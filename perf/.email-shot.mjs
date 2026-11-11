import {webkit} from 'playwright';
const [HTML, OUT, UNSUB] = process.argv.slice(2);
const b = await webkit.launch();
const p = await (await b.newContext({viewport: {width: 640, height: 900}})).newPage();
await p.goto('file://' + HTML); await p.waitForTimeout(1500);
await p.screenshot({path: OUT, fullPage: true});
// Unsubscribe page: does it reach the live handler and show its answer?
const q = await (await b.newContext({viewport: {width: 420, height: 800}})).newPage();
let resp = null;
q.on('response', async (r) => { if (/handleUnsubscribe/.test(r.url())) { try { resp = r.status() + ' ' + (await r.text()); } catch (_) {} } });
await q.goto(UNSUB, {waitUntil: 'networkidle'}); await q.waitForTimeout(2000);
console.log('unsubscribe page →', resp, '| page says:', (await q.textContent('body')).replace(/\s+/g, ' ').trim().slice(0, 160));
const a = await (await b.newContext()).newPage();
const r = await a.goto('https://teeboxmarket.com/account?tab=email', {waitUntil: 'domcontentloaded'});
await a.waitForTimeout(2500);
console.log('manage-prefs link →', r.status(), a.url());
await b.close();
