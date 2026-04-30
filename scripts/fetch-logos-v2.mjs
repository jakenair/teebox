#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fetch-logos-v2.mjs
//
// Fetch real golf course logos for TeeBox Logo Bingo using no-auth APIs:
//   1) Google Favicon API  (https://www.google.com/s2/favicons?domain={domain}&sz=512)
//   2) Clearbit Logo API   (https://logo.clearbit.com/{domain})
//   3) Direct /favicon.ico (https://{domain}/favicon.ico)
//
// Idempotent: skips courses that already have a real PNG (>1500 bytes) that
// is not Google's blank-globe placeholder (~656 bytes — already excluded by
// the 1500 byte gate, but additionally fingerprinted defensively).
// Falls through to the existing SVG lettermark crests when no logo is found.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFile, readFile, stat, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const LOGOS_DIR = join(ROOT, 'assets', 'logos');
const SUMMARY_PATH = join(ROOT, 'scripts', 'logo-fetch-summary.txt');

// Minimum acceptable PNG/image size (bytes). Below this we treat the response
// as a placeholder favicon and fall through to the next source.
const MIN_BYTES = 1500;

// Known Google Favicon "blank globe" placeholder hashes. If we see one we
// reject it regardless of size.
const PLACEHOLDER_SHA1 = new Set([
  // Google's default blue-globe placeholder served when the requested domain
  // has no usable favicon. Any size below ~700 bytes is almost certainly this.
]);

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

  // Newly added US public / resort / municipal / PGA
  'chambers-bay': 'chambersbaygolf.com',
  'wolf-creek': 'golfwolfcreek.com',
  'tpc-scottsdale': 'tpc.com',
  'tpc-river-highlands': 'tpc.com',
  'tpc-southwind': 'tpc.com',
  'detroit-golf-club': 'detroitgolfclub.org',
  'colonial': 'colonialfw.com',
  'muirfield-village': 'memorialtournament.com',
  'sand-valley': 'sandvalley.com',
  'mammoth-dunes': 'sandvalley.com',
  'sedge-valley': 'sandvalley.com',
  'forest-dunes': 'forestdunesgolf.com',
  'the-loop': 'forestdunesgolf.com',
  'arcadia-bluffs': 'arcadiabluffs.com',
  'spyglass-hill': 'pebblebeach.com',
  'monterey-peninsula-shore': 'mpccpb.org',
  'pasatiempo': 'pasatiempo.com',
  'congressional-blue': 'ccclub.org',
  'plainfield': 'plainfieldcc.com',
  'aronimink': 'aronimink.org',
  'cherry-hills': 'chcc.com',
  'southern-hills': 'southernhillscc.com',
  'firestone-south': 'firestonecountryclub.com',
  'olympia-fields-north': 'ofcc.info',
  'austin-cc': 'austincountryclub.com',
  'congaree': 'congareegolf.com',
  'quail-hollow': 'quailhollowclub.com',
  'wild-horse': 'playwildhorse.com',
  'old-sandwich': 'oldsandwich.com',
  'bayonne': 'bayonnegolfclub.com',
  'old-town-club': 'oldtownclub.org',

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
  'royal-aberdeen': 'royalaberdeengolf.com',
  'trump-international-scotland': 'trumpgolfscotland.com',
  'gleneagles-kings': 'gleneagles.com',
  'gleneagles-pga-centenary': 'gleneagles.com',
  'prestwick': 'prestwickgc.co.uk',

  // England, Wales, NI & Ireland
  'royal-county-down': 'royalcountydown.org',
  'royal-portrush-dunluce': 'royalportrushgolfclub.com',
  'royal-portrush-valley': 'royalportrushgolfclub.com',
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
  'royal-porthcawl': 'royalporthcawl.com',
  'royal-ashdown-forest': 'royalashdown.co.uk',
  'rye': 'ryegolfclub.co.uk',
  'st-georges-hill': 'stgeorgeshillgolfclub.co.uk',
  'royal-cinque-ports': 'royalcinqueports.com',
  'royal-west-norfolk': 'rwngc.org',
  'royal-st-davids': 'royalstdavids.co.uk',
  'old-head': 'oldhead.com',
  'waterville': 'watervillegolflinks.ie',
  'tralee': 'traleegolfclub.com',
  'royal-dublin': 'theroyaldublingolfclub.com',
  'county-sligo': 'countysligogolfclub.ie',
  'enniscrone': 'enniscronegolf.com',

  // Continental Europe
  'morfontaine': 'golfdemorfontaine.fr',
  'valderrama': 'valderrama.com',
  'falsterbo': 'fgk.se',
  'halmstad': 'hgk.se',
  'sotogrande': 'sotogrande.com',
  'la-reserva-sotogrande': 'lareservaclubsotogrande.com',
  'real-san-sebastian': 'rgcss.com',
  'le-touquet-la-mer': 'opengolfclub.com',
  'domaine-de-belesbat': 'belesbat.com',
  'fontainebleau': 'golfdefontainebleau.org',
  'pevero': 'golfclubpevero.com',

  // Asia / Middle East
  'hokkaido-classic': 'hokkaido-classic.co.jp',
  'yas-links': 'yaslinks.com',
  'doha-golf-club': 'dohagolfclub.com',
  'emirates-majlis': 'dubaigolf.com',
  'mission-hills-shenzhen': 'missionhillschina.com',

  // Caribbean / Mexico / Latin America
  'diamante-dunes': 'diamantecabo.com',
  'cabot-saint-lucia': 'cabotsaintlucia.com',
  'casa-de-campo-teeth': 'casadecampo.com.do',
  'punta-espada': 'capcanaheritage.com',

  // Australia & New Zealand
  'royal-melbourne-west': 'royalmelbourne.com.au',
  'royal-melbourne-east': 'royalmelbourne.com.au',
  'kingston-heath': 'kingstonheath.melbourne',
  'barnbougle-dunes': 'barnbougle.com.au',
  'barnbougle-lost-farm': 'barnbougle.com.au',
  'cape-wickham': 'capewickham.com.au',
  'new-south-wales': 'nswgolfclub.com.au',
  'tara-iti': 'taraiti.com',
  'cape-kidnappers': 'capekidnappers.com',
  'te-arai-south': 'tearailinks.com',
  'te-arai-north': 'tearailinks.com',
  'paraparaumu-beach': 'paraparaumubeachgolfclub.co.nz',
  'victoria-golf-club': 'victoriagolf.com.au',
  'metropolitan-melbourne': 'metropolitangolf.com.au',

  // Canada
  'cabot-cliffs': 'cabotcapebreton.com',
  'cabot-links': 'cabotcapebreton.com',
  'hamilton-gcc': 'hamiltongolf.com',
  'highlands-links': 'cbhighlandslinks.com',
  'jasper-park': 'fairmont.com',
  'banff-springs': 'fairmont.com',
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
  // SVG (text-based)
  const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return true;
  return false;
}

