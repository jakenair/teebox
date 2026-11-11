// App (native) listing page: scroll down; the photo's heart must go under the
// top bar, not sit on it. usage: node perf/.detail-heart.mjs BASE OUTDIR
import {webkit, devices} from 'playwright';
const [BASE, OUT] = process.argv.slice(2);
const b = await webkit.launch();
const ctx = await b.newContext({...devices['iPhone 14'], serviceWorkers: 'block'});
await ctx.route(/createPaymentIntent|capiRelay|facebook\.(net|com)/i, (r) => r.abort());
await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; try { localStorage.setItem('tb_install_dismissed', '1'); } catch (_) {} });
const p = await ctx.newPage();
await p.goto(BASE + '/', {waitUntil: 'domcontentloaded'}); await p.waitForTimeout(3500);
const sk = p.locator('[data-action="welcome-skip"]:visible, .auth-guest-btn:visible').first(); if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
await p.waitForFunction(() => document.querySelectorAll('[data-action="open-detail"]').length > 0, null, {timeout: 20000});
const id = await p.locator('[data-action="open-detail"]').first().getAttribute('data-product-id');
await p.evaluate((i) => window.openDetailModal(i), id); await p.waitForTimeout(2500);
const info = await p.evaluate(() => {
  const fav = document.querySelector('#detailBackdrop .detail-fav');
  // scroll every scrollable ancestor of the gallery inside the detail sheet
  const sc = [...document.querySelectorAll('#detailBackdrop, #detailBackdrop *')].filter((e) => e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
  // Put the heart in the top-bar band: scroll until its top sits ~25px from the top.
  const r0 = fav.getBoundingClientRect();
  sc.forEach((e) => { e.scrollTop += r0.top - 25; });
  const r = fav && fav.getBoundingClientRect();
  const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {scrollers: sc.map((e) => e.id || e.className).slice(0, 4), favTop: r && Math.round(r.top), favOnTop: !!(hit && fav.contains(hit)), hitIs: hit && (hit.id || hit.className)};
});
await p.waitForTimeout(400);
await p.screenshot({path: OUT + '/detail-heart.png', clip: {x: 0, y: 0, width: 390, height: 260}});
console.log(JSON.stringify(info));
await b.close();
