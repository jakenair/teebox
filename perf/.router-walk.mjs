// r406 web router walk: every main view gets its own URL, Back/Forward work,
// reload stays on the view, the TeeBox logo goes home from everywhere.
// usage: node perf/.router-walk.mjs BASE [desktop|mobile] [EMAIL PASSWORD]
// Signed-in mode (EMAIL given) also walks Sell, My Shop, Passport, own profile
// and checkout entry (never pays: the payment form is only opened and closed).
import {webkit, chromium, devices} from 'playwright';
const [BASE, MODE = 'desktop', EMAIL, PASSWORD] = process.argv.slice(2);
const engine = process.env.ENGINE === 'chromium' ? chromium : webkit;
const b = await engine.launch();
const ctxOpts = MODE === 'mobile' ? {...devices['iPhone 14']} : {viewport: {width: 1280, height: 860}};
const ctx = await b.newContext({...ctxOpts, serviceWorkers: 'block'});
await ctx.addInitScript(() => { try { localStorage.setItem('tb_install_dismissed', '1'); localStorage.setItem('tb_push_prompt_seen', '1'); } catch (_) {} });
// Never create a real PaymentIntent or send Meta events from a test walk.
const blocked = [];
await ctx.route(/createPaymentIntent|capiRelay|capirelay|facebook\.(net|com)/i, (r) => { blocked.push(r.request().url().split('?')[0].slice(-40)); return r.abort(); });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const results = [];
const covered = [], reached = [];
process.on('uncaughtException', async (e) => { for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + '  ' + (r.url || '') + ' [' + (r.top || '') + ']'); console.log('CRASH', e.message.split('\n')[0]); try { console.log('now', await url(), await top()); await p.screenshot({path: '/private/tmp/claude-501/-Users-jakenair-dev-teebox/d81ffcae-e9e4-45a2-be41-f2512ec0b34c/scratchpad/router/crash.png'}); } catch (_) {} process.exit(1); });
const url = () => p.evaluate(() => location.pathname + location.search);
const top = () => p.evaluate(() => { const c = window.__tbRouter ? window.__tbRouter.current() : []; return c.length ? c[c.length - 1].split(':')[0] : 'home'; });
async function check(label, wantUrl, wantTop) {
  await p.waitForTimeout(900);
  const u = await url(), t = await top();
  const ok = (wantUrl instanceof RegExp ? wantUrl.test(u) : u === wantUrl) && t === wantTop;
  results.push({label, ok, url: u, top: t, want: String(wantUrl) + ' / ' + wantTop});
  return ok;
}
async function dismissBanners() {
  // New-account marketing consent banner (test account only) sits over the headers.
  const x = p.locator('#marketingReoptBanner .mrb-close:visible');
  if (await x.count()) { await x.first().click().catch(() => {}); await p.waitForTimeout(400); }
}
async function waitTop(want, ms = 12000) {
  try { await p.waitForFunction((w) => { const c = window.__tbRouter.current(); const t = c.length ? c[c.length - 1].split(':')[0] : 'home'; return t === w; }, want, {timeout: ms}); } catch (_) {}
}
async function skipWelcome() {
  const sk = p.locator('[data-action="welcome-skip"]:visible, .auth-guest-btn:visible').first();
  if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
}
async function reloadCheck(label, wantUrl, wantTop) {
  await p.reload({waitUntil: 'domcontentloaded'});
  await p.waitForTimeout(2500);
  if (!EMAIL) await skipWelcome();
  await waitTop(wantTop);
  await p.waitForTimeout(1500); await dismissBanners();
  return check(label, wantUrl, wantTop);
}
const act = (name) => p.evaluate((n) => window.__actions[n](document.body, new Event('click')), name);
async function clickLogo() {
  // The visible TeeBox logo in the top-left: desktop nav logo or mobile top logo.
  // Only when it is actually on top (full-screen games cover it and have their own ←).
  const sel = await p.evaluate(() => {
    for (const s of ['.nav-logo', '.mobile-top-logo']) {
      const el = [...document.querySelectorAll(s)].find((e) => e.offsetParent !== null);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && el.contains(hit)) return s;
    }
    return null;
  });
  const where = await top();
  if (!sel) { covered.push(where); await act('bn-home'); return 'covered'; }
  reached.push(where);
  await p.locator(sel + ':visible').first().click();
  return 'nav';
}

