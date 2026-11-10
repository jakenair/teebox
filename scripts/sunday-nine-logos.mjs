#!/usr/bin/env node
/**
 * scripts/sunday-nine-logos.mjs — category marks for the Sunday Nine grid.
 *
 *   node scripts/sunday-nine-logos.mjs            # upload + write data/sunday-nine/logos.json
 *   node scripts/sunday-nine-logos.mjs --dry-run  # show the mapping only
 *
 * Inputs (downloaded once into data/sunday-nine/.cache/, sources recorded):
 *   logo-sources.json  — event marks + college primary athletics logos
 *   flag-sources.json  — country flags (flag-icons, MIT)
 * Files are uploaded byte-for-byte — never recolored, redrawn or re-encoded —
 * under content-hashed names (immutable, one-year cache) to Firebase Storage
 * sunday-nine/logos/. A mark that only exists in white (Players, LIV) is
 * shown on a dark plate; everything else on a light plate, so no logo ever
 * needs recoloring to be legible on the forest-green header.
 */

import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync} from "node:fs";
import {dirname, extname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {CATEGORIES} from "../sunday-nine/categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIR = resolve(ROOT, "data/sunday-nine");
const CACHE = resolve(DIR, ".cache");
const BUCKET = "teebox-market.firebasestorage.app";
const PREFIX = "sunday-nine/logos";
const dry = process.argv.includes("--dry-run");

const logoSrc = JSON.parse(readFileSync(resolve(DIR, "logo-sources.json"), "utf8"));
const flagSrc = JSON.parse(readFileSync(resolve(DIR, "flag-sources.json"), "utf8"));

const EVENT_KEYS = {
  "masters": "masters", "pga": "pga-championship", "usopen": "us-open",
  "open": "the-open", "players": "players", "fedex": "fedex-cup",
  "ryder": "ryder-cup", "presidents": "presidents-cup", "liv": "liv",
  "ncaa": "ncaa", "usam": "us-amateur",
};
// Marks that only exist in white: shown on the dark plate.
const DARK_PLATE = new Set(); // white tiles since 2026-11-09: every mark is a colour version
const COLLEGE_KEY_FIX = {"col-texas-aandm": "texas-a-and-m"};

function sourceFor(cat) {
  if (EVENT_KEYS[cat.id]) return {dir: "logos-raw", rec: logoSrc[EVENT_KEYS[cat.id]], key: EVENT_KEYS[cat.id]};
  if (cat.group === "college") {
    const key = COLLEGE_KEY_FIX[cat.id] || cat.id.replace(/^col-/, "");
    return {dir: "logos-raw", rec: logoSrc[key], key};
  }
  if (cat.group === "country") {
    const key = cat.id.replace(/^cty-/, "");
    return {dir: "flags", rec: flagSrc[key], key, flag: true};
  }
  return null; // text-only categories (World No. 1 gets a text badge in the client)
}

const staged = resolve(CACHE, "logos-upload");
mkdirSync(staged, {recursive: true});
const out = {};
const missing = [];
for (const cat of CATEGORIES) {
  const s = sourceFor(cat);
  if (!s) continue;
  // A record with no file documents a mark we could not source (text label).
  if (!s.rec || !s.rec.file) { missing.push(cat.id); continue; }
  const file = resolve(CACHE, s.dir, s.rec.file);
  if (!existsSync(file)) { missing.push(cat.id); continue; }
  const buf = readFileSync(file);
  const ext = extname(file).toLowerCase();
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 10);
  const name = `${s.key}.${hash}${ext}`;
  copyFileSync(file, resolve(staged, name));
  out[cat.id] = {
    u: `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(PREFIX + "/" + name)}?alt=media`,
    plate: s.flag ? "flag" : DARK_PLATE.has(s.key) ? "dark" : "light",
  };
}
console.log(`[logos] ${Object.keys(out).length} categories mapped; missing: ${missing.join(", ") || "none"}`);
if (dry) process.exit(0);
for (const [ext, type] of [[".svg", "image/svg+xml"], [".png", "image/png"]]) {
  if (!readdirSync(staged).some((f) => f.endsWith(ext))) continue;
  execFileSync("gsutil", ["-m", "-q", "-h", `Content-Type:${type}`,
    "-h", "Cache-Control:public, max-age=31536000, immutable",
    "cp", "-n", resolve(staged, "*" + ext), `gs://${BUCKET}/${PREFIX}/`], {stdio: "inherit"});
}
writeFileSync(resolve(DIR, "logos.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`[logos] uploaded to gs://${BUCKET}/${PREFIX}/ and wrote data/sunday-nine/logos.json`);
