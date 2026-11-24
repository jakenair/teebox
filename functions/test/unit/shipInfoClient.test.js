// js/ship-info.js (browser) says the same ship-by date as lib/shipBy.js (server).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const C = require(path.join("..", "..", "..", "js", "ship-info.js"));
const S = require("../../lib/shipBy");
const P = require("../../lib/shippingParcels");

test("same ship-by date, every 7 hours for two years", () => {
  for (let ms = Date.parse("2026-01-01T00:00:00Z"); ms < Date.parse("2028-01-01T00:00:00Z"); ms += 7 * 36e5) {
    assert.equal(C.shipByDate(ms), S.shipBy(ms).date, new Date(ms).toISOString());
  }
});
test("totals: separate rows, protection only when paid, nothing without the split", () => {
  const h = C.totalsHtml({amountCents: 24120, itemCents: 20000, shippingCents: 4120, shippingCarrierCents: 3870, shippingProtectionCents: 250});
  for (const t of ["Item", "$200.00", "Shipping", "$38.70", "Protection", "$2.50", "Total", "$241.20"]) assert.ok(h.includes(t), t);
  assert.ok(!C.totalsHtml({amountCents: 3500, itemCents: 2500, shippingCents: 1000}).includes("Protection"));
  assert.equal(C.totalsHtml({amount: 35}), "");
});
test("timeline: escaped, newest first", () => {
  const h = C.timelineHtml({fulfillmentStatus: "shipped", estimatedDelivery: "2026-11-27", trackingEvents: [
    {at: 1, status: "PRE_TRANSIT", text: "<img src=x>", place: ""}, {at: 2, status: "TRANSIT", text: "", place: "Chicago, IL"}]});
  assert.ok(h.indexOf("In transit") < h.indexOf("Label created"));
  assert.ok(!h.includes("<img") && h.includes("Expected Friday, November 27"));
  assert.equal(C.timelineHtml({}), "");
});
test("seller: payout, ship-by, guide; QR only for small items without a label", () => {
  const o = {id: "pi_1", fulfillmentStatus: "awaiting_seller_shipment", createdAt: {seconds: Date.now() / 1000}, sellerPayoutCents: 18300, itemCents: 20000, platformFeeCents: 1700};
  const club = C.sellerHtml(o, {cat: "clubs"});
  assert.ok(club.includes("$183.00") && club.includes("Ship by") && club.includes("How to pack it") && !club.includes("data-ship-qr"));
  assert.ok(C.sellerHtml(o, {cat: "shoes"}).includes('data-ship-qr="pi_1"'));
  assert.ok(!C.sellerHtml({...o, labelUrl: "x"}, {cat: "shoes"}).includes("data-ship-qr"));
  assert.equal(C.sellerHtml({...o, refunded: true}, {cat: "shoes"}), "");
});
test("a picture for every club box, a guide for every parcel category", () => {
  for (const k of P.CLUB_BOX_KEYS) assert.ok(C.boxSvg(k).startsWith("<svg"));
  for (const k of ["clubs", ...Object.keys(P.CATEGORY_PARCELS)]) assert.equal(C.GUIDES[k].length, 3, k);
});
test("estimate line", () => {
  assert.match(C.estimateText({totalCents: 4120, protectionCents: 250, zip: "90001", from: "2026-12-01", to: "2026-12-04"}), /^≈ \$41\.20 shipping \+ protection to 90001 · est\. delivery Dec 1 to Dec 4$/);
});
