/**
 * functions/shippingInfo.js — shipping transparency (2026-11-23).
 *   getShippingEstimate   callable, no sign-in: what shipping to a ZIP costs
 *   shippoTrackingWebhook Shippo track_updated → the order's timeline
 *   shipByReminders       9 AM Central: business day 2 and 3 to the seller
 * Nothing here charges, refunds or pays anyone.
 */
"use strict";
const crypto = require("crypto");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const SI = require("./shippoIntegration")._internal;
const SP = require("./lib/shippingParcels");
const B = require("./lib/shipBy");
const T = require("./lib/shipTracking");
const {ctDate} = require("./lib/dailyDigestCore");
const {guestRateLimit} = require("./lib/guestCheckout");
const {CATEGORIES, RESEND_API_KEY, UNSUBSCRIBE_SECRET} = require("./lib/email");
const {opsAlert, OPS_ALERT_WEBHOOK} = require("./opsAlert");

const SHIPPO_API_KEY = defineSecret("SHIPPO_API_KEY");
const SHIPPO_TRACKING_TOKEN = defineSecret("SHIPPO_TRACKING_TOKEN");
const FV = admin.firestore.FieldValue;
const TEST_UID = /^(mg_|qa_|pwbuyer_)/;
const ESTIMATE_TTL_MS = 24 * 36e5;
const ESTIMATE_CATS = ["clubs", "bags"];
const LIMITS = {ip: {max: 20, windowMs: 10 * 60e3}, all: {max: 250, windowMs: 36e5}};

/** Delivery window from today: shipped tomorrow at best, on the ship-by day at worst. */
function deliveryWindow(days, nowMs) {
  const n = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.min(14, Math.ceil(Number(days))) : 5;
  const today = ctDate(nowMs);
  return {from: B.addBusinessDays(B.addBusinessDays(today, 1), n), to: B.addBusinessDays(B.shipBy(nowMs).date, n)};
}

/**
 * @param {object} db
 * @param {{listingId: string, zip: string, ip: string, nowMs: number}} a
 * @param {Function} quote (db, listing, toAddr) → carrierQuoteForListing's shape
 */
async function estimate(db, a, quote) {
  const snap = await db.collection("listings").doc(a.listingId).get();
  const l = snap.exists ? snap.data() : null;
  if (!l || !["active", "pending"].includes(l.status)) throw new HttpsError("not-found", "This listing isn't available.");
  const cat = String(l.cat || "").toLowerCase();
  if (!ESTIMATE_CATS.includes(cat)) throw new HttpsError("failed-precondition", "Shipping on this item is a flat price.");
  const itemCents = SI.listingItemCents(l, 1);
  const parcelKey = SP.parcelForListing(l).key;
  const cfg = await SP.getShippingConfig(db);
  const ref = db.doc(`shippingEstimates/${a.listingId}_${a.zip}`);
  const hit = await ref.get();
  let c = hit.exists ? hit.data() : null;
  if (!c || c.parcelKey !== parcelKey || a.nowMs - c.atMs > ESTIMATE_TTL_MS) {
    const [ip, all] = await Promise.all([guestRateLimit(db, FV, `est:${a.ip}`, LIMITS.ip, a.nowMs), guestRateLimit(db, FV, "est:all", LIMITS.all, a.nowMs)]);
    if (!ip.ok || !all.ok) throw new HttpsError("resource-exhausted", "Too many estimates. Try again in a few minutes.");
    const q = await quote(db, l, {zip: a.zip, country: "US"});
    c = {carrierCents: q.shippingCents, days: q.estimatedDays == null ? null : q.estimatedDays, parcelKey, atMs: a.nowMs};
    await ref.set({...c, listingId: a.listingId, zip: a.zip, expireAt: new Date(a.nowMs + 7 * 864e5)});
  }
  const p = SP.protectionFor(itemCents, cfg);
  return {zip: a.zip, shippingCents: c.carrierCents, protectionCents: p.protectionCents, totalCents: c.carrierCents + p.protectionCents,
    ...deliveryWindow(c.days, a.nowMs)};
}

exports.getShippingEstimate = onCall(
    {region: "us-central1", memory: "256MiB", timeoutSeconds: 30, concurrency: 40, maxInstances: 5, secrets: [SHIPPO_API_KEY]},
    async (req) => {
      const d = req.data || {};
      const listingId = String(d.listingId || ""); const zip = String(d.zip || "").trim();
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(listingId)) throw new HttpsError("invalid-argument", "listingId required.");
      if (!/^\d{5}$/.test(zip)) throw new HttpsError("invalid-argument", "Enter a 5-digit ZIP code.");
      const fwd = String((req.rawRequest && req.rawRequest.headers["x-forwarded-for"]) || "").split(",")[0].trim();
      return estimate(admin.firestore(), {listingId, zip, ip: fwd || (req.rawRequest && req.rawRequest.ip) || "unknown", nowMs: Date.now()}, SI.carrierQuoteForListing);
    },
);

