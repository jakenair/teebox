import {webkit, devices} from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({...devices['iPhone 14'], serviceWorkers: 'block'});
await ctx.route(/createPaymentIntent|capiRelay|facebook\.(net|com)/i, (r) => r.abort());
await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
const p = await ctx.newPage();
await p.goto(process.argv[2] + '/', {waitUntil: 'domcontentloaded'}); await p.waitForTimeout(3500);
const sk = p.locator('[data-action="welcome-skip"]:visible').first(); if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
await p.waitForFunction(() => document.querySelectorAll('[data-action="open-detail"]').length > 0);
await p.evaluate((i) => window.openDetailModal(i), await p.locator('[data-action="open-detail"]').first().getAttribute('data-product-id')); await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(() => {
  const fav = document.querySelector('#detailBackdrop .detail-fav'); fav.style.visibility = 'hidden';
  const bar = document.elementFromPoint(200, 30); fav.style.visibility = '';
  const chain = (el) => { const o = []; for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); o.push((e.id ? '#' + e.id : '.' + String(e.className).split(' ')[0]) + ' pos=' + cs.position + ' z=' + cs.zIndex + (cs.isolation !== 'auto' ? ' iso' : '') + (cs.transform !== 'none' ? ' tf' : '')); } return o; };
  return {bar: chain(bar), fav: chain(fav)};
}), null, 1));
await b.close();
