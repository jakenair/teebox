#!/usr/bin/env node
/**
 * perf/measure.mjs — the only sanctioned way to measure TeeBox performance.
 *
 *   node perf/measure.mjs                              # default: logged-out, both states
 *   node perf/measure.mjs --url https://teeboxmarket.com/
 *   node perf/measure.mjs --runs 5 --state logged-out-cold
 *   node perf/measure.mjs --json perf/results/r324.json
 *
 * Reports MEDIAN and SPREAD, never a single run. If LCP spread exceeds 20% of
 * the median the result is marked UNSTABLE and must not be used to justify a
 * change — see the note at the top of lh-config.mjs for why that rule exists.
 *
 * The auth gate is NEVER dismissed. A logged-out visitor sees it; that is the
 * page. To measure the signed-in experience, supply a test account (see
 * perf/README.md) — do not fake it by clicking through the gate.
 */

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {baseConfig, STATES, TARGETS, STABILITY_THRESHOLD, CLS_ABS_THRESHOLD,
  MIN_RUNS} from './lh-config.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL_ = arg('url', 'https://teeboxmarket.com/');
const RUNS = Number(arg('runs', 5));
const ONLY = arg('state', null);
const JSON_OUT = arg('json', null);
const ATTEMPTS_PER_RUN = 3;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ONE = path.join(HERE, 'run-one.mjs');

/**
 * One sample, in its own process.
 *
 * Lighthouse keeps the full trace and LHR alive for the life of the process, so
 * a 5x2 baseline in a single process died with "Ineffective mark-compacts near
 * heap limit" (exit 134) after roughly nine passes. A child per run bounds the
 * heap and contains a dead renderer to the one sample it killed.
 */
function runOnce(url, {warm}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RUN_ONE, url, warm ? 'warm' : 'cold'],
        {timeout: 240000, maxBuffer: 1 << 22}, (err, stdout) => {
          if (err && !stdout) return reject(new Error(err.killed ? 'run timed out' : err.message));
          let r;
          try { r = JSON.parse(String(stdout).trim()); } catch {
            return reject(new Error('child produced no JSON: ' + String(stdout).slice(0, 60)));
          }
          r.ok ? resolve(r) : reject(new Error(r.error));
        });
  });
}

async function measureState(name) {
  const cfg = STATES[name];
  if (cfg.auth) {
    console.log(`  ${name}: SKIPPED — needs a test account, see perf/README.md`);
    return null;
  }
  const rows = [];
  let lost = 0;
  for (let i = 0; i < RUNS; i++) {
    let got = null, lastErr = '';
    for (let t = 1; t <= ATTEMPTS_PER_RUN && !got; t++) {
      process.stdout.write(`  ${name}: run ${i + 1}/${RUNS}${t > 1 ? ` (attempt ${t})` : ''}      \r`);
      try { got = await runOnce(URL_, cfg); } catch (e) { lastErr = String(e && e.message).slice(0, 60); }
    }
    if (got) rows.push(got);
    else { lost++; console.log(`  ${name}: run ${i + 1} LOST after ${ATTEMPTS_PER_RUN} attempts — ${lastErr}`); }
  }
  if (!rows.length) return null;
  const out = {state: name, runs: rows.length, requested: RUNS, lost, metrics: {}, samples: rows};
  for (const k of ['FCP', 'LCP', 'CLS', 'TBT', 'SI', 'score']) {
    const vals = rows.map((r) => r[k]);
    const med = k === 'CLS'
      ? +(median(vals.map((v) => v * 1000)) / 1000).toFixed(3)
      : median(vals);
    out.metrics[k] = {median: med, min: Math.min(...vals), max: Math.max(...vals)};
  }
  // A set is trustworthy only if EVERY metric a change could be judged on is
  // reproducible. Gating on LCP alone let a set through whose CLS ranged
  // 0.014-0.405 — a 29x swing — labelled "stable".
  out.spread = {};
  const bad = [];
  for (const k of ['LCP', 'FCP', 'TBT']) {
    const m = out.metrics[k];
    out.spread[k] = m.median ? (m.max - m.min) / m.median : 0;
    if (out.spread[k] > STABILITY_THRESHOLD) bad.push(`${k} ${(out.spread[k] * 100).toFixed(0)}%`);
  }
  // CLS is a ratio of nothing useful near zero, so judge it in absolute terms
  // against the target itself: a run-to-run swing as big as the budget is noise.
  const c = out.metrics.CLS;
  out.spread.CLS = +(c.max - c.min).toFixed(3);
  if (out.spread.CLS > CLS_ABS_THRESHOLD) bad.push(`CLS \u00b1${out.spread.CLS}`);
  if (rows.length < MIN_RUNS) {
    bad.push(lost ? `n=${rows.length}, ${lost} run(s) lost — below the ${MIN_RUNS} minimum`
                  : `n=${rows.length} is below the ${MIN_RUNS}-run minimum — pass --runs 5`);
  }
  out.lcpSpread = out.spread.LCP;
  out.unstableBecause = bad;
  out.stable = bad.length === 0;
  return out;
}

(async () => {
  console.log(`\n  URL   ${URL_}`);
  console.log(`  runs  ${RUNS} per state, Lighthouse mobile preset (slow 4G, 4x CPU)\n`);
  const results = [];
  for (const name of Object.keys(STATES)) {
    if (ONLY && name !== ONLY) continue;
    const r = await measureState(name);
    if (r) results.push(r);
  }
  console.log('\n  state              FCP            LCP            CLS          TBT      score  n  stable');
  for (const r of results) {
    const f = (k, pad = 6) => {
      const m = r.metrics[k];
      return `${String(m.median).padStart(pad)} (${m.min}-${m.max})`.padEnd(16);
    };
    console.log(`  ${r.state.padEnd(18)} ${f('FCP')} ${f('LCP')} ${f('CLS', 5)} ${f('TBT')} ` +
                `${String(r.metrics.score.median).padStart(3)}    ${r.runs}  ${r.stable ? 'yes' : 'NO'}`);
  }
  for (const r of results) {
    if (r.lost) console.log(`\n  ⚠ ${r.state}: ${r.lost} of ${r.requested} runs lost to renderer crashes — n=${r.runs}.`);
    if (!r.stable) {
      console.log(`\n  ⚠ ${r.state}: UNSTABLE — ${r.unstableBecause.join(', ')}`);
      console.log(`    Do not use this set to justify a change. Fix the harness or the page first.`);
      console.log(`    LCP: ${r.samples.map((s) => s.LCP).join(', ')}`);
      console.log(`    FCP: ${r.samples.map((s) => s.FCP).join(', ')}`);
      console.log(`    CLS: ${r.samples.map((s) => s.CLS).join(', ')}`);
    }
  }
  console.log(`\n  targets  LCP<${TARGETS.LCP} CLS<${TARGETS.CLS} TBT<${TARGETS.TBT}`);
  console.log('  LCP element: run `node perf/investigate.mjs frames` — Lighthouse 13 has no such audit.');
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), {recursive: true});
    fs.writeFileSync(JSON_OUT, JSON.stringify({url: URL_, at: new Date().toISOString(), results}, null, 2));
    console.log(`\n  wrote ${JSON_OUT}`);
  }
})();
