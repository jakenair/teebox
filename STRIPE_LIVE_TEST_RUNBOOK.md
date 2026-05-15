# Stripe LIVE / TEST mode runbook

**Audit date**: 2026-05-15 (pre-TestFlight)

## Current state: LIVE

The deployed `teebox-market` Firebase project is on **Stripe LIVE mode**.
Evidence:

| Surface | Value | Mode |
|---|---|---|
| `STRIPE_SECRET_KEY` secret | `sk_live_51TN...` (confirmed) | LIVE |
| `index.html:4545` `STRIPE_PK` | `pk_live_51TNLBCACdHwBgjjdvEbJm8dnyMSpoOUBMlm9NA3GRpUbRIacTVWyAOwNE5Uz7a0epMm7vxO7WuMENFQojWR2JQy800wZTQ934p` | LIVE |

Any `createPaymentIntent` call right now creates a **real charge**. Test
cards (4242…) will be rejected by live mode.

## Secrets that must flip together

There are **four** Stripe secrets the platform binds. They must be
swapped as a set — mixing live secrets with a test publishable key (or
vice versa) yields signature-verification failures and silent payment
rejections.

| Secret name | Used by | LIVE shape | TEST shape | Inspect with |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | `createPaymentIntent`, `refundOrder`, all Stripe SDK calls (`functions/index.js:14`) | `sk_live_…` | `sk_test_…` | `firebase functions:secrets:access STRIPE_SECRET_KEY \| head -c 12` |
| `STRIPE_WEBHOOK_SECRET` | `stripeWebhook` signature verify (`functions/index.js:15`, used at `index.js:570`) | `whsec_…` (issued by the LIVE platform-events endpoint in Stripe Dashboard) | `whsec_…` (TEST platform-events endpoint) | `firebase functions:secrets:access STRIPE_WEBHOOK_SECRET \| head -c 12` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `stripeConnectWebhook` signature verify (`functions/missingProducers.js:63`) | `whsec_…` (LIVE Connect-events endpoint) | `whsec_…` (TEST Connect-events endpoint) | `firebase functions:secrets:access STRIPE_CONNECT_WEBHOOK_SECRET \| head -c 12` |
| `STRIPE_PRO_PRICE_ID` | `createSubscriptionCheckout` for the Pro Seller plan (`functions/index.js:89`) | `price_…` (a LIVE Price object on the LIVE product) | `price_…` (TEST Price object — must be re-created in TEST mode) | `firebase functions:secrets:access STRIPE_PRO_PRICE_ID \| head -c 12` |

Each is `defineSecret`'d in code; binding doesn't change between
environments — only the **value** does. The function declarations need
no edits when flipping; just rotate the secret values and redeploy the
functions that depend on them.

### Listing all four at once

```bash
for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
         STRIPE_CONNECT_WEBHOOK_SECRET STRIPE_PRO_PRICE_ID; do
  printf "%-32s " "$s"
  firebase functions:secrets:access "$s" 2>/dev/null | head -c 12 || echo "(unset)"
  echo
done
```

Expected output in LIVE: `sk_live_…`, `whsec_…`, `whsec_…`, `price_…`.
Expected output in TEST: `sk_test_…`, `whsec_…`, `whsec_…`, `price_…`
(the two `whsec_` values are different from their LIVE counterparts —
Stripe issues a distinct signing secret per endpoint).

## Client-side publishable key

There is exactly **one** publishable key in the codebase:

- `index.html:4545` — `const STRIPE_PK = 'pk_live_51TN…';`

No other static HTML pages (`support.html`, `refunds.html`,
`privacy.html`, `terms.html`, `dmca.html`, `acceptable-use.html`,
`404.html`, `offline.html`, `unsubscribe.html`) reference a publishable
key. No service worker / iOS bundle / Android bundle references one.

Capacitor wraps `index.html` directly, so updating this single line
flips both iOS and web clients. **There is no environment-variable
indirection in front of the publishable key** — it's a literal string
constant. Plan accordingly: every test/live flip on the client requires
a redeploy of `index.html` (web → push to `main` → GitHub Pages, iOS →
new TestFlight build because the bundled `index.html` is the source).

## Connect webhook configuration

Two webhook endpoints exist in Stripe Dashboard per environment:

1. **Platform endpoint** → `https://us-central1-teebox-market.cloudfunctions.net/stripeWebhook`
   - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `payment_intent.canceled`, `payment_intent.processing`,
     `account.updated`, `account.application.deauthorized`,
     `charge.dispute.*`, `payout.failed`,
     `identity.verification_session.*`, `customer.subscription.*`,
     `invoice.payment_failed`, `invoice.payment_action_required`,
     `charge.refunded`.
   - Signing secret → `STRIPE_WEBHOOK_SECRET`.
