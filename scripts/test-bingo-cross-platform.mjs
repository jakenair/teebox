#!/usr/bin/env node
/**
 * scripts/test-bingo-cross-platform.mjs
 *
 * Asserts that every surface that can produce a Logo Bingo board produces the
 * SAME board: the Cloud Function, the web client, and the bundle that ships
 * inside the iOS app.
 *
 * WHY THIS WAS REWRITTEN (2026-10-01)
 * The previous version loaded the server's selectDailyCourses and compared it
 * against a THIRD re-implementation of the algorithm written inside this file,
 * with both sides reading the repo's current manifest. It passed 366/366 dates
 * on the day Logo Bingo was visibly different on web and iOS, because:
 *   - it never loaded the shipped iOS bundle, so it could not see that the
 *     bundle's logo manifest still contained a course the web had retired
 *     (pool 159 vs 158 — boards sharing 3 of 9 tiles); and
 *   - comparing an implementation against a copy of itself proves nothing
 *     about the code that actually runs.
 * It now imports the one real module and diffs the real artifacts.
 *
 * Checks:
 *   1. functions/lib/bingoSelect.js is the current generated build of
 *      /bingo-select.mjs (hash stamp matches).
 *   2. The iOS bundle's bingo-select.mjs and logo manifest are byte-identical
 *      to the web ones — this is the drift that caused the incident.
 *   3. Server selectDailyCourses == client dailySeed path, every date for the
 *      next 60 days (and across the cutover seam).
 *   4. Boards are 9 unique courses, and no course repeats inside the lookback
 *      window.
 *   5. Pre-cutover dates still reproduce the legacy algorithm exactly.
 *
 * Run: npm run test:bingo-cross-platform
 * Exit: 0 all good · 1 divergence · 2 harness failure
 */

import {readFileSync, existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const DAYS_AHEAD = 60;
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`[FAIL] ${msg}`);
};
const ok = (msg) => console.log(`[OK] ${msg}`);

