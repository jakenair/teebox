// Seller API v1: pure parts (config, routing, serialisation, cursors, keys).
// The full request flow runs against the emulators in test/e2e/sellerApi.e2e.cjs.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const path = require("node:path");
const config = require("../../lib/sellerApiConfig");
const core = require("../../lib/sellerApiCore");
const keys = require("../../lib/sellerApiKeys");

test("config: the key's mode decides; anything but live is the sandbox", () => {
  const env = {GCLOUD_PROJECT: "teebox-market"};
  const live = config.resolve("live", env);
  assert.deepEqual([live.mode, live.partnerPrefix, live.bucket, live.listingUrlBase],
      ["live", "pk_live_", "teebox-market.firebasestorage.app", "https://teeboxmarket.com/?listing="]);
  for (const m of ["test", undefined, "LIVE", ""]) {
    const sb = config.resolve(m, env);
    assert.deepEqual([sb.mode, sb.live, sb.partnerPrefix, sb.bucket, sb.listingUrlBase], ["test", false, "pk_test_", null, null]);
  }
});

test("config: live keys are off everywhere", () => {
  assert.equal(config.LIVE_API_ENABLED, false);
  for (const p of ["teebox-market", config.SANDBOX_PROJECT, "demo-teebox", ""]) assert.equal(config.liveEnabled({GCLOUD_PROJECT: p}), false);
  // the emulator override needs BOTH the emulator and a demo project
  const o = {TEEBOX_API_LIVE_IN_EMULATOR: "1"};
  assert.equal(config.liveEnabled({...o, GCLOUD_PROJECT: "teebox-market", FIRESTORE_EMULATOR_HOST: "x"}), false);
  assert.equal(config.liveEnabled({...o, GCLOUD_PROJECT: "demo-teebox"}), false);
  assert.equal(config.liveEnabled({...o, GCLOUD_PROJECT: "demo-teebox", FIRESTORE_EMULATOR_HOST: "x"}), true);
});

test("config: the sandbox project id is named in exactly one place", () => {
  const out = execFileSync("grep", ["-rl", "teebox-sandbox", "lib", "sellerApi.js"], {cwd: path.join(__dirname, "..", "..")}).toString().trim().split("\n");
  assert.deepEqual(out, ["lib/sellerApiConfig.js"]);
});

test("listingSchema photo bucket: live accepts only teebox-market", () => {
  const out = execFileSync(process.execPath, ["-e",
    "const s=require('./lib/listingSchema');const t=(u)=>s.STORAGE_URL_RE.test(u);" +
    "console.log(JSON.stringify([t('https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/listings%2Fa'),"+
    "t('https://firebasestorage.googleapis.com/v0/b/teebox-sandbox.firebasestorage.app/o/listings%2Fa'),"+
    "t('https://firebasestorage.googleapis.com/v0/b/teebox-marketXfirebasestorage.app/o/a'),"+
    "t('https://teebox-market.firebasestorage.app/x')]))"],
  {cwd: path.join(__dirname, "..", ".."), env: {...process.env, GCLOUD_PROJECT: "teebox-market"}}).toString();
  assert.deepEqual(JSON.parse(out), [true, false, false, true]);
});

test("routes", () => {
  assert.deepEqual(core.route("GET", "/v1/me"), {name: "me"});
  assert.deepEqual(core.route("GET", "/v1/categories/"), {name: "categories"});
  assert.deepEqual(core.route("GET", "/v1/listings"), {name: "list"});
  assert.deepEqual(core.route("POST", "/v1/listings"), {name: "create"});
  assert.deepEqual(core.route("GET", "/v1/listings/abc123"), {name: "get", id: "abc123"});
  assert.deepEqual(core.route("PATCH", "/v1/listings/abc123"), {name: "patch", id: "abc123"});
  assert.deepEqual(core.route("POST", "/v1/listings/abc123/end"), {name: "end", id: "abc123"});
  assert.deepEqual(core.route("DELETE", "/v1/listings/abc123"), {name: "method_not_allowed"});
  assert.deepEqual(core.route("POST", "/v1/sandbox/listings/abc/sell"), {name: "sandbox_sell", id: "abc"});
  assert.deepEqual(core.route("GET", "/v1/sandbox/listings/abc/sell"), {name: "method_not_allowed"});
  assert.equal(core.route("GET", "/v1/listings/%E0%A4%A").id, "", "a broken escape never throws");
  assert.deepEqual(core.route("GET", "/sellerApi/v1/me"), {name: "me"});
  assert.equal(core.route("GET", "/v2/me"), null);
  assert.equal(core.route("GET", "/v1/orders"), null, "there is no orders endpoint");
});

