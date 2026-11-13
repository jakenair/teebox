"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../../lib/verifyLink");

const SECRET = "test-secret-123";
const NOW = Date.UTC(2026, 10, 12, 12);
const FB = "https://teebox-market.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=ABC-123_x&apiKey=k&continueUrl=https%3A%2F%2Fteeboxmarket.com%2F%3Flaunch%3Dauth&lang=en";

test("token round-trips to the same uid", () => {
  const t = V.makeResendToken("uid_ABC123", SECRET, NOW);
  assert.equal(V.readResendToken(t, SECRET, NOW + 1000), "uid_ABC123");
});

test("Apple-style uid with dots survives", () => {
  const uid = "apple_com_000935.b3ebd2af8cb04e9f84eb23e2e9f082fc.0501";
  assert.equal(V.readResendToken(V.makeResendToken(uid, SECRET, NOW), SECRET, NOW), uid);
});

test("wrong secret is rejected", () => {
  const t = V.makeResendToken("u1", SECRET, NOW);
  assert.equal(V.readResendToken(t, "other", NOW), null);
});

test("tampered uid is rejected", () => {
  const t = V.makeResendToken("u1", SECRET, NOW);
  const [, ts, sig] = t.split(".");
  const forged = `${Buffer.from("victim").toString("base64url")}.${ts}.${sig}`;
  assert.equal(V.readResendToken(forged, SECRET, NOW), null);
});

test("token expires after 30 days", () => {
  const t = V.makeResendToken("u1", SECRET, NOW);
  assert.equal(V.readResendToken(t, SECRET, NOW + 29 * 864e5), "u1");
  assert.equal(V.readResendToken(t, SECRET, NOW + 31 * 864e5), null);
});

test("garbage tokens are rejected", () => {
  for (const g of [undefined, null, "", "a.b", "a.b.c", "x".repeat(500), 42]) {
    assert.equal(V.readResendToken(g, SECRET, NOW), null);
  }
});

test("branded URL keeps the oobCode and points at our page", () => {
  const out = new URL(V.brandedVerifyUrl(FB, "u1", SECRET, NOW));
  assert.equal(out.origin + out.pathname, "https://teeboxmarket.com/verify-email/");
  assert.equal(out.searchParams.get("oobCode"), "ABC-123_x");
  assert.equal(V.readResendToken(out.searchParams.get("r"), SECRET, NOW), "u1");
  assert.equal(out.searchParams.get("apiKey"), null);
});

test("unparseable Firebase link falls back unchanged", () => {
  assert.equal(V.brandedVerifyUrl("not a url", "u1", SECRET, NOW), "not a url");
  assert.equal(V.brandedVerifyUrl("https://x.com/?mode=verifyEmail", "u1", SECRET, NOW), "https://x.com/?mode=verifyEmail");
});

test("no secret → link still works, just without resend token", () => {
  const out = new URL(V.brandedVerifyUrl(FB, "u1", "", NOW));
  assert.equal(out.searchParams.get("oobCode"), "ABC-123_x");
  assert.equal(out.searchParams.get("r"), null);
});

test("maskEmail", () => {
  assert.equal(V.maskEmail("louis@gmail.com"), "l***@gmail.com");
  assert.equal(V.maskEmail("bad"), "");
});
