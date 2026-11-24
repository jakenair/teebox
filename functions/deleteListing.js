/**
 * functions/deleteListing.js — seller deletes their own listing (2026-11-23).
 *
 * Replaces the app's direct document delete so a listing can't be deleted out
 * from under a buyer who is paying for it. firestore.rules refuse the same
 * case for older app builds. Order: check and delete the document in one
 * transaction, then clean up its photos (best-effort, as the app did).
 * No payment code.
 *
 * Input:  {listingId}
 * Output: {ok: true}
 */
"use strict";
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {inCheckout, DELETE_BLOCKED} = require("./lib/checkoutHold");

// Named: a gcloud-created function has no storageBucket in FIREBASE_CONFIG.
const BUCKET = "teebox-market.firebasestorage.app";

exports.deleteListing = onCall(
    {region: "us-central1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 20},
    async (req) => {
      if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
      const uid = req.auth.uid;
      const listingId = String((req.data || {}).listingId || "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(listingId)) throw new HttpsError("invalid-argument", "listingId required");
      const db = admin.firestore();
      const ref = db.doc(`listings/${listingId}`);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Listing not found.");
        const l = snap.data();
        if (l.sellerId !== uid) throw new HttpsError("permission-denied", "You can only delete your own listings.");
        if (l.status === "sold") throw new HttpsError("failed-precondition", "A sold listing can't be deleted.");
        const now = Date.now();
        if (inCheckout(l, now)) throw new HttpsError("failed-precondition", DELETE_BLOCKED, {reason: "in_checkout"});
        // A bank or wallet payment still settling may no longer be the one the
        // listing points at (multi-unit), so its own record is checked too.
        const settling = await tx.get(db.collection("pendingOrders").where("listingId", "==", listingId));
        const open = settling.docs.filter((d) => {
          const until = d.data().pendingUntil;
          return until && until.toMillis() > now;
        });
        if (open.length) {
          const orders = await tx.getAll(...open.map((d) => db.doc(`orders/${d.id}`)));
          if (orders.some((o) => !o.exists)) {
            throw new HttpsError("failed-precondition", DELETE_BLOCKED, {reason: "payment_processing"});
          }
        }
        tx.delete(ref);
      });
      try {
        await admin.storage().bucket(BUCKET).deleteFiles({prefix: `listings/${uid}/${listingId}/`});
      } catch (e) {
        logger.warn("deleteListing: photo cleanup failed", {listingId, error: String(e && e.message || e)});
      }
      logger.info("deleteListing", {listingId, uid});
      return {ok: true};
    });
