const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe");

admin.initializeApp();

const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const webhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

const PLATFORM_FEE_PERCENT = 0.065;
const PENDING_WINDOW_MS = 15 * 60 * 1000;
const ALLOWED_ORIGINS = [
  "https://teeboxmarket.com",
  "https://www.teeboxmarket.com",
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getAuthedUser(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const idToken = authHeader.substring(7);
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    logger.warn("Invalid ID token:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// createPaymentIntent
//   - Buyer must be authenticated (Firebase ID token)
//   - Price is pulled from Firestore, never trusted from client
//   - Listing is atomically reserved before the PI is created
// ─────────────────────────────────────────────────────────────
exports.createPaymentIntent = onRequest(
  {secrets: [stripeSecret], cors: ALLOWED_ORIGINS},
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({error: "Method not allowed"});
    }

    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return res.status(401).json({error: "Not authenticated"});
    }
    const buyerId = authUser.uid;

    const {listingId} = req.body || {};
    if (!listingId || typeof listingId !== "string" || listingId.length > 128) {
      return res.status(400).json({error: "Missing or invalid listingId"});
    }

    const db = admin.firestore();
    const listingRef = db.collection("listings").doc(listingId);

    try {
      const reservation = await db.runTransaction(async (tx) => {
        const snap = await tx.get(listingRef);
        if (!snap.exists) {
          throw new HttpError(404, "Listing not found");
        }
        const listing = snap.data();

        if (listing.sellerId === buyerId) {
          throw new HttpError(400, "You cannot buy your own listing");
        }

        const now = Date.now();
        const pendingUntilMs = listing.pendingUntil?.toMillis?.() ?? 0;
        const effectiveStatus = listing.status || "active";
        const isActive = effectiveStatus === "active";
        const isExpiredPending =
          effectiveStatus === "pending" && pendingUntilMs < now;
        const isSameBuyerRetry =
          effectiveStatus === "pending" && listing.pendingBuyer === buyerId;

        if (!isActive && !isExpiredPending && !isSameBuyerRetry) {
          throw new HttpError(
            409,
            `Listing is not available (status: ${effectiveStatus})`
          );
        }

        const priceCents = Math.round(Number(listing.ask) * 100);
        if (!Number.isFinite(priceCents) || priceCents <= 0) {
          throw new HttpError(500, "Listing has invalid price");
        }

        tx.update(listingRef, {
          status: "pending",
          pendingBuyer: buyerId,
          pendingUntil: admin.firestore.Timestamp.fromMillis(
            now + PENDING_WINDOW_MS
          ),
        });

        return {
          priceCents,
          sellerId: listing.sellerId,
          title: listing.title || "Listing",
        };
      });

      const platformFeeCents = Math.round(
        reservation.priceCents * PLATFORM_FEE_PERCENT
      );
      const sellerPayoutCents = reservation.priceCents - platformFeeCents;

      const stripeClient = stripe(stripeSecret.value());

      // Truncate description to Stripe's 1000-char limit, defensively.
      const description = `teebox — ${reservation.title}`.slice(0, 200);

      // Idempotency: same buyer + listing + 5-minute bucket → same PI.
      // Stops a duplicate-charge race if the client retries Pay Now.
      const idempotencyKey = `pi_${listingId}_${buyerId}_${Math.floor(
        Date.now() / (5 * 60 * 1000)
      )}`;

      const paymentIntent = await stripeClient.paymentIntents.create(
        {
          amount: reservation.priceCents,
          currency: "usd",
          automatic_payment_methods: {enabled: true},
          // Explicit policy. 'automatic' = Stripe Radar decides per
          // transaction. Switch to 'any' for marketplace-wide 3DS
          // enforcement once Radar tells us false-positives are low.
          payment_method_options: {
            card: {request_three_d_secure: "automatic"},
          },
          description,
          // Up to 22 chars, what the buyer sees on their card statement.
          statement_descriptor_suffix: "TEEBOX",
          metadata: {
            listingId,
            buyerId,
            sellerId: reservation.sellerId || "",
            platformFeeCents: String(platformFeeCents),
            sellerPayoutCents: String(sellerPayoutCents),
          },
        },
        {idempotencyKey}
      );

      await listingRef.update({pendingPaymentIntentId: paymentIntent.id});

      return res.json({
        clientSecret: paymentIntent.client_secret,
        amountCents: reservation.priceCents,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({error: err.message});
      }
      logger.error("createPaymentIntent error", err);
      return res.status(500).json({error: "Internal error"});
    }
  }
);

// ─────────────────────────────────────────────────────────────
// stripeWebhook
//   - Idempotent order creation (doc id = payment intent id)
//   - Handles success, failure, and cancellation
// ─────────────────────────────────────────────────────────────
exports.stripeWebhook = onRequest(
  {secrets: [stripeSecret, webhookSecret]},
  async (req, res) => {
    const stripeClient = stripe(stripeSecret.value());
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripeClient.webhooks.constructEvent(
        req.rawBody,
        sig,
        webhookSecret.value()
      );
    } catch (err) {
      logger.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await handlePaymentSucceeded(event.data.object);
          break;
        case "payment_intent.payment_failed":
        case "payment_intent.canceled":
          await releaseListingOnFailure(event.data.object);
          break;
        default:
          logger.info(`Unhandled event type: ${event.type}`);
      }
      return res.json({received: true});
    } catch (err) {
      logger.error(`Error handling ${event.type}:`, err);
      return res.status(500).send("Error processing webhook");
    }
  }
);

