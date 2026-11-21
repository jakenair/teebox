"use strict";
// Parcels, club box types, shipping protection and the shipping config doc.
// One module so checkout, getShippingQuote, updateCheckoutShipping, guest
// checkout and createShippingLabel all quote the SAME box and the same
// protection (founder approval 2026-11-21, after Shippo support confirmed
// rates come from the dims+weight we submit and are not audit-proof).
//
// All dims inches, weights lb, money in cents.

// ── Box sizes ───────────────────────────────────────────────────────────
// Club boxes are all 48" long so a driver or a bundle with woods fits (a
// 42" box saves ~$2-5 UPS Ground Chicago->LA but draws an adjustment when
// a driver goes in it). Smaller-than-quoted packing never draws one.
const CLUB_BOXES = {
  single: {
    label: "Single club or small bundle (1-3 clubs)",
    short: "Single club / 1-3 clubs",
    parcel: {length: "48", width: "8", height: "8", weight: "7"},
  },
  partial: {
    label: "Partial set (4-7 clubs)",
    short: "Partial set / 4-7 clubs",
    parcel: {length: "48", width: "10", height: "8", weight: "12"},
  },
  full: {
    label: "Full set or oversized (8+ clubs)",
    short: "Full set / 8+ clubs",
    parcel: {length: "48", width: "14", height: "10", weight: "22"},
  },
};
const CLUB_BOX_KEYS = Object.keys(CLUB_BOXES);

// Every other category keeps one box (r181 values, unchanged).
const CATEGORY_PARCELS = {
  apparel: {length: "12", width: "10", height: "1", weight: "1"},
  accessories: {length: "12", width: "10", height: "4", weight: "2"},
  headcovers: {length: "12", width: "10", height: "4", weight: "1"},
  shoes: {length: "14", width: "10", height: "5", weight: "3"},
  balls: {length: "12", width: "8", height: "4", weight: "3"},
  bags: {length: "38", width: "14", height: "12", weight: "12"},
};

// Default parcel: 12 x 8 x 4, 2 lb (unknown category).
const DEFAULT_PARCEL = {length: "12", width: "8", height: "4", weight: "2"};

function withUnits(p) {
  return {...p, distance_unit: "in", mass_unit: "lb"};
}

// ── Club box classification ─────────────────────────────────────────────
const IRON_TO = {"9": 9, "PW": 10, "AW": 11, "GW": 11, "SW": 12, "LW": 13};

function boxForCount(n) {
  if (!Number.isFinite(n) || n < 1) return null;
  if (n <= 3) return "single";
  if (n <= 7) return "partial";
  return "full";
}

function ironRangeCount(from, to) {
  const f = parseInt(String(from || ""), 10);
  const t = IRON_TO[String(to || "").toUpperCase()] ||
    parseInt(String(to || ""), 10);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) return null;
  return t - f + 1;
}

const SINGLE_CLUB_SPECS = ["driver", "fairway", "hybrid", "single-iron", "wedge", "putter"];

// Words that mean "more than one club" when no count is given.
const SET_WORDS = /\b(iron\s*set|irons|full\s+set|complete\s+set|set\s+of|club\s+set|package\s+set|set)\b/i;
const FULL_WORDS = /\b(full|complete)\s+(golf\s+)?set\b/i;
const WEDGE_SET = /\bwedges?\b.*\bset\b|\bset\b.*\bwedges?\b|\bwedges\b/i;

/**
 * Which club box a listing ships in.
 *   seller: the seller picked it (specs.shipBox)
 *   specs:  counted from an iron set's setFrom/setTo
 *   title:  read from the title/description
 *   default: nothing said otherwise -> single club
 * confident=false means a person should check it (logged by the backfill).
 * @param {Object} listing
 * @return {{box: string, source: string, confident: boolean, why: string}}
 */
