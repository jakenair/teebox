"use strict";
// Seller API v1: request handling. Founder decisions 2026-11-20/21.
// Framework-free and fully injectable so the same code runs in unit tests,
// the emulator e2e and the deployed function (sellerApi.js).
//
//   GET    /v1/me                      who this connection is, can the seller list
//   GET    /v1/categories              category tree + spec fields + listing rules
//   GET    /v1/listings                ?updated_since=&status=&limit=&cursor=
//   POST   /v1/listings                create (Idempotency-Key supported)
//   GET    /v1/listings/{id}
//   PATCH  /v1/listings/{id}           edit; quantity sync via quantity_available
//   POST   /v1/listings/{id}/end       end (refused while a buyer is checking out)
//   POST   /v1/sandbox/listings/{id}/sell   test keys only: pretend a buyer bought it
//
// Listings created here are the SAME document the Sell form writes
// (lib/listingCreate + lib/listingSchema), so moderation, photo processing
// and every create trigger run unchanged. Seller rules that apply:
//   - consent: the seller ticked 18+ and the Seller Terms themselves (lib/sellerConsent)
//   - payouts first (r422): unready sellers' listings save hidden/awaiting_payouts
//   - daily cap 25 / 200 shared with CSV (lib/listingCreate.bulkCapFor)
// A seller connected through an approved partner needs no individual approval
// (founder ruling 2026-11-20); the partner key is the approval.
//
// ENVIRONMENTS: the keys' prefix picks the deps (lib/sellerApiConfig.js). Test
// keys get lib/sellerApiSandbox.js, whose database handle can only reach
// sandbox_* collections. This file never builds its own database handle.
//
// NO payments, payouts, refunds, transfers, orders or Stripe anywhere in here
// (founder hard rule; test/unit/noMoneyIntegrations.test.js enforces it).

const crypto = require("node:crypto");
const schema = require("./listingSchema");
const lc = require("./listingCreate");
const {CONFIRM_MESSAGE} = require("./sellerConsent");
const {inCheckout, heldUnits} = require("./checkoutHold");
const {sellerMessage} = require("./photoFetch");
const keys = require("./sellerApiKeys");
const {LIMITS} = require("./sellerApiConfig");

const {ApiError} = keys;
const LOCKED = ["sold", "pending", "pending_payment", "paid", "shipped", "delivered_pending_inspection", "complete"];
const ID_RE = /^[A-Za-z0-9]{1,128}$/;
const API_STATUSES = ["active", "reserved", "sold", "expired", "ended", "awaiting_payouts", "needs_photos", "under_review"];

const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : (typeof t === "number" ? t : null));
const iso = (t) => { const m = ms(t); return m == null ? null : new Date(m).toISOString(); };
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clock = (deps) => (deps.nowMs ? deps.nowMs() : Date.now());
const short = (s, n = 60) => { const t = String(s); return t.length > n ? t.slice(0, n) + "..." : t; };

// ── Serialisation ──────────────────────────────────────────────────────────

function apiStatus(l) {
  switch (l.status || "active") {
    case "active": return "active";
    case "pending": return "reserved";
    case "sold": return "sold";
    case "expired": return "expired";
    case "removed": return "ended";
    case "hidden":
      if (l.hiddenReason === "awaiting_payouts") return "awaiting_payouts";
      if (l.hiddenReason === "photos_missing") return "needs_photos";
      return "under_review";
    default: return "under_review";
  }
}

function changedMs(l) { return Math.max(ms(l.updatedAt) || 0, ms(l.createdAt) || 0); }

function serializeListing(id, l, cfg, origin, nowMs) {
  const total = Math.max(1, Number(l.quantity) || 1);
  const sold = Math.max(0, Number(l.quantitySold) || 0);
  const reserved = heldUnits(l, nowMs || Date.now());
  const status = apiStatus(l);
  const specs = {...(l.specs || {})};
  delete specs.brand; // stored twice by the Sell form; brand is its own field here
  return {
    id,
    url: cfg.listingUrlBase ? cfg.listingUrlBase + id : null,
    status,
    title: l.title || "",
    brand: l.brand || "",
    category: l.specCategory || null,
    browse_category: l.cat || null,
    condition: l.condition || "",
    price: Number(l.ask) || 0,
    currency: "USD",
    quantity: total,
    quantity_sold: sold,
    quantity_available: status === "active" ? Math.max(0, total - sold - reserved) : 0,
    description: l.desc || "",
    specs,
    photos: (Array.isArray(l.photos) ? l.photos : []).filter((u) => typeof u === "string"),
    created_at: iso(l.createdAt),
    updated_at: new Date(changedMs(l)).toISOString(),
    expires_at: iso(l.expiresAt),
    sold_at: iso(l.soldAt),
    ended_at: status === "ended" ? iso(l.removedAt) : null,
    created_via: l.source === "api" ? "api" : l.source === "csv" ? "csv" : "teebox",
    created_by_you: !!(origin && origin.partnerId),
  };
}

function serializeCategories() {
  const S = schema.SPECS;
  return {
    conditions: S.conditions,
    browse_categories: S.browseCats,
    categories: Object.entries(S.categories).map(([id, c]) => ({
      id, label: c.label,
      browse_category: c.browse || null,
      requires_browse_category: !c.browse,
      fields: (c.fields || []).map((f) => ({
        key: f.k, label: f.label, type: f.type === "select" ? "select" : "text",
        required: !!f.req, ...(f.type === "select" ? {options: f.options || []} : {}),
      })),
    })),
    rules: {
      price_min: schema.PRICE_FLOOR, currency: "USD", quantity_max: 99,
      photos_min: 1, photos_max: schema.MAX_PHOTOS,
      high_value_price: schema.HIGH_VALUE, high_value_photos_min: schema.MIN_PHOTOS_HIGH_VALUE,
      title_max: 120, brand_max: 60, description_max: 4000,
    },
  };
}

// ── Input ──────────────────────────────────────────────────────────────────

const CREATE_FIELDS = ["title", "brand", "category", "browse_category", "condition", "price", "quantity",
  "description", "specs", "photo_urls"];
const PATCH_FIELDS = ["title", "brand", "category", "browse_category", "condition", "price", "quantity",
  "quantity_available", "description", "specs", "photo_urls"];

const TEXT_FIELDS = ["title", "brand", "category", "browse_category", "condition", "description"];
const badField = (field, message) => new ApiError(422, "validation_failed", message, {errors: [{field, message}]});

/**
 * Before anything else: refuse a body that is too big or isn't JSON. The
 * platform has already parsed it, so this stops our own work, not the parse.
 */
