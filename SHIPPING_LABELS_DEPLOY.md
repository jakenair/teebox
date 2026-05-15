# Shipping labels (Shippo) — deploy plan

## What ships in this PR

- `functions/shippoIntegration.js` — full producer:
  - `createShippingLabel` (callable) — calls Shippo `/shipments`,
    picks the cheapest USPS or UPS Ground rate, calls
    `/transactions`, writes `labelUrl` / `trackingNumber` /
    `carrier` / `shippingLabelEnv` to `orders/{orderId}`.
    `emailTriggers.onOrderLabelEmail` then emails the buyer.
  - `getShippingFeatureFlag` (callable) — returns
    `{enabled, env}`. `env` is `"test" | "live" | null`.
  - `SHIPPO_API_KEY` secret declared via `defineSecret`. Value is
    **not** set by this PR — `firebase functions:secrets:set` is
    the only way to populate it.
- `index.html`:
  - "Print Label" button on each unshipped sold-order row, turns
    into a "View Label" link once `labelUrl` is on the doc.
  - Account hub → **Shipping** modal that reads/writes
    `users/{uid}.shippingFrom` (the return-address on every label).
- `firestore.rules`: extends the `users/{uid}` create + update
  allow-list to include `shippingFrom`.
- `functions/emails/transactional/OrderPlacedSeller.jsx` (existing)
  already accepts a `shippoEnabled` prop. When the secret is set,
  the seller-creation email's CTA points to the in-app label flow.

## Carrier / rate selection rules

`functions/shippoIntegration.js:pickRate` implements:

| Parcel weight | Preferred carrier | Notes |
|---|---|---|
| < 2 lb | Cheapest USPS rate (Priority Mail typically) | Default parcel is 2lb; <2lb is rare in v1. |
| 2-70 lb | Cheapest USPS rate (Priority Mail or Parcel Select) | USPS Priority Mail caps at 70 lb. |
| ≥ 70 lb | Cheapest UPS Ground | Rare in golf gear — only golf bags get heavy. |

Fallback when neither carrier returns rates: absolute cheapest rate of
any provider Shippo returned.

Default parcel dimensions are **12 × 8 × 4 in, 2 lb** (see
`DEFAULT_PARCEL` in `shippoIntegration.js`). Sellers can override per
call by passing a `parcel` object in the callable args; v1 UI does not
expose this override but it's wired for future use.

## v1 seller UX flow

### Where the seller accesses "Print Label"

1. **Seller dashboard → My Sales tab** — every paid-but-not-shipped
   order row shows two buttons: **Mark Shipped** (manual postage path)
   and **Print Label** (Shippo). `index.html` constructs them in the
   sold-orders renderer; see `printLabelBtn` near
   `loadShopData`'s sold-orders block.
2. **Single-order modal** (`?order=<id>`) — not currently rendered in
   v1. If the founder wants a per-order detail view, it would mirror
   the same button. **Not in scope of this PR.**
3. **Mobile (Capacitor iOS)** — same button on the same row. The
   handler uses `Capacitor.Browser.open()` to surface the PDF in the
   system browser (rather than a `window.open` no-op inside WKWebView).

After the seller clicks "Print Label":

- The button shows "Buying…" (~5-10s for the Shippo round-trip).
- On success: toast "Label purchased ($X · USPS). Opening PDF…", the
  PDF opens in a new tab / system browser, and the row refreshes to
  show "View Label" (re-open the same PDF without re-buying).
- On error: friendly toast keyed to the `reason` enum (table below).

### Where the "from" address comes from

The Shippo label's return address = `users/{sellerId}.shippingFrom`.
This is set by the seller via **Account → Shipping** (new menu item in
the Account hub, see `data-action="open-shipping-settings"` in the
account-hub markup).

If the seller hasn't set it:

- `createShippingLabel` rejects with `reason: "missing-from-address"`.
- The toast says "Add your ship-from address in Account → Shipping
  first."
- The Shipping modal opens with empty fields; seller fills in
  name / street / city / state / ZIP / phone (all required except
  phone, which Shippo strongly recommends for carriers).

We deliberately **do not fall back to a TeeBox HQ iPostal address** —
the return address on the label must be a real, deliverable address
because USPS sends undeliverable parcels back there. If sellers ship
from rotating PO boxes, that's their problem to manage in the
Shipping settings.

### Default carrier options (per the rate selection rules above)

