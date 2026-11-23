// Seller API hardening (2026-11-23): one test per finding of the security review.
// Everything here runs on an in-memory database and stub fetchers; the M3/H1
// download tests talk to a local http server only.
const {test, before, after} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const {fakeFirestore, Timestamp, FieldValue} = require("./helpers/fakeFirestore");
const FN = path.join(__dirname, "..", "..");
const core = require(path.join(FN, "lib/sellerApiCore"));
const keys = require(path.join(FN, "lib/sellerApiKeys"));
const config = require(path.join(FN, "lib/sellerApiConfig"));
const schema = require(path.join(FN, "lib/listingSchema"));
const lc = require(path.join(FN, "lib/listingCreate"));
const photoFetch = require(path.join(FN, "lib/photoFetch"));
const sharp = require("sharp");

const BUCKET = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/";
const PK = keys.newKey("pk_live_"); const CK = keys.newKey("sk_conn_live_");
const DRIVER = (o) => ({title: "TaylorMade Qi10 Driver", brand: "TaylorMade", category: "driver", condition: "Very Good", price: 249.99,
  description: "Light marks.", specs: {model: "Qi10", loft: "10.5", flex: "S", dexterity: "RH"}, photo_urls: ["https://img.test/a.jpg"], ...o});
const URLS = (n) => Array.from({length: n}, (_, i) => `https://img.test/${i}.jpg`);
const LISTING = (o) => ({sellerId: "s1", title: "TaylorMade Qi10 Driver", brand: "TaylorMade", cat: "clubs", specCategory: "driver", ask: 249.99,
  bid: 225, condition: "Very Good", desc: "Light marks.", status: "active", quantity: 1, quantitySold: 0, requiresAuth: false, authReviewState: "na",
  specs: {model: "Qi10", loft: "10.5°", flex: "S", dexterity: "RH", brand: "TaylorMade"}, photos: [1, 2, 3, 4].map((i) => `${BUCKET}listings%2Fs1%2FL1%2F${i}.jpg?alt=media`),
  createdAt: Timestamp.fromMillis(1e12), updatedAt: Timestamp.fromMillis(1e12), ...o});

/** A whole API on a fake database: call(method, path, body, {headers, query, bodyBytes}) */
function api(over = {}, docs = {}) {
  const f = fakeFirestore({
    ["apiKeys/" + keys.hashKey(PK)]: {kind: "partner", partnerId: "p"},
    ["apiKeys/" + keys.hashKey(CK)]: {kind: "connection", partnerId: "p", connectionId: "c", uid: "s1"},
    "apiPartners/p": {status: "active", keyHash: keys.hashKey(PK), name: "P"},
    "apiConnections/c": {status: "active", keyHash: keys.hashKey(CK), partnerId: "p", uid: "s1"},
    "users/s1": {sellerVerified: true, sellerAge18At: 1, stripeChargesEnabled: true}, ...docs});
  const seen = {fetched: [], stored: [], deleted: [], scanned: []};
  let clock = 1.7e12;
  const deps = {db: f.db, FieldValue, Timestamp, cfg: config.resolve("live", {GCLOUD_PROJECT: "teebox-market"}),
    auth: {getUser: async (uid) => ({uid, emailVerified: true, disabled: false, providerData: []})},
    scanText: async (x) => { seen.scanned.push(x); return {clean: true}; },
    fetchPhoto: async (u) => { seen.fetched.push(u); return {buffer: Buffer.from(u), contentType: "image/jpeg", ext: "jpg"}; },
    storePhoto: async ({uid, listingId, index}) => {
      const u = `${BUCKET}listings%2F${uid}%2F${listingId}%2F${seen.stored.length}_${index}_import.jpg?alt=media`;
      seen.stored.push(u); return u;
    },
    deleteRemovedPhotos: async (b, a) => { seen.deleted.push(...b.filter((u) => !a.includes(u))); },
    logError: () => {}, nowMs: () => clock, ...over};
  const errors = [];
  const env = {logError: (m, e) => errors.push(e), forMode: () => deps};
  const call = (method, p, body, o = {}) => core.handle(env, {method, path: p, query: o.query || {}, body, bodyBytes: o.bodyBytes, ip: "1.2.3.4",
    headers: {"x-teebox-partner-key": PK, "authorization": "Bearer " + CK, "content-type": "application/json", ...(o.headers || {})}});
  return {...f, f, seen, deps, call, errors, listing: (id = "L1") => f.store.get("listings/" + id), tick: (n) => { clock += n; }};
}
const code = (r) => `${r.status} ${r.body.error ? r.body.error.code : "ok"}`;
const within = (ms, p) => Promise.race([p, new Promise((r) => setTimeout(() => r("TOO SLOW"), ms))]);

