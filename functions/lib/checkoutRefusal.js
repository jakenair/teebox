"use strict";
// Why a checkout was refused, on record (founder, 2026-11-23). Every 4xx/5xx
// answer of createPaymentIntent and every error of updateCheckoutShipping
// logs one line: checkout refused {step, status, reason, listingId, buyer}.
// The buyer is an account id, or "guest"; never an email, name or address.

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);

/** A short, stable reason for an answer body or error. */
function reasonOf(body, status) {
  const b = body && typeof body === "object" ? body : {};
  if (b.code) return clean(b.code, 60);
  const e = clean(b.error || b.message, 160);
  const known = [[/age-required/i, "age_18_not_confirmed"], [/not authenticated/i, "not_signed_in"], [/valid email/i, "guest_email_missing"],
    [/suspended|not eligible/i, "account_blocked"], [/own listing/i, "own_listing"], [/status: (\w+)/i, "listing_not_available"], [/right now/i, "not_enough_stock"],
    [/setting up payouts/i, "seller_cannot_take_payment"], [/ship-from/i, "no_ship_from"], [/too many/i, "rate_limited"], [/offer/i, "offer_not_payable"],
    [/listing not found/i, "listing_not_found"], [/shipping rate/i, "no_shipping_rate"], [/complete shipping address/i, "address_incomplete"], [/couldn't verify/i, "account_check_failed"]];
  const hit = known.find(([re]) => re.test(e));
  return hit ? hit[1] : (e || `http_${status}`);
}

/** Wrap an Express response so any refusal is logged. Never changes the answer. */
function logRefusals(req, res, {uid, logger}) {
  const json = res.json.bind(res);
  res.json = (body) => {
    try {
      if (res.statusCode >= 400) {
        const b = req.body || {};
        const ua = clean(req.headers && req.headers["user-agent"], 200);
        logger.warn("checkout refused", {step: b.quoteOnly === true ? "guest_quote" : "create_payment", status: res.statusCode, reason: reasonOf(body, res.statusCode),
          listingId: clean(b.listingId, 64), buyer: uid || (b.guest === true ? "guest" : "none"), surface: /Mobile\/\w+$/.test(ua) ? "ios_app" : "web", ageGate: Number(b.ageGate) || 0});
      }
    } catch (_e) { /* logging never breaks checkout */ }
    return json(body);
  };
}

function logShippingRefusal(logger, {uid, paymentIntentId, listingId}, e) {
  try {
    logger.warn("checkout refused", {step: "shipping_price", status: clean(e && e.code, 40), reason: reasonOf(e, e && e.code),
      listingId: clean(listingId, 64), buyer: uid || "none", paymentIntentId: clean(paymentIntentId, 40)});
  } catch (_e) { /* same */ }
}

module.exports = {reasonOf, logRefusals, logShippingRefusal};
