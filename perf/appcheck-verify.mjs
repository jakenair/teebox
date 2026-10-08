#!/usr/bin/env node
/**
 * perf/appcheck-verify.mjs — prove App Check still mints a token after r325's
 * 10s floor. Watches the network for the reCAPTCHA Enterprise script and the
 * token exchange with firebaseappcheck.googleapis.com, and reports when each
 * happened and what status came back. Read-only.
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbac-'));
const port = 9600 + Math.floor(Math.random() * 90);
const p = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--headless=new', '--disable-gpu',
   '--no-sandbox', '--no-first-run', 'about:blank'], {stdio: 'ignore'});
let ws; for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; } } catch {} await sleep(250); }
const sock = new WebSocket(ws); let id = 0; const pend = new Map(); const events = [];
sock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const {res, rej} = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/recaptcha|firebaseappcheck/.test(u)) events.push({t: Math.round((m.params.timestamp - t0) * 1000), status: m.params.response.status, url: u.replace(/\?.*/, ''), requestId: m.params.requestId, sid: m.sessionId});
  }
});
await new Promise((r) => sock.addEventListener('open', r));
const send = (method, params = {}, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, {res, rej}); sock.send(JSON.stringify({id: i, method, params, ...(s ? {sessionId: s} : {})})); });
const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
const {sessionId: sid} = await send('Target.attachToTarget', {targetId, flatten: true});
await send('Network.enable', {}, sid); await send('Page.enable', {}, sid);
let t0 = 0;
sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Network.requestWillBeSent' && !t0 && m.params.documentURL) t0 = m.params.timestamp; });
await send('Page.navigate', {url: process.argv[2] || 'https://teeboxmarket.com/'}, sid);
await sleep(22000);
console.log('\n  App Check / reCAPTCHA network activity (ms after navigation start):');
if (!events.length) console.log('  (none in 22s)');
for (const ev of events) console.log(`  ${String(ev.t).padStart(6)}ms  ${ev.status}  ${ev.url.replace(/^https:\/\//, '').slice(0, 110)}`);
const exch = events.filter((e) => /firebaseappcheck/i.test(e.url));
for (const e of exch) {
  if (e.status === 200 && exch.length > 1 && e === exch[0]) continue;   // CORS preflight
  try {
    const b = await send('Network.getResponseBody', {requestId: e.requestId}, e.sid);
    console.log(`\n  exchange ${e.status} body: ${String(b.body).slice(0, 400)}`);
  } catch (err) { console.log(`\n  exchange ${e.status}: body unavailable (${String(err.message).slice(0, 60)})`); }
}
if (!exch.length) console.log('\n  ✗ no token exchange observed');
sock.close(); p.kill(); try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5}); } catch {}
process.exit(0);
