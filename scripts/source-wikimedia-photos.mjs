#!/usr/bin/env node
/**
 * source-wikimedia-photos.mjs
 *
 * Sources CC-licensed clubhouse / course photos from Wikimedia Commons
 * to fill in missing course logos for the TeeBox Logo Bingo game.
 *
 * - Reads /bingo-courses.js to get the course list
 * - Skips slugs that already have an existing /assets/logos/{slug}.png
 * - For each remaining slug, queries the MediaWiki API for the page's
 *   main image (and falls back to all images if needed)
 * - Validates each candidate's license is commercial-permissive (CC BY/BY-SA, PD, CC0)
 * - Downloads the original image, resizes to 256x256 cover-cropped PNG via sharp,
 *   and saves to /assets/logos/{slug}.png
 * - Appends an attribution row to /assets/logos/ATTRIBUTION.csv
 * - Writes a summary report to /assets/logos/SOURCING_REPORT.md
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath, URL } from 'node:url';
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
const REPORT_MD = path.join(LOGOS_DIR, 'SOURCING_REPORT.md');
const TMP_DIR = '/tmp';

const USER_AGENT =
  'TeeBoxLogoBingo/1.0 (https://teeboxmarket.app; jakenair23@gmail.com) node-fetch';

const ACCEPTABLE_LICENSES = [
  'cc by 2.0',
  'cc by 3.0',
  'cc by 4.0',
  'cc by-sa 2.0',
  'cc by-sa 2.5',
  'cc by-sa 3.0',
  'cc by-sa 4.0',
  'cc0',
  'public domain',
  'pd',
  'pd-self',
  'pd-usgov',
  'pd-us',
];

const REJECT_KEYWORDS = ['fair use', 'non-commercial', 'noncommercial', 'non-free', 'gfdl only', 'no derivatives', 'nd 2.0', 'nd 3.0', 'nd 4.0'];

// ------------- Utilities -------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    };
    https
      .get(url, opts, res => {
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
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function downloadFile(url, destPath) {
  // curl -L follows redirects; saves binary
  await execFile('curl', ['-L', '-sS', '--fail', '--max-time', '60', '-A', USER_AGENT, '-o', destPath, url]);
  const stat = fs.statSync(destPath);
  if (stat.size < 200) {
    throw new Error(`Downloaded file too small: ${stat.size} bytes`);
  }
  return stat.size;
}

// ------------- Course parsing -------------

function parseCourses(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Each course entry is an object literal containing at minimum `id:` and `name:`.
  // Walk all `id: '<slug>'` occurrences, then in a forward window try to extract
  // the matching name / location / architect. Support both '...' and "..." quoting.
  const courses = [];
  const idRe = /^\s+id:\s*['"]([^'"]+)['"],/gm;
  // For each field we accept either single or double quoted strings.
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
    // Window forward up to the next id: line, so we don't accidentally consume
    // fields from the following entry.
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

// ------------- Wikipedia/Commons API logic -------------

function buildTitleCandidates(course) {
  const out = [];
  const add = s => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
  };

  const name = course.name.trim();
  const shortName = (course.shortName || '').trim();

  // Strip common parenthetical course-identifier suffixes: "(Black)", "(West)", "(Lake)", etc.
  const stripParen = s => s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
  const baseName = stripParen(name);
  const baseShort = stripParen(shortName);

  // Primary candidates
  add(name);
  add(baseName);
  if (shortName) add(shortName);
  if (baseShort) add(baseShort);

  // Strip leading "The"
  for (const v of [name, baseName, shortName, baseShort]) {
    if (!v) continue;
    const stripped = v.replace(/^The\s+/i, '');
    if (stripped !== v) add(stripped);
  }

  // Add common golf-club suffixes if not already present in the candidate
  const suffixes = ['Golf Club', 'Country Club', 'Golf Links', 'Golf Course', 'Golf Resort', 'Resort'];
  for (const v of [...out]) {
    const lower = v.toLowerCase();
    const hasSuffix = /(golf club|country club|golf links|golf course|golf resort|resort| gc| cc| club| links)\b/i.test(lower);
    if (!hasSuffix) {
      for (const s of suffixes) add(`${v} ${s}`);
    }
  }

  // Strip suffixes like " Resort" -> " Golf Resort" (Bandon Dunes Resort → Bandon Dunes Golf Resort)
  for (const v of [...out]) {
    if (/\bResort\b/i.test(v) && !/\bGolf Resort\b/i.test(v)) {
      add(v.replace(/\bResort\b/i, 'Golf Resort'));
    }
  }

  // Variation: replace "(X)" with " X Course" — Bethpage State Park (Black) → Bethpage Black Course
  const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const head = m[1].trim();
    const inside = m[2].trim();
    add(`${head} ${inside} Course`);
    add(`${head} ${inside}`);
    // Try moving the (X) to the front of the second word: "Bethpage Black"
    const headShort = head.replace(/State Park$/i, '').trim();
    if (headShort && headShort !== head) {
      add(`${headShort} ${inside}`);
      add(`${headShort} ${inside} Course`);
    }
  }

  // Try with city for disambiguation
  if (course.location) {
    const city = course.location.split(',')[0].trim();
    if (city) {
      const lower = name.toLowerCase();
      if (!lower.includes(city.toLowerCase())) {
        add(`${baseName} (${city})`);
      }
    }
  }

  return out;
}

function normalizeLicense(s) {
  if (!s) return '';
  return String(s).toLowerCase().trim();
}

function isAcceptableLicense(rawLicense) {
  const lic = normalizeLicense(rawLicense);
  if (!lic) return false;
  for (const reject of REJECT_KEYWORDS) {
    if (lic.includes(reject)) return false;
  }
  for (const ok of ACCEPTABLE_LICENSES) {
    if (lic === ok || lic.includes(ok)) return true;
  }
  return false;
}

function isAcceptableFormat(filename) {
  if (!filename) return false;
  const f = filename.toLowerCase();
  return f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png') || f.endsWith('.tif') || f.endsWith('.tiff') || f.endsWith('.webp');
}

async function findWikipediaPage(course) {
  const candidates = buildTitleCandidates(course);
  for (const title of candidates) {
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages|info&inprop=url&piprop=original|name&pithumbsize=1024&format=json&redirects=1&titles=${encodeURIComponent(title)}`;
    let resp;
    try {
      resp = await httpGetJson(url);
    } catch (e) {
      continue;
    }
    const pages = resp?.query?.pages || {};
    for (const pageId of Object.keys(pages)) {
      if (pageId === '-1') continue;
      const page = pages[pageId];
      if (!page || page.missing !== undefined) continue;
      if (/disambiguation/i.test(page.title || '')) continue;
      return {
        title: page.title,
        canonicalurl: page.fullurl || page.canonicalurl || '',
        pageImageFile: page.pageimage ? `File:${page.pageimage}` : null,
      };
    }
    await sleep(150);
  }
  // Fallback: full-text search via opensearch / search API
  const searchTerms = [
    `${course.name} golf`,
    course.shortName ? `${course.shortName} golf` : '',
    course.location ? `${course.name} ${course.location.split(',')[0]} golf` : '',
  ].filter(Boolean);
  for (const term of searchTerms) {
    const surl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&srlimit=5&format=json`;
    let resp;
    try {
      resp = await httpGetJson(surl);
    } catch (e) {
      continue;
    }
    const hits = resp?.query?.search || [];
    for (const hit of hits) {
      const title = hit.title;
      if (!title) continue;
      const lower = title.toLowerCase();
      if (/disambiguation/i.test(lower)) continue;
      // Filter to titles that actually look like a golf course / club / resort article.
      if (!/(golf|club|links|resort|country|course)/i.test(lower)) continue;
      // Confirm the page exists and grab its main image
      const url2 =
        `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages|info&inprop=url&piprop=original|name&pithumbsize=1024&format=json&redirects=1&titles=${encodeURIComponent(title)}`;
      let resp2;
      try {
        resp2 = await httpGetJson(url2);
      } catch (e) {
        continue;
      }
      const pages = resp2?.query?.pages || {};
      for (const pid of Object.keys(pages)) {
        if (pid === '-1') continue;
        const p = pages[pid];
        if (!p || p.missing !== undefined) continue;
        return {
          title: p.title,
          canonicalurl: p.fullurl || p.canonicalurl || '',
          pageImageFile: p.pageimage ? `File:${p.pageimage}` : null,
        };
      }
      await sleep(150);
    }
    await sleep(200);
  }
  return null;
}

async function listPageImages(pageTitle) {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&prop=images&imlimit=50&format=json&redirects=1&titles=${encodeURIComponent(pageTitle)}`;
  let resp;
  try {
    resp = await httpGetJson(url);
  } catch (e) {
    return [];
  }
  const pages = resp?.query?.pages || {};
  const out = [];
  for (const pageId of Object.keys(pages)) {
    const page = pages[pageId];
    if (!page || !page.images) continue;
    for (const img of page.images) {
      if (img.title) out.push(img.title);
    }
  }
  return out;
}

async function getImageInfo(fileTitle) {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata|mime|size&format=json&titles=${encodeURIComponent(fileTitle)}`;
  let resp;
  try {
    resp = await httpGetJson(url);
  } catch (e) {
    return null;
  }
  const pages = resp?.query?.pages || {};
  for (const pid of Object.keys(pages)) {
    const page = pages[pid];
    const ii = page?.imageinfo?.[0];
    if (!ii) continue;
    const meta = ii.extmetadata || {};
    const license =
      meta.LicenseShortName?.value ||
      meta.License?.value ||
      meta.UsageTerms?.value ||
      '';
    const author =
      stripHtml(meta.Artist?.value || '') ||
      stripHtml(meta.Credit?.value || '') ||
      '';
    return {
      title: page.title,
      url: ii.url,
      mime: ii.mime,
      width: ii.width,
      height: ii.height,
      license,
      licenseUrl: meta.LicenseUrl?.value || '',
      author,
      descriptionUrl: ii.descriptionurl || '',
    };
  }
  return null;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------- Image processing -------------

async function processToSquarePng(srcPath, destPath) {
  await sharp(srcPath)
    .resize(256, 256, { fit: 'cover', position: 'attention' })
    .png({ compressionLevel: 9 })
    .toFile(destPath);
}

// ------------- Attribution CSV -------------

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function ensureAttributionHeader() {
  if (!fs.existsSync(ATTR_CSV)) {
    fs.writeFileSync(
      ATTR_CSV,
      'slug,course_name,wikipedia_url,image_url,author,license,date_sourced,status\n',
      'utf8'
    );
  }
}

// Read existing attribution rows; keep only the most recent entry per slug.
function loadAttribution() {
  const out = new Map();
  if (!fs.existsSync(ATTR_CSV)) return out;
  const raw = fs.readFileSync(ATTR_CSV, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Lightweight CSV parse: split on commas not inside quotes.
    const parts = parseCsvLine(line);
    if (parts.length < 8) continue;
    const [slug, course_name, wikipedia_url, image_url, author, license, date_sourced, status] = parts;
    out.set(slug, { slug, course_name, wikipedia_url, image_url, author, license, date_sourced, status });
  }
  return out;
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

// Rewrite the CSV file from a Map<slug, row> (preserving header).
function rewriteAttribution(rowMap) {
  const header = 'slug,course_name,wikipedia_url,image_url,author,license,date_sourced,status\n';
  const body = [...rowMap.values()].map(r => {
    return [r.slug, r.course_name, r.wikipedia_url, r.image_url, r.author, r.license, r.date_sourced, r.status]
      .map(csvEscape)
      .join(',');
  }).join('\n');
  fs.writeFileSync(ATTR_CSV, header + body + (body ? '\n' : ''), 'utf8');
}

function appendAttribution(row) {
  const cols = [
    row.slug,
    row.course_name,
    row.wikipedia_url,
    row.image_url,
    row.author,
    row.license,
    row.date_sourced,
    row.status,
  ].map(csvEscape);
  fs.appendFileSync(ATTR_CSV, cols.join(',') + '\n', 'utf8');
}

// ------------- Per-course pipeline -------------

async function processCourse(course, today) {
  const result = {
    slug: course.id,
    course_name: course.name,
    wikipedia_url: '',
    image_url: '',
    author: '',
    license: '',
    date_sourced: today,
    status: '',
    failureReason: '',
  };

  const page = await findWikipediaPage(course);
  if (!page) {
    result.status = 'no_wikipedia_article';
    result.failureReason = 'no Wikipedia article found';
    return result;
  }
  result.wikipedia_url = page.canonicalurl;

  // Try the page's main image first
  const candidates = [];
  if (page.pageImageFile) candidates.push(page.pageImageFile);

  // Fallback: list all page images and append (de-duping the main one)
  await sleep(200);
  const moreImages = await listPageImages(page.title);
  for (const t of moreImages) {
    if (!candidates.includes(t)) candidates.push(t);
  }

  if (candidates.length === 0) {
    result.status = 'no_images_on_page';
    result.failureReason = 'page has no images';
    return result;
  }

  let acceptedInfo = null;
  let rejectedAnyForLicense = false;
  let rejectedAnyForFormat = false;

  // Filter and rank candidates:
  //  - drop obvious non-photos (svg, logos, maps, locators, flags, coats)
  //  - prefer images whose filename references the course / club / hole / clubhouse
  const courseKeywords = [course.id.split('-')[0], course.name.split(' ')[0], course.shortName.split(' ')[0]]
    .filter(Boolean)
    .map(s => s.toLowerCase());
  const photoKeywords = ['hole', 'green', 'tee', 'fairway', 'clubhouse', 'aerial', 'view', 'course', 'links', 'golf', 'bunker'];
  const isJunk = (title) => {
    const lower = title.toLowerCase();
    return lower.endsWith('.svg') ||
      lower.includes('logo') ||
      lower.includes('icon') ||
      lower.includes('map of ') ||
      lower.includes('relief location') ||
      lower.includes('locator') ||
      lower.includes('flag of ') ||
      lower.includes('coat of arms') ||
      lower.includes('commons-logo') ||
      lower.includes('symbol') ||
      lower.includes('question_book') ||
      lower.includes('pictogram') ||
      lower.includes('blank.svg');
  };
  const score = (title) => {
    const lower = title.toLowerCase();
    let s = 0;
    for (const kw of courseKeywords) if (kw && lower.includes(kw)) s += 5;
    for (const kw of photoKeywords) if (lower.includes(kw)) s += 1;
    return s;
  };
  const ranked = candidates
    .filter(t => !isJunk(t))
    .map(t => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s)
    .map(({ t }) => t);

  for (const fileTitle of ranked) {
    if (!isAcceptableFormat(fileTitle)) {
      rejectedAnyForFormat = true;
      continue;
    }

    await sleep(200);
    const info = await getImageInfo(fileTitle);
    if (!info) continue;
    if (!info.url) continue;

    if (!isAcceptableLicense(info.license)) {
      rejectedAnyForLicense = true;
      continue;
    }
    // We have a winner.
    acceptedInfo = info;
    break;
  }

  if (!acceptedInfo) {
    if (rejectedAnyForLicense) {
      result.status = 'no_acceptable_license';
      result.failureReason = 'all candidate images had unacceptable licenses';
    } else if (rejectedAnyForFormat) {
      result.status = 'no_usable_format';
      result.failureReason = 'no JPG/PNG raster image found';
    } else {
      result.status = 'no_candidate_images';
      result.failureReason = 'no usable candidate images';
    }
    return result;
  }

  result.image_url = acceptedInfo.descriptionUrl || acceptedInfo.url;
  result.author = acceptedInfo.author;
  result.license = acceptedInfo.license;

  // Download and process
  const tmpFile = path.join(TMP_DIR, `wiki-${course.id}${path.extname(new URL(acceptedInfo.url).pathname) || '.jpg'}`);
  try {
    await downloadFile(acceptedInfo.url, tmpFile);
  } catch (e) {
    result.status = 'download_failed';
    result.failureReason = `download failed: ${e.message}`;
    return result;
  }

  const destPath = path.join(LOGOS_DIR, `${course.id}.png`);
  try {
    await processToSquarePng(tmpFile, destPath);
  } catch (e) {
    result.status = 'sharp_failed';
    result.failureReason = `sharp failed: ${e.message}`;
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    return result;
  }

  try {
    fs.unlinkSync(tmpFile);
  } catch {}

  result.status = 'sourced';
  return result;
}

// ------------- Report writer -------------

function writeReport(stats, sourcedSlugs, failedNoArticle, failedNoLicense, failedNoFormat, failedOther, skipped) {
  const sample = sourcedSlugs.slice(0, 10);
  const md = `# Logo Bingo: Wikimedia Sourcing Report

Generated: ${new Date().toISOString()}

## Totals
- Total courses in bingo-courses.js: **${stats.total}**
- Already had a logo (skipped): **${skipped.length}**
- Processed via Wikimedia: **${stats.processed}**

## Sourced (${sourcedSlugs.length})
${sample.map(s => `- \`${s}\``).join('\n') || '(none)'}
${sourcedSlugs.length > 10 ? `\n_…and ${sourcedSlugs.length - 10} more (see \`ATTRIBUTION.csv\`)_` : ''}

## Skipped (already verified) (${skipped.length})
${skipped.slice(0, 20).map(s => `- \`${s}\``).join('\n')}${skipped.length > 20 ? `\n_…and ${skipped.length - 20} more_` : ''}

## Failed: no Wikipedia article (${failedNoArticle.length})
${failedNoArticle.map(s => `- \`${s}\``).join('\n') || '(none)'}

## Failed: no acceptable license (${failedNoLicense.length})
${failedNoLicense.map(s => `- \`${s}\``).join('\n') || '(none)'}

## Failed: no usable image format (${failedNoFormat.length})
${failedNoFormat.map(s => `- \`${s}\``).join('\n') || '(none)'}

## Failed: other (${failedOther.length})
${failedOther.map(({ slug, reason }) => `- \`${slug}\`: ${reason}`).join('\n') || '(none)'}

## License acceptance policy

Accepted only:
- CC BY 2.0 / 3.0 / 4.0
- CC BY-SA 2.0 / 2.5 / 3.0 / 4.0
- CC0
- Public domain (PD, PD-self, PD-USGov, PD-US)

Rejected: any "fair use", "non-commercial", "non-free", or unrecognized license.
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
  const verbose = args.includes('--verbose');

  const today = new Date().toISOString().slice(0, 10);

  const courses = parseCourses(COURSES_FILE);
  console.log(`Parsed ${courses.length} courses from bingo-courses.js`);

  if (!fs.existsSync(LOGOS_DIR)) {
    fs.mkdirSync(LOGOS_DIR, { recursive: true });
  }
  ensureAttributionHeader();
  const attrMap = loadAttribution();

  const skipped = [];
  const todo = [];
  for (const c of courses) {
    if (only && !only.has(c.id)) continue;
    const dest = path.join(LOGOS_DIR, `${c.id}.png`);
    if (fs.existsSync(dest)) {
      skipped.push(c.id);
    } else {
      todo.push(c);
    }
  }

  console.log(`Skipping ${skipped.length} courses with existing PNGs`);
  console.log(`Sourcing for ${todo.length} courses${limit < Infinity ? ` (limited to ${limit})` : ''}`);
  console.log('---');

  const sourcedSlugs = [];
  const failedNoArticle = [];
  const failedNoLicense = [];
  const failedNoFormat = [];
  const failedOther = [];
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
        slug: course.id,
        course_name: course.name,
        wikipedia_url: '',
        image_url: '',
        author: '',
        license: '',
        date_sourced: today,
        status: 'exception',
        failureReason: e.message,
      };
    }
    processedCount++;

    // Upsert the attribution row by slug (overwrites prior failure rows when retrying).
    attrMap.set(result.slug, {
      slug: result.slug,
      course_name: result.course_name,
      wikipedia_url: result.wikipedia_url,
      image_url: result.image_url,
      author: result.author,
      license: result.license,
      date_sourced: result.date_sourced,
      status: result.status,
    });
    rewriteAttribution(attrMap);

    switch (result.status) {
      case 'sourced':
        sourcedSlugs.push(result.slug);
        console.log(`${tag} ✓ sourced: ${course.id} — ${result.license}`);
        break;
      case 'no_wikipedia_article':
        failedNoArticle.push(course.id);
        console.log(`${tag} ✗ no article: ${course.id}`);
        break;
      case 'no_acceptable_license':
        failedNoLicense.push(course.id);
        console.log(`${tag} ✗ no license: ${course.id}`);
        break;
      case 'no_usable_format':
        failedNoFormat.push(course.id);
        console.log(`${tag} ✗ no usable format: ${course.id}`);
        break;
      default:
        failedOther.push({ slug: course.id, reason: result.failureReason || result.status });
        console.log(`${tag} ✗ ${result.status}: ${course.id} — ${result.failureReason || ''}`);
        break;
    }

    // be polite
    await sleep(500);
  }

  const stats = { total: courses.length, processed: processedCount };
  writeReport(stats, sourcedSlugs, failedNoArticle, failedNoLicense, failedNoFormat, failedOther, skipped);

  console.log('\n=========== SUMMARY ===========');
  console.log(`Total courses:        ${courses.length}`);
  console.log(`Already had logo:     ${skipped.length}`);
  console.log(`Processed:            ${processedCount}`);
  console.log(`✓ Sourced:            ${sourcedSlugs.length}`);
  console.log(`✗ No article:         ${failedNoArticle.length}`);
  console.log(`✗ No license:         ${failedNoLicense.length}`);
  console.log(`✗ No format:          ${failedNoFormat.length}`);
  console.log(`✗ Other failure:      ${failedOther.length}`);
  console.log('Report written to:   ', REPORT_MD);
  console.log('Attribution CSV at:  ', ATTR_CSV);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
