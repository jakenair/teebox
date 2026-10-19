// functions/listFirst.js
//
// LIST-FIRST seller onboarding (founder ruling 2026-10-19) — Cloud Functions.
// Core helpers + constants live in ./lib/listFirstCore.js.
//
//   countListingCreate       onDocumentCreated(listings/{id}) — maintains the
//                            per-seller daily counter the create RULE reads
//                            (users/{uid}/rateLimits/listingCreate).
//   notifySellerInterest     callable — buyer taps "Seller is finishing setup
//                            — tap to get notified": records interest and
//                            nudges the seller (push + email + in-app).
//   hideUnonboardedListings  scheduled daily — hides (not deletes) listings
//                            older than 7 days whose seller still isn't
//                            charges-ready, emails "Finish setup to relist";
//                            ALSO the self-heal pass that relists + notifies
//                            buyers for sellers who became ready since the
//                            last run (no onUpdate trigger — the #34 rule).

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {notify} = require("./lib/notify");
const {RESEND_API_KEY, UNSUBSCRIBE_SECRET} = require("./lib/email");
const {
  APP_URL, PAYOUT_SETUP_URL, RATE_WINDOW_MS, HIDE_AFTER_DAYS,
  HIDDEN_STATUS, HIDDEN_REASON, SELLER_NUDGE_CAP_PER_DAY,
  emailFor, lookupUser, onSellerChargesReady, rollingLimitAllowed, hideClockStartMs,
} = require("./lib/listFirstCore");

const USER_CALLABLE = {
  region: "us-central1", memory: "256MiB", timeoutSeconds: 30,
  concurrency: 80, maxInstances: 100,
};
const LIGHT_TRIGGER = {
  region: "us-central1", memory: "256MiB", timeoutSeconds: 60,
  concurrency: 80, maxInstances: 100,
};
const EMAIL_SECRETS = [RESEND_API_KEY, UNSUBSCRIBE_SECRET];

