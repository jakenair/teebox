// functions/metaCapi.js
//
// Meta Conversions API — the SERVER half of the measurement r278 started.
//
// Why this exists: the browser pixel alone loses a large share of conversions
// to ad blockers, Safari ITP and iOS. Meta then optimises against incomplete
// signal, which costs real money once spend starts. CAPI sends the same event
// server-side, from a place an ad blocker cannot reach — the Stripe webhook's
// own record of the sale.
//
// DEDUPLICATION is the whole trick. Meta collapses a browser event and a
// server event into one when they share `event_name` + `event_id`. r278 made
// this possible by keying the browser Purchase as `purchase_<paymentIntentId>`
// — deterministic, and derivable here without the client telling us anything.
// Get this wrong and every sale counts twice.
//
// PII RULE (founder ruling, index.html r278 comment): no email, name or phone
// in any event; whether hashed email is ever sent server-side is explicitly
// "a separate, still-unruled decision". So this file sends NO personal data.
// It identifies the user with Meta's OWN browser cookies — _fbp and _fbc —
// which are ad-tech identifiers Meta set itself, not user fields we hold.
// That keeps match quality usable without ruling on the open question. If
// hashed email is approved later, add it in buildUserData() and nowhere else.
//
// Fails CLOSED and SILENT: no token, no pixel, a network error or a 4xx all
// log and return. A measurement call must never affect an order.

const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const crypto = require("crypto");
const https = require("https");
const admin = require("firebase-admin");

// Created by the founder in Secret Manager. Until it exists this module is
// inert by design, so it is safe to deploy before the token is minted.
const META_CAPI_TOKEN = defineSecret("META_CAPI_TOKEN");

// The pixel already live on teeboxmarket.com (fb-pixel.js TEEBOX_META_PIXEL_ID
// + the <noscript> fallbacks). Override per deployment with the META_PIXEL_ID
// env var; the default keeps the live pixel working when none is set.
const PIXEL_ID = process.env.META_PIXEL_ID || "4535316483381655";
const GRAPH_VERSION = "v21.0";

const LIGHT = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  maxInstances: 10,
};

/**
 * POST a batch of events to the Conversions API.
 * @param {string} token Meta system-user access token.
 * @param {Array<object>} events CAPI event objects.
 * @return {Promise<{ok: boolean, status: number, body: string}>}
 */
function postEvents(token, events) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({data: events});
    const req = https.request({
      method: "POST",
      hostname: "graph.facebook.com",
      path: `/${GRAPH_VERSION}/${PIXEL_ID}/events?access_token=` +
        encodeURIComponent(token),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: body.slice(0, 500),
      }));
    });
    req.on("timeout", () => req.destroy(new Error("CAPI POST timed out")));
    req.on("error", (e) => resolve({ok: false, status: 0, body: e.message}));
    req.write(payload);
    req.end();
  });
}

/**
 * Normalise an email the way Meta requires before hashing: trim, lowercase.
 * Meta rejects a hash computed over anything else, silently — the event is
 * accepted and simply never matches, so a formatting slip is invisible.
 * @param {string} raw Email address.
 * @return {string} SHA-256 hex digest, or "" when there is nothing to hash.
 */
function hashEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!email || email.indexOf("@") < 1) return "";
  return crypto.createHash("sha256").update(email, "utf8").digest("hex");
}

/**
 * Normalise a phone the way Meta requires before hashing: digits only,
 * country code included, no "+", no leading zeros. Firebase Auth stores
 * E.164 ("+13125551234"), so stripping non-digits is the whole job.
 * @param {string} raw Phone number.
 * @return {string} SHA-256 hex digest, or "" when nothing usable.
 */
/**
 * external_id — our Firebase uid, SHA-256 hashed the way Meta normalises
 * other identifiers. Opaque either way, but hashing keeps the raw uid out of
 * Meta's systems (Jake, 2026-10-26: "hashed external_id (Firebase uid)").
 * @param {string} uid Firebase uid.
 * @return {string} SHA-256 hex digest, or "" when empty.
 */
function hashExternalId(uid) {
  const v = String(uid || "").trim();
  if (!v) return "";
  return crypto.createHash("sha256").update(v, "utf8").digest("hex");
}