// ── Local photo host (plain http standing in for https) ────────────────────
let server; let open = 0; let sent = 0; let goodJpeg; let cutJpeg;
const realRequest = https.request;
before(async () => {
  const noise = Buffer.alloc(300 * 200 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
  goodJpeg = await sharp(noise, {raw: {width: 300, height: 200, channels: 3}}).jpeg().toBuffer();
  cutJpeg = goodJpeg.subarray(0, Math.floor(goodJpeg.length * 0.95));
  server = http.createServer((q, s) => {
    const name = q.url.slice(1);
    s.on("error", () => {});
    const drip = (buf, ms) => { const t = setInterval(() => { if (s.destroyed) clearInterval(t); else { sent += buf.length; s.write(buf); } }, ms); };
    if (name === "drip") { s.writeHead(200, {"content-type": "image/jpeg"}); drip(Buffer.from("x"), 50); }
    else if (name === "redir") { s.writeHead(302, {location: "https://photos.test/good"}); drip(Buffer.alloc(1 << 16), 5); }
    else if (name === "page") { s.writeHead(200, {"content-type": "text/html"}); drip(Buffer.alloc(1 << 16), 5); }
    else { s.writeHead(200, {"content-type": "image/jpeg"}); s.end(name === "cut" ? cutJpeg : goodJpeg); }
  });
  server.on("connection", (c) => { open++; c.on("close", () => open--); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  https.request = (o, cb) => http.request({method: o.method, path: o.path, headers: o.headers, timeout: o.timeout, agent: o.agent,
    host: "127.0.0.1", port: server.address().port}, cb);
});
after(() => { https.request = realRequest; server.closeAllConnections(); server.close(); });
const lookup = async () => [{address: "93.184.216.34", family: 4}];
const get = (name, o) => photoFetch.fetchPhoto("https://photos.test/" + name, {lookup, ...o});

// ── H1 ─────────────────────────────────────────────────────────────────────
test("H1 a photo that doesn't decode is refused when it is fetched", async () => {
  assert.ok((await get("good")).buffer.equals(goodJpeg));
  await assert.rejects(get("cut"), /damaged|can't read/); // browsers show it, the scanner can't read it
});
test("H1 a photo with too many pixels is refused before it is decoded", async () => {
  const {checkDecodes} = require(path.join(FN, "lib/imageConvert"));
  const png = await sharp({create: {width: 10000, height: 7000, channels: 3, background: "#fff"}}).png().toBuffer();
  assert.ok(png.length < 1e6); // a small file that would fill memory
  const heic = Buffer.concat([Buffer.from("....ftypheic........"), Buffer.from("ispe\0\0\0\0"), Buffer.alloc(8)]);
  heic.writeUInt32BE(20000, heic.length - 8); heic.writeUInt32BE(20000, heic.length - 4);
  for (const b of [png, heic]) assert.match(await checkDecodes(b), /pixels/);
  assert.match(await checkDecodes(Buffer.from("<html>not a photo</html>")), /damaged/);
});
test("H1 a flagged listing (or one in a status we don't know) can't be edited", async () => {
  for (const status of ["flagged", "something_new"]) {
    const a = api({}, {"listings/L1": LISTING({status})});
    assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {price: 100})), "409 listing_under_review", status);
    assert.equal(a.listing().ask, 249.99);
  }
});

// ── M1, M2 ─────────────────────────────────────────────────────────────────
test("M1 the function survives two of the largest bodies at once", () => {
  const e = require(path.join(FN, "sellerApi")).sellerApi.__endpoint;
  assert.ok(e.availableMemoryMb >= 1500 * e.concurrency, JSON.stringify([e.availableMemoryMb, e.concurrency]));
  assert.ok(e.maxInstances <= 20);
});
test("M1/M2 oversized and non-JSON bodies are refused before anything is read", async () => {
  const a = api();
  const big = Buffer.alloc(300 * 1024, 97);
  assert.equal(code(await a.call("POST", "/v1/listings", big, {bodyBytes: big.length, headers: {"content-type": "application/octet-stream"}})), "413 payload_too_large");
  assert.equal(code(await a.call("POST", "/v1/listings", {}, {headers: {"content-length": "300000"}})), "413 payload_too_large");
  assert.equal(code(await a.call("POST", "/v1/listings", Buffer.from("abc"), {bodyBytes: 3, headers: {"content-type": "application/octet-stream"}})), "415 unsupported_media_type");
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", Buffer.from("abc"))), "415 unsupported_media_type");
  assert.equal(code(await a.call("POST", "/v1/listings", {a: "1"}, {bodyBytes: 3, headers: {"content-type": "application/x-www-form-urlencoded"}})), "415 unsupported_media_type");
  assert.equal(a.writes.length, 0);
  assert.equal(code(await a.call("POST", "/v1/listings", DRIVER(), {bodyBytes: 500, headers: {"content-type": "application/json; charset=utf-8"}})), "201 ok");
  const b = api({}, {"listings/L1": LISTING()});
  assert.equal(code(await b.call("POST", "/v1/listings/L1/end", undefined, {headers: {"content-type": ""}})), "200 ok", "an empty body needs no type");
});
test("M2 nothing long is echoed back", async () => {
  const a = api();
  const long = "x".repeat(100000);
  for (const r of [await a.call("POST", "/v1/listings", DRIVER({category: long})), await a.call("POST", "/v1/listings", {[long]: 1}),
    await a.call("POST", "/v1/listings", Object.fromEntries(Array.from({length: 5000}, (_, i) => ["k" + i, 1]))),
    await a.call("POST", "/v1/listings", DRIVER({specs: {[long]: {}}})),
    await a.call("DELETE", "/v1/listings/" + long), await a.call("GET", "/v1/listings", undefined, {query: {status: long}})]) {
    assert.ok(r.status >= 400);
    assert.ok(JSON.stringify(r.body).length < 2000, JSON.stringify(r.body).slice(0, 200));
  }
});

// ── M3 ─────────────────────────────────────────────────────────────────────
test("M3 the whole download has one deadline, even when bytes keep coming", async () => {
  const r = await within(3000, get("drip", {timeoutMs: 300}).then(() => "ok", (e) => e.message));
  assert.match(r, /too long/);
});
test("M3 a slow name lookup counts towards the deadline", async () => {
  const r = await within(2000, get("good", {timeoutMs: 200, lookup: () => new Promise(() => {})}).then(() => "ok", (e) => e.message));
  assert.match(r, /too long/);
});
test("M3 redirect and refused responses are closed, not drained", async () => {
  await get("redir");
  await assert.rejects(get("page"), /not a JPEG/);
  await new Promise((r) => setTimeout(r, 200));
  const was = sent;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent, was, "the host is still being read");
  assert.equal(open, 0);
});