function checkRequest(req) {
  const declared = Number(keys.header(req.headers, "content-length")) || 0;
  const size = Math.max(declared, Number(req.bodyBytes) || 0);
  if (size > LIMITS.maxBodyBytes) {
    throw new ApiError(413, "payload_too_large", `The request body can't be more than ${LIMITS.maxBodyBytes / 1024} KB.`);
  }
  const raw = Buffer.isBuffer(req.body) || (typeof req.body === "string" && req.body !== "");
  const json = /^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(keys.header(req.headers, "content-type").trim());
  if (req.method !== "GET" && (raw || (size > 0 && !json))) {
    throw new ApiError(415, "unsupported_media_type", "Send the body as JSON with Content-Type: application/json.");
  }
}

function checkBody(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "Send a JSON object with Content-Type: application/json.");
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k)).slice(0, 10).map((k) => short(k, 40));
  if (unknown.length) {
    throw new ApiError(400, "unknown_field", `Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
        {fields: unknown});
  }
  for (const k of TEXT_FIELDS) {
    if (body[k] != null && typeof body[k] !== "string") throw badField(k, `${k} must be text.`);
  }
  if (body.price != null && typeof body.price !== "number" && typeof body.price !== "string") throw badField("price", "price must be a number.");
  if (body.quantity != null && typeof body.quantity !== "number" && typeof body.quantity !== "string") throw badField("quantity", "quantity must be a whole number.");
  if (body.specs != null && (typeof body.specs !== "object" || Array.isArray(body.specs))) {
    throw badField("specs", "specs must be an object of field key to value.");
  }
  for (const [k, v] of Object.entries(body.specs || {})) {
    if (v != null && typeof v !== "string" && typeof v !== "number") throw badField("specs." + short(k, 40), "Each spec must be text.");
  }
  if (body.photo_urls != null) {
    if (!Array.isArray(body.photo_urls) || body.photo_urls.some((u) => typeof u !== "string" || u.length > 2048)) {
      throw new ApiError(422, "validation_failed", "photo_urls must be an array of https URLs.", {errors: [{field: "photo_urls", message: "must be an array of URLs"}]});
    }
    if (body.photo_urls.length > LIMITS.photoUrlsMax) {
      throw new ApiError(422, "validation_failed", `At most ${LIMITS.photoUrlsMax} photos per listing.`, {errors: [{field: "photo_urls", message: "too many photos"}]});
    }
  }
}

const numStr = (v) => (v == null ? "" : String(v).slice(0, 40));

function toSchemaInput(b, photoCount) {
  return {
    title: b.title, brand: b.brand, category: b.category, cat: b.browse_category,
    condition: b.condition, price: numStr(b.price),
    quantity: b.quantity == null ? "" : numStr(b.quantity),
    description: b.description, specs: b.specs || {}, photoCount,
  };
}

function apiField(f) {
  if (f === "cat") return "browse_category";
  if (f === "photos") return "photo_urls";
  if (f.startsWith("spec:")) return "specs." + f.slice(5);
  return f;
}

function validationError(errors) {
  const list = errors.map((e) => ({field: apiField(e.field), message: e.message}));
  return new ApiError(422, "validation_failed", list[0] ? list[0].message : "Validation failed.", {errors: list});
}

function sellerError(e) {
  if (!(e instanceof lc.ListingCreateError)) return e;
  if (e.message === CONFIRM_MESSAGE) return new ApiError(403, "seller_consent_required", e.message);
  if (/Verify your email/.test(e.message)) return new ApiError(403, "seller_email_unverified", e.message);
  if (e.code === "unauthenticated") return new ApiError(401, "seller_not_found", e.message);
  if (e.code === "permission-denied") return new ApiError(403, "seller_disabled", e.message);
  if (e.code === "invalid-argument") return new ApiError(422, "validation_failed", e.message);
  return new ApiError(400, "seller_cannot_list", e.message);
}

// ── Photos ─────────────────────────────────────────────────────────────────

/**
 * Fetch every URL first (no listing yet). Returns buffers + per-URL errors.
 * The same picture sent twice counts once.
 */
async function prefetchPhotos(deps, urls) {
  const out = new Array(urls.length).fill(null);
  const errors = [];
  const fail = (index, message) => errors.push({index, url: urls[index].slice(0, 200), message});
  const stopAt = Date.now() + LIMITS.photoPhaseMs;
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      if (Date.now() > stopAt) { fail(i, "the photos took too long to download"); continue; }
      try {
        out[i] = await deps.fetchPhoto(urls[i]);
      } catch (e) { fail(i, sellerMessage(e)); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const seen = new Map();
  out.forEach((p, i) => {
    if (!p) return;
    const id = p.buffer ? crypto.createHash("sha256").update(p.buffer).digest("hex") : p.url;
    if (seen.has(id)) { out[i] = null; fail(i, `same photo as photo_urls[${seen.get(id)}]`); } else seen.set(id, i);
  });
  return {photos: out.filter(Boolean), errors: errors.sort((a, b) => a.index - b.index)};
}

/** Run with one of this instance's few photo slots, so photos can't fill its memory. */
async function withPhotoSlot(deps, fn) {
  if (!deps.photoSlot) return fn();
  try {
    return await deps.photoSlot(fn);
  } catch (e) {
    if (!e || !e.slotsFull) throw e;
    throw new ApiError(503, "busy", "TeeBox is busy with other photos. Retry in 30 seconds.", {retry_after: 30, headers: {"Retry-After": "30"}});
  }
}

/** Count photo downloads before making them. They are never given back. */
async function reservePhotos(deps, ctx, n) {
  if (!n) return;
  const cap = lc.photoCapFor(ctx.user);
  const q = await lc.reserveBulkQuota({db: deps.db, Timestamp: deps.Timestamp, uid: ctx.uid, want: n, cap,
    nowMs: clock(deps), counter: "apiPhotoDownloads", whole: true});
  if (q.granted < n) {
    throw new ApiError(429, "daily_limit_reached", `This seller has reached their daily limit of ${cap} photo downloads. ` +
      `Try again after ${new Date(q.resetAt).toISOString()}.`, {daily_limit: cap, resets_at: new Date(q.resetAt).toISOString()});
  }
}

async function storePhotos(deps, ctx, listingId, photos, photoErrors) {
  const stored = [];
  for (let i = 0; i < photos.length; i++) {
    try {
      stored.push(await deps.storePhoto({uid: ctx.uid, listingId, index: i, ...photos[i]}));
    } catch (e) {
      if (deps.logError) deps.logError("sellerApi: photo upload failed", e);
      photoErrors.push({index: i, url: null, message: "the photo could not be saved"});
    }
  }
  return stored;
}

function minPhotos(price) { return Number(price) >= schema.HIGH_VALUE ? schema.MIN_PHOTOS_HIGH_VALUE : 1; }

function photoShortError(need, got, errors) {
  return new ApiError(422, "photo_fetch_failed",
      `${need > 1 ? `Listings at $${schema.HIGH_VALUE} or more need ${need} photos` : "A listing needs at least 1 photo"}, ` +
      `and only ${got} of the photo URLs could be downloaded. Nothing was created or changed.`,
      {photo_errors: errors});
}

// The photoVariants map is keyed by photo index; keep only entries whose
// source file is still in the new photo list (same as updateListing).
function storagePath(url) {
  const m = String(url || "").match(/\/o\/([^?]+)/);
  if (!m) return null;
  try { const p = decodeURIComponent(m[1]); return p.startsWith("listings/") ? p : null; } catch (_e) { return null; }
}
function rekeyPhotoVariants(prev, nextPhotos) {
  const byPath = new Map();
  for (const v of Object.values(prev || {})) {
    const any = v && (v.w400 || v.w800 || v.w1200);
    const vp = any ? storagePath(any) : null;
    if (vp) byPath.set(vp.replace(/_w(400|800|1200)\.webp$/, ""), v);
  }
  const out = {};
  (nextPhotos || []).forEach((u, j) => { const p = storagePath(u); if (p && byPath.has(p)) out[String(j)] = byPath.get(p); });
  return out;
}

// ── Limits, idempotency, audit ─────────────────────────────────────────────

async function rateLimit(deps, ctx) {
  const {db, Timestamp} = deps;
  const now = clock(deps);
  const minute = Math.floor(now / 60000);
  const cRef = db.doc(`apiRate/c_${ctx.connectionId}_${minute}`);
  const expireAt = Timestamp.fromMillis((minute + 10) * 60000);
  const limited = (scope, limit) => ({ok: false, scope, limit, used: limit});
  // The partner counter is split into shards so busy partners don't queue on
  // one document. Start at a random shard and try the rest before refusing,
  // so the total is still exact.
  const shards = LIMITS.partnerRateShards;
  const perShard = Math.floor(LIMITS.partnerRequestsPerMinute / shards);
  const start = Math.floor((deps.random || Math.random)() * shards);
  const r = await db.runTransaction(async (tx) => {
    const c = await tx.get(cRef);
    const cn = c.exists ? Number(c.data().n) || 0 : 0;
    if (cn >= LIMITS.requestsPerMinute) return limited("connection", LIMITS.requestsPerMinute);
    for (let i = 0; i < shards; i++) {
      const pRef = db.doc(`apiRate/p_${ctx.partnerId}_${minute}_${(start + i) % shards}`);
      const p = await tx.get(pRef);
      const pn = p.exists ? Number(p.data().n) || 0 : 0;
      if (pn >= perShard) continue;
      tx.set(cRef, {n: cn + 1, expireAt});
      tx.set(pRef, {n: pn + 1, expireAt});
      return {ok: true, limit: LIMITS.requestsPerMinute, used: cn + 1};
    }
    return limited("partner", LIMITS.partnerRequestsPerMinute);
  });
  const resetSec = Math.max(1, Math.ceil(((minute + 1) * 60000 - now) / 1000));
  const headers = {"RateLimit-Limit": String(r.limit), "RateLimit-Remaining": String(Math.max(0, r.limit - r.used)),
    "RateLimit-Reset": String(resetSec)};
  if (!r.ok) {
    throw new ApiError(429, "rate_limited", r.scope === "partner" ?
      `Too many requests for this partner key (limit ${r.limit} per minute across all sellers). Retry after ${resetSec}s.` :
      `Too many requests for this seller (limit ${r.limit} per minute). Retry after ${resetSec}s.`,
    {retry_after: resetSec, headers: {...headers, "Retry-After": String(resetSec)}});
  }
  return headers;
}

const IDEM_RE = /^[\x21-\x7e]{1,255}$/;

/** @return {Promise<null|{replay: object}|{ref, bodyHash}>} */
async function idempotencyBegin(deps, ctx, key, body) {
  if (!key) return null;
  if (!IDEM_RE.test(key)) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-255 printable characters.");
  const {db, Timestamp} = deps;
  const now = clock(deps);
  const ref = db.doc(`apiIdempotency/${sha(ctx.connectionId + "\n" + key)}`);
  const bodyHash = sha(JSON.stringify(body || {}));
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    // An expired key is gone, whether or not the database has deleted it yet.
    const live = !!d && !(ms(d.expireAt) && ms(d.expireAt) <= now);
    if (live) {
      if (d.bodyHash !== bodyHash) {
        throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
      }
      if (d.state === "done") return {replay: {status: d.status, body: JSON.parse(d.response)}};
      if (d.state !== "failed" && now - (ms(d.startedAt) || 0) < LIMITS.idempotencyLockMs) {
        throw new ApiError(409, "request_in_progress", "A request with this Idempotency-Key is still being processed. Retry in a few seconds.");
      }
    }
    // A create that got as far as making its listing resumes it, never repeats it.
    const listingId = live && d.listingId ? d.listingId : null;
    const claim = crypto.randomBytes(9).toString("base64url");
    tx.set(ref, {state: "processing", bodyHash, claim, startedAt: Timestamp.fromMillis(now),
      expireAt: Timestamp.fromMillis(now + LIMITS.idempotencyHours * 3600000), ...(listingId ? {listingId} : {})});
    return {ref, bodyHash, claim, listingId};
  });
}

async function idempotencyEnd(deps, idem, status, body) {
  if (!idem || !idem.ref) return;
  await deps.db.runTransaction(async (tx) => {
    const s = await tx.get(idem.ref);
    if (!s.exists || s.data().claim !== idem.claim) return; // a later retry owns the key now
    if (idem.listingId && status >= 400) {
      tx.set(idem.ref, {state: "failed", listingId: idem.listingId}, {merge: true});
    } else if (status >= 500) tx.delete(idem.ref);
    else tx.set(idem.ref, {state: "done", status, response: JSON.stringify(body)}, {merge: true});
  });
}

async function audit(deps, entry) {
  try {
    const {db, Timestamp} = deps;
    const now = clock(deps);
    await db.collection("apiAudit").add({...entry, at: Timestamp.fromMillis(now),
      expireAt: Timestamp.fromMillis(now + LIMITS.auditDays * 86400000)});
  } catch (_e) { /* audit is best-effort; never fails a request */ }
}

async function touchConnection(deps, ctx) {
  const now = clock(deps);
  if (now - (ms(ctx.connection.lastUsedAt) || 0) < 10 * 60000) return;
  try {
    await deps.db.doc(`apiConnections/${ctx.connectionId}`).update({lastUsedAt: deps.Timestamp.fromMillis(now)});
  } catch (_e) { /* best-effort */ }
}

// ── Handlers ───────────────────────────────────────────────────────────────

const notFound = () => new ApiError(404, "listing_not_found",
    "No such listing. A listing that returns 404 has been removed from TeeBox; delist it on your side.");

async function loadOwnListing(deps, ctx, id, tx) {
  if (!ID_RE.test(id)) throw notFound();
  const ref = deps.db.doc(`listings/${id}`);
  // About to write: the keys and the seller must still be good.
  if (tx) await keys.recheck(deps, ctx, tx);
  const snap = tx ? await tx.get(ref) : await ref.get();
  // Someone else's listing looks exactly like a missing one.
  if (!snap.exists || (snap.data() || {}).sellerId !== ctx.uid) {
    throw notFound();
  }
  return {ref, data: snap.data() || {}};
}

const stillRunning = () => new ApiError(409, "request_in_progress",
    "A request with this Idempotency-Key is still being processed. Retry in a few seconds.");

async function originOf(deps, ctx, id) {
  const s = await deps.db.doc(`listingApiOrigin/${id}`).get();
  return s.exists && s.data().partnerId === ctx.partnerId ? s.data() : null;
}

async function getMe(deps, ctx) {
  const u = ctx.user;
  let canList = true; let reason = null;
  try { await lc.assertSellerCanList({db: deps.db, auth: deps.auth, uid: ctx.uid}); } catch (e) {
    const a = sellerError(e); canList = false; reason = {code: a.code, message: a.message};
  }
  const cap = lc.bulkCapFor(u);
  const q = await deps.db.doc(`users/${ctx.uid}/rateLimits/bulkListingCreate`).get();
  const qd = q.exists ? q.data() : {};
  const resetMs = ms(qd.resetAt) || 0;
  const now = clock(deps);
  const used = resetMs > now ? Number(qd.count) || 0 : 0;
  return {status: 200, body: {
    environment: deps.cfg.mode === "live" ? "live" : "sandbox",
    partner: {id: ctx.partnerId, name: ctx.partner.name || ctx.partnerId},
    seller: {
      display_name: u.displayName || u.username || null,
      can_list: canList, cannot_list_reason: reason,
      payouts_ready: u.stripeChargesEnabled === true,
      daily_listing_limit: cap, listings_created_today: used,
      daily_limit_resets_at: resetMs > now ? new Date(resetMs).toISOString() : null,
    },
  }};
}

const scanFieldsOf = (value) => ({title: value.title, brand: value.brand, desc: value.desc,
  cat: value.cat, condition: value.condition, ...schema.specScanFields(value.specs)});

/** A listing TeeBox took for review while it was being created. */
function heldListing(deps, ctx, id, value) {
  return serializeListing(id, {status: "hidden", hiddenReason: "moderation_hold", title: value.title, brand: value.brand,
    cat: value.cat, specCategory: value.specCategory, condition: value.condition, ask: value.ask, desc: value.desc,
    specs: value.specs, quantity: value.quantity, source: "api", createdAt: clock(deps)}, deps.cfg, {partnerId: ctx.partnerId});
}

async function createListing(deps, ctx, body, idem) {
  checkBody(body, CREATE_FIELDS);
  const urls = (body.photo_urls || []).map((u) => u.trim());
  const v = schema.validateListingInput(toSchemaInput(body, urls.length));
  if (!v.ok) throw validationError(v.errors);

  let seller;
  try { seller = await lc.assertSellerCanList({db: deps.db, auth: deps.auth, uid: ctx.uid}); } catch (e) { throw sellerError(e); }

  const scan = await deps.scanText(scanFieldsOf(v.value), ctx.uid);
  if (scan && scan.clean === false) {
    throw new ApiError(422, "content_violation", "This listing's text breaks the TeeBox listing rules. Nothing was created.",
        {category: scan.category || null});
  }
  return withPhotoSlot(deps, () => createWithPhotos(deps, ctx, v.value, urls, seller, idem));
}

async function createWithPhotos(deps, ctx, value, urls, seller, idem) {
  const {db, FieldValue, Timestamp} = deps;
  const created = (id, l, photoErrors) => ({status: 201, listingId: id, body: {
    listing: l && l.sellerId === ctx.uid ? serializeListing(id, l, deps.cfg, {partnerId: ctx.partnerId}) : heldListing(deps, ctx, id, value),
    photo_errors: photoErrors}});
  const read = async (id) => { const s = await db.doc(`listings/${id}`).get(); return s.exists ? s.data() || {} : null; };

  // A retry of a create that already made its listing carries on with it.
  let listingId = idem && idem.listingId ? idem.listingId : null;
  if (listingId) {
    const l = await read(listingId);
    const began = (await db.doc(`listingApiOrigin/${listingId}`).get()).exists;
    if (!l && !began) { listingId = null; idem.listingId = null; } // it was never saved
    else if (!l || l.sellerId !== ctx.uid || (Array.isArray(l.photos) && l.photos.length) ||
        !["active", "hidden", "flagged"].includes(l.status)) return created(listingId, l, []);
  }
  const resumed = !!listingId;

  // Both daily limits come before any download.
  if (!resumed) {
    const q = await lc.reserveBulkQuota({db, Timestamp, uid: ctx.uid, want: 1, cap: seller.cap, nowMs: clock(deps)});
    if (q.granted < 1) {
      throw new ApiError(429, "daily_limit_reached",
          `This seller has reached their daily limit of ${seller.cap} new listings (shared with CSV upload). ` +
          `Try again after ${new Date(q.resetAt).toISOString()}.`, {daily_limit: seller.cap, resets_at: new Date(q.resetAt).toISOString()});
    }
  }
  let pre;
  try {
    await reservePhotos(deps, ctx, urls.length);
    pre = await prefetchPhotos(deps, urls);
    const need = minPhotos(value.ask);
    if (pre.photos.length < need) throw photoShortError(need, pre.photos.length, pre.errors);
    if (!resumed) {
      // The listing, which partner made it (founder ruling 2026-11-20; its own
      // document, so the listing stays field-for-field the Sell form's) and
      // the idempotency record land together or not at all.
      listingId = await lc.createListingDoc({db, FieldValue, Timestamp, uid: ctx.uid, value, source: "api",
        paymentReady: seller.paymentReady, nowMs: clock(deps), withTx: async (tx, id) => {
          await keys.recheck(deps, ctx, tx); // before any write in this transaction
          if (idem) {
            const s = await tx.get(idem.ref);
            if (!s.exists || s.data().claim !== idem.claim) throw stillRunning();
          }
          tx.set(db.doc(`listingApiOrigin/${id}`), {partnerId: ctx.partnerId, connectionId: ctx.connectionId,
            uid: ctx.uid, createdAt: FieldValue.serverTimestamp()});
          if (idem) { idem.listingId = id; tx.update(idem.ref, {listingId: id}); }
        }});
    }
  } catch (e) {
    if (!resumed) await lc.releaseBulkQuota({db, uid: ctx.uid, n: 1});
    throw sellerError(e);
  }

  const photoErrors = [...pre.errors];
  try {
    const stored = await storePhotos(deps, ctx, listingId, pre.photos, photoErrors);
    await lc.attachListingPhotos({db, FieldValue, uid: ctx.uid, listingId, urls: stored, isPhotoUrl: deps.isPhotoUrl,
      ...(resumed ? {paymentReady: seller.paymentReady} : {})});
  } catch (e) {
    // Never leave it for sale without photos; a retry with the same key finishes it.
    try { await lc.hideIfPhotoless({db, FieldValue, uid: ctx.uid, listingId}); } catch (e2) {
      if (deps.logError) deps.logError("sellerApi: could not hide a photo-less listing", e2);
    }
    throw e;
  }
  return created(listingId, await read(listingId), photoErrors);
}

async function getListing(deps, ctx, id) {
  const {data} = await loadOwnListing(deps, ctx, id);
  return {status: 200, listingId: id, body: {listing: serializeListing(id, data, deps.cfg, await originOf(deps, ctx, id))}};
}

// Times the database can hold.
const MIN_MS = -62135596800000;
const MAX_MS = 253402300799999;
const isTime = (n) => Number.isInteger(n) && n >= MIN_MS && n <= MAX_MS;

function decodeCursor(c) {
  try {
    const j = JSON.parse(Buffer.from(String(c).slice(0, 2000), "base64url").toString("utf8"));
    // A position is [milliseconds, listing id] plus, when there are any, the
    // nanoseconds past that millisecond.
    const ok = (p) => p === null || (Array.isArray(p) && isTime(p[0]) && typeof p[1] === "string" && ID_RE.test(p[1]) &&
      (p.length === 2 || (p.length === 3 && Number.isInteger(p[2]) && p[2] >= 0 && p[2] < 1e6)));
    if (j && isTime(j.s) && ok(j.a) && ok(j.b)) return j;
  } catch (_e) { /* fall through */ }
  throw new ApiError(400, "invalid_cursor", "That cursor isn't valid. Start again without a cursor.");
}
/** Nanoseconds past the millisecond. */
const subMs = (t) => (t && Number.isInteger(t.nanoseconds) ? t.nanoseconds % 1e6 : 0);
function cursorTime(Timestamp, [m, , ns]) {
  if (!ns) return Timestamp.fromMillis(m);
  const sec = Math.floor(m / 1000);
  return new Timestamp(sec, (m - sec * 1000) * 1e6 + ns);
}
const position = (x) => (x.ns ? [x.k, x.id, x.ns] : [x.k, x.id]);
const encodeCursor = (c) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

/**
 * Everything that changed since a time, oldest change first.
 * Two streams merged: listings by updatedAt, and listings that have never been
 * updated (created in the app, no updatedAt yet) by createdAt. Each stream
 * resumes from its own position in the cursor, so nothing is skipped or
 * repeated. A page can be shorter than limit; keep going while has_more.
 */
async function listListings(deps, ctx, query) {
  const {db, Timestamp} = deps;
  const limit = query.limit == null ? LIMITS.listPageDefault : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listPageMax) {
    throw new ApiError(400, "invalid_limit", `limit must be a whole number from 1 to ${LIMITS.listPageMax}.`);
  }
  let statuses = null;
  if (query.status) {
    statuses = String(query.status).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = statuses.filter((s) => !API_STATUSES.includes(s));
    if (bad.length) throw new ApiError(400, "invalid_status", `Unknown status: ${short(bad.join(", "))}. Use: ${API_STATUSES.join(", ")}.`);
  }
  let cur;
  if (query.cursor) {
    cur = decodeCursor(query.cursor);
  } else {
    const raw = query.updated_since != null ? query.updated_since : query.updatedSince;
    let since = 0;
    if (raw != null && raw !== "") {
      since = Date.parse(String(raw));
      if (!isTime(since)) throw new ApiError(400, "invalid_updated_since", "updated_since must be an ISO 8601 time, e.g. 2026-12-01T00:00:00Z.");
    }
    cur = {s: since, a: null, b: null};
  }

  const page = limit + 1;
  const base = () => db.collection("listings").where("sellerId", "==", ctx.uid);
  let qa = base().where("updatedAt", ">=", Timestamp.fromMillis(cur.s)).orderBy("updatedAt").orderBy("__name__");
  if (cur.a) qa = qa.startAfter(cursorTime(Timestamp, cur.a), cur.a[1]);
  let qb = base().where("createdAt", ">=", Timestamp.fromMillis(cur.s)).orderBy("createdAt").orderBy("__name__");
  if (cur.b) qb = qb.startAfter(cursorTime(Timestamp, cur.b), cur.b[1]);
  const [sa, sb] = await Promise.all([qa.limit(page).get(), qb.limit(page).get()]);

  const A = sa.docs.map((d) => ({id: d.id, l: d.data(), k: ms(d.data().updatedAt), ns: subMs(d.data().updatedAt)}));
  const B = sb.docs.map((d) => ({id: d.id, l: d.data(), k: ms(d.data().createdAt), ns: subMs(d.data().createdAt), skip: ms(d.data().updatedAt) != null}));
  const aMore = A.length === page; const bMore = B.length === page;
  if (aMore) A.pop();
  if (bMore) B.pop();

  const out = [];
  let ia = 0; let ib = 0;
  let posA = cur.a; let posB = cur.b;
  const before = (x, y) => x.k < y.k || (x.k === y.k && (x.ns < y.ns || (x.ns === y.ns && x.id < y.id)));
  while (out.length < limit) {
    const ha = ia < A.length ? A[ia] : null;
    const hb = ib < B.length ? B[ib] : null;
    // A stream that still has unread rows beyond its buffer can't be passed.
    if (!ha && aMore) break;
    if (!hb && bMore) break;
    if (!ha && !hb) break;
    if (ha && (!hb || before(ha, hb))) {
      ia++; posA = position(ha);
      out.push(ha);
    } else {
      ib++; posB = position(hb);
      if (!hb.skip) out.push(hb); // has updatedAt: stream A reports it
    }
  }
  const hasMore = ia < A.length || ib < B.length || aMore || bMore;

  const origins = {};
  if (out.length) {
    const refs = out.map((x) => db.doc(`listingApiOrigin/${x.id}`));
    const snaps = db.getAll ? await db.getAll(...refs) : await Promise.all(refs.map((r) => r.get()));
    snaps.forEach((s, i) => { if (s.exists && s.data().partnerId === ctx.partnerId) origins[out[i].id] = s.data(); });
  }
  let data = out.map((x) => serializeListing(x.id, x.l, deps.cfg, origins[x.id]));
  if (statuses) data = data.filter((x) => statuses.includes(x.status));
  return {status: 200, body: {data, has_more: hasMore, next_cursor: hasMore ? encodeCursor({s: cur.s, a: posA, b: posB}) : null}};
}

/**
 * What an edit does to the $300+ authenticity review (same rule as
 * updateListing). An edit never clears a rejection, whatever the new price.
 * @param {object} cur @param {boolean} isHighValue
 * @return {string|null} the new authReviewState, or null to leave it alone
 */
function authReviewAfterEdit(cur, isHighValue) {
  if (cur.authReviewState === "rejected") return null;
  if (isHighValue && !cur.requiresAuth) return "pending";
  if (!isHighValue && cur.requiresAuth) return "na";
  return null;
}

/** What the edit asks the total quantity to become, or null. Throws if it can't. */
function patchedQuantity(cur, body, nowMs) {
  const taken = Math.max(0, Number(cur.quantitySold) || 0) + heldUnits(cur, nowMs);
  const bad = (field, message) => validationError([{field, message}]);
  let quantity = null;
  if (body.quantity_available != null) {
    const a = body.quantity_available;
    if (!Number.isInteger(a) || a < 0) throw bad("quantity_available", "quantity_available must be a whole number, 0 or more.");
    if (a === 0) {
      throw new ApiError(400, "use_end", "To mark a listing sold out, send quantity_available: 0 on its own, or POST /v1/listings/{id}/end.");
    }
    quantity = taken + a;
  } else if (body.quantity != null) {
    quantity = body.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) throw bad("quantity", "quantity must be a whole number from 1 to 99.");
    if (quantity < taken) throw bad("quantity", `quantity can't be below the ${taken} already sold or in checkout.`);
  }
  if (quantity > 99) throw bad(body.quantity_available != null ? "quantity_available" : "quantity", "Total quantity can't be more than 99.");
  return quantity;
}