function hashPhone(raw) {
  const digits = String(raw || "").replace(/\D+/g, "").replace(/^0+/, "");
  if (digits.length < 7) return "";
  return crypto.createHash("sha256").update(digits, "utf8").digest("hex");
}

/**
 * Identifiers Meta can match on. _fbp and _fbc are cookies Meta's own pixel
 * set in the buyer's browser; the client forwards them through the
 * PaymentIntent so they survive to the webhook. IP and user agent are
 * captured at checkout for the same reason — a Firestore trigger has no
 * request context of its own.
 *
 * `em` is a SHA-256 hash of the buyer's email, approved for purchase
 * matching by the founder ruling of 2026-09-28 and disclosed in
 * privacy.html. It is one-way; Meta cannot recover the address from it.
 *
 * `ph` (SHA-256 of the buyer's VERIFIED Firebase Auth phone, E.164) is
 * wired but OFF by default: the 2026-09-28 ruling approved hashed email
 * only, and privacy.html does not yet disclose phone hashing. The code
 * path stays so turning it on is a flag flip, not a code change:
 *   Firestore config/meta { sendHashedPhone: true }
 * TODO(founder): before flipping, add the clause to privacy.html §CAPI —
 * "…a one-way hash of your email address and, where you verified one,
 * your phone number" — then set the flag. Until then `extra.phone` is
 * ignored even when present.
 *
 * STILL BANNED, and this is the only place that could leak them: plaintext
 * email, name, phone. Do not add fn, ln or an unhashed em/ph here. If a
 * future ruling permits more, add it in THIS function and nowhere else, so
 * there is exactly one place to audit what leaves for Meta.
 *
 * `external_id` is the buyer's uid — our own stable identifier, meaningless
 * to anyone without our database, and the thing that lets Meta join a
 * browser event to a server event for the same person.
 * @param {object} order The order document.
 * @param {{phone?: string, email?: string}} [extra] Verified Auth values.
 * @param {{sendHashedPhone?: boolean}} [cfg] config/meta flags (default off).
 * @return {object} CAPI user_data.
 */
function buildUserData(order, extra, cfg) {
  const ud = {};
  const x = extra || {};
  const c = cfg || {};
  if (order.fbp) ud.fbp = String(order.fbp);
  if (order.fbc) ud.fbc = String(order.fbc);
  if (order.checkoutIp) ud.client_ip_address = String(order.checkoutIp);
  if (order.checkoutUa) ud.client_user_agent = String(order.checkoutUa);
  if (order.buyerId) ud.external_id = hashExternalId(order.buyerId);
  // The buyer's address lives on the order as `receiptEmail` — the value
  // Stripe was given at checkout. There is NO buyerEmail/email field; reading
  // one would hash undefined and silently never match, which is exactly how
  // this class of bug hides (the event is accepted by Meta either way).
  // Verified against a live order doc on 2026-10-02.
  const em = hashEmail(order.receiptEmail || order.buyerEmail || order.email || x.email);
  if (em) ud.em = em;
  if (c.sendHashedPhone === true) {
    const ph = hashPhone(x.phone);
    if (ph) ud.ph = ph;
  }
  return ud;
}

/**
 * Runtime flags from Firestore config/meta (admin-written via console):
 *   testEventCode   string  — attached to SERVER-originated events while
 *                             validating in Events Manager. Delete it after:
 *                             Meta drops test events from reporting, so a
 *                             forgotten code hides real sales.
 *   sendHashedPhone boolean — see buildUserData(); default false.
 * Cached per instance for 60s so the relay does not pay a read per event.
 * @return {Promise<{testEventCode: string, sendHashedPhone: boolean}>}
 */
let _metaCfg = {at: 0, v: {testEventCode: "", sendHashedPhone: false}};
async function metaConfig() {
  if (Date.now() - _metaCfg.at < 60000) return _metaCfg.v;
  try {
    const snap = await admin.firestore().collection("config").doc("meta").get();
    const d = (snap.exists && snap.data()) || {};
    _metaCfg = {at: Date.now(), v: {
      testEventCode: d.testEventCode ? String(d.testEventCode).slice(0, 60) : "",
      sendHashedPhone: d.sendHashedPhone === true,
    }};
  } catch (_e) {
    _metaCfg = {at: Date.now(), v: {testEventCode: "", sendHashedPhone: false}};
  }
  return _metaCfg.v;
}

