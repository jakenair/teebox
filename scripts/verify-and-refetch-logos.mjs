// One-shot logo verification + Wikipedia refetch script.
// Step 1: hash + size-based pruning of existing PNGs.
// Step 2: Wikipedia pageimages API fetch for the top ~60 (PNG-less) courses.
// Step 3: write summary report.
//
// Constraints:
// - Touches only assets/logos/*.png and scripts/logo-verification-summary.txt
// - Never deletes .svg files
// - Polite to Wikipedia: 1 req/sec, identifying User-Agent

import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOGO_DIR = path.join(ROOT, 'assets', 'logos');
const COURSES_FILE = path.join(ROOT, 'bingo-courses.js');
const REPORT_FILE = path.join(ROOT, 'scripts', 'logo-verification-summary.txt');

const UA = 'TeeBoxBingo/1.0 (jakenair23@gmail.com)';
const MIN_SIZE = 5000;     // < 5KB = placeholder favicon
const WIKI_MIN_SIZE = 3000;
const WIKI_LIMIT = 60;

// ── helpers ─────────────────────────────────────────────────────────────────

const md5 = (buf) => createHash('md5').update(buf).digest('hex');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadCourses() {
  const mod = await import(pathToFileURL(COURSES_FILE).href);
  return mod.COURSES;
}

function isPng(buf) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}
function isJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
function isSvg(buf) {
  const head = buf.slice(0, 256).toString('utf8').toLowerCase();
  return head.includes('<svg') || head.includes('<?xml');
}

// ── Step 1 ──────────────────────────────────────────────────────────────────

const RESORT_KEEP = {
  'bandon-': 'bandon-dunes',
  'streamsong-': 'streamsong-blue',
};
const RESORT_DROP_ALL = ['cabot-', 'tpc-', 'gleneagles-'];

function step1Prune(courses) {
  const deleted = [];
  const kept = [];
  const files = readdirSync(LOGO_DIR).filter((f) => f.endsWith('.png'));

  // First pass: gather hash, size, and drop files < 5KB
  const meta = new Map(); // id -> { path, size, hash }
  for (const file of files) {
    const id = path.basename(file, '.png');
    const fp = path.join(LOGO_DIR, file);
    const stat = statSync(fp);
    if (stat.size < MIN_SIZE) {
      unlinkSync(fp);
      deleted.push({ id, reason: `too small (${stat.size}b < ${MIN_SIZE}b)` });
      continue;
    }
    const buf = readFileSync(fp);
    const hash = md5(buf);
    meta.set(id, { path: fp, size: stat.size, hash });
  }

  // Group by hash
  const byHash = new Map();
  for (const [id, m] of meta) {
    if (!byHash.has(m.hash)) byHash.set(m.hash, []);
    byHash.get(m.hash).push(id);
  }

  for (const [hash, ids] of byHash) {
    if (ids.length === 1) continue;

    // Determine resort family handling
    // Check whether all ids share a common resort prefix from RESORT_KEEP/RESORT_DROP_ALL
    const dropAllPrefix = RESORT_DROP_ALL.find((pre) => ids.every((id) => id.startsWith(pre)));
    if (dropAllPrefix) {
      for (const id of ids) {
        const m = meta.get(id);
        unlinkSync(m.path);
        meta.delete(id);
        deleted.push({ id, reason: `hash collision (resort family ${dropAllPrefix}, drop-all policy)` });
      }
      continue;
    }
    const keepPrefix = Object.keys(RESORT_KEEP).find((pre) => ids.every((id) => id.startsWith(pre)));
    if (keepPrefix) {
      const keeper = RESORT_KEEP[keepPrefix];
      for (const id of ids) {
        if (id === keeper) continue;
        const m = meta.get(id);
        unlinkSync(m.path);
        meta.delete(id);
        deleted.push({ id, reason: `hash collision (resort family ${keepPrefix}, keeping ${keeper})` });
      }
      continue;
    }

    // Unexpected collision — drop ALL members
    for (const id of ids) {
      const m = meta.get(id);
      unlinkSync(m.path);
      meta.delete(id);
      deleted.push({ id, reason: `hash collision (unexpected, group of ${ids.length}: ${ids.join(', ')})` });
    }
  }

  for (const id of meta.keys()) kept.push(id);

  return { deleted, kept };
}

// ── Step 2 ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function wikipediaThumbnail(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&format=json&pithumbsize=512&redirects=1&origin=*`;
  let data;
  try { data = await fetchJson(url); } catch { return null; }
  const pages = data?.query?.pages;
  if (!pages) return null;
  for (const k of Object.keys(pages)) {
    const p = pages[k];
    if (p.thumbnail?.source) return { source: p.thumbnail.source, original: p.thumbnail.original || p.thumbnail.source };
  }
  return null;
}

// Heuristic to decide whether the thumbnail is a logo (vs. a course photo).
//
// Wikipedia's pageimages API returns the top-of-infobox image, which for golf
// courses is almost always a course PHOTO. Real logos on Wikipedia are nearly
// always rendered from SVG (path like /commons/thumb/*/*.svg/*.png) or have
// "logo"/"crest"/"emblem"/"badge" in the URL. To avoid false positives we
// REQUIRE one of those signals — anything else is rejected as photo.
function classifyThumb(srcUrl) {
  const u = srcUrl.toLowerCase();
  // Wikipedia renders SVG → PNG via thumb URLs that contain ".svg/" mid-path.
  // Genuine SVG-derived thumbs are an extremely strong logo signal.
  if (u.includes('.svg/') || u.endsWith('.svg')) return { kind: 'svg-logo' };
  if (/\b(logo|crest|emblem|badge|wordmark|insignia)\b/.test(u)) return { kind: 'logo' };
  // Default: reject. The pageimages endpoint returns photos for golf courses
  // far more often than logos, and we'd rather show the SVG lettermark.
  return { kind: 'photo' };
}