// ─── Tracking ─────────────────────────────────────────────────────────
function tokenOk(given, expected) {
  const a = Buffer.from(String(given || "")); const b = Buffer.from(String(expected || ""));
  return b.length > 20 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchTrack(apiKey, carrier, number) {
  const r = await fetch(`https://api.goshippo.com/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(number)}`,
      {headers: {"Authorization": `ShippoToken ${apiKey}`, "Shippo-API-Version": "2018-02-08"}, signal: AbortSignal.timeout(15000)});
  if (!r.ok) throw new Error(`Shippo tracks ${r.status}`);
  return r.json();
}

/** Apply a carrier update to one order. @return {Promise<object|null>} the plan that was applied, with the order */
async function applyTracking(db, orderRef, t) {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(orderRef);
    const o = s.exists ? s.data() : null;
    const p = T.plan(o, t);
    if (!p) return null;
    const u = {...p.update, trackingUpdatedAt: FV.serverTimestamp()};
    if (p.shipped) { u.shippedAt = FV.serverTimestamp(); u.shippedSource = "carrier"; u.trackingCarrier = o.trackingCarrier || o.carrier || null; }
    if (p.delivered) {
      u.deliveredAt = FV.serverTimestamp();
      u.deliveredSource = "carrier";
      u.sellerStatsApplied = true;
      // Same stats as confirmOrderDelivered, behind the same marker.
      if (o.sellerId && !o.sellerStatsApplied) {
        tx.set(db.collection("profiles").doc(o.sellerId), {salesCount: FV.increment(1)}, {merge: true});
        tx.set(db.collection("users").doc(o.sellerId), {totalRevenue: FV.increment(Number(o.amount) || 0), lastSaleAt: FV.serverTimestamp()}, {merge: true});
      }
    }
    tx.update(orderRef, u);
    return {...p, order: {id: orderRef.id, ...o, ...p.update}};
  });
}

async function notifyTracking(db, r) {
  const E = require("./emailTriggers")._shared;
  const {sendPush} = require("./lib/push");
  const o = r.order;
  const {buyer, seller, listing} = await E.loadOrderParties(o);
  const tracking = {carrier: o.trackingCarrier || o.carrier, number: o.trackingNumber, publicUrl: o.trackingUrl, eta: o.estimatedDelivery};
  const mail = async (templateName, party, fallbackUid, key) => {
    const {uid, email} = await E.resolvePartyEmail(party, fallbackUid);
    if (!email) return E.recordEmailMiss({uid, template: templateName, orderId: o.id, reason: "no email (auth + doc both empty)"});
    return E.sendTemplated({category: CATEGORIES.TRANSACTIONAL, templateCategory: "transactional", templateName, to: email, uid,
      ctx: {order: o, buyer, seller, listing, tracking}, idempotencyKey: `${key}-${o.id}`});
  };
  const push = (uid, title, body, kind) => sendPush(uid, {title, body, kind, deepLink: `teebox://order/${o.id}`, orderId: o.id}, "orders")
      .catch((e) => logger.error("shipping push failed", {orderId: o.id, kind, error: String(e && e.message || e)}));
  const jobs = [];
  if (r.shipped && !r.delivered) {
    jobs.push(mail("OrderShipped", buyer, o.buyerId, "shipped"), push(o.buyerId, "Your order shipped", "The carrier has it. Track it in TeeBox.", "order-shipped"));
  }
  if (r.delivered) {
    jobs.push(mail("DeliveredBuyer", buyer, o.buyerId, "delivered-buyer"), mail("DeliveredSeller", seller, o.sellerId, "delivered-seller"),
        push(o.buyerId, "Your order was delivered", "If anything's wrong, open a dispute within 7 days.", "order-delivered-buyer"),
        push(o.sellerId, "Your item was delivered", "Your payout follows Stripe's standard schedule.", "order-delivered-seller"));
    jobs.push(require("./lib/referral").applyReferralCreditIdempotent(db, o.buyerId));
  }
  const bad = (await Promise.allSettled(jobs)).filter((x) => x.status === "rejected");
  if (bad.length) await opsAlert("warn", "Carrier update: a notification failed", {orderId: o.id, error: String(bad[0].reason && bad[0].reason.message || bad[0].reason)});
}

/**
 * @param {object} db
 * @param {{carrier: string, number: string}} hint from the webhook; only says which parcel to look up
 * @param {{track: Function, notify: Function}} deps
 */
async function handleTracking(db, hint, deps) {
  const snap = await db.collection("orders").where("trackingNumber", "==", hint.number).limit(5).get();
  // Only labels bought through our Shippo account. A number a seller typed
  // in is never looked up here: it isn't ours to trust, and it costs money.
  const docs = snap.docs.filter((d) => d.get("shippoTransactionId"));
  if (!docs.length) return {orders: 0};
  const carrier = T.carrierToken(docs[0].get("carrier")) || hint.carrier;
  const t = T.summarize(await deps.track(carrier, hint.number)); // Shippo's own record, not the posted body
  if (!t) return {orders: docs.length, status: "none"};
  for (const d of docs) {
    const r = await applyTracking(db, d.ref, t);
    if (r && (r.shipped || r.delivered)) await deps.notify(db, r);
  }
  return {orders: docs.length, status: t.status};
}

