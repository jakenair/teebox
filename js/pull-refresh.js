/* r425: pull-to-refresh on the home feed + foreground refresh + "New listings" pill.
 *
 * Touch devices only (hover:none + pointer:coarse): desktop gets nothing.
 *
 * Gesture: only when #app-scroll is at the top, the touch starts inside the
 * home <main>, and home is what's on screen (no sheet/overlay over it). A
 * mostly-sideways drag (category pills, Passport row, photo rows) is ignored.
 * While pulling we own the gesture (preventDefault on a cancelable touchmove)
 * so we replace iOS's bounce for that one pull instead of fighting it. Only
 * <main> moves; the fixed top bar / category bar never do.
 *
 * Refresh = ONE Firestore query (window.loadListings: the same 200-newest feed
 * query and the same hidden/awaiting_payouts/sold/expired exclusions as page
 * load). Debounced: a refresh within MIN_GAP_MS of the last one doesn't hit
 * Firestore again. Listings created since the last load are pinned to the top
 * (they carry the existing "New" badge). For You is re-ranked with a fresh
 * seed via TBFeedRank.reseed() (the existing algorithm, new rotation). Never
 * invents listings. Category, filters and sort are left untouched.
 *
 * Foreground: back after > 5 min hidden = the same refresh, silently; only if
 * something is new do we show it (at the top: pinned + spinner flash; scrolled
 * down: the pill).
 *
 * Pill: one Firestore listener, limit(1) on the newest listing, attached only
 * while home is on screen and the app is visible; detached otherwise.
 */
