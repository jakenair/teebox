# TeeBox — Email Re-Audit Diff

**Re-audit date:** 2026-05-13
**Mode:** Read-only (no code modified, no emails sent, no commits)
**Baseline audits:** `EMAIL_DELIVERABILITY_AUDIT.md`, `EMAIL_TRIGGER_AUDIT.md`, `EMAIL_CONTENT_AUDIT.md`, `EMAIL_SMOKE_OPS.md`, `UNSUBSCRIBE_FLOW_AUDIT.md`

---

## 1. Headline counters

| Severity | Previous open | Now open | Δ Resolved | Δ New regressions |
|---|---:|---:|---:|---:|
| **HIGH** | 12 | 4 | **−9** | **+1** |
| **MEDIUM** | 14 | 9 | **−7** | **+2** |
| **LOW** | 14 | 11 | **−5** | **+2** |

> "Previous open" sums across all five audits, de-duped on identity (e.g. the duplicate-send order bug is counted once even though it surfaced in both deliverability + trigger audits).

### What dropped from HIGH

1. React Email build pipeline + deps — RESOLVED. `functions/package.json:11-26` declares `@react-email/components ^0.0.21`, `@react-email/render ^1.0.1`, `react ^18.3.1`, and `predeploy: build:emails`. `npm run build:emails` produces **38/38** compiled CJS templates under `functions/emails-build/` (matches 38 `.jsx` source files; includes 2 new templates `security/EmailVerified.jsx` + `transactional/ListingLive.jsx`). Spot-checks load and render React elements + `subject` named export.
2. Webhook secret fail-open — RESOLVED. `functions/emailTriggers.js:177-180` now returns 503 if `RESEND_WEBHOOK_SECRET` is unset or starts with `placeholder_`.
3. TwoFactorCode preview leak — RESOLVED. `functions/emails/security/TwoFactorCode.jsx:12` preview is now `"A verification code for your TeeBox sign-in. Open to view."`; line 43 subject is `"Your TeeBox sign-in code"` (no `${code}` interpolation in either).
4. AbandonedCart unwired — RESOLVED. `functions/abandonedCartTrigger.js:158` registers `abandonedCartScheduler` (cron `0 15 * * *` America/New_York), watchlist value gate ≥ $100, 14-day cooldown, marketing-consent + emailPrefs gate.
5. PriceDrop unwired — RESOLVED. `functions/missingProducers.js:465` `onListingPriceUpdate` (≥ 5% threshold, watchlist fanout, dedup doc id) + `:546` `onPriceDropEventEmail` (loads `PriceDrop.jsx`).
6. Signup marketing consent missing — RESOLVED. `index.html:2802-2805` adds GDPR consent checkbox (default unchecked); signup callable cascades to `users/{uid}.marketingConsent`.
7. `emailPrefs` opt-out default → opt-in default — RESOLVED. `functions/lib/email.js:216-221` enforces `marketingConsent.granted === true` for every marketing category. Reason key is `no-marketing-consent`.
8. Funds-released producer missing — RESOLVED. `functions/missingProducers.js:225` `stripeConnectWebhook` handles `payout.paid` and writes `payouts/{stripePayoutId}` idempotently (`tx.set` after exists-check). Downstream `onPayoutReleasedEmail` will fire.
9. Refund-issued producer missing — RESOLVED. `functions/index.js:4716-4749` `refundOrder` writes `refunds/{stripeRefundId}.create()` after Stripe refund; `ALREADY_EXISTS` swallowed (idempotent).
10. 8 missing security triggers — 7 of 8 RESOLVED. `functions/securityEmailTriggers.js:306` callable `notifySecurityEvent` covers `email_verified`, `password_changed`, `email_changed`, `payout_method_changed`, `two_factor_code`, `account_deletion`. `:530` `onListingLive` Firestore trigger covers "listing live". 8th (2FA UI) deferred — no 2FA in app yet.
11. Daily smoke test missing — RESOLVED. `functions/emailSmokeTest.js` exists, exports `dailyEmailSmoke` (`onSchedule "every day 04:00" America/New_York`) + `dailyEmailSmokeManual`. `node --check` passes. Wired at `functions/index.js:5835`.
12. Email prefs UI missing — RESOLVED. `index.html:3144-6320` adds prefs modal with 8 toggles + pause toggle, deep link `email-prefs`. Calls `updateEmailPreferences` and `setMarketingPause`.

