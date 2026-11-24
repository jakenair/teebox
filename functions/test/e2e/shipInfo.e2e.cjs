"use strict";
// ZIP estimate, carrier tracking and ship-by reminders against the emulator.
// Shippo, Resend and push are stubs. Run: run-ship-e2e.sh
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("emulator only"); process.exit(2); }
process.env.GCLOUD_PROJECT = "demo-teebox";
const assert = require("node:assert/strict");
const path = require("node:path");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const sent = [], pushes = [];
const stub = (p, exp) => { const f = require.resolve(path.join("../..", p)); const real = require(f); require.cache[f].exports = {...real, ...exp}; };
stub("lib/email.js", {sendEmail: async (o) => { sent.push(o); return {sent: true, id: "x"}; }});
stub("lib/push.js", {sendPush: async (uid, m) => { pushes.push([uid, m.kind]); }});
stub("lib/emailRecipient.js", {resolveUserEmail: async (uid) => ({uid, email: uid ? uid + "@example.test" : null})});
const X = require("../../shippingInfo")._internal;
let n = 0; const ok = (m) => { n++; console.log("ok", n, m); };
const TS = admin.firestore.Timestamp;
const L = (o) => ({title: "Irons", cat: "clubs", ask: 200, status: "active", sellerId: "s1", specs: {shipBox: "partial"}, ...o});
(async () => {
  const now = Date.parse("2026-11-23T18:00:00Z");
  await db.doc("listings/listE1").set(L()); await db.doc("listings/listE2").set(L({cat: "shoes"})); await db.doc("listings/listE3").set(L({status: "hidden"}));
  let calls = 0; const quote = async (_d, _l, to) => { calls++; assert.deepEqual(to, {zip: "90001", country: "US"}); return {shippingCents: 3870, estimatedDays: 4}; };
  const a = (id, o) => X.estimate(db, {listingId: id, zip: "90001", ip: "1.1.1.1", nowMs: now, ...o}, quote);
  let e = await a("listE1");
  assert.deepEqual([e.shippingCents, e.protectionCents, e.totalCents, e.from, e.to], [3870, 250, 4120, "2026-12-01", "2026-12-03"]); ok("estimate: carrier + protection, delivery window");
  await a("listE1"); assert.equal(calls, 1); ok("cached per listing and ZIP");
  await db.doc("listings/listE1").update({ask: 90}); e = await a("listE1"); assert.equal(e.protectionCents, 0); assert.equal(calls, 1); ok("price change: protection follows, no new quote");
  await db.doc("listings/listE1").update({"specs.shipBox": "full"}); await a("listE1"); assert.equal(calls, 2); ok("box change: new quote");
  await a("listE1", {nowMs: now + 25 * 36e5}); assert.equal(calls, 3); ok("a day later: new quote");
  for (const [id, code] of [["listE2", "failed-precondition"], ["listE3", "not-found"], ["nothere1", "not-found"]]) { await assert.rejects(a(id), (x) => x.code === code); } ok("flat items, hidden and missing listings refused");
  let limited = 0; for (let i = 0; i < 25; i++) { await db.doc("listings/rl" + i + "xxxxx").set(L()); try { await a("rl" + i + "xxxxx", {ip: "2.2.2.2"}); } catch (x) { if (x.code === "resource-exhausted") limited++; } }
  assert.equal(limited, 5); ok("rate limited per IP");
  // tracking
  const order = (id, o) => db.doc("orders/" + id).set({buyerId: "b1", sellerId: "s1", listingId: "listE1", amount: 100, status: "paid", fulfillmentStatus: "awaiting_seller_shipment", livemode: true,
    trackingNumber: "9400TEST1", carrier: "USPS", shippoTransactionId: "tx1", createdAt: TS.fromMillis(now - 864e5), ...o});
  const get = async (id) => (await db.doc("orders/" + id).get()).data();
  const track = (status) => async (c, num) => { assert.deepEqual([c, num], ["usps", "9400TEST1"]); return {tracking_status: {status, status_date: "2026-11-24T10:00:00Z", status_details: "scan", location: {city: "Chicago", state: "IL"}}, tracking_history: [], eta: "2026-11-27T00:00:00Z"}; };
  const run = (status) => X.handleTracking(db, {carrier: "fedex", number: "9400TEST1"}, {track: track(status), notify: X.notifyTracking});
  await order("o1"); await order("o2", {shippoTransactionId: null, trackingNumber: "SELLER1"});
  await run("PRE_TRANSIT"); assert.equal((await get("o1")).fulfillmentStatus, "awaiting_seller_shipment"); assert.equal(sent.length, 0); ok("label only: no change, no email; Shippo's carrier from the order, not the post");
  await run("TRANSIT"); let o = await get("o1");
  assert.deepEqual([o.fulfillmentStatus, o.shippingStatus, o.shippedSource, o.estimatedDelivery, o.trackingEvents.length], ["shipped", "shipped", "carrier", "2026-11-27", 1]); assert.ok(o.shippedAt);
  assert.deepEqual(sent.map((s) => [s.template, s.to]), [["OrderShipped", "b1@example.test"]]); assert.deepEqual(pushes, [["b1", "order-shipped"]]); ok("first scan: shipped, buyer emailed and pushed once");
  await run("TRANSIT"); assert.equal(sent.length, 1); ok("repeat webhook: nothing sent");
  await run("DELIVERED"); o = await get("o1");
  assert.deepEqual([o.fulfillmentStatus, o.deliveredSource, o.sellerStatsApplied], ["delivered", "carrier", true]); assert.ok(o.deliveredAt);
  assert.deepEqual(sent.slice(1).map((s) => s.template).sort(), ["DeliveredBuyer", "DeliveredSeller"]);
  assert.equal((await db.doc("profiles/s1").get()).data().salesCount, 1); assert.equal((await db.doc("users/s1").get()).data().totalRevenue, 100); ok("delivered: both emailed, seller stats once");
  await run("DELIVERED"); await run("TRANSIT"); assert.equal((await get("o1")).fulfillmentStatus, "delivered"); assert.equal((await db.doc("profiles/s1").get()).data().salesCount, 1); assert.equal(sent.length, 3); ok("late or repeated scans never move it back or count twice");
  let asked = 0; await X.handleTracking(db, {carrier: "usps", number: "SELLER1"}, {track: async () => { asked++; }, notify: async () => {}}); assert.equal(asked, 0); ok("a number the seller typed in is never looked up");
  await order("o3", {trackingNumber: "REF1", refunded: true}); await X.handleTracking(db, {carrier: "usps", number: "REF1"}, {track: async () => track("DELIVERED")("usps", "9400TEST1"), notify: async () => { throw new Error("no"); }});
  assert.equal((await get("o3")).fulfillmentStatus, "awaiting_seller_shipment"); ok("refunded orders don't move");
  assert.equal(X.tokenOk("a".repeat(32), "a".repeat(32)), true); for (const [g, w] of [["", ""], ["x", "a".repeat(32)], ["short", "short"]]) assert.equal(X.tokenOk(g, w), false); ok("webhook token");
  // reminders: order placed Mon Nov 16
  for (const d of await db.collection("orders").listDocuments()) await d.delete();
  sent.length = 0; pushes.length = 0;
  const placed = TS.fromMillis(Date.parse("2026-11-16T16:00:00Z"));
  await order("r1", {createdAt: placed}); await order("r2", {createdAt: placed, sellerId: "qa_x"}); await order("r3", {createdAt: placed, refunded: true}); await order("r4", {createdAt: placed, fulfillmentStatus: "shipped"});
  const day = (d) => X.runReminders(db, Date.parse(`2026-11-${d}T15:00:00Z`), X.sendReminder);
  await day(17); assert.equal(sent.length, 0); await day(18); await day(18);
  assert.deepEqual(sent.map((s) => [s.template, s.to, s.subject]), [["ShipReminder", "s1@example.test", "Ship by tomorrow: Irons"]]); ok("day 2: one reminder, real unshipped orders only");
  await day(19); assert.equal(sent[1].subject, "Ship today: Irons"); await day(20); assert.equal(sent.length, 2); ok("day 3: one, then silence");
  console.log(`PASS ${n}`); process.exit(0);
})().catch((err) => { console.error("FAIL", err); process.exit(1); });
