// Guest taps Sell → the cartoon welcome wall (not the small sheet). Back closes it,
// "Not now" closes it and drops the intent, and signing in from it lands in the sell form.
// usage: node perf/.sell-welcome.mjs BASE EMAIL PASSWORD OUTDIR
import {webkit, devices} from 'playwright';
const [BASE, EMAIL, PASSWORD, OUT] = process.argv.slice(2);
const b = await webkit.launch();
const ctx = await b.newContext({...devices['iPhone 14'], serviceWorkers: 'block'});
await ctx.route(/createPaymentIntent|capiRelay|facebook\.(net|com)/i, (r) => r.abort());
await ctx.addInitScript(() => { try { localStorage.setItem('tb_install_dismissed', '1'); localStorage.setItem('tb_push_prompt_seen', '1'); } catch (_) {} });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const R = {};
const st = () => p.evaluate(() => ({welcome: document.getElementById('welcomeScreen').classList.contains('open'), sheet: document.getElementById('authSheetBackdrop').classList.contains('open'), sell: document.getElementById('sellModalBackdrop').classList.contains('open'), skip: document.querySelector('#welcomeScreen .welcome-skip').textContent.trim(), intent: typeof window.__pendingAuthIntent === 'function', url: location.pathname + location.search}));
await p.goto(BASE + '/', {waitUntil: 'domcontentloaded'}); await p.waitForTimeout(3000);
const sk = p.locator('[data-action="welcome-skip"]:visible').first(); if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
const sellTab = p.locator('.bottom-nav-item:has-text("Sell"):visible, [data-action="handle-sell"]:visible').first();
R.sellButton = await sellTab.count();
await sellTab.click(); await p.waitForTimeout(1500);
R.afterSell = await st();
await p.screenshot({path: OUT + '/sell-welcome.png'});
await p.goBack(); await p.waitForTimeout(1000);
R.afterBack = await st();
await sellTab.click(); await p.waitForTimeout(1200);
await p.locator('#welcomeScreen .welcome-skip').click(); await p.waitForTimeout(800);
R.afterNotNow = await st();
await sellTab.click(); await p.waitForTimeout(1200);
await p.locator('#welcomeScreen [data-action="welcome-login"]').click(); await p.waitForTimeout(1000);
R.sheetFromWelcome = await st();
await p.locator('text=Continue with email').first().click(); await p.waitForTimeout(600);
await p.fill('#emailInput', EMAIL); await p.fill('#passwordInput', PASSWORD);
await p.locator('#emailSubmitBtn').click();
await p.waitForFunction(() => !!window.CURRENT_USER, null, {timeout: 30000});
await p.waitForTimeout(5000);
R.afterSignIn = await st();
await p.screenshot({path: OUT + '/sell-after-signin.png'});
R.errs = errs.filter((e) => !/firestore|Load failed/.test(e)).slice(0, 3);
R.pass = R.afterSell.welcome && !R.afterSell.sheet && R.afterSell.skip === 'Not now' && R.afterSell.intent && !R.afterBack.welcome
  && !R.afterNotNow.welcome && !R.afterNotNow.intent && /Browse/.test(R.afterNotNow.skip) && R.sheetFromWelcome.sheet && R.afterSignIn.sell && !R.afterSignIn.welcome && !R.errs.length;
console.log(JSON.stringify(R, null, 1));
await b.close();