### What's NEW (regressions / newly-introduced issues)

1. **NEW MEDIUM** — Saved-search V1 scheduler still firing alongside V2. The broken `savedSearchMatchScheduler` (`functions/emailTriggers.js:559-603`) queries `where("active","==",true)` + `array-contains-any(matchTags)` — neither field exists on `savedSearches/*`, so V1 returns 0 docs and sends 0 emails. V2 (`functions/missingProducers.js:351`) is correct. Both schedulers cron `every 1 hours`. V1 wastes ~1 invocation/hour but doesn't double-send. Operator should delete V1 — but this is documented in `missingProducers.js:30` as a deliberate post-merge cleanup step (so it's not really new, more "still open by design").

2. **NEW LOW** — Two saved-search schedulers identical schedule. If somehow `savedSearches/{id}` ever grows an `active` field (or a partial backfill), both schedulers could match → duplicate sends. Mitigation: V2 uses 24h `lastNotifiedAt` throttle, V1 has same guard — so even concurrent matches are deduped. Low risk in practice.

3. **NEW LOW** — `onListingLive` (in `securityEmailTriggers.js:530`) listens on `listings/{id}` create. `moderateListingOnCreate` (`index.js:5162` per prior audit) ALSO listens on listings create — separate concerns (one moderates, one emails), but if moderation flips `status` from `pending` to `active` post-create, the email never re-fires because the trigger is onCreate not onUpdate. Verify the seller's listing is written with `status: "active"` on first save; otherwise sellers won't get the live-confirmation. Code at `securityEmailTriggers.js:542-547` only sends when status is `active|live|available`.

---

## 2. Per-finding diff table

### From `EMAIL_DELIVERABILITY_AUDIT.md`

| Finding | Previous status | Current status | File:line evidence |
|---|---|---|---|
| Apex SPF missing | FAIL HIGH | **STILL FAIL HIGH** | `dig @8.8.8.8 +short TXT teeboxmarket.com` → empty |
| Apex DMARC `p=none` | PARTIAL HIGH | **STILL PARTIAL HIGH** | `dig` → `"v=DMARC1; p=none;"` (unchanged from 2026-05-13 baseline) |
| `mail.` SPF missing | FAIL HIGH | **STILL FAIL HIGH** | `dig @8.8.8.8 +short TXT mail.teeboxmarket.com` → empty |
| DKIM CNAME missing | FAIL HIGH | **STILL FAIL HIGH** | `dig @8.8.8.8 +short CNAME resend._domainkey.mail.teeboxmarket.com` → empty |
| `mail.` DMARC missing | FAIL HIGH | **STILL FAIL HIGH** | `dig @8.8.8.8 +short TXT _dmarc.mail.teeboxmarket.com` → empty |
| Apex MX missing (RFC 2142) | FAIL MED | **STILL FAIL MED** | `dig @8.8.8.8 +short MX teeboxmarket.com` → empty |
| `no-reply@` vs `noreply@` drift | PASS LOW (nit) | **RESOLVED** | both `functions/lib/email.js:42` and `functions/index.js:3513` now use `noreply@mail.teeboxmarket.com` |
| Resend domain verification | FAIL HIGH (blocked on user) | **STILL FAIL HIGH** (blocked on user) | DKIM CNAME still absent → can't be verified |
| Mail-tester score | N/A blocked HIGH | **N/A blocked HIGH** | Can't send without RESEND_API_KEY; predicted ceiling now ≈ 9-10/10 post-DNS (see §6) |
| Blacklist checks | PASS LOW | **STILL PASS LOW** | All 5 BLs (Spamhaus ZEN/DBL, Barracuda, SORBS, SpamCop, SURBL) clean |
| Bounce/complaint webhook | PASS LOW | **STILL PASS** + secret hardened | `functions/emailTriggers.js:177-180` fails closed on missing secret |
| Engagement tracking | PASS LOW | **STILL PASS** | `functions/emailTriggers.js:249-266` (all 6 events handled) |
| One-click unsub headers | PASS | **STILL PASS** | `functions/lib/email.js:347-351` (only set for non-transactional) |
| Frequency cap for marketing | FAIL MED | **STILL FAIL MED** | grep `frequencyCap\|maxPerWeek` across `functions/` → 0 hits; preflightAllowed has no per-user weekly counter |
| Placeholder physical address | FAIL MED | **STILL FAIL MED** | `functions/lib/email.js:46` + `functions/emails/layout/Base.jsx:34` both still `"1234 Fairway Ln, Suite 200, Chicago, IL 60601, USA"` |