function classifyClubBox(listing) {
  const l = listing || {};
  const specs = l.specs && typeof l.specs === "object" ? l.specs : {};
  if (CLUB_BOX_KEYS.includes(specs.shipBox)) {
    return {box: specs.shipBox, source: "seller", confident: true, why: "seller picked"};
  }
  if (l.specCategory === "iron-set") {
    const n = ironRangeCount(specs.setFrom, specs.setTo);
    if (n) return {box: boxForCount(n), source: "specs", confident: true, why: `iron set ${specs.setFrom}-${specs.setTo} = ${n} clubs`};
  }
  const text = `${l.title || ""} ${l.desc || l.description || ""}`.replace(/\s+/g, " ");
  // "4-PW", "5 thru GW", "3-9"
  const range = text.match(/\b([2-7])\s*(?:-|–|to|thru|through)\s*(pw|aw|gw|sw|lw|9)\b/i);
  if (range) {
    const n = ironRangeCount(range[1], range[2]);
    if (n) return {box: boxForCount(n), source: "title", confident: true, why: `"${range[0]}" = ${n} clubs`};
  }
  // "14 clubs", "13-piece", "7 pc"
  const count = text.match(/\b(\d{1,2})\s*(?:-\s*)?(clubs|piece|pc|pcs)\b/i);
  if (count) {
    const n = parseInt(count[1], 10);
    if (n >= 1 && n <= 20) return {box: boxForCount(n), source: "title", confident: true, why: `"${count[0]}"`};
  }
  if (FULL_WORDS.test(text)) return {box: "full", source: "title", confident: true, why: "says full/complete set"};
  // A single-club spec category ("Fairway", "Driver"...) wins over a loose
  // "set" in the description ("adjustable hosel set to 16°").
  if (SINGLE_CLUB_SPECS.includes(l.specCategory)) {
    return {box: "single", source: "specs", confident: true, why: `${l.specCategory} listing`};
  }
  if (l.specCategory === "iron-set") return {box: "partial", source: "specs", confident: false, why: "iron set, no club count"};
  if (WEDGE_SET.test(text) && /\bset\b|\bwedges\b/i.test(text)) {
    return {box: "single", source: "title", confident: false, why: "wedge set, no count"};
  }
  if (SET_WORDS.test(text)) return {box: "partial", source: "title", confident: false, why: "says set/irons, no count"};
  return {box: "single", source: "default", confident: true, why: "single club"};
}

/**
 * The parcel a listing ships in.
 * @param {Object} listing {cat, specs, specCategory, title, desc}
 * @return {{key: string, parcel: Object}} key e.g. "clubs:partial", "bags"
 */
function parcelForListing(listing) {
  const cat = String((listing && listing.cat) || "").toLowerCase();
  if (cat === "clubs") {
    const {box} = classifyClubBox(listing);
    return {key: `clubs:${box}`, parcel: withUnits(CLUB_BOXES[box].parcel)};
  }
  if (CATEGORY_PARCELS[cat]) return {key: cat, parcel: withUnits(CATEGORY_PARCELS[cat])};
  return {key: "default", parcel: withUnits(DEFAULT_PARCEL)};
}

/** Parcel for a stored key (orders keep the key they were quoted with). */
function parcelForKey(key) {
  const k = String(key || "");
  if (k.startsWith("clubs:") && CLUB_BOXES[k.slice(6)]) return withUnits(CLUB_BOXES[k.slice(6)].parcel);
  if (CATEGORY_PARCELS[k]) return withUnits(CATEGORY_PARCELS[k]);
  if (k === "default") return withUnits(DEFAULT_PARCEL);
  return null;
}

/** "48 × 8 × 8 in, up to 7 lb" */
function describeParcel(p) {
  if (!p) return "";
  return `${p.length} × ${p.width} × ${p.height} in, up to ${p.weight} lb`;
}

/** Seller-facing name for a parcel key ("Partial set / 4-7 clubs", "Bag"). */
function boxName(key) {
  const k = String(key || "");
  if (k.startsWith("clubs:") && CLUB_BOXES[k.slice(6)]) return CLUB_BOXES[k.slice(6)].short;
  const names = {bags: "Bag box", shoes: "Shoe box", apparel: "Apparel mailer",
    accessories: "Accessories box", headcovers: "Headcover box", balls: "Ball box", default: "Small box"};
  return names[k] || "Box";
}

