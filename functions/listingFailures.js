"use strict";
// reportListingFailure — server-side record of a failed listing post
// (founder, 2026-11-16).
//
// A seller (Justin) failed to post 12 times over three days and we only
// found out because he emailed. The client (js/app-auth.js submitListing /
// saveListingEdit) now calls this best-effort on every failure with the
// stage it failed at, the error code and, for photo failures, each photo's
// name/size/type/decoded flag and reason. We log it (Cloud Logging, the
// durable record) and raise an ops alert at most once per seller per 10
// minutes so a retry loop cannot flood the inbox.
//
// Nothing here is shown to the seller and nothing is stored in Firestore
// except the per-user throttle doc (users/{uid}/rateLimits/listingFailure,
// server-only like every other rateLimits doc).

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {opsAlert, OPS_ALERT_WEBHOOK} = require("./opsAlert");

const MAX_PER_MINUTE = 6;
const ALERT_EVERY_MS = 10 * 60 * 1000;
const STAGES = new Set(["prepare", "create", "upload", "attach", "held", "edit_upload"]);

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null);

/**
 * Pure: whitelist + clamp the client payload. Never trust shape or size.
 * @param {object} d request.data
 * @return {object}
 */
function sanitizeReport(d) {
  const x = d && typeof d === "object" ? d : {};
  const stage = STAGES.has(String(x.stage)) ? String(x.stage) : "other";
  const photos = Array.isArray(x.photos) ? x.photos.slice(0, 10).map((p) => ({
    i: num(p && p.i),
    name: str(p && p.name, 80),
    origBytes: num(p && p.origBytes),
    sendBytes: num(p && p.sendBytes),
    type: str(p && p.type, 40),
    decoded: !!(p && p.decoded),
    reason: str(p && p.reason, 60),
  })) : [];
  return {
    stage,
    code: str(x.code, 80),
    message: str(x.message, 300),
    listingId: /^[A-Za-z0-9]{1,40}$/.test(String(x.listingId || "")) ? String(x.listingId) : "",
    photoCount: num(x.photoCount),
    specCategory: str(x.specCategory, 20),
    photos,
  };
}

exports.reportListingFailure = onCall(
    {region: "us-central1", memory: "256MiB", timeoutSeconds: 20, concurrency: 80,
      maxInstances: 20, secrets: [OPS_ALERT_WEBHOOK]},
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
      const uid = request.auth.uid;
      const r = sanitizeReport(request.data);
      const ua = str(request.rawRequest && request.rawRequest.headers &&
        request.rawRequest.headers["user-agent"], 200);

      const db = admin.firestore();
      const ref = db.collection("users").doc(uid).collection("rateLimits").doc("listingFailure");
      let admit = true;
      let alert = false;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const now = Date.now();
          const prev = snap.exists ? (snap.data().hits || []) : [];
          const recent = prev.map(Number).filter((n) => Number.isFinite(n) && n > now - 60000).slice(-MAX_PER_MINUTE * 2);
          if (recent.length >= MAX_PER_MINUTE) {
            admit = false;
            return;
          }
          recent.push(now);
          const lastAlertAt = snap.exists ? Number(snap.data().lastAlertAt || 0) : 0;
          alert = now - lastAlertAt > ALERT_EVERY_MS;
          tx.set(ref, {hits: recent, ...(alert ? {lastAlertAt: now} : {}),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
        });
      } catch (e) {
        logger.warn("reportListingFailure: throttle unavailable, logging anyway", {err: e && e.message});
      }
      if (!admit) return {ok: true, throttled: true};

      logger.warn("listing post failed", {uid, ...r, userAgent: ua});
      if (alert) {
        const first = r.photos[0];
        await opsAlert("warn", "Seller couldn't post a listing", {
          uid, stage: r.stage, code: r.code, message: r.message.slice(0, 160),
          listingId: r.listingId || null, specCategory: r.specCategory || null,
          photos: r.photos.length,
          firstPhoto: first ? `${first.name} ${first.type} ${first.origBytes}B→${first.sendBytes}B ${first.reason}` : null,
          userAgent: ua.slice(0, 120),
        });
      }
      return {ok: true};
    },
);

exports._reportListingFailure = {sanitizeReport};