// ── countListingCreate ─────────────────────────────────────────────────
// Rolling 24h window: {count, resetAt}. The rule admits a create while
// count < cap OR resetAt has passed, so this seeds a new window the first
// time a create lands after resetAt. Fires AFTER the create, so the 11th
// create in a window is the first one denied. (A burst of parallel creates
// can overshoot by a few before the counter catches up — acceptable for a
// throttle; the rule, not this trigger, is the enforcement point.)
exports.countListingCreate = onDocumentCreated(
    {document: "listings/{listingId}", ...LIGHT_TRIGGER},
    async (event) => {
      const d = (event.data && event.data.data()) || {};
      const uid = d.sellerId;
      if (!uid) return;
      // Admin re-creates (releaseListingHold) don't count against the seller.
      if (d.moderationCleared === true) return;
      const db = admin.firestore();
      const ref = db.collection("users").doc(uid)
          .collection("rateLimits").doc("listingCreate");
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const now = Date.now();
          const cur = snap.exists ? (snap.data() || {}) : {};
          const resetMs = cur.resetAt && cur.resetAt.toMillis ? cur.resetAt.toMillis() : 0;
          if (!snap.exists || resetMs <= now) {
            tx.set(ref, {
              count: 1,
              windowStartedAt: admin.firestore.Timestamp.fromMillis(now),
              resetAt: admin.firestore.Timestamp.fromMillis(now + RATE_WINDOW_MS),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          } else {
            tx.update(ref, {
              count: admin.firestore.FieldValue.increment(1),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        });
      } catch (e) {
        logger.error(`countListingCreate failed for ${uid}`, e);
      }
    },
);

// Interest tap: 20/hour/buyer so one account can't ring every seller's phone.
const interestTapAllowed = (uid) => rollingLimitAllowed(uid, "interestTap", 20, 60 * 60 * 1000);

// ── notifySellerInterest ───────────────────────────────────────────────
// data: {listingId}
// returns {ok, alreadyBuyable?, duplicate?, interestCount?}
exports.notifySellerInterest = onCall(
    {...USER_CALLABLE, secrets: EMAIL_SECRETS},
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
      const buyerId = request.auth.uid;
      const listingId = request.data && request.data.listingId;
      if (!listingId || typeof listingId !== "string" || listingId.length > 64) {
        throw new HttpsError("invalid-argument", "listingId required");
      }
      const db = admin.firestore();
      const lSnap = await db.collection("listings").doc(listingId).get();
      if (!lSnap.exists) throw new HttpsError("not-found", "Listing not found");
      const listing = {id: lSnap.id, ...lSnap.data()};
      if (listing.sellerId === buyerId) {
        throw new HttpsError("failed-precondition", "That's your own listing.");
      }
      if (listing.status !== "active") {
        throw new HttpsError("failed-precondition", "This listing isn't available.");
      }
      const seller = await lookupUser(listing.sellerId);
      if (seller.stripeChargesEnabled) {
        // Race: seller finished setup while the buyer was looking. Tell the
        // client to refresh and show Buy Now.
        return {ok: true, alreadyBuyable: true};
      }
      if (!(await interestTapAllowed(buyerId))) {
        throw new HttpsError("resource-exhausted", "Too many requests — try again later.");
      }

      const ref = db.collection("listingInterest").doc(`${listingId}_${buyerId}`);
      const created = await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.exists) return false;
        tx.set(ref, {
          listingId, sellerId: listing.sellerId, buyerId,
          listingTitle: String(listing.title || "").slice(0, 120),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          notifiedAt: null,
        });
        tx.set(lSnap.ref, {interestCount: admin.firestore.FieldValue.increment(1)}, {merge: true});
        return true;
      });
      const interestCount = Number(listing.interestCount || 0) + (created ? 1 : 0);
      if (!created) return {ok: true, duplicate: true, interestCount};

      const title = String(listing.title || "your item").slice(0, 60);
      const others = interestCount > 1 ? ` (${interestCount} buyers waiting)` : "";
      // Nudge caps (interest itself is already recorded above):
      //   • one buyer re-tapping → `duplicate` return above, no nudge at all
      //   • per listing: notify() dedupeKey → 1 fan-out per 6h
      //   • per seller: SELLER_NUDGE_CAP_PER_DAY per rolling 24h across all listings
      if (!(await rollingLimitAllowed(listing.sellerId, "interestNudge",
          SELLER_NUDGE_CAP_PER_DAY, RATE_WINDOW_MS))) {
        logger.info(`[listFirst] seller nudge cap hit for ${listing.sellerId}; interest recorded only`);
        return {ok: true, interestCount, sellerNudged: false};
      }
      const nudge = await notify({
        recipientUid: listing.sellerId,
        // One seller nudge per listing per 6h, however many buyers tap.
        dedupeKey: `interest:${listingId}`,
        inApp: {
          type: "buyer_interest",
          title: `Someone wants your ${title}`,
          body: `Finish payout setup to sell it${others}. About 3 minutes.`,
          listingId,
        },
        push: {
          payload: {
            title: `Someone wants your ${title}`,
            body: `Finish payout setup to sell it${others} — about 3 minutes.`,
            deepLink: "teebox://payouts",
            imageUrl: (listing.photos && listing.photos[0]) || "",
            kind: "buyer-interest",
            data: {listingId, kind: "buyer-interest"},
          },
          // Buyer-demand signal → same bucket as offers (default ON).
          category: "offers",
          opts: {threadId: `listing-${listingId}`},
        },
        email: emailFor({
          templateName: "SellerBuyerInterest",
          to: seller.email, uid: listing.sellerId,
          ctx: {user: seller, listing, interestCount, appUrl: APP_URL, setupUrl: PAYOUT_SETUP_URL},
        }),
      });
      const sellerNudged = !(nudge && nudge.skipped);
      logger.info(`[listFirst] interest recorded ${listingId} by ${buyerId} (n=${interestCount}, nudged=${sellerNudged})`);
      return {ok: true, interestCount, sellerNudged};
    },
);