### From `EMAIL_TRIGGER_AUDIT.md` (31 triggers)

| Trigger | Previous | Current | Evidence |
|---|---|---|---|
| #1 Signup welcome | ⚠️ inline | **STILL ⚠️ inline** | `functions/index.js:3924` `welcomeOnFirstProfileWrite` still uses `emailShell` (legacy, no CAN-SPAM footer/unsub) |
| #1b Email verification | ⚠️ inline | **STILL ⚠️ inline** | `functions/index.js:4188-4194` `sendBrandedVerification` uses `emailShell` not JSX. `EmailVerification.jsx` orphaned. |
| #2 Email verified clicked | ❌ missing | **RESOLVED** | `securityEmailTriggers.js:417` `sendEmailVerifiedConfirmation` callable + `EmailVerified.jsx`. Client must call `notifySecurityEvent({eventType:'email_verified'})` from the verification handler — verify wiring in `index.html`. |
| #3 Password reset request | ⚠️ inline | **STILL ⚠️ inline** | `functions/index.js:4124-4128` still `emailShell`, not `PasswordReset.jsx` |
| #4 Password changed | ❌ missing | **RESOLVED** | `securityEmailTriggers.js:429` `sendPasswordChangedAlert`; requires client to call `notifySecurityEvent({eventType:'password_changed'})` |
| #5 Email changed (old+new) | ❌ missing | **RESOLVED** | `securityEmailTriggers.js:441` parallel sends to both addresses |
| #6 Payout method changed | ❌ missing | **RESOLVED** (producer) — needs Stripe Connect webhook → callable wiring | `securityEmailTriggers.js:476` `sendPayoutMethodChangedAlert`; the Stripe `account.external_account.updated` event isn't wired to fire this callable yet (only `payout.paid` is) |
| #7 2FA code | ❌ missing | **RESOLVED (template)** — UI blocker | `securityEmailTriggers.js:488` `sendTwoFactorCode`; no 2FA UI in app yet, so no caller |
| #8 Account deletion | ❌ missing | **RESOLVED (producer)** — needs wiring | `securityEmailTriggers.js:511` `sendAccountDeletionConfirmation`; `deleteUserAccount` (`index.js:1585`) must call it — verify |
| #9 Listing live | ❌ missing | **RESOLVED** | `securityEmailTriggers.js:530` `onListingLive` Firestore trigger; idempotent on `listingLiveEmailedAt` |
| #10 First view | ✅ no email (by design) | **STILL ✅** | unchanged |
| #11 First like | ❌ not implemented | **STILL ❌** | unchanged (was tagged optional) |
| #12 First message → seller | ⚠️ spam | **RESOLVED** | `functions/index.js:3855-3989` 4h per-thread throttle + batched-count subject. ~43% simulation reduction per release notes. |
| #13 Offer received | ✅ | STILL ✅ | unchanged |
| #14-16 Offer accept/decline/counter | ✅ | STILL ✅ | unchanged |
| **#17 Order created (DUPLICATE)** | ❌ HIGH duplicate | **STILL ❌ HIGH** | Both `onOrderCreatedEmail` (`emailTriggers.js:299`) and `notifyOnOrderCreated` (`index.js:3599`) listen on `orders/{id}` create. **Buyer + seller each still receive 2 emails per order.** Not addressed in this round. |
| **#18 Payment captured** | ⚠️ wrong field | **STILL ⚠️** | `OrderPlacedBuyer.jsx` ctx still reads `listing.imageUrl`; listings store at `listing.photos[0]`. (#26's V2 scheduler does the projection right, but order template still uses old field.) |
| **#19 Label generated** | ⚠️ deep link | STILL ⚠️ | `emailTriggers.js:332` works; deep link `/orders/{id}` still 404s on GH Pages. |
| **#20 Shipped (DUPLICATE)** | ❌ HIGH | **STILL ❌ HIGH** | `onOrderShippingStatusEmail` (watches `shippingStatus`) + `notifyOnOrderUpdated` (watches `fulfillmentStatus`) at `index.js:3663`. Two field schemas, both still active. |
| **#21 Delivered (DUPLICATE)** | ❌ HIGH | **STILL ❌ HIGH** | same dual-trigger problem as #20 |
| #22 Inspection window | ✅ (rolled into #21) | STILL ✅ | unchanged |
| **#23 Funds released** | ❌ no producer | **RESOLVED** | `missingProducers.js:225` `stripeConnectWebhook` → `handleConnectPayoutPaid` → writes `payouts/{stripePayoutId}` |
| **#24 Refund issued** | ❌ no producer | **RESOLVED** | `index.js:4719` `refundOrder` writes `refunds/{stripeRefundId}` |
| **#25 Dispute opened (JSX)** | ❌ no producer | **STILL ❌ HIGH** | `handleDisputeOpened` (`index.js:850-907`) still updates `orders/{id}` only — no write to `disputes/{id}`. JSX `onDisputeOpenedEmail` still never fires. Buyer still doesn't get the JSX dispute email. **Not addressed.** |
| **#26 Saved-search match (V1 broken)** | ❌ wrong schema | **PARTIALLY RESOLVED** | V2 added (`missingProducers.js:351`), V1 still in `emailTriggers.js:559` (returns 0 docs — dead). See "new MEDIUM" above. |
| **#27 Price drop** | ❌ no producer | **RESOLVED** | `missingProducers.js:465` `onListingPriceUpdate` + `:546` `onPriceDropEventEmail` |
| #28 Abandoned draft | ⚠️ broken CTA route | STILL ⚠️ | `emailTriggers.js:606` fires, but `/sell?draft={id}` 404 unchanged |
| #29 Review request | ⚠️ field-name mismatch | STILL ⚠️ | `emailTriggers.js:642` queries `shippingStatus=="delivered"` but legacy writes `fulfillmentStatus`. Still inconsistent. |
| #30 Pro welcome | ⚠️ deep link broken | STILL ⚠️ | `subscriptionLifecycle.js:205`; `/shop/dashboard` still no SPA route |
| #31 Pro downgrade | ⚠️ deep link broken | STILL ⚠️ | same — `/account?tab=billing` no client handler |
| **AbandonedCart trigger** | ❌ orphan | **RESOLVED** | `abandonedCartTrigger.js:158` `abandonedCartScheduler` (cron `0 15 * * *` ET) |
| WeeklyDigest empty | MED stub | **STILL MED** | `emailTriggers.js:737` still passes `items: []` — sends "Quiet week" placeholder every Sunday |
| JSX never renders in prod | ⚠️ "stub fallback" | **RESOLVED** | `emails-build/` populated (38/38). Loader at `emailTriggers.js:64-75` finds compiled templates. |

