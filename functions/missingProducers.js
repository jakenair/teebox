/**
 * functions/missingProducers.js
 * ─────────────────────────────────────────────────────────────────────────
 * Wires the four "missing producer" gaps documented in
 * EMAIL_TRIGGER_AUDIT.md (sections #23, #24, #26, #27). Each downstream
 * email handler in `emailTriggers.js` already exists; this file adds the
 * upstream events that produce the Firestore docs those handlers listen
 * on, plus (for #27) a new trigger because the audit found no downstream
 * email handler for `priceDropEvents/{id}`.
 *
 * Isolated into its own file so the GDPR agent's parallel edits to
 * `emailTriggers.js` / `lib/email.js` / `firestore.rules` / `index.html`
 * don't conflict. Wired into deployment by appending a single
 * `Object.assign(exports, require("./missingProducers"));` line at the
 * bottom of `index.js`.
 *
 * IMPORTANT: This file does NOT modify or re-define any existing exports.
 * - Producer 1 (funds-released): exposes `onStripePayoutPaid` as an
 *   "account.payout.paid" Stripe Connect webhook handler. Because the
 *   main `stripeWebhook` in index.js listens on the PLATFORM endpoint and
 *   `payout.paid` fires on the CONNECTED-ACCOUNT endpoint, we add a NEW
 *   webhook export (`stripeConnectWebhook`) here rather than touching the
 *   existing switch. (See open questions at bottom.)
 * - Producer 2 (refund-issued): NOT in this file. The minimal write goes
 *   into `refundOrder` itself in index.js (one edit).
 * - Producer 3 (saved-search match): adds `savedSearchMatchSchedulerV2`
 *   that uses the canonical schema (`notifyOnNew==true`, `query` object)
 *   instead of the broken `active==true`, `tags array-contains-any` query
 *   in emailTriggers.js. After the GDPR agent's branch lands the existing
 *   `savedSearchMatchScheduler` should be deleted to prevent both running.
 * - Producer 4 (price-drop): adds `onListingPriceUpdate` (writes the
 *   producer doc) AND `onPriceDropEventEmail` (the downstream email
 *   trigger — emailTriggers.js has no handler for `priceDropEvents/{id}`).
 */

const {logger} = require("firebase-functions");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");
const stripe = require("stripe");

const {
  sendEmail,
  CATEGORIES,
  RESEND_API_KEY,
  UNSUBSCRIBE_SECRET,
} = require("./lib/email");

// Reuse the same Stripe secrets the main webhook uses. Both secrets are
// declared (without value mutation) in index.js too; defineSecret is
// idempotent across requires.
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
// Separate webhook signing secret for the CONNECT endpoint. The platform
// endpoint uses STRIPE_WEBHOOK_SECRET; Connect events come through a
// distinct endpoint with its own secret. Operator must register:
//   stripe listen --forward-connect-to .../stripeConnectWebhook
// and set STRIPE_CONNECT_WEBHOOK_SECRET.
const stripeConnectWebhookSecret = defineSecret(
    "STRIPE_CONNECT_WEBHOOK_SECRET");

const EMAIL_FN = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 40,
  maxInstances: 50,
};
const LIGHT_TRIGGER = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 80,
  maxInstances: 100,
};
const SCHED_FN = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};
const WEBHOOK_FN = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 30,
  concurrency: 200,
  maxInstances: 50,
};

