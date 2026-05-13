# TeeBox Email Trigger Audit

**Date:** 2026-05-13
**Scope:** All 31 transactional / lifecycle email triggers
**Mode:** Read-only code audit (no live sends — Resend not yet provisioned)
**Auditor note:** Resend API key is a placeholder, DNS unverified, JSX build pipeline not wired. `getRender()` returns `null` if `@react-email/render` doesn't transpile JSX at runtime → in production every JSX template will currently fall to the inline fallback `<p>TeeBox notification: ...</p>` stub from `sendTemplated()`. Triggers themselves are wired and would fire correctly once the build/Resend keys land.

Legend:
- ✅ Wired and consistent
- ⚠️ Wired but with caveats
- ❌ Missing or broken

---

## Master Trigger Table

| # | Trigger | Source / `exports.X` | Template | Path exists | Recipient field | Subject | Personalization vars | Deep link / CTA | Idempotency | Category | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Signup → welcome | `welcomeOnFirstProfileWrite` (index.js:3924), `onDocumentCreated('users/{uid}')` | **Inline HTML** in index.js — no JSX template loaded | n/a | `u.email` via `lookupUser(uid)` | "Welcome to TeeBox" | `u.displayName`, `APP_URL` | `${APP_URL}` (root) | Trigger fires only on `onCreate` (Firestore doc). Doesn't re-fire on subsequent profile writes. | transactional | ⚠️ Uses legacy inline `sendEmail()`/`emailShell` path, not JSX system. No PII/CAN-SPAM footer from `Base.jsx`. |
| 1b | Signup → email verification | `sendBrandedVerification` (index.js:4065), `onCall` (called from web client) | **Inline HTML** via `emailShell`, not `EmailVerification.jsx` | `EmailVerification.jsx` exists but unused | `authUser.email` | "Verify your email for TeeBox" | `verifyUrl` (Firebase action link with `continueURL=APP_URL/?launch=auth`) | Firebase action link → continue URL is `/?launch=auth` | Rate-limited 3/min per uid. No persistent stamp — relies on `emailVerified` flag. | transactional | ⚠️ JSX template `EmailVerification.jsx` exists but **never invoked**. Legacy path is used. `sendSecurityEmail` callable would use the JSX path but no UI wires it. |
| 2 | Email verification clicked → confirmation | (none) | — | — | — | — | — | — | — | — | ❌ **Missing.** No trigger fires when a user clicks the verification link. The web app updates `emailVerified` silently. |
| 3 | Password reset request | `sendBrandedPasswordReset` (index.js:3983), `onCall` | **Inline HTML** via `emailShell`. `PasswordReset.jsx` exists but is only fired from `freezeAccount` flow. | `PasswordReset.jsx` exists | requested email (anti-enumeration) | "Reset your TeeBox password" | `resetUrl` (Firebase action link) | Reset URL → Firebase handler → returns to `/?launch=auth` | Rate-limited 5/min per email. Revokes refresh tokens before sending. | transactional | ⚠️ Two divergent paths: legacy inline HTML (always used) vs. `PasswordReset.jsx` (only used by `freezeAccount`). Inconsistent UX. |
| 4 | Password changed | (none) | `PasswordChanged.jsx` exists | `PasswordChanged.jsx` exists | — | "Your password was changed" | `user`, `ip`, `freezeUrl` | `freezeUrl` (HMAC token → `/security?action=freeze&token=...`) | — | — | ❌ **No automatic trigger.** Only callable via `sendSecurityEmail` (which no client UI calls). After a successful password change there is no Cloud Function that fires the email. |
| 5 | Email changed → BOTH old + new | (none) | `EmailChangedNew.jsx`, `EmailChangedOld.jsx` exist | both exist | — | "Email confirmed" / "Your email was changed" | `user`, `newEmail`, `freezeUrl` | freezeUrl pattern | — | — | ❌ **Missing.** No Firestore/Auth trigger watches `users/{uid}.email` changes. The two-email pattern is template-ready but never fires. Only callable via `sendSecurityEmail`, no client UI calls it. |
| 6 | Payout method changed | (none) | `PayoutMethodChanged.jsx` exists | exists | — | "Payout method changed" | `user`, `last4`, `ip`, `freezeUrl` | freezeUrl pattern | — | — | ❌ **Missing.** No `account.external_account.updated` Stripe webhook hook to fire this. Only callable. |
| 7 | 2FA code | (none — TeeBox doesn't ship 2FA yet) | `TwoFactorCode.jsx` exists | exists | — | "Your code: {code}" | `user`, `code` | n/a (code displayed inline) | — | — | ❌ **Missing.** 2FA is not implemented in the app, but template is ready. Only callable. |
| 8 | Account deletion confirmation | (none — see notes) | `AccountDeletionConfirmed.jsx` exists | exists | — | "Your account was deleted" | `user` | n/a | — | — | ❌ **Missing.** `deleteUserAccount` (index.js:1585) does NOT call `sendSecurityEmail` or `sendTemplated`. After deletion no confirmation is sent. |
| 9 | Listing created → "your listing is live" to seller | (none) | (no template) | — | — | — | — | — | — | — | ❌ **Missing.** `moderateListingOnCreate` (index.js:5162) is the only listing-create trigger; it doesn't email. No "listing is live" email is wired anywhere. |
| 10 | First view → NO email | `incrementListingView` (index.js:2150) | — | — | — | — | — | — | — | — | ✅ **No email send confirmed** — handler only updates counters. |
| 11 | First like | (none) | — | — | — | — | — | — | — | — | ❌ **Not implemented** (this was tagged "optional" in the spec). No like trigger anywhere — only `syncWatchlistCount` (index.js:2615) which is a counter. |
| 12 | First message on listing → seller | `notifyOnNewMessage` (index.js:3855), `onDocumentCreated('conversations/{cid}/messages/{messageId}')` | **Inline HTML** in index.js — fires on every message, not just first. | n/a | recipient resolved from conv participants → `recipient.email` | "New message from {fromName}" | `fromName`, `preview`, `APP_URL` | `${APP_URL}/?inbox=1` | None — emails on every message. Spec said "first message" but code emails always. | transactional | ⚠️ Recipient logic is correct (excludes sender; resolves from `conversations/{cid}.participants`). But sends an email per message — likely spammy. Spec says "first message"; no "has-been-emailed" flag. |
| 13 | Offer received → seller | `notifyOnOfferCreated` (index.js:3750), `onDocumentCreated('offers/{offerId}')` | **Inline HTML** | n/a | `seller.email` via `lookupUser(offer.sellerId)` | "New offer on {listingTitle}" | `buyer.displayName`, `offer.amount`, `listing.title` | `${APP_URL}/?offer=${offerId}` | None | transactional | ✅ Correct recipient (seller). Deep link is web-routed; native `teebox://offer/{id}` is handled by `routePushNotificationTap`. |
| 14 | Offer accepted → buyer | `notifyOnOfferUpdated` (index.js:3793), `onDocumentUpdated('offers/{offerId}')` | **Inline HTML** | n/a | `buyer.email` | "Offer accepted: {listingTitle}" | `seller.displayName`, `offer.amount`, `listing.title` | `${APP_URL}/?offer=${offerId}` | Status transition guard (`before.status !== after.status`). Cannot double-send unless status flaps. | transactional | ✅ |
| 15 | Offer declined → buyer | same trigger as #14 | **Inline HTML** | n/a | `buyer.email` | "Offer declined: {listingTitle}" | same as #14 | same | same | transactional | ✅ |
| 16 | Offer countered → buyer | same trigger as #14 | **Inline HTML** | n/a | `buyer.email` | "Counter offer on {listingTitle}" | `counterAmount`, etc. | same | same | transactional | ✅ |
| 17 | Listing sold → seller + buyer | `onOrderCreatedEmail` (emailTriggers.js:285) **AND** `notifyOnOrderCreated` (index.js:3599). Both fire on `orders/{id}` create. | `OrderPlacedBuyer.jsx`, `OrderPlacedSeller.jsx` (JSX path) + inline HTML (legacy path) | both JSX templates exist | `buyer.email`, `seller.email` | "Order confirmed — {title}" / "You sold {title}" | `order`, `buyer`, `seller`, `listing` | `https://teeboxmarket.com/orders/{orderId}` (**broken — see issues below**) | None — both handlers fire on every create. | transactional | ❌ **DUPLICATE EMAIL BUG**: both `onOrderCreatedEmail` (JSX) and `notifyOnOrderCreated` (inline) fire on the same `orders/{id}` create event. Buyer + seller each get TWO emails. |
| 18 | Payment captured → buyer receipt | Same as #17 (order doc create) | `OrderPlacedBuyer.jsx` | exists | `buyer.email` | "Order confirmed — {title}" | `order.amountCents`, `order.id`, `listing.title`, `listing.imageUrl` | `https://teeboxmarket.com/orders/{orderId}` | None | transactional | ⚠️ `listing.imageUrl` is **wrong field** — listings store images at `listing.photos[0]`. Thumbnail will render empty in email. Also duplicate (#17). |
| 19 | Shipping label generated → buyer | `onOrderLabelEmail` (emailTriggers.js:318), `onDocumentUpdated('orders/{id}')` | `LabelCreated.jsx` | exists | `buyer.email` | "Your label is printed" | `order`, `buyer`, `listing` | `https://teeboxmarket.com/orders/{orderId}` (broken route) | Guards `!before.labelUrl && after.labelUrl` — only fires on first set. ✅ | transactional | ⚠️ Idempotency works. Deep link broken (no SPA fallback for `/orders/`). The Shippo webhook isn't proven to write `labelUrl` — verify field name with shipping integration. |
| 20 | Shipped → buyer with tracking link | `onOrderShippingStatusEmail` (emailTriggers.js:342) on `shippingStatus → "transit"\|"shipped"` **AND** `notifyOnOrderUpdated` (index.js:3663) on `fulfillmentStatus → "shipped"` | `OrderShipped.jsx` (JSX) + inline HTML (legacy) | exists | `buyer.email` | "Your order has shipped" | `order`, `tracking.carrier/number/publicUrl/eta` | `tracking.publicUrl` or `/orders/{id}` | Status diff guard. But TWO triggers on different fields. | transactional | ❌ **Duplicate-email + field-name mismatch**: JSX path reads `after.shippingStatus`, legacy reads `after.fulfillmentStatus`. Whichever the rest of the app writes will fire one — but if both are written (likely as the system grows), the buyer gets two emails. |
| 21 | Delivered → buyer + seller | `onOrderShippingStatusEmail` on `→ "delivered"` **AND** `notifyOnOrderUpdated` on `fulfillmentStatus → "delivered"` | `DeliveredBuyer.jsx`, `DeliveredSeller.jsx` (JSX) + inline (legacy seller only) | both JSX exist | `buyer.email`, `seller.email` | "Your order was delivered" / "Delivered — payout pending" | `order`, `buyer/seller`, `listing.title`, `order.sellerPayoutCents` | `/orders/{id}` | Status diff guard. Same duplicate-trigger problem as #20. | transactional | ❌ Duplicate (JSX + legacy). Legacy emails ONLY the seller on delivery (not the buyer); JSX emails both. If both fire, seller gets two; buyer gets one. |
| 22 | Inspection window started → buyer | (rolled into Delivered Buyer — see #21) | `DeliveredBuyer.jsx` mentions "3 days to inspect" | n/a | same as #21 | same | same | same | same | transactional | ✅ Same email as Delivered Buyer (per spec). |
| 23 | Funds released → seller | `onPayoutReleasedEmail` (emailTriggers.js:414), `onDocumentCreated('payouts/{id}')` | `FundsReleased.jsx` | exists | `seller.email` | "Your payout is on the way" | `payout.amountCents`, `payout.arrivalDate`, `order` | `/account?tab=payouts` (broken — SPA root has tab) | None — fires once per payout doc create. | transactional | ⚠️ **No `payouts/` collection is written anywhere in the codebase** — I searched `index.js` for `collection("payouts")` and got no creators. So this trigger never fires. Also `/account?tab=payouts` isn't a real SPA route — the dashboard tab switcher uses in-app state, not URL. |
| 24 | Refund issued → buyer with reason | `onRefundEmail` (emailTriggers.js:441), `onDocumentCreated('refunds/{id}')` | `RefundIssued.jsx` | exists | `buyer.email` | "Refund issued" | `refund.amountCents`, `refund.reason`, `order` | `/orders/{id}` (broken route) | None — fires once per refund doc create. | transactional | ⚠️ `refundOrder` callable (index.js:4480) issues the refund via Stripe but does **not write to `refunds/{id}` collection**. So this trigger never fires in current code. |
| 25 | Dispute opened → buyer + seller | `onDisputeOpenedEmail` (emailTriggers.js:464), `onDocumentCreated('disputes/{id}')` **AND** `handleDisputeOpened` (index.js:849, called from Stripe webhook `charge.dispute.created`) | `DisputeOpenedBuyer.jsx`, `DisputeOpenedSeller.jsx` + inline HTML for seller in `handleDisputeOpened` | both JSX exist | `buyer.email`, `seller.email` | "Dispute opened" / "Action needed: dispute opened" | `order`, `buyer/seller`, `listing.title`, `dispute.reason` | `/disputes/{id}` (broken — no SPA fallback) | None | transactional | ❌ **Two parallel systems**: `handleDisputeOpened` writes to `notifications/` and emails seller via legacy inline; the JSX `onDisputeOpenedEmail` needs a `disputes/{id}` Firestore doc that nothing in the codebase writes. So the JSX path **never fires** and the buyer never gets the JSX template. |
| 26 | Saved-search match → buyer | `savedSearchMatchScheduler` (emailTriggers.js:545), `onSchedule('every 1 hours')` | `SavedSearchMatch.jsx` | exists | `user.email` | `${n} new for "${q}"` | `user`, `search.query`, `matches[]` | `https://teeboxmarket.com/search?q={query}` | 24h throttle via `savedSearches/{id}.lastNotifiedAt`. ✅ | savedSearchMatches (marketing) | ⚠️ Schema mismatch: scheduler queries `savedSearches` by `active==true` and `tags array-contains-any` (line 552-563), but the in-app schema (index.js:2778) stores `notifyOnNew==true` and `query` (object with category/brand/condition/priceMin/priceMax) — no `tags` array, no `active` field. **The scheduler query will return zero docs in production.** A separate Firestore trigger `notifyOnSavedSearchMatch` (index.js:2766) creates in-app notifications but doesn't email. |
| 27 | Price drop on liked/watched item → buyer | `notifyOnWatchlistPriceDrop` (index.js:3084), `onSchedule('every 4 hours')` | `PriceDrop.jsx` exists, but **not loaded** by the scheduler | exists | — | — | `user`, `listing.previousPriceCents`, `listing.priceCents`, `listing.imageUrl` | `/listing/{id}` (works — 404.html redirects) | Updates `pricesIndex/{id}.ask` every run, so only one notification per price decrease. | priceDrops | ❌ **Email never sent**: `notifyOnWatchlistPriceDrop` only writes in-app notifications. There is no schedule or trigger that loads `PriceDrop.jsx` and calls `sendTemplated`. The template exists but is orphaned. |
| 28 | Abandoned listing draft → seller | `abandonedDraftScheduler` (emailTriggers.js:592), `onSchedule('0 9 * * *')` daily | `AbandonedDraft.jsx` | exists | `user.email` | "Finish your TeeBox listing" | `user`, `draft.title`, `draft.id` | `/sell?draft={id}` (**broken** — no SPA handler for `?draft=` and 404.html doesn't redirect `/sell` either) | `draft.abandonedEmailSent` stamp. ✅ | abandonedDraft (marketing) | ⚠️ Logic correct (24-48h window). But: the app's sell-form likely doesn't write to a `drafts/{id}` collection — verify schema. **CTA link `/sell?draft={id}` 404s.** |
| 29 | Review request 7 days after delivery → buyer | `reviewRequestScheduler` (emailTriggers.js:628), `onSchedule('0 17 * * *')` daily | `ReviewRequest.jsx` | exists | `buyer.email` | "How was your TeeBox order?" | `user (= buyer)`, `order`, `listing`, `seller` | `/orders/{id}?review=1` (broken route) | `order.reviewEmailSent` stamp + `order.reviewed` guard. ✅ | reviewRequests (marketing) | ⚠️ Idempotency correct. Filter is `shippingStatus == "delivered"` and `deliveredAt` between 7-8 days ago. But `notifyOnOrderUpdated` uses `fulfillmentStatus` field, so unless the order doc has BOTH set, the scheduler returns nothing. |
| 30 | Pro tier upgrade → welcome | `proWelcomeEmail` (subscriptionLifecycle.js:205), `onDocumentUpdated('users/{uid}')` | `ProWelcome.jsx` | exists | `user.email` (resolved from doc or Auth) | "Welcome to Pro Seller — fees are now 3%" | `user.firstName/displayName` | `https://teeboxmarket.com/shop/dashboard` (broken — no `/shop/dashboard` SPA route or static page) | `lifecycleEmailsSent.proWelcome` stamp. ✅ | transactional | ⚠️ Same `firstName` field doesn't exist — falls back to `displayName`. Deep link broken. |
| 31 | Pro tier downgrade → re-engagement | `proDowngradedEmail` (subscriptionLifecycle.js:499), `onDocumentUpdated('users/{uid}')` | `ProDowngraded.jsx` | exists | `user.email` | "Pro Seller ended — fees are now 6.5%" | `user.firstName/displayName` | `https://teeboxmarket.com/account?tab=billing` (broken — no route handler for query param) | `lifecycleEmailsSent.proDowngraded:<periodEndMs>` stamp. ✅ | transactional | ⚠️ Deep link broken. |

---

## Bonus templates with no trigger (orphans)

| Template file | Purpose | Used? |
|---|---|---|
| `lifecycle/AbandonedCart.jsx` | 48h after watchlist add, item ≥ $100 | ❌ **No scheduler exists.** |
| `lifecycle/WeeklyDigest.jsx` | Sunday 9am digest | ✅ Triggered by `weeklyDigestScheduler` but template body is a stub (`{items.length ? ... : "Quiet week..."}` — `items` is always `[]` since the scheduler passes `items: []`). |
| `lifecycle/WinBack30/60/90.jsx` | 30/60/90-day inactive sweep | ✅ Triggered by `winBackScheduler`. Requires `users/{uid}.lastActiveAt` field — verify that's actually written somewhere. |
| `subscription/ProPaymentFailed.jsx` | Stripe past_due | ✅ Triggered by `proPaymentFailedEmail`. |
| `subscription/ProPaymentRetrySucceeded.jsx` | past_due → active | ✅ Triggered by `proPaymentRetryEmail`. |
| `subscription/ProRenewalReminder.jsx` | 3 days pre-renewal | ✅ Triggered by `proRenewalReminderScheduled`. |
| `subscription/ProCanceled.jsx` | proCancelAtPeriodEnd flip | ✅ Triggered by `proCanceledEmail`. |
| `security/EmailVerification.jsx` | post-signup verification | ❌ Defined but **unused** — legacy `emailShell` inline used instead. |
| `security/SuspiciousLogin.jsx` | New-device login alert | ❌ No trigger exists. Callable-only via `sendSecurityEmail`, no caller. |

---

## Categorized issues

### CRITICAL (broken / wrong fan-out / silent failure)

1. **Duplicate-send: orders create** — both `onOrderCreatedEmail` (JSX, emailTriggers.js:285) and `notifyOnOrderCreated` (inline, index.js:3599) listen on `onDocumentCreated('orders/{id}')`. Buyer and seller each receive 2 emails on every order. Fix: delete the legacy `notifyOnOrderCreated` or guard it with a flag.

2. **Duplicate-send: order shipping** — `onOrderShippingStatusEmail` watches `shippingStatus`, `notifyOnOrderUpdated` watches `fulfillmentStatus`. If both fields are written for the same transition, two emails fire.

3. **Missing**: Email verified clicked → confirmation (#2). No trigger.

4. **Missing**: Password changed (#4). Template exists; no trigger fires it.

5. **Missing**: Email address changed → old + new (#5). Both templates exist; no trigger watches for email diffs.

6. **Missing**: Payout method changed (#6). Stripe sends `account.external_account.updated` but no handler.

7. **Missing**: Account deletion confirmation (#8). `deleteUserAccount` does not call `sendSecurityEmail("AccountDeletionConfirmed")`.

8. **Missing**: Listing-live email (#9). Sellers never get a "your listing is live" confirmation.

9. **Broken** (#23 — Funds released): trigger watches `payouts/{id}` collection that nothing writes. Stripe payouts settle via Stripe Connect — there's no Firestore doc write upon payout.

10. **Broken** (#24 — Refund): trigger watches `refunds/{id}` that `refundOrder` doesn't write. Buyer never gets a refund email.

11. **Broken** (#25 — Dispute): JSX trigger watches `disputes/{id}` that nothing writes. Stripe `charge.dispute.created` webhook writes only inline-HTML email to seller (no buyer email), via `handleDisputeOpened`.

12. **Broken** (#26 — Saved-search match): scheduler queries `savedSearches.active == true` and `tags array-contains-any`, but the schema uses `notifyOnNew == true` and `query` object. **Zero matches in production.**

13. **Broken** (#27 — Price drop): `PriceDrop.jsx` template exists but no scheduler ever loads it. Only in-app notifications fire.

14. **Spam risk** (#12 — First message): `notifyOnNewMessage` emails on **every** message, not just the first. Should add a "has-been-emailed" flag.

### MEDIUM (deep links / merge tags)

15. **Bad deep links — broken routes**:
    - `https://teeboxmarket.com/orders/{id}` — 404 on GitHub Pages (no SPA fallback in `404.html`).
    - `https://teeboxmarket.com/disputes/{id}` — same.
    - `https://teeboxmarket.com/account?tab=...` — no client-side query-param tab switcher.
    - `https://teeboxmarket.com/shop/dashboard` — no such page.
    - `https://teeboxmarket.com/sell?draft={id}` — `/sell` 404s; no `?draft=` param handler.
    - `https://teeboxmarket.com/search?q=...` — `/search` 404s.
    - **Working**: `/listing/{id}` (404.html redirects), `/seller/{uid}` (404.html redirects), root `/` with query-param deep links like `?order=`, `?offer=`, `?inbox=1`.
    - Recommendation: update all template URLs to use the working root-`?param=` form, or extend 404.html.

16. **Wrong merge tag** (#18 — Buyer order email): `listing.imageUrl` doesn't exist on listing docs (real field is `listing.photos[0]`). Thumbnail will be blank. Same for `SavedSearchMatch.jsx` and `PriceDrop.jsx`.

17. **Wrong merge tag** (#1, #30, #31): templates reference `buyer.firstName`/`user.firstName` but user docs only have `displayName`. Falls back to "golfer"/"there" generic.

18. **Inconsistent paths**: orders use `amountCents`/`sellerPayoutCents` in modern code, but legacy `notifyOnOrderCreated` reads `order.amount` (whole dollars). Legacy email will display "$0" or wrong totals.

19. **No idempotency** on offer-create, message, order-create email handlers — if the function retries, a second email fires.

20. **JSX never renders in production** — `@react-email/render` is not yet wired into the build pipeline. `sendTemplated` falls through to a minimal `<p>TeeBox notification: ...</p>` stub HTML for every JSX template. This is intentional ("keeps deploys green") but means ALL JSX templates currently send a degraded inline message.

### LOW

21. WeeklyDigest scheduler passes `items: []` always — template renders the "Quiet week" placeholder for every recipient.

22. `winBackScheduler` requires `users/{uid}.lastActiveAt` — verify this field is updated on app open.

23. SuspiciousLogin template exists; no detection logic anywhere.

24. `category` for marketing emails (saved search, price drop, abandoned, win-back, weekly digest, review request) is wired correctly with One-Click unsubscribe headers — RFC 8058 compliant. CAN-SPAM compliance via Base.jsx footer (company name + address) is present. ✅

---

## Coverage Stats

- **31/31 triggers in audit scope.**
- **Existing & functional**: 11 (Account 1, 1b, 3 partial; Marketplace 10, 13, 14, 15, 16; Subscription 30, 31; partial 19, 22, 29)
- **Wired but broken** (missing data source, wrong query, wrong field, bad deep link): 10 (#17/18 duplicate, #20/21 duplicate, #23, #24, #25, #26, #27, #28)
- **Missing entirely (no trigger code)**: 6 (#2, #4, #5, #6, #7, #8, #9)
- **Confirmed correct as no-email-by-design**: 1 (#10 — first view)
- **Optional / not implemented**: 1 (#11 — first like)

JSX-template adoption: **0/9 JSX templates actually render in production** (build pipeline not wired → all fall through to inline stub).
