// functions/test/unit/authReview.test.js — $300+ review rules and both feeds.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../lib/authReview");
const {_feed: F} = require("../../metaFeed");

const L = (o) => ({id: "abc123", status: "active", title: "Putter", cat: "clubs", ask: 400, sellerId: "s1",
  requiresAuth: true, authReviewState: "pending", condition: "Good",
  photos: ["https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg?alt=media"], ...o});

test("who needs review: the flag or a $300 ask", () => {
  assert.equal(R.needsAuthReview({ask: 299.99}), false);
  assert.equal(R.needsAuthReview({ask: 300, requiresAuth: false, authReviewState: "na"}), true);
  assert.equal(R.needsAuthReview({ask: 100, requiresAuth: true}), true);
  for (const st of ["pending", "rejected", "na", undefined]) {
    assert.equal(R.authReviewPassed(L({authReviewState: st})), false, String(st));
  }
  assert.equal(R.authReviewPassed(L({authReviewState: "approved"})), true);
});

test("feed: left out until approved, then in stock, whatever the status", () => {
  assert.equal(F.feedRow(L()), null);
  assert.equal(F.feedRow(L({status: "pending"})), null);
  assert.equal(F.feedRow(L({requiresAuth: false, authReviewState: "na"})), null);
  assert.equal(F.feedRow(L({authReviewState: "approved"})).availability, "in stock");
  assert.ok(F.feedRow(L({ask: 299, requiresAuth: false, authReviewState: "na"})));
});

test("approve", () => {
  assert.equal(R.planDecision(L(), "approve").update.authReviewState, "approved");
  assert.equal(R.planDecision(L(), "approve").update.status, undefined);
  assert.equal(R.planDecision(L({authReviewState: "approved"}), "approve").noop, true);
  assert.ok(R.planDecision(L({ask: 50, requiresAuth: false}), "approve").error);
});

test("reject needs a reason, takes the listing down, and an approve puts it back", () => {
  assert.ok(R.planDecision(L(), "reject", "  ").error);
  const u = R.planDecision(L({status: "hidden"}), "reject", "Fake").update;
  assert.deepEqual(u, {authReviewState: "rejected", authReviewReason: "Fake", status: "removed",
    removedReason: "authenticity_review", authReviewPrevStatus: "hidden"});
  const back = R.planDecision(L({status: "removed", authReviewState: "rejected", authReviewPrevStatus: "hidden"}), "approve").update;
  assert.equal(back.status, "hidden");
  assert.ok("removedAt" in back && back.removedAt === undefined);
  // removed by a person for some other reason: an approve never restores it
  assert.ok(R.planDecision(L({status: "removed"}), "approve").error);
  // flagged by moderation: approving the review leaves the flag alone
  assert.equal(R.planDecision(L({status: "flagged", moderationFlags: {reason: "x"}}), "approve").update.status, undefined);
});

test("nothing else undoes a reject: low price, clean photo re-scan, moderation approve", async () => {
  assert.equal(R.authReviewPassed(L({ask: 50, requiresAuth: false, authReviewState: "rejected"})), false);
  const {clearAutoFlagIfClean} = require("../../lib/autoClearFlag");
  let wrote = false;
  const ref = {get: async () => ({exists: true, data: () => L({status: "flagged", authReviewState: "rejected",
    moderationFlags: {source: "auto", reason: "image_scan_error"}})}), update: async () => { wrote = true; }};
  const r = await clearAutoFlagIfClean({db: {collection: () => ({doc: () => ref})}, FieldValue: {}, logger: console},
      {listingId: "a", sellerId: "s", objPath: "p", annotation: {}});
  assert.equal(r, false);
  assert.equal(wrote, false);
  const {planApproval} = require("../../lib/photoPrune");
  assert.ok(!planApproval(L({status: "flagged", authReviewState: "rejected", moderationFlags: {reason: "image_scan_error"}})).setActive);
});

test("refuses during checkout and on finished listings", () => {
  for (const d of ["approve", "reject"]) {
    assert.match(R.planDecision(L({status: "pending"}), d, "r").error, /checking out/);
    assert.match(R.planDecision(L({quantityReserved: 1}), d, "r").error, /checking out/);
    for (const s of ["sold", "removed"]) assert.ok(R.planDecision(L({status: s}), d, "r").error);
  }
  assert.ok(R.planDecision(L(), "maybe").error);
});

test("edits that reopen an approved review: photos, title, brand, category, specs, condition", () => {
  const specs = {brand: "Ping", model: "Anser", length: "34\"", flex: ""};
  const cur = L({brand: "Ping", cat: "clubs", specCategory: "putter", specs, desc: "Clean", authReviewState: "approved", photos: ["a", "b"]});
  const same = {title: "Putter", brand: "Ping", photos: ["b", "a"], cat: "clubs", specCategory: "putter", specs: {...specs}, condition: "Good"};
  const ch = (o) => R.reviewChanges(cur, {...same, ...o});
  assert.deepEqual(ch({}), []);
  assert.deepEqual(ch({title: "Other"}), ["title"]);
  assert.deepEqual(ch({photos: ["a", "c"]}), ["photos"]);
  assert.deepEqual(ch({brand: "Scotty", specs: {...specs, brand: "Scotty"}}), ["brand"]);
  assert.deepEqual(ch({cat: "bags"}), ["category"]);
  assert.deepEqual(ch({specCategory: "driver"}), ["category"]);
  assert.deepEqual(ch({cat: "bags", specCategory: "bag"}), ["category"], "named once");
  assert.deepEqual(ch({specs: {...specs, model: "Newport"}}), ["specs"]);
  assert.deepEqual(ch({specs: {...specs, brand: "Scotty"}}), ["specs"], "the brand shown in specs can't differ unseen");
  assert.deepEqual(ch({specs: {...specs, grip: "Pistol"}}), ["specs"]);
  assert.deepEqual(ch({specs: {model: "Anser"}}), ["specs"]);
  assert.deepEqual(ch({condition: "Fair"}), ["condition"]);
  // what doesn't count
  assert.deepEqual(ch({specs: {length: "34\"", model: " Anser ", brand: "Ping"}}), [], "key order, empty and missing values");
  assert.deepEqual(ch({specs: {model: "Anser", length: "34\"", grip: null}}), [], "the copied brand may be left out");
  assert.deepEqual(ch({specs: {...specs, shipBox: "putter-48"}}), [], "shipping box");
  assert.deepEqual(ch({ask: 100, desc: "Other words", quantity: 4}), []);
  const {cat, specCategory, specs: _s, condition, ...older} = same;
  assert.deepEqual(R.reviewChanges(cur, older), [], "fields that weren't edited");
  assert.deepEqual(R.reviewChanges({...cur, authReviewState: "pending"}, {...same, condition: "Fair"}), []);
  assert.deepEqual(R.reviewChanges({...cur, ask: 100, requiresAuth: false}, {...same, condition: "Fair"}), []);
});
