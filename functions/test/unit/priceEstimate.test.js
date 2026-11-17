"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {pickDraft, titleOverlap} = require("../../priceEstimate")._priceEstimateTesting;
const NOW = Date.parse("2026-11-17T18:00:00Z");
const ts = (ms) => ({toMillis: () => ms});
const log = (id, o) => ({id, data: {uid: "s1", category: "putter", at: ts(NOW - 10 * 60000),
  draft: {title: "Scotty Cameron Special Select Newport 2 Putter 34in", price: {low: 250, mid: 300, high: 340}}, ...o}});
const listing = {sellerId: "s1", specCategory: "putter", title: "Scotty Cameron Newport 2 Special Select putter, 34\""};

test("matches the seller's recent same-category draft with a similar title", () => {
  const r = pickDraft(listing, [log("a")], NOW);
  assert.deepStrictEqual(r, {id: "a", price: {low: 250, mid: 300, high: 340}});
});
test("picks the newest eligible draft", () => {
  const r = pickDraft(listing, [log("old", {at: ts(NOW - 3 * 3600000)}), log("new", {at: ts(NOW - 60000)})], NOW);
  assert.strictEqual(r.id, "new");
});
test("rejects: used, too old, other category, different item, no price", () => {
  assert.strictEqual(pickDraft(listing, [log("u", {consumedBy: "x"})], NOW), null);
  assert.strictEqual(pickDraft(listing, [log("o", {at: ts(NOW - 7 * 3600000)})], NOW), null);
  assert.strictEqual(pickDraft(listing, [log("c", {category: "driver"})], NOW), null);
  assert.strictEqual(pickDraft(listing, [log("t", {draft: {title: "FootJoy Pro SL shoes size 10", price: {mid: 80}}})], NOW), null);
  assert.strictEqual(pickDraft(listing, [log("p", {draft: {title: listing.title, price: {mid: 0}}})], NOW), null);
});
test("title overlap", () => {
  assert.ok(titleOverlap("Titleist T100 irons 4-PW", "Titleist T100 4-PW iron set (irons)") >= 0.5);
  assert.strictEqual(titleOverlap("", "x"), 0);
});