- **Light parcels (default 2 lb)**: USPS Priority Mail or USPS
  Parcel Select. Priority is typically picked because Parcel Select
  has business-only pricing that Shippo may not surface.
- **Mid-weight (5-50 lb)**: USPS Priority Mail (cheapest USPS rate).
- **Heavy (≥ 70 lb)**: UPS Ground (cheapest UPS Ground rate).
- **Fallback** (no USPS / no UPS Ground at all): cheapest rate Shippo
  returns from any carrier (FedEx, etc.).

### What happens on Shippo failure

Every non-2xx Shippo response or returned-error shape gets translated
to a friendly toast. The callable's `reason` enum + the client-side
mapping:

| `reason` | What it means | Seller toast | What to tell the seller |
|---|---|---|---|
| `shippo-not-configured` | `SHIPPO_API_KEY` unset (deploy issue) | "Label generation isn't live yet. Buy postage from any carrier and mark the order shipped." | Use the Mark Shipped button with their own tracking number. |
| `missing-from-address` | Seller hasn't filled out their ship-from address | "Add your ship-from address in Account → Shipping first." | Click Account → Shipping, fill in their address. |
| `missing-to-address` | Order doesn't have a valid `shippingAddress` (rare — Stripe AddressElement is required at checkout) | "This order is missing a shipping address. Message the buyer to confirm before shipping." | Open the conversation, message the buyer for the address; support can patch the order doc manually. |
| `no-rates` | Shippo returned 0 rates (invalid ZIP, embargoed country, oversized parcel, etc.) | "We couldn't find any shipping rates for this address. Double-check the buyer's address and try again." | Confirm address with buyer; if the address is correct, contact support — likely a parcel-dimension issue. |
| `label-purchase-failed` | `/transactions` rejected (insufficient Shippo balance, carrier outage, etc.) | "Label purchase failed. Check your Shippo balance and try again." | Founder needs to top up the Shippo account. Retry after funding. |
| `shippo-down` | Network or 5xx from Shippo | "Shipping rates are temporarily unavailable. Please retry in a few minutes." | Retry in 2-5 min. If it persists, fall back to Mark Shipped + own carrier. |
| `test-key-in-prod` | Production guard tripped (a `shippo_test_…` key is bound to `teebox-market`) | "Shipping labels are temporarily unavailable. Please retry shortly." | Founder needs to rotate the secret to a `shippo_live_…` value. |

### Idempotency

Re-clicking "Print Label" after a successful purchase does NOT
re-buy. The callable short-circuits on `order.labelUrl !== null` and
returns `{ok: true, cached: true, labelUrl, ...}`. The button is
replaced with a "View Label" link as soon as the row refreshes
(within ~1s of the success toast).

## Test mode vs live mode

`SHIPPO_API_KEY` shape determines mode:

- `shippo_test_xxx` → fake labels, no postage charged. Tracking
  numbers look like `SHIPPO_TRANSIT` and USPS / UPS websites
  return "no record" for them. Useful for end-to-end flow testing
  without burning real postage.
- `shippo_live_xxx` → real labels, real postage debited from your
  Shippo account balance.

`shippingLabelEnv: "test" | "live"` is written onto every order doc so
the dashboard / admin tools can filter fake labels out of reporting.

**Production guard** (`functions/shippoIntegration.js`): refuses to
purchase a label if the key starts with `shippo_test_` AND
`process.env.GCLOUD_PROJECT === "teebox-market"`. This prevents the
foot-gun where a misconfigured prod env binds a test key and ships
fake "SHIPPO_TRANSIT" tracking numbers to real buyers.

## Signing up for Shippo

1. Create an account at https://apps.goshippo.com/join.
2. Verify your email + business details.
3. Go to **Settings → API** and copy:
   - **Test Token** (starts with `shippo_test_`) for the pre-launch
     e2e validation.
   - **Live Token** (starts with `shippo_live_`) for closed beta
     onward.
4. Fund the account with at least $25 of postage credit so the
   first labels purchase doesn't get rate-limited.

## Setting the secret

```bash
# Pre-TestFlight: use the test token to exercise the e2e flow.
firebase functions:secrets:set SHIPPO_API_KEY
# paste the shippo_test_... token, hit enter

# Once verified, swap to live (do NOT do this until after the
# scripts/payment-e2e-test.mjs run passes).
firebase functions:secrets:set SHIPPO_API_KEY
# paste the shippo_live_... token, hit enter

firebase deploy --only functions:createShippingLabel,functions:getShippingFeatureFlag
```

