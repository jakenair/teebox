// Club boxes, protection, shipping config and the label delta (2026-11-21).
const {test} = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../../lib/shippingParcels");

test("club boxes: three sizes, all 48in long, sent with dims + weight", () => {
  assert.deepEqual(SP.CLUB_BOX_KEYS, ["single", "partial", "full"]);
  for (const k of SP.CLUB_BOX_KEYS) {
    const p = SP.parcelForKey("clubs:" + k);
    assert.equal(p.length, "48");
    for (const f of ["length", "width", "height", "weight"]) assert.ok(Number(p[f]) > 0, `${k}.${f}`);
    assert.equal(p.distance_unit, "in");
    assert.equal(p.mass_unit, "lb");
  }
  assert.deepEqual(SP.parcelForKey("clubs:single"), {length: "48", width: "8", height: "8", weight: "7", distance_unit: "in", mass_unit: "lb"});
  assert.equal(SP.parcelForKey("clubs:partial").weight, "12");
  assert.equal(SP.parcelForKey("clubs:full").weight, "22");
  assert.equal(SP.parcelForKey("clubs:bogus"), null);
  assert.equal(SP.parcelForKey("bags").length, "38");
});

test("every category resolves to a parcel with all four numbers", () => {
  for (const cat of ["clubs", "bags", "shoes", "apparel", "accessories", "headcovers", "balls", "shafts", ""]) {
    const {key, parcel} = SP.parcelForListing({cat});
    for (const f of ["length", "width", "height", "weight"]) assert.ok(Number(parcel[f]) > 0, `${cat}:${key}.${f}`);
  }
  assert.equal(SP.parcelForListing({cat: "clubs"}).key, "clubs:single");
  assert.equal(SP.parcelForListing({cat: "Bags"}).key, "bags");
  assert.equal(SP.parcelForListing({cat: "shafts"}).key, "default", "shafts still have no box of their own (flagged)");
});

test("classifier: seller pick wins", () => {
  assert.equal(SP.classifyClubBox({specs: {shipBox: "full"}, title: "Scotty Cameron putter"}).box, "full");
  assert.equal(SP.classifyClubBox({specs: {shipBox: "nope"}, title: "Scotty Cameron putter"}).box, "single");
});

test("classifier: iron set counted from setFrom/setTo", () => {
  const c = (from, to) => SP.classifyClubBox({specCategory: "iron-set", specs: {setFrom: from, setTo: to}});
  assert.equal(c("4", "PW").box, "partial"); // 7 clubs
  assert.equal(c("5", "PW").box, "partial");
  assert.equal(c("3", "PW").box, "full"); // 8
  assert.equal(c("4", "GW").box, "full"); // 8
  assert.equal(c("7", "9").box, "single"); // 3
  assert.equal(SP.ironRangeCount("4", "PW"), 7);
  assert.equal(SP.ironRangeCount("9", "4"), null);
});

test("classifier: title/description", () => {
  const t = (title, extra = {}) => SP.classifyClubBox({title, ...extra});
  assert.equal(t("Mizuno JPX 923 Hot Metal 5-PW").box, "partial");
  assert.equal(t("Ping G430 irons 4 thru GW").box, "full");
  assert.equal(t("Full set, 14 clubs + bag").box, "full");
  assert.equal(t("Complete set Callaway Strata").box, "full");
  assert.equal(t("Titleist 3 piece wedge bundle").box, "single");
  const irons = t("Callaway Steelhead XR Irons");
  assert.equal(irons.box, "partial");
  assert.equal(irons.confident, false, "set without a count goes on the review list");
  const fw = t("Cobra Fairway 16°", {specCategory: "fairway", desc: "hosel set to 16"});
  assert.equal(fw.box, "single");
  assert.equal(fw.confident, true);
  assert.equal(t("TaylorMade Qi10 Driver").box, "single");
  assert.equal(t("TaylorMade Qi10 Driver").source, "default");
  assert.equal(t("Vokey wedge set", {desc: "52 56 60"}).box, "single");
});

