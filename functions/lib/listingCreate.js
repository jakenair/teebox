"use strict";
// One server-side listing create for CSV bulk upload and the seller API.
// Seller Integrations Phase 0, 2026-11-17.
//
// Same result as the app's Sell form: the document (lib/listingSchema.js
// buildListingDoc) is field-for-field what submitListing writes, created
// with status "active" and photos [], so every existing trigger runs on it
// unchanged: moderateListingOnCreate (text filter, hold for review),
// stampListingPriceEstimate, notifyOnSavedSearchMatch, onListingLive; and
// photos uploaded afterwards go through optimizeListingPhoto (EXIF strip,
// WebP, Vision SafeSearch).
//
// Gates the rules give the app path, repeated here (Admin SDK skips rules):
//   - seller is signed in, email verified (or phone sign-in), not banned
//   - seller agreed to the Seller Terms (users.sellerVerified, set by
//     requestSellerVerification: the same step the Sell form runs first)
//   - every rule in isValidListingCreate (listingSchema.rulesCreateCheck)
//
// Daily caps (founder ruling 2026-11-17), separate from the app's 10/day:
//   200/day for Pro or integration-approved sellers, 25/day otherwise,
//   CSV + API combined, rolling 24h at users/{uid}/rateLimits/bulkListingCreate.
//   users/{uid}.bulkDailyCap (server-only, set by an admin) overrides both,
//   e.g. for a shop's first big upload.
//   countListingCreate (the app's 10/day counter) skips source csv/api, so a
//   bulk upload never locks a seller out of the Sell form.

const schema = require("./listingSchema");
const {sellerConsentStatus, CONFIRM_MESSAGE} = require("./sellerConsent");

const CAP_STANDARD = 25;
const CAP_HIGH = 200;
const WINDOW_MS = 24 * 60 * 60 * 1000;

class ListingCreateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The seller's bulk daily cap. Pure. */
function bulkCapFor(user) {
  const u = user || {};
  const override = Number(u.bulkDailyCap);
  if (Number.isInteger(override) && override >= 0 && override <= 1000) return override;
  if (u.tier === "pro" || u.integrationsApproved === true) return CAP_HIGH;
  return CAP_STANDARD;
}

/** Photo URLs the API may download for a seller in a rolling 24h. Pure. */
function photoCapFor(user) { return Math.max(500, 20 * bulkCapFor(user)); }

/**
 * Check the seller may create listings at all (mirror of the rules' create gate
 * plus the Sell form's seller-terms step). Throws ListingCreateError.
 * @return {Promise<{user: object, cap: number, paymentReady: boolean}>}
 */
async function assertSellerCanList({db, auth, uid}) {
  if (!uid) throw new ListingCreateError("unauthenticated", "Sign in to list items.");
  let authUser;
  try { authUser = await auth.getUser(uid); } catch (_e) {
    throw new ListingCreateError("unauthenticated", "Your account could not be found. Sign in again.");
  }
  if (authUser.disabled) throw new ListingCreateError("permission-denied", "This account is disabled.");
  const phone = (authUser.providerData || []).some((p) => p && p.providerId === "phone");
  if (!authUser.emailVerified && !phone) {
    throw new ListingCreateError("failed-precondition", "Verify your email before listing items.");
  }
  const snap = await db.doc(`users/${uid}`).get();
  const user = snap.exists ? (snap.data() || {}) : {};
  if (user.banned === true) throw new ListingCreateError("permission-denied", "This account can't list items.");
  // r428: tools never tick the 18+ / Seller Terms boxes. The seller confirms
  // both once in TeeBox (lib/sellerConsent); without that, refuse clearly.
  const consent = sellerConsentStatus(user);
  if (!consent.ok) {
    throw new ListingCreateError("failed-precondition", CONFIRM_MESSAGE);
  }
  // r422 list-first: a seller Stripe hasn't enabled yet still lists, but the
  // listing saves hidden/awaiting_payouts and publishes when charges enable.
  return {user, cap: bulkCapFor(user), paymentReady: user.stripeChargesEnabled === true};
}

/**
 * Reserve up to `want` creates from the seller's rolling 24h bulk quota.
 * Atomic. Returns how many were granted (0..want; 0 or want when `whole`).
 */
async function reserveBulkQuota({db, Timestamp, uid, want, cap, nowMs, counter = "bulkListingCreate", whole = false}) {
  const ref = db.doc(`users/${uid}/rateLimits/${counter}`);
  const now = nowMs || Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? (snap.data() || {}) : {};
    const resetMs = cur.resetAt && cur.resetAt.toMillis ? cur.resetAt.toMillis() : 0;
    const fresh = !snap.exists || resetMs <= now;
    const used = fresh ? 0 : Math.max(0, Number(cur.count) || 0);
    const room = Math.max(0, Math.min(want, cap - used));
    const granted = whole && room < want ? 0 : room;
    if (granted > 0) {
      tx.set(ref, fresh ? {
        count: granted, cap,
        windowStartedAt: Timestamp.fromMillis(now), resetAt: Timestamp.fromMillis(now + WINDOW_MS),
      } : {count: used + granted, cap}, {merge: !fresh});
    }
    return {granted, used: used + granted, cap,
      resetAt: fresh ? now + WINDOW_MS : resetMs};
  });
}

