"use strict";
// stripeWebhook takedown + missing-listing refund, and the delete guard.
// Emulator only; Stripe, Resend and the ops alert are stubs. Run: run-checkout-e2e.sh
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("emulator only"); process.exit(2); }
Object.assign(process.env, {GCLOUD_PROJECT: "demo-teebox-guest", STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_WEBHOOK_SECRET: "whsec_stub",
  RESEND_API_KEY: "re_stub", UNSUBSCRIBE_SECRET: "u", OPS_ALERT_WEBHOOK: "", POSTHOG_API_KEY: "", META_CAPI_TOKEN: ""});
const path = require("node:path"); const fs = require("node:fs"); const Module = require("node:module"); const assert = require("node:assert/strict");
const FN = path.join(__dirname, "../..");
const CALLS = []; let failRefunds = 0; const ALERTS = [];
const stripeStub = () => ({
  charges: {retrieve: async (id) => ({id, transfer: "tr_1", payment_method_details: {card: {fingerprint: "fp"}}})},
  refunds: {create: async (p, o) => {
    CALLS.push({p, key: o && o.idempotencyKey});
    if (failRefunds > 0) { failRefunds--; const e = new Error("stripe down"); e.code = "api_error"; throw e; }
    return {id: "re_" + p.payment_intent, amount: p.amount};
  }},
  paymentIntents: {retrieve: async () => ({})},
  webhooks: {constructEvent: (raw) => JSON.parse(raw.toString("utf8"))},
});
const stub = (file, exp) => { const p = fs.realpathSync(file); const m = new Module(p); m.exports = exp; m.loaded = true; m.filename = p; require.cache[p] = m; };
stub(require.resolve("stripe", {paths: [FN]}), stripeStub);
const oa = require(path.join(FN, "opsAlert.js"));
stub(path.join(FN, "opsAlert.js"), {...oa, opsAlert: async (lvl, msg, info) => { ALERTS.push({lvl, msg, info}); }});
global.fetch = async () => { throw new Error("network blocked"); };
const fns = require(path.join(FN, "index.js"));
const admin = require("firebase-admin"); const db = admin.firestore(); const TS = admin.firestore.Timestamp;
let n = 0; const ok = (m) => { n++; console.log("ok", n, m); };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
let ev = 0;
async function hook(type, pi) {
  const body = Buffer.from(JSON.stringify({id: "evt_" + (++ev), type, created: Math.floor(Date.now() / 1000), data: {object: pi}}));
  return new Promise((done) => {
    const res = {statusCode: 200, headers: {}, on() { return this; }, once() { return this; }, setHeader() {}, getHeader() {}, removeHeader() {}, set() { return this; },
      status(c) { this.statusCode = c; return this; }, json(b) { done({s: this.statusCode, b}); }, send(b) { done({s: this.statusCode, b}); }, end() { done({s: this.statusCode}); }};
    fns.stripeWebhook({method: "POST", headers: {"stripe-signature": "x"}, rawBody: body, body, url: "/", path: "/", get() {}, on() {}}, res);
  });
}
const pi = (id, lid, o = {}) => ({id, amount: 12345, currency: "usd", livemode: false, latest_charge: "ch_" + id,
  metadata: {listingId: lid, buyerId: "buyer1", sellerId: "seller1", platformFeeCents: "850", sellerPayoutCents: "9150", quantity: "1",
    unitPriceCents: "10000", itemCents: "10000", shippingCents: "2345", shippingMethod: "flat", ...o}});
const later = () => TS.fromMillis(Date.now() + 9e5); const past = () => TS.fromMillis(Date.now() - 1000);
const L = (o) => ({title: "Wedge", brand: "B", cat: "clubs", ask: 100, sellerId: "seller1", status: "active", quantity: 1, quantitySold: 0, quantityReserved: 0, ...o});
const held = (id, o) => ({pendingPaymentIntentId: id, pendingBuyer: "buyer1", pendingUntil: later(), quantityReserved: 1, ...o});
const put = (lid, o) => db.doc("listings/" + lid).set(L(o));
const call = (data, uid) => fns.deleteListing.run({data, auth: uid ? {uid, token: {}} : undefined, rawRequest: {}});
const refused = async (p, code, msg) => { try { await p; } catch (e) { assert.equal(e.code, code, e.message); if (msg) assert.equal(e.message, msg); return; } assert.fail("expected " + code); };
const HOLD = "This item is in a buyer's checkout — try again in a few minutes";

