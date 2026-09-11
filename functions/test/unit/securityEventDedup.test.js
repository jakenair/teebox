// functions/test/unit/securityEventDedup.test.js
// Guards the fix for the `email_verified` flood: a second event for the
// same uid must be a no-op. No emulator/Java. Run: npm test

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldSkipSecurityEvent,
  ONCE_EVER_EVENTS,
} = require("../../lib/securityEventDedup");

const NOW = 1_800_000_000_000; // fixed "now" in ms

// ── The regression: email_verified must send exactly once, ever ──
test("email_verified: first send goes through (no stamp yet)", () => {
  const r = shouldSkipSecurityEvent({
    eventType: "email_verified", stampMillis: null, nowMillis: NOW,
  });
  assert.deepEqual(r, {skip: false, reason: null});
});

test("email_verified: SECOND event for same uid is a no-op (stamp exists)", () => {
  // The exact bug: client re-fires on every app open. Even an hour later,
  // with a stamp present, we must NOT send again.
  const anHourAgo = NOW - 60 * 60 * 1000;
  const r = shouldSkipSecurityEvent({
    eventType: "email_verified", stampMillis: anHourAgo, nowMillis: NOW,
  });
  assert.deepEqual(r, {skip: true, reason: "already-sent"});
});

test("email_verified: even a stamp 100 days old still suppresses", () => {
  const r = shouldSkipSecurityEvent({
    eventType: "email_verified",
    stampMillis: NOW - 100 * 24 * 60 * 60 * 1000,
    nowMillis: NOW,
  });
  assert.equal(r.skip, true);
});

test("account_deletion is also once-ever", () => {
  assert.equal(ONCE_EVER_EVENTS.has("account_deletion"), true);
  const r = shouldSkipSecurityEvent({
    eventType: "account_deletion", stampMillis: NOW - 5000, nowMillis: NOW,
  });
  assert.deepEqual(r, {skip: true, reason: "already-sent"});
});

// ── Repeatable events keep the short window (genuine re-notify allowed) ──
test("password_changed: within 60s window is a duplicate", () => {
  const r = shouldSkipSecurityEvent({
    eventType: "password_changed", stampMillis: NOW - 30 * 1000, nowMillis: NOW,
  });
  assert.deepEqual(r, {skip: true, reason: "duplicate"});
});

test("password_changed: a genuine later change (>60s) DOES re-notify", () => {
  const r = shouldSkipSecurityEvent({
    eventType: "password_changed", stampMillis: NOW - 120 * 1000, nowMillis: NOW,
  });
  assert.deepEqual(r, {skip: false, reason: null});
});

test("payout_method_changed: first send goes through", () => {
  const r = shouldSkipSecurityEvent({
    eventType: "payout_method_changed", stampMillis: null, nowMillis: NOW,
  });
  assert.equal(r.skip, false);
});

// ── two_factor_code is never hard-skipped here (throttled in the callable) ──
test("two_factor_code is never skipped by this guard", () => {
  const r = shouldSkipSecurityEvent({
    eventType: "two_factor_code", stampMillis: NOW - 1, nowMillis: NOW,
  });
  assert.deepEqual(r, {skip: false, reason: null});
});

// ── Defensive: malformed stamp is treated as "no stamp" ──
test("NaN / zero stamp is treated as never-sent", () => {
  assert.equal(shouldSkipSecurityEvent({
    eventType: "email_verified", stampMillis: NaN, nowMillis: NOW,
  }).skip, false);
  assert.equal(shouldSkipSecurityEvent({
    eventType: "email_verified", stampMillis: 0, nowMillis: NOW,
  }).skip, false);
});
