# Sell before payouts — Part B (held funds): plan and Stripe notes

Status: **on hold** (founder, 2026-11-09). Not built. Needs a lawyer's view first on
seller of record, dispute liability, and whether holding buyer funds raises
money-transmission questions. The hold window and the seller-of-record choice are on
hold with it. Until then the current behaviour stays: a seller without payouts can
list, buyers see **"Seller is finishing setup — tap to get notified"**, and checkout
returns 409 if a buyer reaches it anyway (`createPaymentIntent`, functions/index.js).

Part A (shipped separately on `feat/payouts-prompt`): post-publish "connect payouts"
pop-up, iOS Stripe overlay fix, iOS 18+ error, listing-live email wording.

## What Part B would do

A buyer can buy from a seller who has not connected Stripe yet. The money is held
until the seller connects, then paid out. If the seller never connects, the buyer is
refunded automatically.

## Why today's checkout can't do it

Checkout uses **destination charges**: the PaymentIntent carries
`transfer_data.destination` and `on_behalf_of` = the seller's Connect account, and
`application_fee_amount` = TeeBox fee + shipping. Stripe needs a connected account
with active capabilities for that:

- `destination` must be "The ID of a connected Stripe account."
  — https://docs.stripe.com/api/transfers/create.md
- "A capability must be active for a connected account to perform actions associated
  with that capability." / "Payments using the `transfers` capability include
  Destination charges and Separate charges and transfers."
  — https://docs.stripe.com/connect/account-capabilities.md
- `on_behalf_of` "is supported only for connected accounts with a payments capability
  such as card_payments." — https://docs.stripe.com/connect/destination-charges.md

Creating the Express account early (at listing time) does not help: its capabilities
stay inactive until onboarding is verified, so charges and transfers to it still fail.
(r348 did this with `prepareOnly`; r396 removed it because it left an orphaned live
account for every lister who never sold.)

## The Stripe pattern: separate charges and transfers

Charge the buyer on the **platform** account, then transfer the seller's share once
their account can receive it.

- "You can create a charge before knowing the connected account. You can create a
  charge before being able to transfer the funds." — https://docs.stripe.com/connect/charges.md
- Transfer with `source_transaction=<charge id>`: "the transfer request returns success
  regardless of your available balance if the related charge hasn't settled yet."
  The transfer can't exceed the charge. Using `source_transaction` also stops the
  platform's automatic payouts from sweeping that money.
  — https://docs.stripe.com/connect/separate-charges-and-transfers.md
- US platform to US accounts: supported.
- The seller's account needs the `transfers` capability active for the transfer.

### Holding period

- Stripe: "we can hold funds in reserve for a period of time that's based on the
  country the business is in: … United States 2 years; All other countries 90 days."
  Stripe also says it advises "against platforms holding funds arbitrarily" and
  recommends holding only "when there's a clear purpose and a commitment to transfer".
  — https://docs.stripe.com/connect/account-balances.md (Holding funds)
- Practical limit: card disputes can be filed "within 120 days of the original
  payment." — https://docs.stripe.com/disputes/how-disputes-work.md
- "Stripe doesn't provide escrow services or support escrow accounts." Don't call it
  escrow in any copy. — https://docs.stripe.com/connect/manual-payouts.md

### Refunds and disputes while funds are held

- The platform balance is debited for "Stripe fees, refunds, and chargebacks"
  (https://docs.stripe.com/connect/charges.md). Before the transfer there is nothing
  to reverse; a refund comes straight out of TeeBox's balance.
- After a transfer, a dispute debits TeeBox, which "can attempt to recover funds from
  the connected account by reversing the transfer" — only if the seller's available
  balance covers it.
- Refunding loses the original processing fee ("Stripe's processing fees from the
  original transaction aren't returned" — https://docs.stripe.com/refunds.md).

### Seller of record and statement descriptor (the legal question)

- Held sales cannot use `on_behalf_of` (the seller has no `card_payments`), so
  **TeeBox is the business of record** and TeeBox's descriptor shows on the buyer's
  card statement. Today, with `on_behalf_of`, the seller's descriptor shows.
- Stripe: "Don't present one party as MoR at checkout and another on the statement,
  receipt, customer terms, or dispute process."
  — https://docs.stripe.com/connect/merchant-of-record.md
- Options to put to the lawyer:
  1. Held sales only on separate charges (TeeBox shown), normal sales unchanged
     (seller shown). Quickest, but mixes merchant of record across sales.
  2. All sales without `on_behalf_of` (TeeBox shown on every sale). Consistent;
     needs a terms update (TeeBox as merchant/seller of record) and a review of
     sales-tax and dispute handling.
  3. Hold funds in a way that keeps the seller as merchant — not possible with Stripe
     before the seller's account is active.
- Money transmission: holding a buyer's payment for a third party and paying it out
  later is the classic question for marketplace payment facilitation. Stripe
  Connect's model is designed to cover platforms, but confirm with counsel for
  TeeBox's specific flow (hold window, auto-refund, who bears loss).

### Fees

Same processing rates either way ("Destination charges and separate charges and
transfers typically use the platform's pricing plan"). No per-transfer fee. Connect
fees unchanged: $2 per monthly active account, 0.25% + 25¢ per payout.
— https://docs.stripe.com/connect/charges.md, https://stripe.com/connect/pricing

## Proposed build (when unblocked)

1. **Checkout** (`createPaymentIntent`): if the seller is not charges-ready, create
   the PaymentIntent on the platform with no `transfer_data`/`on_behalf_of`,
   `transfer_group=<orderId>`, metadata `held=1`, and the same fee math
   (`lib/fees.js`); Buy Now returns for those listings.
2. **Order state** `awaiting_seller_payouts`: the shipping label is blocked until the
   seller connects, so the item never ships before the money can be paid.
3. **Seller notices**: email + push immediately ("You sold X — connect payouts to get
   paid and ship within N days"), reminders on days 1, 3 and 7.
4. **Buyer notice**: the seller is finishing setup; automatic full refund if it
   doesn't ship by day N.
5. **Release**: on `account.updated` with `transfers` active, create the Transfer
   (`source_transaction=<chargeId>`, amount = item − fee), unlock the label, start the
   normal ship-by clock.
6. **Expiry sweep** (daily): orders past day N with no connected account → full
   refund, cancel, relist the item, notify both sides.
7. **Disputes before transfer**: TeeBox's balance takes them; nothing to reverse.
8. **Test mode first**: full E2E with `STRIPE_TEST_SECRET_KEY` — connect-then-transfer,
   day-N auto-refund, dispute before transfer, held-orders metrics — before any live
   checkout change (standing rule from r396).

Open decisions: hold window N (recommendation was 14 days, max 30 — well inside the
120-day dispute window), and seller of record (options above).
