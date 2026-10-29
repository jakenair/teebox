// functions/test/unit/sendMessageHolds.test.js
//
// End-to-end tests of the REAL sendMessage callable and moderateMessage
// trigger (index.js) against an in-memory Firestore double and a stubbed
// Admin Auth. No emulator, no network.
//
// The double deliberately mimics the two Firestore semantics that bit us on
// 2026-09-18: update() treats a dotted key as a FIELD PATH, set() treats it
// as a LITERAL field name. So if anyone reintroduces set() with dotted keys
// for the Rule 6 accumulators, the "3rd seller is held" test fails.
//
// Covers the 2026-10-29 hardening:
//   1. account age from Auth (cached to users.createdAt), fail closed
//   2. link holds (new account / no completed tx; own domain + App Store ok)
//   3. scam phrases + high-risk TLDs + 524178039.cfd blocklist
//   4. new-account seller-burst cap (3rd new seller in an hour held + flagged)

const {test, beforeEach} = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

// ── In-memory Firestore double ──────────────────────────────────────
const RealTimestamp = admin.firestore.Timestamp;
const SENTINEL = Symbol("fv");
const FieldValue = {
  serverTimestamp: () => ({[SENTINEL]: "ts"}),
  increment: (n) => ({[SENTINEL]: "inc", n}),
  delete: () => ({[SENTINEL]: "del"}),
  arrayUnion: (...v) => ({[SENTINEL]: "union", v}),
};

let store; // path -> data
let autoId = 0;
let authUsers; // uid -> {creationTime} | Error

function resolveValue(cur, v) {
  if (v && typeof v === "object" && v[SENTINEL]) {
    const op = v[SENTINEL];
    if (op === "ts") return RealTimestamp.now();
    if (op === "inc") return (Number(cur) || 0) + v.n;
    if (op === "union") return [...new Set([...(cur || []), ...v.v])];
    return undefined;
  }
  return v;
}
function isPlainMap(v) {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof RealTimestamp) &&
    !v[SENTINEL] && Object.getPrototypeOf(v) === Object.prototype;
}
function mergeInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && v[SENTINEL] === "del") { delete target[k]; continue; }
    if (isPlainMap(v)) {
      target[k] = isPlainMap(target[k]) ? target[k] : {};
      mergeInto(target[k], v);
    } else {
      target[k] = resolveValue(target[k], v);
    }
  }
}
function setPath(target, dotted, v) {
  const parts = dotted.split(".");
  let o = target;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainMap(o[p])) o[p] = {};
    o = o[p];
  }
  const last = parts[parts.length - 1];
  if (v && v[SENTINEL] === "del") delete o[last];
  else o[last] = isPlainMap(v) ? JSON.parse(JSON.stringify(v)) : resolveValue(o[last], v);
}

function docRef(path) {
  const id = path.split("/").pop();
  return {
    id, path,
    async get() {
      const d = store.get(path);
      return {id, exists: d !== undefined, data: () => (d === undefined ? undefined : structuredCloneTs(d)),
        get: (f) => (d ? d[f] : undefined)};
    },
    async set(data, opts) {
      const cur = (opts && opts.merge && store.get(path)) ? store.get(path) : {};
      // set(): dotted keys are LITERAL field names (real Firestore behaviour).
      mergeInto(cur, data);
      store.set(path, cur);
    },
    async update(patch) {
      const cur = store.get(path);
      if (cur === undefined) { const e = new Error("NOT_FOUND"); e.code = 5; throw e; }
      // update(): dotted keys are FIELD PATHS.
      for (const [k, v] of Object.entries(patch)) setPath(cur, k, v);
    },
    async delete() { store.delete(path); },
    collection: (name) => collRef(`${path}/${name}`),
  };
}
function structuredCloneTs(d) { return d; } // timestamps must stay Timestamps
function collRef(path, filters = [], lim = Infinity) {
  const q = {
    doc: (id) => docRef(`${path}/${id || "auto" + (++autoId)}`),
    async add(data) { const r = q.doc(); await r.set(data); return r; },
    where: (f, op, v) => collRef(path, [...filters, [f, op, v]], lim),
    limit: (n) => collRef(path, filters, n),
    orderBy: () => q,
    async get() {
      const docs = [];
      for (const [p, d] of store) {
        const rest = p.slice(path.length + 1);
        if (!p.startsWith(path + "/") || rest.includes("/")) continue;
        if (!filters.every(([f, op, v]) => (op === "==" ? d[f] === v : true))) continue;
        docs.push({id: rest, data: () => d});
        if (docs.length >= lim) break;
      }
      return {docs, empty: !docs.length, size: docs.length};
    },
  };
  return q;
}
const fakeDb = {
  collection: (name) => collRef(name),
  doc: (p) => docRef(p),
  batch: () => { const ops = []; return {set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const op of ops) await op(); }}; },
};
const fakeFirestore = () => fakeDb;
fakeFirestore.FieldValue = FieldValue;
fakeFirestore.Timestamp = RealTimestamp;
Object.defineProperty(admin, "firestore", {value: fakeFirestore, configurable: true, writable: true});
Object.defineProperty(admin, "auth", {
  configurable: true, writable: true,
  value: () => ({
    async getUser(uid) {
      const u = authUsers[uid];
      if (u instanceof Error) throw u;
      if (!u) { const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; }
      return {uid, emailVerified: true, metadata: {creationTime: u.creationTime}};
    },
  }),
});

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-teebox";
const fns = require("../../index.js");

