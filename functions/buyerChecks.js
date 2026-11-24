/**
 * functions/buyerChecks.js (2026-11-23)
 *   confirmBuyerAge18   the 18+ tick next to the Pay button, recorded once
 *   publishShipFromHeld the seller just saved a ship-from address
 */
"use strict";
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const H = require("./lib/shipFromHold");

const FN = {region: "us-central1", memory: "256MiB", timeoutSeconds: 30, concurrency: 40, maxInstances: 10};

exports.confirmBuyerAge18 = onCall(FN, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!req.data || req.data.age18 !== true) throw new HttpsError("invalid-argument", "age18 required");
  const db = admin.firestore();
  const ref = db.collection("users").doc(req.auth.uid);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists && s.data().buyerAge18At) return;
    tx.set(ref, {buyerAge18At: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
  });
  return {ok: true};
});

exports.publishShipFromHeld = onCall(FN, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  return {ok: true, published: await H.publishHeld(admin.firestore(), admin.firestore.FieldValue, req.auth.uid)};
});
