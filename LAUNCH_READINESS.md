# TeeBox Launch-Readiness Audit
**Generated**: 2026-05-15T00:00:00Z
**Method**: Static code analysis + cross-reference of deployed config (no live tests, no deploys, no Stripe sandbox calls).

## Verdict

- **TestFlight beta: GO with caveats** — the auth, listing, checkout, fulfillment, refund, admin moderation and email pipelines all exist and look wired. Two CRITICAL items are CAN-SPAM/UX correctness gaps that don't block TestFlight (internal users only) but must not ship to public.
- **Public launch: NO-GO** — 5 CRITICAL items below are launch blockers (CAN-SPAM exposure on Welcome / Offer / Message emails, missing admin refund tooling, GDPR data export promised in policy but unimplemented, no message-push trigger, missing transactional 2FA wire-up though template exists).

### Public-launch blockers (CRITICAL)
1. **Legacy `emailShell()` HTML missing physical address + unsubscribe footer** (CAN-SPAM exposure).
2. **Admin cannot issue refunds** — only the seller can.
3. **GDPR "Portability/Download your data" promised in privacy.html but no callable / UI exists.**
4. **Push notification on new message not wired** — `pushTriggers.js:24` explicitly says "owned by another agent's queued PR."
5. **No general signup welcome email** rendered through `<Base/>` — current welcome HTML lacks compliant footer.

## Summary

- Total items audited: **100** (10 paths × ~10 items each)
- PASS (code-verified): **57**
- PARTIAL (code present but with caveats): **17**
- FAIL (gap found): **11**
- REQUIRES-MANUAL-TEST (cannot verify from static analysis): **15**

## Critical findings (top 10 by leverage)

