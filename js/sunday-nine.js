// sunday-nine.js — Sunday Nine, the daily 3x3 golf player grid. ES module.
//
// Same shape as Logo Bingo (js/bingo.js): a full-screen sheet inside the SPA,
// opened by data-action="open-sunday-nine" or the ?play=sunday-nine deep link
// (teeboxmarket.com/sunday-nine redirects there). The rules live in
// /sunday-nine/engine.js + categories.js, the one copy shared with the Cloud
// Function. The round plays from localStorage; for signed-in players the raw
// guess log syncs to the syncSundayNine callable, which re-scores it and owns
// the streak — nothing this file computes is trusted server-side.
//
// No emoji anywhere in the UI. The share text is the only exception.

import * as E from '/sunday-nine/engine.js';
import { CATEGORY_BY_ID } from '/sunday-nine/categories.js';

const FB = 'https://www.gstatic.com/firebasejs/12.12.0/';
const LS_GAME = 'tb_s9_v1_';
const LS_STATS = 'tb_s9_stats_v1';
const LS_QUEUE = 'tb_s9_queue_v1';

const S = {
  data: null,          // {players, byId, pinned}
  date: null,
  grid: null,
  guesses: [],
  gaveUp: false,
  server: null,        // last state returned by syncSundayNine
  stats: null,         // server stats (signed in)
  daily: null,         // sundayNineDaily/{date} aggregate
  openCell: null,
  preview: false,      // admin-only early round on grid #1 (server-gated)
  active: 0,
  built: false,
  giveUpArmed: 0,
};

// ── Storage (every access guarded: private mode / blocked storage) ─────
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

function saveLocal() {
  lsSet(LS_GAME + S.date, { guesses: S.guesses, gaveUp: S.gaveUp, grid: { rows: S.grid.rows, cols: S.grid.cols } });
}
function loadLocal(date) { return lsGet(LS_GAME + date, null); }

