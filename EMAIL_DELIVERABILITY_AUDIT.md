# TeeBox — Email Deliverability Audit

**Audit date:** 2026-05-13
**Production root domain:** `teeboxmarket.com`
**Sending subdomain:** `mail.teeboxmarket.com`
**ESP:** Resend (`functions/lib/email.js`)
**API key status:** `RESEND_API_KEY` not yet bound to a real Resend key (placeholder).
**DNS host:** Google Cloud DNS (`ns-cloud-e[1-4].googledomains.com`) — Squarespace-acquired Google Domains zone.
**Read-only audit:** no code modified, no emails sent.

---

## TL;DR — 9-row status

| # | Audit | Status | Severity | One-line finding |
|---|-------|--------|----------|------------------|
| 1 | DNS (SPF / DKIM / DMARC, apex + `mail.`) | **FAIL** | HIGH | Only a permissive apex DMARC (`p=none`) is published — no SPF anywhere, no DKIM, no `mail.` DMARC. Inbox-bound mail will fail authentication. |
| 2 | Sending-subdomain separation | **PASS** | LOW | `FROM`/`List-Unsubscribe`/aggregator all use `mail.teeboxmarket.com`. Apex stays clean. Only nit: `no-reply@` vs `noreply@` alias drift between two sending paths. |
| 3 | Resend domain verification | **FAIL** | HIGH | Cannot probe Resend (no API key) but DNS proves the DKIM CNAME has not been added. Resend will refuse to send until verified. |
| 4 | Mail-tester score | **N/A (blocked)** | HIGH | Cannot send through mail-tester without API key. Predicted current ceiling ≈ **3/10**; after fixes ≈ **9–10/10**. |
| 5 | Blacklist checks (apex IPs + domain) | **PASS** | LOW | All 4 GitHub Pages IPs (185.199.108-111.153) and both domains are clean on Spamhaus ZEN/DBL, Barracuda, SORBS, SpamCop, SURBL. No `mail.` IP yet (no MX). |
| 6 | RFC 2142 mailboxes (`abuse@`, `postmaster@`) | **FAIL** | MEDIUM | No MX on apex → `abuse@`/`postmaster@` do not resolve. `acceptable-use.html` advertises `abuse@teeboxmarket.com` publicly, so this is doubly broken. |
| 7 | Bounce + complaint webhooks | **PASS** | LOW | `resendWebhook` handles `email.bounced` (hard → suppress) and `email.complained` (→ suppress + complaint doc) with svix-signature verification. |
| 8 | Engagement tracking (delivered/opened/clicked) | **PASS** | LOW | All 4 events handled; `aggregateEmailMetrics` cron rolls them up. Runbook is missing the Resend-side webhook-subscription checklist. |
| 9 | RFC 8058 one-click unsubscribe + marketing rules | **PARTIAL** | MEDIUM | `List-Unsubscribe` + `List-Unsubscribe-Post` headers correct; transactional correctly excluded; **no frequency cap** on marketing sends. |

---

## 1. DNS records — `dig` evidence

All queries against Google Public DNS (`@8.8.8.8`) on 2026-05-13.

```bash
$ dig @8.8.8.8 +short MX teeboxmarket.com
(empty)

$ dig @8.8.8.8 +short A teeboxmarket.com
185.199.109.153
185.199.110.153
185.199.108.153
185.199.111.153

$ dig @8.8.8.8 +short TXT teeboxmarket.com
(empty)                                           # ← apex SPF MISSING

$ dig @8.8.8.8 +short TXT _dmarc.teeboxmarket.com
"v=DMARC1; p=none;"                               # ← apex DMARC too permissive

$ dig @8.8.8.8 +short TXT mail.teeboxmarket.com
(empty)                                           # ← mail SPF MISSING

$ dig @8.8.8.8 +short CNAME resend._domainkey.mail.teeboxmarket.com
(empty)                                           # ← DKIM CNAME MISSING

$ dig @8.8.8.8 +short TXT _dmarc.mail.teeboxmarket.com
(empty)                                           # ← mail DMARC MISSING

$ dig @8.8.8.8 +short NS teeboxmarket.com
ns-cloud-e1.googledomains.com.
ns-cloud-e2.googledomains.com.
ns-cloud-e3.googledomains.com.
ns-cloud-e4.googledomains.com.
```

### Status per record

