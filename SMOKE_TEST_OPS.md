# Pro Seller Subscription Smoke Test — Runbook

A scheduled Cloud Function that exercises the entire Pro Seller upgrade
lifecycle every morning at **04:00 America/New_York**. If it fails, you
get alerted before US morning traffic arrives, giving you hours to
triage before the day starts.

> **Why it exists.** Stripe webhook bugs are silent. If
> `handleSubscriptionUpsert` regresses, nobody notices until a paying
> customer DMs support saying "I paid for Pro but I still see free fees".
> The smoke catches that within 24 hours.

---

## Files

- `functions/smokeTest.js` — the scheduled function + a manual-trigger
  HTTPS function (`smokeProUpgradeManual`) for ad-hoc runs.
- `functions/lib/subscription.js` — the shared upsert / delete handlers.
  Imported by **both** the live webhook router (`functions/index.js`)
  and the smoke. That's the point: if they ever drift, the smoke isn't
  testing the real handler. **Do not duplicate this logic elsewhere.**
- `functions/index.js` — appends `Object.assign(exports, require('./smokeTest'))`
  so `firebase deploy --only functions` picks up both the scheduled and
  the manual trigger.

---

## What the smoke does (10 steps)

| # | Step | What it does | Assertion |
|---|---|---|---|
| 1 | `setup_user` | Ensure Firebase Auth user `smoke-test@teeboxmarket.invalid` (UID `smoke-test-pro-uid`) exists; wipe stale billing fields | user record returned with matching UID |
| 2 | `create_customer` | `stripe.customers.create({ metadata.firebaseUid })`; persist `users/{uid}.stripeCustomerId` | customer id returned |
| 3 | `attach_pm` | Create PM from `tok_visa` (4242…); attach; set as default | (success implies attach + default set) |
| 4 | `create_subscription` | Subscribe to `STRIPE_TEST_PRO_PRICE_ID` with `payment_behavior:'default_incomplete'`, confirm the PI | `sub.status === 'active'` |
| 5 | `verify_pro_flip` | Call `handleSubscriptionUpsert(sub)` (same fn the webhook calls); poll user doc | `tier='pro'`, `proSubscriptionStatus='active'`, `proCurrentPeriodEnd` in future, `profiles/{uid}.isPro=true` |
| 6 | `cancel_at_period_end` | `stripe.subscriptions.update(id, { cancel_at_period_end: true })` | `updated.cancel_at_period_end === true` |
| 7 | `verify_cancel_pending` | Re-fire upsert with the updated sub; poll | `proCancelAtPeriodEnd=true`, **tier still `'pro'`** (not yet effective) |
| 8 | `immediate_cancel` | `stripe.subscriptions.cancel(id)` (simulates period rollover) | `canceled.status === 'canceled'` |
| 9 | `verify_downgrade` | Fire `handleSubscriptionDeleted(sub)`; poll | `tier='free'`, `proSubscriptionStatus='canceled'`, `profiles/{uid}.isPro=false`, `proCancelAtPeriodEnd` cleared |
| 10 | `teardown` | `stripe.customers.del(id)` (cascades to sub + invoices + PM); zero out billing fields on user doc | (success is no-throw) |

Every step records `{name, ok, ms, err}` in `steps[]` so the failure
report points to the exact step that broke.

### Idempotency

Step 1 wipes any leftover `stripeCustomerId`, `proSubscriptionId`,
`proSubscriptionStatus`, etc. on `users/{SMOKE_UID}` before doing
anything else. Even if yesterday's run crashed mid-flight (orphan
Stripe customer left around), today's run starts from a clean baseline.
The orphan from yesterday will get garbage-collected when its trial
ends or you can manually delete it from the Stripe TEST dashboard.

The user doc itself is **never deleted** — leaving it in place lets
step 1 skip the `admin.auth().createUser` hop on most runs.

---

## Alerting — three layers, ranked by reliability

### Layer 1: Firestore `smokeRuns/{YYYY-MM-DD}` (most durable)

Every run — pass or fail — writes a doc:

