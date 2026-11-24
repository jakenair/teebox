// functions/lib/listFirstCore.js
//
// LIST-FIRST seller onboarding (founder ruling 2026-10-19) — shared core.
//
// Anyone with a verified email can create a listing without finishing
// Stripe; Stripe is required only before an item can be BOUGHT (the
// createPaymentIntent 409 money gate, unchanged). This module holds the
// pieces that several entry points need:
//
//   • onSellerChargesReady(uid)  — the moment a seller becomes charges-ready
//       (getStripeAccountStatus sync, or the daily sweep's self-heal pass):
//       relist their auto-hidden listings and tell every buyer who tapped
//       "notify me" that the item can now be bought.
//   • constants shared with firestore.rules (daily cap) and the client
//       (hidden status + reason).
//
// Plain helpers only — the Cloud Functions live in ../listFirst.js so the
// deploy scanner never sees a non-function export.

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");
const {notify} = require("./notify");
const {CATEGORIES} = require("./email");

const APP_URL = "https://teeboxmarket.com";
// Deep link that mints a FRESH Stripe account link on arrival (client
// ?payouts=setup handler → A['stripe-connect'] → createStripeOnboardingLink).
const PAYOUT_SETUP_URL = `${APP_URL}/?payouts=setup`;
// MUST match listingDailyCap() in firestore.rules.
const LISTING_DAILY_CAP = 10;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HIDE_AFTER_DAYS = 7;
// Day-one fairness: listings that already existed when list-first shipped get
// a FULL 7-day clock starting at this epoch, not an overnight hide because
// they happen to be older than 7 days. The sweep measures age from
// max(createdAt, LIST_FIRST_EPOCH_MS). Set to the deploy day (America/Chicago
// 04:00 = 09:00Z) — first possible hide of a pre-existing listing is 7 days
// after this instant.
const LIST_FIRST_EPOCH_MS = Date.parse("2026-10-20T09:00:00Z");
// Seller-level ceiling on "Someone wants your [item]" nudges (push+email+
// in-app), on top of the per-listing 6h dedupe: at most this many per rolling
// 24h however many listings/buyers are involved. Interest is still RECORDED
// (and the buyer still gets notified when the seller is ready) — only the
// seller-facing nag is capped.
const SELLER_NUDGE_CAP_PER_DAY = 3;
const HIDDEN_STATUS = "hidden";
const HIDDEN_REASON = "payouts_pending";
// r422 "list now, publish after payouts": a listing saved by a seller who
// isn't charges-enabled yet. Same status ("hidden") as the 7-day pause, so
// every client build already in the App Store keeps it out of browse,
// search, category and other people's storefronts; only the reason differs.
const AWAITING_REASON = "awaiting_payouts";

// Lazy template loader — same tolerant pattern as securityEmailTriggers.
function loadTemplate(category, name) {
  try {
    return require(`../emails-build/${category}/${name}`);
  } catch (e1) {
    try {
      return require(`../emails/${category}/${name}`);
    } catch (e2) {
      logger.warn(`[listFirst] template ${category}/${name} not loaded`, e2.message);
      return null;
    }
  }
}

// Build the `email` block for notify() from a template + ctx, or null when
// the recipient has no email / the template is missing (push + in-app still
// go out).
function emailFor({templateName, to, uid, ctx}) {
  if (!to) return null;
  const Tpl = loadTemplate("transactional", templateName);
  if (!Tpl) return null;
  let react; let subject;
  try {
    react = Tpl(ctx);
    subject = typeof Tpl.subject === "function" ? Tpl.subject(ctx) : undefined;
  } catch (e) {
    logger.error(`[listFirst] template ${templateName} failed`, e.message);
    return null;
  }
  return {
    to, uid, react,
    subject: subject || "TeeBox",
    category: CATEGORIES.TRANSACTIONAL,
    template: templateName,
  };
}

async function lookupUser(uid) {
  const db = admin.firestore();
  const [authUser, snap] = await Promise.all([
    admin.auth().getUser(uid).catch(() => null),
    db.collection("users").doc(uid).get().catch(() => null),
  ]);
  const data = snap && snap.exists ? snap.data() : {};
  return {
    uid,
    email: (authUser && authUser.email) || data.email || null,
    displayName: (authUser && authUser.displayName) || data.displayName || null,
    stripeChargesEnabled: data.stripeChargesEnabled === true,
    ...data,
  };
}