async function attemptWikipedia(course) {
  const titles = [
    `${course.name} (golf course)`,
    course.name,
    course.shortName ? `${course.shortName} Golf Club` : null,
    course.shortName,
  ].filter(Boolean);

  for (const title of titles) {
    const t = await wikipediaThumbnail(title);
    await sleep(1100); // polite ≈1 req/s
    if (!t) continue;

    const cls = classifyThumb(t.source);
    if (cls.kind === 'photo') return { ok: false, reason: `photo url (${title}) ${t.source}` };

    // Download
    let buf;
    try { buf = await fetchBuf(t.source); } catch (e) { return { ok: false, reason: `download failed: ${e.message}` }; }
    await sleep(1100);

    if (buf.length < WIKI_MIN_SIZE) return { ok: false, reason: `too small (${buf.length}b)` };

    // Validate magic bytes / convert SVG-rendered thumbs are already PNGs from upload.wikimedia
    let pngBuf;
    if (isPng(buf)) {
      pngBuf = buf;
    } else if (isJpeg(buf)) {
      try { pngBuf = await sharp(buf).png().toBuffer(); } catch (e) { return { ok: false, reason: `jpeg→png failed: ${e.message}` }; }
    } else if (isSvg(buf)) {
      try { pngBuf = await sharp(buf).resize({ width: 512, withoutEnlargement: false }).png().toBuffer(); } catch (e) { return { ok: false, reason: `svg→png failed: ${e.message}` }; }
    } else {
      return { ok: false, reason: 'unknown format' };
    }

    // Aspect ratio guard
    let dims;
    try { dims = await sharp(pngBuf).metadata(); } catch { dims = null; }
    if (dims?.width && dims?.height) {
      const ratio = dims.width / dims.height;
      if (ratio > 1.5 || ratio < 1 / 1.5) {
        return { ok: false, reason: `aspect ratio ${ratio.toFixed(2)} (likely photo) src=${t.source}` };
      }
    }

    // Reject very small final images too
    if (pngBuf.length < WIKI_MIN_SIZE) return { ok: false, reason: `final png too small (${pngBuf.length}b)` };

    const out = path.join(LOGO_DIR, `${course.id}.png`);
    writeFileSync(out, pngBuf);
    return { ok: true, source: t.source, title, bytes: pngBuf.length };
  }
  return { ok: false, reason: 'no wikipedia page hit' };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const courses = await loadCourses();
  console.log(`Loaded ${courses.length} courses`);

  // Step 1
  console.log('\n── Step 1: prune ──');
  const { deleted, kept } = step1Prune(courses);
  console.log(`Deleted: ${deleted.length}`);
  console.log(`Kept: ${kept.length}`);

  // Step 2 — Wikipedia for top WIKI_LIMIT courses that lack a PNG
  console.log('\n── Step 2: Wikipedia fetch ──');
  const haveSet = new Set(readdirSync(LOGO_DIR).filter((f) => f.endsWith('.png')).map((f) => path.basename(f, '.png')));

  const candidates = courses.filter((c) => !haveSet.has(c.id)).slice(0, WIKI_LIMIT);
  console.log(`Attempting Wikipedia for ${candidates.length} courses`);

  const wikiOk = [];
  const wikiSkip = [];
  for (const c of candidates) {
    process.stdout.write(`  [${c.id}] ... `);
    let res;
    try { res = await attemptWikipedia(c); }
    catch (e) { res = { ok: false, reason: `exception: ${e.message}` }; }
    if (res.ok) {
      wikiOk.push({ id: c.id, source: res.source, title: res.title, bytes: res.bytes });
      console.log(`OK (${res.bytes}b) ${res.source}`);
    } else {
      wikiSkip.push({ id: c.id, reason: res.reason });
      console.log(`skip — ${res.reason}`);
    }
  }

  // Final counts
  const finalPngs = readdirSync(LOGO_DIR).filter((f) => f.endsWith('.png'));
  const finalCount = finalPngs.length;
  const fallbackCount = courses.length - finalCount;

  // Report
  const lines = [];
  lines.push('TeeBox logo verification summary');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Total courses in bingo-courses.js: ${courses.length}`);
  lines.push(`PNGs after Step 1: ${kept.length}`);
  lines.push(`PNGs deleted in Step 1: ${deleted.length}`);
  for (const d of deleted) lines.push(`  - ${d.id} — ${d.reason}`);
  lines.push('');
  lines.push(`Wikipedia attempts: ${candidates.length}`);
  lines.push(`Wikipedia successes: ${wikiOk.length}`);
  for (const w of wikiOk) lines.push(`  ✓ ${w.id} (${w.bytes}b) <- ${w.title} :: ${w.source}`);
  lines.push('');
  lines.push(`Wikipedia skips/failures: ${wikiSkip.length}`);
  for (const w of wikiSkip) lines.push(`  ✗ ${w.id} — ${w.reason}`);
  lines.push('');
  lines.push(`Final PNG count: ${finalCount}`);
  lines.push(`Final SVG-fallback count: ${fallbackCount} (${courses.length} - ${finalCount})`);
  lines.push(`Real-logo coverage: ${((finalCount / courses.length) * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('PNGs surviving Step 1 (real-logo candidates):');
  for (const id of kept.sort()) lines.push(`  • ${id}`);

  writeFileSync(REPORT_FILE, lines.join('\n'));
  console.log(`\nReport: ${REPORT_FILE}`);
  console.log(`Final PNG count: ${finalCount} / ${courses.length} (${((finalCount / courses.length) * 100).toFixed(1)}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
