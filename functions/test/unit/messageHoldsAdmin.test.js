// functions/test/unit/messageHoldsAdmin.test.js — 2026-10-30
//
// The held-message admin path against an in-memory Firestore double (with
// runTransaction): approve delivers through the SAME payload sendMessage uses,
// exactly once; reject never delivers; both are admin + fresh-re-auth gated and
// write adminActions. Plus the per-hold ops alert (defanged snippet, deep link,
// no action URL) and the daily digest.
const {test, beforeEach} = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const admin = require("firebase-admin");

process.env.ADMIN_ALLOWLIST = "boss@teeboxmarket.com";
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-teebox";

// ── opsAlert stub (captures instead of POSTing) ─────────────────────
const alerts = [];
const opsAlertPath = path.resolve(__dirname, "../../opsAlert.js");
require.cache[opsAlertPath] = {id: opsAlertPath, filename: opsAlertPath, loaded: true,
  exports: {opsAlert: async (sev, title, details) => { alerts.push({sev, title, details}); },
    OPS_ALERT_WEBHOOK: {name: "SMOKE_ALERT_WEBHOOK", value: () => ""}}};

// ── Firestore double ────────────────────────────────────────────────
const TS = admin.firestore.Timestamp;
const S = Symbol("fv");
const FieldValue = {serverTimestamp: () => ({[S]: "ts"}), increment: (n) => ({[S]: "inc", n})};
let store; let autoId = 0;
const resolve = (cur, v) => (v && v[S] === "ts") ? TS.now() :
  (v && v[S] === "inc") ? (Number(cur) || 0) + v.n : v;
const isMap = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof TS) &&
  !v[S] && Object.getPrototypeOf(v) === Object.prototype;
function merge(t, src) {
  for (const [k, v] of Object.entries(src)) {
    if (isMap(v)) { t[k] = isMap(t[k]) ? t[k] : {}; merge(t[k], v); } else t[k] = resolve(t[k], v);
  }
}
function docRef(p) {
  return {id: p.split("/").pop(), path: p,
    async get() { const d = store.get(p); return {id: p.split("/").pop(), exists: d !== undefined, data: () => d}; },
    async set(data, o) { const cur = (o && o.merge && store.get(p)) || {}; merge(cur, data); store.set(p, cur); },
    async update(patch) { const cur = store.get(p); if (!cur) { const e = new Error("NOT_FOUND"); e.code = 5; throw e; } merge(cur, patch); },
    collection: (n) => coll(`${p}/${n}`)};
}
function coll(p, filters = [], lim = Infinity) {
  const q = {
    doc: (id) => docRef(`${p}/${id || "auto" + (++autoId)}`),
    async add(d) { const r = q.doc(); await r.set(d); return r; },
    where: (f, op, v) => coll(p, [...filters, [f, op, v]], lim),
    limit: (n) => coll(p, filters, n),
    async get() {
      const docs = [];
      for (const [k, d] of store) {
        const rest = k.slice(p.length + 1);
        if (!k.startsWith(p + "/") || rest.includes("/")) continue;
        const ok = filters.every(([f, op, v]) => op === "==" ? d[f] === v :
          op === ">=" ? (d[f] && d[f].toMillis ? d[f].toMillis() >= v.toMillis() : false) : true);
        if (!ok) continue;
        docs.push({id: rest, data: () => d});
        if (docs.length >= lim) break;
      }
      return {docs, empty: !docs.length, size: docs.length};
    },
  };
  return q;
}
let txCommits = 0;
const db = {
  collection: (n) => coll(n),
  // Buffered writes applied on commit — a throw inside the callback writes nothing.
  async runTransaction(fn) {
    const ops = [];
    const tx = {get: (r) => r.get(), set: (r, d, o) => ops.push(() => r.set(d, o)),
      update: (r, d) => ops.push(() => r.update(d))};
    const out = await fn(tx);
    for (const op of ops) await op();
    txCommits++;
    return out;
  },
};
const fsFn = () => db; fsFn.FieldValue = FieldValue; fsFn.Timestamp = TS;
Object.defineProperty(admin, "firestore", {value: fsFn, configurable: true, writable: true});

