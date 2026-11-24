const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../../lib/dailyDigestCore");

test("Central days, DST included", () => {
  assert.equal(new Date(C.ctMidnight("2026-11-23")).toISOString(), "2026-11-23T06:00:00.000Z");
  assert.equal(new Date(C.ctMidnight("2026-07-01")).toISOString(), "2026-07-01T05:00:00.000Z");
  assert.equal((C.ctMidnight("2026-11-02") - C.ctMidnight("2026-11-01")) / 36e5, 25);
  assert.equal((C.ctMidnight("2027-03-15") - C.ctMidnight("2027-03-14")) / 36e5, 23);
  assert.equal(C.ctDate(Date.parse("2026-11-24T05:59:00Z")), "2026-11-23");
  assert.equal(C.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(C.isMonday("2026-11-23"), true);
});
test("money: live and real only; GMV is items, paid includes shipping", () => {
  const m = C.moneyFrom([{amountCents: 5000, itemCents: 4000, shippingCents: 1000, platformFeeCents: 340, sellerPayoutCents: 3660, livemode: true},
    {amountCents: 9900, livemode: false}, {amountCents: 9900, buyerId: "qa_x"}, {amount: 3500}]);
  assert.deepEqual([m.orders, m.gmvCents, m.paidCents, m.feeCents], [2, 7500, 8500, 340]);
});
const M = (o) => ({date: "2026-11-22", money: C.moneyFrom([]), supply: {newListings: 1, byCategory: {clubs: 1}, askCents: 100, sellersListing: 1, highValue: 0, activeListings: 9},
  demand: {newUsers: 2, listingViews: 3, listingsViewed: 1, conversations: null, offers: 0, savedSearches: 0},
  health: {ordersUnshippedOver3Days: 0, holdsPending: 1, flagged: 0, reports: 0, highValueToSee: 0, emailsSent: 1, emailsBounced: 0, emailsComplained: 0},
  top: [{id: "a", title: "<b>Putter</b>", askCents: 100, status: "active", views: 1}], errors: [], ...o});
test("email: four sections, escaped titles, test prefix, missing numbers say so", () => {
  const r = C.render(M(), {test: true});
  assert.match(r.subject, /^\[TEST\] TeeBox daily: Sunday, November 22$/);
  for (const s of ["Money", "Supply", "Demand", "Health", "Top listings"]) assert.ok(r.html.includes(s) && r.text.includes(s));
  assert.ok(!r.html.includes("<b>Putter") && r.html.includes("&lt;b&gt;Putter"));
  assert.ok(r.text.includes("Conversations started: not available"));
  assert.ok(!/Last week/.test(r.html));
  assert.ok(!/@/.test(r.text));
});
test("Monday section", () => {
  const w = C.weekly([M(), M()]);
  assert.deepEqual([w.days, w.newUsers, w.listingViews], [2, 4, 6]);
  assert.match(C.render(M(), {week: w}).html, /Last week \(2 of 7 days on record\)/);
});
