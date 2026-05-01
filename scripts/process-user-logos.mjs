#!/usr/bin/env node
// Process the user-renamed logos in /Users/jakenair/Desktop/Course Logos/
// using a hand-curated filename → slug mapping. Trims, resizes to 256x256,
// and saves to assets/logos/. Skips files marked as "skip" or "unmatched".
//
// Usage:
//   node scripts/process-user-logos.mjs            (dry run)
//   node scripts/process-user-logos.mjs --write    (actually process)

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const PROJECT = '/Users/jakenair/Desktop/teebox';
const SOURCE = '/Users/jakenair/Desktop/Course Logos';
const TARGET = path.join(PROJECT, 'assets/logos');
const WRITE = process.argv.includes('--write');

// Hand-curated mapping. Filename (in Course Logos/) → slug (in assets/logos/).
// Some slugs already exist in bingo-courses.js; the new ones get added by a
// separate patch to bingo-courses.js (see scripts/add-new-courses.mjs).
const MAPPING = {
  // ── Already in bingo-courses.js ──────────────────────────────────────
  'Aronimink.jpg': 'aronimink',
  'Augusta National Golf Club .jpg': 'augusta-national',
  'Baltusrol Golf Club .png': 'baltusrol-lower',
  'Bandon Dunes .png': 'bandon-dunes',
  'Cabot Citrust Farms .jpg': 'cabot-citrus-farms',
  'Cabot St Lucia .jpg': 'cabot-saint-lucia',
  'Castle Pines .png': 'castle-pines',
  'Cherry Hills .png': 'cherry-hills',
  'Cypress Point Golf Club .jpg': 'cypress-point',
  'Erin Hills .jpg': 'erin-hills',
  'Fishers Island Club .jpg': 'fishers-island',
  'Friars Head .jpg': 'friars-head',
  'Gozzer Ranch Golf Club .png': 'gozzer-ranch',
  'Liberty National .png': 'liberty-national',
  'Los Angeles Country Club .png': 'los-angeles-cc-north',
  'Maidstone Club .jpg': 'maidstone',
  'Mammoth Dunes .png': 'mammoth-dunes',
  'McArthur Golf Club .png': 'mcarthur',
  'Merion Golf Club .jpg': 'merion-east',
  'Monterey Peninsula .png': 'monterey-peninsula-shore',
  'National Golf Links of America .jpg': 'national-golf-links',
  'Oakland Hills Country Club .png': 'oakland-hills-south',
  'Oakmont Country Club .jpg': 'oakmont',
  'Ohoopee Match Club .png': 'ohoopee-match',
  'Old Barnwell .jpg': 'old-barnwell',
  'Old Sandwich Golf Club .jpg': 'old-sandwich',
  'Olympia Fields Country Club .jpg': 'olympia-fields-north',
  'Olympic Club .png': 'olympic-club-lake',
  'Pasatiempo .jpg': 'pasatiempo',
  'Philadelphia Cricket Club .png': 'philadelphia-cricket',
  'Pine Valley .jpg': 'pine-valley',
  'Pinehurst .jpg': 'pinehurst-no-2',
  'Plainfield Country Club .jpg': 'plainfield',
  'Quail Hollow .jpg': 'quail-hollow',
  'Sand Valley .png': 'sand-valley',
  'Sedge Valley .png': 'sedge-valley',
  'Seminole Golf Club .png': 'seminole',
  'Shinnecock Hills Golf Club .jpg': 'shinnecock-hills',
  'Sleepy Hallow Country Club .jpg': 'sleepy-hollow',
  'Streamsong .jpg': 'streamsong-blue',
  'The Lido .png': 'lido',
  'The Stanwich Club .jpg': 'stanwich',
  'Tobacco Road .png': 'tobacco-road',
  'Whistling Straits .jpg': 'whistling-straits',
  'Winged Foot .png': 'winged-foot-west',
  'Yale Golf Club .jpg': 'yale',
  // Cabot Highlands is the rebranded Castle Stuart — overwrite our castle-stuart.png
  'Cabot Highlands .png': 'castle-stuart',
  // Cabot Cape Breton is the umbrella resort — apply to cabot-links (the original course)
  'Cabot Cape Breton .png': 'cabot-links',

  // ── New courses, will be added to bingo-courses.js ───────────────────
  'Bellerive Country Club .png': 'bellerive',
  'Berkely Hall Golf Club .png': 'berkeley-hall',
  'Black Sheep .png': 'black-sheep',
  'Boston Golf Club .png': 'boston-golf-club',
  'Broomsedge Golf Club  .png': 'broomsedge',
  'Burning Tree .jpg': 'burning-tree',
  'Calusa Pines .png': 'calusa-pines',
  'Dooks Golf Club .jpg': 'dooks',
  'Essex County Country Club .jpg': 'essex-county',
  'Flossmoor Country Club .jpg': 'flossmoor',
  'Gamble Sands .jpg': 'gamble-sands',
  'Interlachen Golf Club .png': 'interlachen',
  'Kittansett Golf Club .jpg': 'kittansett',
  'Lost Dunes .png': 'lost-dunes',
  'Myopia Hunt Club .jpg': 'myopia-hunt',
  'Old Elm Club .jpg': 'old-elm',
  'Pacific Dunes .png': 'pacific-dunes',
  'Piping Rock Club .jpg': 'piping-rock',
  'Rich Harvest Farms .jpg': 'rich-harvest-farms',
  'Sage Valley Golf Club .jpg': 'sage-valley',
  'Scioto Country Club .jpg': 'scioto',
  'Secession .png': 'secession',
  'Shoreacres .jpg': 'shoreacres',
  'Skene Valley Country Club .jpg': 'skene-valley',
  'St Louis Country Club .png': 'st-louis-cc',
  'Stonewall Orchard Golf Course .png': 'stonewall-orchard',
  'The Alotian Club .jpg': 'alotian',
  'The Country Club at Brookline .jpg': 'the-country-club',
  'The Dunes Club .jpg': 'dunes-club',
  'The Hay .png': 'the-hay',
  'The Loxahatchee Club .jpg': 'loxahatchee',
  'The Tree Farm.png': 'tree-farm',
  'Vaquero Club .jpg': 'vaquero',
  'Naples National .jpg': 'naples-national',
};

