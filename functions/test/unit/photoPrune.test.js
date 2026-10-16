// functions/test/unit/photoPrune.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../lib/photoPrune");

const B = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/";
const url = (uid, lid, f) => `${B}${encodeURIComponent(`listings/${uid}/${lid}/${f}`)}?alt=media&token=t`;
const path = (uid, lid, f) => `listings/${uid}/${lid}/${f}`;
const L = "xVdVwLrM1I2Gux3IzK1E"; const U = "7oQ3N4iXXmYoL6L3jnrI55Xvgdl2";
const four = () => ({
  status: "active",
  photos: [url(U, L, "1_0_a.jpg"), url(U, L, "1_1_b.jpg"), url(U, L, "1_2_c.jpg"), url(U, L, "1_3_d.jpg")],
  photoVariants: {"0": {w400: "v0"}, "1": {w400: "v1"}, "2": {w400: "v2"}, "3": {w400: "v3"}},
});

test("objectPathFromUrl decodes the /o/ segment", () => {
  assert.equal(P.objectPathFromUrl(url(U, L, "1_3_d.jpg")), path(U, L, "1_3_d.jpg"));
  assert.equal(P.objectPathFromUrl("https://example.com/x.jpg"), null);
  assert.equal(P.objectPathFromUrl(""), null);
});

test("prunePhotoByPath: last photo (the 09-14 vest case)", () => {
  const r = P.prunePhotoByPath(four(), path(U, L, "1_3_d.jpg"));
  assert.equal(r.changed, true); assert.equal(r.removedIndex, 3);
  assert.equal(r.photos.length, 3);
  assert.deepEqual(Object.keys(r.photoVariants), ["0", "1", "2"]);
});
test("prunePhotoByPath: middle photo re-keys variants so photoVariants[i] still matches photos[i]", () => {
  const r = P.prunePhotoByPath(four(), path(U, L, "1_1_b.jpg"));
  assert.equal(r.photos.length, 3);
  assert.deepEqual(r.photoVariants, {"0": {w400: "v0"}, "1": {w400: "v2"}, "2": {w400: "v3"}});
  assert.equal(P.objectPathFromUrl(r.photos[1]), path(U, L, "1_2_c.jpg"));
});
test("prunePhotoByPath: path not referenced → unchanged", () => {
  const r = P.prunePhotoByPath(four(), path(U, L, "nope.jpg"));
  assert.equal(r.changed, false); assert.equal(r.photos.length, 4); assert.equal(r.removedUrl, null);
});
test("prunePhotoByPath tolerates missing arrays", () => {
  const r = P.prunePhotoByPath({}, "x"); assert.equal(r.changed, false); assert.deepEqual(r.photos, []);
});

test("pruneAtDeletion: one write carries flags + pruned arrays + removedPhotoUrl", () => {
  const {update, empty, removedUrl} = P.pruneAtDeletion(four(), path(U, L, "1_3_d.jpg"),
      {reason: "racy=LIKELY", source: "auto", signals: {racy: "LIKELY"}});
  assert.equal(empty, false);
  assert.equal(update.status, "flagged");
  assert.equal(update.moderationFlags.reason, "racy=LIKELY");
  assert.equal(update.moderationFlags.removedPhotoUrl, removedUrl);
  assert.equal(update.moderationFlags.offendingPath, path(U, L, "1_3_d.jpg"));
  assert.equal(update.photos.length, 3);
  assert.ok(!("3" in update.photoVariants));
});
test("pruneAtDeletion: last remaining photo → reason no_photos, trip kept", () => {
  const one = {status: "active", photos: [url(U, L, "1_0_a.jpg")], photoVariants: {"0": {w400: "v0"}}};
  const {update, empty} = P.pruneAtDeletion(one, path(U, L, "1_0_a.jpg"), {reason: "adult=VERY_LIKELY", source: "auto"});
  assert.equal(empty, true);
  assert.equal(update.moderationFlags.reason, "no_photos");
  assert.equal(update.moderationFlags.tripReason, "adult=VERY_LIKELY");
  assert.deepEqual(update.photos, []); assert.deepEqual(update.photoVariants, {});
});

test("planApproval: clean active listing is a no-op (idempotent)", () => {
  assert.deepEqual(P.planApproval(four()), {noop: true, reason: "already-active"});
});
test("planApproval: legacy NSFW flag with the deleted URL still present → prune + activate", () => {
  const l = {...four(), status: "flagged", moderationFlags: {reason: "racy=LIKELY", source: "auto", offendingPath: path(U, L, "1_3_d.jpg")}};
  const p = P.planApproval(l);
  assert.equal(p.noop, false); assert.equal(p.setActive, true); assert.equal(p.clearFlags, true);
  assert.equal(p.photos.length, 3); assert.equal(P.objectPathFromUrl(p.prunedUrl), path(U, L, "1_3_d.jpg"));
  assert.deepEqual(p.variantGaps, []);
});
test("planApproval: flag already pruned at deletion (removedPhotoUrl set) → no double prune", () => {
  const l = {...four(), status: "flagged", moderationFlags: {reason: "racy=LIKELY", offendingPath: path(U, L, "1_3_d.jpg"), removedPhotoUrl: "x", photoDeleted: true}};
  l.photos = l.photos.slice(0, 3); delete l.photoVariants["3"];
  const p = P.planApproval(l);
  assert.equal(p.noop, false); assert.equal(p.prunedUrl, null); assert.equal(p.photos, undefined);
});
test("planApproval: scan-error flag keeps the object → no prune, reports variant gaps for backfill", () => {
  const l = {status: "flagged", photos: [url(U, L, "1_0_a.jpg"), url(U, L, "1_1_b.jpg")], photoVariants: {},
    moderationFlags: {reason: "image_scan_error", source: "auto", offendingPath: path(U, L, "1_0_a.jpg")}};
  const p = P.planApproval(l);
  assert.equal(p.noop, false); assert.equal(p.prunedUrl, null); assert.deepEqual(p.variantGaps, [0, 1]);
});
test("planApproval: sold listing with a stale flag → clear flag, do NOT resurrect", () => {
  const l = {...four(), status: "sold", moderationFlags: {reason: "image_scan_error", offendingPath: "x"}};
  const p = P.planApproval(l);
  assert.equal(p.noop, false); assert.equal(p.setActive, false); assert.equal(p.clearFlags, true);
  assert.deepEqual(P.planApproval({...four(), status: "sold"}), {noop: true, reason: "status-sold"});
});
test("planApproval: nothing left to show → no-op with reason no-photos", () => {
  const l = {status: "flagged", photos: [], photoVariants: {}, moderationFlags: {reason: "no_photos", offendingPath: "x", removedPhotoUrl: "u"}};
  const p = P.planApproval(l);
  assert.equal(p.noop, true); assert.equal(p.reason, "no-photos");
});
test("variantGaps lists indices without a w400 entry", () => {
  assert.deepEqual(P.variantGaps({photos: ["a", "b", "c"], photoVariants: {"1": {w400: "x"}}}), [0, 2]);
});
