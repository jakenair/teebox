// functions/test/unit/stickyTakedown.test.js — only an admin restores a takedown,
// and an edit to an approved $300+ listing reopens its review.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../../lib/authReview");
const P = require("../../lib/photoPrune");
const {clearAutoFlagIfClean} = require("../../lib/autoClearFlag");

const FV = {delete: () => 0, serverTimestamp: () => 0};
const quiet = {info() {}, warn() {}, error() {}};
async function rescan(doc) {
  if (!doc.photos) doc.photos = ["https://x/o/p?alt=media"];
  let wrote = null;
  const ref = {get: async () => ({exists: true, data: () => doc}), update: async (u) => { wrote = u; }, delete: async () => {}};
  const db = {collection: () => ({doc: () => ref, add: async () => {}})};
  const cleared = await clearAutoFlagIfClean({db, FieldValue: FV, logger: quiet}, {listingId: "a", sellerId: "s", objPath: "p", annotation: {}});
  return {cleared, wrote};
}

test("a bad photo never moves a removed or sold listing to flagged", () => {
  for (const status of ["removed", "sold"]) {
    assert.equal("status" in P.flagStatus({status}), false);
    const r = P.pruneAtDeletion({status, photos: ["u"]}, "listings/a/b/1_0_x.jpg", {reason: "adult=LIKELY", source: "auto"});
    assert.equal("status" in r.update, false, status);
    assert.ok(r.update.moderationFlags);
  }
  for (const status of ["active", "hidden", "expired", "flagged", "pending", undefined]) {
    assert.deepEqual(P.flagStatus({status}), status === "flagged" ? {status} : {status: "flagged", flaggedFrom: status || "active"}, String(status));
  }
});

test("a clean re-scan never restores a takedown, including one already flagged over", async () => {
  const auto = {source: "auto", reason: "image_scan_error"};
  for (const doc of [
    {status: "removed", removedReason: "counterfeit", removedAt: 1, moderationFlags: auto},
    {status: "flagged", removedReason: "admin_takedown", moderationFlags: auto},
    {status: "flagged", removedAt: 1, moderationFlags: auto},
    {status: "flagged", authReviewState: "rejected", moderationFlags: auto},
  ]) assert.deepEqual(await rescan(doc), {cleared: false, wrote: null});
  assert.equal((await rescan({status: "flagged", moderationFlags: auto})).wrote.status, "active"); // ordinary flag heals
});

test("no photo-moderation path writes status flagged unconditionally", () => {
  for (const f of ["index.js", "lib/photoPrune.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "../..", f), "utf8");
    assert.doesNotMatch(src, /status: "flagged",\s*moderationFlags/, f);
  }
});

test("edits that reopen an approved review: photos, title, brand only", () => {
  const cur = {ask: 400, requiresAuth: true, authReviewState: "approved", title: "Putter", brand: "Scotty", photos: ["a", "b"]};
  const same = {title: "Putter", brand: "Scotty", photos: ["b", "a"]};
  assert.deepEqual(R.reviewChanges(cur, same), []); // reorder is not a change
  assert.deepEqual(R.reviewChanges(cur, {...same, photos: ["a"]}), ["photos"]);
  assert.deepEqual(R.reviewChanges(cur, {...same, photos: ["a", "b", "c"]}), ["photos"]);
  assert.deepEqual(R.reviewChanges(cur, {...same, title: "Putter 2", brand: "Ping"}), ["title", "brand"]);
  for (const st of ["pending", "rejected", "na"]) {
    assert.deepEqual(R.reviewChanges({...cur, authReviewState: st}, {...same, title: "x"}), []);
  }
  assert.deepEqual(R.reviewChanges({...cur, ask: 50, requiresAuth: false}, {...same, title: "x"}), []);
});