function queueSync(date) {
  const q = lsGet(LS_QUEUE, []);
  if (q.indexOf(date) === -1) { q.push(date); lsSet(LS_QUEUE, q.slice(-14)); }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (window.CURRENT_USER && window.CURRENT_USER.uid) || null;
const toast = (m) => { if (window.showToast) window.showToast(m); };

// ── Data ────────────────────────────────────────────────────────────────
async function loadData() {
  if (S.data) return S.data;
  const [pr, gr, lr] = await Promise.all([
    fetch('/sunday-nine/players.json', { cache: 'no-cache' }),
    fetch('/sunday-nine/grids.json', { cache: 'no-cache' }),
    fetch('/sunday-nine/logos.json', { cache: 'no-cache' }).catch(() => null),
  ]);
  if (!pr.ok || !gr.ok) throw new Error('sunday-nine data ' + pr.status + '/' + gr.status);
  const players = (await pr.json()).players;
  const pinned = (await gr.json()).grids;
  let logos = {};
  try { if (lr && lr.ok) logos = (await lr.json()).logos || {}; } catch (_) {}
  S.data = { players, byId: Object.fromEntries(players.map((p) => [p.id, p])), pinned, logos };
  return S.data;
}

function ensureCss() {
  if (document.getElementById('s9Css')) return;
  const l = document.createElement('link');
  l.id = 's9Css'; l.rel = 'stylesheet'; l.href = '/sunday-nine/sunday-nine.css?v=r403';
  document.head.appendChild(l);
}

// ── Screen ──────────────────────────────────────────────────────────────
const BACK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function build() {
  if (S.built) return;
  S.built = true;
  const el = document.createElement('div');
  el.id = 's9Screen';
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Sunday Nine');
  el.innerHTML = `
    <header class="s9-header">
      <button class="s9-back" data-action="close-sunday-nine" aria-label="Close Sunday Nine" type="button">${BACK_SVG}</button>
      <div class="s9-titlewrap">
        <div class="s9-title">Sunday <span>Nine</span></div>
        <div class="s9-date" id="s9Date"></div>
      </div>
      <button class="s9-share-top" id="s9ShareTop" data-action="s9-share" type="button" disabled>Share</button>
    </header>
    <div class="s9-body">
      <div id="s9Pre" hidden>
        <section class="s9-pre">
          <div class="s9-pre-eyebrow">Coming Sunday</div>
          <h2 class="s9-pre-title">First round tees off Sunday</h2>
          <p class="s9-pre-date" id="s9PreDate"></p>
        </section>
        <section class="s9-howto" aria-labelledby="s9HowTitle">
          <h3 id="s9HowTitle">How to play</h3>
          <ol>
            <li>Each square is a hole. Name a pro who fits both its row and its column.</li>
            <li>Three guesses per hole. Right on the first guess is a birdie (2), the second a par (3), the third a bogey (4). Miss all three for a double bogey (5).</li>
            <li>Nine holes, par 27. Each player only once. Shoot 18 for a Sunday Red.</li>
            <li>A new grid every day at midnight Central.</li>
          </ol>
        </section>
      </div>
      <div id="s9Game">
      <p class="s9-sub">Name a pro who fits <strong>both</strong> the row and the column. Nine holes, par 27. First guess right is a birdie. Three guesses per square, and each player only once.</p>
      <div class="s9-scorebar">
        <div><span class="s9-stat-l">Score</span><span class="s9-stat-v" id="s9ToPar">E</span></div>
        <div><span class="s9-stat-l">Thru</span><span class="s9-stat-v" id="s9Thru">0</span></div>
        <div><span class="s9-stat-l">Streak</span><span class="s9-stat-v" id="s9Streak">0</span></div>
      </div>
      <div class="s9-grid" id="s9Grid" role="grid" aria-label="Sunday Nine grid"></div>
      <div class="s9-footer">
        <p class="s9-msg" id="s9Msg">Tap a square to tee off.</p>
        <button class="s9-giveup" id="s9GiveUp" data-action="s9-give-up" type="button">End round</button>
      </div>
      <div class="s9-net" id="s9Net" aria-live="polite"></div>
      <div id="s9Done"></div>
      <div id="s9Answers"></div>
      </div>
    </div>`;
  document.body.appendChild(el);

  const sheet = document.createElement('div');
  sheet.id = 's9GuessBackdrop';
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = `
    <div class="s9-sheet" role="dialog" aria-modal="true" aria-labelledby="s9SheetQ">
      <div class="s9-sheet-head">
        <div class="s9-sheet-q" id="s9SheetQ"></div>
        <button class="s9-close" data-action="s9-close-guess" aria-label="Close" type="button">${X_SVG}</button>
      </div>
      <input class="s9-input" id="s9Input" type="text" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" placeholder="Search players" aria-label="Search players" aria-controls="s9List" />
      <div class="s9-left" id="s9Left"></div>
      <div class="s9-wrong" id="s9Wrong"></div>
      <ul class="s9-list" id="s9List" role="listbox"></ul>
    </div>`;
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeGuess(); });
  document.body.appendChild(sheet);

  const input = sheet.querySelector('#s9Input');
  input.addEventListener('input', () => { S.active = 0; renderList(); });
  input.addEventListener('keydown', (e) => {
    const items = sheet.querySelectorAll('#s9List button');
    if (e.key === 'ArrowDown') { e.preventDefault(); S.active = Math.min(items.length - 1, S.active + 1); renderList(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.active = Math.max(0, S.active - 1); renderList(true); }
    else if (e.key === 'Enter') { e.preventDefault(); const b = items[S.active]; if (b) submitGuess(b.dataset.pid); }
    else if (e.key === 'Escape') { closeGuess(); }
  });
  sheet.querySelector('#s9List').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pid]');
    if (b) submitGuess(b.dataset.pid);
  });
  el.querySelector('#s9Grid').addEventListener('click', (e) => {
    const c = e.target.closest('.s9-cell');
    if (c && !c.disabled) openGuess(+c.dataset.cell);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('open') && !sheet.classList.contains('open')) closeSundayNine();
  });
}

function result() {
  const local = E.scoreGame(S.grid, S.data.byId, S.guesses, S.gaveUp);
  // The server's replay wins when it has seen the same log (it may run on
  // newer data than a cached players.json).
  const sv = S.server;
  if (sv && sv.date === S.date && sv.guesses && sv.guesses.length === S.guesses.length && !!sv.gaveUp === !!S.gaveUp) {
    return { cells: sv.cells, complete: sv.complete, strokes: sv.strokes, toPar: sv.toPar, correct: sv.correct, sundayRed: sv.sundayRed };
  }
  return local;
}

function catLabel(id) { const c = CATEGORY_BY_ID[id]; return c ? c.label : id; }

