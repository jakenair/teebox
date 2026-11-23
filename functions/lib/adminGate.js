/**
 * functions/lib/adminGate.js — the ONE admin check for every callable.
 *
 * Admin = the custom claim admin:true on the caller's ID token (2026-11-23,
 * replaces the old email allowlist). Only the Admin SDK can set it:
 * functions/scripts/set-admin-claim.cjs. firestore.rules and storage.rules
 * check the same claim. An email address never grants anything.
 */
"use strict";
const {HttpsError} = require("firebase-functions/v2/https");

/** @param {object} auth request.auth @return {boolean} */
function isAdminAuth(auth) {
  return !!(auth && auth.token && auth.token.admin === true);
}

/** Throws HttpsError unless the caller carries the admin claim. */
function adminGate(req) {
  if (!req || !req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  if (!isAdminAuth(req.auth)) throw new HttpsError("permission-denied", "Admin only");
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

module.exports = {adminGate, isAdminAuth, requireFreshAdminAuth};
