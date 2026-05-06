# TeeBox Scaling & Performance Audit

_Date: 2026-05-04 · Branch: `worktree-agent-a0cefb20b9ff563b4` (off `main` @ `96d5fec`)_

This document captures the findings of a scaling/performance hardening pass
done before TeeBox was anticipated to handle a viral-share / influencer-post
traffic spike. It enumerates every change shipped in this branch, the
remaining recommendations, and a 100×-traffic run-book.

---

## TL;DR — What ships in this branch

1. **`firestore.indexes.json`** — created from scratch. 19 composite indexes
   covering every multi-field query in `index.html` and `functions/index.js`,
   plus a `watchlist` collection-group index.
2. **Cloud Function sizing** — every onCall / onRequest / Firestore trigger
   now declares `memory`, `timeoutSeconds`, `concurrency`, `maxInstances`.
   `createPaymentIntent` gets `minInstances: 1` to eliminate cold-start
   drop-off on the revenue path.
3. **Hot-path query caps** — every unbounded `getDocs(...)` on the user's
   first-load path now has a `limit()`. The marketplace fetch is capped at
   200 listings (was unbounded), the seller dashboard at 500 listings + 500
   orders (was unbounded), the inbox/badge at 50 conversations, the chat at
   the last 200 messages, etc.
4. **`firebase.json`** wires in `firestore.indexes.json` and tightens the
   asset cache headers — images/fonts get `immutable` + 1y cache.
5. **`sw.js` CACHE_VERSION** bumped `r64 → r65` so the new HTML/JS lands.

---

## 1. Firestore composite indexes

Audit of every multi-field query in the codebase:

| Collection | Filter(s) | Order | Source |
| --- | --- | --- | --- |
| `bids` | `listingId ==` + `buyerId ==` | `createdAt desc` | `index.html:5994` |
| `bids` | `listingId ==` + `sellerId ==` | `createdAt desc` | `index.html:6001` |
| `conversations` | `listingId ==` + `participants array-contains` | — | `index.html:6085, 8629` |
| `conversations` | `participants array-contains` | `lastMessageAt desc` | `index.html:6288, 6553` |
| `offers` | `sellerId ==` + `status ==` | `createdAt desc` | `index.html:6473, 8479` |
| `offers` | `sellerId ==` | `createdAt desc` | `index.html:8479 (fallback)` |
| `offers` | `buyerId ==` | `createdAt desc` | `index.html:8735` |
| `offers` | `status ==` + `expiresAt <` | — | `functions/index.js: expireOldOffers` |
| `orders` | `buyerId ==` | `createdAt desc` | `index.html:8090` |
| `orders` | `sellerId ==` | `createdAt desc` | added (defensive) |
| `orders` | `sellerId ==` + `fulfillmentStatus ==` | `deliveredAt desc` | `index.html:9625` |
| `reviews` | `revieweeId ==` | `createdAt desc` | `index.html:9570` |
| `reviews` | `sellerId ==` | `createdAt desc` | `index.html:9580` |
| `savedSearches` | `userId ==` | `createdAt desc` | `index.html:8936` |
| `listings` | `sellerId ==` | `createdAt desc` | `loadShopData` |
| `listings` | `sellerId ==` + `status ==` | `createdAt desc` | added (defensive) |
| `listings` | `status ==` | `createdAt desc` | added (defensive) |
| `listings` | `status ==` + `expiresAt <` | — | `functions/index.js: expireListings` |
| `listings` | `brand ==` | `createdAt desc` | `index.html:7670` |
| `gameScores` | `date in` | `correctCount desc` | `index.html:11986` |
| `watchlist` (collection-group) | `listingId ==` | — | `functions/index.js: notifyOnWatchlistPriceDrop` |

All of these are now declared in
[`firestore.indexes.json`](./firestore.indexes.json) and wired into
[`firebase.json`](./firebase.json).

**Deploy:**
```sh
firebase deploy --only firestore:indexes
```