/** The whole listing as it would be after the edit, checked. Throws if it breaks a rule. */
function patchedValue(cur, body, photoCount) {
  const curSpecs = {...(cur.specs || {})}; delete curSpecs.brand;
  const pick = (k, v) => (body[k] != null ? body[k] : v);
  const v = schema.validateListingInput(toSchemaInput({
    title: pick("title", cur.title),
    brand: pick("brand", cur.brand),
    category: pick("category", cur.specCategory),
    browse_category: pick("browse_category", cur.cat),
    condition: pick("condition", cur.condition),
    price: pick("price", cur.ask),
    description: pick("description", cur.desc || ""),
    // Changing category starts its specs fresh; otherwise given keys overlay current ones.
    specs: body.category != null && body.category !== cur.specCategory ? (body.specs || {}) : {...curSpecs, ...(body.specs || {})},
    quantity: 1,
  }, photoCount));
  if (!v.ok) throw validationError(v.errors);
  return v.value;
}

/** Only the fields the edit sent (plus what follows from them). */
function patchedFields(body, value) {
  const has = (...ks) => ks.some((k) => body[k] != null);
  return {
    ...(has("title") ? {title: value.title} : {}),
    ...(has("brand") ? {brand: value.brand} : {}),
    ...(has("condition") ? {condition: value.condition} : {}),
    ...(has("description") ? {desc: value.desc} : {}),
    ...(has("price") ? {ask: value.ask, bid: Math.round(value.ask * 0.9)} : {}),
    ...(has("category", "browse_category") ? {cat: value.cat} : {}),
    ...(has("category") ? {specCategory: value.specCategory} : {}),
    ...(has("category", "specs", "brand") ? {specs: value.specs} : {}),
  };
}

