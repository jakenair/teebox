# Stripe "Upgrade to Pro" failure-mode audit

Auditor: code review only. **No live or test Stripe call was made** — TeeBox is
on live keys and test PANs are rejected in live mode.

## TL;DR

The webhook handler is **correct on the critical question**: it never flips
`tier=pro` on `status='incomplete'` (see `functions/index.js:631–680`). For
all 7 test cards, no `tier=pro` / `isPro=true` write would land. Several
**non-critical** issues are surfaced below — none would let an unpaid card
become Pro, but a few hurt UX or reliability.

---

## 1. Code-path trace

### a) Client: `A['upgrade-to-pro']` — `index.html:13589–13628`

```
clicks "Upgrade now" → A['upgrade-to-pro']
  ├─ Capacitor native? → return silently (App Store policy)
  ├─ httpsCallable('createSubscriptionCheckout')()
  │     → { url }
  ├─ window.location.href = url      // navigate to checkout.stripe.com
  └─ on error: showToast(generic message); reset button
```

The generic toast on error is `"Could not start the upgrade. Try again in a
moment."` — it does **not** surface the Stripe error reason. That's fine for
this code path because no payment has been attempted yet (we're just
provisioning a Customer + Session).

### b) Server: `createSubscriptionCheckout` — `functions/index.js:4271–4344`

No `try/catch`. If `stripeClient.customers.create` or
`stripeClient.checkout.sessions.create` throws, `onCall` raises a generic
`internal` error to the client. There is **no** silent retry (good). There
is **no premature DB write of `proSubscriptionId`** before payment (good —
only `stripeCustomerId` is written, which is just a Stripe ref, not a
tier flip).

### c) Stripe Checkout (off-our-host)

User enters card on `checkout.stripe.com`. For cards 1–4 + 7: Checkout
shows decline UI inline. User either clicks "Try another card" (no event
fires until success) or "Cancel" (→ redirect to `?checkout=pro_cancel`,
no Subscription was ever created, no `customer.subscription.created`
event). For card 5: Stripe shows 3DS challenge on its own page — if the
user authenticates, Subscription is created `active`. For card 6: user
fails 3DS — Subscription is **never** created.

### d) Return-URL handlers — `index.html:11610–11625`

- `?checkout=pro_success`: shows success toast. **No client-side tier
  write.** Comment explicitly notes the webhook is source of truth.
- `?checkout=pro_cancel`: shows cancel toast.

Critical: Stripe Checkout in `mode='subscription'` only redirects to
`success_url` after the Subscription is created. Stripe's docs guarantee
this. So `?checkout=pro_success` cannot fire on a hard decline.

### e) Webhook — `functions/index.js:465–606`

Events handled relevant to Pro:
- `customer.subscription.created` → `handleSubscriptionUpsert`
- `customer.subscription.updated` → `handleSubscriptionUpsert`
- `customer.subscription.deleted` → `handleSubscriptionDeleted`

Events **not** handled (fall through to log-only default):
- `checkout.session.completed` — fine, we use subscription events instead
- `checkout.session.expired` — fine, no action needed
- `invoice.payment_failed` — debatable; see "Issues" below
- `invoice.payment_succeeded` — fine, sub.updated covers it
- `payment_intent.payment_failed` — for **subscription** PIs, no action
  needed (sub event covers it). For **listing** PIs it IS handled.

### f) `handleSubscriptionUpsert` — `functions/index.js:653–700`

```
PRO_ACTIVE_STATUSES   = {active, trialing, past_due}    → tier='pro'
PRO_INACTIVE_STATUSES = {canceled, unpaid, incomplete_expired} → tier='free'
status='incomplete'   → leave tier unchanged
```

This is the load-bearing check. It is **correct** for all seven failure
modes: the `incomplete` branch is a no-op, and `incomplete_expired`
correctly downgrades. The "leave unchanged" comment at line 681–682
matches the implementation.

### g) `findUserByStripeCustomer` — `functions/index.js:623–629`

If the lookup misses (e.g. the user doc was deleted, or two customers
were created racing the persistence at line 4321), the upserter logs a
warning and returns. The webhook still returns 200 (no retry storm).
This is safe but slightly fragile (see "Issues #3").

---

## 2. Per-card verdicts

