// Meta Test Events walkthrough on the LIVE site with ?meta_test=CODE:
// view a listing → Buy Now → start a listing → publish a listing.
// Server (CAPI) events only, each tagged with the test code so they land in
// Test Events, not production reporting. Safety:
//   • the browser pixel is blocked (its events can't carry a test code);
//   • createPaymentIntent is blocked, so Buy Now reserves nothing (AddToCart and
//     InitiateCheckout fire before that call);
//   • Buy Now only on a listing whose seller is payouts-ready (else the button
//     records interest and emails the seller), never one of EXCLUDE_UIDS;
//   • the QA listing is deleted by the caller's cleanup trap right after.
// usage: node perf/.meta-walk.mjs CODE EMAIL PASSWORD PHOTO EXCLUDE_UIDS(comma) [--dry]
import {webkit} from 'playwright';
const [CODE, EMAIL, PASSWORD, PHOTO, EXCL = '', DRY] = process.argv.slice(2);
const dry = DRY === '--dry';
const exclude = new Set(EXCL.split(',').filter(Boolean));
const BASE = 'https://teeboxmarket.com';
const ct = () => new Date().toLocaleTimeString('en-US', {timeZone: 'America/Chicago', hour12: false});
const log = [];
const note = (s) => { const l = ct() + ' CT  ' + s; log.push(l); console.log(l); };
const b = await webkit.launch();
const ctx = await b.newContext({viewport: {width: 402, height: 874}, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
await ctx.route(/connect\.facebook\.net|facebook\.com\/tr/i, (r) => r.abort());
await ctx.route(/createPaymentIntent/i, (r) => r.abort());
if (dry) await ctx.route(/capiRelay/i, (r) => r.abort());
await ctx.addInitScript(() => { try { localStorage.setItem('tb_install_dismissed', '1'); localStorage.setItem('tb_push_prompt_seen', '1'); } catch (_) {} });
const p = await ctx.newPage();
const relayed = [];
p.on('request', (r) => {
  if (!/capiRelay/i.test(r.url())) return;
  try { const d = JSON.parse(r.postData() || '{}'); const x = d.data || d; relayed.push({at: ct(), event: x.eventName || x.event_name, code: x.testEventCode || '', id: x.eventId || x.event_id || ''}); } catch (_) {}
});
p.on('response', async (r) => {
  if (!/capiRelay/i.test(r.url())) return;
  try { const t = await r.text(); note('  relay ' + r.status() + ' ' + t.slice(0, 120)); } catch (_) {}
});

note('START walkthrough, test code ' + CODE + (dry ? ' (DRY: relay blocked, no publish)' : ''));
await p.goto(BASE + '/?meta_test=' + CODE, {waitUntil: 'domcontentloaded'});
await p.waitForTimeout(3000);
note('test code stored for the session: ' + await p.evaluate(() => window.metaTestEventCode && window.metaTestEventCode()));
// Live web lands guests straight on the marketplace: sign in from the auth screen.
if (await p.locator('[data-action="welcome-login"]:visible').count()) await p.locator('[data-action="welcome-login"]').click();
else { await p.evaluate(() => window.__actions['show-auth']()); await p.waitForTimeout(1500);
  const wl = p.locator('[data-action="welcome-login"]:visible'); if (await wl.count()) await wl.first().click(); }
await p.waitForTimeout(800);
await p.locator('text=Continue with email').first().click();
await p.fill('#emailInput', EMAIL); await p.fill('#passwordInput', PASSWORD);
await p.locator('#emailSubmitBtn').click();
await p.waitForFunction(() => !!window.CURRENT_USER, null, {timeout: 30000});
await p.waitForTimeout(3000);
{ const x = p.locator('#marketingReoptBanner .mrb-close:visible'); if (await x.count()) await x.first().click(); }
note('signed in as the QA account');

// 1. View a listing whose seller can take payment (not one of the excluded sellers).
const me = await p.evaluate(() => window.CURRENT_USER.uid);
const candidates = await p.evaluate(({me, ex}) => (window.PRODUCTS || []).filter((x) => x.status === 'active' && !x.sold && x.sellerId !== me && !ex.includes(x.sellerId)).map((x) => x.id), {me, ex: [...exclude]});
let picked = null;
for (const id of candidates.slice(0, 15)) {
  await p.evaluate((i) => window.openDetailModal(i), id);
  await p.waitForSelector('#detailBackdrop.open', {timeout: 10000});
  await p.waitForTimeout(2500);
  const label = await p.locator('#detailBackdrop [data-action="detail-buy-now"]').first().textContent().catch(() => '');
  if (/finishing setup|notified|let you know/i.test(label || '')) { await p.evaluate(() => window.__actions['close-detail-direct']()); await p.waitForTimeout(500); continue; }
  picked = id; break;
}
if (!picked) { note('ABORT: no payouts-ready listing found to view/buy'); await b.close(); process.exit(2); }
note('1. ViewContent: opened listing ' + picked);
await p.waitForTimeout(3000);

// 2. Buy Now (PaymentIntent blocked: nothing reserved, no payment form).
await p.locator('#detailBackdrop [data-action="detail-buy-now"]:visible').first().click();
note('2. Buy Now tapped: AddToCart + InitiateCheckout');
await p.waitForTimeout(6000);
await p.evaluate(() => { try { window.__actions['close-checkout-direct'](); } catch (_) {} try { window.__actions['close-detail-direct'](); } catch (_) {} });
await p.waitForTimeout(1500);

// 3. Start a listing.
await p.evaluate(() => window.handleSellClick());
await p.waitForSelector('#sellModalBackdrop.open', {timeout: 15000});
note('3. ListingStarted: sell form opened');
await p.waitForTimeout(3000);

// 4. Publish (QA listing, deleted by the cleanup trap right after).
if (!dry) {
  await p.setInputFiles('#photoInput', PHOTO);
  await p.waitForTimeout(2500);
  await p.locator('#sellSpecCatPills >> text=Apparel').click();
  await p.waitForTimeout(800);
  await p.selectOption('#spec_apparelType', 'Polo'); await p.selectOption('#spec_size', 'M');
  await p.fill('#sellTitle', 'PW WALK TEST polo (delete me)'); await p.fill('#sellBrand', 'Unbranded');
  await p.fill('#sellPrice', '25');
  for (const id of ['sellAge18Checkbox', 'sellTermsCheckbox']) { const c = p.locator('#' + id); if (await c.isVisible().catch(() => false)) await c.check(); }
  await p.locator('#submitListingBtn').click();
  note('4. ListItem: publish tapped');
  await p.waitForTimeout(9000);
} else note('4. (dry) publish skipped');
note('END walkthrough');
console.log('RELAYED EVENTS:');
for (const r of relayed) console.log('  ' + r.at + '  ' + r.event + '  code=' + r.code + '  id=' + r.id);
await b.close();
