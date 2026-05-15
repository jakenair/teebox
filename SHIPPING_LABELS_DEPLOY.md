# Shipping labels (Shippo) — deploy plan

## What ships in this PR

- `functions/shippoIntegration.js` — scaffold callable:
  - `createShippingLabel` — gated stub. Returns
    `{ok: false, reason: "shippo-not-configured"}` when the
    `SHIPPO_API_KEY` secret is unset. Returns
    `{ok: false, reason: "shippo-producer-not-wired"}` when the key
    IS set but the producer body hasn't been flipped on yet (see
    checklist below).
  - `getShippingFeatureFlag` — read-only callable returning
    `{enabled}` so the client can pick the right CTA.
- `SHIPPO_API_KEY` secret declared via `defineSecret`. Value is **not
  set** by this PR — `firebase functions:secrets:set` is the only
  way to populate it.
- `functions/emails/transactional/OrderPlacedSeller.jsx` now accepts a
  `shippoEnabled` prop. When false (v1 default), the email CTA reads
  "How to ship your item" and points to `/support.html#shipping`.
  When true (post-integration), it reverts to "Print label & ship"
  pointing to the in-app dashboard.

## v1 behavior

**Sellers buy their own postage.** USPS, UPS, FedEx — anything. They
ship within 3 business days and mark the order shipped from the
dashboard with the tracking number. The "Mark shipped" flow
(`index.html` confirmShip, already wired) sets `fulfillmentStatus`
and `shippingStatus`, which fires `onOrderShippingStatusEmail` and
the shipped push.

No Shippo charges hit our books in v1. The trade-off is a worse
seller experience (no pre-paid label, no PDF, no rate shopping).

## Why this is a scaffold

A real Shippo integration is 2-3 days of disciplined work:

- Address validation on both ends (POST `/addresses`, check
  `validation_results.is_valid`).
- Rate shopping (POST `/shipments` → pick from `rates[]`).
- Label purchase (POST `/transactions` with `rate_id` +
  `label_file_type: "PDF_4x6"`).
- Webhook subscription for tracking events (POST `/webhooks`,
  inbound HTTP function updates `orders/{orderId}.shippingStatus`).
- Refund-on-cancel (POST `/refunds` if the seller cancels the order
  within 24 hours of label creation — Shippo allows refunds on
  unused labels but only for a limited window).
- Cost reconciliation (Shippo's $0.05/label transaction fee, plus
  carrier postage — who pays? we eat it / pass through / line-item).

We don't want to launch a half-working integration. Better to ship
the scaffold + clear seller comms ("use any carrier") in v1, and
finish the integration in v1.1.

## Signing up for Shippo

1. Create an account at https://apps.goshippo.com/join.
2. Verify your email + business details.
3. Go to **Settings → API** and copy the **Live Token** (starts with
   `shippo_live_`).
4. Fund the account with at least $25 of postage credit so the
   first labels purchase doesn't get rate-limited.

## Setting the secret

```bash
firebase functions:secrets:set SHIPPO_API_KEY
# paste the shippo_live_... token, hit enter
firebase deploy --only functions:createShippingLabel,functions:getShippingFeatureFlag
```

Verify the secret is set without exposing it:

```bash
firebase functions:secrets:access SHIPPO_API_KEY | head -c 20
# should print "shippo_live_..." (first 20 chars only)
```

## Cost notes

- Shippo per-transaction fee: ~$0.05 per label.
- Carrier postage: USPS Priority Mail starts ~$8 / lb; UPS Ground
  similar. Sellers pay this (we mark up zero).
- Estimated breakage: free if listing < $20 and seller eats the
  $0.05 transaction fee. For >$20 listings, the cost is noise.

## Checklist to turn the stub into a producer

Inside `functions/shippoIntegration.js`, replace the inner stub block
of `createShippingLabel` with the real producer path. The annotated
TODO inside the function already lists the 6 steps. Specifically:

- [ ] Add `node-fetch` (or use native `fetch` — Node 22+) for the
  Shippo REST calls. Avoid the official `shippo` npm package — it's
  thin and adds dependency surface.
- [ ] Wire address validation (POST `/addresses`) for both
  `fromAddress` and `toAddress`. Reject with `invalid-argument` if
  `validation_results.is_valid === false`.
- [ ] POST `/shipments` with the validated addresses + parcel. Pick
  the cheapest rate matching the seller's saved preference
  (`users/{uid}.shippingPrefs?.preferredCarrier`).
- [ ] POST `/transactions` with `rate: <rate.object_id>` and
  `label_file_type: "PDF_4x6"`. Poll for `status: "SUCCESS"` (Shippo
  is async — typically completes in <2s).
- [ ] Write `orders/{orderId}.labelUrl = txn.label_url` and
  `.trackingNumber = txn.tracking_number` and `.carrier = ...`.
  This triggers `onOrderLabelEmail` in `emailTriggers.js:332` which
  fires the `LabelCreated` buyer email.
- [ ] Add a Shippo webhook receiver (`functions/shippoWebhook.js`,
  HTTP, validates `X-Shippo-Signature`) that updates
  `orders/{orderId}.shippingStatus` on `track_updated` events.
  Register the webhook in the Shippo dashboard pointing at the new
  function URL.
- [ ] Update `OrderPlacedSeller.jsx` calling-site (most likely
  `functions/emailTriggers.js:onOrderCreatedEmail`) to pass
  `ctx.shippoEnabled = true` when the secret is set.
- [ ] Wire the seller-side UI ("Print label" button in
  `index.html`'s order detail / shop dashboard) to call
  `createShippingLabel` and open the returned `labelUrl` in a new tab.

## Verification once wired

- Call `createShippingLabel` from the seller dashboard with a test
  order. Inspect the response: `{ok: true, labelUrl, trackingNumber}`.
- Open the labelUrl — should serve a valid 4x6 PDF.
- Mark the order shipped manually (Shippo also writes
  `trackingNumber`, but a manual "mark shipped" is fine).
- Wait for a Shippo tracking event in the dashboard. Confirm the
  matching webhook event lands and updates `shippingStatus`.
- Confirm the buyer received the `LabelCreated` email
  (`emailTriggers.js:onOrderLabelEmail`).