**Risk if not deployed:** queries with the missing composite index throw
`failed-precondition` and the UI silently falls back to the unfiltered
client-side path (e.g. `loadSellerOffers`'s `_idxErr` catch), reading
hundreds of unnecessary docs per call.

---

## 2. Cloud Functions sizing

Adopted four shared sizing presets in `functions/index.js`:

| Preset | Use case | Memory | Timeout | Concurrency | Max |
| --- | --- | --- | --- | --- | --- |
| `USER_CALLABLE` | Generic onCall by signed-in user | 256 MiB | 30 s | 80 | 100 |
| `LIGHT_TRIGGER` | Firestore trigger doing tiny doc updates | 256 MiB | 60 s | 80 | 100 |
| `EMAIL_TRIGGER` | Firestore trigger that calls Resend / Stripe | 256 MiB | 60 s | 40 | 50 |
| `SCHEDULED_BATCH` | onSchedule sweep over hundreds of docs | 512 MiB | 300 s | — | — |

Per-function overrides:

- **`createPaymentIntent`** — `memory: 512MiB, timeoutSeconds: 30,
  concurrency: 80, minInstances: 1, maxInstances: 50`. The
  `minInstances: 1` keeps one warm instance so checkout never hits the
  ~3-5s Node.js cold-start tax under load.
- **`stripeWebhook`** — `memory: 512MiB, timeoutSeconds: 30,
  concurrency: 200, maxInstances: 50`. Stripe retries on non-2xx, so we
  need to absorb bursts without the next webhook waiting on a fresh
  cold-start.
- **`incrementListingView`** — `concurrency: 200, timeoutSeconds: 15`.
  This fires on every product detail open; we want one instance soaking
  up the bursts instead of fanning out to many cold containers.
- **`generateListingDescription`** — left at the existing `geminiSecret +
  cors` config; the function itself enforces a 30/day per-user rate
  limit.
- **`optimizeListingPhoto`** — already declares `memory: 1GiB` for sharp.
  Confirmed cache-control of `public, max-age=31536000` is set on the
  uploaded WebP. No change.

**Skipped intentionally** (in-flight work, per audit constraints):

- `exchangeIdTokenForCustomToken` — sign-in/auth code is in flight.
- `createIdentitySession`, `createStripeOnboardingLink`,
  `createSubscriptionCheckout`, `createBillingPortalSession`,
  `refundOrder` — Stripe code is in flight; only added sizing where
  asked (the two webhooks/payment-intent that are user-facing).

---

## 3. Hot-path optimizations (`index.html`)

Every Firestore read on the user's first-paint path is now bounded.

| Function | Before | After | Why |
| --- | --- | --- | --- |
| `loadListings` | unbounded `orderBy('createdAt')` | `limit(200)` | Marketplace grid never shows more than ~50 cards. Scales O(N) reads/page-load to O(1). |
| `loadShopData` | unbounded by sellerId | `orderBy(createdAt) + limit(500)` listings + orders | Power sellers with thousands of listings would otherwise stall the dashboard. |
| `loadProfileListings` | unbounded by sellerId | `limit(200)` | Public profile only renders 24+12 cards above the fold. |
| `loadBuyerOrders` | unbounded by buyerId | `limit(100)` | Order history pagination is a follow-up. |
| `refreshUnreadBadge` | all conversations array-contains user | `limit(50) + orderBy(lastMessageAt)` | Badge runs every 60s; we only need the recent window. |
| `loadInbox` | unbounded conversations | `limit(100)` | UI shows max ~30 rows; cap protects against long-lived chatters. |
| `loadMessages` (snapshot) | unbounded conv messages | `limitToLast(200)` | Real-time payload would otherwise bloat for old threads. |
| `fetchNotifOrders` / `fetchNotifUnreadMessages` | unbounded | `orderBy + limit(50)` | We only render top-8; cap kills the rest. |
| `maybePromptReview` | every order this user has touched | `limit(30)` per role | Old orders are out of the realistic review window. |
| `updateLiveStats` (priceHistory) | full collection scan | `limit(500)` + comment to denormalize later | Public homepage hit; was O(N) reads per visit. |

### Image delivery (verified, no change needed)

- `optimizeListingPhoto` transcodes to WebP and writes
  `cacheControl: "public, max-age=31536000"` — confirmed.
- The marketplace grid uses `loading="lazy"` on photos — confirmed.
- WebP @ q82 + 1600×1600 cap is correct for the Insta-style grid.

### Image hosting cache-control

Tightened in `firebase.json`:

- `**/*.@(woff2|png|jpg|jpeg|gif|webp|ico)` →
  `public, max-age=31536000, s-maxage=31536000, immutable`.
- `**/*.@(js|css|svg)` left at 30d (no cache-busting hash).
- HTML still 5min/10min stale to support the deploy-and-go workflow.
- `sw.js` still `max-age=0` so the service-worker update is immediate.

---

## 4. Service worker (`sw.js`)

Verified strategy is correct for spike traffic:

- HTML navigation → **network-first**, fall back to cache + offline page.
  Critical so a deploy isn't pinned by stale caches.
- Other same-origin GETs → **stale-while-revalidate**.
- Firestore / Stripe / Auth hosts → **bypassed** (network-only). No SW
  interference with auth state or payment flows.
- Cross-origin images → **bypassed** (let the browser HTTP cache do it).

Bumped `CACHE_VERSION` from `teebox-v1-2026-05-04-r64` to
`teebox-v1-2026-05-04-r65` so today's `index.html` lands on every PWA.

---

## 5. Rate limiting

| Endpoint | Status |
| --- | --- |
| `generateListingDescription` | 30/user/day, enforced in transaction. Good. |
| `createPaymentIntent` | Idempotency key on Stripe side; no per-user RL. **Recommendation:** add a simple Firestore counter (`users/{uid}/rateLimits/createPaymentIntent`) capped at e.g. 60/min. ~30min effort. |
| `incrementListingView` | One marker doc per (listing, user) per 24h — implicit RL. |
| `requestSellerVerification` | Idempotent (sets `sellerVerified: true`). |
| Auth | Firebase Auth rate-limits IP-level. |

---

## 6. Bundle size + load performance

`index.html` is ~660 KB. Inline-everything is fine for HTTP/2 single
round-trip but blocks first paint until the whole document is parsed.

**Recommendations** (effort estimates included):

- **Defer non-critical scripts** (Plausible already deferred). The
  `<script type="module">` Firebase block could be moved below
  initial paint or lazily imported on first interaction. Effort: ~2h.
- **Inline only critical CSS** (above-the-fold), defer the rest. Effort:
  ~3-4h. Material gain on Largest Contentful Paint.
- **Preload hero font + first hero image**:
  `<link rel="preload" as="font" ... crossorigin>` and an `as="image"`
  for the hero. Effort: ~30min.

These were not shipped in this pass to keep the diff focused on
scaling — they're CWV/Lighthouse follow-ups.

---

## 7. Run-book — "traffic spiked 100×, do these 3 things"

In rough priority order:

1. **Set `minInstances` everywhere user-facing.** Edit
   `functions/index.js`, set `minInstances: 2` on:
   `createPaymentIntent`, `stripeWebhook`, `getStripeAccountStatus`,
   `incrementListingView`, `generateListingDescription`. Redeploy with
   `firebase deploy --only functions`. Expected effect: cold-start tax
   eliminated for the entire revenue path. _Cost: ~$10/day per warm
   instance per function._ Roll back to 0 when the spike subsides.

2. **Verify all indexes are deployed.** Run
   `firebase deploy --only firestore:indexes` and watch the Firebase
   console "Indexes" tab — every index in `firestore.indexes.json` must
   show "Enabled". An "in-progress" or "missing" index is the most
   likely cause of `failed-precondition` errors during a spike (Firestore
   silently throttles index builds on the free tier — push to Blaze if
   you haven't).

3. **Check for hot Firestore docs.** Open the Firebase console →
   Firestore → "Usage" tab. If a single document is taking >50% of
   writes, that's contention. Most likely culprits:
   - `globalStats/...` (if we ever introduce one — see priceHistory
     comment in `index.html:9221`).
   - A trending listing's `views` counter — `incrementListingView`
     uses `FieldValue.increment(1)` which Firestore caps at ~1
     write/sec/document. **Mitigation:** shard the counter (`views`
     across `views_0..views_9`) and sum at read.
   - A specific seller's `profiles/{uid}` document if `onReviewCreated`
     fires too quickly — this rebuilds the aggregate every review;
     consider replacing the recompute with `FieldValue.increment` on
     `reviewCount + ratingSum` and dividing at read.

### Less-urgent, but useful during a spike

- **Disable saved-search match notifications** by toggling a feature
  flag on `notifyOnSavedSearchMatch` if writes to `notifications` are
  swamping Firestore. The cap is already at 200 saved searches per
  listing create.
- **Disable `notifyOnWatchlistPriceDrop`** scheduled run — every 4
  hours but if listings flap, it can fan out heavily. Pause it from
  Cloud Scheduler.
- **Push warmer keep-alive**: hit each onCall once every 4 minutes
  from a free monitoring service (UptimeRobot, etc.) so they don't
  go cold during off-peak. Frees us from `minInstances` cost.

---

## 8. Outstanding scalability work (recommended, NOT shipped)

1. **Cursor-paginated marketplace** (effort: ~1d). At ~10k active
   listings the 200-cap fetch becomes "first 200 newest" — fine for
   homepage, but search/filter views will show stale data. Move to
   `startAfter(lastDoc)` cursor pagination on scroll-to-end.

2. **Sharded view counter** (effort: ~3h). `incrementListingView`
   currently writes directly to `listings/{id}.views`. Hot listing →
   1 write/sec ceiling. Shard:
   ```js
   const shard = Math.floor(Math.random() * 10);
   listingRef.update({[`views_${shard}`]: FieldValue.increment(1)});
   ```
   On read, sum `views_0..views_9`.

3. **Denormalized `globalStats` doc** (effort: ~2h). Replace
   `updateLiveStats` priceHistory scan with a single doc bumped by the
   order-success handler. Reads-per-homepage drops from 500 → 1.

4. **Per-user rate-limiting on `createPaymentIntent`** (effort: ~30min).
   Cheap insurance against an attacker spinning up payment intents to
   abuse Stripe rate limits.

5. **Firestore App Check enforcement** (effort: in-progress per task
   #137). Task currently pending verification of token flow. App Check
   is the single biggest defence against scrapers / bots once we scale.

6. **CDN for Firebase Storage** (effort: ~1h, configuration only).
   Front Storage with Cloud CDN. Optimized images already have a 1-year
   cache header so this is mostly turning on the toggle.

7. **Inline critical CSS, defer the rest** (effort: ~4h). Major LCP win
   for first-time visitors who aren't yet PWA-cached.

---

## Files modified in this branch

| File | Change |
| --- | --- |
| `firestore.indexes.json` | **NEW** — 19 composite + 1 collection-group + field overrides |
| `firebase.json` | Wired in indexes; tightened asset cache headers |
| `functions/index.js` | Sizing presets + per-function `memory`/`timeout`/`concurrency`/`minInstances`; capped two Firestore scans (deleteUserAccount, onReviewCreated) |
| `index.html` | Added `limit()` to 10 read paths; added `limit, where` to static Firestore import; added scaling comment on `priceHistory` |
| `sw.js` | `CACHE_VERSION` bumped r64 → r65 |
| `SCALING_AUDIT.md` | **NEW** — this document |

---

## Quick reference — deploying this branch

```sh
# Indexes (5-10min build):
firebase deploy --only firestore:indexes

# Functions (the sizing changes are no-op until redeploy):
firebase deploy --only functions

# Hosting (HTML/CSS/JS):
firebase deploy --only hosting
```

If only one of these can be deployed during the spike, **deploy
`firestore:indexes` first** — missing indexes are the only failure mode
that causes hard errors instead of just slow reads.
