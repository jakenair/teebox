#!/usr/bin/env node
// One-shot: reprocess myopia-hunt + sage-valley with stricter trim + extra
// padding so neither cell crops the logo. The earlier standardize pass left
// these two with asymmetric content. Drops them at 180x180 inside a 256x256
// canvas (vs. the default 200x200) — slightly smaller visible logo, but
// guaranteed to never touch the cell border.

import fs from 'node:fs';
import sharp from 'sharp';

const SOURCE_DIR = '/Users/jakenair/Desktop/Course Logos';
const TARGET_DIR = '/Users/jakenair/Desktop/teebox/assets/logos';

const JOBS = [
  { src: 'Myopia Hunt Club .jpg',     slug: 'myopia-hunt' },
  { src: 'Sage Valley Golf Club .jpg', slug: 'sage-valley' },
];

const INNER = 180;
const CANVAS = 256;
const PAD = Math.round((CANVAS - INNER) / 2);

for (const j of JOBS) {
  const src = `${SOURCE_DIR}/${j.src}`;
  const dst = `${TARGET_DIR}/${j.slug}.png`;
  if (!fs.existsSync(src)) {
    console.log(`✗ source missing: ${src}`);
    continue;
  }
  try {
    const out = await sharp(src)
      // Tighter trim — match background within ±25 of pure white so any
      // off-white border or scanner haze still gets cropped.
      .trim({
        background: { r: 255, g: 255, b: 255 },
        threshold: 25,
      })
      // Resize to the smaller 180x180 inner area for guaranteed margin.
      .resize(INNER, INNER, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      // Center on transparent 256x256 canvas.
      .extend({
        top: PAD, bottom: PAD, left: PAD, right: PAD,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      .png({ quality: 95, compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(dst, out);
    console.log(`✓ ${j.slug}.png — re-fitted with ${INNER}x${INNER} inner`);
  } catch (e) {
    console.log(`✗ ${j.slug} — ${e.message}`);
  }
}