// ── M4 ─────────────────────────────────────────────────────────────────────
test("M4 a seller over the daily cap causes no downloads", async () => {
  const a = api({}, {"users/s1/rateLimits/bulkListingCreate": {count: 25, cap: 25, resetAt: Timestamp.fromMillis(1.7e12 + 1e6)}});
  assert.equal(code(await a.call("POST", "/v1/listings", DRIVER())), "429 daily_limit_reached");
  assert.equal(a.seen.fetched.length, 0);
});
test("M4 an edit that can't be saved causes no downloads or uploads", async () => {
  const a = api({}, {"listings/L1": LISTING({quantity: 3, quantitySold: 2})});
  for (const bad of [{quantity: 0}, {quantity: 1}, {quantity: "2"}, {quantity_available: 0}, {quantity_available: 99}]) {
    assert.ok((await a.call("PATCH", "/v1/listings/L1", {photo_urls: URLS(5), ...bad})).status >= 400, JSON.stringify(bad));
  }
  assert.deepEqual([a.seen.fetched.length, a.seen.stored.length], [0, 0]);
});
test("M4 uploads are removed when the save is refused at the last moment", async () => {
  const a = api({}, {"listings/L1": LISTING()});
  const store = a.deps.storePhoto;
  a.deps.storePhoto = async (x) => { a.store.set("listings/L1", {...a.listing(), status: "pending"}); return store(x); };
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {photo_urls: URLS(2)})), "409 checkout_in_progress");
  assert.equal(a.seen.stored.length, 2);
  assert.deepEqual(a.seen.deleted, a.seen.stored);
});
test("M4 photo downloads have a daily limit, counted before downloading", async () => {
  const a = api({}, {"listings/L1": LISTING()});
  let last;
  for (let i = 0; i < 60; i++) { last = await a.call("PATCH", "/v1/listings/L1", {photo_urls: URLS(10)}); a.tick(60000); }
  assert.equal(code(last), "429 daily_limit_reached");
  assert.equal(a.seen.fetched.length, 500);
  a.tick(25 * 3600e3);
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {photo_urls: URLS(2)})), "200 ok");
});
test("M4 only a few requests per instance hold photos at once; the rest wait, then get busy", async () => {
  const slot = photoFetch.photoSlots(2, 50);
  let now = 0; let most = 0;
  const job = (ms) => slot(async () => { most = Math.max(most, ++now); await new Promise((r) => setTimeout(r, ms)); now--; });
  await Promise.all([job(20), job(20), job(1), job(1)]);
  assert.equal(most, 2);
  const r = await Promise.allSettled([job(200), job(200), job(1)]);
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "fulfilled", "rejected"]);
  await job(1); // slots are given back
  const a = api({photoSlot: photoFetch.photoSlots(0, 10)});
  const busy = await a.call("POST", "/v1/listings", DRIVER());
  assert.equal(code(busy), "503 busy");
  assert.equal(busy.headers["Retry-After"], "30");
  assert.match(fs.readFileSync(path.join(FN, "sellerApi.js"), "utf8"), /photoSlots\(2, 30000\)/);
});