| Record | Expected | Actual | Status | Severity |
|---|---|---|---|---|
| `teeboxmarket.com` SPF (TXT) | `v=spf1 -all` (hardline — apex doesn't send) | absent | **FAIL** | HIGH — spoofers can ride apex |
| `_dmarc.teeboxmarket.com` | `v=DMARC1; p=reject; rua=...` | `v=DMARC1; p=none;` | **PARTIAL** | HIGH — no enforcement, no aggregate reporting; published but defanged |
| `mail.teeboxmarket.com` SPF | `v=spf1 include:_spf.resend.com -all` | absent | **FAIL** | HIGH — Resend cannot SPF-align |
| `resend._domainkey.mail.teeboxmarket.com` (CNAME) | Resend-managed DKIM host | absent | **FAIL** | HIGH — no DKIM signature → mail.teeboxmarket.com sends will be DMARC-rejected by every major receiver |
| `_dmarc.mail.teeboxmarket.com` | `v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@mail.teeboxmarket.com; ruf=...; fo=1; aspf=s; adkim=s` | absent | **FAIL** | HIGH — no DMARC policy on the actual sending host |
| `teeboxmarket.com` MX | none required, but blocks RFC 2142 mailboxes when absent | absent | **PARTIAL** | MEDIUM (see Audit 6) |

### Fix (paste-ready) — Google Cloud DNS records

`EMAIL_DNS_SETUP.md` already has the canonical template (lines 18–62). Verbatim, into the Google Cloud DNS zone for `teeboxmarket.com`:

```
;; APEX
@                                IN TXT  "v=spf1 -all"
_dmarc                           IN TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@mail.teeboxmarket.com"

;; SENDING SUBDOMAIN
mail                             IN TXT  "v=spf1 include:_spf.resend.com -all"
_dmarc.mail                      IN TXT  "v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@mail.teeboxmarket.com; ruf=mailto:dmarc@mail.teeboxmarket.com; fo=1; aspf=s; adkim=s"

;; DKIM — replace <RESEND-DKIM-HOST> with the EXACT value Resend's dashboard
;; shows after you add `mail.teeboxmarket.com` as a domain.
resend._domainkey.mail           IN CNAME <RESEND-DKIM-HOST>.resend.com.
;; Resend may also issue resend2._domainkey + resend3._domainkey — add ALL.
```

Verification:
```bash
dig @8.8.8.8 +short TXT teeboxmarket.com                              # should show "v=spf1 -all"
dig @8.8.8.8 +short TXT _dmarc.teeboxmarket.com                       # should show p=reject
dig @8.8.8.8 +short TXT mail.teeboxmarket.com                         # should show resend include
dig @8.8.8.8 +short CNAME resend._domainkey.mail.teeboxmarket.com     # should resolve to Resend host
dig @8.8.8.8 +short TXT _dmarc.mail.teeboxmarket.com                  # should show p=quarantine
```

---

## 2. Sending-subdomain separation

| Item | Location | Value | Status |
|---|---|---|---|
| `FROM_ADDRESS` (lib/email.js) | `functions/lib/email.js:42` | `no-reply@mail.teeboxmarket.com` | PASS |
| `FROM_NAME` | `functions/lib/email.js:41` | `TeeBox` | PASS |
| Legacy `FROM_EMAIL` (index.js inline sender) | `functions/index.js:3513` | `TeeBox <noreply@mail.teeboxmarket.com>` | PASS (subdomain) / nit (alias drift) |
| `List-Unsubscribe` mailto | `functions/lib/email.js:302` | `mailto:unsubscribe@mail.teeboxmarket.com?subject=unsubscribe-{cat}` | PASS |
| DMARC `rua=` aggregator | `EMAIL_DNS_SETUP.md:37,61` | `dmarc@mail.teeboxmarket.com` | PASS (in template — not yet published) |
| `REPLY_TO` | `functions/lib/email.js:44` | `support@teeboxmarket.com` (apex) | PASS — reply-to is allowed on apex; only From/Return-Path need to be on `mail.` |

**Severity:** LOW. **Status: PASS.**

**Recommended fix (cosmetic):** Pick one alias. Either `no-reply@` everywhere (then change `index.js:3513`) or `noreply@` everywhere (then change `lib/email.js:42`). Two visibly-different "no-reply" aliases from the same brand in the same week is a small reputation/UX hit. Suggested change to `functions/index.js:3513`:

```js
// before
const FROM_EMAIL = "TeeBox <noreply@mail.teeboxmarket.com>";
// after — match lib/email.js
const FROM_EMAIL = "TeeBox <no-reply@mail.teeboxmarket.com>";
```

---

## 3. Resend domain verification status

**Status:** **FAIL (blocked on user action).**

**Evidence:**
- `RESEND_API_KEY` is a placeholder per user (no real key bound). Cannot call `GET /domains` on the Resend REST API.
- DNS audit (above) shows zero of the 3 required records (SPF, DKIM CNAME, DMARC) are present for `mail.teeboxmarket.com`.
- `EMAIL_DNS_SETUP.md:7-9` instructs the operator to add `mail.teeboxmarket.com` in the Resend dashboard, but the DKIM target host is left as `<RESEND-DKIM-HOST>` (line 29) — meaning the dashboard step has not been completed.

**Fix (manual, blocked on user):**
1. Sign in to Resend → Domains → **Add Domain** → `mail.teeboxmarket.com`.
2. Resend shows 3 records (1 SPF TXT, 1–3 DKIM CNAMEs, 1 Return-Path MX or TXT). Copy DKIM host(s) verbatim.
3. Add records in Google Cloud DNS as per Section 1 fix block.
4. Wait 5–60 min for propagation. Verify with `dig` commands above.
5. In Resend → Domains → click **Verify**. All checks should turn green.
6. Mint a real API key (Resend → API Keys → **Create**), then:
   ```bash
   firebase functions:secrets:set RESEND_API_KEY
   # paste the re_xxxx key
   ```

Until step 6 lands, every send path (`functions/lib/email.js:289-296`, `functions/index.js:3580-3582`) deliberately no-ops with `[email skipped] RESEND_API_KEY not set` — so nothing is broken in production; it's just that no email is going out.

---

## 4. Mail-tester.com predicted score

**Status:** **N/A (blocked — cannot send a real message until Audits 1+3 are resolved).**

### Predicted deductions (current code state)

| Predicted deduction | -pts | Evidence |
|---|---:|---|
| SPF not published (apex + `mail.`) | −1 | DNS audit Section 1 |
| DKIM not published | −2 | `resend._domainkey.mail.teeboxmarket.com` returns NXDOMAIN |
| DMARC not aligned on sending host (only apex `p=none`) | −1 | `_dmarc.mail.teeboxmarket.com` empty; apex is permissive |
| No plain-text alternative — `@react-email/render` not in `dependencies` | −0.5 | `functions/package.json:17-26` has no `@react-email/render` and no `@react-email/components`; `functions/lib/email.js:144-153` `getRender()` swallows the missing-module error → both `html` and `text` become null and `sendTemplated` (`functions/emailTriggers.js:97-100`) falls back to a stub `<p>TeeBox notification: …</p>` body with **no text body and no real content**. Mail-tester penalizes both "HTML-only" and "near-empty body". |
| Missing physical address in footer | 0 | PRESENT — `functions/emails/layout/Base.jsx:34,123` renders `TeeBox, Inc. · 1234 Fairway Ln, Suite 200, Chicago, IL 60601, USA`. (Caveat: this is a placeholder address — must replace with a real address before sending to comply with CAN-SPAM 16 CFR 316.) |
| Spammy phrases | 0 | Reviewed `OrderShipped.jsx`, `OrderPlacedBuyer.jsx`, `PriceDrop.jsx`, `ProWelcome.jsx`, `WinBack30.jsx`, `AbandonedCart.jsx` — no FREE!!!, ACT NOW, GUARANTEED, urgency-spam, or all-caps subject lines. Subjects are sentence-case and ≤ 50 chars. |
| `List-Unsubscribe` + `List-Unsubscribe-Post` on marketing | 0 | Correct — see Audit 9. |
| Reverse DNS / HELO mismatch | 0 | Not applicable — Resend's outbound IPs handle PTR/HELO. |

**Predicted score now (if we could send):** ≈ **3/10** (the −3 from auth records is dispositive; SpamAssassin alone subtracts ≥ 4 for "no DKIM signature found" + "SPF_SOFTFAIL/NONE").
**Predicted score after Audits 1, 3 land:** ≈ **7/10** (still penalized for HTML-only stub body).
**Predicted score after Audits 1, 3 land AND `@react-email/render` + `@react-email/components` + `react` declared in `dependencies` and `predeploy: build:emails` wired:** **9–10/10**.

### Fix for the render-fallback issue (code change)

Add these to `functions/package.json` `dependencies`:
```json
"@react-email/components": "^0.0.x",
"@react-email/render": "^1.0.x",
"react": "^18.3.x"
```
Then add (also in `functions/package.json`):
```json
"scripts": {
  ...,
  "build:emails": "esbuild emails/**/*.jsx --bundle --platform=node --target=node22 --outdir=emails-build --jsx=automatic --external:@react-email/components --external:react",
  "predeploy": "npm run build:emails"
}
```
And in `functions/emailTriggers.js:62` change `require(\`./emails/${category}/${name}\`)` to `require(\`./emails-build/${category}/${name}\`)`. (Pattern documented at `EMAIL_OPS_RUNBOOK.md:69-81`, but not yet applied.)

---

## 5. Blacklist checks

Reverse-octet of `185.199.108.153` → `153.108.199.185`. Repeat across the 4 GitHub Pages anycast IPs.

```bash
$ dig @8.8.8.8 +short 153.108.199.185.zen.spamhaus.org
(empty)                                # NOT LISTED
$ dig @8.8.8.8 +short 153.109.199.185.zen.spamhaus.org
(empty)                                # NOT LISTED
$ dig @8.8.8.8 +short 153.110.199.185.zen.spamhaus.org
(empty)                                # NOT LISTED
$ dig @8.8.8.8 +short 153.111.199.185.zen.spamhaus.org
(empty)                                # NOT LISTED

$ dig @8.8.8.8 +short teeboxmarket.com.dbl.spamhaus.org
(empty)                                # NOT LISTED
$ dig @8.8.8.8 +short mail.teeboxmarket.com.dbl.spamhaus.org
(empty)                                # NOT LISTED

$ dig @8.8.8.8 +short 153.108.199.185.b.barracudacentral.org
(empty)                                # NOT LISTED
$ dig @8.8.8.8 +short 153.108.199.185.dnsbl.sorbs.net
(empty)                                # NOT LISTED
$ dig @8.8.8.8 +short 153.108.199.185.bl.spamcop.net
(empty)                                # NOT LISTED

$ dig @8.8.8.8 +short teeboxmarket.com.multi.surbl.org
(empty)                                # NOT LISTED
$ dig @8.8.8.8 +short mail.teeboxmarket.com.multi.surbl.org
(empty)                                # NOT LISTED
```

**Status: PASS** (clean across Spamhaus ZEN/DBL, Barracuda, SORBS, SpamCop, SURBL). **Severity: LOW.**

> Note: `mail.teeboxmarket.com` has no A and no MX yet, so there's no sending IP unique to TeeBox to look up. Once Resend sends start, the actual outbound IP belongs to Resend's shared pool (`_spf.resend.com`) — that's Resend's reputation, not ours. Re-run blacklist checks against `mail.teeboxmarket.com.dbl.spamhaus.org` and `mail.teeboxmarket.com.multi.surbl.org` weekly after launch to catch domain-based listings.

---

## 6. RFC 2142 mailboxes (`abuse@`, `postmaster@`)

**Status: FAIL.** **Severity: MEDIUM.**

**Evidence:**
- `dig @8.8.8.8 +short MX teeboxmarket.com` → empty. No mail receiver, so `abuse@teeboxmarket.com` and `postmaster@teeboxmarket.com` are unroutable.
- `ios/App/App/public/acceptable-use.html:192` and `:202` publicly advertise `abuse@teeboxmarket.com` as the channel for fraud / appeals — these are dead drops right now.
- `EMAIL_DNS_SETUP.md:107-118` documents the canonical role mailboxes (`support@`, `legal@`, `press@`, `hello@`, `jake@` on apex; `noreply@`, `unsubscribe@`, `dmarc@` on `mail.`) but they're aspirational comments, not implemented.
- No grep hit for `postmaster@` anywhere in the codebase.

**RFC 2142 violation:** RFC 2142 §6 requires every domain that publishes email addresses to maintain `abuse@` and `postmaster@`. ESPs (including Google, Yahoo, Microsoft) bias against domains that don't.

**Fix:**
1. Configure email hosting on `teeboxmarket.com` (Google Workspace, Fastmail, Cloudflare Email Routing, or simple forwarding via Squarespace email plan).
2. Publish the MX record. Example with Cloudflare Email Routing (free):
   ```
   @   IN MX 10 route1.mx.cloudflare.net.
   @   IN MX 20 route2.mx.cloudflare.net.
   @   IN MX 30 route3.mx.cloudflare.net.
   ```
3. Create forwarders:
   ```
   abuse@teeboxmarket.com      → jakenair23@gmail.com (or support@)
   postmaster@teeboxmarket.com → jakenair23@gmail.com (or support@)
   support@teeboxmarket.com    → already used in REPLY_TO — must exist
   legal@, press@, hello@, jake@ → per EMAIL_DNS_SETUP.md:107-114
   ```
4. On `mail.teeboxmarket.com`, set up `unsubscribe@` and `dmarc@` forwarders (or sink to a DMARC aggregator like Postmark DMARC / Dmarcian).

Until MX is published on the apex, every receiver bouncing to `abuse@teeboxmarket.com` to report spam from us will get a non-delivery report — that itself counts against domain reputation.

---

## 7. Bounce + complaint webhooks

**Status: PASS.** **Severity: LOW.**

| Item | Location | Status |
|---|---|---|
| `resendWebhook` handler exists | `functions/emailTriggers.js:154-263` | PASS |
| svix-signature verification | `functions/emailTriggers.js:126-152` | PASS — verifies `svix-id`, `svix-timestamp` (5-min window), `svix-signature`; HMAC-SHA256 in constant time; correctly strips `whsec_` prefix and base64-decodes the secret |
| `email.bounced` → hard bounce → suppress | `functions/emailTriggers.js:194-213` | PASS — sets `users/{uid}.emailSuppressed = true` + writes `emailSuppressions/{uid}`; soft bounces logged only |
| `email.complained` → suppress + write complaint | `functions/emailTriggers.js:214-234` | PASS — suppresses user, writes `emailSuppressions/{uid}` AND `complaints/{uid}` with full payload |
| Preflight suppression check before send | `functions/lib/email.js:159-183` | PASS — `preflightAllowed` reads `emailSuppressions/{uid}` and `users/{uid}.emailSuppressed`; transactional category bypass per `isTransactional` |

**Minor nit (LOW):** `verifySvix` at `functions/emailTriggers.js:165-170` falls back to "skip verify" when `RESEND_WEBHOOK_SECRET` is unset. Once the secret is set in production, change line 167's `logger.warn` path to a hard 503 so a missing secret can't accidentally accept unsigned events:

```js
// functions/emailTriggers.js:165-170 — recommended hardening (post-launch)
if (!secret) {
  logger.error("resendWebhook: secret not configured");
  return res.status(503).send("webhook secret not configured");
}
```

---

## 8. Engagement tracking

**Status: PASS.** **Severity: LOW.**

| Event | Handler | Side effect | Location |
|---|---|---|---|
| `email.delivered` | `resendWebhook` | `emailSends/{id}.status = "delivered"` | `functions/emailTriggers.js:235-252` |
| `email.opened` | `resendWebhook` | `.status = "opened"` | same |
| `email.clicked` | `resendWebhook` | `.status = "clicked"` | same |
| `email.sent` | `resendWebhook` | `.status = "sent"` | same |
| Hourly aggregator | `aggregateEmailMetrics` | writes `emailMetrics/{YYYY-MM-DD}` with `{sent, delivered, bounced, complained, opened, clicked, skipped, renderFailed}` | `functions/emailTriggers.js:861-903` |

**Caveat:** Resend's webhook dashboard requires the operator to explicitly **subscribe** to each event type. `EMAIL_OPS_RUNBOOK.md` does NOT include a step listing the required subscriptions. Recommend adding to runbook:

> In Resend → Webhooks → Edit the TeeBox endpoint, ensure ALL of these events are checked:
> - `email.sent`, `email.delivered`, `email.opened`, `email.clicked`
> - `email.bounced`, `email.complained`
> Endpoint URL: `https://us-central1-teebox-market.cloudfunctions.net/resendWebhook`

---

## 9. RFC 8058 one-click unsubscribe + marketing rules

**Status: PARTIAL.** **Severity: MEDIUM** (only because of missing frequency cap).

| Item | Location | Status |
|---|---|---|
| `List-Unsubscribe` header (URL + mailto) | `functions/lib/email.js:302` | PASS — `<https://teeboxmarket.com/unsubscribe.html?t=...>, <mailto:unsubscribe@mail.teeboxmarket.com?subject=unsubscribe-{cat}>` |
| `List-Unsubscribe-Post: List-Unsubscribe=One-Click` | `functions/lib/email.js:303` | PASS |
| Marketing-only inclusion | `functions/lib/email.js:300-304` — `if (!isTransactional(category) && uid) { ... }` | PASS — transactional category correctly excludes the header (per RFC 8058 / Gmail-Yahoo Feb-2024 spec) |
| Token security | `functions/lib/email.js:78-126` — HMAC-SHA256 over `${uid}.${category}.${expMs}`, 30-day TTL, base64url-encoded, constant-time compare | PASS |
| Backend handler (`handleUnsubscribe`) | `functions/emailTriggers.js:908-943` | PASS — accepts GET (`?t=`) and POST; writes `users/{uid}.emailPrefs.{category} = false` |
| FROM stable | `functions/lib/email.js:41-43` — `FROM_NAME = "TeeBox"`, `FROM_ADDRESS = "no-reply@mail.teeboxmarket.com"` | PASS |
| Visible unsubscribe link in body | `functions/emails/layout/Base.jsx:131-145` — only rendered for non-transactional | PASS |
| Physical postal address | `functions/emails/layout/Base.jsx:34,123` | PASS (text present — but the address `1234 Fairway Ln, Suite 200, Chicago, IL 60601, USA` looks placeholder. CAN-SPAM 16 CFR 316.5 requires a *valid* physical address.) |
| **Frequency cap (marketing)** | `grep` for `frequency\|max emails\|emails per week\|emailQuota` in `functions/` returned no hits | **FAIL** |

### Frequency-cap recommendation (new code)

Schedulers `savedSearchMatchScheduler`, `winBackScheduler`, `weeklyDigestScheduler`, `reviewRequestScheduler`, `abandonedDraftScheduler`, plus `PriceDrop` / `AbandonedCart` triggers can all theoretically converge on the same user in one day. With seven marketing categories enabled by default (see `functions/emailTriggers.js:732-741`), a power user could plausibly receive 5+ marketing emails per week.

Add a per-user weekly cap to `functions/lib/email.js` `sendEmail()`, before the Resend call:

```js
// Sketch — inside sendEmail, after preflightAllowed, before render:
if (!isTransactional(category) && uid) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recent = await admin.firestore()
    .collection("emailSends")
    .where("uid", "==", uid)
    .where("sentAt", ">=", weekAgo)
    .where("status", "==", "sent")
    .get();
  const marketing = recent.docs.filter(d => d.data().category !== "transactional").length;
  if (marketing >= 5) {                                  // cap = 5/week
    await recordSend({to, uid, category, template, status: "skipped-freq-cap"});
    return {skipped: true, reason: "freq-cap"};
  }
}
```

Pair with a Firestore index on `emailSends(uid asc, sentAt asc)` (already implied by the bounce-resolver query at `functions/emailTriggers.js:184-189`).

### Address fix

`functions/lib/email.js:46` and `functions/emails/layout/Base.jsx:34` both hard-code `"1234 Fairway Ln, Suite 200, Chicago, IL 60601, USA"`. This is a placeholder pattern (street/suite numbers are too round). Replace with a real registered address — a USPS PO Box ($30/yr) is acceptable per CAN-SPAM and FTC guidance.

---

## Prioritized fix checklist

### HIGH (do these before sending the first email — blocks delivery)

1. **Publish DNS records** in Google Cloud DNS for `teeboxmarket.com` (Section 1 fix block, paste-ready). Required: apex SPF, apex DMARC (`p=reject` — upgrade from current `p=none`), `mail.` SPF, `mail.` DKIM CNAME (after step 2 below), `mail.` DMARC.
2. **Verify `mail.teeboxmarket.com` in Resend.** Add domain in Resend dashboard → copy the exact DKIM target host(s) → publish CNAME(s) in DNS → click Verify.
3. **Set the real `RESEND_API_KEY` secret:**
   ```bash
   firebase functions:secrets:set RESEND_API_KEY
   firebase functions:secrets:set RESEND_WEBHOOK_SECRET
   firebase functions:secrets:set UNSUBSCRIBE_HMAC_SECRET
   firebase functions:secrets:set FREEZE_HMAC_SECRET
   firebase deploy --only functions
   ```
   The last two should be random 32-byte hex (`openssl rand -hex 32`).
4. **Install React Email deps + wire build pipeline** so emails aren't stub-fallback bodies. Patch `functions/package.json` per Audit 4. Without this, even after DNS lands, mail-tester will dock points for HTML-only / near-empty bodies.

### MEDIUM (do within 30 days)

5. **Stand up MX + role mailboxes.** Apex MX (Cloudflare Email Routing recommended — free) → forward `abuse@`, `postmaster@`, `support@`, `legal@`, `press@`, `hello@`, `jake@` to a real inbox (per `EMAIL_DNS_SETUP.md:107-118`). On `mail.`, forward `unsubscribe@` and `dmarc@`.
6. **Replace placeholder physical address** in `functions/lib/email.js:46` and `functions/emails/layout/Base.jsx:34`. Use a real registered address or PO Box.
7. **Add marketing frequency cap** in `functions/lib/email.js` `sendEmail()` (≤ 5 marketing emails / user / 7-day window). See Audit 9 sketch.
8. **DMARC ramp** per `EMAIL_DNS_SETUP.md:66-77`: start at `p=quarantine; pct=10` on `mail.`, advance to `pct=50` after 7 clean days, `pct=100` at 14 days, `p=reject` at 30 days. Apex can go straight to `p=reject` since nothing sends from it.
9. **Subscribe to all 6 events on the Resend webhook** (sent, delivered, opened, clicked, bounced, complained). Endpoint: `https://us-central1-teebox-market.cloudfunctions.net/resendWebhook`. Add this step explicitly to `EMAIL_OPS_RUNBOOK.md`.

### LOW (do whenever)

10. **Normalize `noreply@` vs `no-reply@`.** Pick one (suggest `no-reply@` to match `lib/email.js`). Change `functions/index.js:3513`.
11. **Harden webhook secret missing-config path:** in `functions/emailTriggers.js:165-170`, change the warn-and-continue path to a hard 503 after launch.
12. **BIMI** (post-launch, after 30 days of `p=reject` clean): SVG-tiny logo + VMC certificate, publish `default._bimi.mail TXT`. See `EMAIL_DNS_SETUP.md:48-51`.

---

## Items blocked on user action

These cannot be completed by the audit agent and must be done by the operator:

- **Publish DNS records** (requires Google Cloud DNS console access for `teeboxmarket.com`).
- **Add `mail.teeboxmarket.com` to Resend dashboard** and copy the DKIM target host(s).
- **Bind real `RESEND_API_KEY`** (requires Resend account + paid plan or free-tier signup).
- **Stand up MX + role mailboxes** (requires Cloudflare or other email-routing account).
- **Re-run mail-tester.com test** after Audits 1+3+4 fixes — send a transactional through `sendTemplated` to a freshly-generated `*@mail-tester.com` address.

---

## Predicted mail-tester score trajectory

| State | Score |
|---|---|
| Today (no DNS, no key, stub bodies) | ≈ 3/10 (cannot actually send) |
| After Audit 1 + 3 (DNS + Resend verified, real API key) | ≈ 7/10 (HTML-only stub bodies still penalized) |
| After Audit 4 (React Email build wired) | ≈ 9/10 |
| After Audit 6 (MX + role mailboxes) + DMARC ramped to `p=reject` for 30d | **10/10** |

---

## Files referenced

- `/Users/jakenair/Desktop/teebox/functions/lib/email.js` (lines 41–48, 78–126, 159–183, 247–344)
- `/Users/jakenair/Desktop/teebox/functions/emailTriggers.js` (lines 60–112, 126–263, 861–903, 908–943)
- `/Users/jakenair/Desktop/teebox/functions/package.json` (lines 17–26 — missing React Email deps)
- `/Users/jakenair/Desktop/teebox/functions/emails/layout/Base.jsx` (lines 34, 123, 131–145)
- `/Users/jakenair/Desktop/teebox/functions/index.js` (lines 3513, 3585–3590 — duplicate send path)
- `/Users/jakenair/Desktop/teebox/EMAIL_DNS_SETUP.md` (paste-ready DNS template)
- `/Users/jakenair/Desktop/teebox/EMAIL_OPS_RUNBOOK.md` (build/deploy/ramp playbook)
- `/Users/jakenair/Desktop/teebox/ios/App/App/public/acceptable-use.html` (lines 192, 202 — public `abuse@` reference)