// Header: official mark (self-hosted) above the text, which is always shown.
// World No. 1 has no mark of its own, so it gets a plain text badge.
function catHtml(id, row) {
  const lg = S.data.logos[id];
  let mark = '';
  if (id === 'world1') mark = '<span class="s9-badge" aria-hidden="true">No. 1</span>';
  else if (lg && lg.u) mark = `<span class="s9-plate ${esc(lg.plate || 'light')}" aria-hidden="true"><img class="s9-logo" src="${esc(lg.u)}" alt="" loading="lazy" decoding="async"></span>`;
  return `<div class="s9-cat${row ? ' row' : ''}${mark ? ' has-mark' : ''}" role="${row ? 'rowheader' : 'columnheader'}">${mark}<span class="s9-cat-t">${esc(catLabel(id))}</span></div>`;
}

const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;
function initials(name) {
  const w = String(name).replace(/\./g, '. ').split(/\s+/).filter((x) => x && !NAME_SUFFIX.test(x));
  if (!w.length) return '';
  const first = w[0][0];
  const last = w.length > 1 ? w[w.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Photo (self-hosted headshot) or, when there is none, a monogram.
function faceHtml(p) {
  if (p && p.ph) return `<img class="s9-face" src="${esc(p.ph)}" srcset="${esc(p.ph)} 256w, ${esc(p.ph.replace('-256.webp', '-512.webp'))} 512w" sizes="(min-width: 560px) 160px, 30vw" alt="" decoding="async">`;
  return `<span class="s9-mono" aria-hidden="true">${esc(initials(p ? p.n : '?'))}</span>`;
}

function markHtml(strokes) {
  return `<span class="s9-mark b${strokes}" aria-hidden="true">${strokes}</span>`;
}

function render() {
  const r = result();
  const g = S.grid;
  // Idempotent: also covers a finished round restored from storage or
  // adopted from another device.
  if (r.complete) recordLocalFinish(r);
  const num = E.gridNumber(S.date);
  document.getElementById('s9Date').textContent = S.preview
    ? 'Grid No. 1 · Admin preview'
    : (num >= 1 ? 'No. ' + num + ' · ' : 'Preview · ') + prettyDate(S.date);

  let html = `<div class="s9-corner" aria-hidden="true">Par 27<small>9 holes</small></div>`;
  for (let c = 0; c < 3; c++) html += catHtml(g.cols[c], false);
  for (let row = 0; row < 3; row++) {
    html += catHtml(g.rows[row], true);
    for (let c = 0; c < 3; c++) {
      const i = row * 3 + c;
      const cell = r.cells[i];
      const strokes = E.strokesFor(cell);
      const label = `Hole ${i + 1}: ${catLabel(g.rows[row])} and ${catLabel(g.cols[c])}`;
      if (cell.pid) {
        const p = S.data.byId[cell.pid];
        html += `<button class="s9-cell solved${p && p.ph ? ' photo' : ' mono'}" data-cell="${i}" type="button" disabled aria-label="${esc(label)}. ${esc(p ? p.n : '')}, ${E.holeName(strokes)}">
          ${faceHtml(p)}
          <span class="s9-corner-mark">${markHtml(strokes)}</span>
          <span class="s9-pname">${esc(p ? p.n : cell.pid)}</span></button>`;
      } else if (cell.done) {
        html += `<button class="s9-cell missed" data-cell="${i}" type="button" disabled aria-label="${esc(label)}. Double bogey">
          <span class="s9-hole">Hole ${i + 1}</span>
          <span class="s9-result">${markHtml(5)}Double bogey</span></button>`;
      } else {
        let dots = '';
        for (let t = 0; t < E.MAX_ATTEMPTS; t++) dots += `<i class="${t < cell.tries ? 'used' : ''}"></i>`;
        html += `<button class="s9-cell" data-cell="${i}" type="button" ${r.complete ? 'disabled' : ''} aria-label="${esc(label)}. ${E.MAX_ATTEMPTS - cell.tries} guesses left">
          <span class="s9-hole">Hole ${i + 1}</span><span class="s9-tries" aria-hidden="true">${dots}</span></button>`;
      }
    }
  }
  document.getElementById('s9Grid').innerHTML = html;

  const thru = r.cells.filter((c) => c.done).length;
  const tp = document.getElementById('s9ToPar');
  tp.textContent = E.formatToPar(r.toPar);
  tp.classList.toggle('under', r.toPar < 0);
  document.getElementById('s9Thru').textContent = r.complete ? 'F' : String(thru);
  document.getElementById('s9Streak').textContent = String(streakNow(r.complete));
  document.getElementById('s9ShareTop').disabled = !r.complete;
  const gu = document.getElementById('s9GiveUp');
  gu.style.display = r.complete ? 'none' : '';
  gu.textContent = S.giveUpArmed > Date.now() ? 'Tap again to end' : 'End round';
  document.getElementById('s9Msg').textContent = r.complete
    ? 'Round complete. New grid at midnight Central.'
    : thru === 0 ? 'Tap a square to tee off.' : `${9 - thru} to play.`;
  renderDone(r);
  renderAnswers(r);
}

function prettyDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] + ' ' + day + ', ' + y;
}

