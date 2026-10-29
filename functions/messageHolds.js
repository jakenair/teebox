// functions/messageHolds.js — 2026-10-30
//
// Lifecycle of a held chat message (messageHolds/{id}, written by sendMessage):
//
//   onMessageHoldCreated  ops alert per hold (opsAlert → SMOKE_ALERT_WEBHOOK →
//                         opsAlertRelay → email + Telegram) with sender,
//                         recipient, reason, a 120-char DEFANGED snippet and a
//                         deep link into the admin view. The link only OPENS
//                         the hold; approve/reject happen in the admin view
//                         behind admin auth. No action URL is ever emailed.
//   listMessageHolds      admin: the queue (default: pending), with names.
//   releaseHold           admin + fresh re-auth: APPROVE — delivers the message
//                         with the same payload/conversation writes sendMessage
//                         uses (buildDeliveryWrites), atomically with the
//                         pending → released flip (a double tap can't deliver
//                         twice). The delivered message still goes through
//                         moderateMessage (a non-allowlisted link gets the card).
//   rejectHold            admin + fresh re-auth: pending → rejected. Nothing is
//                         delivered.
//   messageHoldsDailyDigest  09:00 America/Chicago: "N held in the last 24 h
//                         (by reason), M pending". Two single-field queries.
//
// Every decision writes adminActions/{auto}. A pending hold that nobody acts on
// is DISCARDED by the Firestore TTL on expireAt (~30 days) — never delivered.
"use strict";
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {adminGate, requireFreshAdminAuth, ADMIN_ALLOWLIST} = require("./lib/adminGate");
const {opsAlert, OPS_ALERT_WEBHOOK} = require("./opsAlert");

const ADMIN_HOLDS_URL = "https://teeboxmarket.com/?admin=holds";
const FN = {region: "us-central1", memory: "256MiB", timeoutSeconds: 30, concurrency: 80,
  maxInstances: 10};

function holdAdminUrl(holdId) {
  return holdId ? `${ADMIN_HOLDS_URL}&hold=${encodeURIComponent(holdId)}` : ADMIN_HOLDS_URL;
}

// Make a phishing URL un-clickable in the ops email / Telegram: scheme →
// hxxp, every dot in a host-like token → [.]. The reviewer still reads it.
function defang(text) {
  return String(text || "")
      .replace(/\bhttp(s?):\/\//gi, "hxxp$1://")
      .replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/gi, (h) => h.replace(/\./g, "[.]"));
}

function snippet(text, n = 120) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return defang(t.length > n ? t.slice(0, n - 1) + "…" : t);
}

function displayNameOf(u) {
  const d = u || {};
  return String(d.displayName || d.name || d.firstName || "").trim().slice(0, 60) || "(no name)";
}

/**
 * Ops alert payload for one hold (pure).
 * @return {{severity:string, title:string, details:object}}
 */
function buildHoldAlert(holdId, h, senderUser, recipientUser) {
  const hold = h || {};
  const reasons = Array.isArray(hold.reasons) && hold.reasons.length ?
    hold.reasons : [hold.reason || "unknown"];
  const title = hold.reviewFlag === true ?
    "Account auto-flagged + message held (new account messaging many sellers)" :
    `Chat message held: ${reasons[0]}`;
  const details = {
    sender: `${displayNameOf(senderUser)} (${hold.sender || "?"})`,
    senderAgeHours: typeof hold.senderAccountAgeHours === "number" ?
      hold.senderAccountAgeHours : null,
    recipient: `${displayNameOf(recipientUser)} (${hold.recipient || "?"})`,
    reason: reasons.join(", "),
    linkHosts: Array.isArray(hold.externalHosts) && hold.externalHosts.length ?
      defang(hold.externalHosts.join(", ")) : null,
    snippet: snippet(hold.text, 120),
    review: holdAdminUrl(holdId) + "  (approve / reject there, admin sign-in required)",
  };
  return {severity: "warn", title, details};
}

/**
 * The writes that deliver a chat message — the ONE payload shape sendMessage
 * and releaseHold share. Returns [{ref, data, opts}] for the caller to apply
 * (sequentially in sendMessage, inside a transaction in releaseHold).
 */
function buildDeliveryWrites({convRef, msgRef, senderId, text, clientFlag, extra, FieldValue}) {
  const message = {senderId, text, createdAt: FieldValue.serverTimestamp()};
  if (clientFlag) message.clientFlag = clientFlag;
  Object.assign(message, extra || {});
  const convBump = {
    lastMessageAt: FieldValue.serverTimestamp(),
    lastMessageText: String(text).slice(0, 100),
    lastMessageSenderId: senderId,
    lastRead: {[senderId]: FieldValue.serverTimestamp()},
  };
  return [
    {ref: msgRef, data: message, opts: null},
    {ref: convRef, data: convBump, opts: {merge: true}},
  ];
}

