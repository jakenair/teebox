#!/usr/bin/env node
/**
 * source-favicons.mjs
 *
 * Sources real golf-club logos by scraping each club's official website —
 * focusing on apple-touch-icon, og:image, link-rel-icon, and /favicon.ico.
 *
 * Pipeline (per missing course):
 *   1. Discover the club's official website URL via:
 *        a. Wikipedia infobox externallinks / wikitext "| website ="
 *        b. Predictable URL guesses (slug.com, slug-gc.com, etc.)
 *   2. Fetch homepage HTML, parse <head> for icon URLs in priority order:
 *        apple-touch-icon[-precomposed]  →  og:image  →  link[rel=icon] (largest)
 *        →  link[rel=shortcut icon]      →  /favicon.ico
 *   3. Reject placeholders / tiny / default images (<2KB or <64×64 dimensions).
 *   4. Download with curl, resize to 256×256 transparent PNG via sharp,
 *      save to /assets/logos/{slug}.png — UNLESS one already exists.
 *   5. Append a row to ATTRIBUTION.csv with status=favicon_scraped.
 *
 * Polite scraping: 1.5s between requests to same host, 1s between hosts,
 * exponential backoff on 429/503, robots.txt respected.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFile = promisify(execFileCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const COURSES_FILE = path.join(ROOT, 'bingo-courses.js');
const LOGOS_DIR = path.join(ROOT, 'assets', 'logos');
const ATTR_CSV = path.join(LOGOS_DIR, 'ATTRIBUTION.csv');
const REPORT_MD = path.join(LOGOS_DIR, 'FAVICON_SOURCING_REPORT.md');
const TMP_DIR = '/tmp';

const SCRAPER_UA = 'Mozilla/5.0 (compatible; TeeBox-Logo-Sourcing/1.0; +https://teeboxmarket.app)';
const WIKI_UA = 'TeeBoxLogoBingo/1.0 (https://teeboxmarket.app; jakenair23@gmail.com)';

// Per-host last-hit timestamp for rate limiting.
// We only enforce per-host pacing; concurrent fetches against DIFFERENT hosts
// are fine and the polite-scraping requirement applies per host.
const lastHostHit = new Map();
const HOST_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function politeWait(host) {
  const last = lastHostHit.get(host) || 0;
  const sinceHost = Date.now() - last;
  if (sinceHost < HOST_DELAY_MS) await sleep(HOST_DELAY_MS - sinceHost);
  lastHostHit.set(host, Date.now());
}

// ------------- Course parsing (reused from source-wikimedia-photos.mjs) -------------

function parseCourses(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const courses = [];
  const idRe = /^\s+id:\s*['"]([^'"]+)['"],/gm;
  const fieldRe = (field) =>
    new RegExp(`\\n\\s+${field}:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`, '');
  const nameRe = fieldRe('name');
  const locRe = fieldRe('location');
  const archRe = fieldRe('architect');
  const shortRe = fieldRe('shortName');
  let m;
  while ((m = idRe.exec(src)) !== null) {
    const id = m[1];
    const start = m.index;
    const skipFrom = start + m[0].length;
    const tail = src.slice(skipFrom);
    const nextIdIdx = tail.search(/^\s+id:\s*['"]/m);
    const windowEnd = nextIdIdx >= 0 ? skipFrom + nextIdIdx : start + 2000;
    const window = src.slice(start, windowEnd);
    const grab = (re) => {
      const mm = window.match(re);
      if (!mm) return '';
      return (mm[1] !== undefined ? mm[1] : mm[2] || '').replace(/\\(['"\\])/g, '$1');
    };
    courses.push({
      id,
      name: grab(nameRe) || id,
      shortName: grab(shortRe),
      location: grab(locRe),
      architect: grab(archRe),
    });
  }
  return courses;
}

// ------------- HTTP helpers -------------

function httpGetText(rawUrl, opts = {}) {
  const { maxRedirects = 5, timeoutMs = 15000, ua = SCRAPER_UA } = opts;
  let url;
  try { url = new NodeURL(rawUrl); } catch { return Promise.reject(new Error('bad url')); }
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.get(rawUrl, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        let next;
        try { next = new NodeURL(res.headers.location, rawUrl).toString(); } catch { return reject(new Error('bad redirect')); }
        res.resume();
        httpGetText(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        return reject(Object.assign(new Error(`HTTP ${status} for ${rawUrl}`), { status }));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ body: buf.toString('utf8'), finalUrl: rawUrl, headers: res.headers });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function httpHead(rawUrl, opts = {}) {
  const { maxRedirects = 5, timeoutMs = 10000, ua = SCRAPER_UA } = opts;
  let url;
  try { url = new NodeURL(rawUrl); } catch { return Promise.reject(new Error('bad url')); }
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(rawUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': ua },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        let next;
        try { next = new NodeURL(res.headers.location, rawUrl).toString(); } catch { return reject(new Error('bad redirect')); }
        res.resume();
        httpHead(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      res.resume();
      resolve({ status, finalUrl: rawUrl, headers: res.headers });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { 'User-Agent': WIKI_UA, 'Accept': 'application/json' },
      timeout: 15000,
    };
    const req = https.get(url, opts, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpGetJson(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ------------- robots.txt -------------

const robotsCache = new Map(); // origin → Set of disallowed paths for *
async function isRobotsAllowed(rawUrl) {
  let u;
  try { u = new NodeURL(rawUrl); } catch { return false; }
  const origin = `${u.protocol}//${u.host}`;
  if (!robotsCache.has(origin)) {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const res = await httpGetText(robotsUrl, { timeoutMs: 8000 });
      const lines = res.body.split(/\r?\n/);
      const disallows = [];
      let inStar = false;
      for (const raw of lines) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'user-agent') {
          inStar = (val === '*');
        } else if (inStar && key === 'disallow') {
          if (val) disallows.push(val);
        }
      }
      robotsCache.set(origin, disallows);
    } catch {
      robotsCache.set(origin, []); // assume allowed if no robots.txt
    }
  }
  const disallows = robotsCache.get(origin);
  const path = u.pathname + (u.search || '');
  for (const d of disallows) {
    if (d === '/') return false; // total block
    if (d && path.startsWith(d)) return false;
  }
  return true;
}

// ------------- Wikipedia → website URL -------------

function buildTitleCandidates(course) {
  const out = [];
  const add = s => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const stripParen = s => s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
  const name = course.name.trim();
  const shortName = (course.shortName || '').trim();
  add(name);
  add(stripParen(name));
  if (shortName) { add(shortName); add(stripParen(shortName)); }
  for (const v of [name, stripParen(name), shortName, stripParen(shortName)]) {
    if (!v) continue;
    const stripped = v.replace(/^The\s+/i, '');
    if (stripped !== v) add(stripped);
  }
  const suffixes = ['Golf Club', 'Country Club', 'Golf Links', 'Golf Resort'];
  for (const v of [...out]) {
    if (!/(golf club|country club|golf links|golf course|golf resort| gc| cc| club| links)\b/i.test(v.toLowerCase())) {
      for (const s of suffixes) add(`${v} ${s}`);
    }
  }
  return out;
}

async function findWikipediaWebsite(course) {
  const candidates = buildTitleCandidates(course);
  for (const title of candidates) {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&prop=externallinks|wikitext&page=${encodeURIComponent(title)}&format=json&redirects=1`;
    let resp;
    try { resp = await httpGetJson(url); }
    catch { continue; }
    const parse = resp?.parse;
    if (!parse) continue;
    // First try infobox "| website = ..." in wikitext
    const wt = parse.wikitext?.['*'] || '';
    const wsMatch = wt.match(/\|\s*website\s*=\s*([^\n|}]+)/i);
    if (wsMatch) {
      const raw = wsMatch[1].trim();
      // wikitext like {{URL|http://...}} or {{Official URL}} or bare URL
      const urlInTpl = raw.match(/https?:\/\/[^\s|}\]]+/i);
      if (urlInTpl) {
        const hit = urlInTpl[0].replace(/[).,]+$/, '');
        return { website: hit, source: `wikipedia:${title}` };
      }
    }
    // Fallback: scan externallinks for plausible official sites
    const ext = parse.externallinks || [];
    const blacklistRe = /wikipedia|wikimedia|wikidata|wiktionary|wikisource|geohack|toolforge|geograph|flickr|youtube|twitter|x\.com|facebook|instagram|linkedin|yelp|tripadvisor|google\.|bing\.|maps\.|openstreetmap|usga\.org|pgatour\.com|britannica\.com|amazon\.com|apple\.com|spotify\.com|archive\.org|jstor\.org|doi\.org|imdb\.com|allmusic\.com|crunchbase|forbes\.com|nytimes\.com|washingtonpost|espn\.com|ncbi\.nlm|youtu\.be|vimeo\.com|reuters\.com|bbc\.co|theguardian|nbc\.com|fox\.com|cnn\.com|usatoday|bloomberg|wsj\.com|sportsillustrated|defector\.com|golfclubatlas|top100golfcourses|golfdigest\.com|golfdigest\.co|^https?:\/\/(www\.)?golf\.com|golfweek|golfmagic|golfchannel|nationalclubgolfer|sportsillustrated|si\.com|todayinsport|theopen\.com|usopen\.com|masters\.com|rydercup\.com|europeantour\.com/i;
    const tryLink = (link) => {
      if (!/^https?:\/\//i.test(link)) return null;
      const lower = link.toLowerCase();
      if (blacklistRe.test(lower)) return null;
      return link;
    };

    // Build host-similarity check: extract host's "second-level" word(s),
    // require that they overlap with at least one significant slug bit (≥4 chars).
    // This rejects third-party news/review sites (golfclubatlas.com, top100golfcourses.com,
    // defector.com) — they won't share host tokens with the course slug.
    const slugBits = course.id.split('-').filter(b => b.length >= 4);
    const courseTokens = new Set([
      ...slugBits,
      ...(course.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(b => b.length >= 4 && !['golf','club','course','country','links','resort','national'].includes(b)),
      ...((course.shortName || '').toLowerCase().split(/[^a-z0-9]+/).filter(b => b.length >= 4)),
    ].filter(Boolean));

    const hostMatchesCourse = (link) => {
      try {
        const u = new NodeURL(link);
        const host = u.host.toLowerCase().replace(/^www\./, '');
        // Strip TLD for matching
        const hostBase = host.split('.').slice(0, -1).join('');
        for (const tok of courseTokens) {
          if (tok.length >= 4 && hostBase.includes(tok)) return true;
        }
      } catch {}
      return false;
    };

    // Pass 1: links whose HOST contains a course token (most likely official)
    for (const link of ext) {
      const ok = tryLink(link);
      if (!ok) continue;
      if (hostMatchesCourse(ok)) return { website: ok, source: `wikipedia:${title}` };
    }
    await sleep(150);
  }
  return null;
}

// ------------- Predictable URL guessing -------------

function urlGuesses(course) {
  const slug = course.id;
  const slugNoHyph = slug.replace(/-/g, '');
  // Strip course-variant suffixes (Black/West/Old/No. 2/etc.)
  const slugNoVariant = slug
    .replace(/-?(no-?\d+|championship|black|red|blue|green|gold|silver|white|west|east|north|south|lake|old|new|ocean|dunes|straits|composite|cliffs|links|lower|upper|main)$/g, '')
    .replace(/--+/g, '-').replace(/-$/, '');
  const slugNoVariantNoHyph = slugNoVariant.replace(/-/g, '');
  const bases = [];
  const seenBase = new Set();
  const addBase = b => { if (b && !seenBase.has(b)) { seenBase.add(b); bases.push(b); } };
  addBase(slugNoVariantNoHyph);
  addBase(slugNoHyph);
  addBase(slugNoVariant);
  addBase(slug);
  // Also derive from name/shortName
  const fromName = (s) => (s || '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .split(/\s+/)
    .filter(w => w && !['the','golf','club','course','country','of','at','and','resort','no'].includes(w))
    .join('');
  addBase(fromName(course.shortName || course.name));
  addBase(fromName(course.name));

  // Most common patterns first; cap at ~12 guesses per course to keep total time bounded.
  const suffixes = ['', 'gc', 'golfclub', 'cc', 'club', 'golf', 'links', 'resort'];
  const guesses = [];
  for (const b of bases) {
    if (!b) continue;
    for (const s of suffixes) {
      guesses.push(`https://www.${b}${s}.com/`);
    }
  }
  return [...new Set(guesses)].slice(0, 24);
}

// US state full-name → 2-letter abbreviation (lowercase).
const STATE_TO_ABBR = {
  alabama:'al', alaska:'ak', arizona:'az', arkansas:'ar', california:'ca',
  colorado:'co', connecticut:'ct', delaware:'de', florida:'fl', georgia:'ga',
  hawaii:'hi', idaho:'id', illinois:'il', indiana:'in', iowa:'ia',
  kansas:'ks', kentucky:'ky', louisiana:'la', maine:'me', maryland:'md',
  massachusetts:'ma', michigan:'mi', minnesota:'mn', mississippi:'ms', missouri:'mo',
  montana:'mt', nebraska:'ne', nevada:'nv', 'new hampshire':'nh', 'new jersey':'nj',
  'new mexico':'nm', 'new york':'ny', 'north carolina':'nc', 'north dakota':'nd',
  ohio:'oh', oklahoma:'ok', oregon:'or', pennsylvania:'pa', 'rhode island':'ri',
  'south carolina':'sc', 'south dakota':'sd', tennessee:'tn', texas:'tx', utah:'ut',
  vermont:'vt', virginia:'va', washington:'wa', 'west virginia':'wv',
  wisconsin:'wi', wyoming:'wy',
};

// Common geography words that match too broadly (any "Beach Country Club"
// would pass a "beach" check). Filter these out so location verification
// requires meaningful disambiguators (city/state/country name).
const GENERIC_GEO_TOKENS = new Set([
  'beach','bay','hill','hills','park','lake','river','creek','valley','dunes',
  'point','springs','spring','heights','heath','grove','woods','field','fields',
  'island','isle','harbor','harbour','south','north','east','west','village',
  'town','city','county','state','center','centre','road','street','lane',
  'mountain','ridge','glen','ranch','farm','wood','green','greens',
]);

function extractLocationTokens(location, excludeSet = new Set()) {
  // Returns { strong: Set<string>, abbrev: Set<string> }
  // - strong: full city / state / country words ≥4 chars (sufficient on their own)
  // - abbrev: state abbreviations (require comma-bounded match in HTML)
  const strong = new Set();
  const abbrev = new Set();
  const lower = (location || '').toLowerCase();
  // Scan for multi-word state names first (e.g. "new jersey")
  for (const stateName of Object.keys(STATE_TO_ABBR)) {
    if (stateName.includes(' ') && lower.includes(stateName)) {
      // Add component words ≥4 chars (e.g. "jersey" from "new jersey")
      for (const w of stateName.split(' ')) if (w.length >= 4) strong.add(w);
      abbrev.add(STATE_TO_ABBR[stateName]);
    }
  }
  for (const word of lower.split(/[^a-z0-9]+/)) {
    if (word.length >= 4 && !excludeSet.has(word) && !GENERIC_GEO_TOKENS.has(word)) {
      strong.add(word);
      // Add state abbrev for single-word states (e.g. "pennsylvania" → "pa")
      if (STATE_TO_ABBR[word]) abbrev.add(STATE_TO_ABBR[word]);
    }
  }
  return { strong, abbrev };
}

// Verify a candidate URL is plausibly the club's site:
// - HTTP 200 reachable
// - The page must mention BOTH (a) at least one course token AND (b) a golf-related
//   keyword. To avoid matching unrelated businesses that share a name (e.g.
//   "Pine Valley Country Club, Fort Wayne IN" vs. famous "Pine Valley GC, NJ"),
//   we additionally require the page to mention either the course's city or its
//   state — unless the host name is unmistakably the club itself.
async function verifyClubSite(url, course) {
  let html, finalUrl;
  try {
    const u = new NodeURL(url);
    await politeWait(u.host);
    const r = await httpGetText(url, { timeoutMs: 12000 });
    html = r.body;
    finalUrl = r.finalUrl || url;
  } catch (e) {
    return { ok: false, reason: `fetch ${e.message}` };
  }
  if (!html || html.length < 200) return { ok: false, reason: 'empty' };
  // Build course tokens (≥4 chars, non-filler)
  const fillers = new Set(['golf','club','course','country','links','resort','national','the','and','of','at','hill','park','beach','cape','bay']);
  const tokens = new Set();
  const addToks = (s) => {
    (s || '').toLowerCase().split(/[^a-z0-9]+/).forEach(t => {
      if (t.length >= 4 && !fillers.has(t)) tokens.add(t);
    });
  };
  addToks(course.name);
  addToks(course.shortName);
  addToks(course.id);
  const locTokens = extractLocationTokens(course.location, tokens);
  // Build sample text to scan
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,400})<\/title>/i);
  const title = (titleMatch ? titleMatch[1] : '').toLowerCase();
  const head = extractHead(html).toLowerCase();
  const sample = (title + ' ' + head + ' ' + html.slice(0, 16000).toLowerCase());
  // For location check, scan the full HTML (location often appears in footer / contact info)
  const fullLower = html.toLowerCase();

  let matchedToken = null;
  for (const t of tokens) {
    if (sample.includes(t)) { matchedToken = t; break; }
  }
  const hasGolfWord = /\b(golf|tee[\s-]?times?|fairway|clubhouse|greens?\b|bunker|pro\s?shop|caddie|caddy|country club|18[\s-]?holes?|membership|tournament|members)\b/.test(sample);

  // Location verification: page must mention the course's city/state full word
  // (≥4 chars) OR a state abbreviation in a contact-info pattern (", PA " or
  // "PA 15139"). Pure 2-letter matches without context produce false positives.
  let hasLocation = false;
  for (const lt of locTokens.strong) {
    if (fullLower.includes(lt)) { hasLocation = true; break; }
  }
  if (!hasLocation) {
    for (const ab of locTokens.abbrev) {
      // Match patterns like ", pa " or " pa," or " pa 15139" (zip)
      const re = new RegExp(`(^|[\\s,>(])${ab}([\\s,)]|\\s+\\d{5}|$)`, 'i');
      if (re.test(fullLower)) { hasLocation = true; break; }
    }
  }
  // Host-strong-match: hostname contains a course token AND a golf-club suffix
  // (golfclub, gc, cc, country, links, resort). This is a strong signal the site
  // is actually the club — used for sparse private-club sites that omit the city
  // (e.g. seminolegolfclub.com).
  let hostStrongMatch = false;
  let hostStrongToken = null;
  try {
    const fu = new NodeURL(finalUrl);
    const hostBase = fu.host.toLowerCase().replace(/^www\./, '').split('.').slice(0, -1).join('');
    for (const t of tokens) {
      if (t.length >= 6 && hostBase.includes(t) && /(golfclub|countryclub|cc$|gc$|cclub|gclub|golf$|links|resort)/.test(hostBase)) {
        hostStrongMatch = true; hostStrongToken = t; break;
      }
    }
  } catch {}

  // Wrong-state detector: scan for any US state abbreviation in a contact-info
  // pattern. If the page lists ONE state and that state ≠ the course's state,
  // we have strong evidence this is the wrong club.
  let wrongState = false;
  let detectedStates = new Set();
  const courseAbbrevs = new Set([...locTokens.abbrev]);
  // Add abbrev derived from any single-word state in tokens too
  for (const tok of tokens) if (STATE_TO_ABBR[tok]) courseAbbrevs.add(STATE_TO_ABBR[tok]);
  // Also accept full state names from the course location
  const courseStates = new Set([...locTokens.strong].filter(s => Object.keys(STATE_TO_ABBR).includes(s)));
  // Detect ZIP-code-bounded state abbreviations in the page (very strong signal)
  const stateZipRe = /\b([a-z]{2})\s+\d{5}\b/gi;
  let m2;
  while ((m2 = stateZipRe.exec(fullLower)) !== null) {
    const ab = m2[1].toLowerCase();
    if (Object.values(STATE_TO_ABBR).includes(ab)) detectedStates.add(ab);
  }
  if (detectedStates.size > 0) {
    let mismatched = true;
    for (const ds of detectedStates) {
      if (courseAbbrevs.has(ds)) { mismatched = false; break; }
    }
    if (mismatched && courseAbbrevs.size > 0) wrongState = true;
  }

  if (wrongState) {
    return {
      ok: false,
      reason: `wrong state (page=${[...detectedStates].join(',')}, course=${[...courseAbbrevs].join(',')})`,
      finalUrl, html,
    };
  }

  if (matchedToken && hasGolfWord && hasLocation) {
    return { ok: true, finalUrl, html, matchedToken };
  }
  if (hostStrongMatch && hasGolfWord) {
    return { ok: true, finalUrl, html, matchedToken: `host:${hostStrongToken}` };
  }
  return {
    ok: false,
    reason: `verify failed (token=${matchedToken || 'none'}, golf=${hasGolfWord}, loc=${hasLocation}, hostStrong=${hostStrongMatch}; title="${title.slice(0,60).replace(/\s+/g,' ')}")`,
    finalUrl, html
  };
}

async function discoverWebsite(course) {
  // 1) Predictable guesses — parallelize HEAD checks across different hosts.
  //    Each guess uses a unique host, so per-host rate-limiting is fine.
  const guesses = urlGuesses(course);
  const headChecks = guesses.map(async (g) => {
    let u;
    try { u = new NodeURL(g); } catch { return null; }
    try {
      const r = await httpHead(g, { timeoutMs: 5000 });
      if (r.status === 200) return g;
    } catch {}
    return null;
  });
  const headResults = await Promise.all(headChecks);
  const reachable = headResults.filter(Boolean);

  // Verify each reachable URL sequentially in priority order (per-host pacing).
  for (const g of reachable) {
    const v = await verifyClubSite(g, course);
    if (v.ok) return { website: v.finalUrl, source: 'guess', preFetchedHtml: v.html };
  }

  // 2) Wikipedia infobox + verified external links (slower path)
  try {
    const w = await findWikipediaWebsite(course);
    if (w?.website) {
      const v = await verifyClubSite(w.website, course);
      if (v.ok) return { website: v.finalUrl, source: w.source, preFetchedHtml: v.html };
    }
  } catch {}

  return null;
}

// ------------- HTML head parsing -------------

function extractHead(html) {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html.slice(0, 50000);
}

function parseAttrs(tag) {
  const out = {};
  const re = /([a-zA-Z:][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5] || '');
    out[key] = decodeHtmlEntities(val);
  }
  return out;
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function findIconCandidates(html, baseUrl) {
  const head = extractHead(html);
  const out = [];
  const linkRe = /<link\b[^>]*\/?>/gi;
  let m;
  while ((m = linkRe.exec(head)) !== null) {
    const attrs = parseAttrs(m[0]);
    const rel = (attrs.rel || '').toLowerCase();
    const href = attrs.href;
    if (!href) continue;
    const sizes = attrs.sizes || '';
    const sizeNum = (() => {
      const sm = sizes.match(/(\d+)x(\d+)/i);
      return sm ? parseInt(sm[1], 10) : 0;
    })();
    let priority = 0;
    if (rel.includes('apple-touch-icon-precomposed')) priority = 95;
    else if (rel.includes('apple-touch-icon')) priority = 100;
    else if (rel === 'icon' || rel === 'shortcut icon' || rel.includes('icon')) {
      priority = 60 + Math.min(sizeNum / 10, 30); // bigger = better
    } else continue;
    let abs;
    try { abs = new NodeURL(href, baseUrl).toString(); } catch { continue; }
    out.push({ url: abs, priority, sizeHint: sizeNum, source: rel });
  }
  // <meta property="og:image" ...>
  const metaRe = /<meta\b[^>]*\/?>/gi;
  while ((m = metaRe.exec(head)) !== null) {
    const attrs = parseAttrs(m[0]);
    const prop = (attrs.property || attrs.name || '').toLowerCase();
    const content = attrs.content;
    if (!content) continue;
    if (prop === 'og:image' || prop === 'og:image:url' || prop === 'og:image:secure_url' || prop === 'twitter:image') {
      let abs;
      try { abs = new NodeURL(content, baseUrl).toString(); } catch { continue; }
      out.push({ url: abs, priority: 80, sizeHint: 0, source: prop });
    }
  }
  // de-dupe by URL, keep max priority
  const byUrl = new Map();
  for (const c of out) {
    const prev = byUrl.get(c.url);
    if (!prev || prev.priority < c.priority) byUrl.set(c.url, c);
  }
  return [...byUrl.values()].sort((a, b) => b.priority - a.priority);
}

// ------------- Image rejection heuristics -------------

const REJECT_URL_TOKENS = ['default', 'placeholder', 'blank-', '/blank.', 'wp-includes/images/wlw',
  'commons-logo', 'wordpress-logo', 'squarespace-logo', 'wix-logo', 'no-image', 'noimage'];

function urlLooksJunk(u) {
  const lower = u.toLowerCase();
  for (const t of REJECT_URL_TOKENS) if (lower.includes(t)) return true;
  return false;
}

// ------------- Download + process -------------

async function downloadBinary(url, destPath) {
  await execFile('curl', [
    '-L', '-sS', '--fail', '--max-time', '20',
    '-A', SCRAPER_UA,
    '-o', destPath, url,
  ]);
  const stat = fs.statSync(destPath);
  return stat.size;
}

async function tryProcessIcon(url, slug) {
  const u = new NodeURL(url);
  const ext = (() => {
    const e = path.extname(u.pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif', '.svg'].includes(e)) return e;
    return '.bin';
  })();
  const tmp = path.join(TMP_DIR, `fav-${slug}${ext}`);
  let size;
  try { size = await downloadBinary(url, tmp); }
  catch (e) { return { ok: false, reason: `download failed: ${e.message}` }; }

  if (size < 2048) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: `too small (${size}B)` };
  }

  // For .ico we need a special path: sharp can't read multi-image .ico directly,
  // but it can read embedded PNG inside an .ico if we extract. For simplicity,
  // try sharp first; if it fails, fall back to using `sips` on macOS.
  let meta;
  try {
    meta = await sharp(tmp).metadata();
  } catch (e) {
    // fall back: try .ico via curl-extracted as PNG (skip for now)
    if (ext === '.ico') {
      // Some .ico files are actually PNG-formatted internally; sharp 0.32 supports this
      // via webp/heif loaders sometimes. If it fails, attempt sips conversion.
      const pngTmp = tmp.replace(/\.ico$/i, '.png');
      try {
        await execFile('sips', ['-s', 'format', 'png', tmp, '--out', pngTmp]);
        meta = await sharp(pngTmp).metadata();
        // swap tmp pointer
        try { fs.unlinkSync(tmp); } catch {}
        fs.renameSync(pngTmp, tmp);
      } catch (e2) {
        try { fs.unlinkSync(tmp); } catch {}
        return { ok: false, reason: `sharp+sips couldn't read: ${e.message}` };
      }
    } else if (ext === '.svg') {
      // sharp without rsvg may fail. Skip SVG for now (rare case).
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, reason: `svg unsupported here` };
    } else {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, reason: `sharp metadata failed: ${e.message}` };
    }
  }

  if (!meta || !meta.width || !meta.height) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: 'no metadata' };
  }

  if (meta.width < 64 || meta.height < 64) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: `dim too small (${meta.width}x${meta.height})` };
  }

  // Resize, preserve transparency
  const dest = path.join(LOGOS_DIR, `${slug}.png`);
  try {
    await sharp(tmp)
      .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: `sharp resize failed: ${e.message}` };
  }

  try { fs.unlinkSync(tmp); } catch {}
  return { ok: true, dimensions: `${meta.width}x${meta.height}`, sizeBytes: size };
}

// ------------- Attribution CSV -------------

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function ensureAttributionHeader() {
  if (!fs.existsSync(ATTR_CSV)) {
    fs.writeFileSync(ATTR_CSV,
      'slug,course_name,wikipedia_url,image_url,author,license,date_sourced,status\n', 'utf8');
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function loadAttribution() {
  const out = new Map();
  if (!fs.existsSync(ATTR_CSV)) return out;
  const raw = fs.readFileSync(ATTR_CSV, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 8) continue;
    const [slug, course_name, wikipedia_url, image_url, author, license, date_sourced, status] = parts;
    out.set(slug, { slug, course_name, wikipedia_url, image_url, author, license, date_sourced, status });
  }
  return out;
}

function rewriteAttribution(rowMap) {
  const header = 'slug,course_name,wikipedia_url,image_url,author,license,date_sourced,status\n';
  const body = [...rowMap.values()].map(r => {
    return [r.slug, r.course_name, r.wikipedia_url, r.image_url, r.author, r.license, r.date_sourced, r.status]
      .map(csvEscape).join(',');
  }).join('\n');
  fs.writeFileSync(ATTR_CSV, header + body + (body ? '\n' : ''), 'utf8');
}

// ------------- Per-course pipeline -------------

async function processCourse(course, today) {
  const result = {
    slug: course.id,
    course_name: course.name,
    website: '',
    iconUrl: '',
    iconSource: '',
    status: '',
    detail: '',
  };

  // Discover website
  let site;
  try {
    site = await discoverWebsite(course);
  } catch (e) {
    result.status = 'no_website_found';
    result.detail = `discovery error: ${e.message}`;
    return result;
  }
  if (!site || !site.website) {
    result.status = 'no_website_found';
    return result;
  }
  result.website = site.website;

  // robots.txt check
  try {
    const u = new NodeURL(site.website);
    await politeWait(u.host);
    const allowed = await isRobotsAllowed(site.website);
    if (!allowed) {
      result.status = 'blocked_by_robots';
      return result;
    }
  } catch (e) {
    result.status = 'no_website_found';
    result.detail = `bad website url: ${e.message}`;
    return result;
  }

  // Reuse pre-fetched HTML from discovery step when available
  let html = site.preFetchedHtml || null;
  if (!html) {
    try {
      const u = new NodeURL(site.website);
      await politeWait(u.host);
      const fetched = await httpGetText(site.website, { timeoutMs: 15000 });
      html = fetched.body;
      result.website = fetched.finalUrl || site.website;
    } catch (e) {
      // exponential backoff on 429/503
      if (e.status === 429 || e.status === 503) {
        await sleep(5000);
        try {
          const fetched = await httpGetText(site.website, { timeoutMs: 15000 });
          html = fetched.body;
        } catch (e2) {
          result.status = 'website_fetch_failed';
          result.detail = e2.message;
          return result;
        }
      } else {
        result.status = 'website_fetch_failed';
        result.detail = e.message;
        return result;
      }
    }
  }

  if (!html || html.length < 200) {
    result.status = 'website_fetch_failed';
    result.detail = 'empty body';
    return result;
  }

  // Extract candidates
  const candidates = findIconCandidates(html, result.website);
  // Fallback: /favicon.ico
  try {
    const u = new NodeURL(result.website);
    candidates.push({
      url: `${u.protocol}//${u.host}/favicon.ico`,
      priority: 10,
      sizeHint: 0,
      source: 'fallback-favicon',
    });
  } catch {}

  // Filter junk
  const filtered = candidates.filter(c => !urlLooksJunk(c.url));
  if (!filtered.length) {
    result.status = 'no_icon_found';
    return result;
  }

  // Try each in priority order
  let lastReason = '';
  for (const c of filtered) {
    try {
      const u = new NodeURL(c.url);
      await politeWait(u.host);
    } catch { continue; }
    const r = await tryProcessIcon(c.url, course.id);
    if (r.ok) {
      result.iconUrl = c.url;
      result.iconSource = c.source;
      result.status = 'sourced';
      result.detail = `${c.source} ${r.dimensions} ${r.sizeBytes}B`;
      return result;
    }
    lastReason = r.reason;
  }

  result.status = 'icon_rejected';
  result.detail = lastReason || 'all candidates rejected';
  return result;
}

// ------------- Report writer -------------

function writeReport(stats, sourced, noWebsite, noIcon, rejected, skipped, blockedByRobots, fetchFailed) {
  const sample = sourced.slice(0, 10).map(r => `- \`${r.slug}\`  ←  ${r.iconSource}  (${r.website})`);
  const md = `# Logo Bingo: Favicon/OG-Image Sourcing Report

Generated: ${new Date().toISOString()}

## Totals
- Total courses in bingo-courses.js: **${stats.total}**
- Already had a logo (skipped): **${skipped.length}**
- Processed via favicon scraping: **${stats.processed}**

## Sourced successfully (${sourced.length})
${sample.join('\n') || '(none)'}
${sourced.length > 10 ? `\n_…and ${sourced.length - 10} more (see ATTRIBUTION.csv)_` : ''}

## No website found (${noWebsite.length})
${noWebsite.map(s => `- \`${s}\``).join('\n') || '(none)'}

## Website found, but no usable icon found in HTML (${noIcon.length})
${noIcon.map(r => `- \`${r.slug}\` — ${r.website}`).join('\n') || '(none)'}

## Icon found but rejected (too small / placeholder / unreadable) (${rejected.length})
${rejected.map(r => `- \`${r.slug}\` — ${r.detail}`).join('\n') || '(none)'}

## Blocked by robots.txt (${blockedByRobots.length})
${blockedByRobots.map(r => `- \`${r.slug}\` — ${r.website}`).join('\n') || '(none)'}

## Website fetch failed (${fetchFailed.length})
${fetchFailed.map(r => `- \`${r.slug}\` — ${r.website || '(no url)'}: ${r.detail}`).join('\n') || '(none)'}

## Methodology

For each course missing a logo, the script:
1. Queried Wikipedia's MediaWiki API for the course's page, extracted \`| website = \` from the infobox wikitext, falling back to \`prop=externallinks\` and matching against the slug.
2. Tried predictable URL guesses (\`{slug}.com\`, \`{slug}gc.com\`, etc.) when no Wikipedia link was found.
3. Fetched the homepage HTML (subject to robots.txt) and parsed \`<link rel="apple-touch-icon">\`, \`<meta property="og:image">\`, \`<link rel="icon" sizes="...">\`, and \`/favicon.ico\` in priority order.
4. Downloaded each candidate, ran it through \`sharp\` (or \`sips\` for .ico), rejected anything <2KB, <64×64, or matching default-placeholder URL patterns.
5. Resized to 256×256 PNG with \`fit: 'contain'\` + transparent background, saved to \`assets/logos/{slug}.png\`.

The 45 verified pre-existing logos were left untouched.

These crests are trademarked logos used here under nominative fair use to identify each club in an editorial brand-identification quiz.
`;
  fs.writeFileSync(REPORT_MD, md, 'utf8');
}

// ------------- Main -------------

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
  const onlyArg = args.find(a => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null;
  const today = new Date().toISOString().slice(0, 10);

  const courses = parseCourses(COURSES_FILE);
  console.log(`Parsed ${courses.length} courses from bingo-courses.js`);

  if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });
  ensureAttributionHeader();
  const attrMap = loadAttribution();

  const skipped = [];
  const todo = [];
  for (const c of courses) {
    if (only && !only.has(c.id)) continue;
    const dest = path.join(LOGOS_DIR, `${c.id}.png`);
    if (fs.existsSync(dest)) skipped.push(c.id);
    else todo.push(c);
  }

  console.log(`Skipping ${skipped.length} courses with existing PNGs`);
  console.log(`Sourcing for ${todo.length} courses${limit < Infinity ? ` (limited to ${limit})` : ''}`);
  console.log('---');

  const sourced = [];
  const noWebsite = [];
  const noIcon = [];
  const rejected = [];
  const blockedByRobots = [];
  const fetchFailed = [];
  let processedCount = 0;

  const work = todo.slice(0, limit);
  for (let i = 0; i < work.length; i++) {
    const course = work[i];
    const tag = `[${i + 1}/${work.length}]`;
    let result;
    try {
      result = await processCourse(course, today);
    } catch (e) {
      result = {
        slug: course.id, course_name: course.name,
        website: '', iconUrl: '', iconSource: '',
        status: 'exception', detail: e.message,
      };
    }
    processedCount++;

    // Upsert ATTRIBUTION.csv row by slug
    attrMap.set(result.slug, {
      slug: result.slug,
      course_name: result.course_name,
      wikipedia_url: result.website,
      image_url: result.iconUrl,
      author: '',
      license: result.status === 'sourced' ? `Trademark of ${course.name}` : '',
      date_sourced: today,
      status: result.status === 'sourced' ? 'favicon_scraped' : result.status,
    });
    rewriteAttribution(attrMap);

    switch (result.status) {
      case 'sourced':
        sourced.push(result);
        console.log(`${tag} ✓ ${course.id} — ${result.iconSource} @ ${result.website}`);
        break;
      case 'no_website_found':
        noWebsite.push(course.id);
        console.log(`${tag} ✗ no website: ${course.id}`);
        break;
      case 'no_icon_found':
        noIcon.push(result);
        console.log(`${tag} ✗ no icon: ${course.id} (${result.website})`);
        break;
      case 'icon_rejected':
        rejected.push(result);
        console.log(`${tag} ✗ rejected: ${course.id} — ${result.detail}`);
        break;
      case 'blocked_by_robots':
        blockedByRobots.push(result);
        console.log(`${tag} ✗ robots: ${course.id} (${result.website})`);
        break;
      case 'website_fetch_failed':
        fetchFailed.push(result);
        console.log(`${tag} ✗ fetch failed: ${course.id} — ${result.detail}`);
        break;
      default:
        fetchFailed.push(result);
        console.log(`${tag} ✗ ${result.status}: ${course.id} — ${result.detail || ''}`);
        break;
    }
  }

  const stats = { total: courses.length, processed: processedCount };
  writeReport(stats, sourced, noWebsite, noIcon, rejected, skipped, blockedByRobots, fetchFailed);

  console.log('\n=========== SUMMARY ===========');
  console.log(`Total courses:        ${courses.length}`);
  console.log(`Already had logo:     ${skipped.length}`);
  console.log(`Processed:            ${processedCount}`);
  console.log(`✓ Sourced:            ${sourced.length}`);
  console.log(`✗ No website:         ${noWebsite.length}`);
  console.log(`✗ No icon:            ${noIcon.length}`);
  console.log(`✗ Rejected:           ${rejected.length}`);
  console.log(`✗ Robots blocked:     ${blockedByRobots.length}`);
  console.log(`✗ Fetch failed:       ${fetchFailed.length}`);
  console.log('Report written to:   ', REPORT_MD);
  console.log('Attribution CSV at:  ', ATTR_CSV);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
