/**
 * functions/emailPauseToggle.js
 * ─────────────────────────────────────────────────────────────────────────
 * setMarketingPause — callable. Lets a signed-in user temporarily pause
 * all marketing email categories for N days without revoking marketing
 * consent outright.
 *
 * Server stores `users/{uid}.marketingPausedUntil` (Timestamp). The
 * marketing-send gate in lib/email.js reads this field and skips a send
 * whenever Date.now() < marketingPausedUntil.toMillis() — independent of
 * marketingConsent.granted, so transactional + security mail is not
 * affected.
 *
 * Why this lives in its own file (not gdprConsent.js or emailTriggers.js):
 *   • gdprConsent.js owns the consent audit trail and is co-owned with the
 *     GDPR sweep; appending here would force two reviewers per change.
 *   • emailTriggers.js is a 900-line file that the email-trigger refactor
 *     keeps cleanly partitioned by producer; this callable doesn't fit
 *     any of those slots.
 * Wired via 1-line append in functions/index.js.
 *
 * Input:  { days?: number }   // default 30; clamped to 1..365
 * Output: { ok: true, pausedUntil: number }   // unix-ms
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

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

exports.setMarketingPause = onCall(
    {...FN},
    async (req) => {
      if (!req.auth) {
        throw new HttpsError("unauthenticated", "Sign-in required.");
      }
      const uid = req.auth.uid;
      const raw = req.data && req.data.days;
      let days = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_DAYS;
      // Special case: days === 0 means "resume now" (clear the pause).
      let pauseUntil = null;
      if (days === 0) {
        pauseUntil = null;
      } else {
        days = Math.max(MIN_DAYS, Math.min(MAX_DAYS, days));
        pauseUntil = admin.firestore.Timestamp.fromMillis(
            Date.now() + days * MS_PER_DAY,
        );
      }

      try {
        await admin.firestore().collection("users").doc(uid).set({
          marketingPausedUntil: pauseUntil,
          marketingPausedUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      } catch (e) {
        logger.error("setMarketingPause write failed", {
          uid,
          err: e.message || String(e),
        });
        throw new HttpsError("internal", "Could not save pause.");
      }

      logger.info("marketingPausedUntil updated", {
        uid,
        days,
        pausedUntil: pauseUntil ? pauseUntil.toMillis() : null,
      });
      return {
        ok: true,
        pausedUntil: pauseUntil ? pauseUntil.toMillis() : null,
      };
    },
);
