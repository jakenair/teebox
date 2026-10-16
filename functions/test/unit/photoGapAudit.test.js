// functions/test/unit/photoGapAudit.test.js — pure reconcile()
const test = require("node:test");
const assert = require("node:assert/strict");
const {reconcile, formatReport} = require("../../lib/photoGapAudit");
const B = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/";
const url = (p) => `${B}${encodeURIComponent(p)}?alt=media&token=t`;

test("gaps, orphans, variant gaps and stats", () => {
  const listings = [
    {id: "A", data: {status: "active", photos: [url("listings/u/A/1_0_a.jpg"), url("listings/u/A/1_1_b.jpg")], photoVariants: {"0": {w400: "x"}}}},
    {id: "S", data: {status: "sold", photos: [url("listings/u/S/1_0_s.jpg")]}},
  ];
  const objects = [
    "listings/u/A/1_0_a.jpg", "listings/u/A/1_0_a.jpg_w400.webp", "listings/u/A/1_0_a.jpg_w800.webp",
    // A photo 1 is MISSING → gap
    "listings/u/S/1_0_s.jpg",
    "listings/u/GONE/1_0_z.jpg", "listings/u/GONE/1_0_z.jpg_w400.webp", // orphan (variant ignored)
  ];
  const r = reconcile(listings, objects);
  assert.deepEqual(r.gaps, [{listingId: "A", status: "active", index: 1, of: 2, path: "listings/u/A/1_1_b.jpg"}]);
  assert.deepEqual(r.orphans, ["listings/u/GONE/1_0_z.jpg"]);
  assert.deepEqual(r.variantGaps, [{listingId: "A", index: 1}]); // sold listing not counted
  assert.deepEqual(r.stats, {listings: 2, photoUrls: 3, nonStorageUrls: 0, originalObjects: 3, gaps: 1, orphans: 1, variantGaps: 1});
  const txt = formatReport({...r, generatedAt: "2026-10-16T00:00:00Z"});
  assert.match(txt, /gaps \(URL in doc, object missing\): 1/); assert.match(txt, /GONE/);
});
test("clean state", () => {
  const r = reconcile([{id: "A", data: {status: "active", photos: [url("listings/u/A/1_0_a.jpg")], photoVariants: {"0": {w400: "x"}}}}], ["listings/u/A/1_0_a.jpg"]);
  assert.equal(r.stats.gaps, 0); assert.equal(r.stats.orphans, 0); assert.equal(r.stats.variantGaps, 0);
});