// ── M6 ─────────────────────────────────────────────────────────────────────
const IDEM = {headers: {"idempotency-key": "sku-1"}};
test("M6 the listing, its partner record and the idempotency record are saved together or not at all", async () => {
  const a = api();
  a.fail(/^listingApiOrigin\//);
  assert.equal((await a.call("POST", "/v1/listings", DRIVER(), IDEM)).status, 500);
  assert.equal(a.f.list("listings").length, 0);
  const r = await a.call("POST", "/v1/listings", DRIVER(), IDEM);
  assert.equal(code(r), "201 ok");
  assert.equal(a.f.list("listings").length, 1);
  assert.equal(a.store.get("users/s1/rateLimits/bulkListingCreate").count, 1);
});
test("M6 a create whose photos fail to attach is taken off sale, and a retry finishes the same listing", async () => {
  const a = api();
  const attach = lc.attachListingPhotos;
  lc.attachListingPhotos = async () => { throw new Error("UNAVAILABLE"); };
  try {
    assert.equal((await a.call("POST", "/v1/listings", DRIVER(), IDEM)).status, 500);
  } finally { lc.attachListingPhotos = attach; }
  const [p] = a.f.list("listings");
  assert.deepEqual([a.store.get(p).status, a.store.get(p).hiddenReason], ["hidden", "photos_missing"]);
  const r = await a.call("POST", "/v1/listings", DRIVER(), IDEM);
  assert.deepEqual([code(r), r.body.listing.status, r.body.listing.photos.length, "listings/" + r.body.listing.id], ["201 ok", "active", 1, p]);
  assert.equal(a.f.list("listings").length, 1);
  assert.equal(a.store.get("users/s1/rateLimits/bulkListingCreate").count, 1);
  const again = await a.call("POST", "/v1/listings", DRIVER(), IDEM);
  assert.equal(again.headers["Idempotent-Replayed"], "true");
});
test("M6 a run that lost its idempotency key to a retry makes no second listing", async () => {
  const a = api();
  let release; const gate = new Promise((r) => { release = r; });
  const fetchPhoto = a.deps.fetchPhoto;
  a.deps.fetchPhoto = async (u) => { await gate; return fetchPhoto(u); };
  const slow = a.call("POST", "/v1/listings", DRIVER(), IDEM);
  await new Promise((r) => setTimeout(r, 30));
  a.deps.fetchPhoto = fetchPhoto;
  a.tick(config.LIMITS.idempotencyLockMs ? config.LIMITS.idempotencyLockMs + 1 : 120001);
  const retry = await a.call("POST", "/v1/listings", DRIVER(), IDEM);
  release();
  assert.equal(code(retry), "201 ok");
  assert.equal(code(await slow), "409 request_in_progress");
  assert.equal(a.f.list("listings").length, 1);
  assert.equal((await a.call("POST", "/v1/listings", DRIVER(), IDEM)).body.listing.id, retry.body.listing.id);
});

// ── M7 ─────────────────────────────────────────────────────────────────────
test("M7 a checkout that ran out of time no longer blocks ending or syncing a listing", async () => {
  const held = (until) => ({"listings/L1": LISTING({quantity: 5, quantityReserved: 2, pendingUntil: Timestamp.fromMillis(1.7e12 + until)})});
  let a = api({}, held(-60000));
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {quantity_available: 1})), "200 ok");
  assert.equal(a.listing().quantity, 1);
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {quantity_available: 0})), "200 ok");
  assert.equal(a.listing().status, "removed");
  a = api({}, held(60000));
  assert.equal(code(await a.call("POST", "/v1/listings/L1/end")), "409 checkout_in_progress", "a live checkout still blocks");
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {quantity: 1})), "422 validation_failed");
  a = api({}, {"listings/L1": LISTING({status: "pending", quantityReserved: 1, pendingUntil: Timestamp.fromMillis(1.7e12 - 60000)})});
  assert.equal(code(await a.call("POST", "/v1/listings/L1/end")), "200 ok");
  a = api({}, {"listings/L1": LISTING({status: "pending", quantityReserved: 1})});
  assert.equal(code(await a.call("POST", "/v1/listings/L1/end")), "409 checkout_in_progress", "no recorded window counts as open");
});

