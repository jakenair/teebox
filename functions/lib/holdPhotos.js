"use strict";
// Rebuild a held listing's photos[] from Storage (2026-11-16).
//
// moderateListingOnCreate snapshots a listing the moment it is created, but
// the client attaches photos a few seconds LATER (create → upload → update).
// So a hold's content.photos is almost always []. Releasing it as-is brought
// the listing back with no photos, and the public feed hides photo-less
// listings — a release that looked like it worked but showed nothing.
//
// The uploads themselves still land in listings/{sellerId}/{listingId}/, and
// optimizeListingPhoto rewrites each original in place (same name, WebP) plus
// _w400/_w800/_w1200 variants. Object names are `${ms}_${index}_${name}`, so
// the original upload order is recoverable from the name.

const VARIANT_RE = /_w\d+\.webp$/i;
const NAME_RE = /^(\d+)_(\d+)_/;

/**
 * Pure: ordered download URLs for a listing folder's original photos.
 * @param {Array<{name: string, token: (string|null)}>} files objects under
 *   listings/{sellerId}/{listingId}/ with their firebaseStorageDownloadTokens
 * @param {string} bucketName
 * @param {string} folder "listings/{sellerId}/{listingId}/"
 * @return {string[]}
 */
function photoUrlsFromFiles(files, bucketName, folder) {
  return (files || [])
      .filter((f) => f && typeof f.name === "string" && f.name.startsWith(folder))
      .filter((f) => !f.name.slice(folder.length).includes("/"))
      .filter((f) => !VARIANT_RE.test(f.name))
      .filter((f) => f.token)
      .map((f) => {
        const base = f.name.slice(folder.length);
        const m = base.match(NAME_RE);
        return {f, idx: m ? Number(m[2]) : 999, ms: m ? Number(m[1]) : 0};
      })
      .sort((a, b) => a.idx - b.idx || a.ms - b.ms)
      .slice(0, 10)
      .map(({f}) => `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/` +
        `${encodeURIComponent(f.name)}?alt=media&token=${String(f.token).split(",")[0]}`);
}

/**
 * List the folder and return photo URLs (empty on any Storage error).
 * @param {object} bucket admin.storage().bucket()
 * @param {string} sellerId
 * @param {string} listingId
 * @return {Promise<string[]>}
 */
async function photosForHeldListing(bucket, sellerId, listingId) {
  const folder = `listings/${sellerId}/${listingId}/`;
  const [files] = await bucket.getFiles({prefix: folder});
  return photoUrlsFromFiles(files.map((f) => ({
    name: f.name,
    token: ((f.metadata || {}).metadata || {}).firebaseStorageDownloadTokens || null,
  })), bucket.name, folder);
}

module.exports = {photoUrlsFromFiles, photosForHeldListing};
