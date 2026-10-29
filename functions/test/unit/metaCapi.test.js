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

// ── Purchase (standard event) — 2026-10-29 ───────────────────────────────
const paidOrder = {status: "paid", livemode: true, listingId: "L1", buyerId: "u1", currency: "usd", quantity: 1, itemCents: 12000, shippingCents: 1500, amountCents: 13500, unitPriceCents: 12000};
test("buildPurchaseEvent: standard Purchase, event_id = purchase_<pi>, content_ids = [listingId], value = ITEM price (not buyer total)", () => {
  const ev = M.buildPurchaseEvent({order: paidOrder, orderId: "pi_123", userData: {em: "x"}, now: 1700000000});
  assert.equal(ev.event_name, "Purchase");
  assert.equal(ev.event_id, "purchase_pi_123");
  assert.equal(ev.action_source, "website");
  assert.equal(ev.event_time, 1700000000);
  assert.deepEqual(ev.custom_data, {currency: "USD", value: 120, content_type: "product", content_ids: ["L1"], order_id: "pi_123", num_items: 1});
  assert.equal(ev.event_source_url, "https://teeboxmarket.com/listing/L1/");
  assert.ok(!("test_event_code" in ev));
});
test("buildPurchaseEvent: test_event_code attached only when config/meta sets it", () => {
  const ev = M.buildPurchaseEvent({order: paidOrder, orderId: "pi_1", userData: {}, cfg: {testEventCode: "TEST1"}});
  assert.equal(ev.test_event_code, "TEST1");
});
test("purchaseValueDollars: itemCents → unitPriceCents×qty → amountCents fallbacks", () => {
  assert.equal(M.purchaseValueDollars({itemCents: 12000, amountCents: 13500}), 120);
  assert.equal(M.purchaseValueDollars({unitPriceCents: 2500, quantity: 2, amountCents: 6000}), 50);
  assert.equal(M.purchaseValueDollars({amountCents: 3500}), 35);
  assert.equal(M.purchaseValueDollars({}), 0);
});
test("purchaseSkipReason: paid+live sends; pending, and Stripe TEST-mode never send; legacy orders without livemode still send", () => {
  assert.equal(M.purchaseSkipReason(paidOrder), "");
  assert.equal(M.purchaseSkipReason({...paidOrder, status: "pending"}), "not-paid");
  assert.equal(M.purchaseSkipReason({...paidOrder, livemode: false}), "test-mode");
  assert.equal(M.purchaseSkipReason({...paidOrder, livemode: undefined}), "");
  assert.equal(M.purchaseSkipReason(null), "not-paid");
});