// ── Fixtures ────────────────────────────────────────────────────────
const NOW = Date.now();
const H = 3600 * 1000;
const ago = (ms) => new Date(NOW - ms).toUTCString();

function seed(path, data) { store.set(path, data); }
function seedConv(cid, {buyer, seller, delivered = false}) {
  seed(`listings/L_${cid}`, {sellerId: seller, status: "active"});
  seed(`conversations/${cid}`, {participants: [buyer, seller], buyerId: buyer, sellerId: seller,
    listingId: `L_${cid}`, createdAt: RealTimestamp.now(),
    ...(delivered ? {lastMessageSenderId: seller, lastMessageText: "hi"} : {})});
  seed(`users/${seller}`, {displayName: "Seller"});
}
function messagesIn(cid) {
  return [...store.keys()].filter((p) => p.startsWith(`conversations/${cid}/messages/`));
}
function holds() {
  return [...store.entries()].filter(([p]) => p.startsWith("messageHolds/")).map(([, d]) => d);
}
async function send(uid, cid, recipientId, text) {
  return fns.sendMessage.run({auth: {uid, token: {email_verified: true}},
    data: {conversationId: cid, recipientId, text}, rawRequest: {headers: {}, ip: "127.0.0.1"}});
}

beforeEach(() => {
  store = new Map();
  authUsers = {};
});

const SCAM = "Hello! I have just paid for an item. However, an error occurred and the payment did not go through, although the money was withdrawn. I contacted support, and they apologized and confirmed that this is a normal situation, and replied that the payment needs to be confirmed via the link. Please confirm the payment. Sorry for the inconvenience. Thank you very much! ❤️";

// ── 1. createdAt / account age ──────────────────────────────────────
test("age comes from Auth and is cached onto users.createdAt when missing", async () => {
  authUsers.buyer = {creationTime: ago(30 * 24 * H)};
  seed("users/buyer", {displayName: "B"}); // no createdAt — the prod state for 519/520 docs
  seedConv("c1", {buyer: "buyer", seller: "s1"});
  const r = await send("buyer", "c1", "s1", "Is this still available?");
  assert.equal(r.ok, true);
  const cached = store.get("users/buyer").createdAt;
  assert.ok(cached instanceof RealTimestamp, "createdAt cached as a Timestamp");
  assert.ok(Math.abs(cached.toMillis() - (NOW - 30 * 24 * H)) < 2000);
});

test("a stale/forged old doc createdAt does NOT beat Auth (Auth is the source of truth)", async () => {
  authUsers.buyer = {creationTime: ago(2 * 60 * 1000)}; // 2 minutes old
  seed("users/buyer", {createdAt: RealTimestamp.fromMillis(NOW - 400 * 24 * H)});
  seedConv("c1", {buyer: "buyer", seller: "s1"});
  const r = await send("buyer", "c1", "s1", "pay here https://example.com/pay");
  assert.equal(r.held, true);
  assert.equal(r.reason, "new_account_external_link");
});

test("Auth lookup fails → falls back to the doc createdAt", async () => {
  authUsers.buyer = new Error("auth down");
  seed("users/buyer", {createdAt: RealTimestamp.fromMillis(NOW - 60 * 24 * H)});
  seed("orders/o1", {buyerId: "buyer", sellerId: "x", status: "paid"});
  seedConv("c1", {buyer: "buyer", seller: "s1"});
  const r = await send("buyer", "c1", "s1", "Same as this one https://www.titleist.com/golf-balls");
  assert.equal(r.ok, true);
});

