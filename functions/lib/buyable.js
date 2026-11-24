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
/**
 * When and where shippingFrom was last saved. Server code and scripts that
 * ever write the field add shipFromStamp(); today only the owner's own Save
 * button writes it (web_settings, ios_settings).
 */
const SHIP_FROM_SOURCES = ["web_settings", "ios_settings", "checkout", "admin", "script"];
function shipFromStamp(source, address, timestamp) {
  if (!SHIP_FROM_SOURCES.includes(source)) throw new Error("unknown ship-from source");
  return {updatedAt: timestamp, source, stampFor: `${address.line1}|${address.postal_code}`};
}
/** @return {{updatedAt: *, source: string}|null} null = saved by something that leaves no stamp */
function shipFromChange(user) {
  const f = user && user.shippingFrom;
  if (!f || !f.updatedAt || f.stampFor !== `${f.line1}|${f.postal_code}`) return null;
  return {updatedAt: f.updatedAt, source: f.source};
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

module.exports = {LIVE_RATE_CATS, SHIP_FROM_SOURCES, hasShipFrom, needsShipFrom, unbuyableReason, shipFromStamp, shipFromChange};
