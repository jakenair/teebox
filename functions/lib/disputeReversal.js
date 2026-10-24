// functions/lib/disputeReversal.js
//
// Chargeback → seller debit, done honestly.
//
// Background (audit 2026-10-24): orders.transferId was read from
// pi.charges.data[0].transfer. On the API version this project pins
// (stripe@22, 2026 "dahlia"), PaymentIntent payloads no longer carry a
// `charges` list — only `latest_charge` — so transferId was never captured,
// the funds_withdrawn backstop (same `charges` read) found nothing, and no
// seller was ever debited for a lost dispute. Worse, a reversal that threw
// was still recorded as `sellerDebited: true`.
//
// This module is pure logic over an injected Stripe client so it can be
// unit-tested without Stripe test mode. index.js wires it into
// handlePaymentSucceeded (capture) and handleDisputeFundsWithdrawn (reverse).

/**
 * Resolve the Charge for a PaymentIntent payload, whichever API shape we got.
 * Returns null when there is no charge to read (e.g. PI without latest_charge).
 * @param {object} pi PaymentIntent (webhook payload or retrieve() result)
 * @param {object} stripe Stripe client (needs charges.retrieve)
 * @return {Promise<object|null>}
 */
async function resolveCharge(pi, stripe) {
  if (!pi) return null;
  // Legacy shape (expanded or pre-2022 API): charges.data[0]
  const legacy = pi.charges && pi.charges.data && pi.charges.data[0];
  if (legacy) return legacy;
  // Current shape: latest_charge is an id string, or the object when expanded.
  const lc = pi.latest_charge;
  if (!lc) return null;
  if (typeof lc === "object") return lc;
  if (!stripe || !stripe.charges || typeof stripe.charges.retrieve !== "function") return null;
  return stripe.charges.retrieve(lc);
}

/** @return {string|null} transfer id from a Charge, or null */
function transferIdFromCharge(ch) {
  if (!ch || !ch.transfer) return null;
  return typeof ch.transfer === "string" ? ch.transfer : (ch.transfer.id || null);
}

/** @return {string|null} card fingerprint from a Charge, or null */
function cardFingerprintFromCharge(ch) {
  const card = ch && ch.payment_method_details && ch.payment_method_details.card;
  return (card && card.fingerprint) || null;
}

/**
 * Reverse the seller's transfer for a lost dispute and record what happened.
 *
 * Writes to orderRef (merge):
 *   success  → {disputeFundsWithdrawn:true, sellerDebited:true,  reversalId, reversedCents}
 *   no xfer  → {disputeFundsWithdrawn:true, sellerDebited:false, reversalError:"no-transfer-id"}
 *   throw    → {disputeFundsWithdrawn:true, sellerDebited:false, reversalError:<message>}
 * Never throws; returns the outcome for logging/tests.
 *
 * @param {object} p
 * @param {object} p.dispute Stripe Dispute (needs id, payment_intent)
 * @param {object} p.order   orders/{pi} data (transferId?, sellerPayoutCents?)
 * @param {object} p.orderRef Firestore DocumentReference for the order
 * @param {object} p.stripe  Stripe client
 * @param {object} p.logger  firebase-functions logger (or console)
 * @param {object} p.FieldValue admin.firestore.FieldValue
 * @return {Promise<{ok:boolean, transferId:string|null, reversalId?:string, error?:string}>}
 */
async function reverseSellerTransferForDispute({dispute, order, orderRef, stripe, logger, FieldValue}) {
  const piId = dispute.payment_intent;
  const ts = FieldValue.serverTimestamp();
  let transferId = (order && order.transferId) || null;

  if (!transferId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(piId, {expand: ["latest_charge"]});
      transferId = transferIdFromCharge(await resolveCharge(pi, stripe));
    } catch (e) {
      logger.warn(`funds_withdrawn: PI retrieve failed for ${piId}: ${e.message}`);
    }
  }

  if (!transferId) {
    logger.error(`funds_withdrawn: no transferId for ${piId}; seller NOT debited`);
    await orderRef.set({
      disputeFundsWithdrawn: true,
      sellerDebited: false,
      reversalError: "no-transfer-id",
      disputeFundsWithdrawnAt: ts,
    }, {merge: true});
    return {ok: false, transferId: null, error: "no-transfer-id"};
  }

  const sellerPayoutCents = Number((order && order.sellerPayoutCents) || 0);
  try {
    const rev = await stripe.transfers.createReversal(transferId, {
      amount: sellerPayoutCents > 0 ? sellerPayoutCents : undefined,
      // Only the seller's share comes back. The platform fee is NOT refunded
      // to the seller on a lost dispute (the old code passed
      // refund_application_fee:true, which handed part of the fee back).
      refund_application_fee: false,
      metadata: {reason: "chargeback", disputeId: dispute.id, orderId: piId},
    }, {idempotencyKey: `rev_${dispute.id}`});
    await orderRef.set({
      disputeFundsWithdrawn: true,
      sellerDebited: true,
      transferId,
      reversalId: rev && rev.id ? rev.id : null,
      reversedCents: rev && Number.isFinite(rev.amount) ? rev.amount : sellerPayoutCents,
      reversalError: FieldValue.delete(),
      disputeFundsWithdrawnAt: ts,
    }, {merge: true});
    logger.info(`funds_withdrawn: reversed ${transferId} for ${piId} (${rev && rev.id})`);
    return {ok: true, transferId, reversalId: rev && rev.id};
  } catch (revErr) {
    const msg = (revErr && revErr.message) || String(revErr);
    logger.error(`funds_withdrawn: transfer reversal FAILED for ${piId} (${transferId}): ${msg}`);
    await orderRef.set({
      disputeFundsWithdrawn: true,
      sellerDebited: false,
      transferId,
      reversalError: msg.slice(0, 500),
      reversalFailedAt: ts,
      disputeFundsWithdrawnAt: ts,
    }, {merge: true});
    return {ok: false, transferId, error: msg};
  }
}

module.exports = {
  resolveCharge,
  transferIdFromCharge,
  cardFingerprintFromCharge,
  reverseSellerTransferForDispute,
};
