const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../../lib/shipBy");
const T = require("../../lib/shipTracking");
const at = (s) => Date.parse(s);

test("holidays and business days", () => {
  const h = B.holidays(2026);
  for (const d of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"]) assert.ok(h.has(d), d);
  assert.ok(B.holidays(2027).has("2027-07-05"), "Sunday the 4th is observed on Monday");
  assert.equal(B.isBusinessDay("2026-11-26"), false);
  assert.equal(B.isBusinessDay("2026-11-27"), true);
});
test("ship-by: 3 business days, Central, weekends and Thanksgiving skipped", () => {
  assert.equal(B.shipBy(at("2026-11-23T16:00:00Z")).date, "2026-11-27"); // Mon → Tue, Wed, (Thu off) Fri
  assert.equal(B.shipBy(at("2026-11-21T16:00:00Z")).date, "2026-11-25"); // Sat → Mon, Tue, Wed
  assert.equal(B.shipBy(at("2026-11-24T04:00:00Z")).date, "2026-11-27"); // still Monday in Chicago
  assert.equal(new Date(B.shipBy(at("2026-11-23T16:00:00Z")).dueMs).toISOString(), "2026-11-28T05:59:59.999Z");
});
test("reminders on business day 2 and 3 only, once each, never when shipped, refunded or test", () => {
  const o = (x) => ({fulfillmentStatus: "awaiting_seller_shipment", livemode: true, createdAtMs: at("2026-11-16T16:00:00Z"), ...x}); // Monday
  const day = (d) => at(`2026-11-${d}T15:00:00Z`);
  assert.equal(B.reminderDue(o(), day(17)), null);
  assert.equal(B.reminderDue(o(), day(18)), 2);
  assert.equal(B.reminderDue(o({shipReminder2At: 1}), day(18)), null);
  assert.equal(B.reminderDue(o({shipReminder2At: 1}), day(19)), 3);
  assert.equal(B.reminderDue(o(), day(20)), null);
  for (const x of [{refunded: true}, {refundedAt: 1}, {livemode: false}, {shippedAt: 1}, {fulfillmentStatus: "shipped"}, {createdAtMs: NaN}]) assert.equal(B.reminderDue(o(x), day(18)), null);
  assert.equal(B.reminderDue(o({createdAtMs: at("2026-11-19T16:00:00Z")}), day(21)), null, "never on a Saturday");
});
const tr = (status, o) => ({tracking_status: {status, status_date: "2026-11-20T10:00:00Z", status_details: "x", location: {city: "Chicago", state: "IL"}, ...(o || {})},
  tracking_history: [{status: "PRE_TRANSIT", status_date: "2026-11-19T10:00:00Z", status_details: "Label"}], eta: "2026-11-23T00:00:00Z"});
test("tracking: summary, order of events, junk ignored", () => {
  const t = T.summarize(tr("TRANSIT"));
  assert.deepEqual([t.status, t.eta, t.events.map((e) => e.status)], ["TRANSIT", "2026-11-23", ["PRE_TRANSIT", "TRANSIT"]]);
  assert.equal(t.events[1].place, "Chicago, IL");
  assert.equal(T.summarize(tr("TRANSIT", {substatus: {code: "out_for_delivery"}})).status, "OUT_FOR_DELIVERY");
  assert.equal(T.summarize({}), null);
  assert.equal(T.summarize({tracking_status: {status: "NOPE"}}).status, "UNKNOWN");
  assert.deepEqual(["USPS", "UPS", "FedEx", "DHL Express", "Pony"].map(T.carrierToken), ["usps", "ups", "fedex", "dhl_express", null]);
});
test("tracking moves an order forward only, once", () => {
  const p = (o, s, x) => T.plan(o, T.summarize(tr(s, x)));
  const a = {fulfillmentStatus: "awaiting_seller_shipment"};
  assert.equal(p(a, "PRE_TRANSIT").shipped, false);
  assert.deepEqual([p(a, "TRANSIT").shipped, p(a, "TRANSIT").update.fulfillmentStatus], [true, "shipped"]);
  const d = p({fulfillmentStatus: "shipped"}, "DELIVERED");
  assert.deepEqual([d.shipped, d.delivered, d.update.fulfillmentStatus], [false, true, "delivered"]);
  const both = p(a, "DELIVERED");
  assert.deepEqual([both.shipped, both.delivered], [true, true]);
  const done = p({fulfillmentStatus: "delivered"}, "TRANSIT");
  assert.equal(done.update.fulfillmentStatus, undefined);
  assert.equal(p({refunded: true, fulfillmentStatus: "shipped"}, "DELIVERED"), null);
  const t = T.summarize(tr("TRANSIT"));
  assert.equal(T.plan({fulfillmentStatus: "shipped", trackingStatus: "TRANSIT", trackingEvents: t.events, estimatedDelivery: t.eta}, t), null);
  assert.equal(p({fulfillmentStatus: "shipped"}, "RETURNED").update.fulfillmentStatus, undefined);
});
