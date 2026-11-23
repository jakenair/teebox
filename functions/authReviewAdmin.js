/**
 * functions/authReviewAdmin.js — admin decisions on high-value listings
 * (2026-11-23). Two admin-only callables behind /admin/review/:
 *
 *   listAuthReviews()                                  → {items: [...]}
 *   decideAuthReview({listingId, decision, reason?})   → {ok, noop?, emailed}
 *
 * decideAuthReview needs a fresh admin sign-in (5 minutes, like banUser),
 * writes the listing + adminActions log in one transaction, then emails the
 * seller. An approved listing joins both ad feeds on their next rebuild.
 * Nothing here touches orders, payments or payouts.
 */
"use strict";
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {adminGate, requireFreshAdminAuth} = require("./lib/adminGate");
const {needsAuthReview, planDecision} = require("./lib/authReview");

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const FN = {region: "us-central1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 5};

exports.listAuthReviews = onCall({...FN}, async (req) => {
  adminGate(req);
  const db = admin.firestore();
  const snap = await db.collection("listings").where("ask", ">=", 300).limit(500).get();
  const ms = (v) => v && typeof v.toMillis === "function" ? v.toMillis() : 0;
  const rows = snap.docs.map((d) => ({id: d.id, ...d.data()}))
      .filter((l) => needsAuthReview(l) && l.authReviewState !== "approved" &&
        (["active", "pending", "hidden", "flagged", "expired"].includes(l.status) ||
          (l.status === "removed" && l.authReviewState === "rejected")) &&
        !require("./lib/testAccounts").isTestListingDoc(l, l.id))
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const ids = [...new Set(rows.map((l) => String(l.sellerId || "")).filter(Boolean))];
  const names = {};
  if (ids.length) {
    const us = await db.getAll(...ids.map((id) => db.doc(`users/${id}`)));
    for (const u of us) names[u.id] = u.exists ? String(u.data().displayName || "") : "";
  }
  return {items: rows.map((l) => ({
    listingId: l.id, title: l.title || "", brand: l.brand || "", ask: Number(l.ask) || 0,
    condition: l.condition || "", status: l.status, state: l.authReviewState || "pending",
    reason: l.authReviewReason || "", photos: (l.photos || []).slice(0, 10),
    sellerId: l.sellerId || "", sellerName: names[l.sellerId] || "", createdAt: ms(l.createdAt),
  }))};
});

exports.decideAuthReview = onCall({...FN, secrets: [RESEND_API_KEY]}, async (req) => {
  adminGate(req);
  requireFreshAdminAuth(req);
  const d = req.data || {};
  const listingId = String(d.listingId || "");
  const decision = String(d.decision || "");
  const reason = String(d.reason || "").trim().slice(0, 500);
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(listingId)) throw new HttpsError("invalid-argument", "listingId required");
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const ref = db.doc(`listings/${listingId}`);
  const after = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Listing no longer exists");
    const l = snap.data();
    const plan = planDecision(l, decision, reason);
    if (plan.error) throw new HttpsError("failed-precondition", plan.error);
    if (plan.noop) return null;
    const n = (Number(l.authReviewDecisionN) || 0) + 1;
    const update = {authReviewedAt: FV.serverTimestamp(), authReviewedBy: req.auth.uid,
      authReviewDecisionN: n, updatedAt: FV.serverTimestamp()};
    for (const [k, v] of Object.entries(plan.update)) update[k] = v === undefined ? FV.delete() : v;
    if (decision === "reject") update.removedAt = FV.serverTimestamp();
    tx.update(ref, update);
    tx.set(db.collection("adminActions").doc(), {
      adminUid: req.auth.uid, adminEmail: (req.auth.token && req.auth.token.email) || null,
      action: `auth_review_${decision}`, targetType: "listing", targetId: listingId, reason,
      metadata: {sellerId: l.sellerId || null, previousState: l.authReviewState || null,
        previousStatus: l.status || null}, performedAt: FV.serverTimestamp(),
    });
    return {id: listingId, sellerId: l.sellerId, title: l.title,
      status: plan.update.status || l.status, decisionN: n};
  });
  if (!after) return {ok: true, noop: true, emailed: false};
  let emailed = false;
  try {
    emailed = await require("./lib/authReviewEmail").sendReviewEmail(after, decision, reason);
  } catch (e) {
    logger.error("decideAuthReview: seller email failed", {listingId, error: String(e && e.message || e)});
  }
  logger.info("decideAuthReview", {listingId, decision, status: after.status, emailed});
  return {ok: true, noop: false, status: after.status, emailed};
});
