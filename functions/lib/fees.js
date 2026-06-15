// functions/lib/fees.js
//
// Single source of truth for the marketplace fee/payout math. Extracted from
// createPaymentIntent so the arithmetic can be unit-tested in isolation (no
// Stripe, no emulator) and so the "you'll net $X" seller-side estimate can
// reuse the EXACT same function the charge uses — no drift between the quote
// and the actual application_fee.
//
// Pro Seller subscribers ($14.99/mo, tier === "pro") pay 3%; everyone else
// pays 6.5%. `tier` is server-written by stripeWebhook on subscription events
// and whitelisted out of client writes by firestore.rules, so a client cannot
// fabricate a lower fee.

const PLATFORM_FEE_PERCENT = 0.065;
const PLATFORM_FEE_PERCENT_PRO = 0.03;

/**
 * Compute the platform fee + seller payout for a sale.
 * @param {number} priceCents  integer sale price in cents (the buyer's item total)
 * @param {string} tier        "pro" → 3%; anything else → 6.5%
 * @return {{tier: string, feeRate: number, platformFeeCents: number,
 *           sellerPayoutCents: number}}
 */
function computeFees(priceCents, tier) {
  const cents = Math.max(0, Math.round(Number(priceCents) || 0));
  const normalizedTier = tier === "pro" ? "pro" : "free";
  const feeRate = normalizedTier === "pro"
    ? PLATFORM_FEE_PERCENT_PRO
    : PLATFORM_FEE_PERCENT;
  // Match the historical inline behavior exactly: Math.round on the fee, payout
  // is the remainder. Rounding the fee (not the payout) keeps the platform fee
  // the rounded value and guarantees fee + payout === price (no lost cent).
  const platformFeeCents = Math.round(cents * feeRate);
  const sellerPayoutCents = cents - platformFeeCents;
  return {tier: normalizedTier, feeRate, platformFeeCents, sellerPayoutCents};
}

module.exports = {
  computeFees,
  PLATFORM_FEE_PERCENT,
  PLATFORM_FEE_PERCENT_PRO,
};
