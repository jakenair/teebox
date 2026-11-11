import {webkit, devices} from 'playwright';
const [BASE, OUT, MODE] = process.argv.slice(2);
const b = await webkit.launch();
const ctx = await b.newContext({...(MODE==='mobile'?devices['iPhone 14']:{viewport:{width:1280,height:860}}), serviceWorkers:'block'});
await ctx.addInitScript(() => { try { localStorage.setItem('tb_install_dismissed','1'); } catch (_) {} });
const p = await ctx.newPage();
await p.goto(BASE + '/', {waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
const sk = p.locator('[data-action="welcome-skip"]:visible, .auth-guest-btn:visible').first(); if (await sk.count()) { await sk.click(); await p.waitForTimeout(800); }
for (const [n, open, close] of [['bingo','open-bingo','close-bingo'],['s9','open-sunday-nine','close-sunday-nine'],['passport','open-passport-feed','close-passport-feed']]) {
  await p.evaluate((a)=>window.__actions[a](document.body,new Event('click')), open); await p.waitForTimeout(2000);
  await p.screenshot({path: `${OUT}/${MODE}-${n}.png`, clip:{x:0,y:0,width:MODE==='mobile'?390:1280,height:220}});
  // what is at the top-left corner?
  console.log(n, await p.evaluate(() => { const e = document.elementFromPoint(40, 30); return e ? (e.className || e.tagName) + ' | ' + (e.closest('[data-action]')?.dataset.action || '-') : null; }));
  await p.evaluate((a)=>window.__actions[a](document.body,new Event('click')), close); await p.waitForTimeout(600);
}
await b.close();
