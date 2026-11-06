#!/usr/bin/env node
/**
 * scripts/sunday-nine-photos.mjs — Sunday Nine player headshots.
 *
 *   node scripts/sunday-nine-photos.mjs fetch     # download originals (cached, polite)
 *   node scripts/sunday-nine-photos.mjs process   # face-crop -> 256/512 webp
 *   node scripts/sunday-nine-photos.mjs upload    # Firebase Storage + photos.json
 *
 * Source order (founder spec 2026-11-06): pga.com, then pgatour.com, then
 * livgolf.com (LIV players), then the DP World Tour site. pga.com (PGA of
 * America) publishes no tour-player profiles or headshots — its sitemap has
 * coaches, programs, events and leaderboards only — so in practice the chain
 * starts at pgatour.com. Every outcome is recorded per player in
 * data/sunday-nine/photo-sources.json (site, profile URL, original image URL),
 * so swapping a source later is a rerun of this script, not a hunt.
 *
 * Politeness: one request at a time, >= 1.1 s apart, a real browser
 * User-Agent, and nothing is ever fetched twice: originals are cached in
 * data/sunday-nine/.cache/raw/ (gitignored). Images are self-hosted — the
 * game never hotlinks a tour CDN.
 *
 * Players with no headshot anywhere get no `ph` field; the client draws a
 * monogram (initials, Playfair, cream on forest green).
 */

import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const require = createRequire(resolve(ROOT, "functions/package.json"));
const DIR = resolve(ROOT, "data/sunday-nine");
const CACHE = resolve(DIR, ".cache");
const RAW = resolve(CACHE, "raw");
const OUT = resolve(CACHE, "out");
const SOURCES = resolve(DIR, "photo-sources.json");
const PHOTOS = resolve(DIR, "photos.json");
const IDS = JSON.parse(readFileSync(resolve(DIR, "pgatour-ids.json"), "utf8"));
const PLAYERS = JSON.parse(readFileSync(resolve(ROOT, "sunday-nine/players.json"), "utf8")).players;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const GAP_MS = 1100;
const BUCKET = "teebox-market.firebasestorage.app";
const PREFIX = "sunday-nine/players";
const FACE_BOX = process.env.FACE_BOX_BIN; // compiled scripts/lib/face-box.swift
// Brand light background the transparent cutouts are flattened onto.
const BG = {r: 0xee, g: 0xf3, b: 0xec};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const save = (f, v) => writeFileSync(f, JSON.stringify(v, null, 1) + "\n");

let last = 0;
async function politeFetch(url) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  return fetch(url, {headers: {"User-Agent": UA, "Accept": "image/avif,image/webp,image/png,image/*;q=0.8"}});
}

// ── Sources, in order. Each returns {site, page, image, buf} or null. ────
const SITES = [
  {
    site: "pga.com",
    // No player profiles exist on pga.com (checked 2026-11-06); recorded so
    // the chain is visible in photo-sources.json.
    async get() { return null; },
  },
  {
    site: "pgatour.com",
    async get(p) {
      const id = IDS[p.id];
      if (!id) return null;
      const image = `https://pga-tour-res.cloudinary.com/image/upload/headshots_${id}`;
      const res = await politeFetch(image);
      if (res.status !== 200) return {miss: `HTTP ${res.status}`};
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4000) return {miss: "placeholder-sized image"};
      return {site: "pgatour.com", page: `https://www.pgatour.com/player/${id}/${p.id}`, image, buf};
    },
  },
  {
    site: "livgolf.com",
    // LIV players only. The profile's single "image" field is the headshot.
    async get(p) {
      if (p.liv !== "Y") return null;
      const page = `https://www.livgolf.com/player/${p.id}`;
      const res = await politeFetch(page);
      if (res.status !== 200) return {miss: `HTTP ${res.status}`};
      const html = await res.text();
      if (!new RegExp("<title>" + p.n.split(" ")[0], "i").test(html)) return {miss: "profile not found"};
      const m = html.match(/"image":"(https:\/\/cdn\.sanity\.io\/images\/[^"?]+)/);
      if (!m) return {miss: "no headshot on profile"};
      const image = m[1] + "?w=1600&fit=max";
      const img = await politeFetch(image);
      if (img.status !== 200) return {miss: `image HTTP ${img.status}`};
      return {site: "livgolf.com", page, image, buf: Buffer.from(await img.arrayBuffer())};
    },
  },
  {
    site: "dpworldtour.com",
    // europeantour.com answers 403 (bot protection) and dpworldtour.com
    // refuses connections from scripts (checked 2026-11-06). We don't work
    // around a block, so this source is recorded as unavailable.
    async get() { return {miss: "site blocks automated access"}; },
  },
];