const mh = require("../../messageHolds");
const T = mh._test;
const NOW_S = Math.floor(Date.now() / 1000);
const ADMIN = {uid: "admin1", token: {email: "boss@teeboxmarket.com", email_verified: true, auth_time: NOW_S - 30}};
const STALE = {uid: "admin1", token: {...ADMIN.token, auth_time: NOW_S - 3600}};
const USER = {uid: "u1", token: {email: "rando@x.com", email_verified: true, auth_time: NOW_S}};
const call = (fn, auth, data) => fn.run({auth, data, rawRequest: {headers: {}}});
const msgs = (cid) => [...store.keys()].filter((k) => k.startsWith(`conversations/${cid}/messages/`));
const actions = () => [...store.entries()].filter(([k]) => k.startsWith("adminActions/")).map(([, d]) => d);

beforeEach(() => {
  store = new Map(); alerts.length = 0; txCommits = 0;
  store.set("conversations/c1", {participants: ["buyer", "seller"], buyerId: "buyer", sellerId: "seller"});
  store.set("users/buyer", {displayName: "Buyer Bob"});
  store.set("users/seller", {displayName: "Seller Sue"});
  store.set("messageHolds/h1", {sender: "buyer", recipient: "seller", conversationId: "c1",
    text: "specs https://www.pingtour.com/g430", reason: "new_account_external_link",
    reasons: ["new_account_external_link"], externalHosts: ["www.pingtour.com"],
    status: "pending", createdAt: TS.now(), clientFlag: null});
});

test("approve: delivers once via the sendMessage payload, flips status, logs adminActions", async () => {
  const r = await call(mh.releaseHold, ADMIN, {holdId: "h1", note: "legit spec link"});
  assert.equal(r.ok, true);
  const ms = msgs("c1");
  assert.equal(ms.length, 1);
  const m = store.get(ms[0]);
  assert.equal(m.senderId, "buyer");
  assert.equal(m.text, "specs https://www.pingtour.com/g430");
  assert.equal(m.releasedFromHold, true);
  assert.equal(m.holdId, "h1");
  assert.ok(m.createdAt instanceof TS);
  const conv = store.get("conversations/c1");
  assert.equal(conv.lastMessageSenderId, "buyer");
  assert.equal(conv.lastMessageText, "specs https://www.pingtour.com/g430");
  assert.ok(conv.lastRead.buyer instanceof TS);
  const h = store.get("messageHolds/h1");
  assert.equal(h.status, "released");
  assert.equal(h.releasedBy, "admin1");
  assert.equal(h.deliveredMessageId, ms[0].split("/").pop());
  const [a] = actions();
  assert.equal(a.action, "release_hold");
  assert.equal(a.targetId, "h1");
  assert.equal(a.adminUid, "admin1");
  // Double tap: second approve refused, still exactly one message.
  await assert.rejects(call(mh.releaseHold, ADMIN, {holdId: "h1"}),
      (e) => e.code === "failed-precondition");
  assert.equal(msgs("c1").length, 1);
});

test("approve payload matches sendMessage's delivery builder exactly (shared write path)", () => {
  const writes = mh.buildDeliveryWrites({convRef: "C", msgRef: "M", senderId: "s", text: "hi",
    clientFlag: {severity: "SOFT"}, FieldValue});
  assert.deepEqual(Object.keys(writes[0].data).sort(), ["clientFlag", "createdAt", "senderId", "text"]);
  assert.deepEqual(Object.keys(writes[1].data).sort(),
      ["lastMessageAt", "lastMessageSenderId", "lastMessageText", "lastRead"]);
  assert.deepEqual(writes[1].opts, {merge: true});
});

test("approve refuses when the sender left the conversation — nothing written", async () => {
  store.set("conversations/c1", {participants: ["seller", "other"]});
  await assert.rejects(call(mh.releaseHold, ADMIN, {holdId: "h1"}),
      (e) => e.code === "failed-precondition");
  assert.equal(msgs("c1").length, 0);
  assert.equal(store.get("messageHolds/h1").status, "pending");
});

test("reject: never delivers, flips status, logs adminActions", async () => {
  const r = await call(mh.rejectHold, ADMIN, {holdId: "h1", note: "phish"});
  assert.equal(r.rejected, true);
  assert.equal(msgs("c1").length, 0);
  assert.equal(store.get("messageHolds/h1").status, "rejected");
  assert.equal(actions()[0].action, "reject_hold");
  await assert.rejects(call(mh.releaseHold, ADMIN, {holdId: "h1"}),
      (e) => e.code === "failed-precondition", "a rejected hold can't be approved later");
});