(async () => {
  // ── ordinary sales are unchanged
  await put("s1", {status: "pending", ...held("pi_s1")});
  let r = await hook("payment_intent.succeeded", pi("pi_s1", "s1")); assert.equal(r.s, 200);
  let o = await get("orders/pi_s1"); let l = await get("listings/s1");
  assert.deepEqual([o.amountCents, o.itemCents, o.shippingCents, o.platformFeeCents, o.sellerPayoutCents, o.transferId, o.status],
      [12345, 10000, 2345, 850, 9150, "tr_1", "paid"]);
  assert.deepEqual([l.status, l.quantitySold, l.quantityReserved, l.soldTo, l.orderId, l.pendingPaymentIntentId], ["sold", 1, 0, "buyer1", "pi_s1", undefined]);
  ok("single unit: sold, order amounts/fee/payout/transfer as before");
  await put("m1", {quantity: 3, ...held("pi_m1")});
  await hook("payment_intent.succeeded", pi("pi_m1", "m1")); l = await get("listings/m1");
  assert.deepEqual([l.status, l.quantitySold, l.quantityReserved, l.soldAt], ["active", 1, 0, undefined]); ok("multi-unit: active with units left");
  await put("m2", {status: "pending", quantity: 2, quantitySold: 1, ...held("pi_m2")});
  await hook("payment_intent.succeeded", pi("pi_m2", "m2")); assert.equal((await get("listings/m2")).status, "sold"); ok("multi-unit last unit: sold");
  await hook("payment_intent.succeeded", pi("pi_m1", "m1")); assert.equal((await get("listings/m1")).quantitySold, 1); ok("redelivery counts once");
  assert.equal(CALLS.length, 0); ok("no refund on any ordinary sale");
  // ── takedowns
  const down = {status: "removed", removedReason: "counterfeit", removedAt: TS.now()};
  await put("t1", {...down, ...held("pi_t1")});
  await hook("payment_intent.succeeded", pi("pi_t1", "t1")); l = await get("listings/t1");
  assert.deepEqual([l.status, l.removedReason, l.quantitySold], ["removed", "counterfeit", 1]); assert.ok(await get("orders/pi_t1")); ok("takedown before payment, single unit: stays removed, order recorded");
  await put("t2", {quantity: 4, ...held("pi_t2")});
  await db.doc("listings/t2").update(down); // admin takes it down while the buyer pays
  await hook("payment_intent.succeeded", pi("pi_t2", "t2")); l = await get("listings/t2");
  assert.deepEqual([l.status, l.quantitySold, l.quantityReserved, l.removedReason], ["removed", 1, 0, "counterfeit"]); ok("takedown mid-checkout, multi-unit: stays removed, counters right");
  await put("t3", {quantity: 4, quantitySold: 1, ...down, ...held("pi_t3")});
  await hook("payment_intent.succeeded", pi("pi_t3", "t3")); assert.equal((await get("listings/t3")).status, "removed"); ok("multi-unit already taken down: stays removed");
  await put("t4", {quantity: 2, quantitySold: 1, ...down, ...held("pi_t4")});
  await hook("payment_intent.succeeded", pi("pi_t4", "t4")); assert.equal((await get("listings/t4")).status, "removed"); ok("last unit of a taken-down listing: stays removed, not sold");
  await fns.refundOrder.run({data: {orderId: "pi_t4"}, auth: {uid: "seller1", token: {}}, rawRequest: {}});
  assert.equal((await get("listings/t4")).status, "removed"); assert.equal(CALLS.length, 1); CALLS.length = 0; ok("refunding that order doesn't restore it");
  for (const st of ["flagged", "hidden"]) {
    await put("f_" + st, {quantity: 3, status: st, ...held("pi_f" + st)});
    await hook("payment_intent.succeeded", pi("pi_f" + st, "f_" + st)); assert.equal((await get("listings/f_" + st)).status, st);
  }
  ok("flagged or hidden mid-checkout: not restored either");
  for (const t of ["payment_failed", "canceled"]) {
    await put("x_" + t, {quantity: 3, ...down, ...held("pi_x" + t)});
    await hook("payment_intent." + t, pi("pi_x" + t, "x_" + t)); l = await get("listings/x_" + t);
    assert.deepEqual([l.status, l.quantityReserved], ["removed", 0]);
  }
  ok("failed or canceled payment after a takedown: stays removed, units released");
  await put("x2", {status: "pending", ...held("pi_x2")});
  await hook("payment_intent.payment_failed", pi("pi_x2", "x2")); assert.equal((await get("listings/x2")).status, "active"); ok("ordinary failed payment still releases the listing");
  // ── paid for a listing that no longer exists
  ALERTS.length = 0;
  r = await hook("payment_intent.succeeded", pi("pi_gone", "gone")); assert.equal(r.s, 200);
  assert.deepEqual(CALLS, [{p: {payment_intent: "pi_gone", reason: "requested_by_customer", refund_application_fee: true, reverse_transfer: true}, key: "orphan_refund_pi_gone"}]);
  assert.equal(await get("orders/pi_gone"), null); o = await get("orphanPayments/pi_gone");
  assert.deepEqual([o.status, o.refundId, o.amountCents, o.listingId], ["refunded", "re_pi_gone", 12345, "gone"]);
  assert.equal(ALERTS.length, 1); assert.equal(ALERTS[0].lvl, "critical"); assert.match(ALERTS[0].msg, /refunded automatically/); ok("missing listing: full refund once, no order, logged, founder alerted");
  await hook("payment_intent.succeeded", pi("pi_gone", "gone")); assert.equal(CALLS.length, 1); assert.equal(ALERTS.length, 1); ok("redelivery: no second refund, no second alert");
  CALLS.length = 0; ALERTS.length = 0; failRefunds = 1;
  r = await hook("payment_intent.succeeded", pi("pi_retry", "gone2")); assert.equal(r.s, 500); assert.equal((await get("orphanPayments/pi_retry")).status, "refund_failed"); assert.match(ALERTS[0].msg, /FAILED/);
  r = await hook("payment_intent.succeeded", pi("pi_retry", "gone2")); assert.equal(r.s, 200); assert.equal((await get("orphanPayments/pi_retry")).status, "refunded");
  assert.deepEqual(CALLS.map((c) => c.key), ["orphan_refund_pi_retry", "orphan_refund_pi_retry"]); ok("refund fails: Stripe is asked to retry, same idempotency key, then refunded");
  CALLS.length = 0;
  await hook("payment_intent.processing", pi("pi_ghost", "ghost")); assert.equal(await get("listings/ghost"), null); ok("a processing payment never re-creates a deleted listing");
  await db.doc("listings/ghost2").set({pendingUntil: later()});
  await hook("payment_intent.succeeded", pi("pi_g2", "ghost2")); assert.equal(CALLS.length, 1); assert.equal(await get("orders/pi_g2"), null); ok("an empty ghost document counts as missing");
  CALLS.length = 0;
  // ── seller delete
  const hold = async (lid, o) => { await put(lid, o); await refused(call({listingId: lid}, "seller1"), "failed-precondition", HOLD); assert.ok(await get("listings/" + lid)); };
  await hold("d1", {status: "pending", ...held("pi_d1")}); ok("delete refused: reserved (last unit)");
  await hold("d2", {quantity: 3, ...held("pi_d2")}); ok("delete refused: multi-unit with a unit in checkout");
  await hold("d3", {status: "pending", quantityReserved: 1}); ok("delete refused: hold with no window recorded");
  await put("d4", {quantity: 3}); await hook("payment_intent.processing", pi("pi_d4", "d4"));
  await refused(call({listingId: "d4"}, "seller1"), "failed-precondition", HOLD); ok("delete refused: a payment is still settling");
  await hook("payment_intent.payment_failed", pi("pi_d4", "d4")); await call({listingId: "d4"}, "seller1"); assert.equal(await get("listings/d4"), null); ok("that payment fails: delete works");
  await put("d5", {status: "pending", ...held("pi_d5"), pendingUntil: past()}); await call({listingId: "d5"}, "seller1"); assert.equal(await get("listings/d5"), null); ok("hold lapsed: delete works");
  await put("d6", {}); await refused(call({listingId: "d6"}, "other"), "permission-denied"); await refused(call({listingId: "d6"}, null), "unauthenticated"); ok("only the owner, signed in");
  await put("d7", {status: "sold"}); await refused(call({listingId: "d7"}, "seller1"), "failed-precondition"); ok("sold listing can't be deleted");
  await refused(call({listingId: "nope"}, "seller1"), "not-found"); await refused(call({listingId: "a/b"}, "seller1"), "invalid-argument"); ok("missing and malformed ids");
  await call({listingId: "d6"}, "seller1"); assert.equal(await get("listings/d6"), null); ok("ordinary delete works");
  console.log(`PASS ${n}`); process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
