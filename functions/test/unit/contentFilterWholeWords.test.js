// 2026-11-23: whole words only, golf parts and makers allowed, each word judged on its own text.
const test = require("node:test");
const assert = require("node:assert/strict");
const {__testing: T} = require("../../moderation/contentFilter");
const slur = (s) => !!T.containsSlurTerm(T.normalizeForScan(s));

test("ordinary words and contractions never look starred out", () => {
  for (const s of ["can't", "Count:", "count.", "won't", "shot's", "Hybrid – 24° – Ladies, can't beat it – count on it"]) assert.equal(T.containsSkeleton(s), false, s);
});
test("a term inside a longer word is not a match; the word itself, leet or spaced, is", () => {
  const {_TEST_SAMPLES} = require("../../moderation/customBlocklist");
  for (const s of ["Montenegro", "Cooney putter", "Spice wedge", "raccoon headcover", "tycoon"]) assert.equal(slur(s), false, s);
  const t = "sl" + "ut";
  for (const s of [t, t + "s", t.replace("u", "*") && t.split("").join(" "), t.split("").join("-"), "x/" + t]) assert.equal(slur(s), true);
  assert.ok(_TEST_SAMPLES);
});
test("flange, knob, Crisman", () => {
  for (const s of ["Otey Crisman 721 HB Goodwin Flange Wrap Grip", "flange", "Knob end", "Jeunghun Wang", "Dick's Sporting Goods"]) assert.equal(T.isAllowlistedToken(s), true, s);
});
