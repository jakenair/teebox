// functions/test/unit/sellerInvite.test.js
// Cohort classifier + template render for the seller-invite campaign.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// firebase-functions/params defineSecret is safe to construct outside the
// runtime; .value() is only read inside the callable, which we never invoke.
const {_classifyUser: classify, _SENT_FLAG} = require("../../sellerInviteCampaign");

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const DAY = 86400000;
const ctx = () => ({
  sellerUids: new Set(["seller1"]),
  suppressedUids: new Set(["sup1"]),
  cutoffMs: NOW - 30 * DAY,
  nowMs: NOW,
});
const au = (over = {}) => ({
  uid: "u1",
  email: "golfer@example.com",
  emailVerified: true,
  metadata: {lastSignInTime: new Date(NOW - 2 * DAY).toISOString()},
  ...over,
});
const consented = {marketingConsent: {granted: true}};

test("eligible: verified, active, non-seller, consented", () => {
  assert.equal(classify(au(), consented, ctx()), "eligible");
});
test("auth-level exclusions come first and need no doc", () => {
  assert.equal(classify(au({email: null}), null, ctx()), "no-email");
  assert.equal(classify(au({email: "x@teeboxtest.invalid"}), null, ctx()), "test-email");
  assert.equal(classify(au({emailVerified: false}), null, ctx()), "unverified");
  assert.equal(classify(au({metadata: {lastSignInTime: new Date(NOW - 45 * DAY).toISOString()}}), null, ctx()), "inactive");
  assert.equal(classify(au({uid: "seller1"}), null, ctx()), "seller");
});
test("doc-level exclusions, in order", () => {
  assert.equal(classify(au(), {[_SENT_FLAG]: 1, ...consented}, ctx()), "already-sent");
  assert.equal(classify(au({uid: "sup1"}), consented, ctx()), "suppressed");
  assert.equal(classify(au(), {emailSuppressed: true, ...consented}, ctx()), "suppressed");
  assert.equal(classify(au(), {emailPrefs: {productUpdates: false}, ...consented}, ctx()), "opted-out");
  assert.equal(classify(au(), {marketingPausedUntil: NOW + DAY, ...consented}, ctx()), "paused");
  assert.equal(classify(au(), {marketingPausedUntil: NOW - DAY, ...consented}, ctx()), "eligible");
});
test("consent gate is the LAST reason, so its count = opt-out-policy delta", () => {
  assert.equal(classify(au(), null, ctx()), "no-consent");
  assert.equal(classify(au(), {}, ctx()), "no-consent");
  assert.equal(classify(au(), {marketingConsent: {granted: false}}, ctx()), "no-consent");
});

const built = path.join(__dirname, "..", "..", "emails-build", "lifecycle", "SellerInvite.js");
test("SellerInvite template renders with CTA + unsubscribe footer",
    {skip: !fs.existsSync(built) && "run `npm run build:emails` first"},
    async () => {
      const Tpl = require(built);
      const {render} = require("@react-email/render");
      const html = await render(Tpl({user: {uid: "u1"}}));
      assert.match(html, /Start selling/);
      assert.match(html, /\?sell=1/);
      assert.match(html, /unsubscribe/i);
      assert.match(html, /Featured Sellers/);
      assert.equal(typeof Tpl.subject(), "string");
    });