async function cmdFetch() {
  mkdirSync(RAW, {recursive: true});
  const src = load(SOURCES, {});
  let n = 0;
  for (const p of PLAYERS) {
    if (src[p.id] && src[p.id].file) continue;
    // Re-runs only try sources not already tried for this player.
    const tried = (src[p.id] && src[p.id].tried) || [];
    const done = new Set(tried.map((t) => t.site));
    let hit = null;
    for (const s of SITES) {
      if (done.has(s.site)) continue;
      const r = await s.get(p);
      if (r && r.buf) { hit = r; break; }
      tried.push({site: s.site, result: r ? r.miss : "no profile"});
    }
    if (hit) {
      const file = `${p.id}.png`;
      writeFileSync(resolve(RAW, file), hit.buf);
      src[p.id] = {name: p.n, site: hit.site, page: hit.page, image: hit.image, file,
        fetchedAt: new Date().toISOString(), tried};
    } else {
      src[p.id] = {name: p.n, site: null, tried};
    }
    if (++n % 25 === 0) { save(SOURCES, src); console.log(`[photos] ${n} fetched…`); }
  }
  save(SOURCES, src);
  const got = Object.values(src).filter((s) => s.file).length;
  console.log(`[photos] originals cached: ${got}/${PLAYERS.length}`);
}

// Square crop around the face: head and shoulders, face ~40% down.
function cropBox(w, h, face) {
  if (!face) {
    const side = Math.min(w, h);
    return {left: Math.round((w - side) / 2), top: 0, width: side, height: side, guessed: true};
  }
  const [fx, fy, fw, fh] = face;
  let side = Math.round(Math.max(fw, fh) * 2.5);
  side = Math.min(side, w, h);
  const cx = fx + fw / 2;
  let left = Math.round(cx - side / 2);
  let top = Math.round(fy - fh * 0.62);
  left = Math.max(0, Math.min(w - side, left));
  top = Math.max(0, Math.min(h - side, top));
  return {left, top, width: side, height: side};
}

async function cmdProcess() {
  if (!FACE_BOX || !existsSync(FACE_BOX)) throw new Error("set FACE_BOX_BIN to the compiled scripts/lib/face-box.swift");
  const sharp = require("sharp");
  mkdirSync(OUT, {recursive: true});
  const src = load(SOURCES, {});
  const ids = Object.keys(src).filter((k) => src[k].file);
  const boxes = {};
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40).map((k) => resolve(RAW, src[k].file));
    const out = execFileSync(FACE_BOX, chunk, {encoding: "utf8", maxBuffer: 1 << 24});
    for (const line of out.trim().split("\n")) {
      const j = JSON.parse(line);
      boxes[j.path.split("/").pop().replace(/\.png$/, "")] = j;
    }
  }
  const report = {noFace: [], small: []};
  for (const k of ids) {
    const b = boxes[k];
    if (!b || b.error) { report.noFace.push(k); continue; }
    const box = cropBox(b.w, b.h, b.face);
    if (box.guessed) report.noFace.push(k);
    if (box.width < 256) report.small.push(k);
    const base = sharp(resolve(RAW, src[k].file)).extract(box).flatten({background: BG});
    for (const size of [256, 512]) {
      await base.clone().resize(size, size, {fit: "cover"}).webp({quality: 82}).toFile(resolve(OUT, `${k}-${size}.webp`));
    }
    src[k].crop = {...box, faceDetected: !box.guessed};
  }
  save(SOURCES, src);
  console.log(`[photos] processed ${ids.length}; no face found: ${report.noFace.length} ${report.noFace.join(", ")}`);
  if (report.small.length) console.log(`[photos] low-res (<256px crop): ${report.small.join(", ")}`);
}

async function cmdUpload() {
  const src = load(SOURCES, {});
  const photos = {};
  const files = readdirSync(OUT).filter((f) => f.endsWith(".webp"));
  // Content-hashed names: a re-crop gets a new URL, so the one-year
  // immutable cache can never serve a stale face.
  const staged = resolve(CACHE, "upload");
  mkdirSync(staged, {recursive: true});
  for (const f of files) {
    const m = f.match(/^(.+)-(256|512)\.webp$/);
    if (!m) continue;
    const buf = readFileSync(resolve(OUT, f));
    const h = createHash("sha256").update(readFileSync(resolve(OUT, `${m[1]}-256.webp`))).digest("hex").slice(0, 10);
    const name = `${m[1]}.${h}-${m[2]}.webp`;
    writeFileSync(resolve(staged, name), buf);
    if (m[2] === "256") photos[m[1]] = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(PREFIX + "/" + name)}?alt=media`;
  }
  execFileSync("gsutil", ["-m", "-q", "-h", "Content-Type:image/webp",
    "-h", "Cache-Control:public, max-age=31536000, immutable",
    "cp", "-n", resolve(staged, "*.webp"), `gs://${BUCKET}/${PREFIX}/`], {stdio: "inherit"});
  for (const [k, url] of Object.entries(photos)) if (src[k]) src[k].hosted = url;
  save(SOURCES, src);
  save(PHOTOS, photos);
  console.log(`[photos] uploaded ${Object.keys(photos).length} players to gs://${BUCKET}/${PREFIX}/`);
}

const cmd = process.argv[2];
const run = {fetch: cmdFetch, process: cmdProcess, upload: cmdUpload}[cmd];
if (!run) { console.error("usage: sunday-nine-photos.mjs fetch|process|upload"); process.exit(1); }
run().catch((e) => { console.error(e); process.exit(1); });
