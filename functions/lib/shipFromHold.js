"use strict";
// Clubs and bags need the seller's ship-from address before they can be sold
// (founder, 2026-11-23). The web Sell form asks for it first. A listing that
// still arrives without one (an older app) is saved hidden/awaiting_ship_from
// and publishes when the address is added: at once when the web or the
// /ship-from/ page saves it, else on the half-hourly sweep. No onUpdate
// trigger (#34).
const {hasShipFrom, needsShipFrom} = require("./buyable");

const REASON = "awaiting_ship_from";

/** Publish one seller's held listings if the address is there now. @return {Promise<number>} */
async function publishHeld(db, FieldValue, uid) {
  const us = await db.collection("users").doc(uid).get();
  const u = us.exists ? us.data() : null;
  if (!hasShipFrom(u)) return 0;
  const snap = await db.collection("listings").where("sellerId", "==", uid).where("status", "==", "hidden")
      .where("hiddenReason", "==", REASON).limit(200).get();
  if (snap.empty) return 0;
  const now = Date.now();
  const batch = db.batch();
  let live = 0;
  snap.docs.forEach((d) => {
    const l = d.data();
    const expired = l.expiresAt && l.expiresAt.toMillis && l.expiresAt.toMillis() < now;
    if (u.stripeChargesEnabled !== true && !expired) {
      batch.update(d.ref, {hiddenReason: "awaiting_payouts", updatedAt: FieldValue.serverTimestamp()});
      return;
    }
    if (!expired) live++;
    batch.update(d.ref, {status: expired ? "expired" : "active", hiddenReason: FieldValue.delete(), hiddenAt: FieldValue.delete(),
      ...(expired ? {} : {publishedAt: FieldValue.serverTimestamp()}), updatedAt: FieldValue.serverTimestamp()});
  });
  await batch.commit();
  return live;
}

/** Every seller with held listings (small set). @return {Promise<number>} */
async function sweep(db, FieldValue) {
  const snap = await db.collection("listings").where("status", "==", "hidden").where("hiddenReason", "==", REASON).limit(200).get();
  let n = 0;
  for (const uid of new Set(snap.docs.map((d) => String(d.data().sellerId || "")).filter(Boolean))) n += await publishHeld(db, FieldValue, uid);
  return n;
}

/** Hide a just-created club or bag whose seller has no address. @return {Promise<boolean>} */
async function holdIfNeeded(db, FieldValue, ref, user) {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const l = s.exists ? s.data() : null;
    if (!l || l.status !== "active" || !needsShipFrom(l) || hasShipFrom(user)) return false;
    tx.update(ref, {status: "hidden", hiddenReason: REASON, awaitingSince: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
    return true;
  });
}

module.exports = {REASON, publishHeld, sweep, holdIfNeeded};