test("status mapping", () => {
  const m = (status, hiddenReason) => core.apiStatus({status, hiddenReason});
  assert.equal(m("active"), "active");
  assert.equal(m("pending"), "reserved");
  assert.equal(m("sold"), "sold");
  assert.equal(m("expired"), "expired");
  assert.equal(m("removed"), "ended");
  assert.equal(m("hidden", "awaiting_payouts"), "awaiting_payouts");
  assert.equal(m("hidden", "photos_missing"), "needs_photos");
  assert.equal(m("hidden", "flagged"), "under_review");
  assert.equal(m("something_new"), "under_review");
  for (const s of ["active", "pending", "sold", "expired", "removed"]) assert.ok(core.API_STATUSES.includes(m(s)));
});

test("serialise: quantity available only when active; specs drop duplicate brand", () => {
  const cfg = config.resolve("live", {GCLOUD_PROJECT: "teebox-market"});
  const l = {status: "active", quantity: 5, quantitySold: 2, quantityReserved: 1, ask: 120, specs: {brand: "Ping", loft: "9°"},
    createdAt: 1000, updatedAt: 5000, source: "api"};
  const s = core.serializeListing("abc", l, cfg, {partnerId: "x"});
  assert.equal(s.quantity_available, 2);
  assert.equal(s.url, "https://teeboxmarket.com/?listing=abc");
  assert.deepEqual(s.specs, {loft: "9°"});
  assert.equal(s.updated_at, new Date(5000).toISOString());
  assert.equal(s.created_by_you, true);
  assert.equal(core.serializeListing("abc", {...l, status: "pending"}, cfg).quantity_available, 0);
  assert.equal(core.serializeListing("abc", {...l, updatedAt: null}, cfg).updated_at, new Date(1000).toISOString(),
      "never-updated listings report their create time");
  const json = JSON.stringify(s);
  for (const f of ["sellerId", "pendingBuyer", "soldTo", "orderId", "bid"]) assert.ok(!json.includes(f), "no internal field " + f);
});

test("cursor round-trips and rejects junk", () => {
  const c = {s: 0, a: [123, "abc"], b: null};
  assert.deepEqual(core.decodeCursor(core.encodeCursor(c)), c);
  assert.throws(() => core.decodeCursor("junk"), /cursor/);
  assert.throws(() => core.decodeCursor(core.encodeCursor({s: 0, a: [1, "../x"], b: null})), /cursor/);
});

test("keys: format, environment, hashing, randomness", () => {
  const k = keys.newKey("pk_test_");
  assert.ok(keys.KEY_RE.test(k));
  assert.equal(keys.keyMode(k), "test");
  assert.equal(keys.keyMode(keys.newKey("sk_conn_live_")), "live");
  assert.equal(keys.hashKey(k).length, 64);
  assert.notEqual(keys.hashKey(k), k);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(keys.randomToken());
  assert.equal(seen.size, 500);
  assert.ok([...seen].every((t) => /^[0-9A-Za-z]{43}$/.test(t)));
  assert.equal(keys.header({"x-teebox-partner-key": "a"}, "X-TeeBox-Partner-Key"), "a");
});

test("categories endpoint covers every Sell form category with its fields", () => {
  const c = core.serializeCategories();
  const specs = require("../../data/listing-specs.json");
  assert.equal(c.categories.length, Object.keys(specs.categories).length);
  assert.deepEqual(c.conditions, specs.conditions);
  assert.equal(c.rules.high_value_photos_min, 4);
});

test("authenticity review: an edit never clears a rejection", () => {
  const f = core.authReviewAfterEdit;
  for (const hv of [true, false]) {
    for (const requiresAuth of [true, false]) {
      assert.equal(f({authReviewState: "rejected", requiresAuth}, hv), null, `${hv}/${requiresAuth}`);
    }
  }
  assert.equal(f({authReviewState: "na", requiresAuth: false}, true), "pending");
  assert.equal(f({authReviewState: "pending", requiresAuth: true}, false), "na");
  assert.equal(f({authReviewState: "approved", requiresAuth: true}, true), null);
  assert.equal(f({authReviewState: "na", requiresAuth: false}, false), null);
});

test("auth: suspended sellers, and keys made before the sessions were reset", () => {
  const K = require("../../lib/sellerApiKeys");
  const now = 1e12; const t = (n) => ({toMillis: () => n});
  assert.equal(K.isSuspended({suspended: true, suspendedUntil: t(now + 1)}, now), true);
  assert.equal(K.isSuspended({suspended: true}, now), true);
  assert.equal(K.isSuspended({suspended: true, suspendedUntil: t(now - 1)}, now), false);
  assert.equal(K.isSuspended({}, now), false);
  const reset = new Date(now).toUTCString();
  assert.equal(K.predatesSessionReset({createdAt: t(now - 1000)}, {tokensValidAfterTime: reset}), true);
  assert.equal(K.predatesSessionReset({createdAt: t(now + 1000)}, {tokensValidAfterTime: reset}), false);
  assert.equal(K.predatesSessionReset({createdAt: t(now)}, {}), false);
});
