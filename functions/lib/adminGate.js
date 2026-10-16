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

module.exports = {adminGate, ADMIN_ALLOWLIST};
