#!/usr/bin/env node
/**
 * scripts/upload-logos-to-storage.mjs
 *
 * Publishes /assets/logos/*.png to Firebase Storage under course-logos/,
 * which is where the Logo Bingo puzzle doc points its absolute logo URLs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY STORAGE AND NOT teeboxmarket.com (2026-10-02)
 *
 * The puzzle doc has always carried ABSOLUTE logo URLs, deliberately: a stale
 * IPA should still render current artwork rather than whatever shipped inside
 * it. That mechanism had never once worked in the app, because index.html's
 * CSP did not list https://teeboxmarket.com, and inside the WebView 'self' is
 * capacitor://localhost, not the web origin. Every tile failed its first probe
 * and fell back to the bundled PNG — which is why Logo Bingo looked different
 * on web and iOS, and why nobody noticed until a board drew bethpage-black,
 * one of 12 logos re-framed in r293.
 *
 * r297 added teeboxmarket.com to img-src, but a CSP ships INSIDE the bundle,
 * so it only takes effect from the next build onward. firebasestorage.
 * googleapis.com is already in the CSP of every build ever shipped. Serving
 * the logos from Storage therefore fixes logo drift on phones people already
 * have, with no rebuild and no App Store wait.
 *
 * Public read is granted by the course-logos/ block in storage.rules; no
 * client can write there. Objects are uploaded immutable with a one-year
 * max-age, so a changed logo needs a changed filename or an explicit
 * re-upload (this script always re-uploads, see --force).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ADDING OR CHANGING A LOGO — the whole workflow:
 *
 *   1. Drop the PNG in /assets/logos/ (or edit an existing one).
 *   2. npm run logos:publish          # this script: regenerates the web
 *                                     # manifest, then uploads to Storage
 *   3. node functions/scripts/generate-bingo-canon.mjs
 *                                     # rebuilds the canon with the new pool
 *                                     # and the Storage URLs
 *   4. bash scripts/deploy-fn.sh generateDailyBingoPuzzle
 *   5. bash scripts/deploy-fn.sh dailyBingoMonitor
 *                                     # the monitor carries its OWN canon
 *                                     # copy — skipping it is why parity was
 *                                     # red for a month
 *   6. npm run build:web && git push  # ships the manifest to web + iOS bundle
 *
 * Steps 3-5 matter because adding or retiring a logo changes the pool. Since
 * 2026-10-05 the selection algorithm is stable under pool changes (see
 * bingo-select.mjs), so this no longer re-rolls every future board — it moves
 * about 0.17 of 9 tiles per day. Before that change it moved 8.37 of 9.
 *
 * Usage:
 *   node scripts/upload-logos-to-storage.mjs            # upload what's missing/changed
 *   node scripts/upload-logos-to-storage.mjs --force    # re-upload everything
 *   node scripts/upload-logos-to-storage.mjs --dry-run  # show what would happen
 */

import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, statSync, existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOGOS_DIR = join(ROOT, "assets", "logos");

export const BUCKET = "teebox-market.firebasestorage.app";
export const PREFIX = "course-logos";
export const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The public URL for a logo, in the one form every shipped CSP allows. */
export function storageLogoUrl(slug, bucket = BUCKET, prefix = PREFIX) {
  const encoded = encodeURIComponent(`${prefix}/${slug}.png`);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encoded}?alt=media`;
}

const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry-run");

function md5(buf) {
  return createHash("md5").update(buf).digest("base64");
}

function remoteIndex() {
  // One listing call rather than a stat per file.
  let out = "";
  try {
    out = execFileSync("gsutil", ["ls", "-L", `gs://${BUCKET}/${PREFIX}/**`],
        {encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"]});
  } catch {
    return new Map(); // empty prefix on first run
  }
  const map = new Map();
  let current = null;
  for (const line of out.split("\n")) {
    const m = line.match(/^gs:\/\/[^\s]+\/([^/\s]+\.png):/);
    if (m) {
      current = m[1];
      continue;
    }
    const h = line.match(/Hash \(md5\):\s+(\S+)/);
    if (h && current) {
      map.set(current, h[1]);
      current = null;
    }
  }
  return map;
}

function main() {
  if (!existsSync(LOGOS_DIR)) {
    console.error(`[logos] missing ${LOGOS_DIR}`);
    process.exit(2);
  }
  const files = readdirSync(LOGOS_DIR)
      .filter((f) => f.endsWith(".png"))
      .filter((f) => statSync(join(LOGOS_DIR, f)).isFile())
      .sort();
  console.log(`[logos] ${files.length} PNGs in assets/logos/`);

  const remote = remoteIndex();
  console.log(`[logos] ${remote.size} already in gs://${BUCKET}/${PREFIX}/`);

  const todo = [];
  for (const f of files) {
    const local = md5(readFileSync(join(LOGOS_DIR, f)));
    if (FORCE || remote.get(f) !== local) todo.push(f);
  }

  if (!todo.length) {
    console.log("[logos] everything is already current — nothing to upload.");
    return;
  }
  console.log(`[logos] ${todo.length} to upload${FORCE ? " (--force)" : ""}:`);
  for (const f of todo.slice(0, 12)) console.log(`          ${f}`);
  if (todo.length > 12) console.log(`          … and ${todo.length - 12} more`);

  if (DRY) {
    console.log("[logos] --dry-run, stopping here.");
    return;
  }

  // gsutil -m parallelises; headers are set at write time so the objects are
  // immutable and cacheable from the first request.
  const args = [
    "-m",
    "-h", "Content-Type:image/png",
    "-h", `Cache-Control:${CACHE_CONTROL}`,
    "cp",
    ...todo.map((f) => join(LOGOS_DIR, f)),
    `gs://${BUCKET}/${PREFIX}/`,
  ];
  execFileSync("gsutil", args, {stdio: "inherit"});
  console.log(`[logos] uploaded ${todo.length}.`);
  console.log(`[logos] sample: ${storageLogoUrl(todo[0].replace(/\.png$/, ""))}`);
  console.log("[logos] NEXT: regenerate the canon and redeploy —");
  console.log("          node functions/scripts/generate-bingo-canon.mjs");
  console.log("          bash scripts/deploy-fn.sh generateDailyBingoPuzzle");
  console.log("          bash scripts/deploy-fn.sh dailyBingoMonitor");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