// ─── Template loader: copy of the tolerant loader in emailTriggers.js so
// we don't depend on a private helper. Loads ./emails-build/* (compiled)
// and falls back to ./emails/* raw JSX — the fallback path still won't
// render, but it lets the inline-stub HTML fire so the send isn't lost.
function getTemplate(category, name) {
  try {
    return require(`./emails-build/${category}/${name}`);
  } catch (e1) {
    try {
      return require(`./emails/${category}/${name}`);
    } catch (e2) {
      logger.warn(
          `getTemplate: ${category}/${name} not loaded`, e2.message);
      return null;
    }
  }
}

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
      logger.error(
          `template instantiation failed: ${templateName}`, e.message);
    }
  }
  if (!react && !html) {
    html = `<!doctype html><html><body><p>TeeBox notification: ${
      subject || templateName
    }</p><p>(Template ${templateName} stub — compile JSX to upgrade.)` +
      `</p></body></html>`;
  }
  if (!subject) subject = "TeeBox notification";
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
// PRODUCER 1 — funds-released
//
// Stripe Connect destination charges settle on the CONNECTED account's
// balance and Stripe creates a `payout` object when funds are paid out
// to the seller's bank. The `payout.paid` event fires on the connected-
// account webhook stream (not the platform stream), so we register a
// second webhook endpoint here. (See open questions for the alternative
// of using `transfer.created` on the platform stream.)
//
// On `payout.paid`:
//   1. Reverse-lookup the seller by `event.account` (the connect acct id).
//   2. Idempotently write `payouts/{stripePayoutId}`. The downstream
//      `onPayoutReleasedEmail` (emailTriggers.js:428) fires on doc create
//      and emails the seller via the `FundsReleased` template.
//
// Idempotency: doc id = stripe payout id. Same Stripe event redelivered
// → docRef.create() is replaced with set() + transactional existence
// check, so the downstream onCreate trigger only fires once.
// ═══════════════════════════════════════════════════════════════════════

