# TeeBox Event Taxonomy

This is the source of truth for every product event in TeeBox. **New events MUST be documented here before being added to code.** Companion to `ANALYTICS_AUDIT.md` (current-state audit).

## Conventions

- **snake_case, verb-noun ordering, no domain prefix.** Use `signup`, `login`, `listing_published`, `order_placed` — never `auth.signup`, `userSignup`, or `listing-published`.
- **One event per fact.** A status flip in Firestore is not an event by itself; fire a discrete event row through the shared `track()` helper.
- **Server-truth events fire server-side; UI-attribution events fire client-side.** When both are useful (e.g. `order_placed`), fire the canonical event server-side from the Stripe webhook handler and a `checkout_completed` client-side event for funnel attribution.
- **Standard property bag is attached automatically by `track()`** — never duplicate those props in `customProps`.
- **Past-tense verbs only.** `signup` (not `signing_up`), `listing_published` (not `publish_listing`). Imperatives are reserved for intent/CTA names.
- **`[NOT YET INSTRUMENTED]`** = the event is canonical but has no code firing it today. Listed so the AI-analytics consumer knows what the schema _will_ contain.

## Standard properties

Attached to every event by `track()`. See `ANALYTICS_AUDIT.md` Part 3 for current derivation sources.

| Property | Type | Required? | Source |
|---|---|---|---|
| `userId` | string \| null | yes (null pre-auth) | `window.CURRENT_USER.uid` (client) / `request.auth.uid` (server) |
| `clientTimestamp` | ISO 8601 UTC | yes | `new Date().toISOString()` at the call site |
| `serverTimestamp` | Firestore Timestamp | yes | `admin.firestore.FieldValue.serverTimestamp()` written on persist |
| `sessionId` | UUID v4 | yes | `sessionStorage.teebox.sid`, generated on app load — **NOT YET WIRED** |
| `deviceType` | `'ios'` \| `'android'` \| `'web'` | yes | `Capacitor.getPlatform()` |
| `appVersion` | semver string | yes | Web: `window.APP_VERSION` (build-injected from `package.json`). iOS: `App.getInfo().version`. **NOT YET WIRED** |
| `source` | string \| null | optional | `?utm_source` on first landing, persisted to `sessionStorage.teebox.attribution` — **NOT YET WIRED** |
| `medium` | string \| null | optional | `?utm_medium` — **NOT YET WIRED** |
| `campaign` | string \| null | optional | `?utm_campaign` — **NOT YET WIRED** |
| `referrer` | string \| null | optional | `document.referrer` (web) / deep-link source (iOS) |

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

_Out of scope today:_ `mfa_enrolled` / `mfa_disabled` — TeeBox has no 2FA/MFA feature.

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
