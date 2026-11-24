const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../lib/listingSchema");
const P = require("../../lib/shippingParcels");
const base = {title: "Ping driver", brand: "Ping", category: "other", cat: "clubs", condition: "Good", price: "50", photoCount: 1};
const req = (k) => Object.fromEntries(S.SPECS.categories[k].fields.filter((f) => f.req).map((f) => [f.k, f.options ? f.options[0] : "x"]));

test("shipBox from a partner: optional, one of three, and it drives the parcel", () => {
  const go = (o) => S.validateListingInput({...base, category: "driver", specs: {...req("driver"), ...o}});
  assert.equal(go({}).ok, true);
  assert.equal(go({shipBox: "enormous"}).ok, false);
  const v = go({shipBox: "full"});
  assert.equal(v.ok, true);
  assert.equal(P.parcelForListing({cat: "clubs", specs: v.value.specs}).key, "clubs:full");
  assert.equal(P.parcelForListing({cat: "clubs", specCategory: "driver", specs: go({}).value.specs}).key, "clubs:single");
});