function localStats() { return lsGet(LS_STATS, { finished: [], best: 0, sundayReds: 0, played: 0, bestStrokes: null }); }

function streakNow(complete) {
  if (uid() && S.stats) return S.stats.current || 0;
  const ls = localStats();
  const fin = ls.finished.slice();
  if (complete && fin.indexOf(S.date) === -1) fin.push(S.date);
  return E.streakFrom(fin, S.date);
}

function recordLocalFinish(r) {
  const ls = localStats();
  if (ls.finished.indexOf(S.date) !== -1) return;
  ls.finished = ls.finished.concat([S.date]).slice(-120);
  ls.played += 1;
  if (r.sundayRed) ls.sundayReds += 1;
  ls.bestStrokes = ls.bestStrokes ? Math.min(ls.bestStrokes, r.strokes) : r.strokes;
  ls.best = Math.max(ls.best, E.streakFrom(ls.finished, S.date));
  lsSet(LS_STATS, ls);
}

function renderDone(r) {
  const host = document.getElementById('s9Done');
  if (!r.complete) { host.innerHTML = ''; return; }
  const st = uid() && S.stats ? S.stats : localStats();
  const streak = streakNow(true);
  const best = Math.max(st.best || 0, streak);
  const toPar = E.formatToPar(r.strokes - E.PAR);
  const eyebrow = r.sundayRed ? 'Sunday Red' : r.strokes < E.PAR ? 'Under par' : r.strokes === E.PAR ? 'Even par' : 'Round complete';
  const sub = r.sundayRed
    ? 'Nine birdies. A perfect grid.'
    : `${r.correct} of 9 squares, ${r.cells.filter((c) => c.pid && c.tries === 1).length} birdies`;
  const guest = uid() ? '' :
    '<div class="s9-guestnote">Playing as a guest. <button type="button" data-action="s9-sign-in">Sign in</button> to keep your streak on every device.</div>';
  host.innerHTML = `
    <section class="s9-done${r.sundayRed ? ' red' : ''}" aria-live="polite">
      <div class="s9-done-eyebrow">${eyebrow}</div>
      <div class="s9-done-score">${r.strokes} <span style="font-size:0.55em">(${toPar})</span></div>
      <div class="s9-done-sub">${sub}</div>
      <div class="s9-done-stats">
        <div><b>${streak}</b>Streak</div>
        <div><b>${best}</b>Best</div>
        <div><b>${st.played || 0}</b>Played</div>
      </div>
      <button class="s9-share" data-action="s9-share" type="button">Share your card</button>
      ${guest}
    </section>`;
}

function renderAnswers(r) {
  const host = document.getElementById('s9Answers');
  if (!r.complete) { host.innerHTML = ''; return; }
  const plays = S.daily && S.daily.plays;
  let html = '<section class="s9-answers"><h3>Every valid answer</h3>';
  for (let i = 0; i < 9; i++) {
    const [rc, cc] = E.squareCats(S.grid, i);
    const list = E.validAnswers(S.grid, i, S.data.players);
    const picks = (S.daily && S.daily.picks && S.daily.picks['c' + i]) || null;
    const mine = r.cells[i].pid;
    if (picks && plays) list.sort((a, b) => (picks[b.id] || 0) - (picks[a.id] || 0) || a.n.localeCompare(b.n));
    const items = list.map((p) => {
      const pct = picks && plays ? Math.round(100 * (picks[p.id] || 0) / plays) : null;
      return `<li class="${p.id === mine ? 'mine' : ''}"><span>${esc(p.n)}</span>${pct !== null ? `<em>${pct}%</em>` : ''}</li>`;
    }).join('');
    const yours = mine ? esc((S.data.byId[mine] || {}).n || '') : 'No answer';
    html += `<details class="s9-ans"${i === 0 ? ' open' : ''}>
      <summary><span class="s9-ans-q">${esc(rc.label)} + ${esc(cc.label)}<span>Yours: ${yours}</span></span>
      <span class="s9-ans-n">${list.length} answers</span></summary><ul>${items}</ul></details>`;
  }
  html += '</section>';
  host.innerHTML = html;
}

