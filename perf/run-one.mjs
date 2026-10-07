#!/usr/bin/env node
/**
 * perf/run-one.mjs — ONE Lighthouse pass, printed as a single JSON line.
 *
 *   node perf/run-one.mjs <url> [warm]
 *
 * Deliberately a separate process per run. Lighthouse keeps the whole trace and
 * LHR alive, so a dozen passes in one process exhausted the V8 heap (exit 134)
 * on the first attempt at a 5x2 baseline. A child per run also means a dead
 * renderer kills only that sample. The parent (measure.mjs) aggregates.
 */
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {baseConfig} from './lh-config.mjs';

const URL_ = process.argv[2];
const WARM = process.argv[3] === 'warm';
const FLAGS = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-dev-shm-usage', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--mute-audio',
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-perf-'));
let chrome;
try {
  chrome = await chromeLauncher.launch({chromeFlags: FLAGS, userDataDir: dir});
  // A warm run is a REVISIT: prime the service worker and HTTP cache with a
  // throwaway load in this same browser, then measure the second load with
  // storage reset disabled so the cache survives into it.
  if (WARM) {
    await lighthouse(URL_, {port: chrome.port, output: 'json', logLevel: 'silent'}, baseConfig);
  }
  const res = await lighthouse(URL_, {
    port: chrome.port, output: 'json', logLevel: 'silent',
    ...(WARM ? {disableStorageReset: true} : {}),
  }, baseConfig);
  if (res.lhr.runtimeError) throw new Error(res.lhr.runtimeError.code);
  const a = res.lhr.audits;
  process.stdout.write(JSON.stringify({
    ok: true,
    FCP: Math.round(a['first-contentful-paint'].numericValue),
    LCP: Math.round(a['largest-contentful-paint'].numericValue),
    CLS: +a['cumulative-layout-shift'].numericValue.toFixed(3),
    TBT: Math.round(a['total-blocking-time'].numericValue),
    SI: Math.round(a['speed-index'].numericValue),
    score: Math.round((res.lhr.categories.performance.score || 0) * 100),
  }));
} catch (e) {
  process.stdout.write(JSON.stringify({ok: false, error: String(e && e.message).slice(0, 90)}));
} finally {
  try { await chrome?.kill(); } catch {}
  fs.rmSync(dir, {recursive: true, force: true});
  // A dead renderer leaves rejections queued behind the awaits above; exiting
  // explicitly stops them resurfacing as an exit-1 after we have our sample.
  process.exit(0);
}
