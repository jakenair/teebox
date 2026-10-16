/**
 * functions/moderationApprove.js
 * ─────────────────────────────────────────────────────────────────────────
 * approveFlaggedListing — admin-only callable. Replaces the admin panel's
 * direct `updateDoc({status:'active', moderationFlags: deleteField()})`.
 *
 * Why a callable and not a client write:
 *   1. the approval must PRUNE the photo moderation deleted (lib/photoPrune
 *      planApproval) — the client never had the object path reliably;
 *   2. it must be IDEMPOTENT: re-approving a clean listing is a no-op, and a
 *      sold/removed listing has its stale flag cleared without being
 *      resurrected;
 *   3. it BACKFILLS variants a scan-error flag skipped, which needs sharp
 *      and bucket access — server-only.
 * One transaction for the listing + queue mirror + moderationLog; variant
 * backfill runs after (best-effort, bounded).
 *
 * Input:  { listingId: string, note?: string }
 * Output: { ok, noop?, reason?, prunedUrl?, backfilled: number, status }
 */
"use strict";
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {adminGate, ADMIN_ALLOWLIST} = require("./lib/adminGate");
const {planApproval, objectPathFromUrl} = require("./lib/photoPrune");
const {backfillVariantsForPhoto} = require("./lib/listingPhotoVariants");

const BUCKET = "teebox-market.firebasestorage.app";
const FN = {
  region: "us-central1",
  memory: "1GiB",          // sharp, for the variant backfill
  timeoutSeconds: 120,
  concurrency: 1,
  maxInstances: 5,
};
const MAX_BACKFILL = 10;

exports.approveFlaggedListing = onCall(
    {...FN, secrets: [ADMIN_ALLOWLIST]},
    async (req) => {
      adminGate(req);
      const listingId = String((req.data || {}).listingId || "");
      const note = String((req.data || {}).note || "").slice(0, 300);
      if (!listingId || !/^[A-Za-z0-9_-]{6,64}$/.test(listingId)) {
        throw new HttpsError("invalid-argument", "listingId required");
      }
      const db = admin.firestore();
      const listingRef = db.collection("listings").doc(listingId);
      const FV = admin.firestore.FieldValue;

      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(listingRef);
        if (!snap.exists) {
          throw new HttpsError("not-found", "Listing no longer exists");
        }
        const data = snap.data() || {};
        const plan = planApproval(data);
        if (plan.noop) {
          // Still drop a stale queue mirror so the card disappears.
          tx.delete(db.collection("flaggedListings").doc(listingId));
          return {ok: true, noop: true, reason: plan.reason, status: data.status, backfilled: 0,
            prunedUrl: null, variantGaps: []};
        }
        const update = {updatedAt: FV.serverTimestamp()};
        if (plan.setActive) update.status = "active";
        if (plan.clearFlags) update.moderationFlags = FV.delete();
        if (plan.photos) {
          update.photos = plan.photos;
          update.photoVariants = plan.photoVariants || {};
        }
        update.unflaggedAt = FV.serverTimestamp();
        update.unflaggedBy = req.auth.uid;
        if (note) update.unflaggedReason = note;
        tx.update(listingRef, update);
        tx.delete(db.collection("flaggedListings").doc(listingId));
        tx.set(db.collection("moderationLog").doc(), {
          kind: "admin-approve",
          listingId,
          sellerId: data.sellerId || null,
          adminUid: req.auth.uid,
          adminEmail: (req.auth.token && req.auth.token.email) || null,
          previousStatus: data.status || null,
          previousFlags: data.moderationFlags || null,
          prunedUrl: plan.prunedUrl || null,
          note: note || null,
          at: FV.serverTimestamp(),
        });
        return {ok: true, noop: false, status: plan.setActive ? "active" : data.status,
          prunedUrl: plan.prunedUrl || null, variantGaps: plan.variantGaps || [],
          photos: plan.photos || data.photos || [], backfilled: 0};
      });

      // Variant backfill — outside the transaction, best-effort, bounded.
      if (!result.noop && result.variantGaps.length) {
        const bucket = admin.storage().bucket(BUCKET);
        for (const idx of result.variantGaps.slice(0, MAX_BACKFILL)) {
          const url = result.photos[idx];
          const path = objectPathFromUrl(url);
          if (!path) continue;
          try {
            const r = await backfillVariantsForPhoto(bucket, listingId, path, idx);
            if (r.ok) result.backfilled++;
            else logger.warn("approve: variant backfill skipped", {listingId, idx, reason: r.reason});
          } catch (e) {
            logger.error("approve: variant backfill failed", {listingId, idx, err: e && e.message});
          }
        }
      }
      delete result.photos;
      logger.info("approveFlaggedListing", {listingId, ...result});
      return result;
    },
);