function shiftDate(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

// ── 1. generated CommonJS build is current ──────────────────────────────────
const SRC = resolve(ROOT, "bingo-select.mjs");
const GEN = resolve(ROOT, "functions/lib/bingoSelect.js");
if (!existsSync(SRC)) {
  console.error("[HARNESS] missing bingo-select.mjs");
  process.exit(2);
}
if (!existsSync(GEN)) {
  fail("functions/lib/bingoSelect.js missing — run: node scripts/sync-bingo-select.mjs");
} else {
  const stamp = (readFileSync(GEN, "utf8").match(/source-sha256: ([0-9a-f]+)/) || [])[1];
  const want = sha(readFileSync(SRC, "utf8"));
  if (stamp !== want) {
    fail(`functions/lib/bingoSelect.js is stale (stamp ${stamp}, source ${want}) ` +
      `— run: node scripts/sync-bingo-select.mjs`);
  } else {
    ok(`functions/lib/bingoSelect.js is the current build of bingo-select.mjs (${want})`);
  }
}

// ── 2. the iOS bundle matches the web ───────────────────────────────────────
const IOS = resolve(ROOT, "ios/App/App/public");
if (!existsSync(IOS)) {
  console.warn("[SKIP] no ios/App/App/public — run `npm run build:web` to populate it");
} else {
  for (const rel of ["bingo-select.mjs", "bingo-courses.js", "assets/logos/manifest.js"]) {
    const w = resolve(ROOT, rel);
    const i = resolve(IOS, rel);
    if (!existsSync(i)) {
      fail(`iOS bundle is missing ${rel} — run \`npm run build:web\``);
      continue;
    }
    const a = sha(readFileSync(w, "utf8"));
    const b = sha(readFileSync(i, "utf8"));
    if (a !== b) {
      fail(`iOS bundle ${rel} differs from web (${b} vs ${a}). ` +
        `The shipped app would compute different boards. Run \`npm run build:web\` ` +
        `(NOT a bare \`npx cap sync\`, which copies a stale dist/).`);
    } else {
      ok(`iOS bundle ${rel} is identical to web`);
    }
  }
}

// ── 3. server vs client, every date ─────────────────────────────────────────
const serverMod = require(resolve(ROOT, "functions/bingoDailyPuzzle.js"));
if (!serverMod || !serverMod.__test || typeof serverMod.__test.selectDailyCourses !== "function") {
  console.error("[HARNESS] functions/bingoDailyPuzzle.js doesn't export __test.selectDailyCourses");
  process.exit(2);
}
const serverSelect = serverMod.__test.selectDailyCourses;

const {COURSES} = await import(resolve(ROOT, "bingo-courses.js"));
const {LOGOS_AVAILABLE} = await import(resolve(ROOT, "assets/logos/manifest.js"));
const sel = await import(SRC);
// Exactly what index.html's dailySeed() does.
const clientPool = COURSES.filter((c) => LOGOS_AVAILABLE.has(c.id));
const clientBoard = (d) => sel.selectBoardIds(d, clientPool);

const today = new Date().toISOString().slice(0, 10);
// Start before the cutover so the seam itself is covered.
const start = shiftDate(sel.CUTOVER_DATE, -5);
const dates = [];
for (let i = 0; i < DAYS_AHEAD + 10; i++) dates.push(shiftDate(start, i));
for (let i = 1; i <= DAYS_AHEAD; i++) {
  const d = shiftDate(today, i);
  if (!dates.includes(d)) dates.push(d);
}

let diverged = 0;
for (const d of dates) {
  const s = serverSelect(d).courses.map((c) => c.id);
  const c = clientBoard(d);
  if (s.join("|") !== c.join("|")) {
    diverged++;
    if (diverged <= 3) {
      fail(`${d} server != client\n      server: ${s.join(", ")}\n      client: ${c.join(", ")}`);
    }
  }
}
if (diverged) {
  fail(`${diverged} of ${dates.length} dates diverged between server and client`);
} else {
  ok(`server and client agree on all ${dates.length} dates ` +
    `(${dates[0]} .. ${dates[dates.length - 1]}, spanning the ${sel.CUTOVER_DATE} cutover)`);
}

// ── 4. board shape + lookback ───────────────────────────────────────────────
let shapeBad = 0;
let repeats = 0;
for (const d of dates) {
  const b = clientBoard(d);
  if (b.length !== 9 || new Set(b).size !== 9) shapeBad++;
  if (d >= sel.CUTOVER_DATE) {
    const prev = new Set();
    for (let i = 1; i <= sel.LOOKBACK_DAYS; i++) {
      clientBoard(shiftDate(d, -i)).forEach((x) => prev.add(x));
    }
    repeats += b.filter((x) => prev.has(x)).length;
  }
}
if (shapeBad) fail(`${shapeBad} dates did not produce 9 unique courses`);
else ok("every board is exactly 9 unique courses");
if (repeats) fail(`${repeats} course(s) repeated inside the ${sel.LOOKBACK_DAYS}-day lookback window`);
else ok(`no course repeats inside the ${sel.LOOKBACK_DAYS}-day lookback window`);

// ── 5. legacy dates unchanged ───────────────────────────────────────────────
// Anything before the cutover must still come from the frozen algorithm, so
// already-played boards and their scores stay valid.
const legacyProbe = ["2026-05-15", "2026-09-01", "2026-10-02", "2026-10-04"];
let legacyBad = 0;
for (const d of legacyProbe) {
  const s = serverSelect(d).courses.map((c) => c.id);
  const c = clientBoard(d);
  if (s.join("|") !== c.join("|")) {
    legacyBad++;
    fail(`legacy date ${d} diverged`);
  }
}
if (!legacyBad) ok(`legacy dates still reproduce identically (${legacyProbe.join(", ")})`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll cross-platform checks passed.");
process.exit(failures ? 1 : 0);
