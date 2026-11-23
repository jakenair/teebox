// functions/test/unit/paidListing.test.js — what a payment does to a listing; when a delete must wait.
const test = require("node:test");
const assert = require("node:assert/strict");
const {afterSale, isMissingListing} = require("../../lib/paidListing");
const {inCheckout} = require("../../lib/checkoutHold");

test("a payment never puts a listing back on sale", () => {
  const multi = {quantity: 5, quantitySold: 1, quantityReserved: 1};
  assert.equal(afterSale({...multi, status: "active"}, 1).status, "active");
  assert.equal(afterSale({...multi, status: "pending"}, 1).status, "active");
  for (const st of ["removed", "flagged", "hidden", "expired"]) assert.equal(afterSale({...multi, status: st}, 1).status, st);
  assert.equal(afterSale({quantity: 1, status: "pending"}, 1).status, "sold");
  assert.equal(afterSale({quantity: 1, status: "removed"}, 1).status, "removed");
  assert.equal(afterSale({}, 1).status, "sold");
});

test("counters are the same arithmetic as before", () => {
  assert.deepEqual(afterSale({status: "active", quantity: 3, quantitySold: 1, quantityReserved: 2}, 1),
      {status: "active", quantitySold: 2, quantityReserved: 1, fullySold: false});
  assert.deepEqual(afterSale({status: "pending", quantity: 3, quantitySold: 1, quantityReserved: 2}, 2),
      {status: "sold", quantitySold: 3, quantityReserved: 0, fullySold: true});
  assert.equal(afterSale({quantity: 2, quantityReserved: 0}, 1).quantityReserved, 0);
});

test("missing = no document, or a ghost with neither seller nor title", () => {
  const snap = (d) => ({exists: !!d, data: () => d});
  assert.equal(isMissingListing(null), true);
  assert.equal(isMissingListing(snap(null)), true);
  assert.equal(isMissingListing(snap({pendingUntil: 1})), true);
  assert.equal(isMissingListing(snap({sellerId: "s", status: "removed"})), false);
});

test("in checkout: any open hold; lapsed holds don't block", () => {
  const now = 1e12;
  const later = {toMillis: () => now + 6e4};
  const past = {toMillis: () => now - 1};
  for (const h of [{status: "pending"}, {quantityReserved: 1}, {pendingPaymentIntentId: "pi"}]) {
    assert.equal(inCheckout({...h, pendingUntil: later}, now), true);
    assert.equal(inCheckout(h, now), true, "no window recorded");
    assert.equal(inCheckout({...h, pendingUntil: past}, now), false);
  }
  assert.equal(inCheckout({status: "active", quantityReserved: 0}, now), false);
  assert.equal(inCheckout({status: "active", pendingUntil: later}, now), false);
});
