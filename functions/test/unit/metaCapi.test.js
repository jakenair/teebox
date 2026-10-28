// functions/test/unit/metaCapi.test.js — hashing + user_data assembly.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {_internal: M} = require("../../metaCapi");
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

test("hashEmail trims + lowercases before hashing (Meta normalisation)", () => {
  assert.equal(M.hashEmail("  Golfer@Example.COM "), sha("golfer@example.com"));
  assert.equal(M.hashEmail(""), ""); assert.equal(M.hashEmail("nope"), "");
});
test("hashPhone keeps digits only incl. country code, drops +, leading zeros", () => {
  assert.equal(M.hashPhone("+1 (312) 555-1234"), sha("13125551234"));
  assert.equal(M.hashPhone("0013125551234"), sha("13125551234"));
  assert.equal(M.hashPhone("123"), "");
  assert.equal(M.hashPhone(undefined), "");
});
test("buildUserData: order keys + verified extra; nothing plaintext", () => {
  const ud = M.buildUserData(
      {fbp: "fb.1.1.2", fbc: "fb.1.1.abc", checkoutIp: "1.2.3.4", checkoutUa: "UA", buyerId: "u1", receiptEmail: "A@b.co"},
      {phone: "+13125551234"}, {sendHashedPhone: true});
  assert.deepEqual(Object.keys(ud).sort(), ["client_ip_address", "client_user_agent", "em", "external_id", "fbc", "fbp", "ph"]);
  assert.equal(ud.em, sha("a@b.co"));
  assert.equal(ud.ph, sha("13125551234"));
  for (const v of Object.values(ud)) { assert.ok(!/@/.test(v) && !/\+1/.test(v)); }
});
test("buildUserData: no phone → no ph key; missing email → no em key", () => {
  const ud = M.buildUserData({buyerId: "u1"}, {});
  assert.deepEqual(Object.keys(ud), ["external_id"]);
});
test("external_id is the SHA-256 of the uid, never the raw uid (2026-10-26)", () => {
  const ud = M.buildUserData({buyerId: "u1"}, {});
  assert.equal(ud.external_id, sha("u1"));
  assert.notEqual(ud.external_id, "u1");
  assert.equal(M.hashExternalId(""), "");
});
test("ph is OFF by default and only sent when config/meta.sendHashedPhone === true", () => {
  const order = {buyerId: "u1", receiptEmail: "a@b.co"};
  assert.ok(!("ph" in M.buildUserData(order, {phone: "+13125551234"})));
  assert.ok(!("ph" in M.buildUserData(order, {phone: "+13125551234"}, {sendHashedPhone: "true"})));
  assert.equal(M.buildUserData(order, {phone: "+13125551234"}, {sendHashedPhone: true}).ph, sha("13125551234"));
});

test("relay allowlist: ListingStarted is relayed (auth-only), Purchase never, anon set is only the two browse events (r386)", () => {
  assert.ok(M.CAPI_RELAY_EVENTS.has("ListingStarted"));
  assert.ok(!M.CAPI_ANON_EVENTS.has("ListingStarted"));
  assert.ok(!M.CAPI_RELAY_EVENTS.has("Purchase"));
  assert.deepEqual([...M.CAPI_ANON_EVENTS].sort(), ["PageView", "ViewContent"]);
  for (const e of M.CAPI_ANON_EVENTS) assert.ok(M.CAPI_RELAY_EVENTS.has(e), e + " must also be in the relay set");
  assert.deepEqual([...M.CAPI_RELAY_EVENTS].sort(), ["AddToCart", "CompleteRegistration", "InitiateCheckout", "ListingCreated", "ListingStarted", "PageView", "ViewContent"]);
});

test("claimOnce: first call per uid claims, every later call is refused (r387 CompleteRegistration gate)", async () => {
  const store = new Map();
  const fakeDb = {
    collection: (c) => ({doc: (id) => ({path: c + "/" + id})}),
    runTransaction: async (fn) => fn({
      get: async (ref) => ({exists: store.has(ref.path)}),
      set: (ref, data) => { store.set(ref.path, data); },
    }),
  };
  assert.equal(await M.claimOnce(fakeDb, "u1", "cr_u1"), true);
  assert.equal(await M.claimOnce(fakeDb, "u1", "cr_u1"), false);
  assert.equal(await M.claimOnce(fakeDb, "u1", "cr_u1_again"), false);
  assert.equal(await M.claimOnce(fakeDb, "u2", "cr_u2"), true);
  assert.equal(store.get("capiRelayOnce/u1").eventId, "cr_u1");
});