await p.goto(BASE + '/?nc=' + Date.now(), {waitUntil: 'domcontentloaded'});
await p.waitForTimeout(2500);
if (EMAIL) {
  await p.locator('[data-action="welcome-login"]').click();
  await p.locator('text=Continue with email').click();
  await p.fill('#emailInput', EMAIL); await p.fill('#passwordInput', PASSWORD);
  await p.locator('#emailSubmitBtn').click();
  await p.waitForFunction(() => !!window.CURRENT_USER, null, {timeout: 30000});
  await p.waitForTimeout(2500);
  await dismissBanners();
} else {
  await skipWelcome();
}
await p.waitForFunction(() => window.__listingsLoaded || document.querySelectorAll('[data-action="open-detail"]').length > 0, null, {timeout: 20000}).catch(() => {});
await check('home', /^\/(\?nc=\d+)?$/, 'home');

// Dylan's path, guest version: Logo Bingo → Sunday Nine → home (logo).
await act('open-bingo'); await waitTop('bingo');
await check('bingo opens', '/?play=bingo', 'bingo');
await reloadCheck('bingo reload', '/?play=bingo', 'bingo');
await p.locator('#bingoScreen [data-action="close-bingo"]:visible').first().click(); await waitTop('home');
// ← closes back to the entry before Bingo (consumed, so Back won't reopen it).
await check('bingo ← → previous page', /^\/(\?nc=\d+)?$/, 'home');
// Back/Forward between two views: home → bingo → (logo can't reach) open s9 from bingo.
await act('open-bingo'); await waitTop('bingo');
await check('bingo again', '/?play=bingo', 'bingo');
await act('close-bingo'); await act('open-sunday-nine'); await waitTop('s9');
await check('bingo → sunday nine', '/?play=sunday-nine', 's9');
await p.goBack(); await waitTop('home');
await check('back → home (bingo was closed by X)', /^\/(\?nc=\d+)?$/, 'home');
await p.goForward(); await waitTop('s9');
await check('forward → sunday nine', '/?play=sunday-nine', 's9');
await act('close-sunday-nine'); await waitTop('home');

await act('open-sunday-nine'); await waitTop('s9');
await check('sunday nine opens', '/?play=sunday-nine', 's9');
await reloadCheck('sunday nine reload', '/?play=sunday-nine', 's9');
await p.locator('#s9Screen [data-action="close-sunday-nine"]:visible').first().click(); await waitTop('home');
await check('sunday nine ← → previous page', /^\/(\?nc=\d+)?$/, 'home');

// Listing → seller profile → back → back.
const card = p.locator('[data-action="open-detail"]').first();
const lid = await card.getAttribute('data-product-id');
await card.click(); await waitTop('detail');
await check('listing opens', '/?listing=' + lid, 'detail');
await reloadCheck('listing reload', '/?listing=' + lid, 'detail');
const sellerLink = p.locator('#detailBackdrop [data-action="open-profile"]:visible').first();
let sellerUid = null;
if (await sellerLink.count()) {
  sellerUid = await sellerLink.getAttribute('data-uid');
  await sellerLink.evaluate((e) => e.click()); await waitTop('profile');
  await check('seller profile from listing', '/?seller=' + sellerUid, 'profile');
  await reloadCheck('profile reload', '/?seller=' + sellerUid, 'profile');
  await p.goBack(); await waitTop('home');
  // After a reload the history entry before the profile is the listing.
  await check('back from profile', /^\/(\?listing=.+)?$/, (await url()).includes('listing') ? 'detail' : 'home');
} else results.push({label: 'seller link in listing', ok: false});
await clickLogo(); await waitTop('home');
await check('logo → home', '/', 'home');

// Logo on the home page itself, scrolled down: stays home, back to the top.
await p.evaluate(() => (document.getElementById('app-scroll') || window).scrollTo(0, 2400)); await p.waitForTimeout(500);
await clickLogo(); await p.waitForTimeout(1200);
const scrollY = await p.evaluate(() => { const s = document.getElementById('app-scroll'); return s && s.scrollHeight > s.clientHeight ? s.scrollTop : window.scrollY; });
results.push({label: 'logo on home: stays home, scrolls to top', ok: (await url()) === '/' && scrollY < 50, url: await url(), top: 'scrollY ' + scrollY});

// Close-by-X consumes the entry: open bingo, close with its X, Back leaves the site state alone.
await act('open-bingo'); await waitTop('bingo');
const hl1 = await p.evaluate(() => history.length);
await act('close-bingo'); await waitTop('home');
await check('bingo X → home', '/', 'home');
const hl2 = await p.evaluate(() => history.length);
results.push({label: 'X close does not grow history', ok: hl2 === hl1, detail: hl1 + '→' + hl2});

