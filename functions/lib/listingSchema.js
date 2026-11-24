"use strict";
// Server-side listing check for listings created OUTSIDE the app's Sell form
// (CSV bulk upload, seller API). Seller Integrations Phase 0, 2026-11-17.
//
// WHY THIS EXISTS: the app creates a listing with a direct client write, and
// firestore.rules (isValidListingCreate) is the only gate. Server code writes
// with the Admin SDK, which skips the rules entirely. So every rule the app
// path is held to is repeated here, plus the checks the Sell form does in the
// browser (required specs, at least 1 photo).
//
// Kept honest by two tests:
//   - test/unit/listingSchema.test.js runs scripts/gen-listing-specs.mjs
//     --check, so the category/spec/condition lists match the Sell form.
//   - test/rules/listingParity.test.js sends the same fixtures through this
//     module AND the real rules (emulator) and fails if they disagree.
//
// Changing a rule? Change firestore.rules, then this file; the parity test
// tells you if you forgot one.

const SPECS = require("../data/listing-specs.json");

const PRICE_FLOOR = 5; // firestore.rules categoryFloor(); Sell form floor
const PRICE_MAX = 1000000; // rules: ask < 1000000
const HIGH_VALUE = 300; // marked so an admin can look afterwards; same rules as any other price
const MIN_PHOTOS = 1;
const MAX_PHOTOS = 10;
const MAX_SPECS = 30;
const EXPIRY_DAYS = 182; // Sell form: listings expire 182 days after creation
const SERVER_SOURCES = ["csv", "api"];

// Exactly the create whitelist in firestore.rules isValidListingCreate.
const CREATE_WHITELIST = [
  "sellerId", "title", "brand", "cat", "ask", "condition",
  "createdAt", "status", "expiresAt", "desc", "photos", "emoji",
  "badge", "volume", "change", "quantity", "quantitySold",
  "requiresAuth", "authReviewState", "specCategory", "specs", "source",
  "hiddenReason",
];
const CREATE_REQUIRED = ["sellerId", "title", "brand", "cat", "ask", "condition", "createdAt", "status", "expiresAt"];

// Only plain values are text: an object or list is never turned into some.
const str = (v) => (v == null || typeof v === "object" || typeof v === "function" ? "" : String(v)).trim();
const short = (s) => (s.length > 40 ? s.slice(0, 40) + "..." : s);
const norm = (v) => str(v).toLowerCase().replace(/\s+/g, " ");

/**
 * Why a piece of text can't be stored or shown, or null. Control characters,
 * characters that flip the reading direction, broken Unicode, and (for a
 * title or brand) text with nothing visible in it.
 */
function textProblem(s, {visible = false} = {}) {
  if (!s.isWellFormed()) return "has a character that can't be saved.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(s)) return "has a hidden control character. Remove it.";
  if (visible && s && !/[\p{L}\p{N}\p{P}\p{S}]/u.test(s.replace(/[\u115F\u1160\u3164\uFFA0\u2800]/g, ""))) return "has no visible text.";
  return null;
}

/** A listing's spec values as content-filter fields. */
function specScanFields(specs) {
  const out = {};
  for (const [k, v] of Object.entries(specs && typeof specs === "object" ? specs : {}).slice(0, MAX_SPECS + 1)) {
    let s = "";
    try { s = String(v == null ? "" : v); } catch (_e) { /* not text */ }
    if (s.trim()) out["spec_" + k] = s;
  }
  return out;
}

