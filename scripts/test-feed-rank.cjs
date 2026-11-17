// node --test scripts/test-feed-rank.cjs — For You ranking rules (js/feed-rank.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const R = require("../js/feed-rank.js");

// Load the config the same way the browser does.
const vm = require("vm");
const fs = require("fs");
const box = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/feed-rank-config.js"), "utf8"), box);
const CFG = box.window.TB_FEED_CONFIG;

const NOW = Date.parse("2026-11-17T18:00:00Z");
const DAY = 86400000;
let n = 0;
function L(o) {
  n++;
  return {id: "L" + n, status: "active", title: "Item " + n, brand: "Titleist", cat: "clubs", specCategory: "driver",
    ask: 200, sellerId: "s" + (n % 7), createdAt: NOW - (n % 30) * DAY, watchlistCount: 0, quantity: 1, quantitySold: 0,
    photoVariants: {0: {w400: "x"}, 1: {w400: "y"}}, ...o};
}
const run = (items, o) => R.rank(items, {now: NOW, seed: "seedA", cfg: CFG, catalog: items, ...o});

test("never shows own, sold, sold-out, removed, held, or live-reserved listings", () => {
  const items = [
    L({id: "mine", sellerId: "me"}),
    L({id: "sold", status: "sold"}),
    L({id: "removed", status: "removed"}),
    L({id: "flagged", status: "flagged"}),
    L({id: "soldout", quantity: 2, quantitySold: 2}),
    L({id: "reserved", status: "pending", pendingUntil: NOW + 5 * 60000}),
    L({id: "lapsed", status: "pending", pendingUntil: NOW - 60000}),
    L({id: "ok"}),
  ];
  const ids = run(items, {uid: "me"}).list.map((p) => p.id);
  assert.deepStrictEqual(ids.sort(), ["lapsed", "ok"]);
});

test("same seed + same inputs = same order (no reshuffle within a visit); new seed = different order", () => {
  const items = Array.from({length: 60}, () => L({}));
  const a = run(items).list.map((p) => p.id);
  const b = run(items.slice().reverse()).list.map((p) => p.id);
  assert.deepStrictEqual(a, b, "input order must not matter");
  const c = run(items, {seed: "seedB"}).list.map((p) => p.id);
  assert.notDeepStrictEqual(a, c);
});

