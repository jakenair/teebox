# index.html Performance Audit (Pre-Launch, V1)

**Scope**: low-hanging-fruit only. Full code-split is 1-2 days and out
of scope. Goal here is 200-500ms improvement to TTI by toggling cheap
attributes, not a refactor.

**File size**: 932 KB / 17,350 lines as of this commit.

## What was applied (1-line wins)

### 1. Preconnect to critical-path Firebase origins (applied)

The SPA's first network calls after parsing are to Firestore (listings
query) and Firebase Storage (photo URLs). Without preconnect, the
browser waits for the script-module evaluation before opening the TLS
session. Added `rel="preconnect"` for:

- `firestore.googleapis.com`     — listings query, watchlist read, etc.
- `firebasestorage.googleapis.com` — listing photos.
- `identitytoolkit.googleapis.com` — Firebase Auth token refresh.

And `rel="dns-prefetch"` for the secondary origins (Cloud Functions,
Stripe), which are not first-paint critical but cost a DNS lookup on
first user interaction:

- `us-central1-teebox-market.cloudfunctions.net`
- `api.stripe.com`, `js.stripe.com`
- `cdn.jsdelivr.net` (Chart.js)

**Expected impact**: 50-200ms shaved off first Firestore round-trip on
cold TCP/TLS, depending on network. Free win, zero behavior change.

## What was audited but NOT applied (with reasons)

### Chart.js lazy-load (skipped — behavior risk)

`chart.umd.min.js` (~190KB minified) is loaded `defer` in the body
(line ~4521 after my insertion). It's only used at two callsites:
`renderRevenueChart` (seller dashboard) and `loadSparkline` (listing
detail price-history chart). Both check `typeof Chart === 'undefined'`
and return early if missing.

**Why not applied**: lazy-loading would mean the seller dashboard
revenue chart and the listing-detail price sparkline render *blank* on
first open, then appear after the second click / a small delay. That
is a regression to UX even though it'd save ~190KB of parse cost. The
right fix is a code-split that lazy-loads chart.js *and* re-runs the
render callback on script-loaded — that's a 30-line change, not a
1-line win.

**Filed for Phase 2**: replace the static `<script defer src=".../chart.umd.min.js">`
with an on-demand loader that resolves a Promise when `Chart` is
defined, and call it from `renderRevenueChart` / `loadSparkline`.
Expected savings: ~120ms TTI on the homepage where chart.js never
gets used.

### Inline `<style>` extraction (skipped — too risky)

The `<style>` block spans lines 275-2704 — roughly 2400 lines of CSS,
the single biggest non-data contributor to the 932KB. Moving to an
external file would let the browser cache it across page loads and
parallelize the download.

**Why not applied**: GitHub Pages serves the site as a single
`index.html` with no separate CSS file in the deploy pipeline. Adding
one would require updates to `.gitignore`, `firebase.json` rewrites,
the SW cache list (`sw.js`), and Capacitor's iOS bundle (which
in-app-loads from the same file). High-risk for a launch window;
needs a real perf-focused PR.

**Filed for Phase 2**: extract `<style>` to `/styles.css`, add
`<link rel="preload" as="style">` in head, gate behind feature flag for
A/B comparison.

### Image lazy-loading audit (already done — confirmed)

14/18 `<img>` tags already use `loading="lazy"`. The 4 without it are
intentional: lightbox img, upload-preview img, capture-preview img,
and the brand logo (eager-loaded for FOLC). No changes needed.

### Inline JSON literals (none found at meaningful scale)

Searched for large `const X = { ... }` / `const X = [...]` blocks. Most
data sources are already in separate files (e.g. `bingo-courses.js`)
or are small string lists (e.g. `EXPLICIT_BLOCKLIST` at ~50 short
strings; not worth moving). No 50KB+ inline JSON blobs to extract.

### Script attributes (already optimized)

- `js.stripe.com/v3/` — already `defer` (line 4521).
- `chart.js` — already `defer` (line 4522).
- `plausible.io/js/script.js` — already `defer` (line 60).
- PostHog snippet — async stub loader that injects the real script
  asynchronously. Optimal already.
- All JSON-LD blocks are `type="application/ld+json"` (parser-ignored
  by definition; no script execution cost).

### Body script blocks (no easy reorder)

There are 3 large inline `<script>` blocks at lines 2744, 4089, and
4515 (~3000 lines total). They define globals (`window.safeText`,
`window.EXPLICIT_BLOCKLIST`, etc.) that are referenced by other inline
scripts and event handlers further down. Reordering or deferring them
would require careful dependency analysis — out of scope for a 1-line
win.

The `<script type="module">` at 5001 is the main app — module scripts
are deferred-by-default, so it's already optimal.

## Phase-2 recommendations (priority order)

1. **Extract `<style>` to a separate CSS file with `rel="preload"`.**
   Single biggest win (~50KB of inline CSS gzipped → external + cached).
   Risk: requires updating SW cache, Capacitor bundle, deploy pipeline.
   ETA: half-day.

2. **Lazy-load `chart.umd.min.js`.** Free ~120ms TTI when no chart is
   rendered (most page loads). Risk: render orchestration changes (two
   callsites). ETA: 1 hour.

3. **Code-split the seller-dashboard chunk** (`renderRevenueChart`,
   `wireRevenueRangeButtons`, related). Currently ~500 lines of dead
   weight for the 90% of users who never open Sell. ETA: 1 day.

4. **Replace the inline `<svg>` icon set with a sprite sheet.** Many
   inline SVGs duplicate the same path data. ETA: 2 hours, ~10KB win.

5. **Stop bundling `bingo-*.js` on non-bingo pages.** `bingo.html`
   already has its own copy of the canonical data — but `index.html`
   imports a few utility functions from `bingo-courses.js`. Audit and
   split. ETA: 2 hours.

## Verification

Before/after Lighthouse run is the right validation. Static-analysis
expectations after this PR:

- 6 new `<link>` tags in `<head>`.
- No CSS or JS behavior change.
- No new HTTP requests (preconnect/dns-prefetch are hints, not loads).
