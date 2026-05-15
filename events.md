# TeeBox Event Taxonomy

This is the source of truth for every product event in TeeBox. **New events MUST be documented here before being added to code.** Companion to `ANALYTICS_AUDIT.md` (current-state audit).

## Conventions

- **snake_case, verb-noun ordering, no domain prefix.** Use `signup`, `login`, `listing_published`, `order_placed` — never `auth.signup`, `userSignup`, or `listing-published`.
- **One event per fact.** A status flip in Firestore is not an event by itself; fire a discrete event row through the shared `track()` helper.
- **Server-truth events fire server-side; UI-attribution events fire client-side.** When both are useful (e.g. `order_placed`), fire the canonical event server-side from the Stripe webhook handler and a `checkout_completed` client-side event for funnel attribution.
- **Standard property bag is attached automatically by `track()`** — never duplicate those props in `customProps`.
- **Past-tense verbs only.** `signup` (not `signing_up`), `listing_published` (not `publish_listing`). Imperatives are reserved for intent/CTA names.
- **`[NOT YET INSTRUMENTED]`** = the event is canonical but has no code firing it today. Listed so the AI-analytics consumer knows what the schema _will_ contain.

## Implementation status — priority 11 (post `feat/posthog-instrumentation`)

The launch-priority eleven events are now live in code via PostHog (`posthog-js` on the client, `posthog-node` on the server). The names below match what fires in production — where the canonical-catalog name diverged from the launch brief's name, the launch-brief name won (see "Naming notes" at the bottom of this section).

| Event (as fired) | Side | Where it fires | Status |
|---|---|---|---|
| `signup` | client | `index.html` `submitEmail()` (email path) + `onAuthStateChanged` first-session detector (Google/Apple OAuth path) | `live` |
| `listing_created` (state: `'draft'`) | client | `index.html` `captureSellDraft()` — first non-empty autosave per session | `live` |
| `listing_created` (state: `'published'`) | client | `index.html` `submitListing()` after `addDoc(collection(db, 'listings'), ...)` resolves | `live` |
| `listing_viewed` | client | `index.html` `openDetailModal()` — fires per open, skips owner self-views, no 24h dedupe | `live` |
| `search_performed` | client | `index.html` `filterSearchRender()` — debounced (150ms), only for queries ≥3 chars | `live` |
| `message_sent` | client | `index.html` `sendMessage()` — only on `out.ok` (held messages do not count) | `live` |
| `offer_made` | client | `index.html` `submitOffer()` after `addDoc(collection(db, 'offers'), ...)` resolves | `live` |
| `checkout_started` | client | `index.html` `openCheckout()` — fires BEFORE Stripe Payment Element mount so the load-time abandonment cohort is captured | `live` |
| `purchase_completed` | server | `functions/index.js` `handlePaymentSucceeded()` — after the `alreadyProcessed` guard so webhook replays don't duplicate | `live` |
| `refund_issued` | server | `functions/index.js` `refundOrder` onCall — after `refunds/{stripeRefundId}.create()` idempotency gate | `live` |
| `dispute_opened` | server | `functions/index.js` `handleDisputeOpened()` — webhook handler for `charge.dispute.created`, after `disputes/{id}.create()` idempotency gate | `live` |
| `review_submitted` | client | `index.html` `submitReview()` after `setDoc(doc(db, 'reviews', ...))` resolves | `live` |

**Status legend:**