```js
// smokeRuns/2026-05-12
{
  ok: false,
  trigger: 'schedule',
  failedStep: 'verify_pro_flip',
  error: 'pollForUserDoc timeout after 30000ms ...',
  steps: [
    { name: 'setup_user', ok: true, ms: 412 },
    { name: 'create_customer', ok: true, ms: 718 },
    ...
    { name: 'verify_pro_flip', ok: false, ms: 30122, err: '...' },
  ],
  durationMs: 38221,
  ranAt: <serverTimestamp>,
}
```

Also appends to `smokeRuns/{date}/runs/{auto-id}` so multiple runs in
a single day (e.g. manual reruns after a fix) are all preserved.

**To check the latest run from the console:**

```js
firebase.firestore()
  .collection('smokeRuns')
  .orderBy('ranAt', 'desc')
  .limit(7)
  .get()
```

Consider adding a small widget to your admin tool that surfaces the
last 7 days' results — green dots = good, red dot = page yourself.

### Layer 2: Cloud Logging — `logger.error("[SMOKE] FAIL", ...)`

On failure the function emits a structured ERROR-severity log entry.
Set up a **log-based alert** to email/page on this:

1. GCP Console → Logging → Log-based Alerts → **Create alert policy**.
2. Filter:

   ```
   resource.type="cloud_function"
   resource.labels.function_name="smokeProUpgrade"
   severity>=ERROR
   jsonPayload.message=~"^\\[SMOKE\\] FAIL"
   ```

3. Aggregation: count per 5 minutes, alert when ≥ 1.
4. Notification channel: your team email or PagerDuty.

This is the **recommended layer to set up immediately** — it covers
the case where the function itself crashes before reaching the
Firestore write in layer 1.

### Layer 3: `SMOKE_ALERT_WEBHOOK` secret (optional, low-latency)

If you have a Slack / Discord / Zapier inbound webhook URL, set it as a
secret and the smoke will POST a multi-key payload (`{text, content, message}`)
on failure — compatible with all three services.

```bash
firebase functions:secrets:set SMOKE_ALERT_WEBHOOK
```

Failure payload looks like:

```
TeeBox Pro Subscription Smoke FAILED
Step: verify_pro_flip
Error: pollForUserDoc timeout after 30000ms (last data keys: ...)
Trigger: schedule
Duration: 38221ms
Steps:
ok setup_user (412ms)
ok create_customer (718ms)
...
FAIL verify_pro_flip (30122ms)
```

Skip this layer entirely if you don't have a team chat channel — layers
1 and 2 are sufficient.

---

## Prerequisites (user actions, do these BEFORE deploying)

1. **Create a TEST-mode Product + Price in Stripe.**
   - Stripe Dashboard → toggle to **Test mode** (top of page).
   - Products → **+ Add product** with the same monthly price ($14.99)
     as your live Pro Seller plan.
   - Copy the test-mode `price_...` id.

2. **Set the required secrets.**
   ```bash
   firebase functions:secrets:set STRIPE_TEST_SECRET_KEY
   # paste sk_test_... (NOT sk_live_... — the smoke refuses to run with a live key)

   firebase functions:secrets:set STRIPE_TEST_PRO_PRICE_ID
   # paste price_... (the test-mode price id you just created)
   ```

3. **Optional: set the alert webhook.**
   ```bash
   firebase functions:secrets:set SMOKE_ALERT_WEBHOOK
   # paste your Slack/Discord/Zapier inbound webhook URL
   ```

4. **Deploy.**
   ```bash
   NODE_OPTIONS="--max-old-space-size=8192" \
     firebase deploy --only functions:smokeProUpgrade,functions:smokeProUpgradeManual
   ```

