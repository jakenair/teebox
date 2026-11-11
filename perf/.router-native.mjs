// Native path check: with Capacitor reporting native, the r406 router must stay
// off and the r156 overlay stack must behave as before (push on open, Back closes).
import {webkit, devices} from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({...devices['iPhone 14'], serviceWorkers: 'block'});
await ctx.route(/createPaymentIntent|capiRelay|facebook\.(net|com)/i, (r) => r.abort());
await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; try { localStorage.setItem('tb_install_dismissed', '1'); } catch (_) {} });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.argv[2] + '/', {waitUntil: 'domcontentloaded'}); await p.waitForTimeout(3000);
const sk = p.locator('[data-action="welcome-skip"]:visible, .auth-guest-btn:visible').first(); if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
const out = {router: await p.evaluate(() => !!window.__tbRouter)};
const h0 = await p.evaluate(() => history.length);
await p.evaluate(() => window.__actions['open-bingo']()); await p.waitForTimeout(1200);
out.bingoOpen = await p.evaluate(() => document.getElementById('bingoScreen').classList.contains('open'));
out.pushed = (await p.evaluate(() => history.length)) - h0;
out.state = await p.evaluate(() => history.state);
await p.goBack(); await p.waitForTimeout(800);
out.backClosedBingo = await p.evaluate(() => !document.getElementById('bingoScreen').classList.contains('open'));
out.url = await p.evaluate(() => location.pathname + location.search);
out.errs = errs.filter((e) => !/firestore|Load failed/.test(e)).slice(0, 3);
out.pass = !out.router && out.bingoOpen && out.pushed === 1 && out.state && out.state.tb === 'bingo' && out.backClosedBingo && !out.errs.length;
console.log(JSON.stringify(out));
await b.close();
