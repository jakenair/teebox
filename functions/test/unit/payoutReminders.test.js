"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const pr = require("../../lib/payoutReminders");

const H = 3600 * 1000;
const D = 24 * H;
// 2026-11-19 15:00 Central (21:00Z) — outside quiet hours.
const T0 = Date.parse("2026-11-19T21:00:00Z");

test("cadence: stage 1 at save, then 24h, 3d, 7d; max 4; nothing after", () => {
  const log = {anchorMs: T0, sent: {}};
  assert.equal(pr.dueStage(log, T0).stage, 1);
  log.sent[1] = {atMs: T0}; log.count = 1;
  assert.equal(pr.dueStage(log, T0 + 23 * H).stage, null);
  assert.equal(pr.dueStage(log, T0 + 24 * H).stage, 2);
  log.sent[2] = {atMs: T0 + 24 * H}; log.count = 2;
  assert.equal(pr.dueStage(log, T0 + 71 * H).stage, null);
  assert.equal(pr.dueStage(log, T0 + 3 * D).stage, 3);
  log.sent[3] = {atMs: T0 + 3 * D}; log.count = 3;
  assert.equal(pr.dueStage(log, T0 + 7 * D - 1).stage, null);
  assert.equal(pr.dueStage(log, T0 + 7 * D).stage, 4);
  log.sent[4] = {atMs: T0 + 7 * D}; log.count = 4;
  assert.equal(pr.dueStage(log, T0 + 30 * D).stage, null);
  assert.equal(pr.dueStage(log, T0 + 30 * D).reason, "max");
});

test("cancelled / done / skip window stop everything", () => {
  assert.equal(pr.dueStage({anchorMs: T0, cancelledAtMs: T0}, T0 + 9 * D).stage, null);
  assert.equal(pr.dueStage({anchorMs: T0, doneAtMs: T0}, T0 + 9 * D).stage, null);
  const r = pr.dueStage({anchorMs: T0, skipUntilMs: T0 + 2 * D}, T0 + D);
  assert.equal(r.stage, null); assert.equal(r.reason, "skip-window");
});

test("outage catch-up sends only the latest overdue stage and supersedes the rest", () => {
  const r = pr.dueStage({anchorMs: T0, sent: {1: {atMs: T0}}, count: 1}, T0 + 4 * D);
  assert.equal(r.stage, 3);
  assert.deepEqual(r.supersede, [2]);
});

test("min gap: never two reminders within 12h", () => {
  // stage 1 was deferred (quiet hours) and went out at T0+20h; stage 2 due at 24h waits until 32h
  const log = {anchorMs: T0, sent: {1: {atMs: T0 + 20 * H}}, count: 1};
  assert.equal(pr.dueStage(log, T0 + 25 * H).reason, "min-gap");
  assert.equal(pr.dueStage(log, T0 + 32 * H).stage, 2);
});

test("quiet hours: 21:00-08:00 Central by default; seller tz when they have one", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(pr.isQuietNow({}, at("2026-11-20T02:30:00Z")), false); // 20:30 CST
  assert.equal(pr.isQuietNow({}, at("2026-11-20T03:30:00Z")), true); //  21:30 CST
  assert.equal(pr.isQuietNow({}, at("2026-11-20T13:59:00Z")), true); //  07:59 CST
  assert.equal(pr.isQuietNow({}, at("2026-11-20T14:01:00Z")), false); // 08:01 CST
  const la = {pushPrefs: {quietHours: {start: "21:00", end: "08:00", tz: "America/Los_Angeles"}}};
  assert.equal(pr.isQuietNow(la, at("2026-11-20T03:30:00Z")), false); // 19:30 PST
  assert.equal(pr.isQuietNow(la, at("2026-11-20T15:30:00Z")), true); //  07:30 PST
  // a custom wider window is honored; the 21-08 window always applies
  const early = {pushPrefs: {quietHours: {start: "19:00", end: "08:00", tz: "America/Chicago"}}};
  assert.equal(pr.isQuietNow(early, at("2026-11-20T02:30:00Z")), true); // 20:30 CST
  const narrow = {pushPrefs: {quietHours: {start: "23:00", end: "06:00", tz: "America/Chicago"}}};
  assert.equal(pr.isQuietNow(narrow, at("2026-11-20T03:30:00Z")), true); // 21:30 CST still quiet
  assert.equal(pr.isQuietNow({pushPrefs: {quietHours: {tz: "Not/AZone"}}}, at("2026-11-20T03:30:00Z")), true);
});

