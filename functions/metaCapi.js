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
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const https = require("https");

// Created by the founder in Secret Manager. Until it exists this module is
// inert by design, so it is safe to deploy before the token is minted.
const META_CAPI_TOKEN = defineSecret("META_CAPI_TOKEN");

// The pixel already live on teeboxmarket.com (index.html head + fb-pixel.js).
const PIXEL_ID = "4535316483381655";
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
 * Identifiers Meta can match on, with NO personal data. _fbp and _fbc are
 * cookies Meta's own pixel set in the buyer's browser; the client forwards
 * them through the PaymentIntent so they survive to the webhook. IP and user
 * agent are captured at checkout for the same reason — a Firestore trigger
 * has no request context of its own.
 * @param {object} order The order document.
 * @return {object} CAPI user_data.
 */
function buildUserData(order) {
  const ud = {};
  if (order.fbp) ud.fbp = String(order.fbp);
  if (order.fbc) ud.fbc = String(order.fbc);
  if (order.checkoutIp) ud.client_ip_address = String(order.checkoutIp);
  if (order.checkoutUa) ud.client_user_agent = String(order.checkoutUa);
  return ud;
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

      const userData = buildUserData(order);
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
        event_source_url: "https://teeboxmarket.com/",
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

module.exports._internal = {buildUserData, PIXEL_ID, GRAPH_VERSION};
