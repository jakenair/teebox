/**
 * functions/messageReadState.js
 * ─────────────────────────────────────────────────────────────────────────
 * Server-derived `users/{uid}.unreadConversations` counter for the
 * bottom-nav badge in the mobile + web UIs. Two Firestore triggers
 * keep the count honest:
 *
 *   onMessageCreatedReadCount —
 *     Fires on conversations/{cid}/messages/{mid} create. For each
 *     participant of the conversation who is NOT the sender, we
 *     compare the conversation's last activity to that participant's
 *     `lastReadAt` cursor (read from
 *     conversations/{cid}/participantState/{uid}.lastReadAt). If the
 *     new message advances the conversation's unread state for that
 *     participant (i.e. lastReadAt < createdAt), we increment that
 *     participant's users/{uid}.unreadConversations counter by 1 IFF
 *     the conversation wasn't already counted as unread.
 *
 *     "Already counted" is tracked by writing
 *     participantState/{uid}.countedUnread = true on the first
 *     increment, and clearing it when the user advances lastReadAt.
 *     This makes the counter a "distinct unread conversations" count
 *     rather than a "raw unread messages" count — matches the
 *     bottom-nav badge UX (1 dot if any conversation has unread, with
 *     the number of conversations behind it).
 *
 *   onParticipantStateReadCount —
 *     Fires on conversations/{cid}/participantState/{uid} update.
 *     When the user advances `lastReadAt` past the conversation's
 *     lastMessageAt, we set their `countedUnread` flag to false and
 *     recompute (scan their participantState docs across all
 *     conversations) their users/{uid}.unreadConversations counter.
 *     The recompute is cheap: one collectionGroup query keyed on the
 *     user's uid.
 *
 * STORAGE SHAPE
 *   conversations/{cid}/participantState/{uid}:
 *     lastReadAt       — Timestamp (client-written, governed by rules)
 *     countedUnread    — bool (server-owned, set by these triggers)
 *
 *   users/{uid}:
 *     unreadConversations — number (server-owned)
 *
 * FAIL-OPEN POSTURE
 *   Both triggers swallow per-conversation errors and continue with the
 *   rest of the fan-out. The counter is a UX badge, not a correctness
 *   surface — a transient Firestore hiccup must NEVER block message
 *   delivery or read-receipt updates.
 *
 * WIRING
 *   Imported into functions/index.js at the bottom of the file via
 *   `Object.assign(exports, require("./messageReadState"));`. Both
 *   triggers deploy automatically with the rest of the function set.
 */

"use strict";

const {logger} = require("firebase-functions");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

const LIGHT_TRIGGER = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 80,
  maxInstances: 100,
};

// ── tsToMillis() ────────────────────────────────────────────────────
// Tolerant Firestore-Timestamp → epoch-millis converter. Handles
// Timestamp objects, raw numbers, ISO strings, and null/undefined.
function tsToMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") {
    try {
      return ts.toMillis();
    } catch (_e) { /* fallthrough */ }
  }
  if (typeof ts.seconds === "number") {
    return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1e6);
  }
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── onMessageCreatedReadCount ───────────────────────────────────────
// On each new message in a conversation, mark every non-sender
// participant's `countedUnread` flag true and (if it wasn't already
// true) bump their users/{uid}.unreadConversations by 1.
exports.onMessageCreatedReadCount = onDocumentCreated(
    {document: "conversations/{cid}/messages/{mid}", ...LIGHT_TRIGGER},
    async (event) => {
      try {
        const snap = event.data;
        if (!snap) return;
        const msg = snap.data() || {};
        const senderId = msg.senderId || msg.fromUid || null;
        const cid = event.params.cid;
        const db = admin.firestore();
        const FieldValue = admin.firestore.FieldValue;

        const convRef = db.collection("conversations").doc(cid);
        const convSnap = await convRef.get();
        if (!convSnap.exists) return;
        const conv = convSnap.data() || {};
        const participants = Array.isArray(conv.participants) ?
          conv.participants : [];

        const createdAtMs = tsToMillis(msg.createdAt) || Date.now();

        await Promise.all(participants.map(async (uid) => {
          if (!uid || uid === senderId) return;
          try {
            const psRef = convRef.collection("participantState").doc(uid);
            const psSnap = await psRef.get();
            const ps = psSnap.exists ? (psSnap.data() || {}) : {};
            const lastReadAtMs = tsToMillis(ps.lastReadAt);
            const alreadyCounted = ps.countedUnread === true;

            // If the conversation is already in the user's unread bucket,
            // a new message doesn't change the counter — we only count
            // DISTINCT unread conversations.
            if (alreadyCounted) return;

            // If for some reason the participant's lastReadAt is already
            // newer than this message's createdAt (clock skew, replayed
            // create), don't count.
            if (lastReadAtMs >= createdAtMs) return;

            // Mark counted-unread on the participantState doc + bump
            // the user's counter in one fan-out.
            await Promise.all([
              psRef.set({countedUnread: true}, {merge: true}),
              db.collection("users").doc(uid).set({
                unreadConversations: FieldValue.increment(1),
              }, {merge: true}),
            ]);
          } catch (e) {
            logger.warn("onMessageCreatedReadCount: participant fan-out failed", {
              cid, uid, error: e && e.message,
            });
          }
        }));
      } catch (err) {
        logger.error("onMessageCreatedReadCount error", err);
      }
    },
);