// ── M8 ─────────────────────────────────────────────────────────────────────
test("M8 an edit is checked against the listing as it is when saved, and writes only what was sent", async () => {
  const a = api({}, {"listings/L1": LISTING()});
  a.deps.scanText = async () => { // another edit lands while this one is being scanned
    a.store.set("listings/L1", {...a.listing(), title: "Other title", photos: a.listing().photos.slice(0, 1)});
    return {clean: true};
  };
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {price: 500, description: "x"})), "422 validation_failed");
  assert.equal(a.listing().ask, 249.99);
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {description: "New words."})), "200 ok");
  assert.deepEqual([a.listing().title, a.listing().desc], ["Other title", "New words."]);
});

// ── L1, L2 ─────────────────────────────────────────────────────────────────
test("L1 bad types, names and times are refused with a 4xx", async () => {
  const a = api({}, {"listings/L1": LISTING()});
  for (const o of [{category: "__proto__"}, {category: "constructor"}, {title: JSON.parse("{\"toString\":1}")}, {title: {a: 1}}, {title: ["x"]}, {title: true},
    {brand: 5}, {price: ["20"]}, {price: true}, {quantity: [2]}, {description: {}}, {condition: []}, {specs: {model: {}, loft: "10.5", flex: "S", dexterity: "RH"}},
    {specs: JSON.parse("{\"__proto__\":{\"model\":\"z\",\"loft\":\"10.5\",\"flex\":\"S\",\"dexterity\":\"RH\"}}")}]) {
    assert.equal(code(await a.call("POST", "/v1/listings", DRIVER(o))), "422 validation_failed", JSON.stringify(o));
  }
  assert.equal(schema.validateListingInput({...DRIVER(), category: "constructor", photoCount: 1}).ok, false);
  for (const q of [{updated_since: "+275760-09-13T00:00:00Z"}, {updated_since: "-000100-01-01T00:00:00Z"}]) {
    assert.equal(code(await a.call("GET", "/v1/listings", undefined, {query: q})), "400 invalid_updated_since", JSON.stringify(q));
  }
  for (const c of [{s: 1e300, a: null, b: null}, {s: 0, a: [1.5, "x"], b: null}, {s: 0, a: [1e18, "x"], b: null}, {s: 0, a: [1, "x", 1e6], b: null}]) {
    assert.equal(code(await a.call("GET", "/v1/listings", undefined, {query: {cursor: core.encodeCursor(c)}})), "400 invalid_cursor", JSON.stringify(c));
  }
  assert.deepEqual(a.errors, []);
  assert.equal(code(await a.call("POST", "/v1/listings", DRIVER({price: "249.99", quantity: "2", specs: {model: 10, loft: "10.5", flex: "S", dexterity: "RH"}}))), "201 ok", "numbers and numeric text still work");
});
test("L2 hidden, direction-flipping, broken and invisible text is refused", async () => {
  const a = api();
  for (const o of [{title: "a\u0000b"}, {title: "​‮"}, {title: "​⁠"}, {title: "ㅤ⠀"}, {title: "Dri‮ver"}, {title: "a\ud800b"},
    {brand: "​"}, {brand: "a\u0007"}, {description: "x\u0000"}, {description: "\udc00"}, {specs: {model: "a\u0000", loft: "10.5", flex: "S", dexterity: "RH"}}]) {
    assert.equal(code(await a.call("POST", "/v1/listings", DRIVER(o))), "422 validation_failed", JSON.stringify(o));
  }
  for (const o of [{title: "Étude 3 Wood – 15° “Tour”"}, {title: "ドライバー"}, {description: "Line one\nLine two\t‏"}]) {
    assert.equal(code(await a.call("POST", "/v1/listings", DRIVER(o))), "201 ok", JSON.stringify(o));
  }
});

