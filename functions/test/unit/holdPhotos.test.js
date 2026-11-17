"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {photoUrlsFromFiles} = require("../../lib/holdPhotos");

const F = "listings/S1/L1/";
test("rebuilds originals in upload order, skips variants/other folders/tokenless", () => {
  const files = [
    {name: F + "1794607046314_1_IMG_3822.jpg", token: "t1"},
    {name: F + "1794607046314_1_IMG_3822.jpg_w400.webp", token: "x"},
    {name: F + "1794607046501_0_IMG_3821.jpg", token: "t0,t0b"},
    {name: F + "1794607046501_0_IMG_3821.jpg_w1200.webp", token: "x"},
    {name: F + "sub/1_2_nested.jpg", token: "x"},
    {name: "listings/S1/OTHER/1_0_a.jpg", token: "x"},
    {name: F + "1794607046999_2_notoken.jpg", token: null},
  ];
  const urls = photoUrlsFromFiles(files, "b.app", F);
  assert.strictEqual(urls.length, 2);
  assert.ok(urls[0].includes(encodeURIComponent(F + "1794607046501_0_IMG_3821.jpg")) && urls[0].endsWith("token=t0"));
  assert.ok(urls[1].includes("IMG_3822.jpg?alt=media&token=t1"));
  assert.ok(urls[0].startsWith("https://firebasestorage.googleapis.com/v0/b/b.app/o/listings%2FS1%2FL1%2F"));
});
test("empty folder → []", () => {
  assert.deepStrictEqual(photoUrlsFromFiles([], "b", F), []);
});