const photosOf = (l) => (Array.isArray(l.photos) ? l.photos : []);

async function patchListing(deps, ctx, id, body) {
  checkBody(body, PATCH_FIELDS);
  if (!Object.keys(body).length) throw new ApiError(400, "empty_update", "Send at least one field to change.");
  if (body.quantity != null && body.quantity_available != null) {
    throw new ApiError(400, "conflicting_fields", "Send quantity or quantity_available, not both.");
  }
  const cur0 = (await loadOwnListing(deps, ctx, id)).data;

  // Sold out elsewhere: quantity_available 0 ends the listing.
  if (body.quantity_available === 0 && Object.keys(body).length === 1) {
    if (cur0.status !== "pending") guardEditable(cur0); // a lapsed hold can be ended; endListing checks
    return endListing(deps, ctx, id, "sold_elsewhere");
  }
  guardEditable(cur0);
  // Everything that can be refused is refused before any download. The same
  // checks run again inside the transaction, on the listing as it is then.
  patchedQuantity(cur0, body, clock(deps));
  const newUrls = body.photo_urls != null ? body.photo_urls.map((u) => u.trim()) : null;
  const value0 = patchedValue(cur0, body, newUrls ? newUrls.length : photosOf(cur0).length);

  let degraded = false;
  if ([...TEXT_FIELDS, "specs"].some((k) => body[k] != null)) {
    const scan = await deps.scanText(scanFieldsOf(value0), ctx.uid);
    if (scan && scan.clean === false) {
      throw new ApiError(422, "content_violation", "This text breaks the TeeBox listing rules. Nothing was changed.", {category: scan.category || null});
    }
    degraded = !!(scan && scan.degraded);
  }
  const save = () => savePatch(deps, ctx, id, body, newUrls, minPhotos(value0.ask), degraded);
  return newUrls ? withPhotoSlot(deps, save) : save();
}