test("diversity: no more than 2 from one seller / 3 from one category in any 6 consecutive (when alternatives exist)", () => {
  const items = [];
  for (let i = 0; i < 12; i++) items.push(L({sellerId: "bigSeller", cat: "apparel", specCategory: "apparel", createdAt: NOW - i * 3600000}));
  for (let i = 0; i < 12; i++) items.push(L({sellerId: "x" + i, cat: ["clubs", "bags", "shoes", "accessories"][i % 4], createdAt: NOW - 20 * DAY}));
  const list = run(items).list;
  for (let i = 0; i + 6 <= 18; i++) {
    const w = list.slice(i, i + 6);
    assert.ok(w.filter((p) => p.sellerId === "bigSeller").length <= 2, "seller wall at " + i);
    const cats = {};
    w.forEach((p) => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
    assert.ok(Object.values(cats).every((c) => c <= 3), "category wall at " + i);
  }
});

test("old listings get exposure: over 20 visits, every listing reaches the first 24 at least once", () => {
  const items = Array.from({length: 77}, (_, i) => L({createdAt: NOW - i * 2 * DAY, sellerId: "s" + (i % 11),
    cat: ["clubs", "bags", "shoes", "apparel", "accessories"][i % 5]}));
  const reached = new Set();
  for (let v = 0; v < 20; v++) run(items, {seed: "visit" + v}).list.slice(0, 24).forEach((p) => reached.add(p.id));
  assert.strictEqual(reached.size, 77);
});

test("freshness decays: a brand-new listing outranks the same listing at 60 days on average", () => {
  let wins = 0;
  for (let v = 0; v < 50; v++) {
    const fresh = L({id: "fresh", createdAt: NOW - 3600000}), old = L({id: "old", createdAt: NOW - 60 * DAY, sellerId: "other"});
    const ids = run([fresh, old], {seed: "s" + v}).list.map((p) => p.id);
    if (ids[0] === "fresh") wins++;
  }
  assert.ok(wins >= 40, "fresh won " + wins + "/50");
});

test("quality: no-brand, way-overpriced and stale listings are pushed down", () => {
  const peers = [L({id: "p1", ask: 300}), L({id: "p2", ask: 320}), L({id: "p3", ask: 280})];
  const ctx = {cfg: CFG, now: NOW, seed: "s", profile: null, seen: {},
    peers: null};
  const all = [...peers, L({id: "over", ask: 1500}), L({id: "fair", ask: 310})];
  const r = run(all).meta;
  assert.ok(r.get("over").parts.quality < r.get("fair").parts.quality);
  const nob = R.score(L({brand: ""}), {...ctx, peers: new Map()});
  const withB = R.score(L({}), {...ctx, peers: new Map()});
  assert.ok(nob.parts.quality < withB.parts.quality);
  const stale = R.score(L({createdAt: NOW - 90 * DAY, watchlistCount: 0}), {...ctx, peers: new Map()});
  assert.ok(stale.why.includes("stale"));
});

test("personal: a buyer who views/likes putters sees putters first; logged-out gets no affinity", () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push(L({cat: "clubs", specCategory: "putter", brand: "Scotty Cameron", ask: 350, sellerId: "a" + i}));
  for (let i = 0; i < 10; i++) items.push(L({cat: "apparel", specCategory: "apparel", brand: "Nike", ask: 40, sellerId: "b" + i}));
  const ev = [
    {t: NOW - DAY, k: "view", cat: "clubs", sc: "putter", brand: "Scotty Cameron", ask: 380},
    {t: NOW - DAY, k: "favorite", cat: "clubs", sc: "putter", brand: "Scotty Cameron", ask: 320},
    {t: NOW - 2 * DAY, k: "search", q: "scotty"},
  ];
  const prof = R.buildProfile(ev, items, NOW, CFG);
  const top = run(items, {uid: "buyer", profile: prof}).list.slice(0, 6);
  assert.ok(top.filter((p) => p.specCategory === "putter").length >= 3, "putters should lead (diversity caps at 3 per 6)");
  const anon = run(items, {uid: null, profile: prof});
  assert.strictEqual(anon.mode, "default");
  assert.ok([...anon.meta.values()].every((m) => m.parts.affinity === 0));
});

test("seen penalty: a listing scrolled past many times drops, capped", () => {
  const items = Array.from({length: 30}, () => L({}));
  const target = items[0].id;
  const base = run(items).meta.get(target);
  const seen = run(items, {seen: {[target]: 10}}).meta.get(target);
  assert.ok(seen.score < base.score);
  assert.ok(seen.score >= base.score - CFG.weights.seen * CFG.exposure.maxPenalty - 1e-9, "penalty is capped");
});

test("ranking 300 listings is fast (< 25 ms)", () => {
  const items = Array.from({length: 300}, (_, i) => L({sellerId: "s" + (i % 40), cat: ["clubs", "bags", "shoes", "apparel"][i % 4]}));
  run(items);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) run(items, {seed: "p" + i});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
  assert.ok(ms < 25, ms.toFixed(2) + " ms");
});

test("discovery slots + seen rotation: a 77-listing catalog fully reaches the first 24 within 10 visits", () => {
  const items = Array.from({length: 77}, (_, i) => L({createdAt: NOW - (i < 40 ? i * 0.2 : 40 + i * 2) * DAY,
    sellerId: "s" + (i % 15), cat: ["clubs", "bags", "shoes", "apparel", "accessories"][i % 5]}));
  const seen = {}; const reached = new Set();
  for (let v = 0; v < 10; v++) {
    const top = run(items, {seed: "visit" + v, seen}).list.slice(0, 24);
    top.forEach((p) => { reached.add(p.id); seen[p.id] = (seen[p.id] || 0) + 1; });
  }
  assert.strictEqual(reached.size, 77);
});
