# TeeBox — End-to-End Marketplace Transaction Loop Audit

**Mode:** Read-only static code audit. No code modified, no API calls, no commits, no emails sent.
**Scope:** Two-real-users-complete-a-sale loop with zero manual intervention, from listing creation to funds release.
**Date:** 2026-05-13
**Prior audits cross-referenced:** `EMAIL_REAUDIT_DIFF.md`, `STRIPE_FAILURE_AUDIT.md`, `STRIPE_INTERRUPTION_AUDIT.md`, `STRIPE_WEBHOOK_AUDIT.md`, `PREMIUM_GATING_AUDIT.md`.

---

## 1. Headline verdict

**Conditional GO** for a private TestFlight beta with a small (≤25) cohort of known testers — **with three CRITICALs and four HIGHs landing before any open-beta or App Store submission.**

The transactional spine (auth → listing → checkout → Stripe destination charge → order doc → seller dashboard) is wired, validated, and signature-verified. The webhook handler is idempotent, the order/listing reservation has rollback paths, and the payout + refund + dispute producers all write the right docs.

The launch-blocking gaps cluster in three areas:

1. **No auto-released-funds / inspection-window mechanism.** App copy promises "48h to confirm" and "funds release in 48h" but no scheduled function flips `payoutStatus="released"` and no escrow hold exists — funds flow on Stripe's default daily payout schedule. The `payout.paid` Connect webhook is the only signal the seller gets paid (which is correct), but the marketing copy mismatches reality.
2. **Email send is blocked on DNS + secrets.** Per `EMAIL_REAUDIT_DIFF.md`: 5 HIGH-severity DNS records still unpublished, `RESEND_API_KEY` is a placeholder, and the unsubscribe HMAC secrets are placeholders. Every JSX email producer is wired correctly — they just have nothing to send through.
3. **Stripe Connect "deauthorized seller during pending PI" still has a 15-min reservation window that can strand the buyer.** Low severity in practice but it's the only path I see where a buyer could be charged without the seller's account being able to receive transfer.

Counter: **9 PASS · 9 PARTIAL · 4 FAIL** across the 22 numbered steps (sub-items counted in §2).

---

## 2. Pass/fail table — all 22 steps

