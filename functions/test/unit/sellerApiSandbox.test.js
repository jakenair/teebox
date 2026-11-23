// Sandbox isolation: test keys can only ever reach sandbox_* collections, and
// nothing that faces people can ever read them.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {sandboxDb, strictSandboxDb, SandboxIsolationError, COLLECTIONS} = require("../../lib/sandboxDb");
const {sandboxDeps} = require("../../lib/sellerApiSandbox");
const core = require("../../lib/sellerApiCore");
const keys = require("../../lib/sellerApiKeys");

const FN = path.join(__dirname, "..", "..");
const ROOT = path.join(FN, "..");

/** A fake Firestore that records every path touched. */
function fakeDb(data = {}) {
  const touched = [];
  const ref = (p) => ({path: p, id: p.split("/").pop(),
    get: async () => { touched.push(p); return {exists: p in data, data: () => data[p], ref: ref(p)}; },
    set: async () => touched.push(p), update: async () => touched.push(p), delete: async () => touched.push(p)});
  const db = {
    doc: (p) => { touched.push(p); return ref(p); },
    collection: (p) => { touched.push(p); return {add: async () => {}, doc: () => ref(p + "/new"), where: () => ({get: async () => ({docs: []})})}; },
    getAll: async (...r) => r.map((x) => { touched.push(x.path); return {exists: false}; }),
    batch: () => ({set() {}, create() {}, update() {}, delete() {}, commit: async () => {}}),
    runTransaction: async (fn) => fn({get: async (r) => r.get(), getAll: async () => [], set() {}, create() {}, update() {}, delete() {}}),
  };
  return {db, touched, ref};
}
const LIVE_NAMES = ["listings/x", "users/x", "orders/x", "apiKeys/x", "apiPartners/x", "moderationLog/x", "mail/x", "publicProfiles/x",
  "", "/", "sandbox", "sandbox_", "Sandbox_listings/x", "x/sandbox_listings/y", "sandbox_listings../listings/x", "../listings/x"];

test("the strict handle throws on every path that isn't a sandbox_ collection", async () => {
  const {db, touched, ref} = fakeDb();
  const s = strictSandboxDb(db);
  for (const p of LIVE_NAMES) {
    assert.throws(() => s.doc(p), SandboxIsolationError, p);
    assert.throws(() => s.collection(p), SandboxIsolationError, p);
    assert.throws(() => s.getAll(ref("sandbox_listings/ok"), ref(p)), SandboxIsolationError, p);
    for (const m of ["create", "set", "update", "delete"]) assert.throws(() => s.batch()[m](ref(p), {}), SandboxIsolationError, m + p);
    await assert.rejects(s.runTransaction(async (tx) => tx.get(ref(p))), SandboxIsolationError);
    await assert.rejects(s.runTransaction(async (tx) => tx.getAll(ref(p))), SandboxIsolationError);
    for (const m of ["create", "set", "update", "delete"]) await assert.rejects(s.runTransaction(async (tx) => tx[m](ref(p), {})), SandboxIsolationError);
  }
  await assert.rejects(s.runTransaction(async (tx) => tx.get({where() {}})), SandboxIsolationError, "queries can't enter a transaction");
  assert.deepEqual(touched, []);
  s.doc("sandbox_listings/a"); s.collection("sandbox_apiAudit");
  assert.deepEqual(touched, ["sandbox_listings/a", "sandbox_apiAudit"]);
});

test("the mapped handle turns API names into sandbox_ names, and refuses every other", () => {
  const {db, touched} = fakeDb();
  const s = sandboxDb(db);
  for (const c of COLLECTIONS) s.doc(c + "/a");
  assert.deepEqual(touched, COLLECTIONS.map((c) => `sandbox_${c}/a`));
  for (const p of ["orders/x", "moderationLog", "publicProfiles/x", "flaggedListings/x", "payouts/x"]) {
    assert.throws(() => s.doc(p), SandboxIsolationError); assert.throws(() => s.collection(p), SandboxIsolationError);
  }
  // Only these entry points exist: no way to the raw handle, a collection group, or recursive delete.
  assert.deepEqual(Object.keys(s).sort(), ["batch", "collection", "doc", "getAll", "runTransaction"]);
  assert.ok(Object.isFrozen(s));
});

