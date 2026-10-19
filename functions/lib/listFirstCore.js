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
const HIDDEN_STATUS = "hidden";
const HIDDEN_REASON = "payouts_pending";

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
  const out = {relisted: 0, expiredInstead: 0, buyersNotified: 0};
  if (!uid) return out;
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  // 1. Relist. Equality-only query → no composite index needed.
  try {
    const hidden = await db.collection("listings")
        .where("sellerId", "==", uid)
        .where("status", "==", HIDDEN_STATUS)
        .where("hiddenReason", "==", HIDDEN_REASON)
        .limit(200).get();
    if (!hidden.empty) {
      const batch = db.batch();
      hidden.docs.forEach((d) => {
        const l = d.data() || {};
        const expired = l.expiresAt && l.expiresAt.toMillis &&
          l.expiresAt.toMillis() < now.toMillis();
        batch.update(d.ref, {
          // Past its 60-day life while hidden → hand it to the normal
          // renew flow instead of resurrecting a stale listing.
          status: expired ? "expired" : "active",
          hiddenReason: admin.firestore.FieldValue.delete(),
          hiddenAt: admin.firestore.FieldValue.delete(),
          relistedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (expired) out.expiredInstead++; else out.relisted++;
      });
      await batch.commit();
    }
  } catch (e) {
    logger.error(`[listFirst] relist failed for ${uid}`, e);
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

module.exports = {
  APP_URL, PAYOUT_SETUP_URL,
  LISTING_DAILY_CAP, RATE_WINDOW_MS, HIDE_AFTER_DAYS,
  HIDDEN_STATUS, HIDDEN_REASON,
  emailFor, lookupUser, onSellerChargesReady,
};
