"use strict";
// Is this listing in a buyer's checkout right now? (2026-11-23)
// The one rule for "a seller may not delete it": used by deleteListing and
// mirrored in firestore.rules (inCheckout). Pure.

const DELETE_BLOCKED = "This item is in a buyer's checkout — try again in a few minutes";

function ms(v) {
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return typeof v === "number" ? v : 0;
}

/**
 * A reservation (status pending, reserved units or a PaymentIntent pointer)
 * whose window hasn't lapsed. No window recorded counts as still open.
 * Payments that are processing extend pendingUntil (handlePaymentProcessing).
 * @param {object} l listing
 * @param {number} nowMs
 * @return {boolean}
 */
function inCheckout(l, nowMs) {
  if (!l) return false;
  const held = l.status === "pending" || Number(l.quantityReserved || 0) > 0 || !!l.pendingPaymentIntentId;
  if (!held) return false;
  const until = ms(l.pendingUntil);
  return until === 0 || until > nowMs;
}

module.exports = {inCheckout, DELETE_BLOCKED};
