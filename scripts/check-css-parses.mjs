#!/usr/bin/env node
/**
 * scripts/check-css-parses.mjs
 *
 * Fails the build if any <style> block in an HTML file contains an
 * unterminated /* comment, or if a rule we expect to exist was swallowed by
 * one.
 *
 * WHY THIS EXISTS
 * r321 left a comment open:
 *
 *     /* r321: height MEASURED from the real rendered rows at 390px ...
 *     .trending-table thead tr { background: var(--gray-100); }
 *
 * The CSS parser scans to the next closing marker, which was nineteen lines
 * later inside an unrelated section header. Thirteen rules died silently —
 * .trend-item, .trend-thumb, .trend-rank, every .trending-table cell style.
 * Nothing errored. The page still rendered, just wrongly: Trending Now became
 * a stack of full-bleed photos 9,185px tall on mobile, and it shipped like
 * that from r321 until r328.
 *
 * A comment-aware scan is the only thing that catches this — counting '/*'
 * against '*' + '/' does not, because both appear inside strings and regexes
 * elsewhere in the file. See the css-change-verification-rule.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['index.html', 'bingo.html', 'round.html'].filter((f) => fs.existsSync(path.join(ROOT, f)));

// Rules whose disappearance would be invisible in CI but obvious to a user.
const MUST_SURVIVE = {
  'index.html': [
    '.trend-thumb', '.trend-item', '.trend-rank', '.trend-info-name',
    '.trending-table td', '.product-img-wrap', '.home-split', '.sk-card',
  ],
};

let failed = 0;

/** Walk a stylesheet exactly as a parser does: strings first, then comments. */
function scanStyle(css, startLine, where) {
  let i = 0, instr = null;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (instr) {
      if (c === '\\') { i += 2; continue; }
      if (c === instr) instr = null;
      i++; continue;
    }
    if (c === '"' || c === "'") { instr = c; i++; continue; }
    if (c === '/' && css[i + 1] === '*') {
      const line = startLine + css.slice(0, i).split('\n').length - 1;
      const close = css.indexOf('*/', i + 2);
      if (close === -1) {
        console.error(`\n  ✗ ${where}:${line} — UNTERMINATED CSS COMMENT`);
        console.error(`    ${css.slice(i, i + 110).split('\n')[0]}…`);
        console.error(`    Everything after this line is swallowed until the next close marker.`);
        failed++;
        return;
      }
      i = close + 2; continue;
    }
    i++;
  }
}

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  const src = fs.readFileSync(file, 'utf8');
  let found = 0;
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    found++;
    scanStyle(m[1], src.slice(0, m.index).split('\n').length, rel);
  }
  // Comment-stripped view: what the browser will actually see.
  const seen = src.replace(/<style[^>]*>([\s\S]*?)<\/style>/g,
      (_, css) => css.replace(/\/\*[\s\S]*?\*\//g, ''));
  for (const sel of (MUST_SURVIVE[rel] || [])) {
    if (!new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,{]').test(seen)) {
      console.error(`  ✗ ${rel} — rule "${sel}" is not present after comment stripping`);
      failed++;
    }
  }
  if (!failed) console.log(`  ✓ ${rel}: ${found} <style> block(s), comments balanced, key rules intact`);
}

if (failed) {
  console.error(`\n  ${failed} CSS problem(s). Refusing to build.\n`);
  process.exit(1);
}
