#!/usr/bin/env node
/**
 * scripts/check-bingo-single-source.mjs
 *
 * CI guard for LOGO_BINGO_DIAGNOSIS.md. Fails the build if any of:
 *
 *   1. iOS native Swift/Obj-C code attempts to bundle a course logo
 *      into Assets.xcassets (would create a second source of bytes
 *      that can silently drift from the CDN).
 *   2. iOS native Swift/Obj-C code references "bingo" or "logoBingo"
 *      or implements a daily-puzzle picker. Native code MUST NOT
 *      perform client-side puzzle generation — that's the bug we're
 *      preventing the recurrence of.
 *   3. The dailySeed() function in index.html is invoked from any
 *      production code path WITHOUT the `__bingoPuzzleStale = true`
 *      offline-fallback marker on the same logical line / nearby.
 *      Catches a future refactor that removes the server-fetch and
 *      "fixes" the local recompute.
 *   4. functions/data/bingo-puzzle-data.json is out of sync with
 *      /bingo-courses.js + /assets/logos/manifest.js (rerun the
 *      generator: `node functions/scripts/generate-bingo-canon.mjs`).
 *
 * Exit codes:
 *   0  all checks pass
 *   1  one or more violations
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const violations = [];

function note(rule, file, message) {
  violations.push({rule, file, message});
}

// ── Walk iOS native source for bingo references ──────────────────────────
function walkDir(dir, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = resolve(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "Pods" || name === "build" || name === "DerivedData") continue;
      walkDir(full, predicate, out);
    } else if (predicate(name)) {
      out.push(full);
    }
  }
  return out;
}

// Check 1 + 2: native iOS sources should not mention bingo.
const iosDir = resolve(REPO_ROOT, "ios", "App", "App");
const nativeFiles = walkDir(
    iosDir,
    (n) => /\.(swift|m|mm|h)$/.test(n),
);
const BINGO_PATTERN = /\b(bingo|logoBingo|dailyPuzzle|dailySeed|courseLogo)\b/i;
for (const file of nativeFiles) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (BINGO_PATTERN.test(src)) {
    note(
        "no-native-bingo-code",
        relative(REPO_ROOT, file),
        "native iOS source references bingo / dailyPuzzle / dailySeed — " +
        "the WebView is the only bingo runtime; native code must not " +
        "implement puzzle generation or logo selection.");
  }
}

// Check 1 (assets): the Assets.xcassets should not contain anything
// that looks like a course logo. We accept AppIcon* and Splash*.
const assetCatalog = resolve(iosDir, "Assets.xcassets");
const assetEntries = (() => {
  try {
    return readdirSync(assetCatalog);
  } catch {
    return [];
  }
})();
for (const entry of assetEntries) {
  if (entry === "Contents.json") continue;
  if (entry.startsWith("AppIcon") || entry.startsWith("Splash")) continue;
  // We'd see imageset / colorset / etc. for app-shell assets; flag any
  // imageset whose name looks like a course slug.
  if (entry.endsWith(".imageset")) {
    const slug = entry.replace(/\.imageset$/, "");
    // Course slugs are kebab-case lowercase; AppIcon-like names contain
    // capitals. Cheap heuristic catches accidental bundling.
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(slug)) {
      note(
          "no-logo-imageset",
          relative(REPO_ROOT, resolve(assetCatalog, entry)),
          `imageset name "${slug}" looks like a course slug — Logo Bingo ` +
          "PNGs must live at /assets/logos/*.png and be served via the " +
          "WebView, NOT bundled in Assets.xcassets.");
    }
  }
}

// Check 3: dailySeed() invocations must be guarded with the stale flag.
// We accept invocations in:
//   - the function definition itself (`function dailySeed(`)
//   - the offline-fallback block, which sets __bingoPuzzleStale = true
//   - the regression test (scripts/test-bingo-cross-platform.mjs has
//     its own webDailySeed implementation, not the SPA's)
//   - the initial game state (game.courses = dailySeed(TODAY)) which
//     is the synchronous placeholder before async loadTodaysBingoPuzzle
//     replaces it — that placeholder is fine, but it MUST be followed
//     within the same module by an await loadTodaysBingoPuzzle() call.
const indexHtmlPath = resolve(REPO_ROOT, "index.html");
const indexSrcRaw = readFileSync(indexHtmlPath, "utf8");
// Strip JS line comments, JS block comments, and HTML comments so call-site
// detection ignores the dozens of `// dailySeed()` references in the
// architecture comments we just wrote.
const indexSrc = indexSrcRaw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const dailySeedCalls = [];
const dailySeedRegex = /\bdailySeed\s*\(/g;
let m;
while ((m = dailySeedRegex.exec(indexSrc)) !== null) {
  // Skip the function definition.
  const before = indexSrc.slice(Math.max(0, m.index - 32), m.index);
  if (/function\s*$/.test(before)) continue;
  dailySeedCalls.push(m.index);
}
let mustHaveStaleMarker = 0;
for (const idx of dailySeedCalls) {
  const window = indexSrc.slice(Math.max(0, idx - 200), idx + 400);
  const isInitialSeed = /game\s*=\s*\{[^}]*courses\s*:\s*dailySeed\s*\(/.test(window);
  const isReseedOnDayRoll = /game\.date\s*=\s*t\s*;\s*game\.courses\s*=\s*dailySeed/.test(window);
  if (isInitialSeed || isReseedOnDayRoll) continue;
  // Otherwise must be near a stale marker.
  if (!/__bingoPuzzleStale\s*=\s*true/.test(window)) {
    mustHaveStaleMarker += 1;
  }
}
if (mustHaveStaleMarker > 0) {
  note(
      "dailySeed-needs-stale-marker",
      "index.html",
      `${mustHaveStaleMarker} dailySeed() call(s) in index.html are not ` +
      "near a `__bingoPuzzleStale = true` marker. Either wrap the call " +
      "in the offline-fallback block, or remove it — production code " +
      "must fetch dailyPuzzles/{date} from Firestore, not recompute.");
}

// Also: loadTodaysBingoPuzzle must call fetchServerDailyPuzzle.
if (!/fetchServerDailyPuzzle/.test(indexSrc)) {
  note(
      "loadTodaysBingoPuzzle-needs-server-fetch",
      "index.html",
      "fetchServerDailyPuzzle() is missing — the client refactor was " +
      "reverted? See LOGO_BINGO_DIAGNOSIS.md.");
}

// Check 4: bingo-puzzle-data.json is in sync with the canonical sources.
const canonPath = resolve(REPO_ROOT, "functions", "data", "bingo-puzzle-data.json");
if (!existsSync(canonPath)) {
  note(
      "canon-json-missing",
      relative(REPO_ROOT, canonPath),
      "functions/data/bingo-puzzle-data.json is missing — run " +
      "`node functions/scripts/generate-bingo-canon.mjs`.");
} else {
  try {
    const canon = JSON.parse(readFileSync(canonPath, "utf8"));
    // Parse the web manifest cheaply via dynamic import; we already
    // know it's a small file.
    const manifestMod = await import(
        resolve(REPO_ROOT, "assets", "logos", "manifest.js"));
    const coursesMod = await import(resolve(REPO_ROOT, "bingo-courses.js"));
    const expected = coursesMod.COURSES
        .filter((c) => manifestMod.LOGOS_AVAILABLE.has(c.id))
        .map((c) => c.id);
    const actual = canon.courses.map((c) => c.id);
    if (expected.length !== actual.length) {
      note(
          "canon-json-out-of-sync",
          relative(REPO_ROOT, canonPath),
          `canon has ${actual.length} courses but web sees ${expected.length} ` +
          "— rerun `npm run build:bingo-canon` (in functions/).");
    } else {
      for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== actual[i]) {
          note(
              "canon-json-out-of-sync",
              relative(REPO_ROOT, canonPath),
              `canon[${i}]=${actual[i]} but web=${expected[i]} — rerun ` +
              "`npm run build:bingo-canon` (in functions/).");
          break;
        }
      }
    }
  } catch (err) {
    note(
        "canon-json-parse-error",
        relative(REPO_ROOT, canonPath),
        err && err.message || String(err));
  }
}

// ── Report ────────────────────────────────────────────────────────────────
if (violations.length === 0) {
  console.log("[check-bingo-single-source] OK — no violations.");
  process.exit(0);
}
console.error(`[check-bingo-single-source] ${violations.length} violation(s):`);
for (const v of violations) {
  console.error(`  - [${v.rule}] ${v.file}: ${v.message}`);
}
process.exit(1);
