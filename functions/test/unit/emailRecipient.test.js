// functions/test/unit/emailRecipient.test.js
// Guards the order-email recipient resolution bug: users/{uid} has NO email
// field on real accounts, so resolution MUST come from Firebase Auth. Pure,
// dependency-injected — no emulator. Run: npm test
"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {resolveUserEmail} = require("../../lib/emailRecipient");

// authGetter stubs
const authWith = (email) => async () => ({email});
const authMiss = async () => {
  const e = new Error("no user record");
  e.code = "auth/user-not-found";
  throw e;
};
const authNoEmail = async () => ({email: undefined});

test("REAL-USER SHAPE: no doc email + Auth has email → resolves from auth (buyer & seller)", async () => {
  const buyer = await resolveUserEmail("buyerUid", undefined, authWith("buyer@gmail.com"));
  assert.equal(buyer.email, "buyer@gmail.com");
  assert.equal(buyer.source, "auth");
  const seller = await resolveUserEmail("sellerUid", undefined, authWith("seller@gmail.com"));
  assert.equal(seller.email, "seller@gmail.com");
  assert.equal(seller.source, "auth");
});

test("auth wins even when a doc email is also present", async () => {
  const r = await resolveUserEmail("uid", "stale@doc.com", authWith("live@auth.com"));
  assert.equal(r.email, "live@auth.com");
  assert.equal(r.source, "auth");
});

test("auth-miss + doc email present → doc fallback (legacy/smoke)", async () => {
  const r = await resolveUserEmail("uid", "fallback@doc.com", authMiss);
  assert.equal(r.email, "fallback@doc.com");
  assert.equal(r.source, "doc-fallback");
});

test("BOTH sources missing → null + 'unresolved' (caller must log, NOT silent-skip)", async () => {
  const r = await resolveUserEmail("uid", undefined, authMiss);
  assert.equal(r.email, null);
  assert.equal(r.source, "unresolved");
});

test("auth returns a user with no email + no doc email → unresolved", async () => {
  const r = await resolveUserEmail("uid", undefined, authNoEmail);
  assert.equal(r.email, null);
  assert.equal(r.source, "unresolved");
});

test("no uid → null / no-uid (never calls authGetter)", async () => {
  let called = false;
  const r = await resolveUserEmail(null, "x@y.com", async () => {
    called = true; return {email: "x@y.com"};
  });
  assert.equal(r.email, null);
  assert.equal(r.source, "no-uid");
  assert.equal(called, false);
});

test("transient auth error + doc fallback still recovers", async () => {
  const r = await resolveUserEmail("uid", "d@doc.com", async () => {
    throw new Error("DEADLINE_EXCEEDED");
  });
  assert.equal(r.email, "d@doc.com");
  assert.equal(r.source, "doc-fallback");
});
