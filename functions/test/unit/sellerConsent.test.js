"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../../lib/sellerConsent");

test("consent: needs sellerVerified AND a server 18+ stamp; tools can't skip either", () => {
  assert.deepEqual(C.sellerConsentStatus({}).missing, ["seller_terms", "age18"]);
  assert.deepEqual(C.sellerConsentStatus({sellerVerified: true}).missing, ["age18"]);
  assert.deepEqual(C.sellerConsentStatus({sellerAge18At: 1}).missing, ["seller_terms"]);
  // client-writable termsAgreed alone never counts
  assert.equal(C.sellerConsentStatus({termsAgreed: true, termsAgreedAt: 1}).ok, false);
  assert.equal(C.sellerConsentStatus({sellerVerified: true, sellerAge18At: 1}).ok, true, "pre-version sellers grandfathered");
  assert.equal(C.sellerConsentStatus({sellerVerified: true, sellerAge18At: 1, sellerTermsVersion: C.SELLER_TERMS_VERSION}).ok, true);
  assert.deepEqual(C.sellerConsentStatus({sellerVerified: true, sellerAge18At: 1, sellerTermsVersion: "2026-01-01"}).missing,
      ["seller_terms_version"], "an older recorded version asks again");
});

test("consent: the error tells the seller to confirm in TeeBox, by hand", () => {
  assert.match(C.CONFIRM_MESSAGE, /18 or older/);
  assert.match(C.CONFIRM_MESSAGE, /Seller Terms/);
  assert.match(C.CONFIRM_MESSAGE, /can't confirm for you/);
});

test("rules: 18+ stamp, sellerVerified and terms version are not client-writable", () => {
  const rules = require("fs").readFileSync(require("path").join(__dirname, "../../../firestore.rules"), "utf8");
  for (const f of ["sellerAge18At", "sellerTermsVersion", "sellerVerified'"]) {
    const lists = rules.match(/hasOnly\(\s*\[[^\]]*\]/g) || [];
    assert.ok(!lists.some((l) => l.includes(f)), f + " appears in a client-writable whitelist");
  }
});
