#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fetch-real-logos.mjs — Pull real course logos from Brandfetch.
// ─────────────────────────────────────────────────────────────────────────────
// For each course in bingo-courses.js, query Brandfetch's search API for the
// most likely brand match, then download the highest-quality PNG/SVG it
// returns and save to /assets/logos/{course-id}.{png|svg}.
//
// This script is incremental: any course that already has a real-logo file
// (one not produced by generate-lettermarks.mjs — i.e. PNG or non-lettermark
// SVG) is skipped. The lettermark .svg fallback is intentionally NOT treated
// as "already has a real logo" — it's a placeholder.
//
// Requires environment variable BRANDFETCH_API_KEY. The script logs a friendly
// message and exits 0 if it's missing, so CI can no-op safely.
//
// Usage:
//   BRANDFETCH_API_KEY=xxx node scripts/fetch-real-logos.mjs
//   BRANDFETCH_API_KEY=xxx node scripts/fetch-real-logos.mjs --only=augusta-national,pebble-beach
//   BRANDFETCH_API_KEY=xxx node scripts/fetch-real-logos.mjs --dry-run
// ─────────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir, stat, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COURSES } from '../bingo-courses.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'assets/logos');
const SEARCH_URL = (q) => `https://api.brandfetch.io/v2/search/${encodeURIComponent(q)}`;

const args = parseArgs(process.argv.slice(2));
const API_KEY = process.env.BRANDFETCH_API_KEY;

function parseArgs(argv) {
  const out = { only: null, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--only=')) out.only = new Set(a.slice('--only='.length).split(','));
  }
  return out;
}

async function exists(path) {
  try { await access(path, FS.F_OK); return true; }
  catch { return false; }
}

// A "real" logo is a PNG OR an SVG that does NOT contain our lettermark
// signature (the comment + radial gradient id 'g' is a tell). We treat the
// lettermark .svg as a placeholder so this script can upgrade it to a real
// asset.
async function alreadyHasRealLogo(courseId) {
  const png = resolve(OUT_DIR, `${courseId}.png`);
  if (await exists(png)) return true;
  // Lettermark SVGs we generate aren't "real" — skip detection.
  return false;
}

// Pick the best logo URL from a Brandfetch result entry.
// Brandfetch search returns entries shaped like:
//   { name, domain, claimed, icon, brandId }
// To get logo files we typically follow up with /v2/brands/{domain} which
// returns `logos: [{ formats: [{ src, format, ... }] }]`. We do that here in
// one extra request per course and pick the highest-priority format.
async function pickLogoForBrand(brandDomain) {
  const url = `https://api.brandfetch.io/v2/brands/${encodeURIComponent(brandDomain)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`brand fetch ${brandDomain}: HTTP ${resp.status}`);
  const data = await resp.json();
  // Prefer logo (over icon/symbol/other) and within that, prefer SVG > PNG.
  const logos = Array.isArray(data.logos) ? data.logos : [];
  const ordered = [...logos].sort((a, b) => {
    const score = (l) => (l.type === 'logo' ? 0 : l.type === 'symbol' ? 1 : 2);
    return score(a) - score(b);
  });
  for (const l of ordered) {
    const formats = Array.isArray(l.formats) ? l.formats : [];
    const fmt =
      formats.find((f) => f.format === 'svg') ||
      formats.find((f) => f.format === 'png') ||
      formats[0];
    if (fmt && fmt.src) return { src: fmt.src, format: fmt.format || 'png' };
  }
  return null;
}

async function searchBrand(query) {
  const resp = await fetch(SEARCH_URL(query), {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`search "${query}": HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  // Take the first claimed result if available, else the first overall.
  return data.find((e) => e.claimed) || data[0];
}

async function downloadTo(url, outPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download ${url}: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(outPath, buf);
  return buf.length;
}

async function main() {
  if (!API_KEY) {
    console.log(`\nfetch-real-logos: BRANDFETCH_API_KEY not set.\n`);
    console.log(`To run this script:`);
    console.log(`  1. Get an API key at https://developers.brandfetch.com`);
    console.log(`  2. Run: BRANDFETCH_API_KEY=your_key node scripts/fetch-real-logos.mjs\n`);
    console.log(`The script will skip any course that already has a real PNG logo,`);
    console.log(`so it's safe to run incrementally.\n`);
    process.exit(0);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const targets = COURSES.filter((c) => !args.only || args.only.has(c.id));
  console.log(`fetch-real-logos: ${targets.length} courses to consider`);
  if (args.dryRun) console.log(`(dry-run — no files will be written)`);

  const ok = [];
  const skipped = [];
  const failed = [];

  for (const course of targets) {
    if (await alreadyHasRealLogo(course.id)) {
      skipped.push({ id: course.id, reason: 'already has real logo' });
      continue;
    }
    // Build a query likely to produce the right brand match.
    // Many courses share names with churches/places, so include "golf".
    const query = `${course.shortName} golf`;
    try {
      const hit = await searchBrand(query);
      if (!hit) {
        failed.push({ id: course.id, reason: `no search hit for "${query}"` });
        continue;
      }
      const logo = await pickLogoForBrand(hit.domain);
      if (!logo) {
        failed.push({ id: course.id, reason: `brand ${hit.domain} has no logo files` });
        continue;
      }
      const ext = (logo.format && ['svg', 'png'].includes(logo.format)) ? logo.format : extname(logo.src).slice(1) || 'png';
      const outPath = resolve(OUT_DIR, `${course.id}.${ext}`);

      if (args.dryRun) {
        ok.push({ id: course.id, domain: hit.domain, src: logo.src, ext, bytes: 0 });
        continue;
      }

      const bytes = await downloadTo(logo.src, outPath);
      ok.push({ id: course.id, domain: hit.domain, src: logo.src, ext, bytes });
      console.log(`  ✓ ${course.id.padEnd(28)} ← ${hit.domain.padEnd(28)} (${ext}, ${bytes}b)`);

      // Be polite to the API.
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed.push({ id: course.id, reason: err.message });
      console.log(`  ✗ ${course.id.padEnd(28)} ${err.message}`);
    }
  }

  console.log(`\n────────────────────────────────`);
  console.log(`Downloaded: ${ok.length}`);
  console.log(`Skipped:    ${skipped.length} (already had real logo)`);
  console.log(`Failed:     ${failed.length}`);
  if (failed.length) {
    console.log(`\nFailures:`);
    for (const f of failed) console.log(`  ${f.id}: ${f.reason}`);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
