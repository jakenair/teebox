// functions/lib/capiCarry.js
//
// The Meta CAPI fields that ride along a checkout: captured in createPaymentIntent
// (from the request), carried as PaymentIntent METADATA ONLY, copied onto the
// order document by the Stripe webhook, and read by capiPurchaseOnOrderCreated.
// Pure functions so the whole chain is unit-tested without Stripe or Firestore.
// Nothing here touches amount, fees, transfer or order creation — it is strings
// in `metadata` and four nullable fields on the order doc.

// 2026-11-14: ad-click attribution carried to the order. First-touch values the
// web client stored when the visitor landed (utm_* and Meta's campaign/ad-set/ad
// ids from URL macros). Allowlisted keys, short strings — they are
// attacker-influencable and land in Stripe metadata (500-char cap per value).
const AD_ATTR_KEYS = {
  utm_source: "adUtmSource", utm_medium: "adUtmMedium", utm_campaign: "adUtmCampaign",
  utm_content: "adUtmContent", utm_term: "adUtmTerm", utm_id: "adUtmId",
  campaign_id: "adCampaignId", adset_id: "adAdsetId", ad_id: "adAdId",
};
const cleanAttr = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);

/** Which client made the checkout call: the Capacitor shell's origin is fixed. */
function platformFromHeaders(h) {
  const origin = String((h && (h.origin || h.Origin)) || "").toLowerCase();
  if (origin.startsWith("capacitor://")) return "ios";
  return "web";
}

/** @return {{capiFbp:string, capiFbc:string, capiIp:string, capiUa:string, capiOptOut:boolean, capiPlatform:string, capiIcEventId:string, capiTestCode:string, adAttr:object}} */
function capiFromRequest(body, headers) {
  const b = body || {};
  const h = headers || {};
  const attrIn = (b.adAttr && typeof b.adAttr === "object") ? b.adAttr : {};
  const adAttr = {};
  for (const k of Object.keys(AD_ATTR_KEYS)) {
    const v = cleanAttr(attrIn[k]);
    if (v) adAttr[k] = v;
  }
  return {
    // Server-side InitiateCheckout dedup key: the id the browser pixel used.
    capiIcEventId: /^[A-Za-z0-9_.:-]{1,120}$/.test(String(b.icEventId || "")) ? String(b.icEventId) : "",
    // Events Manager → Test Events code for this session (?meta_test=…).
    capiTestCode: /^[A-Za-z0-9_-]{4,40}$/.test(String(b.testEventCode || "")) ? String(b.testEventCode) : "",
    capiPlatform: platformFromHeaders(h),
    adAttr,
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
  if (c.capiPlatform) out.capiPlatform = c.capiPlatform;
  if (c.capiTestCode) out.capiTestCode = c.capiTestCode;
  for (const [k, mk] of Object.entries(AD_ATTR_KEYS)) {
    if (c.adAttr && c.adAttr[k]) out[mk] = c.adAttr[k];
  }
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
    checkoutPlatform: m.capiPlatform || null,
    capiTestCode: m.capiTestCode || null,
    adAttribution: adAttributionFromMetadata(m),
  };
}

/** The ad-click attribution object for the order doc, or null when none. */
function adAttributionFromMetadata(m) {
  const out = {};
  for (const [k, mk] of Object.entries(AD_ATTR_KEYS)) if (m && m[mk]) out[k] = String(m[mk]);
  return Object.keys(out).length ? out : null;
}

module.exports = {capiFromRequest, capiMetadata, orderCapiFields, platformFromHeaders, AD_ATTR_KEYS};