test("copy: names the item, no emoji, views only when real and >= badge threshold, never on stage 1", () => {
  const c1 = pr.copyFor(1, {label: "Scotty Cameron Newport 2", views: 50});
  assert.equal(c1.title, "Your Scotty Cameron Newport 2 is almost live");
  assert.equal(c1.body, "Finish payout setup to start selling. About 3 minutes.");
  assert.equal(c1.viewsUsed, 0);
  assert.match(pr.copyFor(2, {label: "Polo", views: 9}).title, /isn't live yet/);
  const v = pr.copyFor(3, {label: "Polo", views: 12});
  assert.equal(v.title, "Buyers are already looking at your Polo");
  assert.equal(v.viewsUsed, 12);
  assert.match(pr.copyFor(4, {label: "Polo"}).title, /^Last reminder: your Polo isn't live$/);
  assert.match(pr.copyFor(1, {label: "Polo", more: 2}).title, /^Your Polo and 2 more are almost live$/);
  const all = [1, 2, 3, 4].flatMap((n) => [pr.copyFor(n, {label: "X"}), pr.copyFor(n, {label: "X", views: 20})]);
  for (const c of all) {
    for (const t of [c.title, c.body, c.emailIntro]) {
      assert.ok(!/\p{Extended_Pictographic}/u.test(t), `emoji in: ${t}`);
    }
  }
});

test("item label trims long titles at a word", () => {
  assert.equal(pr.itemLabel({title: "  Scotty   Cameron "}), "Scotty Cameron");
  const long = pr.itemLabel({title: "Titleist T100 Irons 4-PW Dynamic Gold S300 Stiff Steel Shafts"});
  assert.ok(long.length <= 40, long);
  assert.ok(!/\s$/.test(long));
  assert.equal(pr.itemLabel({}), "listing");
});

test("pickListing: most-viewed when views are real, else newest; views come from viewDays only", () => {
  const ts = (ms) => ({toMillis: () => ms});
  const now = Date.parse("2026-11-19T21:00:00Z");
  const a = {id: "a", title: "A", createdAt: ts(now - 3 * D), viewDays: {"20261119": 6, "20261118": 6}};
  const b = {id: "b", title: "B", createdAt: ts(now - D), viewDays: {"20261119": 2}};
  assert.equal(pr.pickListing([a, b], now).listing.id, "a");
  assert.equal(pr.pickListing([a, b], now).views, 12);
  const a2 = {...a, viewDays: {"20261119": 3}};
  assert.equal(pr.pickListing([a2, b], now).listing.id, "b");
  assert.equal(pr.pickListing([a2, b], now).views, 0);
  // a legacy views7d number alone is not trusted
  assert.equal(pr.pickListing([{id: "c", views7d: 999, createdAt: ts(now)}], now).views, 0);
});

// ── runReminderForSeller with an in-memory Firestore + stub channels ──────
function fakeDb(seed) {
  const store = new Map(Object.entries(seed));
  const merge = (a, b) => {
    const out = {...a};
    for (const [k, v] of Object.entries(b)) {
      out[k] = (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") ? merge(out[k], v) : v;
    }
    return out;
  };
  const ref = (path) => ({
    path,
    get: async () => ({exists: store.has(path), id: path.split("/").pop(), data: () => store.get(path)}),
    set: async (data, opt) => { store.set(path, opt && opt.merge ? merge(store.get(path) || {}, data) : data); },
  });
  const db = {
    store,
    collection: (c) => {
      const filters = [];
      const q = {
        doc: (id) => ref(`${c}/${id}`),
        where: (f, _op, v) => { filters.push([f, v]); return q; },
        limit: () => q,
        get: async () => ({docs: [...store.entries()]
            .filter(([p]) => p.startsWith(c + "/") && p.split("/").length === 2)
            .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
            .map(([p, d]) => ({id: p.split("/")[1], data: () => d}))}),
      };
      return q;
    },
    runTransaction: async (fn) => fn({get: (r) => r.get(), set: (r, d, o) => r.set(d, o)}),
  };
  return db;
}

function deps(db, {push = {sent: 1}, email = {sent: true}} = {}) {
  const calls = {push: [], email: []};
  return {
    calls,
    d: {
      db,
      sendPush: async (uid, payload, cat) => { calls.push.push({uid, payload, cat}); return typeof push === "function" ? push() : push; },
      sendEmail: async (o) => { calls.email.push(o); return email; },
      loadTemplate: () => Object.assign(() => ({}), {subject: (ctx) => ctx.copy.title}),
      authEmail: async () => "seller@example.com",
      logger: {info() {}, warn() {}},
    },
  };
}

const ts = (ms) => ({toMillis: () => ms});
const awaiting = (id, extra = {}) => ({sellerId: "s1", status: "hidden", hiddenReason: "awaiting_payouts",
  title: "Scotty Cameron Newport 2", createdAt: ts(T0), photos: ["https://x/p.jpg"], ...extra});

test("run: stage 1 by push; re-run is a no-op; email fallback when no push lands", async () => {
  const db = fakeDb({"users/s1": {}, "listings/L1": awaiting("L1")});
  const {d, calls} = deps(db);
  const r1 = await pr.runReminderForSeller("s1", {deps: d, nowMs: T0 + 60000, trigger: "create"});
  assert.equal(r1.sent, true); assert.equal(r1.channel, "push"); assert.equal(r1.stage, 1);
  assert.equal(calls.push[0].payload.title, "Your Scotty Cameron Newport 2 is almost live");
  assert.equal(calls.push[0].payload.deepLink, "teebox://payouts/setup");
  assert.equal(calls.push[0].payload.data.listingId, undefined, "no listingId (web click would open the hidden listing)");
  const r2 = await pr.runReminderForSeller("s1", {deps: d, nowMs: T0 + 120000});
  assert.equal(r2.sent, false); assert.equal(calls.push.length, 1);

  const db2 = fakeDb({"users/s2": {}, "listings/L2": awaiting("L2", {sellerId: "s2"})});
  const x = deps(db2, {push: {sent: 0, skipped: "no-tokens"}});
  const r3 = await pr.runReminderForSeller("s2", {deps: x.d, nowMs: T0 + 60000});
  assert.equal(r3.channel, "email");
  assert.equal(x.calls.email[0].category, "payoutReminders");
  assert.equal(x.calls.email[0].to, "seller@example.com");
});

test("run: quiet hours defer; charges-enabled cancels; no awaiting listings sends nothing", async () => {
  const db = fakeDb({"users/s1": {}, "listings/L1": awaiting("L1")});
  const {d, calls} = deps(db);
  const night = Date.parse("2026-11-20T04:00:00Z"); // 22:00 CST
  assert.equal((await pr.runReminderForSeller("s1", {deps: d, nowMs: night})).reason, "quiet-hours");
  assert.equal(calls.push.length, 0);
  db.store.set("users/s1", {stripeChargesEnabled: true});
  db.store.set("payoutReminders/s1", {anchorMs: T0, count: 1, sent: {1: {atMs: T0}}});
  assert.equal((await pr.runReminderForSeller("s1", {deps: d, nowMs: T0 + 2 * D})).reason, "charges-enabled");
  assert.ok(db.store.get("payoutReminders/s1").cancelledAtMs);
  // and stays cancelled even if they somehow drop back to not-ready
  db.store.set("users/s1", {});
  assert.equal((await pr.runReminderForSeller("s1", {deps: d, nowMs: T0 + 3 * D})).reason, "cancelled");
  const db3 = fakeDb({"users/s3": {}});
  assert.equal((await pr.runReminderForSeller("s3", {deps: deps(db3).d, nowMs: T0})).reason, "no-awaiting-listings");
});

test("run: whole cadence end to end = exactly 4 sends, then nothing", async () => {
  const db = fakeDb({"users/s1": {}, "listings/L1": awaiting("L1")});
  const {d, calls} = deps(db);
  for (let h = 0; h <= 10 * 24; h += 0.5) {
    const now = T0 + h * H;
    if (pr.isQuietNow({}, now)) continue;
    await pr.runReminderForSeller("s1", {deps: d, nowMs: now});
  }
  assert.equal(calls.push.length, 4);
  const log = db.store.get("payoutReminders/s1");
  assert.equal(log.count, 4); assert.ok(log.doneAtMs);
  assert.deepEqual(Object.keys(log.sent).sort(), ["1", "2", "3", "4"]);
});

test("run: a fresh claim from another producer blocks a concurrent send", async () => {
  const db = fakeDb({"users/s1": {}, "listings/L1": awaiting("L1"),
    "payoutReminders/s1": {anchorMs: T0, claim: {stage: 1, atMs: T0}}});
  const {d, calls} = deps(db);
  assert.equal((await pr.runReminderForSeller("s1", {deps: d, nowMs: T0 + 1000})).reason, "claimed-elsewhere");
  assert.equal(calls.push.length, 0);
  // a stale claim (crashed send) is retried
  assert.equal((await pr.runReminderForSeller("s1", {deps: d, nowMs: T0 + 11 * 60000})).sent, true);
});
