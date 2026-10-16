/**
 * functions/lib/photoPrune.js
 * ─────────────────────────────────────────────────────────────────────────
 * Pure helpers for keeping listings.photos[] honest when moderation deletes
 * a Storage object, and for making flagged-listing approval idempotent.
 *
 * WHY (incident 2026-09-14 → found 2026-10-16): optimizeListingPhoto deleted
 * a photo that tripped SafeSearch (racy=LIKELY, a false positive) and set the
 * listing to flagged; three days later an admin approved it. Neither step
 * removed the deleted photo's URL from photos[], so the listing carried a
 * dead image for a month — a broken thumbnail in the app and a 404 in the
 * Meta catalog feed. Every approved false positive would do the same.
 *
 * No admin SDK in here: everything takes plain data and returns plain data,
 * so the trigger, the approval callable, the admin UI and the tests all run
 * the exact same logic.
 */

"use strict";

/**
 * Storage object path encoded in a Firebase download URL, or null.
 *   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<ENCODED PATH>?alt=media…
 * @param {string} url
 * @return {string|null}
 */
function objectPathFromUrl(url) {
  const m = String(url || "").match(/\/o\/([^?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (_e) {
    return null;
  }
}

/**
 * Remove the photo whose Storage path is `objPath` from photos[] and re-key
 * photoVariants so index i still describes photos[i].
 * @param {object} listing  {photos?: string[], photoVariants?: object}
 * @param {string} objPath  e.g. "listings/<uid>/<listingId>/<file>"
 * @return {{changed: boolean, photos: string[], photoVariants: object,
 *           removedUrl: (string|null), removedIndex: number}}
 */
function prunePhotoByPath(listing, objPath) {
  const photos = Array.isArray(listing && listing.photos) ? listing.photos.slice() : [];
  const variants = (listing && listing.photoVariants && typeof listing.photoVariants === "object") ?
    listing.photoVariants : {};
  const idx = photos.findIndex((u) => objectPathFromUrl(u) === objPath);
  if (idx < 0) {
    return {changed: false, photos, photoVariants: variants, removedUrl: null, removedIndex: -1};
  }
  const removedUrl = photos[idx];
  const kept = photos.filter((_u, i) => i !== idx);
  // Re-key: variants were stored under the OLD index of each photo.
  const rekeyed = {};
  let j = 0;
  for (let i = 0; i < photos.length; i++) {
    if (i === idx) continue;
    if (variants[String(i)]) rekeyed[String(j)] = variants[String(i)];
    j++;
  }
  return {changed: true, photos: kept, photoVariants: rekeyed, removedUrl, removedIndex: idx};
}

/**
 * Indices of photos[] with no photoVariants entry (the grid then loads the
 * full-size original — the 2026-10-01 scan-error listings are in this state).
 * @param {object} listing
 * @return {number[]}
 */
function variantGaps(listing) {
  const photos = Array.isArray(listing && listing.photos) ? listing.photos : [];
  const variants = (listing && listing.photoVariants) || {};
  const out = [];
  photos.forEach((_u, i) => {
    const v = variants[String(i)];
    if (!v || !v.w400) out.push(i);
  });
  return out;
}

// Statuses an approval must never resurrect. A sold or removed listing that
// still carries a stale flag gets the flag cleared but stays what it is.
const TERMINAL_STATUSES = new Set(["sold", "removed", "expired"]);

/**
 * Decide what approving a flagged listing should do. Idempotent by
 * construction: a clean active listing yields {noop: true}.
 *
 * @param {object} listing  current listing data
 * @return {{noop: boolean, reason?: string, setActive?: boolean,
 *           clearFlags?: boolean, photos?: string[], photoVariants?: object,
 *           prunedUrl?: (string|null), variantGaps?: number[]}}
 */
function planApproval(listing) {
  const l = listing || {};
  const flags = l.moderationFlags || null;
  const offending = flags && flags.offendingPath ? String(flags.offendingPath) : null;

  // Defensive prune: if the object moderation deleted is still referenced,
  // drop it now. (Flags raised by scan/process errors never delete the
  // object, so this only fires for an NSFW trip that pre-dates the
  // prune-at-deletion fix, or a manual approval that skipped it.)
  let prune = {changed: false, photos: l.photos || [], photoVariants: l.photoVariants || {}, removedUrl: null};
  if (offending && flags.removedPhotoUrl == null && flags.photoDeleted !== false) {
    // Only prune when the flag reason implies the object was deleted (NSFW
    // trips). image_scan_error / image_process_error keep the object.
    const reason = String(flags.reason || "");
    const deletedByModeration = !/^image_(scan|process)_error$/.test(reason) && reason !== "no_photos";
    if (deletedByModeration) prune = prunePhotoByPath(l, offending);
  }

  const isTerminal = TERMINAL_STATUSES.has(l.status);
  const alreadyActive = l.status === "active";
  const hasFlags = !!flags;

  if (alreadyActive && !hasFlags && !prune.changed) {
    return {noop: true, reason: "already-active"};
  }
  if (isTerminal && !hasFlags && !prune.changed) {
    return {noop: true, reason: `status-${l.status}`};
  }
  const photosAfter = prune.changed ? prune.photos : (Array.isArray(l.photos) ? l.photos : []);
  if (!photosAfter.length) {
    // Nothing to show buyers — approval cannot make this visible.
    return {noop: true, reason: "no-photos", clearFlags: false};
  }
  const out = {
    noop: false,
    setActive: !isTerminal,   // sold/removed/expired keep their status
    clearFlags: hasFlags,
    prunedUrl: prune.changed ? prune.removedUrl : null,
  };
  if (prune.changed) {
    out.photos = prune.photos;
    out.photoVariants = prune.photoVariants;
  }
  out.variantGaps = variantGaps({photos: photosAfter, photoVariants: out.photoVariants || l.photoVariants});
  return out;
}

/**
 * The update optimizeListingPhoto should write right after deleting an
 * NSFW object — flags + pruned arrays in ONE write.
 * @param {object} listing  current data
 * @param {string} objPath  deleted object
 * @param {{reason: string, source: string, signals?: object}} trip
 * @return {{update: object, empty: boolean, removedUrl: (string|null)}}
 *   `update.moderationFlags.flaggedAt` is left for the caller to stamp with
 *   a server timestamp; everything else is final.
 */
function pruneAtDeletion(listing, objPath, trip) {
  const p = prunePhotoByPath(listing, objPath);
  const empty = p.photos.length === 0;
  const flags = {
    // "no_photos" is what the admin queue and the seller need to act on;
    // the SafeSearch result that caused the deletion is kept alongside it.
    reason: empty ? "no_photos" : trip.reason,
    tripReason: trip.reason,
    source: trip.source,
    signals: trip.signals || {},
    offendingPath: objPath,
    removedPhotoUrl: p.removedUrl,   // null if the URL was not in photos[]
    photoDeleted: true,
  };
  const update = {status: "flagged", moderationFlags: flags};
  if (p.changed) {
    update.photos = p.photos;
    update.photoVariants = p.photoVariants;
  }
  return {update, empty, removedUrl: p.removedUrl};
}

module.exports = {
  objectPathFromUrl,
  prunePhotoByPath,
  variantGaps,
  planApproval,
  pruneAtDeletion,
  TERMINAL_STATUSES,
};
