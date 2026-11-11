import {webkit} from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({viewport: {width: 402, height: 874}, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
await ctx.route(/connect\.facebook\.net|facebook\.com\/tr|capiRelay/i, (r) => r.abort());
const p = await ctx.newPage();
await p.goto('https://teeboxmarket.com/?meta_test=TEST16318', {waitUntil: 'domcontentloaded'}); await p.waitForTimeout(4000);
console.log(await p.evaluate(() => ({authScreen: document.getElementById('authScreen')?.className, guest: window.GUEST_MODE, signIn: [...document.querySelectorAll('[data-action]')].filter((e) => e.offsetParent && /sign|login|auth/i.test(e.dataset.action)).map((e) => e.dataset.action + ':' + e.textContent.trim().slice(0, 25))})));
await p.screenshot({path: process.argv[2]});
await b.close();
