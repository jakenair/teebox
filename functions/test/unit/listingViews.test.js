// functions/test/unit/listingViews.test.js — recordListingView core (r421).
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../../lib/listingViews");

// Minimal in-memory Firestore: collection().doc(), runTransaction with get /
// update (dotted paths + increment/delete/serverTimestamp sentinels) / set.
function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const ref = (path) => ({path});
  const db = {
    store,
    collection: (c) => ({doc: (id) => ref(`${c}/${id}`)}),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => ({exists: store.has(r.path), data: () => store.get(r.path)}),
        update: (r, u) => writes.push(() => {
          const d = store.get(r.path); if (!d) throw new Error("no doc " + r.path);
          for (const [k, v] of Object.entries(u)) {
            const parts = k.split("."); let o = d;
            for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
            const last = parts[parts.length - 1];
            if (v && v.__inc) o[last] = (Number(o[last]) || 0) + v.__inc;
            else if (v && v.__del) delete o[last];
            else if (v && v.__ts) o[last] = {ts: true};
            else o[last] = v;
          }
        }),
        set: (r, d) => writes.push(() => {
          const out = {}; for (const [k, v] of Object.entries(d)) out[k] = v && v.__ts ? {ts: true} : v;
          store.set(r.path, Object.assign({}, store.get(r.path) || {}, out));
        }),
      };
      const res = await fn(tx);
      writes.forEach((w) => w());
      return res;
    },
  };
  return db;
}
const FieldValue = {increment: (n) => ({__inc: n}), delete: () => ({__del: true}), serverTimestamp: () => ({__ts: true})};
const NOW = Date.UTC(2026, 10, 19, 15, 0, 0);
const ANON = "a1b2c3d4e5f6a7b8c9d0e1f2";
const listing = (extra = {}) => ({"listings/L1": {sellerId: "seller", status: "active", ...extra}});
const call = (db, o) => V.recordView({db, FieldValue, listingId: "L1", ip: "1.2.3.4", now: NOW, ...o});

test("dayKey / lastDays / sumWindow / staleKeys", () => {
  assert.equal(V.dayKey(NOW), "20261119");
  assert.deepEqual(V.lastDays(NOW, 3), ["20261119", "20261118", "20261117"]);
  const vd = {"20261119": 2, "20261113": 5, "20261112": 100, "20261101": 9};
  assert.equal(V.sumWindow(vd, NOW), 7); // 19th + 13th; the 12th is day 8, outside 7
  assert.deepEqual(V.staleKeys(vd, NOW).sort(), ["20261101"]); // KEEP_DAYS 8 keeps the 12th
  assert.equal(V.sumWindow(null, NOW), 0);
});

test("anon id validation and marker ids", () => {
  assert.equal(V.validAnonId(ANON), true);
  assert.equal(V.validAnonId("short"), false);
  assert.equal(V.validAnonId("has spaces in it 123456"), false);
  assert.equal(V.markerId("L1", "u1"), "L1_u1"); // same id as the pre-r421 counter
  assert.match(V.markerId("L1", null, ANON), /^L1_a_[0-9a-f]{24}$/);
});

test("a guest view counts once, writes viewDays + shard + views7d", async () => {
  const db = fakeDb(listing());
  const r = await call(db, {anonId: ANON});
  assert.deepEqual(r, {counted: true, views7d: 1});
  const l = db.store.get("listings/L1");
  assert.equal(l.viewDays["20261119"], 1);
  assert.equal(l.views7d, 1);
  assert.equal(Object.keys(l).filter((k) => /^views_\d$/.test(k)).length, 1);
});

test("same viewer within 24h is deduped; after 24h counts again", async () => {
  const db = fakeDb(listing());
  assert.equal((await call(db, {uid: "buyer"})).counted, true);
  assert.deepEqual(await call(db, {uid: "buyer", now: NOW + 3600e3}), {counted: false, reason: "dedupe"});
  assert.equal((await call(db, {uid: "buyer", now: NOW + 25 * 3600e3})).counted, true);
});

test("seller's own view never counts", async () => {
  const db = fakeDb(listing());
  assert.deepEqual(await call(db, {uid: "seller"}), {counted: false, reason: "self"});
  assert.equal(db.store.get("listings/L1").viewDays, undefined);
});

test("no viewer id, bad listing id, missing listing", async () => {
  const db = fakeDb(listing());
  assert.equal((await call(db, {})).reason, "no-viewer");
  assert.equal((await call(db, {anonId: "bad"})).reason, "no-viewer");
  assert.equal((await call(db, {uid: "u", listingId: "../x"})).reason, "bad-listing");
  assert.equal((await call(db, {uid: "u", listingId: "NOPE"})).reason, "no-listing");
});

test("per-IP-per-listing daily cap stops one IP pumping a listing", async () => {
  const db = fakeDb(listing());
  for (let i = 0; i < V.IP_LISTING_DAILY_MAX; i++) {
    assert.equal((await call(db, {anonId: ANON + "x" + i})).counted, true);
  }
  assert.deepEqual(await call(db, {anonId: ANON + "zz"}), {counted: false, reason: "ip-listing"});
  // A different IP still counts.
  assert.equal((await call(db, {anonId: ANON + "zz", ip: "5.6.7.8"})).counted, true);
  // Next UTC day the cap resets.
  assert.equal((await call(db, {anonId: ANON + "zz", now: NOW + 864e5})).counted, true);
});

test("per-IP hourly cap across listings", async () => {
  const seed = {};
  for (let i = 0; i < V.IP_HOURLY_MAX + 1; i++) seed[`listings/M${i}`] = {sellerId: "s", status: "active"};
  const db = fakeDb(seed);
  for (let i = 0; i < V.IP_HOURLY_MAX; i++) {
    assert.equal((await V.recordView({db, FieldValue, listingId: `M${i}`, anonId: ANON, ip: "9.9.9.9", now: NOW})).counted, true);
  }
  const r = await V.recordView({db, FieldValue, listingId: `M${V.IP_HOURLY_MAX}`, anonId: ANON, ip: "9.9.9.9", now: NOW});
  assert.deepEqual(r, {counted: false, reason: "ip-hourly"});
  const later = await V.recordView({db, FieldValue, listingId: `M${V.IP_HOURLY_MAX}`, anonId: ANON, ip: "9.9.9.9", now: NOW + 3600e3});
  assert.equal(later.counted, true);
});

test("old day buckets are pruned on the next counted view; views7d is the 7-day sum", async () => {
  const db = fakeDb(listing({viewDays: {"20261101": 40, "20261115": 4}}));
  const r = await call(db, {uid: "buyer"});
  assert.equal(r.views7d, 5);
  assert.deepEqual(db.store.get("listings/L1").viewDays, {"20261115": 4, "20261119": 1});
});
