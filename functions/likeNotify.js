// functions/likeNotify.js
//
// notifyLike — callable that notifies a SELLER when a buyer likes (watchlists)
// their listing. Likes are a MAP on users/{uid}.watchlist (so a like is an
// onUpdate of the user doc — the #34-unreliable path); rather than trigger off
// that, the client's like action calls this callable explicitly (reliable).
//
// Guardrails:
//   • Server-CONFIRMS the like — the listing must actually be in the caller's
//     watchlist map. Can't be used to spam/harass a seller with fake likes.
//   • Skips self-likes (liker === listing.sellerId).
//   • Dedupes repeat likes (toggle off/on, or re-calls) via the notify() seam's
//     dedupeKey, scoped per (seller, listing, liker) for a day.
//   • In-app immediately + push (batched/deduped). NO per-like email — email is
//     a daily digest (P3), to protect the Resend free-tier cap.
// Inert until the r125 client wires the call into toggleWatch.

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {notify} = require("./lib/notify");

const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 20,
  // concurrency 1: 256MiB yields <1 vCPU, which Cloud Run rejects with
  // concurrency > 1. notifyLike is low-volume (fires on a like), so 1 is fine.
  concurrency: 1,
  maxInstances: 50,
};

exports.notifyLike = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const likerUid = request.auth.uid;
  const listingId = String((request.data || {}).listingId || "");
  if (!listingId) {
    throw new HttpsError("invalid-argument", "Missing listingId.");
  }
  const db = admin.firestore();

  // 1. CONFIRM the like server-side — the listing must be in the caller's
  //    watchlist map. (Defends against spoofed "like" calls used to harass.)
  const likerSnap = await db.doc(`users/${likerUid}`).get();
  const watchlist =
    (likerSnap.exists && (likerSnap.data() || {}).watchlist) || {};
  if (!watchlist[listingId]) {
    return {ok: true, skipped: "not-in-watchlist"};
  }

  // 2. Resolve listing + seller.
  const listingSnap = await db.doc(`listings/${listingId}`).get();
  if (!listingSnap.exists) return {ok: true, skipped: "listing-gone"};
  const listing = listingSnap.data() || {};
  const sellerId = listing.sellerId;
  if (!sellerId) return {ok: true, skipped: "no-seller"};

  // 3. Skip self-likes.
  if (sellerId === likerUid) return {ok: true, skipped: "self-like"};

  // 4. Liker display name (public profile).
  let likerName = "Someone";
  try {
    const prof = await db.doc(`profiles/${likerUid}`).get();
    if (prof.exists && prof.data().displayName) {
      likerName = prof.data().displayName;
    }
  } catch (_e) { /* best-effort */ }

  const title = String(listing.title || "your listing");

  // 5. Fan out via the seam. In-app + push; deduped per (seller,listing,liker)
  //    for a day so toggling/spam can't multi-fire. No per-like email.
  const res = await notify({
    recipientUid: sellerId,
    dedupeKey: `like_${sellerId}_${listingId}_${likerUid}`,
    dedupeWindowMs: 24 * 60 * 60 * 1000,
    inApp: {
      kind: "listing-liked",
      listingId,
      likerUid,
      likerName,
      preview: `${likerName} saved "${title.slice(0, 60)}"`,
    },
    push: {
      payload: {
        title: "Someone saved your listing",
        body: `${likerName} saved "${title.slice(0, 40)}"`,
        deepLink: `teebox://listing/${listingId}`,
        kind: "listing-liked",
        data: {kind: "listing-liked", listingId, likerUid},
      },
      category: "likes",
    },
  });
  logger.info("notifyLike fan-out", {sellerId, listingId, likerUid, res});
  return {ok: true};
});
