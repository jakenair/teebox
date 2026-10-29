/**
 * functions/lib/adminGate.js — the admin allowlist check for standalone
 * callable modules. Same semantics as adminGate()/isAdminEmail() in index.js
 * (ADMIN_ALLOWLIST secret, comma-separated, verified email required); lives
 * here so new modules stop re-pasting it. Every callable using it must bind
 * ADMIN_ALLOWLIST in its `secrets:` array.
 */
"use strict";
const {HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");

const ADMIN_ALLOWLIST = defineSecret("ADMIN_ALLOWLIST");

let _list = null;
function adminEmails() {
  if (_list) return _list;
  let raw = "";
  try {
    raw = ADMIN_ALLOWLIST.value() || "";
  } catch (_e) {
    raw = "";
  }
  _list = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return _list;
}

/** Throws HttpsError unless the caller is a verified allowlisted admin. */
function adminGate(req) {
  if (!req || !req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const email = (req.auth.token && req.auth.token.email) || "";
  const verified = !!(req.auth.token && req.auth.token.email_verified);
  if (!verified || !adminEmails().includes(String(email).toLowerCase())) {
    throw new HttpsError("permission-denied", "Admin only");
  }
}

// Step-up re-auth for destructive/delivering admin actions — same semantics
// as requireFreshAdminAuth() in index.js (banUser & co.): the ID token's
// auth_time must be within the last 5 minutes, else failed-precondition with
// {reauthRequired: true} so the admin UI can re-authenticate and retry.
const ADMIN_REAUTH_WINDOW_SECS = 300;
function requireFreshAdminAuth(req, nowSecs) {
  const authTime = req && req.auth && req.auth.token && req.auth.token.auth_time;
  const now = typeof nowSecs === "number" ? nowSecs : Math.floor(Date.now() / 1000);
  if (typeof authTime !== "number" || now - authTime > ADMIN_REAUTH_WINDOW_SECS) {
    throw new HttpsError("failed-precondition", "Admin re-auth required",
        {reauthRequired: true, lastAuthAt: authTime || null});
  }
}

module.exports = {adminGate, requireFreshAdminAuth, ADMIN_ALLOWLIST};
