"use strict";
/**
 * Guest checkout (web only, r421, founder approval 2026-11-19).
 *
 * A guest pays without an account. The order is owned by a synthetic buyer id
 * derived from the email (guest_<hash>) until the buyer taps the one-time claim
 * link from the confirmation email, which proves they control that inbox; only
 * then is the order moved to a real account (created if none exists).
 *
 * Pure helpers + Firestore-backed rate limits and claim tokens. No Stripe here.
 */
const crypto = require("crypto");

// ── Abuse limits (no App Check: token minting still fails, enforcement off) ──
// Guest PaymentIntent creation = a listing hold, so it is the expensive call.
const GUEST_LIMITS = {
  // per client IP
  ipCreate10m: {max: 5, windowMs: 10 * 60 * 1000},
  ipCreateDay: {max: 20, windowMs: 24 * 60 * 60 * 1000},
  // per buyer email (normalized)
  emailCreateHour: {max: 5, windowMs: 60 * 60 * 1000},
  // price quotes (no hold, no PaymentIntent): cheap, but each live-rate quote
  // costs a Shippo call
  ipQuote10m: {max: 40, windowMs: 10 * 60 * 1000},
  // claim attempts per IP (token guessing is infeasible; this caps noise)
  ipClaim10m: {max: 20, windowMs: 10 * 60 * 1000},
};
const CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // link works for 30 days

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Trimmed, lower-cased email, or null when it isn't a plausible address. */
function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 6 || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

/**
 * Identity key for self-purchase matching: lower-case, "+tag" dropped, and
 * dots ignored for Gmail. Used ONLY to block a seller buying their own item;
 * never to merge accounts.
 */
function emailIdentityKey(raw) {
  const e = normalizeEmail(raw);
  if (!e) return null;
  let [local, domain] = e.split("@");
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

function sameIdentity(a, b) {
  const ka = emailIdentityKey(a);
  const kb = emailIdentityKey(b);
  return !!ka && ka === kb;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

/** Stable synthetic buyer id for a guest email. */
function guestBuyerId(email) {
  const e = normalizeEmail(email);
  if (!e) throw new Error("guestBuyerId: invalid email");
  return "guest_" + sha256Hex("teebox-guest:" + e).slice(0, 28);
}

function isGuestBuyerId(id) {
  return typeof id === "string" && /^guest_[0-9a-f]{28}$/.test(id);
}

/**
 * Sliding-window limiter keyed by an opaque string (hashed before storage, so
 * no raw IP or email is written). Fails OPEN on a Firestore error, matching
 * checkRateLimit in index.js: a blip must not block real buyers.
 * @return {Promise<{ok:boolean, retryAfterSec?:number}>}
 */
async function guestRateLimit(db, FieldValue, key, rule, now = Date.now()) {
  if (!key || !rule) return {ok: true};
  const ref = db.collection("guestRateLimits").doc(sha256Hex(key).slice(0, 40));
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cutoff = now - rule.windowMs;
      const recent = (snap.exists ? (snap.data().hits || []) : [])
          .map(Number).filter((n) => Number.isFinite(n) && n > cutoff)
          .slice(-rule.max * 2);
      if (recent.length >= rule.max) {
        return {ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + rule.windowMs - now) / 1000))};
      }
      recent.push(now);
      tx.set(ref, {hits: recent, updatedAt: FieldValue.serverTimestamp(),
        // TTL hint for a Firestore TTL policy (optional; harmless without one)
        expireAt: new Date(now + rule.windowMs)}, {merge: true});
      return {ok: true};
    });
  } catch (_e) {
    return {ok: true};
  }
}

/** New one-time claim token: raw goes in the email only; the doc id is its hash. */
function newClaimToken() {
  const raw = crypto.randomBytes(32).toString("base64url");
  return {raw, id: sha256Hex("claim:" + raw)};
}
function claimDocId(raw) {
  if (typeof raw !== "string" || raw.length < 30 || raw.length > 100 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return sha256Hex("claim:" + raw);
}

/**
 * Decide what a claim token may do. Pure.
 * @return {{ok:true}|{ok:false, code:string}}
 */
function claimDecision(doc, now = Date.now()) {
  if (!doc) return {ok: false, code: "not-found"};
  if (doc.usedAt) return {ok: false, code: "used"};
  const exp = doc.expiresAtMs || 0;
  if (!exp || now > exp) return {ok: false, code: "expired"};
  if (!normalizeEmail(doc.email) || !isGuestBuyerId(doc.guestBuyerId)) return {ok: false, code: "invalid"};
  return {ok: true};
}

module.exports = {
  GUEST_LIMITS, CLAIM_TTL_MS, normalizeEmail, emailIdentityKey, sameIdentity,
  guestBuyerId, isGuestBuyerId, guestRateLimit, newClaimToken, claimDocId,
  claimDecision, sha256Hex,
};