async function savePatch(deps, ctx, id, body, newUrls, need, degraded) {
  const {db, FieldValue} = deps;
  let stored = null; let photoErrors = [];
  let prevPhotos = [];
  try {
    if (newUrls) {
      await reservePhotos(deps, ctx, newUrls.length);
      const pre = await prefetchPhotos(deps, newUrls);
      if (pre.photos.length < need) throw photoShortError(need, pre.photos.length, pre.errors);
      photoErrors = [...pre.errors];
      stored = await storePhotos(deps, ctx, id, pre.photos, photoErrors);
      if (stored.length < need) throw photoShortError(need, stored.length, photoErrors);
    }
    await db.runTransaction(async (tx) => {
      const {ref, data: cur} = await loadOwnListing(deps, ctx, id, tx);
      guardEditable(cur); // re-checked inside the transaction: a checkout may have started
      const quantity = patchedQuantity(cur, body, clock(deps));
      prevPhotos = photosOf(cur);
      const value = patchedValue(cur, body, (stored || prevPhotos).length);
      const isHighValue = value.ask >= schema.HIGH_VALUE;
      const update = {
        ...patchedFields(body, value),
        ...(stored ? {photos: stored} : {}),
        ...(quantity != null ? {quantity} : {}),
        requiresAuth: isHighValue, updatedAt: FieldValue.serverTimestamp(),
      };
      if (stored && cur.photoVariants && typeof cur.photoVariants === "object") {
        update.photoVariants = rekeyPhotoVariants(cur.photoVariants, stored);
      }
      const review = authReviewAfterEdit(cur, isHighValue);
      if (review) update.authReviewState = review;
      if (degraded) {
        update.needsReview = true; update.needsReviewReason = "edit_scan_degraded";
        update.needsReviewAt = FieldValue.serverTimestamp();
      }
      // A listing hidden only for missing photos comes back once it has them
      // (and its seller is payment-ready; otherwise it waits for payouts).
      if (stored && cur.status === "hidden" && cur.hiddenReason === "photos_missing") {
        if (ctx.user.stripeChargesEnabled === true) { update.status = "active"; update.hiddenReason = FieldValue.delete(); } else update.hiddenReason = "awaiting_payouts";
      }
      tx.update(ref, update);
    });
  } catch (e) {
    // Nothing was saved, so the files just uploaded belong to nobody. Keep any
    // the listing does reference, in case the save went through after all.
    if (stored && stored.length && deps.deleteRemovedPhotos) {
      try {
        const s = await db.doc(`listings/${id}`).get();
        await deps.deleteRemovedPhotos(stored, s.exists ? photosOf(s.data() || {}) : [], id);
      } catch (e2) { if (deps.logError) deps.logError("sellerApi: upload cleanup failed", e2); }
    }
    throw e;
  }
  if (stored && deps.deleteRemovedPhotos) {
    try { await deps.deleteRemovedPhotos(prevPhotos, stored, id); } catch (_e) { /* best-effort, like updateListing */ }
  }
  const snap = await db.doc(`listings/${id}`).get();
  return {status: 200, listingId: id, body: {listing: serializeListing(id, snap.data() || {}, deps.cfg, await originOf(deps, ctx, id)),
    ...(newUrls ? {photo_errors: photoErrors} : {})}};
}

