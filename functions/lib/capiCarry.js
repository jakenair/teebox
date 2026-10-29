// functions/lib/capiCarry.js
//
// The Meta CAPI fields that ride along a checkout: captured in createPaymentIntent
// (from the request), carried as PaymentIntent METADATA ONLY, copied onto the
// order document by the Stripe webhook, and read by capiPurchaseOnOrderCreated.
// Pure functions so the whole chain is unit-tested without Stripe or Firestore.
// Nothing here touches amount, fees, transfer or order creation — it is strings
// in `metadata` and four nullable fields on the order doc.

/** @return {{capiFbp:string, capiFbc:string, capiIp:string, capiUa:string, capiOptOut:boolean}} */
function capiFromRequest(body, headers) {
  const b = body || {};
  const h = headers || {};
  return {
    capiFbp: String(b.fbp || "").slice(0, 200),
    capiFbc: String(b.fbc || "").slice(0, 200),
    // identical to the pre-2026-10-29 inline expression: first x-forwarded-for hop
    capiIp: String(h["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 64),
    capiUa: String(h["user-agent"] || "").slice(0, 300),
    // 2026-10-29: buyer had Do Not Sell or Share / GPC on at checkout → no server Purchase.
    capiOptOut: b.metaOptOut === true,
  };
}

/** PaymentIntent metadata entries (strings only, empty ones omitted). */
function capiMetadata(c) {
  const out = {};
  if (c.capiFbp) out.capiFbp = c.capiFbp;
  if (c.capiFbc) out.capiFbc = c.capiFbc;
  if (c.capiIp) out.capiIp = c.capiIp;
  if (c.capiUa) out.capiUa = c.capiUa;
  if (c.capiOptOut) out.capiOptOut = "1";
  return out;
}

/** Order-document fields from PaymentIntent metadata (nulls, stable shape). */
function orderCapiFields(md) {
  const m = md || {};
  return {
    fbp: m.capiFbp || null,
    fbc: m.capiFbc || null,
    checkoutIp: m.capiIp || null,
    checkoutUa: m.capiUa || null,
    capiOptOut: m.capiOptOut === "1",
  };
}

module.exports = {capiFromRequest, capiMetadata, orderCapiFields};