test("every collection the API code names is in the sandbox map", () => {
  for (const f of ["sellerApiCore", "sellerApiKeys", "listingCreate"]) {
    const src = fs.readFileSync(path.join(FN, "lib", f + ".js"), "utf8");
    for (const m of src.matchAll(/\b(?:doc|collection)\(\s*[`"']([A-Za-z_]+)/g)) assert.ok(COLLECTIONS.includes(m[1]), `${f}: ${m[1]}`);
    assert.doesNotMatch(src, /admin\.|require\(["']firebase-admin/, f + " must not build its own handle");
  }
});

test("the sandbox file has no Storage, Auth, email, push, network or payment code", () => {
  for (const f of ["sellerApiSandbox", "sandboxDb"]) {
    const src = fs.readFileSync(path.join(FN, "lib", f + ".js"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.deepEqual([...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]).sort(),
        f === "sandboxDb" ? [] : ["./photoFetch", "./sandboxDb", "./sellerApiConfig"], f);
    assert.doesNotMatch(src, /storage\(|firebase-admin|https?\.|fetch\(|shippo|resend|messaging/i, f);
  }
});

test("live keys are refused before anything is read, and keys can't be mixed", async () => {
  const pkT = keys.newKey("pk_test_"); const ckT = keys.newKey("sk_conn_test_");
  const pkL = keys.newKey("pk_live_"); const ckL = keys.newKey("sk_conn_live_");
  const modes = [];
  const env = {forMode: (m) => { modes.push(m); throw new keys.ApiError(403, "live_not_open", "x"); }};
  const call = (pk, ck) => core.handle(env, {method: "GET", path: "/v1/me", headers: {"x-teebox-partner-key": pk, "authorization": "Bearer " + ck}});
  assert.equal((await call(pkL, ckT)).body.error.code, "wrong_environment");
  assert.equal((await call(pkT, ckL)).body.error.code, "wrong_environment");
  assert.deepEqual(modes, []);
  assert.equal((await call(pkL, ckL)).status, 403);
  assert.deepEqual(modes, ["live"]);
});

test("a whole sandbox request touches only sandbox_* paths", async () => {
  const pk = keys.newKey("pk_test_"); const ck = keys.newKey("sk_conn_test_");
  const {db, touched} = fakeDb({
    ["sandbox_apiKeys/" + keys.hashKey(pk)]: {kind: "partner", partnerId: "p"},
    ["sandbox_apiKeys/" + keys.hashKey(ck)]: {kind: "connection", partnerId: "p", connectionId: "c", uid: "s"},
    "sandbox_apiPartners/p": {status: "active", keyHash: keys.hashKey(pk)},
    "sandbox_apiConnections/c": {status: "active", keyHash: keys.hashKey(ck), partnerId: "p", uid: "s"},
    "sandbox_users/s": {sellerVerified: true, sellerAge18At: 1, stripeChargesEnabled: true},
  });
  const env = {forMode: () => sandboxDeps({firestore: db, FieldValue: {}, Timestamp: {fromMillis: (m) => ({toMillis: () => m})}})};
  const r = await core.handle(env, {method: "GET", path: "/v1/me", headers: {"x-teebox-partner-key": pk, "authorization": "Bearer " + ck}});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.environment, "sandbox");
  assert.ok(touched.length > 6);
  for (const p of touched) assert.match(p, /^sandbox_/);
});

// ── Nothing public can read it ────────────────────────────────────────────
function walk(dir, skip, out = []) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (skip.has(e.name) || e.name.startsWith(".") || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, skip, out); else out.push(p);
  }
  return out;
}

test("no client, feed, sitemap, search or trigger code mentions a sandbox_ collection", () => {
  const ALLOWED = new Set(["functions/lib/sandboxDb.js", "functions/lib/sellerApiSandbox.js", "functions/lib/sellerApiCore.js",
    "functions/lib/sellerApiConfig.js", "functions/scripts/seed-sandbox.cjs", "functions/scripts/api-partner.cjs",
    "scripts/gen-seller-api-docs.mjs", "developers/openapi.json", "firestore.indexes.json"]);
  const names = new RegExp("sandbox_(" + COLLECTIONS.join("|") + ")");
  const skip = new Set(["node_modules", "emails-build", "test", "ios", "android", "dist", "perf", "worktrees", "assets"]);
  const files = walk(ROOT, skip).filter((f) => /\.(m?js|cjs|jsx|html|json|rules)$/.test(f));
  assert.ok(files.length > 100, "scan found the code");
  for (const must of ["index.html", "sw.js", "functions/metaFeed.js", "functions/tiktokCatalog.js", "firestore.rules"]) {
    assert.ok(files.includes(path.join(ROOT, must)), must + " is scanned");
  }
  const hits = files.filter((f) => names.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f)).filter((f) => !ALLOWED.has(f));
  assert.deepEqual(hits, []);
});

test("no trigger or collection-group query can match sandbox data", () => {
  const files = walk(FN, new Set(["node_modules", "emails-build", "test"])).filter((f) => /\.(js|cjs)$/.test(f));
  let triggers = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/document:\s*["'`]([^"'`]+)["'`]|onDocument\w+\(\s*["'`]([^"'`]+)["'`]/g)) {
      triggers++;
      assert.match(m[1] || m[2], /^(?!sandbox_)[A-Za-z]+\//, `${path.basename(f)}: ${m[1] || m[2]}`);
    }
    // the only subcollection the sandbox writes is users/{id}/rateLimits
    assert.doesNotMatch(src, /collectionGroup\(\s*["'`]rateLimits/, f);
  }
  assert.ok(triggers > 10, "found the triggers");
});
