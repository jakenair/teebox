// functions/test/unit/tiktokCatalog.test.js — TikTok CSV builder + image rules.
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const {_tiktok: T} = require("../../tiktokCatalog");

const B = "teebox-market.firebasestorage.app";
const photo = (n, name) => `https://firebasestorage.googleapis.com/v0/b/${B}/o/` +
  encodeURIComponent(`listings/u1/abc123/${name || n + ".jpg"}`) + `?alt=media&token=t${n}`;
const base = (o) => ({id: "abc123", status: "active", title: "Titleist GT3 Driver", desc: "Great club",
  brand: "Titleist", cat: "clubs", condition: "Like New", ask: 299, sellerId: "s1",
  photos: [photo(1), photo(2)], ...o});
const ctx = (o) => ({testSellers: new Set(), blocks: {notReady: new Set(), noShipFrom: new Set()}, now: Date.now(), bucketName: B, ...o});
const row = (o, c) => T.tiktokRow(base(o), ctx(c)).row;

test("row: required fields filled, sku_id = doc id, price and image format", () => {
  const r = row();
  for (const c of T.REQUIRED) assert.ok(r[c], c);
  assert.equal(r.sku_id, "abc123");
  assert.equal(r.price, "299.00 USD");
  assert.equal(r.condition, "used");
  assert.equal(r.link, "https://teeboxmarket.com/?listing=abc123");
  assert.match(r.image_link, /^https:\/\/teebox-market\.web\.app\/feeds\/tiktok\/img\/abc123\/[0-9a-f]{16}\.jpg$/);
  assert.equal(r.additional_image_link.split(",").length, 1);
  assert.ok(!/token|alt=media|listings/.test(r.image_link + r.additional_image_link));
});

test("availability: pending and sold are out of stock; rejected and unbuyable listings are left out", () => {
  assert.equal(row().availability, "in stock");
  assert.equal(row({status: "pending"}).availability, "out of stock");
  assert.equal(row({status: "sold", soldAt: Date.now() - 864e5}).availability, "out of stock");
  assert.equal(T.tiktokRow(base({requiresAuth: true, authReviewState: "rejected"}), ctx()).skip, "authenticity review not passed");
  for (const o of [{requiresAuth: true, authReviewState: "pending"}, {requiresAuth: false, authReviewState: "na"}, {requiresAuth: true, authReviewState: "approved"}]) {
    assert.equal(row({ask: 400, ...o}).availability, "in stock");
  }
});

test("skips: wrong status, no price, no photo, foreign photo, test listing", () => {
  assert.equal(T.tiktokRow(base({status: "removed"}), ctx()).skip, "status removed");
  assert.equal(T.tiktokRow(base({status: "hidden"}), ctx()).skip, "status hidden");
  assert.equal(T.tiktokRow(base({ask: 0}), ctx()).skip, "no price");
  assert.equal(T.tiktokRow(base({photos: []}), ctx()).skip, "no photo");
  assert.ok(T.tiktokRow(base({photos: ["https://evil.example/a.jpg"]}), ctx()).skip);
  assert.ok(T.tiktokRow(base({isTest: true}), ctx()).skip);
  assert.ok(T.tiktokRow(base(), ctx({testSellers: new Set(["s1"])})).skip);
});

test("cleanText strips emoji, control and zero-width characters, keeps trademarks and accents", () => {
  assert.equal(T.cleanText("\u{1F525} Vokey SM10 \u26F3\uFE0F\u0007 56\u00B0\u200B"), "Vokey SM10 56\u00B0");
  assert.equal(T.cleanText("Pro V1® – Café 👩🏽‍🦰🇺🇸 1️⃣"), "Pro V1® – Café 1");
  assert.equal(T.cleanText("half \uD83D surrogate"), "half surrogate");
  assert.equal(row({title: "🔥🔥"}).title, "Golf gear");
});

test("csv: every cell quoted, quotes doubled, CRLF, no BOM, no duplicate ids", () => {
  const {csv, rows, skipped} = T.buildTikTokCsv(
      [base({title: "Says \"hi\", twice"}), base(), base({id: "b", status: "expired"})], ctx());
  const lines = csv.split("\r\n");
  assert.equal(lines[0], T.COLUMNS.map((c) => `"${c}"`).join(","));
  assert.match(lines[1], /^"abc123","Says ""hi"", twice",/);
  assert.equal(rows, 1);
  assert.deepEqual(skipped, {"status expired": 1});
  assert.notEqual(csv.charCodeAt(0), 0xFEFF);
});