| # | Step | Status | Severity if failed | Evidence (file:line) |
|---|---|---|---|---|
| **SETUP** | | | | |
| A | Seller iOS signup — Apple sign-in + email/password | PASS | CRITICAL | `index.html:5183`-ish (Capacitor wiring); `functions/index.js:1965` `exchangeIdTokenForCustomToken`; `functions/index.js:3870` `welcomeOnFirstProfileWrite` |
| A2 | `Auth.user().onCreate`-equivalent welcome trigger fires | PARTIAL | HIGH | `functions/index.js:3870` fires on `users/{uid}` doc create, but uses legacy `emailShell` (no CAN-SPAM footer); `EMAIL_REAUDIT_DIFF.md` line 70 |
| B | Stripe Connect KYC callable exists | PASS | CRITICAL | `functions/index.js:4089` `createStripeOnboardingLink` (Express account, US, MCC 5941, daily payout schedule) |
| C | Buyer signup web — same path | PASS | CRITICAL | Same auth screen + callable + welcome trigger; no platform-specific branching for buyers |
| **PATH 1 — Seller** | | | | |
| 1 | Signup → verify email → welcome email → deep link → <90s | PARTIAL | HIGH | Trigger wiring is correct (`functions/index.js:3870`, `securityEmailTriggers.js:417` for verify-confirm); BUT `RESEND_API_KEY` is a placeholder per `EMAIL_REAUDIT_DIFF.md §4` → **no email actually sends** until secret bound. `EmailVerified.jsx` exists, `EmailVerification.jsx` is orphaned (verification email uses legacy `emailShell`, not JSX — `index.js:4011-4087`). |
| 2 | Stripe Connect onboarding → payouts enabled → gate before listing | FAIL | CRITICAL | `index.js:4089` mints the link correctly. **No client-side gate**: `index.html:6603` blocks `submitListing` only on `IS_VERIFIED_SELLER` (= `users/{uid}.sellerVerified`), NOT on `stripeChargesEnabled`. A seller can publish listings with no Stripe account. Buyer checkout DOES fail-safe at `index.js:377-383` (refuses to charge), so it's a UX cliff not a data-loss bug — but UX is severe: buyer taps "Buy Now" → 409 "seller hasn't finished setup". |
| 3a | Listing creation 6 photos + form submit | PASS | HIGH | `index.html:6602` `submitListing`; min 3 photos; ≥$300 requires 4 (verification photo); orphan-doc rollback at `:6686-6697` |
| 3b | Suggest Price button (Gemini 2.0 swap confirmed) | PASS | MED | `index.js:5001` model = `gemini-2.0-flash`; previously broken on 1.5 — fix confirmed |
| 3c | Photo upload — parallel + client-compress | PASS | HIGH | `index.html:6518` `uploadPhotos`: `Promise.all` parallel, `shrinkForUpload` → 1600px JPEG @ 0.85 quality before `uploadBytes` |
| 4a | Homepage Latest Listings | PASS | CRITICAL | `index.html:6970` `buildProducts`; `loadListings` fetches top 200 by `createdAt desc`, filters `status !== expired` + photos required |
| 4b | Browse / category filter | PASS | HIGH | `applyFilters` (called from `buildProducts`); filter state via `window.__filter` |
| 4c | Search by brand / model / partial | PASS | HIGH | Client-side string match in `applyFilters`; brand chip clear button wired at `:6976` |
| 4d | Filter by condition + price | PASS | MED | Same `applyFilters` covers price + condition |
| 4e | My Shop dashboard counts | PASS | MED | `functions/index.js:2670` `aggregateSellerStats` increments `salesCount` + `totalRevenue` on delivery |
| 4f | Public profile listings | PASS | MED | `renderProfileView` resolves seller listings on profile open |
| 4g | sitemap.xml auto-generated for listings | FAIL | LOW | `/sitemap.xml` is **static**; only contains homepage + brand pages, no listing detail URLs. No generator function exists. Not launch-blocking (SPA listings aren't SEO-friendly on GH Pages anyway). |
| 4h | OG / Twitter Card per listing | FAIL | MED | `index.html:33-47` — only the homepage default OG meta exists. SPA route doesn't update OG tags. Listing share preview will always show the homepage banner. |
| 5a | Welcome email | PARTIAL | HIGH | Wired (legacy `emailShell` path); blocked on `RESEND_API_KEY` |
| 5b | KYC complete email | FAIL | MED | No handler for Connect `account.updated → details_submitted=true` → email. `syncConnectAccountStatus` (`index.js:827`) only mirrors the booleans into Firestore. No JSX template for "KYC complete". |
| 5c | Listing-live email | PARTIAL | MED | `securityEmailTriggers.js:530` `onListingLive` is correct and idempotent; client creates listings with `status:"active"` so the trigger fires; blocked on `RESEND_API_KEY` |
| **PATH 2 — Buyer** | | | | |
| 6 | Discovery + listing detail load <2s + 6 photos + gallery + zoom | PARTIAL | MED | `index.html:7804` `openProductModal` renders the listing modal from in-memory `window.PRODUCTS` (instant). Single hero image only — **no multi-photo gallery or zoom UI** found. Listing card shows photo count badge but the modal renders `photos[0]` only. |
| 7a | Like / save (watchlist) | PASS | MED | `index.html:12605` reads `users/{uid}.watchlist`; `functions/index.js:2627` `syncWatchlistCount` keeps listing-side count in sync; `notifyOnWatchlistPriceDrop` scheduler exists |
| 7b | Message — conversation + `notifyOnNewMessage` | PASS | HIGH | `index.html:8263` client calls `sendMessage` callable (`index.js:5396`); `notifyOnNewMessage` (`index.js:3732`) fires email + in-app notification with 4h throttle |
| 7c | PII filter on phone/email/payment-app | PASS | HIGH | `index.html:2697` `detectOffPlatform` HARD + SOFT regexes; HARD severity triggers `confirm()` before send (`:8278`); server re-scans authoritatively at `index.js:2373` `moderateMessage` |
| 8a | Offers — Make Offer feature flag | PASS | INFO | `index.html:209` `[data-feature="offers"] { display: none !important; }` hides the button entirely (intentional). The offer-create + accept/decline backend exists but the UI surface is dark. |
| 8b | Offer create + accept/decline/counter callables | PASS | MED | `index.html:11110` writes `offers/{id}`; `functions/index.js:3621` `notifyOnOfferCreated`, `:3664` `notifyOnOfferUpdated`; `:2861` `expireOldOffers` hourly cron |
| 9a | Cart → checkout → Stripe Payment Element | PASS | CRITICAL | `index.html:4309` mounts Payment Element + Address Element; `index.js:165` `createPaymentIntent` (60 req/min rate limit, email_verified gate, ban check) |
| 9b | Destination-charge + application_fee math (3% Pro / 6.5% free) | PASS | CRITICAL | `index.js:65-66` `PLATFORM_FEE_PERCENT=0.065` + `PRO=0.03`; `:340-343` tier-aware; `:415-419` `application_fee_amount` + `transfer_data.destination` + `on_behalf_of` (correct destination-charge with on_behalf_of for dispute liability) |
| 9c | Sales tax — Stripe Tax API | FAIL | HIGH | **No Stripe Tax integration.** `automatic_tax` is never set on the PI. Buyers in California, Washington, etc. should be charged sales tax on tangible goods >$100 (state thresholds vary). Marketplace facilitator liability is real — TeeBox is the seller of record. **Launch-blocker for any sale into a state with marketplace nexus.** |
| 9d | Shipping cost calc | FAIL | HIGH | **No shipping cost field on the listing schema, no add-on at checkout, no shipping calculator.** Buyer pays the listing `ask` only. Seller absorbs shipping (or hides it in the ask). Listing form has no shipping price input. Out-of-state sales will see sellers refusing or hiding cost — review-period nightmare. |
| 9e | Platform fee transparency to buyer | INFO | LOW | The 6.5% fee is on the seller side (`application_fee_amount`), not added to the buyer's total — so buyer-side transparency is N/A. |
| 10 | Buyer post-purchase emails | PARTIAL | HIGH | `emailTriggers.js:299` `onOrderCreatedEmail` fires on `orders/{id}` create → `OrderPlacedBuyer.jsx` + `OrderPlacedSeller.jsx`. Wiring is correct. Stripe sends its own receipt automatically. Blocked on `RESEND_API_KEY`. Known field-name bug: `OrderPlacedBuyer.jsx` reads `listing.imageUrl` but listings store `listing.photos[0]` (`EMAIL_REAUDIT_DIFF.md` line 86) — hero image will be missing. |
| 11a | Seller sale notification + push + listing status flip | PASS | CRITICAL | `pushTriggers.js` (full lifecycle); `index.js:1212` `handlePaymentSucceeded` flips listing → `sold` (or stays `active` for multi-stock partial sells); writes order doc keyed on PI id (idempotent) |
| 11b | Sale email to seller | PARTIAL | HIGH | Same `onOrderCreatedEmail` covers seller via `OrderPlacedSeller.jsx`; blocked on `RESEND_API_KEY` |
| **PATH 3 — Fulfillment** | | | | |
| 12a | Seller marks shipped + tracking number | PASS | HIGH | `index.html:10805` `confirmShip` writes `fulfillmentStatus:"shipped"`, `carrier`, `trackingCarrier`, `trackingNumber`, `shippedAt` |
| 12b | Tracking number format validation USPS/UPS/FedEx/DHL | PASS | HIGH | `index.html:10788-10792` regex per carrier; `validateTrackingNumber` at `:10793` with normalize + length sanity check |
| 12c | Shipping label generation (Shippo/EasyPost) | FAIL | MED | **No label SDK integrated.** `LabelCreated.jsx` template exists and `onOrderLabelEmail` (`emailTriggers.js:332`) fires on `labelUrl` first-set, but **nothing in the codebase ever writes `labelUrl`**. Seller buys/prints labels off-platform. |
| 13a | Tracking updates → buyer notified | PARTIAL | MED | `emailTriggers.js:356` `onOrderShippingStatusEmail` is wired for `shippingStatus` transitions `transit → out_for_delivery → delivered`. **But seller-side UI only writes `fulfillmentStatus` (not `shippingStatus`) at `index.html:10825`** — schema mismatch means buyer never gets the JSX shipped email. `pushTriggers.js:239-251` does fire push on `fulfillmentStatus=="shipped"`. |
| 13b | Carrier webhook → status auto-update | FAIL | MED | **No carrier webhook receiver.** `shippingStatus` field is written nowhere. Out_for_delivery / delivered transitions only happen if the buyer manually taps "Confirm delivery" (`index.html:10872`). |
| 14a | Buyer confirms delivery → inspection window | PARTIAL | HIGH | `confirmDelivery` (`index.html:10872`) sets `fulfillmentStatus:"delivered"` + `deliveredAt`. Push trigger fires "48h to confirm or report" (`pushTriggers.js:258`). **The inspection-window TIMER is never actually started or enforced server-side** — there's no `inspectionEndsAt` field, no scheduled function to release funds. |
| 14b | DeliveredBuyer/DeliveredSeller emails | PARTIAL | MED | Wired in `emailTriggers.js:403` but gated on `shippingStatus=="delivered"` (not `fulfillmentStatus`) — same schema mismatch as 13a. **Buyer + seller currently never receive these emails after delivery.** |
| 15a | Funds release after 48h | FAIL | **CRITICAL (semantic)** | **No 48h hold mechanism exists.** Stripe destination charges with `automatic_payouts` and a `daily` payout schedule (`index.js:4136`) release on Stripe's default schedule — typically T+2 business days for new Connect accounts ramping to T+0/T+1. App copy ("Funds release in 48h", `pushTriggers.js:268`) and "Buyer Protection" callout (`index.html:4297` "never ships, or seller doesn't ship within 5 business days") **mismatch the implementation**. There is no escrow, no `application_fee` with `manual_payouts:true`, no held PI. |
| 15b | `payout.paid` → seller email + payouts/{id} record | PASS | HIGH | `missingProducers.js:225` `stripeConnectWebhook` writes `payouts/{stripePayoutId}` idempotently; `emailTriggers.js:428` `onPayoutReleasedEmail` fires → `FundsReleased.jsx` |
| 16a | 7-day review request | PARTIAL | LOW | `emailTriggers.js:603` `reviewRequestScheduler` daily 17:00 UTC, queries `shippingStatus=="delivered"` — **broken due to same schema mismatch (clients write `fulfillmentStatus`)**. Review email will never fire. |
| 16b | Verified-purchase tie | PARTIAL | LOW | `reviews/{id}` write at `onReviewCreated` (`index.js:2072`); ties to order. Doesn't strictly verify the reviewer was the buyer — auditable. |
| **PATH 4 — Edge cases (post-launch acceptable per scope)** | | | | |
| 17 | Payment failure / decline | PASS | MED | `STRIPE_FAILURE_AUDIT.md` confirms decline handled inline by Stripe; `index.js:537-540` releases listing on `payment_intent.payment_failed` + `.canceled` |
| 18 | 3DS / SCA | PASS | MED | `index.js:409-411` `request_three_d_secure: "automatic"`; Payment Element handles 3DS sheet inline; `STRIPE_FAILURE_AUDIT.md` confirms |
| 19 | Refund flow | PASS | HIGH | `index.js:4426` `refundOrder` callable: Stripe refund with `refund_application_fee:true` + `reverse_transfer:true`, writes `refunds/{stripeRefundId}` doc → `emailTriggers.js:455` `onRefundEmail` → `RefundIssued.jsx`. Idempotent (`ALREADY_EXISTS` swallowed). Inventory restored on full refund. |
| 20 | Dispute / chargeback flow | PASS | HIGH | `index.js:850` `handleDisputeOpened` now writes `disputes/{stripeDisputeId}` (regression in `EMAIL_REAUDIT_DIFF.md` was wrong — it IS resolved at `index.js:942-955`); `:979` `handleDisputeFundsWithdrawn` reverses transfer with `refund_application_fee:true`; `:1048` `handleDisputeFundsReinstated`; `emailTriggers.js:478` `onDisputeOpenedEmail` → both buyer + seller JSX templates |
| 21 | Buyer cancellation pre-ship | FAIL | MED | **No buyer-side cancellation handler before ship.** Buyer can `openDispute` (`index.html:10896`) writing a SEPARATE `disputes/{orderId}` doc (note: collides with Stripe dispute doc id schema — `index.js:942` uses `dispute.id` aka `dp_...`, client uses `orderId` aka `pi_...`, so no actual collision but two doc-id schemas in the same collection is dangerous). Seller can `refundOrder` to refund a pre-ship order — but no one-click "I want to cancel" button for the buyer. |
| 22 | Network failure mid-purchase | PASS | MED | `STRIPE_INTERRUPTION_AUDIT.md` confirms: webhook is source-of-truth, idempotency at `processedStripeEvents/{event.id}`, reservation rolls back if Stripe API throws (`index.js:437-441`) and on `payment_intent.canceled` (`index.js:1377`). 15-min `PENDING_WINDOW_MS` self-expires. |

---

## 3. Launch-blocking failures (CRITICAL + HIGH affecting steps 1-15)

### CRITICAL

**C1. Funds release / inspection window is mythological — copy mismatches implementation.**
- Evidence: `pushTriggers.js:258, 268` advertises a 48-hour inspection window; `index.html:4297` promises a refund "if the seller doesn't ship within 5 business days"; the listing schema has no `inspectionEndsAt`, no scheduled function flips `payoutStatus="released"`, and `index.js:4136` sets `payouts: {schedule: {interval: "daily"}}` on the seller's Connect account. Funds release on Stripe's default rolling-balance schedule (T+2 for new accounts).
- Why this is launch-blocking: if a buyer disputes within the promised 48h and the seller's payout already cleared, TeeBox absorbs the chargeback. `handleDisputeFundsWithdrawn` reverses the transfer with `refund_application_fee:true`, which is the right defense — but a malicious seller with a withdrawn-balance Connect account could leave TeeBox holding the bag. Marketplace facilitator liability.
- Fix: **either** (a) implement real escrow: set `transfer_data` without `application_fee_amount` → manual transfer at T+48h via a scheduled function, OR (b) rewrite the copy to match reality — "Funds become available per Stripe's standard schedule (2 business days for new sellers)" — and offload chargeback handling to Stripe's reverse-transfer mechanism (already wired).

**C2. Seller can publish listings before Stripe Connect KYC.**
- Evidence: `index.html:6603` `submitListing` only checks `IS_VERIFIED_SELLER`. No call to `getStripeAccountStatus`. The gate fires at buyer checkout (`index.js:377-383`).
- Why this is launch-blocking: a buyer who taps Buy Now gets a 409 with no clear remediation. The marketplace pre-purchase UX shows live listings the buyer literally cannot buy.
- Fix: add a one-time check in `submitListing` (around `index.html:6603`) that calls `getStripeAccountStatus` and refuses with "Finish payouts setup first → Open onboarding" if `!chargesEnabled`. Or, on listing create, set a flag `payoutsReady=false` and filter the homepage/browse query.

**C3. Email send is blocked on RESEND_API_KEY + DNS records.**
- Evidence: `EMAIL_REAUDIT_DIFF.md §4` — apex SPF / DMARC, `mail.` SPF / DKIM CNAME / DMARC all unpublished. `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `UNSUBSCRIBE_HMAC_SECRET` are all placeholder values.
- Why this is launch-blocking: every email-driven step in this audit (signup welcome, email-verified confirmation, listing-live, order-placed, shipped, delivered, refund, dispute, funds-released, review request, password reset) will silently fail or land in spam. Buyer/seller never get an out-of-app confirmation of their sale. This is the spec's "zero manual intervention" requirement — without email, the user has to come back to the app to know anything happened.
- Fix: publish DNS records (paste-ready in `EMAIL_DNS_SETUP.md`); bind real Resend secrets via `firebase functions:secrets:set`. Smoke test is at `functions/emailSmokeTest.js:82` and will validate the morning after.

### HIGH

**H1. Sales tax is not collected.** `index.js:404-434` `paymentIntents.create` never sets `automatic_tax: {enabled: true}`. Marketplace facilitator nexus laws (CA, WA, NY, TX, etc.) require tax collection on tangible goods sold via the platform. Fix: enable Stripe Tax in dashboard + add `automatic_tax: {enabled: true}` to the PI; switch from PaymentIntent to Stripe Checkout Session for the simplest path (Checkout handles `automatic_tax` end-to-end including the address-element address feed).

**H2. Shipping cost is missing from the listing schema and checkout total.** `index.html:6639` writes no `shippingCents` field. Buyer pays `ask` only. Seller eats shipping or hides it in ask. Add `shippingCents` to the sell form + listing doc + PI amount calc.

**H3. Schema mismatch: client writes `fulfillmentStatus`, email triggers read `shippingStatus`.**
- `index.html:10825` writes `fulfillmentStatus:"shipped"`.
- `emailTriggers.js:362-364` keys on `shippingStatus`.
- `emailTriggers.js:603` review-request scheduler queries `where("shippingStatus","==","delivered")`.
- `EMAIL_REAUDIT_DIFF.md §B + #20-21, #29` already flags this.
- Result: **OrderShipped / DeliveredBuyer / DeliveredSeller / ReviewRequest emails will never fire in production.** Buyer push fires (`pushTriggers.js:240` reads `fulfillmentStatus`) so they see the in-app notification, but no email arrives.
- Fix: either (a) update client to write `shippingStatus` too, or (b) update email triggers to listen on `fulfillmentStatus` instead. The duplicated/diverged field names should be collapsed.

**H4. Stripe Connect "deauthorized seller during pending PI" — chargeback liability stranded.**
- Evidence: `handleAccountDeauthorized` (`index.js:1115`) clears the seller's Connect state and `stripeChargesEnabled:false`, BUT does NOT roll back any in-flight `listings/{id}` reservations (`pendingUntil`, `pendingBuyer`). The 15-min `PENDING_WINDOW_MS` will self-expire, but a buyer who completes the Stripe Payment Element during that window will get the `payment_intent.succeeded` webhook → `handlePaymentSucceeded` runs → order is created → but `transfer_data.destination` points at an account that can no longer receive transfers.
- Fix: in `handleAccountDeauthorized`, also sweep any `listings/{id}` where `sellerId == this.seller && status == "pending"` and release them. Add a defensive check in `handlePaymentSucceeded` that the destination account is still active before writing the order doc.

---

## 4. Post-launch acceptable (edge cases + LOW/INFO)

| Finding | Where | Why post-launch is fine |
|---|---|---|
| Payment failure / decline path | step 17 | Stripe surfaces decline UX inline; reservation rolls back |
| 3DS / SCA | step 18 | Inline 3DS sheet; tested in Stripe dashboard test cards |
| Refund flow | step 19 | Wired end-to-end; idempotent; email producer exists |
| Dispute / chargeback | step 20 | All four Stripe events handled; transfer reversal works |
| Sitemap.xml static | 4g | SPA on GH Pages — SEO of listing detail pages was never going to work; brand pages are present |
| OG/Twitter card per listing | 4h | First-purchase audience is direct, not viral share; can add a static OG generator post-launch |
| KYC complete email | 5b | Stripe Express sends its own "you're approved" email; not on critical path |
| Label generation SDK | 12c | Sellers print labels off-platform; not critical for v1 unless we promised in-app labels |
| Carrier webhook auto-updates | 13b | Buyer manually confirms delivery; works for low volume |
| Buyer cancellation pre-ship | step 21 | Seller can `refundOrder` for any reason; works as a workaround for v1 |
| V1 saved-search scheduler dead code | `emailTriggers.js:559` (already removed per re-audit) | resolved |
| Subscription dunning gaps (HIGH per `STRIPE_WEBHOOK_AUDIT.md` B4-B6) | `index.js:586-619` | The pro-subscription dunning gaps don't affect the marketplace loop — Pro is a separate flow |
| 2 disputes/{id} doc-id schemas | `index.html:10915` writes orderId; `index.js:942` writes Stripe dispute id | No actual collision (different prefix); rename client one to `complaints/` post-launch |

---

## 5. Manual-test items (require real device / real Stripe)

For each, a 3-step test plan a QA tester can run.

### M1 — Apple Sign-In on iOS device returns to authenticated session
1. On a TestFlight build, tap "Sign in with Apple", complete Touch/Face ID.
2. Verify the app lands on the marketplace (NOT the auth screen) within 5s.
3. Force-quit app + cold launch — should still be signed in, no re-auth prompt.

### M2 — Stripe Connect onboarding completes + listing gate trips correctly
1. Sign up as seller, tap "Sell", tap through to verify-as-seller modal, accept terms.
2. Tap "Start payouts setup" → Stripe Express form. Complete with test SSN `000-00-0000`, test bank `routing 110000000 / account 000123456789`. Should redirect back to `?stripe=onboarded`.
3. Tap "Sell" again → submit a listing. Should succeed. Open the listing on a second device as buyer → tap Buy Now → confirm card field renders + Payment Element loads.

### M3 — End-to-end transaction with real Stripe test card
1. Seller publishes a $25 test listing.
2. Buyer (on a different account, different device) taps Buy Now → fills address → enters `4242 4242 4242 4242` + any future expiry + `424` CVC → taps Pay.
3. Confirm: (a) buyer sees success screen, (b) `orders/{pi_xxx}` doc exists in Firestore, (c) listing `status==="sold"`, (d) seller dashboard shows the new sale row.

### M4 — Push notification chain
1. Both buyer + seller grant push permissions during onboarding.
2. After M3 completes, verify seller receives "New sale" push within 10s of the order doc landing.
3. Seller taps "Mark shipped" with tracking `1Z9999W99999999999` (test UPS) → buyer receives "Your order shipped" push.

### M5 — Email deliverability post-DNS (gated on C3 fix)
1. After publishing DNS + binding `RESEND_API_KEY`, manually trigger `dailyEmailSmokeManual` via `gcloud functions call`.
2. Open the mailbox at `SMOKE_EMAIL_INBOX` — 4 emails (`OrderPlacedBuyer`, `PasswordReset`, `OrderPlacedSeller`, `OrderShipped`) should all arrive within 60s.
3. Run mail-tester.com on the first inbound — score should be ≥ 9/10.

### M6 — Refund round-trip
1. As the seller in the M3 order, tap "Refund" in My Shop.
2. Confirm: (a) Stripe Dashboard shows the refund, (b) `refunds/{re_xxx}` doc exists, (c) buyer's card was credited (visible in their bank app within 5-10 business days, OR check the Stripe dashboard refund status).
3. The order row should now show "Refunded"; listing inventory should restore (if it was multi-stock).

### M7 — Apple Pay on web (gated on Apple Pay domain verification)
1. Replace `/.well-known/apple-developer-merchantid-domain-association.txt` with the file Stripe issues after adding `teeboxmarket.com` in Stripe Dashboard → Payment Methods → Apple Pay.
2. Open the site in Safari on macOS with Apple Pay set up.
3. Tap Buy Now — the Payment Element should render an Apple Pay button at the top.

### M8 — Dispute → chargeback flow
1. Use Stripe test card `4000 0000 0000 0259` (always disputes) to complete an order in M3.
2. Wait for Stripe's `charge.dispute.created` webhook (manual: trigger from Stripe Dashboard → Events → Resend).
3. Verify: (a) `disputes/{dp_xxx}` doc exists, (b) seller gets the in-app chargeback notification + email, (c) `orders/{pi}.disputed === true`.

---

## 6. Top 5 priority fixes (impact × effort)

| Rank | Fix | Impact | Effort | Why this slot |
|---|---|---|---|---|
| 1 | **Publish DNS + bind Resend secrets (C3)** | Unblocks 9 of the audit's PARTIALs | Low — paste 5 TXT/CNAME records, run `firebase functions:secrets:set` 4 times | One operator action turns "every email is a phantom" into "all emails ship" |
| 2 | **Gate listing creation on `stripeChargesEnabled` (C2)** | Closes the "buy now → 409" UX cliff that will tank trust on day 1 | Low — add ~15 lines in `index.html:6603` calling `getStripeAccountStatus` first | Fix once, every future seller-buyer interaction works |
| 3 | **Resolve the `fulfillmentStatus` vs `shippingStatus` schema split (H3)** | Restores shipped/delivered/review-request emails (3 of 6 transactional emails) | Low — change one line in `confirmShip` to also write `shippingStatus:"shipped"` (and same in `confirmDelivery` for `"delivered"`); leave the trigger schema alone | Single-line fix unblocks half the post-purchase email loop |
| 4 | **Reconcile the 48-hour inspection-window copy with reality (C1)** | Aligns marketing copy with implementation; avoids fraud-magnet edge case | Medium — either (a) rewrite copy to "Standard Stripe payout schedule", OR (b) implement real escrow with manual transfers via scheduled function | The fastest version is the copy change; full escrow is a 2-3 day project. Ship the copy change before TestFlight; design escrow before scaling. |
| 5 | **Enable Stripe Tax (H1)** | Marketplace facilitator compliance for the 5+ states that require it on first sale | Medium — switch from inline `paymentIntents.create` to Stripe Checkout Session (subscription/marketplace mode with `automatic_tax:true`), or add the tax-calculation API call before PI create | Required before any sale into CA/WA/NY/TX/IL. Without this, TeeBox is liable for uncollected tax on every transaction. |

Notable also-rans (rank 6-10): wire `notifySecurityEvent` for `password_changed` + `email_changed` (currently no callers in `index.html`); add shipping cost field to listing schema (H2); add per-listing OG meta via a static generator; sweep deauthorized-seller pending reservations (H4); convert legacy `welcomeOnFirstProfileWrite` from `emailShell` to JSX so CAN-SPAM footers are present.

---

## 7. Recommendation: launch-readiness

### Verdict: CONDITIONAL GO for a private TestFlight beta of ≤25 known testers.

The transactional spine is genuinely solid. Stripe Connect destination charges are configured correctly. Webhook is signature-verified + idempotent. Reservations roll back. Refunds + disputes work. Push notifications fire on the right field. The architecture is correct.

**What's actually missing is operator-side configuration + a handful of small code fixes**, not architectural rework:

- DNS records to publish (5 records)
- Resend / Stripe / unsubscribe secrets to bind (~6 secrets)
- A 15-line client gate to add (C2)
- A 2-line schema reconciliation (H3)
- A copy rewrite OR a 2-day escrow build (C1)
- A Stripe Tax toggle + checkout-session refactor (H1)

**GO conditions to clear before private beta:**
1. C2 (listing → Stripe gate) fixed
2. H3 (status schema) fixed
3. C1 — at minimum, copy rewritten to match Stripe's payout schedule
4. C3 — DNS + Resend secrets bound, smoke test green

**Conditions before open beta / App Store submission:**
5. C1 (real escrow OR signed-off copy-only resolution from legal)
6. H1 (Stripe Tax)
7. H2 (shipping cost field)
8. M7 (Apple Pay domain verification) — non-blocking but a UX upgrade

**Hard launch blockers I can't audit from code:**
- Apple Developer enrollment approval (per user memory: paid 2026-04-26, awaiting 24-48h approval)
- TestFlight build provisioning
- Stripe Connect production-mode approval (already on `pk_live_*` so likely already done)

If the operator completes the 4 "GO conditions" above and runs M3 + M6 successfully on test cards, the marketplace can safely accept its first real transactions from a controlled tester cohort.

---

## Files referenced

### Code paths
- `/Users/jakenair/Desktop/teebox/functions/index.js` — main backend (5739 lines)
- `/Users/jakenair/Desktop/teebox/functions/emailTriggers.js` — JSX email producers (921 lines)
- `/Users/jakenair/Desktop/teebox/functions/missingProducers.js` — payout + price-drop + saved-search producers
- `/Users/jakenair/Desktop/teebox/functions/securityEmailTriggers.js` — security email callable + onListingLive
- `/Users/jakenair/Desktop/teebox/functions/pushTriggers.js` — push notification fan-out
- `/Users/jakenair/Desktop/teebox/index.html` — SPA (16731 lines)

### Email templates (`functions/emails/`)
- `transactional/`: OrderPlacedBuyer, OrderPlacedSeller, LabelCreated, OrderShipped, OrderOutForDelivery, DeliveredBuyer, DeliveredSeller, FundsReleased, RefundIssued, DisputeOpenedBuyer, DisputeOpenedSeller, ListingLive (12 templates)
- `security/`: EmailVerification, EmailVerified, PasswordReset, PasswordChanged, EmailChangedOld, EmailChangedNew, PayoutMethodChanged, TwoFactorCode, SuspiciousLogin, AccountDeletionConfirmed (10)
- `subscription/`: ProWelcome, ProRenewalReminder, ProPaymentFailed, ProPaymentRetrySucceeded, ProCanceled, ProDowngraded (6)
- `lifecycle/`: AbandonedCart, AbandonedDraft, PriceDrop, ReviewRequest, SavedSearchMatch, WinBack30/60/90, WeeklyDigest (9)

### Prior audits (referenced, unchanged)
- `EMAIL_REAUDIT_DIFF.md` (current state of email triggers)
- `STRIPE_FAILURE_AUDIT.md`, `STRIPE_INTERRUPTION_AUDIT.md`, `STRIPE_WEBHOOK_AUDIT.md`
- `PREMIUM_GATING_AUDIT.md`, `EMAIL_TRIGGER_AUDIT.md`, `EMAIL_DELIVERABILITY_AUDIT.md`, `UNSUBSCRIBE_FLOW_AUDIT.md`
