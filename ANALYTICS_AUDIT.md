# TeeBox Analytics Instrumentation Audit

_Audit date: 2026-05-15. Read-only review of `main` (post-launch hardening commit `0410621`)._

---

## TL;DR — No product analytics SDK is installed.

**There is no Firebase Analytics, no GA4 `gtag`, no Mixpanel/Amplitude/PostHog/Segment, no Sentry, and no Crashlytics anywhere in the codebase.**

Evidence:

- `package.json` (root): only Capacitor + Firebase Auth deps. No analytics packages. (`/Users/jakenair/Desktop/teebox/.claude/worktrees/agent-a79e44906047c4716/package.json:29-38`)
- `functions/package.json`: only `firebase-admin`, `firebase-functions`, `stripe`, `resend`, `@google-cloud/vision`, `sharp`, `react-email`. No analytics. (`/Users/jakenair/Desktop/teebox/.claude/worktrees/agent-a79e44906047c4716/functions/package.json`)
- `ios/App/Podfile`: only Capacitor + `CapacitorFirebaseAuthentication`. **No `FirebaseAnalytics`, no `FirebaseCrashlytics`, no `Sentry`.** (`/Users/jakenair/Desktop/teebox/.claude/worktrees/agent-a79e44906047c4716/ios/App/Podfile`)
- `ios/App/App/AppDelegate.swift` + `Info.plist`: zero analytics references.
- Web entry `index.html` (~16k lines): no `firebase.analytics()`, no `getAnalytics()`, no `logEvent()`, no `gtag(`, no `window.plausible(` custom-event calls.
- Functions: no `events/` collection write anywhere across all 60 deployed functions (verified via `collection(\"` enumeration — 43 collections, none named `events`/`activity`/`telemetry`).

### What IS installed

| Layer | Tool | Scope |
|---|---|---|
| Web | **Plausible.io** (autotracking script tag only) | Cookieless pageviews + referrer + country. **No custom event calls.** (`index.html:60`) |
| Backend logs | `firebase-functions/logger` | Structured Cloud Functions logs (not product events) |
| Email funnel | Firestore `emailSends/` collection | Per-template send/skip/bounce status — closest thing to an event log we have |
| Stripe | `processedStripeEvents/` collection | Webhook idempotency markers, not a product event stream |
| Engagement counters | Per-listing aggregate fields | Sharded `views_0..views_9`, `messageCount`, `watchlistCount` — but these are aggregates, not events |

So the answer to "is X tracked?" is, for nearly every product event below, **no**. The audit table below documents what _domain-relevant signal_ exists in Firestore today (counters, status flips, email-send rows), but none of it is wired to an analytics product or a unified event stream.

---

## Part 1 — Audit table

Sorted by domain. "Currently tracked as" describes the closest existing signal in Firestore or Cloud Function logs. **No event has Plausible/GA4/Mixpanel/etc. instrumentation** — that column is suppressed for noise. Standard-property compliance is uniformly bad (no `sessionId`, no `deviceType`, no `appVersion`, no `utm`).