// ── Guessing ────────────────────────────────────────────────────────────
function openGuess(i) {
  const r = result();
  if (r.complete || r.cells[i].done) return;
  S.openCell = i;
  S.active = 0;
  const [rc, cc] = E.squareCats(S.grid, i);
  document.getElementById('s9SheetQ').innerHTML = `<span>Hole ${i + 1}</span>${esc(rc.label)} + ${esc(cc.label)}`;
  const left = E.MAX_ATTEMPTS - r.cells[i].tries;
  document.getElementById('s9Left').textContent = `${left} ${left === 1 ? 'guess' : 'guesses'} left on this hole.`;
  const wrong = r.cells[i].wrong.map((id) => (S.data.byId[id] || {}).n).filter(Boolean);
  document.getElementById('s9Wrong').textContent = wrong.length ? 'Not a fit: ' + wrong.join(', ') : '';
  const input = document.getElementById('s9Input');
  input.value = '';
  renderList();
  const bd = document.getElementById('s9GuessBackdrop');
  bd.classList.add('open');
  bd.setAttribute('aria-hidden', 'false');
  setTimeout(() => input.focus(), 50);
}

function closeGuess() {
  const bd = document.getElementById('s9GuessBackdrop');
  if (!bd) return;
  bd.classList.remove('open');
  bd.setAttribute('aria-hidden', 'true');
  S.openCell = null;
}

function renderList(keepScroll) {
  const ul = document.getElementById('s9List');
  const q = document.getElementById('s9Input').value;
  if (!q.trim()) { ul.innerHTML = '<li class="s9-empty">Start typing a name. Accents optional.</li>'; return; }
  const r = result();
  const used = new Set(r.cells.map((c) => c.pid).filter(Boolean));
  const wrong = new Set(r.cells[S.openCell] ? r.cells[S.openCell].wrong : []);
  const pool = S.data.players.filter((p) => !used.has(p.id) && !wrong.has(p.id));
  const hits = E.searchPlayers(pool, q, 8);
  if (!hits.length) { ul.innerHTML = '<li class="s9-empty">No player by that name in the Sunday Nine database.</li>'; return; }
  ul.innerHTML = hits.map((p, k) =>
    `<li role="option" aria-selected="${k === S.active}"><button type="button" data-pid="${esc(p.id)}" class="${k === S.active ? 'active' : ''}">${esc(p.n)}<span>${esc(p.c)}</span></button></li>`).join('');
  if (keepScroll) { const a = ul.querySelector('.active'); if (a) a.scrollIntoView({ block: 'nearest' }); }
}

function submitGuess(pid) {
  const i = S.openCell;
  if (i === null || !S.data.byId[pid]) return;
  const before = result();
  S.guesses.push({ cell: i, pid });
  saveLocal();
  const r = result();
  const cell = r.cells[i];
  closeGuess();
  const name = S.data.byId[pid].n;
  if (cell.pid === pid) toast(`${name}. ${E.holeName(E.strokesFor(cell))}.`);
  else if (cell.done) toast(`${name} doesn't fit. Double bogey.`);
  else if (cell.tries > before.cells[i].tries) toast(`${name} doesn't fit. ${E.MAX_ATTEMPTS - cell.tries} left.`);
  afterChange(r);
}

function afterChange(r) {
  render();
  if (uid()) { queueSync(S.date); scheduleSync(); }
}

function giveUp() {
  if (S.giveUpArmed > Date.now()) {
    S.giveUpArmed = 0;
    S.gaveUp = true;
    saveLocal();
    afterChange(result());
    return;
  }
  S.giveUpArmed = Date.now() + 3000;
  render();
  setTimeout(() => { if (S.giveUpArmed && S.giveUpArmed <= Date.now()) { S.giveUpArmed = 0; render(); } }, 3100);
}