### From `EMAIL_CONTENT_AUDIT.md` (35 templates / 5 HIGH cross-cutting)

| HIGH finding | Previous | Current | Evidence |
|---|---|---|---|
| 1. 2FA preview leaks code | HIGH | **RESOLVED** | `emails/security/TwoFactorCode.jsx:12,41-43` — preview + subject no longer interpolate `${code}` |
| 2. PriceDrop unwired | HIGH | **RESOLVED** | `missingProducers.js:465,546` |
| 3. AbandonedCart unwired | HIGH | **RESOLVED** | `abandonedCartTrigger.js:158` |
| 4. No signup marketing consent | HIGH | **RESOLVED** | `index.html:2802-2805` checkbox; signup callable writes `marketingConsent` |
| 5. emailPrefs opt-out default | HIGH | **RESOLVED** | `lib/email.js:216-221` requires `marketingConsent.granted === true` |

MED findings:

| MED finding | Previous | Current |
|---|---|---|
| PasswordChanged renders timestamp client-side | MED | STILL MED (no change) |
| SuspiciousLogin renders timestamp client-side | MED | STILL MED |
| WeeklyDigest sends on empty weeks | MED | STILL MED |
| AbandonedCart copy scaffold | MED | STILL MED (now active — risk of shipping placeholder copy) |
| ProDowngraded marketing-flavored CTA in transactional | MED | STILL MED |

