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

// Public CDN origin where the same logo bytes are served from. We pin
// the URL here so the Cloud Function writes canonical URLs into the
// daily puzzle doc — even iOS clients whose bundled copies have drifted
// will then render from the live origin.
const CDN_ORIGIN = process.env.LOGO_CDN_ORIGIN || "https://teeboxmarket.com";

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
  for (const c of coursesMod.COURSES) {
    if (!c || typeof c.id !== "string") continue;
    if (!manifestMod.LOGOS_AVAILABLE.has(c.id)) continue;
    eligible.push({
      id: c.id,
      shortName: c.shortName || c.name || c.id,
      logoUrl: `${CDN_ORIGIN}/assets/logos/${c.id}.png`,
    });
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
    generatedAt: new Date().toISOString(),
    sourceFiles: ["bingo-courses.js", "assets/logos/manifest.js"],
    cdnOrigin: CDN_ORIGIN,
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
