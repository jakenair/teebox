#!/usr/bin/env node
// Strip the Meta Pixel snippet from every HTML file in dist/ before it is
// rsynced into the iOS bundle (build:web wires this in between the dist
// copy and the rsync). dist/ exists ONLY as the iOS payload — GitHub Pages
// serves the repo root — so the web keeps the pixel while the native app
// ships with ZERO facebook references: no loader tag, no noscript beacon,
// and /fb-pixel.js itself is never in the copy list. Native tracking (ATT
// prompt + Meta SDK) is a separate, undecided project.
//
// The snippet is always the exact 3-line block inserted at </head>:
//   <!-- Meta Pixel ... -->
//   <script defer src="/fb-pixel.js"></script>
//   <noscript>...facebook.com/tr...</noscript>
import fs from 'node:fs';
import path from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;
const BLOCK = /<!-- Meta Pixel[^>]*-->\s*<script defer src="\/fb-pixel\.js"><\/script>\s*<noscript>.*?<\/noscript>\s*/gs;

let stripped = 0;
let leftovers = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.html')) continue;
    let s = fs.readFileSync(p, 'utf8');
    const before = s;
    s = s.replace(BLOCK, '');
    // index.html's CSP allowlists the pixel hosts for the web — drop them
    // from the iOS copy so nothing in the native shell could phone home
    // even if pixel code were somehow injected.
    s = s.replace(/ ?https:\/\/connect\.facebook\.net/g, '')
         .replace(/ ?https:\/\/www\.facebook\.com(?=[ ;'"])/g, '');
    if (s !== before) { fs.writeFileSync(p, s); stripped++; }
    // "Pixel-free" = zero LOADING VECTORS. Plain-string mentions of
    // facebook (bot-detection regexes, the moderation wordlist, policy
    // links to Meta's own privacy pages, code comments) are content, not
    // trackers, and stay.
    if (/fb-pixel\.js|fbevents\.js|facebook\.com\/tr\b|connect\.facebook\.net/i.test(s)) {
      leftovers.push(p.replace(DIST + '/', ''));
    }
  }
}
if (!fs.existsSync(DIST)) {
  console.error('[strip-pixel-for-ios] dist/ missing — run inside build:web');
  process.exit(1);
}
// Belt-and-braces: the loader must never ride along even if a future copy
// step sweeps it in.
try { fs.unlinkSync(path.join(DIST, 'fb-pixel.js')); } catch (_e) {}
walk(DIST);
if (leftovers.length) {
  console.error('[strip-pixel-for-ios] FACEBOOK REFERENCES REMAIN:', leftovers.join(', '));
  process.exit(1);
}
console.log(`[strip-pixel-for-ios] stripped pixel from ${stripped} HTML files; dist/ has zero facebook references`);