async function share() {
  const r = result();
  if (!r.complete) return;
  const text = E.shareText(S.date, r);
  if (typeof window.shareOrFallback === 'function') {
    const how = await window.shareOrFallback({ title: 'TeeBox Sunday Nine', text });
    if (how === 'copied') toast('Copied your card.');
    return;
  }
  try { await navigator.clipboard.writeText(text); toast('Copied your card.'); } catch (_) {}
}

// ── Sync (signed in) ────────────────────────────────────────────────────
let syncTimer = null;
let syncing = false;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { drainQueue().catch(() => {}); }, 600);
}

function setNet(msg) { const n = document.getElementById('s9Net'); if (n) n.textContent = msg || ''; }

async function drainQueue() {
  if (syncing || !uid() || !navigator.onLine) return;
  const q = lsGet(LS_QUEUE, []);
  if (!q.length) return;
  syncing = true;
  try {
    const { getFunctions, httpsCallable } = await import(FB + 'firebase-functions.js');
    const call = httpsCallable(getFunctions(), 'syncSundayNine');
    for (const date of q.slice()) {
      const saved = loadLocal(date);
      if (!saved) { lsSet(LS_QUEUE, lsGet(LS_QUEUE, []).filter((d) => d !== date)); continue; }
      try {
        const res = await call({ date, guesses: saved.guesses || [], gaveUp: !!saved.gaveUp });
        const d = res.data || {};
        if (d.conflict && d.state && date === S.date) {
          // The server holds an earlier log this one doesn't extend (played
          // on another device). Its round stands.
          S.guesses = d.state.guesses.slice();
          S.gaveUp = !!d.state.gaveUp;
          saveLocal();
        }
        if (date === S.date && d.state) S.server = d.state;
        if (d.stats) S.stats = d.stats;
        lsSet(LS_QUEUE, lsGet(LS_QUEUE, []).filter((x) => x !== date));
        setNet('');
      } catch (e) {
        const code = e && e.code ? String(e.code) : '';
        if (/invalid-argument|failed-precondition/.test(code)) {
          lsSet(LS_QUEUE, lsGet(LS_QUEUE, []).filter((x) => x !== date));
        } else {
          setNet('Saved on this device. It will sync when you are back online.');
        }
      }
    }
  } finally {
    syncing = false;
  }
  if (document.getElementById('s9Screen') && S.grid) {
    if (result().complete) loadDaily().then(render).catch(() => {});
    render();
  }
}

async function hydrateFromServer() {
  const u = uid();
  if (!u) return;
  try {
    const { getFirestore, doc, getDoc } = await import(FB + 'firebase-firestore.js');
    const db = getFirestore();
    const [g, st] = await Promise.all([
      getDoc(doc(db, 'users', u, 'sundayNineGames', S.date)),
      getDoc(doc(db, 'users', u, 'sundayNineStats', 'summary')),
    ]);
    if (st.exists()) S.stats = st.data();
    if (g.exists()) {
      const sv = g.data();
      // Another device got further (or finished): adopt its log.
      if ((sv.guesses || []).length > S.guesses.length || (sv.complete && !result().complete)) {
        S.guesses = (sv.guesses || []).slice();
        S.gaveUp = !!sv.gaveUp;
        saveLocal();
      }
      S.server = sv;
    }
    if (result().complete) await loadDaily();
    render();
  } catch (_) { /* offline: local round stands */ }
  if (lsGet(LS_QUEUE, []).length) scheduleSync();
}

async function loadDaily() {
  if (!uid()) return;
  try {
    const { getFirestore, doc, getDoc } = await import(FB + 'firebase-firestore.js');
    const s = await getDoc(doc(getFirestore(), 'sundayNineDaily', S.date));
    S.daily = s.exists() ? s.data() : null;
  } catch (_) {}
}

// ── Open / close ────────────────────────────────────────────────────────
export async function openSundayNine() {
  ensureCss();
  build();
  const screen = document.getElementById('s9Screen');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');
  (document.getElementById('app-scroll') || document.body).style.overflowY = 'hidden';
  try {
    await loadData();
  } catch (_) {
    document.getElementById('s9Grid').innerHTML = '<p class="s9-msg">Couldn’t load today’s grid. Check your connection and try again.</p>';
    return;
  }
  const date = E.todayKey();
  if (E.dayDiff(E.SUNDAY_NINE_EPOCH, date) < 0) {
    await openPrelaunch(date);
    return;
  }
  showGame(true);
  S.preview = false;
  if (date !== S.date) {
    S.date = date;
    S.server = null; S.daily = null;
    const saved = loadLocal(date);
    S.grid = saved && saved.grid ? { date, rows: saved.grid.rows, cols: saved.grid.cols } : E.gridForDate(date, S.data.players, S.data.pinned);
    S.guesses = (saved && saved.guesses) || [];
    S.gaveUp = !!(saved && saved.gaveUp);
  }
  render();
  // A round started as a guest syncs once the player is signed in.
  if (uid() && S.guesses.length) queueSync(date);
  hydrateFromServer();
}