test("protection: only over the threshold, ceil of the rate, insured at item price", () => {
  const cfg = SP.cleanConfig({});
  assert.deepEqual(SP.protectionFor(10000, cfg), {protectionCents: 0, insuredCents: 0}, "exactly $100 is not over");
  assert.deepEqual(SP.protectionFor(10001, cfg), {protectionCents: 126, insuredCents: 10001});
  assert.deepEqual(SP.protectionFor(40000, cfg), {protectionCents: 500, insuredCents: 40000});
  assert.deepEqual(SP.protectionFor(40000, {...cfg, protectionFixedCents: 100}), {protectionCents: 600, insuredCents: 40000});
  assert.deepEqual(SP.protectionFor(40000, {...cfg, protectionEnabled: false}), {protectionCents: 0, insuredCents: 0});
  assert.deepEqual(SP.protectionFor(5000, {...cfg, protectionThresholdCents: 2500}), {protectionCents: 63, insuredCents: 5000});
  assert.deepEqual(SP.shippoInsurance(40000), {amount: "400.00", currency: "USD", content: "Golf equipment"});
  assert.equal(SP.shippoInsurance(0), null);
});

test("config: defaults, clean overrides, junk ignored", () => {
  const d = SP.cleanConfig(null);
  assert.equal(d.protectionThresholdCents, 10000);
  assert.equal(d.protectionRateBps, 125);
  assert.equal(d.labelDeltaAlertCents, 500);
  assert.equal(d.opsEmail, "jakenair@teeboxmarket.com");
  const c = SP.cleanConfig({protectionRateBps: 150, protectionThresholdCents: 20000, protectionEnabled: false,
    labelDeltaAlertCents: "9", opsEmail: "not an email", protectionFixedCents: 99999});
  assert.equal(c.protectionRateBps, 150);
  assert.equal(c.protectionThresholdCents, 20000);
  assert.equal(c.protectionEnabled, false);
  assert.equal(c.labelDeltaAlertCents, 500, "string ignored");
  assert.equal(c.opsEmail, "jakenair@teeboxmarket.com");
  assert.equal(c.protectionFixedCents, 0, "over cap ignored");
  assert.equal(SP.cleanConfig({protectionRateBps: 5000}).protectionRateBps, 125, "rate capped at 10%");
});

test("config: read once per minute from config/shipping", async () => {
  SP._resetConfigCache();
  let reads = 0;
  const db = {doc: (p) => ({get: async () => { reads++; assert.equal(p, "config/shipping"); return {exists: true, data: () => ({protectionRateBps: 200})}; }})};
  assert.equal((await SP.getShippingConfig(db, 1000)).protectionRateBps, 200);
  await SP.getShippingConfig(db, 30000);
  assert.equal(reads, 1);
  await SP.getShippingConfig(db, 70000);
  assert.equal(reads, 2);
  SP._resetConfigCache();
  const broken = {doc: () => ({get: async () => { throw new Error("down"); }})};
  assert.equal((await SP.getShippingConfig(broken, 1)).protectionRateBps, 125, "read failure falls back to defaults");
  SP._resetConfigCache();
});

test("names + descriptions", () => {
  assert.equal(SP.boxName("clubs:partial"), "Partial set / 4-7 clubs");
  assert.equal(SP.boxName("bags"), "Bag box");
  assert.equal(SP.describeParcel(SP.parcelForKey("clubs:full")), "48 × 14 × 10 in, up to 22 lb");
});

test("client box table matches the server", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "..", "js", "app-auth.js"), "utf8");
  for (const k of SP.CLUB_BOX_KEYS) {
    const want = SP.describeParcel(SP.parcelForKey("clubs:" + k));
    const re = new RegExp(`${k}:\\s*\\{[^}]*dims: '${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`);
    assert.ok(re.test(src), `js/app-auth.js SHIP_BOXES.${k} should say "${want}"`);
  }
  const main = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "..", "js", "app-main.js"), "utf8");
  for (const [k, p] of Object.entries(SP.CATEGORY_PARCELS)) {
    assert.ok(main.includes(`${k}: { name:`) && main.includes(SP.describeParcel(p)), `js/app-main.js SHIP_PARCEL_HINTS.${k}`);
  }
});

// ── shippoIntegration helpers ─────────────────────────────────────────
const SI = require("../../shippoIntegration")._internal;

test("withProtection adds protection to the shipping line and keeps the split", () => {
  const q = SI.withProtection({shippingCents: 2754, method: "live", parcelKey: "clubs:single"}, 40000, SP.cleanConfig({}));
  assert.equal(q.carrierCents, 2754);
  assert.equal(q.protectionCents, 500);
  assert.equal(q.insuredCents, 40000);
  assert.equal(q.shippingCents, 3254);
  assert.deepEqual(SI.shippingMetadata(q), {shippingCents: "3254", shippingCarrierCents: "2754",
    shippingProtectionCents: "500", insuredValueCents: "40000", shippingParcelKey: "clubs:single"});
  const cheap = SI.withProtection({shippingCents: 1400, method: "flat", parcelKey: "shoes"}, 9000, SP.cleanConfig({}));
  assert.equal(cheap.shippingCents, 1400);
  assert.equal(cheap.protectionCents, 0);
});