test("auth: non-admin denied; stale admin sign-in → reauthRequired; nothing written", async () => {
  for (const fn of [mh.releaseHold, mh.rejectHold]) {
    await assert.rejects(call(fn, USER, {holdId: "h1"}), (e) => e.code === "permission-denied");
    await assert.rejects(call(fn, null, {holdId: "h1"}), (e) => e.code === "unauthenticated");
    await assert.rejects(call(fn, STALE, {holdId: "h1"}),
        (e) => e.code === "failed-precondition" && e.details.reauthRequired === true);
  }
  await assert.rejects(call(mh.listMessageHolds, USER, {}), (e) => e.code === "permission-denied");
  assert.equal(msgs("c1").length, 0);
  assert.equal(store.get("messageHolds/h1").status, "pending");
  assert.equal(actions().length, 0);
});

test("list: pending holds with sender/recipient names (session auth is enough to read)", async () => {
  const r = await call(mh.listMessageHolds, STALE, {});
  assert.equal(r.count, 1);
  assert.equal(r.holds[0].senderName, "Buyer Bob");
  assert.equal(r.holds[0].recipientName, "Seller Sue");
});

test("hold alert: sender/recipient names + uids, reason, 120-char defanged snippet, deep link only", async () => {
  await mh.onMessageHoldCreated.run({params: {holdId: "h1"},
    data: {data: () => store.get("messageHolds/h1")}});
  assert.equal(alerts.length, 1);
  const {title, details} = alerts[0];
  assert.match(title, /held: new_account_external_link/);
  assert.equal(details.sender, "Buyer Bob (buyer)");
  assert.equal(details.recipient, "Seller Sue (seller)");
  assert.equal(details.reason, "new_account_external_link");
  assert.equal(details.snippet, "specs hxxps://www[.]pingtour[.]com/g430");
  assert.equal(details.linkHosts, "www[.]pingtour[.]com");
  assert.match(details.review, /^https:\/\/teeboxmarket\.com\/\?admin=holds&hold=h1 /);
  const all = JSON.stringify(alerts[0]);
  assert.doesNotMatch(all, /releaseHold|rejectHold|approve\?|reject\?|token=/i, "no action URLs");
  const long = T.buildHoldAlert("h2", {text: "x".repeat(500), sender: "a", recipient: "b"}, null, null);
  assert.equal(long.details.snippet.length, 120);
  assert.equal(long.details.sender, "(no name) (a)");
});

test("daily digest: counts by reason, decided, pending, oldest pending", async () => {
  const old = TS.fromMillis(Date.now() - 50 * 3600 * 1000);
  store.set("messageHolds/h2", {reason: "high_risk_tld_link", status: "rejected", createdAt: TS.now()});
  store.set("messageHolds/h3", {reason: "new_account_external_link", status: "released", createdAt: TS.now()});
  store.set("messageHolds/h4", {reason: "new_account_external_link", status: "pending", createdAt: old});
  const s = await T.runDailyDigest(Date.now());
  assert.equal(s.heldCount, 3, "h4 is older than 24 h");
  assert.equal(s.pendingCount, 2);
  assert.deepEqual(s.byReason, {new_account_external_link: 2, high_risk_tld_link: 1});
  assert.ok(s.oldestPendingHours >= 49.9);
  assert.equal(alerts[0].sev, "warn");
  assert.equal(alerts[0].title, "Message holds: 3 held in the last 24h, 2 pending");
  assert.equal(alerts[0].details.decidedLast24h, "approved 1, rejected 1");
  store = new Map();
  alerts.length = 0;
  await T.runDailyDigest(Date.now());
  assert.equal(alerts[0].sev, "info", "quiet day still reports (heartbeat)");
  assert.equal(alerts[0].title, "Message holds: 0 held in the last 24h, 0 pending");
});

test("defang", () => {
  assert.equal(T.defang("go to https://s55.524178039.cfd/teeboxmarket now"),
      "go to hxxps://s55[.]524178039[.]cfd/teeboxmarket now");
  assert.equal(T.defang("$60 for 10.5 shoes?"), "$60 for 10.5 shoes?");
});