function showGame(on) {
  document.getElementById('s9Game').hidden = !on;
  document.getElementById('s9Pre').hidden = on;
  const share = document.getElementById('s9ShareTop');
  share.style.visibility = on ? '' : 'hidden';
  if (!on) share.disabled = true;
}

// Before grid #1 there is nothing to play: show the "tees off Sunday" state.
// The server decides whether this account may play grid #1 early (admin
// allowlist); a URL parameter can't unlock it.
async function openPrelaunch(date) {
  S.date = date;
  document.getElementById('s9Date').textContent = 'Starts ' + prettyDate(E.SUNDAY_NINE_EPOCH);
  document.getElementById('s9PreDate').textContent = 'Grid No. 1 drops ' + prettyDate(E.SUNDAY_NINE_EPOCH) + ' at midnight Central.';
  showGame(false);
  if (!uid() || !navigator.onLine) return;
  const saved = loadLocal(date);
  try {
    const { getFunctions, httpsCallable } = await import(FB + 'firebase-functions.js');
    const res = await httpsCallable(getFunctions(), 'syncSundayNine')({
      date, guesses: (saved && saved.guesses) || [], gaveUp: !!(saved && saved.gaveUp),
    });
    const d = res.data || {};
    if (!d.preview || !d.state) return;
    S.preview = true;
    S.grid = { date, rows: d.state.rows, cols: d.state.cols };
    S.guesses = d.state.guesses.slice();
    S.gaveUp = !!d.state.gaveUp;
    S.server = d.state;
    if (d.stats) S.stats = d.stats;
    saveLocal();
    showGame(true);
    render();
  } catch (_) { /* not an admin (or offline): the pre-launch state stands */ }
}

export function closeSundayNine() {
  closeGuess();
  const screen = document.getElementById('s9Screen');
  if (!screen) return;
  screen.classList.remove('open');
  screen.setAttribute('aria-hidden', 'true');
  (document.getElementById('app-scroll') || document.body).style.overflowY = '';
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('play') === 'sunday-nine') { u.searchParams.delete('play'); history.replaceState({}, '', u.pathname + u.search + u.hash); }
  } catch (_) {}
}

window.openSundayNine = openSundayNine;
window.closeSundayNine = closeSundayNine;
window.__actions = window.__actions || {};
const A = window.__actions;
A['open-sunday-nine'] = () => openSundayNine();
A['close-sunday-nine'] = () => closeSundayNine();
A['s9-close-guess'] = () => closeGuess();
A['s9-give-up'] = () => giveUp();
A['s9-share'] = () => share();
A['s9-sign-in'] = () => { if (window.requireAuth) window.requireAuth('to keep your Sunday Nine streak'); };

window.addEventListener('online', () => { drainQueue().catch(() => {}); });

// Midnight Central rollover while the screen is open: the pre-launch state
// becomes grid No. 1, a finished (or untouched) round becomes the new day's
// grid. A round in progress is left alone so it can be finished; it rolls
// over at the next check after it completes.
function maybeRollover() {
  const screen = document.getElementById('s9Screen');
  if (!screen || !screen.classList.contains('open') || !S.date || S.openCell != null) return;
  if (E.todayKey() === S.date) return;
  const prelaunch = !document.getElementById('s9Pre').hidden;
  if (!prelaunch && !S.preview && S.guesses.length && !result().complete) return;
  openSundayNine();
}
setInterval(maybeRollover, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeRollover(); });
window.addEventListener('focus', maybeRollover);

// ?play=sunday-nine deep link (teeboxmarket.com/sunday-nine lands here).
try {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get('play') === 'sunday-nine') {
    if (window.CURRENT_USER || window.GUEST_MODE) setTimeout(openSundayNine, 200);
    else window.__pendingDeepLink = 'sunday-nine';
  }
} catch (_) {}
