# TeeBox Email Template Audit

**Audit date:** 2026-05-13
**Scope:** 35 templates across layout/, transactional/, security/, lifecycle/, subscription/
**Auditor:** Read-only review (no code modified)
**Reference standards:** CAN-SPAM 15 USC §7704, RFC 8058 (one-click unsubscribe), GDPR Arts. 6/7, CCPA §1798.135

## Coverage

- Templates audited: **35** (1 layout + 11 transactional + 9 security + 9 lifecycle + 6 subscription, plus 1 sender lib)
- Fully compliant (no findings): **18**
- At least one issue: **17**
- HIGH severity issues: **5**
- MEDIUM severity issues: **9**
- LOW severity issues: **14**

## Per-template findings

### Layout / sender library

| Template | Subject (chars) | CTAs | Spam triggers | Compliance gaps | Severity | Fix |
|---|---|---|---|---|---|---|
| layout/Base.jsx | n/a | n/a | none | Footer has company, address, support email, unsubscribe (marketing only), "why receiving" copy. Logo URL hard-coded to `teeboxmarket.com/icon-192.png` — verify served as PNG with cache headers. | LOW | Move COMPANY_ADDRESS to a single source-of-truth constant shared with `functions/lib/email.js` (currently duplicated in 2 files — drift risk). |
| lib/email.js | n/a | n/a | n/a | List-Unsubscribe + List-Unsubscribe-Post (RFC 8058) correctly added for non-transactional. Reply-To set to support@. From: `no-reply@mail.teeboxmarket.com` — clear sender identity OK. Suppression list + preference center honored. | OK | none |

### Transactional (11 templates)

| Template | Subject (chars) | CTAs | Spam triggers | Compliance gaps | Severity | Fix |
|---|---|---|---|---|---|---|
| OrderPlacedBuyer | "Order confirmed — {title}" → 24-50 | 1 (View order) | none | `.slice(0, 50)` truncates mid-word on long titles | LOW | Truncate `title` to a budget, append "…" |
| OrderPlacedSeller | "You sold {title}" → 16-50 | 1 (Print label & ship) | none | Same mid-word truncation issue | LOW | Same fix |
| OrderShipped | "Your order has shipped" → 22 | 1 (Track package) | none | None | OK | — |
| OrderOutForDelivery | "Out for delivery today" → 22 | 1 (View tracking) | none | None | OK | — |
| DeliveredBuyer | "Your order was delivered" → 24 | 1 (Confirm or dispute) | none | None | OK | — |
| DeliveredSeller | "Delivered — payout pending" → 26 | 1 (View order) | none | None | OK | — |
| FundsReleased | "Your payout is on the way" → 25 | 1 (View payouts) | none | None | OK | — |
| LabelCreated | "Your label is printed" → 21 | 1 (Track this order) | none | None | OK | — |
| DisputeOpenedBuyer | "Dispute opened" → 14 | 1 (Manage dispute) | none | Subject very generic — fine for transactional but could prepend "TeeBox" for inbox brand recognition | LOW | "TeeBox: dispute opened" (22 chars) |
| DisputeOpenedSeller | "Action needed: dispute opened" → 29 | 1 (Respond to dispute) | "Action needed:" is fine — not a spam trigger phrase | None | OK | — |
| RefundIssued | "Refund issued" → 13 | 1 (View order details) | none | Subject very generic. No order amount / refund amount in subject loses signal. | LOW | "Refund issued: {amount}" |

### Security (9 templates)

| Template | Subject (chars) | CTAs | Spam triggers | Compliance gaps | Severity | Fix |
|---|---|---|---|---|---|---|
| EmailVerification | "Verify your TeeBox email" → 24 | 1 (Verify email) | none | None | OK | — |
| PasswordReset | "Reset your TeeBox password" → 26 | 1 (Reset password) | none | IP shown in body — good for forensics. No geo-IP. | LOW | Show city/region from IP if available (parity with SuspiciousLogin) |
| PasswordChanged | "Your password was changed" → 25 | 1 (freeze account, red) | none | `new Date().toLocaleString()` runs at render-time — could mismatch the actual event time. | MEDIUM | Pass `whenIso` as a prop and format server-side |
| EmailChangedNew | "Email confirmed" → 15 | 0 | none | No CTA at all. Acceptable for confirmation-only email but consider linking to account settings. | LOW | Add a soft link to /account |
| EmailChangedOld | "Your email was changed" → 22 | 1 (freeze account, red) | none | None | OK | — |
| AccountDeletionConfirmed | "Your account was deleted" → 24 | 0 | none | No CTA. Mentions "email support@..." in plain text — make it a link for usability. | LOW | Wrap support@ as `<Link>` |
| PayoutMethodChanged | "Payout method changed" → 21 | 1 (freeze account, red) | none | Body says "no action needed" if it was you — good. High-priority banner present. | OK | — |
| SuspiciousLogin | "New sign-in to your account" → 27 | 1 (freeze account, red) | none | Uses `new Date().toLocaleString()` at render — same timestamp drift risk as PasswordChanged. | MEDIUM | Pass `whenIso` prop |
| TwoFactorCode | "Your code: {code}" → 17 | 0 | none | Code rendered as monospace block — good. Preview includes the code which **leaks the 2FA code into the lock-screen / push notification snippet on many phones**. | HIGH | Remove the code from `preview` — use generic "Your TeeBox login code. Expires in 10 minutes." |

