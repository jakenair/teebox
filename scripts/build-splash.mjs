#!/usr/bin/env node
// Generate clean splash PNGs for the Capacitor SplashScreen plugin.
// Pure brand-green canvas with a centered "TeeBox" gold-italic wordmark
// + small tagline. Renders SVG → PNG via sharp, then writes every
// variant Capacitor expects under Assets.xcassets/Splash.imageset/.
//
// We replace, not append — the previous PNGs were the rounded app icon
// on a slightly-different green which produced a visible bezel on launch.
//
// Usage: node scripts/build-splash.mjs

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SPLASH_DIR = '/Users/jakenair/Desktop/teebox/ios/App/App/Assets.xcassets/Splash.imageset';
const SIZE = 2732; // square canvas; image is centered & cropped on device
const BG = '#0b1a0e';
const GOLD = '#e7d28a';
const WORDMARK = 'TeeBox';
const TAGLINE = 'The Premier Golf Marketplace';

function svg() {
  // 56pt @1x → ~448px on a 2732 canvas (proportionally). Goes serif for
  // brand parity with the in-app hero. White-60% tagline beneath.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="100%" height="100%" fill="${BG}"/>
  <text x="50%" y="49%" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-style="italic"
        font-weight="700" font-size="320" fill="${GOLD}">${WORDMARK}</text>
  <text x="50%" y="55%" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif"
        font-weight="500" font-size="84" fill="rgba(255,255,255,0.6)"
        letter-spacing="2">${TAGLINE}</text>
</svg>`;
}

const FILES = [
  'splash-2732x2732.png',
  'splash-2732x2732-1.png',
  'splash-2732x2732-2.png',
  'Default@1x~universal~anyany.png',
  'Default@2x~universal~anyany.png',
  'Default@3x~universal~anyany.png',
  'Default@1x~universal~anyany-dark.png',
  'Default@2x~universal~anyany-dark.png',
  'Default@3x~universal~anyany-dark.png',
];

const buffer = await sharp(Buffer.from(svg()))
  .png({ quality: 95, compressionLevel: 9 })
  .toBuffer();

let count = 0;
for (const f of FILES) {
  fs.writeFileSync(path.join(SPLASH_DIR, f), buffer);
  count++;
}
console.log(`Wrote ${count} splash variants (${SIZE}×${SIZE}, brand-green + gold wordmark).`);