async function handleConnectPayoutPaid(event) {
  const accountId = event && event.account;
  const payout = event && event.data && event.data.object;
  if (!accountId || !payout || !payout.id) {
    logger.warn("payout.paid: missing accountId or payout.id");
    return;
  }
  const db = admin.firestore();
  const usersSnap = await db.collection("users")
      .where("stripeAccountId", "==", accountId)
      .limit(1)
      .get();
  if (usersSnap.empty) {
    logger.warn(`payout.paid for unknown Connect account ${accountId}`);
    return;
  }
  const sellerUid = usersSnap.docs[0].id;
  const payoutRef = db.collection("payouts").doc(payout.id);

  // Idempotency: short-circuit if the doc already exists. We use a tx
  // so two simultaneous redeliveries of the same event don't both pass
  // the existence check.
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(payoutRef);
    if (existing.exists) {
      logger.info(`payout.paid: doc ${payout.id} already exists — skip`);
      return;
    }
    // Stripe `arrival_date` is unix seconds. Convert to ISO for the
    // template; FundsReleased.jsx reads payout.arrivalDate as a string.
    const arrivalDate = payout.arrival_date ?
      new Date(payout.arrival_date * 1000).toISOString().slice(0, 10) :
      null;
    tx.set(payoutRef, {
      sellerId: sellerUid,
      amount: Number(payout.amount || 0) / 100, // dollars, legacy
      amountCents: Number(payout.amount || 0), // template prefers cents
      currency: payout.currency || "usd",
      arrivalDate,
      status: payout.status || "paid",
      stripePayoutId: payout.id,
      stripeAccountId: accountId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  logger.info(`payout.paid: wrote payouts/${payout.id} for ${sellerUid}`);
}

// Connect-side Stripe webhook. Registers at /stripeConnectWebhook. The
// operator must point the Connect endpoint to this URL in the Stripe
// dashboard. Signature verification uses STRIPE_CONNECT_WEBHOOK_SECRET.
exports.stripeConnectWebhook = onRequest(
    {
      ...WEBHOOK_FN,
      secrets: [stripeSecret, stripeConnectWebhookSecret],
    },
    async (req, res) => {
      const stripeClient = stripe(stripeSecret.value());
      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripeClient.webhooks.constructEvent(
            req.rawBody, sig, stripeConnectWebhookSecret.value());
      } catch (err) {
        logger.error("Connect webhook sig verify failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      // Mirror the platform webhook's processedStripeEvents marker so
      // a redelivered Connect event short-circuits before re-running.
      const db = admin.firestore();
      const markerRef = db
          .collection("processedStripeEvents").doc(event.id);
      try {
        const m = await markerRef.get();
        if (m.exists) {
          return res.json({received: true, duplicate: true});
        }
      } catch (e) {
        logger.error("processedStripeEvents read (connect) failed", e);
      }

      try {
        switch (event.type) {
          case "payout.paid":
            await handleConnectPayoutPaid(event);
            break;
          default:
            logger.info(`Connect: unhandled event type: ${event.type}`);
        }
        try {
          await markerRef.set({
            type: event.type,
            source: "connect",
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            ok: true,
          });
        } catch (e) {
          logger.error("Connect success marker write failed", e);
        }
        return res.json({received: true});
      } catch (err) {
        logger.error(`Connect handler error for ${event.type}:`, err);
        const code = err && (err.code || err.status);
        const transient = code === 14 || code === 4 ||
          code === "UNAVAILABLE" || code === "DEADLINE_EXCEEDED" ||
          (typeof code === "string" && /unavailable|deadline/i.test(code));
        if (transient) {
          return res.status(500).send("retryable");
        }
        try {
          await markerRef.set({
            type: event.type,
            source: "connect",
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            permanent: true,
            error: String((err && err.message) || err),
          });
        } catch (e) {
          logger.error("Connect permanent marker failed", e);
        }
        return res.status(200).json({received: true, error: "permanent"});
      }
    },
);

// ═══════════════════════════════════════════════════════════════════════
// PRODUCER 3 — saved-search match (V2)
//
// Why V2 instead of fixing the original: the GDPR agent is editing
// emailTriggers.js. To avoid merge conflicts, this file ships the
// corrected scheduler under a new export name. Operator must (a) deploy
// this, then (b) delete `savedSearchMatchScheduler` from emailTriggers.js
// after the GDPR branch merges, otherwise both schedulers run.
//
// Schema gap (per index.js:2778 + index.html:11168):
//   ACTUAL schema:     savedSearches/{id} = {
//                        userId, name, query: {category?, brand?,
//                        condition?, priceMin?, priceMax?},
//                        notifyOnNew (bool), createdAt
//                      }
//                      (note: in-app subcollection
//                       users/{uid}/savedSearches/{id} is a separate
//                       legacy path — V2 reads ONLY top-level)
//   BROKEN scheduler:  emailTriggers.js:565 queries
//                        `where("active", "==", true)`
//                        `where("matchTags", "array-contains-any", tags)`
//                      — neither field exists on the doc, so 0 matches.
//
// Match logic re-uses `listingMatchesSavedSearch` from index.js
// (re-implemented here to avoid touching that file's exports).
// ═══════════════════════════════════════════════════════════════════════

function listingMatchesSavedSearch(listing, query) {
  if (!query || typeof query !== "object") return false;
  if (query.category) {
    const lc = String(listing.cat || listing.category || "").toLowerCase();
    if (lc !== String(query.category).toLowerCase()) return false;
  }
  if (query.brand) {
    const lb = String(listing.brand || "").toLowerCase();
    if (lb !== String(query.brand).toLowerCase()) return false;
  }
  if (query.condition) {
    const lcond = String(listing.condition || "").toLowerCase();
    if (lcond !== String(query.condition).toLowerCase()) return false;
  }
  const ask = Number(listing.ask);
  if (Number.isFinite(Number(query.priceMin))) {
    if (!Number.isFinite(ask) || ask < Number(query.priceMin)) return false;
  }
  if (Number.isFinite(Number(query.priceMax))) {
    if (!Number.isFinite(ask) || ask > Number(query.priceMax)) return false;
  }
  return true;
}

exports.savedSearchMatchSchedulerV2 = onSchedule(
    {
      schedule: "every 1 hours",
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
      ...SCHED_FN,
    },
    async () => {
      const db = admin.firestore();
      const cutoff = new Date(Date.now() - 60 * 60 * 1000);

      const searches = await db
          .collection("savedSearches")
          .where("notifyOnNew", "==", true)
          .limit(500)
          .get();
      logger.info(
          `savedSearchMatchSchedulerV2: scanning ${searches.size} ` +
          "active saved searches");

      // Pull every active listing newer than `cutoff` once, then match
      // in-memory. With ~500 searches and a small new-listing batch each
      // hour this is much cheaper than a query per search.
      const newListingsSnap = await db
          .collection("listings")
          .where("status", "==", "active")
          .where("createdAt", ">", cutoff)
          .limit(500)
          .get()
          .catch((e) => {
            logger.warn("V2 listings query failed", e.message);
            return null;
          });
      const newListings = newListingsSnap ?
        newListingsSnap.docs.map((d) => ({id: d.id, ...d.data()})) :
        [];

      for (const doc of searches.docs) {
        const s = doc.data();
        if (!s.userId) continue;
        const lastSentMs = s.lastNotifiedAt && s.lastNotifiedAt.toMillis ?
          s.lastNotifiedAt.toMillis() : 0;
        if (Date.now() - lastSentMs < 24 * 60 * 60 * 1000) continue;

        const matches = newListings
            .filter((l) => l.sellerId !== s.userId)
            .filter((l) => listingMatchesSavedSearch(l, s.query))
            .slice(0, 6);
        if (!matches.length) continue;

        const userSnap = await db.collection("users").doc(s.userId).get();
        if (!userSnap.exists) continue;
        const user = {uid: userSnap.id, ...userSnap.data()};
        if (!user.email) continue;
        // Flatten the structured query into a display string the
        // SavedSearchMatch.jsx template can render via search.query.
        const queryStr = s.name || [
          s.query && s.query.category,
          s.query && s.query.brand,
          s.query && s.query.condition,
        ].filter(Boolean).join(" ") || "your search";

        await sendTemplated({
          category: CATEGORIES.SAVED_SEARCH,
          templateCategory: "lifecycle",
          templateName: "SavedSearchMatch",
          to: user.email,
          uid: user.uid,
          ctx: {
            user,
            search: {id: doc.id, query: queryStr, ...s},
            matches: matches.map((m) => ({
              id: m.id,
              title: m.title,
              priceCents: Math.round(Number(m.ask || 0) * 100),
              condition: m.condition || null,
              imageUrl: (Array.isArray(m.photos) && m.photos[0]) || null,
            })),
          },
        });
        await doc.ref.set(
            {lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp()},
            {merge: true},
        );
      }
    },
);

// ═══════════════════════════════════════════════════════════════════════
// PRODUCER 4 — price-drop
//
// (a) `onListingPriceUpdate` — onDocumentUpdated('listings/{id}'):
//     watches for `ask` decreases ≥ 5%, fans out to every user with the
//     listing in their watchlist, writes
//     `priceDropEvents/{listingId}_{uid}_{newPriceCents}`. Doc id
//     includes new price → if the seller bumps DOWN then UP then DOWN to
//     the same price, the dedup key blocks the third event. If they
//     drop to a NEW lower price, a new doc fires.
//
// (b) `onPriceDropEventEmail` — onDocumentCreated('priceDropEvents/{id}'):
//     loads the PriceDrop template + sends. Wired here because
//     emailTriggers.js has no producer/handler for this collection.
//
// 5% threshold reasoning: per user spec, "avoid spam on rounding
// adjustments". A $99→$98 drop on a $99 listing is 1% — below threshold,
// skip. A $99→$94 drop is 5% — fires.
//
// Watchlist read shape (per index.js:3109): collectionGroup('watchlist')
// where each doc lives at users/{uid}/watchlist/{listingId} with a
// `listingId` field. Listings store price in `ask` (dollars), not
// `price` or `priceCents`.
// ═══════════════════════════════════════════════════════════════════════

const PRICE_DROP_THRESHOLD_PCT = 0.05;

exports.onListingPriceUpdate = onDocumentUpdated(
    {document: "listings/{listingId}", ...LIGHT_TRIGGER},
    async (event) => {
      try {
        const before = event.data && event.data.before &&
            event.data.before.data();
        const after = event.data && event.data.after &&
            event.data.after.data();
        if (!before || !after) return;

        const beforeAsk = Number(before.ask);
        const afterAsk = Number(after.ask);
        if (!Number.isFinite(beforeAsk) || !Number.isFinite(afterAsk)) return;
        if (beforeAsk <= 0) return;
        // Only fire on drops.
        if (afterAsk >= beforeAsk) return;
        // 5% threshold — skip rounding adjustments and sub-percent tweaks.
        const dropFrac = (beforeAsk - afterAsk) / beforeAsk;
        if (dropFrac < PRICE_DROP_THRESHOLD_PCT) return;
        // Don't fire on listings that aren't sellable.
        if (after.status && after.status !== "active") return;

        const listingId = event.params.listingId;
        const db = admin.firestore();

        const watchSnap = await db.collectionGroup("watchlist")
            .where("listingId", "==", listingId)
            .limit(500)
            .get();
        if (watchSnap.empty) return;

        const newPriceCents = Math.round(afterAsk * 100);
        const oldPriceCents = Math.round(beforeAsk * 100);
        const percentDropped = Math.round(dropFrac * 100);
        const sellerId = after.sellerId || before.sellerId || null;

        // We use create() (not set()) per doc so the second drop to the
        // same price hits ALREADY_EXISTS and silently no-ops. set()
        // would overwrite createdAt and (more importantly) not re-fire
        // onCreate, but would silently corrupt downstream queries that
        // sort by createdAt. create() is the explicit "first-write-wins"
        // primitive and surfaces the dedup in error logs.
        const tasks = [];
        watchSnap.forEach((w) => {
          const uid = w.ref.parent && w.ref.parent.parent &&
              w.ref.parent.parent.id;
          if (!uid) return;
          if (uid === sellerId) return; // don't email the seller
          const docId = `${listingId}_${uid}_${newPriceCents}`;
          const ref = db.collection("priceDropEvents").doc(docId);
          tasks.push(ref.create({
            listingId,
            uid,
            oldPrice: beforeAsk,
            newPrice: afterAsk,
            oldPriceCents,
            newPriceCents,
            percentDropped,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch((e) => {
            const code = e && (e.code || e.status);
            if (code === 6 || code === "already-exists" ||
                /already exists/i.test(String(e && e.message))) {
              return; // expected idempotent dedup
            }
            logger.warn(
                `priceDropEvents/${docId} create failed`, e.message);
          }));
        });
        if (tasks.length) {
          await Promise.allSettled(tasks);
          logger.info(
              `onListingPriceUpdate: listing ${listingId} dropped ` +
              `${percentDropped}% → fanned out to ${tasks.length} watchers`);
        }
      } catch (err) {
        logger.error("onListingPriceUpdate error", err);
      }
    },
);

exports.onPriceDropEventEmail = onDocumentCreated(
    {
      document: "priceDropEvents/{eventId}",
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
      ...EMAIL_FN,
    },
    async (event) => {
      try {
        const evt = event.data && event.data.data();
        if (!evt || !evt.uid || !evt.listingId) return;
        const db = admin.firestore();
        const [userSnap, listingSnap] = await Promise.all([
          db.collection("users").doc(evt.uid).get(),
          db.collection("listings").doc(evt.listingId).get(),
        ]);
        if (!userSnap.exists || !listingSnap.exists) return;
        const user = {uid: userSnap.id, ...userSnap.data()};
        if (!user.email) return;
        const listingRaw = listingSnap.data();
        // Project listing into the shape PriceDrop.jsx expects:
        // {id, title, imageUrl, previousPriceCents, priceCents}
        const listing = {
          id: listingSnap.id,
          title: listingRaw.title || "Listing",
          imageUrl: (Array.isArray(listingRaw.photos) && listingRaw.photos[0]) ||
              listingRaw.imageUrl || null,
          previousPriceCents: evt.oldPriceCents,
          priceCents: evt.newPriceCents,
        };
        await sendTemplated({
          category: CATEGORIES.PRICE_DROP,
          templateCategory: "lifecycle",
          templateName: "PriceDrop",
          to: user.email,
          uid: user.uid,
          ctx: {user, listing},
        });
      } catch (err) {
        logger.error("onPriceDropEventEmail error", err);
      }
    },
);
