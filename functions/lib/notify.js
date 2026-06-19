// functions/lib/notify.js
//
// SINGLE notification fan-out seam. One entry — notify(event) — fans a single
// event out to in-app + push + email, each channel optional and each honoring
// the user's prefs. It DELEGATES to the existing, battle-tested helpers so
// prefs/consent/quiet-hours behavior is preserved exactly:
//   • push  → lib/push.sendPush   (enforces users/{uid}.pushPrefs[cat], quiet
//             hours, multicast, dead-token pruning; never throws)
//   • email → lib/email.sendEmail (enforces marketingConsent, suppression list,
//             per-category emailPrefs, unsubscribe headers, idempotency)
//   • in-app→ users/{uid}/notifications doc (same shape as index.js
//             writeNotification, so the bell feed renders uniformly)
//
// Why: today the SAME event is fanned out by separate triggers in pushTriggers
// (push), index.js (email + in-app), etc. Adding a channel means touching 2-3
// files. With this seam a producer makes ONE notify() call; new events
// (e.g. likes) use it directly. notify() NEVER throws — each channel is
// isolated so one failure can't drop the others.

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");
const {sendPush} = require("./push");

const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h default

// In-app notification doc — SAME shape as index.js writeNotification so the
// (forthcoming) bell feed renders every producer's notifications uniformly.
async function writeInApp(uid, doc) {
  const db = admin.firestore();
  await db.collection("users").doc(uid).collection("notifications").add({
    ...doc,
    userId: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    read: false,
  });
}

// Best-effort dedupe: a marker keyed by dedupeKey suppresses a repeat fan-out
// within the window (e.g. a buyer toggling a like off/on). Returns true if this
// is a duplicate (caller should skip). Never throws; on error it ALLOWS the
// send (fail-open — better a rare dup than a dropped notification).
async function isDuplicate(dedupeKey, windowMs) {
  if (!dedupeKey) return false;
  const db = admin.firestore();
  const ref = db.collection("notifyDedupe").doc(String(dedupeKey).slice(0, 280));
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      if (snap.exists) {
        const at = Number((snap.data() || {}).at) || 0;
        if (now - at < windowMs) return true; // recent → duplicate
      }
      tx.set(ref, {at: now});
      return false;
    });
  } catch (e) {
    logger.warn("notify: dedupe check failed (allowing send)", e && e.message);
    return false;
  }
}

/**
 * Fan out one notification across the requested channels.
 * @param {object} event
 *   recipientUid    {string}  REQUIRED
 *   inApp?          {object}  in-app notification body (kind/listingId/preview/…)
 *   push?           {object}  { payload, category, opts } → sendPush
 *   email?          {object}  lib/email.sendEmail opts (to/subject/react/category/uid/template/…)
 *   dedupeKey?      {string}  suppress a repeat fan-out within the window
 *   dedupeWindowMs? {number}
 * @return {object} per-channel result (or {skipped})
 */
async function notify(event) {
  if (!event || !event.recipientUid) return {skipped: "no-recipient"};
  const uid = event.recipientUid;
  const out = {};

  if (event.dedupeKey &&
      await isDuplicate(event.dedupeKey, event.dedupeWindowMs || DEDUPE_WINDOW_MS)) {
    return {skipped: "duplicate", dedupeKey: event.dedupeKey};
  }

  if (event.inApp) {
    try {
      await writeInApp(uid, event.inApp);
      out.inApp = "written";
    } catch (e) {
      logger.error("notify: in-app write failed", {uid, err: e && e.message});
      out.inApp = "error";
    }
  }
  if (event.push) {
    try {
      out.push = await sendPush(
          uid, event.push.payload, event.push.category, event.push.opts);
    } catch (e) {
      logger.error("notify: push failed", {uid, err: e && e.message});
      out.push = {error: e && e.message};
    }
  }
  if (event.email) {
    try {
      // Lazy-require so the Resend path only loads when an email is actually sent.
      out.email = await require("./email").sendEmail(event.email);
    } catch (e) {
      logger.error("notify: email failed", {uid, err: e && e.message});
      out.email = {error: e && e.message};
    }
  }
  return out;
}

module.exports = {notify, writeInApp};
