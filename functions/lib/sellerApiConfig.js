"use strict";
// Seller API v1: environment config. Founder decisions 2026-11-20 to 11-23.
//
// One function serves two environments, chosen by the KEY on each request,
// never by the project or the host:
//   sandbox  pk_test_ / sk_conn_test_  data only in sandbox_* collections
//   live     pk_live_ / sk_conn_live_  real listings
// Every key that isn't a live key is sandbox; sandbox is the safe default.
//
// LIVE IS OFF. With LIVE_API_ENABLED false every live key is refused before
// anything is read. Turn it on only on the founder's word.
const LIVE_API_ENABLED = false;

// The sandbox runs inside the live project (founder, 2026-11-23). Until DNS
// exists its address is the function URL; then change this one line.
const SANDBOX_BASE_URL = "https://us-central1-teebox-market.cloudfunctions.net/sellerApi/v1";
const LIVE_BASE_URL = "https://api.teeboxmarket.com/v1";

// LONG-TERM OPTION: a separate sandbox project. Deploy this same function
// there and point SANDBOX_BASE_URL at it. Nothing else changes: test keys
// still use only sandbox_* collections, and live keys are refused there
// because live runs only in LIVE_PROJECT.
const SANDBOX_PROJECT = "teebox-sandbox";
const LIVE_PROJECT = "teebox-market";

function projectId(env) {
  const e = env || process.env;
  if (e.GCLOUD_PROJECT) return e.GCLOUD_PROJECT;
  try { return JSON.parse(e.FIREBASE_CONFIG || "{}").projectId || ""; } catch (_e) { return ""; }
}

/** May live keys be used here? Pure (env injectable). */
function liveEnabled(env) {
  const e = env || process.env;
  const pid = projectId(e);
  // The emulator e2e exercises the live path against throwaway data.
  if (e.FIRESTORE_EMULATOR_HOST && pid.startsWith("demo-") && e.TEEBOX_API_LIVE_IN_EMULATOR === "1") return true;
  return LIVE_API_ENABLED === true && pid === LIVE_PROJECT;
}

/**
 * Config for one mode. Anything but exactly "live" is the sandbox.
 * @param {"live"|"test"} mode @param {object} [env]
 */
function resolve(mode, env) {
  const live = mode === "live";
  const pid = projectId(env);
  return {
    projectId: pid,
    mode: live ? "live" : "test",
    live,
    sandbox: !live,
    liveEnabled: liveEnabled(env),
    bucket: live ? `${pid || "demo-teebox"}.firebasestorage.app` : null, // the sandbox stores no files
    partnerPrefix: live ? "pk_live_" : "pk_test_",
    connectionPrefix: live ? "sk_conn_live_" : "sk_conn_test_",
    baseUrl: live ? LIVE_BASE_URL : SANDBOX_BASE_URL,
    // The sandbox has no storefront, so its listings carry url: null.
    listingUrlBase: live ? "https://teeboxmarket.com/?listing=" : null,
  };
}

// Limits. Documented on /developers; change both together.
const LIMITS = {
  requestsPerMinute: 120, // per seller connection
  partnerRequestsPerMinute: 1200, // per partner key, all its sellers together
  listPageMax: 100,
  listPageDefault: 50,
  partnerRateShards: 10, // the partner counter is split so one document isn't written 20 times a second
  maxBodyBytes: 256 * 1024,
  photoUrlsMax: 10,
  idempotencyHours: 24,
  idempotencyLockMs: 180000, // longer than the function's own timeout
  photoPhaseMs: 45000, // downloading one request's photos, all together
  auditDays: 90,
};

module.exports = {resolve, projectId, liveEnabled, LIMITS, LIVE_API_ENABLED, SANDBOX_PROJECT, LIVE_PROJECT,
  SANDBOX_BASE_URL, LIVE_BASE_URL};