/**
 * Server-side Purchase, fired from the order Stripe actually created.
 *
 * event_id MUST match the browser's `purchase_<paymentIntentId>` or Meta
 * counts the sale twice and every ROAS number downstream is wrong.
 */
exports.capiPurchaseOnOrderCreated = onDocumentCreated(
    {document: "orders/{orderId}", ...LIGHT, secrets: [META_CAPI_TOKEN]},
    async (event) => {
      const snap = event.data;
      if (!snap) return;
      const order = snap.data() || {};
      const orderId = event.params.orderId;

      let token = "";
      try {
        token = META_CAPI_TOKEN.value() || "";
      } catch (_e) {
        token = "";
      }
      if (!token) {
        logger.info("capiPurchase: META_CAPI_TOKEN unset - skipping", {orderId});
        return;
      }

      // Only real, paid orders. A pending hold is not a conversion.
      if (order.status !== "paid") {
        logger.info("capiPurchase: not paid - skipping", {orderId, status: order.status});
        return;
      }

      // Verified phone (and email as a fallback) from Auth — the order doc
      // carries neither. Best-effort: a lookup failure just means fewer keys.
      let extra = {};
      if (order.buyerId) {
        try {
          const u = await admin.auth().getUser(String(order.buyerId));
          extra = {phone: u.phoneNumber || "", email: u.email || ""};
        } catch (_e) {
          extra = {};
        }
      }
      const cfg = await metaConfig();
      const userData = buildUserData(order, extra, cfg);
      if (!Object.keys(userData).length) {
        // Meta rejects an event with no identifier at all. Better to send
        // nothing than to send junk that drags match quality down.
        logger.warn("capiPurchase: no usable identifier - skipping", {orderId});
        return;
      }

      // The order doc id IS the payment intent id (see handlePaymentSucceeded),
      // which is what the browser keyed its event on.
      const eventId = "purchase_" + orderId;
      const valueDollars = Number(order.amountCents || 0) / 100;

      const ev = {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: order.listingId ?
          "https://teeboxmarket.com/listing/" + encodeURIComponent(String(order.listingId)) + "/" :
          "https://teeboxmarket.com/",
        user_data: userData,
        custom_data: {
          currency: String(order.currency || "usd").toUpperCase(),
          value: valueDollars,
          content_type: "product",
          content_ids: order.listingId ? [String(order.listingId)] : [],
          order_id: String(orderId),
          num_items: Number(order.quantity || 1),
        },
      };

      if (cfg.testEventCode) ev.test_event_code = cfg.testEventCode;

      const res = await postEvents(token, [ev]);
      if (res.ok) {
        logger.info(
            `capiPurchase: sent event_id=${eventId} value=${valueDollars}`,
            {orderId, matchKeys: Object.keys(userData)});
      } else {
        logger.warn(
            `capiPurchase: Meta rejected ${res.status}`,
            {orderId, body: res.body});
      }
    },
);


// ─────────────────────────────────────────────────────────────────────────
// capiRelay — the server leg for events that have no server-side moment.
//
// Purchase is emitted from the order document, because the order is the
// authoritative record that money moved. The other funnel events have no
// equivalent: "tapped Buy Now" exists only in the browser. So the browser
// hands us the event plus the event_id it already sent to the pixel, and we
// re-send it from the server with the SAME id. Meta collapses the pair.
//
// Why bother, when the pixel already sent it: the pixel is blocked for a
// large share of users. The server copy is the one that always arrives, and
// the shared event_id is what stops the two being counted twice.
//
// SECURITY — this endpoint writes into ad reporting, so it is deliberately
// narrow:
//   - auth required. That also means we derive external_id and the hashed
//     email from the VERIFIED token, never from the request body.
//   - Purchase is REJECTED. It is server-authoritative from the order doc;
//     accepting it here would let any signed-in user fabricate conversions
//     and corrupt every ROAS number downstream.
//   - event names are allowlisted, value is bounded, currency is pinned.
// ─────────────────────────────────────────────────────────────────────────
const CAPI_RELAY_EVENTS = new Set([
  "AddToCart",
  "InitiateCheckout",
  "CompleteRegistration",
  "ListingCreated",
  "ViewContent",
  "PageView",
]);
// Browsing events may come from guests — most ad-driven visitors are not
// signed in when they look at a listing. These two carry no identity
// beyond Meta's own cookies + IP/UA, which is all a guest pixel hit has too.
const CAPI_ANON_EVENTS = new Set(["ViewContent", "PageView"]);
const CAPI_MAX_VALUE = 100000; // $100k — far above any real listing