async function handlePaymentSucceeded(pi) {
  const db = admin.firestore();
  const {
    listingId,
    buyerId,
    sellerId,
    platformFeeCents,
    sellerPayoutCents,
  } = pi.metadata || {};

  const orderRef = db.collection("orders").doc(pi.id);
  const listingRef = listingId
    ? db.collection("listings").doc(listingId)
    : null;

  await db.runTransaction(async (tx) => {
    const [existingOrder, listingSnap] = await Promise.all([
      tx.get(orderRef),
      listingRef ? tx.get(listingRef) : Promise.resolve(null),
    ]);

    if (existingOrder.exists) {
      logger.info(`Order ${pi.id} already processed, skipping`);
      return;
    }

    tx.set(orderRef, {
      paymentIntentId: pi.id,
      listingId: listingId || null,
      buyerId: buyerId || null,
      sellerId: sellerId || null,
      amountCents: pi.amount,
      amount: pi.amount / 100,
      currency: pi.currency,
      platformFeeCents: Number(platformFeeCents) || 0,
      sellerPayoutCents: Number(sellerPayoutCents) || 0,
      status: "paid",
      fulfillmentStatus: "awaiting_seller_shipment",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (listingSnap && listingSnap.exists) {
      tx.update(listingRef, {
        status: "sold",
        soldAt: admin.firestore.FieldValue.serverTimestamp(),
        soldTo: buyerId || null,
        orderId: pi.id,
        pendingBuyer: admin.firestore.FieldValue.delete(),
        pendingUntil: admin.firestore.FieldValue.delete(),
        pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      });
    } else if (listingId) {
      logger.warn(`Listing ${listingId} not found for order ${pi.id}`);
    }
  });

  // After the order/listing transaction commits, append the sale to
  // the public priceHistory document for this model so the detail
  // sparkline can render. Best-effort, non-fatal.
  try {
    if (listingRef) {
      const lsnap = await listingRef.get();
      if (lsnap.exists) {
        const ld = lsnap.data();
        const model = `${ld.brand || ""} ${ld.title || ""}`.trim();
        if (model) {
          const slug = model
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 80);
          const histRef = db.collection("priceHistory").doc(slug);
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(histRef);
            const sales = (snap.exists ? snap.data().sales || [] : []).slice(-119);
            sales.push({t: Date.now(), priceCents: pi.amount});
            tx.set(
              histRef,
              {model, sales, updatedAt: admin.firestore.FieldValue.serverTimestamp()},
              {merge: true}
            );
          });
        }
      }
    }
  } catch (err) {
    logger.warn("priceHistory rollup failed:", err.message);
  }

  logger.info(`Order ${pi.id} recorded for listing ${listingId}`);
}

