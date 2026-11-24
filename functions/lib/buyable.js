"use strict";
// Can a buyer actually buy this listing? (founder, 2026-11-23). Two things
// stop a checkout before payment: the seller can't take payment yet, or the
// item is priced by a live carrier rate and the seller has no ship-from
// address to quote from. Pure.

const LIVE_RATE_CATS = ["clubs", "bags"]; // everything else ships at a flat price

/** Is users/{uid}.shippingFrom complete? Accepts every shape normalizeAddress does. */
function hasShipFrom(user) {
  const f = user && user.shippingFrom;
  if (!f || typeof f !== "object") return false;
  const a = f.address && typeof f.address === "object" ? f.address : f;
  const t = (v) => String(v == null ? "" : v).trim();
  return !!(t(a.line1 || a.street1) && t(a.city) && t(a.state) && t(a.postal_code || a.zip));
}
function needsShipFrom(listing) {
  return LIVE_RATE_CATS.includes(String((listing && listing.cat) || "").toLowerCase());
}
/**
 * @param {object} listing @param {object|null} seller users/{uid}
 * @return {"seller_not_ready"|"no_ship_from"|null} null = buyable
 */
function unbuyableReason(listing, seller) {
  if (!(seller && seller.stripeChargesEnabled === true)) return "seller_not_ready";
  if (needsShipFrom(listing) && !hasShipFrom(seller)) return "no_ship_from";
  return null;
}

module.exports = {LIVE_RATE_CATS, hasShipFrom, needsShipFrom, unbuyableReason};
