/**
 * functions/lib/photoGapAudit.js
 * ─────────────────────────────────────────────────────────────────────────
 * Reconcile listings.photos[] against the Storage bucket.
 *   gap     = a URL in a listing doc whose object no longer exists
 *             (the thing that put a 404 in the Meta feed, 2026-10-16)
 *   orphan  = an original object under listings/ that no listing references
 *             (a deleted listing whose cleanup failed; harmless, costs pennies)
 *
 * `reconcile()` is pure and unit-tested; `runPhotoGapAudit()` does the two
 * reads. Used by scripts/audit-photo-gaps.mjs (on demand) and the monthly
 * photoGapAuditMonthly schedule (functions/photoGapAudit.js).
 */
"use strict";
const {objectPathFromUrl, variantGaps} = require("./photoPrune");

const VARIANT_RE = /_w(?:400|800)\.webp$/i;

/**
 * @param {Array<{id: string, data: object}>} listings
 * @param {string[]} objectPaths  every object under listings/ (variants ok; filtered)
 * @return {{gaps: Array, orphans: string[], variantGaps: Array, stats: object}}
 */
function reconcile(listings, objectPaths) {
  const originals = new Set(objectPaths.filter((p) => p.startsWith("listings/") && !VARIANT_RE.test(p)));
  const referenced = new Set();
  const gaps = [];
  const vgaps = [];
  let urlCount = 0;
  let nonStorage = 0;
  for (const {id, data} of listings) {
    const d = data || {};
    const photos = Array.isArray(d.photos) ? d.photos : [];
    photos.forEach((u, i) => {
      urlCount++;
      const path = objectPathFromUrl(u);
      if (!path) {
        nonStorage++;
        return;
      }
      referenced.add(path);
      if (!originals.has(path)) {
        gaps.push({listingId: id, status: d.status || "?", index: i, of: photos.length, path});
      }
    });
    if (d.status === "active" || d.status === "pending") {
      for (const i of variantGaps(d)) vgaps.push({listingId: id, index: i});
    }
  }
  const orphans = [...originals].filter((p) => !referenced.has(p)).sort();
  return {
    gaps,
    orphans,
    variantGaps: vgaps,
    stats: {
      listings: listings.length,
      photoUrls: urlCount,
      nonStorageUrls: nonStorage,
      originalObjects: originals.size,
      gaps: gaps.length,
      orphans: orphans.length,
      variantGaps: vgaps.length,
    },
  };
}

/**
 * Read everything and reconcile. Reads only.
 * @param {object} db      admin.firestore()
 * @param {object} bucket  admin.storage().bucket(name)
 * @return {Promise<object>} reconcile() result + generatedAt
 */
async function runPhotoGapAudit(db, bucket) {
  const snap = await db.collection("listings").get();
  const listings = snap.docs.map((d) => ({id: d.id, data: d.data()}));
  const [files] = await bucket.getFiles({prefix: "listings/", autoPaginate: true});
  const paths = files.map((f) => f.name);
  return {...reconcile(listings, paths), generatedAt: new Date().toISOString()};
}

/** Plain-text report for email / terminal. */
function formatReport(r) {
  const s = r.stats;
  const lines = [
    `TeeBox photo-gap audit — ${r.generatedAt || new Date().toISOString()}`,
    `listings ${s.listings} · photo URLs ${s.photoUrls} · originals in Storage ${s.originalObjects}`,
    `gaps (URL in doc, object missing): ${s.gaps}`,
    ...r.gaps.map((g) => `  - ${g.listingId} [${g.status}] photo ${g.index + 1}/${g.of}: ${g.path}`),
    `orphans (object in Storage, no listing): ${s.orphans}`,
    ...r.orphans.map((p) => `  - ${p}`),
    `active/pending photos without variants: ${s.variantGaps}`,
    ...r.variantGaps.slice(0, 40).map((v) => `  - ${v.listingId} photo ${v.index + 1}`),
  ];
  return lines.join("\n");
}

module.exports = {reconcile, runPhotoGapAudit, formatReport};
