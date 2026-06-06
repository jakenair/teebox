/**
 * functions/pushTriggers.js — Server-side push notification triggers.
 *
 * Required by functions/index.js with one line at the bottom:
 *     require("./pushTriggers");
 *
 * These triggers are ADDITIVE to the existing offer email triggers
 * (notifyOnOfferCreated / notifyOnOfferUpdated) in index.js and the
 * order email triggers in emailTriggers.js (onOrderCreatedEmail,
 * onOrderShippingStatusEmail, etc.). The legacy notifyOnOrderCreated /
 * notifyOnOrderUpdated triggers in index.js were removed on 2026-05-13
 * after the JSX path took over — see the deletion-marker comment in
 * index.js around the offer triggers for context.
 *
 * What's NEW here:
 *   - Respects users/{uid}.pushPrefs.<category>
 *   - Respects quiet hours
 *   - Rich payload (imageUrl, thread-id, time-sensitive, deep link)
 *   - Per-category APNs categories + Android channels
 *   - Saved-search daily batch (8am local)
 *   - Payout-released trigger (NEW — was email-only)
 *   - new-message push (`pushOnNewMessage`) — fires alongside the
 *     `notifyOnNewMessage` email trigger in index.js; respects per-user
 *     `pushPrefs.messages`, quiet hours, presence (skip if recipient
 *     is actively viewing the thread), and coalesces bursts.
 *
 * All triggers use sendPush() from lib/push.js — never call
 * admin.messaging() directly.
 */

const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {sendPush} = require("./lib/push");

// Shared sizing — duplicated lite copy because we don't pull from index.js
// (would create a require-cycle). Keep these in sync if index.js sizing
// changes.
const LIGHT_TRIGGER = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 80,
  maxInstances: 100,
};
const SCHEDULED_BATCH = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};

// Local helpers — DO NOT export. Cloud Functions only allows function exports.
async function _lookupListing(listingId) {
  if (!listingId) return {};
  try {
    const snap = await admin.firestore().collection("listings").doc(listingId).get();
    return snap.exists ? snap.data() : {};
  } catch (_e) {
    return {};
  }
}

async function _lookupUserName(uid) {
  if (!uid) return "Someone";
  try {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.exists) {
      const d = snap.data();
      return d.displayName || "Someone";
    }
  } catch (_e) {}
  return "Someone";
}

// Inline in-app notification writer — mirrors writeNotification() in
// index.js:3917. Duplicated here (not imported) to avoid a require-cycle
// with index.js, same reason LIGHT_TRIGGER is duplicated above. Writes to
// users/{uid}/notifications/* so the in-app center + badge see the event.
async function _writeNotif(uid, doc) {
  if (!uid) return;
  try {
    await admin.firestore().collection("users").doc(uid)
      .collection("notifications").add({
        ...doc,
        userId: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false,
      });
  } catch (e) {
    logger.error("_writeNotif failed", uid, e);
  }
}

