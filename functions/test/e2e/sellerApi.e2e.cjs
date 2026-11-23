// End-to-end test of Seller API v1 against the Firestore/Auth/Storage EMULATORS.
// The real exported `sellerApi` function is mounted on a local express server
// and called over HTTP, exactly as a partner would (curl-style JSON requests).
// Photo URLs on img.test are served by a stub fetcher; one real public photo on
// teeboxmarket.com goes through the real SSRF-guarded fetcher. All other
// outbound network is fenced.
// Run: functions/test/e2e/run-api-e2e.sh (needs Java).
const path = require("path");
for (const k of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) if (!process.env[k]) throw new Error(k + " unset — refusing");
process.env.FIREBASE_STORAGE_EMULATOR_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
process.env.STORAGE_EMULATOR_HOST = process.env.STORAGE_EMULATOR_HOST || "http://127.0.0.1:9199";
process.env.GCLOUD_PROJECT = "demo-teebox";
process.env.TEEBOX_API_LIVE_IN_EMULATOR = "1"; // sections A-J run the LIVE path on throwaway data; K is the sandbox
for (const k of ["RESEND_API_KEY", "OPS_ALERT_WEBHOOK", "STRIPE_SECRET_KEY"]) delete process.env[k];

const FN = path.join(__dirname, "..", "..");
const blocked = [];
const https = require("https");
const realReq = https.request;
https.request = function(...a) {
  const o = typeof a[0] === "string" || a[0] instanceof URL ? new URL(a[0]) : (a[0] || {});
  const sni = String(o.servername || o.hostname || o.host || "").split(":")[0];
  if (!/^(teeboxmarket\.com|127\.0\.0\.1|localhost)$/.test(sni)) { blocked.push(sni); throw new Error("harness: blocked " + sni); }
  return realReq.apply(this, a);
};

// Stub image host: https://img.test/<name>.jpg -> a generated JPEG; broken* fails.
const photoFetch = require(path.join(FN, "lib/photoFetch"));
const realFetchPhoto = photoFetch.fetchPhoto;
const sharp = require(path.join(FN, "node_modules/sharp"));
let fetched = [];
photoFetch.fetchPhoto = async (url, opts) => {
  fetched.push(url);
  const u = new URL(url);
  if (u.hostname !== "img.test") return realFetchPhoto(url, opts);
  if (/broken/.test(u.pathname)) throw new Error("the link returned HTTP 404");
  const buffer = await sharp({create: {width: 800, height: 600, channels: 3, background: "#2d6a4f"}}).jpeg().toBuffer();
  return {buffer, contentType: "image/jpeg", ext: "jpg"};
};

const fns = require(path.join(FN, "index.js"));
const admin = require(path.join(FN, "node_modules/firebase-admin"));
const keys = require(path.join(FN, "lib/sellerApiKeys"));
const config = require(path.join(FN, "lib/sellerApiConfig"));
const schema = require(path.join(FN, "lib/listingSchema"));
const express = require(path.join(FN, "node_modules/express"));
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TS = admin.firestore.Timestamp;
const cfg = config.resolve("live");
const {sandboxDb, COLLECTIONS} = require(path.join(FN, "lib/sandboxDb"));

const results = [];
const check = (name, ok, detail) => {
  results.push({name, ok: !!ok});
  console.log((ok ? "PASS " : "FAIL ") + name + (detail !== undefined && !ok ? "  " + JSON.stringify(detail).slice(0, 600) : ""));
};

let BASE;
async function api(method, p, {pk, ck, body, headers} = {}) {
  const h = {"Content-Type": "application/json", ...(headers || {})};
  if (pk) h["X-TeeBox-Partner-Key"] = pk;
  if (ck) h["Authorization"] = "Bearer " + ck;
  const r = await fetch(BASE + p, {method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)});
  let j = null; try { j = await r.json(); } catch (_e) { /* non-JSON */ }
  return {status: r.status, body: j, headers: r.headers};
}

async function mkSeller(label, extra) {
  const email = `qa-api-${label}-${Date.now()}@example.test`;
  const u = await admin.auth().createUser({email, password: "qa-pass-123456", emailVerified: true});
  await db.doc("users/" + u.uid).set({displayName: "QA " + label, ...(extra || {})});
  return u.uid;
}
const CONSENTED = {sellerVerified: true, sellerAge18At: 1, sellerTermsVersion: "2026-11-17"};
const listingsOf = async (uid) => (await db.collection("listings").where("sellerId", "==", uid).get()).docs;
const DRIVER = (over) => ({title: "TaylorMade Qi10 Driver 10.5", brand: "TaylorMade", category: "driver",
  condition: "Very Good", price: 249.99, description: "Light marks on the crown.",
  specs: {model: "Qi10", loft: "10.5", flex: "S", dexterity: "RH"},
  photo_urls: ["https://img.test/a.jpg", "https://img.test/b.jpg"], ...(over || {})});

