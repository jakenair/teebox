import {spawn} from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tbw-'));
const port=9200+Math.floor(Math.random()*90);
const p=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'--headless=new','--disable-gpu','--no-sandbox','--no-first-run','about:blank'],{stdio:'ignore'});
let ws; for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok){ws=(await r.json()).webSocketDebuggerUrl;break;}}catch{} await sleep(250);}
const sock=new WebSocket(ws); let id=0; const pend=new Map();
sock.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}});
await new Promise(r=>sock.addEventListener('open',r));
const send=(m,pa={},s)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});sock.send(JSON.stringify({id:i,method:m,params:pa,...(s?{sessionId:s}:{})}));});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});
const {sessionId:sid}=await send('Target.attachToTarget',{targetId,flatten:true});
await send('Runtime.enable',{},sid);
const dm=fs.readFileSync('dmsans.woff2').toString('base64'), pf=fs.readFileSync('playfair.woff2').toString('base64');
const SAMPLE="Buy and sell golf gear, golfer to golfer. 8.5% seller fee Stripe-secured checkout. Sign in to TeeBox Enter your email and password to continue. Browse the marketplace first No account needed to look around Continue with Google Forgot your password? Create Account";
const r=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
  const dm=new FontFace('DMW','url(data:font/woff2;base64,${dm})',{weight:'100 900'}); await dm.load(); document.fonts.add(dm);
  const pf=new FontFace('PFW','url(data:font/woff2;base64,${pf})',{weight:'100 900'}); await pf.load(); document.fonts.add(pf);
  const c=document.createElement('canvas').getContext('2d'); const S=${JSON.stringify(SAMPLE)};
  const m=(fam,w)=>{c.font=w+' 100px '+fam; const t=c.measureText(S); return {w:+(t.width/S.length).toFixed(3),asc:+t.fontBoundingBoxAscent.toFixed(2),desc:+t.fontBoundingBoxDescent.toFixed(2)};};
  const out={};
  for (const w of [300,400,500,600,700,800]) out['DM Sans '+w]=m('DMW',w);
  for (const w of [400,700,800,900]) out['Playfair '+w]=m('PFW',w);
  out['Arial']=m('Arial',400); out['Arial Bold']=m('Arial',700);
  out['Times New Roman']=m('"Times New Roman"',400); out['Times New Roman Bold']=m('"Times New Roman"',700);
  out['Georgia']=m('Georgia',400); out['Georgia Bold']=m('Georgia',700);
  out['Helvetica']=m('Helvetica',400); out['system-ui']=m('system-ui',400);
  return out;})()`},sid);
const w=r.result.value; fs.writeFileSync('widths.json',JSON.stringify(w,null,1));
console.log('  font                   avg px/char @100px   asc   desc');
for (const [n,v] of Object.entries(w)) console.log(`  ${n.padEnd(22)} ${String(v.w).padStart(8)}             ${String(v.asc).padStart(6)} ${String(v.desc).padStart(6)}`);
sock.close(); p.kill(); try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5});}catch{}
