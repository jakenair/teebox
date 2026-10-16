/**
 * functions/lib/listingPhotoVariants.js
 * ─────────────────────────────────────────────────────────────────────────
 * 400px + 800px WebP derivatives of a listing photo, recorded on the listing
 * doc under photoVariants[index]. Grid/list/thumb fetch these instead of the
 * 1600px original.
 *
 * Moved out of index.js (2026-10-16) so THREE callers share one encoder:
 *   • optimizeListingPhoto (Storage trigger) — the live path, on clean scan;
 *   • approveFlaggedListing — backfills variants a scan-error flag skipped;
 *   • functions/scripts/backfill-photo-variants.mjs — the one-off repair.
 *
 * Index = the 2nd '_'-delimited token of the filename — uploads are
 * `listings/{uid}/{listingId}/{ts}_{i}_{safeName}` (index.html) and photos[i]
 * maps to it. When the caller knows the index (approval/backfill, where the
 * array may have been pruned since upload) it passes it explicitly.
 */
"use strict";
const crypto = require("crypto");
const admin = require("firebase-admin");
const {logger} = require("firebase-functions");
const {convertToWebp} = require("./imageConvert");

const SIZES = [["w400", 400, 78], ["w800", 800, 82]];

function indexFromObjectName(objName) {
  const idx = parseInt(String(objName.split("/").pop()).split("_")[1], 10);
  return Number.isInteger(idx) ? idx : null;
}

/**
 * Encode + upload the variants and write photoVariants.<idx> on the listing.
 * @param {object} bucket   admin.storage().bucket(...)
 * @param {string} objName  original object path
 * @param {string} listingId
 * @param {object} baseSharp  sharp instance from convertToWebp()
 * @param {number} [index]  photos[] index; parsed from the filename if omitted
 * @return {Promise<object|null>} the {w400, w800} URL map, or null if no index
 */
async function writeListingPhotoVariants(bucket, objName, listingId, baseSharp, index) {
  const idx = Number.isInteger(index) ? index : indexFromObjectName(objName);
  if (idx === null) {
    logger.warn("photoVariants: could not parse photo index from", objName);
    return null;
  }
  const urls = {};
  for (const [key, px, q] of SIZES) {
    const buf = await baseSharp.clone()
        .resize({width: px, height: px, fit: "inside", withoutEnlargement: true})
        // No .withMetadata() — it RETAINS EXIF rather than stripping it. See
        // lib/imageConvert.js; orientation is already baked in by .rotate().
        .webp({quality: q})
        .toBuffer();
    const path = `${objName}_${key}.webp`;
    const token = crypto.randomUUID();
    await bucket.file(path).save(buf, {
      metadata: {
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000",
        metadata: {optimized: "true", firebaseStorageDownloadTokens: token},
      },
      resumable: false,
    });
    urls[key] = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
      `/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  }
  // Field path photoVariants.<idx> — merges per-index, so concurrent photo
  // uploads for the same listing don't clobber each other.
  await admin.firestore().doc(`listings/${listingId}`)
      .update({[`photoVariants.${idx}`]: urls});
  return urls;
}

/**
 * Backfill variants for photos[index] of a listing from the stored original.
 * @param {object} bucket
 * @param {string} listingId
 * @param {string} objPath   Storage path of photos[index]
 * @param {number} index
 * @return {Promise<{ok: boolean, reason?: string, urls?: object}>}
 */
async function backfillVariantsForPhoto(bucket, listingId, objPath, index) {
  const file = bucket.file(objPath);
  const [exists] = await file.exists();
  if (!exists) return {ok: false, reason: "object-missing"};
  const [buf] = await file.download();
  const {baseSharp} = await convertToWebp(buf);
  const urls = await writeListingPhotoVariants(bucket, objPath, listingId, baseSharp, index);
  return urls ? {ok: true, urls} : {ok: false, reason: "no-index"};
}

module.exports = {writeListingPhotoVariants, backfillVariantsForPhoto, indexFromObjectName, SIZES};