// ── L3 ─────────────────────────────────────────────────────────────────────
test("L3 a listing taken for review while being created reads as under_review, with its own text", async () => {
  const a = api();
  const store = a.deps.storePhoto;
  a.deps.storePhoto = async (x) => { a.store.delete("listings/" + x.listingId); return store(x); };
  const r = await a.call("POST", "/v1/listings", DRIVER(), IDEM);
  assert.deepEqual([r.status, r.body.listing.status, r.body.listing.title, r.body.listing.quantity_available], [201, "under_review", "TaylorMade Qi10 Driver", 0]);
  assert.equal(a.f.list("listings").length, 0, "never re-created");
});

// ── L6, L7, L8 ─────────────────────────────────────────────────────────────
test("L6 an idempotency key stops working after 24 hours even if the record is still there", async () => {
  const a = api();
  const first = await a.call("POST", "/v1/listings", DRIVER(), IDEM);
  a.tick(23 * 3600e3);
  assert.equal((await a.call("POST", "/v1/listings", DRIVER(), IDEM)).body.listing.id, first.body.listing.id);
  a.tick(2 * 3600e3);
  const later = await a.call("POST", "/v1/listings", DRIVER({price: 99}), IDEM);
  assert.equal(code(later), "201 ok");
  assert.notEqual(later.body.listing.id, first.body.listing.id);
});
test("L7 a rate-limited request writes nothing", async () => {
  const minute = Math.floor(1.7e12 / 60000);
  const a = api({}, {[`apiRate/c_c_${minute}`]: {n: 120}});
  assert.equal(code(await a.call("GET", "/v1/me")), "429 rate_limited");
  assert.deepEqual(a.writes, []);
  const b = api();
  await b.call("GET", "/v1/me");
  assert.equal(b.f.list("apiAudit").length, 1, "other requests are still audited");
});
test("L8 the partner counter is spread over several documents and still exact", async () => {
  const minute = Math.floor(1.7e12 / 60000);
  const a = api();
  for (let i = 0; i < 100; i++) assert.equal((await a.call("GET", "/v1/categories")).status, 200);
  const shards = a.f.list("apiRate").filter((p) => p.startsWith("apiRate/p_"));
  assert.ok(shards.length >= 5, shards.join());
  assert.ok(Math.max(...shards.map((p) => a.store.get(p).n)) < 50);
  const n = config.LIMITS.partnerRateShards;
  const full = Object.fromEntries(Array.from({length: n}, (_, i) => [`apiRate/p_p_${minute}_${i}`, {n: 1200 / n}]));
  assert.equal(code(await api({}, full).call("GET", "/v1/me")), "429 rate_limited");
  full[`apiRate/p_p_${minute}_7`] = {n: 1200 / n - 1};
  const c = api({}, full);
  assert.equal((await c.call("GET", "/v1/me")).status, 200, "the last request of the 1,200 is found wherever it is");
  assert.equal(code(await c.call("GET", "/v1/me")), "429 rate_limited");
});