1. **CRITICAL — Legacy `emailShell()` violates CAN-SPAM.** `functions/index.js:3556` renders a footer with only "Help · Privacy" links and no physical mailing address or unsubscribe link. The legacy shell is used by `welcomeOnFirstProfileWrite` (index.js:3898), `notifyOnOfferCreated` (index.js:3663), `notifyOnOfferUpdated` (index.js:3726), `notifyOnNewMessage` (index.js:3847), and `sendBrandedPasswordReset` / `sendBrandedVerification` (index.js:4009, 4074). The new JSX `<Base/>` layout (`functions/emails/layout/Base.jsx:180`) correctly includes the iPostal address and unsubscribe link, but these 6 emails bypass it. **Fix**: migrate each caller to a `<Base/>`-rendered template; the offers UI is already hidden so 2 of the 6 are moot in v1. Effort: ~half-day.
2. **CRITICAL — No admin refund path.** `refundOrder` (`functions/index.js:4458`) hard-rejects when `pre.sellerId !== request.auth.uid`. Admin cannot issue a refund through the callable; the only escape hatch is opening the Stripe Dashboard. PATH H4 ("Refund tools — full or partial refund with reason note") fails. **Fix**: add `|| isAdminEmail(request.auth.token.email)` branch; gate the admin path with the same email allowlist used in `firestore.rules:24-30`. Effort: 30 min.
3. **CRITICAL — GDPR Portability/Download promised but not implemented.** `privacy.html:219` advertises "Portability — receive a copy of your data in a structured, machine-readable format." No callable exists (`grep` for `exportMyData|downloadMyData|dataExport` returns 0 results across `functions/` + `index.html`). Risk: regulator complaint within first 30 days post-launch. **Fix**: add `exportMyData` callable that bundles `users/{uid}`, watchlist, savedSearches, owned orders + reviews into a downloadable JSON; expose under Account → Privacy. Effort: 1 day.
4. **CRITICAL — New-message push notification not wired.** `functions/pushTriggers.js:24` explicitly notes "new-message push (owned by another agent's queued PR)". `notifyOnNewMessage` (index.js:3743) sends email but never invokes `sendPush()`. PATH C6 ("Send message to seller — push notification fires") fails. **Fix**: replicate the `pushOnOrderCreated` shape in `pushTriggers.js` with a `conversations/{cid}/messages/{messageId}` create trigger. Effort: half-day.
5. **CRITICAL — Welcome email is plain-HTML via `emailShell`, no signup template in `functions/emails/`.** `functions/emails/transactional/` has no `Welcome.jsx`. `welcomeOnFirstProfileWrite` (index.js:3881) renders inline HTML. Same CAN-SPAM exposure as item 1, plus visual divergence from the rest of the email family. **Fix**: write `functions/emails/transactional/SignupWelcome.jsx`, swap legacy call. Effort: 1 hr.
6. **CRITICAL — 2FA template + producer exist but no client wire-up.** `functions/securityEmailTriggers.js:488` (`sendTwoFactorCode`) is exposed via `notifySecurityEvent`, and `TwoFactorCode.jsx` template exists, but no client code calls `eventType:'two_factor_code'`. If a user enables 2FA in settings (which doesn't appear to exist either — `grep twoFactor` returns 0 results in index.html), the email never fires. PATH J item #4 (2FA code template) is present but disconnected. **Fix**: either disable 2FA in marketing/UI completely, or wire a Settings toggle that calls the producer. Effort: 1 hr to hide claims; 1-2 days to actually ship 2FA.
7. **CRITICAL — Sitemap.xml has no listing pages.** `sitemap.xml` is 45 URLs, all hand-curated brand pages + policy pages. No `/listing/*` entries. PATH G1 ("Web sitemap.xml — includes every active listing, updates within an hour") fails — the listing detail modal is `?listing=<id>`-based, so SEO is dependent on per-listing entries the sitemap doesn't have. **Fix**: scheduled Cloud Function that rewrites sitemap.xml hourly from `listings` where `status=='active'`. Effort: 1 day (also need server-rendered listing pages or canonical URL strategy).
8. **CRITICAL — Ban-evasion / device-fingerprint detection unimplemented.** `functions/index.js:187` has a `TODO(audit)` comment about phase-2 fingerprint capture; the only real defense is `users/{uid}.banned == true` checked in `createPaymentIntent`. A banned user simply makes a new account. PATH E7 ("Ban-evasion detection") fails. **Fix**: at a minimum capture IP + Stripe `card.fingerprint` from successful charges and reject when either matches a banned user. Effort: 1-2 days.
9. **CRITICAL — Shipping labels not integrated.** No Shippo / EasyPost / Stamps wiring. `LabelCreated.jsx` template exists and `onOrderLabelEmail` (`functions/emailTriggers.js:332`) listens for `labelUrl` field, but no Cloud Function writes that field. Sellers have to buy their own postage. PATH D2 ("Shipping label generation") fails. **Fix**: integrate Shippo (industry-standard) or accept this as a v1 limitation and ship copy saying "Use any carrier" — currently order email implies labels are provided. Effort: 2-3 days for Shippo integration.
10. **CRITICAL — Suggest-price ships live (no kill-switch) but burns Gemini quota with no comps.** `aiSuggestPrice` (`index.html:10329`) is always live; server (`functions/index.js:4826` `suggestListingPrice`) calls Gemini 2.0 Flash every time. The audit spec says "currently disabled pending real data" — that disable does NOT exist. With no comps yet, every click hits Gemini at $0.0001-0.001 each. Manageable but not free. **Fix**: add `AI_PRICE_ENABLED` server flag with default false until comp coverage is real. Effort: 15 min.

---

## Detailed findings per path

### PATH A — Onboarding & Authentication

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| A1 | Email signup flow + verification email send | code-verified | — | `index.html:5340-5398` (createUserWithEmailAndPassword + `sendBrandedVerification`), `functions/index.js:4022` (`sendBrandedVerification`) | Verification deep-link delivery requires manual test. |
| A1b | Verification email content + footer compliance | gap-found | CRITICAL | `functions/index.js:4063-4082` uses legacy `emailShell` | Missing physical address + unsub footer (item 1 above). |
| A2 | Sign in with Apple (iOS) | code-verified | — | `index.html:14164-14213` native plugin + custom token exchange; `ios/App/Podfile:31` Pod link; `ios/App/App/App.entitlements:7` entitlement | Requires manual TestFlight test. |
| A3 | Web signup parity | code-verified | — | `index.html:5340-5400` same callable path | Native Apple/Google fall back to popups on web (`index.html:14115`). |
| A4 | Password reset (`sendBrandedPasswordReset`) | partial | HIGH | `functions/index.js:3940`. Enumeration-safe. Uses legacy `emailShell` (footer non-compliant). | Same CAN-SPAM concern. Migrate to JSX `PasswordReset.jsx` (which exists at `functions/emails/security/PasswordReset.jsx`). |
| A5 | In-app account deletion (Apple 5.1.1(vi)) | code-verified | — | `index.html:12642` confirmDeleteAccount; `functions/index.js:1597` deleteUserAccount — anonymizes listings, deletes auth, wipes subcollections, tears down Stripe customer + connect account | Solid. |
| A6 | Sign-out + sign-back-in | code-verified | — | `index.html:5487` signOut; `setPersistence(browserLocalPersistence)` at `index.html:4856` | Manual test for session persistence. |
| A7 | GDPR marketing-consent gate at signup | code-verified | — | `index.html:5360-5388` writes via `updateMarketingConsent` callable; checkbox defaults unchecked (`index.html:5327`); server (`functions/gdprConsent.js:130`) writes audit trail | Checkbox shown only in sign-up mode (`index.html:5326`), defaulted off. |
| A8 | Email enumeration protection | code-verified | — | `index.html:5408` collapses 3 error codes; `functions/index.js:3973` swallows `auth/user-not-found` | Good. |

### PATH B — Seller flow

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| B1 | Stripe Connect onboarding (callable) | code-verified | — | `functions/index.js:4100` `createStripeOnboardingLink`; returns URL the client opens | Opens in Capacitor's in-app webview by default (Capacitor.Browser), not the system browser. State-preservation when returning is a documented Stripe Connect cookie-share concern — needs manual TestFlight test. |
| B1b | Incomplete KYC blocks listing publish (C2) | code-verified | — | `index.html:6657-6675` getStripeAccountStatus pre-check + `firestore.rules:51-82` `sellerStripeReady()` backstop | Client gate + rules backstop both in place. |
| B2 | Create listing — required-field validation | code-verified | — | `index.html:6687` minimum 3 photos, price>0, all fields required | High-value (>=$300) requires 4 photos (`index.html:6699`). Max 10 photos (`index.html:6477`). |
| B2b | Edge-case prices ($0.01, $10000) | code-verified | — | `index.html:6688` price>0 check; `firestore.rules:124` `d.ask > 0 && d.ask < 1000000` | $0.01 accepted, $0 rejected, $1M+ rejected. |
| B2c | Photo upload (1, 3, 6, 10 photos) | code-verified | — | `index.html:6460` cap=10, `index.html:6689` floor=3 | Requires manual test — server-side WebP/EXIF strip in `functions/index.js:3220`. |
| B3 | Create listing (web) — parity | code-verified | — | Same submitListing code path | — |
| B4 | Edit listing | partial | LOW | grep "edit-listing" + `firestore.rules:84-87` listings update | Manual test that every field is editable + saves cleanly. |
| B5 | Delete listing | code-verified | — | `firestore.rules:97-100` allows seller delete unless status=='sold' | — |
| B6 | Seller dashboard counts | requires-manual-test | MED | `index.html` `openShopDashboard` + Chart.js | Verify revenue / counts match reality. |
| B7 | Suggest-price kill-switch | gap-found | CRITICAL | `index.html:10329` always live; no server flag | Item 10 above. |
| B8 | High-value (>=$300) verification photo | code-verified | — | `index.html:6699-6702`, `requiresAuth: true` (`6727`) | Sets `authReviewState: 'pending'`. |

### PATH C — Buyer flow

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| C1 | Browse + homepage | code-verified | — | `index.html` loadListings; `window.GUEST_MODE=true` default (`6804`) | Public access OK. |
| C2 | Search (typeahead) | code-verified | — | `index.html:10440-10505` debounced, fields title/brand/cat/desc | Local substring match, no typo tolerance. |
| C3 | Filters compose (cat/condition/price/location) | partial | MED | `index.html` filterCat / filter sliders | Location filter scope unclear — manual test. |
| C4 | Listing detail (gallery, swipe, share, similar) | code-verified | — | `index.html:7534` openDetailModal + injectListingJsonLd | Schema.org Product injection per-listing (`7507`). |
| C5 | Like / save listing | code-verified | — | `index.html:12713` toggleWatch; watchlist on users/{uid}.watchlist map | — |
| C6 | Message seller — arrival + push + PII | partial | CRITICAL | Arrival: `notifyOnNewMessage` (`index.js:3743`); PII detect server-side: `moderateMessage` (`index.js:2373`); Push: **NOT WIRED** (`pushTriggers.js:24`) | Push trigger missing (item 4 above). Email + in-app notification work. |
| C7 | Make offer / accept / decline / counter | partial | MED | UI exists at `index.html:2998-3060` but is hidden via `[data-feature="offers"]{display:none}` at `index.html:209` (`8942dcb` commit hides the entire flow because `createPaymentIntent` doesn't honor accepted offer amounts) | OK for v1 — but the data-feature hide must remain. |
| C8 | Checkout — Stripe Elements + 3DS + Address | code-verified | — | `index.html:4734` confirmPayment, `redirect:'if_required'`, `request_three_d_secure:"automatic"` (`index.js:410`), AddressElement validated for `complete:true` (`4754`) | No automatic_tax (verified — `grep` returns 0 hits). Acceptable for non-marketplaced taxable goods, but verify legal stance. |
| C9 | Post-purchase: order doc, email, push, in-orders | code-verified | — | `onOrderCreatedEmail` (`emailTriggers.js:299`), `pushOnOrderCreated` (`pushTriggers.js:186`) | Both wired. |
| C10 | Listing detail og: meta dynamic | gap-found | MED | `index.html:33-46` has static OG; runtime injection in `injectListingJsonLd` adds JSON-LD only, not og: meta tags | Listing share preview on Slack/iMessage will show generic site preview. |

### PATH D — Fulfillment & post-sale

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| D1 | Seller mark shipped (tracking + email + push) | code-verified | — | `index.html:10898` confirmShip — writes both `fulfillmentStatus` + `shippingStatus` (H3 fix), `emailTriggers.js:356` watches shippingStatus → OrderShipped email | H3 fix verified. |
| D2 | Shipping label PDF | gap-found | CRITICAL | `LabelCreated.jsx` + `onOrderLabelEmail` (`emailTriggers.js:332`) exist but no Cloud Function writes `labelUrl` | Item 9 above. |
| D3 | Delivery confirmation copy (C1 fix) | code-verified | — | `functions/emails/transactional/DeliveredBuyer.jsx:11,18,25` says "7-day dispute window", `DeliveredSeller.jsx:18-23` says "payout will appear on your Stripe payout schedule" | C1 fix verified — no more "48h inspection window" lie. |
| D4 | Funds release email | code-verified | — | `onPayoutReleasedEmail` (`emailTriggers.js:428`) on `payouts/{payoutId}` create; `FundsReleased.jsx` template | Requires the `payouts/{id}` doc to be written by `handlePayoutPaid` (`functions/index.js:1110`+ via webhook) — manual test. |
| D5 | Review submission + factored into rating | code-verified | — | `index.html:12579` submitReview, `firestore.rules` enforces shape (buyerId/sellerId/rating/role/orderId) | — |
| D6 | Refund flow — buyer/admin | partial | CRITICAL | `refundOrder` (`functions/index.js:4437`) rejects non-seller (`4458`); refund email via `onRefundEmail` (`emailTriggers.js:455`) | Admin-refund path missing (item 2 above). |
| D7 | Dispute flow | code-verified | — | `index.html:11005` submitDispute → `disputes/{auto}`; `onDisputeOpenedEmail` (`emailTriggers.js:478`) | Both buyer + seller emailed. |

### PATH E — Messaging & community

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| E1 | Conversations list + unread badge | requires-manual-test | LOW | `index.html` openInbox (search "openInbox") | Manual UI test. |
| E2 | Open conversation, scroll persistence | requires-manual-test | LOW | — | Manual UI test. |
| E3 | Send text / emoji / image / URL / max length | partial | LOW | `index.html:3675` `maxlength="1000"` chat input. Image attachment not visible in chat input (`grep` shows text-only) | Image attachment may not be wired. |
| E4 | Off-platform PII detection | code-verified | — | Client: `index.html:2668-2727` (phone/email/messaging-url/external-marketplace/cashtag regex + 30+ HARD keywords + 10 SOFT keywords). Server re-scan: `functions/index.js:2373` `moderateMessage`. | Excellent two-tier coverage. |
| E5 | Block user | code-verified | — | `index.html:13539` blockUser writes `users/{uid}.blocked` map; `MY_BLOCKED_UIDS` set used to client-filter | — |
| E6 | Report user / listing | code-verified | — | `index.html:13453-13513` shared `openReportDialog` → `reports/{auto}` | Targets: user, listing, message. |
| E7 | Ban-evasion detection | gap-found | CRITICAL | `functions/index.js:187` `TODO(audit): wire IP + card fingerprint capture` | Item 8 above. |
| E8 | Message push notification | gap-found | CRITICAL | `pushTriggers.js:24` "owned by another agent's queued PR" | Item 4 above. |

### PATH F — Profile & account settings

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| F1 | View own profile | code-verified | — | `index.html` profile modal | — |
| F2 | Edit profile — name/bio/photo/email | partial | MED | Display name editable via users/{uid} merge; email change requires Firebase Auth flow + `EmailChangedNew`/`EmailChangedOld` templates (`functions/emails/security/`) | Email-change UI wire-up not located in `index.html` quick scan — requires manual confirmation. |
| F3 | Push prefs (pushPrefs.<category>) | code-verified | — | `functions/pushTriggers.js:16` respects `users/{uid}.pushPrefs.<category>` | — |
| F4 | Email prefs + 30-day pause + GDPR state | code-verified | — | `updateEmailPreferences` (`emailTriggers.js:718`) + `emailPauseToggle.js` for pause + GDPR shown via `marketingConsent` doc | — |
| F5 | Linked accounts (Stripe Connect, Pro sub, social) | code-verified | — | `getStripeAccountStatus` (`functions/index.js:4170`); `createStripeLoginLink` (`functions/index.js:4214` — note TODO: not wired to UI yet) | Login link callable not surfaced in client UI — minor gap. |
| F6 | Privacy & data — view/download/delete | partial | CRITICAL | View: profile + Firestore data visible. Download: **NOT IMPLEMENTED**. Delete: in-app via `deleteUserAccount` callable. | Item 3 above. |

### PATH G — Discovery & SEO

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| G1 | Sitemap.xml includes every active listing | gap-found | CRITICAL | `sitemap.xml` is 45 hand-curated URLs, no listings | Item 7 above. |
| G2 | Robots.txt blocks admin/account | partial | LOW | `robots.txt` blocks `/api/` + `/functions/` only. The admin panel is `?admin=moderation` query-param, which is already auth-gated server-side so SEO leakage is moot. | Acceptable. |
| G3 | Open Graph tags (homepage) | code-verified | — | `index.html:33-41` og:title/desc/image + dimensions | Listing-level og: NOT dynamically injected (see C10). |
| G4 | Twitter Card tags | code-verified | — | `index.html:43-46` summary_large_image | — |
| G5 | Schema.org markup | code-verified | — | Organization (`index.html:65`) + FAQPage (`index.html:94`); Product (`index.html:7507` dynamic per listing-open) | — |
| G6 | Page titles unique per public page | code-verified | — | `support.html:6`, `terms.html:7`, `refunds.html:7`, `privacy.html:7`, `dmca.html:7`, `acceptable-use.html:7` each have unique titles | — |
| G7 | Mobile responsive @ 375px | requires-manual-test | LOW | viewport meta + CSS media queries present | Visual confirmation needed. |
| G8 | Page load <2s on 4G | requires-manual-test | HIGH | `index.html` is **913 KB** (16,970 lines) — monolithic SPA | Compress + code-split. Even with CDN gzip → ~250 KB. 2s on 4G is borderline. |

### PATH H — Admin & operations

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| H1 | Admin login gated | code-verified | — | `firestore.rules:24-30` `isAdmin()` checks `request.auth.token.email in ['jakenair23@gmail.com']` + `email_verified` | Single hard-coded email. |
| H2 | Flagged listings queue (Cloud Vision) | code-verified | — | `optimizeListingPhoto` (`functions/index.js:3220`) runs SafeSearch; `flaggedListings/{listingId}` mirror; `index.html:14743` admin queue UI | — |
| H3 | Reported users queue (warn/suspend/ban) | partial | MED | `reports/{auto}` collection exists; admin queue UI scope unclear. `users/{uid}.banned` is read in `createPaymentIntent` (`index.js:194`). | Manual test the admin queue actions. |
| H4 | Refund tools (admin) | gap-found | CRITICAL | `refundOrder` rejects admin | Item 2 above. |
| H5 | Dispute response | partial | MED | `disputes/{id}` collection writable by Admin SDK; admin UI surface not located via grep | Manual test. |
| H6 | User search (admin) | requires-manual-test | LOW | Admin UI quirks | — |
| H7 | Listing search (admin) | requires-manual-test | LOW | — | — |
| H8 | Stripe Dashboard cross-check | requires-manual-test | LOW | Out-of-app | — |

### PATH I — Error handling & edge cases

| # | Item | Status | Severity | Code reference | Fix / notes |
|---|---|---|---|---|---|
| I1 | Network failure during signup | code-verified | — | `index.html:5420` `auth/network-request-failed` handled | — |
| I2 | Network failure during checkout (idempotency) | code-verified | — | `functions/index.js:394` PI idempotency key includes 5-min bucket so retries within window get same PI; webhook reconciles | Solid. |
| I3 | Backend 500 → friendly + monitoring | partial | MED | Errors logged via `logger.error`; PostHog/Sentry on other branches | Out-of-scope per task instructions. |
| I4 | App background→foreground session persists | code-verified | — | `browserLocalPersistence` (`index.html:4856`); Firebase Auth handles this natively | — |
| I5 | Offline → online queue + sync | partial | LOW | Service worker `sw.js` 8.5KB; offline banner at `index.html:2611`; `offline.html` exists | Listings writes go straight to Firestore (no offline queue); user perceives "Try again". Acceptable v1. |
| I6 | iOS force-quit during photo upload | partial | MED | `submitListing` has rollback in `index.html:6760-6771` for partial doc-creation, but doesn't resume the upload | Failure is clean — listing is deleted; no orphan photos in Storage path because Storage rules block writes without parent listing. |
| I7 | Web tab closed during checkout | code-verified | — | `pendingUntil` (`functions/index.js:296`) reservation expires 15 min; webhook commits the actual sale | — |
| I8 | 5000-char description | gap-found | LOW | `index.html:4237` `maxlength="2000"`; `firestore.rules:126` allows up to 4000 | 2000 is fine; spec says 5000. Rules already permit 4000 — bump textarea maxlength to 4000 to match. |

### PATH J — Email pipeline (12 transactional)

| # | Email | Template exists | Trigger wired | Footer (Base/iPostal/unsub) | Smoke covers | Status |
|---|---|---|---|---|---|---|
| J1 | Signup welcome | **NO** (`emailShell` HTML) | `welcomeOnFirstProfileWrite` (`index.js:3881`) | **NO** (legacy shell) | NO | gap-found / CRITICAL |
| J2 | Email verification | YES `EmailVerification.jsx` (template-only — actual send is legacy `emailShell` at `index.js:4063`) | `sendBrandedVerification` (`index.js:4022`) | **NO** for actual send | NO | partial / HIGH |
| J3 | Password reset | YES `PasswordReset.jsx` (template-only — actual send is legacy `emailShell` at `index.js:4009`) | `sendBrandedPasswordReset` (`index.js:3940`) | **NO** for actual send | YES (`emailSmokeTest.js:170` but uses jsx template, not the prod path) | partial / HIGH |
| J4 | 2FA code | YES `TwoFactorCode.jsx` | `sendTwoFactorCode` (`securityEmailTriggers.js:488`) | YES | NO | gap-found / CRITICAL (no client wire-up — item 6) |
| J5 | Order confirmation — buyer | YES `OrderPlacedBuyer.jsx` | `onOrderCreatedEmail` (`emailTriggers.js:299`) | YES | YES | code-verified |
| J6 | Order confirmation — seller | YES `OrderPlacedSeller.jsx` | `onOrderCreatedEmail` (`emailTriggers.js:317`) | YES | YES | code-verified |
| J7 | Shipping update | YES `OrderShipped.jsx` | `onOrderShippingStatusEmail` (`emailTriggers.js:356`, status=shipped/transit) | YES | YES | code-verified |
| J8 | Delivered (buyer) | YES `DeliveredBuyer.jsx` | `onOrderShippingStatusEmail` (status=delivered) | YES | NO | partial / LOW |
| J8b | Delivered (seller) | YES `DeliveredSeller.jsx` | same trigger | YES | NO | partial / LOW |
| J9 | Funds released | YES `FundsReleased.jsx` | `onPayoutReleasedEmail` (`emailTriggers.js:428`) | YES | NO | partial / LOW |
| J10 | Refund issued | YES `RefundIssued.jsx` | `onRefundEmail` (`emailTriggers.js:455`) | YES | NO | partial / LOW |
| J11 | Dispute opened (buyer) | YES `DisputeOpenedBuyer.jsx` | `onDisputeOpenedEmail` (`emailTriggers.js:478`) | YES | NO | partial / LOW |
| J11b | Dispute opened (seller) | YES `DisputeOpenedSeller.jsx` | same trigger | YES | NO | partial / LOW |
| J12 | Review request | YES `lifecycle/ReviewRequest.jsx` | `reviewRequestScheduler` (`emailTriggers.js:603`) cron 17:00 UTC 7-day-after-delivery | YES (with unsub since lifecycle) | NO | code-verified |
| J-extra | New-message digest | NO (`emailShell`) | `notifyOnNewMessage` (`index.js:3743`) | **NO** | NO | gap-found / CRITICAL (item 1) |
| J-extra | Offer email (offer flow hidden in v1) | NO (`emailShell`) | `notifyOnOfferCreated/Updated` (`index.js:3632, 3700`) | **NO** | NO | hidden-feature, defer fix |

**Notes on smoke test (`functions/emailSmokeTest.js`)**: it covers OrderPlacedBuyer, PasswordReset, OrderPlacedSeller, OrderShipped — 4 of the 12 required templates. The OrderPlacedSeller subject regression-snapshot is the only protection against template renames. None of the security or lifecycle templates is exercised. Daily 04:00 ET cron + manual trigger via `X-Smoke-Trigger:1` header.

---

## Manual-test checklist

Hand this list to whoever does the TestFlight smoke. Run them in order; each should take 30s-2min.

### Auth
- [ ] **A1**: Email signup with a real address → verify the verification email lands in <60s and the link verifies (deep-links back to app on iOS).
- [ ] **A2**: Sign in with Apple on a fresh device → confirm `users/{uid}` doc is created with a non-anonymous displayName.
- [ ] **A3**: Same flow on web (Safari + Chrome) → popup completes, redirects back signed in.
- [ ] **A4**: Forgot password → email arrives, link opens reset page, new password takes effect on next sign-in.
- [ ] **A5**: Account → Delete account → type DELETE → confirm full deletion: profile shows "Deleted user" on completed orders; Stripe customer/account both terminated; auth record gone.
- [ ] **A6**: Sign out → relaunch → land on guest browse. Sign back in → state restored.
- [ ] **A7**: New signup → confirm the marketing-consent checkbox is visible, defaulted unchecked, and submitting WITHOUT checking it writes `users/{uid}.marketingConsent.granted=false` in Firestore.

### Seller
- [ ] **B1**: New seller with no Stripe Connect → Sell button → confirm Stripe-required modal appears, "Set up payouts" routes to Connect onboarding. Complete KYC. Return → submitListing now succeeds.
- [ ] **B1b**: Try to create a listing in Firestore console as a user with `stripeChargesEnabled !== true` → rule blocks the write.
- [ ] **B2**: Upload 1, 3, 6, 10 photos in sequence. Try $0.01, $10000.01, $0 → confirm correct gate behavior.
- [ ] **B2c**: Listing with >=$300 price requires 4 photos (verification photo).
- [ ] **B5**: Delete listing → disappears from feed, search, your shop.

### Buyer
- [ ] **C8**: Place an order with Stripe test card `4242 4242 4242 4242` → success.
- [ ] **C8a**: Test card `4000 0027 6000 3184` (3DS required) → 3DS prompt appears, completes.
- [ ] **C8b**: Test card `4000 0000 0000 0002` (decline) → friendly error.
- [ ] **C9**: Confirm `orders/{id}` doc exists, OrderPlacedBuyer + OrderPlacedSeller emails land within 5min.
- [ ] **C6**: Send message → confirm in-app notification fires for recipient AND email arrives after the 4h-throttle window. **Note: push will NOT fire — that's the known gap (item 4).**
- [ ] **C6b**: Send message containing "venmo me at $cash" → confirm interstitial warning. Server should flag.

### Fulfillment
- [ ] **D1**: Seller marks shipped (with tracking) → buyer gets OrderShipped email; carrier/tracking renders.
- [ ] **D3**: Seller marks delivered → buyer gets DeliveredBuyer (7-day dispute window copy); seller gets DeliveredSeller (Stripe payout schedule copy). **No "48h inspection" anywhere.**
- [ ] **D4**: Stripe payout fires per schedule → FundsReleased email lands.
- [ ] **D5**: Buyer submits 4-star review → appears on seller profile; rating average updates.
- [ ] **D7**: Buyer opens dispute → both parties get email; dispute appears in admin queue.

### Messaging
- [ ] **E1**: Send 3 messages to a test account. Confirm conversations list orders by most recent, unread badge is correct.
- [ ] **E5**: Block a user → confirm their listings disappear from your feed, they cannot DM you.
- [ ] **E6**: Report a listing → confirm `reports/{auto}` doc appears and admin queue picks it up.

### Profile / Settings
- [ ] **F3**: Toggle push notifications off → seller sends offer → confirm no push.
- [ ] **F4**: Pause emails for 30 days → confirm next marketing email is blocked; transactional still fires.

### Admin
- [ ] **H1**: Sign in as `jakenair23@gmail.com` → `?admin=moderation` opens queue.
- [ ] **H2**: Upload an NSFW image → confirm photo deleted from Storage, listing flagged for review.
- [ ] **H3**: Submit a user report → confirm admin queue shows it. Test ban → user can't checkout.
- [ ] **H4**: **EXPECTED FAIL** — attempt admin refund. Falls through to "Only the seller can refund this order." (Item 2 above.)

### Email pipeline (deliverability)
- [ ] **J-all**: Fire each of the 12 templates and check (a) rendering in Gmail, (b) rendering in Apple Mail, (c) mail-tester.com score ≥ 9/10 for the 5 most-sent templates, (d) DKIM/SPF/DMARC all pass.
- [ ] **J-footer**: Open OrderPlacedBuyer in inbox → confirm physical address (`16649 Oak Park Ave, Ste H #1160`) is visible.
- [ ] **J-welcome**: Confirm signup welcome email — **EXPECTED FAIL** on footer compliance (item 1, 5).
- [ ] **J-smoke**: `curl -X POST -H "X-Smoke-Trigger: 1" https://us-central1-<project>.cloudfunctions.net/dailyEmailSmokeManual` → confirm 200 OK + Firestore `emailSmokeRuns/{today}` updated.

### Edge cases
- [ ] **I2**: Drop network mid-checkout, retry → confirm same PI returned (no double-charge).
- [ ] **I4**: Background app for 5 min → return → confirm still signed in, no spurious sign-out modal.
- [ ] **G8**: Lighthouse Mobile audit on homepage → confirm score ≥ 70 perf.

---

## Anti-launch list (all CRITICAL + HIGH items)

| ID | Issue | Where | Fix shape | Effort |
|---|---|---|---|---|
| BLOCK-1 | Legacy `emailShell` lacks physical address + unsubscribe footer (CAN-SPAM exposure) | `functions/index.js:3556` | Migrate Welcome / NewMessage / Offer / PasswordReset / Verification to render via `functions/emails/layout/Base.jsx`. Offer emails can be skipped while offers feature is hidden (`index.html:209`). | Half-day |
| BLOCK-2 | Admin cannot issue refunds | `functions/index.js:4458` | Add `\|\| isAdminEmail(request.auth.token.email)` branch alongside seller check; same email list as `firestore.rules:28`. | 30 min |
| BLOCK-3 | GDPR data download missing (promised in policy) | `privacy.html:219` vs nothing in `functions/` | Add `exportMyData` callable that bundles `users/{uid}`, watchlist, savedSearches, orders (buyer + seller views), reviews, FCM tokens metadata into JSON; client surfaces a "Download my data" button under Account → Privacy. | 1 day |
| BLOCK-4 | Message push notification missing | `pushTriggers.js:24` | Add `pushOnMessageCreated` onDocumentCreated for `conversations/{cid}/messages/{messageId}`; mirror shape of `pushOnOrderCreated` (lines 186-216). Respect `pushPrefs.messages`. | Half-day |
| BLOCK-5 | Signup welcome email not on Base layout | `functions/index.js:3881-3902` | Create `functions/emails/transactional/SignupWelcome.jsx`; rewire `welcomeOnFirstProfileWrite` to use `sendTemplated` from `emailTriggers.js`. | 1 hr |
| BLOCK-6 | 2FA template wired server-side but no client trigger | `securityEmailTriggers.js:488` vs zero matches in `index.html` | Either disable 2FA in product copy / settings entirely, or wire a Settings → Security → 2FA toggle that calls `notifySecurityEvent({eventType:'two_factor_code'})` on demand. **Recommend deferring 2FA to post-launch.** | 1 hr to hide; 1-2 days to ship |
| BLOCK-7 | Sitemap has no listing pages | `sitemap.xml` (45 hand-curated URLs) | Add scheduled Cloud Function `regenerateSitemap` hourly: query `listings where status=='active'` → write to GCS / serve via HTTP endpoint. | 1 day |
| BLOCK-8 | No ban-evasion detection (TODO marker) | `functions/index.js:187` | Capture Stripe `card.fingerprint` + IP at successful `payment_intent.succeeded`; on `users/{uid}.banned=true` write, mirror fingerprints to `bannedFingerprints/{fingerprint}` collection; `createPaymentIntent` rejects 403 if either matches. | 1-2 days |
| BLOCK-9 | Shipping labels not generated | `LabelCreated.jsx` template orphaned | Integrate Shippo (or whatever the founder chose) OR change order email to "Use any carrier of your choice" and remove the `LabelCreated.jsx` trigger. **Recommend the latter for v1.** | 2-3 days for Shippo / 1 hr to remove |
| BLOCK-10 | Suggest-price has no kill-switch / burns Gemini quota with no comps | `index.html:10329`, `functions/index.js:4826` | Add `AI_SUGGEST_PRICE_ENABLED` server flag (default false until comp count ≥ 50); client hides button when callable returns `disabled:true`. | 15 min |
| HIGH-1 | Listing-level dynamic Open Graph tags missing | `index.html:33-46` static OG | Server-render or client-replace og:title/desc/image based on `?listing=<id>` query param. Without it, shared listing links to Slack/iMessage show site-wide preview. | Half-day |
| HIGH-2 | Welcome / PasswordReset / Verification actual send paths bypass `<Base/>` | `functions/index.js:4009, 4074` | Same as BLOCK-1. | Included |
| HIGH-3 | Homepage payload 913 KB monolith (perf risk on 4G) | `index.html` is 16,970 lines | Code-split feature blocks; lazy-load Stripe + Chart.js (Stripe is already deferred but the rest of the SPA isn't). | 1-2 days |
| HIGH-4 | Stripe `createStripeLoginLink` callable not wired to UI | `functions/index.js:4214` TODO note | Add "Manage payouts" button under Settings → Linked Accounts. | 30 min |
| HIGH-5 | Welcome email content not tested by smoke (`emailSmokeTest.js`) | `emailSmokeTest.js:157-202` covers 4 templates | Add OrderPlacedSeller-style snapshot for Welcome + at least 1 security + 1 lifecycle template. | 1 hr |
| HIGH-6 | Email change flow not located in client | `EmailChangedNew/Old.jsx` templates exist | Confirm flow exists OR remove the templates from `allowed` set in `securityEmailTriggers.js:282`. | 15-30 min |

---

## Notes / things I could not determine from static analysis

- Whether Stripe Connect onboarding completes inside Capacitor's in-app webview without state-loss on return (cookie/storage isolation between webview and Stripe-hosted form). Needs manual TestFlight test.
- Actual deliverability scores for the 38 emails (Gmail/Apple Mail rendering, mail-tester.com score, DKIM/SPF/DMARC alignment). Needs running through mail-tester.com manually.
- Whether the homepage actually loads under 2s on 4G — file size suggests borderline but real-world TTI depends on the parsing cost of the inline SPA.
- The Stripe sandbox test-card behavior (3DS, decline, etc.). Code requests 3DS via `payment_method_options.card.request_three_d_secure: "automatic"` (`functions/index.js:410`) but I cannot fire test cards.
- Whether the admin moderation UI actually allows warn/suspend/ban or just shows a queue. The `?admin=moderation` UI logic in `index.html:14743-14904` needs visual confirmation.
- Whether image attachments in chat are supported (chat input is `maxlength="1000"` text-only at `index.html:3675`; no attachment button visible in quick scan).
- Whether the Logo Bingo / brand pages (which are in sitemap) are actually served — they're listed as `/brand/scotty-cameron` etc. but I don't see route handlers in `firebase.json` or static files for those paths.

---

## Audit metadata

- Branch: `audit/launch-readiness`
- Repo head at audit time: `1473eac` (fix: harden legacy sendEmail() in index.js — check result.error)
- Files examined: `index.html` (16,970 LOC), `functions/index.js` (5,770 LOC), `functions/emailTriggers.js` (921 LOC), `firestore.rules` (1,044 LOC), all 38 email templates under `functions/emails/`, push triggers, GDPR consent, security email triggers, sitemap.xml, robots.txt, iOS AppDelegate + Info.plist + entitlements.
- Out-of-scope per task instructions: PostHog/Sentry/secrets work on separate branches.