test("FAIL CLOSED: Auth fails AND no doc createdAt → treated as new, link held", async () => {
  authUsers.buyer = new Error("auth down");
  seed("users/buyer", {displayName: "B"});
  seed("orders/o1", {buyerId: "buyer", sellerId: "x", status: "paid"});
  seedConv("c1", {buyer: "buyer", seller: "s1"});
  const r = await send("buyer", "c1", "s1", "see https://www.titleist.com/golf-balls");
  assert.equal(r.held, true);
  assert.equal(r.reason, "new_account_external_link");
});

// ── 2. Hold, don't just flag ────────────────────────────────────────
test("new account + external link → HELD and NOTHING written to the conversation", async () => {
  authUsers.att = {creationTime: ago(90 * 1000)};
  seed("users/att", {});
  seedConv("c1", {buyer: "att", seller: "s1"});
  const before = JSON.stringify(store.get("conversations/c1"));
  const r = await send("att", "c1", "s1", "confirm at https://pay-verify.example.com/teeboxmarket");
  assert.deepEqual(r, {ok: false, held: true, reason: "new_account_external_link"});
  assert.equal(messagesIn("c1").length, 0, "no message doc");
  assert.equal(JSON.stringify(store.get("conversations/c1")), before, "conversation doc untouched");
  const [h] = holds();
  assert.equal(h.status, "pending");
  assert.deepEqual(h.externalHosts, ["pay-verify.example.com"]);
  assert.equal(h.senderAgeSource, "auth");
});

test("old account WITH a completed order + external link → delivered (interstitial path)", async () => {
  authUsers.vet = {creationTime: ago(90 * 24 * H)};
  seed("users/vet", {});
  seed("orders/o1", {buyerId: "x", sellerId: "vet", status: "paid", fulfillmentStatus: "delivered"});
  seedConv("c1", {buyer: "vet", seller: "s1"});
  const r = await send("vet", "c1", "s1", "Is it this model? https://www.pingtour.com/g430");
  assert.equal(r.ok, true);
  assert.equal(messagesIn("c1").length, 1);
  assert.equal(holds().length, 0);
});

test("old account with ZERO completed transactions + link → held", async () => {
  authUsers.lurker = {creationTime: ago(200 * 24 * H)};
  seed("users/lurker", {});
  seed("orders/o1", {buyerId: "lurker", sellerId: "x", status: "refunded"}); // doesn't count
  seedConv("c1", {buyer: "lurker", seller: "s1"});
  const r = await send("lurker", "c1", "s1", "specs: https://www.pingtour.com/g430");
  assert.equal(r.held, true);
  assert.equal(r.reason, "no_transactions_external_link");
});

test("own-domain link from a brand-new account → delivered", async () => {
  authUsers.n = {creationTime: ago(60 * 1000)};
  seed("users/n", {});
  seedConv("c1", {buyer: "n", seller: "s1"});
  const r = await send("n", "c1", "s1", "Is this the same as https://teeboxmarket.com/listing/abc123 ?");
  assert.equal(r.ok, true);
});

test("App Store link from a brand-new account → delivered", async () => {
  authUsers.n = {creationTime: ago(60 * 1000)};
  seed("users/n", {});
  seedConv("c1", {buyer: "n", seller: "s1"});
  const r = await send("n", "c1", "s1", "Get the app: https://apps.apple.com/us/app/teebox-market/id6745000000");
  assert.equal(r.ok, true);
});

// ── 3. Phrases, blocklist, high-risk TLDs ───────────────────────────
test("incident domain 524178039.cfd (any subdomain) is BLOCKED outright", async () => {
  authUsers.vet = {creationTime: ago(90 * 24 * H)};
  seed("users/vet", {});
  seedConv("c1", {buyer: "vet", seller: "s1"});
  await assert.rejects(send("vet", "c1", "s1", "https://s55.524178039.cfd/teeboxmarket"),
      (e) => e.code === "invalid-argument" && e.details && e.details.error === "blocked_link");
  assert.equal(messagesIn("c1").length, 0);
});

test(".cfd/.top/.xyz/.icu link is held even from an old account with sales", async () => {
  for (const host of ["s1.other999.cfd", "deal.top", "x.y.xyz", "golf.icu"]) {
    store = new Map();
    authUsers = {vet: {creationTime: ago(400 * 24 * H)}};
    seed("users/vet", {});
    seed("orders/o1", {buyerId: "x", sellerId: "vet", status: "paid"});
    seedConv("c1", {buyer: "vet", seller: "s1"});
    const r = await send("vet", "c1", "s1", `look https://${host}/x`);
    assert.equal(r.reason, "high_risk_tld_link", host);
  }
});

