// Every Sunday Nine category label fits its tile without splitting a word.
// usage: node perf/.s9-labels.mjs BASE DATE OUT.png [width]
import {webkit} from 'playwright';
const [BASE, DATE, OUT, W = '375'] = process.argv.slice(2);
const b = await webkit.launch();
const ctx = await b.newContext({viewport: {width: +W, height: 800}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
await ctx.route(/capiRelay|facebook\.(net|com)/i, (r) => r.abort());
await ctx.addInitScript(() => { try { localStorage.setItem('tb_install_dismissed', '1'); } catch (_) {} });
const p = await ctx.newPage();
await p.clock.install({time: new Date(DATE + 'T10:00:00-06:00')});
await p.goto(BASE + '/', {waitUntil: 'domcontentloaded'}); await p.waitForTimeout(2500);
const sk = p.locator('[data-action="welcome-skip"]:visible').first(); if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
await p.evaluate(() => { window.GUEST_MODE = true; window.openSundayNine(); }); await p.waitForTimeout(3500);
const r = await p.evaluate(() => [...document.querySelectorAll('#s9Grid .s9-cat-t')].map((e) => ({t: e.textContent, fs: getComputedStyle(e).fontSize, over: e.scrollWidth > e.clientWidth + 0.5})));
await p.screenshot({path: OUT, clip: {x: 0, y: 0, width: +W, height: 520}});
console.log(W + 'px', DATE, 'labels:', r.length, '| overflowing:', JSON.stringify(r.filter((x) => x.over)), '| shrunk:', JSON.stringify(r.filter((x) => x.fs !== '11px' && x.fs !== '12px').map((x) => x.t + '@' + x.fs)));
await b.close();
