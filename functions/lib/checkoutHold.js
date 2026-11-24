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

/**
 * Units a buyer is holding now. Once the window has lapsed this is 0, the
 * same rule checkout uses when the next buyer comes along.
 * @param {object} l listing @param {number} nowMs @return {number}
 */
function heldUnits(l, nowMs) {
  const until = ms(l && l.pendingUntil);
  if (until > 0 && until <= nowMs) return 0;
  return Math.max(0, Number(l && l.quantityReserved) || 0);
}

module.exports = {inCheckout, heldUnits, DELETE_BLOCKED};
