// functions/test/unit/fees.test.js
// Pure unit tests for the fee/payout math. No Stripe, no emulator, no Java.
// Run: npm test   (node --test)

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  computeFees,
  PLATFORM_FEE_PERCENT,
  PLATFORM_FEE_PERCENT_PRO,
} = require("../../lib/fees");

test("free tier charges 6.5%", () => {
  const r = computeFees(10000, "free");
  assert.equal(r.tier, "free");
  assert.equal(r.feeRate, 0.065);
  assert.equal(r.platformFeeCents, 650);
  assert.equal(r.sellerPayoutCents, 9350);
});

test("pro tier charges 3%", () => {
  const r = computeFees(10000, "pro");
  assert.equal(r.tier, "pro");
  assert.equal(r.feeRate, 0.03);
  assert.equal(r.platformFeeCents, 300);
  assert.equal(r.sellerPayoutCents, 9700);
});

test("missing / unknown tier defaults to free (6.5%) — no client-fabricated discount", () => {
  for (const t of [undefined, null, "", "FREE", "Pro", "PRO", "gold", 0, true]) {
    const r = computeFees(10000, t);
    assert.equal(r.tier, "free", `tier=${JSON.stringify(t)} should be free`);
    assert.equal(r.platformFeeCents, 650);
  }
  // Only the exact lowercase "pro" string gets the discount.
  assert.equal(computeFees(10000, "pro").platformFeeCents, 300);
});

test("fee rounds half-up and fee + payout always equals price", () => {
  // 7700 * 0.065 = 500.5 → rounds to 501 (Math.round half-up).
  const r = computeFees(7700, "free");
  assert.equal(r.platformFeeCents, 501);
  assert.equal(r.sellerPayoutCents, 7199);
  assert.equal(r.platformFeeCents + r.sellerPayoutCents, 7700);
});

test("invariant: fee + payout === price across a wide range, both tiers", () => {
  for (let price = 0; price <= 500000; price += 137) {
    for (const tier of ["free", "pro"]) {
      const r = computeFees(price, tier);
      assert.equal(
          r.platformFeeCents + r.sellerPayoutCents, price,
          `price=${price} tier=${tier} fee+payout must equal price`);
      assert.ok(r.platformFeeCents >= 0 && r.sellerPayoutCents >= 0,
          `price=${price} tier=${tier} must be non-negative`);
      assert.ok(r.platformFeeCents <= price,
          `price=${price} tier=${tier} fee must not exceed price`);
    }
  }
});

test("zero price → zero fee and zero payout", () => {
  const r = computeFees(0, "free");
  assert.equal(r.platformFeeCents, 0);
  assert.equal(r.sellerPayoutCents, 0);
});

test("non-integer / garbage price is coerced to a safe integer", () => {
  assert.equal(computeFees(99.7, "free").platformFeeCents,
      computeFees(100, "free").platformFeeCents); // rounds price first
  assert.equal(computeFees(-500, "free").platformFeeCents, 0); // clamped to 0
  assert.equal(computeFees("abc", "free").platformFeeCents, 0); // NaN → 0
  assert.equal(computeFees(NaN, "free").sellerPayoutCents, 0);
});

test("large amount stays exact (no float drift)", () => {
  const r = computeFees(1000000, "pro"); // $10,000 sale, pro
  assert.equal(r.platformFeeCents, 30000);
  assert.equal(r.sellerPayoutCents, 970000);
});

test("exported constants match the documented rates", () => {
  assert.equal(PLATFORM_FEE_PERCENT, 0.065);
  assert.equal(PLATFORM_FEE_PERCENT_PRO, 0.03);
});