test("scam phrase + link from a trusted account → held", async () => {
  authUsers.vet = {creationTime: ago(400 * 24 * H)};
  seed("users/vet", {});
  seed("orders/o1", {buyerId: "x", sellerId: "vet", status: "paid"});
  seedConv("c1", {buyer: "vet", seller: "s1"});
  const r = await send("vet", "c1", "s1", "My payment didn't go through, confirm via the link https://secure-pay.example.net/x");
  assert.equal(r.reason, "scam_phrase_with_link");
});

test("the real incident text ALONE is delivered, then flagged HARD with scam_phrase by moderateMessage", async () => {
  authUsers.vet = {creationTime: ago(400 * 24 * H)};
  seed("users/vet", {});
  seedConv("c1", {buyer: "vet", seller: "s1"});
  const r = await send("vet", "c1", "s1", SCAM);
  assert.equal(r.ok, true);
  const [path] = messagesIn("c1");
  const mid = path.split("/").pop();
  await fns.moderateMessage.run({
    params: {cid: "c1", messageId: mid},
    data: {data: () => store.get(path), ref: docRef(path)},
  });
  const flagged = store.get(path).flagged;
  assert.equal(flagged.severity, "HARD");
  assert.ok(flagged.types.includes("scam_phrase"));
});

test("moderateMessage writes the link hosts onto flagged.hosts for the warning card", async () => {
  seedConv("c1", {buyer: "vet", seller: "s1"});
  const path = "conversations/c1/messages/m1";
  seed(path, {senderId: "vet", text: "specs here https://www.pingtour.com/g430"});
  await fns.moderateMessage.run({params: {cid: "c1", messageId: "m1"},
    data: {data: () => store.get(path), ref: docRef(path)}});
  assert.deepEqual(store.get(path).flagged.hosts, ["www.pingtour.com"]);
});

// ── 4. New-account seller-burst cap ─────────────────────────────────
test("new account: 3rd NEW seller within the hour is held + account flagged; existing thread is not", async () => {
  authUsers.nb = {creationTime: ago(2 * H)};
  seed("users/nb", {});
  for (const s of ["sA", "sB", "sC"]) seedConv(`c_${s}`, {buyer: "nb", seller: s});
  seedConv("c_old", {buyer: "nb", seller: "sD", delivered: true}); // seller already replied

  assert.equal((await send("nb", "c_sA", "sA", "Is the driver still available?")).ok, true);
  assert.equal((await send("nb", "c_sB", "sB", "Would you take $40 for the putter?")).ok, true);
  const third = await send("nb", "c_sC", "sC", "What size are the shoes?");
  assert.deepEqual(third, {ok: false, held: true, reason: "new_account_seller_burst"});
  assert.equal(messagesIn("c_sC").length, 0);

  const u = store.get("users/nb");
  // Nested maps, never literal dotted keys (2026-09-18 bug class).
  assert.equal(Object.keys(u).some((k) => k.includes(".")), false, "no literal dotted keys");
  assert.deepEqual(Object.keys(u.newSellerStarts).sort(), ["sA", "sB", "sC"]);
  assert.equal(u.reviewFlag.reason, "new_account_seller_burst");
  assert.ok(holds()[0].reviewFlag === true, "hold marked so the ops alert escalates");

  // Continuing an EXISTING conversation (A now has a delivered message): not held.
  assert.equal((await send("nb", "c_sA", "sA", "Great, I'll buy it now.")).ok, true);
  // A thread where the seller already wrote first: not a start, not held.
  assert.equal((await send("nb", "c_old", "sD", "Thanks for getting back to me")).ok, true);
});

test("seller-burst window is rolling: starts older than an hour don't count", async () => {
  authUsers.nb = {creationTime: ago(3 * 24 * H)};
  const old = RealTimestamp.fromMillis(NOW - 2 * H);
  seed("users/nb", {newSellerStarts: {sX: old, sY: old}});
  seedConv("c_sC", {buyer: "nb", seller: "sC"});
  const r = await send("nb", "c_sC", "sC", "Still for sale?");
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(store.get("users/nb").newSellerStarts), ["sC"], "stale entries pruned");
});

test("seller-burst cap doesn't apply to accounts older than 7 days", async () => {
  authUsers.vet = {creationTime: ago(8 * 24 * H)};
  seed("users/vet", {});
  for (const s of ["sA", "sB", "sC", "sD"]) seedConv(`c_${s}`, {buyer: "vet", seller: s});
  let i = 0;
  for (const s of ["sA", "sB", "sC", "sD"]) {
    assert.equal((await send("vet", `c_${s}`, s, `Question number ${++i} about this one`)).ok, true);
  }
});
