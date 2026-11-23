// functions/test/unit/photoScan.test.js — an unscanned photo never goes back on sale (2026-11-23).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../../lib/photoPrune");
const {clearAutoFlagIfClean} = require("../../lib/autoClearFlag");

const u = (n) => `https://firebasestorage.googleapis.com/v0/b/b/o/listings%2FS%2FL%2F${n}?alt=media&token=t`;
const pth = (n) => `listings/S/L/${n}`;
const v = (n) => ({w400: u(n + "_w400.webp")});
const BAD = pth("1_0_bad.jpg");
const base = (o) => ({status: "flagged", flaggedFrom: "active", photos: [u("1_0_bad.jpg"), u("1_1_ok.jpg")], photoVariants: {1: v("1_1_ok.jpg")},
  moderationFlags: {source: "auto", reason: "image_process_error", offendingPath: BAD}, ...o});
async function run(doc, objPath) {
  let wrote = null;
  const ref = {get: async () => ({exists: true, data: () => doc}), update: async (x) => { wrote = x; }, set: async () => {}};
  const db = {collection: () => ({doc: () => ref, add: async () => {}})};
  const r = await clearAutoFlagIfClean({db, FieldValue: {delete: () => "DEL", serverTimestamp: () => 0}, logger: {info() {}, warn() {}, error() {}}},
      {listingId: "L", sellerId: "S", objPath, annotation: {}});
  return {cleared: r, status: wrote && wrote.status};
}

test("a clean second photo does not release a listing with an unscanned first photo", async () => {
  assert.deepEqual(await run(base(), pth("1_1_ok.jpg")), {cleared: false, status: null});
  assert.deepEqual(await run(base({photoVariants: {1: v("1_1_ok.jpg"), 2: v("2_2_new.jpg")}}), pth("2_2_new.jpg")), {cleared: false, status: null});
});
test("a later flag on another photo doesn't hide the first one: every photo must have passed", async () => {
  const d = base({photos: [u("1_0_bad.jpg"), u("1_1_b.jpg")], photoVariants: {},
    moderationFlags: {source: "auto", reason: "image_scan_error", offendingPath: pth("1_1_b.jpg")}});
  assert.equal((await run(d, pth("1_1_b.jpg"))).cleared, false);
});
test("released when the flagged photo itself passes, or the seller removed it and the rest have passed", async () => {
  assert.deepEqual(await run(base(), BAD), {cleared: true, status: "active"});
  assert.deepEqual(await run(base({photos: [u("1_1_ok.jpg")]}), ""), {cleared: true, status: "active"});
  assert.equal((await run(base({photos: [u("1_1_ok.jpg"), u("9_9_unscanned.jpg")]}), "")).cleared, false);
  assert.equal((await run(base({photos: []}), "")).cleared, false);
});
test("released to what it was: a listing waiting for payouts stays hidden, a lapsed hold isn't restored", async () => {
  assert.equal((await run(base({flaggedFrom: "hidden", hiddenReason: "awaiting_payouts"}), BAD)).status, "hidden");
  assert.equal((await run(base({flaggedFrom: undefined, hiddenReason: "awaiting_payouts"}), BAD)).status, "hidden");
  assert.equal((await run(base({flaggedFrom: "expired"}), BAD)).status, "expired");
  assert.equal((await run(base({flaggedFrom: "pending", pendingUntil: {toMillis: () => 1}}), BAD)).status, "active");
});
test("flagging twice keeps the first status", () => {
  assert.deepEqual(P.flagStatus({status: "hidden"}), {status: "flagged", flaggedFrom: "hidden"});
  assert.deepEqual(P.flagStatus({status: "flagged", flaggedFrom: "hidden"}), {status: "flagged"});
});
test("proof of a scan is the server's copy of that exact file, not just any copy", () => {
  assert.deepEqual(P.unscannedPhotos({photos: [u("a.jpg")], photoVariants: {0: v("b.jpg")}}), [pth("a.jpg")]);
  assert.deepEqual(P.unscannedPhotos({photos: [u("a.jpg")], photoVariants: {3: v("a.jpg")}}), []);
  assert.deepEqual(P.unscannedPhotos({photos: ["https://elsewhere/x"]}), ["https://elsewhere/x"]);
});
test("the scanner skips only its own mark, never a file name", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../index.js"), "utf8");
  const i = src.indexOf("exports.optimizeListingPhoto");
  const head = src.slice(i, src.indexOf("const bucket = admin.storage()", i));
  assert.doesNotMatch(head, /_w\(/);
  assert.match(head, /metadata\.optimized === "true"/);
});