// ── hideUnonboardedListings ────────────────────────────────────────────
exports.hideUnonboardedListings = onSchedule(
    {
      schedule: "every day 04:00",
      timeZone: "America/Chicago",
      region: "us-central1",
      memory: "512MiB",
      timeoutSeconds: 300,
      secrets: EMAIL_SECRETS,
    },
    async () => {
      const db = admin.firestore();
      const cutoff = admin.firestore.Timestamp.fromMillis(
          Date.now() - HIDE_AFTER_DAYS * 86400000);
      const summary = {scanned: 0, hidden: 0, sellersEmailed: 0, healedSellers: 0,
        relisted: 0, buyersNotified: 0};

      // Pass A — hide. Uses the existing (status ASC, createdAt DESC) index.
      const old = await db.collection("listings")
          .where("status", "==", "active")
          .where("createdAt", "<", cutoff)
          .orderBy("createdAt", "desc")
          .limit(500).get();
      summary.scanned = old.size;
      const bySeller = new Map();
      const hideBefore = Date.now() - HIDE_AFTER_DAYS * 86400000;
      old.docs.forEach((d) => {
        const l = d.data() || {};
        if (!l.sellerId) return;
        // Day-one grace: pre-existing listings count from LIST_FIRST_EPOCH.
        if (hideClockStartMs(l) > hideBefore) return;
        if (!bySeller.has(l.sellerId)) bySeller.set(l.sellerId, []);
        bySeller.get(l.sellerId).push({id: d.id, ref: d.ref, title: l.title || "Untitled"});
      });
      const sellerIds = [...bySeller.keys()];
      const userSnaps = sellerIds.length
        ? await db.getAll(...sellerIds.map((id) => db.collection("users").doc(id)))
        : [];
      const notReady = userSnaps.filter((s) => !(s.exists && s.data().stripeChargesEnabled === true));
      for (const us of notReady) {
        const uid = us.id;
        const rows = bySeller.get(uid) || [];
        if (!rows.length) continue;
        try {
          const batch = db.batch();
          rows.forEach((r) => batch.update(r.ref, {
            status: HIDDEN_STATUS,
            hiddenReason: HIDDEN_REASON,
            hiddenAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }));
          await batch.commit();
          summary.hidden += rows.length;
        } catch (e) {
          logger.error(`[hideUnonboarded] batch failed for ${uid}`, e);
          continue;
        }
        try {
          const seller = await lookupUser(uid);
          const n = rows.length;
          const res = await notify({
            recipientUid: uid,
            dedupeKey: `hidden:${uid}:${new Date().toISOString().slice(0, 10)}`,
            inApp: {
              type: "listings_hidden",
              title: n === 1 ? "Your listing is paused" : `${n} listings paused`,
              body: "Finish payout setup to relist — they go live again automatically.",
              listingId: rows[0].id,
            },
            push: {
              payload: {
                title: n === 1 ? `"${String(rows[0].title).slice(0, 40)}" is paused` : `${n} listings paused`,
                body: "They've been live 7 days without payouts set up. Finish setup (~3 min) to relist.",
                deepLink: "teebox://payouts",
                kind: "listings-hidden",
                data: {kind: "listings-hidden", count: String(n)},
              },
              category: "orders",
              opts: {threadId: "payouts"},
            },
            email: emailFor({
              templateName: "SellerListingsHidden",
              to: seller.email, uid,
              ctx: {user: seller, listings: rows.map((r) => ({id: r.id, title: r.title})),
                appUrl: APP_URL, setupUrl: PAYOUT_SETUP_URL, days: HIDE_AFTER_DAYS},
            }),
          });
          if (res && res.email && res.email.sent) summary.sellersEmailed++;
        } catch (e) {
          logger.warn(`[hideUnonboarded] notify failed for ${uid}`, e && e.message);
        }
      }

      // Pass B — self-heal: sellers who became charges-ready since the last
      // run (webhook flipped the flag but nothing relisted/notified). Candidates
      // = owners of hidden listings ∪ sellers with un-notified interest.
      const candidates = new Set();
      try {
        const hidden = await db.collection("listings")
            .where("status", "==", HIDDEN_STATUS)
            .where("hiddenReason", "==", HIDDEN_REASON)
            .limit(500).get();
        hidden.docs.forEach((d) => { const s = d.data().sellerId; if (s) candidates.add(s); });
        const waiting = await db.collection("listingInterest")
            .where("notifiedAt", "==", null).limit(500).get();
        waiting.docs.forEach((d) => { const s = d.data().sellerId; if (s) candidates.add(s); });
      } catch (e) {
        logger.error("[hideUnonboarded] candidate scan failed", e);
      }
      const candIds = [...candidates];
      const candSnaps = candIds.length
        ? await db.getAll(...candIds.map((id) => db.collection("users").doc(id)))
        : [];
      for (const s of candSnaps) {
        if (!(s.exists && s.data().stripeChargesEnabled === true)) continue;
        const r = await onSellerChargesReady(s.id);
        summary.healedSellers++;
        summary.relisted += r.relisted;
        summary.buyersNotified += r.buyersNotified;
      }
      logger.info("[hideUnonboarded] done", summary);
    },
);
