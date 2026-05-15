/**
 * banEvasion.js — V1 ban-evasion signal capture + cross-reference.
 *
 * Background
 *   The audit flagged that the only ban defense was `users/{uid}.banned`
 *   checked at charge time. A banned user could create a fresh account
 *   and walk right back in. This module is a deliberately minimal V1:
 *
 *     1. captureFraudSignal({ uid, ip, cardFingerprint }) — write a
 *        `fraudSignals/{uid}_{YYYY-MM-DD-HH}` doc with whatever signals
 *        we have at the time of the call. Hour-bucketed so a single
 *        user can have multiple docs over time (one per active hour)
 *        without unbounded growth. Best-effort, never throws.
 *
 *     2. checkFingerprintAgainstBanned({ ip, cardFingerprint }) —
 *        scan `fraudSignals/` for matches on either field. For every
 *        match, look up the owning user; if that user is banned,
 *        return { banned: true, matchedUid, matchedField }. Returns
 *        { banned: false } otherwise. Best-effort: any Firestore
 *        error fails OPEN (we don't block legitimate checkouts on a
 *        bad index or transient outage) but the error is logged.
 *
 * Limitations (documented in BAN_EVASION_ROADMAP.md)
 *   - IP is fragile. Shared NATs (corporate / college / hotel wifi),
 *     mobile carriers, VPNs all produce false positives. We accept
 *     this for V1 — the alternative is letting banned users back in
 *     with zero friction.
 *   - Card fingerprint is reliable (Stripe issues one fingerprint per
 *     unique card-number, stable across customers and accounts) but
 *     only available AFTER a successful charge. So the IP check is
 *     pre-charge (deny upfront) and the card-fingerprint check is
 *     post-charge (retroactively ban + flag the order).
 *   - No device fingerprint (FingerprintJS) yet. That's Phase 2.
 *
 * Schema
 *   fraudSignals/{docId}
 *     {
 *       uid: string,
 *       ip: string | null,
 *       cardFingerprint: string | null,
 *       sampledAt: Timestamp,
 *     }
 *
 * Indexes required
 *   - fraudSignals.ip  (asc)             — for the IP query
 *   - fraudSignals.cardFingerprint (asc) — for the card-fingerprint query
 *   Add to firestore.indexes.json when ready to ship in earnest. The
 *   query helpers below tolerate a missing index by logging + failing
 *   open, so we don't block deploy on the index propagating.
 */

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");

// Cap on how many signal docs we scan per query. 200 is plenty for the
// foreseeable scale (a banned user might recycle 5-10 IPs) and bounds
// the worst-case Firestore read cost per checkout.
const MAX_SCAN_LIMIT = 200;

/**
 * Build the hour-bucketed signal doc id. We pad to fixed width so
 * the doc ids sort lexicographically in Firestore (helpful for the
 * admin UI even though we never query by id).
 */
function bucketDocId(uid, when) {
  const d = when || new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  return `${uid}_${y}-${m}-${day}-${hour}`;
}

/**
 * Persist whatever fraud signals we have for a uid. Hour-bucketed
 * (one doc per uid per hour, overwriting within the hour) so a busy
 * user doesn't spawn one doc per request. Merge-on-write so a later
 * call in the same hour can fill in fields (e.g. cardFingerprint after
 * the pre-charge IP capture).
 *
 * Never throws — fraud-signal capture is strictly observability /
 * defense-in-depth, and must not break checkout.
 */
