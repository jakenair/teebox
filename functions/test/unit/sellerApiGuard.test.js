// functions/test/unit/sellerApiGuard.test.js — bad keys are slowed, working tools never are.
const test = require("node:test");
const assert = require("node:assert/strict");
const {KeyGuard} = require("../../lib/sellerApiGuard");
const T = 1e12;

test("one bad pair is held after its limit, and freed the next minute", () => {
  const g = new KeyGuard({perKey: 3, perInstance: 100});
  for (let i = 0; i < 3; i++) { assert.equal(g.wait("bad", T), 0); g.refused("bad", T); }
  assert.ok(g.wait("bad", T) > 0);
  assert.equal(g.wait("other", T), 0);
  assert.equal(g.wait("bad", T + 60000), 0);
});
test("random keys are held by the instance limit; a pair that worked is never held", () => {
  const g = new KeyGuard({perKey: 3, perInstance: 5});
  g.ok("good", T);
  for (let i = 0; i < 5; i++) g.refused("r" + i, T);
  assert.ok(g.wait("r99", T) > 0);
  assert.equal(g.wait("good", T), 0);
});
test("a pair that stops working loses its pass, and passes expire", () => {
  const g = new KeyGuard({perKey: 1, perInstance: 100});
  g.ok("p", T); g.refused("p", T);
  assert.ok(g.wait("p", T) > 0);
  g.ok("q", T); g.refused("z", T + 11 * 60000);
  const g2 = new KeyGuard({perKey: 1, perInstance: 1});
  g2.ok("q", T); g2.refused("z", T + 11 * 60000);
  assert.ok(g2.wait("q", T + 11 * 60000) > 0);
});
test("memory is bounded", () => {
  const g = new KeyGuard();
  for (let i = 0; i < 6000; i++) g.ok("k" + i, T);
  assert.ok(g.known.size <= 5000);
});