/** Daily digest numbers (pure). holds = docs created in the window. */
function summarizeHolds(recent, pending, now) {
  const byReason = {};
  const decided = {released: 0, rejected: 0};
  for (const h of recent || []) {
    const r = (h && h.reason) || "unknown";
    byReason[r] = (byReason[r] || 0) + 1;
    if (h && h.status === "released") decided.released++;
    if (h && h.status === "rejected") decided.rejected++;
  }
  let oldestMs = 0;
  for (const h of pending || []) {
    const ms = h && h.createdAt && h.createdAt.toMillis ? h.createdAt.toMillis() : 0;
    if (ms && (!oldestMs || ms < oldestMs)) oldestMs = ms;
  }
  const heldCount = (recent || []).length;
  const pendingCount = (pending || []).length;
  const reasonLine = Object.entries(byReason).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return {
    heldCount, pendingCount, byReason, decided,
    oldestPendingHours: oldestMs ? Math.round((now - oldestMs) / 360000) / 10 : null,
    title: `Message holds: ${heldCount} held in the last 24h, ${pendingCount} pending`,
    reasonLine,
  };
}

// ── Trigger: alert per hold ─────────────────────────────────────────
exports.onMessageHoldCreated = onDocumentCreated(
    {document: "messageHolds/{holdId}", ...FN, timeoutSeconds: 60,
      secrets: [OPS_ALERT_WEBHOOK]},
    async (event) => {
      try {
        const h = event.data && event.data.data();
        if (!h) return;
        const db = admin.firestore();
        const read = async (uid) => {
          if (!uid) return null;
          try {
            const s = await db.collection("users").doc(String(uid)).get();
            return s.exists ? s.data() : null;
          } catch (_e) { return null; }
        };
        const [su, ru] = await Promise.all([read(h.sender), read(h.recipient)]);
        const a = buildHoldAlert(event.params.holdId, h, su, ru);
        await opsAlert(a.severity, a.title, a.details);
      } catch (err) {
        logger.error("onMessageHoldCreated alert failed", err);
      }
    },
);