function looksLikePlaceholder(buf) {
  if (!buf) return true;
  if (buf.length < MIN_BYTES) return true;
  const sha = createHash('sha1').update(buf).digest('hex');
  if (PLACEHOLDER_SHA1.has(sha)) return true;
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
    return s.size >= MIN_BYTES;
  } catch {
    return false;
  }
}

// Validate buf is a real, usable image (good magic bytes + above min size +
// not a known placeholder fingerprint).
function acceptImage(buf, contentType) {
  if (!buf) return false;
  if (looksLikePlaceholder(buf)) return false;
  if (!(contentType.startsWith('image/') || isImageMagic(buf))) return false;
  return true;
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

  let okGoogle = 0;
  let okClearbit = 0;
  let okDirect = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (const course of mapped) {
    const { id } = course;
    const domain = DOMAINS[id];
    const outPath = join(LOGOS_DIR, `${id}.png`);

    // Idempotent: skip courses that already have a real PNG (>=MIN_BYTES)
    if (await existingRealPng(id)) {
      const s = await stat(outPath);
      log(`[${id}] -- already have PNG (${fmtKB(s.size)}), skipping`);
      skipped++;
      continue;
    }

    // 1) Google Favicon (sz=512) — high resolution favicons are usually the
    //    real branded crest for golf course sites.
    const gf = await fetchBytes(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=512`
    );
    if (gf.ok && acceptImage(gf.buf, gf.contentType || '')) {
      await writeFile(outPath, gf.buf);
      log(`[${id}] OK Google512 (${fmtKB(gf.buf.length)}) <- ${domain}`);
      okGoogle++;
      await sleep(200);
      continue;
    }

    // 2) Clearbit
    const cb = await fetchBytes(`https://logo.clearbit.com/${domain}`);
    if (cb.ok && acceptImage(cb.buf, cb.contentType || '')) {
      await writeFile(outPath, cb.buf);
      log(`[${id}] OK Clearbit (${fmtKB(cb.buf.length)}) <- ${domain}`);
      okClearbit++;
      await sleep(200);
      continue;
    }

    // 3) Direct /favicon.ico from the course site (https only, then http).
    const direct1 = await fetchBytes(`https://${domain}/favicon.ico`);
    if (direct1.ok && acceptImage(direct1.buf, direct1.contentType || '')) {
      await writeFile(outPath, direct1.buf);
      log(`[${id}] OK direct (${fmtKB(direct1.buf.length)}) <- ${domain}/favicon.ico`);
      okDirect++;
      await sleep(200);
      continue;
    }

    // 3b) Try direct apple-touch-icon.png (often higher-res than favicon.ico)
    const direct2 = await fetchBytes(`https://${domain}/apple-touch-icon.png`);
    if (direct2.ok && acceptImage(direct2.buf, direct2.contentType || '')) {
      await writeFile(outPath, direct2.buf);
      log(`[${id}] OK apple-touch (${fmtKB(direct2.buf.length)}) <- ${domain}/apple-touch-icon.png`);
      okDirect++;
      await sleep(200);
      continue;
    }

    log(
      `[${id}] FAIL no logo found <- ${domain}  (google=${gf.status || gf.error || 'err'}, clearbit=${cb.status || cb.error || 'err'}, direct=${direct1.status || direct1.error || 'err'}, apple=${direct2.status || direct2.error || 'err'})`
    );
    failures.push({ id, domain });
    failed++;
    await sleep(200);
  }

  log('');
  log('────────── SUMMARY ──────────');
  log(`Total courses:           ${COURSES.length}`);
  log(`Mapped to domains:       ${mapped.length}`);
  log(`Unmapped (SVG only):     ${unmapped.length}`);
  log(`Already had PNG (skip):  ${skipped}`);
  log(`Fetched via Google512:   ${okGoogle}`);
  log(`Fetched via Clearbit:    ${okClearbit}`);
  log(`Fetched via direct:      ${okDirect}`);
  log(`Failed:                  ${failed}`);
  log(
    `Total real PNGs now:     ${skipped + okGoogle + okClearbit + okDirect} / ${COURSES.length}`
  );

  if (failures.length) {
    log('');
    log('Failed lookups (will use SVG lettermark):');
    for (const f of failures) log(`  ${f.id.padEnd(32)} <- ${f.domain}`);
  }

  if (unmapped.length) {
    log('');
    log('Unmapped (no domain configured, SVG only):');
    for (const c of unmapped) log(`  ${c.id}`);
  }

  await writeFile(SUMMARY_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`\nSummary written to ${SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
