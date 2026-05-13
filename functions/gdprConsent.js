/**
 * functions/gdprConsent.js
 * ─────────────────────────────────────────────────────────────────────────
 * GDPR-compliant marketing-consent capture & revocation.
 *
 * Schema (server-managed; see GDPR_CONSENT_SCHEMA.md):
 *
 *   users/{uid}.marketingConsent: {
 *     granted: boolean,
 *     grantedAt: Timestamp | null,
 *     revokedAt: Timestamp | null,
 *     source:   'signup' | 'banner_reopt' | 'prefs_toggle' | 'migration_default_off',
 *     version:  1,                 // bump on consent-language change → triggers re-consent
 *     history:  [{ granted, at, source, ip?, userAgent? }, ...]   // bounded to 50
 *   }
 *
 *   users/{uid}.marketingBannerDismissedAt: Timestamp
 *
 * Why a callable (not direct client write)? Audit-trail integrity. The
 * Firestore allow-list rule denies client writes to these fields; the
 * client MUST round-trip through this callable so the server can stamp
 * serverTimestamp() (un-spoofable) and append history.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const FN = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  concurrency: 40,
  maxInstances: 20,
};

const CURRENT_CONSENT_VERSION = 1;

// Mirror MARKETING_CATEGORIES from lib/email.js — keeping them in sync is
// a deliberate code-review gate (changes here MUST be reviewed alongside
// the send gate). Don't refactor to a shared import without checking that
// gdprConsent.js can't be required without pulling in the Resend SDK.
const MARKETING_PREF_KEYS = [
  "savedSearchMatches",
  "priceDrops",
  "abandonedDraft",
  "abandonedCart",
  "reviewRequests",
  "winBack",
  "weeklyDigest",
  "productUpdates",
];

const ALLOWED_SOURCES = new Set([
  "signup",
  "banner_reopt",
  "prefs_toggle",
  "migration_default_off",
]);

const MAX_HISTORY = 50;

/**
 * Build the marketingConsent payload + the cascading emailPrefs writes.
 * Returns a Firestore update object ready to pass to .update().
 */
function buildConsentUpdate({granted, source, ip, userAgent}) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = {
    "marketingConsent.granted": granted,
    "marketingConsent.grantedAt": granted ? now : null,
    "marketingConsent.revokedAt": granted ? null : now,
    "marketingConsent.source": source,
    "marketingConsent.version": CURRENT_CONSENT_VERSION,
    // History append uses arrayUnion so concurrent writes don't clobber
    // each other. Note we use Timestamp.now() inside the history entry
    // instead of serverTimestamp() — arrayUnion doesn't support sentinels
    // inside objects, so we accept the (tiny) clock skew between the
    // server's now() and the operation's serverTimestamp().
    "marketingConsent.history": admin.firestore.FieldValue.arrayUnion({
      granted,
      at: admin.firestore.Timestamp.now(),
      source,
      ip: ip || null,
      userAgent: userAgent || null,
    }),
  };
  // Cascade: opt-in → flip all marketing emailPrefs to true; opt-out →
  // flip all to false. User can later toggle individual prefs back via
  // updateEmailPreferences (which gates marketing-cat sends on consent
  // AND per-cat pref together, so individual unsubscribes still work).
  for (const key of MARKETING_PREF_KEYS) {
    update[`emailPrefs.${key}`] = granted;
  }
  update["emailPrefsUpdatedAt"] = now;
  return update;
}

/**
 * Trim history if it gets too long. Called best-effort after the main
 * write so the consent change itself never depends on a history-trim
 * round-trip succeeding. 50 entries × ~6 fields each ~= 3-4 KB; well
 * under the 1 MiB doc limit but worth keeping bounded.
 */
async function trimHistoryIfNeeded(uid) {
  try {
    const db = admin.firestore();
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) return;
    const history = (snap.data().marketingConsent || {}).history || [];
    if (history.length <= MAX_HISTORY) return;
    const trimmed = history.slice(-MAX_HISTORY);
    await db.collection("users").doc(uid).update({
      "marketingConsent.history": trimmed,
    });
  } catch (e) {
    logger.warn("trimHistoryIfNeeded failed", e.message || e);
  }
}

/**
 * updateMarketingConsent — callable.
 *
 * Input:  { granted: boolean, source: 'banner_reopt'|'prefs_toggle'|'signup' }
 * Output: { ok: true, granted, version }
 *
 * Throws HttpsError("unauthenticated") if no auth, "invalid-argument" if
 * payload is malformed.
 */
exports.updateMarketingConsent = onCall(
    {...FN},
    async (req) => {
      if (!req.auth) {
        throw new HttpsError("unauthenticated", "Sign-in required.");
      }
      const uid = req.auth.uid;
      const granted = req.data && req.data.granted === true;
      const sourceRaw = (req.data && req.data.source) || null;
      const source = ALLOWED_SOURCES.has(sourceRaw) ? sourceRaw : "prefs_toggle";

      // Capture IP + UA for the audit trail. rawRequest is the underlying
      // Express request on v2 callables. Missing in tests; default to null.
      const rr = req.rawRequest || {};
      const ip =
        (rr.headers && (rr.headers["x-forwarded-for"] || rr.headers["fastly-client-ip"])) ||
        rr.ip ||
        null;
      const userAgent = (rr.headers && rr.headers["user-agent"]) || null;
      // x-forwarded-for can be a comma-separated chain — keep only the
      // first hop (the originating client) and strip whitespace.
      const ipFirst = typeof ip === "string" ? ip.split(",")[0].trim() : null;

      const update = buildConsentUpdate({
        granted,
        source,
        ip: ipFirst,
        userAgent,
      });

      try {
        await admin.firestore().collection("users").doc(uid).set(update, {merge: true});
      } catch (e) {
        logger.error("updateMarketingConsent write failed", {
          uid,
          err: e.message || String(e),
        });
        throw new HttpsError("internal", "Could not save consent.");
      }
      // Best-effort: trim history if it's grown unbounded.
      trimHistoryIfNeeded(uid).catch(() => {});

      logger.info("marketingConsent updated", {uid, granted, source});
      return {ok: true, granted, version: CURRENT_CONSENT_VERSION};
    },
);

/**
 * dismissMarketingBanner — callable. Records that the user has acknowledged
 * the re-opt-in banner without making a choice. We still show consent as
 * "missing" (no marketingConsent doc) so sends remain gated; the banner
 * just stops nagging.
 */
exports.dismissMarketingBanner = onCall(
    {...FN},
    async (req) => {
      if (!req.auth) {
        throw new HttpsError("unauthenticated", "Sign-in required.");
      }
      const uid = req.auth.uid;
      try {
        await admin.firestore().collection("users").doc(uid).set({
          marketingBannerDismissedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      } catch (e) {
        logger.warn("dismissMarketingBanner write failed", {
          uid,
          err: e.message || String(e),
        });
        throw new HttpsError("internal", "Could not save dismissal.");
      }
      return {ok: true};
    },
);

module.exports.__gdprConsentLoaded = true;
module.exports.CURRENT_CONSENT_VERSION = CURRENT_CONSENT_VERSION;
module.exports.MARKETING_PREF_KEYS = MARKETING_PREF_KEYS;
