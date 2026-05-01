#!/usr/bin/env node
// Match user-renamed logos in /Users/jakenair/Desktop/Course Logos/ against
// the slug list in bingo-courses.js. Then process matched ones via sharp:
// trim transparent edges → resize to 256×256 → save to assets/logos/.
//
// Outputs a triage report:
//   ✓ matched   — filename slug exactly equals a course slug
//   ~ fuzzy     — filename slug close to a course slug (one needs human OK)
//   ?? unknown  — no match — likely a course not in bingo-courses.js
//
// Usage: node scripts/match-and-process-logos.mjs [--write]
// --write actually does the rename + sharp processing. Without it, dry-run.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const PROJECT = '/Users/jakenair/Desktop/teebox';
const SOURCE = '/Users/jakenair/Desktop/Course Logos';
const TARGET = path.join(PROJECT, 'assets/logos');
const COURSES_FILE = path.join(PROJECT, 'bingo-courses.js');

const WRITE = process.argv.includes('--write');

// --- Parse course slugs + names from bingo-courses.js ---
const txt = fs.readFileSync(COURSES_FILE, 'utf8');
const idMatches = [...txt.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
const nameMatches = [...txt.matchAll(/name:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
const courses = idMatches.map((id, i) => ({ id, name: nameMatches[i] || '' }));
console.log(`Loaded ${courses.length} courses from bingo-courses.js`);

// --- Slugify helpers ---
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/\.[a-z]+$/, '')                  // strip extension
    .replace(/^the[- ]/, '')                    // drop leading "the"
    .replace(/[' ]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function nameToSlug(s) {
  return slugify(
    s
      .replace(/\bgolf club\b/gi, '')
      .replace(/\bcountry club\b/gi, '')
      .replace(/\bgolf course\b/gi, '')
      .replace(/\bcc\b/gi, '')
      .replace(/\bgc\b/gi, '')
      .trim()
  );
}

// Build a slug → course map and a name-tokens index for fuzzy matching.
const slugMap = new Map(courses.map(c => [c.id, c]));

function tokenSet(s) {
  return new Set(slugify(s).split('-').filter(t => t.length > 1));
}
const courseTokens = courses.map(c => ({
  c,
  slugTokens: tokenSet(c.id),
  nameTokens: tokenSet(c.name),
}));

function fuzzyMatch(filename) {
  // Try exact slug first
  const fromName = slugify(filename);
  if (slugMap.has(fromName)) return { course: slugMap.get(fromName), score: 1 };

  // Try without "the-" prefix or "-club" suffix
  const candidates = [
    fromName,
    fromName.replace(/^the-/, ''),
    fromName.replace(/-club$/, ''),
    fromName.replace(/-golf$/, ''),
    fromName.replace(/-country$/, ''),
    nameToSlug(filename),
  ];
  for (const cand of candidates) {
    if (slugMap.has(cand)) return { course: slugMap.get(cand), score: 1 };
  }

  // Token overlap fuzzy match
  const filenameTokens = tokenSet(filename);
  if (filenameTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const { c, slugTokens, nameTokens } of courseTokens) {
    const allCourseTokens = new Set([...slugTokens, ...nameTokens]);
    const overlap = [...filenameTokens].filter(t => allCourseTokens.has(t)).length;
    const denom = Math.max(filenameTokens.size, slugTokens.size);
    const score = overlap / denom;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best && bestScore >= 0.5) return { course: best, score: bestScore };
  return null;
}

// --- Triage ---
const files = fs.readdirSync(SOURCE).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
const matched = [];   // exact or close fuzzy match
const unknown = [];   // no match at all

for (const file of files) {
  const m = fuzzyMatch(file);
  if (m && m.score === 1) {
    matched.push({ file, slug: m.course.id, name: m.course.name, score: m.score });
  } else if (m && m.score >= 0.5) {
    matched.push({ file, slug: m.course.id, name: m.course.name, score: m.score });
  } else {
    unknown.push({ file });
  }
}

// --- Report ---
console.log('\n=== MATCHED (' + matched.length + ') ===');
matched.sort((a, b) => b.score - a.score).forEach(m => {
  const tag = m.score === 1 ? '✓ exact' : `~ fuzzy (${(m.score * 100).toFixed(0)}%)`;
  console.log(`${tag.padEnd(16)} ${m.file.padEnd(45)} → ${m.slug.padEnd(35)} (${m.name})`);
});

console.log('\n=== UNKNOWN (' + unknown.length + ') ===');
unknown.forEach(u => console.log('  ' + u.file));

// --- Process matched files ---
if (!WRITE) {
  console.log('\n[dry run] re-run with --write to actually process files');
  process.exit(0);
}

console.log('\n=== PROCESSING ===');
let processed = 0;
let errors = 0;
for (const m of matched) {
  const src = path.join(SOURCE, m.file);
  const dst = path.join(TARGET, `${m.slug}.png`);
  try {
    await sharp(src)
      .trim({ background: { r: 255, g: 255, b: 255, alpha: 0 }, threshold: 10 })
      .resize(256, 256, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      .png({ quality: 95, compressionLevel: 9 })
      .toFile(dst);
    console.log(`✓ ${m.slug}.png  ←  ${m.file}`);
    processed++;
  } catch (e) {
    console.log(`✗ ${m.slug}.png  FAILED: ${e.message}`);
    errors++;
  }
}

console.log(`\nDone. Processed ${processed}, errors ${errors}.`);