test("at most 10 extra images; a replaced photo gets a new URL", () => {
  const r = row({photos: Array.from({length: 15}, (_, i) => photo(i))});
  assert.equal(r.additional_image_link.split(",").length, 10);
  assert.notEqual(T.imageUrl("a", photo(1)), T.imageUrl("a", photo(2)));
});

test("image route only reads listings/ objects in our bucket", () => {
  assert.equal(T.listingObjectPath(photo(1), B), "listings/u1/abc123/1.jpg");
  const at = (p, b) => `https://firebasestorage.googleapis.com/v0/b/${b || B}/o/${encodeURIComponent(p)}?alt=media`;
  assert.equal(T.listingObjectPath(at("users/u1/id.jpg"), B), "");
  assert.equal(T.listingObjectPath(at("listings/../users/x.jpg"), B), "");
  assert.equal(T.listingObjectPath(at("listings/a.jpg", "other-bucket"), B), "");
  assert.equal(T.listingObjectPath("http://firebasestorage.googleapis.com/v0/b/x/o/y", B), "");
  assert.equal(T.listingObjectPath("not a url", B), "");
});

test("paths: feed, image, function-URL prefix, junk", () => {
  assert.deepEqual(T.parsePath("/feeds/tiktok.csv"), {kind: "csv"});
  assert.deepEqual(T.parsePath("/tiktokCatalog/feeds/tiktok.csv"), {kind: "csv"});
  assert.deepEqual(T.parsePath("/feeds/tiktok/img/abc/0123456789abcdef-1795449876191495.jpg"),
      {kind: "img", listingId: "abc", hash: "0123456789abcdef", generation: "1795449876191495"});
  assert.equal(T.parsePath("/feeds/tiktok/img/abc/0123456789abcdef.jpg").generation, "");
  assert.equal(T.parsePath("/feeds/tiktok/img/abc/0123456789abcdef.jpg").kind, "img");
  for (const p of ["/", "/feeds/meta.csv", "/feeds/tiktok/img/../x.jpg", "/feeds/tiktok/img/a/zz.jpg"]) {
    assert.equal(T.parsePath(p), null, p);
  }
});

test("toFeedJpeg: WebP in, JPEG out, 500-1200px, nothing cropped", async () => {
  const mk = (w, h) => sharp({create: {width: w, height: h, channels: 4, background: "#0a0"}}).webp().toBuffer();
  for (const [w, h, ew, eh] of [[2048, 1536, 1200, 900], [300, 900, 500, 900], [2000, 500, 1200, 500], [200, 200, 500, 500]]) {
    const m = await sharp(await T.toFeedJpeg(await mk(w, h))).metadata();
    assert.deepEqual([m.format, m.width, m.height], ["jpeg", ew, eh]);
  }
});

test("a replaced photo, or the same file overwritten in place, gets a new address and a new stored file", () => {
  const p = T.listingObjectPath(photo(1), B);
  const link = (g) => row({}, {generations: new Map([[p, g]])}).image_link;
  assert.match(link("111"), /\/[0-9a-f]{16}-111\.jpg$/);
  assert.notEqual(link("111"), link("222"));
  assert.notEqual(T.cachePath("a", photo(1), "1"), T.cachePath("a", photo(1), "2"));
  assert.notEqual(T.cachePath("a", photo(1), "1"), T.cachePath("a", photo(2), "1"));
  assert.ok(T.cachePath("a", photo(1), "1").startsWith("feed-cache/tiktok/a/"));
});

test("stored images: only unused ones older than 2 days are removed, never anything outside the cache", () => {
  const now = Date.now();
  const used = T.cachePath("a", photo(1), "1");
  const csv = `"${T.imageUrl("a", photo(1), "1")}"`;
  const old = now - 3 * 864e5;
  assert.deepEqual(T.staleCacheFiles([
    {name: used, createdMs: old},
    {name: "feed-cache/tiktok/gone/x.jpg", createdMs: old},
    {name: "feed-cache/tiktok/new/y.jpg", createdMs: now - 3600e3},
    {name: "listings/u1/abc/1.jpg", createdMs: old},
  ], csv, now), ["feed-cache/tiktok/gone/x.jpg"]);
});
