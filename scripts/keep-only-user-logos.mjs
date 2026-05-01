#!/usr/bin/env node
// One-shot: delete every logo PNG that wasn't in the user's hand-curated
// Course Logos folder. forest-dunes is the only explicit exception (the user
// likes it). Run once after the user reports auto-scraped logos as wrong.
//
// Usage:
//   node scripts/keep-only-user-logos.mjs            (dry run)
//   node scripts/keep-only-user-logos.mjs --write    (actually delete)

import fs from 'node:fs';
import path from 'node:path';

const LOGOS_DIR = '/Users/jakenair/Desktop/teebox/assets/logos';
const WRITE = process.argv.includes('--write');

// Pulled from scripts/process-user-logos.mjs — every slug the user curated.
const KEEP = new Set([
  'aronimink', 'augusta-national', 'baltusrol-lower', 'bandon-dunes',
  'cabot-citrus-farms', 'cabot-saint-lucia', 'castle-pines', 'cherry-hills',
  'cypress-point', 'erin-hills', 'fishers-island', 'friars-head',
  'gozzer-ranch', 'liberty-national', 'los-angeles-cc-north', 'maidstone',
  'mammoth-dunes', 'mcarthur', 'merion-east', 'monterey-peninsula-shore',
  'national-golf-links', 'oakland-hills-south', 'oakmont', 'ohoopee-match',
  'old-barnwell', 'old-sandwich', 'olympia-fields-north', 'olympic-club-lake',
  'pasatiempo', 'philadelphia-cricket', 'pine-valley', 'pinehurst-no-2',
  'plainfield', 'quail-hollow', 'sand-valley', 'sedge-valley', 'seminole',
  'shinnecock-hills', 'sleepy-hollow', 'streamsong-blue', 'lido', 'stanwich',
  'tobacco-road', 'whistling-straits', 'winged-foot-west', 'yale',
  'castle-stuart', 'cabot-links',
  'bellerive', 'berkeley-hall', 'black-sheep', 'boston-golf-club',
  'broomsedge', 'burning-tree', 'calusa-pines', 'dooks', 'essex-county',
  'flossmoor', 'gamble-sands', 'interlachen', 'kittansett', 'lost-dunes',
  'myopia-hunt', 'old-elm', 'pacific-dunes', 'piping-rock', 'rich-harvest-farms',
  'sage-valley', 'scioto', 'secession', 'shoreacres', 'skene-valley',
  'st-louis-cc', 'stonewall-orchard', 'alotian', 'the-country-club',
  'dunes-club', 'the-hay', 'loxahatchee', 'tree-farm', 'vaquero',
  'naples-national',
  // Explicit user exception — auto-scraped but accurate.
  'forest-dunes',
]);

const files = fs.readdirSync(LOGOS_DIR).filter(f => f.endsWith('.png'));
const keep = [];
const drop = [];
for (const f of files) {
  const slug = f.replace(/\.png$/, '');
  if (KEEP.has(slug)) keep.push(f);
  else drop.push(f);
}

console.log(`Total PNGs: ${files.length}`);
console.log(`Keep (user-curated + forest-dunes): ${keep.length}`);
console.log(`Drop (auto-scraped): ${drop.length}`);
if (drop.length) {
  console.log('\n── DROP ──');
  drop.forEach(f => console.log(`  ${f}`));
}

const missingFromKeep = [...KEEP].filter(s => !keep.includes(s + '.png'));
if (missingFromKeep.length) {
  console.log('\n── KEEP-LIST SLUGS WITH NO PNG ──');
  missingFromKeep.forEach(s => console.log(`  ${s}`));
}

if (!WRITE) {
  console.log('\n[dry run] re-run with --write to actually delete');
  process.exit(0);
}

let ok = 0;
for (const f of drop) {
  fs.unlinkSync(path.join(LOGOS_DIR, f));
  ok++;
}
console.log(`\nDeleted ${ok} files.`);
