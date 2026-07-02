/**
 * functions/emailTriggers.js
 * ─────────────────────────────────────────────────────────────────────────
 * Every cloud function related to the email system lives here, so we can
 * keep functions/index.js stable and reviewable. Wired into deployment by
 * a single `require('./emailTriggers')` line appended to index.js.
 *
 * Includes:
 *   A) Resend bounce / complaint webhook (svix-signature verified)
 *   B) Transactional triggers (8 templates)
 *   C) Security-email helpers (Auth blocking + manual triggers)
 *   D) Lifecycle / engagement schedulers (cron)
 *   E) updateEmailPreferences (callable)
 *   F) freezeAccount (HTTP, public from "this wasn't me" link)
 *   G) aggregateEmailMetrics (hourly scheduled)
 *   H) handleUnsubscribe (HTTP, one-click, RFC 8058)
 *
 * Most jsx templates aren't loaded directly here because they require a
 * transpile step. Instead we lazy-require them through getTemplate(),
 * which falls back to a basic HTML stub if the compiled template doesn't
 * exist yet — keeps deploys green while the build pipeline catches up.
 */

const crypto = require("crypto");
const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const {
  sendEmail,
  verifyUnsubscribeToken,
  CATEGORIES,
  RESEND_API_KEY,
  UNSUBSCRIBE_SECRET,
} = require("./lib/email");
const {resolveUserEmail} = require("./lib/emailRecipient");

// Resend dashboard → Webhooks → Signing secret. Used to verify svix sigs.
const RESEND_WEBHOOK_SECRET = defineSecret("RESEND_WEBHOOK_SECRET");

// Best-effort ops alerting (never throws). Callers must bind OPS_ALERT_WEBHOOK.
const {opsAlert, OPS_ALERT_WEBHOOK} = require("./opsAlert");

const EMAIL_FN = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 40,
  maxInstances: 50,
};
const SCHED_FN = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};

// ─── Template loader (lazy + tolerant of missing compiled output) ──────
// Loads from ./emails-build/ (built by `npm run build:emails`, hooked
// via predeploy in functions/package.json). Falls back to ./emails/
// (raw JSX) for legacy compatibility — that fallback won't actually
// render but it lets node --check pass during a partial rollout.
function getTemplate(category, name) {
  try {
    return require(`./emails-build/${category}/${name}`);
  } catch (e1) {
    try {
      return require(`./emails/${category}/${name}`);
    } catch (e2) {
      logger.warn(`getTemplate: ${category}/${name} not loaded`, e2.message);
      return null;
    }
  }
}

/**
 * Render-or-fallback wrapper. If the .jsx template can't be loaded (no
 * build step yet), we synthesize a minimal text-only HTML body so the
 * trigger doesn't 500 in CI.
 */