// ── onParticipantStateReadCount ─────────────────────────────────────
// When a participant advances lastReadAt past the conversation's
// lastMessageAt, mark countedUnread=false and recompute their
// unreadConversations counter (collectionGroup scan).
exports.onParticipantStateReadCount = onDocumentUpdated(
    {document: "conversations/{cid}/participantState/{uid}", ...LIGHT_TRIGGER},
    async (event) => {
      try {
        const before = event.data && event.data.before && event.data.before.data();
        const after = event.data && event.data.after && event.data.after.data();
        if (!after) return;
        const beforeLastReadMs = tsToMillis(before && before.lastReadAt);
        const afterLastReadMs = tsToMillis(after.lastReadAt);
        // Only act when the lastReadAt cursor actually moved forward.
        if (afterLastReadMs <= beforeLastReadMs) return;

        const cid = event.params.cid;
        const uid = event.params.uid;
        const db = admin.firestore();
        const FieldValue = admin.firestore.FieldValue;

        // Compare against conversation lastMessageAt — if the user
        // caught up past the last message, clear countedUnread and
        // recompute the global counter.
        const convSnap = await db.collection("conversations").doc(cid).get();
        if (!convSnap.exists) return;
        const conv = convSnap.data() || {};
        const lastMsgMs = tsToMillis(conv.lastMessageAt);

        // If we're still behind the last message, the conversation
        // remains unread — nothing to do.
        if (lastMsgMs > 0 && afterLastReadMs < lastMsgMs) {
          // Edge: client wrote a stale lastReadAt. countedUnread stays
          // true; on the next message create the counter won't
          // double-count thanks to the `alreadyCounted` guard above.
          return;
        }

        // Caught up — clear the flag for this conversation.
        if (after.countedUnread === true) {
          try {
            await event.data.after.ref.set(
                {countedUnread: false}, {merge: true},
            );
          } catch (e) {
            logger.warn("onParticipantStateReadCount: clear flag failed", {
              cid, uid, error: e && e.message,
            });
          }
        }

        // Recompute the counter: count participantState docs across all
        // conversations where countedUnread == true AND the doc
        // belongs to this uid. We use a collectionGroup query keyed on
        // the user's uid by walking through conversations they're in.
        //
        // Two strategies:
        //   1) collectionGroup("participantState") + where on countedUnread
        //      + filter doc id == uid client-side. Cheapest if the user
        //      is in many conversations.
        //   2) Walk users/{uid}'s conversation list (no such cache today).
        //
        // We pick (1) and require a single-field index on
        // participantState.countedUnread — added in firestore.indexes.json.
        let unreadCount = 0;
        try {
          const q = await db.collectionGroup("participantState")
              .where("countedUnread", "==", true)
              .get();
          // Filter to docs owned by this user (doc id == uid).
          for (const d of q.docs) {
            if (d.id === uid) unreadCount += 1;
          }
        } catch (e) {
          // If the collectionGroup query fails (index pending), do a
          // best-effort decrement on the user's counter — better to
          // under-count once than to leak a stuck badge.
          logger.warn("onParticipantStateReadCount: recompute query failed", {
            uid, error: e && e.message,
          });
          try {
            await db.collection("users").doc(uid).set({
              unreadConversations: FieldValue.increment(-1),
            }, {merge: true});
          } catch (_e) { /* swallow */ }
          return;
        }

        // Floor at 0 — set, not increment, so we converge even if the
        // increment-only path drifted positive at some point.
        try {
          await db.collection("users").doc(uid).set({
            unreadConversations: Math.max(0, unreadCount),
          }, {merge: true});
        } catch (e) {
          logger.warn("onParticipantStateReadCount: counter write failed", {
            uid, error: e && e.message,
          });
        }
      } catch (err) {
        logger.error("onParticipantStateReadCount error", err);
      }
    },
);