test("flat categories get protection too; live categories return null", async () => {
  SP._resetConfigCache();
  const db = {doc: () => ({get: async () => ({exists: false})})};
  const shoes = await SI.flatQuoteForListing(db, {cat: "shoes"}, 18000);
  assert.equal(shoes.carrierCents, 1400);
  assert.equal(shoes.protectionCents, 225);
  assert.equal(shoes.shippingCents, 1625);
  assert.equal(shoes.parcelKey, "shoes");
  assert.equal(await SI.flatQuoteForListing(db, {cat: "clubs"}, 18000), null);
  SP._resetConfigCache();
});

test("listingItemCents", () => {
  assert.equal(SI.listingItemCents({ask: 129.99}, 2), 25998);
  assert.equal(SI.listingItemCents({ask: 50}, "x"), 5000);
  assert.equal(SI.listingItemCents({ask: 50}, 500), 495000);
  assert.equal(SI.listingItemCents({}, 1), 0);
});

test("label delta: quoted = shipping line, actual = label (incl. insurance)", () => {
  const d = SI.labelDeltaDoc({orderId: "pi_1", env: "test", carrier: "UPS", parcelKey: "clubs:full",
    order: {shippingCents: 3254, shippingCarrierCents: 2754, shippingProtectionCents: 500, sellerId: "s", listingId: "l", shippingMethod: "live"},
    rate: {amount: "40.10", servicelevel: {token: "ups_ground"}}});
  assert.equal(d.quotedCents, 3254);
  assert.equal(d.actualCents, 4010);
  assert.equal(d.deltaCents, 756);
  assert.equal(d.protectionCents, 500);
  assert.equal(d.service, "ups_ground");
  const legacy = SI.labelDeltaDoc({orderId: "pi_2", env: "live", order: {}, rate: {amount: "9.00"}});
  assert.equal(legacy.quotedCents, 0);
  assert.equal(legacy.quotedCarrierCents, null);
  assert.equal(legacy.shippingMethod, "legacy");
});

test("quoteShippingCents sends the box dims + weight for the listing", async () => {
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return {ok: true, status: 201, json: async () => ({rates: [
      {provider: "UPS", amount: "34.10", servicelevel: {token: "ups_ground", name: "Ground"}, estimated_days: 5, object_id: "r1"},
      {provider: "USPS", amount: "80.61", servicelevel: {token: "usps_ground_advantage", name: "Ground Advantage"}, object_id: "r2"},
    ]})};
  };
  try {
    const q = await SI.quoteShippingCents("shippo_test_x", {cat: "clubs", specs: {shipBox: "partial"}}, {}, {});
    assert.deepEqual(sent.parcels, [SP.parcelForKey("clubs:partial")]);
    assert.equal(q.cents, 3410);
    assert.equal(q.parcelKey, "clubs:partial");
    assert.equal(q.estimatedDays, 5);
    const flat = await SI.quoteShippingCents("k", {cat: "apparel"}, {}, {});
    assert.equal(flat.method, "flat");
    assert.equal(flat.parcelKey, "apparel");
  } finally {
    global.fetch = realFetch;
  }
});

test("carrier allow-list: quote and label use the same purchasable carriers", () => {
  const rates = [{provider: "UPS", amount: "27.54"}, {provider: "USPS", amount: "63.89"}];
  assert.equal(SP.filterCarriers(rates, SP.cleanConfig({})).length, 2, "empty = all");
  assert.deepEqual(SP.filterCarriers(rates, SP.cleanConfig({carriers: ["usps"]})).map((r) => r.provider), ["USPS"]);
  assert.deepEqual(SP.cleanConfig({carriers: ["USPS", 7, "<script>"]}).carriers, ["USPS"]);
  assert.equal(SI.pickRate(SP.filterCarriers(rates.map((r, i) => ({...r, object_id: "r" + i, servicelevel: {token: r.provider.toLowerCase() + "_ground", name: "Ground"}})), SP.cleanConfig({carriers: ["USPS"]})), 7).provider, "USPS");
});
