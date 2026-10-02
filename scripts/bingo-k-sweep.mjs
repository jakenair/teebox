#!/usr/bin/env node
/**
 * scripts/bingo-k-sweep.mjs
 *
 * Retuning tool for the Logo Bingo lookback window (LOOKBACK_DAYS in
 * /bingo-select.mjs). Sweeps K and reports the three properties that matter,
 * so the constant is chosen from measurements rather than taste.
 *
 *   drift    — how many of the 9 tiles change on a given day when ONE course
 *              is added to or retired from the pool. This is the whole reason
 *              the algorithm was replaced on 2026-10-01: the legacy one
 *              averaged 8.37 of 9 (worst 9 of 9), so retiring a single logo
 *              re-rolled every future board. Lower is better; 0 is ideal.
 *   repeats  — courses appearing again within the lookback window. The legacy
 *              cycle gave 0 for free. Must stay 0.
 *   coverage — distinct courses over 30 and 60 days. The legacy algorithm hit
 *              every course once per cycle (157/30d). The stable algorithm
 *              samples instead, so coverage is statistical — the accepted
 *              trade (founder ruling 2026-10-01).
 *
 * K=3 was chosen because repeats hit 0 there and get WORSE above it: the ban
 * set grows faster than the ranking can absorb, pushing selection deeper and
 * out of alignment. Re-run this if the pool grows a lot — the balance depends
 * on pool size.
 *
 * Usage:
 *   node scripts/bingo-k-sweep.mjs            # K = 0..17, 60 days from today
 *   node scripts/bingo-k-sweep.mjs 0 30 180   # minK maxK days
 */

import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const [, , aMin, aMax, aDays] = process.argv;
const K_MIN = Number(aMin ?? 0);
const K_MAX = Number(aMax ?? 17);
const DAYS = Number(aDays ?? 60);

const sel = await import(resolve(ROOT, "bingo-select.mjs"));
const canon = JSON.parse(
    readFileSync(resolve(ROOT, "functions/data/bingo-puzzle-data.json"), "utf8"));
const pool = canon.courses;
// The counterfactual: the same pool with one extra course. Drift is measured
// against this, which is exactly what retiring royal-county-down did in r295.
const poolPlus = pool.concat([{id: "__sweep_probe_course__"}]);

const shift = (ds, n) => {
  const d = new Date(ds + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Re-implements selection ONLY to vary K, which the shipped module fixes at a
// constant. Keep in lockstep with stableSelect in bingo-select.mjs; this file
// is a measurement tool and is never imported by the app.
function boardsFor(K, pl, dates) {
  const cache = new Map();
  const rank = (ds) => pl
      .map((c) => ({c, h: sel.hashStr(sel.SEED + ":" + ds + ":" + c.id)}))
      .sort((a, b) => (a.h - b.h) || (a.c.id < b.c.id ? -1 : 1))
      .map((x) => x.c);
  const board = (ds) => {
    if (ds < sel.CUTOVER_DATE) return sel.selectBoard(ds, pl);
    if (cache.has(ds)) return cache.get(ds);
    const banned = new Set();
    for (let i = 1; i <= K; i++) board(shift(ds, -i)).forEach((c) => banned.add(c.id));
    const r = rank(ds);
    const out = [];
    for (const c of r) {
      if (out.length === 9) break;
      if (!banned.has(c.id)) out.push(c);
    }
    if (out.length < 9) {
      const have = new Set(out.map((c) => c.id));
      for (const c of r) {
        if (out.length === 9) break;
        if (!have.has(c.id)) out.push(c);
      }
    }
    cache.set(ds, out);
    return out;
  };
  const warm = shift(dates[0], -(K + 2));
  for (let d = warm; d <= dates[dates.length - 1]; d = shift(d, 1)) board(d);
  return (ds) => board(ds).map((c) => c.id);
}

const start = sel.CUTOVER_DATE;
const dates = [...Array(DAYS)].map((_, i) => shift(start, i));

console.log(`pool ${pool.length} · ${DAYS} days from ${start} · ` +
  `shipped K = ${sel.LOOKBACK_DAYS}\n`);
console.log("   K  drift(avg/worst)  repeats  distinct/30d  distinct/60d");
console.log("   --  ---------------  -------  ------------  ------------");

for (let K = K_MIN; K <= K_MAX; K++) {
  const A = boardsFor(K, pool, dates);
  const B = boardsFor(K, poolPlus, dates);
  let tot = 0; let worst = 0; let rep = 0;
  for (const d of dates) {
    const a = A(d);
    const b = B(d);
    const diff = 9 - a.filter((x) => b.includes(x)).length;
    tot += diff;
    worst = Math.max(worst, diff);
    const prev = new Set();
    for (let i = 1; i <= Math.max(K, 1); i++) A(shift(d, -i)).forEach((x) => prev.add(x));
    rep += a.filter((x) => prev.has(x)).length;
  }
  const c30 = new Set(); dates.slice(0, 30).forEach((d) => A(d).forEach((x) => c30.add(x)));
  const c60 = new Set(); dates.forEach((d) => A(d).forEach((x) => c60.add(x)));
  const mark = K === sel.LOOKBACK_DAYS ? "  <- shipped" : "";
  console.log(
      `  ${String(K).padStart(2)}  ${(tot / dates.length).toFixed(2).padStart(5)} / ${String(worst).padStart(5)}  ` +
      `${String(rep).padStart(7)}  ${String(c30.size).padStart(12)}  ${String(c60.size).padStart(12)}${mark}`);
}

console.log(`\n  legacy algorithm, for reference:  drift 8.37 / 9   repeats 0   157 distinct/30d`);
