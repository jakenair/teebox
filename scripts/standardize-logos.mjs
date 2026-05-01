#!/usr/bin/env node
// Standardize every logo so it renders at a uniform visible size inside
// the Bingo cells. Each PNG becomes a 256x256 canvas with the logo content
// fitted to ~200x200 in the center (transparent padding fills the rest).
//
// Why: with raw `fit: contain` resizing, square logos fill the cell and
// portrait/landscape logos appear smaller. By forcing every logo's content
// into a fixed inner box, all tiles render at the same visible scale.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const LOGOS_DIR = '/Users/jakenair/Desktop/teebox/assets/logos';
const TARGET_INNER = 200;   // max content size inside the canvas
const CANVAS = 256;          // total canvas size

const files = fs.readdirSync(LOGOS_DIR).filter(f => f.endsWith('.png'));
console.log(`Standardizing ${files.length} logos…`);

let ok = 0, err = 0;
for (const f of files) {
  const fp = path.join(LOGOS_DIR, f);
  try {
    // Read as buffer first so we can write back to the same path safely.
    const buf = fs.readFileSync(fp);
    const out = await sharp(buf)
      // Trim transparent / near-white edges from the source.
      .trim({ background: { r: 255, g: 255, b: 255, alpha: 0 }, threshold: 12 })
      // Fit the trimmed content to fit within TARGET_INNER without cropping.
      .resize(TARGET_INNER, TARGET_INNER, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      // Extend the canvas to CANVAS x CANVAS with transparent padding so
      // every logo ends up centered in a same-sized frame.
      .extend({
        top: Math.round((CANVAS - TARGET_INNER) / 2),
        bottom: Math.round((CANVAS - TARGET_INNER) / 2),
        left: Math.round((CANVAS - TARGET_INNER) / 2),
        right: Math.round((CANVAS - TARGET_INNER) / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ quality: 95, compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(fp, out);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${f} — ${e.message}`);
    err++;
  }
}
console.log(`Done. ${ok} standardized, ${err} errors.`);