// ─────────────────────────────────────────────────────────────
// pushOnOfferCreated — seller hears about a new offer.
//   Trigger: offers/{offerId} created
//   Recipient: listing seller
//   Category: offers
//   Urgent: YES if offer expires within 1h (otherwise normal)
// ─────────────────────────────────────────────────────────────
exports.pushOnOfferCreated = onDocumentCreated(
  {document: "offers/{offerId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const offer = event.data && event.data.data();
      if (!offer || !offer.sellerId) return;
      const offerId = event.params.offerId;
      const [listing, buyerName] = await Promise.all([
        _lookupListing(offer.listingId),
        _lookupUserName(offer.buyerId),
      ]);
      const listingTitle = listing.title || "your listing";
      const photo = (listing.photos && listing.photos[0]) || null;
      const amount = Number(offer.amount || 0);
      // 24h offer expiry is the standard; flag urgent if <1h remains.
      const expiresAt = offer.expiresAt && offer.expiresAt.toMillis
        ? offer.expiresAt.toMillis() : 0;
      const msUntilExpiry = expiresAt - Date.now();
      const urgent = expiresAt > 0 && msUntilExpiry > 0 && msUntilExpiry < 60 * 60 * 1000;

      await sendPush(offer.sellerId, {
        title: `New offer — $${amount.toLocaleString()} on ${listingTitle}`,
        body: `${buyerName} offered $${amount.toLocaleString()}. Expires in 24h.`,
        deepLink: `teebox://offer/${offerId}`,
        imageUrl: photo || "",
        kind: "offer-received",
        data: {
          offerId,
          listingId: offer.listingId || "",
          listingTitle,
          amount: String(amount),
          buyerName,
        },
      }, "offers", {
        urgent,
        threadId: `listing-${offer.listingId || offerId}`,
      });
    } catch (err) {
      logger.error("pushOnOfferCreated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// pushOnOfferUpdated — buyer hears about accept/decline/counter.
// ─────────────────────────────────────────────────────────────
exports.pushOnOfferUpdated = onDocumentUpdated(
  {document: "offers/{offerId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const before = event.data && event.data.before && event.data.before.data();
      const after = event.data && event.data.after && event.data.after.data();
      if (!before || !after) return;
      if (before.status === after.status) return;
      if (!["accepted", "declined", "countered"].includes(after.status)) return;
      const offerId = event.params.offerId;
      const [listing, sellerName] = await Promise.all([
        _lookupListing(after.listingId),
        _lookupUserName(after.sellerId),
      ]);
      const listingTitle = listing.title || "the listing";
      const photo = (listing.photos && listing.photos[0]) || null;
      const counter = Number(after.counterAmount || 0);
      const orig = Number(after.amount || 0);

      let title; let body;
      if (after.status === "accepted") {
        title = "Your offer was accepted";
        body = `${sellerName} accepted your $${orig.toLocaleString()} offer. Tap to pay.`;
      } else if (after.status === "declined") {
        title = "Your offer was declined";
        body = `${sellerName} passed on your $${orig.toLocaleString()} offer on ${listingTitle}.`;
      } else {
        title = `Seller countered at $${counter.toLocaleString()}`;
        body = `${sellerName} countered your offer on ${listingTitle}.`;
      }

      await sendPush(after.buyerId, {
        title, body,
        deepLink: `teebox://offer/${offerId}`,
        imageUrl: photo || "",
        kind: `offer-${after.status}`,
        data: {
          offerId,
          listingId: after.listingId || "",
          listingTitle,
          amount: String(orig),
          counterAmount: String(counter),
          sellerName,
        },
      }, "offers", {
        // Accepted offers are urgent — first-come-first-served. Decline isn't.
        urgent: after.status === "accepted",
        threadId: `listing-${after.listingId || offerId}`,
      });
    } catch (err) {
      logger.error("pushOnOfferUpdated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// pushOnOrderCreated — seller hears about a sale.
// ─────────────────────────────────────────────────────────────
exports.pushOnOrderCreated = onDocumentCreated(
  {document: "orders/{orderId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const order = event.data && event.data.data();
      // Relaxed guard (was `!order || !order.sellerId`) so the buyer side
      // still fires if sellerId were ever absent. Each party is guarded
      // individually below.
      if (!order) return;
      const orderId = event.params.orderId;
      // Parallelise listing + buyer-name lookup — the previous body was
      // "{listingTitle} — print your label…" with no buyer name, which
      // the notification audit (2026-05-17) flagged as a warning. Sellers
      // now see WHO bought their item, not just the price.
      const [listing, buyerDisplayName] = await Promise.all([
        _lookupListing(order.listingId),
        _lookupUserName(order.buyerId),
      ]);
      const listingTitle = listing.title || "your item";
      const photo = (listing.photos && listing.photos[0]) || null;
      const amount = Number(order.amount || 0);

      // ── Seller: in-app notification + "your item sold" push ──
      if (order.sellerId) {
        await _writeNotif(order.sellerId, {
          kind: "order-placed",
          orderId,
          listingId: order.listingId || "",
          listingTitle,
          amount,
          preview: `${buyerDisplayName || "Someone"} bought ` +
            `${listingTitle} for $${amount.toLocaleString()}.`,
        });
        await sendPush(order.sellerId, {
          title: `Your item sold for $${amount.toLocaleString()}`,
          body: `${buyerDisplayName || "Someone"} bought ${listingTitle}. ` +
            `Print your label and ship within 3 business days.`,
          deepLink: `teebox://order/${orderId}`,
          imageUrl: photo || "",
          kind: "order-placed",
          data: {
            orderId,
            listingId: order.listingId || "",
            listingTitle,
            amount: String(amount),
            buyerDisplayName: String(buyerDisplayName || ""),
          },
        }, "orders", {
          // Time-sensitive: sellers need to know fast so they ship on time.
          urgent: true,
          threadId: `order-${orderId}`,
        });
      }

      // ── Buyer: in-app "order confirmed" notification + push ──
      // Server-correct now. On iOS the push will NOT deliver until the
      // FirebaseMessaging APNs→FCM bridge ships (buyer has no usable FCM
      // token until then); web/Android deliver immediately. The in-app
      // notification always lands regardless of platform.
      if (order.buyerId) {
        await _writeNotif(order.buyerId, {
          kind: "order-confirmed",
          orderId,
          listingId: order.listingId || "",
          listingTitle,
          amount,
          preview: `Order confirmed — ${listingTitle} for ` +
            `$${amount.toLocaleString()}. We'll let you know when it ships.`,
        });
        await sendPush(order.buyerId, {
          title: "Order confirmed 🎉",
          body: `Your order for ${listingTitle} is confirmed. ` +
            `We'll notify you when it ships.`,
          deepLink: `teebox://order/${orderId}`,
          imageUrl: photo || "",
          kind: "order-confirmed",
          data: {
            orderId,
            listingId: order.listingId || "",
            listingTitle,
            amount: String(amount),
          },
        }, "orders", {
          threadId: `order-${orderId}`,
        });
      }
    } catch (err) {
      logger.error("pushOnOrderCreated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// pushOnOrderUpdated — handles shipped + delivered + funds released
//   transitions in one place to avoid trigger cycles.
// ─────────────────────────────────────────────────────────────
exports.pushOnOrderUpdated = onDocumentUpdated(
  {document: "orders/{orderId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const before = event.data && event.data.before && event.data.before.data();
      const after = event.data && event.data.after && event.data.after.data();
      if (!before || !after) return;
      const orderId = event.params.orderId;
      const listing = await _lookupListing(after.listingId);
      const listingTitle = listing.title || "your item";
      const photo = (listing.photos && listing.photos[0]) || null;

      // ── shipped ──
      if (before.fulfillmentStatus === "awaiting_seller_shipment"
          && after.fulfillmentStatus === "shipped") {
        const carrier = after.carrier || "Carrier";
        const tracking = after.trackingNumber || "";
        await sendPush(after.buyerId, {
          title: "Your order shipped",
          body: tracking
            ? `${carrier} · ${tracking}`
            : `${listingTitle} is on its way.`,
          deepLink: `teebox://order/${orderId}`,
          imageUrl: photo || "",
          kind: "order-shipped",
          data: {orderId, listingId: after.listingId || "", carrier, trackingNumber: tracking},
        }, "orders", {threadId: `order-${orderId}`});
      }

      // ── delivered (buyer + seller both notified) ──
      if (before.fulfillmentStatus === "shipped"
          && after.fulfillmentStatus === "delivered") {
        await sendPush(after.buyerId, {
          title: "Your order was delivered",
          body: "If anything's wrong, open a dispute within 7 days.",
          deepLink: `teebox://order/${orderId}`,
          imageUrl: photo || "",
          kind: "order-delivered-buyer",
          data: {orderId, listingId: after.listingId || ""},
        }, "orders", {urgent: true, threadId: `order-${orderId}`});

        await sendPush(after.sellerId, {
          title: "Buyer received your item",
          body: "Your payout will appear on Stripe's standard schedule.",
          deepLink: `teebox://order/${orderId}`,
          imageUrl: photo || "",
          kind: "order-delivered-seller",
          data: {orderId, listingId: after.listingId || ""},
        }, "orders", {threadId: `order-${orderId}`});
      }

      // ── funds released (payout) ──
      if (before.payoutStatus !== "released" && after.payoutStatus === "released") {
        const payoutDollars = ((after.sellerPayoutCents || 0) / 100).toFixed(2);
        await sendPush(after.sellerId, {
          title: `Your payout of $${payoutDollars} is on the way`,
          body: "Typically 2 business days via Stripe.",
          deepLink: `teebox://payouts`,
          kind: "payout-released",
          data: {orderId, amount: payoutDollars},
        }, "orders", {threadId: `payout-${orderId}`});
      }
    } catch (err) {
      logger.error("pushOnOrderUpdated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// pushOnPayoutReleased — explicit trigger if payouts live in a
//   separate `payouts/{payoutId}` collection. Many setups write
//   payout docs there in addition to flipping orders.payoutStatus.
//   Idempotent with pushOnOrderUpdated since the order trigger
//   only fires on the in-place flip.
// ─────────────────────────────────────────────────────────────
exports.pushOnPayoutReleased = onDocumentCreated(
  {document: "payouts/{payoutId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const p = event.data && event.data.data();
      if (!p || !p.sellerId || p.status !== "released") return;
      const dollars = ((p.amountCents || 0) / 100).toFixed(2);
      await sendPush(p.sellerId, {
        title: `Your payout of $${dollars} is on the way`,
        body: "Typically 2 business days via Stripe.",
        deepLink: `teebox://payouts`,
        kind: "payout-released",
        data: {payoutId: event.params.payoutId, amount: dollars},
      }, "orders", {threadId: `payout-${event.params.payoutId}`});
    } catch (err) {
      logger.error("pushOnPayoutReleased error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// pushSavedSearchDailyDigest — runs every hour and dispatches
//   batched saved-search matches to users whose local time is 8am.
//
// Why hourly instead of daily? Because users span many timezones —
// running daily at one UTC hour would deliver in the middle of the night
// to half the planet. We bucket by user.pushPrefs.quietHours.tz.
//
// Source of truth: users/{uid}/savedSearchMatchQueue/{matchId} —
// a queue subcollection written by notifyOnSavedSearchMatch in index.js
// when batching is enabled. (If your existing notifyOnSavedSearchMatch
// fires immediately, swap that to queue mode — see TODO.)
// ─────────────────────────────────────────────────────────────
exports.pushSavedSearchDailyDigest = onSchedule(
  {schedule: "every 60 minutes", ...SCHEDULED_BATCH},
  async () => {
    const db = admin.firestore();
    try {
      // Find users whose local hour right now is 8.
      const users = await db.collection("users")
        .where("pushPrefs.savedSearches", "==", true)
        .get();

      let dispatched = 0;
      for (const u of users.docs) {
        const tz = (u.get("pushPrefs.quietHours.tz") || "America/New_York");
        const hour = _localHour(tz);
        if (hour !== 8) continue;

        // Pull queued matches from the last 24h.
        const queueSnap = await db.collection("users").doc(u.id)
          .collection("savedSearchMatchQueue")
          .where("processed", "==", false).limit(50).get();
        if (queueSnap.empty) continue;

        // Group by saved-search id so we can say "3 new for [name]".
        const bySearch = new Map();
        queueSnap.forEach((d) => {
          const m = d.data();
          if (!bySearch.has(m.searchId)) {
            bySearch.set(m.searchId, {name: m.searchName, count: 0, listingIds: []});
          }
          const v = bySearch.get(m.searchId);
          v.count += 1;
          if (m.listingId) v.listingIds.push(m.listingId);
        });

        for (const [savedId, v] of bySearch) {
          await sendPush(u.id, {
            title: `${v.count} new listing${v.count === 1 ? "" : "s"} match ${v.name || "your search"}`,
            body: "Tap to view your matches.",
            deepLink: `teebox://search/${savedId}`,
            kind: "saved-search-match",
            data: {savedSearchId: savedId, count: String(v.count)},
          }, "savedSearches", {threadId: `search-${savedId}`});
          dispatched += 1;
        }

        // Mark the queue entries processed.
        const batch = db.batch();
        queueSnap.forEach((d) => batch.update(d.ref, {processed: true, processedAt: admin.firestore.FieldValue.serverTimestamp()}));
        await batch.commit();
      }
      logger.info(`pushSavedSearchDailyDigest: dispatched ${dispatched}`);
    } catch (err) {
      logger.error("pushSavedSearchDailyDigest error", err);
    }
  }
);

function _localHour(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour12: false, hour: "2-digit", timeZone: tz,
    }).formatToParts(new Date());
    return Number(parts.find((p) => p.type === "hour").value);
  } catch (_e) {
    return -1;
  }
}

// ─────────────────────────────────────────────────────────────
// pushOnNewMessage — recipient hears about a new chat message.
//
//   Trigger: conversations/{cid}/messages/{messageId} created
//   This runs IN ADDITION TO moderateMessage in index.js — both fire
//   on the same path; that's intentional and supported.
//
// Payload shape (matches the C6 launch-readiness item):
//   data.kind = "new-message"
//   data.conversationId, data.messageId, data.senderId
//
// Skips:
//   - message.held === true (rate-limited or spam-pending; the
//     hold-release flow fires its own push later).
//   - recipient is currently looking at the thread (presence doc
//     with lastHeartbeatAt within PRESENCE_WINDOW_MS).
//   - recipient has pushPrefs.messages === false (handled inside
//     sendPush() in lib/push.js — single source of truth for prefs).
//
// Sanitization:
//   - HARD-flagged content gets a "You have a new message" preview
//     (no body text) because the recipient sees an interstitial in
//     the UI and we don't want to leak the raw content to the lock
//     screen / notification center.
//   - Image-only messages render as "[Photo]" per the audit spec
//     (C6: first 120 chars of text, "[Photo]" if image-only).
//   - NOTE: as of writing, `flagged` is patched by moderateMessage
//     in a separate trigger invocation. There is a race: pushOnNewMessage
//     may run before moderateMessage finishes the flag patch. The
//     sanitization is a defense-in-depth signal; the primary protection
//     is the in-app interstitial gating on the rendered message.
//
// Coalescing:
//   - Same sender → same recipient → same conversation within
//     COALESCE_WINDOW_MS collapses into one notification ("N new
//     messages from Jake"). Bookkeeping lives in pushPending/{key}.
//   - Outside the window, the doc is replaced and a fresh count=1
//     push fires.
//
// Stale-token cleanup is handled by sendPush() in lib/push.js —
// any FCM response with messaging/registration-token-not-registered
// triggers a batch delete of the offending tokens.
// ─────────────────────────────────────────────────────────────
const COALESCE_WINDOW_MS = 60 * 1000;
const PRESENCE_WINDOW_MS = 30 * 1000;
const NAME_CACHE_MS = 5 * 60 * 1000;
const _msgNameCache = new Map(); // uid → { name, expiresAt }

async function _lookupSenderName(uid) {
  if (!uid) return "Someone";
  const cached = _msgNameCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  let name = "Someone";
  try {
    const db = admin.firestore();
    // profiles/{uid} is the public-facing display name source; fall back
    // to users/{uid}.displayName for accounts that never set a profile.
    const pSnap = await db.collection("profiles").doc(uid).get();
    if (pSnap.exists) {
      const p = pSnap.data() || {};
      name = p.displayName || p.name || "";
    }
    if (!name) {
      const uSnap = await db.collection("users").doc(uid).get();
      if (uSnap.exists) {
        const u = uSnap.data() || {};
        name = u.displayName || u.name || "";
      }
    }
  } catch (_e) {}
  name = name || "Someone";
  _msgNameCache.set(uid, {name, expiresAt: Date.now() + NAME_CACHE_MS});
  return name;
}

// Per the C4 audit spec: title = "New message from {senderDisplayName}";
// body = first 120 chars of message.text (or "[Photo]" if image-only).
const MESSAGE_BODY_PREVIEW_CHARS = 120;

exports.pushOnNewMessage = onDocumentCreated(
  {document: "conversations/{cid}/messages/{messageId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const msg = event.data && event.data.data();
      if (!msg) return;
      const cid = event.params.cid;
      const messageId = event.params.messageId;
      const senderId = msg.senderId || msg.fromUid || null;
      const text = msg.text || "";
      const hasImage = !!(msg.imageUrl || msg.image ||
        (Array.isArray(msg.images) && msg.images.length));
      const isImageOnly = !text && hasImage;
      if (!senderId) return;

      // 1. Skip held messages — hold-release re-fires the trigger.
      if (msg.held === true) {
        logger.info(`pushOnNewMessage: ${messageId} held; skipping push`);
        return;
      }

      // 2. Sanitize HARD-flagged content. (Note: moderateMessage may not
      // have patched .flagged yet — best-effort signal.)
      const isHardFlagged = msg.flagged && msg.flagged.severity === "HARD";

      const db = admin.firestore();

      // 3. Resolve recipient from the parent conversation doc.
      let recipientId = null;
      let listingId = msg.listingId || null;
      let listingTitle = "";
      try {
        const convSnap = await db.collection("conversations").doc(cid).get();
        if (!convSnap.exists) return;
        const conv = convSnap.data() || {};
        listingId = listingId || conv.listingId || null;
        listingTitle = conv.listingTitle || "";
        const parts = Array.isArray(conv.participants) ? conv.participants : [];
        recipientId = parts.find((u) => u && u !== senderId) || null;
      } catch (e) {
        logger.warn("pushOnNewMessage: conv lookup failed", e);
        return;
      }
      if (!recipientId) return;

      // 4. Skip if recipient is currently viewing this exact thread.
      try {
        const presSnap = await db.collection("presence").doc(recipientId).get();
        if (presSnap.exists) {
          const pres = presSnap.data() || {};
          const last = pres.lastHeartbeatAt && pres.lastHeartbeatAt.toMillis
            ? pres.lastHeartbeatAt.toMillis() : 0;
          if (pres.currentlyViewingConversation === cid &&
              last > 0 &&
              (Date.now() - last) < PRESENCE_WINDOW_MS) {
            logger.info(
                `pushOnNewMessage: recipient ${recipientId} viewing ${cid}; skipping push`
            );
            return;
          }
        }
      } catch (e) {
        // Presence is best-effort; on failure, we send the push.
        logger.warn("pushOnNewMessage: presence lookup failed", e);
      }

      // 5. Coalescing — pushPending/{recipientId}_{senderId}_{cid}.
      // Atomicity here is loose by design: at most one extra push under
      // a race is acceptable, and the trade-off is no transaction cost.
      const FieldValue = admin.firestore.FieldValue;
      const pendingId = `${recipientId}_${senderId}_${cid}`;
      const pendingRef = db.collection("pushPending").doc(pendingId);
      let count = 1;
      let messageIds = [messageId];
      try {
        const pendingSnap = await pendingRef.get();
        if (pendingSnap.exists) {
          const p = pendingSnap.data() || {};
          const lastAtMs = p.lastAt && p.lastAt.toMillis ? p.lastAt.toMillis() : 0;
          if (lastAtMs > 0 && (Date.now() - lastAtMs) < COALESCE_WINDOW_MS) {
            // Within window — coalesce. Append messageId, increment count.
            const prevIds = Array.isArray(p.messageIds) ? p.messageIds : [];
            messageIds = prevIds.concat([messageId]).slice(-20);
            count = (Number(p.count) || prevIds.length || 0) + 1;
            await pendingRef.set({
              recipientId, senderId, conversationId: cid,
              messageIds, count,
              firstAt: p.firstAt || FieldValue.serverTimestamp(),
              lastAt: FieldValue.serverTimestamp(),
            }, {merge: true});
          } else {
            // Stale doc — replace with a fresh window.
            await pendingRef.set({
              recipientId, senderId, conversationId: cid,
              messageIds: [messageId], count: 1,
              firstAt: FieldValue.serverTimestamp(),
              lastAt: FieldValue.serverTimestamp(),
            });
          }
        } else {
          await pendingRef.set({
            recipientId, senderId, conversationId: cid,
            messageIds: [messageId], count: 1,
            firstAt: FieldValue.serverTimestamp(),
            lastAt: FieldValue.serverTimestamp(),
          });
        }
      } catch (e) {
        // Bookkeeping failed — proceed with count=1; the push is more
        // important than perfect coalescing.
        logger.warn("pushOnNewMessage: pushPending write failed", e);
      }

      // 6. Sender display name (cached 5min) + optional listing context.
      const senderName = await _lookupSenderName(senderId);
      if (!listingTitle && listingId) {
        const listing = await _lookupListing(listingId);
        listingTitle = listing.title || "";
      }
      const trimmedTitle = listingTitle ? String(listingTitle).slice(0, 30) : "";

      // 7. Build payload. Per C4 spec:
      //    title = "New message from {senderDisplayName}"
      //    body  = first 120 chars of message.text (or "[Photo]" if image-only)
      let title = `New message from ${senderName}`;
      let body;
      if (isHardFlagged) {
        body = "You have a new message";
      } else if (count > 1) {
        body = `${count} new messages`;
      } else if (isImageOnly) {
        body = "[Photo]";
      } else {
        body = text.length > MESSAGE_BODY_PREVIEW_CHARS
          ? text.slice(0, MESSAGE_BODY_PREVIEW_CHARS) + "…"
          : text;
      }
      const subtitle = trimmedTitle ? `Re: ${trimmedTitle}` : "";

      // 8. Dispatch. sendPush() handles pushPrefs.messages + quiet hours
      // (returns {skipped: "category-off:messages"} silently if the
      // recipient has disabled the messages category — that's the audit-
      // mandated `notificationPrefs.pushMessages !== false` gate).
      // Stale-token pruning also happens inside sendPush().
      // Messages are NOT urgent — they respect quiet hours.
      await sendPush(recipientId, {
        title,
        body,
        subtitle,
        deepLink: `teebox://conversation/${cid}`,
        kind: "new-message",
        data: {
          kind: "new-message",
          conversationId: cid,
          messageId,
          senderId,
          senderName,
          coalesceCount: String(count),
        },
      }, "messages", {
        threadId: cid,
      });
    } catch (err) {
      logger.error("pushOnNewMessage error", err);
    }
  }
);
