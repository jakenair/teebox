#!/usr/bin/env node
/**
 * perf/investigate.mjs — read-only diagnosis of a cold home load. Changes nothing.
 *
 *   node perf/investigate.mjs reads     # every Firestore read the home page issues
 *   node perf/investigate.mjs profile   # CPU profile: what the long tasks actually are
 *   node perf/investigate.mjs frames    # screenshots at 1s/2s/3s + the LCP element
 *
 * Mobile emulation and 4x CPU throttling match perf/lh-config.mjs so numbers here
 * are comparable to the Lighthouse baseline.
 *
 * THE AUTH GATE IS NEVER DISMISSED. These runs measure what a logged-out
 * first-time visitor actually gets, gate included.
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODE = process.argv[2] || 'reads';
const URL_ = (process.argv[3] && !process.argv[3].startsWith('-')) ? process.argv[3]
  : 'https://teeboxmarket.com/';
const AT_ARG = process.argv.indexOf('--at');
const AT_MS = AT_ARG > -1 ? process.argv[AT_ARG + 1].split(',').map(Number) : [1000, 2000, 3000];
const OUT = path.join(process.cwd(), 'perf', 'results');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-inv-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const p = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--disable-dev-shm-usage', '--mute-audio', 'about:blank',
  ], {stdio: 'ignore'});
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return {proc: p, port, dir, ws: (await r.json()).webSocketDebuggerUrl};
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging port');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const {res, rej} = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) listeners.forEach((f) => f(m));
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return {
    ready,
    send: (method, params = {}, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, {res, rej});
      ws.send(JSON.stringify({id: i, method, params, ...(sessionId ? {sessionId} : {})}));
    }),
    on: (f) => listeners.push(f),
    close: () => ws.close(),
  };
}

/** The mobile profile from lh-config.mjs, applied over CDP. */
async function emulateMobile(send, sid) {
  await send('Emulation.setDeviceMetricsOverride',
      {width: 412, height: 823, deviceScaleFactor: 2.625, mobile: true}, sid);
  await send('Emulation.setUserAgentOverride', {userAgent:
    'Mozilla/5.0 (Linux; Android 11; moto g power) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'}, sid);
  await send('Emulation.setCPUThrottlingRate', {rate: 4}, sid);
  await send('Network.emulateNetworkConditions', {offline: false,
    latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8,
    uploadThroughput: 750 * 1024 / 8}, sid);
}

async function newPage(c) {
  const {targetId} = await c.send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await c.send('Target.attachToTarget', {targetId, flatten: true});
  return sessionId;
}

