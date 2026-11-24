"use strict";
// Shippo tracking → what the order page shows. Pure.
const MAX_EVENTS = 30;
const STEP = {UNKNOWN: 0, PRE_TRANSIT: 1, TRANSIT: 2, OUT_FOR_DELIVERY: 3, DELIVERED: 4};

/** Shippo carrier tokens for the names we store. */
function carrierToken(name) {
  const c = String(name || "").toLowerCase();
  if (c.includes("usps")) return "usps";
  if (c.includes("ups")) return "ups";
  if (c.includes("fedex")) return "fedex";
  if (c.includes("dhl")) return "dhl_express";
  return null;
}
const text = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
function place(l) {
  if (!l || typeof l !== "object") return "";
  return [text(l.city, 40), text(l.state, 20)].filter(Boolean).join(", ");
}
function statusOf(s) {
  const st = String(s && s.status || "").toUpperCase();
  const sub = String(s && s.substatus && s.substatus.code || "").toLowerCase();
  if (st === "TRANSIT" && sub === "out_for_delivery") return "OUT_FOR_DELIVERY";
  return ["PRE_TRANSIT", "TRANSIT", "DELIVERED", "RETURNED", "FAILURE"].includes(st) ? st : "UNKNOWN";
}
/** One Shippo event → {at, status, text, place}; null when it says nothing. */
function event(s) {
  const at = Date.parse(s && s.status_date || "");
  const status = statusOf(s);
  if (!Number.isFinite(at) || status === "UNKNOWN") return null;
  return {at, status, text: text(s.status_details, 160), place: place(s.location)};
}

/**
 * @param {object} track GET /tracks/{carrier}/{number}
 * @return {{status: string, events: object[], eta: (string|null)}|null}
 */
function summarize(track) {
  if (!track || !track.tracking_status) return null;
  const events = (Array.isArray(track.tracking_history) ? track.tracking_history : []).map(event).filter(Boolean);
  const cur = event(track.tracking_status);
  if (cur && !events.some((e) => e.at === cur.at && e.status === cur.status)) events.push(cur);
  events.sort((a, b) => a.at - b.at);
  const status = cur ? cur.status : (events.length ? events[events.length - 1].status : "UNKNOWN");
  const eta = Date.parse(track.eta || "");
  return {status, events: events.slice(-MAX_EVENTS), eta: Number.isFinite(eta) ? new Date(eta).toISOString().slice(0, 10) : null};
}

/**
 * What a tracking update changes on an order, or null. Pure.
 * A delivered or refunded order never moves back; the carrier's scans may
 * take the order from awaiting → shipped → delivered.
 * @param {object} o order
 * @param {object} t summarize()
 * @return {{update: object, shipped: boolean, outForDelivery: boolean, delivered: boolean}|null}
 */
function plan(o, t) {
  if (!o || !t || o.refunded || o.refundedAt) return null;
  const update = {trackingStatus: t.status, trackingEvents: t.events};
  if (t.eta) update.estimatedDelivery = t.eta;
  const ffs = o.fulfillmentStatus;
  const step = STEP[t.status] || 0;
  let shipped = false; let outForDelivery = false; let delivered = false;
  if (step >= STEP.TRANSIT && (ffs === "awaiting_seller_shipment" || ffs === "paid")) {
    shipped = true;
    update.fulfillmentStatus = "shipped";
    update.shippingStatus = "shipped";
  }
  const open = shipped || ffs === "shipped";
  if (t.status === "OUT_FOR_DELIVERY" && open && o.shippingStatus !== "out_for_delivery") {
    outForDelivery = true;
    update.shippingStatus = "out_for_delivery";
  }
  if (t.status === "DELIVERED" && open) {
    delivered = true;
    update.fulfillmentStatus = "delivered";
    update.shippingStatus = "delivered";
  }
  const same = !shipped && !outForDelivery && !delivered && o.trackingStatus === t.status &&
    JSON.stringify(o.trackingEvents || []) === JSON.stringify(t.events) && (!t.eta || o.estimatedDelivery === t.eta);
  return same ? null : {update, shipped, outForDelivery, delivered};
}

module.exports = {carrierToken, statusOf, summarize, plan, MAX_EVENTS};