async function releaseListingOnFailure(pi) {
  const db = admin.firestore();
  const {listingId} = pi.metadata || {};
  if (!listingId) return;

  const listingRef = db.collection("listings").doc(listingId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(listingRef);
    if (!snap.exists) return;
    const listing = snap.data();

    if (
      listing.status === "pending" &&
      listing.pendingPaymentIntentId === pi.id
    ) {
      tx.update(listingRef, {
        status: "active",
        pendingBuyer: admin.firestore.FieldValue.delete(),
        pendingUntil: admin.firestore.FieldValue.delete(),
        pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      });
      logger.info(`Released listing ${listingId} after PI ${pi.id} failed`);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// expireListings (scheduled, daily 03:00 America/Chicago)
//   Flips active listings whose expiresAt < now to status='expired'.
//   Sellers can renew from their dashboard.
// ─────────────────────────────────────────────────────────────
exports.expireListings = onSchedule(
  {schedule: "every day 03:00", timeZone: "America/Chicago"},
  async () => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const snap = await db
      .collection("listings")
      .where("status", "==", "active")
      .where("expiresAt", "<", now)
      .limit(500)
      .get();
    if (snap.empty) {
      logger.info("expireListings: nothing to expire");
      return;
    }
    const batch = db.batch();
    snap.docs.forEach((d) => {
      batch.update(d.ref, {
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    logger.info(`expireListings: flipped ${snap.size} listing(s) to expired`);
  }
);

// ─────────────────────────────────────────────────────────────
// moderateImage (callable, STUB)
//   Wraps Google Cloud Vision SafeSearch. Returns {safe: true|false}
//   so the client can refuse to attach a flagged image.
//
// To activate:
//   1. gcloud services enable vision.googleapis.com --project teebox-market
//   2. cd functions && npm install @google-cloud/vision
//   3. Uncomment the import + the body below.
//   4. Redeploy.
// ─────────────────────────────────────────────────────────────
exports.moderateImage = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  // const { ImageAnnotatorClient } = require("@google-cloud/vision");
  // const client = new ImageAnnotatorClient();
  // const url = request.data && request.data.url;
  // if (!url || typeof url !== "string") {
  //   throw new HttpsError("invalid-argument", "url required");
  // }
  // const [result] = await client.safeSearchDetection(url);
  // const ss = result.safeSearchAnnotation || {};
  // const bad = ["LIKELY", "VERY_LIKELY"];
  // const safe = !(bad.includes(ss.adult) || bad.includes(ss.violence) ||
  //                bad.includes(ss.racy)  || bad.includes(ss.medical));
  // return { safe, signals: ss };
  return {safe: true, stub: true};
});

// ─────────────────────────────────────────────────────────────
// notifyOnNewMessage (Firestore trigger, STUB)
//   Sends a transactional email to the recipient on every new
//   /conversations/{cid}/messages/{mid} create.
//
// To activate:
//   1. Sign up for Resend (https://resend.com), grab an API key.
//   2. firebase functions:secrets:set RESEND_API_KEY  (paste key)
//   3. cd functions && npm install resend
//   4. Uncomment the import + body and add `secrets: [RESEND_KEY]`
//      to the export options.
//   5. Redeploy.
// ─────────────────────────────────────────────────────────────
// const {onDocumentCreated} = require("firebase-functions/v2/firestore");
// const RESEND_KEY = defineSecret("RESEND_API_KEY");
//
// exports.notifyOnNewMessage = onDocumentCreated(
//   { document: "conversations/{cid}/messages/{mid}", secrets: [RESEND_KEY] },
//   async (event) => {
//     const msg = event.data.data();
//     const conv = (await admin.firestore()
//       .doc(`conversations/${event.params.cid}`).get()).data();
//     const recipientUid = conv.participants.find(p => p !== msg.senderId);
//     if (!recipientUid) return;
//     const recipient = await admin.auth().getUser(recipientUid);
//     if (!recipient.email) return;  // phone-only accounts have no email
//     const { Resend } = require("resend");
//     const resend = new Resend(RESEND_KEY.value());
//     await resend.emails.send({
//       from: "TeeBox <noreply@teeboxmarket.com>",
//       to: recipient.email,
//       subject: "New message about " + (conv.listingTitle || "your listing"),
//       text: msg.text.slice(0, 500) + "\n\nReply at https://teeboxmarket.com",
//     });
//   }
// );

// ─────────────────────────────────────────────────────────────
// requestSellerVerification (callable)
//   Client can't set sellerVerified=true on its own user doc
//   (Firestore rules block the field). This function is the only
//   way the flag gets flipped. Right now the gate is "agreed to
//   the terms of service"; swap the placeholder logic for real
//   KYC (ID check, bank-account verification) when ready.
// ─────────────────────────────────────────────────────────────
exports.requestSellerVerification = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const phone = request.auth.token.phone_number || null;
  const data = request.data || {};

  if (data.termsAgreed !== true) {
    throw new HttpsError(
      "failed-precondition",
      "You must agree to the Seller Terms of Service"
    );
  }

  const db = admin.firestore();
  await db.doc(`users/${uid}`).set(
    {
      phone,
      sellerVerified: true,
      sellerVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      termsAgreed: true,
      termsAgreedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true}
  );

  return {verified: true};
});

// ─────────────────────────────────────────────────────────────
// deleteUserAccount (callable)
//   Apple guideline 5.1.1(vi) — apps that allow account creation
//   must offer an in-app account-deletion path. This function:
//     1. Marks the seller's listings as removed (preserves
//        order/dispute history for the other party)
//     2. Anonymizes the public profile and private user doc
//     3. Deletes the Firebase Auth record so the phone number is
//        freed and the user is signed out everywhere
//   Uses the admin SDK so it bypasses Firestore rules and works
//   without a recent re-authentication on the client.
// ─────────────────────────────────────────────────────────────
exports.deleteUserAccount = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const listingsSnap = await db.collection("listings")
    .where("sellerId", "==", uid)
    .get();
  if (!listingsSnap.empty) {
    const batch = db.batch();
    listingsSnap.forEach((doc) => {
      batch.update(doc.ref, {
        status: "removed",
        removedAt: now,
        removedReason: "seller_account_deleted",
      });
    });
    await batch.commit();
  }

  await db.doc(`profiles/${uid}`).set({
    displayName: "Deleted user",
    bio: "",
    location: "",
    handicap: null,
    avatarUrl: null,
    deleted: true,
    deletedAt: now,
  }, {merge: true});

  await db.doc(`users/${uid}`).set({
    phone: null,
    displayName: "Deleted user",
    deleted: true,
    deletedAt: now,
    sellerVerified: false,
  }, {merge: true});

  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    logger.warn(`Auth delete failed for ${uid}: ${err.message}`);
    throw new HttpsError("internal", "Could not finalize account deletion");
  }

  logger.info(`User account ${uid} deleted at user request`);
  return {deleted: true};
});

