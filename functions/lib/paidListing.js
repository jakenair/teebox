"use strict";
// What a successful payment does to the listing it bought (2026-11-23).
// Pure; stripeWebhook applies it inside its own transaction. Amounts, fees,
// transfers and refunds are not decided here.

/**
 * True when there is nothing to sell: the listing document is gone, or only a
 * ghost is left (a late pendingUntil write re-created an empty document).
 * @param {{exists: boolean, data: function(): object}|null} snap
 */
function isMissingListing(snap) {
  if (!snap || !snap.exists) return true;
  const l = snap.data() || {};
  return !l.sellerId && !l.title;
}

/**
 * Status and counters after a sale of `qty` units.
 *  - sold out: "sold", unless the listing was taken down; a takedown stays
 *    "removed" (so a later refund can't put it back on sale either)
 *  - units left: back to "active" only from active/pending. Anything else
 *    (removed, flagged, hidden, expired) keeps its status: a payment never
 *    puts a listing back on sale.
 * @param {object} l listing before the sale
 * @param {number} qty
 * @return {{status: string, quantitySold: number, quantityReserved: number, fullySold: boolean}}
 */
function afterSale(l, qty) {
  const total = Math.max(1, Number(l.quantity || 1));
  const quantitySold = Math.max(0, Number(l.quantitySold || 0)) + qty;
  const quantityReserved = Math.max(0, Math.max(0, Number(l.quantityReserved || 0)) - qty);
  const fullySold = quantitySold >= total;
  const was = l.status || "active";
  let status;
  if (fullySold) status = was === "removed" ? "removed" : "sold";
  else status = was === "active" || was === "pending" ? "active" : was;
  return {status, quantitySold, quantityReserved, fullySold};
}

module.exports = {isMissingListing, afterSale};
