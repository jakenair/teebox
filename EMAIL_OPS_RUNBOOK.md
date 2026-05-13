# TeeBox Email — Ops Runbook

How the email system is wired, how to ramp it, what to do when something
breaks, and how to read the deliverability dashboard.

---

## Architecture at 10,000 ft

```
Cloud Function (trigger / scheduler / callable)
        │
        ▼
functions/lib/email.js   ── sendEmail({...})
        │ check suppression + preferences
        │ render React Email template
        │ POST to Resend API
        ▼
   Resend (mail.teeboxmarket.com)
        │ SPF + DKIM + DMARC
        ▼
   Recipient inbox
        │ async events (bounce / complaint / open / click)
        ▼
functions/emailTriggers.js → exports.resendWebhook
        │ verify svix-signature
        │ update emailSends + emailSuppressions
        ▼
   Firestore (admin dashboard reads these)
```

---

## ESP secrets

```bash
firebase functions:secrets:set RESEND_API_KEY
firebase functions:secrets:set RESEND_WEBHOOK_SECRET
firebase functions:secrets:set UNSUBSCRIBE_HMAC_SECRET
firebase functions:secrets:set FREEZE_HMAC_SECRET
```

`UNSUBSCRIBE_HMAC_SECRET` and `FREEZE_HMAC_SECRET` should be random 32-byte
hex strings. Generate with `openssl rand -hex 32`.

---

## Building React Email templates

The `.jsx` templates need a transpile step before Cloud Functions can
`require()` them. Recommended: **`tsx`** in dev, **esbuild** for deploy.

### Local dev

```bash
cd functions
npm i -D tsx
node --experimental-loader=tsx ./emails/transactional/OrderShipped.jsx
```

Or preview in browser:

```bash
npx react-email dev --dir ./functions/emails
```

### Deploy build

Add to `functions/package.json`:

```json
"scripts": {
  "build:emails": "esbuild emails/**/*.jsx --bundle --platform=node --target=node22 --outdir=emails-build --jsx=automatic --external:@react-email/components --external:react",
  "predeploy": "npm run build:emails"
}
```

Then in `functions/lib/email.js`, point the lazy require at
`./emails-build/...` instead of `./emails/...` (one-line change inside
`getTemplate`).

Until that build is wired up, **the `getTemplate` helper falls back to a
stub HTML body**, so deploys won't 500 — but the email content will be
generic. Wire the build before going to prod.

---

## Deliverability dashboard

Admin tab `Email` is added inline in the moderation modal (see
index.html admin moderation section). It reads `emailMetrics/{day}` for
the 30-day rolling window.

Top-line KPIs to watch:

| Metric | Healthy | Warning | Action |
|---|---|---|---|
| Bounce rate | < 1% | 1–3% | Investigate domain/list hygiene |
| Complaint rate | < 0.1% | 0.1–0.3% | Pause non-transactional |
| Open rate (transactional) | > 40% | 25–40% | Subject-line A/B |
| Open rate (lifecycle) | > 18% | 10–18% | Audience segmentation |
| Delivered % | > 98% | 95–98% | Check DMARC aggregates |

If complaint rate breaks 0.3% for 2 consecutive days, **immediately stop
all non-transactional sends** (set `emailPrefs.[category] = false`
globally) and dig into which template/audience is the offender.

---

## Bounce handling

`resendWebhook` automatically:

1. Hard bounces → `users/{uid}.emailSuppressed = true` AND writes
   `emailSuppressions/{uid}` doc.
2. Soft bounces → logged only. Resend retries internally.
3. Complaints → suppress + write `complaints/{uid}` doc for review.

To investigate a complaint:

```bash
gcloud firestore documents lookup --project=teebox-market complaints/<uid>
```

Look at the `payload` field for the original message id + headers.

To restore a falsely-suppressed user (e.g. typo in their email, fixed):

```bash
firebase firestore:delete complaints/<uid>          # if applicable
firebase firestore:delete emailSuppressions/<uid>
# Then unset users/{uid}.emailSuppressed in the admin console.
```

---

## Ramp plan

Ramp Resend traffic gradually to avoid IP-warming issues. Resend uses a
shared pool by default — if you upgrade to dedicated IPs, follow this:

| Day | Volume cap | Audience |
|---|---|---|
| 1–3   | 100 / day   | Internal team only |
| 4–7   | 1,000 / day | Most-engaged 1k users |
| 8–14  | 5,000 / day | Engaged users (opened in last 30d) |
| 15–21 | 20,000 / day | Full active list |
| 22+   | Unlimited   | All opt-in |

Resend's UI surfaces per-day caps. Increase only after the previous step
shows clean reports (bounce <1%, complaint <0.1%, DMARC aggregate >98%
aligned).

---

## Preference center data model

```
users/{uid}.emailPrefs = {
  savedSearchMatches: true,   // default ON for new signups
  priceDrops: true,
  abandonedDraft: true,
  abandonedCart: true,
  reviewRequests: true,
  winBack: true,
  weeklyDigest: false,        // opt-in only (would be too noisy as default)
  productUpdates: true,
}
users/{uid}.emailSuppressed = false       // global kill switch
users/{uid}.emailPrefsUpdatedAt           // for audit
```

Transactional category is **always on** and cannot be disabled.

---

## One-click unsubscribe

`unsubscribe.html` at repo root handles the one-click flow:

1. User clicks `List-Unsubscribe` link (or footer link).
2. Page POSTs to `handleUnsubscribe` cloud function.
3. Function verifies HMAC token (30-day TTL), writes
   `users/{uid}.emailPrefs.[category] = false`.
4. Page shows "you're unsubscribed" without requiring login (RFC 8058).

Token format: base64url(`uid.category.expMs.hmacSha256`).

---

## Security email "this wasn't me" flow

All security templates include a freeze button that hits
`exports.freezeAccount` (HTTP) with a 24-hour HMAC token.

Freeze does:

1. `admin.auth().updateUser(uid, {disabled: true})`
2. `admin.auth().revokeRefreshTokens(uid)` — kills all sessions
3. `users/{uid}.frozen = true`
4. Send `PasswordReset` email with a fresh reset link

User regains access by:

1. Clicking reset link in the new password email
2. Setting a new password
3. Operators must un-disable the account (manual admin step — safety net)

---

## Monitoring + alerts

Recommended (not yet wired):

- Cloud Monitoring alert on `emailSends` write rate dropping > 50% from
  rolling 7-day average → likely Resend outage.
- Alert on `complaints` write count > 5 in any 1-hour window.
- Daily digest of `emailMetrics/{yesterday}` via Slack webhook.

---

## Test sends

```bash
# After deploy, fire a test transactional:
firebase functions:shell

> onOrderCreatedEmail({
    data: { data: () => ({
      buyerId: 'YOUR_UID',
      sellerId: 'OTHER_UID',
      listingId: 'SOME_LISTING_ID',
      amountCents: 12500
    })},
    params: { orderId: 'test-' + Date.now() }
  })
```

Or call from the client:

```js
const fn = httpsCallable(functions, 'sendSecurityEmail');
await fn({ template: 'EmailVerification', payload: { verificationUrl: '...' } });
```
