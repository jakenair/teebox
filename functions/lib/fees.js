// functions/lib/fees.js
//
// Single source of truth for the marketplace fee/payout math. Extracted from
// createPaymentIntent so the arithmetic can be unit-tested in isolation (no
// Stripe, no emulator) and so the "you'll net $X" seller-side estimate can
// reuse the EXACT same function the charge uses — no drift between the quote
// and the actual application_fee.
//
// Pro Seller subscribers ($14.99/mo, tier === "pro") pay the same 8.5% as everyone else. `tier` is server-written by stripeWebhook on subscription events
// and whitelisted out of client writes by firestore.rules, so a client cannot
// fabricate a lower fee.

const PLATFORM_FEE_PERCENT = 0.085;
// Pro repriced to match the standard rate (8.5% since 2026-08-27, was 6.5%) (founder ruling, Phase 2 2026-08-25): at 3% the
// platform cleared ~0.1% after Stripe's variable rate — a guaranteed
// per-sale loss at every realistic price. Zero accounts were ever on Pro,
// so nobody is grandfathered. The tier plumbing (server-written `tier`,
// webhook, rules whitelist) is kept intact for a future perks-based
// re-launch; signup is disabled in createSubscriptionCheckout.
const PLATFORM_FEE_PERCENT_PRO = 0.085;

/**
 * Compute the platform fee + seller payout for a sale.
 * @param {number} priceCents  integer sale price in cents (the buyer's item total)
 * @param {string} tier        "pro" and everything else → 8.5% (flat since 2026-08-27)
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
