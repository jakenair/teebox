// feed-rank.js — "For You" home-feed ranking (2026-11-17).
//
// A weighted score per listing, tuned ONLY in js/feed-rank-config.js:
//   score = fresh·freshness + affinity·match + popularity·likes
//           + explore·seededRandom − quality·penalties − seen·exposure
// then a diversity pass (no wall of one seller / one category).
//
// Runs entirely on the client over listings the page already loads (the
// whole active catalog), so it adds no request and no server. The pure core
// (rank/score/buildProfile/diversify) is exported for node tests; the browser
// glue below it keeps the per-device signal log, the visit seed and the
// impression/click logging.
//
// Guarantees, whatever the weights:
//   - never the viewer's own listings, sold, sold-out, removed, held or
//     currently-reserved (pending with a live window) listings
//   - stable within a visit: the seed and the buyer profile are frozen for the
//     page load, so re-renders and infinite scroll never reshuffle
(function (root) {
  'use strict';

  const DAY = 86400000;

  // ── tiny helpers ──────────────────────────────────────────────────────
  function toMs(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
    return 0;
  }
  // 32-bit string hash → [0, 1). Deterministic per (seed, id).
  function hash01(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return (h1 >>> 0) / 4294967296;
  }
  const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
  // Category key used for matching: the precise spec category (driver,
  // putter, iron-set …) when the seller picked one, else the broad cat.
  function catKey(p) {
    const sc = lc(p && p.specCategory);
    return (sc && sc !== 'other') ? sc : lc(p && p.cat);
  }
  function flexOf(p) { return lc(p && p.specs && p.specs.flex); }
  function askOf(p) { const n = Number(p && p.ask); return Number.isFinite(n) && n > 0 ? n : 0; }

  // ── eligibility (hard rules, not weights) ─────────────────────────────
  function isEligible(p, uid, now) {
    if (!p || p.id == null) return false;
    const st = p.status || 'active';
    if (st !== 'active' && st !== 'pending') return false;
    if (uid && p.sellerId && String(p.sellerId) === String(uid)) return false;
    const qty = Math.max(1, Number(p.quantity || 1));
    if (Math.max(0, Number(p.quantitySold || 0)) >= qty) return false;
    // Reserved for someone's checkout right now. A pending whose window has
    // lapsed is buyable again (the r179 rule) and stays eligible.
    if (st === 'pending') {
      const pu = toMs(p.pendingUntil);
      if (!pu || pu > now) return false;
    }
    return true;
  }

  // ── buyer profile from logged signals ─────────────────────────────────
  // events: [{t, k, cat, sc, brand, ask, flex, q}] — k ∈ view|favorite|
  // message|savedSearch|search|cartAdd. Search events carry only q and are
  // resolved against the catalog (the listings that text would find).
  function buildProfile(events, catalog, now, cfg) {
    const S = cfg.signals || {};
    const hl = Math.max(1, Number(S.signalHalfLifeDays || 21)) * DAY;
    const cat = new Map(), brand = new Map(), flex = new Map();
    let pw = 0, ps = 0, ps2 = 0, n = 0;
    const add = (m, k, w) => { if (k) m.set(k, (m.get(k) || 0) + w); };
    const absorb = (a, w) => {
      add(cat, a.sc && a.sc !== 'other' ? lc(a.sc) : lc(a.cat), w);
      if (a.sc && a.sc !== 'other' && a.cat) add(cat, lc(a.cat), w * 0.4);
      add(brand, lc(a.brand), w);
      add(flex, lc(a.flex), w);
      const ask = Number(a.ask);
      if (Number.isFinite(ask) && ask > 0) { const x = Math.log(ask); pw += w; ps += w * x; ps2 += w * x * x; }
    };
    for (const e of events || []) {
      if (!e || !e.k) continue;
      const base = Number(S[e.k] || 0);
      if (!base) continue;
      const age = Math.max(0, now - Number(e.t || now));
      const w = base * Math.pow(0.5, age / hl);
      if (w < 0.01) continue;
      n++;
      if (e.k === 'search') {
        const q = lc(e.q);
        if (q.length < 2) continue;
        const hits = (catalog || []).filter((p) =>
          (lc(p.brand) + ' ' + lc(p.title || p.name) + ' ' + lc(p.cat) + ' ' + lc(p.specCategory)).includes(q)).slice(0, 8);
        hits.forEach((p) => absorb({cat: p.cat, sc: p.specCategory, brand: p.brand, flex: flexOf(p), ask: p.ask}, w / hits.length));
      } else {
        absorb(e, w);
      }
    }
    if (!n) return null;
    const norm = (m) => {
      let max = 0; m.forEach((v) => { if (v > max) max = v; });
      const out = new Map(); if (max > 0) m.forEach((v, k) => out.set(k, v / max));
      return out;
    };
    let price = null;
    if (pw >= 1.5) {
      const mu = ps / pw;
      const sd = Math.sqrt(Math.max(0, ps2 / pw - mu * mu));
      price = {mu, sd: Math.max(0.35, sd)};
    }
    return {cat: norm(cat), brand: norm(brand), flex: norm(flex), price, events: n};
  }

  function affinity(p, prof, cfg) {
    if (!prof) return 0;
    const A = cfg.affinity || {};
    let num = 0, den = 0;
    if (prof.cat.size) {
      const k = catKey(p);
      const v = Math.max(prof.cat.get(k) || 0, (prof.cat.get(lc(p.cat)) || 0) * 0.6);
      num += (A.category || 0) * v; den += (A.category || 0);
    }
    if (prof.brand.size) { num += (A.brand || 0) * (prof.brand.get(lc(p.brand)) || 0); den += (A.brand || 0); }
    if (prof.price && askOf(p)) {
      const z = (Math.log(askOf(p)) - prof.price.mu) / prof.price.sd;
      num += (A.price || 0) * Math.exp(-0.5 * z * z); den += (A.price || 0);
    }
    if (prof.flex.size && flexOf(p)) { num += (A.flex || 0) * (prof.flex.get(flexOf(p)) || 0); den += (A.flex || 0); }
    return den > 0 ? num / den : 0;
  }

  // Median ask of same brand+category peers, excluding the listing itself.
  function peerIndex(items) {
    const g = new Map();
    for (const p of items) {
      const a = askOf(p); if (!a || !lc(p.brand)) continue;
      const k = lc(p.brand) + '|' + catKey(p);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push({id: String(p.id), a});
    }
    return g;
  }
  function peerMedian(p, idx, minPeers) {
    const arr = idx.get(lc(p.brand) + '|' + catKey(p));
    if (!arr) return 0;
    const others = arr.filter((x) => x.id !== String(p.id)).map((x) => x.a).sort((a, b) => a - b);
    if (others.length < minPeers) return 0;
    const m = others.length >> 1;
    return others.length % 2 ? others[m] : (others[m - 1] + others[m]) / 2;
  }

  function qualityPenalty(p, ctx) {
    const Q = ctx.cfg.quality || {};
    let pen = 0; const why = [];
    if (!lc(p.brand)) { pen += Q.noBrandPenalty || 0; why.push('no-brand'); }
    const O = Q.overpriced || {};
    const est = Number(p.priceEstimate && p.priceEstimate.mid) || peerMedian(p, ctx.peers, O.minPeers || 3);
    if (est > 0 && askOf(p)) {
      const ratio = askOf(p) / est;
      if (ratio > (O.ratio || 1.6)) { pen += Math.min(O.maxPenalty || 1, ratio - (O.ratio || 1.6)); why.push('overpriced'); }
    }
    const ageDays = (ctx.now - toMs(p.createdAt)) / DAY;
    if (ageDays > (Q.staleDays || 45) && !(Number(p.watchlistCount) > 0)) { pen += Q.stalePenalty || 0; why.push('stale'); }
    return {pen, why};
  }

  function score(p, ctx) {
    const cfg = ctx.cfg, W = cfg.weights || {};
    const created = toMs(p.createdAt);
    const ageDays = created ? Math.max(0, (ctx.now - created) / DAY) : 365;
    const fresh = Math.pow(0.5, ageDays / Math.max(0.5, cfg.freshHalfLifeDays || 4));
    const aff = affinity(p, ctx.profile, cfg);
    const likes = Math.max(0, Number(p.watchlistCount || 0));
    const pop = Math.min(1, Math.log1p(likes) / Math.log1p((cfg.popularity && cfg.popularity.likesForFull) || 8));
    const explore = hash01(String(ctx.seed) + ':' + String(p.id));
    const q = qualityPenalty(p, ctx);
    const E = cfg.exposure || {};
    const seenN = (ctx.seen && ctx.seen[String(p.id)]) || 0;
    const seen = Math.min(E.maxPenalty || 0.8, seenN * (E.perImpression || 0.12));
    const parts = {
      fresh: (W.fresh || 0) * fresh,
      affinity: (W.affinity || 0) * aff,
      popularity: (W.popularity || 0) * pop,
      explore: (W.explore || 0) * explore,
      quality: -(W.quality || 0) * q.pen,
      seen: -(W.seen || 0) * seen,
    };
    const total = parts.fresh + parts.affinity + parts.popularity + parts.explore + parts.quality + parts.seen;
    return {score: total, parts, why: q.why};
  }

  // Greedy re-rank: walk the scored list, always taking the best remaining
  // listing that keeps the last `window` cards within the seller/category
  // caps. Relax the category cap, then both, only when nothing else fits.
  function diversify(sorted, cfg) {
    const D = cfg.diversity || {};
    const W = Math.max(2, D.window || 6), mS = D.maxPerSeller || 2, mC = D.maxPerCategory || 3;
    const pool = sorted.slice(), out = [];
    const count = (arr, f, v) => arr.reduce((n, x) => n + (f(x) === v ? 1 : 0), 0);
    const sel = (p) => String(p.sellerId || ''), cat = (p) => lc(p.cat);
    while (pool.length) {
      const win = out.slice(-(W - 1));
      let i = pool.findIndex((p) => count(win, sel, sel(p)) < mS && count(win, cat, cat(p)) < mC);
      if (i < 0) i = pool.findIndex((p) => count(win, sel, sel(p)) < mS);
      if (i < 0) i = 0;
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  // Discovery slots: a few fixed positions near the top go to listings that
  // would otherwise sit below `fromRank` — least-seen on this device first,
  // then the visit seed — so every active listing rotates into view.
  function discovery(list, ctx) {
    const D = ctx.cfg.discovery || {};
    const slots = (D.slots || []).filter((i) => i < list.length).sort((a, b) => a - b);
    const from = Math.max(0, D.fromRank || 24);
    if (!slots.length || list.length <= from) return list;
    const out = list.slice();
    const S = (ctx.cfg.diversity || {}).maxPerSeller || 2, W = (ctx.cfg.diversity || {}).window || 6;
    for (const slot of slots) {
      const tail = out.slice(Math.max(from, slot + 1));
      if (!tail.length) break;
      tail.sort((a, b) => (((ctx.seen[String(a.id)] || 0) - (ctx.seen[String(b.id)] || 0)) ||
        (hash01(ctx.seed + '#d' + a.id) - hash01(ctx.seed + '#d' + b.id))));
      const near = out.slice(Math.max(0, slot - W + 1), slot);
      const pick = tail.find((p) => near.filter((x) => String(x.sellerId) === String(p.sellerId)).length < S) || tail[0];
      out.splice(out.indexOf(pick), 1);
      out.splice(slot, 0, pick);
    }
    return out;
  }

  /**
   * Rank listings for the home feed.
   * @param {Array} items listings (already filtered by the active chips/price/etc.)
   * @param {{uid?:string, now?:number, seed?:string, profile?:object|null,
   *          seen?:Object<string,number>, cfg?:object, catalog?:Array}} o
   * @return {{list: Array, meta: Map<string,{pos:number,score:number,parts:object}>, mode: string}}
   */
  function rank(items, o) {
    const cfg = o.cfg || root.TB_FEED_CONFIG;
    const now = o.now || Date.now();
    const elig = (items || []).filter((p) => isEligible(p, o.uid, now));
    const ctx = {cfg, now, seed: o.seed || '0', profile: o.uid ? (o.profile || null) : null,
      // Peers = ACTIVE listings only, so the boot paint (active-only query)
      // and the full load (which also holds pending) price-compare alike.
      seen: o.seen || {}, peers: peerIndex((o.catalog || items || []).filter((p) => (p.status || 'active') === 'active'))};
    const scored = elig.map((p) => ({p, s: score(p, ctx)}));
    // Ties (identical scores are rare) break on the seeded hash, never on
    // array order, so the result doesn't depend on how the data arrived.
    scored.sort((a, b) => (b.s.score - a.s.score) || (hash01(ctx.seed + String(a.p.id)) - hash01(ctx.seed + String(b.p.id))));
    const list = discovery(diversify(scored.map((x) => x.p), cfg), ctx);
    const byId = new Map(scored.map((x) => [String(x.p.id), x.s]));
    const meta = new Map();
    list.forEach((p, i) => { const s = byId.get(String(p.id)); meta.set(String(p.id), {pos: i, score: Math.round(s.score * 1000) / 1000, parts: s.parts}); });
    return {list, meta, mode: ctx.profile ? 'personal' : 'default'};
  }

  const api = {rank, score, buildProfile, diversify, discovery, isEligible, affinity, hash01, catKey, _toMs: toMs};

  // ── browser glue ──────────────────────────────────────────────────────
  if (typeof root.localStorage !== 'undefined' || typeof root.document !== 'undefined') {
    const LS = {
      get(k, d) { try { const v = root.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_e) { return d; } },
      set(k, v) { try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (_e) { /* private mode / full */ } },
    };
    const cfg = () => root.TB_FEED_CONFIG || {};
    const UID_KEY = 'tb_feed_uid', SEED_KEY = 'tb_feed_visit', SEEN_KEY = 'tb_feed_seen_v1';
    const sigKey = (uid) => 'tb_feed_sig_v1:' + uid;

    // The signed-in uid as last known on this device, so the boot-time first
    // paint (before Firebase auth restores) ranks exactly like the full load.
    api.setUid = function (uid) {
      try { if (uid) root.localStorage.setItem(UID_KEY, String(uid)); else root.localStorage.removeItem(UID_KEY); } catch (_e) {}
    };
    api.knownUid = function () {
      const u = root.CURRENT_USER && root.CURRENT_USER.uid;
      if (u) return u;
      if (root.__authResolved && !root.CURRENT_USER) return null;
      try { return root.localStorage.getItem(UID_KEY) || null; } catch (_e) { return null; }
    };

    // One seed per visit: kept while the user is active, replaced after
    // visitIdleMinutes of inactivity.
    function visitSeed(now) {
      const idle = (cfg().visitIdleMinutes || 30) * 60000;
      const v = LS.get(SEED_KEY, null);
      if (v && v.seed && now - Number(v.last || 0) < idle) { v.last = now; LS.set(SEED_KEY, v); return v.seed; }
      const seed = Math.floor(Math.random() * 1e9).toString(36) + now.toString(36);
      LS.set(SEED_KEY, {seed, last: now});
      return seed;
    }
    api.touchVisit = function () { const v = LS.get(SEED_KEY, null); if (v) { v.last = Date.now(); LS.set(SEED_KEY, v); } };

    function loadSeen(now) {
      const forget = (cfg().exposure && cfg().exposure.forgetDays || 4) * DAY;
      const raw = LS.get(SEEN_KEY, {});
      const out = {};
      Object.keys(raw || {}).forEach((id) => { const r = raw[id]; if (r && now - r.t < forget) out[id] = r.n; });
      return out;
    }

    // Snapshot frozen for this page load (first call wins).
    let snap = null;
    function snapshot(uid, catalog) {
      const now = Date.now();
      if (snap && snap.uid === (uid || null)) return snap;
      const events = uid ? LS.get(sigKey(uid), []) : [];
      snap = {uid: uid || null, now, seed: visitSeed(now), seen: loadSeen(now),
        profile: uid ? buildProfile(events, catalog || [], now, cfg()) : null};
      return snap;
    }

    let lastMeta = new Map(), lastMode = 'default';
    api.rankForHome = function (items, catalog) {
      const uid = api.knownUid();
      const s = snapshot(uid, catalog || items);
      const r = rank(items, {uid, now: s.now, seed: s.seed, profile: s.profile, seen: s.seen, cfg: cfg(), catalog: catalog || items});
      lastMeta = r.meta; lastMode = r.mode;
      return r.list;
    };
    api.metaFor = function (id) { return lastMeta.get(String(id)) || null; };
    api.mode = function () { return lastMode; };
    api.seed = function () { return snap ? snap.seed : null; };
    // Test hook: drop the frozen snapshot (a new "page load").
    api._resetSnapshot = function () { snap = null; };

    // ── signal log (per signed-in user, this device) ──
    // logSignal('view', listing) / ('favorite', listing) / ('message', listing)
    // / ('cartAdd', listing) / ('search', {q}) / ('savedSearch', {cat, brand, ask})
    api.logSignal = function (kind, x) {
      try {
        const uid = api.knownUid();
        if (!uid || !x) return;
        const S = cfg().signals || {};
        if (!S[kind]) return;
        const e = {t: Date.now(), k: kind};
        if (kind === 'search') { e.q = String(x.q || '').slice(0, 60); if (e.q.trim().length < 2) return; }
        else {
          if (x.sellerId && String(x.sellerId) === String(uid)) return; // own listing says nothing
          e.cat = x.cat || null; e.sc = x.specCategory || x.sc || null; e.brand = x.brand || null;
          e.ask = Number(x.ask) || null; e.flex = (x.specs && x.specs.flex) || x.flex || null;
          if (x.id != null) e.id = String(x.id);
        }
        const key = sigKey(uid);
        const arr = LS.get(key, []);
        // One favorite per listing (hydrating likes from the server re-logs them).
        if (kind === 'favorite' && e.id && arr.some((y) => y.k === 'favorite' && y.id === e.id)) return;
        arr.push(e);
        LS.set(key, arr.slice(-(S.maxEvents || 300)));
      } catch (_e) { /* never throws */ }
    };

    // ── impressions + clicks ──
    // A card counts as seen at >= 50% visible for 600ms, once per page load.
    // Seen counts feed the exposure rule; batches go to PostHog for tuning.
    const seenThisLoad = new Set();
    let queue = [], flushTimer = null;
    function flush(beacon) {
      if (!queue.length) return;
      const items = queue; queue = [];
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      try {
        if (root.posthog && root.posthog.capture) {
          root.posthog.capture('feed_impressions', {
            items, mode: items[0].mode, seed: api.seed(), configVersion: cfg().version, count: items.length, host: root.location && root.location.hostname,
          }, beacon ? {transport: 'sendBeacon'} : undefined);
        }
      } catch (_e) {}
    }
    function noteImpression(id) {
      if (seenThisLoad.has(id)) return;
      seenThisLoad.add(id);
      const now = Date.now();
      const raw = LS.get(SEEN_KEY, {});
      const r = raw[id] || {n: 0, t: now};
      raw[id] = {n: r.n + 1, t: now};
      // Keep the map small: drop the oldest beyond 600 ids.
      const ids = Object.keys(raw);
      if (ids.length > 600) ids.sort((a, b) => raw[a].t - raw[b].t).slice(0, ids.length - 600).forEach((k) => delete raw[k]);
      LS.set(SEEN_KEY, raw);
      const m = api.metaFor(id);
      queue.push({id, pos: m ? m.pos : null, score: m ? m.score : null, mode: root.__feedSortMode || lastMode});
      if (queue.length >= 20) flush(false);
      else if (!flushTimer) flushTimer = setTimeout(() => flush(false), 8000);
    }
    api.observeGrid = function (grid) {
      if (!grid || grid.__feedObserved || !('IntersectionObserver' in root)) return;
      grid.__feedObserved = true;
      const timers = new Map();
      const io = new root.IntersectionObserver((entries) => {
        entries.forEach((en) => {
          const id = en.target.getAttribute('data-product-id');
          if (!id) return;
          if (en.isIntersecting && en.intersectionRatio >= 0.5) {
            if (!timers.has(en.target)) timers.set(en.target, setTimeout(() => { timers.delete(en.target); noteImpression(id); }, 600));
          } else if (timers.has(en.target)) { clearTimeout(timers.get(en.target)); timers.delete(en.target); }
        });
      }, {threshold: [0, 0.5]});
      const watch = (el) => { if (el && el.nodeType === 1 && el.matches('.product-card[data-product-id]') && !el.hasAttribute('data-boot')) io.observe(el); };
      Array.from(grid.children).forEach(watch);
      new root.MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(watch))).observe(grid, {childList: true});
      grid.addEventListener('click', (ev) => {
        const card = ev.target && ev.target.closest && ev.target.closest('.product-card[data-product-id]');
        if (!card || (ev.target.closest('.fav-btn'))) return;
        const id = card.getAttribute('data-product-id');
        const m = api.metaFor(id);
        try {
          root.posthog && root.posthog.capture && root.posthog.capture('feed_click', {
            id, pos: m ? m.pos : null, score: m ? m.score : null, parts: m ? m.parts : null,
            mode: root.__feedSortMode || lastMode, seed: api.seed(), configVersion: cfg().version,
          });
        } catch (_e) {}
      }, true);
      root.addEventListener('pagehide', () => flush(true));
      root.document.addEventListener('visibilitychange', () => { if (root.document.visibilityState === 'hidden') flush(true); });
    };
  }

  root.TBFeedRank = api;
  // Loaded async: if the feed already rendered without us (fell back to
  // Newest), re-render once so For You applies.
  if (root.__feedRankMissed && typeof root.buildProducts === 'function') {
    root.__feedRankMissed = false;
    setTimeout(() => { try { root.buildProducts(); } catch (_e) {} }, 0);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
