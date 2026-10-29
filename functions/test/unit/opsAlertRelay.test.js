const test = require("node:test"); const assert = require("node:assert/strict");
const {_internal: R} = require("../../opsAlertRelay");
test("token check: exact match only, constant-time, empty never passes", () => {
  assert.equal(R.tokenOk("abc", "abc"), true);
  assert.equal(R.tokenOk("abd", "abc"), false); assert.equal(R.tokenOk("", "abc"), false); assert.equal(R.tokenOk("abc", ""), false); assert.equal(R.tokenOk(undefined, "abc"), false);
});
test("alert text + subject from the exact body opsAlert posts", () => {
  const msg = "🚨 TeeBox OPS ALERT [WARN]\ncreatePaymentIntent: checkout on a non-charges-ready seller (list-first)\n  listingId: L1\n";
  assert.equal(R.alertText({text: msg, content: msg, message: msg}), msg);
  const s = R.subjectFor(msg); assert.ok(s.startsWith("TeeBox ops WARN: createPaymentIntent")); assert.ok(s.length <= 50);
  assert.equal(R.alertText(null), ""); assert.equal(R.subjectFor(""), "TeeBox ops ALERT: Ops alert");
});
