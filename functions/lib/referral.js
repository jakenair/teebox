// functions/lib/referral.js
//
// Single, idempotent place to apply the once-per-buyer referral credit
// (buyer + referrer each get $REFERRAL_CREDIT_USD when the buyer's first order
// is delivered). Called from THREE paths so a dropped #34 onUpdate event can
// never lose a payout:
//   1. confirmOrderDelivered  — synchronous, the moment delivery is confirmed
//   2. redeemReferralCredit   — onUpdate backstop (marker-guarded; no double-pay)
//   3. reconcileReferralCredits — weekly self-heal over delivered orders
//
// Idempotency key is the PER-BUYER marker users/{buyer}.referralCreditRedeemed
// (referral redeems once per referred buyer, not per order). The credit + the
// marker are written in one transaction, re-checking the marker inside, so two
// concurrent callers can't double-credit.

"use strict";

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");

const REFERRAL_CREDIT_USD = 10;

async function applyReferralCreditIdempotent(db, buyerId) {
  if (!buyerId) return {applied: false, reason: "no_buyer"};
  const buyerRef = db.doc(`users/${buyerId}`);
  const buyerSnap = await buyerRef.get();
  if (!buyerSnap.exists) return {applied: false, reason: "no_buyer_doc"};
  const buyer = buyerSnap.data() || {};
  if (buyer.referralCreditRedeemed === true) return {applied: false, reason: "already"};
  const code = buyer.referredBy;
  if (!code) return {applied: false, reason: "no_referral"};

  // Require a real completed purchase — at least one delivered order.
  const delivered = await db.collection("orders")
      .where("buyerId", "==", buyerId)
      .where("fulfillmentStatus", "==", "delivered").limit(1).get();
  if (delivered.empty) return {applied: false, reason: "no_delivered"};

  const refRef = db.doc(`referrals/${code}`);
  const refSnap = await refRef.get();
  if (!refSnap.exists) return {applied: false, reason: "code_not_found"};
  const referrerId = (refSnap.data() || {}).userId;
  if (!referrerId || referrerId === buyerId) {
    return {applied: false, reason: "invalid_referrer"};
  }
  const referrerRef = db.doc(`users/${referrerId}`);
  const FieldValue = admin.firestore.FieldValue;

  try {
    return await db.runTransaction(async (tx) => {
      // Re-check the marker INSIDE the txn (only read here; writes below are
      // blind increments/arrayUnion → all-reads-before-writes satisfied).
      const bSnap = await tx.get(buyerRef);
      if ((bSnap.data() || {}).referralCreditRedeemed === true) {
        return {applied: false, reason: "already_txn"};
      }
      tx.set(buyerRef, {
        credits: FieldValue.increment(REFERRAL_CREDIT_USD),
        referralCreditRedeemed: true,
        referralCreditRedeemedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
      tx.set(referrerRef,
          {credits: FieldValue.increment(REFERRAL_CREDIT_USD)}, {merge: true});
      tx.set(refRef, {usedBy: FieldValue.arrayUnion(buyerId)}, {merge: true});
      return {applied: true, referrerId, code};
    });
  } catch (e) {
    logger.error(`applyReferralCreditIdempotent: txn failed for buyer ${buyerId}`, e);
    return {applied: false, reason: "txn_error"};
  }
}

module.exports = {applyReferralCreditIdempotent, REFERRAL_CREDIT_USD};