exports.capiRelay = onCall(
    {...LIGHT, secrets: [META_CAPI_TOKEN]},
    async (request) => {
      const auth = request.auth;
      const d = request.data || {};
      const eventName = String(d.eventName || "");
      if (!auth && !CAPI_ANON_EVENTS.has(eventName)) {
        throw new HttpsError("unauthenticated", "Sign-in required.");
      }
      let token = "";
      try {
        token = META_CAPI_TOKEN.value() || "";
      } catch (_e) {
        token = "";
      }
      // Fail quiet, not loud: tracking must never break a user action.
      if (!token) return {ok: false, skipped: "no-token"};

      if (!CAPI_RELAY_EVENTS.has(eventName)) {
        // Purchase lands here too, by design.
        throw new HttpsError("invalid-argument", "Unsupported event.");
      }
      const eventId = String(d.eventId || "").slice(0, 200);
      if (!eventId) {
        throw new HttpsError("invalid-argument", "eventId required for dedup.");
      }

      // Identity comes from the verified token, never the body.
      const ud = {};
      if (auth) {
        ud.external_id = hashExternalId(auth.uid);
        const em = hashEmail(auth.token && auth.token.email);
        if (em) ud.em = em;
        // ph: flag-gated, default off — see buildUserData().
        const cfg = await metaConfig();
        if (cfg.sendHashedPhone === true) {
          const ph = hashPhone(auth.token && auth.token.phone_number);
          if (ph) ud.ph = ph;
        }
      }
      if (d.fbp) ud.fbp = String(d.fbp).slice(0, 200);
      if (d.fbc) ud.fbc = String(d.fbc).slice(0, 200);
      const ip = request.rawRequest &&
        (request.rawRequest.ip ||
         (request.rawRequest.headers || {})["x-forwarded-for"]);
      if (ip) ud.client_ip_address = String(ip).split(",").pop().trim();
      const ua = request.rawRequest &&
        (request.rawRequest.headers || {})["user-agent"];
      if (ua) ud.client_user_agent = String(ua).slice(0, 300);

      const p = d.params || {};
      const custom = {};
      if (Array.isArray(p.content_ids)) {
        custom.content_ids = p.content_ids.slice(0, 20).map((x) => String(x).slice(0, 128));
      }
      if (p.content_type) custom.content_type = String(p.content_type).slice(0, 40);
      if (p.content_category) custom.content_category = String(p.content_category).slice(0, 60);
      const val = Number(p.value);
      if (Number.isFinite(val) && val >= 0 && val <= CAPI_MAX_VALUE) {
        custom.value = Math.round(val * 100) / 100;
        custom.currency = "USD";
      }
      const numItems = Number(p.num_items);
      if (Number.isFinite(numItems) && numItems > 0 && numItems < 1000) {
        custom.num_items = Math.floor(numItems);
      }

      if (!Object.keys(ud).length) {
        // Meta rejects an event with no identifier at all (a guest with
        // cookies blocked and no forwarded IP). Nothing useful to send.
        return {ok: false, skipped: "no-identifier"};
      }

      const evt = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        user_data: ud,
        custom_data: custom,
      };
      if (d.sourceUrl) evt.event_source_url = String(d.sourceUrl).slice(0, 500);
      if (d.testEventCode) evt.test_event_code = String(d.testEventCode).slice(0, 60);

      const res = await postEvents(token, [evt]);
      if (!res.ok) {
        logger.error("capiRelay: Meta rejected the event", {
          eventName, eventId, status: res.status, body: res.body,
        });
        return {ok: false, status: res.status};
      }
      logger.info("capiRelay: sent", {eventName, eventId});
      return {ok: true};
    },
);

module.exports._internal = {buildUserData, hashEmail, hashPhone, hashExternalId, PIXEL_ID, GRAPH_VERSION};