Verify the secret without exposing it:

```bash
firebase functions:secrets:access SHIPPO_API_KEY | head -c 20
# should print "shippo_test_..." or "shippo_live_..."
```

## Cost notes

- Shippo per-transaction fee: ~$0.05 per label.
- Carrier postage: USPS Priority Mail ~$8 / lb; UPS Ground similar.
  **Sellers pay the postage** (charged against the Shippo balance
  the founder funds; the cost is passed through as a future v1.1
  feature where Stripe pulls postage out of the seller's payout).
- v1 reality: founder eats the postage during closed beta and
  reconciles by deducting it from the next payout manually. Track
  this in Stripe Dashboard → Connect → Payouts.

## Pre-TestFlight E2E test (REQUIRED)

Before uploading the TestFlight build, run:

```bash
node scripts/payment-e2e-test.mjs --test
```

This script (see `scripts/payment-e2e-test.mjs`) validates all 9
steps of the payment + shipping pipeline against TEST mode. It:

1. Creates a test seller (Firebase Admin SDK) with
   `stripeChargesEnabled: true` and a hardcoded `shippingFrom`.
2. Creates a test listing under that seller.
3. Creates a test buyer.
4. Simulates a `createPaymentIntent` → confirmPayment flow with a
   Stripe test card.
5. Triggers the order via the `stripeWebhook` (Stripe CLI's
   `stripe trigger payment_intent.succeeded`).
6. Invokes `createShippingLabel` against the test order — verifies
   `labelUrl` is written.
7. Triggers the Connect webhook with `payout.paid` (Stripe CLI's
   `stripe trigger payout.paid`).
8. Verifies emails fired: `OrderPlacedBuyer`, `OrderPlacedSeller`,
   `OrderShipped`, `FundsReleased` (reads `emailSends/`).
9. Cleans up the test user, listing, and order.

Required env vars:

- `STRIPE_SECRET_KEY=sk_test_…` (NOT the same value as the deployed
  Firebase secret — this is the local script's key).
- `SHIPPO_API_KEY=shippo_test_…`
- `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json` —
  service account with Firestore + Auth + Functions permissions.
- `FIREBASE_PROJECT_ID=teebox-market` (or a separate test project
  if you have one).

Required tools:

- Stripe CLI: `brew install stripe/stripe-cli/stripe` then
  `stripe login`.
- Node 22+.

Run flags:

- `--test` (default) — uses test mode, no real money.
- `--live` — opt-in, uses live mode. **Do not pass `--live` against
  the production project unless you intend to create a real charge
  + buy a real label.**

**Required before uploading TestFlight build.** A failing step
means the corresponding production code path is broken — fix it
before submitting.

## Once wired (verification)

- Call `createShippingLabel` from the seller dashboard with a test
  order. Inspect the response: `{ok: true, labelUrl, trackingNumber,
  carrier, rateAmount, env}`.
- Open the labelUrl — should serve a valid PDF (test labels are
  4×6 PNGs that USPS won't accept at the counter; live labels are
  real 4×6 PDFs that scan).
- Confirm `orders/{orderId}.labelUrl`, `.trackingNumber`,
  `.shippingLabelEnv` were written.
- Confirm the buyer received the `LabelCreated` email
  (`emailTriggers.js:onOrderLabelEmail`, fires on first labelUrl
  write).
- (Live only) Drop the package at the carrier. Watch
  `orders/{orderId}.shippingStatus` for the auto-shipped transition
  — note: in v1 this transition is still manual (seller hits Mark
  Shipped). A Shippo webhook → tracking-status pipeline is in scope
  for v1.1.

## Future iterations (NOT in this PR)

- **Shippo tracking webhook** → updates `orders/{orderId}.shippingStatus`
  automatically as the carrier scans the package. Removes the manual
  "Mark Shipped" step.
- **Per-listing parcel overrides** → sellers can save dimensions per
  listing (a driver vs a putter weigh very differently).
- **Postage pass-through** → Stripe pulls the postage cost out of the
  seller's payout instead of the founder eating it.
- **Address validation pre-call** → call Shippo `/addresses` for both
  ends before `/shipments` to fail fast with a clear "address invalid"
  message rather than a generic "no rates".
- **Refund-on-cancel** → if a seller cancels within 24h of label
  creation, call Shippo `/refunds` to recover the postage.
