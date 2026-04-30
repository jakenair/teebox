#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fetch-logos-v2.mjs
//
// Fetch real golf course logos for TeeBox Logo Bingo using no-auth APIs:
//   1) Clearbit Logo API   (https://logo.clearbit.com/{domain})
//   2) Google Favicon API  (https://www.google.com/s2/favicons?domain={domain}&sz=256)
//
// Idempotent: skips courses that already have a real PNG (>500 bytes).
// Falls through to the existing SVG lettermark crests when no logo is found.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const LOGOS_DIR = join(ROOT, 'assets', 'logos');
const SUMMARY_PATH = join(ROOT, 'scripts', 'logo-fetch-summary.txt');

// ── Course → likely public website domain ────────────────────────────────────
// Only confident mappings. Private clubs without a real public site are omitted
// so they fall back to the SVG lettermark crest.
const DOMAINS = {
  // United States (resorts / state parks / public-facing)
  'augusta-national': 'masters.com',
  'pebble-beach': 'pebblebeach.com',
  'shinnecock-hills': 'shinnecockhills.com',
  'oakmont': 'oakmont-countryclub.org',
  'pacific-dunes': 'bandondunesgolf.com',
  'bandon-dunes': 'bandondunesgolf.com',
  'old-macdonald': 'bandondunesgolf.com',
  'bandon-trails': 'bandondunesgolf.com',
  'sheep-ranch': 'bandondunesgolf.com',
  'winged-foot-west': 'wfgc.org',
  'riviera': 'therivieracountryclub.com',
  'oakland-hills-south': 'oaklandhillscc.com',
  'olympic-club-lake': 'olyclub.com',
  'baltusrol-lower': 'baltusrol.org',
  'bethpage-black': 'parks.ny.gov',
  'pinehurst-no-2': 'pinehurst.com',
  'whistling-straits': 'americanclubresort.com',
  'erin-hills': 'erinhills.com',
  'tpc-sawgrass': 'tpc.com',
  'kiawah-ocean': 'kiawahresort.com',
  'harbour-town': 'seapines.com',
  'tobacco-road': 'tobaccoroadgolf.com',
  'streamsong-red': 'streamsongresort.com',
  'streamsong-blue': 'streamsongresort.com',
  'streamsong-black': 'streamsongresort.com',
  'cabot-citrus-farms': 'cabotcitrusfarms.com',
  'inverness': 'invernessclub.com',
  'oak-hill-east': 'oakhillcc.com',
  'medinah-3': 'medinahcc.org',
  'east-lake': 'eastlakegolfclub.com',
  'castle-pines': 'castlepinesgolfclub.com',
  'shadow-creek': 'shadowcreek.com',
  'pine-valley': 'pinevalley.org',
  'merion-east': 'meriongolfclub.com',
  'seminole': 'seminolegolfclub.org',
  'los-angeles-cc-north': 'thelacc.org',
  'san-francisco-gc': 'sfgc.org',
  'prairie-dunes': 'prairiedunes.com',
  'quaker-ridge': 'quakerridgegc.org',

  // Scotland
  'st-andrews-old': 'standrews.com',
  'muirfield': 'muirfield.org.uk',
  'royal-dornoch': 'royaldornoch.com',
  'turnberry-ailsa': 'trumpgolfscotland.com',
  'carnoustie': 'carnoustiegolflinks.com',
  'north-berwick': 'northberwickgolfclub.com',
  'kingsbarns': 'kingsbarns.com',
  'cruden-bay': 'crudenbaygolfclub.co.uk',
  'machrihanish': 'machgolf.com',
  'machrihanish-dunes': 'machrihanishdunes.com',
  'castle-stuart': 'castlestuartgolf.com',
  'royal-troon': 'royaltroon.com',

  // England, Wales, NI & Ireland
  'royal-county-down': 'royalcountydown.org',
  'royal-portrush-dunluce': 'royalportrushgolfclub.com',
  'ballybunion-old': 'ballybuniongolfclub.com',
  'lahinch': 'lahinchgolf.com',
  'portmarnock': 'portmarnockgolfclub.ie',
  'european-club': 'theeuropeanclub.com',
  'royal-st-georges': 'royalstgeorges.com',
  'sunningdale-old': 'sunningdale-golfclub.co.uk',
  'royal-birkdale': 'royalbirkdale.com',
  'royal-lytham': 'royallytham.org',
  'royal-liverpool': 'royalliverpoolgolf.com',
  'walton-heath-old': 'waltonheath.com',

  // Continental Europe
  'morfontaine': 'golfdemorfontaine.fr',
  'valderrama': 'valderrama.com',

  // Australia & New Zealand
  'royal-melbourne-west': 'royalmelbourne.com.au',
  'kingston-heath': 'kingstonheath.melbourne',
  'barnbougle-dunes': 'barnbougle.com.au',
  'barnbougle-lost-farm': 'barnbougle.com.au',
  'cape-wickham': 'capewickham.com.au',
  'new-south-wales': 'nswgolfclub.com.au',
  'tara-iti': 'taraiti.com',
  'cape-kidnappers': 'capekidnappers.com',

  // Canada
  'cabot-cliffs': 'cabotcapebreton.com',
  'cabot-links': 'cabotcapebreton.com',
  'hamilton-gcc': 'hamiltongolf.com',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isImageMagic(buf) {
  if (!buf || buf.length < 8) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WebP: RIFF .... WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  // ICO: 00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return true;
  return false;
}

async function fetchBytes(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TeeBoxLogoBot/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status };
    const ct = res.headers.get('content-type') || '';
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    return { ok: true, status: res.status, contentType: ct, buf };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

function fmtKB(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

async function existingRealPng(id) {
  const p = join(LOGOS_DIR, `${id}.png`);
  if (!existsSync(p)) return false;
  try {
    const s = await stat(p);
    return s.size > 500;
  } catch {
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(LOGOS_DIR, { recursive: true });

  // Load courses
  const mod = await import(join(ROOT, 'bingo-courses.js'));
  const COURSES = mod.COURSES;

  const mapped = COURSES.filter((c) => DOMAINS[c.id]);
  const unmapped = COURSES.filter((c) => !DOMAINS[c.id]);

  const lines = [];
  const log = (s) => {
    console.log(s);
    lines.push(s);
  };

  log(`Total courses: ${COURSES.length}`);
  log(`Mapped to domains: ${mapped.length}`);
  log(`Unmapped (will use SVG lettermark): ${unmapped.length}`);
  log('');

  let okClearbit = 0;
  let okGoogle = 0;
  let failed = 0;
  let skipped = 0;

  for (const course of mapped) {
    const { id } = course;
    const domain = DOMAINS[id];
    const outPath = join(LOGOS_DIR, `${id}.png`);

    // Idempotent: skip courses that already have a real PNG
    if (await existingRealPng(id)) {
      const s = await stat(outPath);
      log(`[${id}] -- already have PNG (${fmtKB(s.size)}), skipping`);
      skipped++;
      continue;
    }

    // 1) Clearbit
    const cb = await fetchBytes(`https://logo.clearbit.com/${domain}`);
    if (
      cb.ok &&
      cb.buf &&
      cb.buf.length >= 500 &&
      (cb.contentType.startsWith('image/') || isImageMagic(cb.buf))
    ) {
      await writeFile(outPath, cb.buf);
      log(`[${id}] OK Clearbit (${fmtKB(cb.buf.length)}) <- ${domain}`);
      okClearbit++;
      await sleep(250);
      continue;
    }

    // 2) Google Favicon (sz=256)
    const gf = await fetchBytes(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`
    );
    if (
      gf.ok &&
      gf.buf &&
      gf.buf.length >= 1024 && // 1 KB minimum to avoid 16x16 default favicons
      (gf.contentType.startsWith('image/') || isImageMagic(gf.buf))
    ) {
      await writeFile(outPath, gf.buf);
      log(`[${id}] OK Google (${fmtKB(gf.buf.length)}) <- ${domain}`);
      okGoogle++;
      await sleep(250);
      continue;
    }

    log(
      `[${id}] FAIL no logo found <- ${domain}  (clearbit=${cb.status || cb.error || 'err'}, google=${gf.status || gf.error || 'err'})`
    );
    failed++;
    await sleep(250);
  }

  log('');
  log('────────── SUMMARY ──────────');
  log(`Total courses:           ${COURSES.length}`);
  log(`Mapped to domains:       ${mapped.length}`);
  log(`Unmapped (SVG only):     ${unmapped.length}`);
  log(`Already had PNG (skip):  ${skipped}`);
  log(`Fetched via Clearbit:    ${okClearbit}`);
  log(`Fetched via Google:      ${okGoogle}`);
  log(`Failed:                  ${failed}`);
  log(
    `Total real PNGs now:     ${skipped + okClearbit + okGoogle} / ${COURSES.length}`
  );

  await writeFile(SUMMARY_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`\nSummary written to ${SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