2. **Connect endpoint** → `https://us-central1-teebox-market.cloudfunctions.net/stripeConnectWebhook`
   - Subscribed via the "Connect" tab in Stripe → Developers → Webhooks
     (NOT the platform tab).
   - Events to subscribe (per the new handler in `missingProducers.js`):
     `account.updated`, `account.external_account.created`,
     `account.external_account.deleted`, `account.external_account.updated`,
     `capability.updated`, `payout.created`, `payout.updated`,
     `payout.paid`, `payout.failed`, `payout.canceled`,
     `transfer.created`, `transfer.updated`, `transfer.reversed`.
   - Signing secret → `STRIPE_CONNECT_WEBHOOK_SECRET`.

When you flip to TEST mode you must register **both endpoints again** in
the Stripe Dashboard's Test-mode view (Dashboard has a separate live /
test toggle; webhook endpoints created in live mode do not show in test
mode and vice-versa). Use the **same Function URLs** — TEST and LIVE
both hit the same Cloud Functions; the secret value is what
discriminates which mode the signature must match.

## Exact flip procedure: LIVE → TEST

### Step 1 — Stripe Dashboard (test mode)

1. Stripe Dashboard → top-right → toggle to **Test mode**.
2. Developers → API keys → copy `sk_test_…` (Secret) and
   `pk_test_…` (Publishable).
3. Developers → Webhooks → click **Add endpoint** twice:
   - Platform endpoint, URL =
     `https://us-central1-teebox-market.cloudfunctions.net/stripeWebhook`,
     events = the 14 listed above under "Platform endpoint". Copy the
     signing secret.
   - Connect endpoint (use the "Listen to events on Connected accounts"
     option), URL =
     `https://us-central1-teebox-market.cloudfunctions.net/stripeConnectWebhook`,
     events = the 13 listed above under "Connect endpoint". Copy the
     signing secret.
4. Products → re-create the **Pro Seller** product in test mode (test
   and live catalogs are separate). Copy its `price_…` id.

### Step 2 — Firebase secrets

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY            # paste sk_test_…
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET        # paste whsec_… (platform-test)
firebase functions:secrets:set STRIPE_CONNECT_WEBHOOK_SECRET # paste whsec_… (connect-test)
firebase functions:secrets:set STRIPE_PRO_PRICE_ID          # paste price_… (test product)
```

### Step 3 — Client publishable key

Edit `index.html:4545`:

```diff
- const STRIPE_PK = 'pk_live_51TN…';
+ const STRIPE_PK = 'pk_test_51TN…';
```

Commit, push, redeploy. For TestFlight builds, also bump the build
number and re-archive.

### Step 4 — Redeploy functions that bind the changed secrets

```bash
firebase deploy --only \
  functions:createPaymentIntent,\