// ── Admin: list ─────────────────────────────────────────────────────
exports.listMessageHolds = onCall(
    {...FN, secrets: [ADMIN_ALLOWLIST]},
    async (req) => {
      adminGate(req);
      const d = req.data || {};
      const status = ["pending", "released", "rejected"].includes(d.status) ? d.status : "pending";
      const limit = Math.min(Math.max(Number(d.limit) || 100, 1), 200);
      const db = admin.firestore();
      const snap = await db.collection("messageHolds")
          .where("status", "==", status).limit(limit).get();
      const toMs = (t) => (t && t.toMillis) ? t.toMillis() : null;
      const holds = snap.docs.map((doc) => {
        const h = doc.data() || {};
        return {
          holdId: doc.id,
          status: h.status || null,
          reason: h.reason || null,
          reasons: Array.isArray(h.reasons) ? h.reasons : null,
          sender: h.sender || null,
          recipient: h.recipient || null,
          conversationId: h.conversationId || null,
          text: h.text || "",
          externalHosts: Array.isArray(h.externalHosts) ? h.externalHosts : null,
          scamPhrases: Array.isArray(h.scamPhrases) ? h.scamPhrases : null,
          senderAccountAgeHours: typeof h.senderAccountAgeHours === "number" ?
            h.senderAccountAgeHours : null,
          createdAt: toMs(h.createdAt),
          expireAt: toMs(h.expireAt),
        };
      }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      // Names for the reviewer (deduped reads).
      const uids = [...new Set(holds.flatMap((x) => [x.sender, x.recipient]).filter(Boolean))];
      const names = {};
      await Promise.all(uids.slice(0, 100).map(async (uid) => {
        try {
          const s = await db.collection("users").doc(uid).get();
          names[uid] = displayNameOf(s.exists ? s.data() : null);
        } catch (_e) { names[uid] = "(unknown)"; }
      }));
      for (const x of holds) {
        x.senderName = names[x.sender] || null;
        x.recipientName = names[x.recipient] || null;
      }
      return {ok: true, count: holds.length, status, holds};
    },
);

async function logAdminAction(req, action, holdId, note, metadata) {
  try {
    await admin.firestore().collection("adminActions").add({
      adminUid: req.auth.uid,
      adminEmail: req.auth.token && req.auth.token.email,
      action,
      targetType: "messageHold",
      targetId: holdId,
      reason: note || "",
      metadata: metadata || {},
      performedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn("messageHolds: logAdminAction failed", e);
  }
}

function holdIdFrom(req) {
  const holdId = String((req.data || {}).holdId || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(holdId)) {
    throw new HttpsError("invalid-argument", "holdId required");
  }
  return holdId;
}

// ── Admin: approve (deliver) ────────────────────────────────────────
exports.releaseHold = onCall(
    {...FN, secrets: [ADMIN_ALLOWLIST]},
    async (req) => {
      adminGate(req);
      requireFreshAdminAuth(req);
      const holdId = holdIdFrom(req);
      const note = String((req.data || {}).note || "").slice(0, 300);
      const db = admin.firestore();
      const FieldValue = admin.firestore.FieldValue;
      const holdRef = db.collection("messageHolds").doc(holdId);
      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(holdRef);
        if (!snap.exists) {
          throw new HttpsError("not-found",
              "Hold not found (it may have expired and been discarded).");
        }
        const hold = snap.data() || {};
        if (hold.status !== "pending") {
          throw new HttpsError("failed-precondition",
              `Hold is '${hold.status || "unknown"}', not pending.`);
        }
        const cid = hold.conversationId;
        const senderId = hold.sender;
        const text = hold.text;
        if (!cid || !senderId || !text) {
          throw new HttpsError("failed-precondition", "Hold is missing conversation/sender/text.");
        }
        const convRef = db.collection("conversations").doc(cid);
        const convSnap = await tx.get(convRef);
        if (!convSnap.exists) {
          throw new HttpsError("failed-precondition", "Conversation no longer exists.");
        }
        const participants = Array.isArray((convSnap.data() || {}).participants) ?
          convSnap.data().participants : [];
        if (!participants.includes(senderId)) {
          throw new HttpsError("failed-precondition",
              "Sender is no longer a participant of this conversation.");
        }
        const msgRef = convRef.collection("messages").doc();
        for (const w of buildDeliveryWrites({convRef, msgRef, senderId, text,
          clientFlag: hold.clientFlag || null,
          extra: {releasedFromHold: true, holdId}, FieldValue})) {
          if (w.opts) tx.set(w.ref, w.data, w.opts); else tx.set(w.ref, w.data);
        }
        tx.update(holdRef, {
          status: "released",
          releasedAt: FieldValue.serverTimestamp(),
          releasedBy: req.auth.uid,
          releaseNote: note,
          deliveredMessageId: msgRef.id,
        });
        return {cid, senderId, messageId: msgRef.id};
      });
      await logAdminAction(req, "release_hold", holdId, note,
          {conversationId: out.cid, sender: out.senderId, messageId: out.messageId});
      logger.info(`releaseHold: delivered ${holdId} -> ${out.cid}/${out.messageId}`);
      return {ok: true, delivered: true, messageId: out.messageId, conversationId: out.cid};
    },
);

// ── Admin: reject ───────────────────────────────────────────────────
exports.rejectHold = onCall(
    {...FN, secrets: [ADMIN_ALLOWLIST]},
    async (req) => {
      adminGate(req);
      requireFreshAdminAuth(req);
      const holdId = holdIdFrom(req);
      const note = String((req.data || {}).note || "").slice(0, 300);
      const db = admin.firestore();
      const FieldValue = admin.firestore.FieldValue;
      const holdRef = db.collection("messageHolds").doc(holdId);
      const hold = await db.runTransaction(async (tx) => {
        const snap = await tx.get(holdRef);
        if (!snap.exists) throw new HttpsError("not-found", "Hold not found.");
        const h = snap.data() || {};
        if (h.status !== "pending") {
          throw new HttpsError("failed-precondition",
              `Hold is '${h.status || "unknown"}', not pending.`);
        }
        tx.update(holdRef, {
          status: "rejected",
          rejectedAt: FieldValue.serverTimestamp(),
          rejectedBy: req.auth.uid,
          rejectNote: note,
        });
        return h;
      });
      await logAdminAction(req, "reject_hold", holdId, note,
          {conversationId: hold.conversationId || null, sender: hold.sender || null,
            reason: hold.reason || null});
      return {ok: true, rejected: true};
    },
);

// ── Daily digest ────────────────────────────────────────────────────
async function runDailyDigest(now) {
  const db = admin.firestore();
  const since = admin.firestore.Timestamp.fromMillis(now - 24 * 3600 * 1000);
  const [recentSnap, pendingSnap] = await Promise.all([
    db.collection("messageHolds").where("createdAt", ">=", since).limit(1000).get(),
    db.collection("messageHolds").where("status", "==", "pending").limit(1000).get(),
  ]);
  const s = summarizeHolds(recentSnap.docs.map((d) => d.data()),
      pendingSnap.docs.map((d) => d.data()), now);
  await opsAlert(s.pendingCount ? "warn" : "info", s.title, {
    heldLast24hByReason: s.reasonLine,
    decidedLast24h: `approved ${s.decided.released}, rejected ${s.decided.rejected}`,
    pending: s.pendingCount,
    oldestPendingHours: s.oldestPendingHours,
    review: ADMIN_HOLDS_URL,
  });
  return s;
}

exports.messageHoldsDailyDigest = onSchedule(
    {schedule: "0 9 * * *", timeZone: "America/Chicago", region: "us-central1",
      memory: "256MiB", timeoutSeconds: 60, secrets: [OPS_ALERT_WEBHOOK]},
    async () => {
      try {
        await runDailyDigest(Date.now());
      } catch (e) {
        logger.error("messageHoldsDailyDigest failed", e);
      }
    },
);

exports.buildDeliveryWrites = buildDeliveryWrites;
module.exports._test = {holdAdminUrl, defang, snippet, buildHoldAlert, buildDeliveryWrites,
  summarizeHolds, runDailyDigest, displayNameOf};