async function captureFraudSignal({uid, ip = null, cardFingerprint = null}) {
  if (!uid || typeof uid !== "string") return;
  if (!ip && !cardFingerprint) return;
  try {
    const db = admin.firestore();
    const ref = db.collection("fraudSignals").doc(bucketDocId(uid));
    const payload = {
      uid,
      sampledAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (ip) payload.ip = String(ip).slice(0, 64);
    if (cardFingerprint) {
      payload.cardFingerprint = String(cardFingerprint).slice(0, 64);
    }
    await ref.set(payload, {merge: true});
  } catch (err) {
    logger.warn("captureFraudSignal failed (non-fatal)", err.message);
  }
}

/**
 * For each candidate signal doc, look up the owning user and decide
 * whether they are banned. Returns the first banned match found, or
 * { banned: false } if none.
 *
 * We dedupe by uid before hitting Firestore for the user docs because
 * a busy attacker will produce many signal docs for the same uid.
 */
async function evaluateMatches(snap, matchedField) {
  const db = admin.firestore();
  const uids = new Set();
  snap.forEach((d) => {
    const data = d.data() || {};
    if (data.uid) uids.add(String(data.uid));
  });
  for (const uid of uids) {
    try {
      const userSnap = await db.doc(`users/${uid}`).get();
      if (userSnap.exists && userSnap.data() &&
          userSnap.data().banned === true) {
        return {banned: true, matchedUid: uid, matchedField};
      }
    } catch (err) {
      // A single user-doc read failure shouldn't stop us from checking
      // the remaining candidates. Log + continue.
      logger.warn(
          `evaluateMatches: users/${uid} read failed`, err.message);
    }
  }
  return {banned: false};
}

/**
 * Cross-reference an incoming { ip, cardFingerprint } pair against
 * the historical fraudSignals collection. Returns:
 *   { banned: true, matchedUid, matchedField }   if any signal that
 *     shares either field belongs to a banned user.
 *   { banned: false }                             otherwise (including
 *     the fail-open path on Firestore errors).
 *
 * The two fields are checked in two separate queries (Firestore can't
 * OR across fields). We bail early if the IP query already finds a
 * banned match so we don't waste reads.
 */
async function checkFingerprintAgainstBanned({ip = null, cardFingerprint = null} = {}) {
  if (!ip && !cardFingerprint) return {banned: false};
  const db = admin.firestore();
  try {
    if (ip) {
      const ipSnap = await db.collection("fraudSignals")
          .where("ip", "==", String(ip))
          .limit(MAX_SCAN_LIMIT)
          .get();
      if (!ipSnap.empty) {
        const result = await evaluateMatches(ipSnap, "ip");
        if (result.banned) return result;
      }
    }
    if (cardFingerprint) {
      const cfSnap = await db.collection("fraudSignals")
          .where("cardFingerprint", "==", String(cardFingerprint))
          .limit(MAX_SCAN_LIMIT)
          .get();
      if (!cfSnap.empty) {
        const result = await evaluateMatches(cfSnap, "cardFingerprint");
        if (result.banned) return result;
      }
    }
  } catch (err) {
    // Fail OPEN. The alternative is blocking legitimate checkouts on
    // every Firestore hiccup — unacceptable for V1. Real ban defense is
    // still the `users/{uid}.banned` check in createPaymentIntent;
    // this module is defense-in-depth on top of that.
    logger.warn(
        "checkFingerprintAgainstBanned failed; failing open", err.message);
  }
  return {banned: false};
}

/**
 * Extract the caller's best-guess IP from an HTTP request. Tries
 * x-forwarded-for first (Firebase / Cloud Run sit behind a proxy) and
 * falls back to req.ip / req.socket.remoteAddress. Returns null on
 * any failure.
 *
 * x-forwarded-for can be a comma-separated chain ("client, proxy1,
 * proxy2"); we take the leftmost (the original client) per RFC 7239.
 */
function extractClientIp(req) {
  if (!req) return null;
  try {
    const h = req.headers || {};
    const xff = h["x-forwarded-for"] || h["X-Forwarded-For"];
    if (typeof xff === "string" && xff.length > 0) {
      const first = xff.split(",")[0].trim();
      if (first) return first.slice(0, 64);
    }
    if (typeof req.ip === "string" && req.ip) return req.ip.slice(0, 64);
    if (req.socket && typeof req.socket.remoteAddress === "string") {
      return req.socket.remoteAddress.slice(0, 64);
    }
  } catch (_e) {
    // fall through to null
  }
  return null;
}

/**
 * Mark a user as banned with an audit trail entry. Used by the
 * post-charge card-fingerprint check to retroactively ban a new
 * account that matched a banned user's card. Best-effort.
 */
async function flagUserBanned({uid, reason, matchedUid, matchedField}) {
  if (!uid) return;
  try {
    const db = admin.firestore();
    await db.doc(`users/${uid}`).set({
      banned: true,
      banReason: reason || "fraud-signal-match",
      bannedAt: admin.firestore.FieldValue.serverTimestamp(),
      banAuditTrail: admin.firestore.FieldValue.arrayUnion({
        reason: reason || "fraud-signal-match",
        matchedUid: matchedUid || null,
        matchedField: matchedField || null,
        at: new Date().toISOString(),
      }),
    }, {merge: true});
  } catch (err) {
    logger.warn("flagUserBanned failed (non-fatal)", err.message);
  }
}

module.exports = {
  captureFraudSignal,
  checkFingerprintAgainstBanned,
  extractClientIp,
  flagUserBanned,
};