// ── Shipping config (Firestore config/shipping, admin-written) ─────────
// Change in the Firebase console without a deploy. Missing fields fall
// back to these defaults. Read at most once a minute per instance.
const SHIPPING_CONFIG_DEFAULTS = {
  protectionEnabled: true,
  protectionThresholdCents: 10000, // protect items priced OVER $100
  protectionRateBps: 125, // 1.25% of insured value (Shippo Protection, domestic)
  protectionFixedCents: 0, // optional flat add-on per protected order
  labelDeltaAlertCents: 500, // email when a label costs > $5 more than collected
  opsEmail: "jakenair@teeboxmarket.com",
  // Carriers we can actually BUY labels from, e.g. ["USPS"]. Empty = all.
  // Shippo quotes carriers its account can't sell (UPS without "Activate
  // Account" quotes fine, then fails ups_registration_error at purchase),
  // so a checkout quote must use the same list the label can buy from.
  carriers: [],
};
const CONFIG_TTL_MS = 60 * 1000;
let _cfg = null;
let _cfgAt = 0;

function cleanConfig(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const out = {...SHIPPING_CONFIG_DEFAULTS};
  if (typeof d.protectionEnabled === "boolean") out.protectionEnabled = d.protectionEnabled;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (int(d.protectionThresholdCents, 0, 10000000)) out.protectionThresholdCents = d.protectionThresholdCents;
  if (int(d.protectionRateBps, 0, 1000)) out.protectionRateBps = d.protectionRateBps; // cap 10%
  if (int(d.protectionFixedCents, 0, 2000)) out.protectionFixedCents = d.protectionFixedCents; // cap $20
  if (int(d.labelDeltaAlertCents, 0, 100000)) out.labelDeltaAlertCents = d.labelDeltaAlertCents;
  if (Array.isArray(d.carriers)) {
    out.carriers = d.carriers.filter((c) => typeof c === "string" && /^[A-Za-z0-9 _-]{2,30}$/.test(c))
        .map((c) => c.toUpperCase()).slice(0, 10);
  }
  if (typeof d.opsEmail === "string" && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(d.opsEmail)) out.opsEmail = d.opsEmail;
  return out;
}

async function getShippingConfig(db, nowMs = Date.now()) {
  if (_cfg && nowMs - _cfgAt < CONFIG_TTL_MS) return _cfg;
  try {
    const snap = await db.doc("config/shipping").get();
    _cfg = cleanConfig(snap.exists ? snap.data() : {});
  } catch (_e) {
    _cfg = _cfg || cleanConfig({});
  }
  _cfgAt = nowMs;
  return _cfg;
}

function _resetConfigCache() {
  _cfg = null; _cfgAt = 0;
}

/**
 * Shipping protection for an order's item total.
 * @param {number} itemCents item total (unit price x qty)
 * @param {Object} cfg from getShippingConfig
 * @return {{protectionCents: number, insuredCents: number}}
 */
function protectionFor(itemCents, cfg) {
  const c = cfg || SHIPPING_CONFIG_DEFAULTS;
  const item = Math.round(Number(itemCents) || 0);
  if (!c.protectionEnabled || item <= c.protectionThresholdCents) {
    return {protectionCents: 0, insuredCents: 0};
  }
  return {
    protectionCents: Math.ceil(item * c.protectionRateBps / 10000) + c.protectionFixedCents,
    insuredCents: item,
  };
}

/** Rates limited to the purchasable carriers (cfg.carriers; empty = all). */
function filterCarriers(rates, cfg) {
  const allow = (cfg && cfg.carriers) || [];
  if (!Array.isArray(rates) || !allow.length) return rates || [];
  return rates.filter((r) => allow.includes(String((r && r.provider) || "").toUpperCase()));
}

/** Shippo `extra.insurance` for a protected order, or null. */
function shippoInsurance(insuredCents) {
  const v = Math.round(Number(insuredCents) || 0);
  if (v <= 0) return null;
  return {amount: (v / 100).toFixed(2), currency: "USD", content: "Golf equipment"};
}

module.exports = {
  CLUB_BOXES,
  CLUB_BOX_KEYS,
  CATEGORY_PARCELS,
  DEFAULT_PARCEL,
  classifyClubBox,
  ironRangeCount,
  boxForCount,
  parcelForListing,
  parcelForKey,
  describeParcel,
  boxName,
  SHIPPING_CONFIG_DEFAULTS,
  cleanConfig,
  getShippingConfig,
  _resetConfigCache,
  protectionFor,
  shippoInsurance,
  filterCarriers,
};
