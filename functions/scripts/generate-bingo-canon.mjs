#!/usr/bin/env node
/**
 * functions/scripts/generate-bingo-canon.mjs
 *
 * Builds functions/data/bingo-puzzle-data.json from the canonical source
 * files at the repo root:
 *   - /bingo-courses.js              (ESM — exports COURSES + courseLogoUrl)
 *   - /assets/logos/manifest.js      (ESM — exports LOGOS_AVAILABLE)
 *
 * The JSON output is what the Cloud Function `generateDailyBingoPuzzle`
 * reads at request time so both the function and the web client are
 * guaranteed to be operating on byte-identical course pools.
 *
 * Wired into `functions/package.json -> predeploy` so every deploy
 * regenerates this file fresh from the repo's web-client sources.
 *
 * Why a JSON intermediate? Cloud Functions only deploys files in the
 * functions/ directory; the canonical sources live at the repo root.
 * Reading the JSON sidesteps that with a single, easy-to-diff artifact.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const OUT_PATH = resolve(__dirname, "..", "data", "bingo-puzzle-data.json");

// Where the puzzle doc points its absolute logo URLs.
//
// These are absolute ON PURPOSE: an iOS build carries its own copy of every
// PNG, and those drift the moment a logo is re-framed or retired. An absolute
// URL lets a stale app render the CURRENT artwork. Do not make these relative
// — a relative path resolves against the app's own bundle, which is exactly
// the stale copy this exists to bypass.
//
// 2026-10-02: moved from https://teeboxmarket.com to Firebase Storage. The
// teeboxmarket.com URLs had NEVER worked in the app: index.html's CSP did not
// list that origin, and inside the WebView 'self' is capacitor://localhost, so
// every tile failed its probe and silently fell back to the bundled PNG. That
// is why Logo Bingo looked different on web and iOS. r297 added
// teeboxmarket.com to img-src, but a CSP ships inside the bundle, so it only
// helps from the next build onward — whereas firebasestorage.googleapis.com is
// already in the CSP of every build ever shipped. Serving from Storage fixes
// logo drift on phones people already have, with no rebuild.
//
// Bytes are published by scripts/upload-logos-to-storage.mjs; public read is
// granted by the course-logos/ block in storage.rules, and no client can write
// there. Objects are immutable with a one-year max-age.
const LOGO_BUCKET = process.env.LOGO_BUCKET || "teebox-market.firebasestorage.app";
const LOGO_PREFIX = process.env.LOGO_PREFIX || "course-logos";

// Set LOGO_CDN_ORIGIN to fall back to the old {origin}/assets/logos/{id}.png
// shape (e.g. for a local build with no Storage access).
const CDN_ORIGIN = process.env.LOGO_CDN_ORIGIN || "";

function logoUrlFor(id) {
  if (CDN_ORIGIN) return `${CDN_ORIGIN}/assets/logos/${id}.png`;
  const encoded = encodeURIComponent(`${LOGO_PREFIX}/${id}.png`);
  return `https://firebasestorage.googleapis.com/v0/b/${LOGO_BUCKET}/o/${encoded}?alt=media`;
}

async function main() {
  const coursesMod = await import(
    resolve(REPO_ROOT, "bingo-courses.js")
  );
  const manifestMod = await import(
    resolve(REPO_ROOT, "assets", "logos", "manifest.js")
  );
  if (!Array.isArray(coursesMod.COURSES)) {
    throw new Error("COURSES export missing from bingo-courses.js");
  }
  if (!(manifestMod.LOGOS_AVAILABLE instanceof Set)) {
    throw new Error("LOGOS_AVAILABLE Set missing from manifest.js");
  }

  // Filter to courses that have a real PNG logo — same filter the web
  // client applies. Keep only the minimal fields the puzzle generator
  // needs (id, shortName) plus the canonical CDN URL we want the doc
  // to carry.
  const eligible = [];
  // Sidecar answer-key terms. The `courses` array above is kept minimal +
  // byte-stable (the puzzle generator hashes/orders it), so the strings the
  // server needs to SCORE a guess (name + aliases) live in a separate map
  // keyed by id. Server-side scoring (functions/lib/bingoScoring.js) reads
  // these to re-derive correctCount; the client reads the same fields from
  // /bingo-courses.js, so client↔server term parity holds by construction.
  const courseData = {};
  for (const c of coursesMod.COURSES) {
    if (!c || typeof c.id !== "string") continue;
    if (!manifestMod.LOGOS_AVAILABLE.has(c.id)) continue;
    eligible.push({
      id: c.id,
      shortName: c.shortName || c.name || c.id,
      logoUrl: logoUrlFor(c.id),
    });
    courseData[c.id] = {
      name: c.name || c.shortName || c.id,
      shortName: c.shortName || c.name || c.id,
      aliases: Array.isArray(c.aliases) ? c.aliases.slice() : [],
    };
  }

  if (eligible.length < 9) {
    throw new Error(
      `Only ${eligible.length} eligible courses — need >= 9 for a puzzle.`,
    );
  }

  const payload = {
    // Version stamp — bumping this string in the future invalidates all
    // cached client puzzles and reshuffles the daily window.
    seed: "teebox-bingo-canon-v3",
    // UTC midnight on the epoch day. dailySeed() in index.html uses this
    // exact value; keeping it in sync is enforced by the regression
    // test (see scripts/test-bingo-cross-platform.mjs).
    epoch: "2026-01-01T00:00:00Z",
    courses: eligible,
    courseData,
    generatedAt: new Date().toISOString(),
    sourceFiles: ["bingo-courses.js", "assets/logos/manifest.js"],
    cdnOrigin: CDN_ORIGIN || `gs://${LOGO_BUCKET}/${LOGO_PREFIX}`,
  };

  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `[generate-bingo-canon] wrote ${eligible.length} courses to ${OUT_PATH}`,
  );
}

main().catch((err) => {
  console.error("[generate-bingo-canon] failed:", err);
  process.exitCode = 1;
});
