const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
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
