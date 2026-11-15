"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const T = require("../../tiktokEvents");
const {buildTikTokEvent, buildBody, hashEmail, EVENT_MAP} = T._internal;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

test("ViewContent: content_id is the listing doc id, content_type product, USD value", () => {
  const ev = buildTikTokEvent({name: "ViewContent", eventId: "vc_abc_1", contentId: "R6MhjH4WRizoRn9UTa90", value: 100, now: 1700000000, ttp: "t1"});
  assert.equal(ev.event, "ViewContent");
  assert.equal(ev.event_id, "vc_abc_1");
  assert.equal(ev.event_time, 1700000000);
  assert.deepEqual(ev.properties.contents, [{content_id: "R6MhjH4WRizoRn9UTa90", quantity: 1}]);
  assert.equal(ev.properties.content_type, "product");
  assert.equal(ev.properties.currency, "USD");
  assert.equal(ev.properties.value, 100);
  assert.equal(ev.page.url, "https://teeboxmarket.com/?listing=R6MhjH4WRizoRn9UTa90");
  assert.equal(typeof ev.properties.contents[0].content_id, "string");
});

test("Purchase maps to TikTok CompletePayment with the shared purchase_<pi> id", () => {
  const ev = buildTikTokEvent({name: "Purchase", eventId: "purchase_pi_123", contentId: "L1", value: 55.5, price: 50, quantity: 1, email: "x@y.com"});
  assert.equal(ev.event, "CompletePayment");
  assert.equal(ev.event_id, "purchase_pi_123");
  assert.equal(ev.properties.value, 55.5);
  assert.equal(ev.properties.contents[0].price, 50);
});

test("email is SHA-256 of trimmed lower-case; never sent raw; phone is never sent", () => {
  const ev = buildTikTokEvent({name: "AddToCart", eventId: "atc_1", contentId: "L1", email: "  Jake@Example.COM ", phone: "+15555550100", phone_number: "+15555550100", uid: "u1"});
  assert.equal(ev.user.email, sha("jake@example.com"));
  assert.equal("external_id" in ev.user, false); // hashed email only
  assert.equal(JSON.stringify(ev).includes("Example"), false);
  assert.equal(JSON.stringify(ev).includes("5555550100"), false);
  assert.equal("phone" in ev.user, false);
  assert.equal("phone_number" in ev.user, false);
  assert.equal(hashEmail("not-an-email"), "");
});

test("unknown events, missing event id or content id are not sent", () => {
  assert.equal(buildTikTokEvent({name: "PageView", eventId: "pv", contentId: "L1"}), null);
  assert.equal(buildTikTokEvent({name: "ViewContent", eventId: "", contentId: "L1"}), null);
  assert.equal(buildTikTokEvent({name: "ViewContent", eventId: "vc", contentId: ""}), null);
  assert.deepEqual(Object.keys(EVENT_MAP).sort(), ["AddToCart", "InitiateCheckout", "Purchase", "ViewContent"]);
});

test("value falls back to price x quantity; absurd values dropped", () => {
  const a = buildTikTokEvent({name: "InitiateCheckout", eventId: "ic", contentId: "L1", price: 20, quantity: 2});
  assert.equal(a.properties.value, 40);
  const b = buildTikTokEvent({name: "InitiateCheckout", eventId: "ic", contentId: "L1", value: 1e9});
  assert.equal("value" in b.properties, false);
});

test("body: web source, pixel code, optional test_event_code", () => {
  const ev = buildTikTokEvent({name: "ViewContent", eventId: "vc", contentId: "L1"});
  assert.deepEqual(Object.keys(buildBody(ev, "PIX")), ["event_source", "event_source_id", "data"]);
  assert.equal(buildBody(ev, "PIX", "TEST1").test_event_code, "TEST1");
  assert.equal(buildBody(ev, "PIX").event_source, "web");
});

test("pixel id is TeeBox Web; without a token the send is skipped, never throws", async () => {
  assert.equal(T._internal.TIKTOK_PIXEL_ID, "DBSAT0BC77UDGS03KQN0");
  assert.equal(await T.sendTikTokEvent({name: "ViewContent", eventId: "vc", contentId: "L1", ttp: "x"}), "no-token");
  assert.equal(T.cleanTikTokTestCode("TEST123"), "TEST123");
  assert.equal(T.cleanTikTokTestCode("bad code!"), "");
});

test("TikTok feed: same rows, key column renamed id -> sku_id", () => {
  const F = require("../../metaFeed")._feed;
  const l = {id: "L1", status: "active", photos: ["https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/x.jpg?alt=media&token=t"], ask: 50, title: "Putter", brand: "Ping", cat: "clubs"};
  const meta = F.buildFeedCsv([l], new Set()).csv;
  const tt = F.toTikTokCsv(meta);
  assert.ok(meta.startsWith("id,title,"));
  assert.ok(tt.startsWith("sku_id,title,"));
  assert.equal(tt.split("\r\n")[1], meta.split("\r\n")[1]);
  assert.equal(tt.split("\r\n")[1].split(",")[0], "L1");
});