// ── L10 ────────────────────────────────────────────────────────────────────
test("L10 the same picture counts once, live and in the sandbox", async () => {
  const same = {buffer: Buffer.from("one picture"), contentType: "image/jpeg", ext: "jpg"};
  const a = api({fetchPhoto: async () => same});
  const r = await a.call("POST", "/v1/listings", DRIVER({price: 400, photo_urls: URLS(4)}));
  assert.equal(code(r), "422 photo_fetch_failed");
  assert.match(r.body.error.photo_errors[0].message, /same photo as photo_urls\[0\]/);
  assert.equal(a.f.list("listings").length, 0);
  const {fetchPhoto} = require(path.join(FN, "lib/sellerApiSandbox"));
  const b = api({fetchPhoto, isPhotoUrl: () => true, storePhoto: async ({url}) => url});
  assert.equal(code(await b.call("POST", "/v1/listings", DRIVER({price: 400, photo_urls: Array(4).fill("https://img.test/a.jpg")}))), "422 photo_fetch_failed");
  assert.equal(code(await b.call("POST", "/v1/listings", DRIVER({price: 400, photo_urls: URLS(4)}))), "201 ok");
});

// ── L11 (unit rules are in authReview.test.js) ─────────────────────────────
test("L11 an approved listing edited into something else goes back to review", async () => {
  const putter = Object.fromEntries(schema.SPECS.categories.putter.fields.filter((f) => f.req).map((f) => [f.k, f.options ? f.options[0] : "Anser"]));
  const approved = {"listings/L1": LISTING({ask: 400, requiresAuth: true, authReviewState: "approved"})};
  for (const [body, why] of [[{category: "putter", specs: putter}, /category, specs/], [{specs: {model: "Qi35"}}, /specs/], [{condition: "Fair"}, /condition/]]) {
    const a = api({}, approved);
    assert.equal(code(await a.call("PATCH", "/v1/listings/L1", body)), "200 ok");
    assert.equal(a.listing().authReviewState, "pending", JSON.stringify(body));
    assert.match(a.listing().authReviewReason, why);
  }
  for (const body of [{price: 350}, {description: "Other."}, {quantity: 2}, {specs: {model: "Qi10"}}, {condition: "Very Good"}, {category: "driver"}]) {
    const a = api({}, approved);
    assert.equal(code(await a.call("PATCH", "/v1/listings/L1", body)), "200 ok", JSON.stringify(body));
    assert.equal(a.listing().authReviewState, "approved", JSON.stringify(body));
  }
});

