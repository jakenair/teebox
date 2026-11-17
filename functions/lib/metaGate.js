// functions/lib/metaGate.js
//
// Decides whether a server-side Meta event goes to PRODUCTION, to Test Events
// only, or nowhere. Pure functions so the rules are unit-tested offline.
//
// Why "nowhere" and not "tag it with test_event_code": Meta's Conversions API
// docs say "Events sent with test_event_code are not dropped. They flow into
// Events Manager and are used for targeting and ads measurement purposes."
// So a test code alone does NOT keep our own traffic out of optimization.
// Internal traffic is therefore DROPPED, unless someone is deliberately
// watching Test Events (a test code is present), in which case it is sent
// tagged so the Test Events tab shows it.
//
// Internal = any of:
//   - a test/QA email domain (INTERNAL_DOMAINS, or any *.invalid address)
//   - config/meta.internalUids contains the uid
//   - config/meta.internalEmails contains the email (Gmail dots and +tags
//     ignored, so jake+qa1@gmail.com matches jake@gmail.com)
//   - a custom claim metaInternal: true
// Non-production runtime (emulator, or any project other than teebox-market)
// is treated the same way.

const PROD_PROJECT = "teebox-market";
const INTERNAL_DOMAINS = new Set([
  "teeboxmarket.com", // staff, App Review, device-test and CAPI-gate accounts
  "teeboxqa.dev",
  "teeboxtest.invalid",
  "teeboxmarket.invalid",
]);

/**
 * Canonical form of an email for internal-list matching.
 * @param {string} raw
 * @return {string}
 */
function canonicalEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return "";
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local + "@" + domain;
}

/**
 * @param {{uid?: string, email?: string, claims?: object}} who
 * @param {{internalUids?: string[], internalEmails?: string[]}} cfg
 * @return {boolean}
 */
function isInternalAccount(who, cfg) {
  const w = who || {};
  const c = cfg || {};
  if (w.claims && w.claims.metaInternal === true) return true;
  if (w.uid && Array.isArray(c.internalUids) && c.internalUids.includes(String(w.uid))) return true;
  const email = canonicalEmail(w.email);
  if (email) {
    const domain = email.slice(email.indexOf("@") + 1);
    if (INTERNAL_DOMAINS.has(domain) || domain.endsWith(".invalid")) return true;
    if (Array.isArray(c.internalEmails) &&
        c.internalEmails.some((x) => canonicalEmail(x) === email)) return true;
  }
  return false;
}

/**
 * True when this code is NOT running as production (emulator, other project).
 * @param {object} [env] process.env (tests pass their own)
 * @return {boolean}
 */
function isNonProdRuntime(env) {
  const e = env || process.env;
  if (e.FUNCTIONS_EMULATOR === "true") return true;
  const project = e.GCLOUD_PROJECT || e.GOOGLE_CLOUD_PROJECT || "";
  return project !== PROD_PROJECT;
}

/**
 * The single decision every server-side Meta event goes through.
 * @param {{internal: boolean, nonProd: boolean, testEventCode?: string}} p
 * @return {{send: boolean, testEventCode: string, reason: string}}
 *   send=false → do not POST anything.
 *   testEventCode non-empty → POST with test_event_code (Test Events tab).
 */
function gateDecision(p) {
  const code = String((p && p.testEventCode) || "").trim();
  if (code) return {send: true, testEventCode: code, reason: "test-event-code"};
  if (p && p.nonProd) return {send: false, testEventCode: "", reason: "non-prod-runtime"};
  if (p && p.internal) return {send: false, testEventCode: "", reason: "internal-account"};
  return {send: true, testEventCode: "", reason: "production"};
}

/** A test code as typed into Events Manager → Test Events (e.g. TEST12345). */
function cleanTestCode(raw) {
  const v = String(raw || "").trim();
  return /^[A-Za-z0-9_-]{4,40}$/.test(v) ? v : "";
}

module.exports = {canonicalEmail, isInternalAccount, isNonProdRuntime, gateDecision, cleanTestCode, INTERNAL_DOMAINS, PROD_PROJECT};
