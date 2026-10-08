import {spawn} from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const CSS=fs.readFileSync('fallbacks.css','utf8');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tbf-'));
const port=9000+Math.floor(Math.random()*90);
const p=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'--headless=new','--disable-gpu','--no-sandbox','--no-first-run','about:blank'],{stdio:'ignore'});
let ws; for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok){ws=(await r.json()).webSocketDebuggerUrl;break;}}catch{} await sleep(250);}
const sock=new WebSocket(ws); let id=0; const pend=new Map();
sock.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}});
await new Promise(r=>sock.addEventListener('open',r));
const send=(m,pa={},s)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});sock.send(JSON.stringify({id:i,method:m,params:pa,...(s?{sessionId:s}:{})}));});
const MEASURE=`JSON.stringify((()=>{const q=(s)=>document.querySelector(s); const h=(s)=>{const e=q(s);return e?Math.round(e.getBoundingClientRect().height*10)/10:null;};
  const w=(s)=>{const e=q(s);return e?Math.round(e.getBoundingClientRect().width*10)/10:null;};
  return {logo:h('.auth-logo'),sub:h('.auth-sub'),title:h('.auth-title'),desc:h('.auth-desc'),guest:h('.auth-guest-btn'),google:h('.auth-google-btn, [data-action="google-signin"]'),
    boxScroll:q('.auth-box')?q('.auth-box').scrollHeight:null, logoW:w('.auth-logo'), heroH:h('.hq-tile'), fonts:document.fonts.status,
    stack:getComputedStyle(document.body).fontFamily.slice(0,40)};})())`;
async function run(label, blockFonts, inject) {
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId:sid}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Network.enable',{},sid); await send('Page.enable',{},sid); await send('Runtime.enable',{},sid);
  await send('Emulation.setDeviceMetricsOverride',{width:412,height:823,deviceScaleFactor:2.625,mobile:true},sid);
  if (blockFonts) await send('Network.setBlockedURLs',{urls:['*fonts.gstatic.com*']},sid);
  if (inject) await send('Page.addScriptToEvaluateOnNewDocument',{source:`document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(CSS)};document.head.appendChild(s);});`},sid);
  await send('Page.navigate',{url:'https://teeboxmarket.com/'},sid); await sleep(7000);
  const r=await send('Runtime.evaluate',{returnByValue:true,expression:MEASURE},sid);
  await send('Target.closeTarget',{targetId});
  return {label,...JSON.parse(r.result.value)};
}
const rows=[];
rows.push(await run('TODAY     web fonts',   false, false));
rows.push(await run('TODAY     fallback',    true,  false));
rows.push(await run('OVERRIDES web fonts',   false, true));
rows.push(await run('OVERRIDES fallback',    true,  true));
console.log('  variant               logo   logoW   sub    title  desc   guest  box.scrollH  hero   fonts    stack');
for (const r of rows) console.log(`  ${r.label.padEnd(20)}  ${String(r.logo).padEnd(6)} ${String(r.logoW).padEnd(7)} ${String(r.sub).padEnd(6)} ${String(r.title).padEnd(6)} ${String(r.desc).padEnd(6)} ${String(r.guest).padEnd(6)} ${String(r.boxScroll).padEnd(12)} ${String(r.heroH).padEnd(6)} ${String(r.fonts).padEnd(8)} ${r.stack}`);
sock.close(); p.kill(); try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5});}catch{}
