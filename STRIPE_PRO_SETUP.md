# Pro Seller Tier — Stripe Setup Checklist

This file walks you through everything that has to happen *outside* the
codebase to make the Pro Seller tier (`$14.99/mo` Stripe subscription →
`tier='pro'` → 3% transaction fee) actually work in production.

The code is already wired up:

- `createSubscriptionCheckout` (callable Cloud Function) — opens Stripe
  Checkout in subscription mode against `STRIPE_PRO_PRICE_ID`
- `createBillingPortalSession` (callable) — opens Stripe-hosted billing
  portal for cancel / payment-method updates
- `stripeWebhook` — handles `customer.subscription.created/updated/deleted`,
  flips `users/{uid}.tier`, mirrors `profiles/{uid}.isPro` for buyer-facing
  badges
- `createPaymentIntent` — reads `sellerData.tier` and uses **3% fee** for
  Pro sellers, **6.5%** otherwise

Note: the in-app upgrade CTA is **hidden on iOS** to comply with Apple
Guideline 3.1.1 (digital subscriptions in iOS apps must use Apple's
IAP). iOS users who want Pro must upgrade via teeboxmarket.com on the
web. The web flow is unaffected.

---

## 1. Create the Stripe Product + Price

In **Stripe Dashboard → Products → + Add product**:

- **Name:** `TeeBox Pro Seller`
- **Description:** `Reduced 3% transaction fee for high-volume sellers.
  Cancel anytime.`
- **Pricing model:** *Recurring*
- **Price:** `$14.99 USD`
- **Billing period:** *Monthly*
- **Tax behavior:** whatever you've configured for the rest of TeeBox
  (likely *Exclusive* — taxes added on top — but match your existing
  setup)

Click **Save product**.

On the resulting product page, copy the **Price ID** — it looks like
`price_1ABcDeFGhIjKlMnOpQrStUvW`. You'll need it in step 2.

> ⚠️  Use a separate Product/Price for **Test mode** vs **Live mode** —
> Stripe scopes price IDs to a single mode. Get the test-mode price ID
> first for end-to-end testing, then repeat in live mode before launch.

## 2. Set the `STRIPE_PRO_PRICE_ID` secret

The Cloud Function reads this from a Firebase secret (NOT a literal
hardcode). Set it:

```bash
firebase functions:secrets:set STRIPE_PRO_PRICE_ID
# When prompted, paste the price_… ID from step 1.
```

Verify it landed:

```bash
firebase functions:secrets:access STRIPE_PRO_PRICE_ID
```

If you maintain separate Firebase projects for test vs. prod, set the
secret in **both**, with the matching mode-scoped price IDs. Re-deploy
functions after either secret changes (see step 5).

## 3. Add subscription events to the existing Stripe webhook

You already have a `stripeWebhook` endpoint registered in Stripe for the
Connect / payment-intent flow. **Don't create a new one** — just add the
three new events to the existing endpoint.

In **Stripe Dashboard → Developers → Webhooks → [your TeeBox endpoint]
→ … → Update details → Listen to events**, ensure these are all
checked:

Existing (don't remove):
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `account.updated`
- `charge.dispute.created`

**New (add these):**
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Save. The `STRIPE_WEBHOOK_SECRET` does **not** change — the same signing
secret authenticates every event on the endpoint.

> Repeat for the test-mode webhook endpoint if you keep them separate.

## 4. Configure the Stripe Customer Portal

This is what `createBillingPortalSession` opens — a Stripe-hosted page
where Pro subscribers can cancel, update their card, or pull invoices.
We don't need to build any UI for this.

In **Stripe Dashboard → Settings → Billing → Customer portal**:

1. **Activate** the customer portal.
2. **Functionality** — enable:
   - ✅ *Customers can update their payment method*
   - ✅ *Customers can update their billing address*
   - ✅ *Customers can view their invoice history*
   - ✅ *Customers can cancel subscriptions*
3. **Cancellation** — set the cancellation policy:
   - *When* → "Cancel at end of billing period" (so they get the rest
     of the month they paid for; matches the "Reactivate any time" copy
     in the in-app banner)
   - *Cancellation reason* → optional but useful for churn analysis
4. **Products** — add `TeeBox Pro Seller`.
5. **Business information** — set your support email (`support@teeboxmarket.com`),
   privacy URL, terms URL.
6. **Branding** — should already be configured from the Connect
   onboarding setup (logo, accent color). Confirm it looks right.

Save. Test with the **Preview** button.

> ⚠️ Customer portal config is **per mode** (test vs. live). Repeat in
> live mode before launch.

## 5. Deploy functions

The Pro tier code lives in `functions/index.js` and is already commited.
Once your local Firebase deploy is fixed (this is a separate blocker
on the user's machine — `firebase deploy --only functions` is currently
failing), run:

```bash
firebase deploy --only functions:createSubscriptionCheckout,functions:createBillingPortalSession,functions:stripeWebhook,functions:createPaymentIntent
```

(Or just `firebase deploy --only functions` if you want a full deploy.)

The first deploy after `STRIPE_PRO_PRICE_ID` is set will pick up the new
secret automatically — no extra flag needed.

Also push the firestore rules (the comment block documenting the new
server-only fields was added in commit `ce4e390`):

```bash
firebase deploy --only firestore:rules
```

## 6. End-to-end test with Stripe test cards

Use Stripe **test mode** for this. You'll need:

- A Firebase project pointed at the test Stripe account (or just `STRIPE_SECRET_KEY` + `STRIPE_PRO_PRICE_ID` swapped to test values)
- The web app at `teeboxmarket.com` (Capacitor iOS hides the CTA — you
  cannot test the upgrade flow inside the iOS app)
- A test Stripe customer (any signed-in TeeBox user)

### Happy path

1. Sign in to teeboxmarket.com with a test user.
2. Open **My Shop** → see the gold *Upgrade to Pro Seller* banner at
   the top.
3. Click **Upgrade to Pro** → modal opens → click **Upgrade now**.
4. Stripe Checkout loads → pay with test card `4242 4242 4242 4242`,
   any future expiry, any CVC, any ZIP.
5. Get redirected to `?checkout=pro_success` → toast appears: *"You're
   on Pro Seller — fees are now 3%."*
6. Reload My Shop → banner now shows the dark green **Pro Seller**
   status with a *Manage subscription* button.
7. List a test item → buy it from a different test buyer → verify in
   Stripe that the application_fee is **3%** of the price (not 6.5%).

### Idempotency / already-Pro

8. While still on Pro, click *Manage subscription* → portal opens. Don't
   cancel yet.
9. Open the Pro modal again somehow (DevTools, force the action) → call
   `createSubscriptionCheckout` → should throw `already-exists` with
   the toast *"You're already on Pro. Use Manage subscription to make
   changes."*

### Cancel

10. In the billing portal, click **Cancel subscription** → choose end of
    period.
11. Reload My Shop → banner now reads *"Your subscription will end at
    the next billing cycle. Reactivate any time."*
12. In Stripe, manually advance the clock or wait until period end →
    webhook fires `customer.subscription.deleted` → `users/{uid}.tier`
    flips to `free`, `profiles/{uid}.isPro` flips to `false`.
13. Reload → banner is back to gold *Upgrade to Pro Seller*.

### Failed payment / dunning

14. Use the Stripe test card `4000 0000 0000 0341` (charge succeeds at
    creation, fails on later renewals).
15. Force a renewal via Stripe's clock simulator → status flips to
    `past_due` → user **stays on tier='pro'** during the Smart Retries
    window (4 attempts over ~3 weeks by default).
16. After all retries fail → status → `canceled` → tier → `free`.

### iOS guard

17. Open the iOS Capacitor build, sign in, open My Shop. Confirm:
    - Free user: no Pro banner at all.
    - Pro user (toggle by upgrading on web first): banner shows the
      Pro Seller status, but the right side reads *"Manage at
      teeboxmarket.com"* — not a button.
    - The Pro pill on other sellers' listing cards still appears
      (info-only badge, no IAP issue).

## 7. Verify in Firebase Console after first Pro upgrade

After step 6.5 above, open **Firebase Console → Firestore**:

- `users/{testUid}` should now contain:
  - `stripeCustomerId: "cus_…"`
  - `stripeCustomerCreatedAt: <timestamp>`
  - `tier: "pro"`
  - `proSubscriptionId: "sub_…"`
  - `proSubscriptionStatus: "active"`
  - `proSubscriptionUpdatedAt: <timestamp>`
  - `proCurrentPeriodEnd: <timestamp> (~30 days out)`
  - `proCancelAtPeriodEnd: false`

- `profiles/{testUid}` should now contain:
  - `isPro: true`
  - `isProUpdatedAt: <timestamp>`

After cancellation (step 6.12):

- `users/{testUid}.tier`: `"free"`
- `users/{testUid}.proSubscriptionStatus`: `"canceled"`
- `profiles/{testUid}.isPro`: `false`

Open **Firebase Console → Functions → Logs** and filter on
`stripeWebhook`. For each lifecycle event you should see one of:

- `Subscription sub_… → active for <uid> (tier=pro)`
- `Subscription sub_… → past_due for <uid> (tier=pro)`
- `Subscription sub_… canceled for <uid>`

If you instead see `subscription event for unknown customer cus_…`, the
`stripeCustomerId` reverse-lookup failed. Double-check that
`createSubscriptionCheckout` actually wrote the customer ID to
`users/{uid}` (Firestore Console is the truth) — every successful
upgrade should leave that doc populated **before** Checkout redirects.

## 8. Going live

When you're ready to flip from test to live mode:

1. Re-do steps 1, 3, 4 in **live mode** (new product, new live price ID,
   live webhook endpoint, live customer portal config).
2. `firebase functions:secrets:set STRIPE_PRO_PRICE_ID` with the live
   price ID, then re-deploy functions.
3. Confirm `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are also set
   to live-mode values.
4. Smoke-test with a real $14.99 charge to your own card → cancel
   immediately in the portal → verify the lifecycle in Firestore the
   same way you did in test mode.

## Rollback

If something breaks in production:

- **Stripe side:** in Stripe Dashboard, archive the live Pro Price (no
  new subscriptions can be created against it). Existing subscribers
  remain billed and at 3% — no disruption.
- **App side:** revert the `renderProTierBanner` function to render
  nothing for everyone, or hide the My Shop upgrade entry-point until
  fixed. The 3% fee path in `createPaymentIntent` continues to work for
  existing Pro subscribers regardless.
- **Tier flip is server-only** — the `tier` field is on the firestore
  rules' deny-list, so you don't need to worry about clients writing
  bogus tier values during incident response.
