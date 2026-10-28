// app-main.js — extracted from index.html (r349 cold-load, Stage C). Classic script (defer): marketplace UI, actions, checkout.
// Edit here; index.html only carries the <script src> tag. Served gzipped and cached by GitHub Pages.

// v1.1: demo seed data removed. The marketplace now shows only real
// Firestore listings. Empty array kept (instead of deleting the const)
// because other code paths reference window.DEFAULT_PRODUCTS — they
// gracefully fall through to an empty state when the array is empty.
const DEFAULT_PRODUCTS = [];
window.DEFAULT_PRODUCTS = DEFAULT_PRODUCTS;
window.PRODUCTS = [...DEFAULT_PRODUCTS];
// r148: first-load feed state. buildProducts() must never paint the
// "No listings yet" empty state before the FIRST feed query resolves —
// on a cold load PRODUCTS starts [] and the init-time buildProducts()
// call runs before auth restore / the prefetch settles, so without this
// gate every cold visitor saw a 0.5–2s "No listings yet" flash.
window.__listingsLoaded = false; // true once the first feed query resolves
window.__listingsError = false;  // true when the last feed query failed
window.IS_VERIFIED_SELLER = false;
window.CURRENT_USER = null;
// Guest browse mode: default to TRUE so a fresh visitor lands on the
// marketplace without a sign-in wall. onAuthStateChanged flips this to
// `false` on a successful login. Any action that requires identity
// goes through requireAuth() (defined below) — guests get a polished
// "Sign in to continue" modal explaining why; authenticated users
// proceed normally.
if (typeof window.GUEST_MODE === 'undefined') window.GUEST_MODE = true;

// Stock-ticker source. v1.2 — derived from real Firestore listings on
// every buildProducts() call. We keep top 8 brands + their median ask
// from active listings and synthesize a session-stable change %.
// ── Ticker reel ────────────────────────────────────────────────────────────
// CURATED, hardcoded list of aspirational golf gear. During the beta the
// marketplace is thin, so a ticker driven by live inventory looks dead — this
// reel keeps the "market" strip lively and sets the premium tone. It FULLY
// REPLACES the live-listing data source for now; we can blend real listings
// back in post-beta if we want.
//
// PURELY DECORATIVE — note the guardrails baked in here:
//   • prices are HAND-AUTHORED typical asking prices, not live data — no
//     deltas, no timestamps, no refresh (r183 removed the cosmetic % moves);
//   • items are NON-clickable — buildTicker emits plain <span>s with no link
//     and no data-action, so there are no dead-ends to listings that don't
//     exist;
//   • text brand/item names only — no logos or images.
// Edit names / prices freely.
const CURATED_TICKER = [
  { name: 'Peter Millar Polo',         price: '$95', },
  { name: 'Holderness & Bourne Shirt', price: '$110', },
  { name: 'Smathers & Branson Belt',   price: '$165', },
  { name: 'TaylorMade Qi10 Driver',    price: '$399', },
  { name: 'Scotty Cameron Putter',     price: '$450', },
  { name: 'Titleist TSR3 Driver',      price: '$375', },
  { name: 'Greyson Hoodie',            price: '$148', },
  { name: 'FootJoy Premiere',          price: '$180', },
  { name: 'Ping G430 Driver',          price: '$360', },
  { name: 'Straight Down Polo',        price: '$85', },
  { name: 'G/FORE Gloves',             price: '$42', },
  { name: 'Dormie Headcover',          price: '$55', },
];


// Kept as an inert no-op so existing callers (loadListings) stay safe. The
// ticker no longer derives from live inventory — see CURATED_TICKER above.
function deriveTickerFromProducts() { /* curated reel — intentionally inert */ }
window.deriveTickerFromProducts = deriveTickerFromProducts;

// v1.1: demo "Upcoming Drops" removed. buildDrops() hides the section
// when this array is empty.
const DROPS = [];

const fav = new Set();
let currentMode = 'buy';

// Image resilience (#3): if a listing photo fails to load/decode (a transient
// CDN or jpg→webp content-type hiccup — the cause of the "blank photo / ?"
// report, whose URL otherwise returns 200), swap it for a neutral placeholder
// instead of a blank box or broken-image glyph. The box stays sized (no layout
// shift) since we only change the source. 'error' doesn't bubble → capture it,
// scoped to listing imagery so avatars/icons are untouched.
if (!window.__imgFallbackBound) {
  window.__imgFallbackBound = true;
  document.addEventListener('error', function (e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.imgFb) return;
    if (!img.closest('.product-img-wrap, .item-cell, .trend-thumb, .detail-gallery, .shop-thumb-placeholder')) return;
    img.dataset.imgFb = '1';
    img.style.background = 'var(--gray-100)';
    img.style.objectFit = 'cover';
    img.src = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' fill='%23eef0f2'/><path d='M14 32l7-8 5 5 4-5 4 8z' fill='%23c8cdd2'/><circle cx='18' cy='18' r='3' fill='%23c8cdd2'/></svg>";
  }, true);
}

// Register handlers used by the `data-action` delegator in <head>.
window.__actions = window.__actions || {};
window.__actions['open-detail'] = function(el, ev) {
  // r182: the card name is now a real <a href="/listing/<id>/"> for
  // crawlers — JS users stay in the SPA modal, so swallow the navigation.
  if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  openDetailModal(el.dataset.productId);
};
window.__actions['handle-sell'] = function() {
  if (typeof handleSellClick === 'function') handleSellClick();
};
// r345 seller invite card (home).
window.__actions['seller-invite-sell'] = function() {
  try { window.posthog && window.posthog.capture('seller_invite_cta', { surface: 'home' }); } catch (_e) {}
  if (typeof handleSellClick === 'function') handleSellClick();
};
window.__actions['seller-invite-dismiss'] = function() {
  try { localStorage.setItem('tb_seller_invite_v1', JSON.stringify({ at: Date.now() })); } catch (_e) {}
  const host = document.getElementById('sellerInvite');
  if (host) { host.style.display = 'none'; host.innerHTML = ''; }
};
window.__actions['reload-listings'] = function() {
  // r148: retry button on the feed error state. loadListings re-shows the
  // skeleton (grid is empty in the error state) and refetches.
  if (window.loadListings) { try { window.loadListings(); } catch (_e) {} }
};
window.__actions['view-my-orders'] = function() {
  // Batch-2: "View Order" on the purchase-confirmation sheet.
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  if (typeof openOrders === 'function') { try { openOrders(); } catch (_e) {} }
};
window.__actions['share-listing'] = async function() {
  // r156: share the open listing. UTM'd link so PostHog measures the loop;
  // no PII, no backend. Native sheet → copy-link toast fallback via the
  // shared shareOrFallback helper (defined in the bingo module, present by
  // user-tap time).
  // currentDetailId is a top-level `let` in this same script scope (not a
  // window prop) — bare reference resolves it at call time.
  const id = (typeof currentDetailId !== 'undefined' && currentDetailId) || null;
  if (!id) return;
  const p = (window.PRODUCTS || []).find(x => String(x.id) === String(id));
  const url = 'https://teeboxmarket.com/?listing=' + encodeURIComponent(String(id)) +
    '&utm_source=seller_share&utm_medium=share&utm_campaign=listing';
  const title = (p && p.name) ? p.name : 'A listing on TeeBox';
  const text = p ? `${p.name} — $${Number(p.ask || 0).toLocaleString()} on TeeBox` : 'Check out this listing on TeeBox';
  const out = window.shareOrFallback
    ? await window.shareOrFallback({ title, text, url })
    : 'failed';
  if (out === 'copied' && window.showToast) window.showToast('Link copied — send it anywhere.');
  else if (out === 'failed' && window.showToast) window.showToast('Could not share this listing.');
};
window.__actions['open-detail-from-search'] = function(el) {
  document.getElementById('searchOverlay').classList.remove('open');
  setTimeout(() => openDetailModal(el.dataset.productId), 100);
};

// Escape helper with a self-contained fallback. buildTicker runs very early
// (top-level call below) and inside WKWebView; never assume window.safeText
// is defined yet — fall back to a local escaper so a load-order shift can't
// leave the reel blank.
function _tickerSafe(v) {
  if (typeof window.safeText === 'function') return window.safeText(v);
  return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function buildTicker() {
  const track = document.getElementById('tickerTrack');
  if (!track) return;
  const wrap = track.closest('.ticker-wrap');
  if (wrap) wrap.style.display = '';
  try {
    // r183 cut the randomized ±% deltas (invented numbers styled as live
    // data). r201 re-adds them per founder ruling 2026-08-13 — aesthetic
    // choice, decorative like the hand-authored prices themselves — with
    // guardrails: DETERMINISTIC (item name + UTC date seeded, day-stable —
    // no per-load flicker, moves roll over at midnight like a market),
    // small realistic magnitudes (±0.2–3.9%), and still non-clickable.
    const _dayKey = new Date().toISOString().slice(0, 10);
    const _delta = (name) => {
      let h = 2166136261 >>> 0;
      const s = name + ':' + _dayKey;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      const up = (h & 1) === 0;
      const mag = (0.2 + ((h >>> 8) % 370) / 100).toFixed(1); // 0.2–3.9
      return { up, txt: (up ? '▲ ' : '▼ ') + mag + '%' };
    };
    const doubled = [...CURATED_TICKER, ...CURATED_TICKER];
    track.innerHTML = doubled.map(t => {
      const d = _delta(t.name);
      return `<div class="ticker-item">`+
        `<span class="ticker-name">${_tickerSafe(t.name)}</span>`+
        `<span class="ticker-price">${_tickerSafe(t.price)}</span>`+
        `<span class="ticker-delta ${d.up ? 'up' : 'dn'}">${d.txt}</span>`+
      `</div>`;
    }).join('');
  } catch (e) {
    // A blank strip reads as broken (reported on iOS/WKWebView). If anything
    // above throws, render a minimal dependency-free fallback so the reel
    // still shows content instead of an empty bar.
    try {
      track.innerHTML = [...CURATED_TICKER, ...CURATED_TICKER].map(t =>
        `<div class="ticker-item"><span class="ticker-name">${_tickerSafe(t.name)}</span>`+
        `<span class="ticker-price">${_tickerSafe(t.price)}</span></div>`).join('');
    } catch (_) { /* give up silently — never throw out of the ticker */ }
  }
}

// Self-heal: guarantee the reel is populated even if the top-level
// buildTicker() call raced the DOM or a transient error left it empty.
// Idempotent (no-op once the track has children). Directly targets the
// reported iOS symptom of an empty ticker bar by making "blank" self-correct.
function ensureTickerReady() {
  const track = document.getElementById('tickerTrack');
  if (track && track.children.length === 0) buildTicker();
}
window.ensureTickerReady = ensureTickerReady;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureTickerReady);
window.addEventListener('load', ensureTickerReady);

function buildTrending() {
  // "Trending" used to sort by a fake `volume` field. Now it just shows
  // the most recent real listings. If there aren't any (e.g., signed-out
  // visitor with no real catalog) hide the section entirely instead of
  // padding it with demos.
  const real = (window.PRODUCTS || []).filter(p => typeof p.id === 'string');
  const tableEl = document.getElementById('trendingTable');
  const sectionEl = tableEl && tableEl.closest('.section');
  // r329: this used to hide the whole section whenever `real` was empty —
  // which is also true for the first ~750ms of every load, before the feed
  // query resolves. MEASURED on a warm load: the section rendered at 457ms,
  // was hidden at 551ms, and came back at 1228ms at h=1213, shoving
  // everything below it down. That one toggle was 0.270 of a 0.283 CLS.
  // Hold the static skeleton until the feed has actually settled; only a
  // RESOLVED empty feed hides the section.
  if (!window.__listingsLoaded) return;
  if (!real.length) {
    if (sectionEl) sectionEl.style.display = 'none';
    return;
  }
  if (sectionEl) sectionEl.style.display = '';

  const sorted = [...real]
    .sort((a, b) => {
      const at = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
      const bt = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
      return bt - at;
    })
    .slice(0, 7);

  const rows = sorted.map((p, i) => {
    const id = window.safeId(p.id);
    const url = window.variantImgUrl(p, 0, 'w400');
    const thumb = url
      ? `<img src="${window.safeAttr(url)}" alt="${window.safeAttr(p.name||'')}" loading="lazy" decoding="async" />`
      : window.CATEGORY_ICON(p.cat);
    const isSold = p.status === 'sold';
    // r186 §4: state classes are CSS hooks only — inline styles unchanged,
    // so the web table renders identically. In-app the routine "Active"
    // badge hides (audit: badge exceptional states only) and rows restyle
    // to 72px list rows.
    const statusBadge = isSold ? '<span class="trend-chg trend-sold" style="background:var(--gray-200);color:var(--gray-700)">Sold</span>' : '<span class="trend-chg trend-active" style="background:var(--up-bg);color:var(--up-green)">Active</span>';
    return `<tr data-action="open-detail" data-product-id="${window.safeAttr(id)}" style="cursor:pointer">`+
      `<td><div class="trend-rank">${i+1}</div></td>`+
      `<td><div class="trend-item"><div class="trend-thumb">${thumb}</div>`+
        `<div><div class="trend-info-name">${window.safeText(p.name || p.title)}</div>`+
        `<div class="trend-info-meta">${window.safeText(p.brand)} · ${window.safeText(p.cat)}</div></div></div></td>`+
      `<td><span class="trend-price">$${Number(p.ask||0).toLocaleString()}</span></td>`+
      `<td>${statusBadge}</td>`+
    `</tr>`;
  }).join('');
  tableEl.innerHTML =
    `<thead><tr><th>#</th><th>Item</th><th>Price</th><th>Status</th></tr></thead><tbody>${rows}</tbody>`;
}

// r345 — Featured Sellers. The rule IS the product: any seller with
// FEATURED_MIN_LISTINGS or more live listings on the public feed gets a card
// on the home page. No admin list, nothing to curate — which is what lets the
// seller invite promise "list five and you're featured" and have it be true
// the moment the fifth listing publishes. Counts come from window.PRODUCTS
// (the feed query: not sold/expired/removed/flagged, has photos), so the
// number a seller sees here is the number buyers see.
const FEATURED_MIN_LISTINGS = 5;
const FEATURED_MAX_CARDS = 6;
window.FEATURED_MIN_LISTINGS = FEATURED_MIN_LISTINGS;
function _createdMs(p) {
  return p && p.createdAt && p.createdAt.toDate ? p.createdAt.toDate().getTime() : 0;
}
function featuredSellerStats() {
  const by = new Map();
  (window.PRODUCTS || []).forEach(p => {
    if (!p || typeof p.id !== 'string' || !p.sellerId || p.status === 'sold') return;
    if (!by.has(p.sellerId)) by.set(p.sellerId, { uid: p.sellerId, count: 0, items: [], newest: 0 });
    const s = by.get(p.sellerId);
    s.count++;
    s.items.push(p);
    const t = _createdMs(p);
    if (t > s.newest) s.newest = t;
  });
  return by;
}
window.featuredSellerStats = featuredSellerStats;

function buildFeaturedSellers() {
  const sec = document.getElementById('featuredSellers');
  const rail = document.getElementById('featuredSellersRail');
  if (!sec || !rail || !window.__listingsLoaded) return;
  const blocked = (window.CURRENT_USER && window.MY_BLOCKED_UIDS) || null;
  const sellers = [...featuredSellerStats().values()]
    .filter(s => s.count >= FEATURED_MIN_LISTINGS && !(blocked && blocked.has(s.uid)))
    .sort((a, b) => (b.count - a.count) || (b.newest - a.newest))
    .slice(0, FEATURED_MAX_CARDS);
  if (!sellers.length) { sec.style.display = 'none'; rail.innerHTML = ''; return; }
  sec.style.display = '';
  const sub = document.getElementById('featuredSellersSub');
  if (sub) sub.textContent = `${FEATURED_MIN_LISTINGS}+ items for sale`;
  rail.innerHTML = sellers.map(s => {
    const uid = window.safeAttr(window.safeId(s.uid));
    const thumbs = [...s.items].sort((a, b) => _createdMs(b) - _createdMs(a)).slice(0, 3).map(p => {
      const u = window.variantImgUrl(p, 0, 'w400');
      return `<span>${u ? `<img src="${window.safeAttr(u)}" alt="" loading="lazy" decoding="async" />` : ''}</span>`;
    }).join('');
    return `<div class="fs-card" data-action="open-profile" data-uid="${uid}">`+
      `<div class="fs-top">`+
        `<div class="card-seller seller-id-slot" data-seller-id="${uid}"></div>`+
        `<span class="fs-badge">Featured</span>`+
      `</div>`+
      `<div class="fs-bottom">`+
        `<div class="fs-thumbs">${thumbs}</div>`+
        `<div class="fs-count">${s.count} items for sale</div>`+
      `</div>`+
    `</div>`;
  }).join('');
  try { hydrateSellerIdentity(rail); } catch (_e) {}
}
window.buildFeaturedSellers = buildFeaturedSellers;

// r345 — "List 5, get featured" invite card. Signed-in, nothing of theirs on
// the feed, not dismissed in the last 14 days. It hides itself the moment
// their first listing lands in window.PRODUCTS (loadListings re-runs after
// publish), and My Shop's subtitle takes over the count from there.
const SELLER_INVITE_DISMISS_DAYS = 14;
function sellerInviteDismissed() {
  try {
    const raw = localStorage.getItem('tb_seller_invite_v1');
    if (!raw) return false;
    const at = Number(JSON.parse(raw).at || 0);
    return (Date.now() - at) / 86400000 < SELLER_INVITE_DISMISS_DAYS;
  } catch (_e) { return false; }
}
function renderSellerInvite() {
  const host = document.getElementById('sellerInvite');
  if (!host) return;
  const hide = () => { host.style.display = 'none'; host.innerHTML = ''; };
  const u = window.CURRENT_USER;
  if (!u || !window.__listingsLoaded || sellerInviteDismissed()) return hide();
  const mine = featuredSellerStats().get(u.uid);
  if (mine && mine.count > 0) return hide();
  host.innerHTML =
    `<div class="seller-invite-card">`+
      `<div class="seller-invite-copy">`+
        `<strong>List 5 items. Get featured.</strong>`+
        `Sellers with five or more items for sale get a Featured Sellers card on this page. Each listing takes a couple of minutes.`+
      `</div>`+
      `<div class="seller-invite-actions">`+
        `<button type="button" class="bh-sell-cta" data-action="seller-invite-sell">Start selling</button>`+
        `<button type="button" class="bh-sell-x" data-action="seller-invite-dismiss">Not now</button>`+
      `</div>`+
    `</div>`;
  host.style.display = '';
  try {
    if (!host.dataset.tracked) {
      host.dataset.tracked = '1';
      window.posthog && window.posthog.capture('seller_invite_shown', { surface: 'home' });
    }
  } catch (_e) {}
}
window.renderSellerInvite = renderSellerInvite;

// Active filter state. Updated by filter-bar inputs; persisted across renders.
window.__filter = window.__filter || { cat: 'all', sort: 'newest', min: null, max: null, conditions: new Set(), brand: null, q: null };

// ── Phase 4 (r370): Vinted-style browse chips ──────────────────────────────
// One chip key → listing predicate. Club chips read listing.specCategory
// (set by the sell flow's spec pills); legacy club listings without one fall
// back to a title keyword match. "accessories" also gathers balls + headcovers.
// Unknown keys (footer links, saved searches from before r369) still match
// listing.cat, so nothing that used to work stops working.
window.FEED_CHIPS = [['all', 'All'], ['driver', 'Drivers'], ['fairway', 'Fairway Woods'], ['hybrid', 'Hybrids'], ['irons', 'Irons'], ['wedge', 'Wedges'], ['putter', 'Putters'], ['bags', 'Bags'], ['shoes', 'Shoes'], ['apparel', 'Apparel'], ['accessories', 'Accessories']];
const CLUB_WORDS = {
  driver: /\bdrivers?\b/i,
  fairway: /\b(fairway|[3579]\s*-?wood|woods?)\b/i,
  hybrid: /\b(hybrids?|rescue)\b/i,
  irons: /\birons?\b/i,
  wedge: /\bwedges?\b/i,
  putter: /\bputters?\b/i,
};
window.chipMatches = function chipMatches(p, key) {
  if (!key || key === 'all') return true;
  const sc = String(p.specCategory || '');
  const title = String(p.name || p.title || '');
  switch (key) {
    case 'driver': case 'fairway': case 'hybrid': case 'wedge': case 'putter':
      if (sc && sc !== 'other') return sc === key;
      return p.cat === 'clubs' && CLUB_WORDS[key].test(title);
    case 'irons':
      if (sc && sc !== 'other') return sc === 'iron-set' || sc === 'single-iron';
      return p.cat === 'clubs' && CLUB_WORDS.irons.test(title);
    case 'accessories': return p.cat === 'accessories' || p.cat === 'balls' || p.cat === 'headcovers';
    default: return p.cat === key;
  }
};

function applyFilters(list) {
  const f = window.__filter;
  let out = list.slice();
  // Hide blocked sellers' listings from the buyer's view. The Set is
  // hydrated by hydrateBlockedUsers() on auth state change.
  const blocked = (window.CURRENT_USER && window.MY_BLOCKED_UIDS) || null;
  if (blocked && blocked.size) {
    out = out.filter(p => !p.sellerId || !blocked.has(p.sellerId));
  }
  if (f.cat && f.cat !== 'all') out = out.filter(p => window.chipMatches(p, f.cat));
  // r335: free-text search applied to the grid (Enter / "See all").
  if (f.q) {
    const ql = String(f.q).toLowerCase();
    out = out.filter(p => searchHaystack(p).includes(ql));
  }
  if (f.brand) {
    const wanted = String(f.brand).trim().toLowerCase();
    out = out.filter(p => String(p.brand || '').trim().toLowerCase() === wanted);
  }
  if (f.min != null) out = out.filter(p => Number(p.ask || 0) >= f.min);
  if (f.max != null) out = out.filter(p => Number(p.ask || 0) <= f.max);
  if (f.conditions && f.conditions.size > 0) out = out.filter(p => f.conditions.has(p.condition));
  switch (f.sort) {
    case 'price-asc':  out.sort((a, b) => Number(a.ask||0) - Number(b.ask||0)); break;
    case 'price-desc': out.sort((a, b) => Number(b.ask||0) - Number(a.ask||0)); break;
    case 'brand':      out.sort((a, b) => String(a.brand||'').localeCompare(String(b.brand||''))); break;
    case 'discover': {
      // "Discover" mode — pseudo-random shuffle that's stable for the
      // current calendar day, then re-shuffles the next day. Lets the
      // homepage feel fresh without being chaotic on every refresh.
      // Hash = djb2(listing.id + YYYY-MM-DD) so each listing gets a
      // deterministic-per-day sort key.
      const today = new Date();
      const ymd = today.getFullYear() + '-' +
        String(today.getMonth() + 1).padStart(2, '0') + '-' +
        String(today.getDate()).padStart(2, '0');
      const hash = (s) => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return h >>> 0;
      };
      out.sort((a, b) => hash(String(a.id) + ymd) - hash(String(b.id) + ymd));
      break;
    }
    case 'newest':
    default:
      out.sort((a, b) => {
        const at = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
        const bt = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
        return bt - at;
      });
  }
  return out;
}

// Map a free-text condition value (sell-modal options + a few legacy
// labels) to (label, color-class). Returns null when the condition is
// missing/blank so we skip the pill entirely. Case-insensitive match,
// falls back to a neutral gray pill for unknown values.
function conditionBadgeMeta(raw) {
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const k = v.toLowerCase();
  if (k === 'new with tags' || k === 'new')                          return { label: v, cls: 'cond-new' };
  if (k === 'like new' || k === 'excellent')                          return { label: v, cls: 'cond-likenew' };
  if (k === 'very good' || k === 'lightly used' || k === 'good')      return { label: v, cls: 'cond-good' };
  if (k === 'used' || k === 'fair')                                   return { label: v, cls: 'cond-fair' };
  if (k === 'for parts' || k === 'parts')                             return { label: v, cls: 'cond-parts' };
  return { label: v, cls: '' };
}
window.conditionBadgeMeta = conditionBadgeMeta;

// Click a brand label on a listing card to narrow the marketplace to
// just that brand. Pass null to clear the brand filter.
function filterByBrand(brand) {
  window.__filter.brand = brand ? String(brand).trim() : null;
  buildProducts();
  // Scroll the marketplace grid back into view so the user sees the
  // narrowed result set immediately.
  const grid = document.getElementById('productGrid');
  if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.filterByBrand = filterByBrand;

// Render one listing card's HTML. Extracted from buildProducts so the
// category-empty fallback (Part 2) can re-render the full inventory grid
// without duplicating the card markup.
// ── Phase 3 likes: shared heart button (cards, detail, profile grids) ─────
// One markup for every surface. State comes from the `fav` set (my likes) and
// listings.watchlistCount (server-owned, see functions/lib/watch.js). The
// count is omitted at zero — "0 likes" on every card reads as nobody wants it.
window.favButtonHtml = function favButtonHtml(p, extraClass) {
  const id = window.safeId(p.id);
  const liked = fav.has(p.id) || fav.has(String(p.id));
  const n = Math.max(0, Number(p.watchlistCount || 0));
  return `<button type="button" class="fav-btn ${extraClass || ''}${liked ? ' liked' : ''}" data-action="toggle-watch" data-product-id="${window.safeAttr(id)}" aria-pressed="${liked ? 'true' : 'false'}" aria-label="${liked ? 'Unlike' : 'Like'}${n ? ` (${n.toLocaleString()} like${n === 1 ? '' : 's'})` : ''}">` +
    `<span class="fav-ico" aria-hidden="true">${window.ICONS.heart}${window.ICONS.heartFill}</span>` +
    `<span class="fav-count">${n ? n.toLocaleString() : ''}</span></button>`;
};
// Repaint every rendered heart for a listing (grid, detail, more-like-this,
// profile) without rebuilding the feed. count === null keeps the number.
window.paintFav = function paintFav(productId, liked, count) {
  const id = String(productId);
  document.querySelectorAll('.fav-btn[data-product-id]').forEach((btn) => {
    if (String(btn.dataset.productId) !== id) return;
    btn.classList.toggle('liked', !!liked);
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    btn.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
    if (count !== null && count !== undefined) {
      const c = btn.querySelector('.fav-count');
      if (c) c.textContent = count > 0 ? Number(count).toLocaleString() : '';
    }
  });
};

// Phase 4 (r370): one muted "key spec · condition" line under the brand, like
// "Stiff · 10.5° · Very good". Picks the two most useful specs per category.
const FLEX_WORD = { L: 'Ladies', A: 'Senior', R: 'Regular', S: 'Stiff', X: 'X-Stiff' };
function cardSpecLine(p) {
  const sp = p.specs || {};
  const v = (k) => { const x = sp[k]; return x == null ? '' : String(x).trim(); };
  const flex = v('flex') ? (FLEX_WORD[v('flex')] || v('flex')) : '';
  let bits = [];
  switch (String(p.specCategory || '')) {
    case 'driver': case 'fairway': case 'hybrid': bits = [flex, v('loft')]; break;
    case 'iron-set': bits = [(v('setFrom') && v('setTo')) ? `${v('setFrom')}–${v('setTo')}` : '', flex]; break;
    case 'single-iron': bits = [v('ironNumber') ? v('ironNumber') + ' iron' : '', flex]; break;
    case 'wedge': bits = [v('loft'), v('bounce') ? v('bounce') + ' bounce' : '']; break;
    case 'putter': bits = [v('length'), v('headStyle')]; break;
    case 'shoes': bits = [v('size') ? 'US ' + v('size') : '']; break;
    case 'apparel': bits = [v('apparelType'), v('size') ? 'Size ' + v('size') : '']; break;
    case 'bag': bits = [v('bagType') ? v('bagType') + ' bag' : '']; break;
    case 'balls': bits = [/^\d+$/.test(v('quantity')) ? v('quantity') + ' balls' : '']; break;
    case 'headcover': bits = [v('hcType') ? 'Fits ' + v('hcType').toLowerCase() : '']; break;
    case 'accessories': bits = [v('itemType')]; break;
    default: bits = [];
  }
  const cm = window.conditionBadgeMeta ? window.conditionBadgeMeta(p.condition) : null;
  bits.push(cm ? cm.label : (p.condition || ''));
  return bits.filter(Boolean).slice(0, 3).map((b) => window.safeText(b)).join(' · ');
}
window.cardSpecLine = cardSpecLine;

function renderProductCardHtml(p, i) {
  const id = window.safeId(p.id);
  // Stagger fade-in (cap at 12 cards so a long list doesn't drag).
  const delay = Math.min(i, 12) * 30;
  const url = window.variantImgUrl(p, 0, 'w400');
  // r351 thumbnails: browser picks the file for the rendered width (srcset +
  // sizes); first four cards eager + high priority (LCP), the rest carry
  // data-src/data-srcset and are swapped in by window.__thumbLoader.
  const _eager = i < 4;
  const _v = (p.photoVariants && p.photoVariants['0']) || null;
  const _w4 = _v && window.safeImgUrl(_v.w400), _w8 = _v && window.safeImgUrl(_v.w800);
  const _srcset = (_w4 && _w8) ? `${window.safeAttr(_w4)} 400w, ${window.safeAttr(_w8)} 800w` : '';
  const _sizes = '(max-width: 600px) 46vw, 220px';
  const _srcAttr = _eager
    ? `src="${window.safeAttr(_w4 || url)}"${_srcset ? ` srcset="${_srcset}" sizes="${_sizes}"` : ''} loading="eager" fetchpriority="high"`
    : `src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" data-src="${window.safeAttr(_w4 || url)}"${_srcset ? ` data-srcset="${_srcset}" sizes="${_sizes}"` : ''} loading="lazy" fetchpriority="low" class="thumb-deferred"`;
  const mainImg = url
    ? `<img ${_srcAttr} alt="${window.safeAttr(p.name||'')}" decoding="async" />`
    : `<div class="placeholder-art" style="width:100%;height:100%">${window.CATEGORY_ICON(p.cat)}</div>`;
  const soldBadge = p.status === 'sold' ? '<div class="sold-badge">SOLD</div>' : '';
  const badgeCls = p.badge === 'hot' ? 'hot' : (p.badge === 'new' ? 'new' : '');
  const badge = p.badge ? `<span class="product-badge badge-${window.safeAttr(badgeCls)}">${p.badge==='hot'?'Hot':'New'}</span>` : '';
  const photoCount = (p.photos && p.photos.length > 1) ? `<span class="photo-count-badge">${Number(p.photos.length)} photos</span>` : '';
  const idAttr = window.safeAttr(id);
  // Verified / Pro pills stay in the brand row (hydrated from PROFILE_CACHE);
  // seller identity, ratings, view counts and Buy Now live in the detail sheet.
  const sellerVerifiedSlot = p.sellerId
    ? `<span class="seller-verified-slot" data-seller-id="${window.safeAttr(window.safeId(p.sellerId))}"></span>`
    : '';
  const sellerProSlot = p.sellerId
    ? `<span class="seller-pro-slot" data-seller-id="${window.safeAttr(window.safeId(p.sellerId))}"></span>`
    : '';
  const totalQty = Math.max(1, Number(p.quantity || 1));
  const soldQty = Math.max(0, Number(p.quantitySold || 0));
  const remaining = Math.max(0, totalQty - soldQty);
  const stockBadge = totalQty > 1 && p.status !== 'sold'
    ? `<span class="stock-badge">${remaining} in stock</span>`
    : '';
  const spec = cardSpecLine(p);
  return `<div class="product-card ${p.status === 'sold' ? 'sold' : ''}" style="animation-delay:${delay}ms" data-action="open-detail" data-product-id="${idAttr}" aria-label="${window.safeAttr(p.name || '')}">`+
    `<div class="product-img-wrap">${soldBadge}`+
      `${mainImg}`+
      `${badge}`+
      `${stockBadge}`+
      `${photoCount}`+
      `${window.favButtonHtml ? window.favButtonHtml(p, 'card-fav') : ''}`+
    `</div>`+
    `<div class="product-body">`+
      `<div class="product-brand">${p.brand ? `<button type="button" class="brand-link" data-action="filter-by-brand" data-brand="${window.safeAttr(p.brand)}">${window.safeText(p.brand)}</button>` : ''}${sellerProSlot}${sellerVerifiedSlot}</div>`+
      `<div class="product-name"><a class="product-name-link" href="/listing/${idAttr}/">${window.safeText(p.name)}</a></div>`+
      `<div class="product-spec">${spec}</div>`+
      `<div class="product-price"><span class="product-price-val">$${Number(p.ask||0).toLocaleString()}</span></div>`+
    `</div>`+
  `</div>`;
}

// Human-readable category labels, mirroring the cat-bar pills (see the
// .cat-pill buttons in the markup). Used by the category-empty callout.
window.CATEGORY_LABEL = function(cat) {
  return ({
    shoes: 'Shoes',
    clubs: 'Clubs',
    apparel: 'Apparel',
    accessories: 'Accessories',
    bags: 'Bags',
    balls: 'Balls',
    headcovers: 'Headcovers',
    // Phase 4 browse chips
    driver: 'Drivers', fairway: 'Fairway Woods', hybrid: 'Hybrids', irons: 'Irons', wedge: 'Wedges', putter: 'Putters',
  })[cat] || (cat ? String(cat).charAt(0).toUpperCase() + String(cat).slice(1) : '');
};

// "Most Viewed" sidebar widget (replaces the static hero card).
// Shows the top 3 listings by actual views (getListingViews). Fallback chain:
//   - fewer than 3 listings have any views → fill the rest with newest
//   - ZERO listings have any views → show newest 3 under "New Listings"
//   - no listings at all → leave the static value-prop copy untouched
// Reads window.PRODUCTS directly (NOT the filtered list) so the widget is
// stable across category / price / condition filtering. Re-runs on every
// buildProducts() call, so it repopulates whenever PRODUCTS reloads.
// NOTE: views are all-time, not week-scoped — no week-bucketed view data
// exists client-side. Heading reads "Most Viewed" (no time scope) so the
// wording matches what the data actually is. If week-scoped view data is
// added later, update the heading + the viewed sort to match.
//
// r299: this read p.viewCount, which NOTHING writes. Views live in sharded
// counters (views_0..views_9) summed by getListingViews(). The filter below
// therefore always matched zero listings, and this widget has silently shown
// "New Listings" — the fallback — every single time it rendered. 351 views
// across 24 active listings were there to rank on the whole time.
function renderMostViewedWidget() {
  const host = document.getElementById('heroMostViewed');
  if (!host) return;
  const all = (window.PRODUCTS || []).filter(p => p && p.id);
  // Genuinely-empty marketplace — keep the static value-prop copy.
  if (!all.length) return;
  const byNewest = (a, b) => {
    const at = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
    const bt = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
    return bt - at;
  };
  const viewsOf = (p) => (window.getListingViews ? Number(window.getListingViews(p) || 0) : 0);
  const ranked = all
    .filter(p => window.popularityRaw(p) >= window.POPULARITY_MIN_SIGNAL)
    .sort((a, b) => window.popularityScore(b) - window.popularityScore(a));
  // One listing per seller in the top 3. A no-op at today's spread (the
  // uncapped top 3 is already three different sellers) but it stops the
  // front page concentrating on whoever happens to post the most — one
  // seller already holds 7 of 25 active listings.
  const capped = [];
  const sellersSeen = new Set();
  for (const p of ranked) {
    if (capped.length === 3) break;
    const sid = p.sellerId || p.seller || '';
    if (sid && sellersSeen.has(sid)) continue;
    if (sid) sellersSeen.add(sid);
    capped.push(p);
  }
  let picks, heading;
  if (capped.length) {
    heading = 'Trending';
    picks = capped;
    if (picks.length < 3) {
      // Top up with newest listings not already shown.
      const seen = new Set(picks.map(p => p.id));
      const filler = all.filter(p => !seen.has(p.id)).sort(byNewest);
      picks = picks.concat(filler.slice(0, 3 - picks.length));
    }
  } else {
    // Nothing has cleared the engagement floor yet — newest 3, relabelled.
    heading = 'New Listings';
    picks = all.slice().sort(byNewest).slice(0, 3);
  }
  if (!picks.length) return;
  const rows = picks.map(p => {
    const idAttr = window.safeAttr(window.safeId(p.id));
    // r264: was rendering the FULL-SIZE original into a thumbnail slot —
    // 305/260/486KB above the fold on the homepage. Use the w400 variant
    // (variantImgUrl falls back to the original when a listing has none).
    const url = window.variantImgUrl ? window.variantImgUrl(p, 0, 'w400') : window.safeImgUrl(p.photos && p.photos[0]);
    const thumb = url
      ? `<img src="${window.safeAttr(url)}" alt="${window.safeAttr(p.name||'')}" loading="lazy" decoding="async" />`
      : window.CATEGORY_ICON(p.cat);
    const price = Number(p.ask || 0).toLocaleString();
    const cm = window.conditionBadgeMeta(p.condition);
    const cond = cm ? window.safeText(cm.label) : '';
    return `<div class="feat-mv-row" data-action="open-detail" data-product-id="${idAttr}">`+
        `<div class="feat-mv-thumb">${thumb}</div>`+
        `<div class="feat-mv-info">`+
          `<div class="feat-mv-name">${window.safeText(p.name || 'Untitled')}</div>`+
          `<div class="feat-mv-meta">`+
            `<span class="feat-mv-price">$${price}</span>`+
            (cond ? `<span class="feat-mv-cond">${cond}</span>` : '')+
          `</div>`+
        `</div>`+
      `</div>`;
  }).join('');
  host.innerHTML =
    `<div class="feat-mv-head">${window.safeText(heading)}</div>` + rows;
}
window.renderMostViewedWidget = renderMostViewedWidget;

function buildProducts(filter) {
  if (filter !== undefined) window.__filter.cat = filter;
  // Repopulate the hero sidebar widget on every render (covers PRODUCTS
  // reload + initial demo render — both call buildProducts). Reads
  // window.PRODUCTS directly so filtering never narrows it.
  try { renderMostViewedWidget(); } catch (_e) {}
  const all = window.PRODUCTS || [];
  const list = applyFilters(all);
  // Render the active-brand chip in the section header.
  const chipSlot = document.getElementById('activeBrandChipSlot');
  if (chipSlot) {
    const b = window.__filter && window.__filter.brand;
    const q = window.__filter && window.__filter.q;
    chipSlot.innerHTML =
      (q ? `<button class="brand-chip" data-action="clear-search-query" title="Clear search">&ldquo;${window.safeText(q)}&rdquo; <span class="x">✕</span></button>` : '') +
      (b ? `<button class="brand-chip" data-action="clear-brand-filter" title="Clear brand filter">${window.safeText(b)} <span class="x">✕</span></button>` : '');
  }
  // Phase 4: keep the windowed-feed state honest on the empty paths too, so
  // the sentinel hides and a later chip tap starts from a clean list.
  window.__feedList = list; window.__feedShown = 0;
  if (typeof updateFeedSentinel === 'function') updateFeedSentinel();
  if (!list.length) {
    // Distinguish "filters too narrow" from "marketplace genuinely
    // empty" — the latter gets a CTA into the Sell flow so signed-out
    // home doesn't look broken on a fresh install.
    const grid = document.getElementById('productGrid');
    if (!all.length) {
      // r148 cold-load guard: PRODUCTS is [] both while the first listings
      // query is still in flight AND when the marketplace is truly empty —
      // only the second is a real empty state. Until the first query
      // resolves, keep the skeleton up; never flash "No listings yet".
      if (window.__listingsLoaded !== true) {
        if (typeof showProductSkeleton === 'function') showProductSkeleton(8);
        return;
      }
      if (window.__listingsError) {
        grid.innerHTML =
          '<div class="dash-empty" style="grid-column:1/-1;padding:3.5rem 1rem;">'+
            '<div style="font-size:18px;font-weight:600;color:var(--gray-800);margin-bottom:8px;">Couldn&rsquo;t load listings</div>'+
            '<div style="margin-bottom:16px;">Check your connection and try again.</div>'+
            '<button class="btn-primary" data-action="reload-listings" style="padding:10px 22px;font-size:14px;">Retry</button>'+
          '</div>';
      } else {
      grid.innerHTML =
        '<div class="dash-empty" style="grid-column:1/-1;padding:3.5rem 1rem;">'+
          '<div style="font-size:18px;font-weight:600;color:var(--gray-800);margin-bottom:8px;">The marketplace is just getting started</div>'+
          '<div style="margin-bottom:16px;">Be one of the first sellers on TeeBox &mdash; or save a search and we\'ll email you when gear you want is listed.</div>'+
          '<button class="btn-primary" data-action="handle-sell" style="padding:10px 22px;font-size:14px;">List an Item</button>'+
          '<div style="margin-top:10px;font-size:13px;"><a href="#" data-action="save-current-search">Save a search instead</a></div>'+
        '</div>';
      }
    } else {
      // Decide WHY the filtered list is empty. If a category is active
      // while price/condition/brand are all at their defaults, the
      // category itself is the cause — show a "be the first" callout for
      // that category, then fall back to the full cross-category
      // inventory so the page never looks empty. If instead a
      // price/condition/brand sub-filter removed everything, keep the
      // generic "widen your filters" message.
      const f = window.__filter || {};
      // r335: a search with no hits is its own state — say what was searched
      // and offer the one action that helps, not "widen your filters".
      if (f.q) {
        grid.innerHTML =
          '<div class="cat-empty-callout" style="grid-column:1/-1;">'+
            '<div class="cat-empty-title">No results for &ldquo;'+window.safeText(f.q)+'&rdquo;</div>'+
            '<div class="cat-empty-sub">Try a brand, a model, or a category &mdash; or check back soon, new gear lands daily.</div>'+
            '<button class="btn-primary" data-action="clear-search-query" style="padding:10px 22px;font-size:14px;">Clear search</button>'+
            '<div style="margin-top:10px;font-size:13px;"><a href="#" data-action="handle-sell">Have one to sell? List it now</a></div>'+
          '</div>';
        return;
      }
      const catActive = f.cat && f.cat !== 'all';
      const subFiltersDefault =
        (f.min == null) && (f.max == null) &&
        (!f.conditions || f.conditions.size === 0) &&
        !f.brand && !f.q;
      if (catActive && subFiltersDefault) {
        // Re-run the rest of the filter pipeline with the category
        // cleared, FOR DISPLAY ONLY. window.__filter is not mutated, so
        // the active cat-pill UI and subsequent chip clicks are
        // unaffected.
        const savedCat = f.cat;
        f.cat = 'all';
        let crossList = [];
        try { crossList = applyFilters(all); }
        finally { f.cat = savedCat; }
        const catLabel = window.CATEGORY_LABEL(savedCat) || 'items';
        const callout =
          '<div class="cat-empty-callout" style="grid-column:1/-1;">'+
            '<div class="cat-empty-title">No '+window.safeText(catLabel)+' right now.</div>'+
            '<div class="cat-empty-sub">New gear lands daily &mdash; save this search and we\'ll email you the moment '+window.safeText(String(catLabel).toLowerCase())+' are listed.</div>'+
            '<button class="btn-primary" data-action="save-current-search" style="padding:10px 22px;font-size:14px;">Save this search</button>'+
            '<div style="margin-top:10px;font-size:13px;"><a href="#" data-action="handle-sell">Have '+window.safeText(String(catLabel).toLowerCase())+' to sell? List them now</a></div>'+
          '</div>';
        if (crossList.length) {
          const heading =
            '<div class="cat-empty-divider" style="grid-column:1/-1;">Latest from across TeeBox</div>';
          grid.innerHTML = callout + heading +
            crossList.map((p, i) => renderProductCardHtml(p, i)).join('');
          // Hydrate the cross-category cards same as the normal grid.
          hydrateVerifiedSellerPills(grid);
          hydrateSellerProPills(grid);
          hydrateSellerRatings(grid);
          hydrateSellerIdentity(grid);
        } else {
          grid.innerHTML = callout;
        }
        return;
      }
      grid.innerHTML =
        '<div class="dash-empty" style="grid-column:1/-1"><div style="font-weight:600;color:var(--gray-700);margin-bottom:6px">No listings match your filters</div>Try widening the price range or clearing conditions.</div>';
    }
    return;
  }
  // Phase 4 (r370): windowed render — first FEED_PAGE cards now, the rest
  // appended as #feedSentinel scrolls into view (and more pages fetched by
  // cursor when the in-memory list runs out). Keeps 100+ listings smooth on
  // a mid-range phone: fewer nodes up front, lazy thumbs, content-visibility.
  window.__feedList = list;
  window.__feedShown = 0;
  document.getElementById('productGrid').innerHTML = '';
  appendFeedCards(FEED_PAGE);
}

const FEED_PAGE = 24;
window.__feedList = []; window.__feedShown = 0; window.__feedFetching = false;
function hydrateGridCards(root) {
  // Async hydrate verified-seller + Pro pills inside listing cards (Feature #3).
  hydrateVerifiedSellerPills(root);
  hydrateSellerProPills(root);
  hydrateSellerRatings(root);
  hydrateSellerIdentity(root);
}
function appendFeedCards(n) {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  const list = window.__feedList || [];
  const from = window.__feedShown, to = Math.min(list.length, from + n);
  if (to > from) {
    const frag = document.createElement('div');
    frag.innerHTML = list.slice(from, to).map((p, i) => renderProductCardHtml(p, from + i)).join('');
    const added = Array.from(frag.children);
    added.forEach((el) => grid.appendChild(el));
    window.__feedShown = to;
    // Hydrate only the new cards' slots (the hydrators walk a root element).
    const tmpRoot = { querySelectorAll: (sel) => added.flatMap((el) => Array.from(el.querySelectorAll(sel))) };
    try { hydrateGridCards(tmpRoot); } catch (_e) {}
  }
  updateFeedSentinel();
}
function updateFeedSentinel() {
  const s = document.getElementById('feedSentinel');
  if (!s) return;
  const list = window.__feedList || [];
  const more = window.__feedShown < list.length ||
    (window.__feedHasMore === true && typeof window.fetchMoreListings === 'function');
  s.hidden = !more;
}
async function growFeed() {
  const list = window.__feedList || [];
  if (window.__feedShown < list.length) { appendFeedCards(FEED_PAGE); return; }
  if (window.__feedHasMore !== true || window.__feedFetching || typeof window.fetchMoreListings !== 'function') { updateFeedSentinel(); return; }
  const s = document.getElementById('feedSentinel');
  window.__feedFetching = true;
  if (s) s.classList.add('loading');
  try {
    const added = await window.fetchMoreListings();
    if (added > 0) {
      // Re-run the active filters over the grown catalogue, but keep the cards
      // already on screen in place (no reflow); only unseen items are appended.
      const fresh = applyFilters(window.PRODUCTS || []);
      const shown = (window.__feedList || []).slice(0, window.__feedShown);
      const shownIds = new Set(shown.map((p) => String(p.id)));
      window.__feedList = [...shown, ...fresh.filter((p) => !shownIds.has(String(p.id)))];
      appendFeedCards(FEED_PAGE);
    }
  } catch (_e) { /* sentinel just hides below */ }
  finally {
    window.__feedFetching = false;
    if (s) s.classList.remove('loading');
    updateFeedSentinel();
  }
}
window.growFeed = growFeed;
(function initFeedSentinel() {
  const s = document.getElementById('feedSentinel');
  if (!s) return;
  if (!('IntersectionObserver' in window)) { s.hidden = true; return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) growFeed();
  }, { rootMargin: '700px 0px' });
  io.observe(s);
})();

// Walk a container, find all .seller-verified-slot[data-seller-id] elements,
// dedupe by sellerId, look up profiles (cached via PROFILE_CACHE), and inject
// the small "Verified" pill where applicable. Best-effort, never throws.
async function hydrateVerifiedSellerPills(rootEl) {
  if (!rootEl) return;
  const slots = rootEl.querySelectorAll('.seller-verified-slot[data-seller-id]');
  if (!slots.length) return;
  const bySeller = new Map();
  slots.forEach(slot => {
    const sid = slot.getAttribute('data-seller-id');
    if (!sid) return;
    if (!bySeller.has(sid)) bySeller.set(sid, []);
    bySeller.get(sid).push(slot);
  });
  // Resolve each unique seller in parallel; loadProfile already de-dupes via cache.
  const tasks = Array.from(bySeller.keys()).map(async sid => {
    try {
      const prof = await loadProfile(sid);
      // r161: badge = Stripe KYC (public chargesReady mirror), never the
      // ToS-agreement placeholder — the tooltip claim must be strictly true.
      const verified = !!(prof && prof.chargesReady === true);
      if (!verified) return;
      bySeller.get(sid).forEach(slot => {
        slot.innerHTML = (' ' + window.VERIFIED_BADGE);
        // Feature #3: tag the parent product card so the gold ribbon CSS
        // kicks in. Walk up to the closest .product-card — the slot lives
        // inside .product-brand inside .product-body inside .product-card.
        const card = slot.closest('.product-card');
        if (card) card.classList.add('verified-card');
      });
    } catch (_e) { /* ignore */ }
  });
  await Promise.allSettled(tasks);
}

// Walk a container, find all .seller-pro-slot[data-seller-id] elements,
// dedupe by sellerId, look up profiles (cached via PROFILE_CACHE), and
// inject the small "PRO" pill where applicable. Best-effort, never throws.
async function hydrateSellerProPills(rootEl) {
  if (!rootEl) return;
  const slots = rootEl.querySelectorAll('.seller-pro-slot[data-seller-id]');
  if (!slots.length) return;
  const bySeller = new Map();
  slots.forEach(slot => {
    const sid = slot.getAttribute('data-seller-id');
    if (!sid) return;
    if (!bySeller.has(sid)) bySeller.set(sid, []);
    bySeller.get(sid).push(slot);
  });
  const tasks = Array.from(bySeller.keys()).map(async sid => {
    try {
      const prof = await loadProfile(sid);
      const isPro = !!(prof && prof._user && prof._user.isPro);
      if (!isPro) return;
      bySeller.get(sid).forEach(slot => {
        slot.innerHTML = ' <span class="pro-pill sm" title="Pro Seller">Pro</span>';
      });
    } catch (_e) { /* ignore */ }
  });
  await Promise.allSettled(tasks);
}

// Walk a container, find all .seller-rating-slot[data-seller-id] elements,
// dedupe by sellerId, and inject a ★ avg (count) row pulled from the
// profile aggregate (avgRating + reviewCount fields, written by the
// `onReviewWrite` Cloud Function). No aggregate = no rating; there is
// deliberately no per-seller query fallback. Slots stay empty for sellers
// with 0 reviews — the `:empty` CSS rule hides them so cards don't get
// a stray gap. Best-effort, never throws.
async function hydrateSellerRatings(rootEl) {
  if (!rootEl) return;
  const slots = rootEl.querySelectorAll('.seller-rating-slot[data-seller-id]');
  if (!slots.length) return;
  const bySeller = new Map();
  slots.forEach(slot => {
    const sid = slot.getAttribute('data-seller-id');
    if (!sid) return;
    if (!bySeller.has(sid)) bySeller.set(sid, []);
    bySeller.get(sid).push(slot);
  });
  const tasks = Array.from(bySeller.keys()).map(async sid => {
    try {
      const prof = await loadProfile(sid);
      const count = (prof && typeof prof.reviewCount === 'number') ? prof.reviewCount : 0;
      const avg = (prof && typeof prof.avgRating === 'number') ? prof.avgRating : 0;
      // r325: NO per-seller reviews query. The fallback that used to run here
      // fired for essentially every seller — 444 of 446 profile docs carry
      // neither reviewCount nor avgRating — and then rendered nothing anyway,
      // because the whole reviews collection holds one document. That was ten
      // of the twenty-four Firestore reads on a cold home load, all discarded.
      // No aggregate on the profile = no rating to show. When reviews exist,
      // onReviewWrite is what must put the aggregate on profiles/{uid}.
      if (!count || count <= 0) return;
      const html = `<span class="pr-star">★</span> ${Number(avg).toFixed(1)} <span class="pr-count">(${Number(count)})</span>`;
      bySeller.get(sid).forEach(slot => { slot.innerHTML = html; });
    } catch (_e) { /* ignore */ }
  });
  await Promise.allSettled(tasks);
}

// ─────────────────────────────────────────────────────────────
// TENURED SELLER BADGES
//   Lightweight social-proof pill that summarises a seller's
//   tenure on TeeBox using the server-aggregated salesCount /
//   avgRating / reviewCount on profiles/{uid} plus account age
//   (createdAt). Tier thresholds are intentionally conservative
//   so the highest tier ("Top-rated") feels earned.
//
//   Tier ladder (each later tier supersedes the prior):
//     - new       — < 3 sales AND < 14 days old
//     - active    — 3+ sales OR 14+ days old (default)
//     - trusted   — 10+ sales, avgRating ≥ 4.5, 30+ days old
//     - top_rated — 50+ sales, avgRating ≥ 4.8, 90+ days old
// ─────────────────────────────────────────────────────────────
window.TENURE_TIERS = {
  new: {
    label: 'New seller',
    cls: 'tenure-new',
    blurb: 'Account < 14 days old with fewer than 3 completed sales.',
  },
  active: {
    label: 'Active seller',
    cls: 'tenure-active',
    blurb: 'Established seller with completed sales or 14+ days on TeeBox.',
  },
  trusted: {
    label: 'Trusted seller',
    cls: 'tenure-trusted',
    blurb: '10+ sales, average rating ≥ 4.5, 30+ days on TeeBox.',
  },
  top_rated: {
    label: 'Top-rated',
    cls: 'tenure-top_rated',
    blurb: '50+ sales, average rating ≥ 4.8, 90+ days on TeeBox.',
  },
};

// Shared shield-with-checkmark glyph used inside every tenure pill.
// Tiny (~11px) so it sits flush with text — colour is currentColor so
// each tier's background palette controls it via CSS.
window.TENURE_ICON_SVG = '<svg class="tenure-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2.2 2.2L15 10"/></svg>';

// Pull a Date out of either profiles/{uid}.createdAt or users/{uid}.createdAt.
// Falls back to null when neither field is present or parseable.
function tenureCreatedDate(profile) {
  if (!profile) return null;
  const candidates = [
    profile.createdAt,
    profile._user && profile._user.createdAt,
  ];
  for (const v of candidates) {
    if (!v) continue;
    if (v.toDate && typeof v.toDate === 'function') {
      try { return v.toDate(); } catch (_e) { /* fall through */ }
    }
    if (v.seconds) {
      try { return new Date(v.seconds * 1000); } catch (_e) { /* fall through */ }
    }
    if (typeof v === 'number') return new Date(v);
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
    if (v instanceof Date && !isNaN(v.getTime())) return v;
  }
  return null;
}

// Human-readable "Joined Apr 2026" string. Returns null when no date.
function tenureJoinedLabel(profile) {
  const d = tenureCreatedDate(profile);
  if (!d) return null;
  return 'Joined ' + d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Returns one of 'new' | 'active' | 'trusted' | 'top_rated' | null.
// Pure function — no DOM, no async. Easy to unit-test.
function sellerTenureTier(profile) {
  if (!profile) return null;
  const sales = (typeof profile.salesCount === 'number') ? profile.salesCount : 0;
  const avg   = (typeof profile.avgRating  === 'number') ? profile.avgRating  : 0;
  const reviews = (typeof profile.reviewCount === 'number') ? profile.reviewCount : 0;
  const created = tenureCreatedDate(profile);
  // Without ANY signal (no sales, no rating, no createdAt) we have
  // nothing to show — return null and the badge slot stays empty.
  if (!sales && !avg && !reviews && !created) return null;
  const ageDays = created
    ? Math.max(0, (Date.now() - created.getTime()) / 86400000)
    : 0;
  if (sales >= 50 && avg >= 4.8 && ageDays >= 90) return 'top_rated';
  if (sales >= 10 && avg >= 4.5 && ageDays >= 30) return 'trusted';
  if (sales < 3 && ageDays < 14) return 'new';
  return 'active';
}
window.sellerTenureTier = sellerTenureTier;
window.tenureCreatedDate = tenureCreatedDate;
window.tenureJoinedLabel = tenureJoinedLabel;

// Build the inner HTML for a tenure pill. `variant`:
//   - 'card'   — compact, used inside listing-card brand row.
//                Drops the tier label when sales >= 3 to save room.
//   - 'detail' — listing-detail / inline placements. Shows tier label
//                + sales/rating when ≥ 3 sales.
//   - 'block'  — large variant for the seller profile page.
function tenurePillHtml(profile, variant) {
  const tier = sellerTenureTier(profile);
  if (!tier) return '';
  const meta = window.TENURE_TIERS[tier];
  if (!meta) return '';
  const sales = (typeof profile.salesCount === 'number') ? profile.salesCount : 0;
  const avg   = (typeof profile.avgRating  === 'number') ? profile.avgRating  : 0;
  const sm = variant === 'card' ? ' sm' : '';
  let inner;
  if (variant === 'card') {
    // Tighten content on the busy listing-card brand row.
    if (sales >= 3) {
      const ratingPart = avg ? ' · ' + avg.toFixed(1) + '★' : '';
      inner = sales + ' sales' + ratingPart;
    } else {
      inner = meta.label;
    }
  } else {
    if (tier === 'trusted' || tier === 'top_rated') {
      const ratingPart = avg ? ' · ' + avg.toFixed(2).replace(/0$/,'') + '★' : '';
      inner = meta.label + ' · ' + sales + ' sales' + ratingPart;
    } else if (sales >= 3) {
      const ratingPart = avg ? ' · ' + avg.toFixed(1) + '★' : '';
      inner = meta.label + ' · ' + sales + ' sales' + ratingPart;
    } else {
      inner = meta.label;
    }
  }
  // Tooltip shows the requirements for this tier — works on desktop
  // hover and is read by screen readers via aria-label.
  const titleAttr = window.safeAttr(meta.label + ': ' + meta.blurb);
  const ariaLabel = window.safeAttr(meta.label + '. ' + meta.blurb);
  return '<span class="tenure-pill ' + meta.cls + sm + '" title="' + titleAttr + '" aria-label="' + ariaLabel + '">'
       + window.TENURE_ICON_SVG
       + '<span>' + window.safeText(inner) + '</span>'
       + '</span>';
}
window.tenurePillHtml = tenurePillHtml;

// Walk a container, find all .seller-tenure-slot[data-seller-id] elements,
// dedupe by sellerId, look up profiles (cached via PROFILE_CACHE), and
// inject the tenure pill + (when applicable) a "Joined …" caption.
// Mirrors hydrateSellerProPills so async hydration is consistent across
// the three pill types we render on listing cards.
async function hydrateSellerTenurePills(rootEl) {
  if (!rootEl) return;
  const slots = rootEl.querySelectorAll('.seller-tenure-slot[data-seller-id]');
  if (!slots.length) return;
  const bySeller = new Map();
  slots.forEach(slot => {
    const sid = slot.getAttribute('data-seller-id');
    if (!sid) return;
    if (!bySeller.has(sid)) bySeller.set(sid, []);
    bySeller.get(sid).push(slot);
  });
  const tasks = Array.from(bySeller.keys()).map(async sid => {
    try {
      const prof = await loadProfile(sid);
      if (!prof) return;
      const variant = 'card';
      const pill = tenurePillHtml(prof, variant);
      const sales = (typeof prof.salesCount === 'number') ? prof.salesCount : 0;
      // Listing-card display rule from spec: when fewer than 3 sales
      // we surface the join date instead of a stats line. The pill
      // itself still shows so buyers see the tier color cue.
      const joinedLine = (sales < 3) ? tenureJoinedLabel(prof) : null;
      bySeller.get(sid).forEach(slot => {
        let html = pill ? (' ' + pill) : '';
        if (joinedLine) {
          // Render the "Joined …" caption as a sibling line so it
          // doesn't push the pill out of the brand row. The card
          // CSS targets a sibling .seller-meta-line element.
          const card = slot.closest('.product-card');
          if (card) {
            const body = card.querySelector('.product-body');
            if (body && !body.querySelector('.seller-meta-line')) {
              const line = document.createElement('div');
              line.className = 'seller-meta-line';
              line.textContent = joinedLine;
              // Insert just after the brand row.
              const brand = body.querySelector('.product-brand');
              if (brand && brand.nextSibling) {
                body.insertBefore(line, brand.nextSibling);
              } else {
                body.appendChild(line);
              }
            }
          }
        }
        slot.innerHTML = html;
      });
    } catch (_e) { /* ignore */ }
  });
  await Promise.allSettled(tasks);
}
window.hydrateSellerTenurePills = hydrateSellerTenurePills;

// Walk a container, find all .seller-id-slot[data-seller-id] elements, dedupe by
// sellerId, look up profiles (cached via PROFILE_CACHE — so this adds ZERO
// fetches beyond the pill/rating hydrators already running), and inject a
// compact avatar + name into each card. Reuses avatarHtml + hydrateAvatars.
// Stale-guard: skips detached slots so a fast scroll / grid re-render mid-fetch
// can't paint a seller's face onto the wrong (recycled) card. Slots are keyed
// by data-seller-id and we load THAT seller's profile, so there's no cross-card
// mismatch even before the isConnected check.
async function hydrateSellerIdentity(rootEl) {
  if (!rootEl) return;
  const slots = rootEl.querySelectorAll('.seller-id-slot[data-seller-id]');
  if (!slots.length) return;
  const bySeller = new Map();
  slots.forEach(slot => {
    const sid = slot.getAttribute('data-seller-id');
    if (!sid) return;
    if (!bySeller.has(sid)) bySeller.set(sid, []);
    bySeller.get(sid).push(slot);
  });
  const tasks = Array.from(bySeller.keys()).map(async sid => {
    try {
      const prof = await loadProfile(sid);
      if (!prof) return;
      const name = window.safeText(prof.displayName || 'Seller');
      const av = (typeof avatarHtml === 'function') ? avatarHtml(prof) : '';
      bySeller.get(sid).forEach(slot => {
        // Stale-guard: the grid may have re-rendered while we awaited the
        // profile — old slots are detached. Don't paint into a dead node.
        if (!slot.isConnected) return;
        slot.innerHTML =
          `<span class="card-seller-avatar">${av}</span>` +
          `<span class="card-seller-name">${name}</span>`;
        if (typeof hydrateAvatars === 'function') hydrateAvatars(slot);
      });
    } catch (_e) { /* ignore */ }
  });
  await Promise.allSettled(tasks);
}
window.hydrateSellerIdentity = hydrateSellerIdentity;

function buildDrops() {
  const gridEl = document.getElementById('dropsGrid');
  const sectionEl = gridEl && gridEl.closest('.section');
  if (!DROPS.length) {
    // No curated drops to show — hide the entire "Upcoming Drops"
    // section. It'll come back when curators populate the array.
    if (sectionEl) sectionEl.style.display = 'none';
    if (gridEl) gridEl.innerHTML = '';
    return;
  }
  if (sectionEl) sectionEl.style.display = '';
  gridEl.innerHTML = DROPS.map(d=>{
    const banner = d.img
      ? `<div class="drop-banner" style="background-image:url('${window.safeAttr(d.img)}');background-size:cover;background-position:center">`
      : `<div class="drop-banner"><span class="drop-emoji">${window.CATEGORY_ICON(d.cat)}</span>`;
    return `<div class="drop-card">`+
      banner+
        `<span class="drop-countdown">${window.safeText(d.countdown)}</span>`+
      `</div>`+
      `<div class="drop-body">`+
        `<div class="drop-label">${window.safeText(d.label)}</div>`+
        `<div class="drop-name">${window.safeText(d.name)}</div>`+
        `<div class="drop-desc">${window.safeText(d.desc)}</div>`+
        `<div class="drop-footer">`+
          `<div><div class="drop-price-lbl">Starting At</div><div class="drop-price">${window.safeText(d.price)}</div></div>`+
          `<button class="drop-btn">${window.safeText(d.btnTxt)}</button>`+
        `</div>`+
      `</div>`+
    `</div>`;
  }).join('');
}

function filterCat(el,cat) {
  document.querySelectorAll('.cat-pill').forEach(p=>p.classList.remove('active'));
  // Mark every pill for this category active — the cat-bar pill and the
  // search-overlay chip (r163) both carry data-cat, and whichever surface
  // is visible should reflect the current filter regardless of which one
  // (or a footer link) triggered it.
  if (el && el.classList && el.classList.contains('cat-pill')) {
    el.classList.add('active');
  }
  document.querySelectorAll('.cat-pill[data-cat="' + cat + '"]').forEach(p => p.classList.add('active'));
  buildProducts(cat);
}

// ── DETAIL MODAL ──
let currentDetailId = null;
function injectListingJsonLd(p) {
  // Schema.org Product + Offer markup. Helps Google show rich snippets +
  // makes us eligible for the Shopping graph. Removed when modal closes
  // so we never have two listings worth of LD on the page at once.
  try {
    const old = document.getElementById('ldListing');
    if (old) old.remove();
    const photo0 = (p.photos && p.photos[0]) || (p.photo) || null;
    const ld = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": String(p.name || p.title || 'Listing'),
      "description": String(p.desc || '').slice(0, 500),
      "brand": p.brand ? { "@type": "Brand", "name": String(p.brand) } : undefined,
      "category": p.cat || undefined,
      "image": photo0 ? [String(photo0)] : undefined,
      "offers": {
        "@type": "Offer",
        "url": "https://teeboxmarket.com/?listing=" + encodeURIComponent(String(p.id)),
        "priceCurrency": "USD",
        "price": String(Number(p.ask || 0)),
        "availability": p.status === 'sold' ? "https://schema.org/SoldOut" : (p.status === 'pending' ? "https://schema.org/PreOrder" : "https://schema.org/InStock"),
        "itemCondition": "https://schema.org/UsedCondition"
      }
    };
    const s = document.createElement('script');
    s.type = 'application/ld+json';
    s.id   = 'ldListing';
    s.textContent = JSON.stringify(ld);
    document.head.appendChild(s);
  } catch (_e) { /* JSON-LD is best-effort */ }
}
function removeListingJsonLd() {
  const old = document.getElementById('ldListing');
  if (old) old.remove();
}
// r156: fetch fallback for listings outside the 200-item feed cache. A
// SHARED link is disproportionately an older/sold listing — exactly the ones
// not in cache — so without this the links people share are the ones that
// die. Mirrors the feed's normalization ({id, name: title, ...data}) and its
// visibility rules, EXCEPT sold stays viewable (detail already renders the
// locked 'Sold' state; a shared sold listing should open, not 404).
window.__fetchListingForDetail = async function(id) {
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const snap = await getDoc(doc(getFirestore(), 'listings', String(id)));
    if (!snap.exists()) return null;
    const d = snap.data();
    if (['removed', 'flagged', 'expired'].includes(String(d.status || ''))) return null;
    if (!Array.isArray(d.photos) || !d.photos.length) return null;
    return { id: snap.id, name: d.title, ...d };
  } catch (_e) { return null; }
};
async function openDetailModal(id) {
  let p = window.PRODUCTS.find(x=>String(x.id)===String(id));
  if (!p) {
    p = await window.__fetchListingForDetail(id);
    if (!p) {
      if (window.showToast) window.showToast('This listing is no longer available.');
      return;
    }
    // Seed the cache so every downstream flow (buy, message, share) that
    // resolves by id finds it.
    if (!window.PRODUCTS.some(x => String(x.id) === String(p.id))) window.PRODUCTS.push(p);
  }
  currentDetailId = id;
  // r262: a seller looking at a listing is one tap from Buy Now — warm
  // Stripe.js here so the lazy load never costs the buyer a wait. Idle warm
  // above can no-op (auth may not have resolved yet); this is the reliable
  // signal. Fire-and-forget: checkout awaits the same promise anyway.
  try { if (typeof loadStripeJs === 'function') loadStripeJs().catch(() => {}); } catch (_e) {}
  injectListingJsonLd(p);
  // Meta Pixel: product view (guarded — fbq is web-only; no PII).
  window.fbTrack && window.fbTrack('ViewContent', { content_ids: [String(p.id)], content_type: 'product', value: Number(p.ask || 0), currency: 'USD' });
  // Feature #12: best-effort view counter via Cloud Function. Non-blocking,
  // never breaks the modal. Only fires for real (Firestore) listings, and
  // skips owner self-views to avoid inflating their own counter.
  // r349 (P1-6): incrementListingView requires a signed-in caller and
  // answered every guest open with a 401. Guests skip the call; signed-in
  // non-owners still count. (Counting guest views needs an unauthenticated,
  // IP-rate-limited variant of the callable — a functions change, not done here.)
  if (typeof p.id === 'string' && p.sellerId
      && window.CURRENT_USER && window.CURRENT_USER.uid !== p.sellerId) {
    (async () => {
      try {
        const { getFunctions, httpsCallable } =
          await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
        const fns = getFunctions();
        const inc = httpsCallable(fns, 'incrementListingView');
        await inc({ listingId: String(p.id) });
      } catch (_e) { /* swallow — view counter is best-effort */ }
    })();
  }
  // Analytics: priority event #3 — `listing_viewed`. Fires EVERY open
  // (not subject to the 24h dedupe that gates the view-counter
  // callable above) because analytics needs the raw stream. Skips
  // owner self-views for parity with the counter. Demo (numeric-id)
  // listings still count — they're the homepage feed and a buyer
  // engaging with them is a real funnel signal. NOT mirrored
  // server-side (would require a Firestore write for every view).
  try {
    if (window.posthog && (!window.CURRENT_USER ||
        !p.sellerId || window.CURRENT_USER.uid !== p.sellerId)) {
      window.posthog.capture('listing_viewed', {
        listingId: String(p.id),
        sellerId: p.sellerId || null,
        cat: p.cat || null,
        askCents: Math.round(Number(p.ask || 0) * 100),
      });
    }
  } catch (_e) { /* never block modal open on analytics */ }
  document.getElementById('detailBrand').textContent = p.brand;
  document.getElementById('detailName').textContent = p.name;
  // Detail condition badge — color-code via conditionBadgeMeta to match
  // the listing-card pills. Wipe stray classes from a prior listing so a
  // re-open with a different condition doesn't keep the old tint.
  const detailCondEl = document.getElementById('detailCondition');
  detailCondEl.className = 'detail-condition';
  if (p.condition) {
    const meta = conditionBadgeMeta(p.condition);
    detailCondEl.textContent = meta ? meta.label : p.condition;
    if (meta && meta.cls) {
      // `.detail` keeps the pill STATIC/inline in the info column — without it
      // the shared `.cond-pill` (position:absolute, for card corners) makes the
      // badge float over the gallery/header seam on the detail sheet.
      detailCondEl.classList.add('cond-pill', 'detail', meta.cls);
    }
    detailCondEl.style.display = '';
  } else {
    detailCondEl.textContent = '';
    detailCondEl.style.display = 'none';
  }
  document.getElementById('detailAsk').textContent = '$'+(p.ask||0).toLocaleString();
  // Structure 2: buyer-paid shipping line under the price. Flat tiers are
  // mirrored from the server map (display only — the charge always comes
  // from the server); clubs/bags get a live carrier quote at checkout.
  const _shipNoteEl = document.getElementById('detailShipNote');
  if (_shipNoteEl) {
    const _tier = (window.FLAT_SHIPPING_DOLLARS_BY_CAT || {})[String(p.cat || '').toLowerCase()];
    _shipNoteEl.textContent = Number.isFinite(_tier)
      ? `+ $${_tier} shipping`
      : 'Shipping calculated at checkout';
  }
  document.getElementById('detailDesc').textContent = p.desc || 'No description provided.';
  // Listing v2: structured spec table (r257). Legacy listings without
  // specs show the owner a complete-your-specs nudge instead.
  try {
    let specHost = document.getElementById('detailSpecs');
    if (!specHost) {
      specHost = document.createElement('div');
      specHost.id = 'detailSpecs';
      const descEl = document.getElementById('detailDesc');
      descEl.parentNode.insertBefore(specHost, descEl.nextSibling);
    }
    const entries = Object.entries(p.specs || {}).filter(([, v]) => v != null && String(v).trim() !== '');
    const ownerNoSpecs = window.CURRENT_USER && p.sellerId === window.CURRENT_USER.uid && !p.specCategory;
    if (entries.length) {
      const order = ['brand', 'model', 'loft', 'ironNumber', 'setFrom', 'setTo', 'bounce', 'grind', 'length', 'headStyle', 'shaftBrand', 'shaftModel', 'shaftType', 'flex', 'dexterity', 'lieLength', 'grip', 'headcover', 'bagType', 'apparelType', 'hcType', 'itemType', 'size', 'quantity'];
      entries.sort((a, b) => { const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
      specHost.innerHTML = '<div class="spec-table">' + entries.map(([k, v]) =>
        `<div class="spec-row"><span class="spec-k">${window.safeText((window.SPEC_LABELS || {})[k] || k)}</span><span class="spec-v">${window.safeText(String(v))}</span></div>`).join('') + '</div>';
    } else if (ownerNoSpecs) {
      specHost.innerHTML = '<div class="spec-nudge">Complete your specs — buyers filter by them. Tap <strong>Edit listing</strong> above, pick a category, and fill in the details.</div>';
    } else {
      specHost.innerHTML = '';
    }
  } catch (_e) { /* spec table never blocks the modal */ }

  // Reflect listing status in the action buttons.
  const buyBtn  = document.getElementById('detailBuyNowBtn');
  const msgBtn  = document.querySelector('.btn-message-seller');
  const isSold     = p.status === 'sold';
  const isPending  = window.isListingPendingNow ? window.isListingPendingNow(p) : (p.status === 'pending');
  // You can't buy your own listing. Show a clear, non-buyable state on the
  // owner's own item rather than a button that no-ops (the server also rejects
  // self-purchase at createPaymentIntent, and openCheckout has a toast guard).
  const isOwnListing = !!(window.CURRENT_USER && p.sellerId && p.sellerId === window.CURRENT_USER.uid);
  const locked = isSold || isPending || isOwnListing;
  const lockable = [buyBtn].filter(Boolean);
  lockable.forEach(b => {
    b.disabled = locked;
    b.style.opacity = locked ? '0.45' : '';
    b.style.cursor  = locked ? 'not-allowed' : '';
  });
  if (buyBtn) buyBtn.textContent = isSold ? 'Sold' : (isPending ? 'Sale Pending' : (isOwnListing ? 'This is your listing' : 'Buy Now'));
  if (msgBtn) {
    // Messaging always allowed on others' listings (sold/pending included —
    // buyers ask about relists, sellers answer). r151: hidden on your OWN
    // listing instead of failing with a post-tap "can't message yourself".
    msgBtn.disabled = false;
    msgBtn.style.display = isOwnListing ? 'none' : '';
  }
  // Make Offer — same visibility rules as Buy Now: hidden on your own
  // listing, on sold/pending items, and on demo listings (no real id).
  const makeOfferBtn = document.getElementById('detailMakeOfferBtn');
  if (makeOfferBtn) {
    const offerable = !locked && typeof p.id === 'string' && !!p.sellerId;
    makeOfferBtn.style.display = offerable ? '' : 'none';
  }
  // Reset the not-buyable note on every open; the async seller-profile check
  // (below, in loadProfile().then) re-shows it when the seller isn't
  // charges-ready (visible-but-not-buyable, list-first).
  const notBuyableNote = document.getElementById('detailNotBuyableNote');
  if (notBuyableNote) { notBuyableNote.style.display = 'none'; notBuyableNote.textContent = ''; }
  if (buyBtn) { delete buyBtn.dataset.notifySetup; buyBtn.classList.remove('is-notify-setup'); }
  // Owner-only "Edit listing" link. Visible ONLY when a user is
  // signed in AND owns this (real, Firestore-backed) listing. Hidden
  // for guests, other users, and demo listings. Locked listings
  // (sold/pending) still show it — the openEditListing UI guard +
  // updateListing callable surface the friendly "locked" message
  // rather than us silently hiding the affordance.
  const editLink = document.getElementById('detailEditListingBtn');
  if (editLink) {
    const ownsThis = !!(window.CURRENT_USER && p.sellerId &&
      window.CURRENT_USER.uid === p.sellerId && typeof p.id === 'string');
    if (ownsThis) {
      editLink.dataset.listingId = String(p.id);
      editLink.style.display = '';
    } else {
      editLink.style.display = 'none';
      delete editLink.dataset.listingId;
    }
  }
  // Multi-quantity selector — only shown when listing has >1 in stock.
  const qtyRow = document.getElementById('detailQtyRow');
  const qtyInput = document.getElementById('detailQty');
  const qtyRemaining = document.getElementById('detailQtyRemaining');
  const totalQty = Math.max(1, Number(p.quantity || 1));
  const soldQty  = Math.max(0, Number(p.quantitySold || 0));
  const remaining = Math.max(0, totalQty - soldQty);
  if (totalQty > 1 && remaining > 0 && !isSold && !isPending) {
    qtyRow.style.display = '';
    qtyInput.max = String(remaining);
    qtyInput.value = '1';
    qtyRemaining.textContent = `${remaining} in stock`;
  } else {
    qtyRow.style.display = 'none';
  }
  // Render seller link if this is a real (Firestore) listing
  const sellerEl = document.getElementById('detailSeller');
  sellerEl.innerHTML = '';
  if (p.sellerId) {
    // Stale-guard: capture which listing we opened with so a fast detail switch
    // while the profile loads can't paint the wrong seller's face/name.
    const _openedDetailId = currentDetailId;
    const _uidAttr = window.safeAttr(window.safeId(p.sellerId));
    // Avatar + name row (was a buried 13px "View seller profile" link). Tappable
    // → openProfile. Initials placeholder until the profile resolves.
    sellerEl.innerHTML =
      `<button class="seller-id-row" type="button" data-action="open-profile" data-uid="${_uidAttr}" aria-label="View seller profile">`+
        `<span class="seller-id-avatar">?</span>`+
        `<span class="seller-id-text">`+
          `<span class="seller-id-name">Seller</span>`+
          `<span class="seller-id-meta"></span>`+
        `</span>`+
        `<span class="seller-id-chevron" aria-hidden="true">&rsaquo;</span>`+
      `</button>`;
    loadProfile(p.sellerId).then((prof) => {
      // Bail if the user opened a different listing while we were loading.
      if (currentDetailId !== _openedDetailId) return;
      if (!prof) return;
      const row = sellerEl.querySelector('.seller-id-row');
      if (!row) return;
      const av = row.querySelector('.seller-id-avatar');
      if (av && typeof avatarHtml === 'function') {
        av.innerHTML = avatarHtml(prof);
        if (typeof hydrateAvatars === 'function') hydrateAvatars(av);
      }
      const nameEl = row.querySelector('.seller-id-name');
      if (nameEl) nameEl.textContent = prof.displayName || 'Seller';
      // Safe public fields only (sold count, rating, member-since, Pro,
      // Verified, Fast-responder) — never email/phone/totalRevenue/stripe*.
      const metaEl = row.querySelector('.seller-id-meta');
      if (metaEl && typeof sellerMetaHtml === 'function') metaEl.innerHTML = sellerMetaHtml(prof);
      // r175: active-listing count appended to the seller meta line —
      // positive signal replacing the removed "No reviews yet" card.
      // Best-effort public query, stale-guarded; capped display at 25+.
      (async () => {
        try {
          const { getFirestore, collection, query, where, getDocs, limit } =
            await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
          const snap = await getDocs(query(
            collection(getFirestore(), 'listings'),
            where('sellerId', '==', p.sellerId),
            where('status', '==', 'active'),
            limit(26)
          ));
          if (currentDetailId !== _openedDetailId) return;
          const n = snap.size;
          if (n > 0 && metaEl && metaEl.isConnected) {
            const label = n > 25 ? '25+' : String(n);
            metaEl.insertAdjacentHTML('beforeend',
              `<span class="sid-dot">&middot;</span><span>${label} listing${n === 1 ? '' : 's'}</span>`);
          }
        } catch (_e) { /* count is a nicety — never block the row */ }
      })();
      // Visible-but-not-buyable (list-first): if the seller hasn't completed
      // Stripe payout setup (public profiles.chargesReady mirror !== true),
      // disable Buy + explain. UX only — createPaymentIntent is the real gate.
      const ownsThis = !!(window.CURRENT_USER && p.sellerId &&
        window.CURRENT_USER.uid === p.sellerId);
      // LIST-FIRST (r348): the seller hasn't finished payouts. Buyers get an
      // ENABLED "tap to get notified" CTA in the Buy slot (notifySellerInterest
      // records interest + nudges the seller; the buyer is told the moment it
      // becomes buyable). The owner sees what buyers see + a one-tap fix.
      // UX only — createPaymentIntent is the real gate.
      if (buyBtn && !isSold && !isPending && !ownsThis && prof.chargesReady !== true) {
        buyBtn.disabled = false;
        buyBtn.style.opacity = '';
        buyBtn.style.cursor = '';
        buyBtn.dataset.notifySetup = '1';
        buyBtn.classList.add('is-notify-setup');
        const _already = (() => { try { return localStorage.getItem('tb_interest_' + p.id) === '1'; } catch (_e) { return false; } })();
        buyBtn.textContent = _already ? 'We’ll let you know when it’s buyable' : 'Seller is finishing setup — tap to get notified';
        if (_already) { buyBtn.disabled = true; buyBtn.style.opacity = '0.6'; buyBtn.style.cursor = 'default'; }
        if (notBuyableNote) {
          const waiting = Number(p.interestCount || 0);
          notBuyableNote.textContent =
            "This seller hasn’t finished payment setup, so it can’t be bought yet. " +
            (_already ? "You’re on the list — we’ll notify you the moment it’s available." :
              "Tap above and we’ll notify you the moment it is — you can also message them or save it.") +
            (waiting > 0 ? ` ${waiting} buyer${waiting === 1 ? '' : 's'} waiting.` : '');
          notBuyableNote.style.display = '';
        }
      } else if (buyBtn && ownsThis && !isSold && !isPending &&
                 prof.chargesReady !== true && prof.stripeChargesEnabled !== true) {
        if (notBuyableNote) {
          const waiting = Number(p.interestCount || 0);
          notBuyableNote.innerHTML =
            'Buyers see <strong>“Seller is finishing setup”</strong> on this listing until you set up payouts (~3 min).' +
            (waiting > 0 ? ` <strong>${waiting} buyer${waiting === 1 ? '' : 's'} waiting.</strong>` : '') +
            ' <button type="button" class="btn-stripe-connect" data-action="stripe-connect" style="margin-left:6px;vertical-align:middle;">Set up payouts</button>';
          notBuyableNote.style.display = '';
        }
      }
    });
  }

  // Bid display removed — Buy-Now-only. Offer/bid negotiation purged in r116
  // (entry points + wiring removed; orphaned handlers/modals left inert,
  // filed for post-launch tidy-up).
  // Sale-history sparkline
  loadSparkline(p);
  // Seller reviews — collapsed preview right inside the listing detail.
  // Helps build buyer trust without forcing a click into the seller's
  // profile to see ratings.
  loadDetailReviews(p);
  const photos = (p.photos && p.photos.length > 0 ? p.photos : [])
    .map(window.safeImgUrl)
    .filter(Boolean);
  const galleryEl = document.getElementById('detailGallery');
  galleryEl.textContent = '';
  // r283: the double-tap handler inside buildIgSwiper reads the listing id
  // off the container, and the like row needs its pre-toggle baseline.
  galleryEl.dataset.listingId = String(p.id);
  snapshotDetailLikes(p);
  renderDetailLikes(p.id);
  if (photos.length === 0) {
    // 0 photos → existing fallback (placeholder icon, square)
    const empty = document.createElement('div');
    empty.className = 'ig-swiper-empty';
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder-art';
    placeholder.style.cssText = 'width:100%;height:100%;border-radius:8px';
    placeholder.innerHTML = window.CATEGORY_ICON(p.cat);
    empty.appendChild(placeholder);
    galleryEl.appendChild(empty);
  } else {
    window.buildIgSwiper(galleryEl, photos, p.name || '');
  }
  // Phase 3: heart with count on the detail photo too (same button, same
  // toggle); double-tap keeps working alongside it.
  if (window.favButtonHtml) galleryEl.insertAdjacentHTML('beforeend', window.favButtonHtml(p, 'card-fav detail-fav'));
  // "More like this" row — same category, current listing excluded, max 6.
  renderMoreLikeThis(p);
  document.getElementById('detailBackdrop').classList.add('open');
  // r156: single choke point for detail-overlay history — every entry route
  // (card tap, search, deep link, chat listing card) lands here. The URL
  // reflects the open listing so copy-address-bar IS a share link; Back
  // closes the sheet and restores the previous URL.
  if (window.__pushOverlay) {
    window.__pushOverlay('detail', '/?listing=' + encodeURIComponent(String(id)));
  }
}

// Build the "More like this" thumbnail row inside the detail modal. Pulls
// up to 6 OTHER listings in the same category from window.PRODUCTS, skips
// sold/pending so we don't dangle dead links, and hides the row entirely
// when there are no matches. Each thumbnail re-opens the detail modal for
// the chosen listing so the user can keep browsing without bouncing back
// to the grid.
function renderMoreLikeThis(currentListing) {
  const wrap = document.getElementById('detailMoreLikeThis');
  const row = document.getElementById('detailMoreLikeThisRow');
  if (!wrap || !row || !currentListing) return;
  row.innerHTML = '';
  const all = Array.isArray(window.PRODUCTS) ? window.PRODUCTS : [];
  const matches = all
    .filter(p => p && p.cat === currentListing.cat && String(p.id) !== String(currentListing.id) && p.status !== 'sold')
    .slice(0, 6);
  if (!matches.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const safeText = window.safeText || ((s) => String(s || ''));
  const safeAttr = window.safeAttr || ((s) => String(s || ''));
  const safeImg  = window.safeImgUrl || ((s) => s || '');
  matches.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mlt-card';
    btn.setAttribute('data-product-id', safeAttr(String(p.id)));
    const imgUrl = (window.variantImgUrl ? window.variantImgUrl(p, 0, 'w400') : '')
      || (p.photos && p.photos[0] ? safeImg(p.photos[0]) : '');
    const imgHtml = imgUrl
      ? `<img src="${imgUrl}" alt="${safeAttr(p.name || '')}" loading="lazy" />`
      : `<div class="placeholder-art" style="width:100%;height:100%">${window.CATEGORY_ICON ? window.CATEGORY_ICON(p.cat) : ''}</div>`;
    btn.innerHTML =
      `<div class="mlt-img">${imgHtml}</div>` +
      (p.brand ? `<div class="mlt-brand">${safeText(p.brand)}</div>` : '<div class="mlt-brand">&nbsp;</div>') +
      `<div class="mlt-name">${safeText(p.name || '')}</div>` +
      `<div class="mlt-price">$${Number(p.ask || 0).toLocaleString()}</div>`;
    btn.addEventListener('click', () => {
      // Re-enter the detail modal for the picked listing. openDetailModal
      // resets all the detail fields, so swapping in place is safe.
      openDetailModal(String(p.id));
      // Snap the modal back to the top so the user lands on the new hero
      // photo, not stuck deep in the previous listing's scroll position.
      const modal = document.querySelector('#detailBackdrop .detail-modal');
      if (modal) modal.scrollTop = 0;
    });
    row.appendChild(btn);
  });
}

// Legacy no-op kept for backwards compatibility — old gallery exposed
// setMainPhoto on window; the new IG-style swiper handles its own state.
window.setMainPhoto = function() {};

// Instagram-style photo swiper for the listing detail modal.
// - Native CSS scroll-snap drives the swipe (no JS swipe library)
// - Dot indicators reflect the current slide via scroll-position observation
// - Arrow buttons (desktop only) scroll to the prev/next slide
// - Tap on any slide opens the existing lightbox at the right index
// - Photo count badge ("3/5") in the top-right
// - 1 photo: no dots, no arrows, no badge — just the image
window.buildIgSwiper = function(container, urls, alt) {
  container.textContent = '';
  if (!urls || !urls.length) return;
  const single = urls.length < 2;

  const swiper = document.createElement('div');
  swiper.className = 'ig-swiper';

  const track = document.createElement('div');
  track.className = 'ig-swiper-track';
  track.setAttribute('role', 'region');
  track.setAttribute('aria-label', 'Listing photos');
  swiper.appendChild(track);

  // r175: count badge removed — the thumbnail strip below communicates
  // position + total (you can't have both per the design pass).

  // Slides
  urls.forEach((url, i) => {
    const slide = document.createElement('div');
    slide.className = 'ig-slide';
    slide.setAttribute('data-idx', String(i));
    const img = document.createElement('img');
    img.src = url;
    img.alt = alt || '';
    img.loading = i === 0 ? 'eager' : 'lazy';
    img.draggable = false;
    slide.appendChild(img);
    // r283: the slide no longer opens the lightbox on its own click. A
    // double-tap fires two clicks, which would have opened the lightbox
    // on top of the like. ppWireTapLikeOpen (below) owns the decision and
    // calls openLightbox itself once it knows the tap was a single.
    track.appendChild(slide);
  });

  // Arrow buttons (desktop only — CSS hides on touch devices)
  let prevBtn = null, nextBtn = null;
  if (!single) {
    prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'ig-arrow ig-arrow-prev';
    prevBtn.setAttribute('aria-label', 'Previous photo');
    prevBtn.textContent = '‹';
    swiper.appendChild(prevBtn);

    nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'ig-arrow ig-arrow-next';
    nextBtn.setAttribute('aria-label', 'Next photo');
    nextBtn.textContent = '›';
    swiper.appendChild(nextBtn);
  }

  // r175: real thumbnail strip replaces the dot pagination — only when
  // 2+ photos (a single photo gets neither strip nor badge).
  const thumbsWrap = document.createElement('div');
  thumbsWrap.className = 'ig-thumbs';
  const thumbs = [];
  if (!single) {
    urls.forEach((url, i) => {
      const th = document.createElement('button');
      th.type = 'button';
      th.className = 'ig-thumb' + (i === 0 ? ' active' : '');
      th.setAttribute('aria-label', `Go to photo ${i + 1} of ${urls.length}`);
      const timg = document.createElement('img');
      timg.src = url;
      timg.alt = '';
      timg.loading = 'lazy';
      timg.draggable = false;
      th.appendChild(timg);
      th.addEventListener('click', () => goTo(i));
      thumbsWrap.appendChild(th);
      thumbs.push(th);
    });
  }

  container.appendChild(swiper);
  container.appendChild(thumbsWrap);

  let currentIdx = 0;
  function setIdx(i) {
    currentIdx = Math.max(0, Math.min(urls.length - 1, i));
    thumbs.forEach((t, ti) => t.classList.toggle('active', ti === currentIdx));
    // Keep the active thumb in view when the strip scrolls (10-photo case).
    const at = thumbs[currentIdx];
    if (at && at.scrollIntoView) { try { at.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch (_e) {} }
    if (prevBtn) prevBtn.disabled = currentIdx === 0;
    if (nextBtn) nextBtn.disabled = currentIdx === urls.length - 1;
    container._igIdx = currentIdx;
  }
  function goTo(i) {
    const target = Math.max(0, Math.min(urls.length - 1, i));
    const slide = track.children[target];
    if (slide) {
      track.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' });
    }
    setIdx(target);
  }

  // Track scroll position to keep dots/badge in sync with native swipe.
  // Debounce via rAF so we don't churn on every scroll event.
  let scrollRaf = 0;
  track.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const w = track.clientWidth || 1;
      const idx = Math.round(track.scrollLeft / w);
      if (idx !== currentIdx) setIdx(idx);
    });
  }, { passive: true });

  if (prevBtn) prevBtn.addEventListener('click', () => goTo(currentIdx - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goTo(currentIdx + 1));

  // Expose stepper on the swiper element so the global keyboard handler
  // (registered once at startup) can drive it without reaching into closure.
  swiper._igGoTo = goTo;
  swiper._igStep = (d) => goTo(currentIdx + d);
  swiper._igCount = urls.length;
  container._igSwiper = swiper;

  // r283 — double-tap the photo to like. The card's heart overlay is gone,
  // so this gesture (and the Likes list) is how a listing gets liked now.
  //
  // Unlike Passport's feed, this TOGGLES. Instagram can make double-tap
  // like-only because it still shows a heart button to undo it; we removed
  // ours, and the Likes list has no remove control either, so like-only
  // would leave a listing liked forever with no way back.
  const burst = document.createElement('div');
  burst.className = 'ig-heart-burst';
  burst.setAttribute('aria-hidden', 'true');
  burst.innerHTML = window.ICONS.heartFill;
  swiper.appendChild(burst);

  // Which slide the gesture started on — the helper resolves tap vs
  // double-tap after the fact, by which time the event target is gone.
  let tapIdx = 0;
  swiper.addEventListener('pointerdown', (e) => {
    const sl = e.target && e.target.closest && e.target.closest('.ig-slide');
    if (sl) tapIdx = Number(sl.getAttribute('data-idx')) || 0;
  }, { passive: true });

  // NOTE: burstEl is deliberately NOT passed. The helper fires its burst
  // before calling onLike, and a signed-out double-tap must reach the
  // sign-in prompt WITHOUT a heart animation first — otherwise a guest sees
  // a "liked" state that no refresh will honour. Same rule the old card
  // heart followed. So we own the burst and fire it after the auth gate.
  ppWireTapLikeOpen(swiper, {
    ignore: '.ig-arrow, .ig-thumbs, .ig-dot',
    onOpen: () => { if (window.openLightbox) window.openLightbox(urls, tapIdx); },
    onLike: () => {
      const id = container.dataset.listingId;
      if (!id) return;
      if (typeof window.requireAuth === 'function' &&
          !window.requireAuth('to like and save listings')) return;
      if (typeof toggleWatch !== 'function') return;
      // Paint the burst for the direction we're about to go, before the
      // await — an unlike showing a big red heart would read as a like.
      const wasLiked = fav.has(id) || fav.has(Number(id));
      burst.classList.toggle('unliking', wasLiked);
      burst.classList.remove('go');
      void burst.offsetWidth; // restart the animation
      burst.classList.add('go');
      Promise.resolve(toggleWatch(id)).then(() => {
        if (typeof window.renderDetailLikes === 'function') {
          window.renderDetailLikes(id);
        }
      }).catch(() => {});
    },
  });

  setIdx(0);
};


// r283 — the listing detail's like row. Reads listings.watchlistCount (kept
// by the syncWatchlistCount trigger), which is authoritative but lags a
// local toggle by a round trip, so we snapshot the value and my own liked
// state when the sheet opens and apply my delta on top. That way the number
// moves the instant I double-tap instead of sitting stale until a refresh.
const detailLikeBase = Object.create(null);
function snapshotDetailLikes(p) {
  if (!p) return;
  const id = String(p.id);
  detailLikeBase[id] = {
    count: Number(p.watchlistCount || 0),
    likedAtOpen: fav.has(p.id) || fav.has(id) || fav.has(Number(id)),
  };
}
function renderDetailLikes(id) {
  const el = document.getElementById('detailLikes');
  if (!el) return;
  const key = String(id);
  const snap = detailLikeBase[key] || { count: 0, likedAtOpen: false };
  const liked = fav.has(id) || fav.has(key) || fav.has(Number(id));
  let n = snap.count + (liked ? (snap.likedAtOpen ? 0 : 1) : (snap.likedAtOpen ? -1 : 0));
  if (n < 0) n = 0;
  const countLabel = n ? `${n.toLocaleString()} like${n === 1 ? '' : 's'}` : '';
  el.classList.toggle('liked', !!liked);
  el.innerHTML =
    `<span class="detail-like-ico" aria-hidden="true">` +
      `${liked ? window.ICONS.heartFill : window.ICONS.heart}</span>` +
    `<span class="detail-like-count">${countLabel}</span>` +
    `<span class="detail-like-hint">${liked ? 'Saved to your liked items' : 'Tap the heart or double-tap the photo to like'}</span>`;
}
window.renderDetailLikes = renderDetailLikes;

window.openDetailModal = openDetailModal;

function closeDetailModalDirect() { document.getElementById('detailBackdrop').classList.remove('open'); removeListingJsonLd(); currentDetailId = null; }
window.closeDetailModalDirect = closeDetailModalDirect;

// Retained as a null-safe no-op: the bid modal (#modalBackdrop) was removed in
// the buy-now-only sweep, but cleanup paths (sign-out, "close all overlays")
// still call closeModalDirect(). No element → nothing to do.
function closeModalDirect() { const b = document.getElementById('modalBackdrop'); if (b) b.classList.remove('open'); }
window.closeModalDirect = closeModalDirect;
// ═══════════════════════════════════════════════════════════
// MESSAGING
// ═══════════════════════════════════════════════════════════
let currentChat = { conversationId: null, listing: null, otherUserId: null };
let unsubscribeMessages = null;

// ─── Presence wiring for new-message push suppression ───────────────────
// Writes presence/{uid}: { currentlyViewingConversation: cid, lastHeartbeatAt }
// while a chat thread is open. The pushOnNewMessage Cloud Function reads
// this to skip pushes for a recipient who is already in the thread.
// Best-effort: if the app is killed abruptly the doc stays stale for at
// most 30s (the server's PRESENCE_WINDOW_MS) before pushes resume.
let _presenceHeartbeatTimer = null;
async function _writePresence(conversationId) {
  if (!window.CURRENT_USER) return;
  try {
    const { getFirestore, doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    await setDoc(
      doc(firestoreDb, 'presence', window.CURRENT_USER.uid),
      {
        currentlyViewingConversation: conversationId,
        lastHeartbeatAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    // Presence is non-critical — recipient just gets a push they didn't
    // strictly need. Don't surface to the user.
  }
}
function _startPresenceHeartbeat(conversationId) {
  _stopPresenceHeartbeat();
  if (!conversationId) return;
  _writePresence(conversationId);
  // 25s cadence (under the 30s server window) so a missed beat doesn't
  // immediately flip the recipient back to push-eligible.
  _presenceHeartbeatTimer = setInterval(() => _writePresence(conversationId), 25000);
}
function _stopPresenceHeartbeat() {
  if (_presenceHeartbeatTimer) { clearInterval(_presenceHeartbeatTimer); _presenceHeartbeatTimer = null; }
}
async function _clearPresence() {
  _stopPresenceHeartbeat();
  if (!window.CURRENT_USER) return;
  try {
    const { getFirestore, doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    await setDoc(
      doc(firestoreDb, 'presence', window.CURRENT_USER.uid),
      {
        currentlyViewingConversation: null,
        lastHeartbeatAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) { /* best-effort */ }
}
// Pause heartbeat when the tab/app is backgrounded so a phone in pocket
// doesn't keep suppressing pushes for the user. Resume on visibility.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _stopPresenceHeartbeat();
  } else if (currentChat && currentChat.conversationId) {
    _startPresenceHeartbeat(currentChat.conversationId);
  }
});

async function openChatForListing(listingId) {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to message the seller', () => openChatForListing(listingId))) return;
  } else if (!window.CURRENT_USER) {
    showToast('Please sign in to message the seller.');
    return;
  }
  // r170: name gate before a thread is opened/created — replay reopens it.
  if (window.requireDisplayName && !window.requireDisplayName('to message the seller', () => openChatForListing(listingId))) return;

  // Get the listing — check Firestore first, fall back to hardcoded products
  let listing = null;
  try {
    const { getFirestore, doc, getDoc, collection, query, where, getDocs, addDoc, serverTimestamp, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();

    // Try to load from Firestore
    const listingSnap = await getDoc(doc(firestoreDb, 'listings', listingId));
    if (listingSnap.exists()) {
      listing = { id: listingSnap.id, ...listingSnap.data() };
    } else {
      // Fall back to hardcoded product list
      const p = (window.PRODUCTS || []).find(pr => String(pr.id) === String(listingId));
      if (p) listing = { id: p.id, title: p.title, brand: p.brand, cat: p.cat, sellerId: null };
    }

    if (!listing) {
      showToast('Listing not found.');
      return;
    }

    if (!listing.sellerId) {
      showToast('This is a demo listing. Messaging will work once sellers list real items.');
      return;
    }

    if (listing.sellerId === window.CURRENT_USER.uid) {
      showToast("You can't message yourself about your own listing.");
      return;
    }

    // Find existing conversation or create one
    const convsRef = collection(firestoreDb, 'conversations');
    const q = query(convsRef,
      where('listingId', '==', listing.id),
      where('participants', 'array-contains', window.CURRENT_USER.uid),
      limit(1));
    const existing = await getDocs(q);

    let conversationId;
    if (!existing.empty && existing.docs[0].data().participants.includes(listing.sellerId)) {
      conversationId = existing.docs[0].id;
    } else {
      const newConv = await addDoc(convsRef, {
        listingId: listing.id,
        listingTitle: listing.title || '',
        listingCat: listing.cat || 'accessories',
        participants: [window.CURRENT_USER.uid, listing.sellerId],
        buyerId: window.CURRENT_USER.uid,
        sellerId: listing.sellerId,
        createdAt: serverTimestamp(),
        lastMessageAt: serverTimestamp(),
      });
      conversationId = newConv.id;
    }

    currentChat = { conversationId, listing, otherUserId: listing.sellerId };
    openChatUI();
    await loadMessages();
  } catch (err) {
    console.error('Error opening chat:', err);
    showToast('Could not open chat.');
  }
}

function openChatUI() {
  const avatarEl = document.getElementById('chatHeaderAvatar');
  // Header identifies WHO you're talking to: title = the other participant's
  // display name (tappable → openProfile), sub = a muted listing reference.
  // The avatar slot shows the listing photo (tappable → listing detail) and
  // falls back to the partner's avatar/monogram only when the listing has no
  // photo. Full item details (brand/condition/price) live ONLY in the pinned
  // card below (renderChatListingCard) — never duplicated here.
  // Prefer the pre-generated w400 variant for the 40px circle; variantImgUrl
  // falls back to photos[0] and safeImgUrl-validates either way.
  const listingPhoto = currentChat.listing && window.variantImgUrl
    ? window.variantImgUrl(currentChat.listing, 0, 'w400')
    : '';
  if (avatarEl) {
    if (listingPhoto) {
      avatarEl.innerHTML =
        `<img src="${window.safeAttr(listingPhoto)}" alt="" loading="eager" fetchpriority="high" decoding="async" class="avatar-img" />`;
      avatarEl.dataset.action = 'chat-open-listing';
      avatarEl.setAttribute('aria-label', 'View listing');
      if (typeof hydrateAvatars === 'function') hydrateAvatars(avatarEl);
    } else {
      avatarEl.innerHTML = '?'; // placeholder until the partner profile resolves
      avatarEl.dataset.action = 'open-chat-partner';
      avatarEl.setAttribute('aria-label', 'View profile');
    }
  }
  document.getElementById('chatTitle').textContent = '…'; // partner name resolves just below
  document.getElementById('chatSub').textContent = currentChat.listing.title || '';
  // Resolve the partner's profile once (cached via loadProfile/PROFILE_CACHE),
  // then render their name in the title — and their avatar only when the
  // listing had no photo. Guard against a thread switch landing the wrong
  // name/avatar by capturing the conversationId we opened with.
  (function resolvePartner() {
    const otherId = currentChat && currentChat.otherUserId;
    const openedCid = currentChat && currentChat.conversationId;
    if (!otherId || typeof loadProfile !== 'function') return;
    loadProfile(otherId).then((prof) => {
      // Stale-guard: bail if the user has since opened a different thread.
      if (!currentChat || currentChat.conversationId !== openedCid) return;
      const name = prof && (prof.displayName || (prof._user && prof._user.displayName));
      const titleEl = document.getElementById('chatTitle');
      if (titleEl) titleEl.textContent = name || 'TeeBox member';
      if (!listingPhoto) {
        const av = document.getElementById('chatHeaderAvatar');
        if (av && typeof avatarHtml === 'function') {
          // Reuse the profile-pic-lag pattern: initials placeholder behind an
          // eager/fetchpriority-high <img>, faded in by hydrateAvatars().
          av.innerHTML = avatarHtml(prof || { id: otherId });
          if (typeof hydrateAvatars === 'function') hydrateAvatars(av);
        }
      }
    }).catch(() => {
      if (!currentChat || currentChat.conversationId !== openedCid) return;
      const titleEl = document.getElementById('chatTitle');
      if (titleEl && titleEl.textContent === '…') titleEl.textContent = 'TeeBox member';
    });
  })();
  document.getElementById('chatInput').value = '';
  document.getElementById('chatBody').innerHTML = '<div class="chat-skeleton"><div class="chat-skel-b them"></div><div class="chat-skel-b me"></div><div class="chat-skel-b them"></div></div>';
  // Pinned listing context card — populate from currentChat.listing.
  // Falls back to the conversation's denormalised listingTitle/listingCat
  // if the full listing record didn't resolve (e.g. listing was deleted).
  renderChatListingCard(currentChat.listing);
  document.getElementById('chatBackdrop').classList.add('open');
  setTimeout(() => document.getElementById('chatInput').focus(), 100);
  // Begin presence heartbeat — server suppresses pushes for the
  // recipient who's actively viewing this thread.
  _startPresenceHeartbeat(currentChat.conversationId);
  // Mark the conversation as read on open. openChatFromConversation does
  // this already for the inbox-entry path, but openChat() (entered from
  // a listing's "Message Seller") didn't — so the unread badge would
  // stay lit on the buyer's side after they reply to the seller. This
  // is best-effort: rule only allows updating lastRead/lastMessage*.
  try {
    if (currentChat && currentChat.conversationId && window.CURRENT_USER) {
      markConversationRead(currentChat.conversationId);
    }
  } catch (_e) {}
}

// Mark conversation as read for the current user. Writes BOTH:
//   1. conversations/{cid}.lastRead.{uid}  — legacy denormalized field
//      used by isConvUnread() for client-side fallback computation
//   2. conversations/{cid}/participantState/{uid}.lastReadAt — new field
//      consumed by the server-side derivation of users/{uid}.unreadConversations
// Best-effort: never throws. The setDoc on the participantState subcoll
// uses { merge: true } so it works whether the doc exists or not.
async function markConversationRead(conversationId) {
  if (!conversationId || !window.CURRENT_USER) return;
  const uid = window.CURRENT_USER.uid;
  try {
    const { getFirestore, doc, updateDoc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    // Legacy denormalized field
    try {
      await updateDoc(doc(firestoreDb, 'conversations', conversationId), {
        [`lastRead.${uid}`]: serverTimestamp(),
      });
    } catch (_e) { /* swallow */ }
    // New participantState subcollection (server derives unreadConversations)
    try {
      await setDoc(
        doc(firestoreDb, 'conversations', conversationId, 'participantState', uid),
        { lastReadAt: serverTimestamp() },
        { merge: true }
      );
    } catch (_e) { /* swallow — rules may not be deployed yet */ }
  } catch (_e) { /* swallow — purely a badge nicety */ }
  // Reading a message also clears it from the notif panel's "Messages"
  // section, but the panel reads from a cached snapshot. Bust the cache
  // so the red dot reconciles immediately.
  invalidateNotifCache();
}
window.markConversationRead = markConversationRead;

// Archive (soft-hide) the currently-open conversation for THIS user only.
// Writes hidden.{uid} = serverTimestamp(); the inbox listener filters it
// out until a newer message arrives (isConvHidden). Never deletes the
// shared thread (rules keep conversations delete:if false).
async function archiveConversation(explicitId) {
  // r289: takes an id so the inbox can archive a row by swipe, not just the
  // thread that happens to be open.
  const cid = explicitId || (currentChat && currentChat.conversationId);
  if (!cid || !window.CURRENT_USER) { showToast('No conversation open.'); return; }
  try {
    const { getFirestore, doc, updateDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    await updateDoc(doc(getFirestore(), 'conversations', cid), {
      [`hidden.${window.CURRENT_USER.uid}`]: serverTimestamp(),
    });
    if (explicitId) {
      // Swiped from the list — undo restores it, same shape as the
      // per-message delete in r284.
      showUndoToast('Conversation archived', () => unarchiveConversation(cid));
    } else {
      showToast('Conversation archived. It returns if they reply.');
      closeChat();
    }
  } catch (e) {
    console.error('archiveConversation failed', e);
    showToast('Could not archive conversation.');
  }
}
window.archiveConversation = archiveConversation;

async function unarchiveConversation(cid) {
  if (!cid || !window.CURRENT_USER) return;
  try {
    const { getFirestore, doc, updateDoc, deleteField } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    await updateDoc(doc(getFirestore(), 'conversations', cid), {
      [`hidden.${window.CURRENT_USER.uid}`]: deleteField(),
    });
  } catch (e) { console.warn('unarchive failed', e); }
}

// r289 — swipe a conversation row to archive it. Reuses the gesture helper
// the per-message delete already uses, so the direction and the feel match:
// swipe LEFT, partial reveals Archive, full swipe archives outright. Archive
// is per-user (hidden.{uid}) and reversible, and the thread comes back on
// its own if the other person replies — so nothing is destroyed.
function wireInboxSwipe(root) {
  if (!root || root.__inboxSwipeWired) return;
  root.__inboxSwipeWired = true;
  let el = null, body = null, sx = 0, sy = 0, dx = 0, axis = '', active = false;
  const OPEN = 96, FULL = 200;
  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { active = false; return; }
    const t = e.changedTouches[0];
    if (t.clientX <= 24) { active = false; return; }   // iOS back-swipe zone
    el = e.target.closest ? e.target.closest('.inbox-swipe') : null;
    body = el && el.querySelector('.inbox-swipe-body');
    if (!el || !body) { active = false; return; }
    document.querySelectorAll('.inbox-swipe.swiped').forEach((o) => {
      if (o !== el) { o.classList.remove('swiped');
        const b = o.querySelector('.inbox-swipe-body'); if (b) b.style.transform = ''; }
    });
    sx = t.clientX; sy = t.clientY; dx = 0; axis = ''; active = true;
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (!active || !body) return;
    const t = e.changedTouches[0];
    const ddx = t.clientX - sx, ddy = t.clientY - sy;
    if (!axis) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      axis = Math.abs(ddx) > Math.abs(ddy) + 4 ? 'x' : 'y';
      if (axis === 'y') { active = false; return; }
    }
    if (ddx > 0 && !el.classList.contains('swiped')) { dx = 0; body.style.transform = ''; return; }
    dx = ddx < -FULL ? -FULL - (Math.abs(ddx) - FULL) * 0.25 : ddx;
    if (dx > 0) dx = 0;
    body.style.transition = 'none';
    body.style.transform = `translateX(${dx}px)`;
    el.classList.toggle('will-archive', dx <= -FULL);
  }, { passive: true });
  root.addEventListener('touchend', () => {
    if (!active || !body || axis !== 'x') { active = false; return; }
    const target = el, moved = dx;
    body.style.transition = ''; el.classList.remove('will-archive'); active = false;
    if (moved <= -FULL) {
      body.style.transform = 'translateX(-100%)';
      const cid = target.dataset.convId;
      setTimeout(() => archiveConversation(cid), 140);
      return;
    }
    if (moved <= -OPEN / 2) { target.classList.add('swiped'); body.style.transform = `translateX(-${OPEN}px)`; }
    else { target.classList.remove('swiped'); body.style.transform = ''; }
  }, { passive: true });
}

// Render the listing context card in the chat header. Safe to call with a
// partial listing object (we only require id+title+cat to render something
// useful). Status pill is shown for sold/pending so a buyer pinging a
// seller about a stale listing sees it immediately.
function renderChatListingCard(listing) {
  const card = document.getElementById('chatListingCard');
  const thumb = document.getElementById('chatListingCardThumb');
  const titleEl = document.getElementById('chatListingCardTitle');
  const subEl = document.getElementById('chatListingCardSub');
  const priceEl = document.getElementById('chatListingCardPrice');
  if (!card || !thumb || !titleEl || !subEl || !priceEl) return;
  if (!listing) { card.classList.remove('show'); return; }
  const title = listing.title || 'Listing';
  const brand = listing.brand || '';
  const cond = listing.condition || '';
  const cat = listing.cat || listing.listingCat || 'accessories';
  const ask = Number(listing.ask || 0);
  const status = listing.status || '';
  titleEl.textContent = title;
  // Sub line: "Brand · Condition" (drop empties so we don't render "· ·").
  const subBits = [brand, cond].filter(Boolean);
  let subText = subBits.join(' · ');
  if (status === 'sold') subText = (subText ? subText + ' · ' : '') + 'SOLD';
  else if (window.isListingPendingNow ? window.isListingPendingNow(listing) : status === 'pending') subText = (subText ? subText + ' · ' : '') + 'Sale pending';
  subEl.textContent = subText;
  priceEl.textContent = ask > 0 ? ('$' + ask.toLocaleString()) : '';
  // Thumb: prefer photos[0] (real listing); else fall back to category icon.
  const photoUrl = (window.variantImgUrl ? window.variantImgUrl(listing, 0, 'w400') : '')
    || (listing.photos && listing.photos[0]
      ? (window.safeImgUrl ? window.safeImgUrl(listing.photos[0]) : String(listing.photos[0]))
      : '');
  if (photoUrl) {
    thumb.classList.remove('placeholder');
    thumb.innerHTML = '';
    thumb.style.backgroundImage = `url("${photoUrl.replace(/"/g, '%22')}")`;
    thumb.style.backgroundSize = 'cover';
    thumb.style.backgroundPosition = 'center';
  } else {
    thumb.classList.add('placeholder');
    thumb.style.backgroundImage = '';
    thumb.innerHTML = (window.CATEGORY_ICON ? window.CATEGORY_ICON(cat) : '');
  }
  card.classList.add('show');
}

// r168: close the mobile ⋯ overflow menu (Archive/Block/Report). Called on
// item selection, outside click, and chat close so it can never stay stuck.
function closeChatMoreMenu() {
  const m = document.getElementById('chatMoreMenu');
  if (m) m.classList.remove('open');
  const b = document.getElementById('chatMoreBtn');
  if (b) b.setAttribute('aria-expanded', 'false');
}
// Outside-click dismiss. The delegated data-action listener registers earlier
// in the document, so a menu item's action fires first and this closes the
// menu after; the ⋯ toggle button is exempt (its own action owns open/close).
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('chatMoreMenu');
  if (!menu || !menu.classList.contains('open')) return;
  const wrap = document.getElementById('chatHeaderMore');
  const inWrap = wrap && wrap.contains(ev.target);
  if (!inWrap || ev.target.closest('.chat-more-menu')) closeChatMoreMenu();
});

function closeChat() {
  closeChatMoreMenu();
  document.getElementById('chatBackdrop').classList.remove('open');
  if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
  // Clear presence so the server resumes sending pushes for this user.
  _clearPresence();
  // Reset the pinned listing card so it doesn't flash through the next
  // openChat() call before the new listing has finished resolving.
  const card = document.getElementById('chatListingCard');
  if (card) card.classList.remove('show');
  currentChat = { conversationId: null, listing: null, otherUserId: null };
  // r288: back out to Messages if that's where this thread was opened from.
  if (window.__chatCameFromInbox) {
    window.__chatCameFromInbox = false;
    const ib = document.getElementById('inboxBackdrop');
    if (ib && !ib.classList.contains('open') && typeof openInbox === 'function') {
      try { openInbox(); } catch (_e) {}
    }
  }
}
async function loadMessages() {
  if (!currentChat.conversationId) return;
  if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
  try {
    const { getFirestore, collection, query, orderBy, onSnapshot, limitToLast } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    // Cap the snapshot to the last 200 messages — anything older isn't
    // visible without scrolling and would inflate the realtime payload
    // for long-lived conversations.
    const msgsQ = query(
      collection(firestoreDb, 'conversations', currentChat.conversationId, 'messages'),
      orderBy('createdAt', 'asc'),
      limitToLast(200)
    );
    unsubscribeMessages = onSnapshot(msgsQ, (snap) => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderMessages(msgs);
      // U-1: a message arriving while the thread is OPEN must clear unread —
      // markConversationRead otherwise only fires on open, leaving the badge
      // lit for a thread the user is actively reading. Idempotent write.
      const last = msgs[msgs.length - 1];
      if (last && window.CURRENT_USER && last.senderId !== window.CURRENT_USER.uid) {
        try { markConversationRead(currentChat.conversationId); } catch (_e) {}
      }
    }, (err) => {
      console.error('Error listening to messages:', err);
      document.getElementById('chatBody').innerHTML =
        '<div class="chat-empty">Could not load messages.</div>';
    });
  } catch (err) {
    console.error('Error loading messages:', err);
    document.getElementById('chatBody').innerHTML =
      '<div class="chat-empty">Could not load messages.</div>';
  }
}

// ─────────────────────────────────────────────────────────────
// r284 — swipe-left-to-delete on a single message (iOS Mail style)
//
// "Delete for me" only: we add the viewer's uid to the message's
// deletedFor array and filter it at render. The doc is never removed and
// the text is never edited, because a buyer/seller thread is the evidence
// if an order is disputed — neither side gets to erase it for the other.
// Firestore rules enforce that you can only add/remove your OWN uid.
// ─────────────────────────────────────────────────────────────
const MSG_SWIPE_OPEN = 88;   // px of Delete revealed on a partial swipe
const MSG_SWIPE_FULL = 200;  // past this, let go and it deletes outright

function closeOpenMessageSwipe(except) {
  document.querySelectorAll('.msg-swipe.swiped').forEach((el) => {
    if (el === except) return;
    el.classList.remove('swiped');
    const b = el.querySelector('.msg-swipe-body');
    if (b) b.style.transform = '';
  });
}
window.closeOpenMessageSwipe = closeOpenMessageSwipe;

function wireMessageSwipe(root) {
  if (!root || root.__swipeWired) return;
  root.__swipeWired = true; // delegated once per #chatBody, survives re-renders

  let el = null, body = null, sx = 0, sy = 0, dx = 0, axis = '', active = false;

  const bodyOf = (t) => (t && t.closest ? t.closest('.msg-swipe') : null);

  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { active = false; return; }
    const t = e.changedTouches[0];
    // iOS interactive-pop lives in the left ~24px. Starting a gesture there
    // is the system back-swipe, not ours.
    if (t.clientX <= 24) { active = false; return; }
    el = bodyOf(e.target);
    body = el && el.querySelector('.msg-swipe-body');
    if (!el || !body) { active = false; return; }
    closeOpenMessageSwipe(el);
    sx = t.clientX; sy = t.clientY; dx = 0; axis = ''; active = true;
  }, { passive: true });

  root.addEventListener('touchmove', (e) => {
    if (!active || !body) return;
    const t = e.changedTouches[0];
    const ddx = t.clientX - sx, ddy = t.clientY - sy;
    if (!axis) {
      // Decide once, with a dead zone, so a vertical scroll is never stolen.
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      axis = Math.abs(ddx) > Math.abs(ddy) + 4 ? 'x' : 'y';
      if (axis === 'y') { active = false; return; }
    }
    if (ddx > 0 && !el.classList.contains('swiped')) { dx = 0; body.style.transform = ''; return; }
    // Rubber-band past the full-swipe point so it never feels unbounded.
    dx = ddx < -MSG_SWIPE_FULL
      ? -MSG_SWIPE_FULL - (Math.abs(ddx) - MSG_SWIPE_FULL) * 0.25
      : ddx;
    if (dx > 0) dx = 0;
    body.style.transition = 'none';
    body.style.transform = `translateX(${dx}px)`;
    el.classList.toggle('will-delete', dx <= -MSG_SWIPE_FULL);
  }, { passive: true });

  const settle = () => {
    if (!active || !body || axis !== 'x') { active = false; return; }
    const target = el, moved = dx;
    body.style.transition = '';
    el.classList.remove('will-delete');
    active = false;
    if (moved <= -MSG_SWIPE_FULL) {
      body.style.transform = 'translateX(-100%)';
      const mid = target.dataset.mid;
      setTimeout(() => { deleteMessageForMe(mid); }, 140);
      return;
    }
    if (moved <= -MSG_SWIPE_OPEN / 2) {
      target.classList.add('swiped');
      body.style.transform = `translateX(-${MSG_SWIPE_OPEN}px)`;
    } else {
      target.classList.remove('swiped');
      body.style.transform = '';
    }
  };
  root.addEventListener('touchend', settle, { passive: true });
  root.addEventListener('touchcancel', () => {
    if (body) { body.style.transition = ''; body.style.transform = ''; }
    if (el) el.classList.remove('will-delete');
    active = false;
  }, { passive: true });
}

// Toast with a single action. showToast is text-only and 3.25s; an undo
// needs longer and something to press.
function showUndoToast(msg, onUndo, ms) {
  const life = ms || 5000;
  const t = document.createElement('div');
  t.className = 'toast toast-undo';
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  label.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-undo-btn';
  btn.textContent = 'Undo';
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 300);
  };
  btn.addEventListener('click', () => { close(); try { onUndo && onUndo(); } catch (_e) {} });
  t.appendChild(label); t.appendChild(btn);
  document.body.appendChild(t);
  setTimeout(close, life);
  return t;
}
window.showUndoToast = showUndoToast;

async function deleteMessageForMe(mid) {
  if (!mid || !window.CURRENT_USER || !currentChat.conversationId) return;
  const uid = window.CURRENT_USER.uid;
  const convId = currentChat.conversationId;
  try {
    const { getFirestore, doc, updateDoc, arrayUnion } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await updateDoc(doc(db, 'conversations', convId, 'messages', mid),
      { deletedFor: arrayUnion(uid) });
    // The snapshot listener repaints the thread; the inbox snippet is a
    // separate doc and has to be told.
    await syncInboxPreviewOverride(convId, mid, true);
    showUndoToast('Message deleted', () => undoDeleteMessageForMe(convId, mid));
  } catch (e) {
    console.warn('deleteMessageForMe failed', e);
    showToast('Could not delete that message.', 'error');
    closeOpenMessageSwipe(null);
    if (typeof renderMessages === 'function') renderMessages(__chatRawMessages);
  }
}
window.deleteMessageForMe = deleteMessageForMe;

async function undoDeleteMessageForMe(convId, mid) {
  if (!mid || !window.CURRENT_USER) return;
  const uid = window.CURRENT_USER.uid;
  try {
    const { getFirestore, doc, updateDoc, arrayRemove } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await updateDoc(doc(db, 'conversations', convId, 'messages', mid),
      { deletedFor: arrayRemove(uid) });
    await syncInboxPreviewOverride(convId, mid, false);
  } catch (e) {
    console.warn('undoDeleteMessageForMe failed', e);
    showToast('Could not restore that message.', 'error');
  }
}

// The inbox snippet comes from conversations.lastMessageText, which the
// sendMessage callable owns and both parties share — so a per-user delete
// can't rewrite it. previewHidden.{uid} is a per-user override the inbox
// applies only while it still points at the conversation's newest message;
// once either party sends again, lastMessageAt moves on and the override
// falls away on its own.
async function syncInboxPreviewOverride(convId, mid, deleting) {
  if (!window.CURRENT_USER) return;
  const uid = window.CURRENT_USER.uid;
  const raw = __chatRawMessages || [];
  const newest = raw[raw.length - 1];
  if (!newest) return;
  const isNewest = String(newest.id) === String(mid);
  const at = newest.createdAt && newest.createdAt.toMillis ? newest.createdAt.toMillis() : 0;
  try {
    const { getFirestore, doc, updateDoc, deleteField } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const ref = doc(db, 'conversations', convId);
    if (deleting && isNewest) {
      // Fall back to the newest message still visible to me.
      const prev = raw.slice(0, -1).reverse().find((m) =>
        !(Array.isArray(m.deletedFor) && m.deletedFor.indexOf(uid) !== -1));
      await updateDoc(ref, {
        [`previewHidden.${uid}`]: { at, text: prev ? String(prev.text || '').slice(0, 200) : '' },
      });
    } else if (!deleting && isNewest) {
      await updateDoc(ref, { [`previewHidden.${uid}`]: deleteField() });
    }
  } catch (e) {
    // Non-fatal: the message is still hidden in the thread, only the inbox
    // one-liner lags. Never surface this as a failed delete.
    console.warn('syncInboxPreviewOverride failed', e);
  }
}

let __chatRawMessages = [];
function renderMessages(messages) {
  const body = document.getElementById('chatBody');
  const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  // r284 "delete for me": the message doc is never removed — these threads
  // are the record if an order is disputed — so a message the viewer deleted
  // is filtered out here and stays visible to the other party. Keep the RAW
  // list around: the delete flow needs it to work out what the inbox snippet
  // should fall back to.
  __chatRawMessages = Array.isArray(messages) ? messages : [];
  const hiddenForMe = (m) => !!(myUid && Array.isArray(m.deletedFor) &&
    m.deletedFor.indexOf(myUid) !== -1);
  messages = __chatRawMessages.filter((m) => !hiddenForMe(m));
  if (messages.length === 0) {
    body.innerHTML = __chatRawMessages.length
      ? '<div class="chat-empty">No messages here anymore.</div>'
      : '<div class="chat-empty">No messages yet. Say hi!</div>';
    return;
  }
  const attrEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fmtMsgTime = (ts) => {
    const ms = ts && ts.toMillis ? ts.toMillis() : 0;
    if (!ms) return '';
    const d = new Date(ms);
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' +
        d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  // "New" divider before the first inbound message that arrived since the
  // last time this user read the thread (currentChat.unreadSince is captured
  // BEFORE mark-read on open, so it reflects the pre-open read cursor).
  const unreadSince = (currentChat && currentChat.unreadSince) || 0;
  let dividerShown = false;
  body.innerHTML = messages.map(m => {
    const mine = m.senderId === myUid;
    const cls = mine ? 'msg msg-mine' : 'msg msg-theirs';
    const safe = (m.text || '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    // Inbound message flagged HARD by the server-side moderateMessage
    // trigger gets an interstitial; bubble is hidden until the user opts in.
    // Other agents (report flow, etc.) event-delegate from #chatBody using
    // the data-msg-id / data-sender-id attributes on .msg-wrap.
    const showInterstitial = !mine && m.flagged && m.flagged.severity === 'HARD';
    const wrapAlign = mine ? 'msg-mine-wrap' : 'msg-theirs-wrap';
    const wrapCls = 'msg-wrap ' + wrapAlign + (showInterstitial ? ' msg-hidden' : '');
    const midAttr = attrEsc(m.id);
    const sidAttr = attrEsc(m.senderId);
    const interstitial = showInterstitial ? `
      <div class="msg-interstitial">
        <div class="msg-interstitial-head">${(window.ICONS && window.ICONS.alert) || ''} Heads up</div>
        <p class="msg-interstitial-body">This message may be moving the deal off TeeBox. <strong>Paying outside the app means no dispute support or refunds from TeeBox.</strong></p>
        <div class="msg-interstitial-actions">
          <button class="btn-ghost" type="button" data-action="msg-show-anyway">Show message anyway</button>
          <button class="btn-ghost btn-warn" data-action="report-message" data-mid="${midAttr}" data-sender="${sidAttr}">Report this message</button>
        </div>
      </div>` : '';
    const ms = m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : 0;
    let divider = '';
    if (!dividerShown && !mine && unreadSince && ms > unreadSince) {
      divider = '<div class="msg-divider"><span>New</span></div>';
      dividerShown = true;
    }
    const t = fmtMsgTime(m.createdAt);
    const timeHtml = t ? `<div class="msg-time">${t}</div>` : '';
    // r169: sender avatar beside every bubble — placeholder '?' now, filled by
    // hydrateMsgAvatars below (photo-over-initial, monogram fallback — same
    // avatarHtml helper as the thread header).
    const rowCls = mine ? 'msg-row msg-row-mine' : 'msg-row msg-row-theirs';
    const avatar = `<span class="msg-avatar" data-avatar-uid="${sidAttr}" aria-hidden="true">?</span>`;
    // The .msg-wrap attributes below are load-bearing for other delegated
    // handlers (report flow) — the swipe shell wraps AROUND the row rather
    // than changing it.
    const row = `<div class="${rowCls}">${avatar}<div class="${wrapCls}" data-msg-id="${midAttr}" data-sender-id="${sidAttr}">${interstitial}<div class="${cls}">${safe}</div>${timeHtml}</div></div>`;
    return divider +
      `<div class="msg-swipe" data-mid="${midAttr}">` +
        `<button type="button" class="msg-del-btn" data-action="delete-message" ` +
          `data-mid="${midAttr}" aria-label="Delete this message for me">Delete</button>` +
        `<div class="msg-swipe-body">${row}</div>` +
      `</div>`;
  }).join('');
  hydrateMsgAvatars(body);
  wireMessageSwipe(body);
  body.scrollTop = body.scrollHeight;
}

// r169: fill per-message avatar slots. loadProfile is PROFILE_CACHE-backed,
// so the per-snapshot re-render costs at most two cache hits (the thread has
// exactly two participants); avatarHtml renders the photo-over-initial
// pattern with the monogram fallback when a user has no avatarUrl. Slots are
// captured per-render — stale nodes from a superseded render are detached
// and harmlessly skipped via isConnected.
function hydrateMsgAvatars(root) {
  if (typeof loadProfile !== 'function' || typeof avatarHtml !== 'function') return;
  const slots = Array.from((root || document).querySelectorAll('.msg-avatar[data-avatar-uid]'));
  const uids = [...new Set(slots.map(s => s.dataset.avatarUid).filter(Boolean))];
  uids.forEach((uid) => {
    loadProfile(uid).then((prof) => {
      slots.filter(s => s.dataset.avatarUid === uid && s.isConnected).forEach((s) => {
        s.innerHTML = avatarHtml(prof || { id: uid });
        if (typeof hydrateAvatars === 'function') hydrateAvatars(s);
      });
    }).catch(() => {});
  });
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !currentChat.conversationId) return;
  // r170: a display name is required to message. The typed text stays in the
  // input (nothing cleared before this point), so the replay resends it.
  if (window.requireDisplayName && !window.requireDisplayName('to send messages', () => sendMessage())) return;

  // Off-platform detection: HARD severity (phone/email/payment app) prompts
  // the sender to reconsider before the doc is written. Authoritative
  // server-side re-scan happens in functions/index.js moderateMessage,
  // which writes the `flagged` field that drives the inbound interstitial.
  let clientFlag = null;
  try {
    if (typeof window.detectOffPlatform === 'function') {
      const det = window.detectOffPlatform(text);
      if (det && det.matched) {
        if (det.severity === 'HARD') {
          const ok = window.confirm("This message looks like it might be moving the deal off TeeBox. Paying outside the app means no dispute support or refunds from TeeBox. Send anyway?");
          if (!ok) return;
        }
        clientFlag = { severity: det.severity, patterns: (det.patterns || []).slice(0, 6) };
      }
    }
  } catch (_e) { /* detector is best-effort; never block sending on its errors */ }

  const sendBtn = document.getElementById('chatSendBtn');
  const _sendLabel = sendBtn.textContent;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  // Optimistic "sending" bubble — the onSnapshot replaces it with the real
  // message on success; removed on failure (see catch).
  let _optimistic = null;
  try {
    const _cb = document.getElementById('chatBody');
    if (_cb) {
      _optimistic = document.createElement('div');
      // r169: match renderMessages' row structure so the pending bubble
      // aligns identically to the real one that replaces it.
      _optimistic.className = 'msg-row msg-row-mine';
      const _myUid = (window.CURRENT_USER && window.CURRENT_USER.uid) || '';
      _optimistic.innerHTML = '<span class="msg-avatar" data-avatar-uid="' +
        _myUid.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) +
        '" aria-hidden="true">?</span>' +
        '<div class="msg-wrap msg-mine-wrap"><div class="msg msg-mine" style="opacity:.55">' +
        text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) +
        '</div><div class="msg-time">Sending…</div></div>';
      _cb.appendChild(_optimistic); _cb.scrollTop = _cb.scrollHeight;
      try { hydrateMsgAvatars(_optimistic); } catch (_e) {}
    }
  } catch (_e) {}
  try {
    // Route through the server-side sendMessage callable — it enforces
    // rate limits, duplicate-spam holds, and PII-per-recipient holds
    // before Admin-SDK-writing the message into the conversation.
    // The client no longer addDoc's directly; the server owns the
    // conversation `lastMessageAt` bump too.
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const sendFn = httpsCallable(fns, 'sendMessage');
    const res = await sendFn({
      conversationId: currentChat.conversationId,
      recipientId: currentChat.otherUserId,
      text: text,
      clientFlag: clientFlag || null,
    });
    const out = (res && res.data) || {};
    if (out.held) {
      // Rule 3 / Rule 4 hold path — the message is in messageHolds for
      // moderator review and was NOT written to the conversation.
      showToast('Your message is pending review and will be sent once approved.');
      input.value = '';
    } else if (out.ok) {
      input.value = '';
      // onSnapshot already streams the new message — no manual reload.
      // Analytics: priority event #5 — `message_sent`. Only fires when
      // the callable confirmed delivery (out.ok). Hold-path (out.held)
      // is intentionally NOT counted as a message-sent event since
      // the message isn't actually visible to the recipient yet. NOT
      // mirrored server-side: the `sendMessage` callable could
      // potentially fire its own event, but tab-close-mid-send is
      // rare enough vs the volume of messages that we accept the
      // client-only fire.
      try {
        if (window.posthog) {
          window.posthog.capture('message_sent', {
            conversationId: currentChat.conversationId || null,
            listingId: currentChat.listingId || null,
            messageLength: text.length,
            containsLink: /https?:\/\//i.test(text),
            // 'buyer' if the user is messaging a seller they're not,
            // else 'seller'. Best-effort — currentChat.role isn't
            // always set on legacy threads, default 'unknown'.
            senderRole: (currentChat && currentChat.role) || 'unknown',
          });
        }
      } catch (_e) { /* analytics never blocks message send */ }
    } else {
      showToast('Could not send message.');
    }
  } catch (err) {
    console.error('Error sending message:', err);
    if (_optimistic) { try { _optimistic.remove(); } catch (_e) {} }
    // Content-violation path: server-side filter rejected the message
    // with HttpsError invalid-argument + details.error = 'content_violation'.
    // Never echo the matched word or category — audit detail only.
    if (window.isContentViolationError && window.isContentViolationError(err)) {
      showContentViolationToast("Your message wasn't sent — it has language we don't allow on TeeBox. Tweak it and try again.");
      sendBtn.disabled = false;
      input.focus();
      return;
    }
    // Map server-side rate-limit rejections to friendly toasts. The
    // callable throws code='resource-exhausted' with details.ruleId
    // identifying which rule fired; never expose internal counters.
    const code = (err && err.code) || '';
    const ruleId = (err && err.details && err.details.ruleId) || '';
    if (code === 'functions/resource-exhausted' || code === 'resource-exhausted') {
      if (ruleId === 'rate_limited_new_account') {
        showToast('New accounts can only send a few messages in the first 24 hours. Try again later.');
      } else if (ruleId === 'rate_limited_breadth') {
        showToast("Slow down. You can message up to 20 different people an hour.");
      } else {
        showToast("You're sending messages too fast. Please wait a moment.");
      }
    } else if (code === 'functions/permission-denied' || code === 'permission-denied') {
      showToast('You can no longer message this user.');
    } else if ((err && err.details && err.details.error) === 'email_unverified') {
      // r173: messaging now requires a verified email (throwaway-DM guard).
      showToast('Verify your email to send messages — check your inbox for the link.');
      try { window.maybeShowVerifyBanner && window.CURRENT_USER && window.maybeShowVerifyBanner(window.CURRENT_USER); } catch (_e) {}
    } else if ((err && err.details && err.details.error) === 'you_blocked_recipient') {
      showToast("You've blocked this user. Unblock them to send a message.");
    } else {
      showToast('Could not send message.');
    }
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = _sendLabel;
    input.focus();
  }
}
// ═══════════════════════════════════════════════════════════════
// INBOX
// ═══════════════════════════════════════════════════════════════
function formatRelativeTime(ts) {
  if (!ts) return '';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
  if (diffSec < 604800) return Math.floor(diffSec / 86400) + 'd ago';
  return date.toLocaleDateString();
}

function escapeInboxText(str) {
  return String(str || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// Realtime global unread badge.
//
// Previously this polled getDocs() every 60s — fine for an idle inbox but
// terrible during an active negotiation: the seller could be staring at
// the tab and not see the buyer's reply for up to a minute. We now keep
// a single onSnapshot listener on the user's 50 most-recent convs (same
// window the polling version used) and recompute the unread count on
// every snapshot. The open inbox piggy-backs on the same listener so
// new messages bubble to the top of the list in realtime.
//
// Lifecycle: attached on auth ready, idempotent on repeat calls. The
// load-time polling interval is gone — the listener is the source of
// truth.
let __unreadUnsub = null;
let __unreadAttaching = null; // in-flight attach, shared by concurrent callers
let __unreadLastConvs = []; // last snapshot, reused to repaint the open inbox.

async function refreshUnreadBadge() {
  // Back-compat shim — older code paths still call this. Attaching is
  // idempotent so repeat calls are safe.
  attachUnreadListener();
}

async function attachUnreadListener() {
  if (!window.CURRENT_USER) {
    if (__unreadUnsub) { try { __unreadUnsub(); } catch (_e) {} __unreadUnsub = null; }
    __unreadLastConvs = [];
    updateUnreadBadge(0);
    return;
  }
  // Conversation listener is the sole source of truth for the unread
  // badge. The previous design had a parallel user-doc listener that
  // asserted users/{uid}.unreadConversations (server-derived via the
  // onParticipantStateReadCount onDocumentUpdated trigger). After read,
  // the conv listener correctly wrote 0 but the user-doc listener
  // re-asserted whatever stale value sat on the user doc — last write
  // wins, badge stuck on. Detached 2026-06-05.
  //
  // Trade-off: this query is limit(50) ordered by lastMessageAt desc.
  // An unread conv ALWAYS has a fresh lastMessageAt by definition (new
  // message just arrived), so unread items sort to the top. Cap kicks
  // in only when a user has 50+ MORE-recently-active conversations than
  // an unread one — realistically unreachable since "unread = recent".
  // Worst case: badge displays 50 instead of true count for power
  // sellers with >50 simultaneous unread. Dot stays ON either way; no
  // false all-clear is possible.
  // r333: the guard has to cover the await below, not just the assignment.
  // __unreadUnsub is only set once onSnapshot returns, so two overlapping
  // callers — the load-event tick at 1.5s and openInbox() — both passed this
  // check, both attached, and the second overwrote the first's handle. The
  // orphan kept streaming and could never be detached. Park the promise here
  // so concurrent callers await the same attach.
  if (__unreadUnsub || __unreadAttaching) return __unreadAttaching || undefined;
  __unreadAttaching = (async () => {
  try {
    const { getFirestore, collection, query, where, orderBy, limit, onSnapshot } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    const q = query(
      collection(firestoreDb, 'conversations'),
      where('participants', 'array-contains', window.CURRENT_USER.uid),
      orderBy('lastMessageAt', 'desc'),
      limit(50)
    );
    __unreadUnsub = onSnapshot(q, (snap) => {
      const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
      if (!myUid) { updateUnreadBadge(0); return; }
      let count = 0;
      const convs = [];
      snap.docs.forEach(d => {
        // serverTimestamps:'estimate' — a just-written lastRead (markConversationRead)
        // is a PENDING serverTimestamp that otherwise reads back as null, which
        // isConvUnread treats as unread → the badge re-lights to the count right
        // after the user reads (and stays lit on flaky/backgrounded mobile until
        // the server round-trips). Estimating resolves the pending lastRead to
        // ≈now (> lastMessageAt) so the count clears immediately and stays cleared.
        const data = { id: d.id, ...d.data({ serverTimestamps: 'estimate' }) };
        if (isConvHidden(data, myUid)) return; // archived → exclude from badge + list
        if (isConvEmpty(data)) return;         // never written in → not a thread yet
        if (isConvUnread(data, myUid)) count++;
        convs.push(data);
      });
      __unreadLastConvs = convs;
      // Use the client-side recomputed count — see updateUnreadBadge
      // for why the server-derived field is no longer preferred.
      updateUnreadBadge(count);
      // If the inbox is open, repaint it so the seller sees the buyer's
      // reply bubble to the top of the list without re-opening the modal.
      const inboxOpen = document.getElementById('inboxBackdrop');
      if (inboxOpen && inboxOpen.classList.contains('open')) {
        renderInbox(convs);
      }
    }, (err) => {
      console.error('unread badge listener error:', err);
    });
  } catch (err) {
    console.error('Error attaching unread listener:', err);
  }
  })();
  try { await __unreadAttaching; } finally { __unreadAttaching = null; }
}

function detachUnreadListener() {
  // An attach may still be mid-flight (sign-out during boot). Wait for it to
  // land and tear it down too, or its listener outlives the session it
  // belonged to and keeps streaming the previous user's conversations.
  const pending = __unreadAttaching;
  if (pending) {
    pending.then(() => {
      if (__unreadUnsub) { try { __unreadUnsub(); } catch (_e) {} __unreadUnsub = null; }
    }).catch(() => {});
  }
  if (__unreadUnsub) { try { __unreadUnsub(); } catch (_e) {} __unreadUnsub = null; }
  __unreadLastConvs = [];
}

// Bootstrap the listener once auth has had a chance to resolve. We re-try
// for up to ~10s because Firebase auth init can lag the page load on
// slow connections. Sign-in/sign-out elsewhere can re-call
// attachUnreadListener() / detachUnreadListener() directly.
window.addEventListener('load', () => {
  let tries = 0;
  const tick = () => {
    if (window.CURRENT_USER) { attachUnreadListener(); return; }
    if (++tries < 5) setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
});
async function openInbox() {
  // Defence in depth — surface the polished sign-in prompt for guests
  // even when this is invoked from a place that isn't an action handler
  // (notif panel deep-link, mobile-nav-and-go, etc.).
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to view your messages', () => openInbox())) return;
  } else if (!window.CURRENT_USER) {
    showToast('Please sign in to view your messages.');
    return;
  }
  // r186: reclaim #inboxBody if the Activity hub adopted it.
  if (window.__activityRestore) window.__activityRestore();
  document.getElementById('inboxBackdrop').classList.add('open');
  (document.getElementById('app-scroll')||document.body).style.overflowY = 'hidden';
  await loadInbox();
}

function closeInbox() {
  const ib = document.getElementById('inboxBackdrop');
  if (ib) ib.classList.remove('open');
  // Only release body scroll if no other overlay is still claiming it.
  const stillBlocking = document.querySelector('#shopDashboard.open, #chatBackdrop.open, .modal-backdrop.open, .detail-backdrop.open, .verify-backdrop.open, .info-backdrop.open, #notifPanel.open');
  if (!stillBlocking) (document.getElementById('app-scroll')||document.body).style.overflowY = '';
}

async function loadInbox() {
  const body = document.getElementById('inboxBody');
  // If the realtime unread listener already has a snapshot cached, render
  // it instantly — saves a redundant getDocs() round-trip on every open.
  if (__unreadLastConvs && __unreadLastConvs.length > 0) {
    renderInbox(__unreadLastConvs);
  } else {
    body.innerHTML = '<div class="inbox-empty" aria-busy="true"><div class="sk sk-line long"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div>';
  }
  // Make sure the realtime listener is attached — this is what will keep
  // the open inbox refreshed as new messages arrive (see
  // attachUnreadListener: it calls renderInbox() on every snapshot
  // whenever the inbox modal is open).
  try { await attachUnreadListener(); } catch (_e) { /* swallow */ }
  // One-shot fallback fetch — covers the cold-open case where the
  // listener hasn't delivered its first snapshot yet (typically <500ms).
  // After the listener fires, its snapshot takes over.
  if (!__unreadLastConvs || __unreadLastConvs.length === 0) {
    try {
      const { getFirestore, collection, query, where, orderBy, getDocs, limit } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const firestoreDb = getFirestore();
      const q = query(
        collection(firestoreDb, 'conversations'),
        where('participants', 'array-contains', window.CURRENT_USER.uid),
        orderBy('lastMessageAt', 'desc'),
        limit(100)
      );
      const snap = await getDocs(q);
      // Don't clobber a snapshot the listener may have just delivered.
      if (!__unreadLastConvs || __unreadLastConvs.length === 0) {
        renderInbox(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }
    } catch (err) {
      console.error('Error loading inbox:', err);
      if (!__unreadLastConvs || __unreadLastConvs.length === 0) {
        body.innerHTML = '<div class="inbox-empty">Could not load messages.</div>';
      }
    }
  }
}

function renderInbox(convs) {
  const body = document.getElementById('inboxBody');
  // Defensive: exclude conversations I've archived (covers the cold-open
  // getDocs fallback path; the live listener already filters these out).
  const _meUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  if (_meUid) convs = (convs || []).filter(c => !isConvHidden(c, _meUid) && !isConvEmpty(c));
  if (convs.length === 0) {
    // Polished empty state (#3 audit follow-up). Icon + display
    // headline + body + green pill CTA that closes the inbox and
    // routes back to browse. Icon: window.ICONS.message (envelope).
    body.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-state-icon">' + (window.ICONS && window.ICONS.message || '') + '</div>' +
        '<h3 class="empty-state-title">Your inbox is empty</h3>' +
        '<p class="empty-state-sub">Browse listings and tap <strong>Message seller</strong> on anything you have a question about. Conversations show up here.</p>' +
        '<button class="empty-state-cta" data-action="close-inbox-and-browse" type="button">Browse listings</button>' +
      '</div>';
    updateUnreadBadge(0);
    return;
  }
  const myUid = window.CURRENT_USER.uid;
  let unreadCount = 0;
  body.innerHTML = convs.map(c => {
    const isUnread = isConvUnread(c, myUid);
    if (isUnread) unreadCount++;
    const cat = c.listingCat || 'accessories';
    const lid = c.listingId || '';
    // Thumb starts as the category-icon placeholder so the list paints
    // instantly; hydrateInboxThumbs() below swaps in the real listing
    // photo once the listing doc resolves (same data the chat-detail
    // header uses — see renderChatListingCard / openChatFromConversation).
    const cidAttr = window.safeAttr(window.safeId(c.id));
    return `
    <div class="inbox-swipe" data-conv-id="${cidAttr}">
      <button type="button" class="inbox-archive-btn" data-action="archive-conv-row" data-conv-id="${cidAttr}" aria-label="Archive this conversation">Archive</button>
      <div class="inbox-swipe-body">
    <div class="inbox-item ${isUnread ? 'unread' : ''}" data-action="open-conv" data-conv-id="${cidAttr}">
      <div class="inbox-item-emoji placeholder-art" data-inbox-thumb data-listing-id="${window.safeAttr(window.safeId(lid))}" data-listing-cat="${window.safeAttr(cat)}" style="width:44px;height:44px;border-radius:8px;background-size:cover;background-position:center">${window.CATEGORY_ICON(cat)}</div>
      <div class="inbox-item-content">
        <div class="inbox-item-title" data-inbox-title data-listing-id="${window.safeAttr(window.safeId(lid))}">${escapeInboxText(c.listingTitle || 'Conversation')}</div>
        <div class="inbox-item-preview">${escapeInboxText(inboxPreviewText(c))}</div>
      </div>
      <div class="inbox-item-dot"></div>
      <div class="inbox-item-time">${formatRelativeTime(c.lastMessageAt)}</div>
    </div>
      </div>
    </div>`;
  }).join('');
  wireInboxSwipe(body);
  updateUnreadBadge(unreadCount);
  // Fire-and-forget: replace category-icon placeholders with the real
  // listing photo. Bounded + cached so the realtime listener repainting
  // the inbox doesn't re-fetch the same listings on every snapshot.
  try { hydrateInboxThumbs(convs); } catch (_e) { /* placeholder is fine */ }
  // Re-apply any active search filter after a re-render so it persists.
  try { const f = document.getElementById('inboxFilter'); if (f && f.value && window.filterInbox) window.filterInbox(f.value); } catch (_e) {}
}

// Client-side inbox search — hides conversation rows that don't match the
// query (listing title, partner name, last-message preview). Pure DOM filter,
// no query/index; re-applied by renderInbox on each snapshot.
// r349 (P0-4): the page's CSP has script-src-attr 'none', so every inline
// on*="" attribute was silently dead. These four are wired here instead.
//   • #inboxFilter input → filterInbox   (inbox search never filtered)
//   • .mobile-nav-drawer-inner click     (tap inside the drawer closed it)
//     r358: the r349 replacement — a stopPropagation listener on the panel —
//     also stopped every drawer link from reaching the document-level
//     data-action dispatcher, so About/Guidelines/Logo Bingo/My Shop/Sign out
//     did nothing (web since r349, iOS since 2.5.3). The panel no longer
//     swallows clicks; close-mobile-nav itself ignores bubbled taps that
//     didn't land on the backdrop or a close control.
//   • "Show message anyway" button       → data-action="msg-show-anyway"
//   • sold-thumb <img onerror> fallback  → capture-phase error listener
(function wireFormerInlineHandlers() {
  const inbox = document.getElementById('inboxFilter');
  if (inbox && !inbox.__wired) { inbox.__wired = true; inbox.addEventListener('input', () => { window.__lastInboxFilter = inbox.value; if (window.filterInbox) window.filterInbox(inbox.value); }); }
  if (!document.__imgFallbackWired) {
    document.__imgFallbackWired = true;
    document.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.classList || !img.classList.contains('js-img-fallback')) return;
      const span = document.createElement('span');
      span.className = 'item-emoji placeholder-art';
      span.style.cssText = 'width:36px;height:36px;border-radius:6px';
      span.innerHTML = img.dataset.fallback || '';
      img.replaceWith(span);
    }, true);
  }
})();
window.filterInbox = function(q) {
  const query = String(q || '').trim().toLowerCase();
  const body = document.getElementById('inboxBody');
  if (!body) return;
  const items = body.querySelectorAll('.inbox-item');
  let shown = 0;
  items.forEach((it) => {
    const match = !query || (it.textContent || '').toLowerCase().includes(query);
    it.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  let none = body.querySelector('.inbox-filter-none');
  if (query && shown === 0 && items.length) {
    if (!none) { none = document.createElement('div'); none.className = 'inbox-filter-none inbox-empty'; body.appendChild(none); }
    none.textContent = 'No conversations match your search.';
    none.style.display = '';
  } else if (none) { none.style.display = 'none'; }
};

// Per-conversation rows only carry denormalized listingId/listingCat/title
// on the conversation doc — NOT the photo. The chat-detail header gets the
// photo by fetching listings/{listingId} on open (openChatFromConversation).
// We replicate that fetch here, but: (a) dedupe by listingId, (b) cache
// results across renderInbox repaints (the realtime unread listener calls
// renderInbox on every snapshot), and (c) only patch the DOM thumb in
// place. This bounds network to the number of DISTINCT listings currently
// visible in the inbox (<=100, deduped, cached) instead of an N+1 per
// snapshot. Fallback chain: photos[0] -> category icon -> gray placeholder.
const __inboxListingCache = new Map(); // listingId -> { photo, cat } | null(deleted)
let __inboxThumbsLoading = false;

async function hydrateInboxThumbs(convs) {
  const body = document.getElementById('inboxBody');
  if (!body) return;
  // Distinct, non-empty listing ids that aren't already resolved.
  const ids = [];
  const seen = new Set();
  convs.forEach(c => {
    const id = c.listingId;
    if (id && !seen.has(id)) { seen.add(id); if (!__inboxListingCache.has(id)) ids.push(id); }
  });
  // Paint anything already cached immediately (covers realtime repaints).
  applyInboxThumb();
  applyInboxTitle();
  if (ids.length === 0 || __inboxThumbsLoading) return;
  __inboxThumbsLoading = true;
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    // Sequential-ish with a small concurrency cap; inbox listing counts are
    // small in practice and we don't want to hammer Firestore on open.
    for (const id of ids) {
      try {
        const snap = await getDoc(doc(firestoreDb, 'listings', id));
        if (snap.exists()) {
          const d = snap.data();
          const raw = d.photos && d.photos[0];
          const photo = raw
            ? (window.safeImgUrl ? window.safeImgUrl(raw) : String(raw))
            : '';
          __inboxListingCache.set(id, { photo: photo, cat: d.cat || d.listingCat || '', title: d.title || '' });
        } else {
          // Listing deleted / not found -> gray placeholder (no icon).
          __inboxListingCache.set(id, null);
        }
      } catch (_e) {
        // Permission/transient error: leave uncached so a later open can
        // retry; the category-icon placeholder stays in the meantime.
      }
      applyInboxThumb();
      applyInboxTitle();
    }
  } catch (_e) {
    /* dynamic import failed — placeholders stay; no hard failure */
  } finally {
    __inboxThumbsLoading = false;
  }

  function applyInboxThumb() {
    const els = body.querySelectorAll('[data-inbox-thumb]');
    els.forEach(el => {
      const id = el.getAttribute('data-listing-id') || '';
      if (!id || !__inboxListingCache.has(id)) return; // unresolved -> keep category icon
      const entry = __inboxListingCache.get(id);
      if (entry && entry.photo) {
        // Listing has a photo -> show it.
        if (el.getAttribute('data-thumb-state') === 'photo') return;
        el.classList.remove('placeholder-art');
        el.innerHTML = '';
        el.style.backgroundImage = `url("${entry.photo.replace(/"/g, '%22')}")`;
        el.setAttribute('data-thumb-state', 'photo');
      } else if (entry === null) {
        // Listing deleted / not found -> plain gray placeholder, no icon.
        if (el.getAttribute('data-thumb-state') === 'gone') return;
        el.classList.add('placeholder-art');
        el.style.backgroundImage = '';
        el.innerHTML = '';
        el.setAttribute('data-thumb-state', 'gone');
      }
      // entry has no photo but listing exists -> leave the category icon
      // that renderInbox already painted (fallback chain step 2).
    });
  }

  // Sibling hydration for the title text. The conv doc has a
  // denormalized `listingTitle` snapshotted at create time, which goes
  // stale the moment the seller edits the listing. The chat-detail
  // header already fetches the live listing; this pulls the same fresh
  // title into the inbox rows so both surfaces agree.
  function applyInboxTitle() {
    const els = body.querySelectorAll('[data-inbox-title]');
    els.forEach(el => {
      const id = el.getAttribute('data-listing-id') || '';
      if (!id || !__inboxListingCache.has(id)) return;
      const entry = __inboxListingCache.get(id);
      if (entry && entry.title && el.textContent !== entry.title) {
        el.textContent = entry.title;
      }
    });
  }
}

// r284: the inbox one-liner, with this viewer's soft-delete applied.
// previewHidden.{uid}.at pins the override to the lastMessageAt it was
// written for, so a newer message from either side retires it automatically
// and nobody's snippet gets stuck. Unread counts are computed from
// lastMessageAt vs lastRead and are deliberately untouched by any of this —
// hiding a message for yourself must not mark a thread read.
function inboxPreviewText(c) {
  const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  const fallback = c.lastMessageText || 'No messages yet';
  if (!myUid) return fallback;
  const ph = c.previewHidden && c.previewHidden[myUid];
  if (!ph) return fallback;
  const lastMs = c.lastMessageAt && c.lastMessageAt.toMillis ? c.lastMessageAt.toMillis() : 0;
  if (!lastMs || Number(ph.at) !== lastMs) return fallback; // stale → ignore
  return ph.text || 'No messages yet';
}

function isConvUnread(conv, myUid) {
  if (!conv.lastMessageSenderId || conv.lastMessageSenderId === myUid) return false;
  const myLastRead = conv.lastRead && conv.lastRead[myUid];
  if (!myLastRead) return true;
  const lastMsg = conv.lastMessageAt;
  if (!lastMsg || !lastMsg.toMillis || !myLastRead.toMillis) return false;
  return lastMsg.toMillis() > myLastRead.toMillis();
}

// Soft-hide / Archive: a conversation is hidden from MY inbox if I've
// archived it AND no newer message has arrived since. hidden[myUid] is the
// archive timestamp; a new message (lastMessageAt > archive time) re-
// surfaces the thread so transaction-relevant replies aren't missed.
// r288: a conversation with no message has never been talked in. Both the
// "open a chat" path and order placement create the doc up front, so an
// inbox showed rows that read as unread messages from the buyer — Jake had
// three, including a SECOND "Masters Head Cover" beside the real thread and
// a "Brooks Koepka" nobody had written in. lastMessageSenderId is written
// only by the sendMessage callable, so its absence is the reliable tell.
// The doc is left alone: the thread springs into the list the moment
// someone actually sends something.
function isConvEmpty(conv) {
  return !(conv && conv.lastMessageSenderId);
}

function isConvHidden(conv, myUid) {
  // r173: a blocked pair hides the thread on BOTH sides. blockedBy is
  // server-stamped (syncBlockedThreads trigger, not client-writable), so
  // neither party can forge it; unblocking clears it and the thread returns.
  if (conv.blockedBy && Object.keys(conv.blockedBy).length > 0) return true;
  const h = conv.hidden && conv.hidden[myUid];
  if (!h) return false;
  const lastMsg = conv.lastMessageAt;
  if (!lastMsg || !lastMsg.toMillis || !h.toMillis) return true;
  return lastMsg.toMillis() <= h.toMillis();
}

function updateUnreadBadge(count) {
  // Multiple places display the unread count: top-nav inbox icon, the
  // bottom-nav Inbox tab on mobile, and the Messages item in the user
  // dropdown. All use the .unread-badge class. Driven solely by the
  // conv-listener's client-recomputed count (attachUnreadListener);
  // the parallel user-doc listener that asserted the server-derived
  // unreadConversations field was detached 2026-06-05 because it
  // raced with this path and re-asserted stale values after read.
  document.querySelectorAll('.unread-badge').forEach((badge) => {
    badge.textContent = count > 99 ? '99+' : (count || '');
    badge.classList.toggle('active', count > 0);
  });
}

async function openChatFromConversation(conversationId) {
  if (!window.CURRENT_USER) return;
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    const convSnap = await getDoc(doc(firestoreDb, 'conversations', conversationId));
    if (!convSnap.exists()) {
      showToast('Conversation not found.');
      return;
    }
    const conv = convSnap.data();
    let listing = { id: conv.listingId, title: conv.listingTitle, cat: conv.listingCat, brand: '' };
    try {
      const listingSnap = await getDoc(doc(firestoreDb, 'listings', conv.listingId));
      if (listingSnap.exists()) {
        listing = { id: listingSnap.id, ...listingSnap.data() };
      }
    } catch (e) { /* ignore */ }

    const otherUserId = conv.participants.find(p => p !== window.CURRENT_USER.uid);
    currentChat = { conversationId, listing, otherUserId, unreadSince: (conv.lastRead && conv.lastRead[window.CURRENT_USER.uid] && conv.lastRead[window.CURRENT_USER.uid].toMillis) ? conv.lastRead[window.CURRENT_USER.uid].toMillis() : 0 };
    // Mark conversation as read (writes both legacy lastRead.{uid} +
    // new participantState/{uid}.lastReadAt for server-side derivation).
    try {
      await markConversationRead(conversationId);
      // Optimistic local clear so the badge drops to 0 immediately instead
      // of waiting for the server-resolved snapshot — serverTimestamp() is
      // null in the latency-compensated snapshot, so isConvUnread would
      // otherwise still read unread until the round-trip lands.
      try {
        const _me = window.CURRENT_USER.uid;
        const _c = (__unreadLastConvs || []).find(c => c.id === conversationId);
        if (_c) {
          _c.lastRead = Object.assign({}, _c.lastRead, { [_me]: { toMillis: () => Date.now() } });
          let _n = 0;
          (__unreadLastConvs || []).forEach(c => { if (!isConvHidden(c, _me) && !isConvEmpty(c) && isConvUnread(c, _me)) _n++; });
          updateUnreadBadge(_n);
        }
      } catch (_e) { /* optimistic only */ }
    }
    catch (e) { console.error('Could not mark read:', e); }
    closeInbox();
    openChatUI();
    loadMessages();
  } catch (err) {
    console.error('Error opening chat from conversation:', err);
    showToast('Could not open chat.');
  }
}

// ─── Notifications panel (Feature: notifications-v1) ─────────────────
// Bell icon dropdown that aggregates pending offers, new orders, unread
// messages, and Stripe action items. Lazy-fetched on open with a 30s
// cache so re-opening doesn't re-fetch. Per-section error isolation.
window.__notifCache = { ts: 0, data: null };
const NOTIF_CACHE_MS = 30000;

// ── Notification "seen" high-water mark ──────────────────────────────
// The red bell dot must CLEAR once the user has viewed the panel, and
// only re-light when something genuinely new arrives. Orders + offers are
// persistent state (a shipped order sits in the list for days), so
// counting their mere presence kept the dot lit forever — the exact bug
// where a "Shipped: awaiting delivery" order never stopped showing unread.
// Instead we remember the newest activity timestamp the user has seen
// (per-uid, localStorage) and light the dot for orders/offers only when
// there is activity newer than that. Messages keep their own unread
// semantics (they clear when the conversation is read); Stripe action
// items stay lit until resolved.
function _notifSeenKey() {
  const uid = window.CURRENT_USER && window.CURRENT_USER.uid;
  return uid ? ('tb_notifSeen_' + uid) : null;
}
function getNotifSeenTs() {
  try { const k = _notifSeenKey(); if (!k) return 0; return Number(localStorage.getItem(k)) || 0; }
  catch (_e) { return 0; }
}
function setNotifSeenTs(ts) {
  try { const k = _notifSeenKey(); if (k && ts) localStorage.setItem(k, String(ts)); }
  catch (_e) {}
}
function _notifTsMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}
// Newest createdAt/respondedAt across orders + offers in the cache.
function newestNotifActivityTs(data) {
  let newest = 0;
  const scan = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach(o => { newest = Math.max(newest, _notifTsMillis(o.createdAt), _notifTsMillis(o.respondedAt)); });
  };
  if (data) { scan(data.orders); scan(data.offers); }
  return newest;
}
// Persist the current newest activity as "seen" — called when the user
// opens the notifications panel.
function markNotificationsSeen() {
  const data = window.__notifCache && window.__notifCache.data;
  const newest = newestNotifActivityTs(data);
  if (newest) setNotifSeenTs(newest);
}

function openNotifications() {
  const panel = document.getElementById('notifPanel');
  const btn = document.getElementById('navNotifBtn');
  if (!panel) return;
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  // On mobile the panel is a full-screen sheet — lock body scroll.
  if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
    (document.getElementById('app-scroll')||document.body).style.overflowY = 'hidden';
  }
  // Opening the panel = the user has seen the current activity. Mark the
  // newest order/offer as seen once the data resolves, then clear the dot.
  loadNotifications().then(() => { markNotificationsSeen(); refreshNotifDot(); }).catch(() => {});
}

function closeNotifications() {
  const panel = document.getElementById('notifPanel');
  const btns = document.querySelectorAll('[data-action="toggle-notifications"]');
  if (panel) {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }
  btns.forEach(b => b.setAttribute('aria-expanded', 'false'));
  // Only release body scroll if no other modal still claims it.
  // Inbox / shop dashboard / chat each set body overflow; we shouldn't
  // clobber theirs. Heuristic: only clear if no .open backdrop visible.
  const stillBlocking = document.querySelector('#shopDashboard.open, #inboxBackdrop.open, #chatBackdrop.open, .modal-backdrop.open, .detail-backdrop.open, .verify-backdrop.open, .info-backdrop.open');
  if (!stillBlocking) (document.getElementById('app-scroll')||document.body).style.overflowY = '';
}

function toggleNotifications() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  if (panel.classList.contains('open')) closeNotifications();
  else openNotifications();
}

async function loadNotifications(force) {
  const body = document.getElementById('notifBody');
  if (!body) return;
  if (!window.CURRENT_USER) {
    body.innerHTML = '<div class="notif-empty-all">Sign in to see notifications.</div>';
    window.__notifCache = { ts: 0, data: null };
    document.querySelectorAll('.notif-dot').forEach(d => d.classList.remove('active'));
    return;
  }
  // Cache hit
  const now = Date.now();
  if (!force && window.__notifCache.data && (now - window.__notifCache.ts) < NOTIF_CACHE_MS) {
    renderNotifications(window.__notifCache.data);
    return;
  }
  // Loading skeleton (3 rows)
  body.innerHTML = `
    <div class="notif-section">
      <div class="notif-section-head"><span>Loading…</span></div>
      ${[0,1,2].map(() => `
        <div class="notif-skeleton-row">
          <div style="flex:1">
            <div class="notif-skeleton-bar tall" style="width:60%"></div>
            <div class="notif-skeleton-bar" style="width:40%;margin-top:6px"></div>
          </div>
          <div class="notif-skeleton-bar" style="width:36px"></div>
        </div>`).join('')}
    </div>`;
  const [offersR, ordersR, msgsR, stripeR] = await Promise.all([
    fetchNotifOffers().catch(e => ({ error: true, msg: e && e.message || 'error' })),
    fetchNotifOrders().catch(e => ({ error: true, msg: e && e.message || 'error' })),
    fetchNotifUnreadMessages().catch(e => ({ error: true, msg: e && e.message || 'error' })),
    fetchNotifStripeStatus().catch(e => ({ error: true, msg: e && e.message || 'error' })),
  ]);
  const data = { offers: offersR, orders: ordersR, messages: msgsR, stripe: stripeR };
  window.__notifCache = { ts: Date.now(), data };
  renderNotifications(data);
}

async function fetchNotifOffers() {
  if (!window.CURRENT_USER) return [];
  const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
    await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
  const db = getFirestore();
  let docs;
  try {
    const snap = await getDocs(query(
      collection(db, 'offers'),
      where('sellerId', '==', window.CURRENT_USER.uid),
      where('status', '==', 'pending'),
      orderBy('createdAt', 'desc'),
      limit(50),
    ));
    docs = snap.docs;
  } catch (_idxErr) {
    const snap = await getDocs(query(
      collection(db, 'offers'),
      where('sellerId', '==', window.CURRENT_USER.uid),
      limit(50),
    ));
    docs = snap.docs.filter(d => (d.data().status || 'pending') === 'pending');
  }
  const offers = docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return bt - at;
    })
    .slice(0, 8);
  // Resolve buyer name + listing title in parallel (best-effort).
  const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
  await Promise.all(offers.map(async o => {
    try {
      if (o.listingId) {
        const ls = await getDoc(doc(db, 'listings', String(o.listingId)));
        if (ls.exists()) o._listingTitle = (ls.data() || {}).title || 'Listing';
      }
    } catch (_e) {}
    try {
      if (o.buyerId && typeof loadProfile === 'function') {
        const prof = await loadProfile(o.buyerId);
        o._buyerName = (prof && prof.displayName) || ('Buyer •••• ' + (o.buyerId || '').slice(-4).toUpperCase());
      }
    } catch (_e) {}
  }));
  return offers;
}

async function fetchNotifOrders() {
  if (!window.CURRENT_USER) return [];
  const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
    await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
  const db = getFirestore();
  // We only render the 8 most-recent unfulfilled orders — fetch a small
  // window ordered by createdAt so the dot/count is fast even for
  // sellers with hundreds of historical orders.
  const snap = await getDocs(query(
    collection(db, 'orders'),
    where('sellerId', '==', window.CURRENT_USER.uid),
    orderBy('createdAt', 'desc'),
    limit(50),
  ));
  const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(o => {
      const stage = o.fulfillmentStatus || 'awaiting_seller_shipment';
      // pre-fulfillment: paid (awaiting shipment) or shipped (awaiting delivery confirmation)
      return stage === 'awaiting_seller_shipment' || stage === 'shipped';
    })
    .sort((a, b) => {
      const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return bt - at;
    })
    .slice(0, 8);
  // Resolve buyer name (best-effort)
  await Promise.all(orders.map(async o => {
    try {
      if (o.buyerId && typeof loadProfile === 'function') {
        const prof = await loadProfile(o.buyerId);
        o._buyerName = (prof && prof.displayName) || ('Buyer •••• ' + (o.buyerId || '').slice(-4).toUpperCase());
      }
    } catch (_e) {}
  }));
  return orders;
}

async function fetchNotifUnreadMessages() {
  if (!window.CURRENT_USER) return [];
  const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
    await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
  const db = getFirestore();
  const snap = await getDocs(query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', window.CURRENT_USER.uid),
    orderBy('lastMessageAt', 'desc'),
    limit(50),
  ));
  const myUid = window.CURRENT_USER.uid;
  const convs = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
    .filter(c => isConvUnread(c, myUid))
    .sort((a, b) => {
      const at = a.lastMessageAt && a.lastMessageAt.toMillis ? a.lastMessageAt.toMillis() : 0;
      const bt = b.lastMessageAt && b.lastMessageAt.toMillis ? b.lastMessageAt.toMillis() : 0;
      return bt - at;
    })
    .slice(0, 8);
  // Refresh stale listingTitle. The denormalized field on the conv doc
  // is snapshotted at create time and never re-synced; a seller editing
  // their listing leaves notif-panel rows showing the old name. Read
  // the live listing (via __inboxListingCache so subsequent inbox-opens
  // are warm) and overlay the fresh title. Same pattern fetchNotifOffers
  // / fetchNotifOrders already use for offers + orders.
  const { doc, getDoc } =
    await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
  await Promise.all(convs.map(async (c) => {
    if (!c.listingId) return;
    if (__inboxListingCache.has(c.listingId)) {
      const cached = __inboxListingCache.get(c.listingId);
      if (cached && cached.title) c.listingTitle = cached.title;
      return;
    }
    try {
      const ls = await getDoc(doc(db, 'listings', String(c.listingId)));
      if (ls.exists()) {
        const d = ls.data() || {};
        const raw = d.photos && d.photos[0];
        const photo = raw
          ? (window.safeImgUrl ? window.safeImgUrl(raw) : String(raw))
          : '';
        __inboxListingCache.set(c.listingId, {
          photo, cat: d.cat || d.listingCat || '', title: d.title || '',
        });
        if (d.title) c.listingTitle = d.title;
      }
    } catch (_e) { /* leave the stale denormalized fallback */ }
  }));
  return convs;
}

async function fetchNotifStripeStatus() {
  if (!window.CURRENT_USER) return { needsAction: false };
  // Check the user's Firestore profile first — only show banner if they
  // appear to be (or are becoming) a seller. Determined by having any
  // listings — cheap proxy. If the heavy callable is too slow, swallow.
  try {
    const { getFirestore, collection, query, where, getDocs, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const lsnap = await getDocs(query(
      collection(db, 'listings'),
      where('sellerId', '==', window.CURRENT_USER.uid),
      limit(1),
    ));
    if (lsnap.empty) return { needsAction: false };
  } catch (_e) {
    return { needsAction: false };
  }
  // User is a seller; ask the Stripe Connect callable for status.
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'getStripeAccountStatus');
    const res = await fn();
    const status = (res && res.data) || {};
    const needsAction = !status.connected || !status.chargesEnabled || !status.payoutsEnabled
      || ((status.requirementsDue || []).length > 0);
    return { needsAction, status };
  } catch (_e) {
    return { needsAction: false };
  }
}

function renderNotifications(data) {
  const body = document.getElementById('notifBody');
  if (!body) return;
  const sections = [];

  // Section: offers
  sections.push(renderNotifSection({
    title: 'Offers received',
    result: data.offers,
    errorMsg: "Couldn't load offers",
    emptyMsg: 'No pending offers.',
    rowsHtml: (offers) => offers.map(o => {
      const id = window.safeAttr(window.safeId(o.id));
      const title = window.safeText(o._listingTitle || 'Listing');
      const sub = window.safeText((o._buyerName || 'Buyer') + ' · ' + formatRelativeTime(o.createdAt));
      const amt = '$' + Number(o.amount || 0).toLocaleString();
      return `<button type="button" class="notif-row" data-action="notif-open-offer" data-offer-id="${id}">
        <div class="notif-row-body">
          <div class="notif-row-title">${title}</div>
          <div class="notif-row-sub">${sub}</div>
        </div>
        <div class="notif-row-meta"><div class="notif-row-amt">${amt}</div></div>
      </button>`;
    }).join(''),
  }));

  // Section: new orders
  sections.push(renderNotifSection({
    title: 'New orders',
    result: data.orders,
    errorMsg: "Couldn't load orders",
    emptyMsg: 'No new orders.',
    rowsHtml: (orders) => orders.map(o => {
      const id = window.safeAttr(window.safeId(o.id));
      const stage = o.fulfillmentStatus || 'awaiting_seller_shipment';
      const stageLabel = stage === 'shipped' ? 'Shipped: awaiting delivery' : 'Paid: ship to buyer';
      const title = window.safeText(o.listingTitle || o.title || 'Order');
      const sub = window.safeText((o._buyerName || 'Buyer') + ' · ' + formatRelativeTime(o.createdAt));
      return `<button type="button" class="notif-row" data-action="notif-open-order" data-order-id="${id}">
        <div class="notif-row-body">
          <div class="notif-row-title">${title}</div>
          <div class="notif-row-sub">${sub}</div>
        </div>
        <div class="notif-row-meta">${window.safeText(stageLabel)}</div>
      </button>`;
    }).join(''),
  }));

  // Section: unread messages
  sections.push(renderNotifSection({
    title: 'Unread messages',
    result: data.messages,
    errorMsg: "Couldn't load messages",
    emptyMsg: 'No unread messages.',
    rowsHtml: (convs) => convs.map(c => {
      const id = window.safeAttr(window.safeId(c.id));
      const title = window.safeText(c.listingTitle || 'Conversation');
      const snippet = window.safeText(c.lastMessageText || '');
      const time = formatRelativeTime(c.lastMessageAt);
      return `<button type="button" class="notif-row" data-action="notif-open-conv" data-conv-id="${id}">
        <div class="notif-row-body">
          <div class="notif-row-title">${title}</div>
          <div class="notif-row-sub">${snippet}</div>
        </div>
        <div class="notif-row-meta">${window.safeText(time)}</div>
      </button>`;
    }).join(''),
  }));

  // Stripe action row (only renders if needsAction)
  let stripeHtml = '';
  if (data.stripe && !data.stripe.error && data.stripe.needsAction) {
    stripeHtml = `<div class="notif-section">
      <div class="notif-section-head"><span>Action needed</span></div>
      <button type="button" class="notif-stripe-row" data-action="notif-open-stripe">
        <span data-ico="shield" aria-hidden="true"></span>
        <div class="notif-stripe-text">
          <strong>Finish Stripe setup to receive payouts.</strong>
          <span>Connect your bank to start getting paid.</span>
        </div>
      </button>
    </div>`;
  }

  // Empty-all check
  const offersEmpty   = !data.offers   || (Array.isArray(data.offers)   && data.offers.length === 0);
  const ordersEmpty   = !data.orders   || (Array.isArray(data.orders)   && data.orders.length === 0);
  const msgsEmpty     = !data.messages || (Array.isArray(data.messages) && data.messages.length === 0);
  const stripeNoAction = !data.stripe || data.stripe.error || !data.stripe.needsAction;
  const allEmpty = offersEmpty && ordersEmpty && msgsEmpty && stripeNoAction;
  const anyError = (data.offers && data.offers.error) || (data.orders && data.orders.error)
    || (data.messages && data.messages.error);

  if (allEmpty && !anyError) {
    body.innerHTML = `<div class="notif-empty-all">You're all caught up.</div>`;
  } else {
    body.innerHTML = sections.join('') + stripeHtml;
  }
  // Render any [data-ico] glyphs we just injected (shield in stripe row).
  body.querySelectorAll('[data-ico]').forEach((el) => {
    const name = el.dataset.ico;
    const svg = window.ICONS && window.ICONS[name];
    if (svg && !el.firstChild) el.innerHTML = svg;
  });
  refreshNotifDot();
}

function renderNotifSection({ title, result, errorMsg, emptyMsg, rowsHtml }) {
  const isError = result && result.error;
  const items = Array.isArray(result) ? result : [];
  const isEmpty = !isError && items.length === 0;
  const emptyCls = isEmpty ? ' empty' : '';
  return `<div class="notif-section${emptyCls}">
    <div class="notif-section-head">
      <span>${window.safeText(title)}</span>
      <span class="notif-section-count">${items.length}</span>
    </div>
    ${isError
      ? `<div class="notif-section-error">${window.safeText(errorMsg)}</div>`
      : (isEmpty
          ? `<div class="notif-section-empty-msg">${window.safeText(emptyMsg)}</div>`
          : rowsHtml(items))}
  </div>`;
}

function refreshNotifDot() {
  const data = window.__notifCache.data;
  let dot = false;
  if (data) {
    // Messages carry their own unread state — they clear when the
    // conversation is read, so count their presence directly.
    if (Array.isArray(data.messages) && data.messages.length) dot = true;
    // Stripe action items are a real to-do; keep the dot lit until resolved.
    if (data.stripe && data.stripe.needsAction) dot = true;
    // Orders + offers are persistent state: light the dot only for
    // activity NEWER than the last time the user opened the panel, so
    // viewing clears it and a genuinely new order/offer re-lights it.
    if (newestNotifActivityTs(data) > getNotifSeenTs()) dot = true;
  }
  document.querySelectorAll('.notif-dot').forEach(d => d.classList.toggle('active', dot));
}

// Bust the notif cache + kick a background refresh so the red dot
// reconciles after a read-state mutation (msg read, offer resolved,
// order shipped/delivered). Without this the dot can stay stuck for
// up to 60s until the background tick in loadNotifications fires.
// Best-effort; swallows.
function invalidateNotifCache() {
  try {
    if (window.__notifCache) window.__notifCache.ts = 0;
    if (typeof loadNotifications === 'function') {
      loadNotifications(true).catch(() => {});
    }
  } catch (_e) {}
}
window.invalidateNotifCache = invalidateNotifCache;

// Background refresh so the red dot updates without re-opening. NET-001: the
// old version forced a 4-query Firestore read EVERY 60s on every tab regardless
// of visibility (~72k reads/day per idle tab). Now:
//   - never poll a hidden/backgrounded tab,
//   - refresh once immediately when the tab returns to the foreground,
//   - 120s base cadence, backing off to 10min after 10min of no interaction.
// Mutation-driven invalidateNotifCache() still force-refreshes on the user's
// own actions, so the poll only needs to catch externally-originated changes.
(function notifPoll() {
  const ACTIVE_MS = 120000;       // foreground cadence
  const IDLE_AFTER_MS = 600000;   // 10 min no interaction -> idle (also idle cadence)
  let lastInteraction = Date.now();
  let lastPoll = 0;
  const bump = () => { lastInteraction = Date.now(); };
  document.addEventListener('pointerdown', bump, { passive: true });
  document.addEventListener('keydown', bump, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    bump();
    if (window.CURRENT_USER) { lastPoll = Date.now(); loadNotifications(true).catch(() => {}); }
  });
  setInterval(() => {
    if (!window.CURRENT_USER || document.hidden) return; // never poll hidden tabs
    const now = Date.now();
    const idle = now - lastInteraction > IDLE_AFTER_MS;
    if (now - lastPoll < (idle ? IDLE_AFTER_MS : ACTIVE_MS)) return;
    lastPoll = now;
    loadNotifications(true).catch(() => {});
  }, 30000);
})();

async function openShopDashboard() {
  // Guests get the polished "Sign in to start selling" prompt; the
  // intent re-opens the dashboard once they finish auth.
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to start selling on TeeBox', () => openShopDashboard())) return;
  } else if (!window.CURRENT_USER) {
    showToast('Please sign in to view your shop.'); return;
  }
  document.getElementById('shopDashboard').classList.add('open');
  (document.getElementById('app-scroll')||document.body).style.overflowY = 'hidden';
  // Reset count-up state so each open re-animates the headline numbers.
  ['statRevenue','statSold','statActive','statAvg','statViews'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.dataset.count = '0';
  });
  await loadShopData();
  // First-run seller tour (Feature: tour-v1) — fires once per device.
  try { maybeRunSellerTour(); } catch (_) {}
}
window.SHOP_DATA = { listings: [], orders: [], profile: null };

async function loadShopData() {
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const firestoreDb = getFirestore();
    const uid = window.CURRENT_USER.uid;

    // Cap each fan-out — a Pro seller with >500 listings still gets fast
    // dashboard load; the long-tail can paginate later. Sort by createdAt
    // so pagination has a natural cursor when we wire it up.
    const SHOP_LISTINGS_CAP = 500;
    const SHOP_ORDERS_CAP = 500;
    const listingsQ = query(
      collection(firestoreDb, 'listings'),
      where('sellerId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(SHOP_LISTINGS_CAP)
    );
    const listingsSnap = await getDocs(listingsQ);
    const listings = listingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const ordersQ = query(
      collection(firestoreDb, 'orders'),
      where('sellerId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(SHOP_ORDERS_CAP)
    );
    const ordersSnap = await getDocs(ordersQ);
    const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Profile is needed so the active-listings table can render correct
    // Pin / Unpin labels (Feature #7).
    const profile = await loadProfile(uid);

    window.SHOP_DATA = { listings, orders, profile };
    renderShopStats();
    renderShopTables();
    renderPayouts();
    wireRevenueRangeButtons();
    renderRevenueChart('7');
    // Render the Pro Seller tier banner at the top of the dashboard.
    // Async because it has to read users/{uid} for the current tier;
    // we don't block the rest of the dashboard on it.
    renderProTierBanner().catch(e => console.warn('proTierBanner:', e));
    // Best-effort pending-offers badge on the dashboard's Offers tab.
    try {
      const pending = await loadSellerOffers();
      const badge = document.getElementById('offersBadge');
      if (badge) {
        if (pending.length) { badge.textContent = String(pending.length); badge.style.display = 'inline-block'; }
        else { badge.style.display = 'none'; }
      }
    } catch (_e) { /* swallow — offers UI loads on tab click anyway */ }
  } catch (err) {
    console.error('Error loading shop data:', err);
    showToast('Could not load shop data.');
  }
}
// Exposed so the edit-listing flow (module scope) can refresh the My
// Shop dashboard after a successful save without duplicating the load.
window.loadShopData = loadShopData;

// Smooth count-up animation for a stat number. Vanilla rAF — no library.
// Honors prefers-reduced-motion by snapping straight to the final value.
function _countUpStat(elId, target, opts) {
  const el = document.getElementById(elId);
  if (!el) return;
  const prefix = (opts && opts.prefix) || '';
  const suffix = (opts && opts.suffix) || '';
  const decimals = (opts && opts.decimals) || 0;
  const duration = (opts && opts.duration) || 800;
  const fmt = v => prefix + Number(v).toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) + suffix;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = parseFloat(el.dataset.count || '0') || 0;
  if (reduce || target === start) {
    el.dataset.count = String(target);
    el.textContent = fmt(target);
    return;
  }
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / duration);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - k, 3);
    const v = start + (target - start) * eased;
    el.textContent = fmt(v);
    if (k < 1) requestAnimationFrame(tick);
    else { el.dataset.count = String(target); el.textContent = fmt(target); }
  };
  requestAnimationFrame(tick);
}

// Sum the sharded view counter on a listing doc. Writes are spread
// across 10 fields (views_0..views_9) by incrementListingView to lift
// Firestore's 1-write/sec/document ceiling — see SCALING_AUDIT #2.
// The legacy `views` field is folded in for backward compat with
// listings created before the shard rollout (no migration required).
function getListingViews(listing) {
  if (!listing) return 0;
  let total = Number(listing.views || 0);
  for (let i = 0; i < 10; i++) {
    total += Number(listing[`views_${i}`] || 0);
  }
  return total;
}
// Exposed for renderProductCard, which builds the stats line via window.*
window.getListingViews = getListingViews;

// ── Popularity scoring (r300) ────────────────────────────────────────────
// Ranks a listing by engagement, decayed by age, for the Trending widget.
//
//   raw   = views + 3*watchers + 5*messages
//   score = raw / (ageInDays + 7) ^ 0.7
//
// Weights: a watcher and a message are far stronger intent than a view, and
// far rarer — today's marketplace holds 351 views, 3 watchers, 10 messages.
//
// Gravity was picked from live data, not taste. The obvious Hacker-News
// shape — hours, gravity 1.4 — is badly wrong here: it assumes new items
// gather points in hours, whereas a new TeeBox listing gets 1-2 views a day.
// At 1.4 the top six were all 1-day-old listings with ONE view, ranking
// above a listing with seventeen. Days-based decay at 0.7 with a 7-day
// offset keeps the genuinely popular items visible while giving a new
// listing with real traction a path to the top: measured against live data
// the top four span 144d, 7d, 19d and 1d old.
//
// POPULARITY_MIN_SIGNAL is the floor. Without it, a brand-new listing nobody
// has opened outranks everything, because the denominator dominates. 18 of
// 25 active listings clear it today; the widget falls back to "New Listings"
// if none do.
//
// All-time, not windowed — there is no time-bucketed view data. If that is
// ever added, revisit the decay here and the heading in the widget.
const POPULARITY_W_VIEW = 1;
const POPULARITY_W_WATCH = 3;
const POPULARITY_W_MESSAGE = 5;
const POPULARITY_GRAVITY = 0.7;
const POPULARITY_OFFSET_DAYS = 7;
window.POPULARITY_MIN_SIGNAL = 5;

function popularityRaw(listing) {
  if (!listing) return 0;
  const views = getListingViews(listing);
  const watch = Number(listing.watchlistCount || 0);
  const msgs = Number(listing.messageCount || 0);
  return views * POPULARITY_W_VIEW +
    watch * POPULARITY_W_WATCH +
    msgs * POPULARITY_W_MESSAGE;
}
window.popularityRaw = popularityRaw;

function popularityScore(listing, nowMs) {
  if (!listing) return 0;
  const raw = popularityRaw(listing);
  if (raw <= 0) return 0;
  const created = listing.createdAt && listing.createdAt.toDate ?
    listing.createdAt.toDate().getTime() : 0;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  // A missing createdAt would otherwise read as 1970 and decay to nothing;
  // treat it as brand new so a data gap can't silently bury a listing.
  const ageDays = created ? Math.max(0, (now - created) / 86400000) : 0;
  return raw / Math.pow(ageDays + POPULARITY_OFFSET_DAYS, POPULARITY_GRAVITY);
}
window.popularityScore = popularityScore;

// Structure 2: order.amount includes the buyer-paid shipping that funds
// the label — it never belongs in a SELLER's sale/revenue figures. Use the
// item-only value everywhere the dashboard talks about sales; legacy
// orders (no itemCents) were item-only already. Buyer-facing surfaces
// (order confirmation, purchase history) keep the full paid total.
function orderItemDollars(o) {
  return (o && o.itemCents != null)
    ? o.itemCents / 100
    : Number((o && o.amount) || 0);
}

// Persistent "you have a sale — ship it" banner for Paid orders awaiting
// shipment. This is the reliable in-app signal now that a seller's email
// may be unverified/bouncing and push isn't guaranteed.
function renderShipItBanner(orders) {
  const el = document.getElementById('shipItBanner');
  if (!el) return;
  const toShip = (orders || []).filter(o =>
    (o.fulfillmentStatus || 'awaiting_seller_shipment') === 'awaiting_seller_shipment' && !o.refunded);
  const n = toShip.length;
  if (!n) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'block';
  // r289 — confetti the FIRST time the seller sees a given sale. Selling
  // something is the best thing that happens on TeeBox and it arrived with
  // no acknowledgement at all. Keyed by order id in localStorage so it fires
  // once per sale, not on every dashboard open; per-viewer and per-device by
  // nature, and wrapped because a celebration must never break the banner.
  try {
    const uid = (window.CURRENT_USER && window.CURRENT_USER.uid) || '_';
    const key = 'tb_seen_sales_' + uid;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_e) { seen = []; }
    const fresh = toShip.map(o => String(o.id)).filter(id => seen.indexOf(id) === -1);
    if (fresh.length && seen.length !== 0) {
      // seen.length === 0 means we have never recorded anything for this
      // seller — that is a first load, not a new sale, so don't celebrate
      // history on the first open after an update.
      if (typeof window.teeboxConfetti === 'function') window.teeboxConfetti(22);
    }
    if (fresh.length) {
      try { localStorage.setItem(key, JSON.stringify(seen.concat(fresh).slice(-100))); } catch (_e) {}
    }
  } catch (_e) { /* non-fatal */ }
  el.innerHTML =
    '<div class="ship-it-banner" role="status" aria-live="polite">' +
      '<div class="sib-icon" aria-hidden="true">' + window.ICONS.box + '</div>' +
      '<div class="sib-body">' +
        '<div class="sib-title">' + (n === 1 ? 'You have a sale — ship it' : n + ' sales waiting to ship') + '</div>' +
        '<div class="sib-sub">' + (n === 1 ? 'A buyer paid and is waiting.' : 'Buyers paid and are waiting.') +
          ' Ship within 3 business days with tracking.</div>' +
      '</div>' +
      '<button class="sib-cta" data-action="switch-dash-tab-scroll" data-tab="sold">View ' + (n === 1 ? 'order' : 'orders') + '</button>' +
    '</div>';
}

function renderShopStats() {
  const { listings, orders } = window.SHOP_DATA;
  renderShipItBanner(orders);
  const totalRevenue = orders.reduce((sum, o) => sum + orderItemDollars(o), 0);
  const itemsSold = orders.length;
  const activeListings = listings.filter(l => l.status !== 'sold').length;
  const avgSale = itemsSold > 0 ? totalRevenue / itemsSold : 0;
  const totalViews = listings.reduce((sum, l) => sum + getListingViews(l), 0);
  // Conversion rate: views → sales. Uses lifetime totals so it stays
  // meaningful even for sellers with low daily traffic.
  const convPct = totalViews > 0 ? (itemsSold / totalViews) * 100 : 0;

  _countUpStat('statRevenue', totalRevenue, { prefix: '$' });
  _countUpStat('statSold', itemsSold);
  _countUpStat('statActive', activeListings);
  // r345: the Featured Sellers bar as a progress line in the seller's own
  // numbers. Counted the way the feed counts (live + photographed), not the
  // dashboard's "not sold", so it never promises a card the feed won't show.
  try {
    const subEl = document.getElementById('dashSubtitle');
    const live = listings.filter(l => (l.status === 'active' || l.status === 'pending')
      && Array.isArray(l.photos) && l.photos.length > 0).length;
    const need = (window.FEATURED_MIN_LISTINGS || 5) - live;
    if (subEl) subEl.textContent = need > 0
      ? `${need} more active listing${need === 1 ? '' : 's'} and you’re featured on the home page`
      : 'Featured on the TeeBox home page';
  } catch (_e) {}
  _countUpStat('statAvg', Math.round(avgSale), { prefix: '$' });
  _countUpStat('statViews', totalViews);
  // Conversion rate gets its own renderer (decimals + % suffix).
  const convEl = document.getElementById('statConv');
  if (convEl) {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      convEl.textContent = convPct.toFixed(1) + '%';
    } else {
      const t0 = performance.now();
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / 800);
        const eased = 1 - Math.pow(1 - k, 3);
        convEl.textContent = (convPct * eased).toFixed(1) + '%';
        if (k < 1) requestAnimationFrame(tick);
        else convEl.textContent = convPct.toFixed(1) + '%';
      };
      requestAnimationFrame(tick);
    }
  }
  const convSub = document.getElementById('statConvSub');
  if (convSub) {
    convSub.textContent = totalViews
      ? (itemsSold + ' sale' + (itemsSold === 1 ? '' : 's') + ' on ' + totalViews.toLocaleString() + ' view' + (totalViews === 1 ? '' : 's'))
      : 'Views that turn into sales';
  }
  // r186 §6 (display-only, app-gated): honest zero states. The revenue
  // tile's sub reads "No sales yet" at zero (web keeps "All time"), and
  // the conversion card's decorative ↗ hides while the rate is 0 (a
  // permanent up-arrow at 0.0% was audit item 6.2). Class toggles are
  // inert on web — only body.is-native CSS reads them.
  if (window.IS_NATIVE) {
    const revSub = document.getElementById('statRevenueSub');
    if (revSub) revSub.textContent = itemsSold > 0 ? 'All time' : 'No sales yet';
  }
  const convIco = document.querySelector('.a-ico-conv');
  if (convIco) convIco.classList.toggle('a-ico-zero', !(convPct > 0));
  // Views card: its chart glyph is also a rising trend line — same audit
  // rule, hide it while views are zero.
  const viewsIco = document.querySelector('.a-ico-views');
  if (viewsIco) viewsIco.classList.toggle('a-ico-zero', !(totalViews > 0));

  // If the advanced section is already open, refresh it now that data is in.
  const adv = document.getElementById('advancedSection');
  if (adv && adv.classList.contains('open')) {
    try { renderAdvancedInsights(); } catch (_) {}
  }

  // Week-over-week deltas (Feature #10)
  const now = Date.now();
  const SEVEN = 7 * 86400000;
  const w0Start = now - SEVEN;          // current 7-day window starts here
  const w1Start = now - 2 * SEVEN;      // previous 7-day window starts here
  let w0Rev = 0, w0Cnt = 0, w1Rev = 0, w1Cnt = 0;
  orders.forEach(o => {
    const d = (o.createdAt && o.createdAt.toDate) ? o.createdAt.toDate() : (o.createdAt ? new Date(o.createdAt) : null);
    if (!d) return;
    const t = d.getTime();
    const amt = orderItemDollars(o);
    if (t >= w0Start && t <= now) { w0Rev += amt; w0Cnt += 1; }
    else if (t >= w1Start && t < w0Start) { w1Rev += amt; w1Cnt += 1; }
  });
  const w0Avg = w0Cnt ? w0Rev / w0Cnt : 0;
  const w1Avg = w1Cnt ? w1Rev / w1Cnt : 0;
  applyDelta('statRevenueDelta', w0Rev, w1Rev);
  applyDelta('statSoldDelta', w0Cnt, w1Cnt);
  applyDelta('statAvgDelta', w0Avg, w1Avg);
}

// Apply a WoW % delta indicator to a stat card chip (Feature #10).
// curr/prev are numbers. "Flat" if both are 0 or within ±1% of each other.
function applyDelta(elId, curr, prev) {
  const el = document.getElementById(elId);
  if (!el) return;
  let cls = 'flat', txt = '—';
  if (prev === 0 && curr === 0) {
    cls = 'flat'; txt = '—';
  } else if (prev === 0) {
    cls = 'up'; txt = '▲ new';
  } else {
    const pct = ((curr - prev) / Math.abs(prev)) * 100;
    if (pct > 0.5) { cls = 'up'; txt = '▲ +' + Math.round(pct) + '%'; }
    else if (pct < -0.5) { cls = 'down'; txt = '▼ −' + Math.abs(Math.round(pct)) + '%'; }
    else { cls = 'flat'; txt = 'flat'; }
  }
  // r186 §6 (display-only): flag the both-zero case so the app can omit
  // the chip entirely (audit 6.1 — heights align since Revenue/Sold/Avg
  // zero out together and Active has no chip). Class is inert on web.
  el.className = 'stat-delta ' + cls + ((prev === 0 && curr === 0) ? ' stat-delta-zero' : '');
  el.textContent = txt;
}

// Compute + render the "Advanced insights" collapsible block. All inputs
// come from the existing window.SHOP_DATA cache — no new Firestore reads.
//   • Best sellers: top items by revenue (orders summed per listing).
//   • Slow movers: oldest active listings (createdAt asc), capped at 5.
//   • Payout cadence: sales-per-week + last delivered date.
//   • Time on market: avg / fastest days from listing.createdAt → order.createdAt.
function renderAdvancedInsights() {
  const data = window.SHOP_DATA || { listings: [], orders: [] };
  const listings = data.listings || [];
  const orders   = data.orders   || [];
  const listingsById = {};
  listings.forEach(l => { listingsById[l.id] = l; });
  const tDate = ts => (ts && ts.toDate) ? ts.toDate() : (ts ? new Date(ts) : null);

  // ── Best sellers (by revenue, top 5) ───────────────────────────────────
  const revByListing = {};
  orders.forEach(o => {
    const k = o.listingId || '__unknown';
    revByListing[k] = (revByListing[k] || 0) + orderItemDollars(o);
  });
  const bestEl = document.getElementById('advBestSellers');
  if (bestEl) {
    const ranked = Object.keys(revByListing)
      .map(id => ({ id, revenue: revByListing[id], listing: listingsById[id] }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
    if (!ranked.length) {
      bestEl.innerHTML = '<li class="adv-empty">No sales yet. Your top items will appear here.</li>';
    } else {
      bestEl.innerHTML = ranked.map(r => {
        const title = (r.listing && r.listing.title) || ('Item #' + (r.id || '—'));
        const rev = '$' + Number(r.revenue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
        return '<li><span class="adv-name">' + window.safeText(title) + '</span><span class="adv-meta">' + window.safeText(rev) + '</span></li>';
      }).join('');
    }
  }

  // ── Slowest movers (oldest unsold active listings, top 5) ──────────────
  const slowEl = document.getElementById('advSlowMovers');
  if (slowEl) {
    const now = Date.now();
    const stale = listings
      .filter(l => l.status !== 'sold')
      .map(l => {
        const d = tDate(l.createdAt);
        return { l, ageDays: d ? Math.floor((now - d.getTime()) / 86400000) : null };
      })
      .filter(x => x.ageDays != null)
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 5);
    if (!stale.length) {
      slowEl.innerHTML = '<li class="adv-empty">No active listings to rank.</li>';
    } else {
      slowEl.innerHTML = stale.map(({ l, ageDays }) => {
        const title = l.title || 'Untitled';
        const meta  = ageDays === 0 ? 'Today' : (ageDays === 1 ? '1 day' : ageDays + ' days');
        return '<li><span class="adv-name">' + window.safeText(title) + '</span><span class="adv-meta">' + window.safeText(meta) + '</span></li>';
      }).join('');
    }
  }

  // ── Payout cadence ─────────────────────────────────────────────────────
  const cadEl = document.getElementById('advPayoutCadence');
  if (cadEl) {
    const delivered = orders.filter(o => {
      const s = o.fulfillmentStatus || '';
      return s === 'delivered' || s === 'reviewed';
    });
    if (!delivered.length) {
      cadEl.innerHTML = '<div class="adv-empty">Once orders are delivered, payout cadence will populate here.</div>';
    } else {
      // Sales per week over the orders' active span (first → now). Caps span
      // at a min of 1 week so brand-new sellers don't see absurd /wk numbers.
      const firstD = orders.reduce((acc, o) => {
        const d = tDate(o.createdAt);
        return (d && (!acc || d < acc)) ? d : acc;
      }, null);
      const spanDays = firstD ? Math.max(7, (Date.now() - firstD.getTime()) / 86400000) : 7;
      const perWeek = (orders.length / spanDays) * 7;
      const lastDeliveredDate = delivered.reduce((acc, o) => {
        const d = tDate(o.deliveredAt) || tDate(o.createdAt);
        return (d && (!acc || d > acc)) ? d : acc;
      }, null);
      const lastLbl = lastDeliveredDate ? lastDeliveredDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
      const totalPaid = delivered.reduce((s, o) => s + orderItemDollars(o), 0);
      cadEl.innerHTML =
        '<div class="adv-kv-row"><span class="adv-k">Sales / week</span><span class="adv-v">' + perWeek.toFixed(1) + '</span></div>' +
        '<div class="adv-kv-row"><span class="adv-k">Last payout</span><span class="adv-v">' + window.safeText(lastLbl) + '</span></div>' +
        '<div class="adv-kv-row"><span class="adv-k">Lifetime paid</span><span class="adv-v">$' + Number(totalPaid).toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</span></div>';
    }
  }

  // ── Time on market (avg + fastest days-to-sell) ────────────────────────
  const dtsEl = document.getElementById('advDaysToSell');
  if (dtsEl) {
    const spans = orders.map(o => {
      const oc = tDate(o.createdAt);
      const lst = listingsById[o.listingId];
      const lc = lst ? tDate(lst.createdAt) : null;
      if (!oc || !lc) return null;
      return Math.max(0, Math.round((oc.getTime() - lc.getTime()) / 86400000));
    }).filter(v => v != null);
    if (!spans.length) {
      dtsEl.innerHTML = '<div class="adv-empty">Once you sell items, we\'ll show how long they took to move.</div>';
    } else {
      const avg = spans.reduce((s, v) => s + v, 0) / spans.length;
      const fastest = Math.min.apply(null, spans);
      const slowest = Math.max.apply(null, spans);
      const dLbl = n => n === 0 ? 'Same day' : (n === 1 ? '1 day' : n + ' days');
      dtsEl.innerHTML =
        '<div class="adv-kv-row"><span class="adv-k">Average</span><span class="adv-v">' + window.safeText(dLbl(Math.round(avg))) + '</span></div>' +
        '<div class="adv-kv-row"><span class="adv-k">Fastest sale</span><span class="adv-v">' + window.safeText(dLbl(fastest)) + '</span></div>' +
        '<div class="adv-kv-row"><span class="adv-k">Slowest sale</span><span class="adv-v">' + window.safeText(dLbl(slowest)) + '</span></div>';
    }
  }
}

function renderShopTables() {
  const { listings, orders, profile } = window.SHOP_DATA;
  const active = listings.filter(l => l.status !== 'sold');
  const soldListingsById = {};
  listings.filter(l => l.status === 'sold').forEach(l => { soldListingsById[l.id] = l; });
  const pinnedId = profile && profile.pinnedListingId ? String(profile.pinnedListingId) : null;

  // ACTIVE LISTINGS TABLE
  const activeEl = document.getElementById('dashTabActive');
  if (active.length === 0) {
    activeEl.innerHTML = '<div class="dash-empty"><div style="font-weight:600;color:var(--gray-700);margin-bottom:6px">No active listings yet</div>Tap <strong>Sell Now</strong> in the nav to post your first item &mdash; most listings are live within a minute.</div>';
  } else {
    const emptyCount = active.filter(l => !Array.isArray(l.photos) || l.photos.length === 0).length;
    const purgeBar = emptyCount > 0
      ? `<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;color:var(--gray-600)">
           <span>${emptyCount} listing${emptyCount === 1 ? '' : 's'} with no photos</span>
           <button class="renew-btn" style="background:var(--red-500);color:#fff;border:none" data-action="purge-empty-listings">Delete all empty</button>
         </div>`
      : '';
    activeEl.innerHTML = `
      ${purgeBar}
      <table class="dash-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Status</th>
            <th>Price</th>
            <th class="col-analytic-h" title="Views">Views</th>
            <th class="col-analytic-h" title="Watchers">Watch</th>
            <th class="col-analytic-h" title="Messages">Msgs</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${active.map(l => {
            const exp = l.expiresAt && l.expiresAt.toDate ? l.expiresAt.toDate() : null;
            const isExpired = l.status === 'expired' || (exp && exp < new Date());
            // r296 — the status cell used to be a two-way ternary (Expired/Active),
            // so EVERY other status rendered a green "Active". On 2026-10-01 a
            // seller's six listings were set to `flagged` by a false-positive
            // image scan: invisible to buyers (filtered at the feed and the
            // detail page) while his dashboard told him they were live. He had
            // no way to know. `removed` and `pending` had the same lie.
            // Tell the truth for every state the table can hold — it filters out
            // `sold` upstream, so: active | expired | flagged | removed | pending.
            const shopStatus = (() => {
              if (isExpired) {
                return {label: 'Expired', color: 'var(--red-500)', title: ''};
              }
              if (l.status === 'flagged') {
                return {
                  label: 'Under review',
                  color: 'var(--gold-600)',
                  title: 'We’re double-checking a photo on this listing, so ' +
                    'buyers can’t see it yet. This usually clears on its own.',
                };
              }
              if (l.status === 'removed') {
                return {
                  label: 'Removed',
                  color: 'var(--gray-500)',
                  title: 'This listing was taken down and isn’t visible to buyers.',
                };
              }
              if (l.status === 'hidden') {
                return {
                  label: 'Paused — set up payouts',
                  color: 'var(--gold-600)',
                  title: 'Live 7 days without payout setup, so it’s hidden from buyers (not deleted). ' +
                    'Finish payout setup and it relists automatically.',
                };
              }
              if (l.status === 'pending') {
                return {
                  label: 'Sale pending',
                  color: 'var(--gold-600)',
                  title: 'A buyer is checking out. It’ll free up shortly if they don’t complete.',
                };
              }
              return {label: 'Active', color: 'var(--up-green)', title: ''};
            })();
            const expireLabel = exp ? exp.toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
            const renew = isExpired ? `<button class="renew-btn" data-action="renew-listing" data-listing-id="${escapeHtml(String(l.id))}">Renew</button>` : '';
            // Edit button — opens the sell modal in edit mode. Shown
            // for every row in the active table (active + expired).
            // Locked listings (a reserved/pending buy) are blocked by
            // the openEditListing UI guard + updateListing callable.
            const editBtn = `<button class="renew-btn" data-action="edit-listing" data-listing-id="${escapeHtml(String(l.id))}" title="Edit listing">Edit</button>`;
            const isPinned = pinnedId && pinnedId === String(l.id);
            const pinBtn = isPinned
              ? `<button class="pin-btn pinned" data-action="unpin-listing" data-listing-id="${escapeHtml(String(l.id))}" title="Unpin from profile">Pinned</button>`
              : `<button class="pin-btn" data-action="pin-listing" data-listing-id="${escapeHtml(String(l.id))}" title="Pin to profile">Pin</button>`;
            const views = getListingViews(l).toLocaleString();
            const watchers = Number(l.watchlistCount || 0).toLocaleString();
            const msgs = Number(l.messageCount || 0).toLocaleString();
            // Primary photo thumbnail (Issue #5). Falls back to a
            // "+ Add photo" placeholder that links to the listing detail
            // when photos[]=[]. lazy-loaded so a seller with 50+ rows
            // doesn't fan out 50 simultaneous CDN fetches on dashboard
            // open. safeImgUrl/safeAttr defend against URL injection
            // — listings.photos[] is server-validated to gs:// /
            // firebasestorage.googleapis.com URLs only.
            const photo0 = Array.isArray(l.photos) && l.photos[0] ? l.photos[0] : '';
            const photoUrl = window.variantImgUrl ? window.variantImgUrl(l, 0, 'w400') : (photo0 || '');
            const thumb = photoUrl
              ? `<img src="${escapeHtml(photoUrl)}" loading="lazy" alt="" style="width:50px;height:50px;border-radius:6px;object-fit:cover;background:var(--gray-100);flex-shrink:0" />`
              : `<a class="shop-thumb-placeholder" data-action="open-detail" data-product-id="${escapeHtml(String(l.id))}" href="#" style="width:50px;height:50px;border-radius:6px;background:var(--gray-100);display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:var(--gray-500);font-size:10px;text-align:center;line-height:1.1;flex-shrink:0" title="Add a photo">${(window.ICONS && window.ICONS.camera) || ""}<br>Add</a>`;
            return `<tr>
              <td>
                <div class="item-cell" style="display:flex;align-items:center;gap:10px">
                  ${thumb}
                  <div>
                    <div style="font-weight:600">${escapeHtml(l.title || 'Untitled')}</div>
                    <div style="font-size:12px;color:var(--gray-500)">${escapeHtml(l.brand || '')}</div>
                  </div>
                </div>
              </td>
              <td style="text-transform:capitalize">${escapeHtml(l.cat || '—')}</td>
              <td><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:${shopStatus.color}"${shopStatus.title ? ` title="${escapeHtml(shopStatus.title)}"` : ''}>${escapeHtml(shopStatus.label)}</span></td>
              <td style="font-weight:600">$${(l.ask || 0).toLocaleString()}</td>
              <td class="col-analytic" title="Views"><span class="lbl">${views}</span></td>
              <td class="col-analytic" title="Watchers"><span class="lbl">${watchers}</span></td>
              <td class="col-analytic" title="Messages"><span class="lbl">${msgs}</span></td>
              <td style="color:var(--gray-500);font-size:12px">${expireLabel}</td>
              <td style="white-space:nowrap">${editBtn} ${pinBtn} ${renew} <button class="listing-delete-btn" data-action="ask-delete-listing" data-listing-id="${escapeHtml(String(l.id))}" data-listing-title="${escapeHtml(String(l.title || 'Untitled'))}" title="Delete listing" aria-label="Delete listing">${window.ICONS.trash}</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  // SOLD ITEMS TABLE
  const soldEl = document.getElementById('dashTabSold');
  if (orders.length === 0) {
    soldEl.innerHTML = '<div class="dash-empty"><div style="font-weight:600;color:var(--gray-700);margin-bottom:6px">No sales yet</div>Once a buyer pays, the order shows up here with the buyer ID, sale price, and date. Payouts go to your linked bank on Stripe\'s standard schedule after the sale.</div>';
  } else {
    soldEl.innerHTML = `
      <table class="dash-table sold-table">
        <thead>
          <tr><th>Item</th><th>Buyer</th><th>Ship To</th><th>Sale Price</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          ${orders.map(o => {
            const listing = soldListingsById[o.listingId] || {};
            const stage = o.fulfillmentStatus || 'awaiting_seller_shipment';
            const stageLabel = ({
              awaiting_seller_shipment: 'Awaiting shipment',
              shipped:                  'Shipped' + (o.trackingNumber ? ' · ' + escapeHtml(o.trackingNumber) : ''),
              delivered:                'Delivered',
              reviewed:                 'Reviewed',
            })[stage] || (o.refunded ? 'Refunded' : stage);
            const shipBtn = stage === 'awaiting_seller_shipment' && !o.refunded
              ? `<button class="ship-btn" data-action="mark-shipped" data-order-id="${escapeHtml(String(o.id))}">Mark Shipped</button>`
              : '';
            // Print Shipping Label (Shippo). Shown only while the order
            // hasn't shipped yet and a label hasn't already been bought.
            // If `labelUrl` is already on the doc, surface a "View label"
            // link instead so the seller can re-open the PDF without
            // re-buying. The createShippingLabel callable is idempotent
            // server-side too (returns cached:true when labelUrl exists).
            const printLabelBtn = !o.refunded && (stage === 'awaiting_seller_shipment' || !stage)
              ? (o.labelUrl
                  ? `<a class="ship-btn secondary" href="${escapeHtml(String(o.labelUrl))}" target="_blank" rel="noopener">View Label</a>`
                  : `<button class="ship-btn secondary" data-action="print-shipping-label" data-order-id="${escapeHtml(String(o.id))}" title="Purchase a shipping label via Shippo">Print Label</button>`)
              : '';
            // "Refund Order" is visible to the seller only while the order is
            // pre-fulfillment-but-paid AND not already refunded. We treat any
            // stage other than reviewed/delivered as still-refundable for the
            // UI surface; the Cloud Function gates the actual action.
            const canRefund = !o.refunded
              && o.status === 'paid'
              && (stage === 'awaiting_seller_shipment' || stage === 'shipped');
            const refundBtn = canRefund
              ? `<button class="ship-btn danger" data-action="refund-order" data-order-id="${escapeHtml(String(o.id))}" title="Issue a full refund to the buyer">Refund Order</button>`
              : '';
            // Message the buyer about this order — reuses the SAME
            // buyer↔seller thread for the listing (openChatForListingAsSeller
            // finds the existing conversation by listingId+participants; it
            // does not create a second thread). Styled as a secondary
            // dashboard button to match the sibling actions in this row.
            const msgBuyerBtn = (o.buyerId && o.listingId)
              ? `<button class="ship-btn secondary" data-action="message-buyer" data-listing-id="${escapeHtml(String(o.listingId))}" data-buyer-id="${escapeHtml(String(o.buyerId))}" title="Message the buyer about this order">Message Buyer</button>`
              : '';
            // Buyer-side shipping address (captured at checkout via Stripe
            // AddressElement, persisted by the webhook). Print address only —
            // never email/phone — to keep PII in the dashboard minimal.
            const sh = o.shipping || null;
            const a = sh && sh.address ? sh.address : null;
            const shipCell = a
              ? `<div style="font-size:12px;color:var(--gray-700);max-width:200px;line-height:1.35">
                   <div style="font-weight:600">${escapeHtml(sh.name || '—')}</div>
                   <div>${escapeHtml([a.line1, a.line2].filter(Boolean).join(', '))}</div>
                   <div>${escapeHtml([a.city, a.state, a.postal_code].filter(Boolean).join(', '))}</div>
                 </div>`
              : '<span style="color:var(--gray-400);font-size:12px">—</span>';
            // Real product thumbnail (w400 webp variant → original photo),
            // falling back to the category placeholder for listings with no
            // usable image. The listing doc (with photos/photoVariants) is
            // already in soldListingsById, so this is no extra Firestore read.
            const soldThumbUrl = window.variantImgUrl(listing, 0, 'w400');
            const soldThumb = soldThumbUrl
              ? `<img src="${escapeHtml(soldThumbUrl)}" alt="" loading="lazy" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0" class="js-img-fallback" data-fallback="${escapeHtml(window.CATEGORY_ICON(listing.cat))}">`
              : `<span class="item-emoji placeholder-art" style="width:36px;height:36px;border-radius:6px">${window.CATEGORY_ICON(listing.cat)}</span>`;
            return `
              <tr>
                <td>
                  <div class="item-cell">
                    ${soldThumb}
                    <div>
                      <div style="font-weight:600">${escapeHtml(listing.title || 'Item #' + (o.listingId || '—'))}</div>
                      <div style="font-size:12px;color:var(--gray-500)">${escapeHtml(listing.brand || '')}</div>
                    </div>
                  </div>
                </td>
                <td data-label="Buyer" style="color:var(--gray-500)">•••• ${maskBuyerId(o.buyerId)}</td>
                <td data-label="Ship to">${shipCell}</td>
                <td data-label="Sale price" style="font-weight:600;color:var(--up-green)">$${orderItemDollars(o).toLocaleString()}</td>
                <td data-label="Status" class="dash-status">${stageLabel}</td>
                <td class="sold-actions-cell"><div class="dash-cell-actions">${shipBtn}${printLabelBtn}${msgBuyerBtn}${refundBtn}</div></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }
}

function maskBuyerId(id) {
  if (!id) return '????';
  return id.slice(-4).toUpperCase();
}

// Payouts dashboard tab (Feature #13). Renders 3 stat cards + a full order
// table with masked buyer info + an "Export CSV" button. CSV intentionally
// excludes buyer info for privacy.
async function renderStripeConnectBanner() {
  // Renders the seller's Stripe Connect status: "set up payouts" CTA if
  // not connected, "finish onboarding" if requirements remain, or a small
  // ✓ confirmation if fully verified. Inlined into the Payouts tab.
  const u = window.CURRENT_USER;
  if (!u) return '';
  let status;
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'getStripeAccountStatus');
    const result = await fn();
    status = result.data || {};
  } catch (e) {
    return `<div class="stripe-connect-banner warn">
      <strong>Couldn't load payout status.</strong>
      <span>Refresh the page or try again in a moment.</span>
    </div>`;
  }
  if (!status.connected) {
    return `<div class="stripe-connect-banner cta">
      <div>
        <strong>Get paid on TeeBox</strong>
        <span>Connect your bank via Stripe to receive payouts. Takes ~3 minutes.</span>
      </div>
      <button class="btn-stripe-connect" data-action="stripe-connect" type="button">Set up payouts</button>
    </div>`;
  }
  if (!status.chargesEnabled || !status.payoutsEnabled || (status.requirementsDue || []).length) {
    return `<div class="stripe-connect-banner warn">
      <div>
        <strong>Finish setting up payouts</strong>
        <span>Stripe still needs a few details before you can be paid.</span>
      </div>
      <button class="btn-stripe-connect" data-action="stripe-connect" type="button">Finish setup</button>
    </div>`;
  }
  return `<div class="stripe-connect-banner ok">
    <div>
      <strong>Payouts active</strong>
      <span>Stripe sends earnings directly to your bank, daily.</span>
    </div>
  </div>`;
}

// Pro Seller tier banner. Fetches the user's tier directly from
// users/{uid} (self-only read, allowed by rules) and paints either an
// "Upgrade to Pro" CTA or a "Pro Seller" badge with a Manage link.
//
// iOS NOTE: Apple Guideline 3.1.1 requires digital subscriptions inside
// an iOS app to be sold via Apple's IAP. Since Pro Seller is sold via
// Stripe, on Capacitor (iOS native) we render NOTHING for free users
// (no upgrade CTA at all) and a status-only banner for Pro users that
// directs them to teeboxmarket.com for any subscription management
// (no in-app link to Stripe).
async function renderProTierBanner() {
  const el = document.getElementById('proTierBanner');
  if (!el) return;
  const u = window.CURRENT_USER;
  if (!u) { el.innerHTML = ''; return; }
  const Cap = (typeof window !== 'undefined') ? window.Capacitor : null;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  let tier = 'free';
  let cancelAtPeriodEnd = false;
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDoc(doc(db, 'users', u.uid));
    const data = snap.exists() ? snap.data() : {};
    tier = data.tier === 'pro' ? 'pro' : 'free';
    cancelAtPeriodEnd = !!data.proCancelAtPeriodEnd;
  } catch (_e) {
    // L3: fail-open NEUTRAL. Previously we fell through to tier='free'
    // and rendered the Upgrade CTA — which briefly mis-states Pro users'
    // status when Firestore is flaky. Render an empty banner instead;
    // a subsequent successful read will fill it in.
    el.innerHTML = '';
    return;
  }

  if (tier === 'pro') {
    const cancelNote = cancelAtPeriodEnd
      ? '<span>Your subscription will end at the next billing cycle. Reactivate any time.</span>'
      : '<span>3% transaction fee, keeping more of every sale.</span>';
    // On iOS we still show the Pro status banner (it's just an info
    // badge — no IAP issue), but we replace the "Manage subscription"
    // button (which would deep-link to Stripe's portal) with a plain
    // text instruction to manage on the web. This avoids Apple's rule
    // against linking out of the app to a digital-goods purchase flow.
    const cta = isNative
      ? '<div class="pro-tier-banner-note">Manage at teeboxmarket.com</div>'
      : '<button class="pro-tier-banner-cta" data-action="manage-subscription" type="button">Manage subscription</button>';
    el.innerHTML = `<div class="pro-tier-banner pro">
      <div class="pro-tier-banner-info">
        <strong><span class="pro-pill">Pro</span> Pro Seller</strong>
        ${cancelNote}
      </div>
      ${cta}
    </div>`;
  } else {
    // Free tier: render NOTHING, on every platform (2026-09-22, founder
    // ruling). Pro signup has been disabled server-side since 2026-08-27
    // (createSubscriptionCheckout throws) and the tier was repriced to
    // 8.5% — this banner was still advertising "8.5% -> 3% for
    // $14.99/month" over a dead callable, the exact dead-button
    // dishonesty the Pro-disable ruling was meant to end, and an App
    // Review tester could tap it. The paid-tier status banner above is
    // untouched (zero accounts were ever on Pro, but it stays correct
    // for the future perks-based re-launch). The open-pro-upgrade
    // action + proUpgradeBackdrop modal become unreachable-by-UI dead
    // code — left in place deliberately, same convention as the r116
    // bid/offer code, for that re-launch.
    el.innerHTML = '';
  }
}

async function renderPayouts() {
  const el = document.getElementById('dashTabPayouts');
  if (!el) return;
  const banner = await renderStripeConnectBanner();
  // Stash banner so the existing render path injects it. We do this by
  // prepending after the rest of the function builds its HTML.
  el.dataset.stripeBanner = banner;
  const { orders, listings } = window.SHOP_DATA;
  const listingsById = {};
  listings.forEach(l => { listingsById[l.id] = l; });
  const now = Date.now();
  const THIRTY = 30 * 86400000;

  let pending = 0;     // shipped but not yet delivered
  let paid30 = 0;      // delivered in last 30 days
  let lifetime = 0;    // delivered all time
  orders.forEach(o => {
    const amt = orderItemDollars(o);
    const stage = o.fulfillmentStatus || 'awaiting_seller_shipment';
    if (stage === 'shipped') pending += amt;
    if (stage === 'delivered' || stage === 'reviewed') {
      lifetime += amt;
      const dlv = (o.deliveredAt && o.deliveredAt.toDate) ? o.deliveredAt.toDate() : null;
      if (dlv && (now - dlv.getTime() <= THIRTY)) paid30 += amt;
    }
  });

  // Sort newest first by createdAt for the table
  const rows = orders.slice().sort((a, b) => {
    const at = (a.createdAt && a.createdAt.toDate) ? a.createdAt.toDate().getTime() : 0;
    const bt = (b.createdAt && b.createdAt.toDate) ? b.createdAt.toDate().getTime() : 0;
    return bt - at;
  });

  const fmt$ = n => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

  const tableRows = rows.map(o => {
    const listing = listingsById[o.listingId] || {};
    const title = listing.title || 'Item #' + (o.listingId || '—');
    const stage = o.fulfillmentStatus || 'awaiting_seller_shipment';
    const isPaid = stage === 'delivered' || stage === 'reviewed';
    const statusCls = isPaid ? 'paid' : 'pending';
    const statusTxt = isPaid ? 'Paid' : 'Pending';
    const d = (o.createdAt && o.createdAt.toDate) ? o.createdAt.toDate() : null;
    const dateLbl = d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    return `<tr>
      <td data-label="Date" style="color:var(--gray-500);font-size:12px;white-space:nowrap">${escapeHtml(dateLbl)}</td>
      <td>
        <div style="font-weight:600">${escapeHtml(title)}</div>
        <div style="font-size:12px;color:var(--gray-500)">${escapeHtml(listing.brand || '')}</div>
      </td>
      <td data-label="Buyer" style="color:var(--gray-500)">•••• ${maskBuyerId(o.buyerId)}</td>
      <td data-label="Amount" style="font-weight:600">${escapeHtml(fmt$(orderItemDollars(o)))}</td>
      <td data-label="Status"><span class="payout-status ${statusCls}">${statusTxt}</span></td>
    </tr>`;
  }).join('');

  const stripeBanner = el.dataset.stripeBanner || '';
  if (rows.length === 0) {
    el.innerHTML = `
      ${stripeBanner}
      <div class="stats-grid" style="margin-bottom:1rem">
        <div class="stat-card"><div class="stat-label">Pending Payout</div><div class="stat-value">${fmt$(pending)}</div><div class="stat-sub">Shipped, awaiting delivery</div></div>
        <div class="stat-card"><div class="stat-label">Paid Out (30d)</div><div class="stat-value">${fmt$(paid30)}</div><div class="stat-sub">Delivered in last 30 days</div></div>
        <div class="stat-card"><div class="stat-label">Lifetime Earnings</div><div class="stat-value">${fmt$(lifetime)}</div><div class="stat-sub">All delivered orders</div></div>
      </div>
      <div class="dash-empty"><div style="font-weight:600;color:var(--gray-700);margin-bottom:6px">No payouts yet</div>Once a buyer pays, you'll see pending and paid amounts here.</div>
    `;
    return;
  }

  el.innerHTML = `
    ${stripeBanner}
    <div class="stats-grid" style="margin-bottom:1rem">
      <div class="stat-card"><div class="stat-label">Pending Payout</div><div class="stat-value">${fmt$(pending)}</div><div class="stat-sub">Shipped, awaiting delivery</div></div>
      <div class="stat-card"><div class="stat-label">Paid Out (30d)</div><div class="stat-value">${fmt$(paid30)}</div><div class="stat-sub">Delivered in last 30 days</div></div>
      <div class="stat-card"><div class="stat-label">Lifetime Earnings</div><div class="stat-value">${fmt$(lifetime)}</div><div class="stat-sub">All delivered orders</div></div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">
      <button class="payout-csv-btn" data-action="payout-export-csv" type="button">Export CSV</button>
    </div>
    <table class="dash-table payouts-table">
      <thead><tr><th>Date</th><th>Item</th><th>Buyer</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
}

// Build + download a CSV of the seller's orders (Feature #13).
// Privacy-first: buyer info is intentionally excluded.
function exportPayoutsCsv() {
  const { orders, listings } = window.SHOP_DATA;
  const listingsById = {};
  listings.forEach(l => { listingsById[l.id] = l; });
  const rows = orders.slice().sort((a, b) => {
    const at = (a.createdAt && a.createdAt.toDate) ? a.createdAt.toDate().getTime() : 0;
    const bt = (b.createdAt && b.createdAt.toDate) ? b.createdAt.toDate().getTime() : 0;
    return bt - at;
  });
  const esc = v => {
    const s = (v == null ? '' : String(v));
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = ['Date,Item,Amount,Status'];
  rows.forEach(o => {
    const listing = listingsById[o.listingId] || {};
    const title = listing.title || 'Item #' + (o.listingId || '');
    const stage = o.fulfillmentStatus || 'awaiting_seller_shipment';
    const isPaid = stage === 'delivered' || stage === 'reviewed';
    const d = (o.createdAt && o.createdAt.toDate) ? o.createdAt.toDate() : null;
    const dateStr = d ? d.toISOString().slice(0, 10) : '';
    lines.push([esc(dateStr), esc(title), esc(orderItemDollars(o).toFixed(2)), esc(isPaid ? 'Paid' : 'Pending')].join(','));
  });
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `teebox-payouts-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function closeShopDashboard() {
  document.getElementById('shopDashboard').classList.remove('open');
  (document.getElementById('app-scroll')||document.body).style.overflowY = '';
  // Defensive: if the user closes the dashboard mid-tour, tear it down so
  // the backdrop + tooltip don't linger over the rest of the app.
  try { dismissSellerTour({ markSeen: false }); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// First-run seller tour (Feature: tour-v1)
// ─────────────────────────────────────────────────────────────
// 3–4 step tooltip walkthrough that fires the FIRST time a user opens
// "My Shop". Tracked by localStorage so it never repeats.
// To reset for testing: localStorage.removeItem('teebox-tour-seen-v1')
const SELLER_TOUR_KEY = 'teebox-tour-seen-v1';
let SELLER_TOUR_STATE = null;

function _sellerTourSteps() {
  // Each step locates its target lazily so we always grab the live DOM
  // node — the Payouts tab, for example, is hidden until clicked.
  return [
    {
      title: 'Connect Stripe',
      desc: 'Sellers get paid through Stripe. Connect your account here so we can send your earnings to your bank.',
      // Open the Payouts tab so the Stripe banner is actually visible.
      before: () => { try { switchDashTab('payouts'); } catch (_) {} },
      target: () => document.querySelector('#dashTabPayouts .stripe-connect-banner')
                 || document.getElementById('dashTabPayouts'),
      placement: 'bottom'
    },
    {
      title: 'List your first item',
      desc: 'Tap here to create your first listing. Add photos, set a price, and you’re live.',
      target: () => document.querySelector('.bottom-nav-item.sell')
                 || document.querySelector('[data-action="handle-sell"]'),
      placement: 'top'
    },
    {
      title: 'Manage offers',
      desc: 'Buyers can make offers below your asking price. You can accept, decline, or counter from this tab.',
      target: () => document.querySelector('.dash-tab[data-tab="offers"]'),
      placement: 'bottom'
    },
    {
      title: 'Check your inbox',
      desc: 'Buyers will message you about your listings here. Quick replies build seller reputation.',
      target: () => document.querySelector('.bottom-nav-item[data-tab="inbox"]')
                 || document.querySelector('[data-action="open-inbox"]'),
      placement: 'top'
    }
  ];
}

function maybeRunSellerTour() {
  try {
    if (localStorage.getItem(SELLER_TOUR_KEY) === '1') return;
  } catch (_) { return; }
  // Wait one paint so renderShopTables / renderPayouts have populated the
  // DOM before we measure target rects.
  const _start = () => setTimeout(() => {
    try { runSellerTour(); } catch (e) { console.warn('Tour failed:', e); }
  }, 350);
  // r194 (audit W1): the tour is contextual to the dashboard (its own
  // surface is exempt from the busy check) but it still takes the single
  // per-session ambient slot — it never stacks with another prompt, and
  // it yields if the user leaves the dashboard or opens another surface
  // (markSeen:false, so it returns on a future dashboard visit).
  if (window.__ambient) {
    window.__ambient.request('tour', {
      show: _start,
      hide: () => { try { dismissSellerTour({ markSeen: false }); } catch (_) {} },
      surface: 'shopDashboard',
    });
  } else {
    _start();
  }
}

function runSellerTour() {
  if (SELLER_TOUR_STATE) return; // already running
  const steps = _sellerTourSteps();
  if (!steps.length) return;

  // Build backdrop + spotlight + tooltip nodes once; we'll mutate them
  // between steps rather than re-creating the DOM.
  let backdrop = document.getElementById('sellerTourBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sellerTourBackdrop';
    document.body.appendChild(backdrop);
  }
  let spot = document.getElementById('sellerTourSpot');
  if (!spot) {
    spot = document.createElement('div');
    spot.id = 'sellerTourSpot';
    spot.className = 'seller-tour-spot';
    document.body.appendChild(spot);
  }
  let tip = document.getElementById('sellerTourTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'sellerTourTip';
    tip.className = 'seller-tour-tip';
    tip.setAttribute('role', 'dialog');
    tip.setAttribute('aria-modal', 'false');
    tip.setAttribute('aria-label', 'Seller tour');
    document.body.appendChild(tip);
  }

  backdrop.classList.remove('closing');
  backdrop.classList.add('open');

  SELLER_TOUR_STATE = { idx: 0, steps, backdrop, spot, tip };

  // Click on backdrop dims but does NOT advance — explicit user intent only.
  backdrop.onclick = (e) => { e.stopPropagation(); };

  // Keyboard: ESC dismisses, Enter advances.
  SELLER_TOUR_STATE.keyHandler = (e) => {
    if (!SELLER_TOUR_STATE) return;
    if (e.key === 'Escape') { e.preventDefault(); dismissSellerTour({ markSeen: true }); }
    else if (e.key === 'Enter') { e.preventDefault(); advanceSellerTour(); }
  };
  document.addEventListener('keydown', SELLER_TOUR_STATE.keyHandler);

  // Reposition on resize / scroll so the spotlight tracks its target.
  SELLER_TOUR_STATE.repos = () => _renderSellerTourStep();
  window.addEventListener('resize', SELLER_TOUR_STATE.repos);
  window.addEventListener('scroll', SELLER_TOUR_STATE.repos, true);

  _renderSellerTourStep();
}

function _renderSellerTourStep() {
  if (!SELLER_TOUR_STATE) return;
  const { idx, steps, spot, tip } = SELLER_TOUR_STATE;
  const step = steps[idx];
  if (!step) return;

  if (typeof step.before === 'function') {
    try { step.before(); } catch (_) {}
  }

  const total = steps.length;
  const isLast = idx === total - 1;
  tip.innerHTML =
    '<div class="seller-tour-step">Step ' + (idx + 1) + ' of ' + total + '</div>' +
    '<div class="seller-tour-title">' + safeText(step.title) + '</div>' +
    '<div class="seller-tour-desc">' + safeText(step.desc) + '</div>' +
    '<div class="seller-tour-actions">' +
      '<button type="button" class="seller-tour-skip" data-action="seller-tour-skip">Skip tour</button>' +
      '<button type="button" class="seller-tour-next" data-action="seller-tour-next">' +
        (isLast ? 'Got it' : 'Next') +
      '</button>' +
    '</div>';

  // Defer one frame so the just-triggered tab switch (e.g. Payouts) has
  // time to render before we measure its bounding rect.
  requestAnimationFrame(() => _placeSellerTourTip(step));
}

function _placeSellerTourTip(step) {
  if (!SELLER_TOUR_STATE) return;
  const { spot, tip } = SELLER_TOUR_STATE;
  const target = (typeof step.target === 'function') ? step.target() : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const tipW = 290, tipH = tip.offsetHeight || 150;
  const margin = 12, pad = 6;

  // Helper: center the tip with no spotlight (mobile fallback).
  const centerFallback = () => {
    spot.style.display = 'none';
    tip.style.left = Math.max(12, (vw - tipW) / 2) + 'px';
    tip.style.top  = Math.max(12, (vh - tipH) / 2) + 'px';
    tip.dataset.arrow = 'none';
  };

  if (!target || !target.getBoundingClientRect) return centerFallback();
  const r = target.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return centerFallback();

  // Position spotlight over target.
  spot.style.display = 'block';
  spot.style.left   = Math.max(0, r.left - pad) + 'px';
  spot.style.top    = Math.max(0, r.top - pad)  + 'px';
  spot.style.width  = (r.width + pad * 2) + 'px';
  spot.style.height = (r.height + pad * 2) + 'px';

  // Decide tooltip placement. Prefer the requested side, but fall back
  // if it doesn't fit.
  let placement = step.placement || 'bottom';
  const fits = {
    bottom: (r.bottom + margin + tipH) < vh,
    top:    (r.top - margin - tipH) > 0,
    right:  (r.right + margin + tipW) < vw,
    left:   (r.left - margin - tipW) > 0
  };
  if (!fits[placement]) {
    placement = ['bottom', 'top', 'right', 'left'].find(p => fits[p]) || 'bottom';
  }

  let left, top, arrow;
  if (placement === 'bottom') {
    left = Math.min(vw - tipW - 12, Math.max(12, r.left));
    top  = r.bottom + margin;
    arrow = 'top';
  } else if (placement === 'top') {
    left = Math.min(vw - tipW - 12, Math.max(12, r.left));
    top  = r.top - tipH - margin;
    arrow = 'bottom';
  } else if (placement === 'right') {
    left = r.right + margin;
    top  = Math.min(vh - tipH - 12, Math.max(12, r.top));
    arrow = 'left';
  } else {
    left = r.left - tipW - margin;
    top  = Math.min(vh - tipH - 12, Math.max(12, r.top));
    arrow = 'right';
  }

  // Final clamp so we never spill past the viewport on tiny screens.
  if (left < 8 || (left + tipW) > (vw - 8) || top < 8 || (top + tipH) > (vh - 8)) {
    return centerFallback();
  }

  tip.style.left = left + 'px';
  tip.style.top  = top + 'px';
  tip.dataset.arrow = arrow;
}

function advanceSellerTour() {
  if (!SELLER_TOUR_STATE) return;
  if (SELLER_TOUR_STATE.idx >= SELLER_TOUR_STATE.steps.length - 1) {
    dismissSellerTour({ markSeen: true });
    return;
  }
  SELLER_TOUR_STATE.idx += 1;
  _renderSellerTourStep();
}

function dismissSellerTour(opts) {
  const markSeen = !opts || opts.markSeen !== false;
  if (markSeen) {
    try { localStorage.setItem(SELLER_TOUR_KEY, '1'); } catch (_) {}
  }
  if (!SELLER_TOUR_STATE) return;
  const { backdrop, spot, tip, keyHandler, repos } = SELLER_TOUR_STATE;
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  if (repos) {
    window.removeEventListener('resize', repos);
    window.removeEventListener('scroll', repos, true);
  }
  // Smooth fade-out, then remove nodes.
  if (backdrop) backdrop.classList.add('closing');
  if (tip) tip.classList.add('closing');
  setTimeout(() => {
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    if (spot && spot.parentNode) spot.parentNode.removeChild(spot);
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
  }, 200);
  SELLER_TOUR_STATE = null;
  try { window.__ambient.done('tour'); } catch (_) {}
}

let revenueChartInstance = null;

// r262: Chart.js (69KB) is dashboard-only and now loads on first use.
let __chartJsPromise = null;
function loadChartJs() {
  if (typeof Chart !== 'undefined') return Promise.resolve();
  if (__chartJsPromise) return __chartJsPromise;
  __chartJsPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
    el.integrity = 'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4';
    el.crossOrigin = 'anonymous';
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { __chartJsPromise = null; reject(new Error('chartjs-load-failed')); };
    document.head.appendChild(el);
  });
  return __chartJsPromise;
}
function renderRevenueChart(rangeDays) {
  const canvas = document.getElementById('revenueChart');
  if (!canvas) return;
  if (typeof Chart === 'undefined') {
    // Load once, then re-enter. A failed load leaves the dashboard intact
    // minus the chart — never a broken screen.
    loadChartJs().then(() => renderRevenueChart(rangeDays)).catch(() => {});
    return;
  }

  const { orders } = window.SHOP_DATA;
  const now = new Date();
  const startDate = rangeDays === 'all'
    ? (orders.length ? (orders[0].createdAt?.toDate ? orders[0].createdAt.toDate() : new Date(orders[0].createdAt)) : new Date(now.getTime() - 7*86400000))
    : new Date(now.getTime() - parseInt(rangeDays)*86400000);

  const days = Math.max(1, Math.ceil((now - startDate) / 86400000));
  const buckets = {};
  for (let i = 0; i <= days; i++) {
    const d = new Date(startDate.getTime() + i*86400000);
    const key = d.toISOString().slice(0,10);
    buckets[key] = 0;
  }

  orders.forEach(o => {
    if (!o.createdAt) return;
    const d = o.createdAt.toDate ? o.createdAt.toDate() : new Date(o.createdAt);
    if (d < startDate) return;
    const key = d.toISOString().slice(0,10);
    if (key in buckets) buckets[key] += orderItemDollars(o);
  });

  const labels = Object.keys(buckets).map(k => {
    const d = new Date(k);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  const data = Object.values(buckets);
  // r186 §6 (display-only): flag an all-zero series so the app swaps the
  // $1-scale chart for a deliberate empty state and mutes the range
  // control. The chart still renders beneath (hidden by app CSS) — no
  // computation or data path changes. Class is inert on web.
  const revSection = canvas.closest('.dash-section');
  if (revSection) revSection.classList.toggle('rev-zero', data.every(v => !v));

  if (revenueChartInstance) revenueChartInstance.destroy();

  revenueChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Revenue',
        data,
        borderColor: '#2d5438',
        backgroundColor: 'rgba(45, 84, 56, 0.08)',
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointRadius: data.some(v => v > 0) ? 3 : 0,
        pointBackgroundColor: '#2d5438'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => '$' + ctx.parsed.y.toLocaleString()
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => '$' + v.toLocaleString() }
        },
        x: {
          ticks: { maxTicksLimit: 8 }
        }
      }
    }
  });
}

function wireRevenueRangeButtons() {
  const wrap = document.getElementById('dashRange');
  if (!wrap || wrap.dataset.wired) return;
  wrap.dataset.wired = '1';
  wrap.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderRevenueChart(btn.dataset.range);
    });
  });
}
function switchDashTab(tab, opts) {
  document.querySelectorAll('.dash-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('dashTabActive').style.display = tab === 'active' ? 'block' : 'none';
  document.getElementById('dashTabSold').style.display = tab === 'sold' ? 'block' : 'none';
  const payoutsEl = document.getElementById('dashTabPayouts');
  if (payoutsEl) payoutsEl.style.display = tab === 'payouts' ? 'block' : 'none';
  const offersEl = document.getElementById('dashTabOffers');
  if (offersEl) offersEl.style.display = tab === 'offers' ? 'block' : 'none';
  if (tab === 'offers') renderSellerOffers();
  // The tab strip sits BELOW all six stat cards, so a caller near the top of
  // My Shop (the "You have a sale — ship it" banner) switched a tab several
  // screens down: the seller tapped "View order" and nothing visibly happened.
  // Bring the strip into view when it isn't already on screen.
  if (opts && opts.scroll) {
    try {
      const strip = document.querySelector('.dash-tabs');
      if (strip) {
        const r = strip.getBoundingClientRect();
        if (r.top < 0 || r.bottom > (window.innerHeight || 0)) {
          strip.scrollIntoView({behavior: 'smooth', block: 'start'});
        }
      }
    } catch (_e) { /* scrolling is a nicety — never break the tab switch */ }
  }
}
// ─────────────────────────────────────────────────────────────
// SELL FORM DRAFT — keeps the long sell form alive across reloads.
// ─────────────────────────────────────────────────────────────
const SELL_DRAFT_KEY = 'teebox-sell-draft-v1';
const SELL_FIELDS = ['sellTitle','sellBrand','sellCat','sellPrice','sellCondition','sellQuantity','sellDesc'];

function readSellDraft() {
  try { return JSON.parse(localStorage.getItem(SELL_DRAFT_KEY) || '{}'); }
  catch { return {}; }
}
function writeSellDraft(d) {
  try { localStorage.setItem(SELL_DRAFT_KEY, JSON.stringify(d)); }
  catch (e) { console.warn('Sell-draft save failed:', e); }
}
function clearSellDraft() {
  try { localStorage.removeItem(SELL_DRAFT_KEY); }
  catch (e) { console.warn('Sell-draft clear failed:', e); }
}
function maybeOfferSellDraft() {
  const host = document.getElementById('sellDraftPrompt');
  if (host) { host.style.display = 'none'; host.innerHTML = ''; }
  if (window.__editingListingId) return; // edit mode never touches drafts
  const d = readSellDraft();
  const hasContent = ['sellTitle', 'sellBrand', 'sellPrice', 'sellDesc']
    .some(k => d[k] != null && String(d[k]).trim() !== '');
  if (!hasContent) return;
  const age = Date.now() - (Number(d.__at) || 0);
  if (!d.__at || age > 7 * 24 * 3600 * 1000) { clearSellDraft(); return; }
  if (!host) return;
  const when = new Date(Number(d.__at)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const label = (d.sellTitle && String(d.sellTitle).trim()) || 'your unfinished listing';
  host.innerHTML = `<div class="sell-draft-banner"><span>Unfinished draft from ${when}: <strong>${window.safeText(String(label).slice(0, 60))}</strong></span><span><button type="button" data-action="sell-draft-resume">Resume</button> &nbsp;·&nbsp; <button type="button" data-action="sell-draft-discard">Discard</button></span></div>`;
  host.style.display = '';
}
window.resumeSellDraft = function () {
  applySellDraft();
  const host = document.getElementById('sellDraftPrompt');
  if (host) { host.style.display = 'none'; host.innerHTML = ''; }
  if (window.updateSellSteps) window.updateSellSteps();
};
window.discardSellDraft = function () {
  clearSellDraft();
  const host = document.getElementById('sellDraftPrompt');
  if (host) { host.style.display = 'none'; host.innerHTML = ''; }
};
function applySellDraft() {
  const d = readSellDraft();
  SELL_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && d[id] != null) el.value = d[id];
  });
}
function captureSellDraft() {
  const d = {};
  SELL_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) d[id] = el.value;
  });
  d.__at = Date.now(); // r258: drafts expire after 7 days (see maybeOfferSellDraft)
  writeSellDraft(d);
  // Analytics: priority event #2 — `listing_created` with state:'draft'.
  // The autosave path is invoked on EVERY keystroke; we only want to
  // emit once per draft session so a per-load guard collapses the
  // event to "user started a listing" rather than per-character noise.
  // The guard resets when the modal closes or the draft is cleared.
  try {
    if (window.posthog && !window.__teeboxDraftEmitted) {
      // Only fire after the user has typed at least a title — empty
      // captures from re-opening an autosaved-empty draft shouldn't
      // count as a new draft.
      if (d.sellTitle && String(d.sellTitle).trim().length > 0) {
        window.__teeboxDraftEmitted = true;
        window.posthog.capture('listing_created', {
          state: 'draft',
          cat: d.sellCat || null,
        });
      }
    }
  } catch (_e) { /* analytics never blocks autosave */ }
}
window.clearSellDraft = clearSellDraft;

// ── Feature flags (Firestore-backed kill-switches) ──
// `config/features` is a single doc the client reads at most once per
// session. Adding a flag: write a boolean field on that doc (server-
// side or via admin tool) and read it via window.FEATURE_FLAGS.<name>
// from the UI. Server callables MUST read the same doc directly (see
// suggestListingPrice) — never trust the client-cached value. Failing
// CLOSED on read errors is the desired behavior for kill-switches.
// See FEATURE_FLAGS.md.
window.FEATURE_FLAGS = window.FEATURE_FLAGS || {};
let __featureFlagsPromise = null;
async function loadFeatureFlags() {
  if (__featureFlagsPromise) return __featureFlagsPromise;
  __featureFlagsPromise = (async () => {
    try {
      const { getDoc, doc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const snap = await getDoc(doc(db, 'config', 'features'));
      const data = (snap.exists() ? snap.data() : null) || {};
      Object.assign(window.FEATURE_FLAGS, data);
    } catch (e) {
      // Fail closed: leave window.FEATURE_FLAGS as-is (empty) on error
      // so any flag check defaults to "off". The server-side check is
      // still the source of truth.
      console.warn('loadFeatureFlags failed', e && e.code || e);
    }
    return window.FEATURE_FLAGS;
  })();
  return __featureFlagsPromise;
}
window.loadFeatureFlags = loadFeatureFlags;

// Show/hide the AI suggest-price button based on the feature flag.
// Called from openSellModal so the lookup happens lazily (and only
// for sellers who actually open the form).
async function applyAiPriceFlagVisibility() {
  try {
    const flags = await loadFeatureFlags();
    const btn = document.getElementById('aiPriceBtn');
    if (!btn) return;
    btn.style.display = flags.aiPriceEnabled === true ? '' : 'none';
  } catch (_e) { /* button stays hidden — failing closed is intentional */ }
}

function openSellModal() {
  // r278 item 5: ListingStarted — top of the seller funnel, paired with
  // ListingCreated at publish. Custom events (trackCustom), since neither is
  // a Meta standard event. No PII: a category at most, never who.
  try {
    if (!window.__editingListingId) {
      window.fbTrack && window.fbTrack('ListingStarted', {}, { custom: true });
    }
  } catch (_e) {}
  // r260 HOTFIX: #uploadCount was removed in r259 (the count moved into
  // the step label, rendered by updateSellSteps) but this line still set
  // .textContent on it — openSellModal threw before opening and the Sell
  // button did nothing on web. Every lookup here is null-guarded now so a
  // markup change can never again take the whole modal down.
  const _prev = document.getElementById('uploadPreviews');
  if (_prev) _prev.innerHTML = '';
  const _zone = document.getElementById('uploadZone');
  if (_zone) _zone.style.display = 'block';
  // Listing v2: fresh opens start with no category picked; edit mode
  // re-hydrates right after via hydrateSpecState().
  if (!window.__editingListingId && window.resetSpecState) window.resetSpecState();
  document.getElementById('sellModalBackdrop').classList.add('open');
  // r193: resolve the seller's tier once per modal-open so the live
  // take-home line can show the real fee. The old check read
  // window.CURRENT_PROFILE — which is never assigned anywhere — so every
  // Pro seller saw 8.5% math. Best-effort; defaults to the standard fee.
  if (!window.__SELLER_TIER) window.__SELLER_TIER = 'free';
  (async () => {
    try {
      if (!window.CURRENT_USER) return;
      const { getFirestore, doc, getDoc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const s = await getDoc(doc(getFirestore(), 'users', window.CURRENT_USER.uid));
      window.__SELLER_TIER = (s.exists() && s.data().tier === 'pro') ? 'pro' : 'free';
      // Structure 2: live-rate categories (clubs, bags) need the seller's
      // ship-from before buyers can check out — resolve its presence here
      // (same doc read) for the sell-form prompt.
      const sf = (s.exists() && s.data().shippingFrom) || null;
      window.__SHIP_FROM_SET = !!(sf && (sf.line1 || sf.street1));
      if (typeof window.updateSellShipFromNotice === 'function') window.updateSellShipFromNotice();
    } catch (_e) { /* keep default */ }
  })();
  // Inline Seller-Terms row: show for not-yet-verified sellers (the merged ToS
  // step); hide in edit mode + once verified. Reset the inline verify prompt.
  try {
    const _termsRow = document.getElementById('sellTermsRow');
    const _cb = document.getElementById('sellTermsCheckbox');
    if (_termsRow) _termsRow.style.display =
      (window.__editingListingId || window.IS_VERIFIED_SELLER) ? 'none' : '';
    if (_cb) _cb.checked = false;
    const _vp = document.getElementById('sellVerifyPrompt');
    if (_vp) _vp.style.display = 'none';
  } catch (_e) { /* non-blocking */ }
  // List-first orientation (#1): if the seller hasn't completed Stripe payout
  // setup, show the non-blocking heads-up (publish now; finish payout to get
  // paid). Reads their OWN user doc (owner-readable). Best-effort; defaults
  // hidden, so a read failure never blocks listing. Hidden in edit mode.
  (async () => {
    const el = document.getElementById('sellPayoutHeadsUp');
    if (!el) return;
    el.style.display = 'none';
    if (window.__editingListingId || !window.CURRENT_USER) return;
    try {
      const { getFirestore, doc, getDoc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const snap = await getDoc(doc(getFirestore(), 'users', window.CURRENT_USER.uid));
      const ready = snap.exists() && snap.data().stripeChargesEnabled === true;
      el.style.display = ready ? 'none' : '';
    } catch (_e) { /* leave hidden on any read error */ }
  })();
  // Force create-flow chrome unless we're in edit mode. openEditListing()
  // sets window.__editingListingId BEFORE calling openSellModal(), so
  // this is a no-op on the edit path and only resets stale "Edit your
  // listing" chrome on a fresh Sell Now.
  if (!window.__editingListingId
      && typeof window.exitSellEditMode === 'function') {
    window.exitSellEditMode();
  }
  // r258 (founder ruling): NEVER silently prefill a fresh open — the
  // silent restore was surfacing weeks-old drafts ("Bulova"). Offer an
  // explicit Resume/Discard for drafts <7 days old; anything older (or
  // timestamp-less, i.e. pre-r258) is discarded.
  maybeOfferSellDraft();
  // Gate the AI suggest-price button on the Firestore feature flag.
  // Off by default until comp coverage > 100 listings per category.
  applyAiPriceFlagVisibility();
  // Ensure the AI button starts in the right state for the (possibly
  // hydrated-from-draft) field values.
  if (typeof refreshAiDescBtnState === 'function') refreshAiDescBtnState();
  // Wire price-suggest debounce once. Reads from sellTitle + sellBrand,
  // queries Firestore for sold listings of the same brand+title, and
  // shows a suggested band in the .price-suggest panel.
  if (!window.__priceSuggestWired) {
    window.__priceSuggestWired = true;
    let t;
    const refresh = () => {
      clearTimeout(t);
      t = setTimeout(() => suggestPrice().catch(()=>{}), 350);
    };
    ['sellTitle', 'sellBrand'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', refresh);
    });
    const priceEl = document.getElementById('sellPrice');
    // Structure 2 (founder ruling 2026-09-04, shipped 2026-09-08): the
    // buyer pays shipping at checkout and it funds the prepaid label, so
    // the take-home is exactly item − 8.5% — no label estimate, no
    // category dependence (Structure 1's LABEL_EST_BY_CAT retired).
    const renderTakeHome = () => {
      const v = parseFloat(priceEl && priceEl.value || '0');
      const th = document.getElementById('sellTakeHome');
      if (th) {
        if (v > 0) {
          // Pro repriced to 8.5% and signup disabled (founder ruling
          // 2026-08-25) — one flat rate for everyone, so the preview no
          // longer branches on __SELLER_TIER (which stays resolved at
          // modal-open for the future perks re-launch).
          const feePct = 8.5;
          const net = v * (1 - feePct / 100);
          // Fee-only on the eBay line too — apples to apples (buyers
          // commonly fund shipping on both platforms now).
          const ebayNet = v * (1 - 13 / 100);
          th.innerHTML =
            `You&rsquo;ll receive <strong>$${net.toFixed(2)}</strong>: ${feePct}% fee, and your buyer pays for shipping.` +
            `<span style="display:block;font-weight:500;color:var(--gray-500);margin-top:2px;">On eBay (~13%): &asymp;$${ebayNet.toFixed(2)}.</span>`;
          th.style.display = '';
        } else {
          th.style.display = 'none';
        }
      }
    };
    // Structure 2: show the ship-from prompt when a live-rate category
    // (clubs, bags) is selected and the seller has no ship-from address.
    // __SHIP_FROM_SET is resolved at sell-modal open (undefined = still
    // loading — stay hidden rather than false-alarm).
    window.updateSellShipFromNotice = () => {
      const n = document.getElementById('sellShipFromNotice');
      if (!n) return;
      const cat = ((document.getElementById('sellCat') || {}).value || '').toLowerCase();
      const liveRate = cat === 'clubs' || cat === 'bags';
      n.style.display = (liveRate && window.__SHIP_FROM_SET === false) ? '' : 'none';
    };
    const sellCatEl = document.getElementById('sellCat');
    if (sellCatEl) sellCatEl.addEventListener('change', window.updateSellShipFromNotice);
    if (priceEl) priceEl.addEventListener('input', () => {
      renderTakeHome();
      const v = parseFloat(priceEl.value || '0');
      const notice = document.getElementById('authPhotoNotice');
      if (!notice) return;
      notice.style.display = v >= 300 ? '' : 'none';
      const handleSpan = document.getElementById('authHandleHint');
      if (handleSpan && window.CURRENT_USER) {
        const dn = (window.CURRENT_PROFILE && window.CURRENT_PROFILE.displayName) || (window.CURRENT_USER.email || '').split('@')[0];
        if (dn) handleSpan.textContent = `"${dn}"`;
      }
    });
  }
}
window.openSellModal = openSellModal;

async function suggestPrice() {
  const titleEl = document.getElementById('sellTitle');
  const brandEl = document.getElementById('sellBrand');
  const priceEl = document.getElementById('sellPrice');
  const panel   = document.getElementById('priceSuggest');
  if (!panel) return;
  const title = (titleEl && titleEl.value || '').trim().toLowerCase();
  const brand = (brandEl && brandEl.value || '').trim();
  if (!brand || title.length < 4) { panel.style.display = 'none'; return; }
  try {
    const { getFirestore, collection, query, where, limit, getDocs } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // Pull up to 50 same-brand sold/active listings; filter title-similarity client-side.
    const snap = await getDocs(query(
      collection(db, 'listings'),
      where('brand', '==', brand),
      limit(50),
    ));
    const tokens = title.split(/\s+/).filter(t => t.length > 2);
    const hits = [];
    snap.forEach(d => {
      const l = d.data();
      const lt = String(l.title || '').toLowerCase();
      const overlap = tokens.filter(t => lt.includes(t)).length;
      if (overlap >= Math.min(2, tokens.length) && Number(l.ask) > 0) {
        hits.push(Number(l.ask));
      }
    });
    if (hits.length < 3) { panel.style.display = 'none'; return; }
    hits.sort((a, b) => a - b);
    const median = hits[Math.floor(hits.length / 2)];
    const low  = hits[Math.floor(hits.length * 0.25)];
    const high = hits[Math.floor(hits.length * 0.75)];
    panel.innerHTML =
      `<span>Comparable listings: <strong>$${low}–$${high}</strong> · median <strong>$${median}</strong> (${hits.length} listings)</span>` +
      `<button type="button" data-action="apply-suggest-price" data-price="${median}">Use $${median}</button>`;
    panel.style.display = '';
  } catch (e) {
    // Best-effort — never block the listing flow.
    panel.style.display = 'none';
  }
}
window.suggestPrice = suggestPrice;

// ─────────────────────────────────────────────────────────────
// AI description generator (Gemini 1.5 Flash via Cloud Function).
// Refreshes the disabled state of the "Write description for me"
// button whenever any of the four required fields change. The
// click handler (aiWriteDescription) calls the callable, fills the
// textarea, and confirms before overwriting an existing draft.
// ─────────────────────────────────────────────────────────────
function refreshAiDescBtnState() {
  const btn = document.getElementById('aiDescBtn');
  if (!btn) return;
  const t = (document.getElementById('sellTitle')     || {}).value || '';
  const b = (document.getElementById('sellBrand')     || {}).value || '';
  const c = (document.getElementById('sellCat')       || {}).value || '';
  const k = (document.getElementById('sellCondition') || {}).value || '';
  const ready = !!(t.trim() && b.trim() && c.trim() && k.trim());
  btn.disabled = !ready;
  btn.title = ready ? 'Generate a description with AI' :
    'Fill in title, brand, category, and condition first';
}
window.refreshAiDescBtnState = refreshAiDescBtnState;

async function aiWriteDescription() {
  const btn  = document.getElementById('aiDescBtn');
  const ta   = document.getElementById('sellDesc');
  if (!btn || !ta || btn.disabled) return;
  const title     = (document.getElementById('sellTitle')     || {}).value.trim();
  const brand     = (document.getElementById('sellBrand')     || {}).value.trim();
  const category  = (document.getElementById('sellCat')       || {}).value.trim();
  const condition = (document.getElementById('sellCondition') || {}).value.trim();
  if (!title || !brand || !category || !condition) {
    showToast('Fill in title, brand, category, and condition first.');
    return;
  }
  // Don't silently overwrite an in-progress draft.
  const existing = ta.value.trim();
  if (existing.length > 0) {
    if (!confirm('Replace your current description with an AI draft?')) return;
  }
  if (!window.CURRENT_USER) { showToast('Sign in to use AI description.'); return; }
  const originalLabel = btn.innerHTML;
  btn.classList.add('loading');
  btn.disabled = true;
  btn.innerHTML = '<span class="ai-desc-spark">&#10024;</span> Writing…';
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'generateListingDescription');
    let result;
    try {
      result = await fn({ title, brand, category, condition });
    } catch (e1) {
      // Seller-gate self-serve: "becoming a seller" IS the Seller-Terms
      // checkbox sitting in this same form. If it's already ticked,
      // record the agreement and retry once instead of dead-ending on
      // "verified sellers only".
      const c1 = (e1 && e1.code) || '';
      const m1 = (e1 && e1.message) || '';
      const cb1 = document.getElementById('sellTermsCheckbox');
      if (c1 === 'functions/failed-precondition' &&
          !/verify your email/i.test(m1) && cb1 && cb1.checked) {
        const verify = httpsCallable(fns, 'requestSellerVerification');
        await verify({ termsAgreed: true });
        window.IS_VERIFIED_SELLER = true;
        result = await fn({ title, brand, category, condition });
      } else {
        throw e1;
      }
    }
    const text = result && result.data && result.data.description;
    if (typeof text === 'string' && text.trim()) {
      ta.value = text.trim();
      // Persist to draft so refresh doesn't lose the AI text.
      if (typeof captureSellDraft === 'function') captureSellDraft();
      showToast('Description ready. Edit before submitting.');
    } else {
      showToast("Couldn't generate. Try again.");
    }
  } catch (e) {
    console.error('aiWriteDescription failed:', e);
    const code = (e && e.code) || '';
    if (code === 'functions/resource-exhausted') {
      showToast('Daily limit reached. Edit manually.');
    } else if (code === 'functions/failed-precondition') {
      // Never a dead end: say WHICH precondition and point at the fix.
      const emsg = (e && e.message) || '';
      const cb = document.getElementById('sellTermsCheckbox');
      if (/verify your email/i.test(emsg)) {
        try { window.maybeShowVerifyBanner && window.maybeShowVerifyBanner(window.CURRENT_USER); } catch (_e) {}
        showToast('Verify your email first — tap the link in your inbox (Resend is on the banner).');
      } else if (cb && !cb.checked) {
        try {
          const row = document.getElementById('sellTermsRow');
          if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (_e) {}
        showToast('Check “I agree to the Seller Terms” below — that makes you a seller, and AI tools unlock.');
      } else {
        showToast('Agree to the Seller Terms in the sell form to become a seller, then try again.');
      }
    } else if (code === 'functions/unauthenticated') {
      showToast('Sign in to use AI description.');
    } else {
      showToast("Couldn't generate. Try again.");
    }
  } finally {
    btn.classList.remove('loading');
    btn.innerHTML = originalLabel;
    refreshAiDescBtnState();
  }
}
window.aiWriteDescription = aiWriteDescription;

// ─────────────────────────────────────────────────────────────
// AI price-suggest (Gemini multimodal via suggestListingPrice CF).
// Reads the current draft (title/brand/category/condition + first 3
// photos), calls the Cloud Function, and renders a small card below
// the price input with the suggested price band + a "Use this price"
// shortcut. Silent fail on any error (inline message in the card).
// ─────────────────────────────────────────────────────────────
function escapeHtmlForAiCard(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function aiSuggestPrice() {
  const btn  = document.getElementById('aiPriceBtn');
  const card = document.getElementById('aiPriceCard');
  if (!btn || !card) return;
  const titleEl = document.getElementById('sellTitle');
  const brandEl = document.getElementById('sellBrand');
  const catEl   = document.getElementById('sellCat');
  const condEl  = document.getElementById('sellCondition');
  const title     = (titleEl     && titleEl.value     || '').trim();
  const brand     = (brandEl     && brandEl.value     || '').trim();
  const category  = (catEl       && catEl.value       || '').trim();
  const condition = (condEl      && condEl.value      || '').trim();
  if (!title) {
    card.className = 'ai-price-card ai-price-error';
    card.style.display = '';
    card.innerHTML = '<span class="ai-price-headline">Add a title first.</span>';
    return;
  }
  if (!window.CURRENT_USER) {
    if (window.showToast) showToast('Sign in to suggest a price.');
    return;
  }
  const originalLabel = btn.innerHTML;
  btn.classList.add('loading');
  btn.disabled = true;
  btn.innerHTML = '<span class="ai-price-spark">&#10024;</span> Analyzing…';
  card.className = 'ai-price-card';
  card.style.display = 'none';
  try {
    // Pull up to 3 photos as base64 (downscaled JPEGs) for multimodal input.
    const inlineImages = (typeof window.getSellPhotosForAI === 'function')
      ? await window.getSellPhotosForAI(3).catch(() => [])
      : [];
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'suggestListingPrice');
    const result = await fn({
      title, brand, category, condition,
      // model is not a separate field in the sell form; pass title as a hint.
      model: '',
      inlineImages,
    });
    const d = (result && result.data) || {};
    // Server kill-switch: feature-flagged off. Hide the button and the
    // card silently. (Visibility is also gated in openSellModal, but a
    // stale-cached client may still try; this is the server-trusted
    // path.)
    if (d && d.enabled === false) {
      const btnEl = document.getElementById('aiPriceBtn');
      if (btnEl) btnEl.style.display = 'none';
      card.style.display = 'none';
      return;
    }
    const suggested = Number(d.suggested || 0);
    const low  = Number(d.low  || 0);
    const high = Number(d.high || 0);
    if (!(suggested > 0 && low > 0 && high > 0)) {
      throw new Error('bad-shape');
    }
    const fmt = (n) => '$' + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
    const compsCount = Number(d.compsCount || 0);
    const reasoning = (typeof d.reasoning === 'string' && d.reasoning.trim())
      ? d.reasoning.trim()
      : (compsCount > 0
          ? `Based on ${compsCount} recent sales of similar items.`
          : 'Based on a fair-value estimate.');
    card.className = 'ai-price-card';
    card.style.display = '';
    card.innerHTML =
      '<span class="ai-price-headline">' +
        '&#128161; Suggested: <strong>' + fmt(suggested) + '</strong> ' +
        '(range <strong>' + fmt(low) + '–' + fmt(high) + '</strong>).' +
      '</span>' +
      '<span class="ai-price-reasoning">' + escapeHtmlForAiCard(reasoning) + '</span>' +
      '<button type="button" data-action="apply-ai-price" data-price="' + suggested + '">Use this price</button>';
  } catch (e) {
    console.warn('aiSuggestPrice failed:', e);
    const code = (e && e.code) || '';
    let msg = "Couldn't suggest a price right now.";
    if (code === 'functions/resource-exhausted') {
      msg = 'Too many requests. Try again in a minute.';
    } else if (code === 'functions/unauthenticated') {
      msg = 'Sign in to suggest a price.';
    } else if (code === 'functions/invalid-argument') {
      msg = 'Add a title first.';
    }
    card.className = 'ai-price-card ai-price-error';
    card.style.display = '';
    card.innerHTML = '<span class="ai-price-headline">' + escapeHtmlForAiCard(msg) + '</span>';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}
window.aiSuggestPrice = aiSuggestPrice;

function closeSellModal(e) { if(e.target===document.getElementById('sellModalBackdrop')) closeSellModalDirect(); }
function closeSellModalDirect() {
  // Single chokepoint for every close path (X button, Cancel,
  // backdrop click, global Escape). In edit mode with unsaved
  // changes, confirm before discarding. The create flow autosaves a
  // draft so it never needs this gate.
  try {
    if (typeof window.sellEditHasUnsavedChanges === 'function'
        && window.sellEditHasUnsavedChanges()) {
      const ok = window.confirm('Discard your unsaved changes to this listing?');
      if (!ok) return; // keep the modal open
    }
  } catch (_e) { /* never trap the user in the modal on an error */ }
  document.getElementById('sellModalBackdrop').classList.remove('open');
  // Always reset edit-mode chrome/state so the next "Sell Now" opens
  // a clean create form.
  try { if (typeof window.exitSellEditMode === 'function') window.exitSellEditMode(); } catch (_e) {}
}
window.closeSellModalDirect = closeSellModalDirect;

// Stripe-required dialog. Opens the gate modal when submitListing detects
// the seller hasn't finished Stripe Connect KYC (chargesEnabled !== true).
// The modal's "Set up payouts" button routes to A['stripe-connect'] which
// opens the existing Stripe Express onboarding link — no new server call
// needed. We pass the status so future iterations can show a finer-grained
// message (e.g. "Stripe still needs your bank account" vs. "...your SSN");
// for now the copy is generic.
function showStripeRequiredDialog(_status) {
  const backdrop = document.getElementById('stripeRequiredBackdrop');
  if (!backdrop) { showToast('Finish payout setup so buyers can purchase your listings.', 'error'); return; }
  backdrop.classList.add('open');
}
function closeStripeRequiredDirect() {
  const backdrop = document.getElementById('stripeRequiredBackdrop');
  if (backdrop) backdrop.classList.remove('open');
}
window.showStripeRequiredDialog = showStripeRequiredDialog;
window.closeStripeRequiredDirect = closeStripeRequiredDirect;

function openSearch() {
  document.getElementById('searchOverlay').classList.add('open');
  setTimeout(()=>document.getElementById('searchInput').focus(),50);
  // Empty input → hide the results dropdown entirely (typeahead spec).
  filterSearch('');
}
// Debounced typeahead. The raw `input` event handler calls
// filterSearch(value), which schedules a 150ms timer; the actual
// match-and-render runs in filterSearchRender. Calling filterSearch
// with an empty string hides the dropdown immediately so it doesn't
// flash a "No matches" frame on backspace-to-empty.
let __searchDebounceTimer = null;
// r335: the ONE definition of "does this listing match a search". The
// typeahead dropdown and the grid's free-text filter both use it, so Enter /
// "See all" shows exactly the set the dropdown was previewing.
function searchHaystack(p) {
  return [p.name, p.title, p.brand, p.cat, p.category, p.desc]
    .filter(Boolean).join(' ').toLowerCase();
}
function searchMatches(query) {
  const ql = String(query || '').trim().toLowerCase();
  if (!ql) return [];
  return (window.PRODUCTS || []).filter(p => p && searchHaystack(p).includes(ql));
}

// r335: Enter / "See all" — show EVERY match in the marketplace grid.
// Before this, Enter opened the first dropdown row, so "Peter Millar" ↵ took
// you to one pair of shoes instead of every Peter Millar listing (Carter,
// 2026-10-08). Category resets to All because the dropdown never filtered by
// category and the result set must be the one it previewed. Pass null/'' to
// clear (the chip's ✕).
function applySearchQuery(q) {
  const query = String(q || '').trim();
  window.__filter.q = query || null;
  const overlay = document.getElementById('searchOverlay');
  if (overlay) overlay.classList.remove('open');
  const input = document.getElementById('searchInput');
  if (input) { try { input.blur(); } catch (_e) {} }
  if (query) {
    filterCat(null, 'all');          // sweeps the pills + buildProducts('all')
    const sec = document.getElementById('homeLatest') || document.getElementById('productGrid');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    buildProducts();
  }
}
window.applySearchQuery = applySearchQuery;

function filterSearch(q) {
  if (__searchDebounceTimer) { clearTimeout(__searchDebounceTimer); __searchDebounceTimer = null; }
  const results = document.getElementById('searchResults');
  if (!results) return;
  const query = String(q || '').trim();
  if (!query) {
    // Empty input — hide the dropdown entirely (no first-N preview).
    results.innerHTML = '';
    results.style.display = 'none';
    return;
  }
  __searchDebounceTimer = setTimeout(() => filterSearchRender(query), 150);
}
// Phase 4 (r370): member search — profiles are public-readable; prefix match
// on displayName (as typed + Capitalised), max 4 rows, ≥2 chars, 250 ms debounce
// via the caller. Results append below the listing rows as "Members".
let __memberSearchSeq = 0;
async function appendMemberResults(results, query) {
  const q = String(query || '').trim();
  const seq = ++__memberSearchSeq;
  if (q.length < 2) return;
  try {
    const { getFirestore, collection, query: fsQuery, orderBy, startAt, endAt, limit, getDocs } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const variants = [...new Set([q, q.charAt(0).toUpperCase() + q.slice(1), q.toLowerCase()])];
    const snaps = await Promise.all(variants.map((v) =>
      getDocs(fsQuery(collection(db, 'profiles'), orderBy('displayName'), startAt(v), endAt(v + '\uf8ff'), limit(4))).catch(() => null)));
    if (seq !== __memberSearchSeq || !results.isConnected) return;
    const seen = new Set(); const rows = [];
    snaps.forEach((snap) => snap && snap.forEach((d) => {
      if (seen.has(d.id) || rows.length >= 4) return;
      const prof = d.data() || {};
      if (!prof.displayName) return;
      seen.add(d.id);
      rows.push({ uid: d.id, name: String(prof.displayName), avatar: window.safeImgUrl(prof.avatarUrl) });
    }));
    if (!rows.length) return;
    const html = '<div class="search-members-title">Members</div>' + rows.map((r) =>
      `<div class="search-result-item search-member" data-action="open-profile" data-uid="${window.safeAttr(window.safeId(r.uid))}" tabindex="0" role="option">` +
        `<div class="search-res-img search-member-avatar">${r.avatar ? `<img src="${window.safeAttr(r.avatar)}" alt="" loading="lazy" decoding="async" />` : `<span class="search-member-initial">${window.safeText(r.name.charAt(0).toUpperCase())}</span>`}</div>` +
        `<div><div class="search-res-name">${window.safeText(r.name)}</div><div class="search-res-cat">TeeBox member</div></div>` +
      `</div>`).join('');
    const wrap = document.createElement('div'); wrap.className = 'search-members'; wrap.innerHTML = html;
    results.querySelectorAll('.search-members').forEach((el) => el.remove());
    results.appendChild(wrap);
    results.style.display = '';
  } catch (_e) { /* members are a bonus; gear results already rendered */ }
}

function filterSearchRender(query) {
  const results = document.getElementById('searchResults');
  if (!results) return;
  results.style.display = '';
  // Substring match across the fields a buyer would type into a
  // typeahead: title/name, brand, category, plus description as a
  // last-resort signal. (Listings have no separate course/club field;
  // brand covers club names like "Scotty Cameron" today.)
  const all = searchMatches(query);
  const matches = all.slice(0, 8);
  // Analytics: priority event #4 — `search_performed`. Fires from
  // inside the 150ms-debounced render (so we don't spam on every
  // keystroke) and only for queries ≥3 chars (matches the audit-
  // recommended threshold). resultCount uses `all.length` not
  // matches.length so analytics sees the true match cardinality
  // even though the dropdown only shows 8. NOT mirrored server-
  // side (search runs entirely client-side today).
  try {
    if (window.posthog && query && query.length >= 3) {
      // Active category filter (cat-pill .active). Read it
      // defensively — the homepage doesn't always have a cat-pill
      // selected, in which case we record null.
      let activeCat = null;
      try {
        const pill = document.querySelector('.cat-pill.active');
        if (pill && pill.dataset && pill.dataset.cat) {
          activeCat = pill.dataset.cat;
        }
      } catch (_) {}
      window.posthog.capture('search_performed', {
        // Match saved-search storage's 80-char cap to keep PII
        // exposure bounded — buyers occasionally paste long
        // strings into search.
        query: String(query).slice(0, 80).toLowerCase(),
        filters: { cat: activeCat },
        resultCount: all.length,
      });
    }
    // Meta Pixel: Search (guarded; query capped at 80 chars like posthog).
    window.fbTrack && window.fbTrack('Search', { search_string: String(query).slice(0, 80) });
  } catch (_e) { /* never block search render on analytics */ }
  // Phase 4: members too ("Search for gear or members"). Async, appended
  // under the listing rows when the profile query returns; never blocks.
  appendMemberResults(results, query);
  if (!matches.length) {
    results.innerHTML = '<div class="search-no-matches" style="padding:1rem;text-align:center;color:var(--gray-400);font-size:14px">No matching gear</div>';
    return;
  }
  results.innerHTML = matches.map((p, i) => {
    const id = window.safeId(p.id);
    const url = window.variantImgUrl ? window.variantImgUrl(p, 0, 'w400') : window.safeImgUrl(p.photos && p.photos[0]);
    const img = url
      ? `<img src="${window.safeAttr(url)}" alt="${window.safeAttr(p.name||'')}" loading="lazy" decoding="async" />`
      : `<span class="placeholder-art" style="width:100%;height:100%;border-radius:6px">${window.CATEGORY_ICON(p.cat)}</span>`;
    const verifiedSlot = p.sellerId
      ? `<span class="seller-verified-slot" data-seller-id="${window.safeAttr(window.safeId(p.sellerId))}"></span>`
      : '';
    // tabindex=0 so Enter on a focused row opens the listing via
    // the keydown handler wired in openSearch().
    return `<div class="search-result-item" data-action="open-detail-from-search" data-product-id="${window.safeAttr(id)}" tabindex="0" role="option" data-search-idx="${i}">`+
      `<div class="search-res-img">${img}</div>`+
      `<div><div class="search-res-name">${window.safeText(p.name)}${verifiedSlot}</div><div class="search-res-cat">${window.safeText(p.brand)} · ${window.safeText(p.cat)}</div></div>`+
      `<span class="search-res-price">$${Number(p.ask||0).toLocaleString()}</span>`+
    `</div>`;
  }).join('') +
  // r335: the whole result set, one tap away. Same action Enter takes.
  `<div class="search-result-item search-see-all" data-action="search-see-all" tabindex="0" role="option" data-search-idx="${matches.length}">`+
    `See all ${all.length} result${all.length === 1 ? '' : 's'} for &ldquo;${window.safeText(query)}&rdquo; &rarr;`+
  `</div>`;
  hydrateVerifiedSellerPills(results);
}

// ─────────────────────────────────────────────────────────────
// RENEWAL — flip an expired listing back to active for another 60 days
// ─────────────────────────────────────────────────────────────
async function renewListing(listingId) {
  if (!listingId || !window.CURRENT_USER) return;
  try {
    const { getFirestore, doc, updateDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    await updateDoc(doc(db, 'listings', listingId), {
      status: 'active',
      expiresAt,
      updatedAt: serverTimestamp(),
    });
    showToast('Listing renewed for 60 days.');
    loadShopData();
  } catch (e) {
    console.error('renewListing failed:', e);
    showToast('Could not renew listing.');
  }
}
window.renewListing = renewListing;

// ─────────────────────────────────────────────────────────────
// DELETE LISTING — one-click + confirm flow from the My Shop active list.
// Removes the Firestore doc, then best-effort cleans up Storage photos.
// ─────────────────────────────────────────────────────────────
let _pendingDeleteListing = null; // { id, title }
function askDeleteListing(listingId, listingTitle) {
  if (!listingId) return;
  _pendingDeleteListing = { id: String(listingId), title: String(listingTitle || 'Untitled') };
  const copy = document.getElementById('deleteListingCopy');
  if (copy) {
    copy.textContent = `Delete "${_pendingDeleteListing.title}"? This cannot be undone.`;
  }
  // Reset button state every time the modal opens.
  const btn = document.getElementById('deleteListingConfirmBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  const bd = document.getElementById('deleteListingBackdrop');
  if (bd) bd.classList.add('open');
}
async function confirmDeleteListing() {
  if (!_pendingDeleteListing || !window.CURRENT_USER) return;
  const { id: listingId } = _pendingDeleteListing;
  const uid = window.CURRENT_USER.uid;
  const btn = document.getElementById('deleteListingConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    // 1. Best-effort: clean up the photos folder FIRST. Storage rules use
    //    firestore.get on the listing doc to authorize delete, so the doc
    //    must still exist when we hit Storage. Path is
    //    listings/{sellerId}/{listingId}/{filename}. Failure here is
    //    non-fatal — we still proceed to delete the listing doc.
    try {
      const { getStorage, ref: sref, listAll, deleteObject } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js");
      const st = getStorage();
      const folderRef = sref(st, `listings/${uid}/${listingId}`);
      const items = await listAll(folderRef);
      await Promise.allSettled(items.items.map(it => deleteObject(it)));
    } catch (storageErr) {
      console.warn('listing photo cleanup failed (non-fatal):', storageErr);
    }

    // 2. Delete the Firestore listing doc — the source of truth.
    const { getFirestore, doc, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await deleteDoc(doc(db, 'listings', listingId));

    // 3. Close modal, refresh the dashboard.
    _pendingDeleteListing = null;
    const bd = document.getElementById('deleteListingBackdrop');
    if (bd) bd.classList.remove('open');
    showToast('Listing deleted.');
    try { await loadShopData(); } catch (_) {}
  } catch (e) {
    console.error('deleteListing failed:', e);
    const reason = (e && e.code) ? e.code : (e && e.message) ? e.message : 'unknown error';
    showToast(`Could not delete listing: ${reason}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  }
}
window.askDeleteListing = askDeleteListing;
window.confirmDeleteListing = confirmDeleteListing;

// Bulk-delete every active listing the current user owns that has no photos.
// Used to clean up orphan test listings from before the rollback fix shipped.
async function purgeEmptyListings() {
  if (!window.CURRENT_USER) { showToast('Please sign in.'); return; }
  if (!window.SHOP_DATA || !Array.isArray(window.SHOP_DATA.listings)) {
    showToast('Shop data not loaded yet.'); return;
  }
  const empties = window.SHOP_DATA.listings.filter(l =>
    (!Array.isArray(l.photos) || l.photos.length === 0) && l.status !== 'sold'
  );
  if (empties.length === 0) { showToast('No empty listings to delete.'); return; }
  if (!confirm(`Delete ${empties.length} listing${empties.length === 1 ? '' : 's'} with no photos? This cannot be undone.`)) return;
  showToast(`Deleting ${empties.length}…`);
  try {
    const { getFirestore, doc, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    let ok = 0, fail = 0;
    for (const l of empties) {
      try { await deleteDoc(doc(db, 'listings', l.id)); ok++; }
      catch (e) { console.warn('purge: delete failed', l.id, e); fail++; }
    }
    showToast(fail === 0 ? `Deleted ${ok} listing${ok === 1 ? '' : 's'}.` : `Deleted ${ok}, ${fail} failed.`);
    try { await loadShopData(); } catch (_) {}
  } catch (e) {
    console.error('purgeEmptyListings failed:', e);
    showToast('Could not bulk-delete. Try again.');
  }
}
window.purgeEmptyListings = purgeEmptyListings;

// ─────────────────────────────────────────────────────────────
// SAVED SEARCHES — persist filter state so users can return to it.
// Email alerts are wired to Resend stub; activate when key is set.
// ─────────────────────────────────────────────────────────────
async function saveCurrentSearch() {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to save this search', () => saveCurrentSearch())) return;
  } else if (!window.CURRENT_USER) { showToast('Sign in to save a search.'); return; }
  const f = window.__filter;
  const q = (document.getElementById('searchInput') || {}).value || '';
  try {
    const { getFirestore, collection, addDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await addDoc(collection(db, 'users', window.CURRENT_USER.uid, 'savedSearches'), {
      cat: f.cat || 'all',
      sort: f.sort || 'newest',
      min: f.min == null ? null : Number(f.min),
      max: f.max == null ? null : Number(f.max),
      conditions: [...(f.conditions || [])],
      query: String(q).slice(0, 80),
      createdAt: serverTimestamp(),
    });
    showToast('Search saved. New matching listings will appear in your saved searches.');
  } catch (e) {
    console.error('saveCurrentSearch failed:', e);
    showToast('Could not save search.');
  }
}
window.saveCurrentSearch = saveCurrentSearch;

async function openSavedSearches() {
  if (!window.CURRENT_USER) { showToast('Sign in to view saved searches.'); return; }
  try {
    const { getFirestore, collection, getDocs, orderBy, query, limit, deleteDoc, doc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // r321: capped. Unbounded before — a user's own list, so small in
    // practice, but nothing stopped it growing and the screen only ever
    // renders what fits.
    const snap = await getDocs(query(
      collection(db, 'users', window.CURRENT_USER.uid, 'savedSearches'),
      orderBy('createdAt', 'desc'),
      limit(50)
    ));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const back = document.getElementById('aboutBackdrop');
    document.getElementById('profileBackdrop').classList.remove('open');
    // Reuse the info-modal frame
    document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
    const sb = document.getElementById('savedSearchesBackdrop');
    if (sb) {
      const body = document.getElementById('savedSearchesBody');
      body.innerHTML = items.length
        ? items.map(s => {
            const desc = [
              s.cat && s.cat !== 'all' ? `cat: ${s.cat}` : null,
              s.min != null ? `min $${s.min}` : null,
              s.max != null ? `max $${s.max}` : null,
              s.query ? `"${s.query}"` : null,
              (s.conditions||[]).length ? s.conditions.join(', ') : null,
            ].filter(Boolean).join(' · ');
            return `<div class="ss-row">
              <div><strong>${window.safeText(desc || 'Any listing')}</strong></div>
              <button class="filter-clear" data-action="apply-saved-search" data-search-id="${window.safeAttr(window.safeId(s.id))}">Apply</button>
              <button class="filter-clear" data-action="delete-saved-search" data-search-id="${window.safeAttr(window.safeId(s.id))}">Delete</button>
            </div>`;
          }).join('')
        : '<div class="profile-loading" style="padding:2rem">No saved searches yet. Set your filters on the marketplace and tap <strong>Save Search</strong> &mdash; we\'ll email you when new matches land.</div>';
      sb.classList.add('open');
    }
    // Stash for apply/delete
    window.__savedSearches = items;
  } catch (e) {
    console.error('openSavedSearches failed:', e);
    showToast('Could not load saved searches.');
  }
}

async function applySavedSearch(id) {
  const s = (window.__savedSearches || []).find(x => x.id === id);
  if (!s) return;
  window.__filter = {
    cat: s.cat || 'all',
    sort: s.sort || 'newest',
    min: s.min == null ? null : Number(s.min),
    max: s.max == null ? null : Number(s.max),
    conditions: new Set(s.conditions || []),
  };
  // Sync UI
  const sm = document.getElementById('sortMode'); if (sm) sm.value = window.__filter.sort;
  const mn = document.getElementById('filterMin'); if (mn) mn.value = window.__filter.min == null ? '' : window.__filter.min;
  const mx = document.getElementById('filterMax'); if (mx) mx.value = window.__filter.max == null ? '' : window.__filter.max;
  document.querySelectorAll('#filterCondition .condition-pill').forEach(b => {
    b.classList.toggle('active', window.__filter.conditions.has(b.dataset.cond));
  });
  document.getElementById('savedSearchesBackdrop').classList.remove('open');
  buildProducts();
  showToast('Search applied.');
}

async function deleteSavedSearch(id) {
  if (!window.CURRENT_USER) return;
  try {
    const { getFirestore, doc, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await deleteDoc(doc(db, 'users', window.CURRENT_USER.uid, 'savedSearches', id));
    openSavedSearches();
  } catch (e) {
    console.error('deleteSavedSearch failed:', e);
    showToast('Could not delete saved search.');
  }
}
window.applySavedSearch = applySavedSearch;
window.deleteSavedSearch = deleteSavedSearch;

// ─────────────────────────────────────────────────────────────
// ORDERS — buyer-facing list with shipment + delivery actions
// ─────────────────────────────────────────────────────────────
// Batch-2: persistent purchase-outcome sheet. ok:true → confirmation with
// item/total/ship-window/View-Order; ok:false → "card was not charged"
// failure state. Called from BOTH payment paths (in-session confirmPayment
// and the 3DS redirect return). Falls back to a toast if the DOM isn't
// ready (the 3DS handler can theoretically resolve mid-parse).
window.showOrderOutcomeSheet = function(opts) {
  const o = opts || {};
  const back = document.getElementById('orderConfirmBackdrop');
  const body = document.getElementById('orderConfirmBody');
  if (!back || !body) {
    if (window.showToast) window.showToast(o.ok ? 'Payment successful. Your order is confirmed.' : 'Payment was not completed. Your card was not charged.', o.ok ? 'success' : 'error');
    return;
  }
  const heading = document.getElementById('orderConfirmHeading');
  if (heading) heading.textContent = o.ok ? 'Order Confirmed' : 'Payment Failed';
  if (o.ok) {
    const p = o.product || null;
    const qty = Math.max(1, Number(o.qty || 1));
    const total = (o.amountCents != null)
      ? (o.amountCents / 100)
      : (p ? Number(p.ask || 0) * qty : null);
    const thumbUrl = p && window.variantImgUrl ? window.variantImgUrl(p, 0, 'w200') : null;
    const thumb = thumbUrl
      ? `<img class="order-thumb" src="${window.safeAttr(thumbUrl)}" alt="" />`
      : `<span class="order-thumb placeholder">${window.CATEGORY_ICON(p ? p.cat : 'accessories')}</span>`;
    const itemRow = p
      ? `<div class="order-confirm-item">${thumb}<div class="order-title">${window.safeText(p.name || p.title || '')}${qty > 1 ? ' × ' + qty : ''}</div></div>`
      : '';
    body.innerHTML =
      `<div class="order-confirm-icon" aria-hidden="true">✓</div>`+
      `<div class="order-confirm-title">You got it.</div>`+
      `<div class="order-confirm-sub">Your payment went through and the seller has been notified.</div>`+
      itemRow +
      (total != null ? `<div class="order-confirm-total"><span>Total paid</span><span>$${Number(total).toLocaleString()}</span></div>` : '') +
      `<div class="order-confirm-note">The seller ships within 3 business days. You&rsquo;ll get an email with tracking the moment it&rsquo;s on the way.</div>`+
      `<div class="order-confirm-actions">`+
        `<button class="btn-full green" data-action="view-my-orders">View Order</button>`+
        `<button class="btn-full ghost" data-action="close-info">Keep Browsing</button>`+
      `</div>`;
  } else {
    body.innerHTML =
      `<div class="order-confirm-icon fail" aria-hidden="true">!</div>`+
      `<div class="order-confirm-title">Payment didn&rsquo;t go through</div>`+
      `<div class="order-confirm-sub">Your card was not charged.</div>`+
      `<div class="order-confirm-note">The listing is still available &mdash; open it again to retry with a different payment method.</div>`+
      `<div class="order-confirm-actions">`+
        `<button class="btn-full green" data-action="close-info">OK</button>`+
      `</div>`;
  }
  back.classList.add('open');
};

async function loadBuyerOrders() {
  if (!window.CURRENT_USER) return [];
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDocs(query(
      collection(db, 'orders'),
      where('buyerId', '==', window.CURRENT_USER.uid),
      orderBy('createdAt', 'desc'),
      limit(100),
    ));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('loadBuyerOrders failed:', e);
    return [];
  }
}

async function openOrders() {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to view your orders', () => openOrders())) return;
  } else if (!window.CURRENT_USER) { showToast('Sign in to view your orders.'); return; }
  const back = document.getElementById('ordersBackdrop');
  if (!back) return;
  // r186: reclaim #ordersBody if the Activity hub adopted it.
  if (window.__activityRestore) window.__activityRestore();
  back.classList.add('open');
  await loadOrdersList();
}

// r186: render half of openOrders — targets #ordersBody by id, wherever it
// currently lives (its modal home, or adopted into the Activity hub).
async function loadOrdersList() {
  document.getElementById('ordersBody').innerHTML = '<div class="profile-loading" aria-busy="true"><div class="sk sk-line long"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div>';
  const orders = await loadBuyerOrders();
  if (!orders.length) {
    document.getElementById('ordersBody').innerHTML = '<div class="profile-loading"><div style="font-weight:600;color:var(--gray-700);margin-bottom:6px">No orders yet</div>When you buy a listing it shows up here with shipping status.</div>';
    return;
  }
  // Batch-2: resolve listing titles/thumbnails so no buyer ever sees a raw
  // Firestore id on a purchase record. PRODUCTS cache first (free), then a
  // per-listing getDoc fallback for items that aged out of the 200-item feed
  // cache (sold listings usually have).
  const lmap = {};
  const missing = [];
  for (const o of orders) {
    const lid = o.listingId;
    if (!lid || lmap[lid]) continue;
    const cached = (window.PRODUCTS || []).find(p => String(p.id) === String(lid));
    if (cached) {
      lmap[lid] = { title: cached.name || cached.title || '', cat: cached.cat,
                    photo: window.variantImgUrl ? window.variantImgUrl(cached, 0, 'w200') : null };
    } else missing.push(lid);
  }
  if (missing.length) {
    try {
      const { getFirestore, doc, getDoc } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const db = getFirestore();
      const fetched = await Promise.all(missing.slice(0, 30).map(async (lid) => {
        try { const s = await getDoc(doc(db, 'listings', lid)); return s.exists() ? { lid, d: s.data() } : null; }
        catch { return null; }
      }));
      for (const f of fetched) {
        if (f) lmap[f.lid] = { title: f.d.title || '', cat: f.d.cat, photo: (Array.isArray(f.d.photos) && f.d.photos[0]) || null };
      }
    } catch (_e) { /* fall back to order-ref titles */ }
  }
  document.getElementById('ordersBody').innerHTML = orders.map(o => {
    const stage = o.fulfillmentStatus || 'awaiting_seller_shipment';
    const stages = [
      { key: 'awaiting_seller_shipment', label: 'Paid' },
      { key: 'shipped',                  label: 'Shipped' },
      { key: 'delivered',                label: 'Delivered' },
      { key: 'reviewed',                 label: 'Reviewed' },
    ];
    const stageIdx = Math.max(0, stages.findIndex(s => s.key === stage));
    // Chevron separators come from CSS (.stage + .stage::before) — never
    // loose text nodes that wrap orphaned.
    const tracker = stages.map((s, i) => `<span class="stage ${i <= stageIdx ? 'on' : ''}">${s.label}</span>`).join('');
    // Prefer trackingCarrier (auto-detected from the number — ground truth)
    // over carrier (a seller dropdown that defaults to USPS and can disagree
    // with the actual number). trackingUrlFor falls back to a plain search
    // when neither resolves to a known carrier.
    const linkCarrier = o.trackingCarrier || o.carrier;
    const trackingLink = trackingUrlFor(linkCarrier, o.trackingNumber);
    const tracking = o.trackingNumber
      ? `<div class="order-tracking">Tracking:
          <a href="${window.safeAttr(trackingLink)}" target="_blank" rel="noopener noreferrer"
             style="color:var(--green-700);font-weight:600;text-decoration:underline;">
             ${window.safeText(o.trackingNumber)}
          </a>${linkCarrier ? ' · ' + window.safeText(linkCarrier) : ''}
        </div>`
      : '';
    const deliveryBtn = stage === 'shipped'
      ? `<button class="btn-full green" data-action="confirm-delivery" data-order-id="${window.safeAttr(window.safeId(o.id))}">Confirm Delivery</button>`
      : '';
    const reportBtn = stage !== 'reviewed'
      ? `<button class="btn-full ghost" data-action="report-problem" data-order-id="${window.safeAttr(window.safeId(o.id))}">Report a problem</button>`
      : '';
    // Message the seller about this order — reuses the SAME buyer↔seller
    // thread for the listing (openChatForListing finds/creates the one
    // conversation by listingId; no second thread). Uses the app's standard
    // .btn-message-seller styling (same as the listing's Message Seller
    // button) as its own full-width row below the action pair.
    const msgSellerBtn = o.listingId
      ? `<button class="btn-message-seller" data-action="message-seller-order" data-listing-id="${window.safeAttr(window.safeId(o.listingId))}">Message seller</button>`
      : '';
    const L = lmap[o.listingId] || {};
    const ref = String(o.id || '').slice(0, 6).toUpperCase();
    const thumb = L.photo
      ? `<img class="order-thumb" src="${window.safeAttr(L.photo)}" alt="" loading="lazy" decoding="async" />`
      : `<span class="order-thumb placeholder">${window.CATEGORY_ICON(L.cat || '')}</span>`;
    const placed = (o.createdAt && typeof o.createdAt.toDate === 'function')
      ? o.createdAt.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    return `<div class="order-card">
      <div class="order-top">${thumb}
        <div class="order-title">${window.safeText(L.title || 'Order ' + ref)}</div>
        <div class="order-price">$${Number(o.amount||0).toLocaleString()}</div>
      </div>
      <div class="order-meta">${placed ? 'Placed ' + placed + ' · ' : ''}Order #${ref}</div>
      <div class="order-stages">${tracker}</div>
      ${tracking}
      <div class="order-actions">${deliveryBtn}${reportBtn}</div>
      ${msgSellerBtn}
    </div>`;
  }).join('');
}

// Build the public tracking URL for a carrier+number pair so the buyer's
// "Tracking" line is clickable. Falls back to a generic Google search
// when the carrier doesn't match a known template.
function trackingUrlFor(carrier, trackingNumber) {
  if (!trackingNumber) return '#';
  const c = String(carrier || '').toLowerCase();
  const tn = encodeURIComponent(trackingNumber);
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${tn}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
  if (c.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking/tracking-parcel.html?tracking-id=${tn}`;
  return `https://www.google.com/search?q=${encodeURIComponent((carrier||'') + ' tracking ' + trackingNumber)}`;
}
window.trackingUrlFor = trackingUrlFor;

let __pendingShipOrderId = null;
function markShipped(orderId) {
  // Open the ship-it modal instead of using two stacked prompts. The modal
  // form has dropdown carriers + a focused tracking input; way friendlier
  // than the native prompt() pair this replaced.
  if (!orderId || !window.CURRENT_USER) return;
  __pendingShipOrderId = orderId;
  const back = document.getElementById('shipBackdrop');
  if (!back) return;
  const carrierSel = document.getElementById('shipCarrier');
  const trackingIn = document.getElementById('shipTracking');
  const errEl = document.getElementById('shipError');
  if (carrierSel) carrierSel.value = 'USPS';
  if (trackingIn) trackingIn.value = '';
  if (errEl) errEl.textContent = '';
  back.classList.add('open');
  setTimeout(() => trackingIn && trackingIn.focus(), 60);
}
window.markShipped = markShipped;

// Live carrier detection as the seller types — gives instant feedback so
// they don't have to submit to find out the format is wrong. Also auto-
// updates the carrier dropdown when the format strongly matches one
// specific carrier different from what's selected.
(function wireTrackingLiveHint() {
  let bound = false;
  function bind() {
    if (bound) return;
    const input = document.getElementById('shipTracking');
    const hint = document.getElementById('shipCarrierHint');
    const carrierSel = document.getElementById('shipCarrier');
    if (!input || !hint) return;
    bound = true;
    input.addEventListener('input', function() {
      const v = this.value || '';
      if (!v.trim()) { hint.textContent = ''; return; }
      const r = window.validateTrackingNumber(v);
      if (r.ok) {
        hint.style.color = 'var(--green-700, #1f8a4d)';
        hint.textContent = 'Looks like ' + r.detected + ' ✓';
        if (carrierSel && carrierSel.value !== r.detected) carrierSel.value = r.detected;
      } else if (v.replace(/[\s-]/g, '').length >= 8) {
        hint.style.color = 'var(--gray-500)';
        hint.textContent = 'Doesn\'t match a known carrier yet. Keep typing or double-check.';
      } else {
        hint.style.color = 'var(--gray-500)';
        hint.textContent = '';
      }
    });
  }
  // Modal markup is in the static HTML so binding once on first markShipped() is enough.
  const orig = window.markShipped;
  window.markShipped = function(id) { bind(); return orig(id); };
})();

// Validate tracking number against the four supported carriers. Returns
// { ok, normalized, detected } — `detected` is the auto-recognized carrier
// (used to warn the seller if it doesn't match their dropdown choice).
window.TRACKING_PATTERNS = {
  USPS:  /^(\d{20}|\d{22}|9[2-5]\d{18,20}|EA\d{9}US|EC\d{9}US|LK\d{9}US)$/,
  UPS:   /^1Z[A-HJ-NP-Z0-9]{16}$/,
  FedEx: /^(\d{12}|\d{15}|\d{20}|\d{22})$/,
  DHL:   /^\d{10}$|^\d{11}$/,
};
window.validateTrackingNumber = function(raw) {
  const normalized = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
  if (!normalized) return { ok: false, msg: 'Tracking number is required.', normalized };
  if (normalized.length < 8 || normalized.length > 30) {
    return { ok: false, msg: 'That tracking number looks too short or too long. Please double-check.', normalized };
  }
  for (const [carrier, re] of Object.entries(window.TRACKING_PATTERNS)) {
    if (re.test(normalized)) return { ok: true, normalized, detected: carrier };
  }
  return { ok: false, msg: 'That doesn’t look like a valid USPS / UPS / FedEx / DHL tracking number. Please double-check.', normalized };
};

async function confirmShip() {
  const orderId = __pendingShipOrderId;
  if (!orderId || !window.CURRENT_USER) return;
  const carrier = (document.getElementById('shipCarrier') || {}).value || 'USPS';
  const trackingRaw = ((document.getElementById('shipTracking') || {}).value || '').trim();
  const errEl = document.getElementById('shipError');
  const result = window.validateTrackingNumber(trackingRaw);
  if (!result.ok) {
    if (errEl) errEl.textContent = result.msg;
    return;
  }
  const tracking = result.normalized;
  const trackingCarrier = result.detected || carrier;
  const btn = document.getElementById('shipConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Marking shipped…'; }
  try {
    // Route through the markOrderShipped callable — the single source of truth
    // for the shipped notification (push + email). The onUpdate trigger is
    // #34-unreliable and is neutered server-side, so the callable owns this.
    // Build 67 devices still direct-write (rules allow it) and just don't get
    // the notification until Build 68 bundles this reroute.
    // fns/httpsCallable are NOT in this plain-script block's scope (the module
    // import at the top is module-scoped) — resolve them locally, like the 17
    // other callables here. Without this, the call throws ReferenceError.
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    // Write-time root-cause fix: store the number-detected carrier as the
    // authoritative `carrier` too, so a stale dropdown default (USPS) can't
    // disagree with the tracking number the way it did on order
    // pi_3UBp2g… (carrier=USPS but a FedEx number). trackingCarrier is
    // result.detected (always set once validateTrackingNumber passes).
    await httpsCallable(fns, 'markOrderShipped')({
      orderId,
      carrier: String(trackingCarrier).slice(0, 20),
      trackingCarrier: trackingCarrier,
      trackingNumber: tracking.slice(0, 60),
    });
    invalidateNotifCache();
    document.getElementById('shipBackdrop').classList.remove('open');
    showToast('Marked as shipped. Buyer notified.');
    __pendingShipOrderId = null;
    if (typeof loadShopData === 'function') loadShopData();
  } catch (e) {
    console.error('confirmShip failed:', e);
    if (errEl) errEl.textContent = 'Could not mark shipped. Please try again.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Mark as shipped'; }
  }
}
window.confirmShip = confirmShip;

// ─────────────────────────────────────────────────────────────
// Shippo — Print Shipping Label flow
//
// printShippingLabel(orderId): calls the `createShippingLabel` callable
// in functions/shippoIntegration.js. On success, opens the returned
// labelUrl PDF in a new tab and refreshes the seller's shop view so the
// row flips to "View Label" / "Mark Shipped". On error, surfaces a
// friendly toast keyed off the `reason` enum the callable returns.
// ─────────────────────────────────────────────────────────────
async function printShippingLabel(orderId) {
  if (!orderId || !window.CURRENT_USER) return;
  // Find the button element so we can spinner-state it.
  const btn = document.querySelector(`button[data-action="print-shipping-label"][data-order-id="${orderId.replace(/"/g, '\\"')}"]`);
  const oldLabel = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Buying…'; }
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'createShippingLabel');
    // Structure 2: the label is prepaid by the buyer's shipping payment —
    // no cost confirmation, nothing deducted from the seller's payout.
    // (Structure 1's quote→confirmDeduct round-trip is retired server-side.)
    const res = await fn({ orderId });
    const data = (res && res.data) || {};
    if (data.ok) {
      if (window.showToast) {
        showToast(
          data.cached
            ? 'Label already exists. Opening PDF.'
            : `Prepaid label ready (${data.carrier || 'USPS'} — paid by your buyer). Opening PDF…`,
          'success',
        );
      }
      // Open the PDF — system browser on iOS Capacitor, new tab on web.
      try {
        const Cap = window.Capacitor;
        if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
          const Browser = Cap.Plugins && Cap.Plugins.Browser;
          if (Browser && typeof Browser.open === 'function') {
            await Browser.open({ url: data.labelUrl });
          } else {
            window.location.href = data.labelUrl;
          }
        } else {
          window.open(data.labelUrl, '_blank', 'noopener,noreferrer');
        }
      } catch (_) {
        window.open(data.labelUrl, '_blank', 'noopener,noreferrer');
      }
      if (typeof loadShopData === 'function') {
        try { await loadShopData(); } catch (_) {}
      }
    } else {
      // Friendly error mapping. The callable returns an enum we can
      // pattern-match on.
      const friendly = {
        'shippo-not-configured': 'Label generation isn\'t live yet. Buy postage from any carrier and mark the order shipped.',
        'missing-from-address': 'Add your ship-from address in Account → Shipping first.',
        'missing-to-address': 'This order is missing a shipping address. Message the buyer to confirm before shipping.',
        'no-rates': 'We couldn\'t find any shipping rates for this address. Double-check the buyer\'s address and try again.',
        // r280: deliberately NOT in this map. The callable now returns
        // the carrier's own message here (an unregistered carrier is
        // reported separately as carrier-not-registered), and the old
        // blanket 'check your Shippo balance' actively misled — the
        // 2026-09-28 failure was an inactive UPS account, not funding.
        'carrier-not-registered': 'Label printing is temporarily unavailable on our side \u2014 we\'ve been alerted. Buy postage from any carrier and mark the order shipped.',
        'shippo-down': 'Shipping rates are temporarily unavailable. Please retry in a few minutes.',
        'test-key-in-prod': 'Shipping labels are temporarily unavailable. Please retry shortly.',
        'label-exceeds-collected': 'Today\'s carrier rate came back higher than the shipping your buyer paid. Contact support and we\'ll sort out the label together.',
      };
      const msg = friendly[data.reason] || data.message ||
        'Couldn\'t generate a shipping label. Please try again.';
      if (window.showToast) showToast(msg, 'error');
      console.warn('createShippingLabel returned non-ok', data);
    }
  } catch (e) {
    console.error('printShippingLabel failed:', e);
    if (window.showToast) showToast('Couldn\'t generate a shipping label. Please try again.', 'error');
  } finally {
    if (btn && oldLabel) { btn.disabled = false; btn.textContent = oldLabel; }
  }
}
window.printShippingLabel = printShippingLabel;

// ─────────────────────────────────────────────────────────────
// Shipping settings modal — Account hub → Shipping. Reads/writes
// users/{uid}.shippingFrom (the from-address every label uses).
// ─────────────────────────────────────────────────────────────
async function openShippingSettings() {
  if (!window.CURRENT_USER) return;
  const back = document.getElementById('shippingSettingsBackdrop');
  if (!back) return;
  const errEl = document.getElementById('shippingSettingsError');
  if (errEl) errEl.textContent = '';
  // Pre-fill from the user doc.
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
    const s = (snap.exists() && snap.data().shippingFrom) || {};
    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v || '';
    };
    setVal('shipFromName',  s.name);
    setVal('shipFromLine1', s.line1 || s.street1);
    setVal('shipFromLine2', s.line2 || s.street2);
    setVal('shipFromCity',  s.city);
    setVal('shipFromState', s.state);
    setVal('shipFromZip',   s.postal_code || s.zip);
    setVal('shipFromPhone', s.phone);
  } catch (e) {
    console.warn('openShippingSettings prefill failed', e);
  }
  back.classList.add('open');
}
window.openShippingSettings = openShippingSettings;

async function saveShippingSettings() {
  if (!window.CURRENT_USER) return;
  const errEl = document.getElementById('shippingSettingsError');
  const btn = document.getElementById('shippingSettingsSaveBtn');
  const val = (id) => (document.getElementById(id) || {}).value || '';
  const payload = {
    name:        val('shipFromName').trim(),
    line1:       val('shipFromLine1').trim(),
    line2:       val('shipFromLine2').trim(),
    city:        val('shipFromCity').trim(),
    state:       val('shipFromState').trim().toUpperCase(),
    postal_code: val('shipFromZip').trim(),
    phone:       val('shipFromPhone').trim(),
    country:     'US',
  };
  // Client-side validation — these four are required by Shippo.
  if (!payload.line1 || !payload.city || !payload.state || !payload.postal_code) {
    if (errEl) errEl.textContent = 'Street, city, state, and ZIP are all required.';
    return;
  }
  if (payload.state.length !== 2) {
    if (errEl) errEl.textContent = 'Use the 2-letter state code (e.g. CA, NY, TX).';
    return;
  }
  if (errEl) errEl.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const { getFirestore, doc, setDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await setDoc(doc(db, 'users', window.CURRENT_USER.uid),
        { shippingFrom: payload }, { merge: true });
    // Clear the sell-form live-rate prompt if it's showing (Structure 2).
    window.__SHIP_FROM_SET = true;
    if (typeof window.updateSellShipFromNotice === 'function') window.updateSellShipFromNotice();
    document.getElementById('shippingSettingsBackdrop').classList.remove('open');
    if (window.showToast) showToast('Shipping address saved.', 'success');
  } catch (e) {
    console.error('saveShippingSettings failed', e);
    if (errEl) errEl.textContent = 'Could not save. Please try again.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}
window.saveShippingSettings = saveShippingSettings;

// Seller-initiated refund. Reuses the `refundOrder` HTTPS callable on the
// backend. We rely on the server to enforce the actual permission gate
// (sellerId match + status check) but mirror the obvious cases in the UI
// so we don't fire an unwinnable call.
async function refundOrder(orderId) {
  if (!orderId || !window.CURRENT_USER) return;
  if (!confirm('Are you sure? Refunding cannot be undone.')) return;
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'refundOrder');
    await fn({ orderId });
    if (window.showToast) showToast('Refund issued. The buyer has been notified.', 'success');
    // Re-pull the seller's shop data so the row flips to "Refunded" and the
    // Refund button disappears without a hard reload.
    if (typeof loadShopData === 'function') {
      try { await loadShopData(); } catch (_e) {}
    }
  } catch (e) {
    console.error('refundOrder failed:', e);
    const msg = (e && (e.message || e.details)) || 'Could not refund this order.';
    if (window.showToast) showToast(msg, 'error');
    else alert(msg);
  }
}
window.refundOrder = refundOrder;

async function confirmDelivery(orderId) {
  if (!orderId || !window.CURRENT_USER) return;
  if (!confirm('Confirm you received this item in the condition described?')) return;
  try {
    // Route through the confirmOrderDelivered callable — the single source of
    // truth for the delivered notification (notifies the SELLER only; the buyer
    // isn't re-notified for a button they just tapped). The onUpdate trigger is
    // #34-unreliable and is neutered server-side. Build 67 devices still
    // direct-write until Build 68 bundles this reroute.
    // fns/httpsCallable are NOT in this plain-script block's scope — resolve
    // locally (see markOrderShipped above); a bare ref throws ReferenceError.
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    await httpsCallable(fns, 'confirmOrderDelivered')({ orderId });
    invalidateNotifCache();
    showToast('Delivery confirmed. Thanks!');
    openOrders();
  } catch (e) {
    console.error('confirmDelivery failed:', e);
    showToast('Could not confirm delivery.');
  }
}
window.confirmDelivery = confirmDelivery;

// ─────────────────────────────────────────────────────────────
// DISPUTES — buyer-initiated complaint with reason + free text
// ─────────────────────────────────────────────────────────────
let pendingDisputeOrderId = null;
function openDispute(orderId) {
  if (!orderId) return;
  pendingDisputeOrderId = orderId;
  document.getElementById('disputeBackdrop').classList.add('open');
}
window.openDispute = openDispute;

async function submitDispute() {
  if (!pendingDisputeOrderId || !window.CURRENT_USER) return;
  const reason = document.getElementById('disputeReason').value;
  const detail = document.getElementById('disputeDetail').value.trim().slice(0, 4000);
  if (!reason) { showToast('Pick a reason.'); return; }
  try {
    const { getFirestore, doc, getDoc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const ord = await getDoc(doc(db, 'orders', pendingDisputeOrderId));
    if (!ord.exists()) { showToast('Order not found.'); return; }
    const od = ord.data();
    await setDoc(doc(db, 'disputes', pendingDisputeOrderId), {
      orderId: pendingDisputeOrderId,
      buyerId: window.CURRENT_USER.uid,
      sellerId: od.sellerId,
      listingId: od.listingId,
      reason, detail,
      status: 'open',
      createdAt: serverTimestamp(),
    });
    document.getElementById('disputeBackdrop').classList.remove('open');
    showToast('Report submitted. TeeBox reviews every dispute and follows up by email.');
  } catch (e) {
    console.error('submitDispute failed:', e);
    showToast('Could not submit report.');
  }
}
window.submitDispute = submitDispute;

// ─────────────────────────────────────────────────────────────
// BLOCK + REPORT
// ─────────────────────────────────────────────────────────────
async function blockConversation() {
  if (!currentChat || !currentChat.otherUserId) { showToast('No active conversation.'); return; }
  if (!confirm('Block this user? Neither of you will be able to message the other, and your existing conversations will be hidden.')) return;
  const otherUid = currentChat.otherUserId;
  try {
    const { getFirestore, doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await setDoc(doc(db, 'users', window.CURRENT_USER.uid), {
      blocked: { [otherUid]: { blockedAt: serverTimestamp() } },
    }, { merge: true });
    closeChat();
    showToast('User blocked.');
  } catch (e) {
    console.error('blockConversation failed:', e);
    showToast('Could not block user.');
  }
}
window.blockConversation = blockConversation;

// r173: the old inline prompt() built a payload the reports rules rejected
// (no targetType, free-text reason vs the enum) — every submission failed.
// Route through the shared report dialog, whose confirmReport payload is
// schema-valid (targetType/enum reason/details/status).
function reportConversation() {
  if (!currentChat || !currentChat.otherUserId) return;
  window.openReportDialog({
    targetType: 'user',
    targetId: currentChat.otherUserId,
    targetUid: currentChat.otherUserId,
    conversationId: currentChat.conversationId || undefined,
  });
}
window.reportConversation = reportConversation;

// Patch the saved-searches register so apply/delete actions resolve.
// These bind v1.1 (top-level + legacy) variants — the v1.1 helpers
// `applySavedSearchV2` / `deleteSavedSearchV2` are defined further
// down in the module; the action handler is invoked at click time so
// hoisting isn't a concern.
window.__actions = window.__actions || {};
window.__actions['apply-saved-search']  = (el) => applySavedSearchV2(el.dataset.searchId, el.dataset.searchSrc);
window.__actions['delete-saved-search'] = (el) => deleteSavedSearchV2(el.dataset.searchId, el.dataset.searchSrc);

// ═════════════════════════════════════════════════════════════
// FEATURE #14 — MAKE-AN-OFFER (buyer ↔ seller negotiation)
// ═════════════════════════════════════════════════════════════
//
// Schema (top-level `offers` collection — see firestore.rules):
//   { buyerId, sellerId, listingId, amount, message?, status,
//     expiresAt, createdAt, counterAmount?, respondedAt? }
//   status ∈ pending | accepted | declined | countered | expired
//
// Buyer flow:
//   1. Tap "Make Offer" on listing detail → openMakeOfferModal
//   2. Submit → addDoc to /offers; toast confirmation
//   3. Status updates show up in "My Offers" (user menu)
//
// Seller flow (Shop dashboard "Offers" tab):
//   - Lists pending offers; per-row Accept/Counter/Decline.
//   - Accept opens chat with the buyer w/ pre-filled checkout text.
//   - Counter writes counterAmount + status='countered'.
//   - Decline writes status='declined' (with confirm).
let __pendingOfferListing = null;
// r318 — keep the offer modal honest and the message warm.
//
// Shipping is NOT a field on the listing: it is quoted live at checkout from
// the buyer's address and the item's parcel class (shippoIntegration.js). So
// there is no number to show here, and inventing one would be worse than
// saying nothing. We say the same thing the detail page and the accepted-offer
// row already say — shipping is added at checkout — so a buyer offering $300
// is not surprised by $320 the moment a seller accepts.
let __offerMsgTouched = false;
function syncOfferModal() {
  const p = __pendingOfferListing;
  const amtEl = document.getElementById('makeOfferAmount');
  const note = document.getElementById('makeOfferShipNote');
  const msg = document.getElementById('makeOfferMessage');
  const amt = Number(amtEl && amtEl.value);
  const valid = Number.isFinite(amt) && amt > 0;
  if (note) {
    note.innerHTML = valid
      ? `You&rsquo;re offering <strong>$${amt.toLocaleString()}</strong> for the item. Shipping is calculated at checkout and paid on top.`
      : 'Shipping is calculated at checkout and paid on top of your offer.';
  }
  // Pre-filled so the seller gets a human note instead of a bare number —
  // but only until the buyer types something of their own.
  if (msg && !__offerMsgTouched) {
    msg.value = valid ? `Hope you'll take $${amt.toLocaleString()}. Thanks!` : '';
  }
  void p;
}
function openMakeOfferModal() {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to make an offer', () => openMakeOfferModal())) return;
  } else if (!window.CURRENT_USER) { showToast('Sign in to make an offer.'); return; }
  if (!currentDetailId) return;
  const p = window.PRODUCTS.find(x => String(x.id) === String(currentDetailId));
  if (!p) return;
  if (typeof p.id !== 'string' || !p.sellerId) {
    showToast('Offers are only available on real listings.'); return;
  }
  if (p.sellerId === window.CURRENT_USER.uid) {
    showToast("You can't offer on your own listing."); return;
  }
  if (p.status === 'sold' || p.status === 'pending') {
    showToast("This listing isn't available for offers."); return;
  }
  __pendingOfferListing = p;
  const ask = Number(p.ask || 0);
  const sub = document.getElementById('makeOfferSub');
  if (sub) sub.textContent = `Listed at $${ask.toLocaleString()}. Most accepted offers fall within 10–20% of the asking price.`;
  const amt = document.getElementById('makeOfferAmount');
  if (amt) amt.value = ask > 0 ? Math.round(ask * 0.85) : '';
  const msg = document.getElementById('makeOfferMessage');
  if (msg) msg.value = '';
  // r318: fresh state every open — a stale tick would let the next offer
  // through without the buyer ever seeing the commitment.
  __offerMsgTouched = false;
  const commit = document.getElementById('makeOfferCommit');
  const send = document.getElementById('makeOfferSubmit');
  if (commit) commit.checked = false;
  if (send) send.disabled = true;
  if (amt && !amt.__offerWired) {
    amt.__offerWired = true;
    amt.addEventListener('input', syncOfferModal);
  }
  if (msg && !msg.__offerWired) {
    msg.__offerWired = true;
    msg.addEventListener('input', () => { __offerMsgTouched = true; });
  }
  if (commit && !commit.__offerWired) {
    commit.__offerWired = true;
    commit.addEventListener('change', () => {
      const b = document.getElementById('makeOfferSubmit');
      if (b) b.disabled = !commit.checked;
    });
  }
  syncOfferModal();
  closeDetailModalDirect();
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  document.getElementById('makeOfferBackdrop').classList.add('open');
}

async function submitOffer() {
  if (!window.CURRENT_USER || !__pendingOfferListing) return;
  const p = __pendingOfferListing;
  const ask = Number(p.ask || 0);
  const amt = Number(document.getElementById('makeOfferAmount').value);
  const msg = (document.getElementById('makeOfferMessage').value || '').trim().slice(0, 500);
  if (!Number.isFinite(amt) || amt <= 0) { showToast('Enter a valid offer amount.'); return; }
  // r318: the button is disabled until this is ticked, but check anyway —
  // the action is reachable from the delegated handler.
  const commitEl = document.getElementById('makeOfferCommit');
  if (!commitEl || !commitEl.checked) {
    showToast('Please confirm you\u2019ll pay if your offer is accepted.');
    return;
  }
  if (ask > 0 && amt >= ask) {
    showToast('Offer is at or above ask. Use Buy Now instead.');
    return;
  }
  try {
    const { getFirestore, collection, addDoc, serverTimestamp, Timestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const offerDocRef = await addDoc(collection(db, 'offers'), {
      buyerId: window.CURRENT_USER.uid,
      sellerId: p.sellerId,
      listingId: String(p.id),
      amount: amt,
      message: msg || '',
      // r318: audit trail for the commitment. The offers create rule uses
      // hasAll(), not hasOnly(), so an extra field needs no rules change.
      agreedToPay: true,
      status: 'pending',
      expiresAt: Timestamp.fromDate(expiresAt),
      createdAt: serverTimestamp(),
    });
    // Analytics: priority event #6 — `offer_made`. Fires after the
    // Firestore write resolves so we only count offers that actually
    // hit the database. NOT mirrored server-side; there's no
    // onOfferCreated event-stream trigger (the existing
    // notifyOnOfferCreated is for fan-out, not analytics).
    try {
      if (window.posthog) {
        window.posthog.capture('offer_made', {
          offerId: offerDocRef.id,
          listingId: String(p.id),
          sellerId: p.sellerId || null,
          askCents: Math.round(ask * 100),
          offerCents: Math.round(amt * 100),
          discountPct: ask > 0 ? Math.round((1 - amt / ask) * 100) : null,
        });
      }
    } catch (_e) { /* never block offer submit on analytics */ }
    document.getElementById('makeOfferBackdrop').classList.remove('open');
    showToast('Offer sent to seller. They have 48 hours to respond.', 'success');
    // Contextual push prompt — first offer made, frame "hear back fast".
    setTimeout(() => { try { window.maybePromptForPush && window.maybePromptForPush('first-offer'); } catch (_e) {} }, 1500);
  } catch (e) {
    console.error('submitOffer failed:', e);
    // Content-violation path: server-side filter rejected the offer
    // with HttpsError invalid-argument + details.error = 'content_violation'.
    // Never echo the matched word or category — audit detail only.
    if (window.isContentViolationError && window.isContentViolationError(e)) {
      showContentViolationToast();
      return;
    }
    showToast('Could not send offer.');
  }
}
window.openMakeOfferModal = openMakeOfferModal;
window.submitOffer = submitOffer;

// Buyer pays an offer the seller agreed to (accepted or countered).
// Payment IS the acceptance — no separate status write. We ensure the
// listing is available to openCheckout (it may not be in the current
// feed if the buyer reached this from "My Offers"), then hand off with
// the offer context. The server re-validates the offer + prices it.
async function payOffer(offerId, listingId, agreedAmount) {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to complete your purchase', () => payOffer(offerId, listingId, agreedAmount))) return;
  } else if (!window.CURRENT_USER) { showToast('Sign in to complete your purchase.'); return; }
  if (!offerId || !listingId) { showToast('Could not open checkout for this offer.'); return; }
  try {
    // Make sure the listing is in window.PRODUCTS so openCheckout can find it.
    let p = (window.PRODUCTS || []).find(x => String(x.id) === String(listingId));
    if (!p) {
      const { getFirestore, doc, getDoc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const snap = await getDoc(doc(getFirestore(), 'listings', String(listingId)));
      if (!snap.exists()) { showToast('That listing is no longer available.'); return; }
      p = { id: snap.id, ...snap.data() };
      window.PRODUCTS = window.PRODUCTS || [];
      if (!window.PRODUCTS.some(x => String(x.id) === String(p.id))) window.PRODUCTS.push(p);
    }
    if (p.status === 'sold') { showToast('This item has already sold.'); return; }
    // Close any open offer modals before the checkout sheet opens.
    document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
    window.openCheckout(String(listingId), 1, { offerId: String(offerId), offerAmount: Number(agreedAmount) || undefined });
  } catch (e) {
    console.error('payOffer failed:', e);
    showToast('Could not open checkout for this offer.');
  }
}
window.payOffer = payOffer;

async function loadSellerOffers() {
  if (!window.CURRENT_USER) return [];
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    let snap;
    try {
      snap = await getDocs(query(
        collection(db, 'offers'),
        where('sellerId', '==', window.CURRENT_USER.uid),
        where('status', '==', 'pending'),
        orderBy('createdAt', 'desc'),
        limit(50),
      ));
    } catch (_idxErr) {
      // Composite index might not be deployed; fall back to one filter.
      const all = await getDocs(query(
        collection(db, 'offers'),
        where('sellerId', '==', window.CURRENT_USER.uid),
        limit(50),
      ));
      const items = all.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(o => o.status === 'pending')
        .sort((a, b) => {
          const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
          const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
          return bt - at;
        });
      return items;
    }
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('loadSellerOffers failed:', e);
    return [];
  }
}

function timeRemaining(expiresAt) {
  if (!expiresAt) return '';
  const ms = (expiresAt.toMillis ? expiresAt.toMillis() : new Date(expiresAt).getTime()) - Date.now();
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  const days  = Math.floor(hours / 24);
  if (days >= 1) return days === 1 ? '1 day left' : days + ' days left';
  if (hours >= 1) return hours === 1 ? '1 hour left' : hours + ' hours left';
  return 'Less than 1 hour left';
}

async function renderSellerOffers() {
  const el = document.getElementById('dashTabOffers');
  if (!el) return;
  el.innerHTML = '<div class="dash-empty">Loading offers…</div>';
  const offers = await loadSellerOffers();
  // Update badge on tab
  const badge = document.getElementById('offersBadge');
  if (badge) {
    if (offers.length) { badge.textContent = String(offers.length); badge.style.display = 'inline-block'; }
    else { badge.style.display = 'none'; }
  }
  if (!offers.length) {
    el.innerHTML = '<div class="dash-empty"><div style="font-weight:600;color:var(--gray-700);margin-bottom:6px">No pending offers</div>When a buyer offers on one of your listings, it shows up here to Accept, Counter, or Decline.</div>';
    return;
  }
  // Build buyer-name resolution + listing snapshot in parallel.
  const listingsById = {};
  (window.SHOP_DATA && window.SHOP_DATA.listings || []).forEach(l => { listingsById[String(l.id)] = l; });
  // Resolve unknown listings on the fly.
  await Promise.all(offers.map(async o => {
    if (!listingsById[o.listingId]) {
      try {
        const { getFirestore, doc, getDoc } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
        const snap = await getDoc(doc(getFirestore(), 'listings', o.listingId));
        if (snap.exists()) listingsById[o.listingId] = { id: snap.id, ...snap.data() };
      } catch (_e) {}
    }
  }));
  const profilesByUid = {};
  await Promise.all(offers.map(async o => {
    if (!profilesByUid[o.buyerId]) {
      profilesByUid[o.buyerId] = await loadProfile(o.buyerId);
    }
  }));
  const rows = offers.map(o => {
    const listing = listingsById[o.listingId] || {};
    const buyerName = (profilesByUid[o.buyerId] && profilesByUid[o.buyerId].displayName) || ('Buyer •••• ' + (o.buyerId || '').slice(-4).toUpperCase());
    const ask = Number(listing.ask || 0);
    const pctOff = ask > 0 ? Math.round((1 - (Number(o.amount) / ask)) * 100) : 0;
    const photo = (listing.photos && listing.photos[0]) || null;
    const img = photo
      ? `<img src="${window.safeAttr(photo)}" alt="" loading="lazy" />`
      : `<span class="placeholder-art" style="width:100%;height:100%;border-radius:6px">${window.CATEGORY_ICON(listing.cat)}</span>`;
    const id = window.safeAttr(window.safeId(o.id));
    const lid = window.safeAttr(window.safeId(o.listingId));
    const buy = window.safeAttr(window.safeId(o.buyerId));
    const expMs = o.expiresAt ? ((o.expiresAt.toMillis ? o.expiresAt.toMillis() : new Date(o.expiresAt).getTime()) - Date.now()) : 0;
    const urgent = expMs > 0 && expMs < 12 * 3600 * 1000;
    const chipClass = urgent ? 'offer-time-chip urgent' : 'offer-time-chip';
    return `<div class="offer-row" data-offer-id="${id}">
      <div class="offer-img">${img}</div>
      <div class="offer-meta">
        <div class="offer-title">${window.safeText(listing.title || 'Listing')}</div>
        <div class="offer-sub">From ${window.safeText(buyerName)} <span class="${chipClass}">${window.safeText(timeRemaining(o.expiresAt))}</span></div>
        ${o.message ? `<div class="offer-msg">"${window.safeText(o.message)}"</div>` : ''}
      </div>
      <div style="text-align:right">
        <div class="offer-amt">$${Number(o.amount || 0).toLocaleString()}</div>
        ${ask > 0 ? `<div class="offer-pct-off">-${pctOff}% vs $${ask.toLocaleString()}</div>` : ''}
      </div>
      <div class="offer-actions" data-feature="offers">
        <button class="btn-accept"  data-action="accept-offer"  data-offer-id="${id}" data-listing-id="${lid}" data-buyer-id="${buy}" data-amount="${Number(o.amount||0)}">Accept</button>
        <button class="btn-counter" data-action="counter-offer" data-offer-id="${id}" data-amount="${Number(o.amount||0)}">Counter</button>
        <button class="btn-decline" data-action="decline-offer" data-offer-id="${id}">Decline</button>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = rows;
}
window.renderSellerOffers = renderSellerOffers;

async function acceptOffer(offerId, listingId, buyerId, amount) {
  if (!window.CURRENT_USER || !offerId) return;
  if (!confirm(`Accept this $${Number(amount).toLocaleString()} offer? The buyer will be able to pay this price right away — the listing stays live until someone pays.`)) return;
  try {
    const { getFirestore, doc, updateDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await updateDoc(doc(db, 'offers', offerId), {
      status: 'accepted',
      respondedAt: serverTimestamp(),
    });
    invalidateNotifCache();
    showToast('Offer accepted. The buyer can pay now — we notified them.', 'success');
    // Let the buyer know it's ready to pay (in-app chat context, best-effort).
    // The buyer's own "My Offers" now shows a Pay button; this is just a nudge.
    if (listingId && buyerId) {
      try {
        await openChatForListingAsSeller(listingId, buyerId, `Your $${Number(amount).toLocaleString()} offer is accepted — open "My Offers" to pay and I'll ship it out.`);
      } catch (_e) { /* fallback: just toast */ }
    }
    renderSellerOffers();
  } catch (e) {
    console.error('acceptOffer failed:', e);
    showToast('Could not accept offer.');
  }
}

// Helper: open a chat for a listing where the seller initiates. The
// existing openChatForListing only supports buyer-initiated convs, so
// we replicate the conversation lookup/creation logic here, with the
// auth user as the seller-side participant.
async function openChatForListingAsSeller(listingId, buyerId, prefillText) {
  if (!window.CURRENT_USER) return;
  const { getFirestore, doc, getDoc, collection, query, where, getDocs, addDoc, serverTimestamp, orderBy, limit } =
    await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
  const firestoreDb = getFirestore();
  const listingSnap = await getDoc(doc(firestoreDb, 'listings', String(listingId)));
  if (!listingSnap.exists()) { showToast('Listing not found.'); return; }
  const listing = { id: listingSnap.id, ...listingSnap.data() };
  if (listing.sellerId !== window.CURRENT_USER.uid) return;
  // Find existing conversation between buyer + seller for this listing.
  const convsRef = collection(firestoreDb, 'conversations');
  const existingQ = query(
    convsRef,
    where('listingId', '==', String(listingId)),
    where('participants', 'array-contains', window.CURRENT_USER.uid),
    limit(5),
  );
  const existing = await getDocs(existingQ);
  let convId = null;
  existing.docs.forEach(d => {
    const data = d.data();
    if (Array.isArray(data.participants) && data.participants.includes(buyerId)) convId = d.id;
  });
  if (!convId) {
    const newConv = await addDoc(convsRef, {
      participants: [window.CURRENT_USER.uid, buyerId],
      listingId: String(listingId),
      buyerId,
      sellerId: window.CURRENT_USER.uid,
      listingTitle: (listing.title || '').slice(0, 200),
      listingEmoji: (listing.emoji || '').slice(0, 16),
      createdAt: serverTimestamp(),
    });
    convId = newConv.id;
  }
  // Drop a message in — r173: routed through the sendMessage callable so
  // the prefill gets the same content scan + rate limits + block checks as
  // every other message. (The old direct addDoc bypassed all of them, and
  // messages-subcollection creates are now denied client-side by rules.)
  // fns/httpsCallable are NOT in this plain-block scope — local import.
  if (prefillText) {
    try {
      const { getFunctions, httpsCallable } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
      const fns = getFunctions();
      await httpsCallable(fns, 'sendMessage')({
        conversationId: convId,
        recipientId: buyerId,
        text: String(prefillText).slice(0, 2000),
        clientFlag: null,
      });
    } catch (e) {
      // Never brick the flow — the thread still opens and the seller can
      // type the message manually if the prefill was scanned out.
      console.warn('prefill send failed:', e && (e.code || e.message) || e);
    }
  }
  // Open chat UI to that conv.
  if (typeof openChatFromConversation === 'function') openChatFromConversation(convId);
}

let __pendingCounterOfferId = null;
function openCounterOffer(offerId, currentAmount) {
  if (!offerId) return;
  __pendingCounterOfferId = offerId;
  const sub = document.getElementById('counterOfferSub');
  if (sub) sub.textContent = `Buyer offered $${Number(currentAmount || 0).toLocaleString()}. Send a counter price.`;
  const amt = document.getElementById('counterOfferAmount');
  if (amt) amt.value = '';
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  document.getElementById('counterOfferBackdrop').classList.add('open');
}

async function confirmCounterOffer() {
  if (!window.CURRENT_USER || !__pendingCounterOfferId) return;
  const amt = Number(document.getElementById('counterOfferAmount').value);
  if (!Number.isFinite(amt) || amt <= 0) { showToast('Enter a valid counter amount.'); return; }
  try {
    const { getFirestore, doc, updateDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await updateDoc(doc(db, 'offers', __pendingCounterOfferId), {
      status: 'countered',
      counterAmount: amt,
      respondedAt: serverTimestamp(),
    });
    invalidateNotifCache();
    document.getElementById('counterOfferBackdrop').classList.remove('open');
    showToast('Counter sent.', 'success');
    renderSellerOffers();
  } catch (e) {
    console.error('confirmCounterOffer failed:', e);
    showToast('Could not send counter.');
  }
}

async function declineOffer(offerId) {
  if (!window.CURRENT_USER || !offerId) return;
  if (!confirm('Decline this offer?')) return;
  try {
    const { getFirestore, doc, updateDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await updateDoc(doc(db, 'offers', offerId), {
      status: 'declined',
      respondedAt: serverTimestamp(),
    });
    invalidateNotifCache();
    showToast('Offer declined.');
    renderSellerOffers();
  } catch (e) {
    console.error('declineOffer failed:', e);
    showToast('Could not decline offer.');
  }
}

// ── Buyer side: My Offers ──────────────────────────────────────────
async function openMyOffers() {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to view your offers', () => openMyOffers())) return;
  } else if (!window.CURRENT_USER) { showToast('Sign in to view your offers.'); return; }
  const back = document.getElementById('myOffersBackdrop');
  if (!back) return;
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  back.classList.add('open');
  const body = document.getElementById('myOffersBody');
  body.innerHTML = '<div class="profile-loading" aria-busy="true"><div class="sk sk-line long"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div>';
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    let offers = [];
    try {
      const snap = await getDocs(query(
        collection(db, 'offers'),
        where('buyerId', '==', window.CURRENT_USER.uid),
        orderBy('createdAt', 'desc'),
        limit(50),
      ));
      offers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_idx) {
      const snap = await getDocs(query(
        collection(db, 'offers'),
        where('buyerId', '==', window.CURRENT_USER.uid),
        limit(50),
      ));
      offers = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
          const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
          return bt - at;
        });
    }
    if (!offers.length) {
      body.innerHTML = '<div class="profile-loading" style="padding:2rem">No offers yet. Find something you like and tap <strong>Make Offer</strong> to send the seller a price.</div>';
      return;
    }
    // Resolve listing snapshots
    const listingsById = {};
    await Promise.all(offers.map(async o => {
      if (listingsById[o.listingId]) return;
      try {
        const { getFirestore: gf2, doc, getDoc } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
        const snap = await getDoc(doc(gf2(), 'listings', o.listingId));
        if (snap.exists()) listingsById[o.listingId] = { id: snap.id, ...snap.data() };
      } catch (_e) {}
    }));
    body.innerHTML = offers.map(o => {
      const listing = listingsById[o.listingId] || {};
      const photo = (listing.photos && listing.photos[0]) || null;
      const img = photo
        ? `<img src="${window.safeAttr(photo)}" alt="" loading="lazy" />`
        : `<span class="placeholder-art" style="width:100%;height:100%;border-radius:6px">${window.CATEGORY_ICON(listing.cat)}</span>`;
      const status = o.status || 'pending';
      const statusCls = status === 'accepted' ? 'accepted' : status === 'declined' ? 'declined' : status === 'countered' ? 'countered' : '';
      const id = window.safeAttr(window.safeId(o.id));
      const lid = window.safeAttr(window.safeId(o.listingId));
      // Accepted → Pay button (payment IS the acceptance server-side).
      // Countered → Accept-$X pays the counter; Walk away lets it expire.
      const actionRow = status === 'accepted'
        ? `<div class="offer-actions" data-feature="offers">
            <button class="btn-accept" data-action="pay-offer" data-offer-id="${id}" data-listing-id="${lid}" data-amount="${Number(o.amount||0)}">Pay $${Number(o.amount||0).toLocaleString()}</button>
           </div>`
        : (status === 'countered' && o.counterAmount)
          ? `<div class="offer-actions" data-feature="offers">
              <button class="btn-accept"  data-action="accept-counter"  data-offer-id="${id}">Accept $${Number(o.counterAmount).toLocaleString()}</button>
              <button class="btn-decline" data-action="decline-counter" data-offer-id="${id}">Walk away</button>
             </div>`
          : '';
      const subText = status === 'pending'
        ? `Awaiting seller · ${window.safeText(timeRemaining(o.expiresAt))}`
        : status === 'accepted'
          ? 'Accepted — pay now to lock it in (plus shipping).'
          : status === 'fulfilled'
            ? 'Purchased ✓ — check your orders.'
            : status === 'declined'
              ? 'Declined by seller.'
              : status === 'countered'
                ? `Seller countered $${Number(o.counterAmount || 0).toLocaleString()}`
                : status;
      return `<div class="offer-row">
        <div class="offer-img">${img}</div>
        <div class="offer-meta">
          <div class="offer-title">${window.safeText(listing.title || 'Listing')}</div>
          <div class="offer-sub">${window.safeText(subText)}</div>
        </div>
        <div style="text-align:right">
          <div class="offer-amt">$${Number(o.amount || 0).toLocaleString()}</div>
          <span class="offer-status-pill ${statusCls}">${window.safeText(status)}</span>
        </div>
        ${actionRow}
      </div>`;
    }).join('');
  } catch (e) {
    console.error('openMyOffers failed:', e);
    body.innerHTML = '<div class="profile-loading">Could not load offers.</div>';
  }
}
window.openMyOffers = openMyOffers;

async function acceptCounter(offerId) {
  // Accepting a counter = paying it. Payment IS the acceptance (the buyer
  // can't write offer status under the rules; the server prices the
  // 'countered' offer at counterAmount and stamps it fulfilled on success).
  if (!window.CURRENT_USER || !offerId) return;
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const offSnap = await getDoc(doc(db, 'offers', offerId));
    if (!offSnap.exists()) { showToast('That offer is no longer available.'); return; }
    const off = offSnap.data();
    const counter = Number(off.counterAmount || 0);
    if (!(counter > 0)) { showToast('That counter is no longer valid.'); return; }
    if (!confirm(`Accept the seller's $${counter.toLocaleString()} counter and pay now? (Plus shipping.)`)) return;
    await payOffer(offerId, off.listingId, counter);
  } catch (e) {
    console.error('acceptCounter failed:', e);
    showToast('Could not open checkout for this counter.');
  }
}
window.acceptCounter = acceptCounter;

async function declineCounter(offerId) {
  // No buyer-side write allowed for status='declined' under current
  // rules (only seller can flip status). The simplest "walk away" is to
  // simply close the modal — the offer will time out via the
  // `expireOldOffers` Cloud Function.
  showToast('No worries. The offer will expire automatically.');
  document.getElementById('myOffersBackdrop').classList.remove('open');
}
window.declineCounter = declineCounter;

// ── Wire the offer buttons into the delegated action dispatch. These
// were authored long ago but never registered (the feature shipped
// hidden behind [data-feature="offers"]); registering them here is what
// turns the make/accept/counter/decline/pay buttons live. Handlers read
// their args from the button's data-* attributes.
window.__actions = window.__actions || {};
window.__actions['make-offer']            = function()   { openMakeOfferModal(); };
window.__actions['submit-offer']          = function()   { submitOffer(); };
window.__actions['open-my-offers']        = function()   { openMyOffers(); };
window.__actions['confirm-counter-offer'] = function()   { confirmCounterOffer(); };
window.__actions['accept-offer']          = function(el) { acceptOffer(el.dataset.offerId, el.dataset.listingId, el.dataset.buyerId, Number(el.dataset.amount)); };
window.__actions['counter-offer']         = function(el) { openCounterOffer(el.dataset.offerId, Number(el.dataset.amount)); };
window.__actions['decline-offer']         = function(el) { declineOffer(el.dataset.offerId); };
window.__actions['accept-counter']        = function(el) { acceptCounter(el.dataset.offerId); };
window.__actions['decline-counter']       = function(el) { declineCounter(el.dataset.offerId); };
window.__actions['pay-offer']             = function(el) { payOffer(el.dataset.offerId, el.dataset.listingId, Number(el.dataset.amount)); };

// ═════════════════════════════════════════════════════════════
// FEATURE #15 — SAVED SEARCHES (top-level v1.1 collection w/ alerts)
// ═════════════════════════════════════════════════════════════
//
// The legacy subcollection-based saveCurrentSearch still exists on the
// filter bar's Save button and continues to work. The new flow opens a
// "Save this search" modal triggered from the search overlay's top-
// right button. It writes to /savedSearches with a name + notify flag.
function openSaveSearchName() {
  if (!window.CURRENT_USER) { showToast('Sign in to save a search.'); return; }
  const q = (document.getElementById('searchInput') || {}).value || '';
  const f = window.__filter || {};
  // Suggest a sensible default name from active filters.
  const parts = [];
  if (f.cat && f.cat !== 'all') parts.push(String(f.cat));
  if (q) parts.push('"' + String(q).slice(0, 40) + '"');
  if (f.min != null) parts.push('over $' + f.min);
  if (f.max != null) parts.push('under $' + f.max);
  const def = parts.length ? parts.join(' · ') : 'My search';
  const inp = document.getElementById('saveSearchNameInput');
  if (inp) inp.value = def;
  const chk = document.getElementById('saveSearchNotifyInput');
  if (chk) chk.checked = true;
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  document.getElementById('saveSearchNameBackdrop').classList.add('open');
}

async function confirmSaveSearch() {
  if (!window.CURRENT_USER) return;
  const name = (document.getElementById('saveSearchNameInput').value || '').trim().slice(0, 80);
  if (!name) { showToast('Add a short name.'); return; }
  const notify = !!document.getElementById('saveSearchNotifyInput').checked;
  const f = window.__filter || {};
  const q = (document.getElementById('searchInput') || {}).value || '';
  // Build the query map per Firestore rules: { category, brand, priceMin, priceMax, condition }
  const queryMap = {};
  if (f.cat && f.cat !== 'all') queryMap.category = String(f.cat).slice(0, 40);
  if (q && q.trim())            queryMap.brand    = String(q).trim().slice(0, 60);
  if (f.min != null && Number.isFinite(Number(f.min))) queryMap.priceMin = Number(f.min);
  if (f.max != null && Number.isFinite(Number(f.max))) queryMap.priceMax = Number(f.max);
  if (f.conditions && f.conditions.size) {
    const first = Array.from(f.conditions)[0];
    if (first) queryMap.condition = String(first).slice(0, 40);
  }
  try {
    const { getFirestore, collection, addDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await addDoc(collection(db, 'savedSearches'), {
      userId: window.CURRENT_USER.uid,
      name,
      query: queryMap,
      notifyOnNew: notify,
      createdAt: serverTimestamp(),
    });
    document.getElementById('saveSearchNameBackdrop').classList.remove('open');
    showToast(notify ? "Saved. We'll alert you when new listings match." : 'Saved.', 'success');
  } catch (e) {
    console.error('confirmSaveSearch failed:', e);
    showToast('Could not save search.');
  }
}
window.openSaveSearchName = openSaveSearchName;
window.confirmSaveSearch = confirmSaveSearch;

// Override the existing user-menu Saved Searches handler to read from
// the new top-level collection AND merge any legacy subcollection rows.
async function openSavedSearchesV2() {
  if (!window.CURRENT_USER) { showToast('Sign in to view saved searches.'); return; }
  // r186: reclaim #savedSearchesBody if the Activity hub adopted it.
  if (window.__activityRestore) window.__activityRestore();
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  const sb = document.getElementById('savedSearchesBackdrop');
  if (!sb) return;
  sb.classList.add('open');
  await loadSavedSearchesList();
}

// r186: render half of openSavedSearchesV2 — targets #savedSearchesBody by
// id wherever it lives. Also the refresh path after notify-toggle/delete,
// so refreshes no longer force the standalone modal open over Activity.
async function loadSavedSearchesList() {
  const body = document.getElementById('savedSearchesBody');
  body.innerHTML = '<div class="profile-loading" aria-busy="true"><div class="sk sk-line long"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div>';
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    let items = [];
    try {
      const snap = await getDocs(query(
        collection(db, 'savedSearches'),
        where('userId', '==', window.CURRENT_USER.uid),
        orderBy('createdAt', 'desc'),
        limit(50),
      ));
      items = snap.docs.map(d => ({ id: d.id, _src: 'top', ...d.data() }));
    } catch (_e) {
      const snap = await getDocs(query(
        collection(db, 'savedSearches'),
        where('userId', '==', window.CURRENT_USER.uid),
        limit(50),
      ));
      items = snap.docs.map(d => ({ id: d.id, _src: 'top', ...d.data() }));
    }
    // Also pull legacy subcollection (read-only display).
    try {
      const legacy = await getDocs(query(
        collection(db, 'users', window.CURRENT_USER.uid, 'savedSearches'),
        orderBy('createdAt', 'desc'),
        limit(50),
      ));
      legacy.docs.forEach(d => items.push({ id: d.id, _src: 'legacy', ...d.data() }));
    } catch (_e) {}
    if (!items.length) {
      body.innerHTML = '<div class="profile-loading" style="padding:2rem">No saved searches yet. Set your filters on the marketplace and tap <strong>Save Search</strong> &mdash; we\'ll email you when new matches land.</div>';
      window.__savedSearches = [];
      return;
    }
    body.innerHTML = items.map(s => {
      const desc = (() => {
        if (s._src === 'top') {
          const q = s.query || {};
          const bits = [];
          if (q.category) bits.push('cat: ' + q.category);
          if (q.brand)    bits.push('"' + q.brand + '"');
          if (q.priceMin != null) bits.push('min $' + q.priceMin);
          if (q.priceMax != null) bits.push('max $' + q.priceMax);
          if (q.condition) bits.push(q.condition);
          return bits.join(' · ');
        }
        return [
          s.cat && s.cat !== 'all' ? 'cat: ' + s.cat : null,
          s.min != null ? 'min $' + s.min : null,
          s.max != null ? 'max $' + s.max : null,
          s.query ? '"' + s.query + '"' : null,
          (s.conditions||[]).length ? s.conditions.join(', ') : null,
        ].filter(Boolean).join(' · ');
      })();
      const id = window.safeAttr(window.safeId(s.id));
      const src = window.safeAttr(s._src);
      const notifyToggle = s._src === 'top'
        ? `<button class="filter-clear" data-action="toggle-saved-search-notify" data-search-id="${id}" title="Toggle alerts">Alerts: ${s.notifyOnNew ? 'On' : 'Off'}</button>`
        : '';
      return `<div class="ss-row">
        <div><strong>${window.safeText(s.name || desc || 'Any listing')}</strong>${s.name && desc ? `<div style="font-size:11px;color:var(--gray-500)">${window.safeText(desc)}</div>` : ''}</div>
        ${notifyToggle}
        <button class="filter-clear" data-action="apply-saved-search" data-search-id="${id}" data-search-src="${src}">Apply</button>
        <button class="filter-clear" data-action="delete-saved-search" data-search-id="${id}" data-search-src="${src}">Delete</button>
      </div>`;
    }).join('');
    window.__savedSearches = items;
  } catch (e) {
    console.error('openSavedSearchesV2 failed:', e);
    body.innerHTML = '<div class="profile-loading">Could not load saved searches.</div>';
  }
}
// Re-bind the action map to the v2 implementation.
window.openSavedSearches = openSavedSearchesV2;

async function toggleSavedSearchNotify(id) {
  if (!window.CURRENT_USER) return;
  const s = (window.__savedSearches || []).find(x => x.id === id && x._src === 'top');
  if (!s) return;
  try {
    const { getFirestore, doc, updateDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await updateDoc(doc(db, 'savedSearches', id), {
      notifyOnNew: !s.notifyOnNew,
      updatedAt: serverTimestamp(),
    });
    loadSavedSearchesList(); // r186: refresh in place (works inside Activity too)
  } catch (e) {
    console.error('toggleSavedSearchNotify failed:', e);
    showToast('Could not update alert.');
  }
}
window.toggleSavedSearchNotify = toggleSavedSearchNotify;

// Apply / delete need to handle both legacy + top-level docs.
async function applySavedSearchV2(id, src) {
  const s = (window.__savedSearches || []).find(x => x.id === id && (!src || x._src === src));
  if (!s) return;
  let cat = 'all', sort = 'newest', min = null, max = null, conditions = [], q = '';
  if (s._src === 'top') {
    const q2 = s.query || {};
    cat = q2.category || 'all';
    if (q2.priceMin != null) min = Number(q2.priceMin);
    if (q2.priceMax != null) max = Number(q2.priceMax);
    if (q2.condition) conditions = [q2.condition];
    q = q2.brand || '';
  } else {
    cat = s.cat || 'all';
    sort = s.sort || 'newest';
    min = s.min != null ? Number(s.min) : null;
    max = s.max != null ? Number(s.max) : null;
    conditions = Array.isArray(s.conditions) ? s.conditions : [];
    q = s.query || '';
  }
  window.__filter = { cat, sort, min, max, conditions: new Set(conditions) };
  const sm = document.getElementById('sortMode'); if (sm) sm.value = sort;
  const mn = document.getElementById('filterMin'); if (mn) mn.value = min == null ? '' : min;
  const mx = document.getElementById('filterMax'); if (mx) mx.value = max == null ? '' : max;
  document.querySelectorAll('#filterCondition .condition-pill').forEach(b => {
    b.classList.toggle('active', window.__filter.conditions.has(b.dataset.cond));
  });
  document.getElementById('savedSearchesBackdrop').classList.remove('open');
  // Open the search overlay with the query pre-filled.
  const si = document.getElementById('searchInput');
  if (si && q) { si.value = q; if (typeof filterSearch === 'function') filterSearch(q); }
  if (typeof buildProducts === 'function') buildProducts();
  showToast('Search applied.');
}
window.applySavedSearch = applySavedSearchV2;

async function deleteSavedSearchV2(id, src) {
  if (!window.CURRENT_USER) return;
  try {
    const { getFirestore, doc, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    if (src === 'legacy') {
      await deleteDoc(doc(db, 'users', window.CURRENT_USER.uid, 'savedSearches', id));
    } else {
      await deleteDoc(doc(db, 'savedSearches', id));
    }
    loadSavedSearchesList(); // r186: refresh in place (works inside Activity too)
  } catch (e) {
    console.error('deleteSavedSearchV2 failed:', e);
    showToast('Could not delete saved search.');
  }
}
window.deleteSavedSearch = deleteSavedSearchV2;

// ═════════════════════════════════════════════════════════════
// FEATURE #16 — WATCHLIST PRICE-DROP NOTIFICATIONS
// ═════════════════════════════════════════════════════════════
//
// Wraps the existing openWatchlist to add price-drop badges + banner
// (Feature #16). The base toggleWatch above already writes
// `priceWhenAdded` on add so we have a comparison baseline here.
async function openWatchlistWithDropBadges() {
  // openWatchlistBase, NOT `openWatchlist`: in a classic script the
  // top-level declaration IS the window binding, so once
  // `window.openWatchlist = openWatchlistWithDropBadges` runs below, a
  // bare `openWatchlist()` here resolves to THIS wrapper → infinite
  // recursion → RangeError on every Likes tap. Pre-existing on r185
  // prod (Feature #16 era); first surfaced by the r186 on-device error
  // reporter, 2026-08-04.
  await openWatchlistBase();
  if (!window.CURRENT_USER) return;
  try {
    const watch = await loadWatchlist();
    const ids = Object.keys(watch);
    if (!ids.length) return;
    const results = document.getElementById('searchResults');
    if (!results) return;
    let droppedCount = 0;
    const rows = results.querySelectorAll('.search-result-item');
    rows.forEach(row => {
      const pid = row.dataset.productId;
      if (!pid) return;
      const w = watch[pid];
      if (!w || w.priceWhenAdded == null) return;
      const product = (window.PRODUCTS || []).find(p => String(p.id) === String(pid));
      if (!product) return;
      const oldPrice = Number(w.priceWhenAdded);
      const newPrice = Number(product.ask || 0);
      if (oldPrice > 0 && newPrice > 0 && newPrice < oldPrice) {
        droppedCount++;
        const pct = Math.round((1 - newPrice / oldPrice) * 100);
        row.classList.add('price-drop-item');
        const nameCell = row.querySelector('.search-res-name');
        if (nameCell && !nameCell.querySelector('.price-drop-badge')) {
          const b = document.createElement('span');
          b.className = 'price-drop-badge';
          b.textContent = `-${pct}% off (was $${oldPrice.toLocaleString()})`;
          nameCell.appendChild(b);
        }
      }
    });
    if (droppedCount > 0 && !document.getElementById('priceDropBanner')) {
      const banner = document.createElement('div');
      banner.id = 'priceDropBanner';
      banner.className = 'price-drop-banner';
      banner.textContent = `${droppedCount} item${droppedCount === 1 ? '' : 's'} dropped in price recently`;
      results.parentNode && results.parentNode.insertBefore(banner, results);
    }
  } catch (e) {
    console.warn('Price-drop hydrate failed:', e);
  }
}
window.openWatchlist = openWatchlistWithDropBadges;

// ─────────────────────────────────────────────────────────────
// LIGHTBOX
// ─────────────────────────────────────────────────────────────
let lightboxState = { urls: [], i: 0 };
function openLightbox(urls, startIndex = 0) {
  if (!urls || !urls.length) return;
  lightboxState = { urls: urls.slice(), i: Math.max(0, Math.min(startIndex, urls.length - 1)) };
  document.getElementById('lightboxImg').src = lightboxState.urls[lightboxState.i];
  document.getElementById('lightbox').classList.add('open');
  (document.getElementById('app-scroll')||document.body).style.overflowY = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  (document.getElementById('app-scroll')||document.body).style.overflowY = '';
}
function stepLightbox(d) {
  if (!lightboxState.urls.length) return;
  lightboxState.i = (lightboxState.i + d + lightboxState.urls.length) % lightboxState.urls.length;
  document.getElementById('lightboxImg').src = lightboxState.urls[lightboxState.i];
}
window.openLightbox = openLightbox;

function showProductSkeleton(n = 8) {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  let html = '';
  for (let i = 0; i < n; i++) {
    html += `<div class="sk-card"><div class="sk sk-img"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div><div class="sk sk-line short"></div></div>`;
  }
  grid.innerHTML = html;
}

function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

async function updateLiveStats() {
  const setListings = document.getElementById('heroStatListings');
  const setVolume   = document.getElementById('heroStatVolume');
  if (!setListings || !setVolume) return;
  // Listings count = real items in the products array, capped at 0.
  const realCount = (window.PRODUCTS || []).filter(p => typeof p.id === 'string').length;
  setListings.textContent = realCount > 0 ? fmtCount(realCount) : '0';

  // Volume = denormalized running total in globalStats/all, bumped
  // atomically by the order-success webhook (see handlePaymentSucceeded
  // in functions/index.js). One getDoc() per homepage hit replaces
  // the previous 500-doc priceHistory scan.
  //
  // First-time deploy: the doc doesn't exist until the admin runs the
  // backfillGlobalStats callable once. While missing, we render '$0'
  // so the hero pill still has a value.
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDoc(doc(db, 'globalStats', 'all'));
    let totalCents = 0;
    if (snap.exists()) {
      const data = snap.data() || {};
      totalCents = Number(data.totalGmvCents || 0);
    }
    const dollars = totalCents / 100;
    setVolume.textContent = dollars >= 1000 ? '$' + fmtCount(dollars) : '$' + dollars.toLocaleString();
  } catch {
    setVolume.textContent = '$0';
  }
}
window.updateLiveStats = updateLiveStats;

function showToast(msg, variant) {
  const t = document.createElement('div');
  // S6 fix: map the variant to a colour class so ERROR states render red (not
  // success-green). success→green, error→red, info→neutral, default→base green.
  const cls = variant === 'success' ? ' success'
    : variant === 'error' ? ' error'
    : variant === 'info' ? ' info' : '';
  t.className = 'toast' + cls;
  // Accessibility: announce to screen readers. Errors are assertive (interrupt);
  // everything else is polite.
  t.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  t.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
  t.setAttribute('aria-atomic', 'true');
  t.textContent = msg;
  document.body.appendChild(t);
  // Slide-out before remove so the toast doesn't pop off mid-frame.
  setTimeout(() => { t.classList.add('toast-out'); }, 3250);
  setTimeout(() => t.remove(), 3550);
}
window.showToast = showToast;

// ─── Content-violation detection ────────────────────────────────
// Server-side content filter (see functions/) rejects writes with
// HttpsError("invalid-argument", "Content violation", { error: "content_violation", category, suggestion }).
// On Firestore-rule rejection paths, the same shape surfaces as a
// permission-denied with an embedded "Content violation" message.
// We never echo the matched word or the category — those are audit
// detail only.
function isContentViolationError(e) {
  if (!e) return false;
  const details = e.details || {};
  if (details.error === 'content_violation') return true;
  const msg = (e.message || '') + '';
  if (msg.includes('Content violation')) return true;
  if (msg.includes('content_violation')) return true;
  return false;
}
function showContentViolationToast(msg) {
  showToast(msg || "That has language we don't allow on TeeBox. Edit it and try again.");
}
window.isContentViolationError = isContentViolationError;
window.showContentViolationToast = showContentViolationToast;

document.addEventListener('keydown',e=>{
  const lb = document.getElementById('lightbox');
  const lbOpen = lb && lb.classList.contains('open');
  if (lbOpen) {
    if (e.key === 'Escape')     return closeLightbox();
    if (e.key === 'ArrowLeft')  return stepLightbox(-1);
    if (e.key === 'ArrowRight') return stepLightbox(1);
  }
  // Listing detail modal: arrow keys step the IG-style photo swiper when
  // the lightbox isn't intercepting and the user isn't typing into a field.
  const detailOpen = document.getElementById('detailBackdrop')?.classList.contains('open');
  if (detailOpen && !lbOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const tag = (e.target && e.target.tagName) || '';
    const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
    if (!editable) {
      const gallery = document.getElementById('detailGallery');
      const swiper = gallery && gallery._igSwiper;
      if (swiper && typeof swiper._igStep === 'function') {
        e.preventDefault();
        swiper._igStep(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
    }
  }
  if(e.key==='Escape') {
    // Auth screen is locked: Esc must NOT dismiss it. The only non-sign-in
    // escape is the explicit "Continue as guest" button inside the form.
    // Swallow Esc when the auth screen is open so it doesn't bubble up
    // and close anything underneath either.
    const _authScreenEl = document.getElementById('authScreen');
    if (_authScreenEl && _authScreenEl.classList.contains('open')) {
      e.preventDefault();
      return;
    }
    // Guest gate prompt still respects Esc (it's a smaller nudge modal,
    // not the full sign-in gate).
    const _signInPrompt = document.getElementById('signInPromptBackdrop');
    if (_signInPrompt && _signInPrompt.classList.contains('open')) {
      if (typeof window.dismissSignInPrompt === 'function') window.dismissSignInPrompt();
      return;
    }
    const so = document.getElementById('searchOverlay');
    if (so) so.classList.remove('open');
    closeModalDirect(); closeSellModalDirect(); closeDetailModalDirect();
    const vb = document.getElementById('verifyBackdrop');
    if (vb) vb.classList.remove('open');
    document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
    closeLightbox();
    // Notifications panel (Feature: notifications-v1)
    if (typeof closeNotifications === 'function') closeNotifications();
    // Inbox / chat / bingo guess (Esc was previously a no-op for these).
    if (typeof closeChat === 'function') closeChat();
    if (typeof closeInbox === 'function') closeInbox();
    // Bingo guess modal close — its function is scoped inside an IIFE,
    // so trigger via the cancel-guess action that's already on the
    // backdrop. The handler hides the backdrop + restores body scroll.
    const bg = document.getElementById('bingoGuessBackdrop');
    if (bg && bg.classList.contains('open')) {
      const fn = window.__actions && window.__actions['bingo-cancel-guess'];
      if (typeof fn === 'function') { try { fn(); } catch (_) {} }
    }
  }
});

buildTicker(); buildTrending(); buildProducts(); buildDrops();

// ─────────────────────────────────────────────────────────────
// PWA bootstrapping: service worker, install prompt, offline
// indicator, mobile bottom-nav, launch-shortcut handler
// ─────────────────────────────────────────────────────────────

// 1. Always opt the body into the bottom-nav class. CSS handles the
//    breakpoint — so it's a no-op on desktop but flips the layout
//    cleanly on phones/tablets.
document.body.classList.add('has-bottom-nav');

// ── Scroll-in reveal observer ────────────────────────────────────────
//   Any element with class="reveal" fades + slides into place when it
//   enters the viewport. Uses native IntersectionObserver — falls back
//   to instantly-visible if the API isn't available (older Safari).
(function () {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  // Also wire up nodes added later (product cards inserted by buildProducts).
  const mo = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      m.addedNodes && m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.classList && n.classList.contains('reveal')) io.observe(n);
        n.querySelectorAll && n.querySelectorAll('.reveal').forEach(el => io.observe(el));
      });
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();

// ── Ripple effect on primary buttons ─────────────────────────────────
//   Click any element matching the selector → set CSS vars to the click
//   coordinates → toggle .rippling so the ::after pseudo expands from
//   the press point. Tasteful, ~60ms perceived feedback.
(function () {
  const RIPPLE_SEL = '.btn-buy-now, .btn-make-offer, .auth-btn, .nav-bingo-cta, .desc-ai-btn, .install-btn, .bingo-share-btn';
  document.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest(RIPPLE_SEL);
    if (!t) return;
    t.classList.add('ripple-host');
    const rect = t.getBoundingClientRect();
    t.style.setProperty('--ripple-x', (ev.clientX - rect.left) + 'px');
    t.style.setProperty('--ripple-y', (ev.clientY - rect.top) + 'px');
    // Toggle .rippling off then on so back-to-back clicks restart the animation.
    t.classList.remove('rippling');
    void t.offsetWidth; // reflow
    t.classList.add('rippling');
    setTimeout(() => t.classList.remove('rippling'), 600);
  }, { passive: true });
})();

// 2. Register the service worker. When a new SW takes control we reload
//    once so the user sees the latest UI without having to manually refresh.
if ('serviceWorker' in navigator) {
  if (window.IS_NATIVE) {
    // NATIVE APP: never run the app-shell service worker. The web bundle is
    // already local, so the SW adds nothing but staleness — a cached shell
    // from a PRIOR build survives app updates in WKWebView and masks the new
    // build (the "I reinstalled and nothing changed" bug). Unregister any SW
    // a previous build left behind and drop its caches so the freshly-bundled
    // files always win.
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => { try { r.unregister(); } catch (_) {} }))
      .catch(() => {});
    if (window.caches && caches.keys) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
  } else {
    let __swReloading = false;
    // r158: only reload on a genuine SW UPDATE (old controller → new). On a
    // FIRST install there is no stale bundle to refresh — and the reload was
    // silently killing every first-visit deep link: the ?listing= router
    // strips the param at ~1.5s, the fresh SW claims the page at ~2s,
    // controllerchange reloaded the now-bare '/', and the shared listing
    // never opened. First-time visitors are exactly who shared links reach.
    const __swHadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!__swHadController) return; // first install — nothing stale, no reload
      if (__swReloading) return;
      __swReloading = true;
      window.location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then((reg) => {
          // If a new SW is waiting, ask it to activate immediately so the
          // user gets the latest UI on the next visit.
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          reg.addEventListener('updatefound', () => {
            const newSw = reg.installing;
            if (!newSw) return;
            newSw.addEventListener('statechange', () => {
              if (newSw.state === 'installed' && navigator.serviceWorker.controller) {
                newSw.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          });
          // Poll for an update every 5 minutes — covers users who keep
          // a tab open all day.
          setInterval(() => { reg.update().catch(() => {}); }, 5 * 60 * 1000);
        })
        .catch((err) => console.warn('SW register failed', err));
    });
  }
}

// ── AMBIENT OVERLAY QUEUE (r194 — audit W1) ──────────────────────────
// ONE rule for every prompt the user didn't ask for (marketing-consent
// banner, install banner, seller tour, and any future nudge):
//   1. At most ONE ambient prompt per page-load. Losers forfeit to a
//      future session — no sequential parade after a dismissal.
//   2. Ambient never renders while a task surface is open (any modal,
//      backdrop, auth screen, dashboard), and YIELDS — hide + forfeit —
//      the moment one opens. Nothing ever interrupts the sell form.
//   3. Priority when several want the one slot: contextual > passive >
//      interruptive — tour(3) > install(2) > consent(1).
// The verify-email banner stays OUTSIDE the queue on purpose: it is
// functional, and error handlers surface it contextually (r188).
window.__ambient = (function () {
  const BUSY_IDS = ['searchOverlay','modalBackdrop','sellModalBackdrop','detailBackdrop','checkoutBackdrop','verifyBackdrop','chatBackdrop','inboxBackdrop','profileBackdrop','aboutBackdrop','guidelinesBackdrop','termsBackdrop','privacyBackdrop','reviewBackdrop','savedSearchesBackdrop','ordersBackdrop','disputeBackdrop','lightbox','bingoScreen','bingoGuessBackdrop','activityBackdrop','journalBackdrop','stripeRequiredBackdrop','filterSheetBackdrop','shopDashboard','notifPanel'];
  const PRIORITY = { tour: 3, install: 2, consent: 1 };
  let slotUsed = false;
  let active = null;
  let pending = [];
  let guardTimer = null;
  let waitTimer = null;
  function busyFor(req) {
    // Auth screen visible (boot, signed-out) counts as busy.
    const auth = document.getElementById('authScreen');
    if (auth && !auth.classList.contains('hidden')) return true;
    for (const id of BUSY_IDS) {
      if (req && req.surface === id) continue; // its own surface is fine
      const el = document.getElementById(id);
      if (el && el.classList.contains('open')) return true;
    }
    return false;
  }
  function surfaceGone(req) {
    if (!req || !req.surface) return false;
    const el = document.getElementById(req.surface);
    return !el || !el.classList.contains('open');
  }
  function tryShow() {
    if (slotUsed || active || !pending.length) return;
    pending.sort((a, b) => (PRIORITY[b.name] || 0) - (PRIORITY[a.name] || 0));
    const top = pending[0];
    if (busyFor(top)) {
      // Not visible yet → WAIT for idle rather than forfeit.
      clearTimeout(waitTimer);
      waitTimer = setTimeout(tryShow, 1500);
      return;
    }
    pending = []; // one per page-load: everyone else forfeits now
    slotUsed = true;
    active = top;
    try { top.show(); } catch (_e) { active = null; return; }
    guardTimer = setInterval(() => {
      if (!active) { clearInterval(guardTimer); return; }
      // A task surface opened, or the overlay's own surface closed → yield.
      if (busyFor(active) || surfaceGone(active)) {
        try { active.hide(); } catch (_e) {}
        active = null;
        clearInterval(guardTimer);
      }
    }, 400);
  }
  return {
    request(name, opts) {
      pending.push({ name, show: opts.show, hide: opts.hide, surface: opts.surface || null });
      clearTimeout(waitTimer);
      waitTimer = setTimeout(tryShow, 250);
    },
    done(name) { // overlay closed naturally (user action / completion)
      if (active && active.name === name) {
        active = null;
        if (guardTimer) clearInterval(guardTimer);
      }
    },
  };
})();

// 3. Install banner: capture beforeinstallprompt and surface our own
//    button. Hide if already installed (display-mode: standalone) OR
//    the user already dismissed in this session.
let __deferredPrompt = null;
const __installBanner  = document.getElementById('installBanner');
const __installBtn     = document.getElementById('installBtn');
const __installDismiss = document.getElementById('installDismiss');

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true; // iOS
}

// Use localStorage so dismissal persists across sessions (sessionStorage cleared
// on tab close, so the banner came back every visit — annoying when user already
// said no). Re-prompt only if user hasn't seen it for 30 days.
function __installDismissedRecently() {
  try {
    const t = parseInt(localStorage.getItem('install-dismissed-at') || '0', 10);
    if (!t) return false;
    return (Date.now() - t) < 30 * 24 * 60 * 60 * 1000;
  } catch { return false; }
}
function __markInstallDismissed() {
  try { localStorage.setItem('install-dismissed-at', String(Date.now())); } catch {}
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  __deferredPrompt = e;
  if (isStandalone() || __installDismissedRecently()) return;
  // r194 (audit W1+W2): through the ambient queue — idle browse only —
  // and CONTAINED: it leaves for the session once the user starts
  // scrolling the feed (no 30-day mark; it may try again next visit).
  window.__ambient.request('install', {
    show: () => {
      if (!__installBanner) return;
      __installBanner.hidden = false;
      const sc = document.getElementById('app-scroll') || window;
      const onScroll = () => {
        const y = (sc === window) ? window.scrollY : sc.scrollTop;
        if (y > 500) {
          sc.removeEventListener('scroll', onScroll);
          __installBanner.hidden = true;
          window.__ambient.done('install');
        }
      };
      sc.addEventListener('scroll', onScroll, { passive: true });
    },
    hide: () => { if (__installBanner) __installBanner.hidden = true; },
  });
});

if (__installBtn) __installBtn.addEventListener('click', async () => {
  if (!__deferredPrompt) return;
  __installBanner.hidden = true;
  __deferredPrompt.prompt();
  const choice = await __deferredPrompt.userChoice;
  __deferredPrompt = null;
  if (choice.outcome !== 'accepted') __markInstallDismissed();
});

// Install banner X — bulletproof close. Some users reported the X not
// dismissing on certain browsers; this handler now removes the element
// outright (not just hidden) so nothing can re-show it within the session.
function __closeInstallBanner() {
  if (__installBanner) {
    __installBanner.hidden = true;
    __installBanner.style.display = 'none';
    try { __installBanner.remove(); } catch {}
  }
  __markInstallDismissed();
  try { window.__ambient.done('install'); } catch {}
}
if (__installDismiss) {
  __installDismiss.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    __closeInstallBanner();
  });
  // Also handle pointerdown for trackpads/touch where click can be
  // swallowed by parent listeners on iOS in standalone mode.
  __installDismiss.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
  });
}

window.addEventListener('appinstalled', () => {
  if (__installBanner) __installBanner.hidden = true;
});

// 4. Online / offline banner
const __offlineBanner = document.getElementById('offlineBanner');
function updateOnline() {
  if (!__offlineBanner) return;
  __offlineBanner.hidden = navigator.onLine;
}
window.addEventListener('online',  updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

// 5. Bottom-nav action: Browse → close any open modals + scroll up.
window.__actions = window.__actions || {};
window.__actions['bn-home'] = () => {
  // r186: return any list containers the Activity hub adopted before
  // closing overlays, so Inbox/Orders/Saved-Searches reopen intact.
  if (window.__activityRestore) window.__activityRestore();
  ['searchOverlay','modalBackdrop','sellModalBackdrop','detailBackdrop','checkoutBackdrop','verifyBackdrop','chatBackdrop','inboxBackdrop','profileBackdrop','aboutBackdrop','guidelinesBackdrop','termsBackdrop','privacyBackdrop','reviewBackdrop','savedSearchesBackdrop','ordersBackdrop','disputeBackdrop','lightbox','bingoScreen','bingoGuessBackdrop','activityBackdrop']
    .forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('open'); });
  const fsb = document.getElementById('filterSheetBackdrop');
  if (fsb) fsb.classList.remove('open');
  (document.getElementById('app-scroll')||document.body).style.overflowY = '';
  document.getElementById('shopDashboard').classList.remove('open');
  (document.getElementById('app-scroll')||window).scrollTo({top: 0, behavior: 'smooth'});
  document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === 'home'));
  // Reset top nav active state to Marketplace (mirror of bottom-nav home).
  document.querySelectorAll('#topNavLinks a').forEach(a =>
    a.classList.toggle('active', a.dataset.nav === 'home'));
  // Replay the page-in animation for a soft transition into Home.
  const main = document.querySelector('main');
  if (main) {
    main.classList.remove('page-in');
    void main.offsetWidth;
    main.classList.add('page-in');
  }
};

// Top-nav active-state toggle. When the user clicks any link in the top
// nav, mark only that link active. This works alongside the existing
// data-action handlers (the action still fires — section anchors still
// scroll, modal-openers still open). bn-home above keeps "home" active
// while a modal is open over the marketplace.
document.querySelectorAll('#topNavLinks a').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelectorAll('#topNavLinks a').forEach(a =>
      a.classList.toggle('active', a === link));
  });
});

// Mark whichever bottom-nav tab the user just tapped as active so the
// pill indicator slides to it. Mirrors the bn-home behavior for the
// other tabs whose actions live elsewhere (search, sell, inbox, account).
document.querySelectorAll('.bottom-nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bottom-nav-item').forEach(b =>
      b.classList.toggle('active', b === btn));
  });
});

// ─────────────────────────────────────────────────────────────
// r186: APP SHELL (UI-audit section 1). applyAppShell() is invoked from
// the Capacitor module boot only when isNativePlatform() — none of this
// runs on the website. CSS half lives under `body.is-native` in <style>.
// ─────────────────────────────────────────────────────────────
window.applyAppShell = function applyAppShell() {
  const I = window.ICONS || {};
  // 1) Bottom tabs → Home / Browse / Sell / Activity / Profile. Mutate the
  //    existing buttons (never replace nodes) so the active-pill click
  //    listeners attached above survive.
  try {
    const nav = document.querySelector('.bottom-nav');
    if (nav) {
      const set = (tab, icon, label, opts) => {
        const btn = nav.querySelector('.bottom-nav-item[data-tab="' + tab + '"]');
        if (!btn) return;
        if (opts && opts.action) btn.setAttribute('data-action', opts.action);
        if (opts && opts.newTab) btn.setAttribute('data-tab', opts.newTab);
        btn.innerHTML = (opts && opts.badge)
          ? '<span class="bn-icon" aria-hidden="true">' + icon + '<span class="unread-badge" aria-hidden="true"></span></span>' + label
          : '<span aria-hidden="true">' + icon + '</span>' + label;
      };
      set('home',    I.home,     'Home');
      set('search',  I.search,   'Browse');
      set('inbox',   I.activity, 'Activity', { action: 'open-activity', newTab: 'activity', badge: true });
      set('account', I.user,     'Profile');
    }
  } catch (e) { console.warn('applyAppShell tabs failed:', e); }
  // 2) Pushed full-screen surfaces get a ← back glyph (CSS moves it left).
  //    Centered modals (sell, checkout, orders, dispute, …) keep their ✕.
  try {
    ['.inbox-close', '.dash-close', '#profileBackdrop .modal-close',
     '.detail-header .modal-close', '.chat-close',
     // r336: the profile hub's pages are pushed screens now, not sheets.
     '#ordersBackdrop .modal-close', '#savedSearchesBackdrop .modal-close',
     '#pushPrefsBackdrop .modal-close', '#emailPrefsBackdrop .modal-close',
     '#shippingSettingsBackdrop .modal-close', '#blockedUsersBackdrop .modal-close',
     '#aboutBackdrop .modal-close', '#guidelinesBackdrop .modal-close',
    ].forEach((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return;
      btn.innerHTML = I.arrowLeft || '←';
      btn.classList.add('app-back');
      btn.setAttribute('aria-label', 'Back');
    });
    // Chat: the ✕ lives in the right-side actions cluster — move the node
    // to the head of the chat header so the arrow sits on the left.
    const chatClose = document.querySelector('.chat-close');
    const chatHeader = document.querySelector('.chat-header');
    if (chatClose && chatHeader && chatHeader.firstElementChild !== chatClose) {
      chatHeader.insertBefore(chatClose, chatHeader.firstElementChild);
    }
  } catch (e) { console.warn('applyAppShell back-glyphs failed:', e); }
  // 3) Collapsing header: past ~88px the cat-bar slides away (CSS), the
  //    compact top-bar search icon appears. Hysteresis avoids jitter at
  //    the threshold. #app-scroll is the app's only scroller (r171).
  try {
    const sc = document.getElementById('app-scroll');
    if (sc && !sc.__hdrCollapseWired) {
      sc.__hdrCollapseWired = true;
      let ticking = false;
      sc.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          const y = sc.scrollTop;
          const collapsed = document.body.classList.contains('hdr-collapsed');
          if (!collapsed && y > 88) document.body.classList.add('hdr-collapsed');
          else if (collapsed && y < 24) document.body.classList.remove('hdr-collapsed');
        });
      }, { passive: true });
    }
  } catch (e) { console.warn('applyAppShell collapse failed:', e); }
  // 4) §2 app home: first-launch flag (feature grid shows once, or while
  //    logged out) + Bingo teaser streak line.
  try {
    if (!localStorage.getItem('teebox.app.launched')) {
      document.body.classList.add('app-first-launch');
      localStorage.setItem('teebox.app.launched', '1');
    }
  } catch (_e) { /* storage unavailable → grid stays logged-out-only */ }
  try {
    const sub = document.getElementById('appBingoTeaserSub');
    if (sub) {
      let streak = 0;
      try { streak = Number((JSON.parse(localStorage.getItem('teebox.bingo.streak') || '{}')).count) || 0; } catch (_e) {}
      if (streak >= 2) {
        // r341: icon, not emoji. `streak` is a Number — nothing user-authored
        // reaches this innerHTML.
        sub.innerHTML = 'Today’s puzzle · ' + Number(streak) + '-day streak ' +
          '<span class="app-teaser-flame" aria-hidden="true">' + (I.flame || '') + '</span>';
      }
    }
  } catch (_e) { /* teaser keeps its static copy */ }
  // 5) §3 browse toolbar + filter sheet: adopt the REAL controls so their
  //    parse-time listeners keep working. #sortMode → toolbar slot,
  //    #filterBar → bottom sheet. App-only (this fn never runs on web).
  try {
    const slot = document.getElementById('appSortSlot');
    const sm = document.getElementById('sortMode');
    if (slot && sm && sm.parentElement !== slot) slot.appendChild(sm);
    const sheetBody = document.getElementById('filterSheetBody');
    const fb = document.getElementById('filterBar');
    if (sheetBody && fb && fb.parentElement !== sheetBody) sheetBody.appendChild(fb);
    // Every filter mutation (sheet inputs, saved-search apply, clear, brand
    // links) funnels through buildProducts() — hook it once so the chips +
    // count badge can never go stale. App-only: this fn never runs on web.
    if (!window.__chipsHooked && typeof buildProducts === 'function') {
      window.__chipsHooked = true;
      const __bpOrig = buildProducts;
      buildProducts = function(...args) {
        const r = __bpOrig.apply(this, args);
        try { window.updateAppFilterChips(); } catch (_e) {}
        return r;
      };
    }
    if (window.updateAppFilterChips) window.updateAppFilterChips();
  } catch (e) { console.warn('applyAppShell filters failed:', e); }
  // 6b) Device finding 2026-08-04: the profile hub's NAVIGATION items
  //     (My Shop / My Orders / Likes / Saved Searches) opened their
  //     destination BEHIND the still-open profile (z/DOM-order losers).
  //     Unlike the settings sub-panels (which correctly stack above),
  //     these leave the profile — so close it first. Capture phase runs
  //     before the data-action delegator's bubble listener. Native-only
  //     by construction (this fn never runs on web; web twin logged).
  try {
    if (!window.__hubNavWired) {
      window.__hubNavWired = true;
      const NAV_ACTIONS = ['open-shop-dashboard', 'open-orders', 'open-watchlist', 'open-saved-searches'];
      document.addEventListener('click', (ev) => {
        const t = ev.target && ev.target.closest && ev.target.closest('[data-action]');
        if (!t || !NAV_ACTIONS.includes(t.getAttribute('data-action'))) return;
        const prof = document.getElementById('profileBackdrop');
        if (prof && prof.classList.contains('open')) {
          const close = window.__actions && window.__actions['close-profile'];
          if (typeof close === 'function') { try { close(); } catch (_e) {} }
          else prof.classList.remove('open');
        }
      }, true);
    }
  } catch (e) { console.warn('applyAppShell hub-nav failed:', e); }
  // 6) §6: Chart.js canvas text (revenue chart + detail sparkline) was the
  //    THIRD font on screen (its default Helvetica stack next to Playfair
  //    and DM Sans). App-only by construction — this fn never runs on web,
  //    so web canvases keep their current rendering. Chart.js loads via a
  //    deferred script that executes before this module boot.
  try {
    if (window.Chart && Chart.defaults && Chart.defaults.font) {
      Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";
    }
  } catch (_e) { /* chart font is cosmetic — never block boot */ }
};

// r186 §3: applied-filter chips + count badge, derived from the single
// source of truth (window.__filter). Chip removal re-drives the existing
// control listeners (input event / pill click) — no duplicated state.
window.updateAppFilterChips = function updateAppFilterChips() {
  const wrap = document.getElementById('appFilterChips');
  const badge = document.getElementById('appFilterCount');
  if (!wrap) return;
  const f = window.__filter || {};
  const chips = [];
  if (f.min != null) chips.push({ kind: 'min', label: 'Min $' + f.min });
  if (f.max != null) chips.push({ kind: 'max', label: 'Max $' + f.max });
  (f.conditions ? Array.from(f.conditions) : []).forEach((c) =>
    chips.push({ kind: 'cond', cond: c, label: c === 'New with Tags' ? 'New' : c }));
  wrap.innerHTML = chips.map((c) =>
    '<button class="af-chip" type="button" data-action="remove-filter-chip" data-kind="' + c.kind + '"' +
    (c.cond ? ' data-cond="' + window.safeAttr(c.cond) + '"' : '') +
    ' aria-label="Remove filter ' + window.safeAttr(c.label) + '">' +
    window.safeText(c.label) + '<span class="af-x" aria-hidden="true">×</span></button>').join('');
  wrap.hidden = chips.length === 0;
  if (badge) { badge.textContent = String(chips.length); badge.hidden = chips.length === 0; }
};
window.__actions['open-filter-sheet'] = function() {
  const b = document.getElementById('filterSheetBackdrop');
  if (!b) return;
  b.classList.add('open');
  (document.getElementById('app-scroll') || document.body).style.overflowY = 'hidden';
};
window.__actions['close-filter-sheet'] = function() {
  const b = document.getElementById('filterSheetBackdrop');
  if (b) b.classList.remove('open');
  const stillBlocking = document.querySelector('#shopDashboard.open, #chatBackdrop.open, #inboxBackdrop.open, #activityBackdrop.open, .modal-backdrop.open, .detail-backdrop.open, .verify-backdrop.open, .info-backdrop.open, #notifPanel.open');
  if (!stillBlocking) (document.getElementById('app-scroll') || document.body).style.overflowY = '';
  if (window.updateAppFilterChips) window.updateAppFilterChips();
};
window.__actions['remove-filter-chip'] = function(el) {
  if (!el || !el.dataset) return;
  const kind = el.dataset.kind;
  if (kind === 'min' || kind === 'max') {
    const input = document.getElementById(kind === 'min' ? 'filterMin' : 'filterMax');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input')); }
  } else if (kind === 'cond') {
    const pills = document.querySelectorAll('#filterCondition .condition-pill');
    for (const pill of pills) { if (pill.dataset.cond === el.dataset.cond) { pill.click(); break; } }
  }
  if (window.updateAppFilterChips) window.updateAppFilterChips();
};

// Drawer identity block (app only — the block is display:none on web).
window.syncDrawerIdentity = function syncDrawerIdentity() {
  const u = window.CURRENT_USER;
  const nameEl = document.getElementById('drawerIdentityName');
  const avEl = document.getElementById('drawerIdentityAvatar');
  if (!u || !nameEl || !avEl) return;
  const name = u.displayName || (u.email ? u.email.split('@')[0] : 'Golfer');
  nameEl.textContent = name;
  // Photo priority (device finding 2026-08-04 — email/password accounts
  // have no Auth photoURL, but the TeeBox profile photo is preloaded at
  // sign-in into CURRENT_PROFILE_AVATAR from profiles/{uid}.avatarUrl):
  // Auth photo → profile avatar → monogram initial.
  const photo = window.safeImgUrl
    ? (window.safeImgUrl(u.photoURL) || window.safeImgUrl(window.CURRENT_PROFILE_AVATAR))
    : (u.photoURL || window.CURRENT_PROFILE_AVATAR);
  if (photo) avEl.innerHTML = '<img src="' + window.safeAttr(photo) + '" alt="" />';
  else avEl.textContent = (name.trim()[0] || 'G').toUpperCase();
};
window.__actions['drawer-view-shop'] = function() {
  const f = window.__actions;
  if (f['close-mobile-nav']) f['close-mobile-nav']();
  if (f['open-profile-self']) f['open-profile-self']();
};

// ─────────────────────────────────────────────────────────────
// r186: ACTIVITY HUB. Segments adopt the existing list containers so the
// existing renderers (loadOrdersList / loadInbox / loadSavedSearchesList)
// and their refresh paths keep targeting the same nodes by id. Adopted
// nodes are returned home by __activityRestore() before anything else
// opens the donor overlays (openInbox/openOrders/openSavedSearchesV2 and
// bn-home all call it first).
// ─────────────────────────────────────────────────────────────
window.__actNodesMoved = {};
window.__activityRestore = function __activityRestore() {
  const moved = window.__actNodesMoved || {};
  Object.keys(moved).forEach((id) => {
    const node = document.getElementById(id);
    const home = moved[id];
    if (node && home && home.parent) {
      if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(node, home.next);
      else home.parent.appendChild(node);
    }
  });
  window.__actNodesMoved = {};
};
function __activityAdopt(pane, id) {
  const node = document.getElementById(id);
  if (!node || node.parentNode === pane) return;
  window.__actNodesMoved[id] = { parent: node.parentNode, next: node.nextSibling };
  pane.appendChild(node);
}
async function activityShow(seg) {
  const paneId = { orders: 'activityPaneOrders', messages: 'activityPaneMessages',
                   likes: 'activityPaneLikes', searches: 'activityPaneSearches' }[seg];
  if (!paneId) return;
  window.__activitySeg = seg;
  document.querySelectorAll('.activity-seg').forEach((b) => {
    const on = b.dataset.seg === seg;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.activity-pane').forEach((p) => p.classList.toggle('active', p.id === paneId));
  const pane = document.getElementById(paneId);
  window.__activityRestore();
  try {
    if (seg === 'orders')        { __activityAdopt(pane, 'ordersBody');        await loadOrdersList(); }
    else if (seg === 'messages') { __activityAdopt(pane, 'inboxBody');         await loadInbox(); }
    else if (seg === 'likes')    { await renderWatchlistInto(document.getElementById('activityLikesBody'), 'bn-home'); }
    else if (seg === 'searches') { __activityAdopt(pane, 'savedSearchesBody'); await loadSavedSearchesList(); }
  } catch (e) { console.warn('activityShow failed:', e); }
}
window.__actions['open-activity'] = function() {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to view your activity', () => window.__actions['open-activity']())) return;
  } else if (!window.CURRENT_USER) { showToast('Sign in to view your activity.'); return; }
  const b = document.getElementById('activityBackdrop');
  if (!b) return;
  b.classList.add('open');
  (document.getElementById('app-scroll') || document.body).style.overflowY = 'hidden';
  activityShow(window.__activitySeg || 'orders');
};
window.__actions['close-activity'] = function() {
  window.__activityRestore();
  const b = document.getElementById('activityBackdrop');
  if (b) b.classList.remove('open');
  const stillBlocking = document.querySelector('#shopDashboard.open, #chatBackdrop.open, #inboxBackdrop.open, .modal-backdrop.open, .detail-backdrop.open, .verify-backdrop.open, .info-backdrop.open, #notifPanel.open');
  if (!stillBlocking) (document.getElementById('app-scroll') || document.body).style.overflowY = '';
};
window.__actions['activity-seg'] = function(el) {
  if (el && el.dataset && el.dataset.seg) activityShow(el.dataset.seg);
};



// ═══ Phase 2 — provider sheet, account linking, connected methods ═════════
// (2026-10-26) One person = one TeeBox account. Server rules live in
// functions/lib/accountLinking.js; this is the client half.
const TB_PROVIDER_LABEL = { 'password': 'email & password', 'google.com': 'Google', 'apple.com': 'Apple', 'facebook.com': 'Facebook' };
function tbProviderLabel(id) { return TB_PROVIDER_LABEL[id] || id; }
function tbIsNative() { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
function tbFlag(name) { return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[name] === true); }

// ── Provider sheet ───────────────────────────────────────────────────────
window.__authSheetMode = 'signup';
window.openAuthSheet = function openAuthSheet(mode, reason) {
  window.__authSheetMode = mode === 'login' ? 'login' : 'signup';
  if (reason) window.__pendingAuthReason = reason;
  const bd = document.getElementById('authSheetBackdrop'); if (!bd) return;
  const t = document.getElementById('authSheetTitle'); if (t) t.textContent = window.__authSheetMode === 'login' ? 'Log in to TeeBox' : 'Sign up for TeeBox';
  const err = document.getElementById('authSheetError'); if (err) err.textContent = '';
  const native = tbIsNative();
  // Apple: native always; web only once the Services ID is configured (flag).
  const apple = document.getElementById('authSheetApple'); if (apple) apple.hidden = !(native || tbFlag('appleWeb'));
  // Google: web always; native only once the GoogleSignIn pod ships (flag).
  const google = document.getElementById('authSheetGoogle'); if (google) google.hidden = native && !tbFlag('nativeGoogle');
  // Facebook: behind a flag that defaults OFF (needs the Meta app + Firebase provider).
  const fb = document.getElementById('authSheetFacebook'); if (fb) fb.hidden = !(tbFlag('facebookLogin') && (!native || tbFlag('nativeFacebook')));
  const div = document.getElementById('authSheetDivider'); if (div) div.hidden = !!(apple && apple.hidden);
  bd.classList.add('open');
  try { window.posthog && window.posthog.capture('auth_sheet_open', { mode: window.__authSheetMode, native }); } catch (_e) {}
};
window.closeAuthSheet = function closeAuthSheet() { const bd = document.getElementById('authSheetBackdrop'); if (bd) bd.classList.remove('open'); };
window.__actions['open-auth-sheet-signup'] = () => window.openAuthSheet('signup');
window.__actions['open-auth-sheet-login'] = () => window.openAuthSheet('login');
window.__actions['close-auth-sheet'] = () => window.closeAuthSheet();
window.__actions['sheet-apple'] = (btn) => { window.__actions['sign-in-apple'](btn); };
window.__actions['sheet-google'] = (btn) => { window.__actions['sign-in-google'](btn); };
window.__actions['sheet-facebook'] = (btn) => { window.signInWithFacebook && window.signInWithFacebook(btn); };
window.__actions['sheet-email'] = () => {
  window.closeAuthSheet();
  if (window.showAuthScreen) window.showAuthScreen(window.__pendingAuthReason || '');
  if (window.setEmailMode) window.setEmailMode(window.__authSheetMode === 'login' ? 'signin' : 'signup');
  // r376 (Jake, 2026-10-27): the email step is a light card over whatever is
  // behind it (the cartoon welcome wall, or the marketplace) — never the old
  // dark full-screen gate. #authScreen.email-step hides the duplicate
  // wordmark/tagline/provider/guest buttons the sheet already offered.
  const as = document.getElementById('authScreen'); if (as) as.classList.add('email-step');
};
window.__actions['auth-back-to-sheet'] = () => {
  const as = document.getElementById('authScreen');
  if (as) { as.classList.remove('open', 'email-step'); as.classList.add('hidden'); }
  window.openAuthSheet(window.__authSheetMode);
};
// Welcome buttons + the generic "sign in to continue" prompt open the sheet.
window.__actions['welcome-signup'] = () => { try { window.posthog && window.posthog.capture('welcome_signup_tap'); } catch (_e) {} window.openAuthSheet('signup'); };
window.__actions['welcome-login'] = () => { try { window.posthog && window.posthog.capture('welcome_login_tap'); } catch (_e) {} window.openAuthSheet('login'); };

// ── Facebook (web popup; native waits for the FBSDK pod + flag) ──────────
window.signInWithFacebook = async function signInWithFacebook(btn) {
  const err = document.getElementById('authSheetError'); if (err) err.textContent = '';
  if (btn) btn.disabled = true;
  try {
    if (tbIsNative()) {
      if (!(window.FBAuthPlugin && window.FBAuthPlugin.signInWithFacebook)) throw Object.assign(new Error('Facebook sign-in is not available in this app version yet.'), { code: 'teebox/not-available' });
      const r = await window.FBAuthPlugin.signInWithFacebook({ skipNativeAuth: true });
      const token = r && r.credential && r.credential.accessToken; if (!token) return;
      const cred = window.FacebookAuthProvider.credential(token);
      await window.signInWithCredential(window.firebaseAuth, cred);
      return;
    }
    const provider = new window.FacebookAuthProvider(); provider.addScope('email'); provider.addScope('public_profile');
    await window.signInWithPopup(window.firebaseAuth, provider, window.__popupResolver);
  } catch (e) {
    const code = (e && e.code) || '';
    if (/cancel|popup-closed/i.test(code + ' ' + (e && e.message))) return;
    if (code === 'auth/account-exists-with-different-credential') { await window.tbHandleAccountExists(e, 'facebook.com'); return; }
    if (err) err.textContent = code === 'teebox/not-available' ? e.message : 'Could not sign in with Facebook. Try another method.';
  } finally { if (btn) btn.disabled = false; }
};

// ── Native token exchange (shared by Apple/Google native paths) ──────────
// intent: 'signin' | 'create' | 'link'. Returns {customToken} | {needsLink} | {relayChoice} | {linked}.
window.tbNativeExchange = async function tbNativeExchange(providerId, tok, intent) {
  const call = window.firebaseHttpsCallable(window.firebaseFns, 'exchangeIdTokenForCustomToken');
  const payload = { idToken: tok.idToken, providerId, intent: intent || 'signin' };
  if (tok.rawNonce) payload.rawNonce = tok.rawNonce;
  const res = await Promise.race([
    call(payload),
    new Promise((_, reject) => setTimeout(() => reject(new Error('exchange timed out after 15s')), 15000)),
  ]);
  return (res && res.data) || {};
};

// ── Link flow ────────────────────────────────────────────────────────────
// __pendingLink = { kind:'native'|'web', providerId, idToken?, rawNonce?, pendingCred?, email, methods, unverified, relay }
window.__pendingLink = null;
window.tbHandleNeedsLink = function tbHandleNeedsLink(info) {
  window.__pendingLink = Object.assign({}, info);
  const msg = document.getElementById('linkSheetMsg'), acts = document.getElementById('linkSheetActions');
  const provider = tbProviderLabel(info.providerId);
  const methods = (info.methods || []).filter((m) => m !== info.providerId);
  const list = methods.map(tbProviderLabel).join(' or ') || 'another method';
  if (msg) {
    msg.textContent = info.unverified
      ? `You already have a TeeBox account for ${info.email} using ${list}, but that email was never verified. Sign in with ${list}, verify your email, and then connect ${provider} from Account → Connected sign-in methods.`
      : `You already have a TeeBox account for ${info.email} using ${list}. Sign in with it and we'll connect ${provider}, so you can use either from now on.`;
  }
  if (acts) {
    acts.innerHTML = methods.map((m) => {
      if (m === 'password') return `<button type="button" class="tb-sheet-btn email" data-action="link-via-password">Sign in with email &amp; password</button>`;
      if (m === 'google.com') return `<button type="button" class="tb-sheet-btn google" data-action="link-via-google"><span>Continue with Google</span></button>`;
      if (m === 'apple.com') return `<button type="button" class="tb-sheet-btn apple" data-action="link-via-apple"><span>Continue with Apple</span></button>`;
      if (m === 'facebook.com') return `<button type="button" class="tb-sheet-btn facebook" data-action="link-via-facebook"><span>Continue with Facebook</span></button>`;
      return '';
    }).join('');
  }
  if (info.unverified) window.__pendingLink.noAutoLink = true;
  window.closeAuthSheet();
  const bd = document.getElementById('linkSheetBackdrop'); if (bd) bd.classList.add('open');
  try { window.posthog && window.posthog.capture('auth_link_prompt', { provider: info.providerId, methods, unverified: !!info.unverified }); } catch (_e) {}
};
window.__actions['close-link-sheet'] = () => { const bd = document.getElementById('linkSheetBackdrop'); if (bd) bd.classList.remove('open'); if (window.__pendingLink && !window.__pendingLink.keep) window.__pendingLink = null; };
window.__actions['link-via-password'] = () => {
  const p = window.__pendingLink; if (!p) return; p.keep = true;
  const bd = document.getElementById('linkSheetBackdrop'); if (bd) bd.classList.remove('open');
  if (window.showAuthScreen) window.showAuthScreen('to connect your sign-in methods');
  if (window.setEmailMode) window.setEmailMode('signin');
  const em = document.getElementById('emailInput'); if (em && p.email) em.value = p.email;
  setTimeout(() => { const pw = document.getElementById('passwordInput'); if (pw) pw.focus(); }, 150);
};
window.__actions['link-via-google'] = (btn) => { if (window.__pendingLink) window.__pendingLink.keep = true; const bd = document.getElementById('linkSheetBackdrop'); if (bd) bd.classList.remove('open'); window.__actions['sign-in-google'](btn); };
window.__actions['link-via-apple'] = (btn) => { if (window.__pendingLink) window.__pendingLink.keep = true; const bd = document.getElementById('linkSheetBackdrop'); if (bd) bd.classList.remove('open'); window.__actions['sign-in-apple'](btn); };
window.__actions['link-via-facebook'] = (btn) => { if (window.__pendingLink) window.__pendingLink.keep = true; const bd = document.getElementById('linkSheetBackdrop'); if (bd) bd.classList.remove('open'); window.signInWithFacebook(btn); };
// Web popup path: Firebase raised account-exists-with-different-credential.
window.tbHandleAccountExists = async function tbHandleAccountExists(e, providerId) {
  try {
    const P = providerId === 'google.com' ? window.GoogleAuthProvider : providerId === 'facebook.com' ? window.FacebookAuthProvider : window.OAuthProvider;
    const pendingCred = P && P.credentialFromError ? P.credentialFromError(e) : null;
    const email = e && e.customData && e.customData.email;
    if (!email) throw e;
    const methods = await window.fetchSignInMethodsForEmail(window.firebaseAuth, email);
    window.tbHandleNeedsLink({ kind: 'web', providerId, pendingCred, email, methods, unverified: false });
  } catch (_e) {
    const err = document.getElementById('authErrorEmail'); if (err) err.textContent = 'An account with that email already exists. Sign in with your original method, then connect this one from Account settings.';
  }
};
// Runs after any successful sign-in (app-auth.js hook): attach the pending provider.
window.completePendingLink = async function completePendingLink() {
  const p = window.__pendingLink; const u = window.firebaseAuth && window.firebaseAuth.currentUser;
  if (!p || !u) return;
  window.__pendingLink = null;
  if (p.noAutoLink) { showToast('Signed in. Verify your email, then connect ' + tbProviderLabel(p.providerId) + ' from Account → Connected sign-in methods.'); return; }
  // Rule: auto-link only on a verified email on the account we just signed in to.
  // (A relay-choice "I already have an account" is an explicit user action, so it may link.)
  if (!u.emailVerified && !p.relay) { showToast('Verify your email first, then connect ' + tbProviderLabel(p.providerId) + ' from Account settings.'); return; }
  try {
    if (p.kind === 'native') {
      const r = await window.tbNativeExchange(p.providerId, { idToken: p.idToken, rawNonce: p.rawNonce }, 'link');
      if (!r || !r.linked) throw new Error('link failed');
    } else if (p.pendingCred) {
      await window.linkWithCredential(u, p.pendingCred);
    }
    try { await window.authReload(u); } catch (_e) {}
    showToast(tbProviderLabel(p.providerId) + ' connected. You can sign in with either from now on.');
    try { window.posthog && window.posthog.capture('auth_linked', { provider: p.providerId, kind: p.kind }); } catch (_e) {}
  } catch (e) {
    const code = (e && e.code) || '';
    const msg = /already-exists|credential-already-in-use|already in use/i.test(code + ' ' + (e && e.message))
      ? 'That ' + tbProviderLabel(p.providerId) + ' sign-in is already its own TeeBox account. Email support@teeboxmarket.com and we will merge them.'
      : 'Signed in, but connecting ' + tbProviderLabel(p.providerId) + ' failed. You can retry from Account → Connected sign-in methods.';
    showToast(msg);
    console.warn('completePendingLink failed', e);
  }
};
// Apple "Hide My Email": nothing matched — ask before creating a second account.
window.tbHandleRelayChoice = function tbHandleRelayChoice(info) {
  window.__pendingLink = Object.assign({ kind: 'native', relay: true, keep: true }, info);
  window.closeAuthSheet();
  const bd = document.getElementById('relaySheetBackdrop'); if (bd) bd.classList.add('open');
};
window.__actions['close-relay-sheet'] = () => { const bd = document.getElementById('relaySheetBackdrop'); if (bd) bd.classList.remove('open'); window.__pendingLink = null; };
window.__actions['relay-create'] = async () => {
  const p = window.__pendingLink; const bd = document.getElementById('relaySheetBackdrop'); if (bd) bd.classList.remove('open');
  if (!p) return; window.__pendingLink = null;
  try {
    const r = await window.tbNativeExchange(p.providerId, { idToken: p.idToken, rawNonce: p.rawNonce }, 'create');
    if (r && r.customToken) await window.signInWithCustomToken(window.firebaseAuth, r.customToken);
    else showToast('Could not create your account. Try again.');
  } catch (e) { showToast('Could not create your account. Try again.'); }
};
window.__actions['relay-existing'] = () => {
  const bd = document.getElementById('relaySheetBackdrop'); if (bd) bd.classList.remove('open');
  // Keep the Apple token; after they sign in with their existing method the
  // completePendingLink hook attaches Apple to that account.
  window.openAuthSheet('login', 'to connect Apple to your account');
};

// ── Account → Connected sign-in methods ──────────────────────────────────
window.openConnectedMethods = async function openConnectedMethods() {
  if (!window.requireAuth('to manage your sign-in methods', () => window.openConnectedMethods())) return;
  openInfo('connectedBackdrop');
  window.renderConnectedMethods();
};
window.renderConnectedMethods = function renderConnectedMethods() {
  const u = window.firebaseAuth && window.firebaseAuth.currentUser; const list = document.getElementById('connectedList'); if (!u || !list) return;
  const have = new Set((u.providerData || []).map((p) => p.providerId));
  const m = /^(google_com|apple_com)_/.exec(u.uid || ''); if (m) have.add(m[1].replace('_', '.')); // legacy native accounts
  const native = tbIsNative();
  const rows = [
    { id: 'password', name: 'Email & password', sub: have.has('password') ? (u.email || '') : 'Sign in with an email and password', can: true, action: 'cm-add-password' },
    { id: 'google.com', name: 'Google', sub: have.has('google.com') ? ((u.providerData.find((p) => p.providerId === 'google.com') || {}).email || 'Connected') : 'Connect your Google account', can: !native || tbFlag('nativeGoogle'), action: 'cm-connect-google' },
    { id: 'apple.com', name: 'Apple', sub: have.has('apple.com') ? ((u.providerData.find((p) => p.providerId === 'apple.com') || {}).email || 'Connected') : 'Connect your Apple ID', can: native || tbFlag('appleWeb'), action: 'cm-connect-apple' },
  ];
  if (tbFlag('facebookLogin')) rows.push({ id: 'facebook.com', name: 'Facebook', sub: have.has('facebook.com') ? 'Connected' : 'Connect your Facebook account', can: !native || tbFlag('nativeFacebook'), action: 'cm-connect-facebook' });
  const count = rows.filter((r) => have.has(r.id)).length;
  list.innerHTML = rows.map((r) => {
    const on = have.has(r.id);
    const btn = on
      ? `<button type="button" class="cm-btn ghost" data-action="cm-disconnect" data-provider="${r.id}" ${count <= 1 ? 'disabled title="Keep at least one way to sign in"' : ''}>Disconnect</button>`
      : (r.can ? `<button type="button" class="cm-btn" data-action="${r.action}">Connect</button>` : `<button type="button" class="cm-btn ghost" disabled>Not available here</button>`);
    return `<div class="cm-row"><div class="cm-ico" data-ico="${r.id === 'password' ? 'mail' : 'user'}"></div><div class="cm-body"><div class="cm-name">${window.safeText(r.name)}</div><div class="cm-sub">${window.safeText(on ? r.sub : r.sub)}</div></div>${btn}</div>`;
  }).join('');
  try { window.renderIcons && window.renderIcons(list); } catch (_e) {}
  const f = document.getElementById('cmPasswordForm'); if (f) { f.classList.remove('open'); const em = document.getElementById('cmEmail'); if (em) { em.value = u.email || ''; em.readOnly = !!u.email; } }
  const err = document.getElementById('cmError'); if (err) err.textContent = '';
};
function cmErr(msg) { const err = document.getElementById('cmError'); if (err) err.textContent = msg || ''; }
function cmLinkError(e, provider) {
  const code = (e && e.code) || '';
  if (/cancel|popup-closed/i.test(code + ' ' + (e && e.message))) return '';
  if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use' || code === 'functions/already-exists') return 'That ' + provider + ' sign-in is already its own TeeBox account. Email support@teeboxmarket.com and we will merge them.';
  if (code === 'auth/requires-recent-login') return 'For security, sign out and back in, then try connecting again.';
  if (code === 'auth/provider-already-linked') return provider + ' is already connected.';
  if (code === 'auth/weak-password') return 'Choose a password with at least 8 characters.';
  return 'Could not connect ' + provider + '. Try again.';
}
window.__actions['open-connected-methods'] = () => window.openConnectedMethods();
window.__actions['cm-add-password'] = () => { const f = document.getElementById('cmPasswordForm'); if (f) f.classList.add('open'); setTimeout(() => { const i = document.getElementById(document.getElementById('cmEmail').value ? 'cmPassword' : 'cmEmail'); if (i) i.focus(); }, 80); };
window.__actions['cm-add-password-submit'] = async () => {
  const u = window.firebaseAuth.currentUser; if (!u) return; cmErr('');
  const email = (document.getElementById('cmEmail').value || '').trim().toLowerCase(); const pw = document.getElementById('cmPassword').value || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { cmErr('Enter a valid email.'); return; }
  if (pw.length < 8) { cmErr('Password needs at least 8 characters.'); return; }
  try {
    await window.linkWithCredential(u, window.EmailAuthProvider.credential(email, pw));
    try { await window.authReload(u); } catch (_e) {}
    showToast('Email & password added. Check your inbox to verify the address.');
    try { await window.firebaseHttpsCallable(window.firebaseFns, 'sendBrandedVerification')({}); } catch (_e) {}
    window.renderConnectedMethods();
  } catch (e) { cmErr(cmLinkError(e, 'email & password')); }
};
window.__actions['cm-connect-google'] = async () => {
  const u = window.firebaseAuth.currentUser; if (!u) return; cmErr('');
  try {
    if (tbIsNative()) {
      const r = await window.FBAuthPlugin.signInWithGoogle(); const idToken = r && r.credential && r.credential.idToken; if (!idToken) return;
      const x = await window.tbNativeExchange('google.com', { idToken }, 'link'); if (!x.linked) throw new Error('link failed');
    } else {
      await window.linkWithPopup(u, new window.GoogleAuthProvider());
    }
    try { await window.authReload(u); } catch (_e) {} showToast('Google connected.'); window.renderConnectedMethods();
  } catch (e) { cmErr(cmLinkError(e, 'Google')); }
};
window.__actions['cm-connect-apple'] = async () => {
  const u = window.firebaseAuth.currentUser; if (!u) return; cmErr('');
  try {
    if (tbIsNative()) {
      const r = await window.FBAuthPlugin.signInWithApple({ skipNativeAuth: true }); const idToken = r && r.credential && r.credential.idToken; const rawNonce = r && r.credential && r.credential.nonce; if (!idToken) return;
      const x = await window.tbNativeExchange('apple.com', { idToken, rawNonce }, 'link'); if (!x.linked) throw new Error('link failed');
    } else {
      const prov = new window.OAuthProvider('apple.com'); prov.addScope('email'); prov.addScope('name');
      await window.linkWithPopup(u, prov);
    }
    try { await window.authReload(u); } catch (_e) {} showToast('Apple connected.'); window.renderConnectedMethods();
  } catch (e) { cmErr(cmLinkError(e, 'Apple')); }
};
window.__actions['cm-connect-facebook'] = async () => {
  const u = window.firebaseAuth.currentUser; if (!u) return; cmErr('');
  try {
    const prov = new window.FacebookAuthProvider(); prov.addScope('email');
    await window.linkWithPopup(u, prov);
    try { await window.authReload(u); } catch (_e) {} showToast('Facebook connected.'); window.renderConnectedMethods();
  } catch (e) { cmErr(cmLinkError(e, 'Facebook')); }
};
window.__actions['cm-disconnect'] = async (el) => {
  const u = window.firebaseAuth.currentUser; if (!u) return; cmErr('');
  const pid = el.dataset.provider; if ((u.providerData || []).length <= 1) { cmErr('Keep at least one way to sign in.'); return; }
  if (!window.confirm('Disconnect ' + tbProviderLabel(pid) + ' from this account?')) return;
  try { await window.unlinkProvider(u, pid); try { await window.authReload(u); } catch (_e) {} showToast(tbProviderLabel(pid) + ' disconnected.'); window.renderConnectedMethods(); }
  catch (e) { cmErr(cmLinkError(e, tbProviderLabel(pid))); }
};

// ═══ Welcome / opening screen (r364 Phase 1) ═══════════════════════════
// Shown to logged-out visitors: web on the first visit (then snoozed 7 days
// after Skip), native on every cold launch (in-memory dismiss, like the old
// auth gate — WKWebView keeps sessionStorage across cold launches). Never on
// deep links (listing/order/offer/brand/seller/bingo/signin…), never for
// crawlers, never once signed in. Tiles: /assets/welcome/art-*.webp — single
// cartoon gear items with TRANSPARENT backgrounds floating on the cream
// (Jake, 2026-10-27: no boxes). Add a tile = art-<name>.webp (600², alpha) +
// art-<name>-320.webp in assets/welcome and the name below.
// 2026-10-27 night: rebuilt from Jake's 37-item ChatGPT set (masters in
// ~/Downloads/teebox-cartoons.zip; cutout recipe in .internal-docs/welcome-photos.md).
// Empty lists = rows stay hidden (.welcome-marquee[hidden]). Four rows, items
// dealt round-robin in Jake's 01-37 order so each row mixes categories.
const WELCOME_PHOTOS_A = ['art-footjoy-shoe', 'art-rainbow-sandals', 'art-woven-belt', 'art-titleist-stand-bag', 'art-oakley-sunglasses-black', 'art-bushnell-rangefinder', 'art-titleist-umbrella', 'art-puma-shoe-navy', 'art-golf-cart-wallet', 'art-polo-dotted'];
const WELCOME_PHOTOS_B = ['art-flag-belt', 'art-adidas-shoe-white-navy', 'art-titleist-cap-black', 'art-sun-mountain-stand-bag', 'art-oakley-sunglasses-tortoise', 'art-yeti-soft-cooler', 'art-titleist-divot-tool', 'art-peter-millar-polo', 'art-evans-scholars-cap', 'art-headcover-medallion'];
const WELCOME_PHOTOS_C = ['art-taylormade-wedge', 'art-footjoy-premiere', 'art-callaway-cap-white', 'art-plaid-headcover', 'art-turtlebox-camo', 'art-golf-towel', 'art-duck-wallet', 'art-rlx-pants', 'art-footjoy-beanie', 'art-koozie-golf-cart'];
const WELCOME_PHOTOS_D = ['art-scotty-cameron-putter', 'art-adidas-shoe-retro', 'art-stand-bag-black', 'art-titleist-ball', 'art-hoodie-quilted-hb', 'art-footjoy-glove', 'art-ball-marker', 'art-wooden-tees', 'art-putter-mallet', 'art-titleist-gt1-driver'];
const WELCOME_SNOOZE_KEY = 'tb_welcome_snooze';
function welcomeTileHtml(name, eager) {
  const b = '/assets/welcome/' + name;
  // All tiles load eagerly: the second copy of each row reuses the same URLs
  // (cached), and lazy tiles inside a translating track would pop in blank
  // mid-loop. Only the first few get fetchpriority=high.
  return `<div class="welcome-tile"><img src="${b}-320.webp" srcset="${b}-320.webp 320w, ${b}.webp 600w" sizes="(min-width: 700px) 104px, 80px" width="300" height="300" alt="" decoding="async"${eager ? ' fetchpriority="high"' : ''}></div>`;
}
function welcomeShouldShow() {
  try {
    if (window.CURRENT_USER) return false;
    if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit/i.test(navigator.userAgent)) return false;
    if (location.pathname !== '/' && location.pathname !== '/index.html') return false;
    const q = new URLSearchParams(location.search);
    for (const k of ['listing', 'order', 'offer', 'brand', 'seller', 'launch', 'action', 'play', 'signin', 'checkout', 'prefs', 'search', 'sell', 'admin', 'preview', 'meta_test']) if (q.has(k)) return false;
    if (location.hash && location.hash.length > 1) return false;
    const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (native) return !window.__welcomeDismissedInSession;
    // r377: Skip hides it for this browser session only (was a 7-day snooze) —
    // a logged-out visitor sees the welcome again on their next visit.
    return !sessionStorage.getItem(WELCOME_SNOOZE_KEY);
  } catch (_e) { return false; }
}
window.showWelcome = function showWelcome() {
  const el = document.getElementById('welcomeScreen'); if (!el || el.classList.contains('open')) return;
  const a = document.getElementById('welcomeTrackA'), b = document.getElementById('welcomeTrackB'), c = document.getElementById('welcomeTrackC'), d = document.getElementById('welcomeTrackD');
  const mq = el.querySelector('.welcome-marquee'); if (mq) mq.hidden = !(WELCOME_PHOTOS_A.length || WELCOME_PHOTOS_B.length);
  if (a && !a.childElementCount && WELCOME_PHOTOS_A.length) {
    // Each track holds the list TWICE so a -50% translate loops seamlessly.
    // One copy must be wider than the viewport or the loop shows a gap, so a
    // short pool is repeated first (tile ≤ 200px + 14px gap).
    const reps = (names) => { const w = Math.max(window.innerWidth || 0, 390) + 112; const one = names.length * 112; const r = Math.max(1, Math.ceil(w / one)); let out = []; for (let i = 0; i < r; i++) out = out.concat(names); return out; };
    const fill = (names, eager) => { const one = reps(names); return one.map((n, i) => welcomeTileHtml(n, i < eager)).join('') + one.map((n) => welcomeTileHtml(n, false)).join(''); };
    a.innerHTML = fill(WELCOME_PHOTOS_A, 4);
    b.innerHTML = fill(WELCOME_PHOTOS_B, 3);
    if (c) c.innerHTML = fill(WELCOME_PHOTOS_C, 3);
    if (d) d.innerHTML = fill(WELCOME_PHOTOS_D, 2);
    // First-row tiles carry fetchpriority=high (above). No <link rel=preload>:
    // in the Lighthouse A/B the extra preloads delayed the web fonts behind
    // the overlay and cost CLS/TBT for no visible gain.
  }
  el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); document.body.classList.add('welcome-open');
  try { window.posthog && window.posthog.capture('welcome_shown', { native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) }); } catch (_e) {}
};
window.hideWelcome = function hideWelcome(reason) {
  const el = document.getElementById('welcomeScreen'); if (!el) return;
  el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); document.body.classList.remove('welcome-open');
  window.__welcomeDismissedInSession = true;
  if (reason === 'skip') { try { sessionStorage.setItem(WELCOME_SNOOZE_KEY, '1'); localStorage.removeItem(WELCOME_SNOOZE_KEY); } catch (_e) {} }
};
function initWelcomeScreen() {
  if (!welcomeShouldShow()) return;
  window.showWelcome();
}
window.__actions['welcome-skip'] = () => { window.hideWelcome('skip'); try { window.posthog && window.posthog.capture('welcome_skip'); } catch (_e) {} };
// welcome-signup / welcome-login: defined in the Phase 2 block above (open the provider sheet).
// Boot: decide once the DOM is ready. Auth state may still be resolving —
// app-auth.js calls hideWelcome() the moment a signed-in user is restored,
// so a returning member sees at most a brief opener on a cold web load.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWelcomeScreen); else initWelcomeScreen();

// 6. Launch shortcuts + deep links from brand SEO pages + path-style routes.
//    PWA manifest shortcuts: /?launch=sell /?launch=inbox /?launch=watchlist
//    Brand SEO links:        /?brand=scotty-cameron /?listing=<id> /?action=sell
//    Public seller pages:    /seller/<uid>  (Firebase rewrite → /)
const __params = new URLSearchParams(location.search);
const __launch = __params.get('launch');
const __action = __params.get('action');
const __brandQ = __params.get('brand');
const __listingQ = __params.get('listing');
const __orderQ   = __params.get('order');
const __sellerQ  = __params.get('seller');
const __checkoutQ = __params.get('checkout');
// Detect /seller/<uid> path-style route — Firebase rewrites + GitHub Pages
// 404 to /index.html, so we just read the path.
const __sellerPath = (location.pathname.match(/^\/seller\/([A-Za-z0-9_\-]+)\/?$/) || [])[1];
// Pro Seller subscription Checkout return — surface a toast so the user
// knows what happened. The webhook is the source of truth for tier flips,
// so the banner may take a few seconds to flip from "Upgrade" → "Pro".
if (__checkoutQ === 'pro_success') {
  setTimeout(async () => {
    if (typeof showToast === 'function') {
      showToast("You're on Pro Seller. Fees are now 3%. Welcome aboard.", 'success');
    }
    // L2: force a token refresh + banner re-render so the user immediately
    // sees their new Pro status. Without this, the banner still reads the
    // pre-webhook tier='free' until the user navigates away. The webhook
    // is still the source of truth — this just narrows the visible-stale
    // window. All best-effort; failures swallowed.
    try {
      if (window.CURRENT_USER && typeof window.CURRENT_USER.getIdToken === 'function') {
        await window.CURRENT_USER.getIdToken(true);
      }
    } catch (_e) { /* swallow */ }
    try {
      if (typeof renderProTierBanner === 'function') {
        await renderProTierBanner();
      }
    } catch (_e) { /* swallow */ }
  }, 600);
  // Strip the param off the URL so a refresh doesn't re-fire the toast.
  try { history.replaceState({}, '', location.pathname); } catch (_e) {}
} else if (__checkoutQ === 'pro_cancel') {
  setTimeout(() => {
    if (typeof showToast === 'function') {
      showToast('Upgrade canceled. You can try again anytime from My Shop.');
    }
  }, 600);
  try { history.replaceState({}, '', location.pathname); } catch (_e) {}
}
if (__launch || __action || __brandQ || __listingQ || __orderQ || __sellerQ || __sellerPath) {
  setTimeout(() => {
    if (__launch === 'sell' || __action === 'sell') {
      window.handleSellClick && window.handleSellClick();
    }
    if (__orderQ) {
      // Email CTAs land here: templates link /orders/<id>, 404.html bounces
      // it to /?order=<id>. Route the signed-in party to the right surface —
      // the SELLER's ship-to + Mark Shipped live on the shop dashboard, the
      // buyer's status lives in Orders. Reading the order doc (rules allow
      // buyer or seller) decides the side; unreadable/absent → buyer surface.
      const __routeOrder = async () => {
        if (!window.CURRENT_USER) {
          window.requireAuth && window.requireAuth('to view your order', __routeOrder);
          return;
        }
        let sellerSide = false;
        try {
          const { getFirestore, doc, getDoc } =
            await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
          const snap = await getDoc(doc(getFirestore(), 'orders', __orderQ));
          sellerSide = !!(snap.exists() && snap.data().sellerId === window.CURRENT_USER.uid);
        } catch (_e) { /* unreadable → buyer surface */ }
        if (sellerSide && window.openShopDashboard) window.openShopDashboard();
        else if (typeof openOrders === 'function') openOrders();
      };
      // Auth resolves after this 800ms boot timer on cold loads — poll
      // briefly for the restored session before letting requireAuth prompt,
      // so a signed-in user opening an email link never sees the sign-in
      // screen flash.
      let __orTries = 0;
      const __orTick = () => {
        if (window.CURRENT_USER || ++__orTries > 10) { __routeOrder(); return; }
        setTimeout(__orTick, 300);
      };
      __orTick();
    }
    if (__launch === 'inbox')     window.openInbox && window.openInbox();
    if (__launch === 'watchlist') (window.openWatchlist || openWatchlistWithDropBadges)();
    if (__listingQ) {
      // r156/r157: wait for the feed cache EVENT instead of the old blind
      // 800ms timer (which fired before listings arrived ~2s on cold load,
      // killing deep links on exactly the cold start a shared link
      // produces). Event-driven, not a poll chain: chained setTimeout polls
      // are throttled to ~1/min in background tabs — where shared links
      // often open. One depth-1 hard-fallback timer (exempt from intensive
      // throttling) covers the pathological case; the getDoc fallback
      // inside openDetailModal covers not-in-cache listings either way.
      let __dlDone = false;
      const openIt = () => {
        if (__dlDone) return;
        __dlDone = true;
        window.openDetailModal && window.openDetailModal(__listingQ);
      };
      if (window.__listingsLoaded) openIt();
      else {
        window.addEventListener('teebox-listings-loaded', openIt, { once: true });
        setTimeout(openIt, 8000);
      }
    } else if (__brandQ) {
      // Brand slugs come from /brand/<slug> SEO pages — feed the slug into the
      // global search so the user lands on a pre-filtered marketplace.
      const term = __brandQ.replace(/-/g, ' ');
      const si = document.getElementById('searchInput');
      if (si && typeof filterSearch === 'function') {
        si.value = term;
        filterSearch(term);
      }
    }
    const sellerUid = __sellerPath || __sellerQ;
    if (sellerUid) {
      window.openProfile && window.openProfile(sellerUid);
    }
    if (!__sellerPath) history.replaceState({}, '', location.pathname);
  }, 800);
}

// ─────────────────────────────────────────────────────────────
// REVIEWS
// ─────────────────────────────────────────────────────────────
const REVIEW_AGG_CACHE = new Map();

// Two-way reviews: load all reviews where this uid is the *reviewee* —
// i.e. the buyer-as-customer reviews on a seller, *plus* the seller-as-
// counterparty reviews on a buyer. The schema migration introduced a
// `revieweeId` field; legacy docs (pre-migration) only have buyerId+
// sellerId, so we fall back to filtering client-side by sellerId for
// uids the new field hasn't backfilled yet.
async function loadUserReviews(uid) {
  if (!uid) return { count: 0, avg: 0, items: [] };
  if (REVIEW_AGG_CACHE.has(uid)) return REVIEW_AGG_CACHE.get(uid);
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const items = [];
    const seen = new Set();
    // Preferred path — the v1.1 `revieweeId` field.
    try {
      const snap = await getDocs(query(
        collection(db, 'reviews'),
        where('revieweeId', '==', uid),
        orderBy('createdAt', 'desc'),
        limit(50),
      ));
      snap.docs.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); items.push({ id: d.id, ...d.data() }); } });
    } catch (_e) { /* index may not exist; legacy fallback below covers it */ }
    // Legacy fallback — sellerId == uid (buyer reviewing seller).
    try {
      const snap2 = await getDocs(query(
        collection(db, 'reviews'),
        where('sellerId', '==', uid),
        orderBy('createdAt', 'desc'),
        limit(50),
      ));
      snap2.docs.forEach(d => {
        if (seen.has(d.id)) return;
        const data = d.data();
        // Only include legacy buyer-role / unmigrated docs here so we
        // don't accidentally surface seller-role reviews on the wrong
        // profile.
        if (data.role === 'seller' && data.revieweeId && data.revieweeId !== uid) return;
        seen.add(d.id);
        items.push({ id: d.id, ...data });
      });
    } catch (_e) {}
    items.sort((a, b) => {
      const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return bt - at;
    });
    const count = items.length;
    const avg = count ? items.reduce((s, r) => s + (r.rating || 0), 0) / count : 0;
    const agg = { count, avg, items };
    REVIEW_AGG_CACHE.set(uid, agg);
    return agg;
  } catch (e) {
    console.error('loadUserReviews failed:', e);
    return { count: 0, avg: 0, items: [] };
  }
}
// Back-compat alias for any external callers.
const loadSellerReviews = loadUserReviews;

// Recently-sold feed for public seller profile (Feature #9).
// Shows up to 5 most-recent delivered orders. NEVER include buyer info.
async function loadRecentSoldOrders(sellerId) {
  if (!sellerId) return [];
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    let snap;
    try {
      snap = await getDocs(query(
        collection(db, 'orders'),
        where('sellerId', '==', sellerId),
        where('fulfillmentStatus', '==', 'delivered'),
        orderBy('deliveredAt', 'desc'),
        limit(5),
      ));
    } catch (idxErr) {
      // Index might not exist yet — fall back to in-memory filter.
      const all = await getDocs(query(
        collection(db, 'orders'),
        where('sellerId', '==', sellerId),
        limit(50),
      ));
      const items = all.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(o => o.fulfillmentStatus === 'delivered')
        .sort((a, b) => {
          const ad = a.deliveredAt && a.deliveredAt.toDate ? a.deliveredAt.toDate().getTime() : 0;
          const bd = b.deliveredAt && b.deliveredAt.toDate ? b.deliveredAt.toDate().getTime() : 0;
          return bd - ad;
        })
        .slice(0, 5);
      return items;
    }
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('loadRecentSoldOrders failed:', e);
    return [];
  }
}

function relativeTimeFromDate(d) {
  if (!d) return '';
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return days + ' days ago';
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  if (months < 12) return months + ' months ago';
  const years = Math.floor(months / 12);
  return years === 1 ? '1 year ago' : years + ' years ago';
}

function starsHtml(rating, max = 5) {
  const r = Math.max(0, Math.min(max, Number(rating) || 0));
  let out = '';
  for (let i = 1; i <= max; i++) {
    out += i <= Math.round(r) ? window.ICONS.star.replace('class="ico"', 'class="ico ico-fill"') : window.ICONS.star;
  }
  return `<span class="stars" aria-label="${r} out of ${max}">${out}</span>`;
}

let pendingReviewOrderId = null;
let pendingReviewSellerId = null;
let pendingReviewBuyerId = null;
let pendingReviewRole = null; // 'buyer' | 'seller'

// Two-way review prompt — buyers AND sellers see a prompt once their
// order is delivered. Doc id is `{orderId}_buyer` or `{orderId}_seller`.
window.maybePromptReview = async function maybePromptReview() {
  if (!window.CURRENT_USER) return;
  // At most ONE prompt per session — this runs on every auth resolve (i.e.
  // every page load), and without a guard a dismissed prompt came right
  // back on the next load ("kept popping up non stop").
  if (window.__reviewPromptedThisSession) return;
  try {
    const { getFirestore, collection, query, where, getDocs, doc, getDoc, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const uid = window.CURRENT_USER.uid;
    // Buyer-role first (we want to thank-you the buyer first). Only check
    // the 30 most-recent orders — anything older is past the realistic
    // review-prompt window.
    const buyerSnap = await getDocs(query(
      collection(db, 'orders'),
      where('buyerId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(30)
    ));
    for (const o of buyerSnap.docs) {
      const od = o.data();
      if (od.fulfillmentStatus !== 'delivered') continue;
      if (reviewSkipped(o.id, 'buyer')) continue; // dismissed recently on this device
      const rev = await getDoc(doc(db, 'reviews', o.id + '_buyer'));
      if (!rev.exists()) {
        pendingReviewOrderId = o.id;
        pendingReviewSellerId = od.sellerId;
        pendingReviewBuyerId = od.buyerId;
        pendingReviewRole = 'buyer';
        showReviewPrompt(od);
        return;
      }
    }
    // Then seller-role (sellers reviewing buyers)
    const sellerSnap = await getDocs(query(
      collection(db, 'orders'),
      where('sellerId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(30)
    ));
    for (const o of sellerSnap.docs) {
      const od = o.data();
      if (od.fulfillmentStatus !== 'delivered') continue;
      if (reviewSkipped(o.id, 'seller')) continue; // dismissed recently on this device
      const rev = await getDoc(doc(db, 'reviews', o.id + '_seller'));
      if (!rev.exists()) {
        pendingReviewOrderId = o.id;
        pendingReviewSellerId = od.sellerId;
        pendingReviewBuyerId = od.buyerId;
        pendingReviewRole = 'seller';
        showReviewPrompt(od);
        return;
      }
    }
  } catch (e) {
    // Silent — review prompt is best-effort.
  }
};

function showReviewPrompt(order) {
  const back = document.getElementById('reviewBackdrop');
  if (!back) return;
  const sub = document.getElementById('reviewSub');
  if (sub) sub.textContent = 'Order ' + (order.listingId || '').slice(0, 6);
  // Role-aware copy
  const titleEl = document.getElementById('reviewModalTitle');
  const copyEl  = document.getElementById('reviewModalCopy');
  if (pendingReviewRole === 'seller') {
    if (titleEl) titleEl.textContent = 'Rate your buyer';
    if (copyEl) copyEl.textContent = 'How was this buyer? Did they pay promptly? Easy to communicate with?';
  } else {
    if (titleEl) titleEl.textContent = 'Rate your seller';
    if (copyEl) copyEl.textContent = 'How was your experience with this seller? Was the item as described? Did they ship promptly?';
  }
  back.classList.add('open');
  window.__reviewPromptedThisSession = true;
  document.querySelectorAll('#reviewStars .star-pick').forEach(b => b.dataset.active = '0');
  document.getElementById('reviewStars').dataset.value = '0';
  const ta = document.getElementById('reviewComment');
  if (ta) ta.value = '';
}

// Dismissal memory. Skip / X used to just close the modal, so the same
// order re-prompted on every page load, on every device. Now a dismissal
// is remembered on this device for 30 days (the realistic review window);
// submitting a review writes reviews/{orderId}_{role}, which ends the
// prompt everywhere for good.
const REVIEW_SKIP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function reviewSkipKey(orderId, role) { return 'tb_reviewSkip:' + orderId + '_' + role; }
function reviewSkipped(orderId, role) {
  try {
    const t = Number(localStorage.getItem(reviewSkipKey(orderId, role)) || 0);
    return t > 0 && (Date.now() - t) < REVIEW_SKIP_TTL_MS;
  } catch (_e) { return false; }
}
function dismissReviewPrompt() {
  if (pendingReviewOrderId && pendingReviewRole) {
    try { localStorage.setItem(reviewSkipKey(pendingReviewOrderId, pendingReviewRole), String(Date.now())); } catch (_e) {}
  }
  const back = document.getElementById('reviewBackdrop');
  if (back) back.classList.remove('open');
  (document.getElementById('app-scroll') || document.body).style.overflowY = '';
}
window.dismissReviewPrompt = dismissReviewPrompt;

function setStarRating(n) {
  document.querySelectorAll('#reviewStars .star-pick').forEach((b, i) => {
    b.dataset.active = (i < n) ? '1' : '0';
  });
  document.getElementById('reviewStars').dataset.value = String(n);
}
window.setStarRating = setStarRating;

async function submitReview() {
  if (!window.CURRENT_USER || !pendingReviewOrderId || !pendingReviewSellerId || !pendingReviewBuyerId) return;
  const rating = Number(document.getElementById('reviewStars').dataset.value || 0);
  if (rating < 1 || rating > 5) {
    showToast('Pick a rating from 1 to 5 stars.');
    return;
  }
  const comment = (document.getElementById('reviewComment').value || '').trim().slice(0, 2000);
  const role = pendingReviewRole === 'seller' ? 'seller' : 'buyer';
  // Reviewer = whoever's clicking submit; reviewee = the other party.
  const reviewerId = window.CURRENT_USER.uid;
  const revieweeId = role === 'buyer' ? pendingReviewSellerId : pendingReviewBuyerId;
  const reviewDocId = pendingReviewOrderId + '_' + role;
  try {
    const { getFirestore, doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await setDoc(doc(db, 'reviews', reviewDocId), {
      // Required by current Firestore rules (buyerId, sellerId, rating, role, orderId, createdAt)
      buyerId: pendingReviewBuyerId,
      sellerId: pendingReviewSellerId,
      orderId: pendingReviewOrderId,
      role,
      // Two-way schema additions — used by loadUserReviews and the
      // review reporting UI.
      reviewerId,
      revieweeId,
      rating,
      comment: comment || '',
      createdAt: serverTimestamp(),
    });
    REVIEW_AGG_CACHE.delete(revieweeId);
    // Analytics: priority event #11 — `review_submitted`. Fires on
    // the buyer-side AFTER setDoc resolves so we only count reviews
    // that actually landed. The server-side `onReviewCreated`
    // trigger (functions/index.js:2072) updates seller avgRating
    // but doesn't itself fire a discrete event — keeping the
    // analytics fire client-side keeps the property bag (rating,
    // hasText) cheaper than re-reading the just-written doc on the
    // server.
    try {
      if (window.posthog) {
        window.posthog.capture('review_submitted', {
          reviewId: reviewDocId,
          orderId: pendingReviewOrderId,
          revieweeId,
          rating,
          hasText: !!(comment && comment.length > 0),
          role,
        });
      }
    } catch (_e) { /* analytics never blocks review submit */ }
    document.getElementById('reviewBackdrop').classList.remove('open');
    showToast('Thanks for the review.');
  } catch (e) {
    console.error('submitReview failed:', e);
    showToast('Could not submit review.');
  }
}

// ─────────────────────────────────────────────────────────────
// ACCOUNT DELETION (Apple App Store guideline 5.1.1(vi) requires
// an in-app deletion path for any app that lets users sign up).
//
// The Cloud Function `deleteUserAccount` is the source of truth —
// it anonymizes the user's Firestore data and deletes the auth
// record using the admin SDK so it succeeds even without a recent
// re-authentication. Client-side fallback signs the user out and
// shows guidance if the function call fails.
// ─────────────────────────────────────────────────────────────
function openDeleteAccountModal() {
  if (!window.CURRENT_USER) return;
  const menu = document.getElementById('userMenu');
  if (menu) menu.classList.remove('open');
  const back = document.getElementById('deleteAccountBackdrop');
  const input = document.getElementById('deleteAccountConfirmInput');
  const err = document.getElementById('deleteAccountError');
  if (input) input.value = '';
  if (err) err.textContent = '';
  if (back) back.classList.add('open');
}
window.openDeleteAccountModal = openDeleteAccountModal;

async function confirmDeleteAccount() {
  const input = document.getElementById('deleteAccountConfirmInput');
  const err = document.getElementById('deleteAccountError');
  const btn = document.getElementById('deleteAccountConfirmBtn');
  const typed = (input?.value || '').trim().toUpperCase();
  if (typed !== 'DELETE') {
    if (err) err.textContent = 'Type DELETE to confirm.';
    return;
  }
  if (!window.CURRENT_USER) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  if (err) err.textContent = '';
  // Capture the user's email BEFORE the auth record is wiped — once
  // `deleteUserAccount` returns, window.CURRENT_USER is gone and we
  // can't look it up. The notifySecurityEvent callable accepts a
  // `toOverride` so the confirmation email reaches the right inbox
  // even after the Firebase Auth record has been destroyed.
  const capturedEmail = (window.CURRENT_USER && window.CURRENT_USER.email) || null;
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    // Fire the AccountDeletionConfirmed email FIRST while the auth
    // record still exists. Producer lives in
    // ./functions/securityEmailTriggers.js. Best-effort — a failure
    // here must not block the actual deletion (Apple guideline
    // 5.1.1(vi) requires an in-app deletion path with no friction).
    try {
      const notify = httpsCallable(fns, 'notifySecurityEvent');
      await notify({
        eventType: 'account_deletion',
        metadata: {
          toOverride: capturedEmail,
          userAgent: (navigator && navigator.userAgent) || null,
        },
      });
    } catch (notifyErr) {
      console.warn('notifySecurityEvent(account_deletion) failed:', notifyErr);
    }
    const del = httpsCallable(fns, 'deleteUserAccount');
    await del({});
    document.getElementById('deleteAccountBackdrop').classList.remove('open');
    showToast('Account deleted. Goodbye.');
    // Auth record is already gone server-side; signOut clears the local session.
    const { getAuth, signOut: fbSignOutLocal } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js");
    try { await fbSignOutLocal(getAuth()); } catch (e) { /* already signed out */ }
  } catch (e) {
    console.error('deleteUserAccount failed:', e);
    if (err) err.textContent = 'Could not delete account. Please try again or email legal@teeboxmarket.com.';
    if (btn) { btn.disabled = false; btn.textContent = 'Delete account permanently'; }
  }
}
window.confirmDeleteAccount = confirmDeleteAccount;

// ─────────────────────────────────────────────────────────────
// GDPR Art. 20 — Download my data
//   Calls the `exportMyData` Cloud Function callable, receives a JSON
//   blob with every Firestore record we hold for the user, triggers a
//   client-side download as `teebox-data-{uid}-{YYYY-MM-DD}.json`.
//
//   Large bundles (heavy sellers with many orders/reviews) may take
//   5–10s. We disable the button + show a loading state during the
//   round-trip. The callable hard-caps at ~9MB; if a user exceeds
//   that, the server throws `resource-exhausted` and we point them
//   at legal@teeboxmarket.com for the background-export path (which
//   is documented but not yet built per dataPortability.js).
// ─────────────────────────────────────────────────────────────
async function downloadMyData() {
  if (!window.CURRENT_USER) return;
  const btn = document.getElementById('downloadMyDataBtn');
  const origLabel = btn ? btn.textContent : 'Download my data';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Preparing export…';
  }
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'exportMyData');
    const res = await fn({});
    const payload = (res && res.data) || null;
    if (!payload || payload.ok !== true) {
      throw new Error('Empty export response');
    }
    const ymd = new Date().toISOString().slice(0, 10);
    const uid = payload.uid || (window.CURRENT_USER && window.CURRENT_USER.uid) || 'me';
    const filename = `teebox-data-${uid}-${ymd}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so Safari has time to start the download before
    // the blob URL is invalidated.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_e) {} }, 4000);
    showToast('Your data export downloaded.', 'success');
  } catch (e) {
    console.error('downloadMyData failed:', e);
    // Server throws `resource-exhausted` when the bundle is too big
    // for inline delivery — surface that path explicitly so users
    // know who to email.
    const code = (e && e.code) || '';
    if (code === 'functions/resource-exhausted' || code === 'resource-exhausted') {
      showToast('Your data is too large for instant download. Please email legal@teeboxmarket.com. We’ll send you a one-time link within 30 days.', 'error');
    } else {
      showToast('Could not export your data. Please try again or email support@teeboxmarket.com.', 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }
}
window.downloadMyData = downloadMyData;

// ─────────────────────────────────────────────────────────────
// Stripe — Manage payouts
//   Resolves a single-use Stripe Express dashboard login URL via the
//   `createStripeLoginLink` callable and opens it in a new tab. The
//   server requires the seller to have a `stripeAccountId` (KYC
//   completed) — the button is hidden in the UI when that's not the
//   case, but we still surface the server error gracefully here.
// ─────────────────────────────────────────────────────────────
async function openStripeLoginLink() {
  if (!window.CURRENT_USER) return;
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'createStripeLoginLink');
    const res = await fn({});
    const url = res && res.data && res.data.url;
    if (!url) throw new Error('No url in createStripeLoginLink response');
    // window.open with noopener for the security default; falls back
    // to direct nav if a popup blocker swallows the new tab.
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      window.location.href = url;
    }
  } catch (e) {
    console.error('createStripeLoginLink failed:', e);
    const msg = (e && e.message) || '';
    if (/failed-precondition/i.test(msg)) {
      showToast('Finish Stripe onboarding before opening the payouts dashboard.', 'info');
    } else {
      showToast('Could not open Stripe dashboard. Try again in a moment.', 'error');
    }
  }
}
window.openStripeLoginLink = openStripeLoginLink;

// ─────────────────────────────────────────────────────────────
// WATCHLIST
// ─────────────────────────────────────────────────────────────
async function loadWatchlist() {
  if (!window.CURRENT_USER) return {};
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
    return (snap.exists() && snap.data().watchlist) || {};
  } catch (e) {
    return {};
  }
}

async function toggleWatch(productId, desired) {
  // Guest gate — Phase 3: guests get the sign-up sheet (Vinted behaviour).
  if (!window.CURRENT_USER) {
    if (typeof window.openAuthSheet === 'function') window.openAuthSheet('signup', 'to like and save listings');
    else if (typeof window.requireAuth === 'function') window.requireAuth('to like and save listings');
    else showToast('Sign in to save items.');
    return;
  }
  const id = String(productId);
  const product = (window.PRODUCTS || []).find(p => String(p.id) === id);
  const wasLiked = fav.has(productId) || fav.has(id) || fav.has(Number(id));
  const on = typeof desired === 'boolean' ? desired : !wasLiked;
  const prevCount = product ? Math.max(0, Number(product.watchlistCount || 0)) : null;
  // Optimistic: flip my state + the visible count now; the server answer
  // below reconciles (or the catch rolls back).
  if (on) { fav.add(productId); fav.add(id); } else { fav.delete(productId); fav.delete(id); fav.delete(Number(id)); }
  if (product) product.watchlistCount = Math.max(0, prevCount + (on ? 1 : -1));
  window.paintFav(id, on, product ? product.watchlistCount : null);
  const syncDetail = (count, liked) => {
    if (currentDetailId != null && String(currentDetailId) === id && typeof window.renderDetailLikes === 'function') {
      if (typeof count === 'number') detailLikeBase[id] = { count, likedAtOpen: !!liked };
      window.renderDetailLikes(id);
    }
  };
  syncDetail(product ? product.watchlistCount : undefined, on);
  try {
    // setWatch (functions/lib/watch.js) writes listings/{id}/watchers/{uid},
    // the users/{uid}.watchlist mirror and watchlistCount in ONE transaction,
    // so the count can't drift and a user can like a listing exactly once.
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const res = await httpsCallable(getFunctions(), 'setWatch')({ listingId: id, on });
    const r = (res && res.data) || {};
    const liked = !!r.on;
    if (liked) { fav.add(productId); fav.add(id); } else { fav.delete(productId); fav.delete(id); fav.delete(Number(id)); }
    if (product && typeof r.count === 'number') product.watchlistCount = r.count;
    window.paintFav(id, liked, typeof r.count === 'number' ? r.count : null);
    syncDetail(typeof r.count === 'number' ? r.count : undefined, liked);
    if (liked && r.changed) {
      const askNow = product ? Number(product.ask || 0) : 0;
      // Meta Pixel: wishlist ADD only (removals deliberately untracked).
      window.fbTrack && window.fbTrack('AddToWishlist', { content_ids: [id], content_type: 'product', value: askNow, currency: 'USD' });
      // r286: tell the seller someone liked their listing (fire-and-forget —
      // it re-checks the watchlist server-side and skips self-likes).
      (async () => {
        try { await httpsCallable(getFunctions(), 'notifyLike')({ listingId: id }); }
        catch (e) { console.warn('notifyLike failed (non-fatal)', e); }
      })();
      // Contextual push prompt — first item added to watchlist.
      setTimeout(() => { try { window.maybePromptForPush && window.maybePromptForPush('first-watchlist'); } catch (_e) {} }, 1500);
    }
  } catch (e) {
    // Roll back the optimistic state.
    if (wasLiked) { fav.add(productId); fav.add(id); } else { fav.delete(productId); fav.delete(id); fav.delete(Number(id)); }
    if (product && prevCount !== null) product.watchlistCount = prevCount;
    window.paintFav(id, wasLiked, prevCount);
    syncDetail(prevCount === null ? undefined : prevCount, wasLiked);
    console.error('toggleWatch failed:', e);
    const code = (e && e.code) || '';
    showToast(/not-found/.test(code) ? 'That listing is no longer available.' : 'Could not update likes. Check your connection and try again.');
  }
}

async function openWatchlistBase() {
  if (typeof window.requireAuth === 'function') {
    if (!window.requireAuth('to view your liked items', () => openWatchlistBase())) return;
  } else if (!window.CURRENT_USER) {
    showToast('Sign in to view your liked items.');
    return;
  }
  // Reuse the search overlay to display
  document.getElementById('searchOverlay').classList.add('open');
  const results = document.getElementById('searchResults');
  // The overlay now opens before the Firestore read — blank any stale
  // typeahead results so they can't flash while the watchlist loads.
  results.style.display = '';
  results.innerHTML = '';
  await renderWatchlistInto(results);
}

// r186: render half of openWatchlist, extracted so the Activity hub's
// Likes segment can render into its own container (the standalone flow
// borrows #searchResults, which Activity must not touch). ctaAction lets
// the empty-state CTA do the right thing per context.
async function renderWatchlistInto(results, ctaAction) {
  const watch = await loadWatchlist();
  const ids = Object.keys(watch);
  const items = ids.map(id => window.PRODUCTS.find(p => String(p.id) === id)).filter(Boolean);
  results.style.display = '';
  if (!items.length) {
    results.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-state-icon">' + (window.ICONS && window.ICONS.heart || '') + '</div>' +
        '<h3 class="empty-state-title">No saved items yet</h3>' +
        '<p class="empty-state-sub">Open any listing and <strong>double-tap the photo</strong> to save it here for later.</p>' +
        '<button class="empty-state-cta" data-action="' + (ctaAction || 'close-watchlist-browse') + '" type="button">Browse listings</button>' +
      '</div>';
    return;
  }
  results.innerHTML = items.map(p => {
    const id = window.safeId(p.id);
    const url = window.safeImgUrl(p.photos && p.photos[0]);
    const img = url
      ? `<img src="${window.safeAttr(url)}" alt="${window.safeAttr(p.name||'')}" loading="lazy" decoding="async" />`
      : `<span class="placeholder-art" style="width:100%;height:100%;border-radius:6px">${window.CATEGORY_ICON(p.cat)}</span>`;
    const verifiedSlot = p.sellerId
      ? `<span class="seller-verified-slot" data-seller-id="${window.safeAttr(window.safeId(p.sellerId))}"></span>`
      : '';
    return `<div class="search-result-item" data-action="open-detail-from-search" data-product-id="${window.safeAttr(id)}">`+
      `<div class="search-res-img">${img}</div>`+
      `<div><div class="search-res-name">${window.safeText(p.name)}${verifiedSlot}</div><div class="search-res-cat">${window.safeText(p.brand)} · ${window.safeText(p.cat)}</div></div>`+
      `<span class="search-res-price">$${Number(p.ask||0).toLocaleString()}</span>`+
    `</div>`;
  }).join('');
  hydrateVerifiedSellerPills(results);
}

// ─────────────────────────────────────────────────────────────
// SELLER REVIEWS ON LISTING DETAIL
//   Loads the seller's review aggregate + last 3 reviews into the
//   listing detail modal so buyers see trust signal before they
//   tap into the seller's profile.
// ─────────────────────────────────────────────────────────────
async function loadDetailReviews(p) {
  const el = document.getElementById('detailReviews');
  if (!el) return;
  el.innerHTML = '';
  if (!p || !p.sellerId) return;
  let agg;
  try {
    if (typeof window.loadUserReviews === 'function') {
      agg = await window.loadUserReviews(p.sellerId);
    }
  } catch (_e) { agg = null; }
  if (!agg || !agg.count) {
    // r175: no reviews → render nothing. The seller row carries the positive
    // signal (join month, sales, active-listing count); a "no reviews yet"
    // card was negative space at the decision point.
    return;
  }
  const stars = (n) => {
    const full = Math.round(n);
    let s = '';
    for (let i = 0; i < 5; i++) s += i < full ? '★' : '☆';
    return s;
  };
  const items = (agg.items || []).slice(0, 3).map(r => {
    const date = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate() : null;
    const when = date ? date.toLocaleDateString(undefined, {month: 'short', year: 'numeric'}) : '';
    const safe = (s) => window.safeText ? window.safeText(s) : String(s || '');
    const comment = r.comment ? `<div style="font-size:13.5px;color:var(--gray-700);line-height:1.5;margin-top:4px;">${safe(r.comment).slice(0, 200)}${(r.comment||'').length > 200 ? '…' : ''}</div>` : '';
    return `<div style="padding:10px 0;border-top:1px solid var(--gray-100);">
      <div style="display:flex;align-items:center;justify-content:space-between;font-size:12.5px;">
        <span style="color:var(--gold-500);letter-spacing:1px;">${stars(r.rating || 0)}</span>
        <span style="color:var(--gray-500);">${when}</span>
      </div>
      ${comment}
    </div>`;
  }).join('');
  el.innerHTML = `<div style="margin:18px 0 6px;padding:14px;background:var(--white);border:1px solid var(--gray-200);border-radius:var(--radius-md);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong style="font-size:14px;">Seller Reviews</strong>
      <span style="font-size:13px;color:var(--gray-700);">
        <span style="color:var(--gold-500);letter-spacing:1px;">${stars(agg.avg)}</span>
        ${agg.avg.toFixed(1)} (${agg.count})
      </span>
    </div>
    ${items}
  </div>`;
}
window.loadDetailReviews = loadDetailReviews;

// ─────────────────────────────────────────────────────────────
// PRICE HISTORY SPARKLINE
// ─────────────────────────────────────────────────────────────
let sparklineChart = null;
async function loadSparkline(p) {
  const canvas = document.getElementById('detailSparkline');
  if (!canvas || typeof Chart === 'undefined') return;
  const model = (p && (p.brand || '') + ' ' + (p.name || '')).trim();
  if (!model) { canvas.style.display = 'none'; return; }
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
    const snap = await getDoc(doc(db, 'priceHistory', slug));
    const data = snap.exists() ? (snap.data().sales || []) : [];
    if (data.length < 2) { canvas.style.display = 'none'; return; }
    canvas.style.display = 'block';
    if (sparklineChart) sparklineChart.destroy();
    const sorted = [...data].sort((a, b) => (a.t || 0) - (b.t || 0));
    sparklineChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: sorted.map(s => new Date(s.t).toLocaleDateString(undefined, {month:'short', day:'numeric'})),
        datasets: [{
          data: sorted.map(s => s.priceCents / 100),
          borderColor: 'var(--green-600)',
          backgroundColor: 'rgba(45,84,56,0.08)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => '$' + c.parsed.y.toLocaleString() } } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
  } catch (e) {
    canvas.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// PROFILES
// ─────────────────────────────────────────────────────────────
const PROFILE_CACHE = new Map();
// M2: 5-minute TTL. Without this, badge / Pro-status flips made via
// the Stripe webhook never surface to existing tabs (the buyer keeps
// seeing the stale "not Pro" cached entry until they navigate away).
// Five minutes is short enough that webhook lag (~seconds) plus a
// natural page interaction picks up the new value, and long enough
// to keep the cache useful for back-to-back loadProfile calls during
// a single feed render.
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
// Expose so the module-script signOut handler can clear stale profile
// data on logout. Different script types share the global window object
// even though they don't share lexical scope.
window.PROFILE_CACHE = PROFILE_CACHE;

// r325: four hydrators (verified pill, Pro pill, ratings, identity) each call
// loadProfile for every seller on the grid, in the same tick. Without this the
// cache can't help them — it is only written after a fetch resolves — so they
// relied on the Firestore SDK happening to coalesce identical targets. Share
// the in-flight promise explicitly instead.
const PROFILE_INFLIGHT = new Map();

async function loadProfile(uid) {
  if (!uid) return null;
  // M2: TTL check. Entries are stored as { data, fetchedAt }; legacy
  // un-wrapped entries (if any) are treated as expired and refetched.
  const cached = PROFILE_CACHE.get(uid);
  if (cached && cached.fetchedAt &&
      (Date.now() - cached.fetchedAt) < PROFILE_CACHE_TTL_MS) {
    // A entry cached before auth resolved carries no users/{uid} data. If it
    // turns out to be the signed-in user's own profile, refetch so their own
    // payout state and verification flags aren't served from the public view.
    const stalePartial = cached.data && cached.data._partial &&
      window.CURRENT_USER && window.CURRENT_USER.uid === uid;
    if (!stalePartial) return cached.data;
  }
  const inflight = PROFILE_INFLIGHT.get(uid);
  if (inflight) return inflight;
  const run = (async () => {
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // r325: users/{uid} is `allow read: if request.auth.uid == userId` —
    // STRICTLY self-only (firestore.rules). Reading it for a seller who isn't
    // you is a guaranteed permission-denied round trip, and the home grid was
    // doing six of them on every cold load. Only ask for your own.
    const isSelf = !!(window.CURRENT_USER && window.CURRENT_USER.uid === uid);
    const [pSnap, uSnap] = await Promise.all([
      getDoc(doc(db, 'profiles', uid)),
      isSelf ? getDoc(doc(db, 'users', uid)).catch(() => null) : Promise.resolve(null),
    ]);
    const data = pSnap.exists() ? { id: pSnap.id, ...pSnap.data() } : { id: uid };
    // `isPro` is mirrored onto profiles/{uid} by the subscription webhook,
    // since users/{uid} is read:self-only and can't be seen by buyers.
    const isPro = pSnap.exists() && pSnap.data() && pSnap.data().isPro === true;
    if (uSnap && uSnap.exists && uSnap.exists()) {
      const u = uSnap.data() || {};
      data._user = {
        sellerVerified: u.sellerVerified === true,
        phone: !!u.phone,
        email: !!u.email,
        // Prefer the private flag for the signed-in user (it's the source
        // of truth); fall back to the public mirror for everyone else.
        isPro: u.tier === 'pro' || isPro,
      };
      // stripeChargesEnabled is self-only readable per firestore.rules
      // — only the signed-in user will get a value here. We hoist it
      // onto the profile object so the "Manage payouts" button can
      // surface conditionally without a second round-trip.
      data.stripeChargesEnabled = u.stripeChargesEnabled === true;
    } else {
      data._user = { sellerVerified: false, phone: false, email: false, isPro };
      data.stripeChargesEnabled = false;
      // r193/r325: no users-doc data here, either because we deliberately
      // skipped the read (not your uid — rules forbid it) or because the read
      // for your own doc failed. Mark the entry PARTIAL so it can still be
      // cached and shared: the TTL check above refetches it the moment auth
      // resolves and the uid turns out to be yours. Caching an unmarked
      // negative used to poison self-views for 5 minutes — false "Finish
      // payout setup" nag, hidden Manage-payouts button, dropped own badges.
      data._partial = true;
      if (window.CURRENT_USER && window.CURRENT_USER.uid === uid) {
        return data;  // own doc, read genuinely failed — never cache that
      }
    }
    PROFILE_CACHE.set(uid, { data, fetchedAt: Date.now() });
    return data;
  } catch (e) {
    console.error('loadProfile failed:', e);
    return { id: uid, _user: { sellerVerified: false, phone: false, email: false, isPro: false } };
  }
  })();
  PROFILE_INFLIGHT.set(uid, run);
  try { return await run; } finally { PROFILE_INFLIGHT.delete(uid); }
}

// Compact, buyer-safe seller meta line for the listing-detail identity row.
// PUBLIC fields ONLY: sold count, rating, member-since, Pro, Verified,
// Fast-responder. NEVER email/phone/totalRevenue/stripeChargesEnabled (those
// are owner-only on users/{uid} and loadProfile null-stubs them for buyers).
function sellerMetaHtml(prof) {
  if (!prof) return '';
  const parts = [];
  const sales = (typeof prof.salesCount === 'number') ? prof.salesCount : 0;
  parts.push(sales > 0
    ? `<span><strong>${Number(sales)}</strong> sold</span>`
    : `<span>New seller</span>`);
  const reviews = (typeof prof.reviewCount === 'number') ? prof.reviewCount : 0;
  const avg = (typeof prof.avgRating === 'number') ? prof.avgRating : 0;
  if (reviews > 0 && avg > 0) {
    parts.push(`<span><span class="sid-star">&#9733;</span> ${avg.toFixed(1)} (${Number(reviews)})</span>`);
  }
  // Member-since (public profiles.createdAt, when present).
  let joined = null;
  const c = prof.createdAt;
  if (c && typeof c.toDate === 'function') joined = c.toDate();
  else if (c && c._seconds) joined = new Date(c._seconds * 1000);
  if (joined && !isNaN(joined)) {
    parts.push(`<span>Since ${window.safeText(joined.toLocaleDateString(undefined, {month: 'short', year: 'numeric'}))}</span>`);
  }
  let html = parts.join('<span class="sid-dot">&middot;</span>');
  // Pills. _user.isPro = public isPro mirror; _user.sellerVerified is owner-only
  // (so the Verified pill only shows on the seller's own view — existing behavior).
  if (prof._user && prof._user.isPro) html += ` <span class="pro-pill sm">Pro</span>`;
  if (prof._user && prof._user.sellerVerified) html += (' ' + window.VERIFIED_BADGE);
  // Fast-responder badge — SURFACE ONLY. Shows when a backend job has set
  // profiles/{uid}.fastResponder=true. That aggregate (median reply time from
  // conversations) is a SEPARATE backend task, flagged — not built here.
  if (prof.fastResponder === true) {
    html += ` <span class="responder-pill" title="Typically replies quickly">Fast responder</span>`;
  }
  return html;
}
window.sellerMetaHtml = sellerMetaHtml;

function profileInitial(p) {
  const s = (p && (p.displayName || p.id) || '').trim();
  return s ? s[0].toUpperCase() : '?';
}

// r266: resolve an avatar to the w96/w256 WebP derivative written by the
// optimizeAvatar Storage trigger. Keyed by BASENAME (the {Date.now()}
// filename minus its extension), which is how the trigger writes it, so a
// re-upload can never be served the previous avatar's derivative. Falls back
// to the original for avatars uploaded before the trigger existed, for
// external Auth photoURLs, and for anything the backfill skipped.
window.avatarVariantUrl = function (p, size) {
  const orig = p && p.avatarUrl;
  if (!orig || typeof orig !== 'string') return window.safeImgUrl(orig);
  const v = p.avatarVariants;
  if (v) {
    const m = orig.match(/\/o\/([^?]+)/);
    if (m) {
      try {
        const base = decodeURIComponent(m[1]).split('/').pop().replace(/\.[^.]+$/, '');
        const hit = v[base] && v[base][size];
        if (hit) { const u = window.safeImgUrl(hit); if (u) return u; }
      } catch (_e) { /* malformed URL → fall through to the original */ }
    }
  }
  return window.safeImgUrl(orig);
};

// `size` defaults to w96, which covers every slot rendered at <= 48 CSS px
// (card 20px, msg 28px, chat header 40px, seller id 40px) through 2x. The
// 88px .profile-avatar passes 'w256'.
// r289 — the confetti Logo Bingo fires on a solve, reusable. A sale is the
// single best thing that happens on this platform and it landed with no
// acknowledgement at all; now it gets the same burst.
window.teeboxConfetti = function teeboxConfetti(n) {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const burst = document.createElement('div');
    burst.className = 'bingo-confetti';
    const colors = ['#2d5438', '#c9991e', '#3a6b47', '#e0b840', '#22402b'];
    const N = n || 14;
    let html = '';
    for (let i = 0; i < N; i++) {
      const left = Math.round(Math.random() * 100);
      const color = colors[i % colors.length];
      const delay = (Math.random() * 0.4).toFixed(2);
      const dur = (1.6 + Math.random() * 0.6).toFixed(2);
      html += `<span style="left:${left}vw;background:${color};animation-duration:${dur}s;animation-delay:${delay}s;"></span>`;
    }
    burst.innerHTML = html;
    document.body.appendChild(burst);
    setTimeout(() => burst.remove(), 2400);
  } catch (_e) { /* a celebration must never break a sale */ }
};

// r289 — nobody-has-a-photo used to mean a grey letter. Only 7 of 333 members
// have uploaded an avatar, so the grey letter IS the product for almost
// everyone. Each member now gets a little caddie on a colour picked
// deterministically from their uid, so the same person is the same colour
// everywhere and two members in a thread never collide by accident.
const CADDIE_COLORS = [
  '#2d5438', '#1f4d5c', '#4a3d6b', '#7a4a2e', '#8a6d1f',
  '#3a6b47', '#2b5a7a', '#5c3a52', '#6b5330', '#40584a',
];
function caddieColorFor(id) {
  const str = String(id || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return CADDIE_COLORS[Math.abs(h) % CADDIE_COLORS.length];
}
// A stick caddie in a bib, reduced to what still reads at 28px: head,
// shoulders, bib. The full .caddie-figure is 76x84 with a golf bag and turns
// to mush at avatar size.
const CADDIE_MARK =
  '<svg class="avatar-caddie" viewBox="0 0 32 32" aria-hidden="true">' +
    '<circle cx="16" cy="11" r="4.6"/>' +
    '<path d="M6.5 27.5c0-5.3 4.3-8.8 9.5-8.8s9.5 3.5 9.5 8.8z"/>' +
    '<rect class="avatar-caddie-bib" x="12.7" y="19.9" width="6.6" height="7.6" rx="1.4"/>' +
  '</svg>';

function avatarHtml(p, size) {
  const initial = window.safeText(profileInitial(p));
  const u = window.avatarVariantUrl(p, size || 'w96');
  if (u) {
    // The initial renders instantly as the placeholder; the photo loads EAGERLY
    // (was loading="lazy", which deferred the fetch and caused the late pop) and
    // fades in over the initials via hydrateAvatars(). The signed-in user's own
    // avatar is also cache-warmed at sign-in (preloadOwnAvatar), so opening
    // their own profile is instant.
    return `<span class="avatar-initial" aria-hidden="true">${initial}</span>` +
      `<img src="${window.safeAttr(u)}" alt="" loading="eager" fetchpriority="high" decoding="async" class="avatar-img" />`;
  }
  // No photo → the caddie, on this member's own colour.
  return `<span class="avatar-caddie-wrap" style="background:${caddieColorFor(p && p.id)}" ` +
    `title="${initial}">${CADDIE_MARK}</span>`;
}

// Perf: reveal avatar images with a fade once they actually load. Inline
// onload on innerHTML-inserted <img> proved unreliable, so we wire it in JS
// after render. If the image is already complete (cache), reveal immediately;
// otherwise reveal on load/error. A 2s CSS animation backstop (see
// .avatar-img) guarantees an avatar can never stay hidden if this is missed.
function hydrateAvatars(root) {
  try {
    (root || document).querySelectorAll('img.avatar-img:not(.avatar-loaded)').forEach((img) => {
      if (img.complete && img.naturalWidth > 0) { img.classList.add('avatar-loaded'); return; }
      const reveal = () => img.classList.add('avatar-loaded');
      img.addEventListener('load', reveal, { once: true });
      img.addEventListener('error', reveal, { once: true });
    });
  } catch (_e) { /* never block render on the fade hook */ }
}

// Perf: cap an uploaded avatar to AVATAR_MAX px on its longest side and
// re-encode as JPEG, so we never store a multi-MB phone photo for an 88px
// circle. Uses createImageBitmap with imageOrientation:'from-image' so EXIF
// rotation is baked in correctly. Bulletproof fallbacks: any failure, a
// non-image, an already-small image, or a re-encode that wouldn't shrink all
// return the ORIGINAL file unchanged — the upload flow can never break here.
async function downscaleAvatar(file, AVATAR_MAX = 512) {
  try {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    if (typeof createImageBitmap !== 'function') return file;
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    if (!bmp) return file;
    const longest = Math.max(bmp.width, bmp.height);
    const scale = Math.min(1, AVATAR_MAX / longest);
    // r269: ALWAYS re-encode, even when the image is already under AVATAR_MAX.
    // This used to `return file` unchanged on the small-enough path, which
    // meant a small camera photo skipped the canvas entirely and reached
    // Storage with its EXIF intact — that is exactly how two live avatars
    // ended up carrying Apple camera identity. The canvas draw is what strips
    // metadata, so it has to run unconditionally. Belt and suspenders with the
    // server-side strip in optimizeAvatar.
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close && bmp.close(); return file; }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    // r269: fall back to the original ONLY if the canvas produced nothing.
    // The old check also bailed when the re-encode wasn't smaller, which
    // silently handed back the metadata-bearing original for the sake of a few
    // KB. A stripped file that is marginally larger is the correct trade.
    if (!blob) return file;
    const base = (file.name || 'avatar').replace(/\.[^.]+$/, '');
    return new File([blob], base + '.jpg', { type: 'image/jpeg' });
  } catch (_e) {
    return file;
  }
}

async function openProfile(uid) {
  if (!uid) {
    // Self-profile but no signed-in user → use the polished prompt.
    if (typeof window.requireAuth === 'function') {
      window.requireAuth('to view your profile');
    } else {
      showToast('Sign in to view your profile.');
    }
    return;
  }
  window.__lastProfileUid = uid;
  const back = document.getElementById('profileBackdrop');
  // Perf: for the signed-in user's OWN profile, paint the avatar + name into
  // the skeleton INSTANTLY from the in-memory cache that preloadOwnAvatar /
  // checkSellerStatus warmed at sign-in. Without this the avatar didn't render
  // until renderProfileView fired — which waits on all four profile reads in
  // the Promise.all below — so a user opening their own profile watched a grey
  // shimmer where their picture should be. The image is already in the HTTP
  // cache (preloadOwnAvatar), so it shows with no network round-trip.
  const _isOwnProfile = !!(window.CURRENT_USER && window.CURRENT_USER.uid === uid);
  // Fall back to Firebase Auth's own photoURL/displayName when the profile
  // caches haven't warmed yet (cold start, or a tap right after sign-in
  // before preloadOwnAvatar/checkSellerStatus resolve). These come off the
  // in-memory auth user with zero network, so the identity paints instantly
  // instead of shimmering until all four profile reads finish.
  const _cachedAvatar = _isOwnProfile
    ? window.safeImgUrl(window.CURRENT_PROFILE_AVATAR || (window.CURRENT_USER && window.CURRENT_USER.photoURL) || '')
    : '';
  const _cachedName = _isOwnProfile
    ? (window.CURRENT_PROFILE_NAME || (window.CURRENT_USER && window.CURRENT_USER.displayName) || '')
    : '';
  const _skelAvatar = _cachedAvatar
    ? '<div class="ps-avatar" style="overflow:hidden;position:relative;border-radius:50%;">' +
        '<img src="' + window.safeAttr(_cachedAvatar) + '" alt="" decoding="async" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" /></div>'
    : '<div class="ps-avatar skeleton-shimmer"></div>';
  const _skelName = _cachedName
    ? '<div class="ps-bar" style="width:auto;height:22px;display:flex;align-items:center;font-family:var(--font-display);font-weight:700;font-size:20px;color:var(--gray-900)">' + window.safeText(_cachedName) + '</div>'
    : '<div class="ps-bar skeleton-shimmer" style="width:62%;height:22px"></div>';
  // Perf: a layout-matching skeleton instead of bland "Loading profile…" text,
  // so the modal feels responsive while the four profile reads resolve.
  document.getElementById('profileBody').innerHTML =
    '<div class="profile-skel">' +
      '<div class="ps-head">' + _skelAvatar +
        '<div class="ps-lines">' + _skelName +
        '<div class="ps-bar skeleton-shimmer" style="width:40%;height:14px"></div></div></div>' +
      '<div class="ps-stats"><div class="ps-stat skeleton-shimmer"></div><div class="ps-stat skeleton-shimmer"></div><div class="ps-stat skeleton-shimmer"></div></div>' +
      '<div class="ps-grid">' + '<div class="ps-card skeleton-shimmer"></div>'.repeat(6) + '</div>' +
    '</div>';
  back.classList.add('open');
  document.getElementById('profileModalTitle').textContent =
    (window.CURRENT_USER && window.CURRENT_USER.uid === uid) ? 'Your Profile' : 'Profile';

  // r290 — the fresh self-read below used to run AFTER this Promise.all
  // resolved, so opening YOUR OWN profile cost two sequential round trips
  // before anything past the skeleton painted. That is the lag: it only ever
  // affected your own profile, which is exactly where it was reported. It is
  // still a fresh read (never the cache), just started at the same time as
  // the other four instead of queued behind them.
  const _selfFresh = (window.CURRENT_USER && window.CURRENT_USER.uid === uid)
    ? (async () => {
        try {
          const { getFirestore, doc, getDoc } =
            await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
          return await getDoc(doc(getFirestore(), 'users', uid));
        } catch (_e) { return null; }
      })()
    : Promise.resolve(null);
  const [profile, listings, reviews, recentSold, _usSnap] = await Promise.all([
    loadProfile(uid),
    loadProfileListings(uid),
    loadSellerReviews(uid),
    loadRecentSoldOrders(uid),
    _selfFresh,
  ]);
  // r193: self-view renders owner-only state (payout nag, Manage payouts,
  // own badges) — re-read it FRESH here, same read-fresh rule as the sell
  // gate, so a stale or pre-auth-poisoned cache entry can never mis-render.
  // One extra getDoc on a rare, user-initiated open. Mutating `profile`
  // in place also heals the cached entry.
  if (window.CURRENT_USER && window.CURRENT_USER.uid === uid && profile) {
    try {
      const us = _usSnap;
      if (us && us.exists()) {
        const u = us.data() || {};
        profile.stripeChargesEnabled = u.stripeChargesEnabled === true;
        profile._user = {
          sellerVerified: u.sellerVerified === true,
          phone: !!u.phone,
          email: !!u.email,
          isPro: u.tier === 'pro' || !!(profile._user && profile._user.isPro),
        };
      }
    } catch (_e) { /* best-effort — render with what we have */ }
  }
  renderProfileView(profile, listings, reviews, recentSold);
}

async function loadProfileListings(uid) {
  try {
    const { getFirestore, collection, query, where, getDocs, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // Cap public profile views — popular sellers can have hundreds of
    // listings; we display 24 active + 12 sold above the fold. Pagination
    // is a follow-up if/when we hit the cap.
    const snap = await getDocs(query(
      collection(db, 'listings'),
      where('sellerId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(200)
    ));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('loadProfileListings failed:', e);
    return [];
  }
}

function renderProfileView(profile, listings, reviews, recentSold) {
  const isMe = window.CURRENT_USER && window.CURRENT_USER.uid === profile.id;
  // Public storefront: hide moderation-held (flagged) listings from buyers, but
  // keep them visible to the owner viewing their own profile so they know a
  // listing is under review. (Owners also manage these from My Shop.)
  // Visibility is an ALLOWLIST, not a blocklist. This was
  // `status !== 'sold' && (isMe || status !== 'flagged')`, which let every
  // other status through — so expired listings (and draft/removed/anything
  // added later) rendered on PUBLIC profiles as if they were live. The main
  // listings feed already filters correctly; profiles did not.
  //
  // Public sees strictly 'active'. The owner also sees their own expired
  // listings, muted and badged, so they can find and renew them.
  const isListingExpired = (l) => {
    if (l.status === 'expired') return true;
    const exp = l.expiresAt && l.expiresAt.toDate ? l.expiresAt.toDate() : null;
    return !!(exp && exp < new Date() && l.status !== 'sold');
  };
  const active = listings.filter(l => {
    if (l.status === 'sold') return false;
    if (l.status === 'active' && !isListingExpired(l)) return true;
    // Owner-only extras: expired (so they can renew) and flagged (so they
    // know something is under review — preserving the original intent of
    // the `isMe || status !== 'flagged'` clause this replaced).
    // r348: + hidden (list-first auto-pause) so the owner can see what's
    // paused and relist by finishing payouts.
    return isMe && (isListingExpired(l) || l.status === 'flagged' || l.status === 'hidden');
  });
  const sold = listings.filter(l => l.status === 'sold');
  recentSold = recentSold || [];
  // Build a quick lookup so the recent-sold feed can hydrate listing titles/photos
  // even for listings that have since been removed (use what's saved on the order).
  const listingsById = {};
  listings.forEach(l => { listingsById[l.id] = l; });

  const joinedDate = profile.createdAt && profile.createdAt.toDate
    ? profile.createdAt.toDate()
    : null;
  const joinedShort = joinedDate
    ? joinedDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : null;
  reviews = reviews || { count: 0, avg: 0, items: [] };

  // Verification badges (Feature #3) — read from data._user populated by loadProfile
  const u = profile._user || { sellerVerified: false, phone: false, email: false, isPro: false };
  let badges = '';
  if (u.isPro) {
    badges += `<span class="pro-pill" title="Pro Seller">Pro Seller</span>`;
  }
  if (u.sellerVerified) {
    badges += (window.VERIFIED_BADGE + ' <span style="font-size:12px;font-weight:700;color:#9c6f14;vertical-align:middle">Verified Seller</span>');
  }
  if (u.phone) {
    badges += `<span class="verify-icon" title="Phone verified">Phone</span>`;
  }
  if (u.email) {
    badges += `<span class="verify-icon" title="Email verified">Email</span>`;
  }

  // Persistent payout-completion nudge — ON THE SELLER'S OWN STOREFRONT ONLY.
  // Reads the owner-only stripeChargesEnabled that loadProfile hoists for the
  // signed-in user viewing themselves (for any OTHER profile it's false/absent
  // AND isMe is false, so a seller's payout state is never exposed to others).
  // Shows until resolved (no dismiss); list-first is preserved — this never
  // blocks listing, it just makes the unfinished-setup state impossible to miss.
  const _ownChargesReady = (profile.stripeChargesEnabled === true);
  const _isSellerSelf = isMe && (u.sellerVerified || active.length > 0 || sold.length > 0);
  // r290 — this nudge used to talk only about getting paid and never named
  // the badge, so a seller had no way to learn that "Verified Seller" IS
  // this step: it means Stripe KYC complete and nothing else. 14 of 333
  // members have accepted seller terms; the badge is what buyers scan for,
  // so naming the reward is the point. Gating is unchanged — we still only
  // nudge people who actually sell, never every browsing member.
  const payoutNudgeHtml = (_isSellerSelf && !_ownChargesReady)
    ? `<div class="stripe-connect-banner warn" style="margin-bottom:16px;" role="status">`+
        `<div>`+
          `<strong>Finish payout setup to become a Verified Seller</strong>`+
          `<span>Your listings are visible, but buyers can't complete a purchase until you connect Stripe — and the gold <strong>Verified Seller</strong> badge buyers look for on a listing is exactly this step, nothing more. About 2 minutes.</span>`+
        `</div>`+
        `<button class="btn-stripe-connect" data-action="stripe-connect" type="button">Get verified</button>`+
      `</div>`
    : '';

  // Prominent stats row (Feature #8) — uses Cloud-Function-written aggregates with
  // graceful fallback to client-side counts.
  const salesCount = (typeof profile.salesCount === 'number') ? profile.salesCount : sold.length;
  const reviewCount = (typeof profile.reviewCount === 'number') ? profile.reviewCount : reviews.count;
  const avgRating = (typeof profile.avgRating === 'number') ? profile.avgRating : reviews.avg;
  const headlineParts = [];
  headlineParts.push(salesCount > 0
    ? `<span class="ph-strong">${salesCount}</span> sold`
    : `<span>New seller</span>`);
  if (joinedShort) headlineParts.push(`Member since ${window.safeText(joinedShort)}`);
  if (reviewCount > 0) {
    headlineParts.push(`<span class="ph-star">★</span> <span class="ph-strong">${avgRating.toFixed(1)}</span> (${reviewCount} reviews)`);
  } else {
    headlineParts.push(`<span class="ph-star">★</span> No reviews yet`);
  }
  const headlineStats = `<div class="profile-headline-stats">${headlineParts.join('<span class="ph-dot"> · </span>')}</div>`;

  const handicap = (typeof profile.handicap === 'number')
    ? `<div class="profile-stat"><span class="profile-stat-n">${Number(profile.handicap)}</span><span class="profile-stat-l">Handicap</span></div>`
    : '';
  const location = profile.location
    ? `<div class="profile-stat"><span class="profile-stat-n">${window.safeText(profile.location)}</span><span class="profile-stat-l">Location</span></div>`
    : '';
  const bio = profile.bio
    ? `<div class="profile-section"><h4>About</h4><div class="profile-bio">${window.safeText(profile.bio)}</div></div>`
    : '';

  // Pinned/featured listing (Feature #7) — render at the top if pinnedListingId
  // matches one of this seller's currently-active listings.
  let featuredHtml = '';
  let pinnedListing = null;
  if (profile.pinnedListingId) {
    // `active` now also carries the owner's expired listings, so re-check:
    // a stale pin must never render an expired item as the featured card.
    pinnedListing = active.find(l =>
      l.id === profile.pinnedListingId && !isListingExpired(l)) || null;
  }
  if (pinnedListing) {
    const pid = window.safeId(pinnedListing.id);
    const purl = window.safeImgUrl(pinnedListing.photos && pinnedListing.photos[0]);
    const pimg = purl
      ? `<img src="${window.safeAttr(purl)}" alt="${window.safeAttr(pinnedListing.title || '')}" loading="lazy" decoding="async" />`
      : `<div class="placeholder-art" style="width:100%;height:100%">${window.CATEGORY_ICON(pinnedListing.cat)}</div>`;
    featuredHtml = `
      <div class="profile-section">
        <h4>Featured Listing</h4>
        <div class="featured-listing" data-action="open-detail" data-product-id="${pid}">
          <div class="featured-listing-img">${pimg}</div>
          <div class="featured-listing-body">
            <span class="featured-badge">Featured</span>
            <div class="featured-listing-title">${window.safeText(pinnedListing.title || '')}</div>
            <div class="featured-listing-price">$${Number(pinnedListing.ask || 0).toLocaleString()}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Active listings grid — pinned card gets a small indicator + isMe gets
  // pin/unpin buttons inline.
  const listingsHtml = active.length
    ? active.map(l => {
        const id = window.safeId(l.id);
        const url = window.safeImgUrl(l.photos && l.photos[0]);
        const img = url
          ? `<img src="${window.safeAttr(url)}" alt="${window.safeAttr(l.title||'')}" loading="lazy" decoding="async" />`
          : `<div class="placeholder-art" style="width:100%;height:100%">${window.CATEGORY_ICON(l.cat)}</div>`;
        const isPinned = profile.pinnedListingId === l.id;
        const expired = isListingExpired(l);
        const pinIndicator = isPinned ? `<span class="pin-indicator" title="Featured">Featured</span>` : '';
        const expiredBadge = expired ? `<span class="expired-badge">Expired</span>` : '';
        const hiddenCard = l.status === 'hidden';
        const hiddenBadge = hiddenCard ? `<span class="hidden-badge" title="Paused until payouts are set up">Paused — set up payouts</span>` : '';
        // An expired listing can't be pinned — it isn't purchasable, so
        // featuring it on the profile would advertise a dead link.
        const pinBtn = (isMe && !expired)
          ? `<button class="pin-btn ${isPinned ? 'pinned' : ''}" data-action="${isPinned ? 'unpin-listing' : 'pin-listing'}" data-listing-id="${id}" type="button">${isPinned ? 'Unpin' : 'Pin to profile'}</button>`
          : '';
        return `<div class="profile-listing ${isPinned ? 'pinned-card' : ''}${expired ? ' is-expired' : ''}${hiddenCard ? ' is-hidden' : ''}" data-action="open-detail" data-product-id="${id}" style="position:relative">`+
          pinIndicator + expiredBadge + hiddenBadge +
          `<div class="profile-listing-img">${img}${(!expired && !hiddenCard && window.favButtonHtml) ? window.favButtonHtml(l, 'card-fav') : ''}</div>`+
          `<div class="profile-listing-name">${window.safeText(l.title || '')}</div>`+
          `<div class="profile-listing-price">$${Number(l.ask||0).toLocaleString()}</div>`+
          (pinBtn ? `<div style="margin-top:6px">${pinBtn}</div>` : '') +
        `</div>`;
      }).join('')
    : '<div class="profile-loading" style="padding:1.5rem">No active listings.</div>';

  // Golf bag (Feature #6) — only render if profile has at least one club.
  let bagHtml = '';
  const bag = Array.isArray(profile.golfBag)
    ? profile.golfBag.filter(s => typeof s === 'string' && s.trim()).slice(0, 14)
    : [];
  if (bag.length) {
    const chips = bag.map(c => `<div class="bag-chip">${window.safeText(c.trim())}</div>`).join('');
    bagHtml = `
      <div class="profile-section">
        <h4>What's in the bag</h4>
        <div class="bag-row">${chips}</div>
      </div>
    `;
  }

  // Recently sold feed (Feature #9) — privacy: do NOT show buyer info.
  let recentSoldHtml = '';
  if (recentSold.length) {
    const rows = recentSold.map(o => {
      const listing = listingsById[o.listingId] || {};
      const title = listing.title || o.listingTitle || 'Sold item';
      const url = window.safeImgUrl((listing.photos && listing.photos[0]) || o.listingPhotoUrl);
      const thumb = url
        ? `<img src="${window.safeAttr(url)}" alt="" loading="lazy" decoding="async" />`
        : `<div class="placeholder-art" style="width:100%;height:100%">${window.CATEGORY_ICON(listing.cat)}</div>`;
      const dlv = o.deliveredAt && o.deliveredAt.toDate ? o.deliveredAt.toDate() : null;
      const when = dlv ? 'Sold ' + relativeTimeFromDate(dlv) : 'Sold';
      const linkable = listingsById[o.listingId] && listingsById[o.listingId].id;
      const dataAction = linkable ? `data-action="open-detail" data-product-id="${window.safeId(linkable)}"` : '';
      const price = (typeof o.amount === 'number')
        ? `<div class="sold-feed-price">$${Number(o.amount).toLocaleString()}</div>`
        : '';
      return `<div class="sold-feed-row" ${dataAction}>
        <div class="sold-feed-thumb">${thumb}</div>
        <div class="sold-feed-info">
          <div class="sold-feed-title">${window.safeText(title)}</div>
          <div class="sold-feed-meta">${window.safeText(when)}</div>
        </div>
        ${price}
      </div>`;
    }).join('');
    recentSoldHtml = `
      <div class="profile-section">
        <h4>Recently Sold</h4>
        <div class="sold-feed">${rows}</div>
      </div>
    `;
  }

  // Apple Review 5.1.1(v): Delete Account must be discoverable WITHOUT
  // scrolling on iPad Air landscape. Profile-actions (Edit/Sign Out/Delete)
  // render right under the header, BEFORE the account-hub list. Build 18
  // was rejected because Delete Account sat below the hub.
  //
  // r186 (2026-08-02 UI audit, approved deviation): the audit asked for
  // Delete Account "at the bottom of Profile → Settings under an Account
  // section". DO NOT do that — it is exactly the build-18 rejection. The
  // r186 change removed the app DRAWER entry only (CSS gated body.is-native);
  // this profile-actions placement is the Apple-accepted slot and stays.
  //
  // GDPR Art. 20: "Download my data" sits in the same actions block so
  // the export option is just as discoverable as the deletion option —
  // privacy.html:219 promises both. Manage payouts shows conditionally
  // when the seller has finished Stripe Connect KYC (stripeChargesEnabled).
  const showManagePayouts = isMe && profile.stripeChargesEnabled === true;
  const profileActionsHtml = isMe
    ? `<div class="profile-actions" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;">
         <button class="btn-full green" data-action="edit-profile">Edit Profile</button>
         <button class="btn-full ghost" data-action="sign-out">Sign Out</button>
         ${showManagePayouts ? `<button class="btn-full ghost" data-action="manage-payouts" style="grid-column:1/-1;">Manage payouts</button>` : ''}
         <!-- r275: toned down from the tinted red block to a quiet text row.
              POSITION IS DELIBERATE AND MUST NOT MOVE — see the "Approved
              deviation" note in .internal-docs/APP_UI_AUDIT_2026-08-02.md:
              moving Delete Account to the bottom of the profile got build 18
              REJECTED under Apple 5.1.1(v), which wants it discoverable
              WITHOUT SCROLLING (checked on iPad Air landscape). Restyling is
              safe because the guideline is about findability, not emphasis;
              relocating it is not. -->
         <button class="btn-full delete-account-link" data-action="open-delete-account" style="grid-column:1/-1;">Delete account</button>
       </div>`
    : `<div class="profile-mod-actions" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;">
         <button class="btn-full ghost" data-action="report-user" data-uid="${window.safeAttr(profile.id)}">Report seller</button>
         <button class="btn-full ghost" data-action="block-user-from-profile" data-uid="${window.safeAttr(profile.id)}">Block</button>
       </div>`;

  const accountHubHtml = isMe
    ? `<div class="profile-section profile-account-hub">
         <h4>Your account</h4>
         <div class="account-hub-list">
           <button class="account-hub-item" data-action="open-shop-dashboard" type="button">
             <span class="account-hub-label">My Shop</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-orders" type="button">
             <span class="account-hub-label">My Orders</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-watchlist" type="button">
             <span class="account-hub-label">Liked items</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-saved-searches" type="button">
             <span class="account-hub-label">Saved Searches</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-push-prefs" type="button">
             <span class="account-hub-label">Notifications</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-email-prefs" type="button">
             <span class="account-hub-label">Email preferences</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-connected-methods" type="button">
             <span class="account-hub-label">Connected sign-in methods</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-shipping-settings" type="button">
             <span class="account-hub-label">Shipping</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-blocked-users" type="button">
             <span class="account-hub-label">Blocked users</span>
             <span class="account-hub-chev">›</span>
           </button>
           <!-- GDPR Art. 20 export (privacy.html promises it). Moved here from
                the pre-hub actions block (r250) — Delete Account CANNOT follow
                it down: build 18 was rejected under Apple 5.1.1(v) for exactly
                that, so delete stays in the pre-hub Apple-accepted slot. The
                id sits on the LABEL span: downloadMyData() swaps textContent
                for its "Preparing export…" state and must not eat the chevron. -->
           <button class="account-hub-item" data-action="download-my-data" type="button" title="Get a JSON copy of all your TeeBox data (GDPR Art. 20). Large bundles may take 5–10s.">
             <span class="account-hub-label" id="downloadMyDataBtn">Download my data</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-about" type="button">
             <span class="account-hub-label">About TeeBox</span>
             <span class="account-hub-chev">›</span>
           </button>
           <button class="account-hub-item" data-action="open-guidelines" type="button">
             <span class="account-hub-label">Guidelines &amp; policies</span>
             <span class="account-hub-chev">›</span>
           </button>
         </div>
         <div style="text-align:center;margin-top:18px;padding:12px 0;">
           <small data-version style="opacity:.5;font-size:12px;color:var(--gray-600);user-select:none;-webkit-user-select:none;">TeeBox v1.5.7</small>
         </div>
       </div>`
    : '';

  document.getElementById('profileBody').innerHTML = `
    ${payoutNudgeHtml}
    <div class="profile-header">
      <div class="profile-avatar">${avatarHtml(profile, 'w256')}</div>
      <div style="min-width:0">
        <div class="profile-name-row">
          <div class="profile-name">${window.safeText(profile.displayName || 'Anonymous Seller')}</div>
          ${badges}
        </div>
        ${headlineStats}
      </div>
    </div>

    ${profileActionsHtml}

    ${featuredHtml}

    ${accountHubHtml}

    <div class="profile-section">
      <div class="profile-stat-row">
        <div class="profile-stat"><span class="profile-stat-n">${active.length}</span><span class="profile-stat-l">Active</span></div>
        <div class="profile-stat"><span class="profile-stat-n">${sold.length}</span><span class="profile-stat-l">Sold</span></div>
        <div class="profile-stat"><span class="profile-stat-n">${reviews.count ? reviews.avg.toFixed(1) : '—'}</span><span class="profile-stat-l">Rating (${reviews.count})</span></div>
        ${handicap}
        ${location}
      </div>
    </div>

    ${bio}

    ${bagHtml}

    <div class="profile-section">
      <div class="passport-head">
        <h4 style="margin-bottom:0">Courses Played</h4>
        <span class="passport-count" id="passportCount"></span>
      </div>
      <div class="passport-wall" id="passportWall" data-uid="${window.safeAttr(window.safeId(profile.id))}">
        <div class="passport-loading">Loading passport…</div>
      </div>
    </div>

    <div class="profile-section">
      <h4>Listings</h4>
      <div class="profile-listings">${listingsHtml}</div>
    </div>

    ${recentSoldHtml}

    ${reviews.count ? renderProfileReviews(reviews.items) : ''}
  `;
  hydrateAvatars(document.getElementById('profileBody'));
  try { renderPassportInto(profile.id, isMe); } catch (_e) { console.warn('passport render failed', _e); }
}

function renderProfileReviews(items) {
  const visible = items.slice(0, 10);
  const rows = visible.map(r => {
    const d = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate() : null;
    const when = d ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';
    const roleTag = r.role === 'seller' ? ' · From seller' : '';
    const id = window.safeAttr(window.safeId(r.id || ''));
    const help = window.__reviewHelpfulness && window.__reviewHelpfulness[r.id] || { yes: 0, no: 0, mine: null };
    const yesCls = help.mine === 'yes' ? ' active' : '';
    const noCls  = help.mine === 'no'  ? ' active' : '';
    return `<div class="review-row">
      ${starsHtml(r.rating)}
      <div class="review-meta">${window.safeText(when)}${roleTag}</div>
      ${r.comment ? `<div class="review-comment">${window.safeText(r.comment)}</div>` : ''}
      <div class="review-actions">
        <span style="color:var(--gray-500)">Was this helpful?</span>
        <button class="review-help-btn${yesCls}" data-action="vote-review-helpful" data-review-id="${id}" data-vote="yes">Yes (${help.yes})</button>
        <button class="review-help-btn${noCls}" data-action="vote-review-helpful" data-review-id="${id}" data-vote="no">No (${help.no})</button>
        <button class="review-report-btn" data-action="open-report-review" data-review-id="${id}" title="Report this review">Report</button>
      </div>
    </div>`;
  }).join('');
  // Kick off async helpfulness aggregate load — re-renders when complete.
  if (visible.length) {
    setTimeout(() => hydrateReviewHelpfulness(visible.map(r => r.id).filter(Boolean)), 0);
  }
  return `<div class="profile-section"><h4>Reviews</h4>${rows}</div>`;
}

// In-memory cache of helpfulness aggregates: { reviewId: { yes, no, mine } }
window.__reviewHelpfulness = window.__reviewHelpfulness || {};

async function hydrateReviewHelpfulness(reviewIds) {
  if (!reviewIds || !reviewIds.length) return;
  try {
    const { getFirestore, collection, getDocs } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
    let dirty = false;
    await Promise.all(reviewIds.map(async (rid) => {
      try {
        const snap = await getDocs(collection(db, 'reviews', rid, 'helpfulVotes'));
        let yes = 0, no = 0, mine = null;
        snap.docs.forEach(d => {
          const v = d.data() || {};
          if (v.vote === 'yes') yes++;
          else if (v.vote === 'no') no++;
          if (myUid && d.id === myUid) mine = v.vote || null;
        });
        const prev = window.__reviewHelpfulness[rid];
        const next = { yes, no, mine };
        if (!prev || prev.yes !== yes || prev.no !== no || prev.mine !== mine) {
          window.__reviewHelpfulness[rid] = next;
          dirty = true;
        }
      } catch (_e) { /* subcollection may not be readable; skip */ }
    }));
    if (dirty) {
      // Re-render the open profile to show the updated counts.
      const back = document.getElementById('profileBackdrop');
      if (back && back.classList.contains('open') && window.__lastProfileUid) {
        // Light re-render: re-call openProfile but it caches profile data.
        openProfile(window.__lastProfileUid);
      }
    }
  } catch (_e) { /* swallow */ }
}

async function voteReviewHelpful(reviewId, vote) {
  if (!window.CURRENT_USER) { showToast('Sign in to vote.'); return; }
  if (!reviewId || (vote !== 'yes' && vote !== 'no')) return;
  try {
    const { getFirestore, doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // Subcollection: reviews/{reviewId}/helpfulVotes/{userId}
    // NOTE: Firestore rules for this subcollection are TBD — see
    // firestore.rules. If they aren't deployed yet, this write fails and
    // we silently fall back.
    await setDoc(doc(db, 'reviews', reviewId, 'helpfulVotes', window.CURRENT_USER.uid), {
      vote,
      createdAt: serverTimestamp(),
    });
    // Optimistic local update.
    const cur = window.__reviewHelpfulness[reviewId] || { yes: 0, no: 0, mine: null };
    const next = { yes: cur.yes, no: cur.no, mine: vote };
    if (cur.mine === 'yes') next.yes = Math.max(0, next.yes - 1);
    if (cur.mine === 'no')  next.no  = Math.max(0, next.no - 1);
    if (vote === 'yes') next.yes++;
    if (vote === 'no')  next.no++;
    window.__reviewHelpfulness[reviewId] = next;
    showToast('Thanks for the feedback.');
    if (window.__lastProfileUid) openProfile(window.__lastProfileUid);
  } catch (e) {
    console.error('voteReviewHelpful failed:', e);
    showToast('Could not record vote.');
  }
}
window.voteReviewHelpful = voteReviewHelpful;

let pendingReportReviewId = null;
function openReportReview(reviewId) {
  if (!window.CURRENT_USER) { showToast('Sign in to report a review.'); return; }
  pendingReportReviewId = reviewId;
  const sel = document.getElementById('reportReviewReason');
  if (sel) sel.value = 'spam';
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  document.getElementById('reportReviewBackdrop').classList.add('open');
}

async function confirmReportReview() {
  if (!window.CURRENT_USER || !pendingReportReviewId) return;
  const reason = (document.getElementById('reportReviewReason').value || 'other').slice(0, 60);
  try {
    const { getFirestore, collection, addDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await addDoc(collection(db, 'reports'), {
      reporterId: window.CURRENT_USER.uid,
      // Schema: targetUid is required by the existing report rule for
      // user-targeted abuse. For review reports we store the review id
      // in `targetId` and tag the type. The rule allows extra fields as
      // long as the required ones are present.
      targetUid: pendingReportReviewId, // satisfies legacy required field
      targetType: 'review',
      targetId: pendingReportReviewId,
      reason,
      details: '',
      createdAt: serverTimestamp(),
    });
    document.getElementById('reportReviewBackdrop').classList.remove('open');
    showToast("Thanks. We'll review this within 48 hours.");
  } catch (e) {
    console.error('confirmReportReview failed:', e);
    showToast('Could not submit report.');
  }
}
window.openReportReview = openReportReview;
window.confirmReportReview = confirmReportReview;

// ─────────────────────────────────────────────────────────────
// SHARED REPORT DIALOG — listings, users, messages
//   openReportDialog({targetType, targetId, targetUid, messageId, conversationId})
//   submits to reports/{auto} with the extended schema (targetType,
//   targetId, targetUid, reason, details, messageId?, conversationId?,
//   reporterId, createdAt). Firestore rules validate.
// ─────────────────────────────────────────────────────────────
let __reportCtx = null;
window.openReportDialog = function openReportDialog(target) {
  if (!window.CURRENT_USER) { showToast('Sign in to report.'); return; }
  __reportCtx = target || {};
  const sel = document.getElementById('reportReason');
  const detailsRow = document.getElementById('reportDetailsRow');
  const detailsEl = document.getElementById('reportDetails');
  const reqLbl = document.getElementById('reportDetailsRequired');
  if (sel) sel.value = 'counterfeit';
  if (detailsEl) detailsEl.value = '';
  if (detailsRow) detailsRow.style.display = 'none';
  if (reqLbl) reqLbl.style.display = 'none';
  // Wire conditional textarea on change.
  if (sel && !sel.__reportWired) {
    sel.addEventListener('change', () => {
      const v = sel.value;
      const isOther = v === 'other';
      if (detailsRow) detailsRow.style.display = (isOther || v === 'scam' || v === 'harassment') ? '' : 'none';
      if (reqLbl) reqLbl.style.display = isOther ? '' : 'none';
    });
    sel.__reportWired = true;
  }
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  document.getElementById('reportBackdrop').classList.add('open');
};

async function confirmReport() {
  if (!window.CURRENT_USER || !__reportCtx) return;
  const ctx = __reportCtx;
  const reason = (document.getElementById('reportReason').value || 'other').slice(0, 60);
  const details = String(document.getElementById('reportDetails').value || '').slice(0, 500);
  if (reason === 'other' && !details.trim()) {
    showToast('Please add details for "Other".');
    return;
  }
  try {
    const { getFirestore, collection, addDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const payload = {
      reporterId: window.CURRENT_USER.uid,
      targetType: ctx.targetType || 'user',
      targetId: String(ctx.targetId || ''),
      targetUid: String(ctx.targetUid || ctx.targetId || ''),
      reason,
      details,
      status: 'open',
      createdAt: serverTimestamp(),
    };
    if (ctx.messageId) payload.messageId = String(ctx.messageId);
    if (ctx.conversationId) payload.conversationId = String(ctx.conversationId);
    await addDoc(collection(db, 'reports'), payload);
    document.getElementById('reportBackdrop').classList.remove('open');
    __reportCtx = null;
    showToast("Thanks. We'll review this within 48 hours.");
  } catch (e) {
    console.error('confirmReport failed:', e);
    showToast('Could not submit report.');
  }
}
window.confirmReport = confirmReport;

// ─────────────────────────────────────────────────────────────
// BLOCK / UNBLOCK
//   users/{uid}.blocked is a map: { [blockedUid]: { blockedAt } }.
//   On auth state change we hydrate window.MY_BLOCKED_UIDS as a Set
//   so buildProducts can client-filter blocked sellers' listings.
// ─────────────────────────────────────────────────────────────
window.MY_BLOCKED_UIDS = window.MY_BLOCKED_UIDS || new Set();

async function hydrateBlockedUsers() {
  if (!window.CURRENT_USER) { window.MY_BLOCKED_UIDS = new Set(); return; }
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
    const data = snap.exists() ? (snap.data() || {}) : {};
    const blocked = data.blocked || {};
    window.MY_BLOCKED_UIDS = new Set(Object.keys(blocked));
  } catch (e) {
    console.warn('hydrateBlockedUsers failed:', e && e.code || e);
  }
}
window.hydrateBlockedUsers = hydrateBlockedUsers;

window.blockUser = async function blockUser(uid) {
  if (!window.CURRENT_USER) { showToast('Sign in to block users.'); return; }
  if (!uid || uid === window.CURRENT_USER.uid) return;
  if (!confirm("Block this user? They won't be able to message you and their listings will be hidden from your view.")) return;
  try {
    const { getFirestore, doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await setDoc(doc(db, 'users', window.CURRENT_USER.uid),
      { blocked: { [uid]: { blockedAt: serverTimestamp() } } }, { merge: true });
    window.MY_BLOCKED_UIDS.add(uid);
    showToast('Blocked.');
    if (typeof buildProducts === 'function') buildProducts();
    if (window.loadListings) { try { window.loadListings(); } catch (_e) {} }
  } catch (e) {
    console.error('blockUser failed:', e);
    showToast('Could not block user.');
  }
};

window.unblockUser = async function unblockUser(uid) {
  if (!window.CURRENT_USER || !uid) return;
  try {
    const { getFirestore, doc, updateDoc, deleteField } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await updateDoc(doc(db, 'users', window.CURRENT_USER.uid),
      { ['blocked.' + uid]: deleteField() });
    window.MY_BLOCKED_UIDS.delete(uid);
    showToast('Unblocked.');
    if (typeof buildProducts === 'function') buildProducts();
    if (document.getElementById('blockedUsersBackdrop').classList.contains('open')) {
      openBlockedUsers();
    }
  } catch (e) {
    console.error('unblockUser failed:', e);
    showToast('Could not unblock user.');
  }
};

async function openBlockedUsers() {
  if (!window.CURRENT_USER) { showToast('Sign in to manage blocked users.'); return; }
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  const body = document.getElementById('blockedUsersBody');
  body.innerHTML = '<div class="profile-loading" aria-busy="true"><div class="sk sk-line long"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div>';
  document.getElementById('blockedUsersBackdrop').classList.add('open');
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const meSnap = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
    const blockedMap = (meSnap.exists() && meSnap.data() && meSnap.data().blocked) || {};
    const uids = Object.keys(blockedMap);
    if (!uids.length) {
      body.innerHTML = '<div class="profile-loading" style="padding:1.5rem">You haven’t blocked anyone.</div>';
      return;
    }
    // Fetch each profile (best-effort; missing profile -> "Unknown user").
    const rows = await Promise.all(uids.map(async (uid) => {
      let name = 'Unknown user';
      try {
        const pSnap = await getDoc(doc(db, 'profiles', uid));
        if (pSnap.exists()) name = pSnap.data().displayName || name;
      } catch (_e) {}
      return `<div class="blocked-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--gray-200)">
        <div style="min-width:0;flex:1"><div style="font-weight:600;color:var(--gray-800)">${window.safeText(name)}</div></div>
        <button class="btn-full ghost" style="max-width:120px" data-action="unblock-user" data-uid="${window.safeAttr(uid)}">Unblock</button>
      </div>`;
    }));
    body.innerHTML = rows.join('');
  } catch (e) {
    console.error('openBlockedUsers failed:', e);
    body.innerHTML = '<div class="profile-loading" style="padding:1.5rem;color:var(--red-500)">Could not load blocked users.</div>';
  }
}
window.openBlockedUsers = openBlockedUsers;

// ─────────────────────────────────────────────────────────────
// MESSAGE CONTEXT MENU — long-press on a chat bubble triggers
//   the report dialog (events delegated on #chatBody; uses
//   data-msg-id / data-sender-id baked into .msg-wrap by
//   renderMessages — we never touch renderMessages).
// ─────────────────────────────────────────────────────────────
(function wireMessageContextMenu() {
  const chatBody = document.getElementById('chatBody');
  if (!chatBody || chatBody.__reportWired) return;
  chatBody.__reportWired = true;
  let pressTimer = null;
  let pressedEl = null;
  function clear() { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; pressedEl = null; }
  chatBody.addEventListener('pointerdown', (e) => {
    const wrap = e.target.closest('.msg-wrap');
    if (!wrap) return;
    pressedEl = wrap;
    pressTimer = setTimeout(() => {
      if (pressedEl !== wrap) return;
      const senderId = wrap.dataset.senderId;
      if (!senderId) return;
      if (window.CURRENT_USER && senderId === window.CURRENT_USER.uid) return;
      const mid = wrap.dataset.msgId;
      window.openReportDialog({
        targetType: 'message',
        targetId: mid || '',
        targetUid: senderId,
        messageId: mid || '',
        conversationId: (typeof currentChat !== 'undefined' && currentChat && currentChat.conversationId) || null,
      });
      pressedEl = null;
    }, 500);
  });
  chatBody.addEventListener('pointerup', clear);
  chatBody.addEventListener('pointercancel', clear);
  chatBody.addEventListener('pointerleave', clear);
  // Right-click on desktop -> same flow.
  chatBody.addEventListener('contextmenu', (e) => {
    const wrap = e.target.closest('.msg-wrap');
    if (!wrap) return;
    const senderId = wrap.dataset.senderId;
    if (!senderId || (window.CURRENT_USER && senderId === window.CURRENT_USER.uid)) return;
    e.preventDefault();
    const mid = wrap.dataset.msgId;
    window.openReportDialog({
      targetType: 'message',
      targetId: mid || '',
      targetUid: senderId,
      messageId: mid || '',
      conversationId: (typeof currentChat !== 'undefined' && currentChat && currentChat.conversationId) || null,
    });
  });
})();

async function renderProfileEditor() {
  if (!window.CURRENT_USER) return;
  const profile = await loadProfile(window.CURRENT_USER.uid) || {};
  document.getElementById('profileModalTitle').textContent = 'Edit Profile';
  // r170: dismissible photo nudge — trust framing, purely optional, shown
  // only while the profile has no photo and the user hasn't dismissed it.
  const _photoNudge = (!profile.avatarUrl && (() => {
    try { return !localStorage.getItem('teebox.photoNudgeDismissed.' + window.CURRENT_USER.uid); } catch (_e) { return true; }
  })())
    ? `<div class="photo-nudge-banner" id="photoNudgeBanner"><span>Add a profile photo — buyers and sellers are more likely to deal with a face they can see.</span><button type="button" class="photo-nudge-dismiss" data-action="dismiss-photo-nudge" aria-label="Dismiss">×</button></div>`
    : '';
  document.getElementById('profileBody').innerHTML = `
    ${_photoNudge}
    <div class="profile-header">
      <div class="profile-avatar" id="editAvatarPreview">${avatarHtml(profile, 'w256')}</div>
      <div>
        <div class="profile-meta">JPG, PNG, WEBP, or HEIC. Max 2MB.</div>
        <div class="avatar-upload-row">
          <button type="button" class="avatar-upload-btn" data-action="avatar-pick">Choose Photo</button>
          <input type="file" id="avatarFileInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" style="display:none" />
        </div>
      </div>
    </div>

    <div class="profile-edit-grid">
      <div>
        <label for="editDisplayName">Display Name</label>
        <input id="editDisplayName" type="text" maxlength="60" placeholder="Your display name" value="${window.safeAttr(profile.displayName || '')}" />
      </div>
      <div>
        <label for="editBio">Bio</label>
        <textarea id="editBio" maxlength="600" placeholder="Tell other members a bit about you and the kind of gear you sell.">${window.safeText(profile.bio || '')}</textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div>
          <label for="editLocation">Location</label>
          <input id="editLocation" type="text" maxlength="80" placeholder="City, State" value="${window.safeAttr(profile.location || '')}" />
        </div>
        <div>
          <label for="editHandicap">Handicap</label>
          <input id="editHandicap" type="number" min="-10" max="54" step="0.1" placeholder="e.g. 12" value="${typeof profile.handicap === 'number' ? Number(profile.handicap) : ''}" />
        </div>
      </div>
      <div>
        <label for="editGolfBag">What's in the bag (one club per line, max 14)</label>
        <textarea id="editGolfBag" maxlength="900" placeholder="TaylorMade Stealth 2 Driver&#10;Titleist TSi3 3-wood&#10;Mizuno JPX 921 Tour irons&#10;…">${window.safeText(Array.isArray(profile.golfBag) ? profile.golfBag.join('\n') : '')}</textarea>
        <div class="bag-edit-hint">Real bags hold 14 clubs. Each line is one club, up to 60 characters.</div>
      </div>
    </div>

    <div class="profile-actions">
      <button class="btn-full ghost" data-action="cancel-edit-profile">Cancel</button>
      <button class="btn-full green" data-action="save-profile" id="saveProfileBtn">Save Changes</button>
    </div>
  `;
  hydrateAvatars(document.getElementById('profileBody'));

  // Wire avatar file input
  const fi = document.getElementById('avatarFileInput');
  if (fi) fi.addEventListener('change', onAvatarFile);
}

let pendingAvatarFile = null;
// ── Reusable image cropper (pan + zoom) ──────────────────────────────
// window.openCropper(file, opts) opens the crop overlay and resolves to a
// square cropped File (or null if cancelled). opts: { round, outputSize,
// mime, quality, title }. Square output (1:1) only for now — covers
// avatars and the course-passport photo grid. The stage IS the crop
// viewport: whatever is visible is the crop, so the image always covers it.
let __cropState = null;
window.openCropper = function(file, opts = {}) {
  return new Promise((resolve) => {
    const stage = document.getElementById('cropStage');
    const img = document.getElementById('cropImg');
    const zoom = document.getElementById('cropZoom');
    const back = document.getElementById('cropBackdrop');
    const titleEl = document.getElementById('cropTitle');
    if (!stage || !img || !zoom || !back) { resolve(file); return; } // fail-open
    if (titleEl) titleEl.textContent = opts.title || 'Crop photo';
    stage.classList.toggle('round', !!opts.round);
    // Open the modal BEFORE measuring — the stage is display:none until
    // .open is added, so measuring first gives clientWidth/Height 0 and the
    // guard below would bail (returning the original, uncropped file).
    img.removeAttribute('src');
    back.classList.add('open'); back.setAttribute('aria-hidden', 'false');
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const SW = stage.clientWidth, SH = stage.clientHeight;
      const NW = im.naturalWidth, NH = im.naturalHeight;
      if (!SW || !SH || !NW || !NH) { URL.revokeObjectURL(url); resolve(file); return; }
      const baseScale = Math.max(SW / NW, SH / NH); // cover the stage at z=1
      const st = {
        url, im, SW, SH, NW, NH, baseScale, z: 1, ox: 0, oy: 0,
        outputSize: opts.outputSize || 512, mime: opts.mime || 'image/jpeg',
        quality: opts.quality || 0.85, resolve, _handlers: null, _ds: baseScale,
      };
      __cropState = st;
      img.src = url;
      zoom.value = 1;
      const render = () => {
        const ds = st.baseScale * st.z;
        const DW = st.NW * ds, DH = st.NH * ds;
        st.ox = Math.min(0, Math.max(st.SW - DW, st.ox)); // keep image covering
        st.oy = Math.min(0, Math.max(st.SH - DH, st.oy));
        img.style.width = DW + 'px';
        img.style.height = DH + 'px';
        img.style.transform = `translate(${st.ox}px, ${st.oy}px)`;
        st._ds = ds;
      };
      st.render = render;
      // start centered
      st.ox = (SW - NW * baseScale) / 2;
      st.oy = (SH - NH * baseScale) / 2;
      render();
      let dragging = false, px = 0, py = 0;
      const down = (e) => { dragging = true; px = e.clientX; py = e.clientY; try { stage.setPointerCapture(e.pointerId); } catch (_e) {} };
      const move = (e) => { if (!dragging) return; st.ox += (e.clientX - px); st.oy += (e.clientY - py); px = e.clientX; py = e.clientY; render(); if (e.cancelable) e.preventDefault(); };
      const up = () => { dragging = false; };
      st._handlers = { down, move, up };
      stage.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      zoom.oninput = () => {
        const oldz = st.z; st.z = Number(zoom.value) || 1;
        // zoom toward the stage centre so it feels anchored
        const cx = st.SW / 2, cy = st.SH / 2, r = st.z / oldz;
        st.ox = cx - (cx - st.ox) * r; st.oy = cy - (cy - st.oy) * r;
        render();
      };
      back.classList.add('open'); back.setAttribute('aria-hidden', 'false');
    };
    im.onerror = () => { try { URL.revokeObjectURL(url); } catch (_e) {} resolve(file); };
    im.src = url;
  });
};
function __cropCleanup(st) {
  const stage = document.getElementById('cropStage');
  const back = document.getElementById('cropBackdrop');
  if (st && st._handlers && stage) {
    stage.removeEventListener('pointerdown', st._handlers.down);
    window.removeEventListener('pointermove', st._handlers.move);
    window.removeEventListener('pointerup', st._handlers.up);
  }
  const z = document.getElementById('cropZoom'); if (z) z.oninput = null;
  if (back) { back.classList.remove('open'); back.setAttribute('aria-hidden', 'true'); }
  if (st && st.url) { try { URL.revokeObjectURL(st.url); } catch (_e) {} }
}
window.__cropConfirm = function() {
  const st = __cropState; if (!st) return; __cropState = null;
  const O = st.outputSize, ds = st._ds;
  const canvas = document.createElement('canvas'); canvas.width = O; canvas.height = O;
  const ctx = canvas.getContext('2d');
  const sx = -st.ox / ds, sy = -st.oy / ds, sW = st.SW / ds, sH = st.SH / ds;
  try { ctx.drawImage(st.im, sx, sy, sW, sH, 0, 0, O, O); } catch (_e) {}
  canvas.toBlob((blob) => {
    __cropCleanup(st);
    st.resolve(blob ? new File([blob], 'photo.jpg', { type: st.mime }) : null);
  }, st.mime, st.quality);
};
window.__cropCancel = function() { const st = __cropState; __cropState = null; __cropCleanup(st); if (st) st.resolve(null); };

// ═══════════════════════════════════════════════════════════════════
// COURSE PASSPORT — the courses you've played, graded + reviewed.
// Data: passport/{uid}/played/{courseId} = {courseId, courseName, grade,
// tags[], review, photos[], createdAt, updatedAt}. Photos in Storage at
// passport/{uid}/{courseId}/*. Public read; owner-only write (see
// firestore.rules + storage.rules). The wall on a profile shows each
// course's logo ringed by its grade colour; tapping opens a detail sheet
// with the photos + review. The owner also gets an "Add course" tile and
// edit/remove. Course list = only slugs with a real logo (LOGOS_AVAILABLE).
// ═══════════════════════════════════════════════════════════════════
window.PASSPORT_GRADES = ['A+','A','B+','B','C+','C','D','F'];
window.PASSPORT_TAGS = ['Caddies','Fairways','Greens','Clubhouse','Food','Practice facility','Pro shop','Views','Conditioning','Pace','Service','Value','Design','19th hole'];
// Grade → ring/badge colour. Gold A+, greens down through neutral to red.
window.PASSPORT_GRADE_COLOR = {
  'A+': '#c9991e', 'A': '#3a6b47', 'B+': '#5a9268', 'B': '#6aad7c',
  'C+': '#9a9a86', 'C': '#a8a89e', 'D': '#d98a3a', 'F': '#c0392b',
};
// Accolade tiers by number of courses logged.
window.PASSPORT_TIERS = [
  { n: 100, label: 'Legend' },
  { n: 50,  label: 'Globetrotter' },
  { n: 25,  label: 'Road Warrior' },
  { n: 10,  label: 'Regular' },
  { n: 5,   label: 'Getting Started' },
  { n: 1,   label: 'First Tee' },
];
function passportTier(n) {
  for (const t of window.PASSPORT_TIERS) if (n >= t.n) return t;
  return null;
}

// Lazy course catalogue (only courses with a real logo, sorted by name).
let __passportCoursesPromise = null;
function loadPassportCourses() {
  if (!__passportCoursesPromise) {
    __passportCoursesPromise = (async () => {
      const [{ COURSES, courseLogoUrl }, manifest] = await Promise.all([
        import('/bingo-courses.js'),
        import('/assets/logos/manifest.js'),
      ]);
      const { LOGOS_AVAILABLE } = manifest;
      // Passport-only originals (wordmarks intact) live in /assets/logos/passport/.
      // A course is Passport-selectable if it has EITHER a Bingo (wordless) logo
      // or a passport original; the original wins for display when present.
      const PASSPORT_LOGOS = manifest.PASSPORT_LOGOS || new Set();
      const list = COURSES.filter(c => LOGOS_AVAILABLE.has(c.id) || PASSPORT_LOGOS.has(c.id))
        .map(c => ({ id: c.id, name: c.name, shortName: c.shortName, location: c.location || '', architect: c.architect || '', founded: c.founded || null,
          logo: PASSPORT_LOGOS.has(c.id) ? `/assets/logos/passport/${c.id}.png` : courseLogoUrl(c) }))
        .sort((a, b) => a.shortName.localeCompare(b.shortName));
      const byId = {};
      list.forEach(c => { byId[c.id] = c; });
      return { list, byId, courseLogoUrl };
    })().catch(e => { console.warn('passport course catalogue failed', e); return { list: [], byId: {}, courseLogoUrl: (c) => `/assets/logos/${c && c.id}.png` }; });
  }
  return __passportCoursesPromise;
}

// Render a profile's passport wall. uid = whose passport; isOwner = viewer owns it.
async function renderPassportInto(uid, isOwner) {
  const wall = document.getElementById('passportWall');
  const countEl = document.getElementById('passportCount');
  if (!wall) return;
  wall.dataset.owner = isOwner ? '1' : '';
  let played = [];
  try {
    const { getFirestore, collection, getDocs } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDocs(collection(db, 'passport', uid, 'played'));
    snap.forEach(d => played.push(d.data()));
  } catch (e) { console.warn('passport read failed', e); }
  // Newest first (createdAt may be a Firestore Timestamp or absent on old docs).
  played.sort((a, b) => {
    const am = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
    const bm = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
    return bm - am;
  });
  // On someone else's profile with an empty passport, hide the whole
  // section — no point showing a bare "no courses" block to visitors.
  const section = wall.closest('.profile-section');
  if (section) section.hidden = !isOwner && played.length === 0;
  const cat = await loadPassportCourses();
  const n = played.length;
  const tier = passportTier(n);
  if (countEl) {
    countEl.innerHTML = n
      ? `<strong>${n}</strong> course${n === 1 ? '' : 's'}${tier ? ` · <span class="passport-tier">${window.safeText(tier.label)}</span>` : ''}`
      : (isOwner ? '<span class="passport-empty-note">Add the courses you’ve played</span>' : '<span class="passport-empty-note">No courses yet</span>');
  }
  const cells = played.map(p => {
    const c = cat.byId[p.courseId] || { shortName: p.courseName || p.courseId, logo: `/assets/logos/${p.courseId}.png` };
    const color = window.PASSPORT_GRADE_COLOR[p.grade] || '#8a7550';
    const rot = ppStampRotation(p.courseId);
    const date = ppStampDate(p.createdAt);
    return `<button type="button" class="pp-stamp" style="--ring:${color};--rot:${rot}deg" data-action="passport-open" data-uid="${window.safeAttr(uid)}" data-course="${window.safeAttr(p.courseId)}" title="${window.safeAttr((c.shortName || '') + (p.grade ? ' — ' + p.grade : ''))}">
      <span class="pp-stamp-ink">
        <img class="pp-stamp-logo" src="${window.safeAttr(c.logo)}" alt="${window.safeAttr(c.shortName || '')}" loading="lazy" decoding="async" />
        ${p.grade ? `<span class="pp-stamp-grade">${window.safeText(p.grade)}</span>` : ''}
      </span>
      <span class="pp-stamp-name">${window.safeText(c.shortName || p.courseName || '')}</span>
      ${date ? `<span class="pp-stamp-date">${window.safeText(date)}</span>` : ''}
    </button>`;
  }).join('');
  const addTile = isOwner
    ? `<button type="button" class="pp-stamp pp-stamp-add" data-action="passport-add" title="Add a course you've played">
         <span class="pp-stamp-ink pp-stamp-add-ink"><span class="pp-stamp-plus">+</span></span>
         <span class="pp-stamp-name">Add course</span>
       </button>`
    : '';
  wall.innerHTML = (cells + addTile) || '<div class="passport-empty">No courses played yet.</div>';
}
window.renderPassportInto = renderPassportInto;

// Deterministic per-course stamp jitter (-4.5°..+4.5°) so the wall looks
// hand-stamped, not gridded, but stays stable across re-renders.
function ppStampRotation(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  return ((h % 91) / 10 - 4.5).toFixed(1);
}
function ppStampDate(ts) {
  const d = ts && ts.toDate ? ts.toDate() : null;
  if (!d) return '';
  try { return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase(); }
  catch (_e) { return ''; }
}

// ── Add/edit modal ───────────────────────────────────────────────────
let __ppState = null; // { editing, courseId, courseName, grade, tags:Set, photos:[{url}|{file,previewUrl}] }

async function openAddPassportCourse(existing) {
  if (window.requireAuth && !window.requireAuth('to add a course to your passport')) return;
  __ppState = { editing: false, courseId: '', courseName: '', grade: '', tags: new Set(), photos: [] };
  const cat = await loadPassportCourses();
  const back = document.getElementById('ppBackdrop');
  const titleEl = document.getElementById('ppModalTitle');
  const search = document.getElementById('ppCourseSearch');
  const menu = document.getElementById('ppCourseMenu');
  const reviewEl = document.getElementById('ppReview');
  if (search) search.placeholder = `Search ${cat.list.length} courses…`;
  if (existing) {
    __ppState.editing = true;
    __ppState.courseId = existing.courseId;
    __ppState.courseName = existing.courseName || (cat.byId[existing.courseId] || {}).shortName || existing.courseId;
    __ppState.grade = existing.grade || '';
    (existing.tags || []).forEach(t => __ppState.tags.add(t));
    __ppState.photos = (existing.photos || []).map(u => ({ url: u }));
    if (titleEl) titleEl.textContent = 'Edit course';
    if (reviewEl) reviewEl.value = existing.review || '';
  } else {
    if (titleEl) titleEl.textContent = 'Add a course';
    if (reviewEl) reviewEl.value = '';
  }
  if (search) { search.value = ''; }
  if (menu) { menu.hidden = true; }
  ppRenderPicked();
  ppRenderGrades();
  ppRenderTags();
  ppRenderPhotos();
  if (search) {
    search.oninput = () => ppRenderCourseMenu(search.value, cat);
    search.onfocus = () => { if (!__ppState.courseId) ppRenderCourseMenu(search.value, cat); };
  }
  const btn = document.getElementById('ppSaveBtn');
  if (btn) { btn.disabled = false; btn.textContent = __ppState.editing ? 'Update' : 'Post'; }
  back.classList.add('open'); back.setAttribute('aria-hidden', 'false');
}

function ppRenderCourseMenu(q, cat) {
  const menu = document.getElementById('ppCourseMenu');
  if (!menu) return;
  const term = (q || '').trim().toLowerCase();
  let list = cat.list;
  if (term) list = list.filter(c =>
    c.shortName.toLowerCase().includes(term) ||
    c.name.toLowerCase().includes(term) ||
    (c.location || '').toLowerCase().includes(term));
  list = list.slice(0, 40);
  menu.innerHTML = list.map(c =>
    `<button type="button" class="pp-course-opt" data-action="passport-pick-course" data-course="${window.safeAttr(c.id)}">
      <img src="${window.safeAttr(c.logo)}" alt="" loading="lazy" />
      <span><strong>${window.safeText(c.shortName)}</strong><small>${window.safeText(c.location || '')}</small></span>
    </button>`).join('') || '<div class="pp-course-none">No matches</div>';
  menu.hidden = false;
}

function ppPickCourse(courseId) {
  loadPassportCourses().then(cat => {
    const c = cat.byId[courseId];
    if (!c || !__ppState) return;
    __ppState.courseId = c.id;
    __ppState.courseName = c.shortName;
    const menu = document.getElementById('ppCourseMenu');
    const search = document.getElementById('ppCourseSearch');
    if (menu) menu.hidden = true;
    if (search) search.value = '';
    ppRenderPicked();
  });
}

function ppRenderPicked() {
  const picked = document.getElementById('ppCoursePicked');
  const search = document.getElementById('ppCourseSearch');
  if (!picked || !__ppState) return;
  if (!__ppState.courseId) { picked.hidden = true; if (search) search.hidden = false; return; }
  loadPassportCourses().then(cat => {
    const c = cat.byId[__ppState.courseId] ||
      { shortName: __ppState.courseName, location: '', logo: `/assets/logos/${__ppState.courseId}.png` };
    picked.innerHTML =
      `<img src="${window.safeAttr(c.logo)}" alt="" />
       <span><strong>${window.safeText(c.shortName)}</strong><small>${window.safeText(c.location || '')}</small></span>
       ${__ppState.editing ? '' : '<button type="button" class="pp-change" data-action="passport-change-course">Change</button>'}`;
    picked.hidden = false;
    if (search) search.hidden = true;
  });
}

function ppChangeCourse() {
  if (!__ppState) return;
  __ppState.courseId = ''; __ppState.courseName = '';
  const search = document.getElementById('ppCourseSearch');
  ppRenderPicked();
  if (search) { search.hidden = false; search.value = ''; try { search.focus(); } catch (_e) {} }
}

function ppRenderGrades() {
  const box = document.getElementById('ppGrades');
  if (!box || !__ppState) return;
  box.innerHTML = window.PASSPORT_GRADES.map(g => {
    const on = __ppState.grade === g;
    const color = window.PASSPORT_GRADE_COLOR[g];
    const style = on ? `background:${color};border-color:${color};color:#fff` : '';
    return `<button type="button" class="pp-grade${on ? ' on' : ''}" data-action="passport-grade" data-grade="${window.safeAttr(g)}" style="${style}">${window.safeText(g)}</button>`;
  }).join('');
}

function ppRenderTags() {
  const box = document.getElementById('ppTags');
  if (!box || !__ppState) return;
  box.innerHTML = window.PASSPORT_TAGS.map(t => {
    const on = __ppState.tags.has(t);
    return `<button type="button" class="pp-tag${on ? ' on' : ''}" data-action="passport-tag" data-tag="${window.safeAttr(t)}">${window.safeText(t)}</button>`;
  }).join('');
}

function ppRenderPhotos() {
  const box = document.getElementById('ppPhotos');
  if (!box || !__ppState) return;
  const tiles = __ppState.photos.map((p, i) => {
    const src = p.url || p.previewUrl;
    return `<div class="pp-photo"><img src="${window.safeAttr(src)}" alt="" /><button type="button" class="pp-photo-x" data-action="passport-photo-remove" data-idx="${i}" aria-label="Remove photo">&times;</button></div>`;
  }).join('');
  const addBtn = __ppState.photos.length < 12
    ? '<button type="button" class="pp-photo-add" data-action="passport-photo-add" aria-label="Add photo">+</button>'
    : '';
  box.innerHTML = tiles + addBtn;
}

function ppAddPhoto() {
  const input = document.getElementById('ppPhotoInput');
  if (!input || !__ppState) return;
  if (__ppState.photos.length >= 12) { showToast('Up to 12 photos per course.'); return; }
  input.value = '';
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    input.onchange = null;
    if (!files.length || !__ppState) return;
    const room = 12 - __ppState.photos.length;
    if (files.length === 1) {
      // Single pick → crop/zoom it precisely.
      const file = files[0];
      if (file.size > 30 * 1024 * 1024) { showToast('That image is too large. Please pick one under 30MB.'); return; }
      // r309: 1600, matching listing photos. 1080 was BELOW what a modern
      // phone displays: a 4:5 card on a 390pt-wide screen at 3x is ~1170px
      // across, so every passport photo was being upscaled on the device it
      // was shot on. Uploads go straight to Storage (uploadBytes), not through
      // a callable, so there is no 1MB payload ceiling to respect here.
      const cropped = await window.openCropper(file, { outputSize: 1600, quality: 0.85, title: 'Crop photo' });
      if (!cropped || !__ppState) return;
      __ppState.photos.push({ file: cropped, previewUrl: URL.createObjectURL(cropped) });
      ppRenderPhotos();
      return;
    }
    // Multiple picks → add them all (downscaled, no per-photo crop step) up to
    // the 12 cap. Easier than cropping each one; the feed/detail cover-fit them.
    let added = 0;
    for (const f of files.slice(0, room)) {
      if (f.size > 30 * 1024 * 1024) continue;
      const small = await ppDownscaleImage(f, 2048, 0.9); // match single-pick size
      if (!__ppState) return;
      __ppState.photos.push({ file: small, previewUrl: URL.createObjectURL(small) });
      added++;
      ppRenderPhotos();
    }
    if (files.length > room) showToast(`Added ${added} — 12 photos max per course.`);
  };
  input.click();
}

// Downscale an image to fit within `max` px (longest side), re-encoded JPEG.
// EXIF-orientation-safe via createImageBitmap; falls back to the original.
// r347: 2048px / q0.9 (was 1600 / 0.85). The server re-encodes to WebP, so this
// JPEG is an intermediate — a larger, cleaner source keeps that second pass sharp.
async function ppDownscaleImage(file, max = 2048, quality = 0.85) {
  try {
    // Decode + scale off the main thread via createImageBitmap resize options
    // (a 12MP photo is ~48MB RGBA if decoded at full size first). Probe the
    // natural size cheaply, then decode straight to the target size.
    const probe = await createImageBitmap(file);
    const pw = probe.width, ph = probe.height;
    if (probe.close) probe.close();
    const scale = Math.min(1, max / Math.max(pw, ph));
    const w = Math.round(pw * scale), h = Math.round(ph * scale);
    const bmp = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch (_e) { return file; }
}

function ppRemovePhoto(idx) {
  if (!__ppState) return;
  const p = __ppState.photos[idx];
  if (p && p.previewUrl) { try { URL.revokeObjectURL(p.previewUrl); } catch (_e) {} }
  __ppState.photos.splice(idx, 1);
  ppRenderPhotos();
}

function ppCloseModal() {
  const back = document.getElementById('ppBackdrop');
  if (back) { back.classList.remove('open'); back.setAttribute('aria-hidden', 'true'); }
  if (__ppState) {
    __ppState.photos.forEach(p => { if (p.previewUrl) { try { URL.revokeObjectURL(p.previewUrl); } catch (_e) {} } });
  }
}

async function ppSave() {
  const st = __ppState;
  if (!st) return;
  if (!st.courseId) { showToast('Pick a course first.'); return; }
  if (!st.grade) { showToast('Give it a grade.'); return; }
  const uid = window.CURRENT_USER && window.CURRENT_USER.uid;
  if (!uid) { window.requireAuth && window.requireAuth('to save your passport'); return; }
  const btn = document.getElementById('ppSaveBtn');
  const reviewEl = document.getElementById('ppReview');
  const review = ((reviewEl && reviewEl.value) || '').trim().slice(0, 2000);
  if (btn) { btn.disabled = true; btn.textContent = st.editing ? 'Saving…' : 'Posting…'; }
  try {
    const [{ getFirestore, doc, getDoc, setDoc, serverTimestamp }, { getStorage, ref: sref, uploadBytes, getDownloadURL }] =
      await Promise.all([
        import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js"),
        import("https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js"),
      ]);
    const stg = getStorage();
    // Upload new photos in PARALLEL (was sequential await per photo — 12
    // photos ≈ 15-20s on mobile; now bandwidth-bound). Paths are
    // Date.now()-unique so a long immutable cache is safe.
    const stamp = Date.now();
    const urls = await Promise.all(st.photos.map(async (p, i) => {
      if (p.url) return p.url;
      if (!p.file) return null;
      const r = sref(stg, `passport/${uid}/${st.courseId}/${stamp}_${i}.jpg`);
      await uploadBytes(r, p.file, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
      return getDownloadURL(r);
    }));
    for (let i = urls.length - 1; i >= 0; i--) if (!urls[i]) urls.splice(i, 1);
    const db = getFirestore();
    const payload = {
      courseId: st.courseId,
      courseName: st.courseName || st.courseId,
      grade: st.grade,
      tags: Array.from(st.tags).slice(0, 20),
      review,
      photos: urls.slice(0, 12),
      // Feed query key (where hasPhotos == true) — Discover is photo-driven.
      hasPhotos: urls.length > 0,
      updatedAt: serverTimestamp(),
      // NOTE (audit 2026-09-17): poster identity is NOT stored on the doc —
      // it was client-supplied and spoofable. The feed/course page/comments
      // resolve name+avatar from profiles/{uid} (session-cached) instead.
    };
    // createdAt is IMMUTABLE under the deployed rules (audit 2026-09-17:
    // blocks pinning a post to the top of Discover by re-stamping it).
    // The "Add a course" flow doesn't know the course may already be in
    // the user's passport — re-adding one (grade first, photos later, the
    // 2026-09-21 'Could not save' case) sent a fresh createdAt with
    // merge:true and the update rule denied the whole write, every time.
    // Point-read the doc first: only a genuinely NEW doc gets createdAt.
    const roundRef = doc(db, 'passport', uid, 'played', st.courseId);
    let isNewDoc = !st.editing;
    if (isNewDoc) {
      try { isNewDoc = !(await getDoc(roundRef)).exists(); } catch (_e) { /* offline read — assume new; create path still valid */ }
    }
    if (isNewDoc) payload.createdAt = serverTimestamp();
    // merge:true keeps createdAt intact when editing/re-adding.
    await setDoc(roundRef, payload, { merge: true });
    ppCloseModal();
    __ppState = null;
    __ppFeedHTML = ''; // new/edited round → refresh the feed on next open
    // Posted from inside the feed? Repaint it now so the new round is visible.
    try {
      const fs = document.getElementById('passportFeedScreen');
      if (fs && fs.classList.contains('open')) openPassportFeed();
    } catch (_e) {}
    showToast(st.editing ? 'Course updated.' : 'Course added to your passport.', 'success');
    try { await renderPassportInto(uid, true); } catch (_e) {}
  } catch (e) {
    console.error('passport save failed', e);
    showToast('Could not save. Please try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = st.editing ? 'Update' : 'Post'; }
  }
}

// ── Course-detail sheet ──────────────────────────────────────────────
let __ppDetailData = null;
let __ppDetailUid = null;

async function openPassportCourseDetail(uid, courseId) {
  const back = document.getElementById('ppDetailBackdrop');
  const body = document.getElementById('ppDetailBody');
  if (!back || !body) return;
  const isOwner = !!(window.CURRENT_USER && window.CURRENT_USER.uid === uid);
  __ppDetailUid = uid;
  body.innerHTML = '<div class="pp-detail-loading">Loading…</div>';
  back.classList.add('open'); back.setAttribute('aria-hidden', 'false');
  let data = null;
  try {
    const { getFirestore, doc, getDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const snap = await getDoc(doc(db, 'passport', uid, 'played', courseId));
    if (snap.exists()) data = snap.data();
  } catch (e) { console.warn('passport detail read failed', e); }
  if (!data) { body.innerHTML = '<div class="pp-detail-loading">Could not load this course.</div>'; return; }
  __ppDetailData = data;
  const cat = await loadPassportCourses();
  const c = cat.byId[courseId] ||
    { shortName: data.courseName || courseId, name: data.courseName || courseId, location: '', logo: `/assets/logos/${courseId}.png` };
  const color = window.PASSPORT_GRADE_COLOR[data.grade] || '#a8a89e';
  const ua = window.safeAttr(uid), ca = window.safeAttr(courseId);
  const photoList = data.photos || [];
  const photos = photoList.map(u => `<img class="pp-detail-photo" ${ppPhotoSrcAttrs(data.photoVariants, u, true)} alt="" loading="lazy" draggable="false" />`).join('');
  const detailDots = photoList.length > 1
    ? `<div class="pp-detail-dots ppc-dots" id="ppDetailDots">${photoList.map((_, i) => `<span class="ppc-dot${i === 0 ? ' on' : ''}"></span>`).join('')}</div>` : '';
  const tags = (data.tags || []).map(t => `<span class="pp-detail-tag">${window.safeText(t)}</span>`).join('');
  body.innerHTML = `
    <div class="pp-detail-head">
      <span class="passport-ring pp-detail-ring" style="--ring:${color}"><img class="passport-logo" src="${window.safeAttr(c.logo)}" alt="" /></span>
      <div class="pp-detail-titles">
        <div class="pp-detail-name">${window.safeText(c.name || c.shortName)}</div>
        ${c.location ? `<div class="pp-detail-loc">${window.safeText(c.location)}</div>` : ''}
        <div class="pp-detail-grade" style="color:${color}">Grade ${window.safeText(data.grade || '—')}</div>
      </div>
    </div>
    <button type="button" class="pp-detail-coursebtn" data-action="open-course-page" data-course="${ca}">View course &amp; all rounds here &rarr;</button>
    ${photos ? `<div class="pp-detail-photowrap"><div class="pp-detail-photos" id="ppDetailPhotos">${photos}</div><div class="pp-heart-burst" id="ppHeartBurst" aria-hidden="true">${window.ICONS.heartFill}</div></div>${detailDots}` : ''}
    ${tags ? `<div class="pp-detail-tags">${tags}</div>` : ''}
    ${data.review ? `<p class="pp-detail-review">${window.safeText(String(data.review).replace(/\n{3,}/g, '\n\n'))}</p>` : ''}
    <div class="pp-likebar">
      <button type="button" class="pp-like-btn" id="ppLikeBtn" data-action="passport-like" data-uid="${ua}" data-course="${ca}">
        <span class="pp-like-ico">${window.ICONS.heart}</span><span id="ppLikeCount"></span>
      </button>
    </div>
    ${isOwner ? `<div class="pp-share-row" id="ppShareRow" data-course="${ca}">
      <button type="button" class="btn-full ghost" data-action="passport-share" data-course="${ca}" id="ppShareBtn">Share this round</button>
      <div class="pp-share-note" id="ppShareNote" hidden></div>
    </div>
    <div class="pp-detail-actions">
      <button type="button" class="btn-full ghost" data-action="passport-edit" data-uid="${ua}" data-course="${ca}">Edit</button>
      <button type="button" class="btn-full danger-ghost" data-action="passport-delete" data-uid="${ua}" data-course="${ca}">Remove</button>
    </div>` : ''}
    <div class="pp-comments">
      <div class="pp-comments-title">Comments</div>
      <div id="ppCommentList"><div class="pp-comment-empty">Loading…</div></div>
      <div id="ppCommentFormWrap"></div>
    </div>
  `;
  // Double-tap / double-click the photos to like (Instagram-style).
  if (photos) ppWireDoubleTapLike(uid, courseId);
  if (photoList.length > 1) ppWireCarouselDots(document.getElementById('ppDetailPhotos'), document.getElementById('ppDetailDots'));
  ppLoadLikes(uid, courseId);
  ppLoadComments(uid, courseId);
}

// ── Likes ────────────────────────────────────────────────────────────
let __ppLikeState = { uid: null, courseId: null, liked: false, count: 0, busy: false };

async function ppLoadLikes(uid, courseId) {
  __ppLikeState = { uid, courseId, liked: false, count: 0, busy: false };
  const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  try {
    const { getFirestore, collection, doc, getDoc, getCountFromServer } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // 2 reads instead of N: aggregate count + "did I like it" point-read.
    // (Was a full getDocs of the likes subcollection — 1k likes = 1k reads.)
    const likesCol = collection(db, 'passport', uid, 'played', courseId, 'likes');
    const [cnt, mine] = await Promise.all([
      getCountFromServer(likesCol),
      myUid ? getDoc(doc(likesCol, myUid)) : Promise.resolve(null),
    ]);
    __ppLikeState.count = cnt.data().count || 0;
    __ppLikeState.liked = !!(mine && mine.exists());
  } catch (e) { console.warn('passport likes read failed', e); }
  ppRenderLike();
}

function ppRenderLike() {
  const btn = document.getElementById('ppLikeBtn');
  const cnt = document.getElementById('ppLikeCount');
  if (!btn) return;
  btn.classList.toggle('liked', __ppLikeState.liked);
  const ico = btn.querySelector('.pp-like-ico');
  if (ico) ico.innerHTML = __ppLikeState.liked ? window.ICONS.heartFill : window.ICONS.heart;
  if (cnt) cnt.textContent = __ppLikeState.count ? String(__ppLikeState.count) : '';
}

async function ppToggleLike(forceLike) {
  const st = __ppLikeState;
  if (!st.uid || st.busy) return;
  if (window.requireAuth && !window.requireAuth('to like a course')) return;
  const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  if (!myUid) return;
  const wantLiked = forceLike ? true : !st.liked;
  if (wantLiked === st.liked) { ppRenderLike(); return; } // double-tap on an already-liked post
  st.busy = true;
  // Optimistic
  st.liked = wantLiked; st.count += wantLiked ? 1 : -1; if (st.count < 0) st.count = 0;
  ppRenderLike();
  try {
    const { getFirestore, doc, setDoc, deleteDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const ref = doc(db, 'passport', st.uid, 'played', st.courseId, 'likes', myUid);
    if (wantLiked) await setDoc(ref, { createdAt: serverTimestamp() });
    else await deleteDoc(ref);
  } catch (e) {
    console.warn('passport like write failed', e);
    // Revert
    st.liked = !wantLiked; st.count += wantLiked ? -1 : 1; if (st.count < 0) st.count = 0;
    ppRenderLike();
    showToast('Could not update like. Try again.', 'error');
  } finally { st.busy = false; }
}

function ppWireDoubleTapLike(uid, courseId) {
  const strip = document.getElementById('ppDetailPhotos');
  if (!strip) return;
  const burst = () => {
    const h = document.getElementById('ppHeartBurst');
    if (!h) return;
    h.classList.remove('go'); void h.offsetWidth; h.classList.add('go');
  };
  strip.addEventListener('dblclick', () => { burst(); ppToggleLike(true); });
  // Touch double-tap — ignore swipes (the strip is now a photo carousel).
  let lastTap = 0, sx = 0, sy = 0, moved = false;
  strip.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; moved = false; }, { passive: true });
  strip.addEventListener('touchmove', (e) => { const t = e.changedTouches[0]; if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) moved = true; }, { passive: true });
  strip.addEventListener('touchend', () => {
    if (moved) { lastTap = 0; return; }
    const now = Date.now();
    if (now - lastTap < 300) { burst(); ppToggleLike(true); lastTap = 0; }
    else lastTap = now;
  }, { passive: true });
}

// ── Comments ─────────────────────────────────────────────────────────
async function ppLoadComments(uid, courseId) {
  const list = document.getElementById('ppCommentList');
  const formWrap = document.getElementById('ppCommentFormWrap');
  const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  const isOwner = !!(myUid && myUid === uid);
  let comments = [];
  try {
    const { getFirestore, collection, getDocs, query, orderBy, limitToLast } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // Bounded: newest 100 (was an unbounded read of the whole subcollection).
    const snap = await getDocs(query(collection(db, 'passport', uid, 'played', courseId, 'comments'), orderBy('createdAt'), limitToLast(100)));
    snap.forEach(d => comments.push({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('passport comments read failed', e); }
  // Author identity from profiles/{authorUid}, never from the comment doc.
  const authors = comments.map(cm => ({ uid: cm.authorUid }));
  await ppResolvePosters(authors);
  comments.forEach((cm, i) => {
    cm._name = authors[i].ownerName || 'Golfer';
    cm._avatar = authors[i].ownerAvatar || '';
  });
  if (list) {
    list.innerHTML = comments.length
      ? comments.map(cm => {
          const canDel = !!(myUid && (myUid === cm.authorUid || isOwner));
          const ava = cm._avatar
            ? `<img src="${window.safeAttr(cm._avatar)}" alt="" loading="lazy" />`
            : `<span class="pf-ava-fallback">${window.safeText((cm._name || 'G').slice(0, 1).toUpperCase())}</span>`;
          const au = window.safeAttr(window.safeId(cm.authorUid || ''));
          return `<div class="pp-comment">
            <button type="button" class="pp-comment-ava" data-action="passport-comment-user" data-uid="${au}" aria-label="View profile">${ava}</button>
            <div class="pp-comment-body"><button type="button" class="pp-comment-name" data-action="passport-comment-user" data-uid="${au}">${window.safeText(cm._name)}</button>${window.safeText(cm.text || '')}</div>
            ${canDel ? `<button type="button" class="pp-comment-del" data-action="passport-comment-del" data-uid="${window.safeAttr(uid)}" data-course="${window.safeAttr(courseId)}" data-id="${window.safeAttr(cm.id)}" aria-label="Delete comment">&times;</button>` : ''}
          </div>`;
        }).join('')
      : '<div class="pp-comment-empty">No comments yet. Be the first.</div>';
  }
  if (formWrap) {
    formWrap.innerHTML = myUid
      ? `<div class="pp-comment-form">
           <textarea class="pp-comment-input" id="ppCommentInput" rows="1" maxlength="500" placeholder="Add a comment…"></textarea>
           <button type="button" class="pp-comment-send" data-action="passport-comment-send" data-uid="${window.safeAttr(uid)}" data-course="${window.safeAttr(courseId)}">Post</button>
         </div>`
      : `<div class="pp-comment-empty">Sign in to join the conversation.</div>`;
  }
}

async function ppSendComment(uid, courseId) {
  const input = document.getElementById('ppCommentInput');
  if (!input) return;
  const text = (input.value || '').trim().slice(0, 500);
  if (!text) return;
  const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  if (!myUid) { window.requireAuth && window.requireAuth('to comment'); return; }
  input.disabled = true;
  try {
    const { getFirestore, collection, addDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // No authorName on the doc — resolved from profiles/{authorUid} on render
    // (audit 2026-09-17: stored names were spoofable).
    await addDoc(collection(db, 'passport', uid, 'played', courseId, 'comments'), {
      authorUid: myUid, text, createdAt: serverTimestamp(),
    });
    input.value = '';
    await ppLoadComments(uid, courseId);
  } catch (e) {
    console.warn('passport comment write failed', e);
    showToast('Could not post comment. Try again.', 'error');
  } finally { input.disabled = false; }
}

async function ppDeleteComment(uid, courseId, commentId) {
  try {
    const { getFirestore, doc, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await deleteDoc(doc(db, 'passport', uid, 'played', courseId, 'comments', commentId));
    await ppLoadComments(uid, courseId);
  } catch (e) { console.warn('passport comment delete failed', e); showToast('Could not delete. Try again.', 'error'); }
}

// ── Passport FEED (Discover) ─────────────────────────────────────────
const __ppPosterCache = {};
let __ppFeedHTML = ''; // last rendered feed, for instant reopen (refreshed in bg)
// r253: the in-memory cache dies with the tab, so every fresh session paid
// the full skeleton wait (query + profile reads) on first open — the "lags
// and doesn't show the photos" report. Persist the last render to
// localStorage (our own safeText/safeAttr-built markup, same string the
// in-memory path already replays) and paint it instantly; the fetch below
// still runs and swaps only if content changed. VERSIONED so a build that
// changes card markup never replays a stale shape, and TTL'd to 24h.
const __PP_FEED_LS = 'tb_pp_feed_v1';
function ppReadFeedCache() {
  try {
    const raw = localStorage.getItem(__PP_FEED_LS);
    if (!raw) return '';
    const o = JSON.parse(raw);
    if (!o || typeof o.html !== 'string' || !o.at) return '';
    if (Date.now() - o.at > 24 * 3600 * 1000) return '';
    return o.html;
  } catch (_e) { return ''; }
}
function ppWriteFeedCache(html) {
  try {
    if (!html || html.length > 400000) return; // respect LS quota
    localStorage.setItem(__PP_FEED_LS, JSON.stringify({ html, at: Date.now() }));
  } catch (_e) { /* quota/private mode — instant-open just degrades */ }
}

async function openPassportFeed() {
  const screen = document.getElementById('passportFeedScreen');
  const body = document.getElementById('passportFeedBody');
  if (!screen || !body) return;
  screen.classList.add('open'); screen.setAttribute('aria-hidden', 'false');
  (document.getElementById('app-scroll') || document.body).style.overflowY = 'hidden';
  body.scrollTop = 0;
  // Instant paint: reuse the last render if we have it (then refresh below);
  // else the persisted last-session render (photos come from HTTP cache);
  // only a true first-timer sees the layout-matching skeleton.
  if (!__ppFeedHTML) __ppFeedHTML = ppReadFeedCache();
  if (__ppFeedHTML) { body.innerHTML = __ppFeedHTML; ppWireFeed(); }
  else body.innerHTML = ppFeedSkeleton();
  let posts = [];
  try {
    const fs = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const { getFirestore, collectionGroup, getDocs, query, where, orderBy, limit } = fs;
    const db = getFirestore();
    let snap;
    try {
      // Preferred: photo rounds only, newest first (collection-group index
      // hasPhotos ASC, createdAt DESC). Filtering server-side means the
      // feed can't shrink toward empty as photo-less rounds accumulate.
      snap = await getDocs(query(collectionGroup(db, 'played'),
        where('hasPhotos', '==', true), orderBy('createdAt', 'desc'), limit(60)));
    } catch (_e1) {
      try {
        snap = await getDocs(query(collectionGroup(db, 'played'), orderBy('createdAt', 'desc'), limit(60)));
      } catch (_e2) {
        snap = await getDocs(query(collectionGroup(db, 'played'), limit(200)));
      }
    }
    snap.forEach(d => {
      const data = d.data() || {};
      const parent = d.ref.parent && d.ref.parent.parent;
      const uid = parent ? parent.id : null;
      if (!uid) return;
      posts.push({
        uid, courseId: data.courseId, courseName: data.courseName, grade: data.grade,
        photos: Array.isArray(data.photos) ? data.photos : [], review: data.review || '',
        photoVariants: data.photoVariants || null,
        createdAt: data.createdAt, ownerName: data.ownerName || '', ownerAvatar: data.ownerAvatar || '',
        likeCount: Number(data.likeCount || 0), // r361: server-maintained (onPassportLikeWritten)
      });
    });
  } catch (e) { console.warn('passport feed read failed', e); }
  // Photo-driven feed — only rounds with at least one photo.
  posts = posts.filter(p => p.photos && p.photos.length);
  posts.sort((a, b) => {
    const am = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
    const bm = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
    return bm - am;
  });
  posts = posts.slice(0, 60);
  if (!posts.length) {
    __ppFeedHTML = '';
    body.innerHTML = '<div class="pf-empty">No rounds posted yet.<br>Post a course you’ve played with a photo and it shows up here.' +
      '<br><button type="button" class="pf-empty-cta" data-action="passport-post">Post your first round</button></div>';
    return;
  }
  const cat = await loadPassportCourses();
  await ppResolvePosters(posts);
  // First two cards load their lead photo eagerly at high priority — with
  // everything lazy, above-the-fold photos didn't even START downloading
  // until after layout (the visible "photos missing" beat on open).
  const html = posts.map((p, i) => ppFeedCard(p, cat, { eager: i < 2 })).join('');
  // Only repaint if the content actually changed (avoids a flash when the
  // cached render already matches what we just fetched). Compare against the
  // previous SOURCE string — innerHTML re-serialises entities (e.g. &#10084;)
  // so comparing to the DOM was always "different".
  const changed = html !== __ppFeedHTML;
  __ppFeedHTML = html;
  ppWriteFeedCache(html); // survive the session (r253 instant-open)
  if (changed) { body.innerHTML = html; ppWireFeed(); }
}

// Resolve poster identity from profiles/{uid} (session-cached). Never trust
// name/avatar stored on the post — audit 2026-09-17: those were client-
// supplied and could impersonate another member in the feed.
async function ppResolvePosters(posts) {
  posts.forEach(p => { p.ownerName = ''; p.ownerAvatar = ''; });
  const need = [...new Set(posts.filter(p => !__ppPosterCache[p.uid]).map(p => p.uid))];
  if (need.length) {
    try {
      const { getFirestore, doc, getDoc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const db = getFirestore();
      await Promise.all(need.map(async uid => {
        try {
          const s = await getDoc(doc(db, 'profiles', uid));
          const d = s.exists() ? s.data() : {};
          __ppPosterCache[uid] = { name: d.displayName || 'Golfer', avatar: d.avatarUrl || '' };
        } catch (_e) { __ppPosterCache[uid] = { name: 'Golfer', avatar: '' }; }
      }));
    } catch (_e) { /* best-effort */ }
  }
  posts.forEach(p => {
    const m = __ppPosterCache[p.uid] || {};
    p.ownerName = p.ownerName || m.name || 'Golfer';
    p.ownerAvatar = p.ownerAvatar || m.avatar || '';
  });
}

// r254: prefer the w400/w800 WebP variants the reworked
// optimizePassportPhoto emits (keyed by file basename; backfilled for all
// pre-existing photos). Originals stay the fallback for any round whose
// variants don't exist (fresh upload mid-generation) — a card never points
// at a variant that isn't there.
function ppPhotoBasename(url) {
  try {
    const path = decodeURIComponent(String(url).split('/o/')[1].split('?')[0]);
    return String(path.split('/').pop()).replace(/\.[^.]+$/, '');
  } catch (_e) { return ''; }
}
function ppVariantSrc(variants, url, size) {
  const v = variants && variants[ppPhotoBasename(url)];
  return (v && v[size]) || '';
}
// src/srcset attribute string for a feed slide (w400-first) or detail photo
// (w800-first). No variants -> plain original src.
function ppPhotoSrcAttrs(variants, url, big) {
  const w4 = ppVariantSrc(variants, url, 'w400');
  const w8 = ppVariantSrc(variants, url, 'w800');
  const w12 = ppVariantSrc(variants, url, 'w1200'); // r347: may be absent on old rounds
  if (!w4 || !w8) return `src="${window.safeAttr(url)}"`;
  // r347: the srcset now reaches 1200w and ends with the stored original
  // (≥1600px) so a 3x phone at ~1170 physical px picks a sharp file instead
  // of stretching w800. `sizes` describes the CSS width; the browser does the
  // DPR math.
  const main = big ? (w12 || w8) : w4;
  const sizes = big ? '(max-width: 520px) 94vw, 480px' : '(max-width: 640px) 100vw, 600px';
  const set = [`${window.safeAttr(w4)} 400w`, `${window.safeAttr(w8)} 800w`];
  if (w12) set.push(`${window.safeAttr(w12)} 1200w`);
  const orig = window.safeImgUrl ? window.safeImgUrl(url) : '';
  if (orig) set.push(`${window.safeAttr(orig)} 1600w`);
  return `src="${window.safeAttr(main)}" srcset="${set.join(', ')}" sizes="${sizes}"`;
}
// One-shot retry for passport imagery: an aborted/flaky load left a slide
// permanently broken (error state, no retry — the "black cards" report,
// 2026-09-21). Error events don't bubble but do capture; retry each img
// once with a cache-buster.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  if (!img.matches('.pf-slide, .pp-detail-photo')) return;
  if (img.dataset.retried === '1' || !img.src) return;
  img.dataset.retried = '1';
  const u = new URL(img.src, location.href);
  u.searchParams.set('rt', Date.now().toString(36));
  setTimeout(() => { img.src = u.href; }, 400);
}, true);

function ppFeedCard(p, cat, opts) {
  const c = cat.byId[p.courseId] || { shortName: p.courseName || p.courseId, logo: `/assets/logos/${p.courseId}.png` };
  const color = window.PASSPORT_GRADE_COLOR[p.grade] || '#8a7550';
  const ua = window.safeAttr(p.uid), ca = window.safeAttr(p.courseId);
  const ava = p.ownerAvatar
    ? `<img src="${window.safeAttr(p.ownerAvatar)}" alt="" loading="lazy" />`
    : `<span class="pf-ava-fallback">${window.safeText((p.ownerName || 'G').slice(0, 1).toUpperCase())}</span>`;
  // r253: above-the-fold cards eager-load their FIRST slide at high fetch
  // priority; every other photo stays lazy (carousel siblings included).
  const eager = !!(opts && opts.eager);
  const slides = p.photos.map((u, si) => `<img class="pf-slide" ${ppPhotoSrcAttrs(p.photoVariants, u, false)} alt="${window.safeAttr(c.shortName)}" ${eager && si === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} draggable="false" />`).join('');
  const dots = p.photos.length > 1
    ? `<div class="ppc-dots">${p.photos.map((_, i) => `<span class="ppc-dot${i === 0 ? ' on' : ''}"></span>`).join('')}</div>` : '';
  const review = p.review ? (p.review.length > 140 ? p.review.slice(0, 140) + '…' : p.review) : '';
  return `<article class="pf-card">
    <button type="button" class="pf-card-user" data-action="passport-feed-user" data-uid="${ua}">
      <span class="pf-ava">${ava}</span>
      <span class="pf-user-text"><strong>${window.safeText(p.ownerName)}</strong><small>played ${window.safeText(c.shortName)}</small></span>
    </button>
    <div class="pf-media" data-uid="${ua}" data-course="${ca}">
      <div class="pf-carousel">${slides}</div>
      <button type="button" class="pf-course-chip" data-action="open-course-page" data-course="${ca}"><img src="${window.safeAttr(c.logo)}" alt="" />${window.safeText(c.shortName)}</button>
      ${p.grade ? `<span class="pf-grade-seal" style="background:${color}">${window.safeText(p.grade)}</span>` : ''}
      ${dots}
      <div class="pp-heart-burst" aria-hidden="true">${window.ICONS.heartFill}</div>
    </div>
    <div class="pf-foot" data-uid="${ua}" data-course="${ca}">
      <span class="pf-likes${Number(p.likeCount) > 0 ? '' : ' is-zero'}"><span class="pf-likes-ico">${window.ICONS.heart}</span><span class="pf-likes-n">${Number(p.likeCount) > 0 ? Number(p.likeCount).toLocaleString() : ''}</span></span>
    </div>
    ${review ? `<p class="pf-review">${window.safeText(review)}</p>` : ''}
  </article>`;
}

// r360: after a like lands, refresh that card's total from the server (one
// aggregate read) so the number is exact whether the tap was a first like or
// a repeat. likeCount on the round doc is maintained by onPassportLikeWritten.
async function ppRefreshCardLikes(uid, courseId) {
  try {
    const { getFirestore, collection, getCountFromServer } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const cnt = await getCountFromServer(collection(db, 'passport', uid, 'played', courseId, 'likes'));
    const n = cnt.data().count || 0;
    document.querySelectorAll(`.pf-foot[data-uid="${CSS.escape(uid)}"][data-course="${CSS.escape(courseId)}"] .pf-likes`).forEach((el) => {
      el.classList.toggle('is-zero', n === 0);
      const num = el.querySelector('.pf-likes-n'); if (num) num.textContent = n ? n.toLocaleString() : '';
      const ico = el.querySelector('.pf-likes-ico'); if (ico) ico.innerHTML = window.ICONS.heartFill;
      el.classList.add('liked');
    });
  } catch (_e) { /* cosmetic */ }
}

// After the feed HTML is set, wire each card's carousel (dot tracking) and
// its tap gestures (single tap → open detail, double tap → like, swipe →
// native scroll through photos).
function ppWireFeed(root) {
  const scope = root || document.getElementById('passportFeedBody');
  if (!scope) return;
  scope.querySelectorAll('.pf-media').forEach(media => {
    const car = media.querySelector('.pf-carousel');
    const dotsEl = media.querySelector('.ppc-dots');
    const burst = media.querySelector('.pp-heart-burst');
    const uid = media.dataset.uid, courseId = media.dataset.course;
    if (car && dotsEl) ppWireCarouselDots(car, dotsEl);
    ppWireTapLikeOpen(media, {
      burstEl: burst,
      onOpen: () => openPassportCourseDetail(uid, courseId),
      onLike: () => ppLikePost(uid, courseId),
    });
  });
}

// Update the active dot as a carousel is swiped.
function ppWireCarouselDots(scrollEl, dotsEl) {
  const dots = dotsEl.querySelectorAll('.ppc-dot');
  if (dots.length < 2) return;
  let raf = 0;
  scrollEl.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const i = Math.round(scrollEl.scrollLeft / Math.max(1, scrollEl.clientWidth));
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
    });
  }, { passive: true });
}

// Distinguish tap (open) vs double-tap (like) vs swipe (native scroll).
function ppWireTapLikeOpen(el, { onOpen, onLike, burstEl, ignore }) {
  let sx = 0, sy = 0, moved = false, lastTap = 0, singleTimer = null, clickTimer = null, suppressClickUntil = 0, startTarget = null;
  // Real controls inside the tap surface handle their own taps — we must not
  // also open or like. Passport's course chip was the original case; r283
  // reuses this helper for the listing gallery, whose arrows and thumbnails
  // need the same exemption, so the selector is now the caller's to name.
  const IGNORE_SEL = ignore || '.pf-course-chip';
  const onChip = (t) => !!(t && t.closest && t.closest(IGNORE_SEL));
  const burst = () => { if (!burstEl) return; burstEl.classList.remove('go'); void burstEl.offsetWidth; burstEl.classList.add('go'); };
  const doLike = () => { burst(); if (onLike) onLike(); };
  el.addEventListener('dblclick', (e) => { e.preventDefault(); if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } doLike(); });
  el.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; moved = false; startTarget = e.target; }, { passive: true });
  el.addEventListener('touchmove', (e) => { const t = e.changedTouches[0]; if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) moved = true; }, { passive: true });
  el.addEventListener('touchend', () => {
    suppressClickUntil = Date.now() + 600; // swallow the synthetic click after a touch
    if (onChip(startTarget)) { lastTap = 0; return; } // chip handles itself
    if (moved) { lastTap = 0; return; }     // it was a swipe
    const now = Date.now();
    if (now - lastTap < 300) {               // double tap
      if (singleTimer) { clearTimeout(singleTimer); singleTimer = null; }
      lastTap = 0; doLike();
    } else {                                 // maybe a single tap (wait for a possible 2nd)
      lastTap = now;
      singleTimer = setTimeout(() => { singleTimer = null; if (onOpen) onOpen(); }, 300);
    }
  }, { passive: true });
  el.addEventListener('click', (e) => {
    if (onChip(e.target)) return;                // chip's data-action handles it
    if (Date.now() < suppressClickUntil) return; // touch path already handled it
    if (e.detail === 2) return;                  // part of a dblclick
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    clickTimer = setTimeout(() => { clickTimer = null; if (onOpen) onOpen(); }, 260);
  });
}

// Double-tap like from the feed (always likes; double-tap never un-likes,
// matching Instagram). Idempotent — the doc id is the liker's uid.
async function ppLikePost(uid, courseId) {
  if (window.requireAuth && !window.requireAuth('to like a post')) return;
  const myUid = window.CURRENT_USER && window.CURRENT_USER.uid;
  if (!myUid) return;
  try {
    const { getFirestore, doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await setDoc(doc(db, 'passport', uid, 'played', courseId, 'likes', myUid), { createdAt: serverTimestamp() });
    ppRefreshCardLikes(uid, courseId);
  } catch (e) { console.warn('passport feed like failed', e); }
}

function ppFeedSkeleton() {
  const card = '<article class="pf-card"><div class="pf-card-user"><span class="pf-ava skeleton-shimmer"></span>' +
    '<span class="pf-user-text"><span class="pf-skel-line" style="width:40%"></span><span class="pf-skel-line" style="width:28%"></span></span></div>' +
    '<div class="pf-skel-photo skeleton-shimmer"></div></article>';
  return card + card;
}

function closePassportFeed() {
  const s = document.getElementById('passportFeedScreen');
  if (s) { s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); }
  (document.getElementById('app-scroll') || document.body).style.overflowY = '';
}
window.openPassportFeed = openPassportFeed;

// ── Course page — one course, everyone's rounds + the course facts ───
async function openCoursePage(courseId) {
  const screen = document.getElementById('coursePageScreen');
  const body = document.getElementById('coursePageBody');
  const titleEl = document.getElementById('coursePageTitle');
  const subEl = document.getElementById('coursePageSub');
  if (!screen || !body) return;
  screen.classList.add('open'); screen.setAttribute('aria-hidden', 'false');
  (document.getElementById('app-scroll') || document.body).style.overflowY = 'hidden';
  body.scrollTop = 0;
  body.innerHTML = '<div class="pf-loading">Loading…</div>';
  const cat = await loadPassportCourses();
  const c = cat.byId[courseId] ||
    { shortName: courseId, name: courseId, location: '', architect: '', founded: null, logo: `/assets/logos/${courseId}.png` };
  if (titleEl) titleEl.textContent = c.shortName || 'Course';
  if (subEl) subEl.textContent = c.location || '';
  let posts = [];
  try {
    const { getFirestore, collectionGroup, getDocs, query, where, orderBy, limit } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    // Server-side filter (collection-group index courseId ASC, createdAt DESC).
    // Falls back to the old 300-doc scan only if the index isn't there.
    let snap;
    try {
      snap = await getDocs(query(collectionGroup(db, 'played'),
        where('courseId', '==', courseId), orderBy('createdAt', 'desc'), limit(60)));
    } catch (_e) {
      snap = await getDocs(query(collectionGroup(db, 'played'), limit(300)));
    }
    snap.forEach(d => {
      const data = d.data() || {};
      if (data.courseId !== courseId) return;
      const parent = d.ref.parent && d.ref.parent.parent;
      const uid = parent ? parent.id : null;
      if (!uid) return;
      posts.push({
        uid, courseId, courseName: data.courseName, grade: data.grade,
        photos: Array.isArray(data.photos) ? data.photos : [], review: data.review || '',
        createdAt: data.createdAt, ownerName: data.ownerName || '', ownerAvatar: data.ownerAvatar || '',
        likeCount: Number(data.likeCount || 0), // r361: server-maintained (onPassportLikeWritten)
      });
    });
  } catch (e) { console.warn('course page read failed', e); }
  posts.sort((a, b) => {
    const am = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
    const bm = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
    return bm - am;
  });
  await ppResolvePosters(posts);
  const withPhotos = posts.filter(p => p.photos && p.photos.length);
  const cards = withPhotos.length
    ? withPhotos.map(p => ppFeedCard(p, cat)).join('')
    : '<div class="pf-empty">No rounds with photos here yet.</div>';
  const n = posts.length;
  body.innerHTML = ppCourseHero(c) +
    `<div class="cp-count">${n} round${n === 1 ? '' : 's'} logged</div>` + cards;
  ppWireFeed(body);
}

function ppCourseHero(c) {
  const facts = [];
  if (c.architect) facts.push(`<div class="cp-fact"><span class="cp-fact-l">Architect</span><span class="cp-fact-v">${window.safeText(c.architect)}</span></div>`);
  if (c.founded) facts.push(`<div class="cp-fact"><span class="cp-fact-l">Established</span><span class="cp-fact-v">${window.safeText(String(c.founded))}</span></div>`);
  return `<div class="cp-hero">
      <span class="cp-hero-logo"><img src="${window.safeAttr(c.logo)}" alt="${window.safeAttr(c.shortName || '')}" /></span>
      <div class="cp-hero-text">
        <div class="cp-hero-name">${window.safeText(c.name || c.shortName)}</div>
        ${c.location ? `<div class="cp-hero-loc">${window.safeText(c.location)}</div>` : ''}
      </div>
    </div>
    ${facts.length ? `<div class="cp-facts">${facts.join('')}</div>` : ''}`;
}

function closeCoursePage() {
  const s = document.getElementById('coursePageScreen');
  if (s) { s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); }
  const feedOpen = !!(document.getElementById('passportFeedScreen') && document.getElementById('passportFeedScreen').classList.contains('open'));
  if (!feedOpen) (document.getElementById('app-scroll') || document.body).style.overflowY = '';
}
window.openCoursePage = openCoursePage;

// "My Passport": open the signed-in user's profile and scroll to the
// Courses Played wall once it has rendered (profile loads async). From the
// feed/course page we close those overlays first so the profile modal is
// on top.
function openMyPassport() {
  if (window.requireAuth && !window.requireAuth('to see your passport', openMyPassport)) return;
  const uid = window.CURRENT_USER && window.CURRENT_USER.uid;
  if (!uid) return;
  closeCoursePage();
  closePassportFeed();
  openProfile(uid);
  let tries = 0;
  const tick = () => {
    const wall = document.getElementById('passportWall');
    if (wall && !wall.querySelector('.passport-loading')) {
      try { wall.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_e) { wall.scrollIntoView(); }
      return;
    }
    if (++tries < 25) setTimeout(tick, 200); // up to ~5s for the profile reads
  };
  setTimeout(tick, 250);
}
window.openMyPassport = openMyPassport;

function ppDetailClose() {
  const back = document.getElementById('ppDetailBackdrop');
  if (back) { back.classList.remove('open'); back.setAttribute('aria-hidden', 'true'); }
}

async function ppDelete(uid, courseId) {
  if (!confirm('Remove this course from your passport? This cannot be undone.')) return;
  try {
    const { getFirestore, doc, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    await deleteDoc(doc(db, 'passport', uid, 'played', courseId));
    ppDetailClose();
    __ppFeedHTML = ''; // removed round → refresh the feed on next open
    showToast('Course removed.', 'success');
    try { await renderPassportInto(uid, true); } catch (_e) {}
  } catch (e) { console.error('passport delete failed', e); showToast('Could not remove. Try again.', 'error'); }
}

async function onAvatarFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) {
    showToast('That image is too large. Please pick one under 30MB.');
    try { ev.target.value = ''; } catch (_e) {}
    return;
  }
  // Crop/zoom to a square avatar. openCropper outputs a 512px JPEG (well
  // under the 2MB storage cap), so the old downscale-first path is replaced.
  // Cancel = no-op. Reset the input so re-picking the same file re-fires.
  let cropped = null;
  try { cropped = await window.openCropper(file, { round: true, outputSize: 512, title: 'Crop your photo' }); }
  catch (_e) { cropped = null; }
  try { ev.target.value = ''; } catch (_e) {}
  if (!cropped) return;
  let prepared = cropped;
  if (prepared.size > 2 * 1024 * 1024) { try { prepared = await downscaleAvatar(prepared); } catch (_e) {} }
  pendingAvatarFile = prepared;
  const blobUrl = URL.createObjectURL(prepared);
  const preview = document.getElementById('editAvatarPreview');
  if (preview) preview.innerHTML = `<img src="${blobUrl}" alt="" />`;
}

async function saveProfileEdits() {
  if (!window.CURRENT_USER) return;
  // r170: a display name can't be blanked out. Mirrors the server-side
  // reject in the updateProfile callable; validating here keeps the
  // message friendly and the form state intact.
  const _nameVal = document.getElementById('editDisplayName').value.replace(/\s+/g, ' ').trim();
  if (_nameVal.length < 2) {
    showToast('Please enter a display name (at least 2 characters).');
    const _ne = document.getElementById('editDisplayName');
    if (_ne) _ne.focus();
    return;
  }
  const btn = document.getElementById('saveProfileBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const uid = window.CURRENT_USER.uid;
    const updates = {
      displayName: document.getElementById('editDisplayName').value.trim().slice(0, 60),
      bio: document.getElementById('editBio').value.trim().slice(0, 600),
      location: document.getElementById('editLocation').value.trim().slice(0, 80),
      updatedAt: (await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js")).serverTimestamp(),
    };
    const hcRaw = document.getElementById('editHandicap').value;
    if (hcRaw !== '') {
      const hc = Number(hcRaw);
      if (Number.isFinite(hc) && hc >= -10 && hc <= 54) updates.handicap = hc;
    }

    // Golf bag (Feature #6) — split lines, trim, dedupe, drop empties, cap at 14,
    // each entry capped at 60 chars (matches Firestore rule).
    const bagEl = document.getElementById('editGolfBag');
    if (bagEl) {
      const seen = new Set();
      const bag = bagEl.value.split(/\r?\n/)
        .map(s => s.trim().slice(0, 60))
        .filter(s => s.length > 0)
        .filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 14);
      updates.golfBag = bag;
    }

    if (pendingAvatarFile) {
      const { getStorage, ref: sref, uploadBytes, getDownloadURL } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js");
      const st = getStorage();
      // Perf: downscale to a sized avatar before upload (the listing variant
      // pipeline is server-side; this is the client-only equivalent for the
      // single avatar). EXIF-safe via createImageBitmap; falls back to the
      // original file on any failure or if it wouldn't shrink.
      const avaFile = await downscaleAvatar(pendingAvatarFile);
      const ext = (avaFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
      const ref = sref(st, `avatars/${uid}/${Date.now()}.${ext}`);
      await uploadBytes(ref, avaFile);
      updates.avatarUrl = await getDownloadURL(ref);
    }

    // Route profile content edits through the updateProfile callable so the
    // server runs its synchronous content scan before writing profiles/{uid}.
    // (A content violation throws and is handled by the catch below via
    // isContentViolationError → showContentViolationToast.)
    const payload = {
      displayName: updates.displayName,
      bio: updates.bio,
      location: updates.location,
    };
    if ('handicap' in updates) payload.handicap = updates.handicap;
    if ('golfBag' in updates) payload.golfBag = updates.golfBag;
    if ('avatarUrl' in updates) payload.avatarUrl = updates.avatarUrl;
    // fns/httpsCallable are NOT in this plain-script block's scope — resolve
    // locally (see markOrderShipped); a bare ref throws ReferenceError.
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    await httpsCallable(fns, 'updateProfile')(payload);

    PROFILE_CACHE.delete(uid);
    pendingAvatarFile = null;
    // r170: keep the name-gate state in sync so the gate never re-fires
    // after a successful save (and the avatar flag skips the photo nudge).
    if (updates.displayName) {
      window.CURRENT_DISPLAY_NAME = updates.displayName;
      window.CURRENT_PROFILE_NAME = updates.displayName;
    }
    if (updates.avatarUrl) window.CURRENT_PROFILE_AVATAR = updates.avatarUrl;
    // Fire a one-time welcome toast the first time a user gives themselves
    // a real displayName. Keyed per-uid so it never re-fires after profile
    // edits, and never fires if they skip naming themselves.
    const newName = updates.displayName || '';
    const welcomeKey = 'teebox.welcomed.' + uid;
    if (newName && !localStorage.getItem(welcomeKey)) {
      const firstName = newName.split(/\s+/)[0];
      showToast('Welcome, ' + firstName + '!', 'success');
      try { localStorage.setItem(welcomeKey, String(Date.now())); } catch {}
    } else {
      showToast('Profile saved.');
    }
    openProfile(uid);
  } catch (e) {
    console.error('saveProfile failed:', e);
    // Content-violation path: server-side filter rejected the profile
    // update with HttpsError invalid-argument + details.error =
    // 'content_violation' (display name / bio / location). Never echo
    // the matched word or category — audit detail only.
    if (window.isContentViolationError && window.isContentViolationError(e)) {
      showContentViolationToast();
      btn.disabled = false;
      btn.textContent = 'Save Changes';
      return;
    }
    showToast('Could not save profile.');
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

// Pin / unpin a featured listing on the seller's own profile (Feature #7).
// Pass listingId to pin, or null to unpin.
async function pinListingToProfile(listingId) {
  if (!window.CURRENT_USER) { showToast('Sign in to pin listings.'); return; }
  try {
    const { getFirestore, doc, setDoc, deleteField, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const db = getFirestore();
    const uid = window.CURRENT_USER.uid;
    const updates = {
      pinnedListingId: listingId ? String(listingId) : deleteField(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'profiles', uid), updates, { merge: true });
    PROFILE_CACHE.delete(uid);
    showToast(listingId ? 'Listing pinned to profile.' : 'Listing unpinned.');
    // Re-render whichever surface is open.
    const profileOpen = document.getElementById('profileBackdrop')
      && document.getElementById('profileBackdrop').classList.contains('open');
    if (profileOpen) openProfile(uid);
    const dashOpen = document.getElementById('shopDashboard')
      && document.getElementById('shopDashboard').classList.contains('open');
    if (dashOpen) {
      // Repaint the active-listings table so Pin/Unpin labels update.
      try { renderShopTables(); } catch (_) {}
    }
  } catch (e) {
    console.error('pinListing failed:', e);
    showToast('Could not update featured listing.');
  }
}

// ─────────────────────────────────────────────────────────────
// Wire all data-action / data-event handlers in one place so the
// HTML can be free of inline on*= attributes (CSP-friendly).
// ─────────────────────────────────────────────────────────────
window.__actions = window.__actions || {};
const A = window.__actions;

// ──────────────────────────────────────────────────────────
// GUEST GATE — requireAuth(reason, intent)
//   The single place every gated action runs through. If the user is
//   signed in, returns true and the caller proceeds. If the user is a
//   guest, opens the polished "Sign in to continue" prompt with a
//   contextual reason ("Sign in to buy on TeeBox" / "...to like this
//   listing" / etc.) and stashes the original intent so we can replay
//   it after a successful sign-in (deep-link the user back to what
//   they were trying to do).
//
//   Usage:
//     if (!requireAuth('to buy this listing', () => openCheckout(id, qty))) return;
//   Or shorthand for actions that don't need a replay:
//     if (!requireAuth('to send a message')) return;
// ──────────────────────────────────────────────────────────
window.requireAuth = function requireAuth(reason, intent) {
  if (window.CURRENT_USER) return true;
  showSignInPrompt(reason || '', typeof intent === 'function' ? intent : null);
  return false;
};

// ── Display-name gate (r170) ──────────────────────────────
// Mirrors requireAuth's contract: returns true to proceed; otherwise opens
// the "Add your name" modal, stashes the intent for replay after a
// successful save, and returns false. Gates user-to-user ACTIONS only
// (message send, chat open, listing publish) — browsing is NEVER gated.
// Passes on either the resolved profile name (CURRENT_DISPLAY_NAME, stamped
// at sign-in by resolveDisplayName) or the Auth displayName, so it can't
// misfire during the brief post-sign-in resolution window.
window.__pendingNameIntent = null;
window.requireDisplayName = function requireDisplayName(reason, intent) {
  if (!window.CURRENT_USER) return true; // signed-out is requireAuth's job
  if ((window.CURRENT_DISPLAY_NAME || '').trim()) return true;
  if ((window.CURRENT_USER.displayName || '').trim()) return true;
  window.__pendingNameIntent = (typeof intent === 'function') ? intent : null;
  const err = document.getElementById('nameGateError');
  if (err) err.textContent = '';
  const s1 = document.getElementById('nameGateStep1');
  const s2 = document.getElementById('nameGateStep2');
  if (s1) s1.style.display = '';
  if (s2) s2.style.display = 'none';
  const bd = document.getElementById('nameGateBackdrop');
  if (bd) bd.classList.add('open');
  setTimeout(() => { const i = document.getElementById('nameGateInput'); if (i) i.focus(); }, 120);
  return false;
};

async function saveNameGate() {
  const input = document.getElementById('nameGateInput');
  const err = document.getElementById('nameGateError');
  const btn = document.getElementById('nameGateSaveBtn');
  const name = (input ? input.value : '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 2) {
    if (err) err.textContent = 'Please enter your name (at least 2 characters).';
    return;
  }
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const uid = window.CURRENT_USER.uid;
    // The DEPLOYED updateProfile callable treats absent displayName/bio/
    // location as '' and overwrites — send the current bio/location along
    // with the new name so this one-field save can't blank the rest.
    let bio = ''; let location = '';
    try {
      const prof = (typeof loadProfile === 'function') ? await loadProfile(uid) : null;
      bio = (prof && prof.bio) || '';
      location = (prof && prof.location) || '';
    } catch (_e) {}
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    await httpsCallable(fns, 'updateProfile')({ displayName: name, bio, location });
    window.CURRENT_DISPLAY_NAME = name;
    window.CURRENT_PROFILE_NAME = name;
    try { PROFILE_CACHE.delete(uid); } catch (_e) {}
    // Step 2: the optional photo nudge — skipped when they already have a
    // photo or have dismissed the nudge before. Never blocks the intent.
    const first = name.split(/\s+/)[0];
    const fEl = document.getElementById('nameGateFirst');
    if (fEl) fEl.textContent = first;
    const dismissed = (() => { try { return !!localStorage.getItem('teebox.photoNudgeDismissed.' + uid); } catch (_e) { return false; } })();
    if (dismissed || window.CURRENT_PROFILE_AVATAR) {
      finishNameGate();
    } else {
      const s1 = document.getElementById('nameGateStep1');
      const s2 = document.getElementById('nameGateStep2');
      if (s1) s1.style.display = 'none';
      if (s2) s2.style.display = '';
    }
  } catch (e) {
    console.error('name gate save failed', e);
    if (window.isContentViolationError && window.isContentViolationError(e)) {
      if (err) err.textContent = "That name isn't allowed on TeeBox — try a different one.";
    } else if (err) {
      err.textContent = 'Could not save your name. Please try again.';
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function finishNameGate() {
  const bd = document.getElementById('nameGateBackdrop');
  if (bd) bd.classList.remove('open');
  const intent = window.__pendingNameIntent;
  window.__pendingNameIntent = null;
  if (typeof intent === 'function') {
    setTimeout(() => { try { intent(); } catch (e) { console.warn('name-gate intent replay failed:', e); } }, 150);
  }
}

// Enter in the name field = Save (CSP blocks inline handlers).
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target && ev.target.id === 'nameGateInput') {
    ev.preventDefault();
    saveNameGate();
  }
});

window.showSignInPrompt = function showSignInPrompt(reason, intent) {
  // r349: ONE prompt, not two. The gated guest goes straight to the auth
  // screen on the Create Account pane with the contextual reason; the old
  // "Join TeeBox to continue" interstitial (below, unreachable now) added a
  // tap and 3 s on slow links for no information.
  window.__pendingAuthIntent = intent || null;
  window.__pendingAuthReason = reason || '';
  try { window.dismissSignInPrompt && window.dismissSignInPrompt(); } catch (_e) {}
  if (window.setEmailMode) window.setEmailMode('signup');
  // Phase 2: the provider sheet (Apple / Google / email) is the first step.
  if (window.openAuthSheet) { window.openAuthSheet('signup', reason || ''); return; }
  if (window.showAuthScreen) { window.showAuthScreen(reason || ''); return; }
  const backdrop = document.getElementById('signInPromptBackdrop');
  if (!backdrop) return;
  // Compose title + message. r159: title matches the create-first CTA
  // stack (most gated guests are NEW users); the contextual reason still
  // lands in the message.
  const titleEl = document.getElementById('signInPromptTitle');
  const msgEl = document.getElementById('signInPromptMsg');
  if (titleEl) titleEl.textContent = 'Join TeeBox to continue';
  if (msgEl) {
    const r = (reason || '').trim();
    msgEl.textContent = r
      ? `Create a free TeeBox account ${r}.`
      : 'Create a free TeeBox account to keep going.';
  }
  // Stash both the intent (replay after sign-in) and the reason (used
  // by the auth screen banner if the user chooses to continue).
  window.__pendingAuthIntent = intent || null;
  window.__pendingAuthReason = reason || '';
  backdrop.classList.add('open');
};

window.dismissSignInPrompt = function dismissSignInPrompt() {
  const backdrop = document.getElementById('signInPromptBackdrop');
  if (backdrop) backdrop.classList.remove('open');
  // Note: we keep __pendingAuthIntent in case the user re-opens via
  // the nav Sign In pill — they likely still want the deep-link back.
  // It's cleared on auth state change or explicit replay.
};

window.showAuthScreen = function showAuthScreen(reason) {
  const _authScreen = document.getElementById('authScreen');
  if (!_authScreen) return;
  _authScreen.classList.remove('hidden');
  _authScreen.classList.remove('fading-out');
  _authScreen.classList.remove('email-step'); // sheet-email re-adds it after this call
  _authScreen.classList.add('open');
  // Surface the contextual reason inside the auth box so users
  // remember why they're here after the auth gate appears.
  const reasonEl = document.getElementById('authReason');
  const r = (reason || window.__pendingAuthReason || '').trim();
  if (reasonEl) {
    if (r) {
      reasonEl.textContent = `Sign in ${r}.`;
      reasonEl.classList.add('visible');
    } else {
      reasonEl.textContent = '';
      reasonEl.classList.remove('visible');
    }
  }
  // r172: the auth gate is meaningful content — never leave the splash
  // covering it (cold signed-out loads open the gate before listings land).
  try { window.__maybeDismissSplash && window.__maybeDismissSplash(); } catch (_e) {}
  // Focus the email field for keyboard users (skipped on small mobile
  // since the OS keyboard popping is more disruptive than helpful).
  setTimeout(() => {
    try {
      if (window.matchMedia && window.matchMedia('(min-width: 700px)').matches) {
        const emailInput = document.getElementById('emailInput');
        if (emailInput) emailInput.focus();
      }
    } catch (_) {}
  }, 80);
};

window.dismissAuthScreen = function dismissAuthScreen() {
  const _authScreen = document.getElementById('authScreen');
  if (!_authScreen) return;
  // Only flip into GUEST_MODE if the user isn't actually signed in.
  // This function is reused by the OAuth success path (Google/Apple)
  // to defensively close the modal — in that case onAuthStateChanged
  // has already set CURRENT_USER and GUEST_MODE = false, and we must
  // NOT clobber that back to true.
  if (!window.CURRENT_USER) {
    window.GUEST_MODE = true;
  }
  // Remember that the user explicitly dismissed the auth gate so we
  // don't re-open it on subsequent navigations / re-renders this
  // session. In-memory only (NOT sessionStorage) so a true cold app
  // relaunch resets and the gate appears again until the user signs
  // in or taps Continue as guest in that new session.
  window.__authGateDismissedInSession = true;
  _authScreen.classList.remove('open');
  _authScreen.classList.add('hidden');
  _authScreen.classList.remove('fading-out');
  // Clear any reason banner so it doesn't leak into a later session.
  const reasonEl = document.getElementById('authReason');
  if (reasonEl) { reasonEl.textContent = ''; reasonEl.classList.remove('visible'); }
  // Ensure the nav "Sign In" pill is visible so a guest has a way back.
  // For a signed-in user (OAuth success path calls this defensively),
  // the pill must stay hidden — onAuthStateChanged already hid it.
  const _signInBtn = document.getElementById('navSignInBtn');
  if (_signInBtn) {
    _signInBtn.style.display = window.CURRENT_USER ? 'none' : 'inline-flex';
  }
  // Clear any stale errors so they don't appear next time the screen opens.
  ['authErrorEmail', 'authError1', 'authError2'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
};

// r377 (Jake): the cartoon welcome screen IS the login — header/drawer Sign In
// opens it (its buttons lead to the provider sheet), never the old dark gate.
A['show-auth']                = () => { if (window.showWelcome && !window.CURRENT_USER) { window.showWelcome(); return; } window.showAuthScreen(''); };
A['dismiss-sign-in-prompt']   = () => window.dismissSignInPrompt();
A['show-auth-from-prompt']    = () => {
  const reason = window.__pendingAuthReason || '';
  window.dismissSignInPrompt();
  window.showAuthScreen(reason);
  // r159: explicit mode so a previous toggle doesn't stick.
  if (window.setEmailMode) window.setEmailMode('signin');
};
A['show-auth-from-prompt-signup'] = () => {
  // r159: gate primary — the copy promises account creation, the CTA now
  // delivers it (auth screen opens on the Create Account pane).
  const reason = window.__pendingAuthReason || '';
  window.dismissSignInPrompt();
  window.showAuthScreen(reason);
  if (window.setEmailMode) window.setEmailMode('signup');
};
A['set-email-mode']          = (el) => setEmailMode(el.dataset.emailmode);
A['forgot-password']         = () => forgotPassword();
A['submit-email']            = () => submitEmail();
A['sign-in-google']          = async (btn) => {
  const err = document.getElementById('authErrorEmail');
  if (err) err.textContent = '';
  // Loading state on the Google button so a slow popup or native sheet
  // doesn't look frozen. Disable to suppress double-taps that would
  // otherwise spawn two sign-in flows.
  const googleBtn = btn || document.querySelector('.auth-google-btn');
  const labelEl = googleBtn ? googleBtn.querySelector('span') : null;
  const originalLabel = (labelEl && labelEl.textContent) || 'Continue with Google';
  if (googleBtn) googleBtn.disabled = true;
  if (labelEl) labelEl.textContent = 'Signing in…';
  const restoreBtn = () => {
    if (googleBtn) googleBtn.disabled = false;
    if (labelEl) labelEl.textContent = originalLabel;
  };
  try {
    // Native (iOS/Android): use the @capacitor-firebase/authentication plugin
    // so we get the real Google sign-in UI from the OS, not a popup.
    //
    // Important nuance — the native plugin signs the user into the *native*
    // Firebase Auth layer only. Our app's data layer (Firestore, Storage,
    // callable Functions) runs through the Firebase JS SDK inside the
    // WKWebView, which is a *separate* Auth instance. So we have to take
    // the Google id_token returned by the plugin and feed it into the JS
    // SDK via signInWithCredential — otherwise onAuthStateChanged never
    // fires on the web layer, the auth modal stays open, and Firestore
    // requests run unauthenticated.
    //
    // (Also note: the iOS Podfile must depend on the plugin's `Google`
    // subspec — without it, the GIDSignIn flow is compiled out and
    // signInWithGoogle() hangs forever with no result and no error.)
    if (window.IS_NATIVE && window.FBAuthPlugin && typeof window.FBAuthPlugin.signInWithGoogle === 'function') {
      // Custom-token-exchange path. Why we don't call signInWithCredential
      // directly: in WKWebView (Capacitor iOS) the JS-SDK's
      // signInWithCredential -> identitytoolkit accounts:signInWithIdp
      // request hangs indefinitely (confirmed at G5 across Builds 40-45,
      // including after switching to inMemoryPersistence). The
      // accounts:signInWithCustomToken endpoint, by contrast, completes
      // normally in WKWebView. So:
      //   1. Plugin runs the native Google sheet and returns the credential.
      //      skipNativeAuth:true (capacitor.config) so it does NOT also try to
      //      sign into the native Firebase Auth layer — the webview never uses
      //      it, and that step is an extra failure point whose throw surfaces
      //      as an immediate "Could not sign in". We only need the idToken.
      //   2. We send the Google idToken to the
      //      `exchangeIdTokenForCustomToken` Cloud Function, which
      //      verifies it against Google's public keys and mints a
      //      Firebase custom token.
      //   3. We call signInWithCustomToken on the JS SDK — that path
      //      WORKS in WKWebView, onAuthStateChanged fires, modal closes.
      const result = await window.FBAuthPlugin.signInWithGoogle();
      const idToken = result && result.credential && result.credential.idToken;
      if (!idToken) {
        // Plugin returned without a token — usually means the user backed
        // out of the Google sheet. Treat as silent cancel and just
        // restore the button rather than showing a scary error.
        restoreBtn();
        return;
      }
      // Use plain fetch instead of httpsCallable. Cloud Function logs (Build
      // 47) confirmed httpsCallable hangs in iOS WKWebView before the HTTP
      // request leaves the device — never reaches the function. Same family
      // of WKWebView issue as signInWithCredential. fetch() routes through
      // Capacitor's native networking and works correctly.
      const _gX = await window.tbNativeExchange('google.com', { idToken }, 'signin');
      if (_gX && _gX.needsLink) { restoreBtn(); window.tbHandleNeedsLink(Object.assign({ kind: 'native', providerId: 'google.com', idToken }, _gX.needsLink)); return; }
      if (_gX && _gX.relayChoice) { restoreBtn(); window.tbHandleRelayChoice({ providerId: 'google.com', idToken }); return; }
      const customToken = _gX && _gX.customToken;
      if (!customToken) {
        throw new Error('Token exchange returned no customToken');
      }
      // 15s timeout race kept as a defensive net — signInWithCustomToken
      // is the path we believe works in WKWebView, but if anything
      // regresses we still want to surface an error rather than freeze.
      const _g6Start = Date.now();
      await Promise.race([
        window.signInWithCustomToken(window.firebaseAuth, customToken),
        new Promise((_, reject) => setTimeout(() => reject(new Error('signInWithCustomToken timed out after 15s')), 15000)),
      ]);
      const _g6Ms = Date.now() - _g6Start;
      // Belt-and-suspenders cleanup. Previously we relied solely on
      // onAuthStateChanged to hide the auth screen, but on the native
      // plugin path the listener can race with this resolve, leaving
      // the modal stuck on "Signing in…" until force-quit. Defensive
      // double-dismiss: if the listener already started its fade
      // animation we leave it alone (`.fading-out` is set), otherwise
      // we force-hide. Either way the in-memory dismissed flag is
      // already set by the listener.
      const _as = document.getElementById('authScreen');
      if (_as && _as.classList.contains('open') && !_as.classList.contains('fading-out')) {
        try { window.dismissAuthScreen && window.dismissAuthScreen(); } catch (_) {}
      }
      // Fallback: 600ms after the await, if for any reason the modal
      // is still visible OR the button is still in "Signing in…" state,
      // forcibly tear it down. Idempotent on success.
      setTimeout(() => {
        try {
          const _stillOpen = _as && (_as.classList.contains('open') || (_as.style && _as.style.display === 'flex'));
          if (_stillOpen) { window.dismissAuthScreen && window.dismissAuthScreen(); }
          restoreBtn();
        } catch (_) {}
      }, 600);
      return;
    }
    // Web fallback: Firebase Web SDK popup. If popups are blocked the
    // browser surfaces an error we relay below. signInWithPopup resolves
    // only after onAuthStateChanged has propagated, so the auth screen
    // close happens before this await returns — no need to restore.
    const provider = new window.GoogleAuthProvider();
    await window.signInWithPopup(window.firebaseAuth, provider, window.__popupResolver);
  } catch (e) {
    const code = (e && e.code) || '';
    let msg = 'Could not sign in with Google. Try again or use email.';
    // User backed out — the popup/sheet was closed before completion.
    // Don't surface an error message; just restore the button so they
    // can try again.
    if (
      code === 'auth/popup-closed-by-user' ||
      code === 'auth/cancelled-popup-request' ||
      code === 'auth/cancelled' ||
      code === 'auth/user-cancelled' ||
      /cancel/i.test((e && e.message) || '')
    ) {
      restoreBtn();
      return;
    }
    if (code === 'auth/popup-blocked') msg = 'Pop-up blocked. Allow pop-ups or use email sign-in.';
    else if (code === 'auth/network-request-failed') msg = 'Network error. Check your connection and try again.';
    else if (code === 'auth/account-exists-with-different-credential') {
      restoreBtn();
      await window.tbHandleAccountExists(e, 'google.com');
      return;
    } else if (code === 'teebox/email-exists-different-method') {
      // r186 §8: native exchange-path twin of the case above.
      msg = 'An account with that email already exists. Sign in with your email and password instead.';
    } else if (code === 'auth/internal-error') {
      msg = 'Something went wrong. Force-quit the app and try again, or use email sign-in.';
    }
    if (err) err.textContent = msg;
    console.warn('[auth] google sign-in failed:', code, e && e.message);
    restoreBtn();
  }
};
A['sign-in-apple']           = async (btn) => {
  const err = document.getElementById('authErrorEmail');
  if (err) err.textContent = '';
  const appleBtn = btn || document.querySelector('.auth-apple-btn');
  const labelEl = appleBtn ? appleBtn.querySelector('span') : null;
  const originalLabel = (labelEl && labelEl.textContent) || 'Continue with Apple';
  if (appleBtn) appleBtn.disabled = true;
  if (labelEl) labelEl.textContent = 'Signing in…';
  const restoreBtn = () => {
    if (appleBtn) appleBtn.disabled = false;
    if (labelEl) labelEl.textContent = originalLabel;
  };
  try {
    // Native iOS: use the Capacitor plugin so we get the OS's Apple sheet.
    // Same JS-SDK bridge pattern as Google — exchange the credential into
    // the JS Auth instance so Firestore/Storage/Functions get an authed user.
    if (window.IS_NATIVE && window.FBAuthPlugin && typeof window.FBAuthPlugin.signInWithApple === 'function') {
      // Custom-token-exchange path (same rationale as Google above —
      // signInWithCredential hangs in WKWebView, signInWithCustomToken
      // doesn't). For Apple specifically:
      //   - skipNativeAuth: true keeps the iOS Firebase SDK from
      //     consuming the single-use Apple identity token (Apple
      //     id_tokens are one-shot — without this flag the plugin
      //     burns it during native auth and our exchange call would
      //     get a "Duplicate credential" / nonce error from Apple).
      //   - The plugin generates a random nonce, hashes it with
      //     SHA-256, and includes the hash in the ASAuthorization
      //     request. We forward the un-hashed `rawNonce` to the
      //     Cloud Function so it can verify the hash inside Apple's
      //     id_token.
      const result = await window.FBAuthPlugin.signInWithApple({ skipNativeAuth: true });
      const idToken = result && result.credential && result.credential.idToken;
      const rawNonce = result && result.credential && result.credential.nonce;
      if (!idToken) {
        // User backed out — silent restore.
        restoreBtn();
        return;
      }
      // Plain fetch — see Google handler comment for rationale.
      const _aX = await window.tbNativeExchange('apple.com', { idToken, rawNonce }, 'signin');
      if (_aX && _aX.needsLink) { restoreBtn(); window.tbHandleNeedsLink(Object.assign({ kind: 'native', providerId: 'apple.com', idToken, rawNonce }, _aX.needsLink)); return; }
      if (_aX && _aX.relayChoice) { restoreBtn(); window.tbHandleRelayChoice({ providerId: 'apple.com', idToken, rawNonce }); return; }
      const customToken = _aX && _aX.customToken;
      if (!customToken) {
        throw new Error('Token exchange returned no customToken');
      }
      const _a6Start = Date.now();
      await Promise.race([
        window.signInWithCustomToken(window.firebaseAuth, customToken),
        new Promise((_, reject) => setTimeout(() => reject(new Error('signInWithCustomToken timed out after 15s')), 15000)),
      ]);
      const _a6Ms = Date.now() - _a6Start;
      // Same race-safety as the Google path. If the onAuthStateChanged
      // listener hasn't already started fading the modal out, force it.
      const _as = document.getElementById('authScreen');
      if (_as && _as.classList.contains('open') && !_as.classList.contains('fading-out')) {
        try { window.dismissAuthScreen && window.dismissAuthScreen(); } catch (_) {}
      }
      // Idempotent fallback: 600ms later, if the modal is somehow still
      // visible, force-hide it and restore the button.
      setTimeout(() => {
        try {
          const _stillOpen = _as && (_as.classList.contains('open') || (_as.style && _as.style.display === 'flex'));
          if (_stillOpen) { window.dismissAuthScreen && window.dismissAuthScreen(); }
          restoreBtn();
        } catch (_) {}
      }, 600);
      return;
    }
    // Web fallback: Firebase popup with OAuthProvider('apple.com').
    // Apple Sign In on web requires the Service ID + return URL configured
    // in Firebase Console > Auth > Sign-in method > Apple.
    const provider = new window.OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
    await window.signInWithPopup(window.firebaseAuth, provider, window.__popupResolver);
  } catch (e) {
    const code = (e && e.code) || '';
    let msg = 'Could not sign in with Apple. Try again or use email.';
    if (
      code === 'auth/popup-closed-by-user' ||
      code === 'auth/cancelled-popup-request' ||
      code === 'auth/cancelled' ||
      code === 'auth/user-cancelled' ||
      /cancel/i.test((e && e.message) || '')
    ) {
      restoreBtn();
      return;
    }
    if (code === 'auth/popup-blocked') msg = 'Pop-up blocked. Allow pop-ups or use email sign-in.';
    else if (code === 'auth/network-request-failed') msg = 'Network error. Check your connection and try again.';
    else if (code === 'auth/account-exists-with-different-credential') {
      restoreBtn();
      await window.tbHandleAccountExists(e, 'apple.com');
      return;
    } else if (code === 'auth/operation-not-allowed') {
      msg = 'Apple Sign In is not enabled yet. Use email or Google for now.';
    } else if (code === 'auth/internal-error') {
      msg = 'Something went wrong. Force-quit the app and try again, or use email sign-in.';
    }
    if (err) err.textContent = msg;
    console.warn('[auth] apple sign-in failed:', code, e && e.message);
    restoreBtn();
  }
};
A['continue-as-guest']       = () => {
  window.GUEST_MODE = true;
  // Remember the dismissal so the auth gate doesn't auto-reopen on
  // the next render this session. In-memory only — a true cold
  // relaunch (force-quit on iOS) wipes this and re-shows the gate.
  window.__authGateDismissedInSession = true;
  // Clear any reason banner + pending intent — the user explicitly
  // chose to skip sign-in, so the previously-stashed deep-link
  // intent should not silently fire later.
  window.__pendingAuthIntent = null;
  window.__pendingAuthReason = '';
  const reasonEl = document.getElementById('authReason');
  if (reasonEl) { reasonEl.textContent = ''; reasonEl.classList.remove('visible'); }
  const _authScreen = document.getElementById('authScreen');
  if (_authScreen) {
    _authScreen.classList.remove('open');
    _authScreen.classList.add('hidden');
    _authScreen.classList.remove('fading-out');
  }
  // Clear any stale errors so they don't reappear next time.
  ['authErrorEmail', 'authError1', 'authError2'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  // Show the nav Sign In pill so guests can return on demand.
  const _signInBtn = document.getElementById('navSignInBtn');
  if (_signInBtn) _signInBtn.style.display = 'inline-flex';
  // If a deep-link asked us to land on Bingo, honor it now.
  if (window.__pendingDeepLink === 'bingo') {
    window.__pendingDeepLink = null;
    if (typeof window.openBingo === 'function') window.openBingo();
  }
};
A['close-verify']            = () => closeVerifyModal();
A['become-seller']           = () => { if (!window.requireAuth('to become a seller on TeeBox')) return; becomeSeller(); };
A['close-shop-dashboard']    = () => closeShopDashboard();
A['switch-dash-tab']         = (el) => switchDashTab(el.dataset.tab);
// Same switch, but scrolls the tab strip into view — used by the ship-it
// banner at the top of My Shop, which sits far above the tabs.
A['switch-dash-tab-scroll']  = (el) => switchDashTab(el.dataset.tab, {scroll: true});
A['accept-email-fix']        = (el) => {
  const inp = document.getElementById('emailInput');
  if (inp && el && el.dataset.fix) {
    inp.value = el.dataset.fix;
    const h = document.getElementById('emailTypoHint');
    if (h) { h.style.display = 'none'; h.innerHTML = ''; }
    try { inp.focus(); } catch (_e) {}
  }
};
A['toggle-advanced-insights']= (el) => {
  const sec = document.getElementById('advancedSection');
  if (!sec) return;
  const isOpen = sec.classList.toggle('open');
  el.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  // Render lazily on first open so we don't compute on every dashboard mount.
  if (isOpen) { try { renderAdvancedInsights(); } catch (_) {} }
};
A['open-pro-upgrade']        = () => {
  if (!window.CURRENT_USER) { showToast('Sign in to upgrade.'); return; }
  // iOS guard (Apple Guideline 3.1.1): never open the Pro upgrade modal
  // on Capacitor — the CTA is hidden but a stray deep-link / programmatic
  // call shouldn't bypass that. Free users on iOS are simply not offered
  // the upsell in-app; they can upgrade at teeboxmarket.com on web.
  const _Cap = window.Capacitor;
  if (_Cap && _Cap.isNativePlatform && _Cap.isNativePlatform()) {
    return;
  }
  // Reset the button state in case it's still in the loading state from a
  // previous open (e.g. the user closed Checkout and came back).
  const btn = document.getElementById('proUpgradeBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Upgrade now'; }
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  const back = document.getElementById('proUpgradeBackdrop');
  if (back) back.classList.add('open');
};
A['upgrade-to-pro']          = async () => {
  if (!window.CURRENT_USER) { showToast('Sign in to upgrade.'); return; }
  // iOS guard (Apple Guideline 3.1.1): block the actual Stripe Checkout
  // call on native too, in case anyone wires up a button that triggers
  // this action through a code path that bypasses the modal.
  const _Cap = window.Capacitor;
  if (_Cap && _Cap.isNativePlatform && _Cap.isNativePlatform()) {
    return;
  }
  const btn = document.getElementById('proUpgradeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening Stripe…'; }
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'createSubscriptionCheckout');
    const res = await fn();
    const url = res && res.data && res.data.url;
    if (!url) throw new Error('No checkout URL returned');
    // On Capacitor (iOS), open in the system browser so Stripe Checkout
    // gets the cookies + Apple Pay it expects. On web, just navigate.
    const Cap = window.Capacitor;
    if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
      window.location.href = url;
    } else {
      window.location.href = url;
    }
  } catch (e) {
    console.error('upgrade-to-pro failed:', e);
    const msg = (e && e.message) ? String(e.message) : '';
    if (msg.includes('already on Pro')) {
      showToast("You're already on Pro. Use Manage subscription to make changes.");
    } else if (msg.includes('not configured')) {
      showToast('Pro upgrades aren’t available yet. Check back soon.');
    } else {
      showToast('Could not start the upgrade. Try again in a moment.');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Upgrade now'; }
  }
};
A['manage-subscription']     = async () => {
  if (!window.CURRENT_USER) { showToast('Sign in to manage your subscription.'); return; }
  // iOS guard (Apple Guideline 3.1.1): on native, point Pro subscribers
  // back to teeboxmarket.com to manage billing instead of opening
  // Stripe's portal in-app (which Apple treats as an out-of-app
  // digital-goods flow).
  const _Cap = window.Capacitor;
  if (_Cap && _Cap.isNativePlatform && _Cap.isNativePlatform()) {
    showToast('Manage your Pro subscription at teeboxmarket.com.');
    return;
  }
  showToast('Opening billing portal…');
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'createBillingPortalSession');
    const res = await fn();
    const url = res && res.data && res.data.url;
    if (!url) throw new Error('No portal URL returned');
    const Cap = window.Capacitor;
    if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
      window.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (e) {
    console.error('manage-subscription failed:', e);
    showToast('Could not open billing portal. Try again later.');
  }
};
// Stale-claim guard (2026-08-05 first-listing incident): clicking the email
// verify link updates the ACCOUNT instantly, but the cached ID token keeps
// email_verified=false for up to an hour — and callables + firestore.rules
// trust the TOKEN. When the live record says verified but the cached claim
// doesn't, force-mint a fresh token. getIdTokenResult() reads the cached
// token (no network), so the refresh round-trip only happens on the rare
// stale path. Never throws — the server has its own live-record fallback.
// r262b (Phase 2): requestIdleCallback alone was the wrong trigger. On a
// throttled phone the main thread goes "idle" at ~4.8s — while the feed is
// still waiting on Firestore — so deferred work (reCAPTCHA, pixel) started
// exactly when it would compete with the product render, and products
// painted LATER than before the change (10.5s -> 12.8s, measured). Gate
// background work on the feed actually having painted, with a hard cap so a
// page without a grid (or an empty marketplace) still runs it.
// r351: concurrency-capped thumbnail loader. IntersectionObserver with a short
// lookahead decides WHEN a deferred card image may load; at most
// THUMB_MAX_INFLIGHT download at once (queue drains on load/error). On a
// 50 KB/s link this bounds the bandwidth the feed can take from a sign-up or
// checkout call to ~4 small files instead of ~30.
(function thumbLoader() {
  const THUMB_MAX_INFLIGHT = 4;
  const queue = []; let inflight = 0;
  const pump = () => {
    while (inflight < THUMB_MAX_INFLIGHT && queue.length) {
      const img = queue.shift();
      if (!img.isConnected || !img.dataset.src) continue;
      inflight++;
      const done = () => { inflight--; img.removeEventListener('load', done); img.removeEventListener('error', done); pump(); };
      img.addEventListener('load', done); img.addEventListener('error', done);
      if (img.dataset.srcset) img.srcset = img.dataset.srcset;
      img.src = img.dataset.src;
      delete img.dataset.src; delete img.dataset.srcset;
      img.classList.remove('thumb-deferred');
    }
  };
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
    for (const e of entries) { if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target); } }
    pump();
  }, {rootMargin: '240px 0px'}) : null;
  window.__thumbLoader = {
    scan() {
      const imgs = document.querySelectorAll('img.thumb-deferred[data-src]:not([data-thumb-seen])');
      imgs.forEach((img) => { img.dataset.thumbSeen = '1'; if (io) io.observe(img); else { queue.push(img); } });
      if (!io) pump();
    },
    stats() { return {queued: queue.length, inflight}; },
  };
  // Re-scan whenever the grid re-renders (loadListings / filters replace innerHTML).
  const grid = document.getElementById('productGrid');
  if (grid && 'MutationObserver' in window) new MutationObserver(() => window.__thumbLoader.scan()).observe(grid, {childList: true});
  window.__thumbLoader.scan();
})();
window.__afterFeedPaint = function (fn, capMs) {
  let fired = false;
  const run = () => {
    if (fired) return;
    fired = true;
    try { (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(fn, {timeout: 2000}); }
    catch (_e) { setTimeout(fn, 200); }
  };
  const t0 = Date.now();
  const cap = capMs || 7000;
  const tick = () => {
    if (fired) return;
    const grid = document.getElementById('productGrid');
    if ((grid && grid.querySelector('.product-card')) || (Date.now() - t0) > cap) return run();
    setTimeout(tick, 200);
  };
  setTimeout(tick, 200);
};

window.__ensureVerifiedClaimFresh = async function() {
  const u = window.CURRENT_USER;
  if (!u || !u.emailVerified) return;
  try {
    const t = await u.getIdTokenResult();
    if (!t || !t.claims || t.claims.email_verified !== true) {
      await u.getIdToken(true);
    }
  } catch (_e) { /* best-effort */ }
};
// r348 LIST-FIRST: buyer tapped "Seller is finishing setup — tap to get
// notified". Guests sign in first (replay lands back here). Server records
// listingInterest/{listingId}_{uid}, nudges the seller, and notifies this
// buyer when the seller becomes charges-ready. Idempotent per buyer+listing.
A['notify-seller-setup']     = async () => {
  const pid = currentDetailId;
  if (!pid) return;
  if (!window.requireAuth('to get notified when this is buyable', () => { setTimeout(() => A['notify-seller-setup'](), 300); })) return;
  const btn = document.getElementById('detailBuyNowBtn');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'One sec…'; }
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fn = httpsCallable(getFunctions(), 'notifySellerInterest');
    const res = await fn({ listingId: String(pid) });
    const d = (res && res.data) || {};
    if (d.alreadyBuyable) {
      // Seller finished while the buyer was looking — reload the card as buyable.
      showToast('Good news — this is buyable now.', 'success');
      try { if (window.PROFILE_CACHE) delete window.PROFILE_CACHE[String((window.PRODUCTS.find(x => String(x.id) === String(pid)) || {}).sellerId)]; } catch (_e) {}
      if (btn) { delete btn.dataset.notifySetup; btn.classList.remove('is-notify-setup'); btn.disabled = false; btn.textContent = 'Buy Now'; }
      const note = document.getElementById('detailNotBuyableNote'); if (note) note.style.display = 'none';
      return;
    }
    try { localStorage.setItem('tb_interest_' + pid, '1'); } catch (_e) {}
    if (btn) { btn.textContent = 'We’ll let you know when it’s buyable'; btn.style.opacity = '0.6'; btn.style.cursor = 'default'; }
    const note = document.getElementById('detailNotBuyableNote');
    if (note) { note.textContent = 'You’re on the list — we’ll notify you the moment it’s available. You can still message the seller.'; note.style.display = ''; }
    showToast(d.duplicate ? 'You’re already on the list for this one.' : 'Got it — we’ll notify you when it’s buyable.', 'success');
  } catch (e) {
    console.warn('notifySellerInterest failed:', e && e.code, e && e.message);
    if (btn) { btn.disabled = false; btn.textContent = prev; }
    const m = (e && e.message) || '';
    showToast(/own listing/i.test(m) ? 'That’s your own listing.' : (/isn.t available/i.test(m) ? 'This listing isn’t available anymore.' : 'Couldn’t save that — try again.'), 'error');
  }
};
function showStripeConnecting(on) {
  const el = document.getElementById('stripeConnectingOverlay');
  if (!el) return;
  el.classList.toggle('open', !!on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}
window.showStripeConnecting = showStripeConnecting;
A['stripe-connect']          = async () => {
  if (!window.requireAuth('to set up payouts')) return;
  // Email verification no longer gates Stripe onboarding (founder ruling
  // 2026-09-13) — Stripe's own KYC is the identity gate, so go straight to
  // onboarding. The server no longer rejects on unverified email.
  // If the Stripe-required gate modal is open, close it so the seller's
  // listing draft is visible underneath when they return from onboarding.
  try { closeStripeRequiredDirect(); } catch (_e) {}
  // r348: visible interstitial instead of a toast — link minting takes 1–3 s
  // and the tap used to look dead. Cleared on any failure; on success the
  // page navigates away under it.
  showStripeConnecting(true);
  // If the user already has a payouts-enabled Connect account, this
  // click is a CHANGE (not an initial setup) — fire the payout-method-
  // changed security alert so a hijacker rerouting funds gets caught.
  // We read the cached status off window.LAST_STRIPE_STATUS (set by
  // renderStripeConnectBanner on dashboard render); if absent we skip
  // the alert silently — we'd rather under-alert than spam every
  // first-time onboarder. The authoritative producer for the alert
  // would be a Stripe Connect `account.external_account.updated`
  // webhook (open question — not yet wired in functions/index.js).
  const wasAlreadyEnabled =
    !!(window.LAST_STRIPE_STATUS &&
       window.LAST_STRIPE_STATUS.payoutsEnabled);
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns = getFunctions();
    const fn = httpsCallable(fns, 'createStripeOnboardingLink');
    const res = await fn();
    const url = res && res.data && res.data.url;
    if (!url) throw new Error('No onboarding URL returned');
    if (wasAlreadyEnabled) {
      // Fire-and-forget. Producer lives in
      // ./functions/securityEmailTriggers.js.
      try {
        const notify = httpsCallable(fns, 'notifySecurityEvent');
        notify({
          eventType: 'payout_method_changed',
          metadata: {
            userAgent: (navigator && navigator.userAgent) || null,
          },
        }).catch((e) => console.warn(
            'notifySecurityEvent(payout_method_changed) failed:', e));
      } catch (_e) { /* swallow — security alert is best-effort */ }
    }
    // Always same-page redirect for Stripe Connect onboarding.
    // window.open(url, '_blank') is popup-blocked by Chrome/Safari/Firefox
    // because the await above breaks the user-gesture chain. Collapsing
    // both branches to location.href matches Stripe's recommended pattern;
    // return_url handler already detects ?stripe=onboarded on return.
    window.location.href = url;
  } catch (e) {
    showStripeConnecting(false);
    console.error('stripe-connect failed:', e);
    // Surface the SPECIFIC reason, never a dead end (mirrors the
    // become-a-seller handler). The common rejection is email-not-verified.
    const code = (e && e.code) || '';
    const msg = (e && e.message) || '';
    if (/verify your email/i.test(msg) || code.includes('failed-precondition')) {
      try { window.maybeShowVerifyBanner && window.maybeShowVerifyBanner(window.CURRENT_USER); } catch (_e) {}
      showToast('Verify your email to set up payouts — tap the link in your inbox (Resend is on the banner).', 'error');
    } else {
      showToast('Could not start Stripe setup. Try again.');
    }
  }
};
A['msg-show-anyway']         = (el) => { try { const w = el.closest('.msg-wrap'); if (w) w.classList.remove('msg-hidden'); const i = el.closest('.msg-interstitial'); if (i) i.remove(); } catch (_e) {} };
A['close-inbox']             = () => closeInbox();
A['close-inbox-and-browse']  = () => { closeInbox(); try { (document.getElementById('app-scroll')||window).scrollTo({top: 0, behavior: 'smooth'}); } catch (_e) {} };
A['close-watchlist-browse']  = () => { const so = document.getElementById('searchOverlay'); if (so) so.classList.remove('open'); try { (document.getElementById('app-scroll')||window).scrollTo({top: 0, behavior: 'smooth'}); } catch (_e) {} };
A['close-chat']              = () => closeChat();
A['send-message']            = () => { if (!window.requireAuth('to send a message')) return; sendMessage(); };
// Pinned chat listing card → reopen the listing detail modal. Best-effort:
// if PRODUCTS doesn't have the listing (cold open from a deep-link), bail
// silently rather than throw — the card is purely a navigation shortcut.
A['chat-open-listing']       = () => {
  try {
    const id = currentChat && currentChat.listing && currentChat.listing.id;
    if (!id) return;
    if (typeof window.openDetailModal === 'function') window.openDetailModal(String(id));
  } catch (_e) { /* swallow — best-effort navigation */ }
};
A['open-search']             = () => openSearch();
A['close-search']            = () => document.getElementById('searchOverlay').classList.remove('open');
// r270: Shop dropdown (homepage restructure bump 1). Mirrors the user-menu
// pattern rather than inventing a second one.
A['toggle-shop-menu']        = () => {
  const menu = document.getElementById('shopMenu');
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open');
  const btn = document.getElementById('shopMenuBtn');
  if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
};
window.__closeShopMenu = () => {
  const menu = document.getElementById('shopMenu');
  if (!menu || !menu.classList.contains('open')) return;
  menu.classList.remove('open');
  const btn = document.getElementById('shopMenuBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
};
// Picking a category reuses the EXACT filter-cat path the pills use, so
// filtering, active state and the grid scroll all behave identically — then
// closes the menu, which a bare filter-cat would not do.
A['shop-pick']               = (el, ev) => {
  A['filter-cat'](el, ev);
  window.__closeShopMenu();
};
A['toggle-user-menu']        = () => {
  const menu = document.getElementById('userMenu');
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open');
  const btn = document.getElementById('userBadge');
  if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
};
A['recheck-email-verify'] = async () => {
  // #3: re-check verification status in-place (no page reload). If verified,
  // hide the prompt and continue the publish; otherwise nudge to check inbox.
  if (!window.CURRENT_USER) return;
  try { await window.CURRENT_USER.reload(); } catch (_e) {}
  if (window.CURRENT_USER.emailVerified) {
    // Account verified — but the cached ID token may still say otherwise
    // (claims mint at sign-in). Refresh before resuming the publish so
    // firestore.rules + callables see the new state.
    await window.__ensureVerifiedClaimFresh();
    const vp = document.getElementById('sellVerifyPrompt');
    if (vp) vp.style.display = 'none';
    try { window.hideVerifyBanner && window.hideVerifyBanner(); } catch (_e) {}
    showToast('Email verified — publishing your listing.', 'success');
    if (typeof window.submitListing === 'function') window.submitListing();
  } else {
    showToast("Not verified yet — tap the link in your inbox, then try again.", 'error');
  }
};
A['resend-verification-email'] = async () => {
  // Best-effort resend of the verification link via our branded
  // Cloud Function (Resend-powered, DKIM/SPF-signed for deliverability).
  // Hidden for non-email users; surfaces a generic toast on success and
  // a specific message on rate-limit so the user knows to wait.
  try { document.getElementById('userMenu').classList.remove('open'); } catch {}
  if (!window.requireAuth('to resend the verification email')) return;
  const u = window.CURRENT_USER;
  if (!u || !u.email) { showToast('Sign in with email to resend verification.'); return; }
  if (u.emailVerified) { showToast('Your email is already verified.', 'success'); return; }
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const fns2 = getFunctions();
    const sendVerify = httpsCallable(fns2, 'sendBrandedVerification');
    const res = await sendVerify();
    const out = (res && res.data) || {};
    if (out.alreadyVerified) {
      showToast('Your email is already verified.', 'success');
    } else {
      showToast('Verification link sent to ' + u.email + ' — check your inbox, and your spam or Promotions folder.', 'success');
    }
  } catch (e) {
    const code = e && e.code;
    if (code === 'functions/resource-exhausted' || (e && /Too many/.test(String(e.message || '')))) {
      showToast('Too many requests. Try again in a few minutes.');
    } else {
      showToast('Could not send verification email. Try again later.');
    }
  }
};

// ── Email-verification soft prompt (Phase 2) ──────────────────────────
// Surfaces emailVerified state as a dismissible banner. NEVER gates any
// action — no hard-gate on sell/payout (founder sign-off required first).
// Resend reuses A['resend-verification-email'] (branded callable + rate
// limit). Dismissal is per-uid so we don't nag; it stops qualifying once
// the user verifies (emailVerified flips true on next auth resolution).
window.maybeShowVerifyBanner = function (user) {
  const b = document.getElementById('verifyEmailBanner');
  if (!b) return;
  // Only password users with an unverified email qualify: Google/OAuth
  // users are already verified; phone users have no email.
  if (!user || !user.email || user.emailVerified) { b.classList.remove('show'); return; }
  try { if (localStorage.getItem('teebox_verifyDismissed_' + user.uid) === '1') return; } catch (_) {}
  const addr = document.getElementById('verifyEmailAddr');
  if (addr) addr.textContent = user.email;
  // Defer so it doesn't fight the auth-screen / splash fade-out.
  setTimeout(function () { b.classList.add('show'); }, 500);
};
window.hideVerifyBanner = function () {
  const b = document.getElementById('verifyEmailBanner');
  if (b) b.classList.remove('show');
};
A['dismiss-verify-banner'] = () => {
  window.hideVerifyBanner();
  try {
    const u = window.CURRENT_USER;
    if (u && u.uid) localStorage.setItem('teebox_verifyDismissed_' + u.uid, '1');
  } catch (_) {}
};
A['toggle-mobile-nav']       = () => {
  const d = document.getElementById('mobileNavDrawer');
  if (!d) return;
  const opening = !d.classList.contains('open');
  // r186: refresh the app-only identity block whenever the drawer opens.
  if (opening && window.syncDrawerIdentity) window.syncDrawerIdentity();
  d.classList.toggle('open', opening);
  d.setAttribute('aria-hidden', opening ? 'false' : 'true');
  const btn = document.querySelector('.mobile-nav-toggle');
  if (btn) btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  (document.getElementById('app-scroll')||document.body).style.overflowY = opening ? 'hidden' : '';
};
A['close-mobile-nav']        = (el, ev) => {
  const d = document.getElementById('mobileNavDrawer');
  if (!d) return;
  // r358: the drawer root carries this action as its backdrop handler. A tap
  // on dead space inside the panel bubbles up to it too — ignore those so
  // only the backdrop itself, the × button, or a direct call closes it.
  if (ev && el === d && ev.target !== d) return;
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  const btn = document.querySelector('.mobile-nav-toggle');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  (document.getElementById('app-scroll')||document.body).style.overflowY = '';
};
A['close-mobile-nav-and-go'] = (el) => {
  A['close-mobile-nav']();
  const anchor = el && el.getAttribute('data-anchor');
  if (anchor) { const t = document.getElementById(anchor); if (t) t.scrollIntoView({behavior:'smooth', block:'start'}); }
};
A['close-lightbox']          = () => closeLightbox();
A['lightbox-prev']           = () => stepLightbox(-1);
A['lightbox-next']           = () => stepLightbox(1);
A['open-saved-searches']     = () => { if (!window.requireAuth('to view your saved searches', () => openSavedSearchesV2())) return; openSavedSearchesV2(); };
A['save-current-search']     = () => { if (!window.requireAuth('to save this search')) return; saveCurrentSearch(); };
A['filter-by-brand']         = (el) => filterByBrand(el.dataset.brand);
A['clear-brand-filter']      = () => filterByBrand(null);
A['clear-search-query']      = () => applySearchQuery(null);
A['search-see-all']          = () => {
  const input = document.getElementById('searchInput');
  applySearchQuery(input ? input.value : '');
};
A['renew-listing']           = (el) => { if (!window.requireAuth('to renew your listing')) return; renewListing(el.dataset.listingId); };
A['edit-listing']            = (el) => { if (!window.requireAuth('to edit your listing')) return; window.openEditListing && window.openEditListing(el.dataset.listingId); };
A['ask-delete-listing']      = (el) => { if (!window.requireAuth('to delete your listing')) return; askDeleteListing(el.dataset.listingId, el.dataset.listingTitle); };
A['confirm-delete-listing']  = () => { if (!window.requireAuth('to delete your listing')) return; confirmDeleteListing(); };
A['purge-empty-listings']    = () => { if (!window.requireAuth('to clean up your listings')) return; purgeEmptyListings(); };
A['mark-shipped']            = (el) => { if (!window.requireAuth('to mark this order shipped')) return; markShipped(el.dataset.orderId); };
A['print-shipping-label']    = (el) => { if (!window.requireAuth('to print a shipping label')) return; printShippingLabel(el.dataset.orderId); };
A['open-shipping-settings']  = () => { if (!window.requireAuth('to manage shipping settings', () => openShippingSettings())) return; openShippingSettings(); };
A['save-shipping-settings']  = () => { if (!window.requireAuth('to save shipping settings')) return; saveShippingSettings(); };
A['confirm-ship']            = () => { if (!window.requireAuth('to confirm shipment')) return; confirmShip(); };
A['confirm-delivery']        = (el) => { if (!window.requireAuth('to confirm delivery')) return; confirmDelivery(el.dataset.orderId); };
A['refund-order']            = (el) => { if (!window.requireAuth('to refund this order')) return; refundOrder(el.dataset.orderId); };
A['report-problem']          = (el) => { if (!window.requireAuth('to report a problem with this order')) return; openDispute(el.dataset.orderId); };
// Order-level messaging — both reuse the existing buyer↔seller thread for
// the listing (no second thread per order). Buyer side → openChatForListing;
// seller side → openChatForListingAsSeller (finds the same conversation).
A['message-seller-order']    = (el) => { const lid = el && el.dataset && el.dataset.listingId; if (lid) openChatForListing(lid); };
A['message-buyer']           = (el) => { if (!window.requireAuth('to message the buyer')) return; const d = el && el.dataset || {}; if (d.listingId && d.buyerId) openChatForListingAsSeller(d.listingId, d.buyerId); };
A['submit-dispute']          = () => { if (!window.requireAuth('to submit your dispute')) return; submitDispute(); };
A['block-conv']              = () => { if (!window.requireAuth('to manage this conversation')) return; blockConversation(); };
A['report-conv']             = () => { if (!window.requireAuth('to report this conversation')) return; reportConversation(); };
A['archive-conv']            = () => { if (!window.requireAuth('to archive this conversation')) return; archiveConversation(); };
A['archive-conv-row']        = (el, ev) => {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  if (!window.requireAuth('to archive this conversation')) return;
  const shell = el.closest('.inbox-swipe');
  if (shell) shell.classList.remove('swiped');
  archiveConversation(el.dataset.convId);
};
A['toggle-chat-menu']        = (el) => {
  const m = document.getElementById('chatMoreMenu');
  if (!m) return;
  const open = m.classList.toggle('open');
  el.setAttribute('aria-expanded', open ? 'true' : 'false');
};
// r170: display-name gate + photo nudge actions.
A['save-name-gate']          = () => { saveNameGate(); };
A['dismiss-name-gate']       = () => {
  window.__pendingNameIntent = null; // abandoning the gated action is fine — browsing is never gated
  const bd = document.getElementById('nameGateBackdrop');
  if (bd) bd.classList.remove('open');
};
A['name-gate-continue']      = () => {
  try { localStorage.setItem('teebox.photoNudgeDismissed.' + ((window.CURRENT_USER && window.CURRENT_USER.uid) || ''), '1'); } catch (_e) {}
  finishNameGate();
};
A['name-gate-add-photo']     = () => {
  // Replay the gated action first (finishNameGate), then open the profile
  // editor on top so their message/listing isn't lost while they upload.
  finishNameGate();
  setTimeout(() => {
    try {
      if (window.CURRENT_USER && typeof openProfile === 'function') {
        openProfile(window.CURRENT_USER.uid);
        setTimeout(() => { try { renderProfileEditor(); } catch (_e) {} }, 350);
      }
    } catch (_e) {}
  }, 450);
};
A['dismiss-photo-nudge']     = () => {
  try { localStorage.setItem('teebox.photoNudgeDismissed.' + ((window.CURRENT_USER && window.CURRENT_USER.uid) || ''), '1'); } catch (_e) {}
  const b = document.getElementById('photoNudgeBanner');
  if (b) b.remove();
};
A['open-orders']             = () => { if (!window.requireAuth('to view your orders', () => openOrders())) return; openOrders(); };
A['delete-message']          = (el, ev) => {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  const mid = el.dataset.mid;
  const shell = el.closest('.msg-swipe');
  if (shell) shell.classList.remove('swiped');
  if (typeof deleteMessageForMe === 'function') deleteMessageForMe(mid);
};

A['toggle-watch']            = (el, ev) => {
  ev.stopPropagation();
  const id = el.dataset.productId;
  // Guest gate FIRST — show the polished sign-in prompt and do NOT
  // run any optimistic animation. Otherwise a guest sees a fake
  // "liked" state that doesn't survive a refresh.
  if (!window.CURRENT_USER) {
    // Phase 3: guests get the sign-up sheet, nothing optimistic.
    if (typeof window.openAuthSheet === 'function') window.openAuthSheet('signup', 'to like and save listings');
    else if (typeof window.requireAuth === 'function') window.requireAuth('to like and save listings');
    return;
  }
  // Two-state animation; the liked class + count are painted by toggleWatch
  // (optimistically, with rollback). On a fresh like, also spawn a small
  // CSS-only particle burst (six tiny hearts that float up + fade).
  const wasLiked = fav.has(id) || fav.has(Number(id));
  el.classList.remove('popped', 'unpopped');
  void el.offsetWidth; // force reflow so animation re-triggers
  if (wasLiked) {
    el.classList.add('unpopped');
    setTimeout(() => el.classList.remove('unpopped'), 360);
  } else {
    el.classList.add('popped');
    setTimeout(() => el.classList.remove('popped'), 420);
    spawnHeartBurst(el);
  }
  toggleWatch(id, !wasLiked);
};
// Optional CSS-only flourish — six tiny floating hearts. Skipped when
// prefers-reduced-motion is set (the .heart-burst rule hides itself).
function spawnHeartBurst(btn) {
  if (!btn || typeof window === 'undefined') return;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (_e) {}
  const wrap = document.createElement('span');
  wrap.className = 'heart-burst';
  // 6 particles spread across ~80px, each with a small horizontal drift.
  const drifts = [-26, -14, -4, 6, 16, 28];
  drifts.forEach((dx, i) => {
    const p = document.createElement('span');
    p.className = 'heart-burst-particle';
    p.innerHTML = window.ICONS.heartFill;  // r288: svg, not an emoji glyph
    p.style.setProperty('--hx', dx + 'px');
    p.style.animationDelay = (i * 30) + 'ms';
    wrap.appendChild(p);
  });
  btn.appendChild(wrap);
  setTimeout(() => { try { wrap.remove(); } catch (_e) {} }, 900);
}
// ── Gated actions: each requires a signed-in user. The requireAuth()
//    helper opens the polished sign-in prompt for guests with the
//    contextual reason. open-profile (other users) is left ungated —
//    public profiles are part of the marketplace browse experience.
A['submit-review']            = () => { if (!window.requireAuth('to leave a review')) return; submitReview(); };
A['open-delete-account']     = () => { if (!window.requireAuth('to manage your account')) return; openDeleteAccountModal(); };
A['confirm-delete-account']  = () => { if (!window.requireAuth('to delete your account')) return; confirmDeleteAccount(); };
A['download-my-data']        = () => { if (!window.requireAuth('to download your data')) return; downloadMyData(); };
A['manage-payouts']          = () => { if (!window.requireAuth('to manage payouts')) return; openStripeLoginLink(); };
A['open-watchlist']          = () => { if (!window.requireAuth('to view your liked items', () => openWatchlistWithDropBadges())) return; openWatchlistWithDropBadges(); };
A['open-profile-self']       = () => { if (!window.requireAuth('to view your profile', () => openProfile(window.CURRENT_USER && window.CURRENT_USER.uid))) return; openProfile(window.CURRENT_USER && window.CURRENT_USER.uid); };
A['open-profile']            = (el) => openProfile(el.dataset.uid);
A['close-profile']           = () => document.getElementById('profileBackdrop').classList.remove('open');
A['edit-profile']            = () => { if (!window.requireAuth('to edit your profile')) return; renderProfileEditor(); };
A['cancel-edit-profile']     = () => openProfile(window.CURRENT_USER && window.CURRENT_USER.uid);
A['save-profile']            = () => { if (!window.requireAuth('to save your profile')) return; saveProfileEdits(); };
A['avatar-pick']             = () => { if (!window.requireAuth('to update your avatar')) return; document.getElementById('avatarFileInput').click(); };
A['crop-confirm']            = () => { window.__cropConfirm && window.__cropConfirm(); };
A['crop-cancel']             = () => { window.__cropCancel && window.__cropCancel(); };
A['passport-add']            = () => { openAddPassportCourse(); };
A['passport-close']          = () => { ppCloseModal(); __ppState = null; };
A['passport-pick-course']    = (el) => { ppPickCourse(el.dataset.course); };
A['passport-change-course']  = () => { ppChangeCourse(); };
A['passport-grade']          = (el) => { if (__ppState) { __ppState.grade = el.dataset.grade; ppRenderGrades(); } };
A['passport-tag']            = (el) => { if (!__ppState) return; const t = el.dataset.tag; if (__ppState.tags.has(t)) __ppState.tags.delete(t); else __ppState.tags.add(t); ppRenderTags(); };
A['passport-photo-add']      = () => { ppAddPhoto(); };
A['passport-photo-remove']   = (el) => { ppRemovePhoto(Number(el.dataset.idx)); };
A['passport-save']           = () => { ppSave(); };
A['passport-open']           = (el) => { openPassportCourseDetail(el.dataset.uid, el.dataset.course); };
A['passport-detail-close']   = () => { ppDetailClose(); };
A['passport-like']           = () => { ppToggleLike(false); };
A['passport-comment-send']   = (el) => { ppSendComment(el.dataset.uid, el.dataset.course); };
A['passport-comment-del']    = (el) => { ppDeleteComment(el.dataset.uid, el.dataset.course, el.dataset.id); };
A['open-passport-feed']      = () => { openPassportFeed(); };
A['close-passport-feed']     = () => { closePassportFeed(); };
A['passport-feed-open']      = (el) => { openPassportCourseDetail(el.dataset.uid, el.dataset.course); };
A['passport-feed-user']      = (el) => { closePassportFeed(); openProfile(el.dataset.uid); };
A['open-course-page']        = (el) => { ppDetailClose(); openCoursePage(el.dataset.course); };
// Tapping a commenter's avatar or name. Closes the detail sheet FIRST —
// plain open-profile would stack the profile modal on top of the open
// sheet, same reason open-course-page and passport-edit close first.
A['passport-comment-user']   = (el) => { if (!el.dataset.uid) return; ppDetailClose(); openProfile(el.dataset.uid); };
A['open-my-passport']        = () => { openMyPassport(); };
A['passport-post']           = () => { openAddPassportCourse(); };
A['close-course-page']       = () => { closeCoursePage(); };
// r274 — Passport round sharing. Opt-in: nothing about this round is public
// until the owner taps here. The callable mints an opaque token and copies the
// w400/w800 derivatives to sharedRounds/{token}/, so the link and the images it
// serves both contain a token rather than the owner's uid.
A['passport-share']          = async (el) => {
  const courseId = el.dataset.course;
  if (!courseId || !window.CURRENT_USER) return;
  const btn = document.getElementById('ppShareBtn');
  const note = document.getElementById('ppShareNote');
  const setBusy = (t) => { if (btn) { btn.disabled = true; btn.textContent = t; } };
  setBusy('Preparing link…');
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    const res = (await httpsCallable(getFunctions(), 'sharePassportRound')({ courseId })).data;
    if (!res || !res.url) throw new Error('no-url');
    if (btn) { btn.disabled = false; btn.textContent = 'Share this round'; }
    if (note) {
      note.hidden = false;
      note.innerHTML = '<span class="pp-share-live">This round is public by link.</span> ' +
        '<button type="button" class="pp-share-unshare" data-action="passport-unshare" ' +
        'data-course="' + window.safeAttr(courseId) + '">Make private</button>';
    }
    // Reuse the one share helper — never a second implementation.
    const out = window.shareOrFallback
      ? await window.shareOrFallback({
        title: 'A round on TeeBox',
        text: 'A course I played, on my TeeBox Passport',
        url: res.url })
      : 'failed';
    if (out === 'copied' && window.showToast) showToast('Link copied — send it anywhere.');
    else if (out === 'failed' && window.showToast) showToast('Could not open the share sheet.', 'error');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Share this round'; }
    if (window.showToast) showToast('Could not create a share link. Try again.', 'error');
    console.warn('passport share failed', e && e.message);
  }
};
A['passport-unshare']        = async (el) => {
  const courseId = el.dataset.course;
  if (!courseId) return;
  el.disabled = true; el.textContent = 'Removing…';
  try {
    const { getFunctions, httpsCallable } =
      await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    await httpsCallable(getFunctions(), 'unsharePassportRound')({ courseId });
    const note = document.getElementById('ppShareNote');
    if (note) { note.hidden = true; note.innerHTML = ''; }
    if (window.showToast) showToast('That link no longer works.');
  } catch (e) {
    el.disabled = false; el.textContent = 'Make private';
    if (window.showToast) showToast('Could not make it private. Try again.', 'error');
  }
};
A['passport-edit']           = (el) => { ppDetailClose(); if (__ppDetailData) openAddPassportCourse(__ppDetailData); };
A['passport-delete']         = (el) => { ppDelete(el.dataset.uid, el.dataset.course); };
A['pin-listing']             = (el) => { if (!window.requireAuth('to pin a listing to your profile')) return; pinListingToProfile(el.dataset.listingId); };
A['unpin-listing']           = (_el) => { if (!window.requireAuth('to unpin your listing')) return; pinListingToProfile(null); };
A['payout-export-csv']       = () => { if (!window.requireAuth('to export your payouts')) return; exportPayoutsCsv(); };
A['seller-tour-next']        = () => advanceSellerTour();
A['seller-tour-skip']        = () => dismissSellerTour({ markSeen: true });

A['open-about']              = () => openInfo('aboutBackdrop');
A['open-guidelines']         = () => openInfo('guidelinesBackdrop');
A['open-terms']              = () => openInfo('termsBackdrop');
A['open-privacy']            = () => openInfo('privacyBackdrop');
A['close-info']              = () => { document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open')); (document.getElementById('app-scroll') || document.body).style.overflowY = ''; };
A['review-dismiss']          = () => { dismissReviewPrompt(); };
A['open-journal']            = () => {
  // r288: web only. Hidden in the native shell by CSS; this makes a deep
  // link or a stale cached bundle inert too rather than opening a surface
  // that is not supposed to exist in the app.
  return;  // r291: reachable via the footer "Reads" link (/reads/) only.
  // r151: Journal is public content — no auth gate. Close the hamburger
  // drawer if it's open so the overlay doesn't stack under it (reuses the
  // close-mobile-nav semantics incl. aria-expanded reset).
  if (document.getElementById('mobileNavDrawer')?.classList.contains('open')) {
    const closeFn = A['close-mobile-nav'];
    if (typeof closeFn === 'function') closeFn();
  }
  const jb = document.getElementById('journalBackdrop');
  if (jb) jb.classList.add('open');
};
A['report-listing']          = () => {
  if (!window.requireAuth || !window.requireAuth('to report a listing')) return;
  const id = (typeof currentDetailId !== 'undefined' && currentDetailId) || null;
  const p = id ? (window.PRODUCTS || []).find(x => String(x.id) === String(id)) : null;
  window.openReportDialog({
    targetType: 'listing',
    targetId: id,
    targetUid: (p && p.sellerId) || null,
  });
};
A['report-user']             = (el) => {
  if (!window.requireAuth || !window.requireAuth('to report a user')) return;
  const uid = el && el.dataset && el.dataset.uid;
  if (!uid) return;
  window.openReportDialog({ targetType: 'user', targetId: uid, targetUid: uid });
};
A['block-user-from-profile'] = (el) => {
  if (!window.requireAuth || !window.requireAuth('to block a user')) return;
  const uid = el && el.dataset && el.dataset.uid;
  if (!uid) return;
  window.blockUser(uid);
};
A['report-message']          = (el) => {
  if (!window.requireAuth || !window.requireAuth('to report a message')) return;
  const mid = el && el.dataset && el.dataset.mid;
  const sender = el && el.dataset && el.dataset.sender;
  window.openReportDialog({
    targetType: 'message',
    targetId: mid || '',
    targetUid: sender || '',
    messageId: mid || '',
    conversationId: (typeof currentChat !== 'undefined' && currentChat && currentChat.conversationId) || null,
  });
};
A['confirm-report']          = () => { if (!window.requireAuth('to submit your report')) return; confirmReport(); };
A['open-blocked-users']      = () => { if (!window.requireAuth('to view your blocked users', () => openBlockedUsers())) return; openBlockedUsers(); };
A['open-push-prefs']         = () => { if (!window.requireAuth('to manage notifications', () => window.openPushPrefs())) return; window.openPushPrefs(); };
A['save-push-prefs']         = () => { window.savePushPrefs && window.savePushPrefs(); };
A['open-email-prefs']        = () => { if (!window.requireAuth('to manage email preferences', () => window.openEmailPrefs())) return; window.openEmailPrefs(); };
A['email-prefs-resume']      = () => {
  const t = document.getElementById('emailPrefsPauseToggle');
  if (t) { t.checked = false; window._handleEmailPrefPauseToggle && window._handleEmailPrefPauseToggle(t); }
};
A['email-prefs-enable-marketing'] = () => { window._handleEmailPrefsEnableMarketing && window._handleEmailPrefsEnableMarketing(); };
A['push-prompt-accept']      = () => { window._handlePushPromptAnswer && window._handlePushPromptAnswer('yes'); };
A['push-prompt-decline']     = () => { window._handlePushPromptAnswer && window._handlePushPromptAnswer('no'); };
A['unblock-user']            = (el) => {
  const uid = el && el.dataset && el.dataset.uid;
  if (!uid) return;
  window.unblockUser(uid);
};
// Open a legal page in the system browser on native (Capacitor.Browser),
// or a plain new tab on web. Used by the Account hub + mobile slide-out
// links pointing at /terms.html, /privacy.html, /dmca.html, /refunds.html,
// /acceptable-use.html and the redirect button inside the privacy modal.
function openLegalUrl(path) {
  // On Capacitor iOS, window.open('/foo.html', '_blank') is silently
  // blocked by WKWebView and @capacitor/browser isn't installed yet.
  // Same-window navigation works because the legal pages are bundled
  // into the iOS app (ios/App/App/public/) and Firebase Auth now uses
  // browserLocalPersistence so the session survives the nav.
  try {
    const Cap = window.Capacitor;
    if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
      const Browser = Cap.Plugins && Cap.Plugins.Browser;
      if (Browser && typeof Browser.open === 'function') {
        Browser.open({ url: 'https://teeboxmarket.com' + path }).catch(() => {
          window.location.href = path;
        });
        return;
      }
      window.location.href = path;
      return;
    }
  } catch (_e) {}
  // Web: try popup first, fall back to same-window nav.
  const w = window.open(path, '_blank', 'noopener,noreferrer');
  if (!w) window.location.href = path;
}
A['open-privacy-full']       = () => openLegalUrl('/privacy.html');
A['open-terms-full']         = () => openLegalUrl('/terms.html');
A['open-terms-page']         = () => openLegalUrl('/terms.html');
A['open-dmca']               = () => openLegalUrl('/dmca.html');
A['open-refund-policy']      = () => openLegalUrl('/refunds.html');
A['open-acceptable-use']     = () => openLegalUrl('/acceptable-use.html');
// Re-show the seller-agreement modal in read-only mode after acceptance.
// The verify modal is reused so we maintain a single source of truth for
// the 8-clause body; we just hide the checkbox + footer buttons and add
// a Close button. State is restored when the modal closes.
A['open-seller-agreement']   = () => {
  const back = document.getElementById('verifyBackdrop');
  if (!back) return;
  back.classList.add('readonly-mode');
  back.classList.add('open');
};
A['close-seller-agreement']  = () => {
  const back = document.getElementById('verifyBackdrop');
  if (!back) return;
  back.classList.remove('open');
  back.classList.remove('readonly-mode');
};
function openInfo(id) {
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
  // Lock the page behind the modal so a drag inside the sheet can't scroll
  // the feed underneath (iOS scroll-chaining). Restored by close-info.
  (document.getElementById('app-scroll') || document.body).style.overflowY = 'hidden';
}

// ─── Admin moderation queue (?admin=moderation) ───────────────
// Hardcoded email gate — kept in sync with firestore.rules and
// storage.rules isAdmin(). Anyone else who hits the deep link
// gets a "Not authorized" toast and the URL is cleared.
const MODERATION_ADMIN_EMAILS = new Set(['jakenair23@gmail.com']);
function isModerationAdmin() {
  const u = window.CURRENT_USER;
  if (!u || !u.email) return false;
  if (!u.emailVerified) return false;
  return MODERATION_ADMIN_EMAILS.has(String(u.email).toLowerCase());
}
A['close-moderation']        = () => {
  const bd = document.getElementById('moderationBackdrop');
  if (bd) bd.classList.remove('open');
  // Drop the ?admin=moderation query so a refresh doesn't reopen it.
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('admin') === 'moderation') {
      u.searchParams.delete('admin');
      window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch (_e) {}
};
async function openModerationQueue() {
  if (!isModerationAdmin()) {
    if (window.showToast) window.showToast('Not authorized.', 'error');
    // Strip the query param so non-admins don't see the modal.
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('admin');
      window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    } catch (_e) {}
    return;
  }
  const bd = document.getElementById('moderationBackdrop');
  const body = document.getElementById('moderationBody');
  if (!bd || !body) return;
  // Open with loading state.
  document.querySelectorAll('.info-backdrop.open').forEach(b => b.classList.remove('open'));
  body.innerHTML = '<div class="moderation-loading" style="text-align:center;padding:48px 16px;color:var(--gold-300);">Loading flagged listings…</div>';
  bd.classList.add('open');
  try {
    const { getFirestore, collection, query, orderBy, limit, getDocs } =
      await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
    const db = getFirestore();
    // Read from the dedicated flaggedListings collection (Cloud
    // Functions write into it; firestore.rules grants admin read).
    // r321: capped at 100. This is the moderation queue — it grows with
    // every flag and nothing trimmed it, so a busy week would have pulled
    // the whole collection into an admin screen that shows a list.
    const q = query(collection(db, 'flaggedListings'), orderBy('flaggedAt', 'desc'), limit(100));
    const snap = await getDocs(q);
    if (snap.empty) {
      body.innerHTML = '<div class="mod-empty">Nothing in the queue. Nice.</div>';
      return;
    }
    const items = [];
    snap.forEach(d => items.push(Object.assign({_id: d.id}, d.data())));
    renderModerationQueue(items);
  } catch (err) {
    console.error('moderation queue load failed:', err);
    body.innerHTML = '<div class="mod-error">Could not load queue: ' + escapeHtml(err && err.message || 'unknown error') + '</div>';
  }
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderModerationQueue(items) {
  const body = document.getElementById('moderationBody');
  if (!body) return;
  if (!items || !items.length) {
    body.innerHTML = '<div class="mod-empty">Nothing in the queue. Nice.</div>';
    return;
  }
  const cards = items.map(it => {
    const photos = Array.isArray(it.photos) ? it.photos.slice(0, 3) : [];
    const photoHtml = photos.length
      ? photos.map(p => `<img class="mod-photo" src="${escapeHtml(p)}" alt="" loading="lazy"/>`).join('')
      : '<div class="mod-photo placeholder">all photos<br/>removed</div>';
    const reason = it.reason || 'unknown';
    const sigLines = it.signals
      ? Object.entries(it.signals)
          .map(([k,v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
          .join(' · ')
      : '';
    return `
      <div class="mod-card" data-listing-id="${escapeHtml(it._id)}" data-seller-id="${escapeHtml(it.sellerId || '')}">
        <div>${photoHtml}</div>
        <div class="mod-info">
          <div class="mod-title">${escapeHtml(it.title || '(untitled)')}</div>
          <div class="mod-brand">${escapeHtml(it.brand || '')}</div>
          <div class="mod-meta">listing <code>${escapeHtml(it._id)}</code> · seller <code>${escapeHtml(it.sellerId || '')}</code></div>
          <div class="mod-reason">flagged: ${escapeHtml(reason)}${sigLines ? ' &nbsp;·&nbsp; ' + sigLines : ''}</div>
          <div class="mod-actions">
            <button class="mod-btn mod-btn-approve" data-action="mod-approve">Approve</button>
            <button class="mod-btn mod-btn-reject" data-action="mod-reject">Reject + delete</button>
            <button class="mod-btn mod-btn-skip" data-action="mod-skip">Skip</button>
          </div>
        </div>
      </div>`;
  }).join('');
  body.innerHTML = cards;
}
async function moderationCardAction(el, kind) {
  const card = el && el.closest('.mod-card');
  if (!card) return;
  const listingId = card.dataset.listingId;
  const sellerId = card.dataset.sellerId;
  if (!listingId) return;
  // Disable buttons immediately so a double-tap can't double-fire.
  card.querySelectorAll('.mod-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
  try {
    const fs = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
    const { getFirestore, doc, updateDoc, deleteDoc, deleteField, serverTimestamp } = fs;
    const db = getFirestore();
    if (kind === 'approve') {
      // r346: approval is SERVER-side (approveFlaggedListing). The direct
      // updateDoc that lived here set status:active and dropped the flags but
      // left the photo moderation had deleted in photos[] — a dead image that
      // surfaced as a 404 in the Meta feed (2026-10-16). The callable prunes
      // it, is idempotent (re-approving a clean listing is a no-op), won't
      // resurrect a sold/removed listing, and backfills missing thumbnails.
      const { getFunctions, httpsCallable } =
        await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js');
      const res = await httpsCallable(getFunctions(), 'approveFlaggedListing')({ listingId });
      const r = (res && res.data) || {};
      if (window.showToast) {
        if (r.noop) window.showToast(r.reason === 'no-photos'
          ? 'No photos left — the seller has to re-upload before this can go live.'
          : 'Already ' + (r.status || 'active') + ' — nothing to do.', 'info');
        else window.showToast('Approved.' + (r.prunedUrl ? ' Removed the deleted photo.' : '') +
          (r.backfilled ? ` Rebuilt ${r.backfilled} thumbnail${r.backfilled === 1 ? '' : 's'}.` : ''), 'success');
      }
    } else if (kind === 'reject') {
      // Delete photos, then listing doc, then queue mirror.
      try {
        const st = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js');
        const { getStorage, ref: sref, listAll, deleteObject } = st;
        const storage = getStorage();
        const folder = sref(storage, `listings/${sellerId}/${listingId}`);
        const items = await listAll(folder);
        await Promise.allSettled(items.items.map(it => deleteObject(it)));
      } catch (storageErr) {
        console.warn('moderation reject: photo cleanup failed (non-fatal):', storageErr);
      }
      await deleteDoc(doc(db, 'listings', listingId)).catch(() => {});
      await deleteDoc(doc(db, 'flaggedListings', listingId)).catch(() => {});
      if (window.showToast) window.showToast('Rejected + deleted.', 'success');
    } else if (kind === 'skip') {
      // No write — just collapse the card and move on.
      if (window.showToast) window.showToast('Skipped.', 'info');
    }
    // Animate the card out.
    card.style.transition = 'opacity 200ms ease, transform 200ms ease';
    card.style.opacity = '0';
    card.style.transform = 'translateX(8px)';
    setTimeout(() => {
      card.remove();
      const body = document.getElementById('moderationBody');
      if (body && !body.querySelector('.mod-card')) {
        body.innerHTML = '<div class="mod-empty">Queue cleared. Nice.</div>';
      }
    }, 220);
  } catch (err) {
    console.error('moderation action failed:', err);
    if (window.showToast) window.showToast('Something went wrong. Please try again.', 'error');
    card.querySelectorAll('.mod-btn').forEach(b => { b.disabled = false; b.style.opacity = ''; });
  }
}
A['mod-approve'] = (el) => moderationCardAction(el, 'approve');
A['mod-reject']  = (el) => moderationCardAction(el, 'reject');
A['mod-skip']    = (el) => moderationCardAction(el, 'skip');
window.openModerationQueue = openModerationQueue;
// Honor ?admin=moderation on initial load — wait for auth to settle
// (onAuthStateChanged fires async after page load) then open if admin.
try {
  const _adminSp = new URLSearchParams(window.location.search);
  if (_adminSp.get('admin') === 'moderation') {
    let _modAttempts = 0;
    const _modPoll = setInterval(() => {
      _modAttempts++;
      // Bail after ~10s; auth hasn't resolved or user is signed out.
      if (_modAttempts > 50) {
        clearInterval(_modPoll);
        if (!window.CURRENT_USER) {
          if (window.showToast) window.showToast('Sign in as the admin to view the moderation queue.', 'info');
        }
        return;
      }
      if (window.CURRENT_USER) {
        clearInterval(_modPoll);
        openModerationQueue();
      }
    }, 200);
  }
} catch (_e) {}
// r298: close the drawer first — My Shop is now a drawer row, and nothing
// closes the drawer on link tap (open-about gets away with it because the info
// backdrop sits above it; the dashboard does not).
A['open-shop-dashboard']     = () => { A['close-mobile-nav'](); if (!window.requireAuth('to start selling on TeeBox', () => openShopDashboard())) return; openShopDashboard(); };
A['open-inbox']              = () => { if (!window.requireAuth('to view your messages', () => openInbox())) return; openInbox(); };
A['sign-out']                = () => signOut();
A['handle-sell']             = () => handleSellClick();
A['open-modal-buy']          = () => {
  // Hero "Shop Now" + footer "Buy" → scroll the marketplace grid into view.
  // (Was openModal('buy'), which already just scrolled-to-grid; the dead bid
  // modal it could open was removed in the buy-now-only sweep.)
  const grid = document.getElementById('productGrid');
  if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
A['filter-cat']              = (el, ev) => {
  // Footer + bottom-nav category triggers are <a href="#"> — block the
  // default scroll-to-top so we stay anchored on the marketplace grid.
  if (ev && ev.preventDefault && el && el.tagName === 'A') ev.preventDefault();
  filterCat(el, el.dataset.cat);
  // If the user came from footer / bottom-nav, scroll the grid into view.
  if (el && el.tagName === 'A') {
    const grid = document.getElementById('productGrid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};
A['close-detail-direct']     = () => closeDetailModalDirect();
// r163: category chip inside the search overlay (native app). Filter the
// feed, then dismiss via the close-search ACTION (not a raw classList
// remove) so the r156 overlay-history wrapper consumes its history entry.
A['search-cat']              = (el) => {
  filterCat(el, el.dataset.cat);
  if (A['close-search']) A['close-search']();
};

// ─────────────────────────────────────────────────────────────
// r156: OVERLAY HISTORY (heuristic #2) — browser Back closes the top
// overlay instead of leaving the site. Mechanics:
//   • __pushOverlay(name, url?) records the overlay on our stack and pushes
//     a history entry (detail passes its deep-link URL so the address bar
//     reflects the open listing).
//   • popstate pops our stack and closes that overlay IF still open (a
//     no-op when it was already closed by its X — closers are idempotent).
//   • X-button close actions are wrapped post-'load' (bingo registers its
//     closer in a later module): after a wrapped closer runs, if the stack
//     top is that overlay we call history.back() to consume the entry, so
//     the NEXT Back press does what the user expects.
// Overlays opened without a push (programmatic flows) simply keep the old
// behavior for that instance — pushes and pops always stay 1:1.
// ─────────────────────────────────────────────────────────────
const __OV = {
  detail:    { el: 'detailBackdrop',   act: 'close-detail-direct' },
  checkout:  { el: 'checkoutBackdrop', act: 'close-checkout-direct' },
  search:    { el: 'searchOverlay',    act: 'close-search' },
  inbox:     { el: 'inboxBackdrop',    act: 'close-inbox' },
  chat:      { el: 'chatBackdrop',     act: 'close-chat' },
  dashboard: { el: 'shopDashboard',    act: 'close-shop-dashboard' },
  orders:    { el: 'ordersBackdrop',   act: null },
  activity:  { el: 'activityBackdrop', act: 'close-activity' },
  filtersheet: { el: 'filterSheetBackdrop', act: 'close-filter-sheet' },
  notif:     { el: 'notifPanel',       act: 'close-notifications' },
  bingo:     { el: 'bingoScreen',      act: 'close-bingo' },
  drawer:    { el: 'mobileNavDrawer',  act: 'close-mobile-nav' },
  info:      { act: 'close-info',
               isOpen: () => !!document.querySelector('.info-backdrop.open') },
};
const __ovStack = [];
function __ovIsOpen(name) {
  const o = __OV[name]; if (!o) return false;
  if (o.isOpen) return o.isOpen();
  const el = document.getElementById(o.el);
  return !!(el && el.classList.contains('open'));
}
function __ovClose(name) {
  const o = __OV[name]; if (!o) return;
  const fn = o.act && A[o.act];
  if (typeof fn === 'function') { try { fn(); } catch (_e) {} }
  else if (o.el) { const el = document.getElementById(o.el); if (el) el.classList.remove('open'); }
}
window.__pushOverlay = function(name, url) {
  try {
    __ovStack.push(name);
    history.pushState({ tb: name }, '', url || null);
    // r278 item 3: SPA PageView. Hooked HERE rather than on every modal open
    // because this is the only place the app actually changes the URL — a
    // real navigation a browser would have counted. Firing on every overlay
    // would inflate counts, which is worse than undercounting.
    // Guarded two ways: only when the URL genuinely changed, and only once
    // per URL per page load, so back/forward and re-opens do not re-fire.
    try {
      const here = location.pathname + location.search;
      if (here !== window.__tbLastPvUrl) {
        window.__tbLastPvUrl = here;
        window.__tbSeenPv = window.__tbSeenPv || {};
        if (!window.__tbSeenPv[here]) {
          window.__tbSeenPv[here] = true;
          window.fbTrack && window.fbTrack('PageView');
        }
      }
    } catch (_e2) { /* analytics must never break navigation */ }
  } catch (_e) {}
};
// ── r336: RETURN TO THE PROFILE ─────────────────────────────────────────
// Profile → My Shop → ← landed on the marketplace, and so did
// Profile → Notifications → ✕. Two causes, same effect: several hub openers
// strip .open from EVERY .info-backdrop (openInfo, openSavedSearchesV2,
// openBlockedUsers), and close-info does the same on the way out — and the
// profile is an .info-backdrop. By the time the hub page closed there was no
// profile left under it.
//
// No z-index surgery: the profile steps BEHIND (visibility hidden, DOM and
// scroll position intact) when a hub page opens from it, and is restored
// when the last hub page closes. Push/pop semantics, which is what a phone
// user expects from a ←.
const PROFILE_HUB_OPENS = ['open-shop-dashboard', 'open-orders', 'open-watchlist',
  'open-saved-searches', 'open-push-prefs', 'open-email-prefs', 'open-connected-methods', 'open-shipping-settings',
  'open-blocked-users', 'open-about', 'open-guidelines'];
// Likes reuses the search overlay, so its ← is close-search.
const PROFILE_HUB_CLOSES = ['close-info', 'close-shop-dashboard', 'close-search'];
window.__returnToProfile = false;
function __profileIsOpen() {
  const p = document.getElementById('profileBackdrop');
  return !!(p && p.classList.contains('open') && !p.classList.contains('nav-behind'));
}
function __hubStillOpen() {
  // Pages that close-info does NOT close: a close-info from a dialog on top of
  // My Shop must leave My Shop, not jump back to the profile.
  const d = document.getElementById('shopDashboard');
  const so = document.getElementById('searchOverlay');
  return !!((d && d.classList.contains('open')) || (so && so.classList.contains('open')));
}
function __profileReturn() {
  window.__returnToProfile = false;
  const p = document.getElementById('profileBackdrop');
  if (!p) return;
  p.classList.remove('nav-behind');
  p.classList.add('open');
  (document.getElementById('app-scroll') || document.body).style.overflowY = 'hidden';
}
window.__profileReturn = __profileReturn;
// The OPEN side hooks the tap itself, in the capture phase, not the action
// table: the app shell has a second click dispatcher that handles My Shop
// without ever calling A['open-shop-dashboard'], so an action wrapper never
// saw that tap (verified — flag stayed false). A capture listener runs before
// every dispatcher and cannot be bypassed by any of them.
document.addEventListener('click', (ev) => {
  const t = ev.target && ev.target.closest && ev.target.closest('[data-action]');
  if (!t || !PROFILE_HUB_OPENS.includes(t.dataset.action)) return;
  if (!t.closest('#profileBackdrop') || !__profileIsOpen()) return;
  window.__returnToProfile = true;
  // Step behind AFTER the opener has run, so an opener that checks what is
  // open still sees the profile exactly as it did before this change.
  setTimeout(() => {
    const p = document.getElementById('profileBackdrop');
    if (p && window.__returnToProfile) p.classList.add('nav-behind');
  }, 0);
}, true);
window.addEventListener('load', () => {
  PROFILE_HUB_CLOSES.forEach((act) => {
    if (typeof A[act] !== 'function') return;
    const orig = A[act];
    A[act] = function(...args) {
      const r = orig.apply(this, args);
      if (window.__returnToProfile && !__hubStillOpen()) __profileReturn();
      return r;
    };
  });
  // "Browse listings" from an empty Likes screen means the marketplace, not
  // the profile — honour the stated intent and drop the return.
  if (typeof A['close-watchlist-browse'] === 'function') {
    const orig = A['close-watchlist-browse'];
    A['close-watchlist-browse'] = function(...args) {
      window.__returnToProfile = false;
      const p = document.getElementById('profileBackdrop');
      if (p) { p.classList.remove('nav-behind'); p.classList.remove('open'); }
      return orig.apply(this, args);
    };
  }
});

window.addEventListener('popstate', () => {
  const name = __ovStack.pop();
  if (name && __ovIsOpen(name)) __ovClose(name);
  // URL is whatever the history entry says — for detail that returns the
  // address bar from /?listing=<id> to the previous state automatically.
});
window.addEventListener('load', () => {
  // Wrap closers for stack/history sync (after ALL registrations exist).
  Object.keys(__OV).forEach((name) => {
    const act = __OV[name].act;
    if (!act || typeof A[act] !== 'function') return;
    const orig = A[act];
    A[act] = function(...args) {
      const r = orig.apply(this, args);
      if (__ovStack[__ovStack.length - 1] === name) {
        try { history.back(); } catch (_e) {}
      }
      return r;
    };
  });
  // Wrap open paths that AREN'T the detail choke point (detail pushes inside
  // openDetailModal so every entry route is covered). Async opens verify the
  // overlay actually opened before pushing.
  [['open-search', 'search'], ['open-inbox', 'inbox'], ['open-orders', 'orders'],
   ['open-activity', 'activity'], ['open-filter-sheet', 'filtersheet'],
   ['open-shop-dashboard', 'dashboard'], ['open-bingo', 'bingo'], ['open-journal', 'info'],
   ['toggle-mobile-nav', 'drawer'], ['toggle-notifications', 'notif'], ['open-conv', 'chat'],
   ['detail-buy-now', 'checkout'],
  ].forEach(([act, name]) => {
    if (typeof A[act] !== 'function') return;
    const orig = A[act];
    A[act] = function(...args) {
      const wasOpen = __ovIsOpen(name);
      const r = orig.apply(this, args);
      setTimeout(() => { if (!wasOpen && __ovIsOpen(name)) window.__pushOverlay(name); }, 350);
      return r;
    };
  });
});
A['detail-buy-now']          = () => {
  // r348 LIST-FIRST: in "Seller is finishing setup" mode the Buy slot records
  // interest instead of opening checkout (which would 409 server-side anyway).
  const _bb = document.getElementById('detailBuyNowBtn');
  if (_bb && _bb.dataset.notifySetup === '1') { A['notify-seller-setup'](); return; }
  const qInp = document.getElementById('detailQty');
  const qty = qInp && qInp.offsetParent !== null ? Number(qInp.value || 1) : 1;
  // Capture the listing id BEFORE closing the modal. closeDetailModalDirect()
  // sets currentDetailId = null, so reading currentDetailId AFTER the close fed
  // openCheckout() a null id → window.PRODUCTS.find() missed → silent no-op on
  // EVERY Buy Now (regression from 827f0e3). Both paths below — the immediate
  // signed-in path and the guest-replay closure that runs post-sign-in — now
  // use the captured pid.
  const pid = currentDetailId;
  // Guest gate. We pass the replay intent so a guest who completes
  // sign-in lands directly back in checkout.
  if (!window.requireAuth('to buy this listing', () => { closeDetailModalDirect(); openCheckout(pid, qty); })) return;
  closeDetailModalDirect();
  openCheckout(pid, qty);
};
A['detail-message-seller']   = () => {
  // Persist the listing ID across the auth round-trip (currentDetailId
  // resets when the modal closes during sign-in).
  const _id = currentDetailId;
  if (!window.requireAuth('to message the seller', () => { closeDetailModalDirect(); openChatForListing(_id); })) return;
  closeDetailModalDirect();
  openChatForListing(_id);
};
// Feature #15 — saved searches v1.1
A['open-save-search-name']    = () => { if (!window.requireAuth('to save this search')) return; openSaveSearchName(); };
A['confirm-save-search']      = () => { if (!window.requireAuth('to save your search')) return; confirmSaveSearch(); };
A['toggle-saved-search-notify'] = (el) => { if (!window.requireAuth('to manage your saved searches')) return; toggleSavedSearchNotify(el.dataset.searchId); };
// Reviews v1.1
A['vote-review-helpful']      = (el) => { if (!window.requireAuth('to vote on reviews')) return; voteReviewHelpful(el.dataset.reviewId, el.dataset.vote); };
A['open-report-review']       = (el) => { if (!window.requireAuth('to report a review')) return; openReportReview(el.dataset.reviewId); };
A['confirm-report-review']    = () => { if (!window.requireAuth('to submit your report')) return; confirmReportReview(); };
A['close-sell-direct']       = () => closeSellModalDirect();
A['close-stripe-required']   = () => closeStripeRequiredDirect();
A['submit-listing']          = () => { if (!window.requireAuth('to publish your listing')) return; submitListing(); };
A['toggle-sell-qty']         = () => { if (window.__setSellQtyVisible) window.__setSellQtyVisible(true); const q = document.getElementById('sellQuantity'); if (q) q.focus(); };
// 'ai-suggest-price' retired r257 (Gemini pair replaced by the Listing
// v2 draft bar). The old aiSuggestPrice/aiGenerateDesc JS is documented
// dead code pending a cleanup pass.
A['pick-spec-cat']            = (el) => { if (window.setSpecCategory) window.setSpecCategory(el.dataset.speccat); };
A['ai-draft-listing']         = () => { if (!window.requireAuth('to draft your listing')) return; window.aiDraftListing && window.aiDraftListing(); };
A['ai-draft-undo']            = () => { window.aiDraftUndo && window.aiDraftUndo(); };
A['photo-make-main']          = (el) => { window.photoMakeMain && window.photoMakeMain(el.dataset.idx); };
A['sell-step-expand']         = (el) => { window.expandSellStep && window.expandSellStep(el.dataset.step); };
A['caddie-price']             = (el) => { window.caddieSetPrice && window.caddieSetPrice(Number(el.dataset.price) || 0, el); };
A['sell-draft-resume']        = () => { window.resumeSellDraft && window.resumeSellDraft(); };
A['sell-draft-discard']       = () => { window.discardSellDraft && window.discardSellDraft(); };
A['apply-ai-price']           = (el) => {
  const p = Number(el.dataset.price || 0);
  const inp = document.getElementById('sellPrice');
  if (inp && p > 0) {
    inp.value = String(p);
    // Trigger the input event so any side effects (auth-photo-notice,
    // draft persistence) run as if the user typed it.
    inp.dispatchEvent(new Event('input', {bubbles: true}));
    if (window.showToast) showToast('Price applied.');
  }
};
A['close-checkout-direct']   = () => closeCheckoutDirect();
A['confirm-payment']         = () => { if (!window.requireAuth('to complete your purchase')) return; confirmPayment(); };
// Mount-time error recovery — re-runs openCheckout for the active product
// when the buyer taps the swapped "Try again" button on the Pay slot.
A['retry-checkout']          = () => {
  if (!window.checkoutProduct) { closeCheckoutDirect(); return; }
  const p = window.checkoutProduct;
  closeCheckoutDirect();
  setTimeout(() => window.openCheckout(p.id, Number(p.__qty || 1)), 50);
};
A['open-photo-input']        = () => document.getElementById('photoInput').click();
A['remove-photo']            = (el) => removePhoto(Number(el.dataset.idx));
A['open-conv']               = (el) => {
  if (!window.requireAuth('to open this conversation')) return;
  // r288: closing a thread used to drop you on the marketplace, because
  // closeChat only hides the chat and the inbox had already closed beneath
  // it. Remember the way in so the back arrow walks back one step instead
  // of all the way out.
  window.__chatCameFromInbox = true;
  openChatFromConversation(el.dataset.convId);
};
// Tap the thread-header partner name (or the avatar, when it's showing the
// partner-monogram fallback for a photo-less listing) → open that
// participant's public profile. Works for any uid (buyer or seller);
// openProfile renders empty listings/sold gracefully as "New seller".
A['open-chat-partner']       = () => { const uid = currentChat && currentChat.otherUserId; if (uid && typeof openProfile === 'function') openProfile(uid); };
// Notifications panel (Feature: notifications-v1)
A['toggle-notifications']    = () => { if (!window.requireAuth('to view your notifications')) return; toggleNotifications(); };
A['close-notifications']     = () => closeNotifications();
A['notif-open-order']        = (el) => {
  if (!window.requireAuth('to view your orders')) return;
  closeNotifications();
  if (typeof openShopDashboard === 'function') openShopDashboard().then(() => {
    setTimeout(() => { try { switchDashTab('sold'); } catch (_e) {} }, 250);
  });
};
A['notif-open-conv']         = (el) => {
  if (!window.requireAuth('to open this conversation')) return;
  closeNotifications();
  if (typeof openChatFromConversation === 'function') openChatFromConversation(el.dataset.convId);
};
A['notif-open-stripe']       = () => {
  if (!window.requireAuth('to set up Stripe payouts')) return;
  closeNotifications();
  const fn = window.__actions && window.__actions['stripe-connect'];
  if (typeof fn === 'function') fn();
};

// Backdrop click-to-close: an element marked data-close-on-backdrop
// fires the named action only when the click hits the backdrop itself.
document.querySelectorAll('[data-close-on-backdrop]').forEach((el) => {
  el.addEventListener('click', (ev) => {
    if (ev.target !== el) return;
    const name = el.dataset.closeOnBackdrop;
    const fn = A[name];
    if (typeof fn === 'function') fn(el, ev);
  });
});

// Populate every [data-ico] element with the matching SVG. Safe — no
// user data; ICONS values are hardcoded markup.
document.querySelectorAll('[data-ico]').forEach((el) => {
  const name = el.dataset.ico;
  const svg = window.ICONS && window.ICONS[name];
  if (svg) el.innerHTML = svg;
});

// r272: hero quick-action tiles — bingo mini board + rotating Journal covers.
(function () {
  // Mini board reflects the LOCAL saved game only (same key the bingo screen
  // writes). No network, no puzzle data, nothing that isn't already on this
  // device — so the preview cannot leak the day's answers.
  try {
    const board = document.getElementById('hqBingoBoard');
    if (board) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const g = (t) => parts.find((x) => x.type === t).value;
      const today = `${g('year')}-${g('month')}-${g('day')}`;
      const raw = localStorage.getItem('teebox.bingo.' + today);
      const cells = raw ? (JSON.parse(raw) || {}).cells : null;
      if (Array.isArray(cells)) {
        const boxes = board.querySelectorAll('i');
        let solved = 0;
        cells.slice(0, 9).forEach((c, i) => {
          if (c && c.state === 'correct') { boxes[i].classList.add('solved'); solved++; }
        });
        const sub = document.getElementById('hqBingoSub');
        if (sub && solved > 0) {
          sub.textContent = solved === 9
            ? 'All nine solved today'
            : `${solved} of 9 solved today`;
        }
      }
    }
  } catch (_e) { /* preview is decoration — never block the tile */ }

  // r273: the Journal cover rotation lived here and is gone with the
  // slideshow — the tiles are solid white now, so there is nothing to rotate
  // behind the label. cover-sm.webp assets deleted in the same commit.

  // r309: the Journal tile shows the newest article's headline. The source of
  // truth is the in-page Journal index (#journalBackdrop .journal-list) — the
  // one place article titles are already maintained, kept newest-first in
  // lockstep with /reads/index.html. Reading it here means publishing an
  // article updates this tile for free: no second list to forget, and no
  // network call on the homepage critical path. If the index is ever empty or
  // missing, the tile keeps the static fallback copy already in the DOM.
  try {
    const jsub = document.getElementById('hqJournalSub');
    const latest = document.querySelector('#journalBackdrop .journal-card .journal-title');
    const jtitle = latest && latest.textContent.trim();
    if (jsub && jtitle) jsub.textContent = 'Latest: ' + jtitle;
  } catch (_e) { /* fallback copy is already rendered */ }
})();

// r271: fill the category side-panel rows with the existing per-category
// SVGs. CATEGORY_ICON is the same source the cards and search chips use, so
// the panel can never drift from them. "all" has no dedicated glyph — it gets
// the sliders mark, matching the Shop dropdown's trigger.
document.querySelectorAll('.cat-side-ico[data-cat-ico]').forEach((el) => {
  const cat = el.dataset.catIco;
  try {
    el.innerHTML = cat === 'all'
      ? (window.ICONS && window.ICONS.sliders) || ''
      : (window.CATEGORY_ICON ? window.CATEGORY_ICON(cat) : '');
  } catch (_e) { /* an icon is decoration — never block the row */ }
});

// Hero featured cards + checkout/modal product slots use the
// .placeholder-art gradient. Drop a category icon inside the empty ones.
document.querySelectorAll('.feat-img.placeholder-art:empty').forEach((el, i) => {
  // The hero featured cards map to clubs / apparel / accessories.
  el.innerHTML = window.CATEGORY_ICON(['clubs','apparel','accessories'][i] || 'clubs');
});

// Nav magnifying-glass + bell glyphs. querySelectorAll so the r163
// native-app search row's icon gets the same glyph as the desktop nav's.
document.querySelectorAll('.nav-search-icon').forEach(el => { el.innerHTML = window.ICONS.search; });
const navInbox = document.getElementById('navInboxIcon');
if (navInbox) navInbox.innerHTML = window.ICONS.message;

// Wire star-rating picker (1..5) — tap OR drag across the stars. The old
// build only had per-button click handlers, which on iOS WKWebView were
// easy to miss (users reported "couldn't give any stars"). Pointer events
// on the container capture the drag and resolve the star under the finger,
// so a tap and a swipe both work; the per-button click stays as a fallback.
document.querySelectorAll('#reviewStars .star-pick').forEach((btn, i) => {
  btn.addEventListener('click', () => setStarRating(i + 1));
});
(function wireStarDrag() {
  const cont = document.getElementById('reviewStars');
  if (!cont) return;
  cont.style.touchAction = 'none';
  const ratingFromX = (clientX) => {
    const btns = cont.querySelectorAll('.star-pick');
    for (let i = 0; i < btns.length; i++) {
      if (clientX < btns[i].getBoundingClientRect().right) return i + 1;
    }
    return btns.length || 5;
  };
  let dragging = false;
  cont.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { cont.setPointerCapture(e.pointerId); } catch (_e) {}
    setStarRating(ratingFromX(e.clientX));
    if (e.cancelable) e.preventDefault();
  });
  cont.addEventListener('pointermove', (e) => { if (dragging) setStarRating(ratingFromX(e.clientX)); });
  const end = () => { dragging = false; };
  cont.addEventListener('pointerup', end);
  cont.addEventListener('pointercancel', end);
})();

// r270: close the Shop dropdown on outside click / Escape, matching the
// user menu's behaviour.
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('shopMenu');
  const wrap = document.getElementById('shopMenuWrap');
  if (!menu || !wrap || !menu.classList.contains('open')) return;
  if (!wrap.contains(ev.target)) window.__closeShopMenu();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const menu = document.getElementById('shopMenu');
  if (!menu || !menu.classList.contains('open')) return;
  window.__closeShopMenu();
  const btn = document.getElementById('shopMenuBtn');
  if (btn) btn.focus();
});

// Close the user menu when clicking outside it.
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('userMenu');
  const wrap = document.getElementById('userMenuWrap');
  if (!menu || !wrap || !menu.classList.contains('open')) return;
  if (!wrap.contains(ev.target)) {
    menu.classList.remove('open');
    const btn = document.getElementById('userBadge');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
});

// Close the notifications panel when clicking outside it.
// (Feature: notifications-v1)
document.addEventListener('click', (ev) => {
  const panel = document.getElementById('notifPanel');
  if (!panel || !panel.classList.contains('open')) return;
  // Ignore clicks on either of the toggle buttons (desktop or mobile).
  if (ev.target.closest('[data-action="toggle-notifications"]')) return;
  // Ignore clicks inside the panel itself.
  if (panel.contains(ev.target)) return;
  closeNotifications();
});

// Direct click listener on the hamburger as a backup. Build 18 reports
// suggested the data-action delegation occasionally missed the tap on
// iOS WKWebView — a direct binding guarantees the drawer opens.
const hamburgerBtn = document.querySelector('.mobile-nav-toggle');
if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const fn = window.__actions && window.__actions['toggle-mobile-nav'];
    if (typeof fn === 'function') fn(hamburgerBtn, ev);
  });
}

// Auto-close the mobile nav drawer when any link inside it is tapped.
// Runs after the action handler so the destination opens before the close.
document.addEventListener('click', (ev) => {
  const link = ev.target.closest('.mobile-nav-link');
  if (!link) return;
  const drawer = document.getElementById('mobileNavDrawer');
  if (!drawer || !drawer.classList.contains('open')) return;
  setTimeout(() => {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    const btn = document.querySelector('.mobile-nav-toggle');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    (document.getElementById('app-scroll')||document.body).style.overflowY = '';
  }, 80);
});

// Wire the filter bar.
const sortSel = document.getElementById('sortMode');
if (sortSel) sortSel.addEventListener('change', () => { window.__filter.sort = sortSel.value; buildProducts(); });
const fmin = document.getElementById('filterMin');
if (fmin) fmin.addEventListener('input', () => { const v = parseFloat(fmin.value); window.__filter.min = isNaN(v) ? null : v; buildProducts(); });
const fmax = document.getElementById('filterMax');
if (fmax) fmax.addEventListener('input', () => { const v = parseFloat(fmax.value); window.__filter.max = isNaN(v) ? null : v; buildProducts(); });
document.querySelectorAll('#filterCondition .condition-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const c = btn.dataset.cond;
    if (window.__filter.conditions.has(c)) {
      window.__filter.conditions.delete(c);
      btn.classList.remove('active');
    } else {
      window.__filter.conditions.add(c);
      btn.classList.add('active');
    }
    buildProducts();
  });
});
const fclear = document.getElementById('filterClear');
if (fclear) fclear.addEventListener('click', () => {
  window.__filter = { cat: window.__filter.cat, sort: 'newest', min: null, max: null, conditions: new Set() };
  if (sortSel) sortSel.value = 'newest';
  if (fmin) fmin.value = '';
  if (fmax) fmax.value = '';
  document.querySelectorAll('#filterCondition .condition-pill').forEach(b => b.classList.remove('active'));
  buildProducts();
});

// Sell-form draft autosave: snapshot every keystroke into localStorage
// so the long form survives an accidental refresh. Also re-evaluates
// the AI-description button's disabled state on every change.
SELL_FIELDS.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', captureSellDraft);
  el.addEventListener('change', captureSellDraft);
  el.addEventListener('input', refreshAiDescBtnState);
  el.addEventListener('change', refreshAiDescBtnState);
});

// Hydrate the watchlist set from Firestore so hearts are rendered
// correctly on first paint.
async function hydrateWatchlist() {
  if (!window.CURRENT_USER) return;
  const wl = await loadWatchlist();
  Object.keys(wl).forEach(id => {
    const num = Number(id);
    fav.add(Number.isFinite(num) ? num : id);
  });
  buildProducts();
}
window.hydrateWatchlist = hydrateWatchlist;

// Non-click events that need explicit listeners.
const photoInput = document.getElementById('photoInput');
if (photoInput) photoInput.addEventListener('change', (e) => onPhotoSelect(e));
const termsBox = document.getElementById('termsCheckbox');
if (termsBox) termsBox.addEventListener('change', () => onTermsCheck());
const searchIn = document.getElementById('searchInput');
if (searchIn) {
  searchIn.addEventListener('input', (e) => filterSearch(e.target.value));
  // r335: Enter from the input shows EVERY match in the grid (it used to
  // open the first row — "Peter Millar" ↵ landed on one pair of shoes).
  // ArrowDown moves focus into the results list so subsequent Enter
  // opens whichever row the user has selected — the typeahead path is
  // still there for anyone who wants a specific row.
  searchIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = String(e.target.value || '').trim();
      if (q) { e.preventDefault(); applySearchQuery(q); }
    } else if (e.key === 'ArrowDown') {
      const first = document.querySelector('#searchResults .search-result-item');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
}
// Enter / arrow keys on a focused result row.
const searchResultsEl = document.getElementById('searchResults');
if (searchResultsEl) {
  searchResultsEl.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.search-result-item');
    if (!row) return;
    if (e.key === 'Enter') { e.preventDefault(); row.click(); return; }
    if (e.key === 'ArrowDown') {
      const next = row.nextElementSibling;
      if (next && next.classList.contains('search-result-item')) { e.preventDefault(); next.focus(); }
    } else if (e.key === 'ArrowUp') {
      const prev = row.previousElementSibling;
      if (prev && prev.classList.contains('search-result-item')) { e.preventDefault(); prev.focus(); }
      else { e.preventDefault(); const si = document.getElementById('searchInput'); if (si) si.focus(); }
    }
  });
}
const chatIn = document.getElementById('chatInput');
if (chatIn) chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
const uploadZone = document.getElementById('uploadZone');
if (uploadZone) {
  uploadZone.addEventListener('dragover', (e) => onDragOver(e));
  uploadZone.addEventListener('dragleave', () => onDragLeave());
  uploadZone.addEventListener('drop', (e) => onDrop(e));
}
