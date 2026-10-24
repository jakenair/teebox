// functions/passportLikeCount.js
//
// Keeps passport/{uid}/played/{courseId}.likeCount in step with the likes
// subcollection so the Discover feed can show a total per post without a
// count query per card (r360). Likes are one doc per liker (doc id = liker
// uid), created/deleted by the client under the rules in firestore.rules.
//
// onDocumentWritten covers both create (+1) and delete (-1). The parent is
// updated in a transaction and clamped at 0, so a replayed or out-of-order
// event can't push the count negative. If the parent round was deleted the
// update is skipped (no orphan doc is created).

const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

exports.onPassportLikeWritten = onDocumentWritten(
    {
      document: "passport/{uid}/played/{courseId}/likes/{likerId}",
      region: "us-central1",
      memory: "256MiB",
      timeoutSeconds: 30,
      concurrency: 1,
      maxInstances: 20,
    },
    async (event) => {
      const before = !!(event.data && event.data.before && event.data.before.exists);
      const after = !!(event.data && event.data.after && event.data.after.exists);
      const delta = (!before && after) ? 1 : (before && !after) ? -1 : 0;
      if (!delta) return;
      const {uid, courseId} = event.params;
      const db = admin.firestore();
      const ref = db.doc(`passport/${uid}/played/${courseId}`);
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return; // round deleted — nothing to count against
          const cur = Number(snap.get("likeCount") || 0);
          tx.update(ref, {likeCount: Math.max(0, cur + delta)});
        });
      } catch (e) {
        logger.warn(`passportLikeCount: ${uid}/${courseId} ${delta > 0 ? "+" : ""}${delta} failed: ${e.message}`);
      }
    },
);
