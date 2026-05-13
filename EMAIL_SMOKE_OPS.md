# EMAIL_SMOKE_OPS

Runbook for the daily transactional email smoke test
(`functions/emailSmokeTest.js`).

## What it does

Runs at **04:00 America/New_York** (same slot as the Pro upgrade smoke,
deliberately) and exercises four critical transactional email templates
end-to-end against the live Resend API:

| Step                       | Template                              | What breaks if this fails                   |
| -------------------------- | ------------------------------------- | ------------------------------------------- |
| `order_placed_send`        | `transactional/OrderPlacedBuyer.jsx`  | Buyers stop getting order receipts          |
| `password_reset_send`      | `security/PasswordReset.jsx`          | Locked-out users can't recover accounts     |
| `sale_notification_send`   | `transactional/OrderPlacedSeller.jsx` | Sellers don't know they need to ship        |
| `order_shipped_send`       | `transactional/OrderShipped.jsx`      | Buyers don't get tracking, open disputes    |

For each send the smoke:

1. Renders the React Email component with synthetic data
   (`Test Scotty Cameron Newport 2`, fake order id, etc.).
2. Calls `sendEmail()` from `functions/lib/email.js` — the SAME helper
   the live transactional triggers use. This is intentional: a smoke
   that bypasses the render/send pipeline could pass while the real
   pipeline silently broke.
3. Captures the `email.id` returned by Resend.

Then it waits **60 seconds** and queries `GET /emails/{id}` for each
id. A step passes when `last_event` ∈
`{sent, delivered, delivered_to_inbox}` and fails otherwise.

The remote `subject` and a 140-char preview of the rendered body are
snapshotted into the Firestore run doc on success, so a future
regression that renames a subject line or drops the preview text is
caught when the diff is reviewed.

## Setup (first-time)

You need three secrets configured in the **teebox-market** Firebase
project. If `RESEND_API_KEY` is still the placeholder, the smoke
refuses to run (logs a clear error) — so you can deploy this safely
even before Resend is fully wired up.

```sh
# 1. The test inbox. Use a Gmail / Fastmail / etc. address you control.
#    Smoke mail will arrive here daily — set up a filter to auto-archive.
firebase functions:secrets:set SMOKE_EMAIL_INBOX --project teebox-market
#    paste e.g. jakenair23+teeboxsmoke@gmail.com  then ⏎

# 2. Real Resend API key. Smoke refuses placeholders via a startsWith
#    check (must begin with `re_live_` or `re_test_`).
firebase functions:secrets:set RESEND_API_KEY --project teebox-market

# 3. Resend webhook signing secret (already required by the live
#    transactional triggers — set if not already).
firebase functions:secrets:set RESEND_WEBHOOK_SECRET --project teebox-market

# 4. (Optional, shared with the Pro smoke.) Slack/Discord/Zapier webhook
#    URL for failure alerts. If unset, the Firestore doc + Cloud
#    Logging ERROR are still your alert channels.
firebase functions:secrets:set SMOKE_ALERT_WEBHOOK --project teebox-market
```

Deploy only the two new functions (cheaper than a full functions deploy):

```sh
NODE_OPTIONS="--max-old-space-size=8192" \
  firebase deploy \
  --only functions:dailyEmailSmoke,functions:dailyEmailSmokeManual \
  --project teebox-market
```

## Manual trigger

Force a run any time (e.g., after a template edit):

```sh
curl -X POST -H "X-Smoke-Trigger: 1" \
  https://us-central1-teebox-market.cloudfunctions.net/dailyEmailSmokeManual
```

The endpoint is gated by the `X-Smoke-Trigger: 1` header — that's a
trivial speed bump, not security. Abuse is bounded because the smoke
only ever delivers to your `SMOKE_EMAIL_INBOX` value.

Response is JSON with `{ok, durationMs, steps, sends}` (or
`{ok:false, failedStep, error, ...}`).

## Where to look when it fires an alert

1. **Firestore** → `emailSmokeRuns/{YYYY-MM-DD}`. Top-level doc has
   `ok`, `failedStep`, `error`, `steps[]`, and `sends{}` with the
   snapshot subjects. Per-run history at
   `emailSmokeRuns/{date}/runs/{auto-id}` (append-only).
2. **Cloud Logging** → filter
   `jsonPayload.severity="ERROR" AND textPayload:"[EMAIL_SMOKE] FAIL"`.
   Set up a log-based alert on this filter to get email/SMS even
   without `SMOKE_ALERT_WEBHOOK`.
3. **Resend dashboard** → Emails → search by tag `smoke=1`. The send
   itself (HTML rendering, headers, delivery events) is visible there.
4. **Test inbox** → real mail. If something's visually wrong but
   `last_event=delivered`, you'll spot it here.

## Interpreting failures