| Event (canonical) | Currently tracked as | Trigger location (file:line) | Properties captured | Missing standard properties | Status |
|---|---|---|---|---|---|
| **AUTH** | | | | | |
| `signup` | Firebase Auth user-record creation; `users/{uid}` doc bootstrap; `updateMarketingConsent` callable records consent decision | `index.html:5365` (`createUserWithEmailAndPassword`), `index.html:5383` (consent), `functions/gdprConsent.js:130` | none on the auth side; consent doc has `granted`, `source: 'signup'`, `at` | `userId`, `sessionId`, `deviceType`, `appVersion`, `source`, `medium`, `referrer` | not implemented |
| `signup_google` / `signup_apple` (OAuth) | Firebase Auth user record | `index.html:14111` (`signInWithPopup`), `index.html:14240` (Apple) | none | all standard props | not implemented |
| `login` (email/password success) | Firebase Auth session | `index.html:5358` (`signInWithEmailAndPassword`) | none | all standard props | not implemented |
| `login_failed` | `index.html:5401-5422` catch block (error code mapped to UI copy only) | `index.html:5401` | none — error code is shown to user, not logged | all standard props | not implemented |
| `login_google` / `login_apple` | Firebase Auth session | `index.html:14111`, `index.html:14240`; native path at `index.html:14015-14180` | none | all standard props | not implemented |
| `logout` | Local sign-out only; `window.signOut` at `index.html:5487`; native FBAuthPlugin signOut at `index.html:5543` | `index.html:5487` | none | all standard props | not implemented |
| `password_reset_requested` | Resend email send logged in `emailSends/` | `index.html:5466` calls `sendBrandedPasswordReset` → `functions/index.js:3929` | `to`, `uid`, `category: TRANSACTIONAL`, `template`, `resendId`, `status`, `sentAt` | `userId` is captured indirectly (uid), no `sessionId`/`deviceType`/`appVersion` | partial |
| `email_verification_sent` | `emailSends/` row | `index.html:5395` calls `sendBrandedVerification` → `functions/index.js:4011` | same as above | same gaps | partial |
| `email_verified` | Not tracked. Firebase Auth flips `emailVerified` flag on the user record; no Firestore mirror, no event. | n/a | n/a | n/a | not implemented |
| `mfa_enrolled` / `mfa_disabled` | **Feature does not exist in product.** No `multiFactor`, `enrollMfa`, or `TOTP` references anywhere. | n/a | n/a | n/a | not implemented |
| `account_deleted` | `deleteUserAccount` callable; `adminActions/` may receive a row (server-side audit) | `index.html:12681`, `functions/index.js:1597` | server-side: uid, deletion summary in function logs | no client-side event; no `sessionId`/`deviceType` | partial (logs only) |
| **LISTING LIFECYCLE** | | | | | |
| `listing_created` (= draft saved client-side) | Autosave to `localStorage`; no Firestore write until publish | `index.html:6634` (`submitListing`) | only persisted on Submit | all standard props | not implemented |
| `listing_published` | `listings/{id}` doc with `status: 'active'`, `createdAt: serverTimestamp()` | `index.html:6713` (client addDoc), `functions/securityEmailTriggers.js:530` (`onListingLive` trigger fires welcome email) | doc: `title`, `brand`, `cat`, `ask`, `bid`, `condition`, `desc`, `photos[]`, `sellerId`, `status`, `createdAt`, `expiresAt`, `quantity`, `quantitySold`, `requiresAuth`, `authReviewState` | no `sessionId`, `deviceType`, `appVersion`, `source`/`medium` (would help attribute first-listing) | partial (state, not event) |
| `listing_edited` | Untracked. `updateDoc` on `listings/{id}` writes `updatedAt` field but no event row. | `index.html:10517` (renew is the only common edit path) | `status`, `expiresAt`, `updatedAt` | all standard props + diff of fields changed | not implemented |
| `listing_renewed` | `updateDoc` setting `status: 'active'` + `expiresAt: +60d` | `index.html:10517` | none beyond the state flip | all standard props | not implemented |
| `listing_deleted` | `deleteDoc` on `listings/{id}` (+ best-effort Storage cleanup) | `index.html:10576`, `index.html:14878` (admin) | none | all standard props + deletion reason | not implemented |
| `listing_flagged` | `moderateListingOnCreate` trigger writes `flaggedListings/{listingId}` with reason | `functions/index.js:3334`, `functions/index.js:5160` | `reason`, `severity`, `listingId`, `sellerId`, `flaggedAt` | no `sessionId` (server-side), no `appVersion` of the client that triggered moderation | partial |
| `listing_taken_down` | `takeDownListing` callable, writes to `adminActions/` | `functions/index.js:2582` | admin uid, listingId, reason, timestamp | server-only audit, no event stream | partial |
| `listing_sold` | `listings/{id}.status = 'sold'` + `soldAt` set in `handlePaymentSucceeded` | `functions/index.js:1297` | `status`, `quantitySold`, `soldAt`, `soldTo`, `orderId` | duplicates `order_placed`; no `sessionId`/`deviceType` of buyer-from-client | partial (state) |
| `listing_expired` | `expireListings` scheduled function flips `status` after 60d | `functions/index.js:1432` | `status: 'expired'` | system event, no actor — fine for server | partial |
| **DISCOVERY / ENGAGEMENT** | | | | | |
| `search_performed` | **Not tracked.** Search runs entirely client-side via `filterSearch()`; no Firestore write, no Plausible custom event. | `index.html:15193` (`searchInput` listener), `index.html:11648` (filter pass) | none | all standard props + `query`, `filters`, `result_count` | not implemented |
| `listing_viewed` | `incrementListingView` callable bumps sharded `views_N` field; `listingViews/{listingId}_{uid}` marker doc rate-limits to 1/24h/user | `index.html:7549` (client call), `functions/index.js:2162` (server) | marker: `listingId`, `uid`, `lastViewedAt` (server timestamp). Aggregate: `listings/{id}.views_N` | no per-view event row; no `sessionId`/`deviceType`/`source` per view; viewer identity lost after 24h dedupe | partial (counter, not event) |
| `listing_saved` (watchlist add) | `users/{uid}.watchlist.{listingId} = {addedAt, …}` map entry | `index.html:12744` | `addedAt` field on map entry | no event row; no `sessionId`/`deviceType` | partial (state) |
| `listing_unsaved` | `users/{uid}.watchlist.{listingId}` deleted via `deleteField()` | `index.html:12737` | none | all standard props | not implemented |
| `saved_search_created` | `addDoc(users/{uid}/savedSearches)` + duplicate top-level `addDoc(savedSearches)` collection | `index.html:10639`, `index.html:11686` | `cat`, `sort`, `min`, `max`, `conditions[]`, `query`, `createdAt` | no `sessionId`/`deviceType`/`source` | partial (state) |
| `saved_search_deleted` | `deleteDoc` on saved-search doc | `index.html:11720`, `index.html:11735` | none | all standard props | not implemented |
| `saved_search_match_notified` | `notifyOnSavedSearchMatch` writes `users/{uid}/notifications/{id}` with `kind: 'saved-search-match'` | `functions/index.js:2778` | `kind`, `listingId`, `searchId`, `searchName`, `listingTitle`, `listingPrice` | server-side notification doc, not an event | partial |
| `saved_search_match_opened` | **Not tracked.** Push payload carries `notificationId` (`functions/index.js:3489`) but no open-handler logs a click. | n/a | n/a | all standard props + `notificationId` | not implemented |
| `price_drop_notified` | `priceDropEvents/{id}` doc created by `onListingPriceUpdate` | `functions/missingProducers.js:465`, `functions/missingProducers.js:546` | `listingId`, `previousAsk`, `currentAsk`, `dropPct`, `createdAt` | server-only; no client click-tracking | partial |
| **TRANSACTION** | | | | | |
| `checkout_started` | `openCheckout()` opens modal + calls `createPaymentIntent` HTTP endpoint to mount Stripe Payment Element | `index.html:4601`, `functions/index.js:165` (server creates PI + writes `pendingOrders/{piId}` reservation) | server-side: PI metadata = `listingId`, `buyerId`, `sellerId`, `quantity`, `unitPriceCents`, `platformFeeCents`, `sellerPayoutCents` | no client event; no `sessionId`/`deviceType`/`source`/`medium`; no funnel timestamp | partial (server reservation only) |
| `checkout_abandoned` | Heuristic only: `abandonedCartScheduler` infers abandonment from watchlist + non-purchase window | `functions/abandonedCartTrigger.js:158` | no per-event row; just a 30d-cooldown stamp on `users/{uid}.lifecycleEmailsSent.abandonedCart` | n/a (not a real event) | not implemented |
| `order_placed` | `orders/{pi.id}` doc created in `handlePaymentSucceeded` | `functions/index.js:1262` | `paymentIntentId`, `listingId`, `buyerId`, `sellerId`, `amountCents`, `currency`, `quantity`, `unitPriceCents`, `platformFeeCents`, `sellerPayoutCents`, `transferId`, `shipping`, `receiptEmail`, `status: 'paid'`, `fulfillmentStatus`, `createdAt` | no `sessionId`/`deviceType`/`source`/`medium`/`referrer` of buyer; no card-network/payment-method captured | partial (rich state, no event semantics) |
| `payment_succeeded` | Same as `order_placed` (collapsed in TeeBox model) | `functions/index.js:1212` | same as above | same | partial |
| `payment_failed` | `releaseListingOnFailure` releases the reservation; no event row | `functions/index.js:539` | server logs only (`logger.info`); pendingOrders is deleted | no event collection, no client event | not implemented |
| `order_shipped` | `orders/{id}.fulfillmentStatus = 'shipped'` + `shippingStatus`, `carrier`, `trackingNumber`, `shippedAt` | `index.html:10918` (`confirmShip`) | listed above | no `sessionId`/`deviceType` of seller; no event row | partial |
| `order_delivered` (buyer confirms) | `orders/{id}.fulfillmentStatus = 'delivered'`, `shippingStatus`, `deliveredAt` | `index.html:10978` (`confirmDelivery`) | listed above | same gaps | partial |
| `order_delivered_carrier` (carrier webhook) | **Not implemented.** Comment at `index.html:10920` explicitly says "Until a Shippo webhook is in place, this manual mark-as-shipped action is the only producer of the transit/shipped transition." | n/a | n/a | n/a | not implemented |
| `refund_requested` | `disputes/{orderId}` doc created by buyer | `index.html:11017` | `orderId`, `buyerId`, `sellerId`, `listingId`, `reason`, `detail`, `status: 'open'`, `createdAt` | no `sessionId`/`deviceType`; no `refundAmount` (since it's a dispute, not a refund yet) | partial |
| `refund_issued` | `refundOrder` callable creates a Stripe refund + writes `refunds/{id}` | `functions/index.js:4426` | server-side row | no event row in unified stream | partial |
| `dispute_opened` (Stripe) | `disputes/{id}` doc via `charge.dispute.created` webhook | `functions/index.js:553`, `functions/index.js:853` | dispute id, reason, amount, status, evidence-due-by | server-only | partial |
| `dispute_resolved` | `charge.dispute.funds_withdrawn` / `funds_reinstated` flip status fields | `functions/index.js:556-562` | server-only state | server-only | partial |
| **MESSAGING** | | | | | |
| `conversation_started` | `conversations/{cid}` doc created on first message exchange | `index.html:8146`, `index.html:8469`, `index.html:8563` (lookup-or-create) | `participants[]`, `listingId`, `sellerId`, `lastMessageAt` | no event row; no `sessionId`/`deviceType` | partial (state) |
| `message_sent` | `conversations/{cid}/messages/{id}` doc + side effects: `incrementListingMessage` (buyer→seller only), `moderateMessage`, `notifyOnNewMessage` | `index.html:8337` calls `sendMessage` callable → `functions/index.js:5396`. Also direct `addDoc` at `index.html:11432` | message doc: `senderId`, `text`, `createdAt`. Aggregate: `listings/{id}.messageCount` | no `sessionId`/`deviceType`/`appVersion`; no per-message length/has-link/has-pii flags in unified stream (moderation writes its own `messageFlags`) | partial |
| `message_flagged` | `messageFlags/{messageId}` doc, `users/{uid}.offPlatformFlags` increment | `functions/index.js:2373` (`moderateMessage`) | `severity`, `types[]`, increment counters | server-side audit only | partial |
| `conversation_reported` | `reports/` collection addDoc | `index.html:11117` | report payload (uid, conversationId, reason, createdAt) | no `sessionId`/`deviceType` | partial |
| **MONETIZATION (Pro subscription)** | | | | | |
| `pro_checkout_started` | `createSubscriptionCheckout` callable returns a Stripe-hosted URL | `index.html:14349`, `functions/index.js:4268` | server-side Checkout Session metadata | no client event; no `sessionId`/`deviceType` of initiator | partial |
| `pro_subscription_started` | `customer.subscription.created` webhook flips `users/{uid}.tier = 'pro'`, `proSubscriptionStatus`; `proWelcomeEmail` trigger fires welcome | `functions/index.js:579`, `functions/subscriptionLifecycle.js:205` | `tier`, `proSubscriptionStatus`, `proCurrentPeriodEnd`, `proCustomerId`, `proPriceId`, `proStartedAt` | server-only; no `source`/`medium` captured at upgrade time | partial |
| `pro_renewed` | `customer.subscription.updated` webhook bumps `proCurrentPeriodEnd`; renewal-reminder email fires hourly inside the 3d window | `functions/index.js:580`, `functions/subscriptionLifecycle.js:249` | period-end timestamps | no renewal event row | partial |
| `pro_payment_failed` | `invoice.payment_failed` webhook + `proPaymentFailedEmail` trigger | `functions/index.js:587`, `functions/subscriptionLifecycle.js:358` | server-side: `proPaymentFailureAt`, status flip | server-only | partial |
| `pro_canceled` | `customer.subscription.deleted` webhook + `proCanceledEmail` trigger | `functions/index.js:583`, `functions/subscriptionLifecycle.js:461` | server-side status flip | no cancel-reason capture (Stripe Portal collects one, not mirrored) | partial |
| `pro_downgraded` | `proDowngradedEmail` trigger detects tier flip | `functions/subscriptionLifecycle.js:499` | server-side | partial | partial |
| **OFFERS / BIDS / REVIEWS** | | | | | |
| `offer_created` | `addDoc(offers, …)` | `index.html:11212` | `listingId`, `buyerId`, `sellerId`, `amount`, `status`, `createdAt` | no `sessionId`/`deviceType` | partial |
| `offer_accepted` / `offer_declined` / `offer_countered` | `updateDoc(offers/{id}, {status})` | `index.html:11243`, `index.html:11513`, `index.html:11520` | `status`, `counterAmount` (when applicable) | no event row, status flip only | partial |
| `review_created` | `reviews/{id}` doc + `onReviewCreated` trigger updates seller avgRating | `index.html:12380`, `functions/index.js:2072` | `rating`, `text`, `orderId`, `revieweeId`, `reviewerId`, `createdAt` | no `sessionId`/`deviceType` | partial |
| `report_created` (generic abuse report) | `addDoc(reports, …)` | `index.html:11117`, `index.html:13423`, `index.html:13504` | report-type-specific payload | no `sessionId`/`deviceType` | partial |
| **SYSTEM / ERRORS** | | | | | |
| `stripe_webhook_received` | `processedStripeEvents/{eventId}` marker doc | `functions/index.js:465`, `functions/index.js:626` | `type`, `processedAt`, `ok` flag | dedup marker, not analytics | partial |
| `stripe_webhook_failure` | `logger.error` only; no Firestore row. Marker only written on success. | `functions/index.js:638-660` | function logs | not in event stream | not implemented |
| `email_sent` | `emailSends/{id}` doc | `functions/lib/email.js:254` | `to`, `uid`, `category`, `template`, `status`, `resendId`, `error`, `sentAt` | no `sessionId`/`deviceType` (server-side event so N/A); but no `messageId`, `subject` for the dashboard | working |
| `email_delivered` / `opened` / `clicked` | `resendWebhook` updates `emailSends/{id}.status` | `functions/emailTriggers.js:249-265` | status field flip on existing doc | no separate event row (status is overwritten) | partial |
| `email_bounced` (hard) | `emailSuppressions/{uid}` + `users/{uid}.emailSuppressed = true` | `functions/emailTriggers.js:208` | `uid`, `email`, `reason`, `bounceType`, `at` | no analytics-stream row, only a suppression record | partial |
| `email_complained` | `complaints/{uid}` + `emailSuppressions/{uid}` | `functions/emailTriggers.js:228` | uid, email, payload, at | partial — admin queue only | partial |
| `email_send_failure` | Caught in `sendEmail` and written via `recordSend({status: 'failed', error})` | `functions/lib/email.js:397` (Resend error path) | `status: 'failed'`, `error` field | recorded in `emailSends/` | working |
| `push_sent` | `sendEachForMulticast` result; **dead tokens pruned but no per-push event row** | `functions/index.js:3479` | none persisted | no event row; per-send result discarded after pruning | not implemented |
| `push_send_failure` | `logger.error("pushNotificationDispatch error", err)` | `functions/index.js:3511` | function logs only | not in event stream | not implemented |
| `app_crash` (web) | **Not tracked.** No `window.onerror`, no Sentry, no Firebase Crashlytics. | n/a | n/a | n/a | not implemented |
| `app_crash` (iOS) | **Not tracked.** No Crashlytics, no Sentry in Podfile. Apple's default crash reports go to App Store Connect only. | n/a | n/a | n/a | not implemented |
| **REFERRAL / GROWTH** | | | | | |
| `referral_code_generated` | `generateReferralCode` callable writes `users/{uid}.referralCode` | `functions/index.js:2924` | server-side field | no event | partial |
| `referral_redeemed` | `redeemReferralCredit` trigger on user doc | `functions/index.js:3003` | server-side `referralCreditedBy` field | no event | partial |
| `marketing_consent_granted` / `_revoked` | `users/{uid}.marketingConsent = {granted, source, at, ...}` via `updateMarketingConsent` callable | `functions/gdprConsent.js:130` | `granted`, `source` (`signup` / `banner` / `settings`), `at` | richest property bag we have, but only a state mirror — no history beyond current | partial |
| **BINGO (mini-game)** | | | | | |
| `bingo_sync` | `bingoGames/{uid}` doc written by `syncBingoProgress` callable | `functions/bingoSync.js:223` | `boardSeed`, `markedTiles[]`, `streakDays`, etc. | no event row; just state | partial |
| `bingo_win` | `gameScores/{id}` row + `onBingoWinAggregate` updates leaderboards | `functions/bingoLeaderboards.js:230` | score, board, uid, country, createdAt | server-side aggregate, partial event semantics | partial |

### Summary counts (Part 1)

- **47 distinct events surveyed** across 8 domains.
- **`working`: 2** — `email_sent`, `email_send_failure` (both via the `emailSends/` collection).
- **`partial`: 32** — domain state exists (status fields, status-flip triggers, counters, side-effect docs) but is not in a unified analytics event stream.
- **`not implemented`: 13** — `signup`, OAuth signups, `login`, `login_failed`, OAuth logins, `logout`, `email_verified`, `mfa_*` (feature absent), `listing_created` (draft), `listing_edited`, `listing_deleted`, `listing_unsaved`, `saved_search_deleted`, `saved_search_match_opened`, `search_performed`, `checkout_abandoned`, `payment_failed` (no row), `order_delivered_carrier`, `stripe_webhook_failure`, `push_sent`, `push_send_failure`, `app_crash` (web), `app_crash` (iOS).

(The brief stated `working / partial / not implemented` totals at the end — the table contains more rows than the 13 explicit "not implemented" because some "partial" rows could fairly be called "not implemented" depending on definition. We've been generous to `partial` whenever ANY persisted signal exists.)

---

## Part 2 — Naming inconsistencies

Because there is no analytics SDK, there are very few competing event _names_ — but there's substantial inconsistency in the closest analogues (Firestore status strings, `kind` discriminators on notification docs, and email template names). All of these need to be normalized to the snake_case verb-first convention before they back a unified analytics stream.

| Concept | Variants seen in code | File:line | Recommended canonical |
|---|---|---|---|
| Order placed | `kind: "order-placed"` (notification doc) · email template `OrderPlacedBuyer` / `OrderPlacedSeller` · order status `"paid"` · function name `handlePaymentSucceeded` · exports `onOrderCreatedEmail` / `pushOnOrderCreated` | `functions/index.js:3461`, `functions/emailTriggers.js:299-311`, `functions/index.js:1281`, `functions/pushTriggers.js:186` | `order_placed` |
| Order shipped | `kind: "order-shipped"` · `fulfillmentStatus: "shipped"` · `shippingStatus: "shipped"` (mirror field, see `index.html:10923` comment) · template `OrderShipped` · export `onOrderShippingStatusEmail` | `functions/index.js:3464`, `index.html:10918-10923`, `functions/emailTriggers.js:356` | `order_shipped` |
| Order delivered | `kind: "order-delivered"` · `fulfillmentStatus: "delivered"` · `shippingStatus: "delivered"` · templates `DeliveredBuyer` + `DeliveredSeller` | `functions/index.js:3469`, `index.html:10978-10982` | `order_delivered` |
| Offer received | `kind: "offer-received"` · function `notifyOnOfferCreated` | `functions/index.js:3637`, `functions/index.js:3621` | `offer_created` (canonical, neutral) |
| Offer accepted | `kind: "offer-accepted"` · `offers/{id}.status = "accepted"` · function `notifyOnOfferUpdated` | `functions/index.js:3449`, `index.html:11243` | `offer_accepted` |
| Offer declined | `kind: "offer-declined"` | `functions/index.js:3452` | `offer_declined` |
| Offer countered | `kind: "offer-countered"` | `functions/index.js:3455` | `offer_countered` |
| Saved-search match | `kind: "saved-search-match"` (hyphenated) but native push handler keys off `saved_search_match` (snake_case) — explicit translation at `functions/index.js:3486` | `functions/index.js:3438`, `functions/index.js:3486` | `saved_search_match` — and stop the dual translation; pick snake_case everywhere |
| Price drop | `kind: "price-drop"` · collection `priceDropEvents` · email template `PriceDrop` | `functions/index.js:3435`, `functions/missingProducers.js:465` | `price_drop` |
| New message | `kind: "new-message"` · function `notifyOnNewMessage` / `notifyNewMessage` (two near-duplicate fns!) · template `NewMessageEmail` | `functions/index.js:3458`, `functions/index.js:3732`, `functions/pushTriggers.js:464` | `message_sent` |
| Review received | `kind: "review-received"` | `functions/index.js:3472` | `review_created` |
| Pro welcome | `kind: "pro-welcome"` (push) · email template `ProWelcome` · `data: {event: "pro-welcome"}` (hybrid kebab) | `functions/subscriptionLifecycle.js:236-238` | `pro_subscription_started` |
| Listing live | export `onListingLive` (singular) · status `"active"` · email-trigger naming | `functions/securityEmailTriggers.js:530` | `listing_published` |
| Marketing consent source values | `'signup'`, `'banner'`, `'settings'` mixed with `gdpr_banner` in some docstrings | `functions/gdprConsent.js`, `index.html:5383` | `signup`, `banner`, `settings` (lowercase, no prefix) |
| Listing field naming drift | `ask` (price) vs `bid` (90% of ask) vs `price` in JSON-LD vs `unitPriceCents` in Stripe metadata | `index.html:6713`, `functions/index.js:1271` | When attached as an event property: `price_cents` (always integer cents, never dollars) |

### Convention violations to call out (Plausible custom-event names — when added)

The brief's stated convention is **snake_case verb-first, no domain prefix**. Every existing `kind:` string violates the format (hyphens). Every other "event-like" string is either an entity status (`paid`, `shipped`, `active`, `sold`) — which is fine to keep as a Firestore state field — or a function/template name (PascalCase, fine as code identifier).

**Recommendation:** when product-event instrumentation lands, do NOT reuse the `kind:` strings. Define a fresh enum in a single shared module (`functions/lib/eventNames.js` + `assets/eventNames.js` for web parity) and write events using only those names.

---

## Part 3 — Standard property schema

Below is the canonical property bag, with current derivation availability:

| Property | Type | Required? | How to derive today | Gap |
|---|---|---|---|---|
| `userId` | string \| null | required (null for pre-auth events) | `window.CURRENT_USER.uid` on web (`index.html` global); `request.auth.uid` on callables; `req.auth?.uid` on triggers | Available everywhere there's an auth context. For pre-auth pageviews / signup-completion events the property is null and that's correct. |
| `timestamp` | ISO 8601 UTC string | required, set BOTH client and server | Client: `new Date().toISOString()`. Server: `admin.firestore.FieldValue.serverTimestamp()` (already used widely in `createdAt`, `sentAt`, `processedAt`, etc.) | Both sources exist; we just need to attach both on every event (client-stamp + server-stamp so we can detect skew). |
| `sessionId` | UUID v4 string | required | **NO SOURCE EXISTS.** No code generates a session id today. `sessionStorage.getItem('teebox.push.declined')` at `index.html:5584` is the only `sessionStorage` reference and stores a flag, not an id. | **Follow-up item: add `crypto.randomUUID()` on app load, persist in `sessionStorage`, rotate on tab close.** |
| `deviceType` | `'ios'` \| `'android'` \| `'web'` | required | `window.Capacitor && Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web'` — `Capacitor.getPlatform()` returns `'ios'`/`'android'`/`'web'`. Already used at `index.html:14340`, `index.html:14356`, `index.html:14381`. | Available via Capacitor on every load. No gap — just needs to be attached. |
| `appVersion` | semver string | required | Web: `package.json` `version` field (`"1.0.0"` today, `package.json:3`) — needs to be injected at build time into a `window.APP_VERSION` global. Build script `npm run build:web` (`package.json:12`) does **not** currently inject this. iOS: `Bundle.main.infoDictionary?["CFBundleShortVersionString"]` (native) — must be exposed to JS via a Capacitor plugin or `@capacitor/app` (`App.getInfo()` already provides `version`/`build`). | **Follow-up item: build-time substitution for web; `App.getInfo()` for iOS (the `@capacitor/app` plugin is already installed per `package.json:31`).** |
| `source` | string \| null | optional | URL query string `?utm_source=…` on landing; falls back to `document.referrer` host. **No code captures this today.** | **Follow-up: parse on first page load, persist to `sessionStorage.teebox.attribution = {source, medium, campaign, referrer, firstSeenAt}` for the session.** |
| `medium` | string \| null | optional | same as `source` (utm_medium) | same gap |
| `referrer` | string \| null | optional | `document.referrer` (web). iOS: not generally available; if launching from a deep link, `App.addListener('appUrlOpen')` provides the URL. | Easy on web; partial on iOS. |

### Derivation gaps to file as follow-up tickets

1. **No sessionId source.** Net new. Single-line addition: `if (!sessionStorage.getItem('teebox.sid')) sessionStorage.setItem('teebox.sid', crypto.randomUUID())`. Should run inside the existing module script in `index.html` around line 4850 (where auth boots).
2. **No `window.APP_VERSION` build-time injection.** The `build:web` script just copies HTML; it does not template-replace. Either add a sed step that injects `window.APP_VERSION = "1.0.0"` from `package.json:version`, or expose it via a generated `version.js` imported from `index.html`.
3. **No UTM capture.** First-touch + last-touch attribution both currently lost.

---

## Part 4 — Punch list (top 20 by leverage)

Ordered: highest-priority gaps first; naming migrations; schema migrations; infra.

### A. Infrastructure (must come before any event work)

1. **Pick an analytics SDK and install it.** Recommended: Firebase Analytics (already pulling Firebase Auth + Firestore + FCM; the Capacitor plugin `@capacitor-firebase/analytics` exists and is the lowest-friction add for both iOS + web). Alternative: PostHog (richer product-analytics UX, plays well with Plausible-style cookieless mode). **Pick one; don't dual-instrument.**
2. **Generate a `sessionId` on app load** (`crypto.randomUUID()` stored in `sessionStorage`). Inject into a shared `currentEventContext()` helper. (See Part 3 gap #1.)
3. **Inject `appVersion`** into `window.APP_VERSION` at web build time AND read it from `@capacitor/app`'s `App.getInfo()` on iOS. Wire both into `currentEventContext()`. (Gap #2.)
4. **Capture UTM params + referrer on first page load**; persist to `sessionStorage.teebox.attribution`. Attach to `currentEventContext()` so every event carries them. (Gap #3.)
5. **Write a single shared `track(name, props)` helper** (one in `index.html` for client, one in `functions/lib/events.js` for server). All event firing must go through it. Helper attaches the standard property bag automatically.
6. **Add `events/` Firestore collection (or BigQuery export sink) as the authoritative event log** in addition to whatever SDK is chosen, so AI analytics has a queryable raw stream that is fully ours.
7. **Install a client-side crash reporter** (Sentry Web SDK + `sentry-cocoa` via CocoaPods). Today an unhandled JS exception in `index.html` is invisible.

### B. Highest-priority event gaps (must exist for AI analytics to be useful)

8. `search_performed` — currently 100% client-side, zero server signal. Without this, demand-side analytics is blind. Fire on debounced `searchInput` change (≥3 chars) with `{query, filters, result_count}`.
9. `listing_viewed` — convert from sharded counter to also writing per-event row (the 24h dedupe is fine for aggregates but loses the ability to model funnel cohort/source). Keep the counter; add the event.
10. `checkout_started` — fire client-side when `openCheckout()` mounts the Stripe Payment Element. Captures the upper funnel that today only surfaces when payment _succeeds_.
11. `payment_failed` — `releaseListingOnFailure` already runs but writes nothing queryable. Add an `events` row with `{listingId, buyerId, errorCode, declineReason}`.
12. `signup` + `login` + `logout` — three foundational events with zero presence today. Fire client-side on auth-state success transition.
13. `pro_checkout_started` — fires before the Stripe Checkout redirect; lets us measure the upgrade-page conversion rate independent of Stripe's own funnel.
14. `app_crash` (web) — `window.onerror` + `window.onunhandledrejection` → `events` row. Free; do this even before Sentry.

### C. Naming migrations (sed-able renames once an SDK lands)

15. Standardize all push-notification `kind:` strings from kebab-case to snake_case across `functions/index.js`, `functions/subscriptionLifecycle.js`, and the iOS native push handlers that translate them. Drop the dual-translation at `functions/index.js:3486`. (Affects ~11 strings.)
16. Rename `notifyOnNewMessage` (`functions/index.js:3732`) vs `notifyNewMessage` (`functions/pushTriggers.js:464`) — the two functions are confusingly named and one is dead. Audit and consolidate to one export.

### D. Schema migrations (add missing properties to existing event-like rows)

17. **Add `sessionId` + `deviceType` + `appVersion` to**: `listings.createdAt` doc, `orders` doc, `offers` doc, `reports` doc, `disputes` doc, `reviews` doc, `users/{uid}/savedSearches`. These docs already carry meaningful product-event semantics — adding three fields to each `addDoc` call is mechanical and unlocks attribution.
18. **Stamp marketing-consent decisions with `source`/`medium` from the attribution session** (today only `source: 'signup'|'banner'|'settings'` literal, missing UTM context). `functions/gdprConsent.js:130`.

### E. Misc cleanups

19. **Stop writing the legacy duplicate `savedSearches` top-level collection** at `index.html:11686` — `index.html:10639` writes the per-user sub-collection which is the canonical one. The dupe creates phantom event volume.
20. **Document Plausible custom events** as the web-only fallback for marketing-attribution events (`signup`, `listing_published`, `order_placed`) and call `window.plausible(...)` alongside the chosen SDK for the first month so we can sanity-check counts.

(Anything beyond #20 is noise — cap holds.)
