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
const geminiSecret = defineSecret("GEMINI_API_KEY");

const PLATFORM_FEE_PERCENT = 0.065;
const PENDING_WINDOW_MS = 15 * 60 * 1000;
const ALLOWED_ORIGINS = [
  "https://teeboxmarket.com",
  "https://www.teeboxmarket.com",
  "https://teebox-market.web.app",
  "https://teebox-market.firebaseapp.com",
  "capacitor://localhost",
  "http://localhost",
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

    const {listingId, quantity} = req.body || {};
    if (!listingId || typeof listingId !== "string" || listingId.length > 128) {
      return res.status(400).json({error: "Missing or invalid listingId"});
    }
    let qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > 99) qty = 99;

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

        // Multi-quantity stock check. quantity / quantitySold default to 1/0
        // for legacy single-unit listings.
        const totalQty = Math.max(1, Number(listing.quantity || 1));
        const soldQty = Math.max(0, Number(listing.quantitySold || 0));
        const remaining = totalQty - soldQty;
        if (qty > remaining) {
          throw new HttpError(
            409,
            `Only ${remaining} in stock — please reduce your quantity.`
          );
        }

        const unitPriceCents = Math.round(Number(listing.ask) * 100);
        if (!Number.isFinite(unitPriceCents) || unitPriceCents <= 0) {
          throw new HttpError(500, "Listing has invalid price");
        }
        const priceCents = unitPriceCents * qty;

        // For multi-stock listings, only flip to "pending" when the LAST
        // unit is being reserved. Otherwise keep status active so other
        // buyers can keep purchasing remaining units in parallel.
        const isLastUnit = (qty === remaining);
        tx.update(listingRef, isLastUnit ? {
          status: "pending",
          pendingBuyer: buyerId,
          pendingUntil: admin.firestore.Timestamp.fromMillis(
            now + PENDING_WINDOW_MS
          ),
        } : {
          // Reserve units atomically without locking the whole listing.
          // The Stripe webhook commits the increment to quantitySold;
          // here we just keep the listing active.
          pendingBuyer: buyerId,
          pendingUntil: admin.firestore.Timestamp.fromMillis(
            now + PENDING_WINDOW_MS
          ),
        });

        return {
          priceCents,
          unitPriceCents,
          qty,
          totalQty,
          isLastUnit,
          sellerId: listing.sellerId,
          title: listing.title || "Listing",
        };
      });

      const platformFeeCents = Math.round(
        reservation.priceCents * PLATFORM_FEE_PERCENT
      );
      const sellerPayoutCents = reservation.priceCents - platformFeeCents;

      // Look up the seller's Stripe Connect account. Without an active
      // Connect account + chargesEnabled, we can't route funds to them —
      // refuse to charge so the buyer doesn't pay for an item the seller
      // can never get paid for.
      const sellerSnap = await db.collection("users")
        .doc(reservation.sellerId)
        .get();
      const sellerData = sellerSnap.exists ? sellerSnap.data() : {};
      const stripeAccountId = sellerData.stripeAccountId || null;
      const stripeChargesEnabled = !!sellerData.stripeChargesEnabled;

      if (!stripeAccountId || !stripeChargesEnabled) {
        // Roll back the reservation we just made so the listing doesn't
        // sit in `pending` forever.
        await listingRef.update({
          status: "active",
          pendingBuyer: admin.firestore.FieldValue.delete(),
          pendingUntil: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        return res.status(409).json({
          error: "This seller hasn't finished setting up payouts yet. " +
            "Please come back in a bit, or message them via the listing.",
        });
      }

      const stripeClient = stripe(stripeSecret.value());

      // Truncate description to Stripe's 1000-char limit, defensively.
      const description = `teebox — ${reservation.title}`.slice(0, 200);

      // Idempotency: same buyer + listing + 5-minute bucket → same PI.
      // Stops a duplicate-charge race if the client retries Pay Now.
      const idempotencyKey = `pi_${listingId}_${buyerId}_${Math.floor(
        Date.now() / (5 * 60 * 1000)
      )}`;

      // Stripe Connect destination charge: platform receives the funds,
      // automatically transfers (priceCents - applicationFee) to the
      // seller's connected account. Stripe handles the split — no manual
      // payouts, no holding funds on our books.
      const paymentIntent = await stripeClient.paymentIntents.create(
        {
          amount: reservation.priceCents,
          currency: "usd",
          automatic_payment_methods: {enabled: true},
          payment_method_options: {
            card: {request_three_d_secure: "automatic"},
          },
          description,
          statement_descriptor_suffix: "TEEBOX",
          // ── Connect bits ──
          application_fee_amount: platformFeeCents,
          transfer_data: {destination: stripeAccountId},
          // Charge the seller's account for any disputes/refunds rather
          // than the platform — keeps platform liability bounded.
          on_behalf_of: stripeAccountId,
          metadata: {
            listingId,
            buyerId,
            sellerId: reservation.sellerId || "",
            stripeAccountId,
            platformFeeCents: String(platformFeeCents),
            sellerPayoutCents: String(sellerPayoutCents),
            quantity: String(reservation.qty),
            unitPriceCents: String(reservation.unitPriceCents),
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
        case "account.updated":
          // Seller's Connect status changed (finished onboarding,
          // requirement added, etc.). Mirror it into Firestore so the
          // app can gate Buy Now + show payout-status banners.
          await syncConnectAccountStatus(event.data.object);
          break;
        case "charge.dispute.created":
          await handleDisputeOpened(event.data.object);
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

async function syncConnectAccountStatus(account) {
  if (!account || !account.id) return;
  const db = admin.firestore();
  // Reverse-lookup the user by their stored stripeAccountId.
  const usersSnap = await db.collection("users")
    .where("stripeAccountId", "==", account.id).limit(1).get();
  if (usersSnap.empty) {
    logger.warn(`account.updated for unknown account ${account.id}`);
    return;
  }
  const userDoc = usersSnap.docs[0];
  const update = {
    stripeChargesEnabled: !!account.charges_enabled,
    stripePayoutsEnabled: !!account.payouts_enabled,
    stripeDetailsSubmitted: !!account.details_submitted,
    stripeRequirementsCount: ((account.requirements || {}).currently_due || []).length,
    stripeAccountUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await userDoc.ref.update(update);
  logger.info(`Synced Connect status for ${userDoc.id}: ` +
    `charges=${update.stripeChargesEnabled}, payouts=${update.stripePayoutsEnabled}`);
}

async function handleDisputeOpened(dispute) {
  if (!dispute || !dispute.payment_intent) return;
  const db = admin.firestore();
  // Tag the order doc so the seller dashboard can surface the dispute,
  // and so /orders queries can flag affected items in red.
  const orderRef = db.collection("orders").doc(dispute.payment_intent);
  await orderRef.set({
    disputed: true,
    disputeId: dispute.id,
    disputeReason: dispute.reason || "",
    disputeAmountCents: dispute.amount || 0,
    disputeStatus: dispute.status || "needs_response",
    disputeCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  logger.warn(`Dispute opened on order ${dispute.payment_intent}: ${dispute.reason}`);
}

async function handlePaymentSucceeded(pi) {
  const db = admin.firestore();
  const {
    listingId,
    buyerId,
    sellerId,
    platformFeeCents,
    sellerPayoutCents,
    quantity,
    unitPriceCents,
  } = pi.metadata || {};
  const orderQty = Math.max(1, parseInt(quantity || "1", 10));

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
      quantity: orderQty,
      unitPriceCents: Number(unitPriceCents) || pi.amount,
      platformFeeCents: Number(platformFeeCents) || 0,
      sellerPayoutCents: Number(sellerPayoutCents) || 0,
      status: "paid",
      fulfillmentStatus: "awaiting_seller_shipment",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (listingSnap && listingSnap.exists) {
      const listing = listingSnap.data();
      const totalQty = Math.max(1, Number(listing.quantity || 1));
      const newSold = Math.max(0, Number(listing.quantitySold || 0)) + orderQty;
      const fullySold = newSold >= totalQty;
      tx.update(listingRef, fullySold ? {
        status: "sold",
        quantitySold: newSold,
        soldAt: admin.firestore.FieldValue.serverTimestamp(),
        soldTo: buyerId || null,
        orderId: pi.id,
        pendingBuyer: admin.firestore.FieldValue.delete(),
        pendingUntil: admin.firestore.FieldValue.delete(),
        pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      } : {
        // Multi-stock: bump sold count, keep listing active for remaining units.
        status: "active",
        quantitySold: newSold,
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

// ─────────────────────────────────────────────────────────────
// notifyOnWatchlistPriceDrop (scheduled, every 4 hours)
//   For each listing whose ask price decreased since the last
//   recorded `lastPriceCheck` value, write a notification doc to
//   every user who has it in their watchlist. Uses a small
//   index doc (`pricesIndex/{listingId}`) to remember the
//   previous price between runs.
// ─────────────────────────────────────────────────────────────
exports.notifyOnWatchlistPriceDrop = onSchedule(
  {schedule: "every 4 hours"},
  async () => {
    try {
      const db = admin.firestore();
      const listingsSnap = await db.collection("listings")
        .where("status", "==", "active")
        .limit(500)
        .get();

      let notified = 0;
      for (const doc of listingsSnap.docs) {
        const listing = doc.data();
        const ask = Number(listing.ask || 0);
        if (!ask) continue;

        const idxRef = db.collection("pricesIndex").doc(doc.id);
        const idx = await idxRef.get();
        const prev = idx.exists ? Number(idx.data().ask || 0) : 0;

        // Always update the index. Only notify if it dropped.
        await idxRef.set({ask, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
        if (prev <= 0 || ask >= prev) continue;

        // Find users who have this listing in their watchlist
        const watchSnap = await db.collectionGroup("watchlist")
          .where("listingId", "==", doc.id)
          .limit(200)
          .get();
        if (watchSnap.empty) continue;

        const drop = prev - ask;
        const pct = Math.round((drop / prev) * 100);

        const batch = db.batch();
        watchSnap.forEach((w) => {
          // Path is users/{uid}/watchlist/{listingId}; uid is parent.parent.id
          const uid = w.ref.parent.parent.id;
          if (uid === listing.sellerId) return; // don't notify the seller
          const notifRef = db.collection("users").doc(uid)
            .collection("notifications").doc();
          batch.set(notifRef, {
            kind: "price-drop",
            listingId: doc.id,
            listingTitle: listing.title || "Listing",
            previousAsk: prev,
            currentAsk: ask,
            dropAmount: drop,
            dropPct: pct,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            read: false,
          });
        });
        await batch.commit();
        notified += watchSnap.size;
      }

      logger.info(`notifyOnWatchlistPriceDrop: wrote ${notified} notification(s)`);
    } catch (err) {
      logger.error("notifyOnWatchlistPriceDrop error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// optimizeListingPhoto (Storage trigger)
//   Runs whenever a new image is uploaded to listings/{id}/photos.
//   Strips EXIF (privacy: removes geolocation), resizes to a sensible
//   max dimension, and rewrites as WebP. The original is replaced
//   in-place to keep URLs stable. Skips files that are already
//   processed (have a content-disposition or webp content-type).
// ─────────────────────────────────────────────────────────────
exports.optimizeListingPhoto = require("firebase-functions/v2/storage")
  .onObjectFinalized(
    {memory: "1GiB", region: "us-east1", bucket: "teebox-market.firebasestorage.app"},
    async (event) => {
      const obj = event.data;
      if (!obj || !obj.name) return;
      // Only process listing photos.
      if (!obj.name.startsWith("listings/")) return;
      // Skip non-images and already-WebP files.
      const contentType = obj.contentType || "";
      if (!contentType.startsWith("image/")) return;
      if (obj.metadata && obj.metadata.optimized === "true") return;
      try {
        const sharp = require("sharp");
        const bucket = admin.storage().bucket(obj.bucket);
        const file = bucket.file(obj.name);
        const [buf] = await file.download();
        const out = await sharp(buf)
          .rotate() // honor EXIF orientation
          .resize({width: 1600, height: 1600, fit: "inside", withoutEnlargement: true})
          .withMetadata({}) // strip EXIF (incl. GPS)
          .webp({quality: 82})
          .toBuffer();
        await file.save(out, {
          metadata: {
            contentType: "image/webp",
            cacheControl: "public, max-age=31536000",
            metadata: {optimized: "true"},
          },
          resumable: false,
        });
        logger.info(`optimized ${obj.name}: ${buf.length} → ${out.length} bytes`);
      } catch (err) {
        logger.error("optimizeListingPhoto error", obj.name, err);
      }
    }
  );

// ─────────────────────────────────────────────────────────────
// createIdentitySession (callable)
//   Creates a Stripe Identity Verification Session. Returned
//   client_secret + url is used by the iOS / web client to embed
//   the verification flow. We mark the user as `identityPending`
//   and only flip to `identityVerified=true` when the
//   stripeIdentityWebhook receives `identity.verification_session.verified`.
// ─────────────────────────────────────────────────────────────
exports.createIdentitySession = onCall(
  {secrets: [stripeSecret]},
  async (request) => {
    const auth = request.auth;
    if (!auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }
    const uid = auth.uid;
    try {
      const s = stripe(stripeSecret.value());
      const session = await s.identity.verificationSessions.create({
        type: "document",
        metadata: {uid},
        options: {
          document: {
            require_id_number: false,
            require_live_capture: true,
            require_matching_selfie: true,
          },
        },
      });
      await admin.firestore().collection("users").doc(uid).set({
        identityPending: true,
        identitySessionId: session.id,
        identityRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      return {
        url: session.url,
        clientSecret: session.client_secret,
      };
    } catch (err) {
      logger.error("createIdentitySession error", err);
      throw new HttpsError("internal", "Could not start verification.");
    }
  }
);

// ─────────────────────────────────────────────────────────────
// pushNotificationDispatch (Firestore trigger)
//   Whenever a notification doc lands at users/{uid}/notifications,
//   look up the user's FCM tokens (stored at users/{uid}/fcmTokens)
//   and dispatch the message. Tokens that fail with "registration-
//   token-not-registered" are pruned automatically.
// ─────────────────────────────────────────────────────────────
exports.pushNotificationDispatch = onDocumentCreated(
  {document: "users/{uid}/notifications/{notifId}"},
  async (event) => {
    try {
      const uid = event.params.uid;
      const data = event.data && event.data.data();
      if (!data) return;
      const db = admin.firestore();
      const tokensSnap = await db.collection("users").doc(uid)
        .collection("fcmTokens").get();
      if (tokensSnap.empty) return;

      // Compose a short notification body based on the notification kind.
      let title = "TeeBox";
      let body = "You have a new notification";
      if (data.kind === "price-drop") {
        title = `Price drop on ${data.listingTitle || "your watchlist"}`;
        body = `Now $${data.currentAsk} (was $${data.previousAsk}, -${data.dropPct}%)`;
      } else if (data.kind === "saved-search-match") {
        title = "New listing matches your saved search";
        body = data.listingTitle || "Tap to view";
      } else if (data.kind === "offer-received") {
        title = `New offer: $${data.amount}`;
        body = `From ${data.buyerName || "a buyer"} on ${data.listingTitle || "your listing"}`;
      } else if (data.kind === "offer-accepted") {
        title = "Offer accepted!";
        body = `${data.sellerName || "The seller"} accepted your $${data.amount} offer.`;
      } else if (data.kind === "offer-declined") {
        title = "Offer declined";
        body = `${data.sellerName || "The seller"} passed on your $${data.amount} offer.`;
      } else if (data.kind === "offer-countered") {
        title = `Counter offer: $${data.counterAmount}`;
        body = `${data.sellerName || "The seller"} countered your offer.`;
      } else if (data.kind === "new-message") {
        title = `New message from ${data.fromName || "buyer"}`;
        body = data.preview || "Tap to read";
      } else if (data.kind === "order-placed") {
        title = `You sold ${data.listingTitle || "an item"}`;
        body = `$${data.amount} — ship within 3 business days.`;
      } else if (data.kind === "order-shipped") {
        title = `Your ${data.listingTitle || "order"} shipped`;
        body = data.trackingNumber
          ? `${data.carrier || "Carrier"} · ${data.trackingNumber}`
          : "On its way!";
      } else if (data.kind === "order-delivered") {
        title = "Order delivered";
        body = `${data.listingTitle || "Your item"} reached the buyer. Payout incoming.`;
      } else if (data.kind === "review-received") {
        title = `New ${data.rating || ""}★ review`;
        body = data.preview || "Tap to read your review.";
      }

      const tokens = [];
      tokensSnap.forEach((t) => tokens.push(t.id));
      const resp = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: {title, body},
        data: {
          kind: String(data.kind || ""),
          listingId: String(data.listingId || ""),
          notificationId: String(event.params.notifId),
        },
      });

      // Prune dead tokens.
      const dead = [];
      resp.responses.forEach((r, i) => {
        if (!r.success && r.error &&
            (r.error.code === "messaging/registration-token-not-registered" ||
             r.error.code === "messaging/invalid-registration-token")) {
          dead.push(tokens[i]);
        }
      });
      if (dead.length) {
        const batch = db.batch();
        dead.forEach((t) => batch.delete(
          db.collection("users").doc(uid).collection("fcmTokens").doc(t)
        ));
        await batch.commit();
        logger.info(`pruned ${dead.length} dead FCM token(s) for ${uid}`);
      }
    } catch (err) {
      logger.error("pushNotificationDispatch error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Email + push fan-out helpers
//   Each user-facing event (order placed/shipped/delivered, offer
//   received/responded, message received, review received) writes a
//   notification doc (which fires pushNotificationDispatch) AND, when
//   RESEND_API_KEY is configured, sends a transactional email via
//   Resend. Email failure never blocks push — they're independent.
// ─────────────────────────────────────────────────────────────
const RESEND_KEY = defineSecret("RESEND_API_KEY");
const FROM_EMAIL = "TeeBox <noreply@teeboxmarket.com>";
const APP_URL = "https://teeboxmarket.com";

async function lookupUser(uid) {
  if (!uid) return null;
  const db = admin.firestore();
  const [authUser, profileSnap] = await Promise.all([
    admin.auth().getUser(uid).catch(() => null),
    db.collection("users").doc(uid).get().catch(() => null),
  ]);
  return {
    uid,
    email: authUser ? authUser.email : null,
    displayName: (profileSnap && profileSnap.exists && profileSnap.data().displayName) ||
      (authUser && authUser.displayName) || "TeeBox member",
  };
}

async function writeNotification(uid, doc) {
  if (!uid) return;
  const db = admin.firestore();
  await db.collection("users").doc(uid).collection("notifications").add({
    ...doc,
    userId: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    read: false,
  });
}

// Lightweight branded email shell. Inline styles only (Gmail strips
// <style> blocks). Cream + green palette mirrors the app.
function emailShell(headline, bodyHtml, ctaLabel, ctaUrl) {
  const cta = ctaLabel && ctaUrl
    ? `<p style="margin:28px 0 0;text-align:center;">
         <a href="${ctaUrl}" style="display:inline-block;background:#1f4827;color:#fff;
            text-decoration:none;font-weight:600;padding:13px 28px;border-radius:50px;">
           ${ctaLabel}
         </a>
       </p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f2e8;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f2e8;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
          <tr><td style="background:#14301a;padding:24px;text-align:center;">
            <span style="font-family:Georgia,serif;font-style:italic;font-weight:700;font-size:28px;color:#e7d28a;">TeeBox</span>
          </td></tr>
          <tr><td style="padding:32px 28px 16px;">
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#14301a;">${headline}</h1>
            ${bodyHtml}
            ${cta}
          </td></tr>
          <tr><td style="padding:24px 28px 28px;border-top:1px solid #f0eadb;color:#777;font-size:12px;line-height:1.5;text-align:center;">
            TeeBox · The peer-to-peer marketplace for golfers<br/>
            <a href="${APP_URL}/support" style="color:#1f4827;">Help</a> ·
            <a href="${APP_URL}/privacy.html" style="color:#1f4827;">Privacy</a>
          </td></tr>
        </table>
      </td></tr>
    </table></body></html>`;
}

async function sendEmail({to, subject, html}) {
  if (!to || !subject || !html) return;
  let key;
  try { key = RESEND_KEY.value(); } catch (_e) { key = null; }
  if (!key) {
    logger.info(`[email skipped] RESEND_API_KEY not set — would send "${subject}" to ${to}`);
    return;
  }
  try {
    const {Resend} = require("resend");
    const resend = new Resend(key);
    await resend.emails.send({from: FROM_EMAIL, to, subject, html});
  } catch (err) {
    logger.error(`[email send failed] ${subject} → ${to}`, err);
  }
}

// ─────────────────────────────────────────────────────────────
// notifyOnOrderCreated
//   Fires when Stripe webhook writes orders/{paymentIntentId}.
//   - Push + email to seller: "you sold X, ship within 3 business days"
//   - Email to buyer: "order confirmed, here's your receipt"
// ─────────────────────────────────────────────────────────────
exports.notifyOnOrderCreated = onDocumentCreated(
  {document: "orders/{orderId}", secrets: [RESEND_KEY]},
  async (event) => {
    try {
      const order = event.data && event.data.data();
      if (!order) return;
      const db = admin.firestore();
      const listing = await db.collection("listings").doc(order.listingId).get()
        .then((s) => s.exists ? s.data() : {}).catch(() => ({}));
      const listingTitle = listing.title || "your item";
      const photo = (listing.photos && listing.photos[0]) || null;
      const amount = Number(order.amount || 0);

      const [seller, buyer] = await Promise.all([
        lookupUser(order.sellerId),
        lookupUser(order.buyerId),
      ]);

      // Seller: push + email.
      await writeNotification(order.sellerId, {
        kind: "order-placed",
        listingId: order.listingId,
        orderId: event.params.orderId,
        listingTitle,
        amount,
      });
      if (seller && seller.email) {
        const body = `<p>Great news — <strong>${listingTitle}</strong> sold for
          <strong>$${amount.toLocaleString()}</strong>. Please ship within 3 business days
          and mark it as shipped in the app so the buyer can track delivery.</p>
          ${photo ? `<p style="text-align:center;margin:20px 0;"><img src="${photo}"
            alt="" style="max-width:280px;border-radius:8px;" /></p>` : ""}`;
        await sendEmail({
          to: seller.email,
          subject: `You sold ${listingTitle} — ship within 3 days`,
          html: emailShell(`You sold ${listingTitle}!`, body, "Open Order", `${APP_URL}/?order=${event.params.orderId}`),
        });
      }

      // Buyer: confirmation email only (push at this point would be
      // redundant with the in-app Stripe success screen).
      if (buyer && buyer.email) {
        const body = `<p>Thanks for your order, ${buyer.displayName}!</p>
          <p><strong>${listingTitle}</strong> — $${amount.toLocaleString()}</p>
          <p>The seller will ship within 3 business days. You'll get an email + push
          notification with tracking when it's on the way.</p>`;
        await sendEmail({
          to: buyer.email,
          subject: `Order confirmed: ${listingTitle}`,
          html: emailShell("Order confirmed", body, "View Order", `${APP_URL}/?order=${event.params.orderId}`),
        });
      }
    } catch (err) {
      logger.error("notifyOnOrderCreated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// notifyOnOrderUpdated
//   Single trigger handles two transitions:
//     awaiting_seller_shipment → shipped   → notify buyer
//     shipped                  → delivered → notify seller
// ─────────────────────────────────────────────────────────────
exports.notifyOnOrderUpdated = onDocumentUpdated(
  {document: "orders/{orderId}", secrets: [RESEND_KEY]},
  async (event) => {
    try {
      const before = event.data && event.data.before && event.data.before.data();
      const after = event.data && event.data.after && event.data.after.data();
      if (!before || !after) return;
      const db = admin.firestore();
      const listing = await db.collection("listings").doc(after.listingId).get()
        .then((s) => s.exists ? s.data() : {}).catch(() => ({}));
      const listingTitle = listing.title || "your item";

      // Shipment notification (seller → buyer)
      if (before.fulfillmentStatus === "awaiting_seller_shipment"
          && after.fulfillmentStatus === "shipped") {
        const buyer = await lookupUser(after.buyerId);
        await writeNotification(after.buyerId, {
          kind: "order-shipped",
          listingId: after.listingId,
          orderId: event.params.orderId,
          listingTitle,
          carrier: after.carrier || "",
          trackingNumber: after.trackingNumber || "",
        });
        if (buyer && buyer.email) {
          const trackingLink = trackingUrl(after.carrier, after.trackingNumber);
          const trackingHtml = after.trackingNumber
            ? `<p><strong>${after.carrier || "Carrier"}</strong>:
                <a href="${trackingLink}" style="color:#1f4827;">${after.trackingNumber}</a></p>`
            : "";
          const body = `<p>Your <strong>${listingTitle}</strong> just shipped.</p>${trackingHtml}
            <p>You'll get another note when it's delivered.</p>`;
          await sendEmail({
            to: buyer.email,
            subject: `Shipped: ${listingTitle}`,
            html: emailShell("Your order shipped", body, "Track Order", `${APP_URL}/?order=${event.params.orderId}`),
          });
        }
      }

      // Delivery confirmation (buyer → seller; aggregateSellerStats
      // already handles seller-stats roll-up separately).
      if (before.fulfillmentStatus === "shipped"
          && after.fulfillmentStatus === "delivered") {
        const seller = await lookupUser(after.sellerId);
        await writeNotification(after.sellerId, {
          kind: "order-delivered",
          listingId: after.listingId,
          orderId: event.params.orderId,
          listingTitle,
        });
        if (seller && seller.email) {
          const payoutCents = Number(after.sellerPayoutCents || 0);
          const payoutDollars = (payoutCents / 100).toFixed(2);
          const body = `<p>${listingTitle} reached the buyer. Your payout of
            <strong>$${payoutDollars}</strong> is on the way to your bank
            (typically 2 business days via Stripe).</p>
            <p>Thanks for being a great seller!</p>`;
          await sendEmail({
            to: seller.email,
            subject: `Delivered: ${listingTitle}`,
            html: emailShell("Delivered — payout incoming", body, "View Order", `${APP_URL}/?order=${event.params.orderId}`),
          });
        }
      }
    } catch (err) {
      logger.error("notifyOnOrderUpdated error", err);
    }
  }
);

function trackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return APP_URL;
  const c = String(carrier || "").toLowerCase();
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking/tracking-parcel.html?tracking-id=${encodeURIComponent(trackingNumber)}`;
  return APP_URL;
}
// Local helper — intentionally NOT exported. Firebase Functions only
// accepts Cloud Function exports; exporting a plain function breaks
// `firebase deploy --only functions` with a backend-spec timeout.

// ─────────────────────────────────────────────────────────────
// notifyOnOfferCreated — push + email seller when a buyer offers
// ─────────────────────────────────────────────────────────────
exports.notifyOnOfferCreated = onDocumentCreated(
  {document: "offers/{offerId}", secrets: [RESEND_KEY]},
  async (event) => {
    try {
      const offer = event.data && event.data.data();
      if (!offer || !offer.sellerId) return;
      const db = admin.firestore();
      const [seller, buyer, listingSnap] = await Promise.all([
        lookupUser(offer.sellerId),
        lookupUser(offer.buyerId),
        db.collection("listings").doc(offer.listingId || "").get().catch(() => null),
      ]);
      const listing = (listingSnap && listingSnap.exists) ? listingSnap.data() : {};
      const listingTitle = listing.title || "your listing";

      await writeNotification(offer.sellerId, {
        kind: "offer-received",
        listingId: offer.listingId,
        offerId: event.params.offerId,
        listingTitle,
        amount: Number(offer.amount || 0),
        buyerName: (buyer && buyer.displayName) || "a buyer",
      });
      if (seller && seller.email) {
        const body = `<p>${(buyer && buyer.displayName) || "Someone"} offered
          <strong>$${Number(offer.amount || 0).toLocaleString()}</strong> on
          <strong>${listingTitle}</strong>.</p>
          <p>Open the app to accept, decline, or counter.</p>`;
        await sendEmail({
          to: seller.email,
          subject: `New offer on ${listingTitle}`,
          html: emailShell(`New offer: $${Number(offer.amount || 0).toLocaleString()}`, body, "Review Offer", `${APP_URL}/?offer=${event.params.offerId}`),
        });
      }
    } catch (err) {
      logger.error("notifyOnOfferCreated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// notifyOnOfferUpdated — push + email buyer on accept/decline/counter
// ─────────────────────────────────────────────────────────────
exports.notifyOnOfferUpdated = onDocumentUpdated(
  {document: "offers/{offerId}", secrets: [RESEND_KEY]},
  async (event) => {
    try {
      const before = event.data.before.data();
      const after = event.data.after.data();
      if (!before || !after) return;
      if (before.status === after.status) return;
      if (!["accepted", "declined", "countered"].includes(after.status)) return;
      const db = admin.firestore();
      const [buyer, seller, listingSnap] = await Promise.all([
        lookupUser(after.buyerId),
        lookupUser(after.sellerId),
        db.collection("listings").doc(after.listingId || "").get().catch(() => null),
      ]);
      const listing = (listingSnap && listingSnap.exists) ? listingSnap.data() : {};
      const listingTitle = listing.title || "the listing";
      const sellerName = (seller && seller.displayName) || "The seller";

      const kind = after.status === "accepted" ? "offer-accepted"
        : after.status === "declined" ? "offer-declined"
        : "offer-countered";
      await writeNotification(after.buyerId, {
        kind, listingId: after.listingId, offerId: event.params.offerId,
        listingTitle, sellerName,
        amount: Number(after.amount || 0),
        counterAmount: Number(after.counterAmount || 0),
      });

      if (buyer && buyer.email) {
        let subject; let headline; let body;
        if (after.status === "accepted") {
          subject = `Offer accepted: ${listingTitle}`;
          headline = `${sellerName} accepted your offer!`;
          body = `<p>Your <strong>$${Number(after.amount || 0).toLocaleString()}</strong>
            offer on <strong>${listingTitle}</strong> was accepted.
            Pay now to lock it in — listings are first-come, first-served until paid.</p>`;
        } else if (after.status === "declined") {
          subject = `Offer declined: ${listingTitle}`;
          headline = `${sellerName} passed on your offer`;
          body = `<p>Your $${Number(after.amount || 0).toLocaleString()} offer on
            <strong>${listingTitle}</strong> wasn't accepted. The listing is
            still available — try a higher offer or buy at the asking price.</p>`;
        } else {
          subject = `Counter offer on ${listingTitle}`;
          headline = `Counter offer: $${Number(after.counterAmount || 0).toLocaleString()}`;
          body = `<p>${sellerName} countered with
            <strong>$${Number(after.counterAmount || 0).toLocaleString()}</strong>
            on <strong>${listingTitle}</strong>. Open the app to accept, decline, or
            counter back.</p>`;
        }
        await sendEmail({to: buyer.email, subject, html: emailShell(headline, body, "Open Offer", `${APP_URL}/?offer=${event.params.offerId}`)});
      }
    } catch (err) {
      logger.error("notifyOnOfferUpdated error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// notifyOnNewMessage — push (immediate) + email (when not online)
// ─────────────────────────────────────────────────────────────
exports.notifyOnNewMessage = onDocumentCreated(
  {document: "messages/{messageId}", secrets: [RESEND_KEY]},
  async (event) => {
    try {
      const msg = event.data && event.data.data();
      if (!msg) return;
      const db = admin.firestore();
      let recipientUid = msg.recipientId || msg.toUid;
      const conversationId = msg.conversationId;
      if (!recipientUid && conversationId) {
        const conv = await db.collection("conversations").doc(conversationId).get();
        if (conv.exists) {
          const c = conv.data();
          const senderId = msg.senderId || msg.fromUid;
          recipientUid = (c.participants || []).find((p) => p !== senderId);
        }
      }
      if (!recipientUid) return;
      const [recipient, sender] = await Promise.all([
        lookupUser(recipientUid),
        lookupUser(msg.senderId || msg.fromUid),
      ]);
      const fromName = (sender && sender.displayName) || "A buyer";
      const preview = String(msg.text || msg.body || "").slice(0, 120);

      await writeNotification(recipientUid, {
        kind: "new-message",
        listingId: msg.listingId || null,
        conversationId,
        fromName,
        preview,
      });
      // Mail an immediate digest only if the recipient has email AND the
      // message isn't from themselves. A future enhancement would batch
      // these into a daily digest if recipients complain.
      if (recipient && recipient.email && msg.senderId !== recipientUid) {
        const safePreview = preview.replace(/[<>]/g, "");
        const body = `<p><strong>${fromName}</strong> sent you a message:</p>
          <blockquote style="border-left:3px solid #c5a253;padding:8px 14px;
            margin:14px 0;color:#4a4a4a;font-style:italic;">${safePreview}</blockquote>
          <p>Reply in the app — buyers and sellers chat directly inside TeeBox.</p>`;
        await sendEmail({
          to: recipient.email,
          subject: `New message from ${fromName}`,
          html: emailShell(`Message from ${fromName}`, body, "Open Inbox", `${APP_URL}/?inbox=1`),
        });
      }
    } catch (err) {
      logger.error("notifyOnNewMessage error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// welcomeOnFirstProfileWrite
//   Fires the first time a users/{uid} doc is created — which happens
//   right after the first sign-in regardless of provider (email, Google,
//   phone). Sends a branded welcome email. Firebase's built-in
//   verification email is separate (it's just the "click to verify"
//   link); this one is the actual welcome.
// ─────────────────────────────────────────────────────────────
exports.welcomeOnFirstProfileWrite = onDocumentCreated(
  {document: "users/{uid}", secrets: [RESEND_KEY]},
  async (event) => {
    try {
      const uid = event.params.uid;
      const u = await lookupUser(uid);
      if (!u || !u.email) return;
      const body = `<p>Welcome to TeeBox, ${u.displayName}.</p>
        <p>You're now part of a peer-to-peer marketplace built specifically for golfers.
        Buy gear from other members, list what you no longer use, and trade at fair
        peer-to-peer prices — with payments secured by Stripe and a flat 6.5% seller fee.</p>
        <p>A few things you can try right now:</p>
        <ul>
          <li><strong>Browse</strong> the live marketplace</li>
          <li><strong>Like</strong> items by tapping the heart on any listing</li>
          <li><strong>Play Logo Bingo</strong> — daily golf course logo guessing game</li>
        </ul>`;
      await sendEmail({
        to: u.email,
        subject: "Welcome to TeeBox",
        html: emailShell(`Welcome, ${u.displayName}`, body, "Open TeeBox", APP_URL),
      });
    } catch (err) {
      logger.error("welcomeOnFirstProfileWrite error", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// STRIPE CONNECT — seller onboarding + status
//
// createStripeOnboardingLink (callable)
//   - First call: creates an Express account, stores the id on the user,
//     returns an account-link URL the user opens in a browser/webview.
//   - Subsequent calls: re-issues a fresh link if onboarding wasn't
//     finished, or returns null + status if it was.
//   - Stripe redirects the user back to teeboxmarket.com on completion.
//
// getStripeAccountStatus (callable)
//   - Reads the live status from Stripe (chargesEnabled, payoutsEnabled,
//     requirements). Server-of-record stays Stripe; we cache the booleans
//     in users/{uid} via the account.updated webhook.
// ─────────────────────────────────────────────────────────────
exports.createStripeOnboardingLink = onCall(
  {secrets: [stripeSecret]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const db = admin.firestore();
    const stripeClient = stripe(stripeSecret.value());
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const user = userSnap.exists ? userSnap.data() : {};

    // Pull email + name to pre-fill Stripe's onboarding form.
    let email; let displayName;
    try {
      const authUser = await admin.auth().getUser(uid);
      email = authUser.email || undefined;
      displayName = authUser.displayName || user.displayName || undefined;
    } catch (_e) { /* swallow — Stripe will collect on the form */ }

    let accountId = user.stripeAccountId;
    if (!accountId) {
      const account = await stripeClient.accounts.create({
        type: "express",
        country: "US",
        email,
        capabilities: {
          card_payments: {requested: true},
          transfers: {requested: true},
        },
        business_type: "individual",
        business_profile: {
          mcc: "5941", // sporting goods
          product_description: "Used + new golf gear via the TeeBox marketplace",
          url: APP_URL,
        },
        metadata: {
          firebaseUid: uid,
          ...(displayName ? {displayName} : {}),
        },
        settings: {
          payouts: {schedule: {interval: "daily"}},
        },
      });
      accountId = account.id;
      await userRef.set({
        stripeAccountId: accountId,
        stripeAccountCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    }

    // Refresh URL is hit if the link expires while the user is filling
    // out the form — sends them back to call us again for a new link.
    // Return URL is hit on completion.
    const link = await stripeClient.accountLinks.create({
      account: accountId,
      refresh_url: `${APP_URL}/?stripe=refresh`,
      return_url: `${APP_URL}/?stripe=onboarded`,
      type: "account_onboarding",
    });
    return {url: link.url, accountId};
  },
);

exports.getStripeAccountStatus = onCall(
  {secrets: [stripeSecret]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const db = admin.firestore();
    const userSnap = await db.collection("users").doc(uid).get();
    const user = userSnap.exists ? userSnap.data() : {};
    if (!user.stripeAccountId) {
      return {connected: false};
    }
    const stripeClient = stripe(stripeSecret.value());
    const acct = await stripeClient.accounts.retrieve(user.stripeAccountId);
    // Cache the booleans in Firestore so the client can skip the round-trip
    // to Stripe on every page load — webhook already does this on changes,
    // this is a belt-and-suspenders sync for first-time fetches.
    await db.collection("users").doc(uid).update({
      stripeChargesEnabled: !!acct.charges_enabled,
      stripePayoutsEnabled: !!acct.payouts_enabled,
      stripeDetailsSubmitted: !!acct.details_submitted,
    }).catch(() => {});
    return {
      connected: true,
      accountId: acct.id,
      chargesEnabled: !!acct.charges_enabled,
      payoutsEnabled: !!acct.payouts_enabled,
      detailsSubmitted: !!acct.details_submitted,
      requirementsDue: (acct.requirements && acct.requirements.currently_due) || [],
    };
  },
);

// ─────────────────────────────────────────────────────────────
// refundOrder (callable)
//   Seller- or platform-initiated refund. Reverses the payment intent,
//   refunds the buyer, and reverses the application_fee proportionally
//   (Stripe handles the maths via refund_application_fee=true).
// ─────────────────────────────────────────────────────────────
exports.refundOrder = onCall(
  {secrets: [stripeSecret]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const {orderId, reason} = request.data || {};
    if (!orderId || typeof orderId !== "string") {
      throw new HttpsError("invalid-argument", "orderId required");
    }
    const db = admin.firestore();
    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found");
    }
    const order = orderSnap.data();
    // Only the seller (or platform-admin in the future) can refund.
    if (order.sellerId !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Only the seller can refund this order.");
    }
    if (order.refunded) {
      throw new HttpsError("failed-precondition", "Order is already refunded.");
    }
    const stripeClient = stripe(stripeSecret.value());
    const refund = await stripeClient.refunds.create({
      payment_intent: orderId,
      reason: ["duplicate", "fraudulent", "requested_by_customer"]
        .includes(reason) ? reason : "requested_by_customer",
      refund_application_fee: true,
      reverse_transfer: true,
    });
    await orderRef.update({
      refunded: true,
      refundId: refund.id,
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      fulfillmentStatus: "refunded",
    });
    return {refundId: refund.id, status: refund.status};
  },
);

// ─────────────────────────────────────────────────────────────
// generateListingDescription
//   Callable that asks Gemini 1.5 Flash to draft a marketplace
//   listing description from {title, brand, category, condition}.
//   - Auth required
//   - Verified-seller required (users/{uid}.isVerifiedSeller, with a
//     fallback to legacy `sellerVerified` field for older users)
//   - 30 calls/user/day rate limit, tracked at users/{uid}/aiUsage/{YYYY-MM-DD}
//   - Returns { description: <trimmed text> }
// ─────────────────────────────────────────────────────────────
exports.generateListingDescription = onCall(
  {secrets: [geminiSecret], cors: true},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in.");
    }
    const uid = request.auth.uid;
    const data = request.data || {};

    // ── Input validation ──
    const requireString = (key, max) => {
      const v = data[key];
      if (typeof v !== "string") {
        throw new HttpsError("invalid-argument", `${key} required`);
      }
      const trimmed = v.trim();
      if (!trimmed) {
        throw new HttpsError("invalid-argument", `${key} required`);
      }
      if (trimmed.length > max) {
        throw new HttpsError("invalid-argument", `${key} too long`);
      }
      return trimmed;
    };
    const title = requireString("title", 200);
    const brand = requireString("brand", 200);
    const category = requireString("category", 200);
    const condition = requireString("condition", 200);

    const db = admin.firestore();

    // ── Verified-seller gate ──
    let userSnap;
    try {
      userSnap = await db.collection("users").doc(uid).get();
    } catch (err) {
      logger.error("generateListingDescription: user lookup failed", err);
      throw new HttpsError("internal", "Could not verify seller.");
    }
    const userData = userSnap.exists ? userSnap.data() : {};
    const isVerified = !!(userData.isVerifiedSeller || userData.sellerVerified);
    if (!isVerified) {
      throw new HttpsError(
          "failed-precondition",
          "Verified sellers only.",
      );
    }

    // ── Rate limit (30/day per user) ──
    // Stored at users/{uid}/aiUsage/{YYYY-MM-DD} so it's auditable and
    // self-cleans (one tiny doc per day per user).
    const dateKey = new Date().toISOString().slice(0, 10); // UTC day
    const usageRef = db
        .collection("users").doc(uid)
        .collection("aiUsage").doc(dateKey);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(usageRef);
        const count = snap.exists ? Number(snap.data().count || 0) : 0;
        if (count >= 30) {
          throw new HttpsError("resource-exhausted", "Daily AI limit reached.");
        }
        tx.set(usageRef, {
          count: count + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      });
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("generateListingDescription: rate-limit txn failed", err);
      throw new HttpsError("internal", "Could not record AI usage.");
    }

    // ── Build prompt + call Gemini 1.5 Flash via REST ──
    const prompt =
      "Write a concise (60-100 word) marketplace listing description for " +
      "a used golf item. " +
      `Item: ${title}. Brand: ${brand}. Category: ${category}. ` +
      `Condition: ${condition}. ` +
      "Tone: confident and informative, no fluff. " +
      "Don't invent specs or features that weren't given. " +
      "Don't use emojis. Don't use 'I'/'you' — third person. " +
      "Don't include the price. Output the description only, no preamble.";

    const apiKey = geminiSecret.value();
    if (!apiKey) {
      logger.error("generateListingDescription: GEMINI_API_KEY missing");
      throw new HttpsError("internal", "AI service not configured.");
    }
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      "gemini-1.5-flash:generateContent?key=" + encodeURIComponent(apiKey);

    let aiResp;
    try {
      aiResp = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          contents: [{parts: [{text: prompt}]}],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 256,
          },
        }),
      });
    } catch (err) {
      logger.error("generateListingDescription: fetch failed", err);
      throw new HttpsError("internal", "Could not reach AI service.");
    }

    if (!aiResp.ok) {
      const body = await aiResp.text().catch(() => "");
      logger.error(
          "generateListingDescription: Gemini error",
          aiResp.status,
          body,
      );
      throw new HttpsError("internal", "AI service returned an error.");
    }

    let payload;
    try {
      payload = await aiResp.json();
    } catch (err) {
      logger.error("generateListingDescription: bad JSON", err);
      throw new HttpsError("internal", "AI service returned invalid response.");
    }

    const text =
      payload &&
      payload.candidates &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      payload.candidates[0].content.parts &&
      payload.candidates[0].content.parts[0] &&
      payload.candidates[0].content.parts[0].text;

    if (typeof text !== "string" || !text.trim()) {
      logger.error(
          "generateListingDescription: empty candidate",
          JSON.stringify(payload).slice(0, 500),
      );
      throw new HttpsError("internal", "AI service returned an empty draft.");
    }

    return {description: text.trim()};
  },
);

// ──────────────────────────────────────────────────────────────────────
// moderateListingOnCreate
//
// Server-side enforcement of the explicit-content blocklist. The client
// runs the same check before submit, but a malicious client could bypass
// it. This trigger fires when any new listing is created and removes the
// doc if the title/desc/brand contain a blocked term. We also flag
// listings that will need photo moderation (Cloud Vision SafeSearch is
// applied separately by optimizeListingPhoto on each photo upload).
// ──────────────────────────────────────────────────────────────────────
const EXPLICIT_BLOCKLIST = [
  "fuck", "shit", "asshole", "bitch", "cunt", "dick ", "pussy", "cock ",
  "tits", "tit ", "whore", "slut", "bastard", "retard", "fag", "faggot",
  "nigger", "nigga", "kike", "spic", "chink", "tranny", "dyke",
  "jizz", "blowjob", "handjob", "rimjob",
  "porn", "xxx", "nude", "nudes", "naked", "sex", "sexy", "sexual", "erotic",
  "horny", "penis", "vagina", "boobs", "boob", "nipple", "orgasm",
  "masturbat", "wank", "rape", "molest", "pedo",
  "beastiality", "bestiality", "incest",
];

function findExplicitTerm(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  for (const term of EXPLICIT_BLOCKLIST) {
    const trimmed = term.trim();
    const re = new RegExp("\\b" + trimmed + "\\b", "i");
    if (re.test(s)) return trimmed;
  }
  return null;
}

exports.moderateListingOnCreate = onDocumentCreated(
    "listings/{listingId}",
    async (event) => {
      const snap = event.data;
      if (!snap) return;
      const d = snap.data();
      const haystack = [d.title, d.brand, d.desc].filter(Boolean).join(" ");
      const term = findExplicitTerm(haystack);
      if (!term) return;

      logger.warn("moderation: blocking listing for explicit term", {
        listingId: event.params.listingId,
        sellerId: d.sellerId,
        term,
      });
      try {
        await snap.ref.delete();
      } catch (e) {
        logger.error("moderation: delete failed", e);
      }
    },
);
