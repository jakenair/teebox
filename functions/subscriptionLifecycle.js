/**
 * functions/subscriptionLifecycle.js
 * ─────────────────────────────────────────────────────────────────────────
 * Premium-subscription lifecycle notifications (email + push). Watches
 * `users/{uid}` Firestore document transitions for tier / subscription
 * status changes that are already written by handleSubscriptionUpsert
 * and handleSubscriptionDeleted in index.js.
 *
 * Triggers (one onDocumentUpdated each + one onSchedule):
 *   1. proWelcomeEmail              — free → pro, status='active'
 *   3. proRenewalReminderScheduled  — 3-day pre-renewal cron
 *   4. proPaymentFailedEmail        — status flips to past_due
 *   5. proPaymentRetryEmail         — past_due → active
 *   6. proCanceledEmail             — proCancelAtPeriodEnd flips to true
 *   7. proDowngradedEmail           — tier flips pro → free
 *
 * Each handler is idempotent: we stamp
 * `users/{uid}.lifecycleEmailsSent.<key>` after a successful send and
 * skip if the stamp already exists (renewal reminder is special — it
 * keys on proCurrentPeriodEnd to allow one-per-period).
 *
 * #2 ("each successful charge") intentionally has NO trigger here —
 * Stripe sends its own receipt. See PREMIUM_NOTIFICATIONS_TEST.md for the
 * dashboard configuration the user must verify.
 *
 * Wired from functions/index.js with:
 *   Object.assign(exports, require("./subscriptionLifecycle"));
 */

const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const {
  sendEmail,
  CATEGORIES,
  RESEND_API_KEY,
  UNSUBSCRIBE_SECRET,
} = require("./lib/email");
const {sendPush} = require("./lib/push");

const FN_LIGHT = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 40,
  maxInstances: 50,
};
const FN_SCHED = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};