- `live` — capture call lands in production, attribution and dedupe verified by reading the code path.
- `pending` — code added but waiting on a runtime check (the PostHog dashboard hasn't yet shown the event arrive end-to-end). Use this state until you replace the placeholder API key and trigger the event manually.
- `blocked` — couldn't find a trigger location in this codebase.

**No event is currently `blocked` or `pending` in the launch-priority eleven.** All trigger locations existed in `index.html` / `functions/index.js`. Some collateral notes:

- `listing_created` fires for BOTH draft autosave AND publish, discriminated by the `state` prop (`'draft'` | `'published'`). The catalog below historically named the publish event `listing_published` — the launch brief's `listing_created` (with a state prop) is what's wired.
- `message_sent` fires from the client when the server callable confirms `out.ok`. The audit (`ANALYTICS_AUDIT.md` line 88) recommended mirroring server-side from `sendMessage` callable — that mirror is NOT wired in this pass because the client path is reliable enough for product analytics and the duplicate would inflate counts. Revisit if browser-close-mid-send becomes a real signal-loss source.
- `purchase_completed`, `refund_issued`, `dispute_opened` fire ONLY server-side. Tab-close-before-fire is impossible (Stripe is the source of truth), so no client mirror is needed.

**Naming notes — divergences from the canonical catalog below:**

- Brief: `listing_created` (state-discriminated) ↔ Catalog: `listing_created` + `listing_published`. The catalog's `listing_published` row is preserved for historical context — when the second-phase event taxonomy lands, fold it back into `listing_created` with `state: 'published'`.
- Brief: `offer_made` ↔ Catalog: `offer_created`. The brief's verb is preserved in code.
- Brief: `purchase_completed` ↔ Catalog: `order_placed`. The brief's verb is preserved in code.
- Brief: `review_submitted` ↔ Catalog: `review_created`. The brief's verb is preserved in code.

A follow-up housekeeping commit should reconcile by either:
1. Renaming the four diverged code-side events to the catalog names (`listing_published`, `offer_created`, `order_placed`, `review_created`), OR
2. Updating the catalog rows below to match the brief names.

Per the audit's "snake_case verb-first" convention either is valid — `_completed` vs `_created` is a semantic choice the founder should make before PostHog dashboards are wired.

## Standard properties

Attached to every event by `posthog.register()` (client) and `captureServerEvent()` (server). See `ANALYTICS_AUDIT.md` Part 3 for derivation sources.

Status legend: **WIRED** = attached automatically by the analytics layer as of `feat/posthog-instrumentation`. **PENDING** = property defined in this schema but no producer yet.

| Property | Type | Required? | Source | Status |
|---|---|---|---|---|
| `userId` | string \| null | yes (null pre-auth) | `posthog.identify(uid)` driven by `onAuthStateChanged` (client) / `request.auth.uid` (server) | WIRED |
| `clientTimestamp` | ISO 8601 UTC | yes | PostHog stamps it automatically on `posthog.capture()` | WIRED |
| `serverTimestamp` | ISO 8601 UTC | yes | `captureServerEvent` auto-attaches `new Date().toISOString()`; callers may override with a deterministic value (e.g. Stripe `event.created`) for replay idempotency | WIRED |
| `sessionId` | UUID v4 | yes | `sessionStorage.teebox.sid`, generated via `crypto.randomUUID()` in the PostHog init block at top of `index.html`; rotates on tab close (iOS WKWebView discards on cold-launch) | WIRED |
| `deviceType` | `'ios'` \| `'android'` \| `'web'` \| `'server'` | yes | `Capacitor.getPlatform()` on the client; literal `'server'` on the server | WIRED |
| `appVersion` | semver string | yes | Web: `window.APP_VERSION` constant in `index.html` (currently `'1.0.0'` — bump this when shipping a release). iOS: shares the same web-bundle constant — `@capacitor/app`'s `App.getInfo().version` is available but not currently consulted (web constant takes priority so cross-platform parity is guaranteed). | WIRED |
| `source` | string \| null | optional | `?utm_source` on first landing, persisted to `localStorage.teebox.attribution.utm_source` (first-touch attribution survives multi-day delays before signup) | WIRED |
| `medium` | string \| null | optional | `?utm_medium` — same first-touch localStorage persistence | WIRED |
| `campaign` | string \| null | optional | `?utm_campaign` | PENDING — schema reserved, not yet auto-captured |
| `referrer` | string \| null | optional | `document.referrer` (web) / deep-link source (iOS) | PENDING |

---

## Event catalog

### Auth domain
_Owner: account-onboarding / identity_

- `signup` `[NOT YET INSTRUMENTED]` — **Fires when** a Firebase Auth user record is successfully created (email/password OR OAuth). Fires from client on the `createUserWithEmailAndPassword` / `signInWithPopup` success path. **Custom props:** `method` (`'email'` \| `'google'` \| `'apple'`), `marketingConsentGranted` (bool).
- `login` `[NOT YET INSTRUMENTED]` — **Fires when** an existing user successfully completes any sign-in flow. **Custom props:** `method`, `wasReauth` (bool — true if `signInWithCredential` after token-exchange).
- `login_failed` `[NOT YET INSTRUMENTED]` — **Fires when** any sign-in attempt throws. **Custom props:** `method`, `errorCode` (`'auth/wrong-password'`, `'auth/user-disabled'`, etc.). _Note: do NOT include the attempted email — preserves the anti-enumeration UX._
- `logout` `[NOT YET INSTRUMENTED]` — **Fires when** the user confirms sign-out (after `confirm()` prompt at `index.html:5487`). Fires before the auth state is cleared. **Custom props:** `sessionDurationMs` (computed from `sessionId` creation time).
- `password_reset_requested` — **Fires when** `sendBrandedPasswordReset` callable succeeds. Currently logged via `emailSends/` row only; needs unified-stream parity. **Custom props:** `email` (hashed for PII).
- `email_verification_sent` — **Fires when** `sendBrandedVerification` callable succeeds. Currently logged via `emailSends/` row only. **Custom props:** none beyond standard.
- `email_verified` `[NOT YET INSTRUMENTED]` — **Fires when** Firebase Auth flips `emailVerified` true. Hardest to instrument — requires polling/listening to `onIdTokenChanged` and comparing before/after states. **Custom props:** `secondsSinceSignup`.
- `account_deleted` — **Fires when** the `deleteUserAccount` callable completes. Server-side. **Custom props:** `reason` (if collected), `listingsDeleted`, `ordersAffected`.

_Out of scope today:_ `mfa_enrolled` / `mfa_disabled` / `2fa_enabled` `[NOT YET IMPLEMENTED]` — TeeBox has no 2FA/MFA feature in v1. The `TwoFactorCode.jsx` template and `sendTwoFactorCode` producer exist in `functions/securityEmailTriggers.js` but no client wire-up calls them, so no event ever fires. Revisit when a Settings → Security → 2FA toggle ships.

### Listing lifecycle domain
_Owner: marketplace / supply_

- `listing_created` `[NOT YET INSTRUMENTED]` — **Fires when** the seller first interacts with the Sell modal AND the autosaved draft is persisted to `localStorage`. Distinct from `listing_published`. **Custom props:** `cat`, `isDraft: true`.
- `listing_published` — **Fires when** `addDoc(collection(db, 'listings'), {...})` resolves with `status: 'active'`. Mirror server-side in `onListingLive` trigger so we capture the canonical timestamp. **Custom props:** `listingId`, `cat`, `brand`, `condition`, `askCents`, `photoCount`, `isHighValue` (>$300), `quantity`.
- `listing_edited` `[NOT YET INSTRUMENTED]` — **Fires when** an `updateDoc` on a listing changes any of `{ask, bid, desc, condition, photos, quantity}`. **Custom props:** `listingId`, `fieldsChanged: string[]`.
- `listing_renewed` `[NOT YET INSTRUMENTED]` — **Fires when** `renewListing()` at `index.html:10510` flips an expired listing back to `active`. **Custom props:** `listingId`, `daysSinceExpiry`.
- `listing_deleted` `[NOT YET INSTRUMENTED]` — **Fires when** `deleteDoc(doc(db, 'listings', id))` resolves. **Custom props:** `listingId`, `daysSinceCreated`, `hadActiveOffers` (bool), `wasFlagged` (bool).
- `listing_flagged` — **Fires when** `moderateListingOnCreate` writes to `flaggedListings/`. Server-side. **Custom props:** `listingId`, `sellerId`, `reason`, `severity`.
- `listing_taken_down` — **Fires when** `takeDownListing` admin callable completes. Server-side. **Custom props:** `listingId`, `adminUid`, `reason`.
- `listing_sold` — **Fires when** `listings/{id}.status` flips to `sold` (last unit purchased) in `handlePaymentSucceeded`. _De-duplicates with `order_placed`_: both fire, since a multi-quantity listing produces N `order_placed` events but only 1 `listing_sold`. **Custom props:** `listingId`, `finalSalePriceCents`, `daysOnMarket`.
- `listing_expired` — **Fires when** `expireListings` scheduled function flips a listing past its 60-day TTL. Server-side. **Custom props:** `listingId`, `viewCount`, `messageCount`.

### Discovery / engagement domain
_Owner: demand / discovery_

- `search_performed` `[NOT YET INSTRUMENTED]` — **Fires when** `filterSearch()` runs with a debounced query of ≥3 chars OR when filters change. Debounce 350 ms so we don't spam on every keystroke. **Custom props:** `query` (lowercased, 80-char cap matching saved-search storage at `index.html:10645`), `filters: { cat, sort, minCents, maxCents, conditions[] }`, `resultCount`, `isSavedSearch` (true if fired from a saved-search replay).
- `listing_viewed` — **Fires when** `openDetailModal` opens for a real Firestore listing AND the viewer is not the seller (mirrors the `incrementListingView` guard at `index.html:7542`). Keep the existing 24h dedupe for the _counter_ field, but fire the _event_ every open (analytics needs the raw stream). **Custom props:** `listingId`, `sellerId`, `cat`, `askCents`, `referrer` (intra-app: `'feed'` \| `'search'` \| `'saved-search'` \| `'profile'` \| `'deep-link'`).
- `listing_saved` `[NOT YET INSTRUMENTED]` — **Fires when** a user adds a listing to their watchlist (`users/{uid}.watchlist.{listingId}` set). **Custom props:** `listingId`, `askCents`.
- `listing_unsaved` `[NOT YET INSTRUMENTED]` — **Fires when** the same map entry is `deleteField()`-ed. **Custom props:** `listingId`, `secondsHeld`.
- `saved_search_created` `[NOT YET INSTRUMENTED]` — **Fires when** `saveCurrentSearch()` at `index.html:10629` resolves. **Custom props:** `query`, `filters`, `existingSavedSearchCount`.
- `saved_search_deleted` `[NOT YET INSTRUMENTED]` — **Fires when** a saved search is removed. **Custom props:** `searchId`, `daysHeld`, `totalMatchesNotified`.
- `saved_search_match_notified` — **Fires when** `notifyOnSavedSearchMatch` writes a notification doc. Server-side. **Custom props:** `searchId`, `listingId`, `matchedField` (`'title'`/`'cat'`/`'price'`).
- `saved_search_match_opened` `[NOT YET INSTRUMENTED]` — **Fires when** the user taps the push notification (carries `notificationId` per `functions/index.js:3489`) and the deep-link handler resolves. **Custom props:** `searchId`, `notificationId`, `secondsSinceSent`.
- `price_drop_notified` — **Fires when** `priceDropEvents/{id}` doc is created. Server-side. **Custom props:** `listingId`, `previousAskCents`, `currentAskCents`, `dropPct`.
- `profile_viewed` `[NOT YET INSTRUMENTED]` — **Fires when** `loadProfile` opens a seller's profile modal. **Custom props:** `viewedUserId`, `referrer` (intra-app source).

### Transaction domain
_Owner: payments / fulfillment_

- `checkout_started` `[NOT YET INSTRUMENTED]` — **Fires when** `openCheckout()` mounts the Stripe Payment Element. Fires from the client. **Custom props:** `listingId`, `sellerId`, `qty`, `unitPriceCents`, `totalCents`.
- `payment_intent_created` — **Fires when** the `createPaymentIntent` HTTP endpoint returns a client secret. Server-side. **Custom props:** `paymentIntentId`, `listingId`, `buyerId`, `sellerId`, `qty`, `unitPriceCents`, `platformFeeCents`, `sellerPayoutCents`.
- `payment_authorized` `[NOT YET INSTRUMENTED]` — **Fires when** Stripe Payment Element returns success client-side (before the webhook lands). Captures the "user thinks payment succeeded" timestamp for funnel skew analysis. **Custom props:** `paymentIntentId`.
- `order_placed` — **Fires when** `handlePaymentSucceeded` commits the `orders/{piId}` doc with `status: 'paid'`. Server-side. _Canonical event._ **Custom props:** `orderId` (= `paymentIntentId`), `listingId`, `buyerId`, `sellerId`, `amountCents`, `currency`, `qty`, `unitPriceCents`, `platformFeeCents`, `sellerPayoutCents`.
- `payment_failed` `[NOT YET INSTRUMENTED]` — **Fires when** `payment_intent.payment_failed` or `payment_intent.canceled` webhook lands. Server-side. **Custom props:** `paymentIntentId`, `listingId`, `buyerId`, `lastPaymentError.code`, `declineCode`.
- `checkout_abandoned` `[NOT YET INSTRUMENTED]` — **Fires when** `checkout_started` is recorded but no `order_placed` or `payment_failed` follows within 30 minutes for the same `sessionId`. Computed server-side by a scheduled function, not at the call site. **Custom props:** `listingId`, `minutesSinceStart`, `lastStep` (`'mounted'` \| `'address-entered'` \| `'submitted'`).
- `order_shipped` — **Fires when** `confirmShip` at `index.html:10918` writes `fulfillmentStatus: 'shipped'`. Client-side _and_ verify server-side via `onOrderShippingStatusEmail` trigger. **Custom props:** `orderId`, `carrier`, `trackingNumber` (last-4 only, PII), `hoursFromOrderPlaced`.
- `order_delivered` — **Fires when** `confirmDelivery` at `index.html:10978` writes `fulfillmentStatus: 'delivered'`. **Custom props:** `orderId`, `hoursFromOrderShipped`, `confirmedBy: 'buyer'` (until carrier-webhook integration, this is always buyer-confirmed).
- `refund_requested` `[NOT YET INSTRUMENTED]` — **Fires when** the buyer submits a dispute via `submitDispute()` at `index.html:11005`. **Custom props:** `orderId`, `reason`, `daysSinceDelivery`.
- `refund_issued` — **Fires when** `refundOrder` callable creates a Stripe refund. Server-side. **Custom props:** `orderId`, `refundAmountCents`, `initiatedBy: 'seller'` \| `'admin'` \| `'dispute'`.
- `dispute_opened` — **Fires when** `charge.dispute.created` webhook lands. Server-side. **Custom props:** `orderId`, `disputeId`, `reason`, `amountCents`, `evidenceDueBy`.
- `dispute_resolved` — **Fires when** `charge.dispute.funds_withdrawn` or `funds_reinstated` lands. **Custom props:** `orderId`, `outcome` (`'won'` \| `'lost'`).

### Messaging domain
_Owner: trust / messaging_

- `conversation_started` `[NOT YET INSTRUMENTED]` — **Fires when** a new `conversations/{cid}` doc is created (first message between two users on a listing). **Custom props:** `conversationId`, `listingId`, `sellerId`, `buyerId`.
- `message_sent` `[NOT YET INSTRUMENTED]` — **Fires when** `sendMessage` callable succeeds. **Custom props:** `conversationId`, `listingId`, `messageLength`, `containsLink` (bool), `senderRole` (`'buyer'` \| `'seller'`).
- `message_flagged` — **Fires when** `moderateMessage` writes a `messageFlags/{id}` doc. Server-side. **Custom props:** `conversationId`, `messageId`, `severity`, `types` (`['phone_us','email',…]`).
- `conversation_reported` `[NOT YET INSTRUMENTED]` — **Fires when** `reportConversation()` at `index.html:11109` writes a `reports/` doc. **Custom props:** `conversationId`, `reason`.

### Offers / reviews domain
_Owner: marketplace_

- `offer_created` `[NOT YET INSTRUMENTED]` — **Fires when** `addDoc(offers, …)` resolves. **Custom props:** `offerId`, `listingId`, `askCents`, `offerCents`, `discountPct`.
- `offer_accepted` `[NOT YET INSTRUMENTED]` — **Fires when** an offer's `status` flips to `'accepted'`. **Custom props:** `offerId`, `secondsToDecide`.
- `offer_declined` `[NOT YET INSTRUMENTED]` — same as above with `'declined'`. **Custom props:** `offerId`, `secondsToDecide`.
- `offer_countered` `[NOT YET INSTRUMENTED]` — fires when seller posts a counter. **Custom props:** `offerId`, `originalOfferCents`, `counterCents`.
- `review_created` — **Fires when** `reviews/{id}` doc is committed. Server-side via `onReviewCreated` trigger. **Custom props:** `reviewId`, `orderId`, `revieweeId`, `rating` (1–5), `hasText` (bool).
- `report_created` `[NOT YET INSTRUMENTED]` — generic abuse-report fired by `addDoc(reports, …)`. **Custom props:** `targetType` (`'listing'`/`'user'`/`'conversation'`), `targetId`, `reason`.

### Monetization domain
_Owner: revenue / growth_

- `pro_checkout_started` `[NOT YET INSTRUMENTED]` — **Fires when** `createSubscriptionCheckout` callable returns a session URL and the client is about to redirect. **Custom props:** `priceId`, `currentTier` (`'free'`).
- `pro_subscription_started` — **Fires when** `customer.subscription.created` webhook flips `users/{uid}.tier` to `pro` AND status is `active`. Server-side via the existing `proWelcomeEmail` trigger location. **Custom props:** `subscriptionId`, `priceId`, `currentPeriodEnd`, `attribution.source` (from session at checkout-start).
- `pro_renewed` — **Fires when** `customer.subscription.updated` extends `proCurrentPeriodEnd` with no tier change. **Custom props:** `subscriptionId`, `previousPeriodEnd`, `newPeriodEnd`, `amountCents`.
- `pro_payment_failed` — **Fires when** `invoice.payment_failed` webhook lands. **Custom props:** `subscriptionId`, `invoiceId`, `attemptCount`, `nextRetryAt`.
- `pro_canceled` — **Fires when** `customer.subscription.deleted` webhook lands. **Custom props:** `subscriptionId`, `daysActive`, `endedReason` (`'voluntary'` \| `'payment_failure'` \| `'admin'`).
- `pro_downgraded` — **Fires when** `proDowngradedEmail` trigger detects a tier flip from `pro` → `free`. **Custom props:** `subscriptionId`, `daysAsPro`.
- `referral_code_generated` — **Fires when** `generateReferralCode` callable returns a fresh code. **Custom props:** `code`.
- `referral_redeemed` — **Fires when** `redeemReferralCredit` flips the referred user's credit field. **Custom props:** `referrerUid`, `referredUid`, `creditCents`.
- `marketing_consent_changed` — **Fires when** `updateMarketingConsent` callable persists a new state. **Custom props:** `granted` (bool), `source` (`'signup'`/`'banner'`/`'settings'`), `previousState` (bool).

### Bingo domain (mini-game)
_Owner: engagement / retention_

- `bingo_board_loaded` `[NOT YET INSTRUMENTED]` — fires when the user opens `bingo.html`. **Custom props:** `boardSeed`, `currentStreakDays`.
- `bingo_tile_marked` `[NOT YET INSTRUMENTED]` — fires when a course tile is checked off. **Custom props:** `courseId`, `tileIndex`, `boardCompletedPct`.
- `bingo_win` — **Fires when** `gameScores/{id}` row is created by `onBingoWinAggregate`. Server-side. **Custom props:** `score`, `country`, `boardSeed`.
- `bingo_streak_extended` `[NOT YET INSTRUMENTED]` — fires when daily check-in extends the streak. **Custom props:** `streakDays`.

### System / errors domain
_Owner: platform / reliability_

- `stripe_webhook_received` — fires after signature verify but before handler dispatch. Server-side. **Custom props:** `eventId`, `type`, `livemode`.
- `stripe_webhook_failure` `[NOT YET INSTRUMENTED]` — fires when a handler throws AND the marker doc is NOT written. **Custom props:** `eventId`, `type`, `errorCode`, `willRetry` (based on 500 vs 200 response).
- `email_sent` — fires from `recordSend()` in `functions/lib/email.js`. Server-side. **Custom props:** `to` (hashed), `category`, `template`, `resendId`.
- `email_delivered` / `email_opened` / `email_clicked` — fired by `resendWebhook` Resend webhook handler. Server-side. Currently overwrite `emailSends/{id}.status`; should also fire as discrete events. **Custom props:** `resendId`, `template`, `clickedUrl` (for clicked).
- `email_bounced` — fires when `email.bounced` lands. **Custom props:** `resendId`, `bounceType` (`'hard'` \| `'soft'`), `email` (hashed), `wasSuppressed` (bool).
- `email_complained` — fires when `email.complained` lands. **Custom props:** `resendId`, `email` (hashed).
- `email_send_failure` — fires when `sendEmail` catches a Resend error and `recordSend({status: 'failed'})` runs. **Custom props:** `category`, `template`, `error`.
- `push_sent` `[NOT YET INSTRUMENTED]` — fires per successful `sendEachForMulticast` response. **Custom props:** `notificationId`, `kind`, `tokenCount`, `successCount`, `failureCount`.
- `push_send_failure` `[NOT YET INSTRUMENTED]` — fires when `pushNotificationDispatch` catches. **Custom props:** `notificationId`, `kind`, `errorCode`.
- `app_crash_web` `[NOT YET INSTRUMENTED]` — fires from `window.onerror` and `window.onunhandledrejection`. **Custom props:** `errorMessage`, `errorStack` (truncated 4kb), `url`, `lineno`, `colno`. **Recommended:** also forward to Sentry once installed.
- `app_crash_ios` `[NOT YET INSTRUMENTED]` — requires Crashlytics or Sentry-Cocoa. Not derivable from current iOS bundle (`ios/App/Podfile` has no crash SDK).
- `app_session_start` `[NOT YET INSTRUMENTED]` — fires on `DOMContentLoaded` (or `App.addListener('appStateChange', state => state.isActive)` on iOS). **Custom props:** `sessionId`, `daysSinceLastSession`.

---

## Adding a new event

1. Append it to the catalog above with the trigger description + required custom props + `[NOT YET INSTRUMENTED]` if applicable.
2. Reference the new name in code only via the shared enum in `functions/lib/eventNames.js` (server) or `assets/eventNames.js` (client). No string-literal event names anywhere in product code.
3. PR title must include "(adds event: `event_name`)".
4. If the event has revenue impact (`order_*`, `pro_*`, `refund_*`), the PR must also update `BINGO_CACHING_AUDIT.md` style sales-dashboard queries that consume it.

---

## Operational

### Where the PostHog public key lives

The public (front-end) PostHog project key is a constant in `index.html`, declared in the analytics init block right after the `<script defer ... plausible.io ...>` tag:

```js
var PUBLIC_POSTHOG_KEY = 'phc_PLACEHOLDER_REPLACE_WITH_POSTHOG_PROJECT_KEY';
```

This is the ingest-only key — it cannot read events back, so hardcoding it in the public bundle is safe (the same pattern PostHog's docs use). To wire a real PostHog Cloud project:

1. Create a project at <https://us.posthog.com>.
2. Copy the **Project API Key** from Project Settings → Project API Key (starts with `phc_`).
3. Replace the placeholder in `index.html` and commit.
4. Re-run `npm run build:web` (the web build does a literal copy — no build-time substitution today).

The `APP_VERSION` constant (same init block, currently `'1.0.0'`) should be bumped whenever you ship a release so PostHog can segment events by release. Both constants live together so a release-bump PR touches one block.

### Where to set the server `POSTHOG_API_KEY` secret

The server uses a separate, **private** PostHog API key (project-scope, ingest-only is fine — we don't read events from server code) stored as a Firebase Functions secret:

```bash
firebase functions:secrets:set POSTHOG_API_KEY
# Paste the key from PostHog → Project Settings → Project API Key when prompted.
# (You CAN use the same phc_… key as the client; PostHog accepts the same
# key from both posthog-js and posthog-node. Using a distinct key is also
# fine if you want per-source rate-limit separation in PostHog billing.)
```

The secret is consumed via `defineSecret("POSTHOG_API_KEY")` in `functions/lib/analytics.js`. Each function that calls `captureServerEvent` must include `posthogSecret` in its `secrets:` array — currently:

- `exports.stripeWebhook` — for `purchase_completed` + `dispute_opened`.
- `exports.refundOrder` — for `refund_issued`.

Add new functions to that list as new server-side events come online.

If the secret is not set when a function runs, `captureServerEvent` logs a one-time warning via `logger.warn` and silently drops the call. **Analytics never crashes a production function.**

### How to test end-to-end

Web (client events):

1. Open `https://teeboxmarket.com` (or your local dev URL) in a fresh tab.
2. Open browser DevTools → **Network** tab, filter on `posthog`.
3. Trigger an event — e.g., type 3+ characters into the search bar (`search_performed`), or open any listing card (`listing_viewed`).
4. You should see a `POST` to `https://us.i.posthog.com/e/?ip=…&_=…` carrying the event payload. Click it → Payload tab → confirm the `event` name and `properties` (including `sessionId`, `deviceType: "web"`, `appVersion: "1.0.0"`).
5. In the PostHog dashboard → **Activity** → the event should appear within ~30 seconds.

If you see no network call:

- Confirm `PUBLIC_POSTHOG_KEY` is set (not the `phc_PLACEHOLDER...` default). Open the JS console — a placeholder key logs an info-level hint.
- Check the CSP `connect-src`: it must include `https://us.i.posthog.com` and `https://us-assets.i.posthog.com`. The `script-src` must include `https://us-assets.i.posthog.com` (the snippet loader fetches `array.js` from there).

Server (Cloud Functions events):

1. From your dev environment with `firebase emulators:start --only functions`, OR after deploying to a sandbox project:
2. Trigger a Stripe test webhook (`stripe trigger payment_intent.succeeded`) to fire `purchase_completed`.
3. Call `refundOrder` from a test client (or use the seller dashboard's refund button) to fire `refund_issued`.
4. Watch Cloud Functions logs: `firebase functions:log --only stripeWebhook` should NOT contain any `[analytics]` warnings if the secret is bound correctly.
5. Confirm in PostHog → Activity that the event arrived with `deviceType: "server"` and `source: "cloud-function"`.

### Identity model

- On a successful sign-in, `onAuthStateChanged` in `index.html` calls `posthog.identify(user.uid, {email, displayName, emailVerified})`. All subsequent client events attribute to that Firebase UID.
- On sign-out, the same listener calls `posthog.reset()` so anonymous events from the next visitor don't fold into the previous user's profile.
- On the server, `captureServerEvent({userId, event, props})` uses the supplied `userId` as PostHog's `distinct_id`. `null` userIds map to the literal string `'system:cloud-function'` so cron/system events don't fan out into thousands of throwaway anonymous profiles.

### Replay idempotency (Stripe webhooks)

`captureServerEvent` honors a `props.eventTimestampMs` (number) or `props.serverTimestamp` (ISO string) — if either is set, it is forwarded to PostHog as the event's `timestamp`. Combined with PostHog's `(distinct_id, event, timestamp)` dedupe, this means Stripe webhook redeliveries collapse to a single row in PostHog even though our handlers re-enter on retry. (The handlers themselves are already idempotent at the Firestore layer via `processedStripeEvents/{eventId}`, `disputes/{id}.create()`, and `refunds/{stripeRefundId}.create()`.)

### Releases checklist

Before each deploy:

- Bump `APP_VERSION` in `index.html` to match the new tag.
- Confirm `PUBLIC_POSTHOG_KEY` is real (not placeholder) for production builds.
- Confirm `POSTHOG_API_KEY` secret exists in the active Firebase project (`firebase functions:secrets:access POSTHOG_API_KEY`).
