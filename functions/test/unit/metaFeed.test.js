// functions/test/unit/metaFeed.test.js — pure feed builder.
const test = require("node:test");
const assert = require("node:assert/strict");
const {_feed: F} = require("../../metaFeed");

const IMG = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/x.jpg?alt=media&token=t";
const base = (over = {}) => ({
  id: "abc123", title: "Titleist T100 irons, 4-PW", brand: "Titleist", cat: "clubs",
  ask: 850, condition: "Very Good", desc: "Line one.\nLine two <b>bold</b> &amp; more.",
  photos: [IMG, IMG + "2"], status: "active", quantity: 1, quantitySold: 0, ...over,
});

test("row shape, price format, link, categories", () => {
  const r = F.feedRow(base());
  assert.equal(r.price, "850.00 USD");
  assert.equal(r.link, "https://teeboxmarket.com/listing/abc123/");
  assert.equal(r.image_link, IMG);
  assert.equal(r.additional_image_link, IMG + "2");
  assert.equal(r.google_product_category, "1046");
  assert.equal(r.product_type, "Golf > Clubs");
  assert.equal(r.item_group_id, "abc123");
  assert.equal(r.description, "Line one. Line two bold & more.");
});
test("condition mapping", () => {
  assert.equal(F.mapCondition("New with Tags"), "new");
  assert.equal(F.mapCondition("Like New"), "used");
  assert.equal(F.mapCondition("Fair"), "used");
  assert.equal(F.mapCondition("Refurbished"), "refurbished");
  assert.equal(F.mapCondition(""), "used");
});
test("availability: active in stock, pending/sold out of stock, multi-unit respected", () => {
  assert.equal(F.mapAvailability(base()), "in stock");
  assert.equal(F.mapAvailability(base({status: "pending"})), "out of stock");
  assert.equal(F.mapAvailability(base({status: "sold"})), "out of stock");
  assert.equal(F.mapAvailability(base({quantity: 2, quantitySold: 1})), "in stock");
  assert.equal(F.mapAvailability(base({quantity: 2, quantitySold: 1, quantityReserved: 1})), "out of stock");
});
test("omits expired/removed/flagged, photo-less, non-https and zero-price rows", () => {
  assert.equal(F.feedRow(base({status: "expired"})), null);
  assert.equal(F.feedRow(base({status: "flagged"})), null);
  assert.equal(F.feedRow(base({photos: []})), null);
  assert.equal(F.feedRow(base({photos: ["http://evil.example/x.jpg"]})), null);
  assert.equal(F.feedRow(base({ask: 0})), null);
});
test("CSV escaping + header + CRLF", () => {
  const {csv, rows, skipped} = F.buildFeedCsv([base({title: 'Says "hi", twice', status: "active"}), base({status: "expired"})]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], F.COLUMNS.join(","));
  assert.match(lines[1], /^abc123,"Says ""hi"", twice",/);
  assert.equal(rows, 1); assert.equal(skipped, 1);
});
test("description capped at 5000 chars", () => {
  const r = F.feedRow(base({desc: "x".repeat(6000)}));
  assert.ok(r.description.length <= 5000);
});
