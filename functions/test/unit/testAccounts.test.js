"use strict";
// Shared QA exclusion (lib/testAccounts.js) + proof that a QA listing creates
// ZERO notifications for a real user's matching saved search
// (lib/savedSearchFanout.js, the body of notifyOnSavedSearchMatch).
const test = require("node:test");
const assert = require("node:assert");
const ta = require("../../lib/testAccounts");
const {savedSearchFanout} = require("../../lib/savedSearchFanout");

// ── tiny in-memory Firestore ──────────────────────────────────────────
function fakeDb(seed) {
  const docs = new Map(Object.entries(seed || {})); // "col/id[/sub/id]" -> data
  let auto = 0;
  const ref = (path) => ({
    id: path.split("/").pop(), path,
    get: async () => ({exists: docs.has(path), id: path.split("/").pop(), data: () => docs.get(path)}),
    set: async (d) => { docs.set(path, d); },
    collection: (c) => col(path + "/" + c),
  });
  const col = (path) => ({
    doc: (id) => ref(path + "/" + (id || "auto" + (++auto))),
    where: (f, op, v) => ({
      limit: () => ({
        get: async () => {
          const hits = [...docs.entries()].filter(([k, d]) =>
            k.startsWith(path + "/") && k.split("/").length === path.split("/").length + 1 && d[f] === v);
          return {size: hits.length, docs: hits.map(([k, d]) => ({id: k.split("/").pop(), data: () => d})),
            forEach(fn) { hits.forEach(([k, d]) => fn({id: k.split("/").pop(), data: () => d})); }};
        },
      }),
    }),
  });
  return {db: {collection: col}, docs};
}
const fakeAuth = (emails) => ({getUser: async (uid) => {
  if (!(uid in emails)) { const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; }
  return {uid, email: emails[uid]};
}});
const matchesClubs = (l, q) => !q || !q.category || l.cat === q.category;
const notifsFor = (docs, uid) => [...docs.keys()].filter((k) => k.startsWith(`users/${uid}/notifications/`));

test("QA email / uid / listing classification", () => {
  for (const e of ["a@teeboxqa.dev", "x@teeboxtest.invalid", "jakenair+qa417@teeboxmarket.com", "JakeNair+QA@TeeboxMarket.com"]) assert.ok(ta.isTestEmail(e), e);
  for (const e of ["jakenair@teeboxmarket.com", "justin@cleveland-company.com", "qa@gmail.com", "jakenair+promo@teeboxmarket.com", ""]) assert.ok(!ta.isTestEmail(e), e);
  assert.ok(ta.isTestListingDoc({}, "mg_test_listing"));
  assert.ok(ta.isTestListingDoc({}, "qa_filter_golf_1116"));
  assert.ok(ta.isTestListingDoc({isTest: true}, "abc"));
  assert.ok(ta.isTestListingDoc({sellerId: "mg_seller"}, "abc"));
  assert.ok(!ta.isTestListingDoc({sellerId: "TOhaTLDQB3QVsBIq2ilvKmfcyA22"}, "NkObaz8CmXPEzgDpgYkY"));
});

test("isTestUid: users doc flag, Auth QA email, fixed QA uid; real user is not test; lookup errors fail open", async () => {
  const {db} = fakeDb({"users/flagged": {isTestAccount: true}, "users/real": {}});
  const ctx = {db, auth: fakeAuth({flagged: "a@gmail.com", qaMail: "z@teeboxqa.dev", real: "real@gmail.com"}), cache: new Map()};
  assert.strictEqual(await ta.isTestUid("flagged", ctx), true);
  assert.strictEqual(await ta.isTestUid("qaMail", ctx), true);
  assert.strictEqual(await ta.isTestUid("mg_seller", ctx), true);
  assert.strictEqual(await ta.isTestUid("real", ctx), false);
  assert.strictEqual(await ta.isTestUid("ghost", ctx), false);
  const broken = {db: {collection: () => { throw new Error("down"); }}, auth: fakeAuth({}), cache: new Map()};
  assert.strictEqual(await ta.isTestUid("someone", broken), false);
});

for (const [label, listingId, seed, listing] of [
  ["money-gate listing (mg_ ids)", "mg_test_listing", {}, {sellerId: "mg_seller"}],
  ["QA seller flagged isTestAccount", "L1", {"users/qaSeller": {isTestAccount: true}}, {sellerId: "qaSeller"}],
  ["QA seller with a jakenair+qa Auth email", "L2", {"users/qaPlus": {}}, {sellerId: "qaPlus"}],
  ["listing flagged isTest", "L3", {"users/realSeller": {}}, {sellerId: "realSeller", isTest: true}],
]) {
  test(`a QA listing creates ZERO notifications for a real user: ${label}`, async () => {
    const {db, docs} = fakeDb({
      ...seed,
      "users/realBuyer": {},
      "savedSearches/s1": {userId: "realBuyer", notifyOnNew: true, query: {category: "clubs"}, name: "clubs"},
    });
    const auth = fakeAuth({qaPlus: "jakenair+qa418@teeboxmarket.com", realSeller: "s@gmail.com", realBuyer: "b@gmail.com"});
    const r = await savedSearchFanout({
      db, listingId, listing: {title: "QA Money Gate Test Wedge", cat: "clubs", ask: 120, status: "active", ...listing},
      matches: matchesClubs, scanCap: 200, now: () => new Date(), testCtx: {db, auth, cache: new Map()},
    });
    assert.strictEqual(r.matched, 0);
    assert.strictEqual(r.skipped, "test-listing");
    assert.deepStrictEqual(notifsFor(docs, "realBuyer"), []);
  });
}

test("control: the same listing from a REAL seller does notify the real user once", async () => {
  const {db, docs} = fakeDb({
    "users/realSeller": {}, "users/realBuyer": {},
    "savedSearches/s1": {userId: "realBuyer", notifyOnNew: true, query: {category: "clubs"}, name: "clubs"},
  });
  const r = await savedSearchFanout({
    db, listingId: "realListing1", listing: {title: "Titleist T100 irons", cat: "clubs", ask: 700, status: "active", sellerId: "realSeller"},
    matches: matchesClubs, scanCap: 200, now: () => new Date(),
    testCtx: {db, auth: fakeAuth({realSeller: "s@gmail.com"}), cache: new Map()},
  });
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(notifsFor(docs, "realBuyer").length, 1);
});
