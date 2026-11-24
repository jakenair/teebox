"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../../lib/buyable");
const A = {name: "N", line1: "1 A St", line2: "", city: "X", state: "IL", postal_code: "60647", phone: "", country: "US"};

test("stamped address: still complete, and the stamp reads back", () => {
  for (const s of B.SHIP_FROM_SOURCES) {
    const u = {shippingFrom: {...A, ...B.shipFromStamp(s, A, 5)}};
    assert.equal(B.hasShipFrom(u), true);
    assert.deepEqual(B.shipFromChange(u), {updatedAt: 5, source: s});
  }
  assert.throws(() => B.shipFromStamp("other", A, 5));
});

test("an older app saves over a stamped address: no stale stamp is reported", () => {
  const u = {shippingFrom: {...A, ...B.shipFromStamp("web_settings", A, 5), line1: "2 B St"}};
  assert.equal(B.hasShipFrom(u), true);
  assert.equal(B.shipFromChange(u), null);
  assert.equal(B.shipFromChange({shippingFrom: A}), null);
  assert.equal(B.shipFromChange({}), null);
});

test("the label and quote address never carries the stamp", () => {
  const SI = require("../../shippoIntegration")._internal;
  const n = SI.normalizeAddress({...A, ...B.shipFromStamp("ios_settings", A, 5)});
  assert.deepEqual(Object.keys(n).sort(), ["city", "country", "email", "name", "phone", "state", "street1", "street2", "zip"]);
});
