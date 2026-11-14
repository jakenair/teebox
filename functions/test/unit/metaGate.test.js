// Meta test-traffic gate + server InitiateCheckout (2026-11-14).
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../../lib/metaGate");
const {capiFromRequest, capiMetadata, orderCapiFields} = require("../../lib/capiCarry");
const {_internal: M} = require("../../metaCapi");

const CFG = {internalUids: ["uidJake"], internalEmails: ["jake.nair@gmail.com"]};

test("internal: test domains, *.invalid, listed uid, listed email incl. gmail +tag/dots, claim", () => {
  assert.equal(G.isInternalAccount({email: "appreview@teeboxmarket.com"}, {}), true);
  assert.equal(G.isInternalAccount({email: "x-seller@teeboxqa.dev"}, {}), true);
  assert.equal(G.isInternalAccount({email: "smoke@whatever.invalid"}, {}), true);
  assert.equal(G.isInternalAccount({uid: "uidJake", email: "a@b.com"}, CFG), true);
  assert.equal(G.isInternalAccount({email: "JakeNair+qa7@gmail.com"}, CFG), true);
  assert.equal(G.isInternalAccount({email: "jakenair@googlemail.com"}, CFG), true);
  assert.equal(G.isInternalAccount({email: "buyer@gmail.com", claims: {metaInternal: true}}, {}), true);
});

test("not internal: ordinary buyers, look-alike domains, admin claim alone", () => {
  assert.equal(G.isInternalAccount({uid: "u1", email: "louis@gmail.com"}, CFG), false);
  assert.equal(G.isInternalAccount({email: "x@teeboxmarket.com.evil.io"}, CFG), false);
  assert.equal(G.isInternalAccount({email: "jake.nair@yahoo.com"}, CFG), false);
  assert.equal(G.isInternalAccount({}, CFG), false);
  assert.equal(G.isInternalAccount(null, null), false);
});

test("gate: production sends; internal/non-prod are dropped; a test code always sends tagged", () => {
  assert.deepEqual(G.gateDecision({internal: false, nonProd: false}), {send: true, testEventCode: "", reason: "production"});
  assert.equal(G.gateDecision({internal: true, nonProd: false}).send, false);
  assert.equal(G.gateDecision({internal: false, nonProd: true}).send, false);
  const t = G.gateDecision({internal: true, nonProd: false, testEventCode: "TEST123"});
  assert.equal(t.send, true); assert.equal(t.testEventCode, "TEST123");
});

test("runtime: only teebox-market outside the emulator is production", () => {
  assert.equal(G.isNonProdRuntime({GCLOUD_PROJECT: "teebox-market"}), false);
  assert.equal(G.isNonProdRuntime({GCLOUD_PROJECT: "teebox-market", FUNCTIONS_EMULATOR: "true"}), true);
  assert.equal(G.isNonProdRuntime({GCLOUD_PROJECT: "teebox-staging"}), true);
  assert.equal(G.isNonProdRuntime({}), true);
});

test("platform: Capacitor origin is ios, everything else web", () => {
  assert.equal(capiFromRequest({}, {origin: "capacitor://localhost"}).capiPlatform, "ios");
  assert.equal(capiFromRequest({}, {origin: "https://teeboxmarket.com"}).capiPlatform, "web");
  assert.equal(capiFromRequest({}, {}).capiPlatform, "web");
});

test("IC skip rules: iOS sends, new web (icEventId) sends, legacy web skips, test mode / opt-out skip", () => {
  assert.equal(M.initiateCheckoutSkipReason({platform: "ios", livemode: true}), "");
  assert.equal(M.initiateCheckoutSkipReason({platform: "web", icEventId: "ic_x_1", livemode: true}), "");
  assert.equal(M.initiateCheckoutSkipReason({platform: "web", livemode: true}), "web-client-relays-it");
  assert.equal(M.initiateCheckoutSkipReason({platform: "ios", livemode: false}), "test-mode");
  assert.equal(M.initiateCheckoutSkipReason({platform: "ios", livemode: undefined}), "test-mode");
  assert.equal(M.initiateCheckoutSkipReason({platform: "ios", livemode: true, optOut: true}), "opted-out");
});

test("IC event: iOS id is ic_<PI>, web reuses the pixel id; item value, no shipping", () => {
  const ios = M.buildInitiateCheckoutEvent({paymentIntentId: "pi_1", listingId: "L1", itemCents: 2500, quantity: 1, platform: "ios", userData: {em: "h"}, now: 1});
  assert.equal(ios.event_id, "ic_pi_1");
  assert.equal(ios.custom_data.value, 25);
  assert.equal(ios.custom_data.platform, "ios");
  assert.equal(ios.test_event_code, undefined);
  const web = M.buildInitiateCheckoutEvent({paymentIntentId: "pi_1", icEventId: "ic_L1_abc", listingId: "L1", itemCents: 999, userData: {}, testEventCode: "TEST9", now: 1});
  assert.equal(web.event_id, "ic_L1_abc");
  assert.equal(web.test_event_code, "TEST9");
});

test("carry: icEventId/test code validated; ad attribution allowlisted to the order", () => {
  const c = capiFromRequest({
    icEventId: "ic_L1_abc", testEventCode: "TEST123",
    adAttr: {utm_source: "facebook", utm_campaign: "fall", campaign_id: "1202", evil: "x", utm_term: "\u0000a"},
  }, {origin: "https://teeboxmarket.com"});
  assert.equal(c.capiIcEventId, "ic_L1_abc");
  assert.equal(c.capiTestCode, "TEST123");
  const md = capiMetadata(c);
  for (const v of Object.values(md)) assert.equal(typeof v, "string");
  assert.equal(md.evil, undefined);
  const o = orderCapiFields(md);
  assert.deepEqual(o.adAttribution, {utm_source: "facebook", utm_campaign: "fall", utm_term: "a", campaign_id: "1202"});
  assert.equal(o.checkoutPlatform, "web");
  assert.equal(o.capiTestCode, "TEST123");
  assert.equal(capiFromRequest({icEventId: "bad id <script>"}, {}).capiIcEventId, "");
  assert.equal(capiFromRequest({testEventCode: "x"}, {}).capiTestCode, "");
});

test("Purchase carries the checkout platform", () => {
  const ev = M.buildPurchaseEvent({order: {status: "paid", listingId: "L1", itemCents: 2500, checkoutPlatform: "ios"}, orderId: "pi_9", userData: {em: "h"}, now: 1});
  assert.equal(ev.event_id, "purchase_pi_9");
  assert.equal(ev.custom_data.platform, "ios");
});