/** Give back unused quota (e.g. rows that failed after reserving). */
async function releaseBulkQuota({db, uid, n}) {
  if (!(n > 0)) return;
  const ref = db.doc(`users/${uid}/rateLimits/bulkListingCreate`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const c = Math.max(0, (Number(snap.data().count) || 0) - n);
    tx.update(ref, {count: c});
  });
}

/**
 * Create ONE listing from an already-validated value (listingSchema
 * validateListingInput(...).value). Caller has run assertSellerCanList and
 * reserved quota. Returns the new listing id.
 * `withTx(tx, listingId)`, if given, runs in the same transaction as the
 * listing write, before it (so its reads are allowed): all or nothing.
 */
async function createListingDoc({db, FieldValue, Timestamp, uid, value, source, paymentReady, nowMs, withTx}) {
  const doc = schema.buildListingDoc(value, {uid, source, FieldValue, Timestamp, nowMs, paymentReady});
  const failed = schema.rulesCreateCheck(doc);
  if (failed.length) throw new ListingCreateError("invalid-argument", "Listing failed checks: " + failed.join(", "));
  const ref = db.collection("listings").doc();
  if (withTx) {
    await db.runTransaction(async (tx) => {
      await withTx(tx, ref.id);
      tx.create(ref, doc);
    });
  } else await ref.set(doc);
  return ref.id;
}

/**
 * Take a listing that still has no photos off sale (its photos could not be
 * attached). Same state a listing with failed uploads gets; sending photos
 * brings it back. Does nothing to a listing that has photos or moved on.
 */
async function hideIfPhotoless({db, FieldValue, uid, listingId}) {
  const ref = db.doc(`listings/${listingId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const l = snap.exists ? snap.data() || {} : null;
    if (!l || l.sellerId !== uid || (Array.isArray(l.photos) && l.photos.length)) return;
    if (l.status !== "active" && !(l.status === "hidden" && l.hiddenReason === "awaiting_payouts")) return;
    tx.update(ref, {status: "hidden", hiddenReason: "photos_missing",
      hiddenAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
  });
}

/**
 * Attach uploaded photo URLs to a server-created listing and enforce the photo
 * rules now that the real count is known. A listing that ends up short of
 * photos (uploads failed) is taken down (status "hidden", reason
 * "photos_missing") instead of staying live without them. `paymentReady`
 * (a retry of a create whose photos failed) puts such a listing back.
 * @return {Promise<{ok: boolean, photos: number, reason?: string}>}
 */
async function attachListingPhotos({db, FieldValue, uid, listingId, urls, isPhotoUrl, paymentReady}) {
  // Our bucket only, except in the API sandbox, which stores no files.
  const okUrl = isPhotoUrl || ((u) => schema.STORAGE_URL_RE.test(u));
  const ref = db.doc(`listings/${listingId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return {ok: false, photos: 0, reason: "missing"};
    const l = snap.data() || {};
    if (l.sellerId !== uid) return {ok: false, photos: 0, reason: "not-yours"};
    const all = [...(Array.isArray(l.photos) ? l.photos : []), ...(urls || [])]
        .filter((u) => typeof u === "string" && okUrl(u));
    const photos = [...new Set(all)].slice(0, schema.MAX_PHOTOS);
    const need = Number(l.ask) >= schema.HIGH_VALUE ? schema.MIN_PHOTOS_HIGH_VALUE : 1;
    if (photos.length < need) {
      if (l.status === "active" || l.hiddenReason === "awaiting_payouts") {
        tx.update(ref, {photos, status: "hidden", hiddenReason: "photos_missing",
          hiddenAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
      }
      return {ok: false, photos: photos.length, reason: need > 1 ? "needs-4-photos" : "needs-a-photo"};
    }
    const back = paymentReady !== undefined && l.status === "hidden" && l.hiddenReason === "photos_missing" ?
      (paymentReady ? {status: "active", hiddenReason: FieldValue.delete()} : {hiddenReason: "awaiting_payouts"}) : {};
    tx.update(ref, {photos, ...back, updatedAt: FieldValue.serverTimestamp()});
    return {ok: true, photos: photos.length};
  });
}

module.exports = {
  assertSellerCanList, reserveBulkQuota, releaseBulkQuota, createListingDoc, attachListingPhotos, hideIfPhotoless,
  bulkCapFor, photoCapFor, ListingCreateError, CAP_STANDARD, CAP_HIGH,
};