5. **Trigger a first manual run** to validate everything is wired up
   (don't wait for 04:00):
   ```bash
   curl -X POST \
     -H "X-Smoke-Trigger: 1" \
     https://us-central1-<your-project-id>.cloudfunctions.net/smokeProUpgradeManual
   ```
   You can also run via `firebase functions:shell` and invoke
   `smokeProUpgrade()` directly.

---

## Debugging a failure

1. **Read the Firestore run doc first.** `smokeRuns/<today>` tells you
   exactly which step failed and why.
2. **Check Cloud Logging** for the surrounding logs. Filter by
   `resource.labels.function_name="smokeProUpgrade"` and read the last
   ~30 entries around the failure timestamp.
3. **Reproduce locally:**
   ```bash
   cd functions
   firebase functions:shell
   > smokeProUpgrade()
   ```
4. **Common failure modes:**
   - `STRIPE_TEST_SECRET_KEY ... not a test-mode key` — you pasted a
     live key. The smoke explicitly refuses to run against live Stripe.
   - `STRIPE_TEST_PRO_PRICE_ID missing or malformed` — secret not set,
     or you pasted a `prod_...` instead of a `price_...`.
   - `create_subscription: expected active/trialing, got status='incomplete'` —
     the test PM confirm step failed. Usually a Stripe API change or a
     restricted-key permission issue. Try
     `stripe paymentMethods create ...` from the Stripe CLI to verify
     your key has `card` access.
   - `pollForUserDoc timeout` — the user doc never reached the expected
     state. Means `handleSubscriptionUpsert` either threw or wrote the
     wrong fields. Check the upsert handler's logs in Cloud Logging.

---

## Manual cleanup if the smoke leaves orphans

If a run crashes between `create_customer` and `teardown`, you'll have
a stray Stripe TEST customer hanging around. The next morning's run
will start fresh (different customer id), so this isn't a correctness
issue — but the TEST dashboard gets cluttered.

```bash
# List all smoke customers (note the .invalid email).
stripe customers list --email="smoke-test@teeboxmarket.invalid"

# Delete them all.
stripe customers list --email="smoke-test@teeboxmarket.invalid" --format=json \
  | jq -r '.data[].id' \
  | xargs -n1 stripe customers delete
```

---

## What this smoke does NOT catch

Be honest about coverage. The smoke explicitly does **not** cover:

- **Live webhook signing secret misconfiguration.** The smoke uses
  TEST mode and bypasses the webhook layer entirely (it calls the
  handler function directly). If `STRIPE_WEBHOOK_SECRET` in production
  ever stops matching what Stripe is signing with, the smoke will
  still pass while real users break.
- **Live Stripe Customer Portal config drift.** The portal config
  (which fields users see, whether they can self-cancel, etc.) is set
  in the Stripe Dashboard and not exercised by the smoke.
- **Live Price archived/changed.** The smoke verifies the TEST price,
  not the live `STRIPE_PRO_PRICE_ID` price. If you archive your live
  Price by accident the smoke won't notice.
- **Browser-side bugs.** Checkout button broken, 3DS modal blocked by
  CSP, mobile keyboard hiding the CVC field — these need a separate
  Puppeteer smoke that drives the actual browser.
- **Webhook timeout / retry behavior.** The smoke calls the handler
  synchronously; it doesn't exercise Stripe's retry queue or the
  router's transient-error classification logic.

### Recommended follow-up

Add a **weekly Puppeteer-driven E2E smoke** that opens a headless
browser, signs in as the smoke user, clicks the actual "Upgrade to
Pro" button, and walks through the real Stripe Checkout page. That
catches the browser-side gaps above. Out of scope for this runbook.

---

## Retention

`smokeRuns/{date}` is a per-day rollup, so you accumulate one doc per
day forever. After a year you'll have ~365 docs — negligible for
Firestore. The `runs/` subcollection grows by the number of manual
reruns, which is also small in practice.

If you ever want to prune: a one-line scheduled function that deletes
docs older than 90 days is fine. Not worth doing pre-emptively.

---

## Open questions for the team

- **Timezone.** Set to `America/New_York` (per user's TZ). If TeeBox
  ever gets a non-US ops team, consider moving to UTC or splitting
  into a per-region smoke.
- **Retention policy.** Currently keep forever — fine for now, revisit
  if Firestore costs ever become visible.
- **Slack channel.** If/when there's a team channel, set
  `SMOKE_ALERT_WEBHOOK` to its incoming webhook so failures route
  there instead of just email.
