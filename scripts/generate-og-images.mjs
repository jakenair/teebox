#!/usr/bin/env node
/**
 * Generate Open Graph / link-preview images for TeeBox.
 *
 * Outputs:
 *   assets/og/og-default.png   1200x630   marketplace card
 *   assets/og/og-bingo.png     1200x630   logo bingo card
 *
 * Approach:
 *   - Build the artwork as raw SVG strings (brand fonts, colors, layout).
 *   - Render to PNG via sharp (already vendored in functions/node_modules).
 *
 * Run:
 *   node scripts/generate-og-images.mjs
 *
 * No new dependencies are added — sharp is loaded from the functions/ folder.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Sharp is vendored under functions/node_modules so we don't add a top-level dep.
const require = createRequire(import.meta.url);
const sharp = require(join(repoRoot, 'functions', 'node_modules', 'sharp'));

const OUT_DIR = join(repoRoot, 'assets', 'og');
mkdirSync(OUT_DIR, { recursive: true });

const W = 1200;
const H = 630;

// Brand tokens — kept in sync with index.html :root.
const GREEN_900 = '#0b1a0e';
const GREEN_800 = '#13261a';
const GOLD_500 = '#d6a900';
const GOLD_300 = '#e9c64a';
const CREAM = '#f6efe1';
const WHITE = '#ffffff';

// Serif display stack — Playfair / system serif fallback. Sharp uses librsvg
// which only resolves system-installed fonts, so we use a generic serif stack
// that renders well on macOS (Iowan Old Style / Times New Roman) and Linux.
const SERIF = "'Iowan Old Style','Apple Garamond','Baskerville','Times New Roman',Times,serif";
const SANS = "'SF Pro Display','Helvetica Neue',Arial,sans-serif";

/**
 * Subtle radial-glow background plate. Matches the dark-forest brand mood.
 */
function bgPlate() {
  return `
    <defs>
      <radialGradient id="plate" cx="22%" cy="35%" r="85%">
        <stop offset="0%" stop-color="#16301d" />
        <stop offset="55%" stop-color="${GREEN_900}" />
        <stop offset="100%" stop-color="#070f09" />
      </radialGradient>
      <linearGradient id="goldRule" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${GOLD_500}" stop-opacity="0" />
        <stop offset="20%" stop-color="${GOLD_500}" stop-opacity="1" />
        <stop offset="80%" stop-color="${GOLD_500}" stop-opacity="1" />
        <stop offset="100%" stop-color="${GOLD_500}" stop-opacity="0" />
      </linearGradient>
      <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1" fill="${GOLD_500}" fill-opacity="0.06" />
      </pattern>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#plate)" />
    <rect width="${W}" height="${H}" fill="url(#dots)" />
    <!-- gold inner border -->
    <rect x="24" y="24" width="${W - 48}" height="${H - 48}"
          fill="none" stroke="${GOLD_500}" stroke-opacity="0.35" stroke-width="2" rx="14" />
  `;
}

/**
 * App Store badge (vector replica). Filled rounded rect with Apple mark + text.
 * Apple's marketing guidelines are flexible for placeholder use; the user can
 * swap in the official SVG later.
 */
function appStoreBadge(x, y) {
  const w = 240;
  const h = 64;
  return `
    <g transform="translate(${x}, ${y})">
      <rect width="${w}" height="${h}" rx="12" fill="#000" stroke="${WHITE}" stroke-opacity="0.4" stroke-width="1" />
      <!-- Apple logo glyph (simplified) -->
      <g transform="translate(20, 14) scale(0.9)" fill="${WHITE}">
        <path d="M22.5 19.7c0-3.3 2.7-4.9 2.8-5-1.5-2.2-3.9-2.5-4.7-2.5-2-.2-3.9 1.2-4.9 1.2-1 0-2.6-1.2-4.3-1.1-2.2 0-4.2 1.3-5.4 3.3-2.3 4-.6 9.9 1.7 13.1 1.1 1.6 2.4 3.4 4.1 3.3 1.6-.1 2.3-1.1 4.3-1.1 2 0 2.5 1.1 4.3 1 1.8 0 2.9-1.6 4-3.2 1.3-1.8 1.8-3.6 1.8-3.7-.1 0-3.4-1.3-3.7-5.3zM19.6 9.7c.9-1.1 1.5-2.6 1.3-4.1-1.3.1-2.8.9-3.7 1.9-.8.9-1.6 2.4-1.4 3.9 1.4.1 2.9-.7 3.8-1.7z"/>
      </g>
      <text x="74" y="26" font-family="${SANS}" font-size="11" fill="${WHITE}" fill-opacity="0.85" letter-spacing="0.5">Download on the</text>
      <text x="74" y="48" font-family="${SANS}" font-size="22" font-weight="600" fill="${WHITE}">App Store</text>
    </g>
  `;
}

