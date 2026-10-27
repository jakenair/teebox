// Unit tests for lib/disputeReversal — a lost chargeback must debit the
// seller's transfer, and a failed reversal must be recorded as a failure.
// Runs against an injected fake Stripe client (no network, no test mode).
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../../lib/disputeReversal");

const FieldValue = {serverTimestamp: () => "TS", delete: () => "DELETE"};
const quiet = {info() {}, warn() {}, error() {}};
function logSpy() {
  const calls = {info: [], warn: [], error: []};
  return {calls, info: (m) => calls.info.push(String(m)), warn: (m) => calls.warn.push(String(m)), error: (m) => calls.error.push(String(m))};
}
function fakeOrderRef() {
  const writes = [];
  return {writes, set: async (data, opts) => { writes.push({data, opts}); }};
}

test("resolveCharge: legacy charges.data[0] shape", async () => {
  const ch = await lib.resolveCharge({charges: {data: [{id: "ch_1", transfer: "tr_1"}]}}, {});
  assert.equal(ch.id, "ch_1");
  assert.equal(lib.transferIdFromCharge(ch), "tr_1");
});

test("resolveCharge: latest_charge id → charges.retrieve (current API shape)", async () => {
  let asked = null;
  const stripe = {charges: {retrieve: async (id) => { asked = id; return {id, transfer: {id: "tr_2"}, payment_method_details: {card: {fingerprint: "fp_9"}}}; }}};
  const ch = await lib.resolveCharge({id: "pi_x", latest_charge: "ch_2"}, stripe);
  assert.equal(asked, "ch_2");
  assert.equal(lib.transferIdFromCharge(ch), "tr_2");
  assert.equal(lib.cardFingerprintFromCharge(ch), "fp_9");
});

test("resolveCharge: expanded latest_charge object needs no fetch", async () => {
  const ch = await lib.resolveCharge({latest_charge: {id: "ch_3", transfer: "tr_3"}}, {charges: {retrieve: async () => { throw new Error("should not fetch"); }}});
  assert.equal(lib.transferIdFromCharge(ch), "tr_3");
});

test("resolveCharge: no charge at all → null", async () => {
  assert.equal(await lib.resolveCharge({id: "pi_none"}, {}), null);
  assert.equal(lib.transferIdFromCharge(null), null);
});

test("lost dispute: seller transfer reversed for exactly the seller share, fee not refunded", async () => {
  const reversals = [];
  const stripe = {
    transfers: {createReversal: async (id, params, opts) => { reversals.push({id, params, opts}); return {id: "trr_1", amount: params.amount}; }},
    paymentIntents: {retrieve: async () => { throw new Error("not needed"); }},
  };
  const orderRef = fakeOrderRef();
  const out = await lib.reverseSellerTransferForDispute({
    dispute: {id: "du_1", payment_intent: "pi_1"},
    order: {transferId: "tr_1", sellerPayoutCents: 3202},
    orderRef, stripe, logger: quiet, FieldValue,
  });
  assert.equal(out.ok, true);
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].id, "tr_1");
  assert.equal(reversals[0].params.amount, 3202);
  assert.equal(reversals[0].params.refund_application_fee, false);
  assert.equal(reversals[0].opts.idempotencyKey, "rev_du_1");
  const w = orderRef.writes[0].data;
  assert.equal(w.sellerDebited, true);
  assert.equal(w.reversalId, "trr_1");
  assert.equal(w.reversedCents, 3202);
  assert.equal(w.reversalError, "DELETE");
});

test("lost dispute: order never captured transferId → resolved via latest_charge, then reversed", async () => {
  const stripe = {
    paymentIntents: {retrieve: async (id, opts) => { assert.deepEqual(opts, {expand: ["latest_charge"]}); return {id, latest_charge: {id: "ch_9", transfer: "tr_9"}}; }},
    transfers: {createReversal: async (id) => ({id: "trr_9", amount: 1000})},
  };
  const orderRef = fakeOrderRef();
  const out = await lib.reverseSellerTransferForDispute({
    dispute: {id: "du_9", payment_intent: "pi_9"},
    order: {sellerPayoutCents: 1000},
    orderRef, stripe, logger: quiet, FieldValue,
  });
  assert.equal(out.ok, true);
  assert.equal(out.transferId, "tr_9");
  assert.equal(orderRef.writes[0].data.transferId, "tr_9");
  assert.equal(orderRef.writes[0].data.sellerDebited, true);
});

test("failure path: reversal throws → sellerDebited:false, reversalError recorded, logged as error", async () => {
  const stripe = {
    transfers: {createReversal: async () => { const e = new Error("balance_insufficient: Insufficient funds in connected account"); throw e; }},
    paymentIntents: {retrieve: async () => ({})},
  };
  const orderRef = fakeOrderRef(); const log = logSpy();
  const out = await lib.reverseSellerTransferForDispute({
    dispute: {id: "du_f", payment_intent: "pi_f"},
    order: {transferId: "tr_f", sellerPayoutCents: 500},
    orderRef, stripe, logger: log, FieldValue,
  });
  assert.equal(out.ok, false);
  const w = orderRef.writes[0].data;
  assert.equal(w.sellerDebited, false);
  assert.match(w.reversalError, /balance_insufficient/);
  assert.equal(w.reversalFailedAt, "TS");
  assert.equal(log.calls.error.length, 1);
  assert.match(log.calls.error[0], /reversal FAILED/);
});

test("no transfer anywhere → sellerDebited:false with reversalError no-transfer-id, never throws", async () => {
  const stripe = {
    paymentIntents: {retrieve: async () => ({id: "pi_n"})},
    transfers: {createReversal: async () => { throw new Error("must not be called"); }},
  };
  const orderRef = fakeOrderRef(); const log = logSpy();
  const out = await lib.reverseSellerTransferForDispute({
    dispute: {id: "du_n", payment_intent: "pi_n"},
    order: {},
    orderRef, stripe, logger: log, FieldValue,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "no-transfer-id");
  assert.equal(orderRef.writes[0].data.sellerDebited, false);
  assert.equal(orderRef.writes[0].data.reversalError, "no-transfer-id");
  assert.equal(log.calls.error.length, 1);
});