/** Match a user-typed value to one of a select's options (case/spacing/unit tolerant). */
function matchOption(value, options) {
  const v = norm(value);
  if (!v) return null;
  for (const o of options) if (norm(o) === v) return o;
  // "34" -> '34"', "10.5" -> "10.5°": accept the number without its unit.
  for (const o of options) {
    const bare = norm(o).replace(/[°"]$/, "");
    if (bare === v.replace(/[°"]$/, "") && /^[0-9.]+$/.test(bare)) return o;
  }
  return null;
}

/**
 * Validate one listing input and normalise it.
 * input: {title, brand, category, cat?, condition, price, quantity?, description?,
 *         specs?: {key: value}, photoCount}
 * @return {{ok: boolean, errors: Array<{field: string, message: string}>, value?: object}}
 */
function validateListingInput(input) {
  const errors = [];
  const err = (field, message) => errors.push({field, message});
  const i = input || {};

  const title = str(i.title);
  if (!title) err("title", "Add a title so buyers can find your item.");
  else if (title.length > 120) err("title", "Title is too long (max 120 characters).");

  const brand = str(i.brand);
  if (!brand) err("brand", "Add the brand (or \"Unbranded\").");
  else if (brand.length > 60) err("brand", "Brand is too long (max 60 characters).");

  const titleBad = textProblem(title, {visible: true});
  if (titleBad) err("title", "Title " + titleBad);
  const brandBad = textProblem(brand, {visible: true});
  if (brandBad) err("brand", "Brand " + brandBad);

  const condition = matchOption(i.condition, SPECS.conditions);
  if (!str(i.condition)) err("condition", "Pick a condition.");
  else if (!condition) err("condition", `Condition must be one of: ${SPECS.conditions.join(", ")}.`);

  const specKey = norm(i.category).replace(/ /g, "-");
  const spec = Object.hasOwn(SPECS.categories, specKey) ? SPECS.categories[specKey] : undefined;
  if (!specKey) err("category", "Pick what you're selling (e.g. driver, putter, apparel).");
  else if (!spec) err("category", `Unknown category "${short(str(i.category))}". Use one of: ${Object.keys(SPECS.categories).join(", ")}.`);

  // Browse category: implied by the spec category, except "other".
  let cat = spec && spec.browse ? spec.browse : norm(i.cat);
  if (spec && !spec.browse) {
    if (!cat) err("cat", `For "other" items, also give a browse category: ${SPECS.browseCats.join(", ")}.`);
    else if (!SPECS.browseCats.includes(cat)) err("cat", `Browse category must be one of: ${SPECS.browseCats.join(", ")}.`);
  }
  if (!cat) cat = "";

  const priceRaw = str(i.price).replace(/^\$/, "").replace(/,/g, "");
  const price = Number(priceRaw);
  if (!priceRaw) err("price", "Enter a price.");
  else if (!Number.isFinite(price) || !/^\d+(\.\d{1,2})?$/.test(priceRaw)) err("price", "Price must be a number like 120 or 120.50.");
  else if (price < PRICE_FLOOR) err("price", `Minimum listing price is $${PRICE_FLOOR}.`);
  else if (price >= PRICE_MAX) err("price", "Price is too high.");

  let quantity = 1;
  if (str(i.quantity)) {
    quantity = Number(str(i.quantity));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) err("quantity", "Quantity must be a whole number from 1 to 99.");
  }

  const desc = str(i.description);
  if (desc.length > 4000) err("description", "Description is too long (max 4,000 characters).");
  const descBad = textProblem(desc);
  if (descBad) err("description", "Description " + descBad);

  const specs = {};
  if (spec) {
    const given = i.specs && typeof i.specs === "object" ? i.specs : {};
    const lower = Object.create(null);
    for (const [k, v] of Object.entries(given)) lower[norm(k)] = v;
    for (const f of spec.fields) {
      const raw = str(lower[norm(f.k)] !== undefined ? lower[norm(f.k)] : lower[norm(f.label)]);
      if (!raw) {
        if (f.req) err("spec:" + f.k, `${f.label} is required for ${spec.label.toLowerCase()} listings.`);
        continue;
      }
      if (f.type === "select") {
        const m = matchOption(raw, f.options || []);
        if (!m) { err("spec:" + f.k, `${f.label} must be one of: ${(f.options || []).join(", ")}.`); continue; }
        specs[f.k] = m;
      } else {
        const bad = textProblem(raw);
        if (bad) { err("spec:" + f.k, `${f.label} ${bad}`); continue; }
        specs[f.k] = raw.slice(0, 120).toWellFormed();
      }
    }
    if (brand) specs.brand = brand.slice(0, 60); // the Sell form stores brand in specs too
  }
  if (Object.keys(specs).length > MAX_SPECS) err("specs", "Too many spec fields.");

  const photoCount = Number(i.photoCount) || 0;
  if (photoCount < MIN_PHOTOS) err("photos", "Add at least 1 photo — listings need a main image.");
  else if (photoCount > MAX_PHOTOS) err("photos", `At most ${MAX_PHOTOS} photos per listing.`);

  if (errors.length) return {ok: false, errors};
  return {ok: true, errors, value: {
    title, brand, cat, ask: Math.round(price * 100) / 100, condition, desc,
    specCategory: specKey, specs, quantity, photoCount,
    isHighValue: price >= HIGH_VALUE,
  }};
}

/**
 * The listing document, field-for-field what the app's Sell form writes
 * (js/app-auth.js submitListing), plus `source`. Photos start empty and are
 * attached after upload, exactly like the app.
 */
function buildListingDoc(value, {uid, source, FieldValue, Timestamp, nowMs, paymentReady = true}) {
  if (!SERVER_SOURCES.includes(source)) throw new Error("bad source " + source);
  const now = nowMs || Date.now();
  return {
    title: value.title, brand: value.brand, cat: value.cat, ask: value.ask,
    condition: value.condition, desc: value.desc, badge: "new",
    specCategory: value.specCategory, specs: value.specs,
    photos: [], sellerId: uid,
    // r422: an unready seller's listing saves hidden/awaiting_payouts.
    ...(paymentReady ? {status: "active"} : {status: "hidden", hiddenReason: "awaiting_payouts"}),
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now + EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    quantity: value.quantity, quantitySold: 0,
    requiresAuth: value.isHighValue, authReviewState: value.isHighValue ? "pending" : "na",
    source,
  };
}

// Photos must live in OUR bucket. Live: teebox-market only (= the rules'
// allOwnPhotos). In the sandbox project (and the emulator) that
// project's own bucket is accepted too, so the same code runs there.
const BUCKETS = [...new Set(["teebox-market", require("./sellerApiConfig").projectId() || "teebox-market"])]
    .map((b) => (b + ".firebasestorage.app").replace(/[.]/g, "\\."));
const STORAGE_URL_RE = new RegExp("^https://(firebasestorage\\.googleapis\\.com/v0/b/(" + BUCKETS.join("|") +
    ")/|(" + BUCKETS.join("|") + ")/)");

/**
 * Mirror of firestore.rules isValidListingCreate for a concrete document
 * (createdAt may be a sentinel). The one deliberate difference: `source` may
 * be "csv"/"api" here (server-only values); the rules allow only "bingo".
 * @return {string[]} the names of failed checks ([] = passes)
 */
function rulesCreateCheck(d, {allowServerSource = true, listingId = null} = {}) {
  const f = [];
  const keys = Object.keys(d || {});
  for (const k of CREATE_REQUIRED) if (!keys.includes(k)) f.push("missing:" + k);
  for (const k of keys) if (!CREATE_WHITELIST.includes(k)) f.push("not-allowed:" + k);
  if (!((d.status === "active" && !("hiddenReason" in d)) ||
      (d.status === "hidden" && d.hiddenReason === "awaiting_payouts"))) f.push("status");
  if ("source" in d && !(d.source === "bingo" || (allowServerSource && SERVER_SOURCES.includes(d.source)))) f.push("source");
  const s = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!s(d.title, 120)) f.push("title");
  if (!s(d.brand, 60)) f.push("brand");
  if (!s(d.cat, 40)) f.push("cat");
  if (!s(d.condition, 40)) f.push("condition");
  if (!(typeof d.ask === "number" && d.ask >= PRICE_FLOOR && d.ask < PRICE_MAX)) f.push("ask");
  if ("desc" in d && !(typeof d.desc === "string" && d.desc.length <= 4000)) f.push("desc");
  if ("photos" in d && !(Array.isArray(d.photos) && d.photos.length <= MAX_PHOTOS &&
      d.photos.every((u) => typeof u === "string" && STORAGE_URL_RE.test(u) &&
        // the rules also require this listing's own folder
        (!listingId || u.includes(`/o/listings%2F${d.sellerId}%2F${listingId}%2F`))))) f.push("photos");
  if ("specCategory" in d && !(typeof d.specCategory === "string" && d.specCategory.length <= 20)) f.push("specCategory");
  if ("specs" in d && !(d.specs && typeof d.specs === "object" && !Array.isArray(d.specs) && Object.keys(d.specs).length <= MAX_SPECS)) f.push("specs");
  if ("emoji" in d && !(typeof d.emoji === "string" && d.emoji.length <= 16)) f.push("emoji");
  if ("badge" in d && !(typeof d.badge === "string" && d.badge.length <= 16)) f.push("badge");
  if ("volume" in d && d.volume !== 0) f.push("volume");
  if ("change" in d && d.change !== 0) f.push("change");
  if ("quantity" in d && !(Number.isInteger(d.quantity) && d.quantity >= 1 && d.quantity <= 99)) f.push("quantity");
  if ("quantitySold" in d && d.quantitySold !== 0) f.push("quantitySold");
  if ("requiresAuth" in d && typeof d.requiresAuth !== "boolean") f.push("requiresAuth");
  if ("authReviewState" in d && !["na", "pending"].includes(d.authReviewState)) f.push("authReviewState");
  return f;
}

module.exports = {
  validateListingInput, buildListingDoc, rulesCreateCheck, matchOption, textProblem, specScanFields,
  SPECS, PRICE_FLOOR, HIGH_VALUE, MAX_PHOTOS, CREATE_WHITELIST, STORAGE_URL_RE,
};