/**
 * The TeeBox wordmark — gold "Tee" + white "Box" — in serif display.
 */
function wordmark(x, y, fontSize) {
  return `
    <text x="${x}" y="${y}" font-family="${SERIF}" font-size="${fontSize}"
          font-weight="700" letter-spacing="-2">
      <tspan fill="${GOLD_500}">Tee</tspan><tspan fill="${WHITE}">Box</tspan>
    </text>
  `;
}

/**
 * Default marketplace OG card.
 */
function buildDefaultSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${bgPlate()}

  <!-- Eyebrow -->
  <text x="80" y="160" font-family="${SANS}" font-size="20" font-weight="600"
        fill="${GOLD_300}" letter-spacing="6">PEER-TO-PEER GOLF MARKETPLACE</text>

  <!-- Wordmark -->
  ${wordmark(76, 310, 196)}

  <!-- Gold rule -->
  <rect x="80" y="345" width="320" height="3" fill="url(#goldRule)" />

  <!-- Tagline -->
  <text x="80" y="420" font-family="${SERIF}" font-size="46" font-weight="500"
        fill="${CREAM}">The Premier Golf Marketplace</text>

  <!-- Sub-tagline -->
  <text x="80" y="470" font-family="${SANS}" font-size="22" fill="${CREAM}" fill-opacity="0.78">
    Buy and sell clubs, apparel, and accessories — secured by Stripe.
  </text>

  <!-- App Store badge bottom-left -->
  ${appStoreBadge(80, 522)}

  <!-- Right-side accent: stylized golf-ball circle on tee -->
  <g transform="translate(880, 180)" opacity="0.95">
    <!-- aura -->
    <circle cx="120" cy="140" r="190" fill="${GOLD_500}" fill-opacity="0.07" />
    <circle cx="120" cy="140" r="140" fill="${GOLD_500}" fill-opacity="0.10" />
    <!-- ball -->
    <circle cx="120" cy="140" r="92" fill="${WHITE}" />
    <circle cx="120" cy="140" r="92" fill="none" stroke="${GREEN_900}" stroke-opacity="0.15" stroke-width="2" />
    <!-- dimples (sparse pattern) -->
    <g fill="${GREEN_900}" fill-opacity="0.10">
      <circle cx="92" cy="112" r="4"/>
      <circle cx="120" cy="98" r="4"/>
      <circle cx="148" cy="112" r="4"/>
      <circle cx="78" cy="140" r="4"/>
      <circle cx="106" cy="130" r="4"/>
      <circle cx="134" cy="130" r="4"/>
      <circle cx="162" cy="140" r="4"/>
      <circle cx="92" cy="168" r="4"/>
      <circle cx="120" cy="156" r="4"/>
      <circle cx="148" cy="168" r="4"/>
      <circle cx="106" cy="184" r="4"/>
      <circle cx="134" cy="184" r="4"/>
    </g>
    <!-- tee -->
    <path d="M 100 244 L 140 244 L 132 286 L 120 304 L 108 286 Z"
          fill="${GOLD_500}" />
    <rect x="86" y="240" width="68" height="8" rx="4" fill="${GOLD_500}" />
  </g>

  <!-- Domain footer -->
  <text x="${W - 80}" y="588" text-anchor="end" font-family="${SANS}" font-size="18"
        fill="${CREAM}" fill-opacity="0.55" letter-spacing="2">teeboxmarket.com</text>
