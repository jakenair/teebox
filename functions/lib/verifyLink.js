"use strict";
// r412 — branded email-verification links.
//
// Firebase's generateEmailVerificationLink() returns a link to its own hosted
// handler (teebox-market.firebaseapp.com/__/auth/action). When that link has
// expired or was already used, Firebase shows a dead-end page with no way to
// get a new one. We keep Firebase's one-time code (oobCode) but send people
// to our own page, teeboxmarket.com/verify-email/, which applies the code and,
// on an expired link, offers "Send a new link".
//
// The resend button works without signing in, so the link also carries a
// short signed token (`r`) naming the account. The token can only do one
// thing: ask us to email a fresh verification link to that account's OWN
// address on file. It never reveals the address and can't target anyone else.
// It is HMAC-signed with a purpose-specific key derived from the existing
// unsubscribe secret, and expires after RESEND_TOKEN_TTL_DAYS.

const crypto = require("crypto");

const VERIFY_PAGE = "https://teeboxmarket.com/verify-email/";
const RESEND_TOKEN_TTL_DAYS = 30;
const PURPOSE = "tb-verify-resend-v1";

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload, secret) {
  const key = crypto.createHmac("sha256", String(secret)).update(PURPOSE).digest();
  return b64url(crypto.createHmac("sha256", key).update(payload).digest()).slice(0, 32);
}

/** Token = base64url(uid) "." issuedSec "." sig */
function makeResendToken(uid, secret, nowMs = Date.now()) {
  if (!uid || !secret) return null;
  const payload = `${b64url(uid)}.${Math.floor(nowMs / 1000)}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** @return {string|null} uid when the token is genuine and unexpired */
function readResendToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== "string" || !secret || token.length > 400) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uidPart, issuedStr, sig] = parts;
  const expected = sign(`${uidPart}.${issuedStr}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const issued = Number(issuedStr);
  if (!Number.isFinite(issued)) return null;
  const ageMs = nowMs - issued * 1000;
  if (ageMs < -5 * 60 * 1000 || ageMs > RESEND_TOKEN_TTL_DAYS * 864e5) return null;
  let uid;
  try {
    uid = Buffer.from(uidPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch (_) {
    return null;
  }
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(uid) ? uid : null;
}

/**
 * Turn Firebase's hosted-handler link into our page's link. Falls back to the
 * original Firebase link if it can't be parsed, so an email always goes out
 * with a working link.
 */
function brandedVerifyUrl(firebaseLink, uid, secret, nowMs = Date.now()) {
  let oob;
  try {
    oob = new URL(firebaseLink).searchParams.get("oobCode");
  } catch (_) {
    return firebaseLink;
  }
  if (!oob) return firebaseLink;
  const u = new URL(VERIFY_PAGE);
  u.searchParams.set("oobCode", oob);
  const r = makeResendToken(uid, secret, nowMs);
  if (r) u.searchParams.set("r", r);
  return u.toString();
}

/**
 * Daily cap on verification emails per account (rolling 24h), on top of the
 * 60s cooldown. Pure: give it the stored send times, get back the decision
 * and the list to store.
 * @return {{ok:boolean, retryAfterSec?:number, sends:number[]}}
 */
const VERIFY_DAILY_CAP = 5;
function dailyCapDecision(prevSends, nowMs = Date.now(), cap = VERIFY_DAILY_CAP) {
  const DAY = 864e5;
  const recent = (Array.isArray(prevSends) ? prevSends : [])
      .map(Number).filter((t) => Number.isFinite(t) && t > nowMs - DAY && t <= nowMs + 60e3)
      .sort((a, b) => a - b).slice(-cap);
  if (recent.length >= cap) {
    return {ok: false, retryAfterSec: Math.max(60, Math.ceil((recent[0] + DAY - nowMs) / 1000)), sends: recent};
  }
  return {ok: true, sends: [...recent, nowMs]};
}

/** j***@gmail.com — enough to recognise, not enough to harvest. */
function maskEmail(email) {
  const m = /^([^@]+)@(.+)$/.exec(String(email || ""));
  if (!m) return "";
  return `${m[1].slice(0, 1)}***@${m[2]}`;
}

module.exports = {
  VERIFY_PAGE, RESEND_TOKEN_TTL_DAYS,
  VERIFY_DAILY_CAP, dailyCapDecision,
  makeResendToken, readResendToken, brandedVerifyUrl, maskEmail,
};
