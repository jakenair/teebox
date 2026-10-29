// lib/capiCarry — the checkout → PaymentIntent metadata → order → Purchase chain, offline.
const test = require("node:test");
const assert = require("node:assert/strict");
const {capiFromRequest, capiMetadata, orderCapiFields} = require("../../lib/capiCarry");
const {_internal: M} = require("../../metaCapi");

const H = {"user-agent": "UA/1", "x-forwarded-for": "203.0.113.9, 10.0.0.1"};
test("opted-IN checkout: match keys carried, no opt-out marker; order sends Purchase", () => {
  const c = capiFromRequest({fbp: "fb.1.1.a", fbc: "fb.1.1.b"}, H);
  const md = capiMetadata(c);
  assert.deepEqual(md, {capiFbp: "fb.1.1.a", capiFbc: "fb.1.1.b", capiIp: "203.0.113.9", capiUa: "UA/1"});
  const order = {status: "paid", livemode: true, ...orderCapiFields(md)};
  assert.equal(order.capiOptOut, false);
  assert.equal(M.purchaseSkipReason(order), "");
});
test("opted-OUT checkout: marker is the string '1' in metadata only; order skips Purchase with 'opted-out'", () => {
  const c = capiFromRequest({metaOptOut: true}, H);
  const md = capiMetadata(c);
  assert.deepEqual(md, {capiIp: "203.0.113.9", capiUa: "UA/1", capiOptOut: "1"});
  for (const v of Object.values(md)) assert.equal(typeof v, "string");
  const order = {status: "paid", livemode: true, ...orderCapiFields(md)};
  assert.equal(order.capiOptOut, true);
  assert.equal(M.purchaseSkipReason(order), "opted-out");
});
test("metadata carries ONLY capi keys — never amount/fee/transfer/order fields", () => {
  const md = capiMetadata(capiFromRequest({fbp: "x", metaOptOut: true, amount: 1, platformFeeCents: 0}, H));
  assert.deepEqual(Object.keys(md).sort(), ["capiFbp", "capiIp", "capiOptOut", "capiUa"]);
});
test("marker is strict: only boolean true opts out (strings/1/'true' do not)", () => {
  for (const v of ["true", 1, "1", {}, null, undefined]) assert.equal(capiFromRequest({metaOptOut: v}, H).capiOptOut, false);
});
test("orderCapiFields: legacy PI without capi metadata → nulls + capiOptOut false (stable shape)", () => {
  assert.deepEqual(orderCapiFields(undefined), {fbp: null, fbc: null, checkoutIp: null, checkoutUa: null, capiOptOut: false});
});
