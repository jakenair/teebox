"use strict";
// TikTok Events API 2.0 — server leg of the TikTok Pixel (2026-11-15, Dylan).
//
// Mirrors the Meta Conversions API design (metaCapi.js), with no new Cloud
// Functions: capiRelay (ViewContent / AddToCart / InitiateCheckout) and
// capiPurchaseOnOrderCreated (Purchase) call sendTikTokEvent() next to their
// Meta send. Every call is best-effort and never throws, so TikTok can never
// break checkout, the order trigger or a Meta event.
//
// Endpoint and payload: business-api.tiktok.com/portal/docs/setup-guide-for-web/v1.3
//   POST https://business-api.tiktok.com/open_api/v1.3/event/track/
//   header Access-Token; body {event_source:"web", event_source_id:<pixel>,
//   data:[{event, event_time (s), event_id, user{...}, properties{...}, page{url}}]}
// Dedup with the browser pixel: TikTok matches event_source_id + event +
// event_id, so the browser and server legs share the Meta event ids
// (vc_*, atc_*, ic_*, purchase_<paymentIntentId>).
//
// IDENTIFIERS (Dylan/Jake 2026-11-15): hashed email (SHA-256 of the trimmed,
// lower-cased address) and hashed external_id only. Hashed PHONE IS NEVER
// SENT — it stays off until the privacy policy covers it. There is no flag
// for it on purpose.
//
// content_id = the listing doc id = the catalog feed's id/sku_id
// (functions/metaFeed.js), content_type "product".

const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const crypto = require("crypto");
const https = require("https");

const TIKTOK_EVENTS_API_TOKEN = defineSecret("TIKTOK_EVENTS_API_TOKEN");
// The TikTok pixel code (public, same value as TEEBOX_TIKTOK_PIXEL_ID in
// /tt-pixel.js). EMPTY = the whole TikTok leg is off. Set it here and in
// tt-pixel.js in the same change.
const TIKTOK_PIXEL_ID = process.env.TIKTOK_PIXEL_ID || "";
const ENDPOINT_PATH = "/open_api/v1.3/event/track/";

// Our (Meta) event names -> TikTok standard events. TikTok's current docs
// name the order event "Purchase" (formerly "CompletePayment").
const EVENT_MAP = {
  ViewContent: "ViewContent",
  AddToCart: "AddToCart",
  InitiateCheckout: "InitiateCheckout",
  Purchase: "Purchase",
};
const MAX_VALUE = 100000;

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}
function hashEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!email || email.indexOf("@") < 1) return "";
  return sha256(email);
}
function clean(v, n) {
  return String(v == null ? "" : v).slice(0, n);
}

/**
 * Pure builder for one Events API 2.0 web event, or null when it must not be
 * sent (unknown event, no event id, no content id).
 * @param {object} p
 * @param {string} p.name       our event name (ViewContent, AddToCart, InitiateCheckout, Purchase)
 * @param {string} p.eventId    shared with the browser pixel
 * @param {string} p.contentId  listing doc id
 * @param {number} [p.value]    total value in dollars
 * @param {number} [p.price]    unit price in dollars
 * @param {number} [p.quantity]
 * @param {string} [p.contentName]
 * @param {string} [p.email]    plaintext; hashed here, never sent raw
 * @param {string} [p.uid]      hashed into external_id
 * @param {string} [p.ip]
 * @param {string} [p.userAgent]
 * @param {string} [p.ttp]      _ttp cookie
 * @param {string} [p.ttclid]   TikTok click id
 * @param {string} [p.url]
 * @param {string} [p.referrer]
 * @param {number} [p.now]      epoch seconds (tests)
 * @return {object|null}
 */