| # | Card | Description | Verdict | Evidence |
|---|---|---|---|---|
| 1 | `4000…0002` | Card declined | **PASS** | Checkout shows decline; sub never created; no event. If user retries with good card, `customer.subscription.created` fires with `status=active` → `tier=pro`. Clean. `functions/index.js:574–577,631,666`. |
| 2 | `4000…9995` | Insufficient funds | **PASS** | Same path as #1. |
| 3 | `4000…0069` | Expired card | **PASS** | Same path as #1 (front-end Checkout validation also catches some expirations before Stripe round-trip). |
| 4 | `4000…0119` | Processing error | **PASS** | Same path. `createSubscriptionCheckout` does NOT silently retry — there is no retry loop in `index.js:4271–4344`. |
| 5 | `4000 0027…3184` | 3DS required, auth succeeds | **PASS** | After successful 3DS, subscription is `active` → `handleSubscriptionUpsert` flips tier. CSP allows `frame-src https://*.stripe.com` (`index.html:6`) and Hosting has `X-Frame-Options: SAMEORIGIN` (`firebase.json:42`) — but 3DS happens on `checkout.stripe.com`, not our origin, so neither matters. |
| 6 | `4000 0084…1629` | 3DS auth fails | **PASS** | User fails 3DS → PI ends `requires_payment_method` → Subscription never created (Stripe Checkout in subscription mode only creates the sub after the initial invoice's PI succeeds). No webhook fires. No DB write. |
| 7 | `4100…0019` | Fraudulent (Radar block) | **PASS** | Stripe Radar blocks at PI creation; Checkout shows generic decline; sub never created. |

---

## 3. Issues found (none are CRITICAL for the "no false Pro" bar)

### MEDIUM — `createSubscriptionCheckout` swallows specific Stripe errors

**`functions/index.js:4271–4344`** — No `try/catch` around the Stripe API
calls. Any `StripeAPIError`, network blip, or invalid Price will surface
to the client as `FUNCTIONS/INTERNAL` and the UI shows a generic toast.
A logged error message + a typed `HttpsError('aborted', err.message)`
for known card errors (none happen here, only at the actual Checkout
step) would let us tell the user "Stripe is having a moment" vs. "we
mis-configured your Price."

**Sketch:**
```js
try { /* customers.create / checkout.sessions.create */ }
catch (e) {
  logger.error('createSubscriptionCheckout failed', e);
  throw new HttpsError('aborted',
    e && e.code ? `Stripe error: ${e.code}` : 'Could not start Checkout.');
}
```

### LOW — `past_due` keeps user on Pro for the full Smart Retries window

**`functions/index.js:631`** — `PRO_ACTIVE_STATUSES` includes `past_due`,
which is standard for SaaS dunning (~3 weeks of Smart Retries). This is
not a bug, but it is worth flagging because it means a user can stay on
Pro for ~3 weeks after their first failed renewal invoice. If we ever
want to be stricter (e.g. revoke Pro on first failed renewal), this is
the only line to change. The inline comment at lines 617–622 explains
the trade-off.

### LOW — `findUserByStripeCustomer` warns and returns silently

**`functions/index.js:623–629, 655–658`** — If we ever lose the
`stripeCustomerId` field on a user doc (manual edit, restore from
backup, etc.) we'll silently drop subscription updates. Consider adding
a `client_reference_id` fallback: `handleSubscriptionUpsert` already
gets `sub.metadata.firebaseUid` (set at `index.js:4336`); falling back
to that for the lookup would harden the path.

**Sketch:**
```js
async function findUserByStripeCustomer(customerId, fallbackUid) {
  if (customerId) { /* current path */ }
  if (fallbackUid) return db.collection('users').doc(fallbackUid).get();
  return null;
}
// caller: findUserByStripeCustomer(sub.customer, sub.metadata?.firebaseUid)
```

### LOW — No handler for `invoice.payment_failed` (subscription invoices)

**`functions/index.js:529–583`** — We don't notify the user when a
renewal invoice fails. Stripe's hosted dunning emails the customer
from `checkout.stripe.com` automatically (if enabled in the Dashboard),
but our in-app banner wouldn't reflect it until the subscription
transitions to `canceled`. Not a correctness bug for this audit's
question, but a UX gap. Add a handler that writes
`proPaymentFailedAt: serverTimestamp()` and surface it in the My Shop
banner.

### INFO — Webhook idempotency uses Firestore `create`

**`functions/index.js:504–527`** — Good. `processedStripeEvents/{eventId}`
guards against duplicate flips on Stripe redeliveries.

### INFO — Refresh-token revocation on tier change

**`functions/index.js:689–694`** — Good. Forces a token refresh so
custom-claim consumers see the new tier within seconds.

---

## 4. Manual UI test plan (rotate to TEST mode)

> **Reminder:** TeeBox is on LIVE keys. Run this in a separate Stripe
> account or carefully restore live values after.

### Step 1 — Set the three function secrets to test values
```bash
# In the repo root, with you logged into firebase-tools:
firebase functions:secrets:set STRIPE_SECRET_KEY        # paste sk_test_...
firebase functions:secrets:set STRIPE_PRO_PRICE_ID      # paste price_... (test)
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET    # paste whsec_... from the TEST-mode endpoint
```
Then redeploy only the affected functions:
```bash
firebase deploy --only functions:createSubscriptionCheckout,functions:stripeWebhook,functions:createBillingPortalSession
```

### Step 2 — Create a TEST-mode webhook endpoint
In the Stripe Dashboard (**Test mode** toggle on), Developers →
Webhooks → Add endpoint:
- URL: `https://us-central1-<your-firebase-project>.cloudfunctions.net/stripeWebhook`
  (or whatever your live URL is — same function, test-mode key now)
- Events: `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, plus the payment-related ones we
  already use for listings if they apply.
- Copy the signing secret → paste into `STRIPE_WEBHOOK_SECRET` above.

### Step 3 — Use a throwaway TeeBox account
Sign up on web.teeboxmarket.com with a brand-new Google account. Open
the Firestore console in another tab and watch `users/<uid>` +
`profiles/<uid>` live.

### Step 4 — Run each card

For each of the 7 cards:
1. Open the Pro upgrade modal → click **Upgrade now**.
2. On the Stripe Checkout page (URL: `checkout.stripe.com`), enter:
   - Card number from table
   - Expiry: any future date (e.g. `12 / 34`)
   - CVC: any 3 digits
   - ZIP: any 5 digits
3. Click **Subscribe**.

| # | Card | Expected UI | Expected Firestore |
|---|---|---|---|
| 1 | `4000 0000 0000 0002` | Inline decline; can retry. If cancel → `pro_cancel` toast. | `tier` unchanged. `stripeCustomerId` set. `proSubscriptionId` absent. |
| 2 | `4000 0000 0000 9995` | Inline "Insufficient funds." | Same as #1. |
| 3 | `4000 0000 0000 0069` | "Card expired" inline. | Same as #1. |
| 4 | `4000 0000 0000 0119` | "Try again or use a different card." | Same as #1. |
| 5 | `4000 0027 6000 3184` | 3DS modal appears; click **Complete authentication**. → redirect to `?checkout=pro_success`. | Within ~5s: `tier=pro`, `proSubscriptionStatus=active`, `proSubscriptionId=sub_...`, `profiles/<uid>.isPro=true`. |
| 6 | `4000 0084 0000 1629` | 3DS modal appears; click **Fail authentication**. → back to Checkout with decline. | Same as #1. |
| 7 | `4100 0000 0000 0019` | Generic decline (Radar). | Same as #1. |

### Step 5 — After each failing card, verify clean retry
Refresh the page. The Upgrade button should still say "Upgrade now". Open
Pro modal again — no stale state. (This is enforced by the `tier === 'pro'
&& proSubscriptionId` guard at `functions/index.js:4293`, which blocks
double-subscribing only when both fields are set, which they won't be.)

### Step 6 — Restore live keys
```bash
firebase functions:secrets:set STRIPE_SECRET_KEY        # paste live sk_live_
firebase functions:secrets:set STRIPE_PRO_PRICE_ID      # paste live price_
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET    # paste live whsec_
firebase deploy --only functions:createSubscriptionCheckout,functions:stripeWebhook,functions:createBillingPortalSession
```
Delete the test webhook endpoint. Audit the test customer in the Stripe
Dashboard.

---

## 5. Programmatic reproduction

Path: `/Users/jakenair/Desktop/teebox/scripts/test-stripe-failures.js`

How to run:
```bash
STRIPE_TEST_SECRET_KEY=sk_test_xxx \
STRIPE_TEST_PRO_PRICE_ID=price_xxx \
node scripts/test-stripe-failures.js
```

What it does:
- Creates one fresh Customer per card (auto-cleaned on exit unless
  `KEEP_CUSTOMERS=1`).
- Attaches the matching `pm_card_*` test token.
- Creates a Subscription with `payment_behavior: 'default_incomplete'`.
- Asserts `subscription.status` and `latest_invoice.payment_intent.status`.
- Prints PASS/FAIL per card and a summary.

What it does **not** do:
- Touch Firestore or any TeeBox function. Safe to run anytime.
- Complete 3DS challenges (card #5 / #6 sit in `requires_action`,
  which is the off-session terminal state).

---

## 6. Open questions for you

1. **iOS in-app webview & 3DS** — `index.html:13594-13597` short-circuits
   the upgrade action when running in Capacitor. So 3DS in the iOS app
   isn't a path today. Is the intent that mobile-Safari (browser, not
   wrapper) is the only mobile path? If so, no action needed; the CSP
   already allows Stripe's frames. If you ever ship an in-app upgrade
   flow, plan for 3DS-via-redirect (system browser), not iframe.

2. **`past_due` keeps Pro for ~3 weeks** — confirm this is the intended
   policy. Some teams revoke Pro on first failed renewal to avoid abuse;
   others (most) ride Smart Retries.

3. **`invoice.payment_failed` notifications** — do you want an in-app
   banner when a renewal fails, or rely entirely on Stripe's dunning
   emails?

4. **Webhook idempotency vs. transient errors** — the current code
   writes the `processedStripeEvents` marker BEFORE handler logic
   (`index.js:506–509`). If the handler then throws a transient error
   (Firestore unavailable), we return 500 → Stripe retries → next time
   the marker already exists → we short-circuit and skip the handler.
   This means a transient Firestore failure could permanently lose a
   subscription event. Should the marker write be moved to AFTER the
   handler runs? Tradeoff: re-introduces some duplicate-handling risk,
   but `handleSubscriptionUpsert` is idempotent (it's just a `set` with
   merge), so this would be safe.