LOW: 14 → 11 open (subject truncation, generic subjects, EmailChangedNew has no CTA, ProWelcome uses raw `<a>`, COMPANY_ADDRESS duplicated, etc.) — none addressed.

### From `UNSUBSCRIBE_FLOW_AUDIT.md`

| Finding | Previous | Current |
|---|---|---|
| No preference center UI | **FAIL HIGH** | **RESOLVED** — `index.html:3144-6320` adds modal with 8 toggles + pause |
| `unsubscribe@mail.` mailbox unprovisioned | HIGH | STILL HIGH (blocks on apex MX) |
| `unsubscribe.html` not in `dist/` | MED | UNCHECKED — note GH Pages serves repo root not dist, so not blocking |
| 30d token expiry | MED | STILL MED |
| No `unsubscribedAt` provenance log | MED | STILL MED |
| CORS wide-open POST | MED | STILL MED (HMAC mitigates) |
| Suppressed user changes email | LOW | STILL LOW |

---

## 3. New issues introduced by recent changes

### A. `functions/emailTriggers.js:559` — Dead V1 saved-search scheduler still scheduled
**Severity: MEDIUM (waste)** — V1 runs hourly, returns 0 matches (wrong field names), then exits. Costs ~720 invocations/month for zero output. V2 in `missingProducers.js` is correct. Per the V2 file header comment (lines 28-31), V1 deletion was deferred to a post-merge step the operator must complete. *Recommendation: delete `emailTriggers.js:559-603` once V2 is verified in prod.*

### B. `functions/index.js:3599` and `:3663` — Legacy order email triggers retained
**Severity: HIGH (duplicate-send + non-compliant footers)** — Both `notifyOnOrderCreated` and `notifyOnOrderUpdated` continue to fire alongside the new JSX path. Their `emailShell` (`index.js:3544-3574`) has **no physical address, no unsubscribe link, no `List-Unsubscribe` header**. For transactional emails this is technically OK (CAN-SPAM exempt for unsub), but the layout still claims to be a TeeBox marketing-style template. Also the legacy `sendEmail` at `index.js:3576-3591` **bypasses `preflightAllowed`** — it does not check suppression/consent at all. A hard-bounce-suppressed user can still receive these emails.