// Relist hidden listings + notify waiting buyers. Idempotent: a second call
// finds nothing hidden and no un-notified interest. Never throws.
async function onSellerChargesReady(uid) {
  const out = {relisted: 0, expiredInstead: 0, buyersNotified: 0, published: 0};
  if (!uid) return out;
  const db = admin.firestore();
  // r422: the seller is charges-enabled, so no more payout-setup reminders.
  // Runs first and for every seller (test accounts too) so cancel-on-onboard
  // never depends on the relist below.
  try {
    await require("./payoutReminders").cancelReminders(uid, "charges-enabled");
  } catch (e) {
    logger.warn(`[listFirst] reminder cancel failed for ${uid}`, e && e.message);
  }
  // 2026-11-16: a TEST seller's listings never trigger buyer emails.
  {
    const tl = require("./testAccounts");
    if (await tl.isTestUid(uid, tl.adminCtx())) return {...out, skipped: "test-seller"};
  }
  const now = admin.firestore.Timestamp.now();

  // 1. Relist. Equality-only queries → no composite index needed.
  //    (a) the 7-day pause (payouts_pending) and (b) r422 listings saved
  //    before payouts (awaiting_payouts), which publish for the first time.
  const published = [];
  try {
    const [pausedSnap, awaitingSnap] = await Promise.all([HIDDEN_REASON, AWAITING_REASON].map((r) =>
      db.collection("listings")
          .where("sellerId", "==", uid)
          .where("status", "==", HIDDEN_STATUS)
          .where("hiddenReason", "==", r)
          .limit(200).get()));
    // Clubs and bags also need a ship-from address; those wait for it.
    const {hasShipFrom, needsShipFrom} = require("./buyable");
    const me = (await db.collection("users").doc(uid).get()).data() || null;
    const all = [...pausedSnap.docs, ...awaitingSnap.docs];
    const held = hasShipFrom(me) ? [] : all.filter((d) => needsShipFrom(d.data()));
    for (const d of held) {
      await d.ref.update({hiddenReason: require("./shipFromHold").REASON, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    }
    const docs = all.filter((d) => !held.includes(d));
    if (docs.length) {
      const batch = db.batch();
      docs.forEach((d) => {
        const l = d.data() || {};
        const expired = l.expiresAt && l.expiresAt.toMillis &&
          l.expiresAt.toMillis() < now.toMillis();
        const wasAwaiting = l.hiddenReason === AWAITING_REASON;
        batch.update(d.ref, {
          // Past its 60-day life while hidden → hand it to the normal
          // renew flow instead of resurrecting a stale listing.
          status: expired ? "expired" : "active",
          hiddenReason: admin.firestore.FieldValue.delete(),
          hiddenAt: admin.firestore.FieldValue.delete(),
          ...(wasAwaiting ? {publishedAt: admin.firestore.FieldValue.serverTimestamp(),
            listingLiveEmailedAt: admin.firestore.FieldValue.serverTimestamp()} :
            {relistedAt: admin.firestore.FieldValue.serverTimestamp()}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (expired) out.expiredInstead++;
        else if (wasAwaiting) { out.published++; published.push({id: d.id, ...l}); } else out.relisted++;
      });
      await batch.commit();
    }
  } catch (e) {
    logger.error(`[listFirst] relist failed for ${uid}`, e);
  }

  // 1b. r422: tell the seller their saved listing(s) are now live.
  //     dedupeKey keeps the webhook + status callable (which can both land
  //     within seconds) from double-sending.
  if (published.length) {
    try {
      const seller = await lookupUser(uid);
      const first = published[0];
      const t = String(first.title || "Your listing").slice(0, 50);
      const n = published.length;
      const title = n === 1 ? "Your listing is live" : `${n} listings are live`;
      const body = n === 1 ?
        `${t} is now on TeeBox and buyers can purchase it.` :
        `${t} and ${n - 1} more are now on TeeBox and buyers can purchase them.`;
      await notify({
        recipientUid: uid,
        dedupeKey: `published:${uid}:${published.map((p) => p.id).sort().join(",")}`.slice(0, 280),
        dedupeWindowMs: 24 * 60 * 60 * 1000,
        inApp: {type: "listing_published", title, body, listingId: first.id},
        push: {
          payload: {
            title, body,
            deepLink: `teebox://listing/${first.id}`,
            imageUrl: (first.photos && first.photos[0]) || "",
            kind: "listing-published",
            data: {listingId: first.id, kind: "listing-published"},
          },
          category: "orders",
          opts: {threadId: "payouts"},
        },
        email: emailFor({
          templateName: "ListingLive",
          to: seller.email, uid,
          ctx: {user: seller, listing: first, appUrl: APP_URL, payoutsReady: true,
            moreCount: n - 1},
        }),
      });
    } catch (e) {
      logger.warn(`[listFirst] published notify failed for ${uid}`, e && e.message);
    }
  }

  // 2. Tell waiting buyers.
  try {
    const pending = await db.collection("listingInterest")
        .where("sellerId", "==", uid)
        .where("notifiedAt", "==", null)
        .limit(500).get();
    if (pending.empty) return out;
    const byListing = new Map();
    pending.docs.forEach((d) => {
      const r = d.data() || {};
      if (!byListing.has(r.listingId)) byListing.set(r.listingId, []);
      byListing.get(r.listingId).push({ref: d.ref, ...r});
    });
    const listingRefs = [...byListing.keys()].map((id) => db.collection("listings").doc(id));
    const listingSnaps = listingRefs.length ? await db.getAll(...listingRefs) : [];
    const sellerName = (await lookupUser(uid)).displayName || "The seller";
    for (const ls of listingSnaps) {
      const rows = byListing.get(ls.id) || [];
      const listing = ls.exists ? {id: ls.id, ...ls.data()} : null;
      const buyable = !!listing && listing.status === "active";
      for (const row of rows) {
        const stamp = {notifiedAt: admin.firestore.FieldValue.serverTimestamp()};
        if (buyable) {
          try {
            const buyer = await lookupUser(row.buyerId);
            const title = String(listing.title || "The item you asked about").slice(0, 60);
            await notify({
              recipientUid: row.buyerId,
              dedupeKey: `available:${ls.id}:${row.buyerId}`,
              inApp: {
                type: "listing_available",
                title: `${title} is ready to buy`,
                body: `${sellerName} finished payout setup. Grab it before someone else does.`,
                listingId: ls.id,
              },
              push: {
                payload: {
                  title: `${title} is ready to buy`,
                  body: `${sellerName} finished setup — you asked us to let you know.`,
                  deepLink: `teebox://listing/${ls.id}`,
                  imageUrl: (listing.photos && listing.photos[0]) || "",
                  kind: "listing-available",
                  data: {listingId: ls.id, kind: "listing-available"},
                },
                category: "savedSearches",
                opts: {threadId: `listing-${ls.id}`},
              },
              email: emailFor({
                templateName: "BuyerListingAvailable",
                to: buyer.email, uid: row.buyerId,
                ctx: {user: buyer, listing, sellerName, appUrl: APP_URL},
              }),
            });
            out.buyersNotified++;
          } catch (e) {
            logger.warn(`[listFirst] buyer notify failed ${row.buyerId}`, e && e.message);
          }
        } else {
          stamp.skippedReason = listing ? `status:${listing.status}` : "listing-gone";
        }
        await row.ref.set(stamp, {merge: true}).catch(() => {});
      }
    }
  } catch (e) {
    logger.error(`[listFirst] buyer fan-out failed for ${uid}`, e);
  }
  logger.info(`[listFirst] onSellerChargesReady ${uid}`, out);
  return out;
}

// Rolling-window counter shared by the nudge cap (same storage shape as
// index.js checkRateLimit: users/{uid}/rateLimits/{key}.hits[]). Fail-open.
async function rollingLimitAllowed(uid, key, max, windowMs) {
  const db = admin.firestore();
  const ref = db.collection("users").doc(uid).collection("rateLimits").doc(key);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const recent = ((snap.exists && snap.data().hits) || [])
          .map(Number).filter((n) => Number.isFinite(n) && n > now - windowMs).slice(-max * 2);
      if (recent.length >= max) return false;
      recent.push(now);
      tx.set(ref, {hits: recent, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      return true;
    });
  } catch (e) {
    logger.warn(`rollingLimitAllowed(${key}) failed open`, e && e.message);
    return true;
  }
}

// Effective "live since" for the auto-hide clock (see LIST_FIRST_EPOCH_MS).
function hideClockStartMs(listing) {
  const c = listing && listing.createdAt && listing.createdAt.toMillis ? listing.createdAt.toMillis() : 0;
  return Math.max(c, LIST_FIRST_EPOCH_MS);
}

/** Does this new listing use up the Sell form's daily limit? Pure. */
function countsTowardFormLimit(l) {
  return !["csv", "api"].includes(l && l.source);
}

module.exports = {
  countsTowardFormLimit,
  APP_URL, PAYOUT_SETUP_URL,
  LISTING_DAILY_CAP, RATE_WINDOW_MS, HIDE_AFTER_DAYS, LIST_FIRST_EPOCH_MS,
  SELLER_NUDGE_CAP_PER_DAY, rollingLimitAllowed, hideClockStartMs,
  HIDDEN_STATUS, HIDDEN_REASON, AWAITING_REASON,
  emailFor, lookupUser, onSellerChargesReady,
};
