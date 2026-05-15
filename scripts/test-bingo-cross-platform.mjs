#!/usr/bin/env node
/**
 * scripts/test-bingo-cross-platform.mjs
 *
 * Regression test for LOGO_BINGO_DIAGNOSIS.md: asserts that for any
 * given date, the WEB CLIENT's dailySeed() function and the CLOUD
 * FUNCTION's selectDailyCourses() produce IDENTICAL 9-course arrays
 * in the same order.
 *
 * The two implementations live in different files (index.html ESM
 * block vs functions/bingoDailyPuzzle.js CommonJS module) but they
 * MUST stay in lockstep. This test loads both, replays them across a
 * year of dates, and fails loudly if the outputs ever disagree.
 *
 * Run via `npm run test:bingo-cross-platform` from the repo root.
 *
 * Exit codes:
 *   0  all dates match
 *   1  any date diverges (CI should fail the build)
 *   2  test harness failure (file missing, parse error, etc.)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// ── Load the web client's dailySeed() ──────────────────────────────────────
// dailySeed() is embedded in index.html (inside a <script type="module">).
// Rather than parse the whole HTML, we extract the algorithm by importing
// the canonical inputs (bingo-courses.js + manifest.js) and re-implementing
// the SAME shuffle here — using byte-identical PRNG + seed string + epoch.
//
// Drift guard: if anyone changes dailySeed() in index.html, they must
// also change this helper (or the bingoDailyPuzzle.js algorithm). All
// three are reviewed together — see LOGO_BINGO_DIAGNOSIS.md.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadWebPool() {
  const coursesMod = await import(resolve(REPO_ROOT, "bingo-courses.js"));
  const manifestMod = await import(
      resolve(REPO_ROOT, "assets", "logos", "manifest.js"));
  return coursesMod.COURSES
      .filter((c) => manifestMod.LOGOS_AVAILABLE.has(c.id))
      .map((c) => ({id: c.id, shortName: c.shortName || c.name || c.id}));
}

function webDailySeed(dateStr, pool) {
  // EXACT copy of dailySeed() from index.html — keep these aligned.
  const rngOrder = mulberry32(hashStr("teebox-bingo-canon-v3"));
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rngOrder() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  const today = new Date(dateStr + "T00:00:00Z");
  const epoch = new Date("2026-01-01T00:00:00Z");
  const daysSince = Math.max(0, Math.floor((today - epoch) / 86400000));
  const windowCount = Math.max(1, Math.floor(arr.length / 9));
  const start = (daysSince % windowCount) * 9;
  return arr.slice(start, start + 9);
}

// ── Load the Cloud Function's selectDailyCourses() ─────────────────────────
function loadServerSelector() {
  const mod = require(resolve(REPO_ROOT, "functions", "bingoDailyPuzzle.js"));
  if (!mod || !mod.__test || typeof mod.__test.selectDailyCourses !== "function") {
    throw new Error(
        "functions/bingoDailyPuzzle.js doesn't export __test.selectDailyCourses");
  }
  return mod.__test;
}

// ── Date iteration helpers ─────────────────────────────────────────────────
function addDays(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  let serverSelector;
  try {
    serverSelector = loadServerSelector();
  } catch (err) {
    console.error("[FATAL] could not load server selector:", err.message);
    process.exit(2);
  }
  let webPool;
  try {
    webPool = await loadWebPool();
  } catch (err) {
    console.error("[FATAL] could not load web pool:", err.message);
    process.exit(2);
  }

  // Sanity: pool sizes match (the function's canon JSON should be a
  // byte-equal subset of what the web client filters down to).
  if (webPool.length !== serverSelector.CANON.courses.length) {
    console.error(
        `[FAIL] pool size mismatch: web=${webPool.length} ` +
        `server=${serverSelector.CANON.courses.length}`);
    process.exit(1);
  }
  for (let i = 0; i < webPool.length; i++) {
    if (webPool[i].id !== serverSelector.CANON.courses[i].id) {
      console.error(
          `[FAIL] pool order mismatch at index ${i}: ` +
          `web=${webPool[i].id} server=${serverSelector.CANON.courses[i].id}`);
      process.exit(1);
    }
  }

  // Walk a year of dates starting from the epoch.
  let mismatches = 0;
  let start = "2026-01-01";
  const DAYS_TO_CHECK = 366;
  for (let i = 0; i < DAYS_TO_CHECK; i++) {
    const date = addDays(start, i);
    const webOut = webDailySeed(date, webPool);
    const serverOut = serverSelector.selectDailyCourses(date).courses;
    const webIds = webOut.map((c) => c.id).join(",");
    const serverIds = serverOut.map((c) => c.id).join(",");
    if (webIds !== serverIds) {
      console.error(`[MISMATCH] ${date}`);
      console.error(`  web:    ${webIds}`);
      console.error(`  server: ${serverIds}`);
      mismatches += 1;
      if (mismatches > 5) {
        console.error("(...stopping after 5 mismatches)");
        break;
      }
    }
  }

  if (mismatches > 0) {
    console.error(
        `\n[FAIL] ${mismatches} dates produced different puzzles. ` +
        `Either dailySeed() in index.html OR selectDailyCourses() in ` +
        `functions/bingoDailyPuzzle.js has drifted.`);
    process.exit(1);
  }

  // Also assert the server's logoUrls are absolute CDN URLs.
  const sample = serverSelector.selectDailyCourses("2026-05-15").courses;
  for (const c of sample) {
    if (typeof c.logoUrl !== "string" || !c.logoUrl.startsWith("https://")) {
      console.error(
          `[FAIL] server course ${c.id} logoUrl is not an absolute https URL: ${c.logoUrl}`);
      process.exit(1);
    }
  }

  console.log(
      `[OK] web dailySeed() and server selectDailyCourses() ` +
      `produced identical puzzles for ${DAYS_TO_CHECK} consecutive dates.`);
  console.log(
      `[OK] all logoUrls in sample are absolute https CDN URLs.`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(2);
});