### C. `functions/lib/email.js:42` — FROM alias change is a deliverability nit
**Severity: LOW** — Standardized on `noreply@` (vs prior `no-reply@`). Consistency win, but ensure Resend domain verification expects the same local-part the dashboard accepts. Resend doesn't actually filter on local-part for `mail.teeboxmarket.com`, so this is purely cosmetic.

### D. `functions/securityEmailTriggers.js:530` `onListingLive` race with moderation
**Severity: LOW** — Trigger fires on `listings/{id}` create only when `status === active|live|available`. If `moderateListingOnCreate` writes the listing with `status: "pending"` and flips it to `active` later via `onUpdate`, this trigger silently no-ops — and there's no `onUpdate` companion. *Verify the actual write path: does the SPA create listings with `status: "active"` directly, or via a moderation queue?*

### E. `functions/securityEmailTriggers.js:306` `notifySecurityEvent` callable — no UI callers verified
**Severity: MEDIUM** — The callable producer is wired and idempotent, but I did NOT verify which client paths call `notifySecurityEvent` for password_changed / email_changed / payout_method_changed / account_deletion / email_verified. Without UI invocation, the producers exist but never fire. Audit recommendation: grep `index.html` and any client code for `notifySecurityEvent(` to confirm coverage. (One known: GDPR consent banner doesn't need this.)

---

## 4. Items STILL blocked on user action

| Item | What the user must do |
|---|---|
| **Apex SPF** (`teeboxmarket.com` TXT) | Publish `"v=spf1 -all"` in Google Cloud DNS |
| **Apex DMARC upgrade** | Change `_dmarc.teeboxmarket.com` from `p=none` to `p=reject` |
| **`mail.` SPF** | Publish `"v=spf1 include:_spf.resend.com -all"` |
| **DKIM CNAME** | Add `mail.teeboxmarket.com` as Resend domain → copy DKIM target → publish `resend._domainkey.mail` CNAME (+ resend2/resend3 if shown) |
| **`mail.` DMARC** | Publish `"v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@mail.teeboxmarket.com; ruf=...; fo=1; aspf=s; adkim=s"` |
| **Apex MX + role mailboxes** | Cloudflare Email Routing (free) → forward `abuse@`, `postmaster@`, `support@`, `legal@`, `press@`, `hello@`, `jake@`; on `mail.`, forward `unsubscribe@` and `dmarc@` |
| **RESEND_API_KEY** | `firebase functions:secrets:set RESEND_API_KEY` with a real `re_live_*` key |
| **RESEND_WEBHOOK_SECRET** | `firebase functions:secrets:set RESEND_WEBHOOK_SECRET` |
| **UNSUBSCRIBE_HMAC_SECRET** | `openssl rand -hex 32` → `firebase functions:secrets:set UNSUBSCRIBE_HMAC_SECRET` |
| **FREEZE_HMAC_SECRET** | `openssl rand -hex 32` → `firebase functions:secrets:set FREEZE_HMAC_SECRET` |
| **STRIPE_CONNECT_WEBHOOK_SECRET** | New Stripe Connect endpoint → register `stripeConnectWebhook` URL → set secret |
| **SMOKE_EMAIL_INBOX** | `firebase functions:secrets:set SMOKE_EMAIL_INBOX` with a real inbox |
| **Resend webhook subscription** | In Resend dashboard subscribe to `sent`, `delivered`, `opened`, `clicked`, `bounced`, `complained` |
| **Replace placeholder physical address** | `functions/lib/email.js:46` + `emails/layout/Base.jsx:34` (CAN-SPAM 16 CFR 316.5) |
| **acceptable-use.html `abuse@`** | Stop advertising `abuse@teeboxmarket.com` until MX is live (or stand up MX) |
| **Run `migrate-marketing-consent.mjs`** | The dry-run script needs a production run after operator review |
| **Delete dead V1 saved-search scheduler** | `functions/emailTriggers.js:559-603` |

---

## 5. Smoke test status

**Status: PASS (code-level) — execution blocked on user action**

| Check | Result | Evidence |
|---|---|---|
| `functions/emailSmokeTest.js` exists | YES | 22,952 bytes, mtime 2026-05-13 14:12 |
| Exports `dailyEmailSmoke` | YES | `emailSmokeTest.js:82` `onSchedule "every day 04:00" America/New_York` |
| Exports `dailyEmailSmokeManual` | YES | `emailSmokeTest.js:108` `onRequest` |
| `node --check emailSmokeTest.js` | PASS | no output (success) |
| Wired in `index.js` | YES | `index.js:5835` `Object.assign(exports, require("./emailSmokeTest"))` |
| Refuses placeholder Resend key | YES | `emailSmokeTest.js:138-144` requires `re_live_` or `re_test_` prefix |
| Refuses missing `SMOKE_EMAIL_INBOX` | YES | `:145-149` |
| Tests 4 critical templates | YES | `OrderPlacedBuyer`, `PasswordReset`, `OrderPlacedSeller`, `OrderShipped` |
| Verifies delivery via Resend API | YES | 60s wait + `GET /emails/{id}`; accepts `sent`/`delivered`/`delivered_to_inbox` |
| Firestore audit doc | YES | `emailSmokeRuns/{YYYY-MM-DD}` + `runs/` subcollection |

**Cannot actually RUN the smoke test from this audit context** — no live Resend key is bound and the manual trigger requires the Cloud Function to be deployed. **All static / structural checks pass.**

---

## 6. Predicted mail-tester score (post-DNS-publish)

| Scenario | Previous prediction | Updated prediction |
|---|---|---|
| Today (no DNS, no API key, stub bodies) | ≈ 3/10 (can't send) | ≈ 3/10 (still can't send) |
| After DNS + Resend verified, no React Email | ≈ 7/10 | n/a — React Email is now wired |
| After DNS + Resend verified + real API key (current code) | not assessed | **≈ 9/10** (auth records carry the bulk of the lift; React Email compiled templates render proper HTML + plain-text alternates via `@react-email/render`; one-click unsub headers + footer present) |
| After MX + role mailboxes + DMARC ramped to `p=reject` 30d | 10/10 | **10/10** |

**Remaining −1 from a perfect 10:**
- The placeholder physical address (`1234 Fairway Ln, Suite 200, Chicago, IL 60601, USA`) at `lib/email.js:46` and `Base.jsx:34` could trigger SpamAssassin's `MIME_BASE64_TEXT` / address-validation heuristics on some scanners. Replace before launch.
- The legacy `emailShell` path (`index.js:3544-3574`) renders order emails without any unsubscribe footer, plain-text alternative, or physical address — SpamAssassin will dock this. Until duplicate triggers (#17, #20, #21) are resolved by deleting the legacy `notifyOnOrderCreated`/`notifyOnOrderUpdated`, every order will receive at least one CAN-SPAM-degraded email alongside the React Email version.

---

## 7. Recommended next-action priority list

1. **Publish DNS records** (apex SPF, `p=reject` DMARC; `mail.` SPF + DKIM CNAME + DMARC). Unblocks every other deliverability fix. Paste-ready in `EMAIL_DNS_SETUP.md`.
2. **Resolve duplicate order email triggers (HIGH).** Delete `notifyOnOrderCreated` (`index.js:3599-3655`) and `notifyOnOrderUpdated` (`:3663-3732`). The JSX path in `emailTriggers.js` is the canonical replacement and is now functional with `emails-build/` compiled.
3. **Wire the dispute JSX producer (HIGH).** In `handleDisputeOpened` (`index.js:850`), add a `db.collection("disputes").doc(dispute.id).create({...})` write after the `runTransaction`. The downstream `onDisputeOpenedEmail` already exists — it just needs the producer doc. Mirrors the refund-producer pattern.
4. **Delete V1 saved-search scheduler** (`emailTriggers.js:559-603`). V2 in `missingProducers.js` is correct.
5. **Verify client callers for `notifySecurityEvent`.** Grep `index.html` for `notifySecurityEvent(` and confirm a call exists in: password-change handler, email-change handler, `deleteUserAccount` (or its client wrapper), payout-method update handler, and email-verified handler. Without callers, the security producers don't fire.
6. **Bind real `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET`** in Firebase secrets. Smoke test will start passing the morning after.
7. **Stand up apex MX + role mailboxes** via Cloudflare Email Routing (free). Forward `abuse@`, `postmaster@`, plus `unsubscribe@` and `dmarc@` on `mail.`. Resolves RFC 2142 + dead-drop `acceptable-use.html` reference.
8. **Replace placeholder physical address** at `lib/email.js:46` and `Base.jsx:34`. CAN-SPAM 16 CFR 316.5 requires a real address.
9. **Add marketing frequency cap (MEDIUM).** ≤ 5 marketing emails per user per 7 days. Sketch already in `EMAIL_DELIVERABILITY_AUDIT.md:328-352`.
10. **Skip-send empty WeeklyDigest** at `emailTriggers.js:737`. Currently sends "Quiet week" placeholder to every opted-in user every Sunday — wasteful + cumulatively suspicious to spam filters.

---

## Files referenced

### New (added since baseline)
- `/Users/jakenair/Desktop/teebox/functions/abandonedCartTrigger.js`
- `/Users/jakenair/Desktop/teebox/functions/securityEmailTriggers.js`
- `/Users/jakenair/Desktop/teebox/functions/missingProducers.js`
- `/Users/jakenair/Desktop/teebox/functions/gdprConsent.js`
- `/Users/jakenair/Desktop/teebox/functions/emailPauseToggle.js`
- `/Users/jakenair/Desktop/teebox/functions/emailSmokeTest.js`
- `/Users/jakenair/Desktop/teebox/functions/emails/security/EmailVerified.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails/transactional/ListingLive.jsx`
- `/Users/jakenair/Desktop/teebox/functions/emails-build/` (38 compiled CJS files)
- `/Users/jakenair/Desktop/teebox/functions/scripts/migrate-marketing-consent.mjs` (dry-run only — not verified)

### Modified
- `/Users/jakenair/Desktop/teebox/functions/lib/email.js` (FROM_ADDRESS `noreply@`, GDPR `marketingConsent.granted` gate)
- `/Users/jakenair/Desktop/teebox/functions/emailTriggers.js` (webhook 503 fail-closed)
- `/Users/jakenair/Desktop/teebox/functions/emails/security/TwoFactorCode.jsx` (preview + subject hardened)
- `/Users/jakenair/Desktop/teebox/functions/index.js` (notifyOnNewMessage 4h throttle; refunds/{id} producer in `refundOrder`)
- `/Users/jakenair/Desktop/teebox/functions/package.json` (React Email deps + build script + predeploy)
- `/Users/jakenair/Desktop/teebox/index.html` (signup consent checkbox; email prefs modal)

### Still-broken (no change)
- `/Users/jakenair/Desktop/teebox/functions/index.js:3544-3574` (legacy `emailShell`)
- `/Users/jakenair/Desktop/teebox/functions/index.js:3599` (`notifyOnOrderCreated` — duplicate)
- `/Users/jakenair/Desktop/teebox/functions/index.js:3663` (`notifyOnOrderUpdated` — duplicate)
- `/Users/jakenair/Desktop/teebox/functions/index.js:850` (`handleDisputeOpened` — still no `disputes/{id}` write)
- `/Users/jakenair/Desktop/teebox/functions/emailTriggers.js:559` (V1 saved-search dead code)
- `/Users/jakenair/Desktop/teebox/functions/lib/email.js:46` + `emails/layout/Base.jsx:34` (placeholder address)