</svg>`;
}

/**
 * Bingo OG card — 3x3 logo grid accent in the right column.
 */
function buildBingoSvg() {
  // 3x3 grid of placeholder logo tiles (we draw simple monogram circles since
  // we can't reliably embed PNGs inside SVG via sharp without base64 — and
  // keeping it vector keeps the file portable). Each tile gets a different
  // serif initial to evoke a bingo-style card of course logos.
  const initials = ['A', 'C', 'P', 'B', 'M', 'R', 'S', 'O', 'W'];
  const gridX = 720;
  const gridY = 130;
  const tile = 110;
  const gap = 16;
  let tiles = '';
  for (let i = 0; i < 9; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const tx = gridX + col * (tile + gap);
    const ty = gridY + row * (tile + gap);
    // middle tile (i === 4) is highlighted gold to signal "free space"
    const isFree = i === 4;
    const fill = isFree ? GOLD_500 : GREEN_800;
    const stroke = isFree ? GOLD_300 : GOLD_500;
    const strokeOp = isFree ? '0.9' : '0.45';
    const textFill = isFree ? GREEN_900 : CREAM;
    tiles += `
      <g transform="translate(${tx}, ${ty})">
        <rect width="${tile}" height="${tile}" rx="14"
              fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOp}" stroke-width="2" />
        <text x="${tile / 2}" y="${tile / 2 + 22}" text-anchor="middle"
              font-family="${SERIF}" font-size="58" font-weight="700"
              fill="${textFill}">${initials[i]}</text>
      </g>
    `;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${bgPlate()}

  <!-- Eyebrow -->
  <text x="80" y="160" font-family="${SANS}" font-size="20" font-weight="600"
        fill="${GOLD_300}" letter-spacing="6">DAILY GOLF GAME</text>

  <!-- Wordmark -->
  ${wordmark(76, 290, 156)}

  <!-- Gold rule -->
  <rect x="80" y="320" width="280" height="3" fill="url(#goldRule)" />

  <!-- Tagline -->
  <text x="80" y="395" font-family="${SERIF}" font-size="56" font-weight="500"
        fill="${CREAM}">Logo Bingo</text>
  <text x="80" y="445" font-family="${SERIF}" font-size="32" font-style="italic"
        fill="${CREAM}" fill-opacity="0.85">Name the course from the logo.</text>

  <!-- Sub-tagline -->
  <text x="80" y="490" font-family="${SANS}" font-size="20" fill="${CREAM}" fill-opacity="0.72">
    A new round daily. Share your score, challenge a friend.
  </text>

  <!-- App Store badge bottom-left -->
  ${appStoreBadge(80, 528)}

  <!-- 3x3 grid accent -->
  ${tiles}

  <!-- Domain footer -->
  <text x="${W - 80}" y="588" text-anchor="end" font-family="${SANS}" font-size="18"
        fill="${CREAM}" fill-opacity="0.55" letter-spacing="2">teeboxmarket.com/?play=bingo</text>
</svg>`;
}

async function renderToPng(svgString, outPath) {
  const buf = Buffer.from(svgString, 'utf8');
  await sharp(buf, { density: 144 })
    .resize(W, H, { fit: 'cover' })
    .png({ compressionLevel: 9, quality: 92 })
    .toFile(outPath);
  const sizeKb = Math.round((require('node:fs').statSync(outPath).size) / 1024);
  console.log(`  wrote ${outPath} (${sizeKb} KB)`);
}

async function main() {
  console.log('Generating Open Graph images...');

  const defaultSvg = buildDefaultSvg();
  const bingoSvg = buildBingoSvg();

  // Also write the SVGs alongside the PNGs in case the user wants to tweak.
  writeFileSync(join(OUT_DIR, 'og-default.svg'), defaultSvg);
  writeFileSync(join(OUT_DIR, 'og-bingo.svg'), bingoSvg);

  await renderToPng(defaultSvg, join(OUT_DIR, 'og-default.png'));
  await renderToPng(bingoSvg, join(OUT_DIR, 'og-bingo.png'));

  console.log('Done. Re-run after edits with: node scripts/generate-og-images.mjs');
}

main().catch((err) => {
  console.error('OG generation failed:', err);
  process.exit(1);
});