function guardEditable(l) {
  const s = l.status || "active";
  if (s === "pending") throw new ApiError(409, "checkout_in_progress", "A buyer is checking out this listing right now. Retry in a few minutes.");
  if (LOCKED.includes(s)) throw new ApiError(409, "listing_sold", "This listing has sold and can't be changed.");
  if (s === "removed") throw new ApiError(409, "listing_ended", "This listing has ended and can't be changed.");
  if (s === "expired") throw new ApiError(409, "listing_expired", "This listing has expired. The seller can renew it in TeeBox.");
  // "flagged" (a photo that failed its check), other hidden reasons, and any
  // status this file doesn't know: TeeBox is looking at it.
  if (s !== "active" && !(s === "hidden" && ["awaiting_payouts", "photos_missing"].includes(l.hiddenReason))) {
    throw new ApiError(409, "listing_under_review", "This listing is under review by TeeBox and can't be changed right now.");
  }
}

async function endListing(deps, ctx, id, reason) {
  const {db, FieldValue} = deps;
  let already = false;
  await db.runTransaction(async (tx) => {
    const {ref, data: l} = await loadOwnListing(deps, ctx, id, tx);
    const s = l.status || "active";
    if (s === "removed") { already = true; return; }
    // A hold whose window has lapsed no longer counts, same as deleteListing.
    if (inCheckout(l, clock(deps))) {
      throw new ApiError(409, "checkout_in_progress", "A buyer is checking out this listing right now, so it can't be ended. Retry in a few minutes.");
    }
    if (s !== "pending" && LOCKED.includes(s)) throw new ApiError(409, "listing_sold", "This listing has already sold.");
    tx.update(ref, {status: "removed", removedReason: reason === "sold_elsewhere" ? "seller_sold_elsewhere" : "seller_ended",
      removedAt: FieldValue.serverTimestamp(), removedVia: "api", removedByPartner: ctx.partnerId,
      updatedAt: FieldValue.serverTimestamp()});
  });
  const snap = await db.doc(`listings/${id}`).get();
  return {status: 200, listingId: id, body: {listing: serializeListing(id, snap.data() || {}, deps.cfg, await originOf(deps, ctx, id)),
    already_ended: already}};
}