functions:stripeWebhook,\
functions:stripeConnectWebhook,\
functions:refundOrder,\
functions:createSubscriptionCheckout,\
functions:createStripeOnboardingLink,\
functions:createStripeLoginLink,\
functions:getStripeAccountStatus,\
functions:onStripePayoutPaid
```

(A full `firebase deploy --only functions` is the safe sledgehammer if
you're not sure which functions bind which secret.)

### Step 5 — Smoke test

- `stripe listen --forward-to localhost:5001/teebox-market/us-central1/stripeWebhook --skip-verify`
  — confirm signature checks pass.
- Create a tester user, complete Connect onboarding with Stripe's test
  flow (`000-000-0000` phone, `0000` SSN-last-4, the dummy bank account
  Stripe pre-fills in test mode).
- Purchase with `4242 4242 4242 4242`, expiry any future date, CVC any
  three digits. PI succeeds → `orders/{id}` doc appears.
- `stripe trigger payout.paid` against the test Connect account → the
  new Connect handler fires, `payouts/{id}` doc is written,
  `FundsReleased` email lands at the seller's address.

## Exact flip procedure: TEST → LIVE

Mirror image of the above.

1. Stripe Dashboard → toggle to **Live mode**.
2. Copy `sk_live_…` / `pk_live_…`. Re-create or re-find the
   webhook endpoints + the Pro Seller price.
3. Re-set the four secrets to their live values.
4. Revert `index.html:4545` to `pk_live_…`.
5. Re-deploy the same set of functions.
6. **Disable test-mode webhook endpoints** in Stripe (Dashboard → set to
   "Disabled"). Leaving them enabled means every test event still pings
   your prod Cloud Functions and either silently 200s (if duplicate of a
   live event) or floods logs.

## Risk analysis: stay LIVE vs flip to TEST for the closed beta

### Option A — stay LIVE for the closed-beta (25 trusted testers)

**Pros**
- Zero risk of an env-mismatch bug surfacing right before public launch.
  The exact code path that handles real charges is the one being
  exercised.
- Real payouts to seller bank accounts can be validated end-to-end
  including the 2-business-day ACH settlement.
- `pk_live_` already shipped → no rebuild needed.

**Cons**
- Every test purchase is a real charge with real card fees (~2.9% +
  $0.30 routed by Stripe; we eat this on refund).
- Testers must use real cards. With 25 testers, expect to refund every
  single purchase → 25 × $0.30 = $7.50 in unrecoverable Stripe fees,
  plus the marketplace fee (currently 8% of GMV but waived on refund
  paths — verify in `refundOrder` if you go this route).
- Stripe radar / fraud scoring counts these against the platform risk
  profile. 25 charges + 25 immediate refunds on a young account looks
  suspicious to Radar.
- Disputes from test cards (rare but possible if a tester chargebacks
  by accident) hit the live Disputes counter, which Stripe weighs in
  account-health scoring for ~12 months.

**Mitigations**
- Use the `disableAdminCharges` config doc (NOT IMPLEMENTED — would
  need a feature flag) to short-circuit `createPaymentIntent` for the
  founder's admin email so internal QA doesn't burn fees.
- Issue refunds immediately via the new admin-refund path
  (`functions/index.js:4458`, post-fix). Stripe waives the $0.30
  fee on a refund issued within 60 days — see Stripe's pricing page.

### Option B — flip to TEST for the closed beta, flip back before public

**Pros**
- No real money moves. Testers use `4242 4242 4242 4242`. Connect
  onboarding uses dummy SSN/bank fields. No fraud-score penalty.
- Multiple iterations on Connect onboarding flow without rebuilding the
  seller's account.
- Webhooks fire instantly (test mode does not require ACH wait).

**Cons**
- **Re-test before public launch is mandatory** — TEST mode never
  exercises real card networks, real KYC review, real ACH timing, or
  real Stripe Radar. A code path that works in TEST can still 500 in
  LIVE because of an issuer-side check or a Radar rule.
- One re-flip step (4 secrets + 1 client const + 9 function redeploys
  + 2 client redeploys for iOS & web) before public launch. Risk of an
  env-mismatch bug during the flip is the single biggest exposure.
- TestFlight builds with `pk_test_…` baked in cannot be promoted
  directly to App Store — you'd ship a new build with `pk_live_…` for
  the App Store, and that build needs its own beta-test cycle in
  TestFlight (Apple requires the App Store submission build to be
  TestFlight-tested before going wide).

### Recommendation (this audit)

**Go with Option A — stay LIVE for the closed beta.** Reasons:

1. The closed beta IS the live-mode validation. Flipping to TEST and
   then back doubles the surface area for env-mismatch bugs and
   eliminates the most valuable signal (real ACH timing, real Radar
   scoring).
2. With only 25 testers and ~$7-10 of unrecoverable fees, the cost is
   immaterial.
3. The new admin-refund path (`refundOrder` + `isAdminEmail` gate,
   shipped in this branch's predecessor) means the founder can issue
   instant refunds without needing to open Stripe Dashboard.
4. The TestFlight build needs `pk_live_…` anyway for App Store, so
   re-baking it with `pk_test_…` would force a second beta cycle.

**Caveats / what to monitor in LIVE closed beta**:

- Watch Stripe Dashboard → Disputes for any chargebacks. Even one in
  the first 30 days is a yellow flag.
- Watch the Radar score on each test charge. If it climbs above 70
  on consecutive test-account purchases, Radar is flagging the pattern;
  consider whitelisting tester IPs.
- Use the e2e test script (`scripts/payment-e2e-test.mjs`) which
  defaults to `--test` to validate the code paths in isolation BEFORE
  pointing live testers at the app. The script runs against
  `sk_test_…`, so to use it you'd temporarily either (a) run it against
  a separate Firebase project pinned to test mode, or (b) set
  `STRIPE_SECRET_KEY=sk_test_…` in your local env for the duration of
  the script (the script reads from env, NOT Firebase secrets — see
  the script's docstring).

## How to detect mode at runtime (defensive)

If you want a belt-and-suspenders check, add this stanza near
`createPaymentIntent` (NOT IMPLEMENTED — flagged for future
hardening):

```js
const sk = stripeSecret.value();
const expectingLive = process.env.GCLOUD_PROJECT === "teebox-market";
const isLive = sk.startsWith("sk_live_");
if (expectingLive && !isLive) {
  logger.error("Stripe key mismatch — LIVE env binding a TEST secret");
  throw new HttpsError("internal", "Payments temporarily unavailable.");
}
```

This blocks the foot-gun where a TEST secret accidentally ships to the
prod project mid-rotation.

## Stripe-CLI install (required for the e2e test script)

```bash
brew install stripe/stripe-cli/stripe   # macOS
stripe login                            # opens browser for OAuth
stripe listen --forward-to https://us-central1-teebox-market.cloudfunctions.net/stripeWebhook
```

The `stripe listen` command in TEST mode is the easiest way to verify
the platform webhook is wired: it prints every event the local listener
forwards and shows the response code from your Cloud Function. Run it
in a second terminal while you fire test charges.
