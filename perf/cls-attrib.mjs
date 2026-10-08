#!/usr/bin/env node
/**
 * perf/cls-attrib.mjs — which ELEMENTS are shifting, straight from Lighthouse.
 *
 *   node perf/cls-attrib.mjs            # warm (the reproducible one)
 *   node perf/cls-attrib.mjs --cold
 *
 * A CLS number says nothing about what to fix. This prints Lighthouse's own
 * layout-shifts audit: one row per shift, the node that moved, and its score.
 * Use it before changing anything, and again after, to prove the shift you
 * targeted is actually the one that went away.
 *
 * Note: perf/investigate.mjs `shifts` uses a PerformanceObserver under CDP
 * throttling and can disagree — it reported 0 shifts on a page Lighthouse
 * scored 0.051, because the two apply throttling differently. When they
 * disagree, Lighthouse is the number we report, so this is the authority.
 */
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {baseConfig} from './lh-config.mjs';

const COLD = process.argv.includes('--cold');
const url = process.argv.find((a) => a.startsWith('http')) || 'https://teeboxmarket.com/';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcls-'));
const chrome = await chromeLauncher.launch({userDataDir: dir, chromeFlags: [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage']});
try {
  if (!COLD) await lighthouse(url, {port: chrome.port, output: 'json', logLevel: 'silent'}, baseConfig);
  const res = await lighthouse(url, {port: chrome.port, output: 'json', logLevel: 'silent',
    ...(COLD ? {} : {disableStorageReset: true})}, baseConfig);
  const a = res.lhr.audits;
  console.log(`\n  ${COLD ? 'cold' : 'warm'}  CLS ${a['cumulative-layout-shift'].numericValue.toFixed(4)}\n`);
  const items = ((a['layout-shifts'] || {}).details || {}).items || [];
  if (!items.length) console.log('  no shifts recorded');
  for (const it of items) {
    const n = it.node || {};
    console.log(`  ${it.score.toFixed(4)}  ${(n.selector || n.snippet || '?').slice(0, 76)}`);
  }
  console.log('');
} finally {
  await chrome.kill();
  try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5}); } catch {}
  process.exit(0);
}