function buildTikTokEvent(p) {
  const x = p || {};
  const event = EVENT_MAP[x.name];
  const eventId = clean(x.eventId, 200);
  const contentId = clean(x.contentId, 128);
  if (!event || !eventId || !contentId) return null;
  const qty = Number.isFinite(Number(x.quantity)) && Number(x.quantity) > 0 ?
    Math.min(999, Math.floor(Number(x.quantity))) : 1;
  const item = {content_id: contentId, quantity: qty};
  const price = Number(x.price);
  if (Number.isFinite(price) && price >= 0 && price <= MAX_VALUE) item.price = Math.round(price * 100) / 100;
  if (x.contentName) item.content_name = clean(x.contentName, 150);
  const properties = {contents: [item], content_type: "product", currency: "USD"};
  const value = Number(x.value);
  if (Number.isFinite(value) && value >= 0 && value <= MAX_VALUE) properties.value = Math.round(value * 100) / 100;
  else if (item.price != null) properties.value = Math.round(item.price * qty * 100) / 100;

  const user = {};
  const em = hashEmail(x.email);
  if (em) user.email = em;
  if (x.uid) user.external_id = sha256(String(x.uid));
  if (x.ip) user.ip = clean(String(x.ip).split(",").pop().trim(), 64);
  if (x.userAgent) user.user_agent = clean(x.userAgent, 300);
  if (x.ttp) user.ttp = clean(x.ttp, 200);
  if (x.ttclid) user.ttclid = clean(x.ttclid, 500);
  // NO phone, by rule (see header).

  const ev = {
    event,
    event_time: x.now || Math.floor(Date.now() / 1000),
    event_id: eventId,
    user,
    properties,
    page: {url: clean(x.url || ("https://teeboxmarket.com/?listing=" + encodeURIComponent(contentId)), 500)},
  };
  if (x.referrer) ev.page.referrer = clean(x.referrer, 500);
  return ev;
}

/**
 * Full request body. testEventCode routes the event to Events Manager's
 * Test Events tab instead of production reporting.
 * @param {object} ev from buildTikTokEvent
 * @param {string} pixelId
 * @param {string} [testEventCode]
 * @return {object}
 */
function buildBody(ev, pixelId, testEventCode) {
  const body = {event_source: "web", event_source_id: String(pixelId), data: [ev]};
  if (testEventCode) body.test_event_code = String(testEventCode);
  return body;
}

function postTikTok(token, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: "business-api.tiktok.com",
      path: ENDPOINT_PATH,
      method: "POST",
      headers: {
        "Access-Token": token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 8000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => {
        if (data.length < 500) data += c;
      });
      res.on("end", () => {
        let code = null;
        try {
          code = JSON.parse(data).code;
        } catch (_e) { /* capped body */ }
        // HTTP 200 + API code 0 = accepted.
        resolve({ok: res.statusCode === 200 && code === 0, status: res.statusCode, code, body: data.slice(0, 500)});
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ok: false, status: 0, body: String(e && e.message).slice(0, 200)}));
    req.end(payload);
  });
}

/**
 * Best-effort send. Never throws. Callers run their own internal-account /
 * non-prod / opt-out gate first (lib/metaGate.js) and pass only events that
 * passed it.
 * @param {object} p buildTikTokEvent input plus {testEventCode, tag}
 * @return {Promise<string>} "sent" | a skip/failure reason
 */
async function sendTikTokEvent(p) {
  try {
    if (!TIKTOK_PIXEL_ID) return "no-pixel-id";
    let token = "";
    try {
      token = TIKTOK_EVENTS_API_TOKEN.value() || "";
    } catch (_e) {
      token = "";
    }
    if (!token) return "no-token";
    const ev = buildTikTokEvent(p);
    if (!ev) return "invalid";
    if (!Object.keys(ev.user).length) return "no-identifier";
    const res = await postTikTok(token, buildBody(ev, TIKTOK_PIXEL_ID, p.testEventCode));
    if (!res.ok) {
      logger.warn("tiktokEvents: rejected", {tag: p.tag, event: ev.event, eventId: ev.event_id, status: res.status, code: res.code, body: res.body});
      return "rejected";
    }
    logger.info("tiktokEvents: sent", {tag: p.tag, event: ev.event, eventId: ev.event_id});
    return "sent";
  } catch (e) {
    logger.warn("tiktokEvents: error", {err: e && e.message});
    return "error";
  }
}

// A TikTok test code is our own short token, same shape rule as Meta's.
function cleanTikTokTestCode(v) {
  const s = String(v || "");
  return /^[A-Za-z0-9_-]{4,40}$/.test(s) ? s : "";
}

module.exports = {
  TIKTOK_EVENTS_API_TOKEN,
  sendTikTokEvent,
  cleanTikTokTestCode,
  _internal: {buildTikTokEvent, buildBody, hashEmail, EVENT_MAP, TIKTOK_PIXEL_ID, ENDPOINT_PATH},
};
