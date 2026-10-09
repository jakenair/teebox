#!/usr/bin/env node
/**
 * perf/overflow.mjs — "can the page pan sideways?" check in REAL WebKit.
 *
 *   node perf/overflow.mjs                       # web layout, iPhone 14 profile
 *   node perf/overflow.mjs --native              # app layout (stubs Capacitor so body.is-native applies)
 *   node perf/overflow.mjs http://localhost:8787/ --native
 *
 * Why it exists: r330-r332 made Trending 509px wide — but only under
 * body.is-native and only in WebKit. Chrome (and every Lighthouse run) said
 * the page was 390px. Jake found it on his phone a day after the App Store
 * release: the whole app slid sideways while scrolling (r343). Chrome cannot
 * stand in for the app's engine, and the web layout cannot stand in for the
 * native one. Run BOTH modes before any iOS build.
 *
 * Fails (exit 1) if any scroll container that is not an intentional horizontal
 * scroller (cat bars, chips, carousels) is wider than its box.
 */
import {webkit, devices} from 'playwright';
const INTENDED = /cat-side-list|app-home-chips|cat-bar|carousel|pp-detail-photos|more-like-this-row|bag-row|dash-tabs|ticker/;
const url = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'https://teeboxmarket.com/';
const native = process.argv.includes('--native');
const browser = await webkit.launch();
const ctx = await browser.newContext({...devices['iPhone 14'], locale: 'en-US'});
if (native) await ctx.addInitScript(() => { window.Capacitor = {isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {}, isPluginAvailable: () => false}; });
const page = await ctx.newPage();
await page.goto(url, {waitUntil: 'networkidle', timeout: 90000});
await page.waitForTimeout(5000);
const out = await page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  const res = {W, bodyClass: document.body.className, docScrollWidth: document.documentElement.scrollWidth, scrollers: [], wide: []};
  const cands = [document.scrollingElement, ...document.querySelectorAll('*')].filter(Boolean);
  for (const el of cands) {
    const cs = getComputedStyle(el);
    const scrollable = el === document.scrollingElement || /(auto|scroll)/.test(cs.overflowX + cs.overflowY + cs.overflow);
    if (!scrollable) continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const before = el.scrollLeft; el.scrollLeft = 60; const after = el.scrollLeft; el.scrollLeft = before;
      res.scrollers.push({el: (el.id ? '#' + el.id : el.tagName.toLowerCase()) + '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.'), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, overflowX: cs.overflowX, overflowY: cs.overflowY, pansTo: after, display: cs.display});
    }
  }
  const main = document.querySelector('#app-scroll') || document.body;
  for (const el of main.querySelectorAll('*')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect(); if (r.width === 0) continue;
    if (r.right > W + 1 && !el.closest('.ticker-wrap')) {
      const anc = []; let p = el; while (p && p !== document.body && anc.length < 5) { anc.push((p.id ? '#' + p.id : p.tagName.toLowerCase()) + (typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : '')); p = p.parentElement; }
      res.wide.push({path: anc.reverse().join(' > '), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), pos: cs.position, text: (el.textContent || '').trim().slice(0, 30)});
    }
  }
  return res;
});
console.log('W', out.W, 'body:', out.bodyClass.slice(0, 80), '| doc scrollWidth', out.docScrollWidth);
console.log('scroll containers wider than their box:'); for (const s of out.scrollers) console.log(' ', JSON.stringify(s));
console.log('elements past the right edge (non-ticker):', out.wide.length); for (const w of out.wide.slice(0, 25)) console.log(' ', w.pos.padEnd(8), String(w.left).padStart(5), String(w.right).padStart(5), String(w.w).padStart(5), w.path, '|', w.text);
await page.screenshot({path: '/private/tmp/claude-501/-Users-jakenair/f37056fa-6e25-4518-9ee3-7b3bc4983bac/scratchpad/rec/webkit-' + (native ? 'native' : 'web') + '.png'});
await browser.close();
const bad = out.scrollers.filter((s) => !INTENDED.test(s.el));
if (bad.length) { console.log('\n  ✗ sideways pan possible:', bad.map((b) => b.el).join(', ')); process.exit(1); }
console.log('\n  ✓ no sideways pan (' + (native ? 'native' : 'web') + ')');