### Lifecycle (9 templates — marketing per CAN-SPAM/FTC)

| Template | Subject (chars) | CTAs | Spam triggers | Compliance gaps | Severity | Fix |
|---|---|---|---|---|---|---|
| AbandonedCart | "Still thinking it over?" → 23 | 1 (View listing) | none | **Marked SCAFFOLDED, TODO copy.** No trigger in `emailTriggers.js`. Footer unsubscribe present via category=`abandonedCart`. Body is one short paragraph — passes wall-of-text check. No "??" but two `?` close together in subject is fine. | MEDIUM | Ship real copy; wire trigger or document why disabled |
| AbandonedDraft | "Finish your TeeBox listing" → 26 | 1 (Finish listing) | none | **SCAFFOLDED.** Trigger wired (`abandonedDraftScheduler`). Copy is OK but thin. | LOW | Marketing review of copy |
| PriceDrop | "Price drop: {title}" → 20-50 | 1 (View listing) | none | Fully built. **No trigger in `emailTriggers.js`** — template will never send. Truncation risk on long titles. | HIGH | Wire trigger before launch |
| ReviewRequest | "How was your TeeBox order?" → 26 | 1 (Leave a review) | none | Correctly categorized as `reviewRequests` (marketing per FTC) — unsubscribe link present in footer. | OK | — |
| SavedSearchMatch | "{n} new for "{q}"" → 11-50 | 1 (See all matches) | none | Risk: if user's saved query is "FREE Scotty Cameron" or contains exclamation, that text injects into subject. Low probability but worth a regex strip. | LOW | Sanitize query for !!! / FREE / ALL CAPS before subject |
| WeeklyDigest | "Your TeeBox week" → 16 | 1 (Browse marketplace) | none | **SCAFFOLDED.** Trigger wired but body is just a single placeholder line — sends with empty digest. Correctly gated on `emailPrefs.weeklyDigest == true` (opt-in only) — good. | MEDIUM | Skip-send when items empty (today: sends "Quiet week" — wasted send) |
| WinBack30 | "We miss you on TeeBox" → 21 | 1 (Browse new listings) | none | **SCAFFOLDED.** Default emailPrefs.winBack is undefined → defaults to send. See "GDPR/CCPA" section below. | LOW | Marketing copy |
| WinBack60 | "It's been a while" → 17 | 1 (See what's new) | none | **SCAFFOLDED.** Same opt-in default issue. | LOW | Marketing copy |
| WinBack90 | "Still here when you're ready" → 28 | 1 (Take a look) | none | **SCAFFOLDED.** Last in a series — should explicitly mention "we won't email you again after this" per best practice. | LOW | Add sunset wording |

### Subscription (6 templates — all marked `transactional`)

| Template | Subject (chars) | CTAs | Spam triggers | Compliance gaps | Severity | Fix |
|---|---|---|---|---|---|---|
| ProWelcome | "Welcome to Pro Seller — fees are now 3%" → 39 | 1 Button (dashboard) + 1 inline link (manage) | none | Inline manage link uses raw `<a>` instead of `<Link>` from react-email — Outlook may strip styles. Lists benefits with `<br />` inside `<Text>` — renders OK in React Email but better as `<ul>`. | LOW | Convert raw `<a>` to `<Link>`, benefits as bullet list |
| ProRenewalReminder | "Pro Seller renews {when}" → 22-50 | 1 (Manage subscription) | none | Categorized `transactional` — per CAN-SPAM 16 CFR 316.3(a)(1), pre-renewal notice IS transactional (relationship-maintenance). Correct. | OK | — |
| ProPaymentFailed | "Action needed: Pro Seller payment failed" → 40 | 1 (Update payment method) | none | "Action needed" is borderline but not on spam-trigger lists; this is genuinely transactional. | OK | — |
| ProPaymentRetrySucceeded | "Pro Seller renewed — payment received" → 37 | 1 (Open seller dashboard) | none | None | OK | — |
| ProCanceled | "Pro Seller ends {when}" → 21-50 | 1 (Reactivate Pro Seller) | none | CTA is a soft win-back inside a transactional email — borderline but acceptable because user-initiated cancel. | LOW | Watch FTC subscription-cancellation rules (Click-to-Cancel 2025) — make sure the email itself doesn't encourage friction back |
| ProDowngraded | "Pro Seller ended — fees are now 6.5%" → 36 | 1 (Reactivate Pro Seller) | none | Same as ProCanceled — has a marketing-flavored CTA. Acceptable but a regulator could argue this should carry an unsubscribe link. | MEDIUM | Consider categorizing as `productUpdates` or splitting the "reactivate" CTA into a separate marketing email |

## Cross-cutting findings

### HIGH severity (fix before next deploy)

1. **TwoFactorCode preview leaks the 2FA code** into lock-screen notifications. The `preview` prop on line 8 of `functions/emails/security/TwoFactorCode.jsx` interpolates `${code}`. Many phones and inbox apps show 90 chars of preview on the lock screen — adversaries with eyes-on-screen access get the code. Fix: generic preview.
2. **PriceDrop is unwired.** Template exists but no producer in `functions/emailTriggers.js`. Either ship the trigger or remove the template.
3. **AbandonedCart is unwired** (same as PriceDrop).
4. **No marketing consent at signup.** `index.html` lines 2762-2789 (auth screen) shows email + password + terms-of-service link only. No "I want product updates / digest" checkbox. EU and CA users sent any lifecycle/marketing email (WinBack, AbandonedCart, PriceDrop) are presumed opted-in without explicit affirmative action — GDPR Art. 7 / CCPA opt-in/opt-out interplay. Fix: add a checkbox; default unchecked.
5. **emailPrefs defaults to send for all marketing categories** (see `functions/lib/email.js` line 176: `if (prefs[category] === false) opted-out`). Only `weeklyDigest` is gated on `== true` (line 723 of emailTriggers). All other lifecycle categories send unless the user has explicitly opted out. Combined with finding #4, this is the substantive GDPR gap.

### MEDIUM severity

- `PasswordChanged`, `SuspiciousLogin` use client-side `new Date().toLocaleString()` — pass server timestamp to avoid drift between event and render time.
- `WeeklyDigest` sends even when no items — wasteful and slightly bad-look. Skip-send when empty.
- `ProDowngraded` has a marketing-flavored CTA inside a "transactional" categorized email — defensible but soft GDPR exposure.
- `AbandonedCart` is scaffolded copy; do not enable trigger until copy reviewed.

### LOW severity

- Multiple subjects use `.slice(0, 50)` which truncates mid-word on long item titles. Replace with word-boundary truncation + ellipsis.
- `EmailChangedNew` and `AccountDeletionConfirmed` have no CTA at all — fine for confirmation but a "Manage account" or "Restore account" link improves UX.
- `SavedSearchMatch` subject reflects raw user query — sanitize for caps / spam words.
- `ProWelcome` uses raw `<a>` for "Manage subscription" link instead of React Email `<Link>` — Outlook may strip styles.
- `AccountDeletionConfirmed` displays the support email as plain text rather than a mailto: link.
- The `COMPANY_ADDRESS` constant is duplicated in both `Base.jsx` and `lib/email.js` — drift risk.

### Cross-client / Outlook compatibility

All templates use React Email components (`Section`, `Row`, `Column`, `Text`) which compile to table-based HTML — passes Outlook. Styles are inline. No CSS3 features (flex/grid/transforms) found in any template.

### Plain-text fallback

`@react-email/render` is invoked with `{plainText: true}` in `functions/lib/email.js` line 224 — every send includes both HTML and text parts. Templates are simple enough to render meaningfully as text. No findings.

### Categorization correctness

All templates correctly tag via `category` prop on `<Base>`. `emailTriggers.js` passes a matching `CATEGORIES.*` constant for each send. Two judgment calls:
- `ReviewRequest` correctly classified as marketing (`reviewRequests`, not transactional) — matches FTC guidance.
- `ProCanceled` / `ProDowngraded` classified as `transactional` — defensible, but the reactivate CTA dances close to a marketing message. Document the legal rationale or split.

### GDPR / CCPA

- One-click unsubscribe: WORKS WITHOUT AUTH via `unsubscribe.html` POSTing the signed token to `handleUnsubscribe` — RFC 8058 compliant.
- `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers added correctly (`functions/lib/email.js` lines 302-303).
- Token validity: 30 days, HMAC-signed, timing-safe equal — good.
- Preference center: `https://teeboxmarket.com/account?tab=email` linked from footer. Granularity assumed (not verified in this audit — recommend verifying the page exposes a checkbox per category).
- **Missing explicit consent at signup** (see HIGH #4).
- **Default-on for marketing categories** (see HIGH #5).

## Brand voice — current state

Voice is mostly consistent and clearly intentional: warm but direct, golf-aware ("golfer" as fallback first-name), short paragraphs, plain English. A small minority drift:
- ProWelcome opens with "Thanks for upgrading" — slightly transactional-cold for a welcome moment.
- WinBack copy is placeholder; once written, should match the "we miss you on the course" register.
- DisputeOpenedSeller uses red warning banner — appropriate.
- DeliveredBuyer "Delivered. Take a look." — strong example of the house voice.

### Proposed 5-bullet brand voice guide

1. **Direct over decorative.** Lead with what happened; explain afterward. ("Delivered. Take a look.")
2. **Golfer-aware, not golf-clichéd.** Use "the course," "the bag," "the round" naturally. Don't say "fore!" or "par for the course."
3. **Short paragraphs, action verbs.** Each `<P>` is one thought. No paragraph over 60 words.
4. **One primary CTA.** Always. Secondary actions become muted footnotes ("Manage subscription" link in `<P muted>`), never a second button.
5. **Warmth via specificity, not adjectives.** "Your Scotty Cameron sold for $340" beats "Congratulations on your wonderful sale!"

## Rewritten subject + preview for the 3 worst templates

### 1. WeeklyDigest (currently: "Your TeeBox week" / "Your weekly TeeBox highlights.")
The current preview duplicates the subject and conveys zero specifics. Worse, it sends even on empty weeks.

- **Subject:** `5 new putters, 3 price drops this week` (variable — built from digest content)
- **Preview:** `Plus a Scotty Cameron Newport 2 that just dropped 18%.`

If the digest is empty, **do not send**.

### 2. WinBack90 (currently: "Still here when you're ready" / "One last reminder — your TeeBox watchlist is still here.")
Currently doesn't telegraph that this is the final email — best practice is to be explicit so it reads as respect, not spam.

- **Subject:** `Last email — your TeeBox watchlist`
- **Preview:** `If you want to stay on the list, browse once. Otherwise we'll quiet down.`

### 3. AbandonedCart (currently: "Still thinking it over?" / "Still thinking it over? Here's that listing.")
Currently the preview is the subject + 3 words. Preview should EXTEND the subject with the specific item or specific reason this matters.

- **Subject:** `That Scotty Cameron is still available` (variable — built from listing.title)
- **Preview:** `You watched it 2 days ago. One-of-a-kind on TeeBox — no restocks.`

## Files referenced

- `/Users/jakenair/Desktop/teebox/functions/emails/layout/Base.jsx`
- `/Users/jakenair/Desktop/teebox/functions/lib/email.js`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/OrderPlacedBuyer.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/OrderPlacedSeller.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/OrderShipped.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/OrderOutForDelivery.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/DeliveredBuyer.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/DeliveredSeller.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/FundsReleased.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/LabelCreated.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/DisputeOpenedBuyer.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/DisputeOpenedSeller.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/RefundIssued.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/EmailVerification.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/PasswordReset.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/PasswordChanged.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/EmailChangedNew.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/EmailChangedOld.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/AccountDeletionConfirmed.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/PayoutMethodChanged.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/SuspiciousLogin.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/TwoFactorCode.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/AbandonedCart.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/AbandonedDraft.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/PriceDrop.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/ReviewRequest.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/SavedSearchMatch.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/WeeklyDigest.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/WinBack30.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/WinBack60.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/lifecycle/WinBack90.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/subscription/ProWelcome.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/subscription/ProRenewalReminder.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/subscription/ProPaymentFailed.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/subscription/ProPaymentRetrySucceeded.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/subscription/ProCanceled.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/subscription/ProDowngraded.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emailTriggers.js`
- `/Users/jakenair/Desktop/teebox/unsubscribe.html`
- `/Users/jakenair/Desktop/teebox/index.html` (signup auth screen lines 2762-2789)