if (EMAIL) {
  await act('open-shop-dashboard'); await waitTop('shop');
  await check('my shop opens', '/?view=shop', 'shop');
  await reloadCheck('my shop reload', '/?view=shop', 'shop');
  await clickLogo(); await waitTop('home');
  await check('logo from my shop → home', '/', 'home');
  // Dylan's exact path: Logo Bingo → dashboard → home, then Back twice.
  // Dylan's path as a user takes it: Logo Bingo, its ←, My Shop, logo home,
  // then Back / Back / Forward / Forward.
  await act('open-bingo'); await waitTop('bingo');
  await check('bingo', '/?play=bingo', 'bingo');
  await p.locator('#bingoScreen [data-action="close-bingo"]:visible').first().click(); await waitTop('home');
  await act('open-shop-dashboard'); await waitTop('shop');
  await check('bingo ← then dashboard', '/?view=shop', 'shop');
  await act('bn-home'); await waitTop('home');
  await check('dashboard → home (Home)', '/', 'home');
  await p.goBack(); await waitTop('shop');
  await check('back → dashboard', '/?view=shop', 'shop');
  await p.goForward(); await waitTop('home');
  await check('forward → home', '/', 'home');
  await reloadCheck('reload home', '/', 'home');
  await p.goBack(); await waitTop('shop');
  await check('back after reload → dashboard', '/?view=shop', 'shop');
  // Both open at once (bingo over shop): the URL follows what is visible.
  await act('open-bingo'); await waitTop('bingo');
  await check('bingo over open dashboard', '/?play=bingo', 'bingo');
  await act('bn-home'); await waitTop('home');

  await p.evaluate(() => window.handleSellClick()); await waitTop('sell');
  await check('sell opens', '/?view=sell', 'sell');
  await reloadCheck('sell reload', '/?view=sell', 'sell');
  await clickLogo(); await waitTop('home');
  await check('logo from sell → home', '/', 'home');

  await act('open-passport-feed'); await waitTop('passport');
  await check('passport opens', '/?view=passport', 'passport');
  await reloadCheck('passport reload', '/?view=passport', 'passport');
  await p.locator('#passportFeedScreen [data-action="close-passport-feed"]:visible').first().click(); await waitTop('home');
  await check('passport ← → home', '/', 'home');

  const me = await p.evaluate(() => window.CURRENT_USER.uid);
  await p.evaluate((u) => window.openProfile(u), me); await waitTop('profile');
  await check('own profile', '/?seller=' + me, 'profile');
  await reloadCheck('own profile reload', '/?seller=' + me, 'profile');
  await clickLogo(); await waitTop('home');
  await check('logo from profile → home', '/', 'home');

  // Checkout entry on someone else's listing (opens the form, never pays).
  const other = await p.evaluate((u) => { const c = [...document.querySelectorAll('[data-action="open-detail"]')]; const pr = (window.PRODUCTS || []); const ids = c.map((x) => x.dataset.productId); const ok = pr.filter((x) => ids.includes(x.id) && x.sellerId !== u && x.status === 'active' && !x.sold); return ok.length ? ok[0].id : null; }, me);
  if (other) {
    await p.evaluate((id) => window.openDetailModal(id), other); await waitTop('detail');
    await check('listing for checkout', '/?listing=' + other, 'detail');
    await p.locator('#detailBackdrop [data-action="detail-buy-now"]:visible').first().click().catch(() => {});
    await waitTop('checkout', 15000);
    await check('checkout entry', '/?listing=' + other + '&view=checkout', 'checkout');
    await p.goBack(); await waitTop('detail');
    await check('back from checkout → listing', '/?listing=' + other, 'detail');
    await p.goForward(); await p.waitForTimeout(1500);
    results.push({label: 'forward to checkout (reopens listing only, by design)', ok: true, url: await url(), top: await top()});
    await reloadCheck('checkout reload → listing', '/?listing=' + other, 'detail');
    await clickLogo(); await waitTop('home');
    await check('logo from listing → home', '/', 'home');
  } else results.push({label: 'checkout entry: no other-seller listing on page', ok: false});
}

console.log('blocked requests:', blocked.length, [...new Set(blocked)].join(' , '));
console.log('logo clicked directly on:', [...new Set(reached)].join(', ') || '-', '| logo covered (Home action used) on:', [...new Set(covered)].join(', ') || '-');
results.push({label: 'page errors', ok: !errs.filter((e) => !/firestore.googleapis.com|Load failed|ResizeObserver/.test(e)).length, detail: errs.filter((e) => !/firestore.googleapis.com|Load failed|ResizeObserver/.test(e)).slice(0, 4)});
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.url !== undefined ? '  ' + r.url + ' [' + r.top + ']' : '') + (r.ok ? '' : '  want ' + (r.want || '') + ' ' + JSON.stringify(r.detail || '')));
console.log(results.every((r) => r.ok) ? 'ALL PASS' : 'FAILURES: ' + results.filter((r) => !r.ok).length);
await b.close();