(function () {
  'use strict';
  if (window.__tbPullRefresh) return;
  window.__tbPullRefresh = true;
  const touchUI = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (!touchUI) return;

  const THRESH = 64;          // visual pull distance (px) that arms a refresh
  const MAX_PULL = 120;       // rubber-band ceiling
  const HOLD = 56;            // where <main> rests while refreshing
  const MIN_GAP_MS = 8000;    // debounce: no second Firestore query inside this
  const FOREGROUND_MS = 5 * 60 * 1000;
  const CAUGHT_UP_MS = 2000;

  const scroller = () => document.getElementById('app-scroll');
  const mainEl = () => { const s = scroller(); return s && s.querySelector(':scope > main'); };
  const grid = () => document.getElementById('productGrid');

  let lastLoadAt = Date.now();
  let lastQueryAt = 0;
  let inFlight = null;
  window.addEventListener('teebox-listings-loaded', () => { lastLoadAt = Date.now(); });

  function haptic() {
    try {
      const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (H && H.impact) H.impact({ style: 'LIGHT' });
    } catch (_e) {}
  }

  // Home is "on screen" when the page is visible, the grid is rendered and the
  // middle of the viewport is home content (not a sheet, overlay or welcome).
  function homeOnScreen() {
    if (document.visibilityState !== 'visible') return false;
    const m = mainEl(), g = grid();
    if (!m || !g || g.offsetParent === null) return false;
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return !!(el && m.contains(el));
  }
  const atTop = () => { const s = scroller(); return !!s && s.scrollTop <= 0; };

  // ── UI bits ───────────────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
  .tb-ptr-spin { position: fixed; left: 50%; z-index: 40; width: 30px; height: 30px; margin-left: -15px;
    pointer-events: none; opacity: 0; color: var(--gold-500); }
  .tb-ptr-spin svg { width: 100%; height: 100%; display: block; }
  .tb-ptr-spin.is-spinning svg { animation: tbPtrSpin 0.8s linear infinite; }
  @keyframes tbPtrSpin { to { transform: rotate(360deg); } }
  .tb-ptr-note { position: fixed; left: 50%; z-index: 40; transform: translateX(-50%); pointer-events: none;
    font-family: var(--font-body); font-size: 12.5px; font-weight: 600; color: var(--gold-300);
    line-height: 20px; padding: 0 12px; opacity: 0; transition: opacity 180ms ease; white-space: nowrap; }
  .tb-ptr-note.is-on { opacity: 1; }
  .tb-new-pill { position: fixed; left: 50%; z-index: 41; transform: translate(-50%, -8px); opacity: 0; pointer-events: none;
    display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 50px; padding: 8px 16px;
    background: var(--green-900); color: var(--white); font-family: var(--font-body); font-size: 13px; font-weight: 700;
    box-shadow: var(--shadow-card); transition: opacity 180ms ease, transform 180ms ease; cursor: pointer; }
  .tb-new-pill.is-on { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
  .tb-new-pill svg { width: 14px; height: 14px; }
  @media (prefers-reduced-motion: reduce) { .tb-ptr-spin.is-spinning svg { animation-duration: 2s; } }
  `;
  document.head.appendChild(css);

  // Golf ball: brand gold ring + dimples. No emoji.
  const BALL = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
    '<circle cx="16" cy="16" r="13" fill="var(--white)" stroke="currentColor" stroke-width="2.5"/>' +
    '<g fill="currentColor"><circle cx="11" cy="11" r="1.6"/><circle cx="16.5" cy="9" r="1.6"/><circle cx="21.5" cy="12" r="1.6"/>' +
    '<circle cx="12" cy="17" r="1.6"/><circle cx="18" cy="15.5" r="1.6"/><circle cx="22" cy="19" r="1.6"/>' +
    '<circle cx="15" cy="22.5" r="1.6"/><circle cx="10" cy="22" r="1.2" opacity=".6"/></g></svg>';
  const spin = document.createElement('div');
  spin.className = 'tb-ptr-spin'; spin.innerHTML = BALL; spin.setAttribute('aria-hidden', 'true');
  const note = document.createElement('div');
  note.className = 'tb-ptr-note'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  const pill = document.createElement('button');
  pill.type = 'button'; pill.className = 'tb-new-pill'; pill.setAttribute('aria-hidden', 'true'); pill.tabIndex = -1;
  pill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg><span>New listings</span>';
  function mount() { [spin, note, pill].forEach((n) => { if (!n.isConnected) document.body.appendChild(n); }); }

  // Top edge of the home content (just under the fixed top bar + category bar).
  function contentTop() {
    let top = 0;
    document.querySelectorAll('.mobile-top-bar, #catBarWrap').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && cs.display !== 'none') top = Math.max(top, el.getBoundingClientRect().bottom);
    });
    return Math.round(top);
  }

  // The quiet line sits in the gap the pull opened (header green behind it):
  // <main> rests NOTE_GAP px down for CAUGHT_UP_MS, then settles. Any new
  // touch ends it early. Nothing is drawn over the feed itself.
  const NOTE_GAP = 40;
  function endNote() {
    clearTimeout(showNote._t); showNote._t = 0;
    if (note.classList.contains('is-on')) { note.classList.remove('is-on'); if (!busy && !g) settle(); }
  }
  function showNote(text) {
    mount();
    note.textContent = text;
    setPull(NOTE_GAP, true);
    spin.style.opacity = '0';
    note.style.top = (contentTop() + (NOTE_GAP - 20) / 2) + 'px';
    note.classList.add('is-on');
    clearTimeout(showNote._t);
    showNote._t = setTimeout(endNote, CAUGHT_UP_MS);
  }

  // ── Refresh ───────────────────────────────────────────────────────────
  // Returns {newCount, skipped}. One query (loadListings) unless debounced.
  async function refresh() {
    if (inFlight) return inFlight;
    if (Date.now() - lastQueryAt < MIN_GAP_MS) return { newCount: 0, skipped: true };
    inFlight = (async () => {
      lastQueryAt = Date.now();
      const since = lastLoadAt;
      const before = new Set((window.PRODUCTS || []).map((p) => String(p.id)));
      const f = window.__filter || {};
      if ((f.sort === 'foryou' || f.sort === 'discover') && window.TBFeedRank && window.TBFeedRank.reseed) {
        try { window.TBFeedRank.reseed(); } catch (_e) {}
      }
      if (typeof window.loadListings !== 'function') return { newCount: 0 };
      await window.loadListings();
      if (window.__listingsError) return { newCount: 0, error: true };
      const ms = (p) => (p.createdAt && p.createdAt.toMillis ? p.createdAt.toMillis()
        : (p.createdAt && p.createdAt.seconds ? p.createdAt.seconds * 1000 : 0));
      const fresh = (window.PRODUCTS || []).filter((p) => typeof p.id === 'string' && !before.has(String(p.id)) && ms(p) > since - 60000);
      window.__feedPinTop = new Set(fresh.map((p) => String(p.id)));
      if (fresh.length && typeof window.buildProducts === 'function') window.buildProducts();
      hidePill();
      return { newCount: fresh.length };
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  window.tbFeedRefresh = refresh;

  // ── Gesture ───────────────────────────────────────────────────────────
  let g = null; // {x0, y0, decided, pulling, d, armed}
  let busy = false;
  const rubber = (dy) => Math.min(MAX_PULL, dy <= 0 ? 0 : (dy < 2 * THRESH ? dy * 0.5 : THRESH + (dy - 2 * THRESH) * 0.2));

  function setPull(d, animate) {
    const m = mainEl(); if (!m) return;
    m.style.transition = animate ? 'transform 220ms cubic-bezier(.2,.8,.2,1)' : 'none';
    m.style.transform = d > 0 ? `translate3d(0, ${d}px, 0)` : '';
    mount();
    const p = Math.min(1, d / THRESH);
    spin.style.transition = animate ? 'opacity 220ms ease, top 220ms cubic-bezier(.2,.8,.2,1)' : 'none';
    spin.style.top = (contentTop() + Math.max(0, d / 2 - 15)) + 'px';
    spin.style.opacity = String(d > 4 ? Math.max(0.25, p) : 0);
    if (!spin.classList.contains('is-spinning')) spin.firstChild.style.transform = `rotate(${Math.round(d * 4)}deg)`;
  }
  function settle() {
    setPull(0, true);
    const m = mainEl();
    setTimeout(() => { if (m && !g && !note.classList.contains('is-on')) { m.style.transition = ''; m.style.transform = ''; } }, 240);
  }

  function onStart(e) {
    if (showNote._t) endNote();
    if (busy || e.touches.length !== 1) { g = null; return; }
    const m = mainEl();
    if (!m || !m.contains(e.target) || !atTop() || !homeOnScreen()) { g = null; return; }
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, decided: false, pulling: false, d: 0, armed: false };
  }
  function onMove(e) {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if (!g.decided) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      // Sideways (pill rows, Passport row, photo rows) or upward: not ours.
      if (Math.abs(dx) > Math.abs(dy) || dy <= 0 || !atTop()) { g = null; return; }
      g.decided = true; g.pulling = true;
    }
    if (!g.pulling) return;
    if (e.cancelable) e.preventDefault();
    g.d = rubber(dy);
    setPull(g.d, false);
    if (!g.armed && g.d >= THRESH) { g.armed = true; haptic(); }
    else if (g.armed && g.d < THRESH) g.armed = false;
  }
  async function onEnd() {
    if (!g) return;
    const was = g; g = null;
    if (!was.pulling) return;
    // A pull is never a tap: swallow the click the browser may synthesize.
    const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', eat, true);
    setTimeout(() => document.removeEventListener('click', eat, true), 400);
    if (!was.armed) { settle(); return; }
    busy = true;
    setPull(HOLD, true);
    spin.classList.add('is-spinning');
    const started = Date.now();
    let r = { newCount: 0 };
    try { r = await refresh(); } catch (_e) {}
    const wait = Math.max(0, 600 - (Date.now() - started)); // spinner never just flickers
    setTimeout(() => {
      spin.classList.remove('is-spinning');
      busy = false;
      if (r && !r.error && !r.newCount) showNote("You're all caught up"); else settle();
    }, wait);
  }

  function attachGesture() {
    const s = scroller();
    if (!s || s.__tbPtr) return;
    s.__tbPtr = true;
    s.addEventListener('touchstart', onStart, { passive: true });
    s.addEventListener('touchmove', onMove, { passive: false });
    s.addEventListener('touchend', onEnd, { passive: true });
    s.addEventListener('touchcancel', onEnd, { passive: true });
  }

  // ── Foreground refresh ────────────────────────────────────────────────
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); syncListener(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    syncListener();
    if (away <= FOREGROUND_MS || !homeOnScreen() || busy) return;
    const r = await refresh().catch(() => null);
    if (!r || !r.newCount) return; // nothing new: silent
    if (atTop()) {
      mount(); setPull(HOLD, true); spin.classList.add('is-spinning');
      setTimeout(() => { spin.classList.remove('is-spinning'); settle(); }, 700);
    } else {
      showPill();
    }
  });

  // ── "New listings" pill: one limit(1) listener while home is on screen ─
  let unsub = null, attaching = false, newestSeen = null;
  function showPill() {
    mount();
    pill.style.top = (contentTop() + 10) + 'px';
    pill.classList.add('is-on'); pill.setAttribute('aria-hidden', 'false'); pill.tabIndex = 0;
  }
  function hidePill() { pill.classList.remove('is-on'); pill.setAttribute('aria-hidden', 'true'); pill.tabIndex = -1; }
  pill.addEventListener('click', async () => {
    hidePill();
    const s = scroller();
    if (s) s.scrollTo({ top: 0, behavior: 'smooth' });
    lastQueryAt = 0; // the pill is a deliberate tap on a known-new listing
    const r = await refresh().catch(() => null);
    if (r && !r.error && !r.newCount) showNote("You're all caught up");
  });

  async function attachListener() {
    if (unsub || attaching) return;
    attaching = true;
    try {
      const { getFirestore, collection, query, orderBy, limit, onSnapshot } =
        await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
      if (unsub || !homeOnScreen()) return;
      const q = query(collection(getFirestore(), 'listings'), orderBy('createdAt', 'desc'), limit(1));
      unsub = onSnapshot(q, (snap) => {
        const d = snap.docs[0];
        if (!d || snap.metadata.hasPendingWrites) return;
        const id = d.id, x = d.data() || {};
        if (newestSeen === null) { newestSeen = id; return; } // baseline on attach
        if (id === newestSeen) return;
        newestSeen = id;
        const known = (window.PRODUCTS || []).some((p) => String(p.id) === id);
        const live = (x.status === 'active') && Array.isArray(x.photos) && x.photos.length > 0;
        const mine = window.CURRENT_USER && x.sellerId === window.CURRENT_USER.uid;
        if (!known && live && !mine && homeOnScreen() && !atTop()) showPill();
      }, () => { detachListener(); });
    } catch (_e) {
    } finally { attaching = false; }
  }
  function detachListener() {
    if (unsub) { try { unsub(); } catch (_e) {} }
    unsub = null; newestSeen = null;
  }
  function syncListener() {
    if (homeOnScreen()) attachListener(); else { detachListener(); hidePill(); }
  }
  window.__tbPtrListenerActive = () => !!unsub;
  window.__tbPtrTest = { showPill, hidePill }; // e2e hook (no reads)

  function boot() {
    attachGesture();
    // Home on/off screen changes come from overlays opening/closing and
    // navigation; a cheap DOM check (no reads) keeps the listener honest.
    setInterval(syncListener, 3000);
    window.addEventListener('teebox-listings-loaded', syncListener);
    syncListener();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
