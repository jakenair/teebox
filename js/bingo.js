// bingo.js — extracted from index.html (r349 cold-load, Stage C). ES module: Logo Bingo.
// Edit here; index.html only carries the <script src> tag. Served gzipped and cached by GitHub Pages.

  import { COURSES, courseLogoUrl } from '/bingo-courses.js';
  import { LOGOS_AVAILABLE } from '/assets/logos/manifest.js';
  // THE board algorithm — the one authored copy, shared verbatim with the
  // Cloud Function (via its generated CommonJS build) and the iOS bundle.
  // Never reimplement selection here; see bingo-select.mjs for why.
  import { selectBoard, hashStr } from '/bingo-select.mjs';

  // ── Date helpers ───────────────────────────────────────────────────────
  // Daily puzzle flips at midnight US Eastern so US users get a fresh
  // game at midnight their time (or close to it). Everyone in the world
  // sees the same date string at the same instant — leaderboards stay
  // coherent across timezones.
  // Auto-handles EST/EDT via Intl, no manual DST math.
  function todayUTC() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function prettyDate(yyyymmdd) {
    // "2026-04-29" → "April 29, 2026" (locale-agnostic month names)
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    const mo = ['January','February','March','April','May','June','July','August','September','October','November','December'][m - 1];
    return `${mo} ${d}, ${y}`;
  }
  function yesterday(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  // The PRNG and hash used to live here. They moved into bingo-select.mjs
  // on 2026-10-01 so the client, the server and the iOS bundle cannot drift.
  // hashStr is imported above — it is still used for the board fingerprint.
  // Pick the 9 courses for a date. OFFLINE FALLBACK ONLY — the canonical
  // board comes from /dailyPuzzles/{date} (see loadTodaysBingoPuzzle).
  //
  // The algorithm is NOT implemented here. It lives in bingo-select.mjs, the
  // single authored copy shared by this client, the iOS bundle and the Cloud
  // Function, so the three cannot drift. Before 2026-10-01 each had its own
  // copy and the iOS one silently fell a pool-change behind, computing a
  // board that shared 3 of 9 tiles with the server.
  //
  // pool is filtered to courses with a real PNG logo (LOGOS_AVAILABLE) —
  // Bingo is a *Logo* game, emoji fallbacks defeat the point. The server
  // filters the identical way when it builds the canon, so both sides pass
  // selectBoard the same pool.
  function dailySeed(dateStr) {
    const pool0 = COURSES.filter(c => LOGOS_AVAILABLE.has(c.id));
    return selectBoard(dateStr, pool0);
  }

  // ── Fuzzy match: normalize, then check `name`, `shortName`, `aliases` ──
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
      .replace(/[^a-z0-9 ]+/g, ' ')                         // drop punctuation
      .replace(/\bgolf club\b|\bgolf links\b|\bgolf course\b|\bcountry club\b|\bgc\b|\bcc\b|\bgl\b/g, '')
      .replace(/\bthe\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function courseTerms(course) {
    const out = new Set();
    out.add(norm(course.name));
    out.add(norm(course.shortName));
    (course.aliases || []).forEach(a => out.add(norm(a)));
    out.delete('');
    return [...out];
  }
  function matchesCourse(input, course) {
    const q = norm(input);
    if (!q) return false;
    return courseTerms(course).some(t => t === q);
  }
  // For autocomplete: prefix/substring match against any term
  function autocompleteMatches(input, pool) {
    const q = norm(input);
    if (!q) return [];
    const scored = [];
    for (const c of pool) {
      const terms = courseTerms(c);
      let best = -1;
      for (const t of terms) {
        if (t === q) { best = 3; break; }
        if (t.startsWith(q)) { best = Math.max(best, 2); }
        else if (t.includes(' ' + q) || t.includes(q)) { best = Math.max(best, 1); }
      }
      if (best > -1) scored.push({ c, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map(x => x.c);
  }

  // ── State ──────────────────────────────────────────────────────────────
  const STATE_KEY = (date) => `teebox.bingo.${date}`;
  const STREAK_KEY = 'teebox.bingo.streak';

  function loadGameState(date) {
    try {
      const raw = localStorage.getItem(STATE_KEY(date));
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return null;
      return s;
    } catch { return null; }
  }
  function saveGameState(date, state) {
    try { localStorage.setItem(STATE_KEY(date), JSON.stringify(state)); } catch {}
  }
  function loadStreak() {
    try {
      const raw = localStorage.getItem(STREAK_KEY);
      if (!raw) return { count: 0, lastPlayedDate: null };
      const s = JSON.parse(raw);
      return { count: Number(s.count) || 0, lastPlayedDate: s.lastPlayedDate || null };
    } catch { return { count: 0, lastPlayedDate: null }; }
  }
  // Reflect today's bingo state on the desktop nav CTA pill: shows
  // "Play Today" + pulsing dot when unplayed; "X/9 today" + steady gold
  // text when the puzzle has at least one resolved cell. Called on
  // every render() and on initial page load.
  window.updateNavBingoCta = function() {
    try {
      const cta = document.getElementById('navBingoCta');
      const sub = document.getElementById('navBingoSub');
      if (!cta || !sub) return;
      const state = loadGameState(TODAY);
      const resolved = state && Array.isArray(state.cells)
        ? state.cells.filter(c => c && c.state && c.state !== 'pending').length
        : 0;
      const correct = state && Array.isArray(state.cells)
        ? state.cells.filter(c => c && c.state === 'correct').length
        : 0;
      if (resolved > 0) {
        sub.textContent = `${correct}/9 Today`;
        cta.classList.add('played');
        cta.classList.remove('unplayed');
      } else {
        sub.textContent = 'Play Today';
        cta.classList.add('unplayed');
        cta.classList.remove('played');
      }
    } catch {}
  };

  function saveStreak(streak) {
    try { localStorage.setItem(STREAK_KEY, JSON.stringify(streak)); } catch {}
  }

  // ── Offline play: puzzle cache + sync queue ────────────────────────────
  // The bingo tab MUST work at the golf course with no signal. To get
  // there we:
  //   1. Cache the day's puzzle metadata (the 9 course IDs/names) in
  //      localStorage so the page can re-render the grid from cold even
  //      offline.
  //   2. Tell the service worker to pre-cache the 9 logo PNGs so the
  //      tiles aren't broken-image icons offline.
  //   3. Mirror every tap to localStorage via the existing persist().
  //   4. Queue a debounced sync to the syncBingoProgress callable. If
  //      we're offline, the queue drains on the next `online` event.
  // Items 1-3 already make the round playable; item 4 keeps the server's
  // gameScores / streak / leaderboard in agreement with the local copy.
  const PUZZLE_CACHE_KEY = (date) => `teebox.bingo.puzzle.${date}`;
  const SYNC_QUEUE_KEY = 'teebox.bingo.syncQueue';
  const ENSURE_READY_KEY = 'teebox.bingo.ensureReadyOn'; // last-run YYYY-MM-DD
  let __bingoSyncDebounceTimer = null;
  let __bingoSyncInFlight = false;
  let __bingoPuzzleStale = false;     // true if we fell back to yesterday's puzzle

  // Cache the puzzle metadata (course IDs, names, logo URLs) so we can
  // rebuild today's grid even with the network completely gone. The
  // course pool in bingo-courses.js ships with the bundle, but we still
  // cache the selection so a future server-driven daily list would slot
  // in the same way. (The earlier `generateDailyBingoPuzzle` Cloud
  // Function was deleted 2026-05-12 — see BINGO_CLEANUP.md.)
  // `source` is 'server' when courses came from the /dailyPuzzles/{date}
  // Firestore doc (canonical) and 'local' when they came from the
  // offline dailySeed() fallback. The cache reader only treats 'server'
  // entries as authoritative — a previously-cached 'local' entry will
  // be re-fetched on next open, so a transient offline session can't
  // pin a stale-bundle puzzle for the rest of the day.
  function cacheTodaysPuzzle(date, courses, source) {
    if (!Array.isArray(courses) || courses.length !== 9) return;
    try {
      const minimal = courses.map((c) => ({
        id: c.id,
        shortName: c.shortName,
        // Prefer the server-supplied logoUrl when present (handles
        // CDN-migration scenarios where the host changed). Falls back
        // to the local courseLogoUrl() helper otherwise.
        logoUrl: c.logoUrl || courseLogoUrl(c),
      }));
      localStorage.setItem(
        PUZZLE_CACHE_KEY(date),
        JSON.stringify({
          date,
          courses: minimal,
          source: source === 'server' ? 'server' : 'local',
          cachedAt: Date.now(),
        })
      );
    } catch {}
  }
  function readCachedPuzzle(date) {
    try {
      const raw = localStorage.getItem(PUZZLE_CACHE_KEY(date));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || obj.date !== date || !Array.isArray(obj.courses) || obj.courses.length !== 9) {
        return null;
      }
      return obj;
    } catch { return null; }
  }
  // Resolve a cached puzzle's minimal entries back to full COURSES rows so
  // the rest of the game (matchesCourse, etc.) still has aliases/location.
  function hydrateCachedPuzzleToCourses(cached) {
    if (!cached) return null;
    const out = [];
    for (const c of cached.courses) {
      const full = COURSES.find((x) => x.id === c.id);
      if (full) out.push(full);
      else out.push({
        id: c.id, name: c.shortName, shortName: c.shortName,
        aliases: [], location: '', architect: '', logo: '', logoUrl: c.logoUrl || '',
      });
    }
    return out;
  }

  // Fetch the canonical /dailyPuzzles/{date} doc the server-side
  // generateDailyBingoPuzzle scheduled function wrote at UTC midnight.
  // This is the SINGLE SOURCE OF TRUTH — both web and iOS WebView read
  // from here. The local dailySeed() is kept as an offline fallback only
  // (see loadTodaysBingoPuzzle).
  //
  // Returns null on any failure (network down, doc not yet written for
  // this date, etc.) — callers must handle the fallback. Doc shape:
  //
  //   { date: "2026-05-15", seed, courses: [{id, shortName, logoUrl}, x9],
  //     daysSinceEpoch, windowStart, poolSize, generatorVersion, generatedAt }
  //
  // The function and the local dailySeed() share the same canonical
  // algorithm + course pool (functions/data/bingo-puzzle-data.json is
  // regenerated from /bingo-courses.js + manifest.js on every deploy),
  // so under normal conditions the two paths produce identical courses;
  // they only diverge when an iOS bundle is stale, which is exactly
  // when we *want* the server doc to win.
  async function fetchServerDailyPuzzle(date) {
    try {
      const {getFirestore, doc, getDoc} = await import(
        'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js'
      );
      const db = getFirestore();
      const snap = await getDoc(doc(db, 'dailyPuzzles', date));
      if (!snap.exists()) return null;
      const d = snap.data();
      if (!d || !Array.isArray(d.courses) || d.courses.length !== 9) {
        return null;
      }
      return d;
    } catch (_err) {
      return null;
    }
  }

  // Hydrate a server-doc minimal course (id, shortName, logoUrl) into the
  // full COURSES metadata so matchesCourse() still has aliases/location.
  // Falls back to a stub when the id isn't in our local COURSES (e.g.
  // server added a new course but the client bundle hasn't shipped yet).
  function hydrateServerCoursesToFull(serverCourses) {
    return serverCourses.map((c) => {
      const full = COURSES.find((x) => x.id === c.id);
      if (full) {
        // Prefer the server's logoUrl so a stale client bundle still
        // renders against the canonical CDN URL. matchesCourse() reads
        // name/shortName/aliases off the full row.
        return {...full, logoUrl: c.logoUrl || full.logoUrl || ''};
      }
      // Course id unknown locally — render the best we can. The user
      // can still guess by shortName.
      return {
        id: c.id,
        name: c.shortName || c.id,
        shortName: c.shortName || c.id,
        aliases: [],
        location: '',
        architect: '',
        logo: '',
        logoUrl: c.logoUrl || '',
      };
    });
  }

  // ── Resilient logo loading (board tiles + guess modal) ──────────────
  // The old probe had no onerror: one failed fetch (cold HTTP cache + bad
  // signal — exactly the at-the-course case for a course added after the
  // installed app bundle shipped) left the tile blank AND the guess modal
  // empty for the whole session. Now: up to 3 attempts with short backoff,
  // one bonus attempt when connectivity returns, and a guessable initials
  // fallback in the meantime. A late success swaps the real logo in.
  // Scoring is untouched — matchesCourse() never reads the logo.
  const BINGO_LOGO_RETRY_MS = [1200, 3500];
  // r311: this used to print the course's INITIALS. The intent was a tile you
  // could still play without signal, but it did the opposite — "CW" against a
  // 167-course pool is most of the answer, and a player who never saw the logo
  // got the solve (and the streak) for free. A logo that cannot load is not a
  // playable tile; it is a tile that is not ready yet, and it should say so
  // rather than hand over the answer. The retry ladder below is unchanged, so
  // the real logo still swaps in the moment one lands.
  // `course` is intentionally unused — reading it is exactly the bug.
  function bingoLogoFallbackHtml(_course) {
    return '<span class="bingo-logo-fallback" role="img" aria-label="Logo still loading">?</span>';
  }
  function loadBingoLogoInto(el, course) {
    if (!el) return;
    // Candidate URLs in order: the puzzle's logoUrl (usually an absolute CDN
    // URL) first, then the BUNDLED local asset. Some CDN URLs fail in-app
    // (CSP/404) even though the app ships the PNG — falling back to the local
    // path fixes logos that used to render blank (e.g. Old Macdonald,
    // Pinehurst No. 2, The Alotian Club).
    const primary = courseLogoUrl(course);
    const local = (course && course.id) ? `/assets/logos/${course.id}.png` : '';
    const candidates = [];
    if (primary) candidates.push(primary);
    if (local && local !== primary) candidates.push(local);
    if (!candidates.length) return;
    let ci = 0, attempt = 0, usedOnlineRetry = false;
    const tryLoad = () => {
      if (!el.isConnected) return; // container re-rendered — abandon
      const url = candidates[ci];
      const probe = new Image();
      // STALL GUARD (r250): a hung request on flaky cellular fires NEITHER
      // onload nor onerror — the probe waited forever, the retry ladder
      // never started, and the tile showed neither logo nor initials
      // (blank until a tap re-rendered and re-probed on a fresh
      // connection). Treat >5s of silence as a failure: cancel the probe
      // and fall into the normal error/retry path.
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        try { probe.src = ''; } catch (_e) {}
        if (!el.isConnected) return;
        // Show the guessable fallback from the first miss on, but keep
        // trying (next candidate, then timed retries) and swap in a real
        // logo if one lands.
        if (!el.querySelector('img')) el.innerHTML = bingoLogoFallbackHtml(course);
        if (ci < candidates.length - 1) { ci += 1; tryLoad(); return; } // try bundled local
        if (attempt < BINGO_LOGO_RETRY_MS.length) {
          setTimeout(() => { ci = 0; tryLoad(); }, BINGO_LOGO_RETRY_MS[attempt]);
          attempt += 1;
        } else if (!usedOnlineRetry) {
          // Retries exhausted — one last shot when connectivity returns.
          usedOnlineRetry = true;
          window.addEventListener('online', () => { ci = 0; tryLoad(); }, {once: true});
        }
      };
      const stallTimer = setTimeout(fail, 5000);
      probe.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        if (el.isConnected) el.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
      };
      probe.onerror = () => { clearTimeout(stallTimer); fail(); };
      probe.src = url;
    };
    tryLoad();
  }

  // Pull today's puzzle. Order of preference:
  //   1. Cached server doc in localStorage (instant render, no flicker)
  //   2. Live fetch of /dailyPuzzles/{date} from Firestore (canonical)
  //   3. Local dailySeed() — offline fallback, marked stale so the
  //      monitor can detect and the banner can warn the user.
  //   4. Most recent cached puzzle (any date) — last-ditch offline.
  //
  // The "stale" flag distinguishes 3 + 4 from 1 + 2: when set, the
  // top-of-screen banner explains that we're showing yesterday's
  // puzzle / a local computation because the network is down, and the
  // monitor function logs the divergence.
  async function loadTodaysBingoPuzzle() {
    const date = todayUTC();

    // 1. Cached server doc — fast path. We tag the cache with `source`
    //    so a previously-cached client-computed puzzle doesn't masquerade
    //    as authoritative.
    const cached = readCachedPuzzle(date);
    if (cached && cached.source === 'server') {
      __bingoPuzzleStale = false;
      const hydrated = hydrateCachedPuzzleToCourses(cached);
      if (hydrated && hydrated.every(Boolean)) {
        // Best-effort refresh in the background — if the server doc
        // changed (e.g. canon update + regen) we want to converge fast.
        fetchServerDailyPuzzle(date).then((doc) => {
          if (doc) cacheTodaysPuzzle(date, doc.courses, 'server');
        }).catch(() => {});
        return hydrated;
      }
    }

    // 2. Live fetch — canonical path.
    const serverDoc = await fetchServerDailyPuzzle(date);
    if (serverDoc && Array.isArray(serverDoc.courses)) {
      cacheTodaysPuzzle(date, serverDoc.courses, 'server');
      __bingoPuzzleStale = false;
      return hydrateServerCoursesToFull(serverDoc.courses);
    }

    // 3. Local fallback — offline OR the server doc hasn't been written
    //    for this date yet. dailySeed() is deterministic and uses the
    //    same algorithm the function uses, so under nominal conditions
    //    its output equals the server's. But we still mark it stale so
    //    the founder can see in logs when a client is falling back.
    try {
      console.warn(
        '[bingo] server dailyPuzzles/' + date + ' unreachable — ' +
        'falling back to local dailySeed(). If this fires for online ' +
        'users, the cross-platform monitor will alert.'
      );
      const courses = dailySeed(date);
      cacheTodaysPuzzle(date, courses, 'local');
      __bingoPuzzleStale = true;
      return courses;
    } catch (err) {
      // 4. Truly degenerate — show the most recent cached puzzle, even
      //    if it's not for today. Better than a blank grid.
      const fallback = findMostRecentCachedPuzzle();
      if (fallback) {
        __bingoPuzzleStale = true;
        return hydrateCachedPuzzleToCourses(fallback);
      }
      throw err;
    }
  }
  function findMostRecentCachedPuzzle() {
    try {
      let best = null;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('teebox.bingo.puzzle.')) continue;
        const obj = JSON.parse(localStorage.getItem(k) || 'null');
        if (!obj || !obj.date) continue;
        if (!best || obj.date > best.date) best = obj;
      }
      return best;
    } catch { return null; }
  }

  // Send today's logo URLs to the service worker. The SW caches them in a
  // dedicated namespace so the user can still see the tiles offline. Skip
  // when there's no SW (private browsing, older Safari, native WebView
  // without registration yet) — the browser HTTP cache covers most cases.
  //
  // Native app: there is no SW (the app unregisters it at boot), so new
  // logos were cold-cache until the tile probe fetched them — one bad-signal
  // fetch meant a blank tile. warmBingoLogoCacheNative() is the app-side
  // twin of the SW pinning: fire-and-forget fetches that warm the WKWebView
  // HTTP cache. Strictly non-blocking (nothing awaits it) and each request
  // aborts after 8s so a dead network can't hold sockets open.
  function warmBingoLogoCacheNative(urls) {
    urls.forEach((u) => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        // no-cors: an opaque response still populates the HTTP cache, and
        // it mirrors how <img> fetches the same URL (no CORS dependency).
        fetch(u, {mode: 'no-cors', cache: 'default', signal: ctl.signal})
          .catch(() => {})
          .finally(() => clearTimeout(timer));
      } catch {}
    });
  }
  function precacheBingoLogos(courses) {
    try {
      const urls = courses
        .map((c) => courseLogoUrl(c))
        .filter((u) => typeof u === 'string' && u.length > 0);
      if (!urls.length) return;
      const Cap = window.Capacitor;
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
        warmBingoLogoCacheNative(urls);
        return;
      }
      if (!('serviceWorker' in navigator)) return;
      const ctrl = navigator.serviceWorker.controller;
      if (!ctrl) return;
      ctrl.postMessage({type: 'CACHE_BINGO_LOGOS', urls});
    } catch {}
  }

  // Called on app open (not just bingo-tab open) so by the time the user
  // navigates to bingo offline, the puzzle + logos are pinned. Throttled
  // to once per UTC day to avoid redundant work.
  async function ensureBingoOfflineReady() {
    try {
      const today = todayUTC();
      let last = null;
      try { last = localStorage.getItem(ENSURE_READY_KEY); } catch {}
      if (last === today) return;
      const courses = await loadTodaysBingoPuzzle();
      precacheBingoLogos(courses);
      try { localStorage.setItem(ENSURE_READY_KEY, today); } catch {}
    } catch (err) {
      // Best-effort — the synchronous dailySeed() path makes this
      // basically un-failable in practice.
      console.warn('[bingo] ensureBingoOfflineReady failed:', err);
    }
  }
  // Expose for the app-open hook below.
  window.ensureBingoOfflineReady = ensureBingoOfflineReady;

  // Sync queue helpers. Each entry is just a date string — the actual
  // payload is read fresh from localStorage at drain time so a tap
  // *after* enqueue is still included in the eventual sync.
  function readSyncQueue() {
    try {
      const raw = localStorage.getItem(SYNC_QUEUE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  }
  function writeSyncQueue(arr) {
    try { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(arr)); } catch {}
  }
  function enqueueBingoSync(date) {
    const q = readSyncQueue();
    if (!q.includes(date)) {
      q.push(date);
      writeSyncQueue(q);
    }
    updateBingoNetPill();
    scheduleBingoSync();
  }
  function scheduleBingoSync() {
    // Debounce: 10s after the last tap, or immediately on solve via
    // flushBingoSync().
    if (__bingoSyncDebounceTimer) clearTimeout(__bingoSyncDebounceTimer);
    __bingoSyncDebounceTimer = setTimeout(() => {
      __bingoSyncDebounceTimer = null;
      drainBingoSyncQueue().catch(() => {});
    }, 10000);
  }
  function flushBingoSync() {
    if (__bingoSyncDebounceTimer) {
      clearTimeout(__bingoSyncDebounceTimer);
      __bingoSyncDebounceTimer = null;
    }
    drainBingoSyncQueue().catch(() => {});
  }
  async function drainBingoSyncQueue() {
    if (__bingoSyncInFlight) return;
    if (!navigator.onLine) return;
    const u = window.CURRENT_USER;
    if (!u || !u.uid) return;             // anonymous: nothing to sync
    const q = readSyncQueue();
    if (!q.length) { updateBingoNetPill(); return; }
    __bingoSyncInFlight = true;
    let didSyncAny = false;
    try {
      const {getFunctions, httpsCallable} = await import(
        'https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js'
      );
      const fns = getFunctions();
      const sync = httpsCallable(fns, 'syncBingoProgress');
      // Copy the queue — we mutate the real one as we go.
      const dates = [...q];
      for (const date of dates) {
        const state = loadGameState(date);
        if (!state || !Array.isArray(state.cells) || state.cells.length !== 9) {
          // Nothing meaningful to send for this date — drop from queue.
          removeFromQueue(date);
          continue;
        }
        const totalAttempts = state.cells.reduce(
          (acc, c) => acc + (Number(c && c.attempts) || 0),
          0
        );
        const completed = state.cells.every(
          (c) => c && (c.state === 'correct' || c.state === 'revealed')
        );
        const correctCount = state.cells.filter(
          (c) => c && c.state === 'correct'
        ).length;
        const resolvedTimes = state.cells
          .map((c) => (c && Number.isFinite(c.resolvedAt) ? c.resolvedAt : null))
          .filter((x) => x !== null);
        const tapTimes = state.cells
          .map((c) => (c && Number.isFinite(c.tappedAt) ? c.tappedAt : null))
          .filter((x) => x !== null);
        const startedAt = tapTimes.length ? Math.min(...tapTimes) : null;
        const solvedAt = completed && resolvedTimes.length ? Math.max(...resolvedTimes) : null;
        try {
          await sync({
            date,
            cells: state.cells,
            solvedAt,
            attempts: totalAttempts,
            startedAt,
            clientWonAt: correctCount === 9 ? solvedAt : null,
            // Board provenance (recording only — server stores, does not
            // recompute): which board these cells were actually played on.
            puzzleSource: state.puzzleSource === 'server' ? 'server'
              : (state.puzzleSource === 'local' ? 'local' : null),
            courseIds: Array.isArray(state.courses)
              ? state.courses.map((c) => c && c.id).filter((x) => typeof x === 'string')
              : null,
            boardHash: typeof state.boardHash === 'string' ? state.boardHash : null,
          });
          removeFromQueue(date);
          didSyncAny = true;
        } catch (err) {
          // Network blip / rules failure / etc. Leave it queued; we'll
          // retry on the next online event or page load.
          console.warn('[bingo] sync failed for', date, err && err.code || err);
          // Don't keep hammering — break out and let the next trigger retry.
          break;
        }
      }
    } catch (err) {
      console.warn('[bingo] drainBingoSyncQueue init failed:', err);
    } finally {
      __bingoSyncInFlight = false;
      updateBingoNetPill();
      if (didSyncAny) {
        showSyncedToast();
        // Now that the server has the win, the onBingoWinAggregate
        // trigger will fire ~1s later. Wait briefly and retry the
        // results panel load — if the first call (from maybeFinish)
        // came back { pending: true } this picks up the real numbers.
        // Reset the loaded flag so this second attempt is allowed.
        if (typeof loadBingoResults === 'function'
            && document.getElementById('bingoResultsPanel')) {
          setTimeout(() => {
            __bingoResultsLoaded = false;
            loadBingoResults(TODAY);
          }, 1500);
        }
        // r317: refresh the board too. It was loaded ONCE when the bingo
        // screen opened and never again, so the player who had just finished
        // could not see their own score — the list still showed the state
        // from before they played. Same 1.5s wait: gameScores is written by
        // the fanout, not by the client, so an instant refresh would miss it.
        if (typeof loadLeaderboard === 'function'
            && document.getElementById('bingoLbList')) {
          setTimeout(() => loadLeaderboard(currentLbTab), 1600);
        }
      }
    }
  }
  function removeFromQueue(date) {
    const q = readSyncQueue().filter((d) => d !== date);
    writeSyncQueue(q);
  }
  function showSyncedToast() {
    // Brief "Synced" pill animation on the bingo header pill, only if
    // the bingo screen is open. Otherwise the next time the user opens
    // bingo they'll see no pending state, which is its own cue.
    const screen = document.getElementById('bingoScreen');
    if (!screen || !screen.classList.contains('open')) return;
    const pill = document.getElementById('bingoNetPill');
    if (!pill) return;
    pill.setAttribute('data-mode', 'synced');
    const lbl = pill.querySelector('.bingo-net-pill-text');
    if (lbl) lbl.textContent = 'Synced';
    setTimeout(updateBingoNetPill, 1800);
  }
  function updateBingoNetPill() {
    const pill = document.getElementById('bingoNetPill');
    if (!pill) return;
    const lbl = pill.querySelector('.bingo-net-pill-text');
    const queued = readSyncQueue().length;
    if (!navigator.onLine) {
      pill.setAttribute('data-mode', 'offline');
      if (lbl) lbl.textContent = queued ? 'Offline (pending sync)' : 'Offline';
    } else if (queued > 0) {
      pill.setAttribute('data-mode', 'pending');
      if (lbl) lbl.textContent = 'Pending sync';
    } else {
      pill.removeAttribute('data-mode');
    }
  }
  function updateBingoStaleBanner() {
    const banner = document.getElementById('bingoStaleBanner');
    if (!banner) return;
    banner.classList.toggle('show', !!__bingoPuzzleStale);
  }

  // Wire connection-change events. We don't gate the page on this — we
  // just nudge the UI + try to drain the queue once we come back.
  window.addEventListener('online',  () => {
    updateBingoNetPill();
    drainBingoSyncQueue().catch(() => {});
  });
  window.addEventListener('offline', () => {
    updateBingoNetPill();
  });

  // ── Game wiring ────────────────────────────────────────────────────────
  const TODAY = todayUTC();
  let game = {
    date: TODAY,
    courses: dailySeed(TODAY),
    // Which board game.courses came from: 'server' (dailyPuzzles doc, via
    // live fetch or cache) or 'local' (dailySeed fallback). Persisted with
    // the game and reported at sync so board provenance is queryable.
    puzzleSource: 'local',
    // For each cell index 0..8: { state: 'pending'|'correct'|'wrong'|'revealed', attempts: number, guess: string|null }
    cells: null,
    activeCell: -1,                  // index of the cell whose modal is open
  };
  function boardHashOf(courses) {
    try {
      return hashStr((courses || []).map((c) => c && c.id).join('|')).toString(36);
    } catch { return ''; }
  }
  // Restore the exact board the saved cells were played on (divergence fix:
  // a relaunch must NEVER swap unsolved tiles to a different board — the
  // saved snapshot wins over dailySeed()). Returns null for pre-fix saves
  // with no snapshot; callers then keep their current board, matching the
  // old behavior.
  function restoreSavedBoard(saved) {
    if (!saved || !Array.isArray(saved.courses) || saved.courses.length !== 9) return null;
    const hydrated = hydrateCachedPuzzleToCourses({ courses: saved.courses });
    return (hydrated && hydrated.length === 9 && hydrated.every(Boolean)) ? hydrated : null;
  }
  function defaultCellState() {
    return Array.from({ length: 9 }, () => ({
      state: 'pending', attempts: 0, guess: null,
      // Speed-scoring: when the tile's modal opened (tappedAt) and when it
      // resolved (resolvedAt). Used to compute per-tile point bonus.
      tappedAt: null, resolvedAt: null, points: 0,
    }));
  }

  function hydrate() {
    const saved = loadGameState(game.date);
    if (saved && Array.isArray(saved.cells) && saved.cells.length === 9) {
      game.cells = saved.cells;
      // Divergence fix: cells only make sense against the board they were
      // played on. Restore that board from the snapshot instead of keeping
      // the dailySeed() the module booted with — on a stale bundle those
      // differ, and the old behavior silently swapped every unsolved tile.
      const board = restoreSavedBoard(saved);
      if (board) {
        game.courses = board;
        game.puzzleSource = saved.puzzleSource === 'server' ? 'server' : 'local';
      }
    } else {
      game.cells = defaultCellState();
      persist({sync: false});
    }
  }
  function persist(opts) {
    // Keyed by game.date (not the module-load TODAY constant): a page that
    // lives across UTC midnight must save the game under the date it
    // belongs to, or a post-roll save corrupts yesterday's record.
    saveGameState(game.date, {
      cells: game.cells,
      finalScore: scoreCount(),
      completed: isComplete(),
      savedAt: Date.now(),
      // Board snapshot — see restoreSavedBoard(). Also reported at sync
      // (recording only; the server just stores it).
      courses: (game.courses || []).map((c) => ({
        id: c && c.id, shortName: (c && c.shortName) || '', logoUrl: (c && c.logoUrl) || '',
      })),
      puzzleSource: game.puzzleSource === 'server' ? 'server' : 'local',
      boardHash: boardHashOf(game.courses),
    });
    // Local-first: the tap UI does not await the server. We just enqueue
    // a debounced sync; drainBingoSyncQueue() handles offline-replay,
    // signed-out users, and rate-limiting. Board-snapshot-only saves pass
    // {sync:false} — nothing new for the server yet.
    if (!opts || opts.sync !== false) {
      try { enqueueBingoSync(game.date); } catch {}
    }
  }
  function scoreCount() {
    return game.cells.filter(c => c.state === 'correct').length;
  }
  // ── Point scoring ──────────────────────────────────────────────────────
  // Per-tile points = base (correct = 100, attempt-2 correct = 50) + speed
  // bonus on first-try correct only:
  //   tap→answer ≤ 5s  → +200
  //   ≤ 10s            → +100
  //   ≤ 15s            → +50
  //   else             → +20
  // Wrong-then-correct earns the base 50 only — speed bonuses reward decisive
  // first-try guesses, which is what makes the leaderboard interesting.
  function computeCellPoints(cell) {
    if (cell.state !== 'correct') return 0;
    const base = cell.attempts === 1 ? 100 : 50;
    if (cell.attempts !== 1 || !cell.tappedAt || !cell.resolvedAt) return base;
    const sec = Math.max(0, (cell.resolvedAt - cell.tappedAt) / 1000);
    let bonus = 20;
    if (sec <= 5) bonus = 200;
    else if (sec <= 10) bonus = 100;
    else if (sec <= 15) bonus = 50;
    return base + bonus;
  }
  function totalPoints() {
    return game.cells.reduce((sum, c) => sum + (c.points || 0), 0);
  }
  function totalElapsedSec() {
    let total = 0;
    for (const c of game.cells) {
      if (c.tappedAt && c.resolvedAt) total += (c.resolvedAt - c.tappedAt) / 1000;
    }
    return Math.round(total);
  }
  function formatDuration(sec) {
    if (!sec) return '—';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  }
  // ── Sell card gating (r308, reworked r345) ──────────────────────────────
  // r308 put a sell nudge INSIDE the result banner, once per 7 days. r345
  // moves it to the handoff block below the board (renderBingoHandoff), where
  // it is a persistent card next to the listings row, so the cooldown goes:
  // the rules that remain are
  //   1. signed-in only — a guest already gets the sign-in ask in the banner,
  //      and two stacked asks reads as nagging rather than an invitation;
  //   2. never to an existing seller — they get the progress card instead;
  //   3. "Not now" hides it for 30 days;
  //   4. localStorage only, wrapped in try/catch, because a private window or
  //      blocked site data throws on access and must never break the board.
  const SELL_NUDGE_KEY = 'tb_bingo_sell_nudge_v1';
  const SELL_NUDGE_DISMISS_DAYS = 30;
  function alreadySells() {
    try {
      const uid = window.CURRENT_USER && window.CURRENT_USER.uid;
      if (!uid) return false;
      // PRODUCTS may not be loaded inside the Bingo view. An empty list means
      // "unknown", not "no listings" — showing the nudge once to someone who
      // already sells is a far smaller cost than never showing it at all.
      return (window.PRODUCTS || []).some(p => p && p.sellerId === uid);
    } catch (_e) { return false; }
  }
  function shouldShowSellNudge() {
    try {
      if (!window.CURRENT_USER) return false;
      if (alreadySells()) return false;
      const raw = localStorage.getItem(SELL_NUDGE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        const days = (Date.now() - Number(o.at || 0)) / 86400000;
        if (o.dismissed && days < SELL_NUDGE_DISMISS_DAYS) return false;
      }
      return true;
    } catch (_e) { return false; }
  }
  function markSellNudgeSeen(dismissed) {
    try {
      localStorage.setItem(SELL_NUDGE_KEY,
        JSON.stringify({at: Date.now(), dismissed: !!dismissed}));
    } catch (_e) {}
  }
  // Mirrored for the action handlers, which live in a sibling <script>.
  window.__bingoSellNudge = {markSellNudgeSeen};

  // ── r345: Bingo → marketplace handoff ───────────────────────────────────
  // The solve is the most engaged moment of the day for ~90 people, and the
  // screen used to end at "come back tomorrow". This renders, below the
  // footer, a row of the freshest listings and a sell card. The row reads
  // window.PRODUCTS — the home feed, fetched at boot for everyone including
  // guests — so it costs no extra query; if the feed hasn't resolved yet we
  // render when it announces itself (teebox-listings-loaded, r157).
  const HANDOFF_PICKS = 8;
  function handoffPicks() {
    const uid = window.CURRENT_USER && window.CURRENT_USER.uid;
    const blocked = (uid && window.MY_BLOCKED_UIDS) || null;
    const ms = (p) => p.createdAt && p.createdAt.toDate ? p.createdAt.toDate().getTime() : 0;
    return (window.PRODUCTS || [])
      .filter(p => p && typeof p.id === 'string' && p.status !== 'sold'
        && Array.isArray(p.photos) && p.photos.length
        && !(uid && p.sellerId === uid)
        && !(blocked && blocked.has(p.sellerId)))
      .sort((a, b) => ms(b) - ms(a))
      .slice(0, HANDOFF_PICKS);
  }
  function handoffSellCard() {
    const uid = window.CURRENT_USER && window.CURRENT_USER.uid;
    if (!uid) return '';
    const min = window.FEATURED_MIN_LISTINGS || 5;
    const mine = window.featuredSellerStats ? window.featuredSellerStats().get(uid) : null;
    const count = mine ? mine.count : 0;
    if (count > 0) {
      const need = Math.max(0, min - count);
      const pct = Math.min(100, Math.round((count / min) * 100));
      return `
        <div class="bh-card">
          <div class="bh-sell">
            <div class="bh-sell-copy">
              <strong>${need > 0 ? `${need} more listing${need === 1 ? '' : 's'} and you&rsquo;re featured` : 'You&rsquo;re a Featured Seller'}</strong>
              ${need > 0 ? `${count} of ${min} live. Five puts your card on the home page.` : 'Your card is live on the TeeBox home page.'}
              <div class="bh-progress" aria-hidden="true"><i style="width:${pct}%"></i></div>
            </div>
            <div class="bh-sell-actions">
              <button type="button" class="bh-sell-cta" data-action="bingo-handoff-sell">List another</button>
            </div>
          </div>
        </div>`;
    }
    if (!shouldShowSellNudge()) return '';
    return `
      <div class="bh-card">
        <div class="bh-sell">
          <div class="bh-sell-copy">
            <strong>Sell your stuff</strong>
            Clubs, bags, shoes, polos &mdash; list five and you&rsquo;re a Featured Seller on the home page.
          </div>
          <div class="bh-sell-actions">
            <button type="button" class="bh-sell-cta" data-action="bingo-handoff-sell">Start selling</button>
            <button type="button" class="bh-sell-x" data-action="bingo-handoff-dismiss">Not now</button>
          </div>
        </div>
      </div>`;
  }
  let __handoffWaiting = false;
  function renderBingoHandoff() {
    const body = document.querySelector('.bingo-body');
    if (!body || !isComplete()) return;
    if (!window.__listingsLoaded) {
      if (!__handoffWaiting) {
        __handoffWaiting = true;
        window.addEventListener('teebox-listings-loaded', () => {
          __handoffWaiting = false;
          try { renderBingoHandoff(); } catch (_e) {}
        }, { once: true });
      }
      return;
    }
    let host = document.getElementById('bingoHandoff');
    if (!host) {
      host = document.createElement('div');
      host.id = 'bingoHandoff';
      host.className = 'bingo-handoff';
      const footer = body.querySelector('.bingo-footer');
      if (footer) footer.insertAdjacentElement('afterend', host); else body.appendChild(host);
    }
    const picks = handoffPicks();
    const picksHtml = picks.length ? `
      <div class="bh-card">
        <div class="bh-head">
          <div class="bh-title">Fresh on TeeBox</div>
          <button type="button" class="bh-link" data-action="bingo-handoff-browse">See all &rarr;</button>
        </div>
        <div class="bh-row">${picks.map(p => {
          const id = window.safeAttr(window.safeId(p.id));
          const url = window.variantImgUrl(p, 0, 'w400');
          const img = url
            ? `<img src="${window.safeAttr(url)}" alt="" loading="lazy" decoding="async" />`
            : (window.CATEGORY_ICON ? window.CATEGORY_ICON(p.cat) : '');
          return `<button type="button" class="bh-pick" data-action="bingo-pick-open" data-product-id="${id}">`+
            `<span class="bh-pick-img">${img}</span>`+
            `<span class="bh-pick-name">${window.safeText(p.name || p.title || '')}</span>`+
            `<span class="bh-pick-price">$${Number(p.ask || 0).toLocaleString()}</span>`+
          `</button>`;
        }).join('')}</div>
      </div>` : '';
    const sellHtml = handoffSellCard();
    if (!picksHtml && !sellHtml) { host.remove(); return; }
    host.innerHTML = picksHtml + sellHtml;
    try {
      if (!host.dataset.tracked) {
        host.dataset.tracked = '1';
        window.posthog && window.posthog.capture('bingo_handoff_shown', {
          picks: picks.length, sell_card: !!sellHtml, signed_in: !!window.CURRENT_USER,
        });
      }
    } catch (_e) {}
  }
  function removeBingoHandoff() {
    const h = document.getElementById('bingoHandoff');
    if (h) h.remove();
  }
  window.renderBingoHandoff = renderBingoHandoff;

  function isComplete() {
    return game.cells.every(c => c.state === 'correct' || c.state === 'revealed');
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function render() {
    const grid = document.getElementById('bingoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    game.courses.forEach((course, i) => {
      const cell = game.cells[i];
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'bingo-cell';
      div.dataset.idx = String(i);
      div.dataset.state = cell.state;
      div.setAttribute('aria-label', cell.state === 'pending'
        ? `Tile ${i + 1}, tap to guess`
        : cell.state === 'correct' ? `Solved: ${course.shortName}`
        : `Revealed: ${course.shortName}`);
      div.dataset.action = 'bingo-guess';
      let mark = '';
      if (cell.state === 'correct') mark = '<span class="bingo-cell-mark">✓</span>';
      else if (cell.state === 'revealed') mark = '<span class="bingo-cell-mark">✗</span>';
      const showName = cell.state === 'correct' || cell.state === 'revealed';
      const nameHtml = showName
        ? `<div class="bingo-cell-name">${window.safeText ? window.safeText(course.shortName) : course.shortName}</div>`
        : '';
      div.innerHTML = `
        <span class="bingo-cell-num">${i + 1}</span>
        ${mark}
        <div class="bingo-cell-logo" data-logo-id="${course.id}"></div>
        ${nameHtml}
      `;
      grid.appendChild(div);
    });

    grid.querySelectorAll('.bingo-cell-logo').forEach((el) => {
      const id = el.dataset.logoId;
      const course = game.courses.find(c => c.id === id);
      if (!course) return;
      loadBingoLogoInto(el, course);
    });

    // Stat row
    const score = scoreCount();
    const dateLbl = document.getElementById('bingoDateLbl');
    const scoreLbl = document.getElementById('bingoScoreLbl');
    const streakLbl = document.getElementById('bingoStreakLbl');
    const fill = document.getElementById('bingoProgressFill');
    if (dateLbl) dateLbl.textContent = prettyDate(TODAY);
    const pts = totalPoints();
    if (scoreLbl) scoreLbl.textContent = pts > 0 ? `${score}/9 · ${pts.toLocaleString()} pts` : `${score}/9`;
    if (fill) fill.style.width = `${Math.round((score / 9) * 100)}%`;
    if (streakLbl) {
      // Signed in → the server-derived streak (written inline by
      // syncBingoProgress) is authoritative. Guest/offline → local cache.
      let showStreak;
      if (window.CURRENT_USER && Number.isFinite(window.__serverBingoStreak)) {
        showStreak = window.__serverBingoStreak;
      } else {
        showStreak = loadStreak().count;
      }
      streakLbl.textContent = `${showStreak}d`;
    }
    updateNavBingoCta();

    // Footer
    const msg = document.getElementById('bingoFooterMsg');
    const shareBtn = document.getElementById('bingoShareBtn');
    const shareTop = document.getElementById('bingoShareTopBtn');
    const completed = isComplete();
    const anyResolved = game.cells.some(c => c.state !== 'pending');
    // Result banner: insert if completed and not already present (e.g. on
    // re-open of a puzzle finished earlier today). The animated insert from
    // maybeFinish() handles the live-completion path; this handles reload.
    const existingBanner = document.getElementById('bingoResultBanner');
    if (completed && !existingBanner) {
      const body = document.querySelector('.bingo-body');
      const gridEl = document.getElementById('bingoGrid');
      if (body && gridEl) {
        // Post-bump local count, never __serverBingoStreak: at live
        // completion the server value is exactly today's play behind (the
        // sync POST hasn't landed yet), so the banner would celebrate
        // yesterday's streak. The header pill above still prefers the
        // server value, which is correct for a persistent cross-device label.
        const bannerStreak = applyCompletionStreak().count;
        const banner = document.createElement('div');
        banner.id = 'bingoResultBanner';
        banner.className = 'bingo-result-banner';
        const elapsed = totalElapsedSec();
        // Honest non-gating nudge for guests — play is never blocked, but a
        // signed-out result isn't saved or ranked, so invite them to sign in.
        const guestNudge = !window.CURRENT_USER ? `
          <div style="margin-top:10px;font-size:13px;opacity:0.95">
            Playing as a guest — this result isn't saved.
            <button type="button" data-action="show-auth"
              style="margin-left:4px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.5);color:#fff;font-weight:600;font-size:13px;padding:4px 10px;border-radius:8px;cursor:pointer">
              Sign in</button>
            <span style="display:block;margin-top:2px;opacity:0.85">to save your streak going forward + join the leaderboard.</span>
          </div>` : '';
        banner.innerHTML = `
          <div style="font-weight:700;font-size:16px">You got ${score}/9 today!</div>
          <div style="margin-top:4px;font-size:14px;opacity:0.95">
            <strong>${pts.toLocaleString()}</strong> pts · ${formatDuration(elapsed)} · Streak ${bannerStreak}
          </div>
          ${guestNudge}
          <div><button type="button" class="bingo-stats-link" data-action="open-bingo-stats">View your stats &rarr;</button></div>
        `;
        body.insertBefore(banner, gridEl);
      }
      // r345: listings row + sell card under the footer.
      try { renderBingoHandoff(); } catch (_e) {}
      // Reload-of-completed path: kick off the results panel load.
      // loadBingoResults is idempotent and a no-op for anonymous users
      // / offline / already-loaded states.
      try {
        if (typeof loadBingoResults === 'function') loadBingoResults(TODAY);
      } catch (_e) {}
    } else if (!completed && existingBanner) {
      existingBanner.remove();
      const oldPanel = document.getElementById('bingoResultsPanel');
      if (oldPanel) oldPanel.remove();
      removeBingoHandoff();
    }
    if (completed) {
      if (msg) {
        msg.classList.add('done');
        msg.textContent = `${score}/9 — come back tomorrow for a new puzzle.`;
      }
      if (shareBtn) shareBtn.disabled = false;
      if (shareTop) shareTop.disabled = false;
    } else {
      if (msg) {
        msg.classList.remove('done');
        msg.textContent = anyResolved
          ? `Tap a tile to guess. ${score}/9 solved so far.`
          : 'Tap a tile to make your guess.';
      }
      // Allow sharing partial progress only after the puzzle is fully done,
      // so people don't share a half-finished grid by accident.
      if (shareBtn) shareBtn.disabled = !completed;
      if (shareTop) shareTop.disabled = !completed;
    }
  }

  // ── Open / close screen ────────────────────────────────────────────────
  // Normalize a server-stored cell into the client cell shape (same shape the
  // client sends; defensive defaults guard against partial/legacy data).
  function normalizeServerCell(sc) {
    const VALID = ['pending', 'correct', 'wrong', 'revealed'];
    return {
      state: VALID.includes(sc && sc.state) ? sc.state : 'pending',
      attempts: Number(sc && sc.attempts) || 0,
      guess: typeof (sc && sc.guess) === 'string' ? sc.guess : null,
      tappedAt: Number.isFinite(sc && sc.tappedAt) ? sc.tappedAt : null,
      resolvedAt: Number.isFinite(sc && sc.resolvedAt) ? sc.resolvedAt : null,
      points: Number(sc && sc.points) || 0,
    };
  }

  // Cross-platform read-back. When signed in, the SERVER doc
  // users/{uid}/bingoGames/{date} is the source of truth: restore cells, adopt
  // the server-derived streak, and (because resolved cells are non-tappable,
  // see openGuessModal) a solved board comes back LOCKED. Local storage stays a
  // cache/offline buffer. Offline / read error → no-op, retried on next open.
  async function reconcileServerGame(date) {
    const u = window.CURRENT_USER;
    if (!u || !u.uid) return;
    try {
      const { getFirestore, doc, getDoc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const db = getFirestore();
      const [gameSnap, userSnap] = await Promise.all([
        getDoc(doc(db, 'users/' + u.uid + '/bingoGames/' + date)),
        getDoc(doc(db, 'users/' + u.uid)),
      ]);
      // Authoritative streak — written inline by syncBingoProgress (not the
      // #34-flaky aggregate trigger). render() prefers this when signed in.
      if (userSnap.exists()) {
        const sd = userSnap.data() || {};
        if (Number.isFinite(Number(sd.bingoCurrentStreak))) {
          window.__serverBingoStreak = Number(sd.bingoCurrentStreak);
        }
      }
      if (date !== game.date) { render(); return; } // UTC day rolled mid-flight
      const persistLocal = () => saveGameState(date, {
        cells: game.cells, finalScore: scoreCount(),
        completed: isComplete(), savedAt: Date.now(),
      });
      if (!gameSnap.exists()) {
        // No server record yet. If a local solve never synced, queue it.
        if (isComplete()) { try { enqueueBingoSync(date); } catch (_e) {} }
        render();
        return;
      }
      const sdata = gameSnap.data() || {};
      const serverCells = (Array.isArray(sdata.cells) && sdata.cells.length === 9)
        ? sdata.cells.map(normalizeServerCell) : null;
      if (!serverCells) { render(); return; }
      if (Number.isFinite(sdata.solvedAt)) {
        // Server solved → source of truth. Restore (locks resolved tiles).
        game.cells = serverCells;
        persistLocal();
        render();
        return;
      }
      // Neither solved → cell-wise MAX-progress merge: a server-resolved cell
      // beats a local pending; a local-resolved cell is kept.
      const local = (game.cells && game.cells.length === 9)
        ? game.cells : defaultCellState();
      game.cells = local.map((lc, i) => {
        const sc = serverCells[i];
        const localResolved = lc && lc.state !== 'pending';
        const serverResolved = sc && sc.state !== 'pending';
        return (serverResolved && !localResolved) ? sc : lc;
      });
      persistLocal();
      render();
    } catch (e) {
      // Offline / read failure → keep playing from the local cache; the next
      // openBingo / online event / sign-in retries the reconcile.
      console.warn('[bingo] reconcileServerGame fell back to local:', e && e.message);
    }
  }

  function openBingo() {
    // Re-seed state if the UTC day rolled while the page was open
    const t = todayUTC();
    if (t !== game.date) {
      game.date = t;
      game.courses = dailySeed(t);
      game.puzzleSource = 'local';
      const saved = loadGameState(t);
      game.cells = (saved && Array.isArray(saved.cells) && saved.cells.length === 9)
        ? saved.cells : defaultCellState();
      // Divergence fix: if today already has a saved game, its board
      // snapshot wins over the dailySeed just computed (see hydrate()).
      const board = restoreSavedBoard(saved);
      if (board) {
        game.courses = board;
        game.puzzleSource = saved.puzzleSource === 'server' ? 'server' : 'local';
      }
    } else if (!game.cells) {
      hydrate();
    }
    const screen = document.getElementById('bingoScreen');
    if (screen) {
      screen.classList.add('open');
      screen.setAttribute('aria-hidden', 'false');
    }
    (document.getElementById('app-scroll')||document.body).style.overflowY = 'hidden';

    // Async: pull the canonical /dailyPuzzles/{date} doc and swap our
    // local-fallback courses for the server's whenever they disagree.
    // Initial render() (below) uses game.courses from dailySeed() so
    // the grid never blocks on the network — but as soon as the server
    // doc loads, we converge on the cross-platform-identical 9 logos.
    //
    // The swap is suppressed when the user has any progress on the
    // current (local) courses, to avoid stranding their resolved tiles
    // against the wrong logos. In practice this almost never happens:
    // the cross-platform monitor and the audit script catch upstream
    // drift before users have a chance to start a round on a stale
    // bundle. But the suppression is a safe-default.
    (async () => {
      try {
        const courses = await loadTodaysBingoPuzzle();
        if (!Array.isArray(courses) || courses.length !== 9) return;
        const localIds = (game.courses || []).map((c) => c && c.id).join(',');
        const newIds = courses.map((c) => c && c.id).join(',');
        const noProgress = !game.cells || game.cells.every(
          (c) => !c || c.state === 'pending');
        const adoptedSource = __bingoPuzzleStale ? 'local' : 'server';
        if (localIds !== newIds) {
          if (noProgress) {
            game.courses = courses;
            game.puzzleSource = adoptedSource;
            // Snapshot the adopted board immediately — a relaunch before
            // the first tap must restore THIS board, not re-seed locally.
            persist({sync: false});
            render();
          } else {
            // Mid-round divergence — leave the player on their current
            // grid but warn so divergence is observable in the logs.
            // Post-fix this should only fire when the SERVER doc itself
            // changed mid-round (canon regen), never from a relaunch.
            console.warn(
              '[bingo] server puzzle differs from local mid-round; ' +
              'keeping current grid. local=', localIds, 'server=', newIds);
          }
        } else if (game.courses !== courses) {
          // IDs match but object references differ — adopt the server
          // copies so any updated logoUrl (e.g. CDN migration) takes
          // effect on the next render.
          game.courses = courses;
          game.puzzleSource = adoptedSource;
          persist({sync: false});
        }
        precacheBingoLogos(courses);
        updateBingoStaleBanner();
      } catch {}
    })();
    updateBingoNetPill();
    updateBingoStaleBanner();
    // If we came back online while bingo was closed, drain any pending sync.
    drainBingoSyncQueue().catch(() => {});
    // Cross-platform read-back: when signed in, reconcile against the server
    // doc (source of truth) so a solve on another device comes back locked and
    // the streak is the server value. Non-blocking — grid is already rendered.
    reconcileServerGame(game.date).catch(() => {});

    render();
    loadLeaderboard(currentLbTab);

    // Reflect bottom-nav active state
    document.querySelectorAll('.bottom-nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === 'bingo');
    });
  }
  let currentLbTab = 'week';
  // r353 leaderboard redesign: podium for the top three, rows below, a
  // skeleton while loading. All text goes through safeText; names come from
  // the server projection (never a uid).
  function lbSkeletonHtml(n = 5) {
    return Array.from({length: n}, () =>
      '<div class="bingo-lb-skel" aria-hidden="true"><span class="sk-rank"></span><span class="sk-av"></span><span class="sk-name"></span><span class="sk-score"></span></div>'
    ).join('');
  }
  function lbInitials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'G';
    const a = parts[0][0] || '';
    const b = parts.length > 1 ? (parts[parts.length - 1][0] || '') : '';
    return (a + b).toUpperCase();
  }
  function lbTone(name) {
    let hsh = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) hsh = (hsh * 31 + s.charCodeAt(i)) >>> 0;
    return 1 + (hsh % 4);
  }
  function lbStreakText(streak) {
    const n = Number(streak) || 0;
    return n > 0 ? `${n}-day streak` : '';
  }
  function lbPodiumHtml(r) {
    const safe = window.safeText || ((s) => String(s || ''));
    const name = r.displayName || 'Golfer';
    const sub = r.isCaller ? ['You', lbStreakText(r.streak)].filter(Boolean).join(' · ') : lbStreakText(r.streak);
    return `<div class="bingo-lb-pod rank-${Number(r.rank) || 0}${r.isCaller ? ' you' : ''}">
      <div class="bingo-lb-avatar tone-${lbTone(name)}" aria-hidden="true">${safe(lbInitials(name))}</div>
      <div class="bingo-lb-pod-rank">${Number(r.rank) || ''}</div>
      <div class="bingo-lb-pod-name">${safe(name)}</div>
      <div class="bingo-lb-pod-score">${Number(r.correctCount) || 0}/9</div>
      ${sub ? `<div class="bingo-lb-pod-streak">${safe(sub)}</div>` : ''}
    </div>`;
  }
  function lbRowHtml(r) {
    const safe = window.safeText || ((s) => String(s || ''));
    const name = r.displayName || 'Golfer';
    const score = Number(r.correctCount) || 0;
    const sub = lbStreakText(r.streak);
    return `<div class="bingo-lb-row${r.isCaller ? ' you' : ''}">
      <div class="bingo-lb-rank${r.rank === 1 ? ' gold' : ''}">${Number(r.rank) || ''}</div>
      <div class="bingo-lb-avatar tone-${lbTone(name)}" aria-hidden="true">${safe(lbInitials(name))}</div>
      <div class="bingo-lb-who">
        <div class="bingo-lb-name"><span>${safe(name)}</span>${r.isCaller ? '<span class="bingo-lb-you">You</span>' : ''}</div>
        ${sub ? `<div class="bingo-lb-sub">${safe(sub)}</div>` : ''}
      </div>
      <div class="bingo-lb-score${score === 9 ? ' perfect' : ''}">${score}/9</div>
    </div>`;
  }
  async function loadLeaderboard(scope) {
    currentLbTab = scope || 'week';
    const list = document.getElementById('bingoLbList');
    if (!list) return;
    document.querySelectorAll('.bingo-lb-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === currentLbTab);
      t.setAttribute('aria-selected', t.dataset.tab === currentLbTab ? 'true' : 'false');
    });
    // r317: the heading was static markup, so it read "This week's top
    // players" even on the Today tab.
    const lbTitle = document.querySelector('.bingo-lb-title');
    if (lbTitle) {
      lbTitle.textContent = currentLbTab === 'today'
        ? "Today's top players"
        : "This week's top players";
    }
    list.innerHTML = lbSkeletonHtml();
    list.setAttribute('aria-busy', 'true');
    try {
      // r255 (audit 2026-09-01 A1-full): the board comes from the
      // getBingoLeaderboard PROJECTED callable — {rank, displayName,
      // correctCount, streak, isCaller} only, no uid. This replaces the
      // direct world-readable gameScores query AND the top-9 loadProfile
      // over-fetch (A2). The callable serves guests too (no auth
      // required), so signed-out visibility is unchanged; the "you"
      // highlight now rides the server-computed isCaller flag.
      const { getFunctions, httpsCallable } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
      const fn = httpsCallable(getFunctions(), 'getBingoLeaderboard');
      const res = await fn({ scope: currentLbTab });
      const rows = (res && res.data && res.data.rows) || [];
      if (!rows.length) {
        // r317: scope-aware. The old copy said "no completed scores yet" on
        // both tabs, which reads as "nobody has played today" even when the
        // week tab is simply empty — and vice versa.
        list.innerHTML = currentLbTab === 'today'
          ? '<div class="bingo-lb-empty">Nobody has finished today\u2019s board yet. Be the first.</div>'
          : '<div class="bingo-lb-empty">No finished boards this week yet.</div>';
        return;
      }
      // Podium for the top three (2-1-3 left to right) when there are at
      // least three finishers; otherwise plain rows so a two-player day
      // does not get an empty third plinth.
      const podium = rows.length >= 3
        ? `<div class="bingo-lb-podium">${[rows[1], rows[0], rows[2]].map(lbPodiumHtml).join('')}</div>`
        : '';
      const rest = rows.length >= 3 ? rows.slice(3) : rows;
      list.innerHTML = podium + rest.map(lbRowHtml).join('');
    } catch (err) {
      console.warn('leaderboard load failed', err);
      list.innerHTML = '<div class="bingo-lb-empty">Could not load leaderboard.</div>';
    } finally {
      list.setAttribute('aria-busy', 'false');
    }
  }
  window.loadLeaderboard = loadLeaderboard;
  function closeBingo() {
    const screen = document.getElementById('bingoScreen');
    if (screen) {
      screen.classList.remove('open');
      screen.setAttribute('aria-hidden', 'true');
    }
    (document.getElementById('app-scroll')||document.body).style.overflowY = '';
    closeGuessModal();
    // Restore home tab as active
    document.querySelectorAll('.bottom-nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === 'home');
    });
  }

  // ── Guess modal ────────────────────────────────────────────────────────
  function openGuessModal(idx) {
    const cell = game.cells[idx];
    const course = game.courses[idx];
    if (!cell || !course) return;
    if (cell.state === 'correct' || cell.state === 'revealed') return;  // locked
    game.activeCell = idx;
    // Stamp tappedAt on first open so first-try speed bonus is fair. Don't
    // re-stamp on retry — preserves the original click-to-answer window.
    if (!cell.tappedAt) cell.tappedAt = Date.now();
    const back = document.getElementById('bingoGuessBackdrop');
    const logo = document.getElementById('bingoGuessLogo');
    const input = document.getElementById('bingoGuessInput');
    const hint = document.getElementById('bingoGuessHint');
    const ac = document.getElementById('bingoAutocomplete');
    if (logo) {
      // Same resilient path as the board tile — if the tile is showing the
      // initials fallback, the modal shows the identical fallback (still
      // guessable); a late fetch success swaps the real logo in both.
      logo.innerHTML = '';
      loadBingoLogoInto(logo, course);
    }
    if (input) { input.value = ''; }
    if (hint) {
      hint.classList.remove('error');
      hint.textContent = 'One guess only. Make it count.';
    }
    if (ac) { ac.innerHTML = ''; ac.classList.remove('open'); }
    if (back) {
      back.classList.add('open');
      back.setAttribute('aria-hidden', 'false');
    }
    // Always-visible browse list for the empty input — lets users scroll
    // the full course library on open, even before typing.
    renderAutocomplete('');
    setTimeout(() => { if (input) input.focus(); }, 50);
  }
  function closeGuessModal() {
    const back = document.getElementById('bingoGuessBackdrop');
    // r344: blur BEFORE hiding. On iOS (WKWebView) the keyboard scrolls the
    // window to reveal the focused input even though body is overflow:hidden;
    // hiding the sheet with the input still focused drops the keyboard but
    // leaves that offset in place, so the next taps on the board hit-test
    // against the shifted viewport and seem to do nothing — Jake's 10-15
    // recording: 5-8 s of dead taps after every guess until the sheet
    // finally opened. Blur first, then put the window back where it was.
    try {
      const ae = document.activeElement;
      if (ae && ae !== document.body && back && back.contains(ae)) ae.blur();
    } catch (_e) {}
    if (back) {
      back.classList.remove('open');
      back.setAttribute('aria-hidden', 'true');
    }
    game.activeCell = -1;
    try {
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
      requestAnimationFrame(() => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); });
    } catch (_e) {}
  }

  function renderAutocomplete(query) {
    const ac = document.getElementById('bingoAutocomplete');
    if (!ac) return;
    const q = (query || '').trim();
    let pool, headerLabel, isBrowse = false;
    if (!q) {
      // Empty input → full browseable list of all courses, alphabetised by
      // shortName so users can scan/scroll the world Top 100.
      isBrowse = true;
      pool = [...COURSES].sort((a, b) => a.shortName.localeCompare(b.shortName));
      headerLabel = `Browse all ${COURSES.length} courses`;
    } else {
      // Filtered fuzzy matches — keep all (cap previously was 8 in
      // autocompleteMatches; we still respect that since the dropdown is
      // bounded by max-height + scroll).
      pool = autocompleteMatches(q, COURSES);
      headerLabel = `Matches for "${q}"`;
    }
    const safeQuery = window.safeText ? window.safeText(q) : q;
    if (!pool.length) {
      ac.innerHTML = `
        <div class="bingo-autocomplete-empty">
          No courses match "${safeQuery}". Try a partial name like "Augusta".
          <br/>
          <button type="button" data-bingo-skip="1">Skip: reveal answer</button>
        </div>`;
      ac.classList.add('open');
      const skipBtn = ac.querySelector('button[data-bingo-skip]');
      if (skipBtn) skipBtn.addEventListener('click', () => skipGuess());
      return;
    }
    const headerHtml = `<div class="bingo-autocomplete-header">${headerLabel}</div>`;
    const rowsHtml = pool.map(c => {
      const safeName = window.safeText ? window.safeText(c.shortName) : c.shortName;
      const safeLoc  = window.safeText ? window.safeText(c.location)  : c.location;
      return `<div class="bingo-autocomplete-row" data-pick="${window.safeAttr ? window.safeAttr(c.shortName) : c.shortName}">
        <div style="min-width:0;">
          <div class="bingo-autocomplete-name">${safeName}</div>
          <div class="bingo-autocomplete-meta">${safeLoc}</div>
        </div>
      </div>`;
    }).join('');
    ac.innerHTML = headerHtml + rowsHtml;
    ac.classList.add('open');
    // Reset scroll position on every fresh render of the filtered list (but
    // not the browse-all view — let the user keep their scroll position).
    if (!isBrowse) ac.scrollTop = 0;
    // Wire row clicks (not relying on data-action since this is dynamic)
    ac.querySelectorAll('.bingo-autocomplete-row').forEach(row => {
      row.addEventListener('click', () => {
        const pick = row.dataset.pick;
        const input = document.getElementById('bingoGuessInput');
        if (input) input.value = pick;
        ac.classList.remove('open');
        // Auto-submit on pick — feels right for a tap-driven autocomplete
        submitGuess();
      });
    });
  }
  // Keyboard navigation through autocomplete rows. Tracks the active row
  // via the .active class; Enter accepts.
  function moveAutocompleteSelection(delta) {
    const ac = document.getElementById('bingoAutocomplete');
    if (!ac || !ac.classList.contains('open')) return;
    const rows = Array.from(ac.querySelectorAll('.bingo-autocomplete-row'));
    if (!rows.length) return;
    const cur = rows.findIndex(r => r.classList.contains('active'));
    let next = cur + delta;
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
    rows.forEach(r => r.classList.remove('active'));
    rows[next].classList.add('active');
    rows[next].scrollIntoView({ block: 'nearest' });
  }

  function submitGuess() {
    const idx = game.activeCell;
    if (idx < 0) return;
    const cell = game.cells[idx];
    const course = game.courses[idx];
    const input = document.getElementById('bingoGuessInput');
    const hint = document.getElementById('bingoGuessHint');
    if (!cell || !course || !input) return;
    const raw = input.value.trim();
    if (!raw) {
      if (hint) { hint.classList.add('error'); hint.textContent = 'Type or pick a course name.'; }
      return;
    }
    const correct = matchesCourse(raw, course);
    cell.attempts += 1;
    cell.guess = raw.slice(0, 80);
    if (correct) {
      cell.state = 'correct';
      cell.resolvedAt = Date.now();
      cell.points = computeCellPoints(cell);
      persist();
      showCourseRevealCard(course, true, cell.points);
      closeGuessModal();
      render();
      bingoHaptic('correct');
      playCorrectFx(idx, course);
      maybeFinish();
      return;
    }
    // Wrong guess — single-shot mode. No retry. Tile resolves to revealed
    // immediately with the correct answer shown.
    cell.state = 'revealed';
    cell.resolvedAt = Date.now();
    cell.points = 0;
    persist();
    showCourseRevealCard(course, false, 0);
    closeGuessModal();
    render();
    bingoHaptic('wrong');
    playRevealFx(idx);
    maybeFinish();
  }
  function skipGuess() {
    // "Reveal" button — same as exhausting attempts
    const idx = game.activeCell;
    if (idx < 0) return;
    const cell = game.cells[idx];
    const course = game.courses[idx];
    if (!cell || !course) return;
    cell.state = 'revealed';
    cell.attempts = Math.max(cell.attempts, 2);
    cell.resolvedAt = Date.now();
    cell.points = 0;
    persist();
    showCourseRevealCard(course, false, 0);
    closeGuessModal();
    render();
    bingoHaptic('wrong');
    playRevealFx(idx);
    maybeFinish();
  }

  // ── Course reveal card ─────────────────────────────────────────────────
  // Animated banner that drops in after each tile resolves, showing the
  // course name, location, architect, and points earned. Green on correct,
  // red on revealed (wrong). Auto-dismisses after 2.5s.
  function showCourseRevealCard(course, correct, points) {
    if (!course) return;
    // Remove any previous card
    const old = document.getElementById('bingoRevealCard');
    if (old) old.remove();

    const card = document.createElement('div');
    card.id = 'bingoRevealCard';
    card.className = 'bingo-reveal-card ' + (correct ? 'is-correct' : 'is-wrong');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');

    const head = correct
      ? `<div class="bingo-reveal-head">✓ Correct &nbsp;·&nbsp; <span class="bingo-reveal-points">+${points} pts</span></div>`
      : `<div class="bingo-reveal-head">✗ Revealed</div>`;

    const safe = (s) => (window.safeText ? window.safeText(s) : String(s || ''));
    card.innerHTML = `
      ${head}
      <div class="bingo-reveal-name">${safe(course.shortName || course.name)}</div>
      <div class="bingo-reveal-meta">
        ${course.location ? `<span>${safe(course.location)}</span>` : ''}
        ${course.architect && course.architect !== '—' ? `<span>${safe(course.architect)}</span>` : ''}
      </div>
    `;

    document.body.appendChild(card);
    // Auto-dismiss
    setTimeout(() => card.classList.add('out'), 2200);
    setTimeout(() => card.remove(), 2700);
  }

  // ── Cell FX ────────────────────────────────────────────────────────────
  // CSS-only effects (transform/opacity) honoring prefers-reduced-motion.
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  }
  function getCellEl(idx) {
    return document.querySelector(`.bingo-cell[data-idx="${idx}"]`);
  }
  function playCorrectFx(idx, course) {
    const el = getCellEl(idx);
    if (!el) return;
    // ARIA announcement
    announceLive(`Correct! ${course && course.shortName ? course.shortName : ''}`);
    if (reducedMotion()) return;
    el.classList.remove('bingo-cell-flip', 'bingo-cell-correct-fx');
    void el.offsetWidth;
    el.classList.add('bingo-cell-flip', 'bingo-cell-correct-fx');
    // Inject checkmark + particle burst — they self-clean after animation
    const check = document.createElement('div');
    check.className = 'bingo-check';
    check.textContent = '✓';
    el.appendChild(check);
    const particles = document.createElement('div');
    particles.className = 'bingo-particles';
    particles.innerHTML = '<span></span><span></span><span></span><span></span><span></span>';
    el.appendChild(particles);
    setTimeout(() => { check.remove(); particles.remove(); }, 1100);
  }
  function playWrongFx(idx) {
    const el = getCellEl(idx);
    if (!el || reducedMotion()) return;
    el.classList.remove('bingo-cell-wrong-fx');
    void el.offsetWidth;
    el.classList.add('bingo-cell-wrong-fx');
    setTimeout(() => el.classList.remove('bingo-cell-wrong-fx'), 500);
  }
  function playRevealFx(idx) {
    const el = getCellEl(idx);
    if (!el) return;
    if (reducedMotion()) return;
    el.classList.remove('bingo-cell-flip', 'bingo-cell-reveal-fx');
    void el.offsetWidth;
    el.classList.add('bingo-cell-reveal-fx');
  }
  function announceLive(msg) {
    let live = document.getElementById('bingoLive');
    if (!live) {
      live = document.createElement('div');
      live.id = 'bingoLive';
      live.setAttribute('aria-live', 'polite');
      live.setAttribute('aria-atomic', 'true');
      live.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;';
      document.body.appendChild(live);
    }
    live.textContent = '';
    setTimeout(() => { live.textContent = msg; }, 30);
  }
  function celebrateCompletion() {
    if (reducedMotion()) return;
    // Cascade bounce, staggered top-left → bottom-right
    const cells = document.querySelectorAll('.bingo-grid .bingo-cell');
    cells.forEach((el, i) => {
      setTimeout(() => {
        el.classList.remove('bingo-cell-bounce');
        void el.offsetWidth;
        el.classList.add('bingo-cell-bounce');
        setTimeout(() => el.classList.remove('bingo-cell-bounce'), 250);
      }, i * 80);
    });
    // Confetti burst (r289: extracted to window.teeboxConfetti so a sale can
    // use the same celebration Bingo already had).
    window.teeboxConfetti();
  }

  // Streak: only counts if at least 1 correct AND user hadn't already
  // logged today. Gap > 1 day → reset to 1; gap == 1 day → +1; same day
  // is a no-op (replay is impossible because state is locked anyway).
  // Idempotent on purpose: submitGuess() calls render() before
  // maybeFinish(), and render() builds the completion banner, so the banner
  // path has to be able to apply the bump itself or it prints yesterday's
  // number (a first-ever finisher saw "Streak 0").
  function applyCompletionStreak() {
    const s = loadStreak();
    if (s.lastPlayedDate === TODAY) return s;
    const score = scoreCount();
    if (score > 0) {
      s.count = (s.lastPlayedDate === yesterday(TODAY)) ? (s.count || 0) + 1 : 1;
    } else {
      s.count = 0;
    }
    s.lastPlayedDate = TODAY;
    saveStreak(s);
    return s;
  }

  function maybeFinish() {
    if (!isComplete()) return;
    const score = scoreCount();
    const s = applyCompletionStreak();
    render();

    // Animated celebration: cascading cell bounce + confetti + banner.
    // Wait until the resolving cell's flip mostly settles before kicking off.
    setTimeout(() => {
      celebrateCompletion();
      const body = document.querySelector('.bingo-body');
      const grid = document.getElementById('bingoGrid');
      if (body && grid && !document.getElementById('bingoResultBanner')) {
        const banner = document.createElement('div');
        banner.id = 'bingoResultBanner';
        banner.className = 'bingo-result-banner';
        const pts = totalPoints();
        const elapsed = totalElapsedSec();
        const guestNudge = !window.CURRENT_USER ? `
          <div style="margin-top:10px;font-size:13px;opacity:0.95">
            Playing as a guest — this result isn't saved.
            <button type="button" data-action="show-auth"
              style="margin-left:4px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.5);color:#fff;font-weight:600;font-size:13px;padding:4px 10px;border-radius:8px;cursor:pointer">
              Sign in</button>
            <span style="display:block;margin-top:2px;opacity:0.85">to save your streak going forward + join the leaderboard.</span>
          </div>` : '';
        banner.innerHTML = `
          <div style="font-weight:700;font-size:16px">You got ${score}/9 today!</div>
          <div style="margin-top:4px;font-size:14px;opacity:0.95">
            <strong>${pts.toLocaleString()}</strong> pts · ${formatDuration(elapsed)} · Streak ${s.count}
          </div>
          ${guestNudge}
          <div><button type="button" class="bingo-stats-link" data-action="open-bingo-stats">View your stats &rarr;</button></div>
        `;
        body.insertBefore(banner, grid);
      }
      // r345: listings row + sell card under the footer.
      try { renderBingoHandoff(); } catch (_e) {}
      announceLive(`Puzzle complete. ${score} of 9 correct. Streak ${s.count}.`);
      // Spin up the percentile / friends / streak panel below the banner.
      // The server may not have aggregated this solve yet (race between
      // the sync POST and the onBingoWinAggregate trigger) — in that case
      // the callable returns { pending: true } and we'll show "calculating"
      // until drainBingoSyncQueue's success handler retries us.
      try {
        if (typeof loadBingoResults === 'function') loadBingoResults(TODAY);
      } catch (_e) {}
    }, 650);

    // Best-effort leaderboard write
    // A4 (audit 2026-09-01; r257): client no longer writes gameScores —
    // syncBingoProgress is the sole writer (server-computed streak, score
    // validated against the day's board). The create/update rules flip to
    // false in the same release; stale bundles' writes fail silently by
    // their own .catch design.
    // writeLeaderboardScore(score, s.count) — retired.
    // Flush the local sync queue immediately on solve — no need to wait
    // for the 10s debounce when the user just hit the most engagement-
    // worthy moment of the round. If we're offline this is a no-op and
    // the next `online` event will drain the queue.
    try { enqueueBingoSync(TODAY); flushBingoSync(); } catch {}
    try { maybeAskBingoReminder(TODAY); } catch (_e) {}
  }

  async function writeLeaderboardScore(correctCount, streak) {
    try {
      const u = window.CURRENT_USER;
      if (!u || !u.uid) return;        // anonymous; skip silently
      const [{ getFirestore, doc, setDoc, serverTimestamp }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js'),
      ]);
      const db = getFirestore();
      const totalAttempts = game.cells.reduce((acc, c) => acc + (c.attempts || 0), 0);
      await setDoc(doc(db, 'gameScores', `${TODAY}_${u.uid}`), {
        // Field name must be `userId` (not `uid`) to match
        // firestore.rules:915 — see LOGO_BINGO_LEADERBOARD_AUDIT_2026_05_17.md
        // finding B1. Mismatch was silently rejected on every solve.
        userId: u.uid,
        date: TODAY,
        // Canonical daily puzzle id — one board per UTC date (the server
        // /dailyPuzzles/{date} doc). Ties each score to the board it was
        // played against so a day's scores compare like-for-like.
        puzzleId: TODAY,
        correctCount,
        attempts: totalAttempts,
        streak,
        completedAt: serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      // Rules may reject (anonymous, gameScores collection not set up,
      // etc.) — failing silently is the contract.
      console.warn('[bingo] leaderboard write skipped:', e && e.code || e);
    }
  }

  // ── Share ──────────────────────────────────────────────────────────────
  // r313: @capacitor/haptics. A no-op everywhere the plugin isn't present —
  // web, a stale bundle, Android without it — so no call site needs its own
  // platform check. Styles are the plugin's string enums, which avoids
  // importing ImpactStyle/NotificationType just for two constants.
  function bingoHaptic(kind) {
    try {
      const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (!H) return;
      if (kind === 'correct') { if (H.impact) H.impact({ style: 'LIGHT' }); }
      else if (H.notification) H.notification({ type: 'ERROR' });
    } catch (_e) {}
  }

  // r313: the ONLY place the notification ask can begin. Gated on boards
  // COMPLETED, not elapsed time — the first finished board asks once; a
  // "Not now" waits three more finished boards and asks once more; after
  // that, never. The prompt is in-app; the iOS system sheet appears only if
  // the user taps "Remind me" (see maybeRegisterPushNative's request flag).
  const BINGO_ASK_KEY = 'tb_bingo_push_ask_v1';
  const BINGO_DONE_KEY = 'tb_bingo_boards_done_v1';
  function bingoBoardsCompleted() {
    try { return Number(localStorage.getItem(BINGO_DONE_KEY) || 0) || 0; } catch (_e) { return 0; }
  }
  function bumpBingoBoardsCompleted(date) {
    try {
      // Idempotent per board — re-entering a finished day must not re-count.
      const seen = BINGO_DONE_KEY + '.' + date;
      if (localStorage.getItem(seen)) return bingoBoardsCompleted();
      localStorage.setItem(seen, '1');
      const n = bingoBoardsCompleted() + 1;
      localStorage.setItem(BINGO_DONE_KEY, String(n));
      return n;
    } catch (_e) { return 0; }
  }
  function maybeAskBingoReminder(date) {
    try {
      const n = bumpBingoBoardsCompleted(date);   // counts for guests too
      if (!window.CURRENT_USER || !window.maybePromptForPush) return;
      let st = { asks: 0, at: 0 };
      try { st = JSON.parse(localStorage.getItem(BINGO_ASK_KEY) || 'null') || st; } catch (_e) {}
      if (st.asks >= 2) return;
      if (st.asks === 0 ? n < 1 : n < st.at + 3) return;
      try { localStorage.setItem(BINGO_ASK_KEY, JSON.stringify({ asks: st.asks + 1, at: n })); } catch (_e) {}
      // Let the result banner land before anything else appears.
      setTimeout(() => { try { window.maybePromptForPush('bingo-first-board'); } catch (_e) {} }, 1600);
    } catch (_e) {}
  }

  // r315 — lifetime stats sheet. Reads users/{uid}.bingoStats, the counters
  // onBingoWinAggregate maintains once per completed board (and that the
  // backfill script seeded from bingoGames for everyone who played before
  // the trigger existed). Current/best streak already live on the user doc.
  //
  // "Perfect" rather than "win %": every board resolves in single-shot mode,
  // so a solved-rate would read 100% and tell the player nothing.
  async function openBingoStats() {
    const back = document.getElementById('bingoStatsBackdrop');
    const body = document.getElementById('bingoStatsBody');
    if (!back || !body) return;
    body.innerHTML = '<div class="bingo-stats-empty">Loading&hellip;</div>';
    back.classList.add('open');
    const esc = (v) => (window.safeText ? window.safeText(String(v)) : String(v));
    const stat = (n, l) => `<div class="bingo-stat"><div class="bingo-stat-n">${esc(n)}</div><div class="bingo-stat-l">${esc(l)}</div></div>`;
    try {
      const u = window.CURRENT_USER;
      if (!u || !u.uid) {
        // Guests have no server record. The local board counter is the only
        // honest number we hold, so show that and say plainly why it is alone.
        let n = 0;
        try { n = Number(localStorage.getItem('tb_bingo_boards_done_v1') || 0) || 0; } catch (_e) {}
        body.innerHTML =
          `<div class="bingo-stats-grid">${stat(n, 'Played')}</div>` +
          '<div class="bingo-stats-empty">Sign in to keep the full record &mdash; perfect rounds, streaks and your score ' +
          'distribution, saved across devices.<br>' +
          '<button type="button" data-action="show-auth" class="bingo-stats-link" ' +
          'style="margin-top:10px;background:var(--green-700);border-color:var(--green-700)">Sign in</button></div>';
        return;
      }
      const { getFirestore, doc, getDoc } =
        await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
      const snap = await getDoc(doc(getFirestore(), 'users', u.uid));
      const d = (snap.exists() && snap.data()) || {};
      const st = d.bingoStats || {};
      const played = Number(st.played) || 0;
      const perfect = Number(st.perfect) || 0;
      const cur = Number(d.bingoCurrentStreak) || 0;
      const best = Number(d.bingoBestStreak) || 0;
      if (!played) {
        body.innerHTML = '<div class="bingo-stats-empty">No completed boards yet. Finish today&rsquo;s nine and your record starts here.</div>';
        return;
      }
      const dist = st.distribution || {};
      let max = 0;
      for (let i = 0; i <= 9; i++) max = Math.max(max, Number(dist[String(i)]) || 0);
      const todayScore = (typeof scoreCount === 'function') ? scoreCount() : -1;
      const todayDone = (game && game.cells || []).every((c) => c && c.state !== 'pending');
      let rows = '';
      for (let i = 9; i >= 0; i--) {
        const n = Number(dist[String(i)]) || 0;
        const pct = max ? Math.max(6, Math.round(n * 100 / max)) : 6;
        const isToday = todayDone && i === todayScore;
        rows += `<div class="bingo-dist-row${isToday ? ' is-today' : ''}">` +
          `<span class="bingo-dist-k">${i}/9</span>` +
          `<span class="bingo-dist-bar" style="width:${pct}%">${n}</span></div>`;
      }
      body.innerHTML =
        '<div class="bingo-stats-grid">' +
          stat(played, 'Played') +
          stat(Math.round(perfect * 100 / played) + '%', 'Perfect') +
          stat(cur, 'Streak') +
          stat(best, 'Best') +
        '</div>' +
        '<div class="bingo-dist-h">Score distribution</div>' + rows;
    } catch (err) {
      console.warn('bingo stats failed', err);
      body.innerHTML = '<div class="bingo-stats-empty">Couldn&rsquo;t load your stats just now. Try again in a moment.</div>';
    }
  }
  window.openBingoStats = openBingoStats;

  // r313: boards are numbered from the first ever puzzle, 2026-05-15 (the
  // earliest /dailyPuzzles doc in production). Wordle-style numbering gives
  // the share a running identity and makes two people's cards comparable.
  const BINGO_FIRST_BOARD = '2026-05-15';
  function bingoBoardNumber(dateStr) {
    const d = Date.UTC(...dateStr.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)));
    const e = Date.UTC(...BINGO_FIRST_BOARD.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)));
    return Math.max(1, Math.floor((d - e) / 86400000) + 1);
  }
  function buildShareText() {
    const score = scoreCount();
    const rows = [];
    for (let r = 0; r < 3; r++) {
      let row = '';
      for (let c = 0; c < 3; c++) {
        const cell = game.cells[r * 3 + c];
        row += cell.state === 'correct' ? '🟩' : '🟥';
      }
      rows.push(row);
    }
    const streak = loadStreak();
    const pts = totalPoints();
    const elapsed = totalElapsedSec();
    // Stat line packs the most engagement-relevant info: score, points, time,
    // streak. Then a one-line link for the recipient. Format is intentionally
    // recognizable so it stands out in iMessage / Twitter.
    const lines = [
      `TeeBox Logo Bingo #${bingoBoardNumber(TODAY)} · ${TODAY}`,
      '',
      ...rows,
      '',
      `Score: ${score}/9 · ${pts.toLocaleString()} pts`,
    ];
    if (elapsed) lines.push(`Time: ${formatDuration(elapsed)}`);
    if (streak.count > 0) lines.push(`Streak: ${streak.count}d`);
    lines.push('');
    // /bingo.html is a static stub with bingo-specific OG/Twitter tags so the
    // iMessage / Twitter / Slack preview shows the Logo Bingo card. The stub
    // immediately redirects humans to /?play=bingo (see bingo.html).
    // UTM so PostHog can measure the share loop (bingo.html forwards params
    // through its redirect).
    lines.push('Play: https://teeboxmarket.com/bingo.html?utm_source=ig_story&utm_medium=share&utm_campaign=bingo');
    return lines.join('\n');
  }
  // Layered share helper — generic on purpose: the listing-share feature
  // (r15x queue) calls this same function. Returns 'shared-file' |
  // 'shared-text' | 'downloaded' | 'copied' | 'cancelled' | 'failed'.
  // Order: Web Share w/ image file (iOS Safari 15+, Android Chrome, and —
  // pending the TestFlight device test — Capacitor's WKWebView) → native
  // Capacitor sheet (text-only; the Share plugin needs a file:// URL and
  // Filesystem isn't bundled) → Web Share text + PNG download → clipboard
  // + PNG download. A user-cancelled sheet (AbortError) STOPS the chain —
  // cancel means cancel, not "try a worse method".
  window.shareOrFallback = async function(opts) {
    const { title, text, file, downloadName } = opts || {};
    const dl = () => {
      if (!file) return false;
      try {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url; a.download = downloadName || file.name || 'teebox.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return true;
      } catch { return false; }
    };
    const url = opts && opts.url;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title, text }); return 'shared-file'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    // r156: URL share (listing links). Native sheet first; the clipboard
    // rung below copies text+url together.
    if (url && !file && navigator.share) {
      try { await navigator.share({ title, text, url }); return 'shared-text'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    try {
      const Cap = window.Capacitor;
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
        const Share = Cap.Plugins && Cap.Plugins.Share;
        if (Share && typeof Share.share === 'function') {
          await Share.share(url ? { title, text, url, dialogTitle: title } : { title, text, dialogTitle: title });
          return 'shared-text';
        }
      }
    } catch (e) { /* fall through */ }
    if (navigator.share) {
      try {
        await navigator.share({ title, text });
        return dl() ? 'downloaded' : 'shared-text';
      } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    const downloaded = dl();
    try {
      await navigator.clipboard.writeText(url ? ((text ? text + '\n' : '') + url) : (text || ''));
      return downloaded ? 'downloaded' : 'copied';
    } catch {}
    try { window.prompt('Copy your result:', text); } catch {}
    return downloaded ? 'downloaded' : 'failed';
  };
  async function shareResult() {
    if (!isComplete()) {
      if (window.showToast) window.showToast('Finish all 9 tiles first.');
      return;
    }
    const title = `Logo Bingo · ${TODAY}`;
    const text = buildShareText();
    // Render the branded story image; on any failure fall back to text-only
    // (the render is a bonus, never a blocker).
    let file = null;
    try {
      const img = await renderStoryImage();
      if (img && img.blob) {
        file = new File([img.blob], `teebox-logo-bingo-${TODAY}.png`, { type: 'image/png' });
      }
    } catch (e) {
      console.warn('[bingo] story image render failed, sharing text only:', e);
    }
    const out = await window.shareOrFallback({ title, text, file, downloadName: `teebox-logo-bingo-${TODAY}.png` });
    if (out === 'downloaded') {
      if (window.showToast) window.showToast('Result copied & story image saved — add it to your Instagram Story.');
    } else if (out === 'copied') {
      if (window.showToast) window.showToast('Copied result to clipboard.');
    } else if (out === 'failed') {
      if (window.showToast) window.showToast('Could not share — try a screenshot.');
    }
    // 'shared-file' / 'shared-text' / 'cancelled': the sheet spoke for itself.
  }

  // ── IG Story share image ────────────────────────────────────────────────
  // Renders the day's result as a branded 1080x1920 PNG entirely client-side.
  // r164: shows the day's REAL logos (names hidden) — the board is the same
  // /dailyPuzzles doc for every player, so logos-without-names leak zero
  // answers and turn the story into "here's today's puzzle, beat me."
  // Result state rides a ring + corner badge (green check / gold dash /
  // hollow dot), never the tile fill, so the logos stay legible. Trademark
  // posture ruled by Jake 2026-07-17: same marks the game already shows,
  // editorial/UGC-flavored; any club that objects gets its logo swapped for
  // a neutral tile. If a logo fails to load, that tile falls back to the
  // pre-r164 flat colored tile — the share never blocks on a fetch.
  // No PII: score/points/streak/date only. Safe zones: IG overlays the
  // profile chip (~top 250px) and reply bar (~bottom 250px) — all content
  // stays inside y 250..1670.
  const STORY = {
    W: 1080, H: 1920,
    green: '#133624', gold: '#E3BB45', cream: '#F3ECDB',   // brand — exact carousel values
    bgTop: '#17452D', bgBot: '#0B1F14',
    tileGreen: '#2E9E5B', tileDark: '#0C2015', red: '#C74A36',
    tileBorder: 'rgba(243,236,219,0.14)',
  };
  // Tile semantics (single-shot game): correct = green; revealed with
  // attempts===1 = guessed-and-missed (gold); revealed with attempts>=2 =
  // skipped via the Reveal button (dark). skipGuess stamps attempts>=2.
  function storyTileFor(cell) {
    if (cell && cell.state === 'correct') return 'green';
    if (cell && cell.state === 'revealed' && Number(cell.attempts) === 1) return 'gold';
    return 'dark';
  }
  async function ensureStoryFonts() {
    try {
      await Promise.all([
        document.fonts.load('900 128px "Playfair Display"'),
        document.fonts.load('800 150px "Playfair Display"'),
        document.fonts.load('600 30px "DM Sans"'),
        document.fonts.load('700 34px "DM Sans"'),
      ]);
      await document.fonts.ready;
    } catch (_e) {}
    // Verify, don't assume — a fallback-font render looks cheap. Callers may
    // still proceed (system serif) but the flag is surfaced for QA.
    return document.fonts.check('900 128px "Playfair Display"') &&
           document.fonts.check('600 30px "DM Sans"');
  }
  function storyRoundRect(x, rx, ry, w, h, r) {
    x.beginPath();
    x.moveTo(rx + r, ry);
    x.arcTo(rx + w, ry, rx + w, ry + h, r);
    x.arcTo(rx + w, ry + h, rx, ry + h, r);
    x.arcTo(rx, ry + h, rx, ry, r);
    x.arcTo(rx, ry, rx + w, ry, r);
    x.closePath();
  }
  // r164: knock near-white logo backgrounds to transparent so hard-white
  // PNGs sit clean on the warm-white tile. Render-time only — the shared
  // /assets/logos sources stay untouched, and future days' white-background
  // logos get the same cleanup for free. A tainted canvas (no CORS) keeps
  // the opaque original rather than failing.
  function storyKnockoutWhite(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    try {
      const d = g.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 246 && px[i + 1] > 246 && px[i + 2] > 246) px[i + 3] = 0;
      }
      g.putImageData(d, 0, 0);
    } catch (_e) {}
    return c;
  }
  // ── Logo loading for the story card ────────────────────────────────────
  // r312: the old loader raced ONE attempt against a 4s timeout, and only
  // teeboxmarket.com URLs had a second candidate. Combined with the dead SW
  // pre-cache (see sw.js) every logo was a cold Storage fetch — 9 in
  // parallel — and the slowest simply lost. That is how an 8/9 board shipped
  // with 7 logos and two flat squares.
  // Now: two candidates for EVERY course (the puzzle's absolute URL, then
  // the copy bundled at /assets/logos/{id}.png, which exists both on web and
  // inside the app), two attempts each with backoff, a longer budget, and
  // decode() before the bitmap is allowed anywhere near drawImage.
  const __storyLogoCache = new Map();
  const STORY_LOAD_TIMEOUT = 8000;
  function storyLoadLogoOnce(src) {
    return new Promise((res) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; res(v); } };
      const im = new Image();
      im.crossOrigin = 'anonymous';
      const t = setTimeout(() => done(null), STORY_LOAD_TIMEOUT);
      im.onload = async () => {
        // onload can fire on iOS while the bitmap is still undecodable;
        // drawImage then paints NOTHING and reports no error. decode()
        // turns that silent failure into a value we can branch on.
        try { if (im.decode) await im.decode(); } catch (_e) {}
        clearTimeout(t);
        done((im.naturalWidth > 0 && im.naturalHeight > 0) ? im : null);
      };
      im.onerror = () => { clearTimeout(t); done(null); };
      im.src = src;
    });
  }
  async function storyLoadLogo(url, course) {
    const key = url || (course && course.id) || '';
    if (!key) return null;
    if (__storyLogoCache.has(key)) return __storyLogoCache.get(key);
    const cands = [];
    if (url) {
      // Inside Capacitor the origin is capacitor://localhost, so a
      // teeboxmarket.com absolute is cross-origin — try it as a same-origin
      // relative path first, which the app bundle also satisfies.
      const m = url.match(/^https:\/\/(?:www\.)?teeboxmarket\.com(\/.+)$/);
      if (m) cands.push(m[1]);
      cands.push(url);
    }
    if (course && course.id) {
      const local = '/assets/logos/' + course.id + '.png';
      if (cands.indexOf(local) === -1) cands.push(local);
    }
    for (const src of cands) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 400));
        const im = await storyLoadLogoOnce(src);
        if (im) {
          const c = storyKnockoutWhite(im);
          __storyLogoCache.set(key, c);
          return c;
        }
      }
    }
    return null;  // deliberately NOT cached — a later share should retry
  }
  // The app icon for the card header. No white-knockout: it is our own art
  // on a dark ground, and the knockout would eat the gold ball's highlight.
  function storyLoadAppIcon() { return storyLoadLogoOnce('/icon-512.png'); }
  // Montserrat is not in the app's font load (Playfair + DM Sans only), so
  // it is fetched ON DEMAND at render time and falls back to DM Sans. No
  // cost on any normal page load for a face only the canvas uses.
  async function ensureStoryMontserrat() {
    try {
      if (document.fonts.check('500 34px Montserrat')) return true;
      if (!document.getElementById('story-montserrat')) {
        const l = document.createElement('link');
        l.id = 'story-montserrat';
        l.rel = 'stylesheet';
        l.href = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap';
        document.head.appendChild(l);
      }
      await Promise.race([
        Promise.all([
          document.fonts.load('500 36px Montserrat'),
          document.fonts.load('600 36px Montserrat'),
        ]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
      return document.fonts.check('500 34px Montserrat');
    } catch (_e) { return false; }
  }
  async function renderStoryImage(overrides) {
    const o = overrides || {};
    const cells = o.cells || game.cells || [];
    const score = (o.score != null) ? o.score : scoreCount();
    const pts = (o.points != null) ? o.points : totalPoints();
    const streakCount = (o.streak != null) ? o.streak : ((loadStreak() || {}).count || 0);
    // "Monday, October 5" — plain sentence case, no year, no upper-casing.
    const dateLabel = o.dateLabel || new Date(TODAY + 'T12:00:00Z')
      .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const fontsOk = await ensureStoryFonts();
    const monoOk = await ensureStoryMontserrat();
    const serif = fontsOk ? '"Playfair Display", Georgia, serif' : 'Georgia, serif';
    const sans = monoOk ? 'Montserrat, "DM Sans", system-ui, sans-serif'
               : (fontsOk ? '"DM Sans", system-ui, sans-serif' : 'system-ui, sans-serif');
    const courses = o.courses || game.courses || [];
    // QA hook: indices whose logo load is skipped, so the fallback tile can
    // be reviewed without having to break the network.
    const forceFail = Array.isArray(o.forceFail) ? o.forceFail : [];
    const [logos, appIcon] = await Promise.all([
      Promise.all(Array.from({ length: 9 }, (_, i) => {
        if (forceFail.indexOf(i) !== -1) return Promise.resolve(null);
        const c = courses[i];
        return storyLoadLogo(c && (c.logoUrl || courseLogoUrl(c)), c);
      })),
      storyLoadAppIcon(),
    ]);

    const cv = document.createElement('canvas');
    cv.width = STORY.W; cv.height = STORY.H;
    const x = cv.getContext('2d');

    // Background: brand green vertical gradient + the gold radial glow.
    const g = x.createLinearGradient(0, 0, 0, STORY.H);
    g.addColorStop(0, STORY.bgTop); g.addColorStop(0.55, STORY.green); g.addColorStop(1, STORY.bgBot);
    x.fillStyle = g; x.fillRect(0, 0, STORY.W, STORY.H);
    const rg = x.createRadialGradient(540, 760, 40, 540, 760, 820);
    rg.addColorStop(0, 'rgba(227,187,69,0.11)'); rg.addColorStop(1, 'rgba(227,187,69,0)');
    x.fillStyle = rg; x.fillRect(0, 0, STORY.W, STORY.H);

    // ── Measured vertical stack ──────────────────────────────────────────
    // Every block's height is MEASURED and every gap is explicit. Nothing is
    // placed at a hand-tuned y, which is exactly what let the date collide
    // with "Logo Bingo"'s descenders and the stats line collide with "8/9".
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    const F = {
      word:  '900 62px ' + serif,
      title: '900 118px ' + serif,
      date:  '500 34px ' + sans,
      score: '800 150px ' + serif,
      stat:  '500 36px ' + sans,
      foot:  '500 28px ' + sans,
      foot2: '600 26px ' + sans,
    };
    const ink = (font, text) => {
      x.font = font;
      const m = x.measureText(text);
      const asc = m.actualBoundingBoxAscent || 0;
      const desc = m.actualBoundingBoxDescent || 0;
      return { asc, desc, w: m.width, h: asc + desc };
    };
    const statsText = (() => {
      // r313: the perfect round rides the SAME cream line rather than its own
      // callout — one line, no extra block to balance.
      const bits = [];
      if (score === 9) bits.push('Perfect round');
      bits.push(Number(pts).toLocaleString() + ' pts');
      if (streakCount > 0) bits.push(streakCount + '-day streak');
      return bits.join('  ·  ');
    })();
    const FOOT1 = 'Play daily at teeboxmarket.com';
    const FOOT2 = '@teeboxmarketplace';
    const scoreText = score + '/9';

    const ICON = 96;
    const T = 200, GAP = 22;
    const GRID_H = 3 * T + 2 * GAP;

    const m = {
      word: ink(F.word, 'TeeBox'),
      title: ink(F.title, 'Logo Bingo'),
      date: ink(F.date, dateLabel),
      score: ink(F.score, scoreText),
      stats: ink(F.stat, statsText),
      foot1: ink(F.foot, FOOT1),
      foot2: ink(F.foot2, FOOT2),
    };
    // Gaps are the compressible part of the stack; block heights are not.
    let gaps = [20, 32, 24, 54, 60, 26, 52, 12];
    const blocks = [ICON, m.word.h, m.title.h, m.date.h, GRID_H, m.score.h, m.stats.h, m.foot1.h, m.foot2.h];
    const blockSum = blocks.reduce((a, b) => a + b, 0);
    const SAFE_TOP = 250, SAFE_BOT = 1670, BAND = SAFE_BOT - SAFE_TOP;
    const gapSum = gaps.reduce((a, b) => a + b, 0);
    if (blockSum + gapSum > BAND) {
      // Squeeze the gaps proportionally rather than letting the stack run
      // into the story UI. Floors at 0.55 so it can never collapse to mush.
      const k = Math.max(0.55, (BAND - blockSum) / gapSum);
      gaps = gaps.map((v) => Math.round(v * k));
    }
    const total = blockSum + gaps.reduce((a, b) => a + b, 0);
    let y = SAFE_TOP + Math.max(0, (BAND - total) / 2);

    // App icon.
    if (appIcon) {
      x.save();
      storyRoundRect(x, 540 - ICON / 2, y, ICON, ICON, 22);
      x.clip();
      x.drawImage(appIcon, 540 - ICON / 2, y, ICON, ICON);
      x.restore();
    }
    y += ICON + gaps[0];

    // "TeeBox" wordmark — Tee cream, Box gold, centred as one unit.
    x.font = F.word;
    const wTee = x.measureText('Tee').width, wBox = x.measureText('Box').width;
    const wStart = 540 - (wTee + wBox) / 2;
    x.textAlign = 'left';
    x.fillStyle = STORY.cream; x.fillText('Tee', wStart, y + m.word.asc);
    x.fillStyle = STORY.gold;  x.fillText('Box', wStart + wTee, y + m.word.asc);
    x.textAlign = 'center';
    y += m.word.h + gaps[1];

    // Title, then the date placed off the title's MEASURED bottom.
    x.font = F.title; x.fillStyle = STORY.cream;
    x.fillText('Logo Bingo', 540, y + m.title.asc);
    y += m.title.h + gaps[2];
    x.font = F.date; x.fillStyle = 'rgba(243,236,219,0.62)';
    x.fillText(dateLabel, 540, y + m.date.asc);
    y += m.date.h + gaps[3];

    // ── 3x3 grid ─────────────────────────────────────────────────────────
    const X0 = (STORY.W - (3 * T + 2 * GAP)) / 2, Y0 = y;
    const tiles = [];
    for (let i = 0; i < 9; i++) {
      const got = cells[i] && cells[i].state === 'correct';
      tiles.push(got ? 'green' : 'missed');
      const tx = X0 + (i % 3) * (T + GAP), ty = Y0 + Math.floor(i / 3) * (T + GAP);
      const logo = logos[i];
      // The tile itself is always drawn — there is no such thing as a blank
      // cell any more, with or without artwork.
      x.save();
      x.shadowColor = 'rgba(0,0,0,0.28)'; x.shadowBlur = 18; x.shadowOffsetY = 6;
      const tg = x.createLinearGradient(tx, ty, tx + T, ty + T);
      tg.addColorStop(0, '#ffffff'); tg.addColorStop(1, '#fbf7ee');
      x.fillStyle = tg;
      storyRoundRect(x, tx, ty, T, T, 26); x.fill();
      x.restore();

      if (logo) {
        const box = T - 50;
        const s = Math.min(box / logo.width, box / logo.height);
        const dw = logo.width * s, dh = logo.height * s;
        x.save();
        // Missed tiles keep the artwork but drop back, so the eye reads the
        // row of greens first without the board turning into holes.
        if (!got) x.globalAlpha = 0.5;  // r313: 0.4 lost pale line-art logos entirely
        x.drawImage(logo, tx + (T - dw) / 2, ty + (T - dh) / 2, dw, dh);
        x.restore();
      } else {
        // Artwork genuinely unavailable after the full candidate ladder.
        // Neutral mark, never the course's identity — see the note in the
        // r312 commit about why this is not initials.
        x.save();
        x.globalAlpha = got ? 0.55 : 0.3;
        x.strokeStyle = '#9aa79c'; x.lineWidth = 4;
        x.setLineDash([10, 9]);
        x.beginPath(); x.arc(tx + T / 2, ty + T / 2, T * 0.26, 0, Math.PI * 2); x.stroke();
        x.setLineDash([]);
        x.fillStyle = '#6f7d72';
        x.font = '700 64px ' + sans;
        x.textBaseline = 'middle';
        x.fillText('?', tx + T / 2, ty + T / 2 + 2);
        x.textBaseline = 'alphabetic';
        x.restore();
      }

      // Result ring.
      x.strokeStyle = got ? STORY.tileGreen : 'rgba(199,74,54,0.55)';
      x.lineWidth = got ? 5 : 3;
      storyRoundRect(x, tx + 2.5, ty + 2.5, T - 5, T - 5, 24); x.stroke();

      // Corner badge: green check, or small red cross.
      const dx = tx + T - 26, dy = ty + 26;
      x.fillStyle = got ? STORY.tileGreen : STORY.red;
      x.beginPath(); x.arc(dx, dy, got ? 16 : 14, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#ffffff'; x.lineWidth = 3.5;
      x.lineCap = 'round';
      if (got) {
        x.beginPath(); x.moveTo(dx - 7, dy + 0.5); x.lineTo(dx - 2, dy + 5.5); x.lineTo(dx + 7.5, dy - 5.5); x.stroke();
      } else {
        x.beginPath(); x.moveTo(dx - 5, dy - 5); x.lineTo(dx + 5, dy + 5); x.stroke();
        x.beginPath(); x.moveTo(dx + 5, dy - 5); x.lineTo(dx - 5, dy + 5); x.stroke();
      }
      x.lineCap = 'butt';
    }
    y = Y0 + GRID_H + gaps[4];

    // Score, then the stats line off the score's MEASURED bottom.
    x.font = F.score; x.fillStyle = STORY.cream;
    x.fillText(scoreText, 540, y + m.score.asc);
    y += m.score.h + gaps[5];
    x.font = F.stat; x.fillStyle = 'rgba(243,236,219,0.88)';
    x.fillText(statsText, 540, y + m.stats.asc);
    y += m.stats.h + gaps[6];

    // Footer.
    x.font = F.foot; x.fillStyle = 'rgba(243,236,219,0.80)';
    x.fillText(FOOT1, 540, y + m.foot1.asc);
    y += m.foot1.h + gaps[7];
    x.font = F.foot2; x.fillStyle = 'rgba(227,187,69,0.90)';
    x.fillText(FOOT2, 540, y + m.foot2.asc);

    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    return { blob, dataUrl: cv.toDataURL('image/png'), tiles, fontsOk, monoOk,
             missing: logos.reduce((n, l, i) => l ? n : n.concat(i), []) };
  }
  // Exposed for the QA harness now and the share wiring once approved.
  window.__bingoRenderShareImage = renderStoryImage;

  // ── Wire actions ───────────────────────────────────────────────────────
  // The global delegated click handler reads from window.__actions, so we
  // just register entries — no extra listeners needed for the cells.
  window.__actions = window.__actions || {};
  const A = window.__actions;
  A['open-bingo']           = () => openBingo();
  A['open-bingo-stats']     = () => { openBingoStats(); };
  // Expose for the deep-link / guest-mode hand-off in the auth flow.
  window.openBingo = openBingo;
  // Exposed so the onAuthStateChanged sign-in branch can reconcile guest play
  // onto the now-known account (drain local solves → read the server doc back).
  window.drainBingoSyncQueue = drainBingoSyncQueue;
  window.reconcileServerGame = reconcileServerGame;
  window.bingoTodayUTC = todayUTC;

  // Kick the offline-readiness pass on app open so the puzzle + 9 logos are
  // pinned locally before the user navigates to bingo. Idle-callback first
  // so we don't fight with the marketplace's initial render; setTimeout
  // fallback for Safari which historically delayed requestIdleCallback.
  const __kickReady = () => { ensureBingoOfflineReady().catch(() => {}); };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(__kickReady, {timeout: 4000});
  } else {
    setTimeout(__kickReady, 1500);
  }
  // Also drain any queued syncs on load if we're already online. This
  // covers the case where the user solved the puzzle offline yesterday
  // and is reopening the app today on wifi.
  if (navigator.onLine) {
    setTimeout(() => drainBingoSyncQueue().catch(() => {}), 2000);
  }
  // Handle ?play=bingo deep-link from shared messages. If the user is signed
  // in (or already in guest mode), open Bingo immediately. Otherwise stash the
  // intent and the auth-screen guest button will pick it up.
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('play') === 'bingo') {
      if (window.CURRENT_USER || window.GUEST_MODE) {
        setTimeout(openBingo, 200);
      } else {
        window.__pendingDeepLink = 'bingo';
      }
    }
    // r345: ?sell=1 from the seller-invite email. Signed-in → straight into
    // handleSellClick (it owns the Stripe-onboarding gate); otherwise stash
    // it like the others and replay after sign-in.
    if (sp.get('sell') === '1') {
      if (window.CURRENT_USER) {
        setTimeout(() => { try { window.handleSellClick && window.handleSellClick(); } catch (_) {} }, 400);
      } else {
        window.__pendingDeepLink = 'sell';
      }
    }
    // r348: ?payouts=setup — every list-first nudge (listing-live email,
    // "someone wants your item", "listings paused") lands here. Signed-in →
    // mint a FRESH Stripe account link and go; guests sign in first and the
    // replay below does the same. Strip the param so a refresh doesn't loop.
    if (sp.get('payouts') === 'setup') {
      try { const u = new URL(window.location.href); u.searchParams.delete('payouts'); window.history.replaceState({}, '', u.pathname + u.search + u.hash); } catch (_) {}
      if (window.CURRENT_USER) {
        setTimeout(() => { try { window.__actions && window.__actions['stripe-connect'] && window.__actions['stripe-connect'](); } catch (_) {} }, 400);
      } else {
        window.__pendingDeepLink = 'payouts';
      }
    }
    // ?prefs=email deep-link from the unsubscribe-success page footer.
    // Requires sign-in (guests can't have email prefs), so stash on the
    // auth screen and replay after sign-in if CURRENT_USER is null.
    if (sp.get('prefs') === 'email') {
      if (window.CURRENT_USER) {
        setTimeout(() => { try { window.openEmailPrefs && window.openEmailPrefs(); } catch (_) {} }, 200);
      } else {
        window.__pendingDeepLink = 'email-prefs';
      }
    }
  } catch {}
  A['bingo-lb-tab']         = (el) => loadLeaderboard(el.dataset.tab);
  A['apply-suggest-price']  = (el) => {
    const p = Number(el.dataset.price || 0);
    const inp = document.getElementById('sellPrice');
    if (inp && p > 0) inp.value = String(p);
  };
  A['qty-step'] = (el) => {
    const dir = Number(el.dataset.dir || 0);
    const inp = document.getElementById('detailQty');
    if (!inp) return;
    const max = Number(inp.max || 1);
    const cur = Number(inp.value || 1);
    inp.value = String(Math.min(max, Math.max(1, cur + dir)));
  };
  A['close-bingo']          = () => closeBingo();
  A['bingo-guess']          = (el) => {
    const idx = Number(el && el.dataset && el.dataset.idx);
    if (Number.isInteger(idx)) openGuessModal(idx);
  };
  A['bingo-submit-guess']   = () => submitGuess();
  A['bingo-skip-guess']     = () => skipGuess();
  A['bingo-cancel-guess']   = () => closeGuessModal();
  A['bingo-share']          = () => shareResult();
  // r308 sell nudge. Record BEFORE navigating: handle-sell can open the auth
  // or Stripe-onboarding path and never return here, and a nudge that reopens
  // every single day because the user actually acted on it is the worst
  // possible outcome.
  A['bingo-sell-start']     = () => {
    try { window.__bingoSellNudge && window.__bingoSellNudge.markSellNudgeSeen(false); } catch (_e) {}
    const n = document.querySelector('.bingo-sell-nudge');
    if (n) n.remove();
    try { A['close-bingo'] && A['close-bingo'](); } catch (_e) {}
    handleSellClick();
  };
  A['bingo-sell-dismiss']   = () => {
    try { window.__bingoSellNudge && window.__bingoSellNudge.markSellNudgeSeen(true); } catch (_e) {}
    const n = document.querySelector('.bingo-sell-nudge');
    if (n) n.remove();
  };
  // r345 handoff actions. A pick closes the game FIRST: the detail modal's
  // backdrop sits under #bingoScreen (z 320 — the r317 stats-sheet lesson),
  // so opening it on top would open it invisibly. The handler is the same
  // one the home grid uses, so the listing opens exactly as it does there.
  A['bingo-pick-open'] = (el) => {
    const id = el && el.dataset && el.dataset.productId;
    if (!id) return;
    try { window.posthog && window.posthog.capture('bingo_handoff_pick_tap', { listing_id: id }); } catch (_e) {}
    try { closeBingo(); } catch (_e) {}
    setTimeout(() => {
      try { A['open-detail']({ dataset: { productId: id } }, null); } catch (_e) {}
    }, 60);
  };
  A['bingo-handoff-browse'] = () => {
    try { window.posthog && window.posthog.capture('bingo_handoff_browse'); } catch (_e) {}
    try { closeBingo(); } catch (_e) {}
    setTimeout(() => {
      const el = document.getElementById('homeLatest');
      if (el) { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_e) {} }
    }, 80);
  };
  A['bingo-handoff-sell'] = () => {
    try { window.posthog && window.posthog.capture('bingo_handoff_sell_tap'); } catch (_e) {}
    try { markSellNudgeSeen(false); } catch (_e) {}
    try { closeBingo(); } catch (_e) {}
    handleSellClick();
  };
  A['bingo-handoff-dismiss'] = () => {
    try { markSellNudgeSeen(true); } catch (_e) {}
    try { renderBingoHandoff(); } catch (_e) {}
  };

  // Wire input listeners (autocomplete + Enter-to-submit). We attach once
  // and just feed today's pool every time.
  const guessInput = document.getElementById('bingoGuessInput');
  if (guessInput) {
    guessInput.addEventListener('input', (e) => renderAutocomplete(e.target.value));
    guessInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveAutocompleteSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveAutocompleteSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const ac = document.getElementById('bingoAutocomplete');
        // Prefer an explicitly-selected row (keyboard nav); else first row.
        const picked = ac && (ac.querySelector('.bingo-autocomplete-row.active')
                              || ac.querySelector('.bingo-autocomplete-row'));
        if (picked && ac.classList.contains('open')) {
          const pick = picked.dataset.pick;
          if (pick) guessInput.value = pick;
          ac.classList.remove('open');
        }
        submitGuess();
      } else if (e.key === 'Escape') {
        closeGuessModal();
      }
    });
  }

  // ── Leaderboard results panel ──────────────────────────────────────────
  //
  // After a win, ask the server for four things:
  //   1. Global daily percentile
  //   2. Country daily percentile (if user has country set)
  //   3. Friends board (top 10 + your rank)
  //   4. Global streak record + your personal best
  //
  // The win banner shows immediately on solve; this panel slots in below
  // it once the server-side aggregation finishes (usually 1–3s after the
  // last sync). All four calls run in parallel; any failure is rendered
  // as a quiet drop-out (we render the others) rather than blocking.
  //
  // Network model: drainBingoSyncQueue is the only path that writes
  // users/{uid}/bingoGames/{date} — once it succeeds the
  // onBingoWinAggregate trigger fires and the percentile callable can
  // answer. If the user is offline we render "Will calculate when you
  // reconnect" and let drainBingoSyncQueue re-trigger us on next online.
  let __bingoResultsLoaded = false;
  let __bingoResultsLoading = false;
  function ensureResultsPanelHost() {
    let panel = document.getElementById('bingoResultsPanel');
    if (panel) return panel;
    const banner = document.getElementById('bingoResultBanner');
    if (!banner) return null;
    panel = document.createElement('div');
    panel.id = 'bingoResultsPanel';
    panel.className = 'bingo-results-panel';
    panel.innerHTML = '<div class="brp-loading">Calculating your rank…</div>';
    banner.insertAdjacentElement('afterend', panel);
    return panel;
  }
  function renderResultsOffline() {
    const panel = ensureResultsPanelHost();
    if (!panel) return;
    panel.innerHTML =
      '<div class="brp-loading">Will calculate when you reconnect.</div>';
  }
  // r266: flagEmoji() removed. It converted an ISO-3166 code to regional
  // indicator emoji (globe fallback) but had ZERO call sites — the country
  // bullet below has always rendered as plain text ("78% in United States").
  // Deleted rather than swapped for inline SVG: there was no emoji on screen
  // to replace, only dead code carrying one.
  function renderResultsPanel(panel, results) {
    const { global, country, friends, streak } = results;
    const lines = [];
    // Headline — global percentile is the hero number.
    if (global && global.solved && Number.isInteger(global.percentile)) {
      lines.push(
        '<div class="brp-headline">You scored higher than ' +
        global.percentile + '% of players today</div>'
      );
    } else if (global && global.pending) {
      lines.push(
        '<div class="brp-headline">Your rank is being calculated…</div>'
      );
    } else {
      lines.push(
        '<div class="brp-headline">Your rank will be ready shortly</div>'
      );
    }
    // Per-scope detail row
    const detail = [];
    if (global && Number.isInteger(global.percentile)) {
      detail.push(global.percentile + '% globally');
    }
    if (country && country.countrySet && Number.isInteger(country.percentile)) {
      detail.push(country.percentile + '% in ' + country.country);
    }
    if (friends && Number.isInteger(friends.friendsWhoSolved)
        && Number.isInteger(friends.totalFriends) && friends.totalFriends > 0) {
      detail.push(
        'Beat ' + friends.friendsWhoSolved + ' of ' +
        friends.totalFriends + ' friends'
      );
    }
    if (detail.length) {
      const esc = window.safeText || (function (s) { return s; });
      lines.push(
        '<div class="brp-row">' + detail.map(esc).join(' · ') + '</div>'
      );
    }
    // Country row: HIDDEN ENTIRELY when the user has no country field set
    // (countrySet === false). Adding country is gated on the users/{uid}
    // rules whitelist + profile-edit UI — see BINGO_LEADERBOARD_PREREQS.md.
    // The detail-row block above already only renders a country bullet
    // when countrySet && Number.isInteger(percentile), so there's nothing
    // to render here. Friends row is similarly suppressed when
    // totalFriends === 0. Global percentile + streak always show.
    // Streak block
    if (streak) {
      const your = Number(streak.yourBestStreak) || 0;
      const all = streak.allTimeLongestStreak;
      const bits = [];
      if (your > 0) bits.push('Your best streak: ' + your +
        ' day' + (your === 1 ? '' : 's'));
      if (all && Number(all.streak) > 0) {
        bits.push('Global record: ' + all.streak +
          ' day' + (all.streak === 1 ? '' : 's'));
      }
      if (bits.length) {
        lines.push('<div class="brp-streak">' + bits.join(' · ') + '</div>');
      }
    }
    panel.innerHTML = lines.join('');
  }
  async function loadBingoResults(date) {
    // Idempotent — calling twice while the first call is in flight or
    // after it succeeded is a no-op.
    if (__bingoResultsLoaded || __bingoResultsLoading) return;
    const u = window.CURRENT_USER;
    if (!u || !u.uid) return;       // anonymous, no server-side rank
    const panel = ensureResultsPanelHost();
    if (!panel) return;
    if (!navigator.onLine) { renderResultsOffline(); return; }
    __bingoResultsLoading = true;
    try {
      const { getFunctions, httpsCallable } = await import(
        'https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js'
      );
      const fns = getFunctions();
      const callP = (name) => httpsCallable(fns, name)({ date })
        .then((r) => (r && r.data) || null)
        .catch((e) => {
          console.warn('[bingo] callable failed:', name, e && e.code || e);
          return null;
        });
      // Streak callable doesn't take a date — wrap separately so all
      // four resolve under one Promise.all.
      const streakP = httpsCallable(fns, 'getBingoGlobalStreakRecord')({})
        .then((r) => (r && r.data) || null)
        .catch(() => null);
      const [global, country, friends, streak] = await Promise.all([
        callP('getBingoPercentile'),
        callP('getBingoCountryPercentile'),
        callP('getBingoFriendsBoard'),
        streakP,
      ]);
      renderResultsPanel(panel, { global, country, friends, streak });
      // Mark loaded only if the server has actually aggregated; a
      // pending state lets us retry on the next openBingo() call.
      if (global && global.synced && !global.pending) {
        __bingoResultsLoaded = true;
      }
    } catch (err) {
      console.warn('[bingo] loadBingoResults failed:', err);
      panel.innerHTML =
        '<div class="brp-loading">Couldn\'t load your rank. Try again later.</div>';
    } finally {
      __bingoResultsLoading = false;
    }
  }
  window.loadBingoResults = loadBingoResults;

  // Hydrate state on load (so the badge / stat row reads correctly even
  // before the screen is opened, in case we add a "today's score" preview
  // somewhere later).
  hydrate();
  // Reflect today's progress on the desktop nav CTA pill.
  updateNavBingoCta();