// --- Scan the source folder and report ---
const files = fs.readdirSync(SOURCE).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
const mapped = [];
const unmapped = [];

for (const f of files) {
  if (MAPPING[f]) {
    mapped.push({ file: f, slug: MAPPING[f] });
  } else {
    unmapped.push(f);
  }
}

console.log(`Source folder: ${files.length} files`);
console.log(`Mapped: ${mapped.length}`);
console.log(`Unmapped: ${unmapped.length}`);

if (unmapped.length) {
  console.log('\n── UNMAPPED FILES ──');
  unmapped.forEach(f => console.log(`  ${f}`));
}

if (!WRITE) {
  console.log('\n[dry run] re-run with --write to actually process');
  process.exit(0);
}

// --- Process matched files ---
console.log('\n── PROCESSING ──');
let ok = 0;
let err = 0;
for (const m of mapped) {
  const src = path.join(SOURCE, m.file);
  const dst = path.join(TARGET, `${m.slug}.png`);
  try {
    await sharp(src)
      .trim({ background: { r: 255, g: 255, b: 255, alpha: 0 }, threshold: 12 })
      .resize(256, 256, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      .png({ quality: 95, compressionLevel: 9 })
      .toFile(dst);
    console.log(`✓ ${m.slug}.png`);
    ok++;
  } catch (e) {
    console.log(`✗ ${m.slug}.png — ${e.message}`);
    err++;
  }
}
console.log(`\nDone. Processed ${ok}, errors ${err}.`);
