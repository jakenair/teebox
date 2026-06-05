# TeeBox Market — Performance Audit (Runtime · Page-Load · Build/Deploy)

**Date:** 2026-06-05
**Type:** AUDIT + PLAN ONLY. No code changed, nothing deployed. Every finding is read-only analysis with `file:line` evidence.
**Method:** Code-only review across three axes by three independent passes — (1) Firestore read/listener cost in `index.html` + `functions/`, (2) front-end page-load causes (no Lighthouse run — founder will feed DevTools numbers; this flags the code-level causes those audits would surface), (3) build/deploy reliability. Mirrors the shape of `SECURITY_AUDIT_2026_05_17.md`.
**Supersedes:** the 2026-05-15 `PERF_AUDIT.md` (low-hanging-fruit pass). Its one applied win — preconnect/dns-prefetch to Firebase/Stripe/fonts origins — is **confirmed still present** (`index.html:272-285`). Its Phase-2 list is folded into the appendix.

Finding IDs: **NET-xxx** (runtime/Firestore), **FE-xx** (front-end/page-load), **BD-xx** (build/deploy).

---

## 1. Executive summary

The app is functionally sound; the perf debt is concentrated in three predictable places:

1. **One runaway client poll.** `NET-001` re-runs all four notification queries every 60s with `force=true` — deliberately defeating its own cache — for the entire life of any open tab. On an idle seller tab that's ~**72,000 Firestore reads/day** of pure waste, and it duplicates data the always-on inbox listener already holds. This is the single highest-ROI fix in the whole audit: one line, web-only, low risk.
2. **A 1 MB single-file SPA.** `index.html` is 19,063 lines / ~1 MB, of which ~692 KB is unminified inline JS and ~209 KB inline CSS. The service worker serves HTML network-first, so any one-character change re-ships the whole megabyte, and full-resolution listing photos are loaded into ~220 px grid thumbnails. These are the LCP/TTI/transfer items Lighthouse will flag.
3. **A blocked, all-manual functions deploy (#22) sitting on top of five at-risk triggers (#34).** `firebase deploy --only functions` hangs at discovery on the founder's disk-pressured laptop; the gcloud-direct escape hatch works but is hand-typed and has an **unresolved** failure — `moderateListingOnUpdate` didn't fire after a clean gcloud deploy. The web deploy half is cleanly separable and automatable today; the functions half must stay manual and gated until that's root-caused.

### Top 10 fixes by ROI (cross-axis, quick wins first)

| # | ID | Fix | Impact | Effort | Risk | Surface | #34 |
|---|----|-----|--------|--------|------|---------|-----|
| 1 | NET-001 | Drop `force=true` on the 60s notif poll (or delete the poll — the inbox listener already provides live unread) | High | Low | Low | web | No |
| 2 | BD-02 | Root `.gcloudignore` re-include `emails-build/` (or always `--source=./functions`) — stops shipping email fns that crash at runtime | High | Low | Low | server/process | No |
| 3 | NET-005 | Add `limit()` to unbounded `flaggedListings` mod-queue query | Med | Low | Low | web | No |
| 4 | NET-008 | Add `limit()` to unbounded legacy `savedSearches` query | Low | Low | Low | web | No |
| 5 | NET-006 | Gate `maybePromptReview` behind a per-session flag (stops ~120 reads/load) | Med | Low | Low | web | No |
| 6 | FE-04 | Un-block the render-blocking Google Fonts stylesheet (`media=print` onload swap or preload) | Med | Low | Low | web | No |
| 7 | FE-05 | Reconcile font weights — drop unused DM Sans 300; add the used-but-unrequested 800 | Med | Low | Low | web | No |
| 8 | FE-03 | Serve resized listing-photo thumbnails (consume the existing `optimizeListingPhoto` output / add `srcset`) | High | Med | Med | web/server | No |
| 9 | BD-04 | Root-cause why `moderateListingOnUpdate` didn't fire after gcloud deploy | High | Med | Med | server | **YES** |
| 10 | BD-01 | #22 durable fix: split the monolith `functions/index.js` (mechanically splittable — one-way require fan-out) | High | High | High | server | **YES** |

### Strategic (high-impact, high-effort — plan, don't rush)

- **FE-01 / FE-02** — split + minify the 1 MB SPA. ~692 KB unminified JS ships on every load regardless of route. High impact on TTI, but invasive (cross-`<script>` `window.*` mirroring) and needs a build step that doesn't exist yet.
- **BD-01** — the monolith split is both the #22 durable fix *and* the FE-02 server analog; it re-registers all five #34 triggers, so it's gated behind founder authorization and a verified deploy path.

### Findings totals

| Impact | NET | FE | BD | Total |
|--------|-----|----|----|-------|
| High   | 1   | 3  | 4  | 8 |
| Medium | 5   | 5  | 4  | 14 |
| Low    | 4   | 1  | 1  | 6 |
| **All**| **10** | **9** | **9** | **28** |

**Deploy-surface split:** web-only safe to ship now: all 10 NET + FE-04/05/07 + BD-05/06. Server/process (gated): FE-03/09 (Storage side), BD-01/02/03/04/07/08/09.

**#34 at-risk-trigger flags (would touch `moderateListingOnUpdate`, `notifyOnOfferUpdated`, `moderateProfileOnWrite`, `moderateUserDocOnUpdate`, `onParticipantStateReadCount`):** BD-01, BD-03, BD-04, BD-09. **Zero** runtime (NET) or front-end (FE) fixes require touching any at-risk trigger — the entire client-perf surface is shippable web-only.

---

## 2. Axis 1 — Runtime / Firestore cost

`functions/index.js` contains only Admin-SDK reads inside event-driven triggers/callables (server-billed, not the polling/listener surface) — no client listeners. All findings below are client-side in `index.html`. **Two `onSnapshot` listeners total; both detach correctly — no leaked/stacking listeners found.**

### Inventory table (every Firestore op in `index.html`)

| file:line | type | collection | limited? | detached? |
|---|---|---|---|---|
| 5539 | getDoc | listings/{id} | n/a | n/a |
| 5890, 6662, 6701, 6770, 6986, 11151, 12720, 15579, 15639 | getDoc | users/{uid} | n/a | n/a |
| 7411 | getDocs | listings (browse) | limit(200) | n/a |
| 7725, 9398, 10121, 13269 | getDoc | listings/{id} | n/a | n/a |
| 9269, 9276 | getDocs | bids | limit(20) | n/a |
| 9332 | setDoc (write) | presence/{uid} | n/a | timer cleared |
| **9350** | **setInterval** presence heartbeat (25s) | presence/{uid} (write) | n/a | **YES** |
| 9428, 13281 | getDocs | conversations/offers (dup-check) | n/a | n/a |
| **9585/9590** | **onSnapshot** messages | conversations/{cid}/messages | limitToLast(200) | **YES** |
| **9819/9825** | **onSnapshot** unread/inbox | conversations | limit(50) | **YES** |
| 9915 | getDocs fallback | conversations | limit(100) | n/a |
| 10015, 10259, 10347, 13177, 13413 | **getDoc fan-out** | listings/{id} | n/a | n/a |
| 10231/10240, 13108/13117, 13383/13391 | getDocs | offers | limit(50) | n/a |
| 10281, 10316 | getDocs | orders/conversations (notif) | limit(50) | n/a |
| 10373 | getDocs | listings (seller probe) | limit(1) | n/a |
| **10553** | **setInterval** notif poll (60s) | 4 queries + fan-out | partial | **NO (never cleared)** |
| **10591, 10600** | getDocs dashboard | listings, orders | limit(500) | n/a |
| 11742 | getDoc | config/features | n/a | n/a |
| 11833 | getDocs | listings (price suggest) | limit(50) | n/a |
| **12345** | getDocs | users/{uid}/savedSearches | **NO limit** | n/a |
| 12430 | getDocs | orders (buyer) | limit(100) | n/a |
| 13592/13600/13609 | getDocs | savedSearches | limit(50) | n/a |
| 14277/14287 | getDocs | reviews | limit(50) | n/a |
| 14332/14341 | getDocs | orders (recent sold) | limit(5/50) | n/a |
| 14404, 14424 | getDocs | orders (review prompt) | limit(30) | n/a |
| 14413, 14433 | **getDoc fan-out** | reviews/{orderId}_{role} | n/a | n/a |
| 14951/14952 | getDoc (TTL-cached) | profiles, users | n/a | n/a |
| 15031 | getDocs | listings (profile) | limit(200) | n/a |
| **15397** | **getDocs fan-out** | reviews/{rid}/helpfulVotes | **NO limit** | n/a |
| **16880** | getDocs (mod queue) | flaggedListings | **NO limit** | n/a |
| 13848 | getDoc | globalStats/all | n/a | n/a |
| 14886 | getDoc | priceHistory/{slug} | n/a | n/a |
| 17631 | getDoc | dailyPuzzles/{date} | n/a | n/a |
| 18266 | getDocs | gameScores (bingo lb) | limit(50) | n/a |
| 14049 | setInterval (SW update) | none | n/a | NO (intentional) |
| 17002 | setInterval (auth-gate) | none | n/a | YES |

---

### NET-001 — 60-second notification poll (4 queries + fan-out, never stops, defeats its own cache)
- **Location:** `index.html:10553` (interval) → `loadNotifications(true)` `index.html:10185` → sub-queries at `10231/10281/10316/10373`, fan-out `10259/10347`
- **Type:** poll/interval with fan-out
- **What it does:** A global `setInterval(…, 60000)` calls `loadNotifications(true)` with `force=true`, which **bypasses the `NOTIF_CACHE_MS` cache** and re-runs all four notification queries + per-item hydration every 60s for the page lifetime while signed in. The interval handle is never stored or cleared.
- **Cost reasoning:** Each forced cycle ≈ offers limit(50) + orders limit(50) + unread-convs limit(50) + seller-probe limit(1) ≈ **up to 151 query reads**, plus fan-out (listing/profile hydration, mostly cache-warm). Cold first cycle ≈ 167 reads; warm steady-state ≈ **~151 reads / 60s / open tab**. An 8-hour idle seller tab = 480 cycles × ~151 ≈ **~72,000 reads/day/idle-tab**, none user-initiated. The unread-convs query here **duplicates** the always-on `__unreadUnsub` listener (NET-003) — the data is already in memory.
- **Impact:** High · **Effort:** Low · **Risk:** Low · **Surface:** web · **#34:** No

### NET-002 — Seller dashboard pulls up to 500 listings + 500 orders, capped but not paginated, no cache
- **Location:** `index.html:10591` (listings limit(500)), `10600` (orders limit(500)) in `loadShopData`; called on every `openShopDashboard` (`10574`) and post-edit via `window.loadShopData`
- **Type:** one-shot read (large cap, no pagination)
- **What it does:** Every dashboard open reads up to 500 listings + 500 orders in two `getDocs`, then profile + offers. Capped at 500 but **not cursor-paginated** (comment flags pagination as TODO); no in-memory cache, so every re-open re-fetches everything.
- **Cost reasoning:** Typical small seller (20 listings / 30 orders) ≈ **~50 reads/open** — fine. Power seller at the cap = **up to ~1,000 reads/open**, and every tab-switch back + every post-edit `loadShopData()` re-pays it. The 500 cap bounds worst case but there's no delta/cache.
- **Impact:** Medium (bites high-volume sellers — exactly the costly accounts) · **Effort:** Medium · **Risk:** Low–Med (stats/charts assume the full set; paginating means revenue totals move server-side) · **Surface:** web · **#34:** No

### NET-003 — Unread/inbox realtime listener + per-conversation thumbnail fan-out
- **Location:** listener `index.html:9819/9825` (`attachUnreadListener`); fan-out `hydrateInboxThumbs` `9992-10033` (getDoc loop `10015`); cold fallback `9915`
- **Type:** listener + fan-out
- **What it does:** One always-on `onSnapshot` on `conversations where participants array-contains uid orderBy lastMessageAt desc limit(50)`, attached on auth-ready, kept for the session, **properly detached** on sign-out. On inbox render, one `getDoc(listings/{id})` per distinct conversation listing (cached in `__inboxListingCache`).
- **Cost reasoning:** Initial attach = up to 50 conversation reads. Then **1 read per changed doc** per snapshot (~1/inbound message — cheap, correct). Inbox-open fan-out ≈ C (≤50) listing reads **once** (warm re-renders ≈ 0). The only real cost: the 50-read attach happens for **every** signed-in user on every page load whether or not they open the inbox.
- **Impact:** Medium · **Effort:** Low (defer attach until first badge/inbox need) · **Risk:** Med (badge correctness depends on early attach) · **Surface:** web · **#34:** No (the read-count derivation lives in `onParticipantStateReadCount`, but this client listener doesn't require touching it)

### NET-004 — Presence heartbeat (chat-open write every 25s, write-only, well-bounded)
- **Location:** `index.html:9350` (`setInterval(_writePresence, 25000)`); write `9331`; clear-on-close `9355/9568`; visibility pause `9374`
- **Type:** poll/interval (write-only)
- **What it does:** While a chat thread is open, writes `presence/{uid}` immediately then every 25s so server-side `pushOnNewMessage` can skip pushing to a recipient already viewing the thread. Cleared on close, paused on tab-hide.
- **Cost reasoning:** This is a **write**, not a read: ~2.4 writes/min while a thread is open + foregrounded; a 10-min session ≈ **~25 writes**. Client does **zero** presence reads (read side is server, 1/inbound message). Lifecycle correct: timer stored, `clearInterval` on close/hide, visibility handler stops a backgrounded phone writing forever.
- **Impact:** Low · **Effort:** Low · **Risk:** Med (25s is deliberately under the 30s `PRESENCE_WINDOW_MS`; widening risks a missed beat flipping the recipient back to push-eligible mid-chat) · **Surface:** web · **#34:** No

### NET-005 — Moderation queue: unbounded `flaggedListings` query (no limit)
- **Location:** `index.html:16880`
- **Type:** one-shot read (unbounded)
- **What it does:** `getDocs(query(collection('flaggedListings'), orderBy('flaggedAt','desc')))` with **no `.limit()`** — pulls the entire collection on every mod-queue open, no cache.
- **Cost reasoning:** Reads = N total flagged docs, unbounded and monotonically growing. Admin-only (low traffic) but a queue that's flagged 5,000 items over time = 5,000 reads/open.
- **Impact:** Medium · **Effort:** Low (`limit(100)` + cursor) · **Risk:** Low · **Surface:** web · **#34:** No

### NET-006 — Review-prompt scan: 60 order reads + per-delivered-order review getDoc fan-out, on every load
- **Location:** `index.html:14404` (buyer orders limit(30)), `14413` (getDoc reviews/_buyer in loop), `14424` (seller orders limit(30)), `14433` (getDoc reviews/_seller in loop); triggered by `setTimeout(maybePromptReview, 2000)` at `5783`
- **Type:** fan-out
- **What it does:** 2s after auth on every load, reads the 30 most-recent buyer + 30 seller orders, and for each `delivered` one does an extra `getDoc(reviews/{orderId}_{role})`; stops at first un-reviewed delivered order.
- **Cost reasoning:** Up to 60 order reads + up to ~60 review getDocs ≈ **~120 reads per page load**, before the user does anything. No cross-reload caching.
- **Impact:** Medium · **Effort:** Low (per-session flag, or a server-derived `hasUnpromptedReview` field, or a recent-time-range window) · **Risk:** Low · **Surface:** web · **#34:** No

### NET-007 — Review helpfulness hydration: unbounded subcollection getDocs per review + self-re-render
- **Location:** `index.html:15397` (`hydrateReviewHelpfulness`, getDocs per review, **no limit**); re-render `15418` re-calls `openProfile`
- **Type:** fan-out
- **What it does:** For each visible review, `getDocs(collection('reviews', rid, 'helpfulVotes'))` — the **entire** votes subcollection per review — to tally yes/no/mine; if counts changed it re-calls `openProfile(uid)` (cached, so the second pass short-circuits).
- **Cost reasoning:** With R visible reviews × V votes each, cost = ΣV reads, unbounded per review. A popular review with 500 votes = 500 reads just to show "3 found helpful." Each profile open = R unbounded subcollection scans.
- **Impact:** Medium (scales with vote counts, which grow on popular sellers) · **Effort:** Med (denormalize `helpfulYes/No` counters via a **new** trigger — not one of the at-risk five) · **Risk:** Med (quick `limit()` fix makes counts inaccurate) · **Surface:** web (quick) / server (counter) · **#34:** No

### NET-008 — Saved-searches legacy subcollection query (no limit; inconsistent with the limited path)
- **Location:** `index.html:12345` (`openSavedSearches`, `users/{uid}/savedSearches`, **no limit**); a parallel limited path exists at `13609` (limit(50))
- **Type:** one-shot read (unbounded)
- **Cost reasoning:** Reads = N saved searches, unbounded — but self-created and rarely >10 in practice. Flagged for completeness + consistency with the limited path.
- **Impact:** Low · **Effort:** Low (`limit(50)`) · **Risk:** Low · **Surface:** web · **#34:** No

### NET-009 — Browse-listings homepage fetch (200-row cap, no cursor pagination)
- **Location:** `index.html:7411` (`loadListings`, listings orderBy createdAt limit(200))
- **Type:** one-shot read (large cap)
- **Cost reasoning:** Up to 200 reads per fresh page load; grid shows a few dozen above the fold, so ~170 are speculative. Filter/category paths appear to operate in-memory on `window.PRODUCTS` (good — confirm they don't re-invoke `loadListings`, which would be another 200 reads each). Multiplies by traffic; partly served from the Firestore SDK local cache on warm reloads.
- **Impact:** Low–Med · **Effort:** Med (cursor-paginated infinite scroll) · **Risk:** Low · **Surface:** web · **#34:** No

### NET-010 — Low-cost one-shot reads (grouped — fine, listed for completeness)
- **Location:** ~40 single-doc `getDoc`s + small bounded queries (user/profile/listing/order/config/globalStats/priceHistory/dailyPuzzles lookups; bids limit(20), price-suggest limit(50), offers limit(50), reviews limit(50), bingo lb limit(50), etc.)
- **Cost reasoning:** 1 read each (docs) or ≤limit (queries), all user-action-gated, mostly cached (`PROFILE_CACHE_TTL_MS`, `REVIEW_AGG_CACHE`) or bounded ≤50. No fan-out, no polling, no leaks. These dominate the callsite count but are individually negligible. **No action.**
- **Impact:** Low · **#34:** No

---

## 3. Axis 2 — Front-end / page-load

Confirmed up front: preconnect/dns-prefetch from the prior audit still present (`index.html:272-285`); `font-display:swap` is set; `loading="lazy"` on 16 of ~20 imgs (lightbox correctly `eager`). SW strategy: HTML network-first (`sw.js:116`), same-origin stale-while-revalidate (`sw.js:140`), API hosts network-only bypass, cross-origin images bypass (`sw.js:164`), bingo logos cache-first in an isolated namespace.

### FE-01 — Enormous single-file SPA payload (~1 MB HTML, fully re-downloaded on every deploy)
- **Location:** `index.html` (whole file, 19,063 lines / 1,022,962 bytes)
- **Lighthouse:** "Avoid enormous network payloads" + "Reduce unused JavaScript" + "Efficient cache policy"
- **Cause:** Everything inlined. Breakdown: inline `<style>` `287-3014` ≈ 209 KB; inline scripts ≈ 692 KB (largest single block `7895-17322` ≈ **449 KB**; module `5396-7893` ≈ 131 KB; module `17350-19061` ≈ 72 KB). Because the SW serves HTML network-first, any one-char change cache-busts and re-ships the whole ~1 MB; no CSS/JS can be cached independently or marked immutable.
- **Impact:** High · **Effort:** High · **Risk:** High (cross-`<script>` `window.*` mirroring — see `index.html:5158, 7996`) · **Surface:** web + process

### FE-02 — ~692 KB of unminified inline JS parsed/executed before interactivity
- **Location:** `index.html:7895-17322` (449 KB), `5396-7893` (131 KB module), `17350-19061` (72 KB module)
- **Lighthouse:** "Reduce unused JavaScript" / "Minimize main-thread work" / "JavaScript execution time"
- **Cause:** All app logic ships on first load regardless of route; module blocks are deferred but the classic `<script>` blocks (`3051`, `4910`, the giant `7895`) execute synchronously where they sit. No code-splitting, no lazy routes, **no minification** (full commented source ships to clients).
- **Impact:** High · **Effort:** High · **Risk:** Medium · **Surface:** web + process (needs a build/minify step — none exists)

### FE-03 — Full-resolution Firebase photos loaded into thumbnail grids (no resize/CDN transform)
- **Location:** `index.html:3061-3068` (`safeImgUrl` pass-through); grid cards `8195, 8995, 10953, 13195`; grid CSS `1407` (`minmax(220px,1fr)`), `1456` (`aspect-ratio:4/3`)
- **Lighthouse:** "Properly size images" + "Avoid enormous network payloads"
- **Cause:** `safeImgUrl` returns the raw Storage URL verbatim — no `=s400`/width param, no thumbnail variant, no `srcset`/`sizes` (0 `srcset` matches). Cards render ~220 px (dashboard thumb 50×50) yet fetch the original multi-MB upload. The comment at `10943` notes an `optimizeListingPhoto` Cloud Function **exists**, but the client still requests full-res.
- **Impact:** High (LCP + transfer on the main grid) · **Effort:** Med · **Risk:** Med (depends on whether resized derivatives are actually generated/stored) · **Surface:** web + server (Storage/Functions derivative generation)

### FE-04 — Render-blocking Google Fonts stylesheet in `<head>`
- **Location:** `index.html:286`
- **Lighthouse:** "Eliminate render-blocking resources"
- **Cause:** Synchronous cross-origin `<link rel="stylesheet">` to `fonts.googleapis.com` blocks first paint on the round-trip (then `fonts.gstatic.com` for WOFF2). `preconnect` to both origins mitigates the handshake but not the request-chain blocking. No `media="print" onload` swap, no font-file `preload`, no self-hosting. (`font-display:swap` is in the URL, so FOIT is handled — the stylesheet link itself is the blocker.)
- **Impact:** Medium · **Effort:** Low · **Risk:** Low · **Surface:** web

### FE-05 — Eight font weights requested across two families; several unused/mismatched
- **Location:** `index.html:286` — `Playfair+Display:wght@400;700;900` + `DM+Sans:wght@300;400;500;600`
- **Lighthouse:** font transfer / "Avoid enormous network payloads"
- **Cause:** 7 distinct weight files requested. CSS actually uses 700 (×132), 600 (×96), 800 (×16), 500 (×11), 900 (×8). Two mismatches: (a) **DM Sans 300 is requested but never used** in any `font-weight` — wasted download; (b) CSS uses **800 (×16) which is NOT requested** for either family → browser synthesizes faux-bold / falls back. A requested weight is wasted while a used weight is missing.
- **Impact:** Medium · **Effort:** Low (edit the font URL: drop 300, reconcile 800) · **Risk:** Low · **Surface:** web

### FE-06 — CACHE_VERSION bump wipes the entire SW cache + stale-client deploy footgun
- **Location:** `sw.js:3` (`r94`), `sw.js:55-62` (activate deletes all non-matching caches), shell `9-23`
- **Lighthouse:** "Efficient cache policy" — coarse invalidation
- **Cause:** The version string *is* the cache name; on activate every key `!== CACHE_VERSION` is deleted, so `r94→r95` discards the whole app-shell + all SWR runtime entries at once → next load re-fetches `/`, the 1 MB `index.html`, `bingo-courses.js`, all icons. No per-asset content hashing. Footgun: HTML is network-first (fresh on deploy, good), but genuinely-changed static assets rely on a **manual** bump; forgetting it serves stale SWR copies (`BINGO_LOGO_CACHE` is separate and survives bumps, `sw.js:8`). See the v1.1 stale-pin incident comment at `sw.js:66-67`.
- **Impact:** Medium · **Effort:** Med (hashed asset names + precache manifest) · **Risk:** Med · **Surface:** process + web

### FE-07 — `<img>` elements lack intrinsic width/height (CLS where no aspect-ratio wrapper)
- **Location:** ~20 `<img>` templates incl. `index.html:7992, 8051, 8160, 8278, 8995, 13195, 14803, 15116, 16909, 18345`
- **Lighthouse:** "Image elements do not have explicit width and height" → "Avoid large layout shifts"
- **Cause:** No `width`/`height` attrs on the imgs. The main grid is largely protected because `.product-img-wrap` and thumb containers set `aspect-ratio:4/3` / fixed px (`1456, 284, 300, 369`), so the reserved box doesn't shift. Images **without** a wrapper — moderation `mod-photo`, lightbox `18345` (`eager`, no dims) — reflow as they load. CLS contained on the primary grid, not guaranteed everywhere.
- **Impact:** Med-Low · **Effort:** Low · **Risk:** Low · **Surface:** web

### FE-08 — Chart.js (~200 KB) loaded on every page though only dashboard/analytics use it
- **Location:** `index.html:4906` (Stripe `defer`), `4907-4909` (Chart.js `defer`, jsDelivr), `60` (Plausible `defer`), `83-189` (PostHog inline loader)
- **Lighthouse:** "Reduce the impact of third-party code"
- **Cause:** Stripe + Chart.js both `defer` (not render-blocking) with `dns-prefetch` present — good. But Chart.js 4.4.1 UMD (~200 KB) loads on **every** page even though charts only appear on dashboard/analytics; lazy-load on the dashboard route. Two analytics vendors (Plausible + PostHog) also load early; none render-blocking but they add third-party weight. (Re-raises the prior audit's deferred Chart.js lazy-load item with the over-fetch quantified.)
- **Impact:** Low-Med · **Effort:** Med (lazy-load Chart.js) · **Risk:** Low · **Surface:** web

### FE-09 — Cross-origin listing images bypass the SW cache (rely on Storage HTTP headers only)
- **Location:** `sw.js:160-166`
- **Lighthouse:** "Serve images with an efficient cache policy"
- **Cause:** For cross-origin `image` requests the SW returns early and leans on the browser HTTP cache + whatever `Cache-Control` Firebase Storage returns (often short/absent unless set at upload). Combined with FE-03 (full-res), repeat-visit image transfer can be high. Deliberate (per comment, to avoid pinning stale demo images) but leaves real-photo caching to upstream headers not controlled here.
- **Impact:** Low · **Effort:** Med (set `cacheControl` metadata at upload) · **Risk:** Low · **Surface:** server (Storage upload metadata)

---

## 4. Axis 3 — Build / deploy

### BD-01 — #22 deploy discovery hang: cold-I/O FS thrash + monolith require-walk
- **Location:** `functions/index.js` (7,042 LOC); require cluster **`index.js:6915-7042`** (21 `Object.assign(exports, require("./..."))` lines — *corrected from the stale `6742-6869`, which is now the `sendMessage` rate-limiter*); lazy-init `functions/moderation/contentFilter.js:84-108`; `POST_BETA_FIXES.md:186-223`
- **What fails:** `firebase deploy --only functions` hangs at "Loading and analyzing source code…" for 180s+ and times out at every `FUNCTIONS_DISCOVERY_TIMEOUT` (10/60/180/300/600/900). Discovery does an in-process `require("./index.js")` pulling all 21 submodules + heavy SDKs; bare `require()` measured **245s** on the disk-pressured laptop (disk 98-99% full). Compound root cause: (a) cold-I/O FS thrash on a near-full disk, (b) the one-way require fan-out at `6915-7042`. Lazy-init of `bad-words` is applied and correct but "necessary but insufficient" — deferring app SDKs doesn't avoid walking the internal require tree.
- **Monolith-split assessment — favorable:** **no submodule requires back into `./index.js`** (zero `require("./index")` matches) → strictly one-way fan-out, mechanically splittable into per-domain files using the exact `Object.assign(exports, require(...))` pattern already in use. The 50 `exports.*` still inline in `index.js` are the migration surface.
- **Impact:** High · **Effort:** High (durable split) / Low (gcloud escape hatch / clean machine) · **Risk:** High (split re-registers every trigger's deploy identity) · **Surface:** server · **#34:** **YES** — a split moves/re-registers `moderateListingOnUpdate` (`5925`), `notifyOnOfferUpdated` (`4075`), `moderateProfileOnWrite` (`6372`), `moderateUserDocOnUpdate` (`6421`), `onParticipantStateReadCount` (`messageReadState.js:159`).

### BD-02 — Root `.gcloudignore` excludes `emails-build/` with NO re-include → ships email fns that crash at runtime
- **Location:** root `.gcloudignore:55` vs `functions/.gcloudignore:41-43`
- **What fails:** `functions/.gcloudignore` correctly re-includes after the gitignore-include chain (`!emails-build/`, `!emails-build/**`, `!data/bingo-puzzle-data.json`). The **root** `.gcloudignore:55` excludes `emails-build` with **no re-include**. `emails-build/` is gitignored (362 MB, never committed) and only regenerated by `npm run build:emails`. If a deploy runs from repo root (or `--source` is omitted — the root file's header notes it was auto-created on exactly such an incident on 2026-05-29), the upload omits rendered templates and every email-sending fn (`sendMessage`, `emailTriggers`, `emailSmokeTest`) throws `Cannot find module './emails-build/...'` at first send — **silent deploy success, runtime failure**. Compounding: gcloud skips the `predeploy` hook (`build:emails && build:bingo-canon`), so the operator must rebuild manually. Secrets are correctly excluded by both files — a deploy **cannot** ship secrets.
- **Impact:** High · **Effort:** Low (add re-includes to root `.gcloudignore`, or enforce `--source=./functions`) · **Risk:** Low · **Surface:** server/process · **#34:** No

### BD-03 — gcloud-direct deploy path is all-manual: region/trigger-location/namespace/entry-point/secret footguns
- **Location:** `POST_BETA_FIXES.md:204-221`; `defineSecret` arrays across `functions/*.js`
- **What fails:** Because #22 blocks `firebase deploy`, the working path is hand-typed `gcloud functions deploy <name> --gen2` with no validation. Error-prone: function `--region=us-central1` but `--trigger-location=nam5` (Firestore DB is in `nam5`, not us-central1 — mismatch silently mis-wires the trigger); the four `--trigger-event-filters` + path-pattern; the `namespace=(default)` filter the docs omit but sister `moderateListingOnCreate` includes; `--entry-point` must match the export; `--runtime/--memory/--timeout` must match the in-code option block. Critically, **gcloud does not read the in-code `secrets:[...]` arrays** the way `firebase deploy` does — every function's secrets must be re-bound by hand or it deploys without them and fails at first invocation. One function per `delete`. Documented only as prose in one doc.
- **Impact:** High · **Effort:** Med (wrap per-function gcloud calls in a manifest-driven script) · **Risk:** Med (a generated script that mis-derives a trigger filter is as dangerous as hand-typing) · **Surface:** server/process · **#34:** **YES** — this is the path used to (re)deploy all five at-risk triggers.

### BD-04 — `moderateListingOnUpdate` did not fire after a clean gcloud deploy (UNRESOLVED)
- **Location:** `functions/index.js:5925`; `POST_BETA_FIXES.md:222`
- **What fails:** After a clean gcloud deploy (101s, State=ACTIVE, gen2), a smoke test updated a listing title with a profane string and polled 30s: title **not** reverted, **zero** `moderationLog` rows. Rolled back immediately per founder instruction; no diagnosis. Open hypotheses (unvalidated): (a) Eventarc needs 5-10 min post-deploy propagation, 30s poll too short; (b) gcloud may not auto-wire the Eventarc/Cloud Run invoker IAM bindings `firebase deploy` creates; (c) `namespace=(default)` filter wrong for this DB flavor. **The gcloud escape hatch has an unproven track record for Firestore-triggered moderation specifically** — the highest-value server protection. Repro: redeploy, wait 10 min, `gcloud functions logs read moderateListingOnUpdate --gen2 --region=us-central1 --limit=20` after a test write; inspect IAM bindings.
- **Impact:** High (silent loss of server-side content moderation) · **Effort:** Med · **Risk:** Med · **Surface:** server · **#34:** **YES** — `moderateListingOnUpdate` (named); same hypothesis gates `moderateProfileOnWrite`, `moderateUserDocOnUpdate`.

### BD-05 — Web deploy path is ambiguous (GitHub Pages `git push` vs Firebase Hosting `dist/`) — split-brain risk
- **Location:** `package.json:27` (`deploy:hosting` → Firebase Hosting); `scripts/launch-deploy.sh:91-100` (step 6 → `git push` Pages); `scripts/launch-preflight.sh:146-152` (asserts origin=github.com); `firebase.json:23-24` (`hosting.public: "dist"`)
- **What fails:** Two contradictory web-deploy mechanisms coexist mid-migration. `npm run deploy:hosting` ships `dist/` to Firebase Hosting; `launch-deploy.sh` step 6 instead `git push`es to GitHub Pages, and preflight *fails* if origin isn't github.com. Which is live depends on current DNS, which neither script checks. Risk: running `launch-deploy.sh` while DNS points at Firebase ships the new `index.html`/`sw.js` to a Pages origin nobody serves → prod stays stale. Also a stray `dist 2/` + `assets 2` (artifact duplication from the disk-pressure incident).
- **Impact:** Medium · **Effort:** Low (pick one path) · **Risk:** Low · **Surface:** web/process · **#34:** No

### BD-06 — `sw.js` CACHE_VERSION bump is manual; preflight warns but does not block
- **Location:** `sw.js:3`; `scripts/launch-preflight.sh:117-143`; `build:web` in `package.json:12`
- **What fails:** Forgetting to bump `CACHE_VERSION` means the SW keeps serving the old cached `index.html`/assets — clients never get the new build. Partial guard: preflight validates format + age but only `warn`s on staleness (never blocks), and the age check fires at >7 days, not "changed since last deploy." The bump is fully manual; `build:web` copies `sw.js` verbatim, so a forgotten bump propagates unchanged. (`firebase.json:118-121` sets `sw.js` to `max-age=0, must-revalidate`, so the file updates — its internal cache key not changing is the footgun.)
- **Impact:** Medium · **Effort:** Low (`prebuild` auto-increment `rNN` + date, or preflight `warn`→`fail` when unchanged) · **Risk:** Low · **Surface:** web/process · **#34:** No

### BD-07 — `launch-deploy.sh` steps 4-5 invoke the exact `firebase deploy --only functions` that #22 hangs on
- **Location:** `scripts/launch-deploy.sh:84-89`
- **What fails:** Step 5 runs `firebase deploy --only functions` (the all-functions discovery deploy #22 hangs on). Step 4's *targeted* `firebase deploy --only functions:notifyOnNewMessage,...` still routes through the same in-process `require("./index.js")` discovery, so it's **also** exposed. The documented "safe order" runbook stalls at step 4/5 on the affected machine, with `set -eu` + ERR trap aborting the whole sequence (incl. the not-yet-reached web push). No awareness of the gcloud escape hatch.
- **Impact:** Medium · **Effort:** Low (gate behind gcloud-direct or a clean-machine check) · **Risk:** Low · **Surface:** server/process · **#34:** No (it would attempt to redeploy all triggers if run, but the finding is the orchestrator stalling)

### BD-08 — Secrets/version pins must be pre-set; preflight checks `index.js` secrets only, misses submodule secrets
- **Location:** `scripts/launch-preflight.sh:54-76`; `defineSecret` across `functions/*.js`
- **What fails:** 20+ secrets via `defineSecret` in `index.js` (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GEMINI_API_KEY, RESEND_API_KEY, ADMIN_ALLOWLIST, STRIPE_PRO_PRICE_ID) **and submodules** (`founderBriefing.js`: ANTHROPIC_API_KEY, SLACK_BRIEFING_WEBHOOK; `emailSmokeTest/emailTriggers`: RESEND_WEBHOOK_SECRET, SMOKE_EMAIL_INBOX, FREEZE_HMAC_SECRET; `smokeTest.js`: STRIPE_TEST_SECRET_KEY; `shippoIntegration.js`: SHIPPO_API_KEY; `missingProducers.js`: stripeConnectWebhookSecret). Missing → deploys but throws at first access (no `RESEND_API_KEY` breaks every email; no `STRIPE_SECRET_KEY` breaks checkout/refund/payout). **Preflight greps only `functions/index.js`** (`:60`), so submodule secrets are unverified — a deploy can pass with `ANTHROPIC_API_KEY`/`SHIPPO_API_KEY` unset. Also `resend@^6.12.2` + other `^`-pinned heavy deps float; a transitive bump that slows load directly worsens #22.
- **Impact:** Medium · **Effort:** Low (extend preflight to `functions/**/*.js`) · **Risk:** Low · **Surface:** server/process · **#34:** No

### BD-09 — CI-ability: web deploy is automatable now; functions deploy is not (but #22 is environment-specific)
- **Location:** process-wide; `POST_BETA_FIXES.md:204` (Cloud Build did the require-walk in ~100s vs 180s+ local)
- **Assessment:** #22 is **environment-specific to the disk-pressured laptop**, not intrinsic: the same chain that hung 180s+ locally completed ~100s on Cloud Build. So `firebase deploy --only functions` would very likely **not** hang on a GH Actions / Cloud Build runner (fast SSD, no disk pressure) — making functions deploy CI-able in principle and obsoleting the gcloud footguns (BD-03/04). **But BD-04 must be root-caused first** — CI inherits any IAM/propagation gap. The **web half is cleanly separable and automatable today**: `firebase deploy --only hosting` / `firestore:indexes` / `firestore:rules,storage` have no dependency on functions discovery; a GH Action could run `npm run build:web` + `deploy:hosting` on push to main now, blocked only by BD-05's path ambiguity + a CI token.
- **Impact:** Low (opportunity) · **Effort:** Med (web CI now; functions CI after BD-04) · **Risk:** Med (auto-deploying functions could ship at-risk triggers unsmoke-tested) · **Surface:** process · **#34:** **YES** — functions CI would redeploy all five; do not enable until BD-04 verified in the CI environment.

### Recommended deploy runbook shape

Separate the **web (safe)** half from the **functions (risky / #22 / #34)** half; never block one on the other.

- **Web (safe — do first, automate next):** run preflight (upgrade the `sw.js` check `warn`→`fail` when unchanged) → bump `CACHE_VERSION` → `npm run build:web` → deploy hosting via **one** chosen path (resolve BD-05; recommend Firebase Hosting `deploy:hosting`, retire the Pages push) → `firestore:indexes` → `firestore:rules,storage`. Fast, discovery-free, CI-able today; can move to a GH Action on push to main.
- **Functions (risky — manual, gated):** do **not** rely on `firebase deploy --only functions` on the laptop (hangs). Either deploy from a clean machine / CI runner (~100s), or use gcloud-direct with `--source=./functions` (never repo root — BD-02), after `(cd functions && npm run build:emails && npm run build:bingo-canon)` and binding **every** function's secrets incl. submodule ones (BD-08). For any of the five #34 triggers — especially `moderateListingOnUpdate` — first close **BD-04**: redeploy, wait 10 min for Eventarc propagation, verify IAM invoker bindings + logs show invocations on a test write *before* trusting moderation. Smoke-test after, never before, the functions half is confirmed live.

---

## 5. Appendix — prior audit (2026-05-15), carried forward

The superseded `PERF_AUDIT.md` (low-hanging-fruit pass) applied one win, **confirmed present** at audit time, and filed a Phase-2 list. Status of each Phase-2 item against this audit:

| Prior Phase-2 item | Status here |
|---|---|
| Preconnect critical Firebase origins + dns-prefetch (APPLIED) | ✅ Confirmed live `index.html:272-285` |
| Extract inline `<style>` to external cacheable CSS | Subsumed by **FE-01** (the whole monolith, not just CSS) |
| Lazy-load `chart.umd.min.js` | Re-raised as **FE-08** with over-fetch quantified |
| Code-split the seller-dashboard chunk | Subsumed by **FE-02** (code-splitting/minify) |
| Replace inline `<svg>` icon set with a sprite sheet (~10 KB, 2 hrs) | **Still open — not re-investigated this pass.** Small standalone win; carry forward. |
| Stop bundling `bingo-*.js` utils on non-bingo pages (2 hrs) | **Still open — not re-investigated this pass.** Carry forward. |

---

## 6. What was NOT audited (scope boundary)

- No Lighthouse/WebPageTest run — code-level causes only (founder runs DevTools and feeds numbers; map them to FE-01…FE-09).
- No live Firestore console read-count capture — NET cost figures are derived math to sanity-check *against* the console.
- Android/iOS Capacitor native shell performance (cold start, bridge overhead) not covered.
- Bundle analysis of `functions/node_modules` depth (only the require-walk surface relevant to #22 was assessed).
- The two carried-forward prior items (SVG sprite, bingo-utils split) — not re-investigated.
- No load/stress testing; no CDN/edge analysis beyond the SW.
