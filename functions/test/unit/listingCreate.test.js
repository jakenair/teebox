// Seller Integrations Phase 0: seller gate, bulk daily cap, photo attach.
// See functions/lib/listingCreate.js.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const C = require("../../lib/listingCreate");

// Minimal in-memory Firestore: doc().get/set/update, collection().doc(), runTransaction.
function fakeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  let n = 0;
  const snap = (p) => ({exists: store.has(p), data: () => store.get(p), id: p.split("/").pop()});
  const ref = (p) => ({path: p, id: p.split("/").pop(),
    get: async () => snap(p),
    set: async (d, o) => { store.set(p, o && o.merge ? {...(store.get(p) || {}), ...d} : {...d}); },
    update: async (d) => { store.set(p, {...store.get(p), ...d}); }});
  const db = {
    store,
    doc: (p) => ref(p),
    collection: (c) => ({doc: (id) => ref(`${c}/${id || "auto" + (++n)}`)}),
    runTransaction: async (fn) => fn({
      get: async (r) => snap(r.path),
      set: (r, d, o) => store.set(r.path, o && o.merge ? {...(store.get(r.path) || {}), ...d} : {...d}),
      update: (r, d) => store.set(r.path, {...store.get(r.path), ...d}),
    }),
  };
  return db;
}
const TS = {fromMillis: (ms) => ({toMillis: () => ms})};
const FV = {serverTimestamp: () => "ts"};
const URL = (i) => `https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/listings%2Fu1%2FL1%2F${i}.jpg?alt=media`;

test("bulk cap: 25 standard, 200 Pro or integration-approved, admin override wins", () => {
  assert.equal(C.bulkCapFor({}), 25);
  assert.equal(C.bulkCapFor({tier: "free"}), 25);
  assert.equal(C.bulkCapFor({tier: "pro"}), 200);
  assert.equal(C.bulkCapFor({integrationsApproved: true}), 200);
  assert.equal(C.bulkCapFor({bulkDailyCap: 500}), 500);
  assert.equal(C.bulkCapFor({tier: "pro", bulkDailyCap: 10}), 10);
  assert.equal(C.bulkCapFor({bulkDailyCap: "lots"}), 25);
});

test("quota: grants up to the cap in a rolling 24h window, then resets", async () => {
  const db = fakeDb();
  const t0 = 1e12;
  let r = await C.reserveBulkQuota({db, Timestamp: TS, uid: "u1", want: 20, cap: 25, nowMs: t0});
  assert.equal(r.granted, 20);
  r = await C.reserveBulkQuota({db, Timestamp: TS, uid: "u1", want: 20, cap: 25, nowMs: t0 + 1000});
  assert.equal(r.granted, 5);
  r = await C.reserveBulkQuota({db, Timestamp: TS, uid: "u1", want: 1, cap: 25, nowMs: t0 + 2000});
  assert.equal(r.granted, 0);
  await C.releaseBulkQuota({db, uid: "u1", n: 3});
  r = await C.reserveBulkQuota({db, Timestamp: TS, uid: "u1", want: 5, cap: 25, nowMs: t0 + 3000});
  assert.equal(r.granted, 3);
  r = await C.reserveBulkQuota({db, Timestamp: TS, uid: "u1", want: 200, cap: 200, nowMs: t0 + 864e5 + 1});
  assert.equal(r.granted, 200, "a new 24h window starts fresh");
});

test("seller gate: verified email (or phone), not banned, Seller Terms agreed", async () => {
  const auth = (u) => ({getUser: async () => u});
  const db = fakeDb({"users/ok": {sellerVerified: true, sellerAge18At: 1}, "users/banned": {sellerVerified: true, sellerAge18At: 1, banned: true},
    "users/noterms": {}, "users/pro": {sellerVerified: true, sellerAge18At: 1, tier: "pro"}, "users/noage": {sellerVerified: true}});
  const ok = await C.assertSellerCanList({db, auth: auth({emailVerified: true}), uid: "ok"});
  assert.equal(ok.cap, 25);
  assert.equal((await C.assertSellerCanList({db, auth: auth({emailVerified: true}), uid: "pro"})).cap, 200);
  await C.assertSellerCanList({db, auth: auth({emailVerified: false, providerData: [{providerId: "phone"}]}), uid: "ok"});
  await assert.rejects(C.assertSellerCanList({db, auth: auth({emailVerified: false, providerData: []}), uid: "ok"}), /Verify your email/);
  await assert.rejects(C.assertSellerCanList({db, auth: auth({emailVerified: true}), uid: "banned"}), /can't list/);
  await assert.rejects(C.assertSellerCanList({db, auth: auth({emailVerified: true}), uid: "noterms"}), /Seller Terms/);
  await assert.rejects(C.assertSellerCanList({db, auth: auth({emailVerified: true}), uid: "noage"}), /18 or older/);
  await assert.rejects(C.assertSellerCanList({db, auth: auth({emailVerified: true, disabled: true}), uid: "ok"}), /disabled/);
});

test("photo attach: only our bucket URLs; $300+ short of 4 photos is taken down, not left live", async () => {
  const db = fakeDb({
    "listings/A": {sellerId: "u1", ask: 120, status: "active", photos: []},
    "listings/B": {sellerId: "u1", ask: 450, status: "active", photos: []},
    "listings/C": {sellerId: "u2", ask: 50, status: "active", photos: []},
  });
  let r = await C.attachListingPhotos({db, FieldValue: FV, uid: "u1", listingId: "A", urls: [URL(1), "https://evil.example/x.jpg"]});
  assert.deepEqual(r, {ok: true, photos: 1});
  assert.deepEqual(db.store.get("listings/A").photos, [URL(1)]);
  r = await C.attachListingPhotos({db, FieldValue: FV, uid: "u1", listingId: "B", urls: [URL(1), URL(2), URL(3)]});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "needs-4-photos");
  assert.equal(db.store.get("listings/B").status, "hidden");
  assert.equal(db.store.get("listings/B").hiddenReason, "photos_missing");
  r = await C.attachListingPhotos({db, FieldValue: FV, uid: "u1", listingId: "C", urls: [URL(1)]});
  assert.equal(r.reason, "not-yours");
});

test("createListingDoc writes an active Sell-form document with source tag", async () => {
  const db = fakeDb();
  const S = require("../../lib/listingSchema");
  const v = S.validateListingInput({title: "Scotty Cameron Newport 2", brand: "Scotty Cameron", category: "putter",
    condition: "Very Good", price: "325", specs: {model: "Newport 2", length: "34", "head style": "blade", dexterity: "RH"},
    photoCount: 4}).value;
  const id = await C.createListingDoc({db, FieldValue: FV, Timestamp: TS, uid: "u1", value: v, source: "csv", nowMs: 1e12});
  const d = db.store.get("listings/" + id);
  assert.equal(d.status, "active");
  assert.equal(d.source, "csv");
  assert.equal(d.specs.length, "34\"");
  assert.equal(d.specs.headStyle, "Blade");
  assert.equal(d.requiresAuth, true);
});