// Stamp keys on users/{uid}.lifecycleEmailsSent.<key>.
const STAMP = Object.freeze({
  WELCOME: "proWelcome",
  PAYMENT_FAILED: "proPaymentFailed",
  PAYMENT_RETRY: "proPaymentRetrySucceeded",
  CANCELED: "proCanceled",
  DOWNGRADED: "proDowngraded",
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Lazy-load a JSX template; falls back to null + a text-only HTML stub. */
function loadTemplate(name) {
  try {
    return require(`./emails/subscription/${name}`);
  } catch (e) {
    logger.warn(`subscriptionLifecycle: template ${name} not loaded`, e.message);
    return null;
  }
}

/** Resolve the recipient's email address. Prefers users/{uid}.email; falls
 *  back to Firebase Auth record. Returns null if neither has one. */
async function resolveEmail(uid, userData) {
  if (userData && userData.email) return userData.email;
  try {
    const authUser = await admin.auth().getUser(uid);
    return authUser.email || null;
  } catch (_e) {
    return null;
  }
}

/** Build the shared user context object passed into every template. */
function buildUserCtx(uid, userData) {
  const data = userData || {};
  return {
    uid,
    email: data.email || null,
    firstName:
      data.firstName ||
      (typeof data.displayName === "string" ? data.displayName.split(" ")[0] : null) ||
      null,
    displayName: data.displayName || null,
  };
}

/** Format a Firestore Timestamp / number / Date into "May 15" style label. */
function formatDateLabel(ts) {
  if (!ts) return "soon";
  let d;
  if (ts.toDate) d = ts.toDate();
  else if (typeof ts === "number") d = new Date(ts);
  else if (ts instanceof Date) d = ts;
  else return "soon";
  try {
    return d.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    });
  } catch (_e) {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Send a subscription-lifecycle email + stamp idempotency. If `stampKey`
 * is null, no stamp is written (used by the scheduled renewal reminder
 * which manages its own keying).
 */
async function sendOnceAndStamp({
  uid,
  userData,
  template,
  templateName,
  ctx,
  subjectOverride,
  stampKey,
  stampValue,
}) {
  const lifecycleSent =
    (userData && userData.lifecycleEmailsSent) || {};
  if (stampKey && lifecycleSent[stampKey]) {
    return {skipped: true, reason: "already-sent"};
  }
  const to = await resolveEmail(uid, userData);
  if (!to) {
    logger.info(`subscriptionLifecycle ${templateName}: no email on user ${uid}`);
    return {skipped: true, reason: "no-email"};
  }

  let react = null;
  let subject = subjectOverride;
  if (template) {
    try {
      react = template(ctx);
      if (!subject && typeof template.subject === "function") {
        subject = template.subject(ctx);
      }
    } catch (e) {
      logger.error(
        `subscriptionLifecycle: template instantiation ${templateName} failed`,
        e.message,
      );
    }
  }
  const fallbackHtml = react ?
    null :
    `<!doctype html><html><body><p>TeeBox: ${
      subject || templateName
    }</p><p>(JSX stub — compile templates to upgrade.)</p></body></html>`;
  if (!subject) subject = `TeeBox: ${templateName}`;

  const result = await sendEmail({
    to,
    subject,
    react,
    html: fallbackHtml,
    category: CATEGORIES.TRANSACTIONAL,
    uid,
    template: templateName,
    tags: [{name: "lifecycle", value: "subscription"}],
  });

  // Stamp on best-effort send (sent OR skipped-no-key both count as
  // "we tried" — we don't want to retry on every doc update forever).
  if (stampKey) {
    try {
      await admin.firestore().collection("users").doc(uid).set({
        lifecycleEmailsSent: {
          [stampKey]: stampValue || admin.firestore.FieldValue.serverTimestamp(),
        },
      }, {merge: true});
    } catch (e) {
      logger.warn(
        `subscriptionLifecycle: stamp ${stampKey} on ${uid} failed`,
        e.message,
      );
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. ProWelcome — free → pro AND status === 'active'
// ─────────────────────────────────────────────────────────────────────────
exports.proWelcomeEmail = onDocumentUpdated(
  {
    document: "users/{uid}",
    secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
    ...FN_LIGHT,
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!before || !after) return;
    if (before.tier === "pro") return;
    if (after.tier !== "pro") return;
    if (after.proSubscriptionStatus !== "active") return;

    const uid = event.params.uid;
    const user = buildUserCtx(uid, after);

    await sendOnceAndStamp({
      uid,
      userData: after,
      template: loadTemplate("ProWelcome"),
      templateName: "ProWelcome",
      ctx: {user},
      stampKey: STAMP.WELCOME,
    });

    // Push: actionable celebratory notification.
    try {
      await sendPush(uid, {
        title: "You're on Pro Seller — fees are now 3%",
        body: "Welcome to Pro. Open your seller dashboard to see the new fee in action.",
        deepLink: "teebox://shop/dashboard",
        kind: "pro-welcome",
        data: {event: "pro-welcome"},
      }, "orders", {urgent: true, threadId: "subscription-lifecycle"});
    } catch (e) {
      logger.warn("proWelcomeEmail: push failed", e.message || String(e));
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// 3. ProRenewalReminder — scheduled hourly; sends if renewal is in ~3 days
// ─────────────────────────────────────────────────────────────────────────
exports.proRenewalReminderScheduled = onSchedule(
  {
    schedule: "every 1 hours",
    secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
    ...FN_SCHED,
  },
  async () => {
    const db = admin.firestore();
    const now = Date.now();
    // Window: [now + 2.95d, now + 3.05d]. Cron runs hourly; 0.05d ≈ 72 min,
    // so we'll catch every user exactly once even with jitter.
    const lo = admin.firestore.Timestamp.fromMillis(now + 2.95 * 86400 * 1000);
    const hi = admin.firestore.Timestamp.fromMillis(now + 3.05 * 86400 * 1000);

    let snap;
    try {
      snap = await db.collection("users")
        .where("proSubscriptionStatus", "==", "active")
        .where("proCurrentPeriodEnd", ">=", lo)
        .where("proCurrentPeriodEnd", "<=", hi)
        .limit(500)
        .get();
    } catch (e) {
      logger.error("proRenewalReminderScheduled: query failed", e.message);
      return;
    }
    if (snap.empty) return;

    const template = loadTemplate("ProRenewalReminder");
    const tasks = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const uid = doc.id;
      // Skip if user is canceling — they'll get ProCanceled, not a reminder.
      if (data.proCancelAtPeriodEnd === true) return;
      // Idempotency: don't send twice for the same period_end.
      const periodEndMs = data.proCurrentPeriodEnd &&
        data.proCurrentPeriodEnd.toMillis ?
        data.proCurrentPeriodEnd.toMillis() :
        null;
      const stampedFor = data.lifecycleEmailsSent &&
        data.lifecycleEmailsSent.renewalReminderSentForPeriodEnd;
      const stampedForMs = stampedFor && stampedFor.toMillis ?
        stampedFor.toMillis() : Number(stampedFor) || 0;
      if (periodEndMs && stampedForMs === periodEndMs) return;

      const renewsOnLabel = formatDateLabel(data.proCurrentPeriodEnd);
      const ctx = {
        user: buildUserCtx(uid, data),
        renewal: {
          renewsOnLabel,
          amountLabel: "$14.99",
          // We don't have card brand/last4 in Firestore — leave generic
          // unless caller passes it through. (Future: cache from Stripe.)
          cardBrand: "card",
          cardLast4: null,
        },
      };

      tasks.push((async () => {
        const to = await resolveEmail(uid, data);
        if (!to) return;
        let react = null;
        let subject = "Pro Seller renews soon";
        if (template) {
          try {
            react = template(ctx);
            if (typeof template.subject === "function") {
              subject = template.subject(ctx);
            }
          } catch (e) {
            logger.error("ProRenewalReminder render failed", e.message);
          }
        }
        try {
          await sendEmail({
            to,
            subject,
            react,
            html: react ? null : `<p>TeeBox: Pro Seller renews ${renewsOnLabel}.</p>`,
            category: CATEGORIES.TRANSACTIONAL,
            uid,
            template: "ProRenewalReminder",
            tags: [{name: "lifecycle", value: "subscription"}],
          });
          // Stamp the period-end so we don't fire twice.
          if (periodEndMs) {
            await db.collection("users").doc(uid).set({
              lifecycleEmailsSent: {
                renewalReminderSentForPeriodEnd:
                  admin.firestore.Timestamp.fromMillis(periodEndMs),
              },
            }, {merge: true});
          }
        } catch (e) {
          logger.error(
            `proRenewalReminderScheduled: send failed for ${uid}`,
            e.message || String(e),
          );
        }
      })());
    });
    await Promise.allSettled(tasks);
  },
);

// ─────────────────────────────────────────────────────────────────────────
// 4. ProPaymentFailed — status flips to "past_due"
// ─────────────────────────────────────────────────────────────────────────
exports.proPaymentFailedEmail = onDocumentUpdated(
  {
    document: "users/{uid}",
    secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
    ...FN_LIGHT,
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!before || !after) return;
    if (before.proSubscriptionStatus === "past_due") return;
    if (after.proSubscriptionStatus !== "past_due") return;

    const uid = event.params.uid;
    const user = buildUserCtx(uid, after);

    await sendOnceAndStamp({
      uid,
      userData: after,
      template: loadTemplate("ProPaymentFailed"),
      templateName: "ProPaymentFailed",
      ctx: {user},
      stampKey: STAMP.PAYMENT_FAILED,
    });

    try {
      await sendPush(uid, {
        title: "Pro Seller payment failed",
        body: "Update your payment method to keep your 3% seller fee.",
        deepLink: "teebox://billing",
        kind: "pro-payment-failed",
        data: {event: "pro-payment-failed"},
      }, "orders", {urgent: true, threadId: "subscription-lifecycle"});
    } catch (e) {
      logger.warn("proPaymentFailedEmail: push failed", e.message || String(e));
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// 5. ProPaymentRetrySucceeded — past_due → active
// ─────────────────────────────────────────────────────────────────────────
exports.proPaymentRetryEmail = onDocumentUpdated(
  {
    document: "users/{uid}",
    secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
    ...FN_LIGHT,
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!before || !after) return;
    if (before.proSubscriptionStatus !== "past_due") return;
    if (after.proSubscriptionStatus !== "active") return;

    const uid = event.params.uid;
    const user = buildUserCtx(uid, after);

    // Clear the failure stamp so a future failure can re-fire.
    try {
      await admin.firestore().collection("users").doc(uid).set({
        lifecycleEmailsSent: {
          [STAMP.PAYMENT_FAILED]: admin.firestore.FieldValue.delete(),
        },
      }, {merge: true});
    } catch (e) {
      logger.warn(
        "proPaymentRetryEmail: clear failed-stamp failed",
        e.message || String(e),
      );
    }

    await sendOnceAndStamp({
      uid,
      userData: after,
      template: loadTemplate("ProPaymentRetrySucceeded"),
      templateName: "ProPaymentRetrySucceeded",
      ctx: {user},
      // Stamp keyed on the new period_end so we can fire again on the
      // NEXT recovery cycle without manual reset.
      stampKey: `${STAMP.PAYMENT_RETRY}:${
        (after.proCurrentPeriodEnd && after.proCurrentPeriodEnd.toMillis &&
          after.proCurrentPeriodEnd.toMillis()) || "none"
      }`,
    });

    try {
      await sendPush(uid, {
        title: "Pro Seller renewed",
        body: "Your payment went through. You're back on the 3% seller fee.",
        deepLink: "teebox://shop/dashboard",
        kind: "pro-payment-retry-succeeded",
        data: {event: "pro-payment-retry-succeeded"},
      }, "orders", {urgent: true, threadId: "subscription-lifecycle"});
    } catch (e) {
      logger.warn("proPaymentRetryEmail: push failed", e.message || String(e));
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// 6. ProCanceled — proCancelAtPeriodEnd flips to true
// ─────────────────────────────────────────────────────────────────────────
exports.proCanceledEmail = onDocumentUpdated(
  {
    document: "users/{uid}",
    secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
    ...FN_LIGHT,
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!before || !after) return;
    if (before.proCancelAtPeriodEnd === true) return;
    if (after.proCancelAtPeriodEnd !== true) return;

    const uid = event.params.uid;
    const user = buildUserCtx(uid, after);
    const endsOnLabel = formatDateLabel(after.proCurrentPeriodEnd);

    // Stamp keyed on period-end so re-cancel-then-reactivate-then-cancel
    // doesn't get silenced forever.
    const periodEndMs = after.proCurrentPeriodEnd &&
      after.proCurrentPeriodEnd.toMillis ?
      after.proCurrentPeriodEnd.toMillis() :
      "none";
    await sendOnceAndStamp({
      uid,
      userData: after,
      template: loadTemplate("ProCanceled"),
      templateName: "ProCanceled",
      ctx: {user, subscription: {endsOnLabel}},
      stampKey: `${STAMP.CANCELED}:${periodEndMs}`,
    });
    // No push — cancellation is low-urgency.
  },
);

// ─────────────────────────────────────────────────────────────────────────
// 7. ProDowngraded — tier flips pro → free
// ─────────────────────────────────────────────────────────────────────────
exports.proDowngradedEmail = onDocumentUpdated(
  {
    document: "users/{uid}",
    secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
    ...FN_LIGHT,
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!before || !after) return;
    if (before.tier !== "pro") return;
    if (after.tier !== "free") return;

    const uid = event.params.uid;
    const user = buildUserCtx(uid, after);

    // Stamp keyed on the downgrade timestamp (millis) so a future
    // upgrade+downgrade cycle gets its own email. Use the previous
    // proCurrentPeriodEnd as the key, or 'now' if missing.
    const keyTs = (before.proCurrentPeriodEnd &&
      before.proCurrentPeriodEnd.toMillis &&
      before.proCurrentPeriodEnd.toMillis()) || Date.now();

    await sendOnceAndStamp({
      uid,
      userData: after,
      template: loadTemplate("ProDowngraded"),
      templateName: "ProDowngraded",
      ctx: {user},
      stampKey: `${STAMP.DOWNGRADED}:${keyTs}`,
    });

    try {
      await sendPush(uid, {
        title: "Pro Seller ended",
        body: "Your seller fee is now 6.5%. Reactivate any time.",
        deepLink: "teebox://billing",
        kind: "pro-downgraded",
        data: {event: "pro-downgraded"},
      }, "orders", {urgent: true, threadId: "subscription-lifecycle"});
    } catch (e) {
      logger.warn("proDowngradedEmail: push failed", e.message || String(e));
    }
  },
);

module.exports.__subscriptionLifecycleLoaded = true;