// ── L12 ────────────────────────────────────────────────────────────────────
test("L12 only real public IPv6 addresses pass, however they are spelled", () => {
  for (const ip of ["::a9fe:a9fe", "::169.254.169.254", "0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:a9fe:a9fe", "fec0::1", "2001:0:1::1", "2001:10::1", "100::1",
    "3fff::1", "4000::1", "64:ff9b:1::1", "2001:0db8::1", "fe80::1%en0", "192.88.99.1", "not-an-ip"]) assert.equal(photoFetch.isPublicIp(ip), false, ip);
  for (const ip of ["2607:f8b0:4009:80b::200e", "2a00:1450::1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "0:0:0:0:0:ffff:808:808", "192.88.98.1"]) {
    assert.equal(photoFetch.isPublicIp(ip), true, ip);
  }
});

// ── L13 ────────────────────────────────────────────────────────────────────
test("L13 spec text is scanned on create and edit, everywhere listings are written", async () => {
  const a = api({scanText: async (x) => (Object.values(x).some((v) => /badword/.test(v)) ? {clean: false, category: "x"} : {clean: true})},
      {"listings/L1": LISTING()});
  assert.equal(code(await a.call("POST", "/v1/listings", DRIVER({specs: {model: "badword", loft: "10.5", flex: "S", dexterity: "RH"}}))), "422 content_violation");
  assert.equal(code(await a.call("PATCH", "/v1/listings/L1", {specs: {model: "badword"}})), "422 content_violation");
  const src = fs.readFileSync(path.join(FN, "index.js"), "utf8");
  for (const fn of ["moderateListingOnCreate", "updateListing"]) {
    const body = src.slice(src.indexOf(`exports.${fn} =`)).slice(0, 9000);
    assert.match(body, /specScanFields\(/, fn);
  }
  assert.deepEqual(Object.values(schema.specScanFields({a: "x", b: ["y"], c: 5, d: null, e: {toString: 1}})), ["x", "y", "5"], "nothing hides in a list");
});
test("L13 every option the Sell form offers passes the filter", async () => {
  const {scanFields} = require(path.join(FN, "moderation/contentFilter"));
  const bad = [];
  for (const c of Object.values(schema.SPECS.categories)) {
    for (const f of c.fields) for (const o of f.options || []) if (!(await scanFields({o}, "listing", null, null)).clean) bad.push(o);
  }
  assert.deepEqual(bad, []);
});

// ── L14 ────────────────────────────────────────────────────────────────────
test("L14 paging one at a time finishes when changes share a millisecond", async () => {
  const at = (ns) => new Timestamp(1.6e9, 123000000 + ns);
  const a = api({}, {"listings/A1": LISTING({createdAt: at(0), updatedAt: at(456000)}), "listings/A2": LISTING({createdAt: at(0), updatedAt: at(456001)}),
    "listings/A3": LISTING({createdAt: at(789000), updatedAt: undefined})});
  const seen = []; let cursor; let pages = 0;
  do {
    const r = await a.call("GET", "/v1/listings", undefined, {query: {limit: "1", ...(cursor ? {cursor} : {})}});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    seen.push(...r.body.data.map((x) => x.id)); cursor = r.body.next_cursor; pages++;
  } while (cursor && pages < 30);
  assert.deepEqual(seen, ["A1", "A2", "A3"]);
  assert.ok(pages < 30);
  assert.deepEqual(core.decodeCursor(core.encodeCursor({s: 0, a: [123, "abc"], b: null})).a, [123, "abc"], "old cursors still work");
});

// ── L15 ────────────────────────────────────────────────────────────────────
test("L15 raw errors from storage, sockets or DNS never reach a partner", async () => {
  const secret = "svc@project.iam.gserviceaccount.com 10.1.2.3";
  let n = 0;
  const a = api({storePhoto: async () => { if (n++) throw new Error(secret); return BUCKET + "listings%2Fs1%2FL%2Fa.jpg"; }});
  const r = await a.call("POST", "/v1/listings", DRIVER({photo_urls: URLS(2)}));
  assert.equal(r.status, 201);
  assert.equal(r.body.photo_errors.length, 1);
  assert.ok(!JSON.stringify(r.body).includes("gserviceaccount"));
  const b = api({fetchPhoto: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:443"); }});
  assert.ok(!JSON.stringify((await b.call("POST", "/v1/listings", DRIVER())).body).includes("ECONNREFUSED"));
});

// ── L9, L16: exported functions, run against the in-memory database ─────────
async function withAdmin(f, fn) {
  const admin = require("firebase-admin");
  const was = Object.getOwnPropertyDescriptor(admin, "firestore");
  Object.defineProperty(admin, "firestore", {configurable: true, value: Object.assign(() => f.db, {FieldValue, Timestamp})});
  try { return await fn(); } finally { if (was) Object.defineProperty(admin, "firestore", was); else delete admin.firestore; }
}
test("L9 API and CSV listings don't use up the Sell form's daily limit", async () => {
  const {countListingCreate} = require(path.join(FN, "listFirst"));
  for (const [source, n] of [["api", 0], ["csv", 0], [undefined, 1], ["bingo", 1]]) {
    const f = fakeFirestore({"users/s1": {stripeChargesEnabled: false}, "listings/L1": {status: "active"}});
    const data = {sellerId: "s1", status: "active", ...(source ? {source} : {})};
    await withAdmin(f, () => countListingCreate.run({params: {listingId: "L1"}, data: {data: () => data, ref: f.db.doc("listings/L1")}}));
    assert.equal((f.store.get("users/s1/rateLimits/listingCreate") || {count: 0}).count, n, String(source));
    assert.equal(f.store.get("listings/L1").hiddenReason, "awaiting_payouts", "the payouts-first rule still runs");
  }
});
test("L16 one access request a day, however many arrive together", async () => {
  const {requestApiAccess} = require(path.join(FN, "sellerApi"));
  const f = fakeFirestore();
  const out = await withAdmin(f, () => Promise.all([1, 2, 3].map(() => requestApiAccess.run({auth: {uid: "s1"}, data: {tool: "Vendoo"}}))));
  assert.equal(out.filter((x) => !x.already).length, 1);
});
