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
const {reviewChanges} = require("./authReview");
const lc = require("./listingCreate");
const {CONFIRM_MESSAGE} = require("./sellerConsent");
const keys = require("./sellerApiKeys");
const {LIMITS} = require("./sellerApiConfig");

const {ApiError} = keys;
const LOCKED = ["sold", "pending", "pending_payment", "paid", "shipped", "delivered_pending_inspection", "complete"];
const ID_RE = /^[A-Za-z0-9]{1,128}$/;
const API_STATUSES = ["active", "reserved", "sold", "expired", "ended", "awaiting_payouts", "needs_photos", "under_review"];

const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : (typeof t === "number" ? t : null));
const iso = (t) => { const m = ms(t); return m == null ? null : new Date(m).toISOString(); };
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

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

function serializeListing(id, l, cfg, origin) {
  const total = Math.max(1, Number(l.quantity) || 1);
  const sold = Math.max(0, Number(l.quantitySold) || 0);
  const reserved = Math.max(0, Number(l.quantityReserved) || 0);
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

function checkBody(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "Send a JSON object with Content-Type: application/json.");
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new ApiError(400, "unknown_field", `Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
        {fields: unknown});
  }
  if (body.specs != null && (typeof body.specs !== "object" || Array.isArray(body.specs))) {
    throw new ApiError(422, "validation_failed", "specs must be an object of field key to value.", {errors: [{field: "specs", message: "specs must be an object"}]});
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

const numStr = (v) => (v == null ? "" : typeof v === "number" ? String(v) : String(v));

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

/** Fetch every URL first (no listing yet). Returns buffers + per-URL errors. */
async function prefetchPhotos(deps, urls) {
  const out = new Array(urls.length).fill(null);
  const errors = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      try {
        out[i] = await deps.fetchPhoto(urls[i]);
      } catch (e) {
        errors.push({index: i, url: urls[i].slice(0, 200), message: String(e && e.message || e)});
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return {photos: out.filter(Boolean), errors: errors.sort((a, b) => a.index - b.index)};
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
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const minute = Math.floor(now / 60000);
  const cRef = db.doc(`apiRate/c_${ctx.connectionId}_${minute}`);
  const pRef = db.doc(`apiRate/p_${ctx.partnerId}_${minute}`);
  const expireAt = Timestamp.fromMillis((minute + 10) * 60000);
  const r = await db.runTransaction(async (tx) => {
    const [c, p] = await Promise.all([tx.get(cRef), tx.get(pRef)]);
    const cn = c.exists ? Number(c.data().n) || 0 : 0;
    const pn = p.exists ? Number(p.data().n) || 0 : 0;
    if (cn >= LIMITS.requestsPerMinute) return {ok: false, scope: "connection", limit: LIMITS.requestsPerMinute, used: cn};
    if (pn >= LIMITS.partnerRequestsPerMinute) return {ok: false, scope: "partner", limit: LIMITS.partnerRequestsPerMinute, used: pn};
    tx.set(cRef, {n: cn + 1, expireAt});
    tx.set(pRef, {n: pn + 1, expireAt});
    return {ok: true, limit: LIMITS.requestsPerMinute, used: cn + 1};
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
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const ref = db.doc(`apiIdempotency/${sha(ctx.connectionId + "\n" + key)}`);
  const bodyHash = sha(JSON.stringify(body || {}));
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists) {
      const d = s.data();
      if (d.bodyHash !== bodyHash) {
        throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
      }
      if (d.state === "done") return {replay: {status: d.status, body: JSON.parse(d.response)}};
      if (now - (ms(d.startedAt) || 0) < 120000) {
        throw new ApiError(409, "request_in_progress", "A request with this Idempotency-Key is still being processed. Retry in a few seconds.");
      }
    }
    tx.set(ref, {state: "processing", bodyHash, startedAt: Timestamp.fromMillis(now),
      expireAt: Timestamp.fromMillis(now + LIMITS.idempotencyHours * 3600000)});
    return {ref, bodyHash};
  });
}

async function idempotencyEnd(deps, idem, status, body) {
  if (!idem || !idem.ref) return;
  if (status >= 500) { await idem.ref.delete().catch(() => {}); return; }
  await idem.ref.set({state: "done", status, response: JSON.stringify(body)}, {merge: true});
}

async function audit(deps, entry) {
  try {
    const {db, Timestamp} = deps;
    const now = deps.nowMs ? deps.nowMs() : Date.now();
    await db.collection("apiAudit").add({...entry, at: Timestamp.fromMillis(now),
      expireAt: Timestamp.fromMillis(now + LIMITS.auditDays * 86400000)});
  } catch (_e) { /* audit is best-effort; never fails a request */ }
}

async function touchConnection(deps, ctx) {
  const now = deps.nowMs ? deps.nowMs() : Date.now();
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
  const snap = tx ? await tx.get(ref) : await ref.get();
  // Someone else's listing looks exactly like a missing one.
  if (!snap.exists || (snap.data() || {}).sellerId !== ctx.uid) {
    throw notFound();
  }
  return {ref, data: snap.data() || {}};
}

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
  const now = deps.nowMs ? deps.nowMs() : Date.now();
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

async function createListing(deps, ctx, body) {
  checkBody(body, CREATE_FIELDS);
  const urls = (body.photo_urls || []).map((u) => u.trim());
  const v = schema.validateListingInput(toSchemaInput(body, urls.length));
  if (!v.ok) throw validationError(v.errors);

  let seller;
  try { seller = await lc.assertSellerCanList({db: deps.db, auth: deps.auth, uid: ctx.uid}); } catch (e) { throw sellerError(e); }

  const scan = await deps.scanText({title: v.value.title, brand: v.value.brand, desc: v.value.desc,
    cat: v.value.cat, condition: v.value.condition}, ctx.uid);
  if (scan && scan.clean === false) {
    throw new ApiError(422, "content_violation", "This listing's text breaks the TeeBox listing rules. Nothing was created.",
        {category: scan.category || null});
  }

  const pre = await prefetchPhotos(deps, urls);
  const need = minPhotos(v.value.ask);
  if (pre.photos.length < need) throw photoShortError(need, pre.photos.length, pre.errors);

  const {db, FieldValue, Timestamp} = deps;
  const q = await lc.reserveBulkQuota({db, Timestamp, uid: ctx.uid, want: 1, cap: seller.cap,
    nowMs: deps.nowMs ? deps.nowMs() : undefined});
  if (q.granted < 1) {
    throw new ApiError(429, "daily_limit_reached",
        `This seller has reached their daily limit of ${seller.cap} new listings (shared with CSV upload). ` +
        `Try again after ${new Date(q.resetAt).toISOString()}.`, {daily_limit: seller.cap, resets_at: new Date(q.resetAt).toISOString()});
  }

  let listingId;
  try {
    listingId = await lc.createListingDoc({db, FieldValue, Timestamp, uid: ctx.uid, value: v.value, source: "api",
      paymentReady: seller.paymentReady, nowMs: deps.nowMs ? deps.nowMs() : undefined});
  } catch (e) {
    await lc.releaseBulkQuota({db, uid: ctx.uid, n: 1});
    throw sellerError(e);
  }
  // Which partner created this listing (founder ruling 2026-11-20). Its own
  // document, so the listing itself stays field-for-field the Sell form's.
  await db.doc(`listingApiOrigin/${listingId}`).set({partnerId: ctx.partnerId, connectionId: ctx.connectionId,
    uid: ctx.uid, createdAt: FieldValue.serverTimestamp()});

  const stored = [];
  const photoErrors = [...pre.errors];
  for (let i = 0; i < pre.photos.length; i++) {
    try {
      stored.push(await deps.storePhoto({uid: ctx.uid, listingId, index: i, ...pre.photos[i]}));
    } catch (e) {
      photoErrors.push({index: i, url: null, message: "upload failed: " + String(e && e.message || e)});
    }
  }
  await lc.attachListingPhotos({db, FieldValue, uid: ctx.uid, listingId, urls: stored, isPhotoUrl: deps.isPhotoUrl});
  const snap = await db.doc(`listings/${listingId}`).get();
  return {status: 201, listingId, body: {listing: serializeListing(listingId, snap.data() || {}, deps.cfg, {partnerId: ctx.partnerId}),
    photo_errors: photoErrors}};
}

async function getListing(deps, ctx, id) {
  const {data} = await loadOwnListing(deps, ctx, id);
  return {status: 200, listingId: id, body: {listing: serializeListing(id, data, deps.cfg, await originOf(deps, ctx, id))}};
}

function decodeCursor(c) {
  try {
    const j = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
    const ok = (p) => p === null || (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "string" && ID_RE.test(p[1]));
    if (j && typeof j.s === "number" && ok(j.a) && ok(j.b)) return j;
  } catch (_e) { /* fall through */ }
  throw new ApiError(400, "invalid_cursor", "That cursor isn't valid. Start again without a cursor.");
}
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
    if (bad.length) throw new ApiError(400, "invalid_status", `Unknown status: ${bad.join(", ")}. Use: ${API_STATUSES.join(", ")}.`);
  }
  let cur;
  if (query.cursor) {
    cur = decodeCursor(query.cursor);
  } else {
    const raw = query.updated_since != null ? query.updated_since : query.updatedSince;
    let since = 0;
    if (raw != null && raw !== "") {
      since = Date.parse(String(raw));
      if (!Number.isFinite(since)) throw new ApiError(400, "invalid_updated_since", "updated_since must be an ISO 8601 time, e.g. 2026-12-01T00:00:00Z.");
    }
    cur = {s: since, a: null, b: null};
  }

  const page = limit + 1;
  const base = () => db.collection("listings").where("sellerId", "==", ctx.uid);
  let qa = base().where("updatedAt", ">=", Timestamp.fromMillis(cur.s)).orderBy("updatedAt").orderBy("__name__");
  if (cur.a) qa = qa.startAfter(Timestamp.fromMillis(cur.a[0]), cur.a[1]);
  let qb = base().where("createdAt", ">=", Timestamp.fromMillis(cur.s)).orderBy("createdAt").orderBy("__name__");
  if (cur.b) qb = qb.startAfter(Timestamp.fromMillis(cur.b[0]), cur.b[1]);
  const [sa, sb] = await Promise.all([qa.limit(page).get(), qb.limit(page).get()]);

  const A = sa.docs.map((d) => ({id: d.id, l: d.data(), k: ms(d.data().updatedAt)}));
  const B = sb.docs.map((d) => ({id: d.id, l: d.data(), k: ms(d.data().createdAt), skip: ms(d.data().updatedAt) != null}));
  const aMore = A.length === page; const bMore = B.length === page;
  if (aMore) A.pop();
  if (bMore) B.pop();

  const out = [];
  let ia = 0; let ib = 0;
  let posA = cur.a; let posB = cur.b;
  const before = (x, y) => x.k < y.k || (x.k === y.k && x.id < y.id);
  while (out.length < limit) {
    const ha = ia < A.length ? A[ia] : null;
    const hb = ib < B.length ? B[ib] : null;
    // A stream that still has unread rows beyond its buffer can't be passed.
    if (!ha && aMore) break;
    if (!hb && bMore) break;
    if (!ha && !hb) break;
    if (ha && (!hb || before(ha, hb))) {
      ia++; posA = [ha.k, ha.id];
      out.push(ha);
    } else {
      ib++; posB = [hb.k, hb.id];
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
 * @param {string[]} [changed] reviewChanges(): what an approval no longer covers
 * @return {string|null} the new authReviewState, or null to leave it alone
 */
function authReviewAfterEdit(cur, isHighValue, changed) {
  if (cur.authReviewState === "rejected") return null;
  if (isHighValue && changed && changed.length) return "pending";
  if (isHighValue && !cur.requiresAuth) return "pending";
  if (!isHighValue && cur.requiresAuth) return "na";
  return null;
}

async function patchListing(deps, ctx, id, body) {
  checkBody(body, PATCH_FIELDS);
  if (!Object.keys(body).length) throw new ApiError(400, "empty_update", "Send at least one field to change.");
  if (body.quantity != null && body.quantity_available != null) {
    throw new ApiError(400, "conflicting_fields", "Send quantity or quantity_available, not both.");
  }
  const {db, FieldValue} = deps;
  const first = await loadOwnListing(deps, ctx, id);
  const cur0 = first.data;
  guardEditable(cur0);

  // Sold out elsewhere: quantity_available 0 ends the listing.
  if (body.quantity_available === 0 && Object.keys(body).length === 1) {
    return endListing(deps, ctx, id, "sold_elsewhere");
  }

  const curSpecs = {...(cur0.specs || {})}; delete curSpecs.brand;
  const merged = {
    title: body.title != null ? body.title : cur0.title,
    brand: body.brand != null ? body.brand : cur0.brand,
    category: body.category != null ? body.category : cur0.specCategory,
    browse_category: body.browse_category != null ? body.browse_category : cur0.cat,
    condition: body.condition != null ? body.condition : cur0.condition,
    price: body.price != null ? body.price : cur0.ask,
    description: body.description != null ? body.description : (cur0.desc || ""),
    // Changing category starts its specs fresh; otherwise given keys overlay current ones.
    specs: body.category != null && body.category !== cur0.specCategory ? (body.specs || {}) : {...curSpecs, ...(body.specs || {})},
  };
  const newUrls = body.photo_urls != null ? body.photo_urls.map((u) => u.trim()) : null;
  const photoCount = newUrls ? newUrls.length : (Array.isArray(cur0.photos) ? cur0.photos.length : 0);
  const v = schema.validateListingInput(toSchemaInput({...merged, quantity: 1}, photoCount));
  if (!v.ok) throw validationError(v.errors);

  const textChanged = ["title", "brand", "description", "condition", "category", "browse_category"].some((k) => body[k] != null);
  let degraded = false;
  if (textChanged) {
    const scan = await deps.scanText({title: v.value.title, brand: v.value.brand, desc: v.value.desc,
      cat: v.value.cat, condition: v.value.condition}, ctx.uid);
    if (scan && scan.clean === false) {
      throw new ApiError(422, "content_violation", "This text breaks the TeeBox listing rules. Nothing was changed.", {category: scan.category || null});
    }
    degraded = !!(scan && scan.degraded);
  }

  let stored = null; let photoErrors = [];
  if (newUrls) {
    const pre = await prefetchPhotos(deps, newUrls);
    const need = minPhotos(v.value.ask);
    if (pre.photos.length < need) throw photoShortError(need, pre.photos.length, pre.errors);
    photoErrors = pre.errors;
    stored = [];
    for (let i = 0; i < pre.photos.length; i++) {
      try { stored.push(await deps.storePhoto({uid: ctx.uid, listingId: id, index: i, ...pre.photos[i]})); } catch (e) {
        photoErrors.push({index: i, url: null, message: "upload failed: " + String(e && e.message || e)});
      }
    }
    if (stored.length < need) throw photoShortError(need, stored.length, photoErrors);
  } else if (photoCount < minPhotos(v.value.ask)) {
    throw validationError([{field: "photos", message: `Listings at $${schema.HIGH_VALUE} or more need at least ${schema.MIN_PHOTOS_HIGH_VALUE} photos. Send photo_urls with the new price.`}]);
  }

  let prevPhotos = [];
  let reopened = [];
  let reopenedListing = null;
  await db.runTransaction(async (tx) => {
    const {ref, data: cur} = await loadOwnListing(deps, ctx, id, tx);
    guardEditable(cur); // re-checked inside the transaction: a checkout may have started
    const sold = Math.max(0, Number(cur.quantitySold) || 0);
    const reserved = Math.max(0, Number(cur.quantityReserved) || 0);
    let quantity = Math.max(1, Number(cur.quantity) || 1);
    if (body.quantity_available != null) {
      const a = body.quantity_available;
      if (!Number.isInteger(a) || a < 0) throw validationError([{field: "quantity_available", message: "quantity_available must be a whole number, 0 or more."}]);
      if (a === 0) {
        throw new ApiError(400, "use_end", "To mark a listing sold out, send quantity_available: 0 on its own, or POST /v1/listings/{id}/end.");
      }
      quantity = sold + reserved + a;
    } else if (body.quantity != null) {
      quantity = body.quantity;
      if (!Number.isInteger(quantity) || quantity < 1) throw validationError([{field: "quantity", message: "quantity must be a whole number from 1 to 99."}]);
      if (quantity < sold + reserved) {
        throw validationError([{field: "quantity", message: `quantity can't be below the ${sold + reserved} already sold or in checkout.`}]);
      }
    }
    if (quantity > 99) throw validationError([{field: body.quantity_available != null ? "quantity_available" : "quantity", message: "Total quantity can't be more than 99."}]);

    const photos = stored || (Array.isArray(cur.photos) ? cur.photos : []);
    prevPhotos = Array.isArray(cur.photos) ? cur.photos : [];
    const isHighValue = v.value.ask >= schema.HIGH_VALUE;
    const update = {
      title: v.value.title, brand: v.value.brand, cat: v.value.cat, ask: v.value.ask,
      bid: Math.round(v.value.ask * 0.9), condition: v.value.condition, desc: v.value.desc,
      specCategory: v.value.specCategory, specs: v.value.specs, photos, quantity,
      requiresAuth: isHighValue, updatedAt: FieldValue.serverTimestamp(),
    };
    if (stored && cur.photoVariants && typeof cur.photoVariants === "object") {
      update.photoVariants = rekeyPhotoVariants(cur.photoVariants, photos);
    }
    reopened = isHighValue ? reviewChanges(cur, update) : [];
    const review = authReviewAfterEdit(cur, isHighValue, reopened);
    if (review) update.authReviewState = review;
    if (reopened.length) {
      update.authReviewReason = "Changed after approval: " + reopened.join(", ");
      update.authReviewReopenedAt = FieldValue.serverTimestamp();
      reopenedListing = {id, sellerId: cur.sellerId, title: update.title, status: cur.status, decisionN: Number(cur.authReviewDecisionN) || 0};
    }
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
  if (reopenedListing && deps.notifyReviewReopened) { // live only; the sandbox sends nothing
    try { await deps.notifyReviewReopened(reopenedListing, reopened.join(", ")); } catch (e) { deps.logError("review email failed", e); }
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
  if (s === "hidden" && !["awaiting_payouts", "photos_missing"].includes(l.hiddenReason)) {
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
    if (s === "pending" || (Number(l.quantityReserved) || 0) > 0) {
      throw new ApiError(409, "checkout_in_progress", "A buyer is checking out this listing right now, so it can't be ended. Retry in a few minutes.");
    }
    if (LOCKED.includes(s)) throw new ApiError(409, "listing_sold", "This listing has already sold.");
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
async function handle(env, req) {
  const started = Date.now();
  let deps = null;
  const requestId = "req_" + crypto.randomBytes(9).toString("base64url");
  const headers = {"X-Request-Id": requestId, "Cache-Control": "no-store"};
  const r = route(req.method, req.path);
  let ctx = null; let idem = null; let result;
  try {
    if (!r) throw new ApiError(404, "not_found", "No such endpoint. See https://teeboxmarket.com/developers.");
    if (r.name === "method_not_allowed") throw new ApiError(405, "method_not_allowed", `${req.method} isn't supported on ${req.path}.`);
    const k = keys.readKeys(req.headers);
    deps = env.forMode(k.mode);
    ctx = await keys.authenticate(deps, k);
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
          result = await createListing(deps, ctx, req.body);
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
  post: {
    if (!ctx) break post;
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