/** Sandbox only: the same result a real sale leaves on a listing. */
async function sandboxSell(deps, ctx, id, rawBody) {
  if (deps.cfg.mode !== "test") throw new ApiError(404, "not_found", "No such endpoint. See https://teeboxmarket.com/developers.");
  const body = rawBody == null || rawBody === "" ? {} : rawBody;
  checkBody(body, ["quantity"]);
  const qty = body.quantity == null ? 1 : body.quantity;
  if (!Number.isInteger(qty) || qty < 1) throw validationError([{field: "quantity", message: "quantity must be a whole number, 1 or more."}]);
  const {db, FieldValue} = deps;
  await db.runTransaction(async (tx) => {
    const {ref, data: l} = await loadOwnListing(deps, ctx, id, tx);
    if ((l.status || "active") !== "active") throw new ApiError(409, "listing_not_active", "Only an active listing can sell.");
    const total = Math.max(1, Number(l.quantity) || 1);
    const sold = Math.max(0, Number(l.quantitySold) || 0) + qty;
    if (sold > total) throw validationError([{field: "quantity", message: "quantity is more than the units still for sale."}]);
    tx.update(ref, {quantitySold: sold, updatedAt: FieldValue.serverTimestamp(),
      ...(sold === total ? {status: "sold", soldAt: FieldValue.serverTimestamp()} : {})});
  });
  return getListing(deps, ctx, id);
}

