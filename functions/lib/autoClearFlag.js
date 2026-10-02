// functions/lib/autoClearFlag.js
//
// Self-healing for listings hidden by an automated image check.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// When optimizeListingPhoto cannot verify a photo it fails closed and sets the
// listing to status:"flagged" — invisible to buyers. That part is deliberate.
// What was missing was any way back out:
//   - firestore.rules only permits a status transition from active/expired, so
//     a direct client write is denied;
//   - updateListing never touches `status`, so re-uploading a good photo
//     changed nothing;
//   - no admin surface reads flaggedListings, so the queue is not watched.
// A false positive was therefore permanent in practice. One sat at
// status:"pending" for 81 days (a racy=LIKELY trip on an ordinary product
// photo in July 2026) and the seller eventually deleted the listing. On
// 2026-10-01 a Vision quota blip hid six listings from one seller inside an
// hour; they were restored by hand.
//
// This module closes that loop: when a re-scan of a photo passes, the listing
// is released automatically.
//
// SAFETY RULES (founder requirements, 2026-10-01)
//   1. Only flags raised by the automated check are ever cleared. Flags we
//      raise are stamped `source: "auto"`; older ones are recognised by their
//      reason. Anything else is left strictly alone.
//   2. The re-scan must pass the SAME thresholds that raised the flag — the
//      caller runs isSafeForMarketplace(), the one function both sides use, so
//      a listing can only clear on the exact test it failed.
//   3. Every clear is written to moderationLog with the old reason and the new
//      scan result, and counted in dailyFounderBriefing.
//
// Note on rule 1 as of today: admin takedown writes status:"removed", not
// "flagged", and all three writers of "flagged" are automated checks inside
// optimizeListingPhoto. So there is currently no manual flag this could touch.
// The gate exists so that the day someone adds one, the safe default is
// already in place.
// ─────────────────────────────────────────────────────────────────────────

const AUTO_FLAG_SOURCE = "auto";

// Reasons the automated path writes. NSFW trips are rendered by
// describeSafeSearchTrip as e.g. "adult=LIKELY" or "racy=VERY_LIKELY,violence=…".
const AUTO_FLAG_REASONS = new Set(["image_scan_error", "image_process_error"]);
const AUTO_FLAG_REASON_RE = /^(adult|racy|violence)=/;

/**
 * Was this flag raised by the automated image check?
 *
 * Unstamped flags fall back to reason matching so listings flagged before the
 * stamp existed can still self-heal. Anything unrecognised returns false —
 * the conservative answer, since a flag we cannot identify is one a human may
 * have set.
 *
 * @param {object} mf The listing's `moderationFlags` map.
 * @return {boolean} True only when the flag is known to be automated.
 */
function isAutoRaisedFlag(mf) {
  if (!mf || typeof mf !== "object" || Array.isArray(mf)) return false;
  if (mf.source === AUTO_FLAG_SOURCE) return true;
  if (mf.source) return false; // explicitly some other source — never ours
  const reason = String(mf.reason || "");
  if (AUTO_FLAG_REASONS.has(reason)) return true;
  return AUTO_FLAG_REASON_RE.test(reason);
}

/**
 * Release a listing an automated check hid, after a clean re-scan.
 *
 * No-op unless the listing exists, is currently flagged, and the flag is
 * automated. Never throws: a failure here must not break photo processing,
 * which is the caller's actual job.
 *
 * @param {object} deps Injected so this is testable without firebase-admin.
 * @param {object} deps.db Firestore instance.
 * @param {object} deps.FieldValue Firestore FieldValue (delete/serverTimestamp).
 * @param {object} [deps.logger] Defaults to console.
 * @param {object} args Call arguments.
 * @param {string} args.listingId Listing being re-scanned.
 * @param {string} args.sellerId Owner, recorded on the audit row.
 * @param {string} args.objPath Storage path of the photo that just passed.
 * @param {object} args.annotation The passing SafeSearch annotation.
 * @return {Promise<boolean>} True if a flag was cleared.
 */
async function clearAutoFlagIfClean(deps, args) {
  const {db, FieldValue} = deps;
  const log = deps.logger || console;
  const {listingId, sellerId, objPath, annotation} = args;
  try {
    const ref = db.collection("listings").doc(listingId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    const data = snap.data() || {};
    if (data.status !== "flagged") return false;

    const mf = data.moderationFlags || {};
    if (!isAutoRaisedFlag(mf)) {
      log.info("autoClearFlag: leaving a non-automated flag alone", {
        listingId, reason: mf.reason, source: mf.source,
      });
      return false;
    }

    const previousReason = String(mf.reason || "(unknown)");
    await ref.update({
      status: "active",
      moderationFlags: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Audit row — what it was flagged for, and what the passing scan said.
    try {
      await db.collection("moderationLog").add({
        contentType: "listing",
        action: "auto_flag_cleared",
        listingId,
        sellerId,
        previousReason,
        rescanSignals: annotation || {},
        rescanPath: objPath,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      log.error("autoClearFlag: moderationLog write failed", listingId, e);
    }

    // Close the admin-queue mirror so entries don't linger the way the July
    // 2026 one did (81 days at status:"pending").
    try {
      await db.collection("flaggedListings").doc(listingId).set({
        status: "resolved",
        resolvedAt: FieldValue.serverTimestamp(),
        resolutionNote:
          `Auto-cleared: re-scan of ${objPath} passed the same thresholds ` +
          `that raised "${previousReason}".`,
      }, {merge: true});
    } catch (e) {
      log.error("autoClearFlag: flaggedListings update failed", listingId, e);
    }

    log.info("autoClearFlag: listing restored after clean re-scan", {
      listingId, sellerId, previousReason, path: objPath,
    });
    return true;
  } catch (e) {
    log.error("autoClearFlag failed", listingId, e && e.message);
    return false;
  }
}

module.exports = {
  clearAutoFlagIfClean,
  isAutoRaisedFlag,
  AUTO_FLAG_SOURCE,
  AUTO_FLAG_REASONS,
};