(async () => {
  const app = express();
  app.use(express.json({limit: "1mb"}));
  app.all("*", (req, res) => fns.sellerApi(req, res));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  const d = {db, FieldValue: FV, cfg};

  // ── Setup: two partners, four sellers ─────────────────────────────────────
  const acme = await keys.createPartner(d, {partnerId: "acme-" + Date.now().toString(36), name: "Acme Lister", contactEmail: "dev@acme.test"});
  const other = await keys.createPartner(d, {partnerId: "other-" + Date.now().toString(36), name: "Other Tool"});
  const s1 = await mkSeller("ready", {...CONSENTED, stripeChargesEnabled: true});
  const s2 = await mkSeller("nopayouts", {...CONSENTED});
  const s3 = await mkSeller("noconsent", {});
  const c1 = await keys.createConnection(d, {uid: s1, partnerId: acme.partnerId});
  const c2 = await keys.createConnection(d, {uid: s2, partnerId: acme.partnerId});
  const c3 = await keys.createConnection(d, {uid: s3, partnerId: acme.partnerId});
  const c1o = await keys.createConnection(d, {uid: s1, partnerId: other.partnerId});
  const A1 = {pk: acme.key, ck: c1.key};
  check("0a keys have the live prefixes", acme.key.startsWith("pk_live_") && c1.key.startsWith("sk_conn_live_") && keys.KEY_RE.test(acme.key));
  const stored = (await db.doc(`apiPartners/${acme.partnerId}`).get()).data();
  check("0b only the key hash is stored", stored.keyHash === keys.hashKey(acme.key) && !JSON.stringify(stored).includes(acme.key));

  // ── A. Auth ───────────────────────────────────────────────────────────────
  let r = await api("GET", "/v1/me");
  check("1a no keys -> 401 missing_partner_key", r.status === 401 && r.body.error.code === "missing_partner_key", r.body);
  r = await api("GET", "/v1/me", {pk: acme.key});
  check("1b no connection key -> 401 missing_connection_key", r.status === 401 && r.body.error.code === "missing_connection_key", r.body);
  r = await api("GET", "/v1/me", {pk: "pk_test_" + acme.key.slice(8), ck: c1.key});
  check("1c mixed test and live keys -> 401 wrong_environment", r.status === 401 && r.body.error.code === "wrong_environment", r.body);
  r = await api("GET", "/v1/me", {pk: acme.key, ck: "sk_conn_live_" + "x".repeat(43)});
  check("1d unknown connection key -> 401", r.status === 401 && r.body.error.code === "invalid_connection_key", r.body);
  r = await api("GET", "/v1/me", {pk: other.key, ck: c1.key});
  check("1e a connection key with ANOTHER partner's key -> 403 mismatch", r.status === 403 && r.body.error.code === "connection_partner_mismatch", r.body);
  r = await api("GET", "/v1/nope", A1);
  check("1f unknown endpoint -> 404 not_found", r.status === 404 && r.body.error.code === "not_found", r.body);
  r = await api("DELETE", "/v1/listings", A1);
  check("1g wrong method -> 405", r.status === 405, r.body);

  // ── B. /me and /categories ────────────────────────────────────────────────
  r = await api("GET", "/v1/me", A1);
  check("2a /me: live, partner, seller can list, payouts ready, limit 25",
      r.status === 200 && r.body.environment === "live" && r.body.partner.id === acme.partnerId &&
      r.body.seller.can_list === true && r.body.seller.payouts_ready === true && r.body.seller.daily_listing_limit === 25 &&
      /^req_/.test(r.body.request_id) && r.headers.get("x-request-id") === r.body.request_id, r.body);
  r = await api("GET", "/v1/me", {pk: acme.key, ck: c3.key});
  check("2b /me: a seller without consent can't list, with the reason", r.body.seller.can_list === false &&
      r.body.seller.cannot_list_reason.code === "seller_consent_required", r.body);
  r = await api("GET", "/v1/categories", A1);
  const driverCat = r.body.categories.find((c) => c.id === "driver");
  check("2c /categories: 15 categories, conditions, rules; driver has required select fields",
      r.status === 200 && r.body.categories.length === 15 && r.body.conditions.length > 3 && r.body.rules.price_min === 5 &&
      driverCat && driverCat.fields.some((f) => f.key === "loft" && f.type === "select" && f.options.length > 3),
      r.body && r.body.categories && r.body.categories.map((c) => c.id));
  const otherCat = r.body.categories.find((c) => c.id === "other");
  check("2d /categories: 'other' needs a browse category", otherCat && otherCat.requires_browse_category === true && otherCat.browse_category === null);

  // ── C. Create ─────────────────────────────────────────────────────────────
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER()});
  const L1 = r.body.listing;
  check("3a create -> 201 active listing with 2 photos in our bucket", r.status === 201 && L1.status === "active" &&
      L1.photos.length === 2 && L1.photos.every((u) => schema.STORAGE_URL_RE.test(u)) && L1.quantity_available === 1 &&
      L1.created_via === "api" && L1.created_by_you === true && L1.category === "driver" && L1.browse_category, r.body);
  const doc1 = (await db.doc("listings/" + L1.id).get()).data();
  // photos + updatedAt are the post-create photo attach (same as the app's); the create itself is checked.
  const asCreated = (x) => { const y = {...x, photos: []}; delete y.updatedAt; return y; };
  check("3b the stored listing is the Sell form's document (passes the rules mirror) + source api",
      doc1.source === "api" && doc1.sellerId === s1 && schema.rulesCreateCheck(asCreated(doc1)).length === 0 &&
      doc1.specs.loft === "10.5°" && doc1.specs.brand === "TaylorMade", {doc1, fail: schema.rulesCreateCheck(asCreated(doc1))});
  const origin = (await db.doc("listingApiOrigin/" + L1.id).get()).data();
  check("3c partner logged on the listing (listingApiOrigin)", origin && origin.partnerId === acme.partnerId && origin.connectionId === c1.connectionId);
  check("3d price is a number and specs drop the duplicate brand", L1.price === 249.99 && !("brand" in L1.specs) && L1.specs.loft === "10.5°");

  // Idempotency
  const idemBody = DRIVER({title: "Ping G430 Driver idem"});
  const i1 = await api("POST", "/v1/listings", {...A1, body: idemBody, headers: {"Idempotency-Key": "k-123"}});
  const i2 = await api("POST", "/v1/listings", {...A1, body: idemBody, headers: {"Idempotency-Key": "k-123"}});
  const n1 = (await listingsOf(s1)).length;
  check("3e same Idempotency-Key + body replays the first response, no second listing",
      i1.status === 201 && i2.status === 201 && i2.body.listing.id === i1.body.listing.id &&
      i2.headers.get("idempotent-replayed") === "true" && n1 === 2, {i1: i1.status, i2: i2.body, n1});
  const i3 = await api("POST", "/v1/listings", {...A1, body: DRIVER({title: "Different"}), headers: {"Idempotency-Key": "k-123"}});
  check("3f same key, different body -> 422 idempotency_key_reused", i3.status === 422 && i3.body.error.code === "idempotency_key_reused", i3.body);

  // Validation
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER({specs: {loft: "10.5", flex: "S", dexterity: "RH"}})});
  check("3g missing required spec -> 422 with field specs.model", r.status === 422 && r.body.error.code === "validation_failed" &&
      r.body.error.errors.some((e) => e.field === "specs.model"), r.body);
  r = await api("POST", "/v1/listings", {...A1, body: {...DRIVER(), colour: "red"}});
  check("3h unknown field -> 400 unknown_field", r.status === 400 && r.body.error.code === "unknown_field", r.body);
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER({price: 3})});
  check("3i price under $5 -> 422 field price", r.status === 422 && r.body.error.errors[0].field === "price", r.body);
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER({price: 450})});
  check("3j $300+ with 2 photos -> 422 field photo_urls", r.status === 422 && r.body.error.errors.some((e) => e.field === "photo_urls"), r.body);
  const before = (await listingsOf(s1)).length;
  const qBefore = (await db.doc(`users/${s1}/rateLimits/bulkListingCreate`).get()).data().count;
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER({price: 450, photo_urls: ["https://img.test/1.jpg", "https://img.test/2.jpg", "https://img.test/3.jpg", "https://img.test/broken.jpg"]})});
  const qAfter = (await db.doc(`users/${s1}/rateLimits/bulkListingCreate`).get()).data().count;
  check("3k $300+ where 1 of 4 photo URLs fails -> 422 photo_fetch_failed, nothing created, quota untouched",
      r.status === 422 && r.body.error.code === "photo_fetch_failed" && r.body.error.photo_errors.length === 1 &&
      (await listingsOf(s1)).length === before && qAfter === qBefore, {body: r.body, qBefore, qAfter});
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER({title: "Shit driver for sale"})});
  check("3l content violation -> 422 content_violation, nothing created", r.status === 422 && r.body.error.code === "content_violation" &&
      (await listingsOf(s1)).length === before, r.body);

  // Seller rules
  r = await api("POST", "/v1/listings", {pk: acme.key, ck: c3.key, body: DRIVER()});
  check("3m seller without consent -> 403 seller_consent_required with TeeBox's message, nothing created",
      r.status === 403 && r.body.error.code === "seller_consent_required" && /tick both boxes yourself/.test(r.body.error.message) &&
      (await listingsOf(s3)).length === 0, r.body);
  r = await api("POST", "/v1/listings", {pk: acme.key, ck: c2.key, body: DRIVER()});
  check("3n seller without payouts -> 201 but status awaiting_payouts (r422 list-first)", r.status === 201 &&
      r.body.listing.status === "awaiting_payouts" && r.body.listing.quantity_available === 0, r.body);
  const L2id = r.body.listing.id;

  // Real wiring for a real public photo (SSRF-guarded fetcher)
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER({title: "Real photo polo", category: "apparel",
    specs: {apparelType: "Polo", size: "L"}, price: 45, photo_urls: ["https://teeboxmarket.com/assets/logos/royal-troon.png"]})});
  check("3o a real public photo URL is fetched through the SSRF guard and stored", r.status === 201 && r.body.listing.photos.length === 1, r.body);
  r = await api("POST", "/v1/listings", {...A1, body: DRIVER({photo_urls: ["http://127.0.0.1/x.jpg"]})});
  check("3p an http:// / private photo URL is refused -> 422 photo_fetch_failed", r.status === 422 && r.body.error.code === "photo_fetch_failed", r.body);

  // ── D. Read ───────────────────────────────────────────────────────────────
  r = await api("GET", "/v1/listings/" + L1.id, A1);
  check("4a GET own listing", r.status === 200 && r.body.listing.id === L1.id && r.body.listing.created_by_you === true, r.body);
  r = await api("GET", "/v1/listings/" + L1.id, {pk: acme.key, ck: c2.key});
  check("4b another seller's listing -> 404 (looks missing)", r.status === 404 && r.body.error.code === "listing_not_found", r.body);
  r = await api("GET", "/v1/listings/" + L1.id, {pk: other.key, ck: c1o.key});
  check("4c same seller via another tool: readable, created_by_you false", r.status === 200 && r.body.listing.created_by_you === false, r.body);
  r = await api("GET", "/v1/listings/does-not-exist", A1);
  check("4d missing id -> 404 with the delist hint", r.status === 404 && /delist it on your side/.test(r.body.error.message), r.body);

  // ── E. Update + quantity sync ─────────────────────────────────────────────
  const t0 = Date.parse(L1.updated_at);
  await new Promise((res) => setTimeout(res, 30));
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {price: 229, description: "Price drop."}});
  const doc1b = (await db.doc("listings/" + L1.id).get()).data();
  check("5a PATCH price + description -> 200, updated_at moves, bid = 90%", r.status === 200 && r.body.listing.price === 229 &&
      r.body.listing.description === "Price drop." && Date.parse(r.body.listing.updated_at) > t0 && doc1b.bid === Math.round(229 * 0.9) &&
      doc1b.specs.model === "Qi10", r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {quantity_available: 3}});
  check("5b quantity_available 3 -> quantity 3, available 3", r.status === 200 && r.body.listing.quantity === 3 && r.body.listing.quantity_available === 3, r.body);
  await db.doc("listings/" + L1.id).update({quantitySold: 1}); // a TeeBox sale
  r = await api("GET", "/v1/listings/" + L1.id, A1);
  check("5c after 1 TeeBox sale: sold 1, available 2", r.body.listing.quantity_sold === 1 && r.body.listing.quantity_available === 2, r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {quantity_available: 1}});
  check("5d quantity_available 1 -> total 2 (1 sold + 1 left)", r.body.listing.quantity === 2 && r.body.listing.quantity_available === 1, r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {quantity: 0}});
  check("5e quantity 0 -> 422", r.status === 422, r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {quantity: 1, quantity_available: 1}});
  check("5f quantity + quantity_available together -> 400", r.status === 400 && r.body.error.code === "conflicting_fields", r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {title: "Shit title"}});
  check("5g PATCH with a content violation -> 422, nothing changed", r.status === 422 &&
      (await db.doc("listings/" + L1.id).get()).data().title === doc1b.title, r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {photo_urls: ["https://img.test/n1.jpg", "https://img.test/n2.jpg", "https://img.test/n3.jpg"]}});
  check("5h PATCH photo_urls replaces the photos", r.status === 200 && r.body.listing.photos.length === 3 &&
      r.body.listing.photos.every((u) => !L1.photos.includes(u)), r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {specs: {flex: "X"}}});
  check("5i PATCH one spec keeps the others", r.status === 200 && r.body.listing.specs.flex === "X" && r.body.listing.specs.model === "Qi10", r.body);

  // Checkout lock
  await db.doc("listings/" + L1.id).update({status: "pending"});
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {price: 200}});
  const e1 = await api("POST", `/v1/listings/${L1.id}/end`, A1);
  check("5j buyer checking out: PATCH and end -> 409 checkout_in_progress, listing reads as reserved",
      r.status === 409 && r.body.error.code === "checkout_in_progress" && e1.status === 409 &&
      (await api("GET", "/v1/listings/" + L1.id, A1)).body.listing.status === "reserved", {r: r.body, e1: e1.body});
  await db.doc("listings/" + L1.id).update({status: "active", quantityReserved: 1});
  r = await api("POST", `/v1/listings/${L1.id}/end`, A1);
  check("5k multi-unit listing with a unit in checkout: end -> 409", r.status === 409, r.body);
  await db.doc("listings/" + L1.id).update({quantityReserved: 0});

  // A rejected authenticity review survives a price drop under $300.
  const rej = db.doc("listings/reviewRejected1");
  await rej.set({title: "Rejected putter", brand: "Ping", cat: "clubs", ask: 400, condition: "Good", desc: "x", status: "active",
    sellerId: s1, createdAt: TS.now(), expiresAt: TS.fromMillis(Date.now() + 9e8), quantity: 1, quantitySold: 0, specCategory: "putter",
    specs: {brand: "Ping", model: "Anser", length: "34\"", headStyle: schema.SPECS.categories.putter.fields.find((f) => f.k === "headStyle").options[0],
      dexterity: schema.SPECS.categories.putter.fields.find((f) => f.k === "dexterity").options[0]},
    photos: Array.from({length: 4}, (_, i) => `https://firebasestorage.googleapis.com/v0/b/demo-teebox.firebasestorage.app/o/listings%2Fa${i}.jpg?alt=media`),
    requiresAuth: true, authReviewState: "rejected"});
  r = await api("PATCH", "/v1/listings/reviewRejected1", {...A1, body: {price: 200}});
  const rejAfter = (await rej.get()).data();
  check("5z a price drop never clears a rejected authenticity review", r.status === 200 && rejAfter.ask === 200 && rejAfter.authReviewState === "rejected", r.body);
  // An approved review survives a price change and reopens on a title change.
  await rej.update({authReviewState: "approved", ask: 400, requiresAuth: true});
  await api("PATCH", "/v1/listings/reviewRejected1", {...A1, body: {price: 350}});
  const stillOk = (await rej.get()).data().authReviewState;
  await api("PATCH", "/v1/listings/reviewRejected1", {...A1, body: {title: "Renamed putter"}});
  const reop = (await rej.get()).data();
  check("5z2 approved review: kept on a price drop, reopened on a title change", stillOk === "approved" && reop.authReviewState === "pending" && /title/.test(reop.authReviewReason || ""), {stillOk, s: reop.authReviewState});
  await rej.delete();

  // ── F. End ────────────────────────────────────────────────────────────────
  r = await api("POST", `/v1/listings/${L1.id}/end`, A1);
  const doc1e = (await db.doc("listings/" + L1.id).get()).data();
  check("6a end -> status ended (stored as removed, logged with the partner)", r.status === 200 && r.body.listing.status === "ended" &&
      r.body.listing.ended_at && doc1e.status === "removed" && doc1e.removedByPartner === acme.partnerId && doc1e.removedVia === "api", r.body);
  r = await api("POST", `/v1/listings/${L1.id}/end`, A1);
  check("6b end again is safe (already_ended true)", r.status === 200 && r.body.already_ended === true, r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...A1, body: {price: 100}});
  check("6c PATCH an ended listing -> 409 listing_ended", r.status === 409 && r.body.error.code === "listing_ended", r.body);
  const L3 = (await api("POST", "/v1/listings", {...A1, body: DRIVER({title: "Cobra driver sold elsewhere"})})).body.listing;
  r = await api("PATCH", "/v1/listings/" + L3.id, {...A1, body: {quantity_available: 0}});
  check("6d quantity_available 0 on its own -> ended (sold elsewhere)", r.status === 200 && r.body.listing.status === "ended" &&
      (await db.doc("listings/" + L3.id).get()).data().removedReason === "seller_sold_elsewhere", r.body);

  // ── G. updated_since ──────────────────────────────────────────────────────
  // An app-made listing has createdAt but no updatedAt (the Sell form doesn't stamp it).
  const appRef = db.collection("listings").doc();
  await appRef.set({sellerId: s1, title: "App listing", brand: "Titleist", cat: "balls", ask: 30, condition: "Good",
    status: "active", createdAt: FV.serverTimestamp(), expiresAt: TS.fromMillis(Date.now() + 864e5), photos: [], quantity: 1, quantitySold: 0});
  const all = [];
  let cursor = null; let pages = 0;
  do {
    r = await api("GET", "/v1/listings?limit=2" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), A1);
    if (r.status !== 200) break;
    all.push(...r.body.data); cursor = r.body.next_cursor; pages++;
  } while (cursor && pages < 30);
  const ids = all.map((x) => x.id);
  const mine = (await listingsOf(s1)).map((x) => x.id);
  check("7a paging with limit=2 returns every listing exactly once, oldest change first",
      r.status === 200 && ids.length === mine.length && new Set(ids).size === ids.length && mine.every((id) => ids.includes(id)) &&
      all.every((x, i) => i === 0 || Date.parse(all[i - 1].updated_at) <= Date.parse(x.updated_at)), {ids, mine, pages, last: r.body});
  check("7b includes the app-made listing that has no updatedAt", ids.includes(appRef.id));
  const mid = Date.parse(all[Math.floor(all.length / 2)].updated_at);
  r = await api("GET", "/v1/listings?updated_since=" + encodeURIComponent(new Date(mid).toISOString()), A1);
  check("7c updated_since returns only listings changed at/after that time", r.status === 200 &&
      r.body.data.length > 0 && r.body.data.length < all.length && r.body.data.every((x) => Date.parse(x.updated_at) >= mid), r.body);
  r = await api("GET", "/v1/listings?status=ended", A1);
  check("7d status=ended filter", r.status === 200 && r.body.data.length === 2 && r.body.data.every((x) => x.status === "ended"), r.body);
  // A sale: the webhook stamps updatedAt (deployed 2026-11-21); simulate it.
  const since = new Date().toISOString();
  await new Promise((res) => setTimeout(res, 30));
  const L4 = (await api("POST", "/v1/listings", {...A1, body: DRIVER({title: "Mizuno ST-Z driver"})})).body.listing;
  await db.doc("listings/" + L4.id).update({status: "sold", quantitySold: 1, soldAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp()});
  r = await api("GET", "/v1/listings?updated_since=" + encodeURIComponent(since), A1);
  const soldRow = r.body.data.find((x) => x.id === L4.id);
  check("7e a sale since the last poll shows up as status sold with sold_at", soldRow && soldRow.status === "sold" && soldRow.sold_at && soldRow.quantity_available === 0, r.body);
  r = await api("GET", "/v1/listings?updated_since=yesterday", A1);
  check("7f bad updated_since -> 400", r.status === 400 && r.body.error.code === "invalid_updated_since", r.body);
  r = await api("GET", "/v1/listings?cursor=garbage", A1);
  check("7g bad cursor -> 400", r.status === 400 && r.body.error.code === "invalid_cursor", r.body);
  r = await api("GET", "/v1/listings", {pk: acme.key, ck: c2.key});
  check("7h a seller only ever sees their own listings", r.status === 200 && r.body.data.length === 1 && r.body.data[0].id === L2id, r.body);

  // ── H. Kill switch, revoke, rotate ────────────────────────────────────────
  await keys.setPartnerStatus(d, {partnerId: acme.partnerId, status: "disabled", reason: "e2e"});
  const k1 = await api("GET", "/v1/me", A1);
  const k2 = await api("GET", "/v1/me", {pk: acme.key, ck: c2.key});
  const k3 = await api("GET", "/v1/me", {pk: other.key, ck: c1o.key});
  check("8a KILL SWITCH: disabling a partner refuses it and all its sellers on the next request; other partners unaffected",
      k1.status === 403 && k1.body.error.code === "partner_disabled" && k2.status === 403 && k3.status === 200, {k1: k1.body, k2: k2.status, k3: k3.status});
  await keys.setPartnerStatus(d, {partnerId: acme.partnerId, status: "active"});
  check("8b re-enabling restores access", (await api("GET", "/v1/me", A1)).status === 200);
  await keys.revokeConnection(d, {uid: s2, connectionId: c2.connectionId});
  r = await api("GET", "/v1/me", {pk: acme.key, ck: c2.key});
  check("8c a seller's revoked connection key -> 401", r.status === 401, r.body);
  let bad = false;
  try { await keys.revokeConnection(d, {uid: s1, connectionId: c3.connectionId}); } catch (_e) { bad = true; }
  check("8d a seller can't revoke someone else's connection", bad);
  const rot = await keys.rotatePartnerKey(d, {partnerId: acme.partnerId});
  const o1 = await api("GET", "/v1/me", A1);
  const o2 = await api("GET", "/v1/me", {pk: rot.key, ck: c1.key});
  check("8e rotating the partner key: old key refused, new key works with existing connections", o1.status === 401 && o2.status === 200, {o1: o1.body});
  const P = {pk: rot.key, ck: c1.key};
  const again = await keys.createConnection(d, {uid: s1, partnerId: acme.partnerId});
  r = await api("GET", "/v1/me", P);
  const r2 = await api("GET", "/v1/me", {pk: rot.key, ck: again.key});
  check("8f connecting the same tool again replaces the old connection key", r.status === 401 && r2.status === 200 && again.replaced === 1, r.body);
  const P2 = {pk: rot.key, ck: again.key};

  // ── I. Limits ─────────────────────────────────────────────────────────────
  await db.doc(`users/${s1}/rateLimits/bulkListingCreate`).set({count: 25, cap: 25, resetAt: TS.fromMillis(Date.now() + 3600e3)});
  r = await api("POST", "/v1/listings", {...P2, body: DRIVER({title: "Over the cap driver"})});
  check("9a daily cap reached -> 429 daily_limit_reached with resets_at", r.status === 429 && r.body.error.code === "daily_limit_reached" && r.body.error.resets_at, r.body);
  const minute = Math.floor(Date.now() / 60000);
  await db.doc(`apiRate/c_${again.connectionId}_${minute}`).set({n: 120});
  await db.doc(`apiRate/c_${again.connectionId}_${minute + 1}`).set({n: 120});
  r = await api("GET", "/v1/me", P2);
  check("9b per-seller rate limit -> 429 rate_limited with Retry-After", r.status === 429 && r.body.error.code === "rate_limited" &&
      Number(r.headers.get("retry-after")) > 0, r.body);
  r = await api("GET", "/v1/me", {pk: other.key, ck: c1o.key});
  check("9c rate limits are per connection (same seller, other tool still fine)", r.status === 200 && Number(r.headers.get("ratelimit-remaining")) >= 0, r.body);

  // ── J. Audit ──────────────────────────────────────────────────────────────
  const au = await db.collection("apiAudit").where("partnerId", "==", acme.partnerId).get();
  const rows = au.docs.map((x) => x.data());
  check("10a every authenticated request is in the audit log with partner, seller, route, status",
      rows.length > 30 && rows.some((x) => x.route === "create" && x.status === 201 && x.listingId && x.uid === s1) &&
      rows.some((x) => x.route === "end" && x.mutating === true) && rows.every((x) => x.expireAt), rows.length);
  check("10b audit never stores keys", !JSON.stringify(rows).includes("sk_conn_") && !JSON.stringify(rows).includes("pk_live_"));
  // ── K. Sandbox (test keys, sandbox_* only) ────────────────────────────────
  const dump = async () => { // every live (non-sandbox) document, to prove nothing moves
    const out = {};
    for (const c of await db.listCollections()) {
      if (c.id.startsWith("sandbox_")) continue;
      for (const x of (await c.get()).docs) out[x.ref.path] = x.updateTime ? x.updateTime.toMillis() : 0;
    }
    return JSON.stringify(Object.entries(out).sort());
  };
  const [filesBefore] = await admin.storage().bucket(cfg.bucket).getFiles();
  const usersBefore = (await admin.auth().listUsers()).users.length;
  const fetchedBefore = fetched.length;
  await new Promise((res) => setTimeout(res, 1500)); // let section A-J background work settle
  const liveBefore = await dump();
  const sdb = sandboxDb(db);
  const sd = {db: sdb, FieldValue: FV, cfg: config.resolve("test")};
  const sp = await keys.createPartner(sd, {partnerId: "sand-tool", name: "Sand Tool"});
  await sdb.doc("users/sbA").set({displayName: "Sandbox Shop", sellerVerified: true, sellerAge18At: 1, stripeChargesEnabled: true});
  await sdb.doc("users/sbB").set({displayName: "Other Shop", sellerVerified: true, sellerAge18At: 1, stripeChargesEnabled: true});
  const sc = await keys.createConnection(sd, {uid: "sbA", partnerId: "sand-tool"});
  const scB = await keys.createConnection(sd, {uid: "sbB", partnerId: "sand-tool"});
  const S = {pk: sp.key, ck: sc.key}; const SB = {pk: sp.key, ck: scB.key};
  check("11a sandbox keys have the test prefixes", sp.key.startsWith("pk_test_") && sc.key.startsWith("sk_conn_test_"));
  r = await api("GET", "/v1/me", S);
  check("11b /me says sandbox", r.status === 200 && r.body.environment === "sandbox" && r.body.seller.can_list === true, r.body);
  const sbSince = new Date(Date.now() - 1000).toISOString();
  r = await api("POST", "/v1/listings", {...S, body: DRIVER({quantity: 2}), headers: {"Idempotency-Key": "sku-1"}});
  const sl = r.body.listing || {};
  check("11c create: active, url null, photo URLs stored as given", r.status === 201 && sl.status === "active" && sl.url === null &&
      sl.photos.join() === "https://img.test/a.jpg,https://img.test/b.jpg", r.body);
  r = await api("POST", "/v1/listings", {...S, body: DRIVER({quantity: 2}), headers: {"Idempotency-Key": "sku-1"}});
  check("11d repeat with the same key replays, no second listing", r.status === 201 && r.body.listing.id === sl.id &&
      (await sdb.collection("listings").where("sellerId", "==", "sbA").get()).size === 1, r.body);
  r = await api("PATCH", "/v1/listings/" + sl.id, {...S, body: {price: 219.5}});
  check("11e update", r.status === 200 && r.body.listing.price === 219.5, r.body);
  r = await api("POST", `/v1/sandbox/listings/${sl.id}/sell`, S);
  check("11f sandbox sell: one of two units", r.status === 200 && r.body.listing.status === "active" && r.body.listing.quantity_sold === 1 && r.body.listing.quantity_available === 1, r.body);
  r = await api("GET", "/v1/listings?updated_since=" + encodeURIComponent(sbSince), S);
  check("11g updated_since shows the sale", r.status === 200 && r.body.data.length === 1 && r.body.data[0].quantity_sold === 1, r.body);
  r = await api("POST", `/v1/sandbox/listings/${sl.id}/sell`, {...S, body: {quantity: 5}});
  check("11h can't sell more than is left", r.status === 422, r.body);
  r = await api("POST", `/v1/sandbox/listings/${sl.id}/sell`, {...SB});
  check("11i another sandbox seller's listing -> 404", r.status === 404 && r.body.error.code === "listing_not_found", r.body);
  r = await api("POST", `/v1/sandbox/listings/${sl.id}/sell`, {...S, body: {quantity: 1}});
  check("11j last unit -> sold with sold_at", r.status === 200 && r.body.listing.status === "sold" && r.body.listing.sold_at, r.body);
  r = await api("GET", "/v1/listings?status=sold&updated_since=" + encodeURIComponent(sbSince), S);
  check("11k polling for sold finds it", r.status === 200 && r.body.data.map((x) => x.id).join() === sl.id, r.body);
  r = await api("POST", `/v1/listings/${sl.id}/end`, S);
  check("11l a sold listing can't be ended", r.status === 409 && r.body.error.code === "listing_sold", r.body);
  r = await api("POST", "/v1/listings", {...S, body: DRIVER({title: "Second sandbox driver"})});
  const sl2 = r.body.listing || {};
  r = await api("POST", `/v1/listings/${sl2.id}/end`, S);
  check("11m end", r.status === 200 && r.body.listing.status === "ended", r.body);
  r = await api("POST", `/v1/sandbox/listings/${sl2.id}/sell`, S);
  check("11n an ended listing can't sell", r.status === 409 && r.body.error.code === "listing_not_active", r.body);
  r = await api("POST", "/v1/listings", {...S, body: DRIVER({photo_urls: ["http://127.0.0.1/x.jpg"]})});
  check("11o a bad photo URL is refused by shape", r.status === 422 && r.body.error.code === "photo_fetch_failed", r.body);
  r = await api("POST", "/v1/listings", {...S, body: DRIVER({description: "sandboxviolation"})});
  check("11p content_violation can be rehearsed", r.status === 422 && r.body.error.code === "content_violation", r.body);
  // Isolation, both ways.
  r = await api("GET", "/v1/listings/" + L1.id, S);
  check("12a a test key can't read a live listing", r.status === 404, r.body);
  r = await api("PATCH", "/v1/listings/" + L1.id, {...S, body: {price: 6}});
  check("12b a test key can't change a live listing", r.status === 404, r.body);
  r = await api("POST", `/v1/sandbox/listings/${L1.id}/sell`, S);
  check("12c a test key can't sell a live listing", r.status === 404, r.body);
  const liveP = {pk: other.key, ck: c1o.key};
  r = await api("GET", "/v1/listings/" + sl.id, liveP);
  check("12d a live key can't read a sandbox listing", r.status === 404, r.body);
  r = await api("POST", `/v1/sandbox/listings/${sl.id}/sell`, liveP);
  check("12e a live key has no sandbox sell", r.status === 404 && r.body.error.code === "not_found", r.body);
  r = await api("GET", "/v1/me", {pk: "pk_test_" + other.key.slice(8), ck: "sk_conn_test_" + c1o.key.slice(13)});
  check("12f a live key with a test prefix is unknown", r.status === 401, r.body);
  r = await api("GET", "/v1/me", {pk: "pk_live_" + sp.key.slice(8), ck: "sk_conn_live_" + sc.key.slice(13)});
  check("12g a test key with a live prefix is unknown", r.status === 401, r.body);
  r = await api("GET", "/v1/me", {pk: sp.key, ck: c1o.key});
  check("12h mixed keys are refused", r.status === 401 && r.body.error.code === "wrong_environment", r.body);
  delete process.env.TEEBOX_API_LIVE_IN_EMULATOR; // production setting
  r = await api("GET", "/v1/me", liveP);
  check("12i with live off, live keys -> 403 live_not_open", r.status === 403 && r.body.error.code === "live_not_open", r.body);
  r = await api("GET", "/v1/me", S);
  check("12j with live off, test keys still work", r.status === 200, r.body);
  process.env.TEEBOX_API_LIVE_IN_EMULATOR = "1";
  const diff = (a, b) => { const A = new Map(JSON.parse(a)); return JSON.parse(b).filter(([k, v]) => A.get(k) !== v).map(([k]) => k); };
  // Only the live-key calls above may leave live traces: their own audit + rate rows.
  const moved = diff(liveBefore, await dump()).filter((k) => !/^(apiAudit|apiRate)\//.test(k) && !/^apiConnections\//.test(k));
  check("13a the sandbox changed no live document", moved.length === 0, moved);
  const sandAudit = (await sdb.collection("apiAudit").get()).size;
  const liveAudit = (await db.collection("apiAudit").where("partnerId", "==", "sand-tool").get()).size;
  check("13b sandbox requests are audited only in the sandbox", sandAudit > 15 && liveAudit === 0, {sandAudit, liveAudit});
  const roots = (await db.listCollections()).map((c) => c.id).filter((c) => c.startsWith("sandbox_"));
  check("13c only the known sandbox collections exist", roots.every((c) => COLLECTIONS.includes(c.slice(8))), roots);
  const [filesAfter] = await admin.storage().bucket(cfg.bucket).getFiles();
  check("13d no files, no accounts, no downloads", filesAfter.length === filesBefore.length &&
      (await admin.auth().listUsers()).users.length === usersBefore && fetched.length === fetchedBefore);
  check("10c no outbound request escaped the fence", blocked.length === 0, blocked);

  server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e && e.stack || e); process.exit(2); });