exports.shippoTrackingWebhook = onRequest(
    {region: "us-central1", memory: "512MiB", timeoutSeconds: 60, maxInstances: 5,
      secrets: [SHIPPO_API_KEY, SHIPPO_TRACKING_TOKEN, RESEND_API_KEY, UNSUBSCRIBE_SECRET, OPS_ALERT_WEBHOOK]},
    async (req, res) => {
      if (req.method !== "POST") { res.status(405).send("POST only"); return; }
      if (!tokenOk(req.query.t, SHIPPO_TRACKING_TOKEN.value())) { res.status(404).send("Not found"); return; }
      const data = (req.body && req.body.data) || {};
      const number = String(data.tracking_number || "").trim();
      const carrier = String(data.carrier || "").toLowerCase();
      if ((req.body && req.body.event) !== "track_updated" || !/^[A-Za-z0-9_ -]{6,40}$/.test(number) || !/^[a-z0-9_]{2,30}$/.test(carrier)) {
        res.status(200).json({ok: true, ignored: true});
        return;
      }
      try {
        const out = await handleTracking(admin.firestore(), {carrier, number},
            {track: (c, n) => fetchTrack(SHIPPO_API_KEY.value(), c, n), notify: notifyTracking});
        logger.info("shippoTrackingWebhook", out);
        res.status(200).json({ok: true});
      } catch (e) {
        logger.error("shippoTrackingWebhook failed", {error: String(e && e.message || e)});
        res.status(500).json({ok: false}); // Shippo retries
      }
    },
);

// ─── Ship-by reminders ────────────────────────────────────────────────
/** @param {object} db @param {number} nowMs @param {Function} send (order, day) */
async function runReminders(db, nowMs, send) {
  const snap = await db.collection("orders").where("fulfillmentStatus", "==", "awaiting_seller_shipment").limit(500).get();
  let sent = 0;
  for (const d of snap.docs) {
    const raw = d.data();
    if (TEST_UID.test(String(raw.sellerId || ""))) continue;
    const day = B.reminderDue({...raw, createdAtMs: raw.createdAt && raw.createdAt.toMillis ? raw.createdAt.toMillis() : NaN}, nowMs);
    if (!day) continue;
    const claimed = await db.runTransaction(async (tx) => {
      const s = await tx.get(d.ref); const o = s.data();
      if (!o || o.fulfillmentStatus !== "awaiting_seller_shipment" || o[`shipReminder${day}At`]) return null;
      tx.update(d.ref, {[`shipReminder${day}At`]: FV.serverTimestamp()});
      return o;
    });
    if (!claimed) continue;
    try { await send({id: d.id, ...claimed, createdAtMs: raw.createdAt.toMillis()}, day); sent++; } catch (e) {
      logger.error("shipByReminders: send failed", {orderId: d.id, error: String(e && e.message || e)});
    }
  }
  return {checked: snap.size, sent};
}

async function sendReminder(o, day) {
  const E = require("./emailTriggers")._shared;
  const {sendPush} = require("./lib/push");
  const {seller, listing} = await E.loadOrderParties(o);
  const {date} = B.shipBy(o.createdAtMs);
  await sendPush(o.sellerId, {title: day === 3 ? "Ship today" : "Ship by tomorrow", body: `${String(listing.title || "Your sold item").slice(0, 60)} needs to ship.`,
    kind: "ship-reminder", deepLink: `teebox://order/${o.id}`, orderId: o.id}, "orders").catch((e) => logger.error("ship reminder push failed", {orderId: o.id, error: String(e && e.message || e)}));
  const {uid, email} = await E.resolvePartyEmail(seller, o.sellerId);
  if (!email) return E.recordEmailMiss({uid, template: "ShipReminder", orderId: o.id, reason: "no seller email (auth + doc both empty)"});
  return E.sendTemplated({category: CATEGORIES.TRANSACTIONAL, templateCategory: "transactional", templateName: "ShipReminder", to: email, uid,
    ctx: {order: o, seller, listing, day, shipByDate: date}, idempotencyKey: `ship-reminder-${day}-${o.id}`});
}

exports.shipByReminders = onSchedule(
    {schedule: "0 9 * * *", timeZone: "America/Chicago", region: "us-central1", memory: "512MiB", timeoutSeconds: 120, maxInstances: 1,
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET]},
    async () => { logger.info("shipByReminders", await runReminders(admin.firestore(), Date.now(), sendReminder)); },
);

module.exports._internal = {estimate, deliveryWindow, handleTracking, applyTracking, notifyTracking, runReminders, sendReminder, tokenOk};