// ── Router ─────────────────────────────────────────────────────────────────

// A broken % escape is just an id that doesn't exist.
function decodeId(v) { try { return decodeURIComponent(v); } catch (_e) { return ""; } }

function route(method, path) {
  // The function URL may keep its own name in front of the path.
  const p = String(path || "").split("?")[0].replace(/^\/sellerApi(?=\/)/, "").replace(/\/+$/, "");
  const m = p.match(/^\/v1(\/.*)?$/);
  if (!m) return null;
  const rest = m[1] || "";
  if (rest === "/me" && method === "GET") return {name: "me"};
  if (rest === "/categories" && method === "GET") return {name: "categories"};
  if (rest === "/listings" && method === "GET") return {name: "list"};
  if (rest === "/listings" && method === "POST") return {name: "create"};
  let mm = rest.match(/^\/listings\/([^/]+)$/);
  if (mm && method === "GET") return {name: "get", id: decodeId(mm[1])};
  if (mm && method === "PATCH") return {name: "patch", id: decodeId(mm[1])};
  mm = rest.match(/^\/listings\/([^/]+)\/end$/);
  if (mm && method === "POST") return {name: "end", id: decodeId(mm[1])};
  mm = rest.match(/^\/sandbox\/listings\/([^/]+)\/sell$/);
  if (mm && method === "POST") return {name: "sandbox_sell", id: decodeId(mm[1])};
  if (mm) return {name: "method_not_allowed"};
  const known = ["/me", "/categories", "/listings"].includes(rest) || /^\/listings\/[^/]+(\/end)?$/.test(rest);
  return known ? {name: "method_not_allowed"} : null;
}

function errorBody(e) {
  const extra = e.extra || {};
  const {headers, ...rest} = extra;
  return {error: {code: e.code, message: e.message, ...rest}};
}

/**
 * Handle one request. req: {method, path, query, headers, body, ip}
 * env.forMode("test"|"live") returns that environment's deps, or throws an
 * ApiError when it isn't open. Called only after the keys' shape is checked.
 * @return {Promise<{status: number, body: object, headers: object}>}
 */
const {KeyGuard} = require("./sellerApiGuard");
const guard = new KeyGuard();
const {RefusalStats} = require("./refusalStats");
const refusals = new RefusalStats();
const REFUSED = new Set([401, 403, 413, 415, 429]);

async function handle(env, req) {
  const started = Date.now();
  let deps = null;
  const requestId = "req_" + crypto.randomBytes(9).toString("base64url");
  const headers = {"X-Request-Id": requestId, "Cache-Control": "no-store"};
  const r = route(req.method, req.path);
  let ctx = null; let idem = null; let result;
  try {
    checkRequest(req);
    if (!r) throw new ApiError(404, "not_found", "No such endpoint. See https://teeboxmarket.com/developers.");
    if (r.name === "method_not_allowed") throw new ApiError(405, "method_not_allowed", `${short(req.method, 10)} isn't supported on ${short(req.path, 100)}.`);
    const k = keys.readKeys(req.headers);
    deps = env.forMode(k.mode);
    const pairId = keys.hashKey(k.pk + k.ck);
    const hold = guard.wait(pairId, clock(deps));
    if (hold) {
      throw new ApiError(429, "rate_limited", `Too many requests with keys that don't work. Retry after ${hold}s.`,
          {retry_after: hold, headers: {"Retry-After": String(hold)}});
    }
    try {
      ctx = await keys.authenticate(deps, k);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) guard.refused(pairId, clock(deps));
      throw e;
    }
    guard.ok(pairId, clock(deps));
    Object.assign(headers, await rateLimit(deps, ctx));
    const q = req.query || {};
    switch (r.name) {
      case "me": result = await getMe(deps, ctx); break;
      case "categories": result = {status: 200, body: serializeCategories()}; break;
      case "list": result = await listListings(deps, ctx, q); break;
      case "get": result = await getListing(deps, ctx, r.id); break;
      case "patch": result = await patchListing(deps, ctx, r.id, req.body); break;
      case "sandbox_sell": result = await sandboxSell(deps, ctx, r.id, req.body); break;
      case "end": result = await endListing(deps, ctx, r.id, "ended"); break;
      case "create": {
        idem = await idempotencyBegin(deps, ctx, keys.header(req.headers, "idempotency-key"), req.body);
        if (idem && idem.replay) {
          result = {...idem.replay, replayed: true};
          headers["Idempotent-Replayed"] = "true";
          idem = null;
        } else {
          result = await createListing(deps, ctx, req.body, idem);
          await idempotencyEnd(deps, idem, result.status, result.body);
        }
        break;
      }
    }
  } catch (e) {
    const err = e instanceof ApiError ? e : null;
    if (!err && env.logError) env.logError("sellerApi: unexpected error", e);
    const status = err ? err.status : 500;
    const body = err ? errorBody(err) : {error: {code: "internal", message: "Something went wrong on our side. Retry, and contact TeeBox if it keeps happening."}};
    if (err && err.extra && err.extra.headers) Object.assign(headers, err.extra.headers);
    if (idem && idem.ref) await idempotencyEnd(deps, idem, status, body).catch(() => {});
    result = {status, body};
  }
  if (REFUSED.has(result.status)) {
    const summary = refusals.note({status: result.status, partnerKey: keys.header(req.headers, "x-teebox-partner-key"),
      ip: req.ip, nowMs: Date.now()});
    if (summary && env.logInfo) env.logInfo("sellerApi: refusals", summary);
  }
  post: {
    if (!ctx) break post;
    // A rate-limited request costs as little as we can make it.
    if (result.body && result.body.error && result.body.error.code === "rate_limited") break post;
    const done = Date.now();
    const mutating = req.method !== "GET";
    await audit(deps, {partnerId: ctx.partnerId, connectionId: ctx.connectionId, uid: ctx.uid, requestId,
      method: req.method, route: r ? r.name : null, listingId: result.listingId || (r && r.id) || null,
      status: result.status, code: result.body && result.body.error ? result.body.error.code : null,
      mutating, ms: done - started, ipHash: req.ip ? sha(req.ip).slice(0, 16) : null});
    await touchConnection(deps, ctx);
  }
  headers["Content-Type"] = "application/json; charset=utf-8";
  return {status: result.status, body: {...result.body, request_id: requestId}, headers};
}

module.exports = {
  handle, route, serializeListing, serializeCategories, apiStatus, rekeyPhotoVariants,
  encodeCursor, decodeCursor, authReviewAfterEdit, API_STATUSES, LOCKED, CREATE_FIELDS, PATCH_FIELDS,
};