// ── MODE: reads ────────────────────────────────────────────────────────────
// Firestore's own debug log names every target and document path it requests.
// We enable it on the SAME module instance the app imports (ESM is keyed by
// URL, so a dynamic import of the gstatic URL hands back the one singleton)
// before any app code runs, then read it off the console.
async function modeReads(c, sid) {
  const lines = [];
  c.on((m) => {
    if (m.sessionId !== sid) return;
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (t.includes('Firestore')) lines.push(t);
    }
  });
  await c.send('Runtime.enable', {}, sid);
  await c.send('Network.enable', {}, sid);
  await c.send('Page.enable', {}, sid);
  await emulateMobile(c.send, sid);
  await c.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.__fsTap = [];
    import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js")
      .then((m) => { try { m.setLogLevel('debug'); } catch (e) {} });
  `}, sid);
  await c.send('Page.navigate', {url: URL_}, sid);
  await sleep(20000);
  return lines;
}

// ── MODE: profile ──────────────────────────────────────────────────────────
async function modeProfile(c, sid) {
  await c.send('Page.enable', {}, sid);
  await c.send('Runtime.enable', {}, sid);
  await emulateMobile(c.send, sid);
  await c.send('Profiler.enable', {}, sid);
  await c.send('Profiler.setSamplingInterval', {interval: 200}, sid);
  await c.send('Profiler.start', {}, sid);
  await c.send('Page.navigate', {url: URL_}, sid);
  await sleep(15000);
  const {profile} = await c.send('Profiler.stop', {}, sid);
  return profile;
}

// ── MODE: shifts ───────────────────────────────────────────────────────────
// Every layout shift, with the element that moved. CLS is a single number that
// says nothing about what to fix; this says which node to reserve space for.
// `warm` first does a throwaway load so the service worker and cache are
// primed, because warm CLS (0.355 every run) is the reproducible one.
async function modeShifts(c, sid, warm) {
  await c.send('Page.enable', {}, sid);
  await c.send('Runtime.enable', {}, sid);
  await emulateMobile(c.send, sid);
  await c.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.__shifts = [];
    window.__mutations = [];
    // Watch the sections around the shift so we see WHAT changed, not just
    // which neighbour moved. A style flip on #trending moves everything below
    // it, and the layout-shift API names the neighbour, not the cause.
    try {
      const watch = () => {
        ['trending', 'homeLatest', 'productGrid'].forEach((id) => {
          const el = document.getElementById(id);
          if (!el || el.__watched) return;
          el.__watched = true;
          window.__mutations.push({t: Math.round(performance.now()), id,
            what: 'initial', display: getComputedStyle(el).display,
            h: Math.round(el.getBoundingClientRect().height)});
          new MutationObserver((ms) => {
            for (const m of ms) {
              window.__mutations.push({t: Math.round(performance.now()), id,
                what: m.type === 'attributes' ? 'attr:' + m.attributeName : 'children',
                display: getComputedStyle(el).display,
                h: Math.round(el.getBoundingClientRect().height)});
            }
          }).observe(el, {attributes: true, attributeFilter: ['style', 'class', 'hidden'],
            childList: true});
        });
      };
      watch();
      const iv = setInterval(watch, 150);
      setTimeout(() => clearInterval(iv), 12000);
    } catch (e) {}
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__shifts.push({
            t: Math.round(e.startTime),
            v: +e.value.toFixed(4),
            sources: (e.sources || []).map((s) => {
              const n = s.node;
              return {
                tag: n ? n.tagName : '?',
                id: n ? (n.id || '') : '',
                cls: n ? (n.className || '').toString().slice(0, 60) : '',
                from: s.previousRect ? [s.previousRect.y, s.previousRect.height] : null,
                to: s.currentRect ? [s.currentRect.y, s.currentRect.height] : null,
              };
            }),
          });
        }
      }).observe({type: 'layout-shift', buffered: true});
    } catch (e) {}
  `}, sid);
  if (warm) {
    await c.send('Page.navigate', {url: URL_}, sid);
    await sleep(14000);
  }
  await c.send('Page.navigate', {url: URL_}, sid);
  await sleep(14000);
  const r = await c.send('Runtime.evaluate',
      {expression: 'JSON.stringify({shifts: window.__shifts, mutations: window.__mutations})',
        returnByValue: true}, sid);
  return JSON.parse(r.result.value || '{"shifts":[],"mutations":[]}');
}