// ─────────────────────────────────────────────────────────────
// exchangeIdTokenForCustomToken
//   Bridges native iOS Firebase auth (via @capacitor-firebase/authentication
//   plugin) to the Web SDK auth state used by Firestore/Storage on the same
//   page. The native plugin signs in via APNs silent push (no reCAPTCHA),
//   then the client sends us its native ID token; we mint a custom token
//   for the same UID, and the client signs the Web SDK in with that.
// ─────────────────────────────────────────────────────────────
exports.exchangeIdTokenForCustomToken = onCall(async (request) => {
  const idToken = request.data && request.data.idToken;
  if (!idToken) {
    throw new HttpsError("invalid-argument", "idToken required");
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    logger.warn(`Token exchange — bad idToken: ${err.message}`);
    throw new HttpsError("unauthenticated", "Invalid ID token");
  }
  const additionalClaims = {};
  if (decoded.phone_number) additionalClaims.phone_number = decoded.phone_number;
  const customToken = await admin.auth().createCustomToken(decoded.uid, additionalClaims);
  return {customToken};
});

// ─────────────────────────────────────────────────────────────
// onReviewCreated (Firestore trigger)
//   When a buyer leaves a review at reviews/{orderId}, recompute
//   seller aggregates (count, avg rating, 5-star %) on the
//   seller's public profile so listing/profile cards can render
//   them without an N+1 read.
// ─────────────────────────────────────────────────────────────
exports.onReviewCreated = onDocumentCreated(
  "reviews/{orderId}",
  async (event) => {
    try {
      const review = event.data && event.data.data();
      if (!review) {
        logger.warn("onReviewCreated: empty review payload");
        return;
      }
      const sellerId = review.sellerId;
      if (!sellerId) {
        logger.warn(
          `onReviewCreated: review ${event.params.orderId} has no sellerId`
        );
        return;
      }

      const db = admin.firestore();
      const snap = await db
        .collection("reviews")
        .where("sellerId", "==", sellerId)
        .get();

      let total = 0;
      let fiveStars = 0;
      const reviewCount = snap.size;
      snap.forEach((d) => {
        const r = d.data();
        const rating = Number(r.rating) || 0;
        total += rating;
        if (rating >= 5) fiveStars += 1;
      });

      const avgRating = reviewCount > 0
        ? Math.round((total / reviewCount) * 10) / 10
        : 0;
      const fiveStarPct = reviewCount > 0
        ? Math.round((fiveStars / reviewCount) * 100)
        : 0;

      await db.doc(`profiles/${sellerId}`).set(
        {
          reviewCount,
          avgRating,
          fiveStarPct,
          // Wired later once we track seller message-response timing.
          responseRate: null,
          lastReviewAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true}
      );

      logger.info(
        `onReviewCreated: profile ${sellerId} -> ${reviewCount} reviews, ` +
          `avg ${avgRating}, 5-star ${fiveStarPct}%`
      );
    } catch (err) {
      logger.error("onReviewCreated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// incrementListingView (callable)
//   Bumps listings/{listingId}.views, throttled to one count per
//   user per listing per 24h via a marker doc in listingViews.
//   Returns the fresh view count so the caller can render it.
// ─────────────────────────────────────────────────────────────
exports.incrementListingView = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const data = request.data || {};
  const listingId = data.listingId;
  if (!listingId || typeof listingId !== "string" || listingId.length > 128) {
    throw new HttpsError("invalid-argument", "listingId required");
  }

  const db = admin.firestore();
  const listingRef = db.collection("listings").doc(listingId);
  const markerRef = db.collection("listingViews").doc(`${listingId}_${uid}`);
  const now = Date.now();
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  try {
    const markerSnap = await markerRef.get();
    const lastViewedMs = markerSnap.exists
      ? markerSnap.data().lastViewedAt?.toMillis?.() ?? 0
      : 0;
    const withinWindow = now - lastViewedMs < TWENTY_FOUR_HOURS_MS;

    if (!withinWindow) {
      await listingRef.update({
        views: admin.firestore.FieldValue.increment(1),
      });
      await markerRef.set(
        {
          listingId,
          uid,
          lastViewedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
    }

    const fresh = await listingRef.get();
    const views = fresh.exists ? Number(fresh.data().views) || 0 : 0;
    return {views};
  } catch (err) {
    logger.error("incrementListingView error", err);
    throw new HttpsError("internal", "Could not record listing view");
  }
});

// ─────────────────────────────────────────────────────────────
// incrementListingMessage (Firestore trigger)
//   Counts inbound buyer interest. Bumps
//   listings/{listingId}.messageCount when a non-seller posts a
//   new message in a conversation tied to a listing.
// ─────────────────────────────────────────────────────────────
exports.incrementListingMessage = onDocumentCreated(
  "messages/{messageId}",
  async (event) => {
    try {
      const msg = event.data && event.data.data();
      if (!msg) return;

      const db = admin.firestore();
      let listingId = msg.listingId || null;
      let sellerId = msg.sellerId || null;

      // Fall back to the parent conversation doc if the message
      // doesn't carry the listingId/sellerId itself.
      const conversationId = msg.conversationId;
      if ((!listingId || !sellerId) && conversationId) {
        const convSnap = await db
          .collection("conversations")
          .doc(conversationId)
          .get();
        if (convSnap.exists) {
          const conv = convSnap.data();
          listingId = listingId || conv.listingId || null;
          sellerId = sellerId || conv.sellerId || null;
        }
      }

      if (!listingId) {
        logger.info(
          `incrementListingMessage: ${event.params.messageId} has no listingId, skipping`
        );
        return;
      }

      const senderId = msg.senderId || msg.fromUid || null;
      if (sellerId && senderId && senderId === sellerId) {
        // Seller's own outbound message; not a fresh inbound interest signal.
        return;
      }

      await db.collection("listings").doc(listingId).update({
        messageCount: admin.firestore.FieldValue.increment(1),
      });
    } catch (err) {
      logger.error("incrementListingMessage error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// aggregateSellerStats (Firestore trigger)
//   When an order transitions to fulfillmentStatus='delivered',
//   roll up sales count + revenue onto the seller's profile.
//   Idempotent on the before/after diff so re-writes don't
//   double-count.
// ─────────────────────────────────────────────────────────────
exports.aggregateSellerStats = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    try {
      const before = event.data && event.data.before && event.data.before.data();
      const after = event.data && event.data.after && event.data.after.data();
      if (!before || !after) return;

      const wasDelivered = before.fulfillmentStatus === "delivered";
      const isDelivered = after.fulfillmentStatus === "delivered";
      if (wasDelivered || !isDelivered) return;

      const sellerId = after.sellerId;
      if (!sellerId) {
        logger.warn(
          `aggregateSellerStats: order ${event.params.orderId} has no sellerId`
        );
        return;
      }

      const amount = Number(after.amount) || 0;
      const db = admin.firestore();
      await db.doc(`profiles/${sellerId}`).set(
        {
          salesCount: admin.firestore.FieldValue.increment(1),
          totalRevenue: admin.firestore.FieldValue.increment(amount),
          lastSaleAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true}
      );

      logger.info(
        `aggregateSellerStats: seller ${sellerId} +1 sale, +$${amount}`
      );
    } catch (err) {
      logger.error("aggregateSellerStats error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// generateDailyBingoPuzzle (scheduled, daily 00:00 UTC)
//   Picks 9 random course IDs from the Logo Bingo course pool
//   and writes them to dailyGames/{YYYY-MM-DD}. Idempotent: if
//   today's doc already exists, the function exits without
//   overwriting it. Course pool is baked in here (mirrors
//   /bingo-courses.js) so the function has no client coupling.
// ─────────────────────────────────────────────────────────────
const BINGO_COURSE_POOL = [
  "augusta-national", "pine-valley", "cypress-point", "pebble-beach",
  "shinnecock-hills", "oakmont", "merion-east", "national-golf-links",
  "fishers-island", "sand-hills", "pacific-dunes", "bandon-dunes",
  "old-macdonald", "bandon-trails", "sheep-ranch", "chicago-golf-club",
  "winged-foot-west", "seminole", "los-angeles-cc-north", "riviera",
  "oakland-hills-south", "olympic-club-lake", "san-francisco-gc",
  "baltusrol-lower", "bethpage-black", "pinehurst-no-2", "whistling-straits",
  "erin-hills", "tpc-sawgrass", "kiawah-ocean", "harbour-town", "tobacco-road",
  "streamsong-red", "streamsong-blue", "streamsong-black", "cabot-citrus-farms",
  "inverness", "crystal-downs", "prairie-dunes", "oak-hill-east", "medinah-3",
  "quaker-ridge", "wade-hampton", "east-lake", "whispering-pines",
  "castle-pines", "shadow-creek", "friars-head", "somerset-hills", "maidstone",
  "st-andrews-old", "muirfield", "royal-dornoch", "turnberry-ailsa",
  "carnoustie", "north-berwick", "kingsbarns", "cruden-bay", "machrihanish",
  "machrihanish-dunes", "castle-stuart", "royal-troon", "royal-county-down",
  "royal-portrush-dunluce", "ballybunion-old", "lahinch", "portmarnock",
  "european-club", "royal-st-georges", "sunningdale-old", "royal-birkdale",
  "royal-lytham", "royal-liverpool", "swinley-forest", "walton-heath-old",
  "morfontaine", "les-bordes", "valderrama", "royal-melbourne-west",
  "kingston-heath", "barnbougle-dunes", "barnbougle-lost-farm", "cape-wickham",
  "new-south-wales", "tara-iti", "cape-kidnappers", "cabot-cliffs",
  "cabot-links", "st-georges-canada", "hamilton-gcc", "hirono", "kawana-fuji",
  "tokyo-gc",
];

function pickNRandom(arr, n) {
  // Fisher-Yates partial shuffle, n items.
  const copy = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function todayUtcDateKey() {
  // YYYY-MM-DD in UTC.
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

exports.generateDailyBingoPuzzle = onSchedule(
  {schedule: "every day 00:00", timeZone: "UTC"},
  async () => {
    try {
      const db = admin.firestore();
      const dateKey = todayUtcDateKey();
      const ref = db.collection("dailyGames").doc(dateKey);
      const existing = await ref.get();
      if (existing.exists) {
        logger.info(
          `generateDailyBingoPuzzle: ${dateKey} already exists, skipping`
        );
        return;
      }
      const courses = pickNRandom(BINGO_COURSE_POOL, 9);
      await ref.set({
        date: dateKey,
        courses,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info(
        `generateDailyBingoPuzzle: wrote ${dateKey} with 9 courses`
      );
    } catch (err) {
      logger.error("generateDailyBingoPuzzle error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// notifyOnSavedSearchMatch (Firestore trigger)
//   On every new active listing, scan savedSearches with
//   notifyOnNew==true and create an in-app notification doc for
//   each saved search whose query criteria match. Push delivery
//   wires up later — this just records the match.
// ─────────────────────────────────────────────────────────────
const SAVED_SEARCH_SCAN_CAP = 200;

function listingMatchesSavedSearch(listing, query) {
  if (!query || typeof query !== "object") return false;

  if (query.category) {
    const lc = String(listing.category || "").toLowerCase();
    if (lc !== String(query.category).toLowerCase()) return false;
  }

  if (query.brand) {
    const lb = String(listing.brand || "").toLowerCase();
    if (lb !== String(query.brand).toLowerCase()) return false;
  }

  if (query.condition) {
    const lcond = String(listing.condition || "").toLowerCase();
    if (lcond !== String(query.condition).toLowerCase()) return false;
  }

  const ask = Number(listing.ask);
  if (Number.isFinite(Number(query.priceMin))) {
    if (!Number.isFinite(ask) || ask < Number(query.priceMin)) return false;
  }
  if (Number.isFinite(Number(query.priceMax))) {
    if (!Number.isFinite(ask) || ask > Number(query.priceMax)) return false;
  }

  return true;
}

exports.notifyOnSavedSearchMatch = onDocumentCreated(
  "listings/{listingId}",
  async (event) => {
    try {
      const listing = event.data && event.data.data();
      if (!listing) return;
      if (listing.status !== "active") return;

      const listingId = event.params.listingId;
      const db = admin.firestore();

      const searchesSnap = await db
        .collection("savedSearches")
        .where("notifyOnNew", "==", true)
        .limit(SAVED_SEARCH_SCAN_CAP + 1)
        .get();

      if (searchesSnap.size > SAVED_SEARCH_SCAN_CAP) {
        logger.warn(
          `notifyOnSavedSearchMatch: more than ${SAVED_SEARCH_SCAN_CAP} ` +
            `saved searches with notifyOnNew=true; skipping listing ${listingId}`
        );
        return;
      }

      let matched = 0;
      const writes = [];
      searchesSnap.forEach((doc) => {
        const search = doc.data();
        const userId = search.userId;
        if (!userId) return;
        // Don't self-notify the seller for their own listing.
        if (userId === listing.sellerId) return;

        if (!listingMatchesSavedSearch(listing, search.query)) return;

        const notifRef = db.collection("notifications").doc();
        writes.push(
          notifRef.set({
            userId,
            type: "saved-search-match",
            listingId,
            searchId: doc.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            read: false,
          })
        );
        matched += 1;
      });

      await Promise.all(writes);
      if (matched > 0) {
        logger.info(
          `notifyOnSavedSearchMatch: listing ${listingId} matched ${matched} ` +
            `saved search(es)`
        );
      }
    } catch (err) {
      logger.error("notifyOnSavedSearchMatch error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// expireOldOffers (scheduled, hourly)
//   Flips offers with status=='pending' and expiresAt < now to
//   status='expired'. Batches in chunks of 100 to stay well
//   under Firestore's 500-op batch limit.
// ─────────────────────────────────────────────────────────────
exports.expireOldOffers = onSchedule(
  {schedule: "every 1 hours"},
  async () => {
    try {
      const db = admin.firestore();
      const now = admin.firestore.Timestamp.now();
      const snap = await db
        .collection("offers")
        .where("status", "==", "pending")
        .where("expiresAt", "<", now)
        .get();

      if (snap.empty) {
        logger.info("expireOldOffers: nothing to expire");
        return;
      }

      const docs = snap.docs;
      const CHUNK = 100;
      let expired = 0;
      for (let i = 0; i < docs.length; i += CHUNK) {
        const slice = docs.slice(i, i + CHUNK);
        const batch = db.batch();
        slice.forEach((d) => {
          batch.update(d.ref, {
            status: "expired",
            expiredAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
        expired += slice.length;
      }

      logger.info(`expireOldOffers: expired ${expired} pending offer(s)`);
    } catch (err) {
      logger.error("expireOldOffers error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// generateReferralCode (callable)
//   Mints (or returns) a stable 6-char alphanumeric referral code
//   for the signed-in user. Reserves the code under
//   referrals/{code} so future redeemers can look the referrer up
//   by code. Retries up to 5 times on collision.
// ─────────────────────────────────────────────────────────────
const REFERRAL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomReferralCode() {
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += REFERRAL_ALPHABET.charAt(
      Math.floor(Math.random() * REFERRAL_ALPHABET.length)
    );
  }
  return s;
}

exports.generateReferralCode = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const db = admin.firestore();

  try {
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const existing =
      userSnap.exists && userSnap.data().referralCode
        ? String(userSnap.data().referralCode)
        : null;
    if (existing) {
      return {
        code: existing,
        shareUrl: `https://teebox-market.web.app/?ref=${existing}`,
      };
    }

    let code = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomReferralCode();
      const refRef = db.doc(`referrals/${candidate}`);
      try {
        const claimed = await db.runTransaction(async (tx) => {
          const snap = await tx.get(refRef);
          if (snap.exists) return false;
          tx.set(refRef, {
            userId: uid,
            code: candidate,
            usedBy: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (claimed) {
          code = candidate;
          break;
        }
      } catch (txErr) {
        logger.warn(
          `generateReferralCode: tx attempt ${attempt} failed: ${txErr.message}`
        );
      }
    }

    if (!code) {
      logger.error(
        `generateReferralCode: could not mint unique code for ${uid} after 5 tries`
      );
      throw new HttpsError("internal", "Could not generate referral code");
    }

    await userRef.set({referralCode: code}, {merge: true});

    return {
      code,
      shareUrl: `https://teebox-market.web.app/?ref=${code}`,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error("generateReferralCode error", err);
    throw new HttpsError("internal", "Could not generate referral code");
  }
});

// ─────────────────────────────────────────────────────────────
// redeemReferralCredit (Firestore trigger)
//   When an order transitions to fulfillmentStatus=='delivered'
//   and the buyer has a referredBy code AND this is their first
//   delivered order, credit BOTH the buyer and the referrer with
//   $10 (users/{uid}.credits +10) and append the buyer to
//   referrals/{code}.usedBy.
//   Idempotent: only fires on the delivered transition itself.
// ─────────────────────────────────────────────────────────────
const REFERRAL_CREDIT_USD = 10;

exports.redeemReferralCredit = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    try {
      const before = event.data && event.data.before && event.data.before.data();
      const after = event.data && event.data.after && event.data.after.data();
      if (!before || !after) return;

      const wasDelivered = before.fulfillmentStatus === "delivered";
      const isDelivered = after.fulfillmentStatus === "delivered";
      if (wasDelivered || !isDelivered) return;

      const buyerId = after.buyerId;
      if (!buyerId) return;

      const db = admin.firestore();
      const buyerRef = db.doc(`users/${buyerId}`);
      const buyerSnap = await buyerRef.get();
      if (!buyerSnap.exists) return;
      const buyer = buyerSnap.data();
      const referralCode = buyer.referredBy;
      if (!referralCode) return; // skip silently — no referral attached

      // First-delivered-order check: count prior delivered orders for buyer.
      const priorSnap = await db
        .collection("orders")
        .where("buyerId", "==", buyerId)
        .where("fulfillmentStatus", "==", "delivered")
        .get();

      // The current order is now in this set (Firestore reads see it post-update).
      // So "first delivered" means exactly 1 delivered order for this buyer.
      const deliveredCount = priorSnap.size;
      if (deliveredCount !== 1) {
        logger.info(
          `redeemReferralCredit: buyer ${buyerId} has ${deliveredCount} ` +
            `delivered order(s); skipping (not first)`
        );
        return;
      }

      const refRef = db.doc(`referrals/${referralCode}`);
      const refSnap = await refRef.get();
      if (!refSnap.exists) {
        logger.warn(
          `redeemReferralCredit: referral code ${referralCode} not found ` +
            `for buyer ${buyerId}`
        );
        return;
      }
      const referrerId = refSnap.data().userId;
      if (!referrerId || referrerId === buyerId) {
        logger.warn(
          `redeemReferralCredit: invalid referrerId for code ${referralCode}`
        );
        return;
      }

      const referrerRef = db.doc(`users/${referrerId}`);
      const batch = db.batch();
      batch.set(
        buyerRef,
        {credits: admin.firestore.FieldValue.increment(REFERRAL_CREDIT_USD)},
        {merge: true}
      );
      batch.set(
        referrerRef,
        {credits: admin.firestore.FieldValue.increment(REFERRAL_CREDIT_USD)},
        {merge: true}
      );
      batch.update(refRef, {
        usedBy: admin.firestore.FieldValue.arrayUnion(buyerId),
      });
      await batch.commit();

      logger.info(
        `redeemReferralCredit: +$${REFERRAL_CREDIT_USD} to buyer ${buyerId} ` +
          `and referrer ${referrerId} (code ${referralCode})`
      );
    } catch (err) {
      logger.error("redeemReferralCredit error", err);
    }
  }
);