async function sendTemplated({
  category,
  templateCategory,
  templateName,
  to,
  uid,
  ctx = {},
  subject: subjectOverride,
}) {
  const Tpl = getTemplate(templateCategory, templateName);
  let subject = subjectOverride;
  let react = null;
  let html = null;
  if (Tpl) {
    try {
      react = Tpl(ctx);
      if (!subject && typeof Tpl.subject === "function") {
        subject = Tpl.subject(ctx);
      }
    } catch (e) {
      logger.error(`template instantiation failed: ${templateName}`, e.message);
    }
  }
  if (!react && !html) {
    html = `<!doctype html><html><body><p>TeeBox notification: ${
      subject || templateName
    }</p><p>(Template ${templateName} stub — compile JSX to upgrade.)</p></body></html>`;
  }
  if (!subject) subject = `TeeBox notification`;
  return sendEmail({
    to,
    subject,
    react,
    html,
    category,
    uid,
    template: templateName,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// A. RESEND WEBHOOK — bounces & complaints
// ═══════════════════════════════════════════════════════════════════════
/**
 * Svix-signed webhook. Resend sends headers:
 *   svix-id        unique event id
 *   svix-timestamp epoch seconds
 *   svix-signature space-separated list of "v1,<base64-hmac>"
 *
 * Signed payload = `${id}.${timestamp}.${rawBody}`.
 * We compare HMAC-SHA256 in constant time.
 */
function verifySvix(req, secret) {
  const id = req.headers["svix-id"];
  const ts = req.headers["svix-timestamp"];
  const sig = req.headers["svix-signature"];
  if (!id || !ts || !sig || !secret) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 5 * 60) return false; // 5-min window
  const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
  const signed = `${id}.${ts}.${raw}`;
  // Resend secrets are prefixed `whsec_` + base64. Strip prefix before decoding.
  const keyMaterial = secret.startsWith("whsec_") ?
    Buffer.from(secret.slice(6), "base64") :
    Buffer.from(secret, "utf8");
  const expected = crypto
      .createHmac("sha256", keyMaterial)
      .update(signed)
      .digest("base64");
  const provided = String(sig)
      .split(" ")
      .map((s) => s.replace(/^v1,/, ""))
      .filter(Boolean);
  return provided.some((p) => {
    const a = Buffer.from(p);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

exports.resendWebhook = onRequest(
    {...EMAIL_FN, secrets: [RESEND_WEBHOOK_SECRET]},
    async (req, res) => {
      if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

      let secret = null;
      try {
        secret = RESEND_WEBHOOK_SECRET.value();
      } catch (_e) {
        secret = null;
      }
      // Fail closed: if no secret is configured, refuse the request rather
      // than accept un-verified webhooks. Operator must set the secret before
      // any webhook event is honored. Returns 503 so Resend retries until the
      // misconfiguration is fixed.
      if (!secret || secret.startsWith("placeholder_")) {
        logger.error("resendWebhook: RESEND_WEBHOOK_SECRET unset or placeholder — refusing request");
        return res.status(503).send("webhook secret not configured");
      }
      if (!verifySvix(req, secret)) {
        logger.warn("resendWebhook: bad signature");
        return res.status(400).send("bad signature");
      }

      const evt = req.body || {};
      const type = evt.type || "";
      const data = evt.data || {};
      const email = (data.to && data.to[0]) || data.email || null;
      const bounceType = (data.bounce && data.bounce.type) || data.bounce_type || null;

      const db = admin.firestore();

      try {
        // Resolve uid from emailSends if we have one.
        let uid = null;
        if (email) {
          const sends = await db
              .collection("emailSends")
              .where("to", "==", email)
              .orderBy("sentAt", "desc")
              .limit(1)
              .get();
          if (!sends.empty) uid = sends.docs[0].data().uid || null;
        }

        switch (type) {
          case "email.bounced": {
            // Hard bounces only → suppress.
            const hard = !bounceType || /hard|invalid|undeliverable/i.test(String(bounceType));
            if (hard && uid) {
              await db.collection("users").doc(uid).set(
                  {emailSuppressed: true, emailSuppressedAt: admin.firestore.FieldValue.serverTimestamp()},
                  {merge: true},
              );
              await db.collection("emailSuppressions").doc(uid).set({
                uid,
                email,
                reason: "hard-bounce",
                bounceType: bounceType || null,
                at: admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              logger.info("soft bounce — logged only", {bounceType});
            }
            break;
          }
          case "email.complained": {
            if (uid) {
              await db.collection("users").doc(uid).set(
                  {emailSuppressed: true},
                  {merge: true},
              );
              await db.collection("emailSuppressions").doc(uid).set({
                uid,
                email,
                reason: "complaint",
                at: admin.firestore.FieldValue.serverTimestamp(),
              });
              await db.collection("complaints").doc(uid).set({
                uid,
                email,
                at: admin.firestore.FieldValue.serverTimestamp(),
                payload: data,
              });
            }
            break;
          }
          case "email.delivered":
          case "email.opened":
          case "email.clicked":
          case "email.sent": {
            // Update emailSends/{id} if Resend includes our internal id.
            const status = type.replace("email.", "");
            const resendId = data.email_id || data.id || null;
            if (resendId) {
              const matches = await db
                  .collection("emailSends")
                  .where("resendId", "==", resendId)
                  .limit(1)
                  .get();
              if (!matches.empty) {
                await matches.docs[0].ref.set({status}, {merge: true});
              }
            }
            break;
          }
          default:
            logger.info("resendWebhook: unhandled event", {type});
        }
        return res.status(200).send("ok");
      } catch (e) {
        logger.error("resendWebhook handler error", e);
        return res.status(500).send("error");
      }
    },
);

// ═══════════════════════════════════════════════════════════════════════
// B. TRANSACTIONAL TRIGGERS — order lifecycle
// ═══════════════════════════════════════════════════════════════════════

/** Helper: load user + listing in parallel. */
async function loadOrderParties(order) {
  const db = admin.firestore();
  const [buyerSnap, sellerSnap, listingSnap] = await Promise.all([
    order.buyerId ? db.collection("users").doc(order.buyerId).get() : null,
    order.sellerId ? db.collection("users").doc(order.sellerId).get() : null,
    order.listingId ? db.collection("listings").doc(order.listingId).get() : null,
  ]);
  return {
    buyer: buyerSnap && buyerSnap.exists ? {uid: buyerSnap.id, ...buyerSnap.data()} : {},
    seller: sellerSnap && sellerSnap.exists ? {uid: sellerSnap.id, ...sellerSnap.data()} : {},
    listing: listingSnap && listingSnap.exists ? {id: listingSnap.id, ...listingSnap.data()} : {},
  };
}

/**
 * Record an order email that could NOT be sent because no deliverable address
 * resolved. Written to emailSends (same collection recordSend uses) so the miss
 * is auditable and alertable — the original bug silently skipped instead.
 * @param {{uid:string, template:string, orderId:string, reason:string}} p
 */
async function recordEmailMiss({uid, template, orderId, reason}) {
  try {
    await admin.firestore().collection("emailSends").add({
      to: null,
      uid: uid || null,
      category: CATEGORIES.TRANSACTIONAL,
      template,
      status: "skipped-no-recipient-email",
      error: reason,
      orderId: orderId || null,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.error("recordEmailMiss: emailSends write failed", e.message || e);
  }
}

// 1. Order placed → buyer + seller
exports.onOrderCreatedEmail = onDocumentCreated(
    {document: "orders/{orderId}", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...EMAIL_FN},
    async (event) => {
      const order = {id: event.params.orderId, ...(event.data && event.data.data())};
      if (!order || !order.buyerId) return;
      const {buyer, seller, listing} = await loadOrderParties(order);
      const ctx = {order, buyer, seller, listing};
      // Canonical email source is Firebase Auth (users/{uid} has no email field
      // for real accounts — that was the silent-skip bug). doc email is a
      // legacy/smoke fallback. See lib/emailRecipient.js.
      const authGetter = (uid) => admin.auth().getUser(uid);
      const recipients = [
        {role: "buyer", uid: buyer.uid || order.buyerId,
          docEmail: buyer.email, template: "OrderPlacedBuyer"},
        {role: "seller", uid: seller.uid || order.sellerId,
          docEmail: seller.email, template: "OrderPlacedSeller"},
      ];
      const tasks = recipients.map(async (r) => {
        if (!r.uid) return; // party absent on the order (e.g. no sellerId)
        const {email} = await resolveUserEmail(r.uid, r.docEmail, authGetter);
        if (!email) {
          // NEVER silent-skip (the original defect). Log + record the miss.
          logger.error(
              `onOrderCreatedEmail: no deliverable email for ${r.role} ` +
              `${r.uid} on order ${order.id} (auth + users-doc both empty)`);
          await recordEmailMiss({
            uid: r.uid, template: r.template, orderId: order.id,
            reason: `no email for ${r.role} (auth-miss + no users-doc email)`,
          });
          return;
        }
        return sendTemplated({
          category: CATEGORIES.TRANSACTIONAL,
          templateCategory: "transactional",
          templateName: r.template,
          to: email,
          uid: r.uid,
          ctx,
        });
      });
      await Promise.allSettled(tasks);
    },
);

// 2. Label created → buyer
exports.onOrderLabelEmail = onDocumentUpdated(
    {document: "orders/{orderId}", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...EMAIL_FN},
    async (event) => {
      const before = event.data && event.data.before && event.data.before.data();
      const after = event.data && event.data.after && event.data.after.data();
      if (!before || !after) return;
      if (before.labelUrl || !after.labelUrl) return; // only on first set
      const order = {id: event.params.orderId, ...after};
      const {buyer, listing} = await loadOrderParties(order);
      if (!buyer.email) return;
      await sendTemplated({
        category: CATEGORIES.TRANSACTIONAL,
        templateCategory: "transactional",
        templateName: "LabelCreated",
        to: buyer.email,
        uid: buyer.uid,
        ctx: {order, buyer, listing},
      });
    },
);

// 3. Shipped (Shippo webhook sets shippingStatus="transit")
// 4. Out for delivery
// 5. Delivered (buyer + seller)
exports.onOrderShippingStatusEmail = onDocumentUpdated(
    {document: "orders/{orderId}", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...EMAIL_FN},
    async (event) => {
      const before = event.data && event.data.before && event.data.before.data();
      const after = event.data && event.data.after && event.data.after.data();
      if (!before || !after) return;
      const beforeStatus = before.shippingStatus || "";
      const afterStatus = after.shippingStatus || "";
      if (beforeStatus === afterStatus) return;

      const order = {id: event.params.orderId, ...after};
      const {buyer, seller, listing} = await loadOrderParties(order);
      const tracking = {
        carrier: after.carrier,
        number: after.trackingNumber,
        publicUrl: after.trackingUrl,
        eta: after.estimatedDelivery,
      };

      const ctx = {order, buyer, seller, listing, tracking};

      switch (afterStatus) {
        case "transit":
        case "shipped":
          // NEUTERED r118 — markOrderShipped callable is the single source of
          // truth for the shipped email (this onUpdate trigger is #34-unreliable;
          // it drops the majority of fires). Reversible: delete the `false &&`.
          if (false && buyer.email) {
            await sendTemplated({
              category: CATEGORIES.TRANSACTIONAL,
              templateCategory: "transactional",
              templateName: "OrderShipped",
              to: buyer.email,
              uid: buyer.uid,
              ctx,
            });
          }
          break;
        case "out_for_delivery":
          if (buyer.email) {
            await sendTemplated({
              category: CATEGORIES.TRANSACTIONAL,
              templateCategory: "transactional",
              templateName: "OrderOutForDelivery",
              to: buyer.email,
              uid: buyer.uid,
              ctx,
            });
          }
          break;
        case "delivered":
          // NEUTERED r118 — confirmOrderDelivered callable is the single source
          // of truth for delivered (notifies the SELLER only; no DeliveredBuyer
          // leak — the buyer tapped the button). Reversible: `if (false)`->`if (true)`.
          if (false) await Promise.allSettled([
            buyer.email && sendTemplated({
              category: CATEGORIES.TRANSACTIONAL,
              templateCategory: "transactional",
              templateName: "DeliveredBuyer",
              to: buyer.email,
              uid: buyer.uid,
              ctx,
            }),
            seller.email && sendTemplated({
              category: CATEGORIES.TRANSACTIONAL,
              templateCategory: "transactional",
              templateName: "DeliveredSeller",
              to: seller.email,
              uid: seller.uid,
              ctx,
            }),
          ]);
          break;
      }
    },
);

// 6. Funds released → seller
exports.onPayoutReleasedEmail = onDocumentCreated(
    {document: "payouts/{payoutId}", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...EMAIL_FN},
    async (event) => {
      const payout = {id: event.params.payoutId, ...(event.data && event.data.data())};
      if (!payout || !payout.sellerId) return;
      const db = admin.firestore();
      const sellerSnap = await db.collection("users").doc(payout.sellerId).get();
      const seller = sellerSnap.exists ? {uid: sellerSnap.id, ...sellerSnap.data()} : {};
      if (!seller.email) return;
      const orderSnap = payout.orderId ?
        await db.collection("orders").doc(payout.orderId).get() :
        null;
      const order = orderSnap && orderSnap.exists ?
        {id: orderSnap.id, ...orderSnap.data()} :
        {};
      await sendTemplated({
        category: CATEGORIES.TRANSACTIONAL,
        templateCategory: "transactional",
        templateName: "FundsReleased",
        to: seller.email,
        uid: seller.uid,
        ctx: {order, seller, payout},
      });
    },
);

// 7. Refund issued → buyer
exports.onRefundEmail = onDocumentCreated(
    {document: "refunds/{refundId}", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...EMAIL_FN},
    async (event) => {
      const refund = {id: event.params.refundId, ...(event.data && event.data.data())};
      if (!refund || !refund.orderId) return;
      const db = admin.firestore();
      const orderSnap = await db.collection("orders").doc(refund.orderId).get();
      if (!orderSnap.exists) return;
      const order = {id: orderSnap.id, ...orderSnap.data()};
      const {buyer} = await loadOrderParties(order);
      if (!buyer.email) return;
      await sendTemplated({
        category: CATEGORIES.TRANSACTIONAL,
        templateCategory: "transactional",
        templateName: "RefundIssued",
        to: buyer.email,
        uid: buyer.uid,
        ctx: {order, buyer, refund},
      });
    },
);

// 8. Dispute opened → buyer + seller
exports.onDisputeOpenedEmail = onDocumentCreated(
    {document: "disputes/{disputeId}", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...EMAIL_FN},
    async (event) => {
      const dispute = {id: event.params.disputeId, ...(event.data && event.data.data())};
      if (!dispute || !dispute.orderId) return;
      const db = admin.firestore();
      const orderSnap = await db.collection("orders").doc(dispute.orderId).get();
      if (!orderSnap.exists) return;
      const order = {id: orderSnap.id, ...orderSnap.data()};
      const {buyer, seller, listing} = await loadOrderParties(order);
      const ctx = {order, buyer, seller, listing, dispute};
      await Promise.allSettled([
        buyer.email && sendTemplated({
          category: CATEGORIES.TRANSACTIONAL,
          templateCategory: "transactional",
          templateName: "DisputeOpenedBuyer",
          to: buyer.email,
          uid: buyer.uid,
          ctx,
        }),
        seller.email && sendTemplated({
          category: CATEGORIES.TRANSACTIONAL,
          templateCategory: "transactional",
          templateName: "DisputeOpenedSeller",
          to: seller.email,
          uid: seller.uid,
          ctx,
        }),
      ]);
    },
);

// ═══════════════════════════════════════════════════════════════════════
// C. SECURITY — most are called inline from auth flows. Exposed here as
//    callables so the index.js / web app can fire them on demand.
// ═══════════════════════════════════════════════════════════════════════

exports.sendSecurityEmail = onCall(
    {...EMAIL_FN, secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET]},
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new HttpsError("unauthenticated", "Sign-in required.");
      const {template, payload} = req.data || {};
      const allowed = new Set([
        "EmailVerification",
        "PasswordReset",
        "PasswordChanged",
        "EmailChangedNew",
        "EmailChangedOld",
        "PayoutMethodChanged",
        "TwoFactorCode",
        "SuspiciousLogin",
        "AccountDeletionConfirmed",
      ]);
      if (!allowed.has(template)) {
        throw new HttpsError("invalid-argument", "Unknown template.");
      }
      const db = admin.firestore();
      const userSnap = await db.collection("users").doc(auth.uid).get();
      if (!userSnap.exists) throw new HttpsError("not-found", "User missing.");
      const user = {uid: userSnap.id, ...userSnap.data()};
      const to = (payload && payload.toOverride) || user.email;
      if (!to) throw new HttpsError("failed-precondition", "No email on file.");
      const freezeUrl = buildFreezeUrl(auth.uid);
      const ctx = {user, freezeUrl, ...(payload || {})};
      return sendTemplated({
        category: CATEGORIES.TRANSACTIONAL,
        templateCategory: "security",
        templateName: template,
        to,
        uid: auth.uid,
        ctx,
      });
    },
);

// ═══════════════════════════════════════════════════════════════════════
// D. LIFECYCLE — scheduled functions
// ═══════════════════════════════════════════════════════════════════════

// Hourly saved-search match digest lives in missingProducers.js as
// `savedSearchMatchSchedulerV2`. The original V1 implementation that
// previously sat here queried `where("active","==",true)` and
// `array-contains-any("matchTags", ...)` — neither field exists on the
// canonical `savedSearches/{id}` doc shape, so it returned zero results
// and burned ~720 invocations/month. Removed 2026-05; see
// EMAIL_REAUDIT_DIFF.md for the audit trail.

// Daily 09:00 UTC: abandoned-draft sweep.
exports.abandonedDraftScheduler = onSchedule(
    {schedule: "0 9 * * *", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...SCHED_FN},
    async () => {
      // DISABLED 2026-05-20 — pre-launch, re-enable before public launch; see POST_BETA_FIXES.md
      // Belt-and-suspenders: the Cloud Scheduler job is also PAUSED (the
      // immediate disable). This flag keeps the schedule a no-op once
      // this function is next redeployed (a redeploy recreates the
      // scheduler ENABLED).
      if (process.env.ABANDONED_DRAFTS_ENABLED !== "true") return;
      const db = admin.firestore();
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const until = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const snap = await db
          .collection("drafts")
          .where("submitted", "==", false)
          .where("updatedAt", ">=", since)
          .where("updatedAt", "<", until)
          .limit(500)
          .get()
          .catch(() => null);
      if (!snap) return;
      for (const d of snap.docs) {
        const draft = {id: d.id, ...d.data()};
        if (draft.abandonedEmailSent) continue;
        const userSnap = await db.collection("users").doc(draft.uid).get();
        if (!userSnap.exists) continue;
        const user = {uid: userSnap.id, ...userSnap.data()};
        if (!user.email) continue;
        await sendTemplated({
          category: CATEGORIES.ABANDONED_DRAFT,
          templateCategory: "lifecycle",
          templateName: "AbandonedDraft",
          to: user.email,
          uid: user.uid,
          ctx: {user, draft},
        });
        await d.ref.set({abandonedEmailSent: true}, {merge: true});
      }
    },
);

// Daily 17:00 UTC: 7-day-after-delivery review request.
exports.reviewRequestScheduler = onSchedule(
    {schedule: "0 17 * * *", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...SCHED_FN},
    async () => {
      const db = admin.firestore();
      const since = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const until = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const snap = await db
          .collection("orders")
          .where("shippingStatus", "==", "delivered")
          .where("deliveredAt", ">=", since)
          .where("deliveredAt", "<", until)
          .limit(500)
          .get()
          .catch(() => null);
      if (!snap) return;
      for (const o of snap.docs) {
        const order = {id: o.id, ...o.data()};
        if (order.reviewed || order.reviewEmailSent) continue;
        const {buyer, seller, listing} = await loadOrderParties(order);
        if (!buyer.email) continue;
        await sendTemplated({
          category: CATEGORIES.REVIEW_REQUEST,
          templateCategory: "lifecycle",
          templateName: "ReviewRequest",
          to: buyer.email,
          uid: buyer.uid,
          ctx: {user: buyer, order, listing, seller},
        });
        await o.ref.set({reviewEmailSent: true}, {merge: true});
      }
    },
);

// Daily: 30/60/90-day win-back.
exports.winBackScheduler = onSchedule(
    {schedule: "0 16 * * *", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...SCHED_FN},
    async () => {
      // DISABLED 2026-05-20 — pre-launch, re-enable before public launch; see POST_BETA_FIXES.md
      // Belt-and-suspenders: the Cloud Scheduler job is also PAUSED (the
      // immediate disable). This flag keeps the schedule a no-op once
      // this function is next redeployed (a redeploy recreates the
      // scheduler ENABLED).
      if (process.env.WIN_BACK_ENABLED !== "true") return;
      const db = admin.firestore();
      const day = 24 * 60 * 60 * 1000;
      const bands = [
        {tpl: "WinBack30", min: 30, max: 31, flag: "winBack30Sent"},
        {tpl: "WinBack60", min: 60, max: 61, flag: "winBack60Sent"},
        {tpl: "WinBack90", min: 90, max: 91, flag: "winBack90Sent"},
      ];
      for (const band of bands) {
        const since = new Date(Date.now() - band.max * day);
        const until = new Date(Date.now() - band.min * day);
        const snap = await db
            .collection("users")
            .where("lastActiveAt", ">=", since)
            .where("lastActiveAt", "<", until)
            .limit(500)
            .get()
            .catch(() => null);
        if (!snap) continue;
        for (const u of snap.docs) {
          const user = {uid: u.id, ...u.data()};
          if (user[band.flag]) continue;
          if (!user.email) continue;
          await sendTemplated({
            category: CATEGORIES.WIN_BACK,
            templateCategory: "lifecycle",
            templateName: band.tpl,
            to: user.email,
            uid: user.uid,
            ctx: {user},
          });
          await u.ref.set({[band.flag]: true}, {merge: true});
        }
      }
    },
);

// Sunday 09:00 UTC weekly digest. Local-time delivery is a TODO — for now
// we send at 09:00 UTC regardless and rely on user-side timezone shifting.
exports.weeklyDigestScheduler = onSchedule(
    {schedule: "0 9 * * 0", secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET], ...SCHED_FN},
    async () => {
      // DISABLED 2026-05-20 — pre-launch, re-enable before public launch; see POST_BETA_FIXES.md
      // Belt-and-suspenders: the Cloud Scheduler job is also PAUSED (the
      // immediate disable). This flag keeps the schedule a no-op once
      // this function is next redeployed (a redeploy recreates the
      // scheduler ENABLED).
      if (process.env.WEEKLY_DIGEST_ENABLED !== "true") return;
      const db = admin.firestore();
      const snap = await db
          .collection("users")
          .where("emailPrefs.weeklyDigest", "==", true)
          .limit(1000)
          .get()
          .catch(() => null);
      if (!snap) return;
      for (const u of snap.docs) {
        const user = {uid: u.id, ...u.data()};
        if (!user.email) continue;
        await sendTemplated({
          category: CATEGORIES.WEEKLY_DIGEST,
          templateCategory: "lifecycle",
          templateName: "WeeklyDigest",
          to: user.email,
          uid: user.uid,
          ctx: {user, items: []},
        });
      }
    },
);

// ═══════════════════════════════════════════════════════════════════════
// E. updateEmailPreferences — callable preference center
// ═══════════════════════════════════════════════════════════════════════
const PREF_KEYS = new Set([
  "savedSearchMatches",
  "priceDrops",
  "abandonedDraft",
  "abandonedCart",
  "reviewRequests",
  "winBack",
  "weeklyDigest",
  "productUpdates",
]);

exports.updateEmailPreferences = onCall(
    {...EMAIL_FN},
    async (req) => {
      if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
      const uid = req.auth.uid;
      const prefs = (req.data && req.data.prefs) || {};
      const next = {};
      for (const [k, v] of Object.entries(prefs)) {
        if (PREF_KEYS.has(k)) next[`emailPrefs.${k}`] = !!v;
      }
      if (!Object.keys(next).length) {
        return {updated: 0};
      }
      next["emailPrefsUpdatedAt"] = admin.firestore.FieldValue.serverTimestamp();
      await admin.firestore().collection("users").doc(uid).update(next);
      return {updated: Object.keys(next).length - 1};
    },
);

// ═══════════════════════════════════════════════════════════════════════
// F. freezeAccount — public HTTP from "this wasn't me" links
// ═══════════════════════════════════════════════════════════════════════
const FREEZE_SECRET = defineSecret("FREEZE_HMAC_SECRET");

function buildFreezeUrl(uid) {
  let secret;
  try {
    secret = FREEZE_SECRET.value();
  } catch (_e) {
    secret = "dev-secret-not-set";
  }
  const exp = Date.now() + 24 * 60 * 60 * 1000; // 24h
  const payload = `${uid}.${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const token = Buffer.from(`${payload}.${sig}`).toString("base64url");
  return `https://teeboxmarket.com/security?action=freeze&token=${token}`;
}

function verifyFreezeToken(token) {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const parts = raw.split(".");
    if (parts.length !== 3) return null;
    const [uid, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return null;
    let secret;
    try {
      secret = FREEZE_SECRET.value();
    } catch (_e) {
      secret = "dev-secret-not-set";
    }
    const expected = crypto
        .createHmac("sha256", secret)
        .update(`${uid}.${expStr}`)
        .digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return uid;
  } catch (_e) {
    return null;
  }
}

/**
 * Public freeze endpoint. Called from the "this wasn't me" CTA in security
 * emails. Disables auth, revokes refresh tokens, marks user frozen, and
 * fires a password reset link to the email on file.
 */
exports.freezeAccount = onRequest(
    {...EMAIL_FN, secrets: [FREEZE_SECRET, RESEND_API_KEY]},
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      const token = (req.query && req.query.token) || (req.body && req.body.token);
      const uid = token ? verifyFreezeToken(String(token)) : null;
      if (!uid) {
        return res.status(400).send("Invalid or expired link.");
      }
      try {
        await admin.auth().updateUser(uid, {disabled: true});
        await admin.auth().revokeRefreshTokens(uid);
        await admin.firestore().collection("users").doc(uid).set(
            {
              frozen: true,
              frozenAt: admin.firestore.FieldValue.serverTimestamp(),
              frozenReason: "user-initiated-this-wasnt-me",
            },
            {merge: true},
        );
        // Force a password reset link to email-on-file.
        const userRec = await admin.auth().getUser(uid).catch(() => null);
        if (userRec && userRec.email) {
          const resetLink = await admin.auth().generatePasswordResetLink(userRec.email);
          await sendTemplated({
            category: CATEGORIES.TRANSACTIONAL,
            templateCategory: "security",
            templateName: "PasswordReset",
            to: userRec.email,
            uid,
            ctx: {user: {uid, email: userRec.email}, resetUrl: resetLink, ip: req.ip},
          });
        }
        return res
            .status(200)
            .send(
                "<h1>Account frozen.</h1><p>We've signed you out everywhere and emailed a password-reset link. Set a new password to regain access.</p>",
            );
      } catch (e) {
        logger.error("freezeAccount error", e);
        return res.status(500).send("Could not freeze the account. Email support@teeboxmarket.com.");
      }
    },
);

// ═══════════════════════════════════════════════════════════════════════
// G. aggregateEmailMetrics — hourly rollup for dashboard
// ═══════════════════════════════════════════════════════════════════════
exports.aggregateEmailMetrics = onSchedule(
    {schedule: "every 1 hours", ...SCHED_FN},
    async () => {
      const db = admin.firestore();
      const today = new Date();
      const day = today.toISOString().slice(0, 10); // YYYY-MM-DD
      const start = new Date(`${day}T00:00:00Z`);
      const snap = await db
          .collection("emailSends")
          .where("sentAt", ">=", start)
          .limit(5000)
          .get();
      const totals = {
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        opened: 0,
        clicked: 0,
        skipped: 0,
        renderFailed: 0,
      };
      for (const d of snap.docs) {
        const s = d.data().status || "";
        if (s === "sent") totals.sent += 1;
        else if (s === "delivered") totals.delivered += 1;
        else if (s === "bounced") totals.bounced += 1;
        else if (s === "complained") totals.complained += 1;
        else if (s === "opened") totals.opened += 1;
        else if (s === "clicked") totals.clicked += 1;
        else if (s === "render-failed") totals.renderFailed += 1;
        else if (s.startsWith("skipped")) totals.skipped += 1;
      }
      await db.collection("emailMetrics").doc(day).set(
          {
            day,
            ...totals,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          {merge: true},
      );
    },
);

// ═══════════════════════════════════════════════════════════════════════
// H. handleUnsubscribe — backend for unsubscribe.html one-click
// ═══════════════════════════════════════════════════════════════════════
exports.handleUnsubscribe = onRequest(
    {...EMAIL_FN, secrets: [UNSUBSCRIBE_SECRET]},
    async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") return res.status(204).send("");

      // RFC 8058 one-click POST OR ?t= GET both supported.
      const token =
        (req.body && req.body.t) ||
        (req.query && req.query.t) ||
        null;
      if (!token) return res.status(400).json({ok: false, error: "no-token"});

      const verified = verifyUnsubscribeToken(String(token));
      if (!verified.ok) {
        return res.status(400).json({ok: false, error: verified.error});
      }
      try {
        const updates = {
          [`emailPrefs.${verified.category}`]: false,
          emailPrefsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await admin
            .firestore()
            .collection("users")
            .doc(verified.uid)
            .set(updates, {merge: true});
        return res.json({ok: true, uid: verified.uid, category: verified.category});
      } catch (e) {
        logger.error("handleUnsubscribe write failed", e);
        return res.status(500).json({ok: false, error: "write-failed"});
      }
    },
);

// ═══════════════════════════════════════════════════════════════════════
// Order fulfillment callables (Option A) — restore the shipped/delivered
// buyer/seller notifications that the gen2 #34 regression silently killed on
// the onDocumentUpdated triggers (pushOnOrderUpdated / onOrderShippingStatusEmail
// stay in place but inert). These write the status and send push+email INLINE.
//
// Guardrails:
//   1. Idempotent: a transaction guards the transition — already-shipped /
//      already-delivered returns ok without re-sending; invalid transitions
//      (ship an order that's delivered/cancelled, confirm one not yet shipped)
//      are rejected with failed-precondition.
//   2. Notification is NON-FATAL: the status dual-write commits in the
//      transaction FIRST (source of truth); push+email are best-effort after
//      and can never roll back the order or fail the callable.
//   3. Direct-write status path stays ALLOWED in rules (iOS Build 67 users
//      still write directly — order advances, no push — until Build 68). These
//      callables are additive, not a replacement.
//   4. Recipient per event: shipped -> BUYER; delivered (buyer-initiated) ->
//      SELLER only (never re-notify the buyer for a button they just tapped).
//
// FUNC-05: both fulfillmentStatus + shippingStatus are still written (dual-write
// preserved). Single-field normalization is deferred — it's a migrate-every-
// reader project (see POST_LAUNCH.md).
// ═══════════════════════════════════════════════════════════════════════

exports.markOrderShipped = onCall(
    // memory 512MiB: this callable does push (lib/push) + React-Email render
    // together; the 256Mi default OOMs under load. NOTE for gcloud deploys:
    // gcloud ignores this config — you MUST pass `--memory=512Mi` explicitly.
    {...EMAIL_FN, memory: "512MiB",
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET, OPS_ALERT_WEBHOOK]},
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
      const uid = request.auth.uid;
      const d = request.data || {};
      const orderId = d.orderId;
      if (!orderId) throw new HttpsError("invalid-argument", "Missing orderId.");
      const db = admin.firestore();
      const ref = db.collection("orders").doc(String(orderId));

      // Guardrail 1+2: idempotent transition guard, status committed first.
      const res = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
        const o = snap.data();
        if (o.sellerId !== uid) {
          throw new HttpsError("permission-denied", "Only the seller can mark this order shipped.");
        }
        const cur = o.fulfillmentStatus;
        if (cur === "shipped" || cur === "delivered") {
          return {alreadyDone: true}; // idempotent: never re-send
        }
        if (cur !== "awaiting_seller_shipment" && cur !== "paid") {
          throw new HttpsError("failed-precondition", `Cannot ship an order in state "${cur}".`);
        }
        tx.update(ref, {
          fulfillmentStatus: "shipped",
          shippingStatus: "shipped", // dual-write (FUNC-05 deferred)
          carrier: String(d.carrier || "").slice(0, 20),
          trackingCarrier: String(d.trackingCarrier || d.carrier || "").slice(0, 40),
          trackingNumber: String(d.trackingNumber || "").slice(0, 60),
          shippedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return {alreadyDone: false, order: {id: String(orderId), ...o,
          fulfillmentStatus: "shipped", trackingNumber: String(d.trackingNumber || "")}};
      });
      if (res.alreadyDone) return {ok: true, alreadyDone: true};

      // Guardrail 2+4: best-effort notify the BUYER. Never throws.
      try {
        const order = res.order;
        const {buyer, seller, listing} = await loadOrderParties(order);
        const {sendPush} = require("./lib/push");
        await sendPush(order.buyerId, {
          title: "Your order shipped",
          body: order.trackingNumber ? `Tracking: ${order.trackingNumber}` : "It's on the way.",
          kind: "order-shipped",
          deepLink: `teebox://order/${orderId}`,
          orderId: String(orderId),
        }, "orders").catch((e) => logger.error("markOrderShipped: push failed (non-fatal)", e));
        if (buyer.email) {
          await sendTemplated({
            category: CATEGORIES.TRANSACTIONAL,
            templateCategory: "transactional",
            templateName: "OrderShipped",
            to: buyer.email,
            uid: order.buyerId,
            ctx: {order, buyer, seller, listing},
          }).catch((e) => logger.error("markOrderShipped: email failed (non-fatal)", e));
        }
      } catch (e) {
        logger.error("markOrderShipped: notify failed (non-fatal)", e);
        // Observability: the buyer's shipped notification pipeline broke. The
        // order status committed (above), so this is non-fatal to the txn, but
        // a burst signals a systemic notification outage (the #34 family).
        await opsAlert("warn",
            "markOrderShipped: buyer notify pipeline failed",
            {orderId: String(orderId),
              error: String((e && e.message) || e)});
      }
      return {ok: true};
    },
);

exports.confirmOrderDelivered = onCall(
    // memory 512MiB — see markOrderShipped note (gcloud needs --memory=512Mi).
    {...EMAIL_FN, memory: "512MiB",
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET, OPS_ALERT_WEBHOOK]},
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
      const uid = request.auth.uid;
      const orderId = (request.data || {}).orderId;
      if (!orderId) throw new HttpsError("invalid-argument", "Missing orderId.");
      const db = admin.firestore();
      const ref = db.collection("orders").doc(String(orderId));

      const res = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
        const o = snap.data();
        if (o.buyerId !== uid) {
          throw new HttpsError("permission-denied", "Only the buyer can confirm delivery.");
        }
        const cur = o.fulfillmentStatus;
        if (cur === "delivered") return {alreadyDone: true};
        if (cur !== "shipped") {
          throw new HttpsError("failed-precondition", `Cannot confirm delivery from state "${cur}".`);
        }
        // P1 sold-count (2026-06-25): apply the seller sale-stats SYNCHRONOUSLY
        // in this transaction — atomic with the delivered flip, so the count
        // can't be lost to a dropped #34 onUpdate event. `sellerStatsApplied`
        // is the idempotency marker the aggregateSellerStats backstop +
        // reconcileSellerStats both honor (never double-count). Reads are done
        // (tx.get above); only blind-increment writes below — tx rule satisfied.
        const _sellerId = o.sellerId || null;
        const _amount = Number(o.amount) || 0;
        tx.update(ref, {
          fulfillmentStatus: "delivered",
          shippingStatus: "delivered", // dual-write (FUNC-05 deferred)
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
          sellerStatsApplied: true,
        });
        if (_sellerId) {
          // salesCount → PUBLIC profile; totalRevenue + lastSaleAt → owner-only
          // users/ doc (privacy split preserved — rules are document-level).
          tx.set(db.collection("profiles").doc(_sellerId),
              {salesCount: admin.firestore.FieldValue.increment(1)}, {merge: true});
          tx.set(db.collection("users").doc(_sellerId),
              {totalRevenue: admin.firestore.FieldValue.increment(_amount),
                lastSaleAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
        }
        return {alreadyDone: false, order: {id: String(orderId), ...o, fulfillmentStatus: "delivered"}};
      });
      if (res.alreadyDone) return {ok: true, alreadyDone: true};

      // P1 referral credit (2026-06-25): apply SYNCHRONOUSLY here (the
      // redeemReferralCredit onUpdate trigger is #34-unreliable). Idempotent
      // (per-buyer marker) + best-effort — never fails the delivery.
      try {
        const {applyReferralCreditIdempotent} = require("./lib/referral");
        await applyReferralCreditIdempotent(db, res.order.buyerId);
      } catch (e) {
        logger.error("confirmOrderDelivered: referral credit failed (non-fatal)", e);
      }

      // Guardrail 4: buyer tapped the button — notify the SELLER only.
      try {
        const order = res.order;
        const {buyer, seller, listing} = await loadOrderParties(order);
        const {sendPush} = require("./lib/push");
        await sendPush(order.sellerId, {
          title: "Buyer received your item",
          body: "Your payout will appear on Stripe's standard schedule.",
          kind: "order-delivered-seller",
          deepLink: `teebox://order/${orderId}`,
          orderId: String(orderId),
        }, "orders").catch((e) => logger.error("confirmOrderDelivered: push failed (non-fatal)", e));
        if (seller.email) {
          await sendTemplated({
            category: CATEGORIES.TRANSACTIONAL,
            templateCategory: "transactional",
            templateName: "DeliveredSeller",
            to: seller.email,
            uid: order.sellerId,
            ctx: {order, buyer, seller, listing},
          }).catch((e) => logger.error("confirmOrderDelivered: email failed (non-fatal)", e));
        }
      } catch (e) {
        logger.error("confirmOrderDelivered: notify failed (non-fatal)", e);
        // Observability: delivered-notification pipeline broke. Status already
        // committed; a burst signals a systemic notification outage (#34).
        await opsAlert("warn",
            "confirmOrderDelivered: notify pipeline failed",
            {orderId: String(orderId),
              error: String((e && e.message) || e)});
      }
      return {ok: true};
    },
);

// ═══════════════════════════════════════════════════════════════════════
module.exports.__emailTriggersLoaded = true;