// ── MODE: frames ───────────────────────────────────────────────────────────
async function modeFrames(c, sid) {
  await c.send('Page.enable', {}, sid);
  await c.send('Runtime.enable', {}, sid);
  await emulateMobile(c.send, sid);
  // Record the LCP element as the browser itself reports it — no guessing.
  await c.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.__lcp = null;
    try {
      new PerformanceObserver((l) => {
        const e = l.getEntries();
        const last = e[e.length - 1];
        window.__lcp = {
          time: Math.round(last.startTime),
          tag: last.element ? last.element.tagName : null,
          id: last.element ? (last.element.id || '') : '',
          cls: last.element ? (last.element.className || '').toString().slice(0, 80) : '',
          text: last.element ? (last.element.textContent || '').trim().slice(0, 60) : '',
          url: last.url || '',
        };
      }).observe({type: 'largest-contentful-paint', buffered: true});
    } catch (e) {}
  `}, sid);
  fs.mkdirSync(path.join(OUT, 'frames'), {recursive: true});
  const t0 = Date.now();
  await c.send('Page.navigate', {url: URL_}, sid);
  const shots = [];
  for (const at of AT_MS) {
    await sleep(Math.max(0, at - (Date.now() - t0)));
    const {data} = await c.send('Page.captureScreenshot', {format: 'png'}, sid);
    const f = path.join(OUT, 'frames', `t${(at / 1000).toFixed(1)}s.png`);
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    shots.push({at, file: f});
  }
  await sleep(6000);
  const lcp = await c.send('Runtime.evaluate',
      {expression: 'JSON.stringify(window.__lcp)', returnByValue: true}, sid);
  const visible = await c.send('Runtime.evaluate', {returnByValue: true, expression: `
    JSON.stringify((() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 40 && r.height > 20 && r.top < 823 && r.bottom > 0 &&
               s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
      };
      const gate = document.getElementById('authScreen');
      return {
        gateOpen: !!(gate && gate.classList.contains('open')),
        splash: !!document.getElementById('authSplash'),
        bodyClass: document.body.className,
        headline: [...document.querySelectorAll('h1,h2,.auth-tagline,.auth-splash-tag')]
            .filter(vis).map((e) => e.textContent.trim().slice(0, 50)),
        cards: document.querySelectorAll('.product-card, .pc-card').length,
      };
    })())`}, sid);
  return {shots, lcp: JSON.parse(lcp.result.value || 'null'),
    visible: JSON.parse(visible.result.value)};
}

(async () => {
  const {proc, dir, ws} = await launch();
  const c = connect(ws);
  await c.ready;
  const sid = await newPage(c);
  try {
    fs.mkdirSync(OUT, {recursive: true});
    if (MODE === 'reads') {
      const lines = await modeReads(c, sid);
      fs.writeFileSync(path.join(OUT, 'fs-debug.log'), lines.join('\n'));
      console.log(`captured ${lines.length} Firestore debug lines → perf/results/fs-debug.log`);
    } else if (MODE === 'shifts') {
      const out = await modeShifts(c, sid, process.argv.includes('--warm'));
      const sh = out.shifts; const total = sh.reduce((a, b) => a + b.v, 0);
      console.log(`\n  ${sh.length} layout shifts, CLS ${total.toFixed(3)}\n`);
      for (const s2 of sh.sort((a, b) => b.v - a.v).slice(0, 12)) {
        console.log(`  ${String(s2.v).padStart(7)}  at ${s2.t}ms`);
        for (const src of s2.sources.slice(0, 3)) {
          const move = src.from && src.to ? `  y ${Math.round(src.from[0])}->${Math.round(src.to[0])}  h ${Math.round(src.from[1])}->${Math.round(src.to[1])}` : '';
          console.log(`           <${src.tag.toLowerCase()}${src.id ? ' #' + src.id : ''}${src.cls ? ' .' + src.cls.trim().split(/\s+/).join('.') : ''}>${move}`);
        }
      }
      console.log('\n  ── section timeline ──');
      for (const m of out.mutations) {
        console.log(`  ${String(m.t).padStart(6)}ms  #${m.id.padEnd(12)} ${m.what.padEnd(12)} display:${String(m.display).padEnd(7)} h:${m.h}`);
      }
      console.log('');
    } else if (MODE === 'profile') {
      const p = await modeProfile(c, sid);
      fs.writeFileSync(path.join(OUT, 'boot-profile.json'), JSON.stringify(p));
      console.log(`profile: ${p.nodes.length} nodes, ${p.samples.length} samples → perf/results/boot-profile.json`);
    } else {
      const r = await modeFrames(c, sid);
      fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(r, null, 2));
      console.log(JSON.stringify(r, null, 2));
    }
  } finally {
    c.close(); proc.kill();
    try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 300}); } catch {}
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