| Failed step                | Most likely cause                                            |
| -------------------------- | ------------------------------------------------------------ |
| `order_placed_send` (early)| `RESEND_API_KEY` placeholder, render error in template       |
| `*_send` (one specific)    | Template threw on the synthetic ctx — missing/renamed field  |
| `*_verify` w/ `bounced`    | Inbox address typo, or recipient mailbox full                |
| `*_verify` w/ `delivery_delayed` | Recipient SMTP soft-bounce; rerun in 10 minutes        |
| `*_verify` w/ `complained` | Test inbox accidentally marked smoke mail as spam — un-spam  |
| All four `*_verify` fail   | Resend account-level issue (quota / suspended domain)        |
| HTTP 401 in error          | `RESEND_API_KEY` rotated and not redeployed                  |
| HTTP 404 in error          | `email.id` aged out of Resend's 30-day retention window      |

## Alert mechanism (3 layers, mirrors the Pro smoke)

The smoke is intentionally noisy-on-failure. We use three independent
layers so a single misconfigured channel doesn't silently swallow
production breakage:

1. **Firestore** — `emailSmokeRuns/{YYYY-MM-DD}` durable record. The
   Firebase Console alerts panel can fire on doc writes if you want
   that wired up, but the doc is most useful for post-mortem.
2. **Cloud Logging** — `logger.error("[EMAIL_SMOKE] FAIL", ...)`
   surfaces at ERROR severity. The recommended setup is a log-based
   alert in GCP Monitoring on the literal string `[EMAIL_SMOKE] FAIL`
   that emails the on-call person.
3. **`SMOKE_ALERT_WEBHOOK`** — POSTs a one-line summary to a
   Slack/Discord/Zapier inbound webhook. Body has `text`, `content`,
   and `message` keys so a single URL works regardless of vendor.
   Same secret the Pro smoke uses — if you set it once, both smokes
   alert through it.

## What this smoke does NOT catch

Be aware of the blind spots — if any of these regress, this smoke
will still pass:

- **Cross-client rendering.** Resend's `last_event=delivered` only
  confirms SMTP handoff; it says nothing about Outlook/Yahoo Mail
  rendering, dark-mode background bleed, or the iOS Mail
  pre-rendering pipeline. You still need to spot-check the test inbox
  on a real mobile device after big template changes.
- **Engagement / spam folder placement.** A mail can be `delivered`
  and still land in the recipient's Spam folder. We don't query
  open/click events because the test inbox isn't a real user, so the
  numbers would be meaningless. Use GlockApps / Mail-Tester monthly
  for an actual inbox-placement score.
- **Resend account-level rate limit / API quota.** The smoke uses 4
  sends/day so it can't itself exhaust the quota, but it also won't
  warn you that you're at 90% of your monthly Resend cap — that
  surfaces via Resend's own dashboard.
- **Mailbox forwarder behavior.** If `SMOKE_EMAIL_INBOX` is a Gmail
  address that forwards to your real address, the mail may be
  `delivered` to Gmail but silently dropped by the forwarder. Verify
  the inbox you set up actually receives the smoke mail in the first
  few days.
- **The unsubscribe / preference-center loop** for non-transactional
  email. The smoke deliberately only fires `category=transactional`
  templates, which are exempt from suppression gating. Marketing
  category emails (savedSearchMatches, priceDrops, weeklyDigest, etc.)
  have their own gating logic that this smoke does not exercise.
- **DKIM / SPF / DMARC alignment.** Resend signs with our DKIM key, so
  `delivered` implies signature validity at delivery time, but a
  domain DNS regression that happens between the smoke and the next
  real send won't be caught until the next smoke run.
- **Webhook reception.** This smoke verifies sends via Resend's HTTP
  API, not via our own webhook handler in `emailTriggers.js`. A
  broken webhook signature verifier won't fail this smoke.

## Idempotency / accumulation

The smoke uses fixed synthetic uids (`smoke-email-buyer-uid`,
`smoke-email-seller-uid`) and a fixed `SMOKE_EMAIL_INBOX` address.
There's no cleanup needed between runs — every send just appends to
the inbox and to Resend's per-send log. Set up a Gmail filter like
`from:no-reply@mail.teeboxmarket.com subject:Smoke` → auto-archive
to keep the inbox tidy.

Each send writes a row to the `emailSends/` collection (via
`recordSend()` in `lib/email.js`) — that's expected, the smoke rows
are tagged `template: "Smoke-<TemplateName>"` so you can filter them
out of the deliverability dashboard.

## Editing the smoke

If you add or rename a transactional template that's critical enough
to belong in the smoke:

1. Add a synthetic-data helper next to the existing `synth*Ctx()`
   functions in `functions/emailSmokeTest.js`.
2. Add a `step("<name>_send", ...)` block in `runEmailSmoke()`.
3. Add the matching `[<name>_verify, sends.<name>]` entry to the
   `verifyPairs` array.
4. Bump the manual trigger and verify it passes before merging.

Keep the count small — every additional template is one more
synthetic-ctx surface that drifts as schemas evolve. 4-6 templates is
the sweet spot.
