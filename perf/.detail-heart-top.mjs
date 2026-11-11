import {webkit, devices} from 'playwright';
const b = await webkit.launch();
for (const native of [true, false]) {
  const ctx = await b.newContext({...devices['iPhone 14'], serviceWorkers: 'block'});
  await ctx.route(/createPaymentIntent|capiRelay|facebook\.(net|com)/i, (r) => r.abort());
  if (native) await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
  const p = await ctx.newPage();
  await p.goto(process.argv[2] + '/', {waitUntil: 'domcontentloaded'}); await p.waitForTimeout(3500);
  const sk = p.locator('[data-action="welcome-skip"]:visible').first(); if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
  await p.waitForFunction(() => document.querySelectorAll('[data-action="open-detail"]').length > 0);
  await p.evaluate((i) => window.openDetailModal(i), await p.locator('[data-action="open-detail"]').first().getAttribute('data-product-id')); await p.waitForTimeout(2500);
  console.log(native ? 'app ' : 'web ', JSON.stringify(await p.evaluate(() => { const f = document.querySelector('#detailBackdrop .detail-fav'); const r = f.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return {visible: r.width > 0, onTop: !!(h && f.contains(h)), top: Math.round(r.top)}; })));
  await ctx.close();
}
await b.close();
