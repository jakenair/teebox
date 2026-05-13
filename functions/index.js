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

// Sizing presets for the four common shapes — keep one source of truth
// so we can tune the whole platform at once. Values are picked to handle
// a 100x traffic spike (influencer post / viral share) without piling up
// cold-starts at the buyer/seller path.
//
//   • USER_CALLABLE — onCall shape used by signed-in users. 30s budget,
//     tight cold-start ceiling, room to scale to 100 instances.
//   • LIGHT_TRIGGER — Firestore trigger for tiny doc updates (counters,
//     fan-outs). Default memory + 60s is fine; concurrency boosted.
//   • EMAIL_TRIGGER — Firestore trigger that calls Resend / Stripe API.
//     Keep memory low but allow long timeout for retried HTTP.
//   • SCHEDULED_BATCH — onSchedule sweep that reads/writes hundreds of
//     docs. Needs more memory + a 5-min budget.
const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  concurrency: 80,
  maxInstances: 100,
};
const LIGHT_TRIGGER = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 80,
  maxInstances: 100,
};
const EMAIL_TRIGGER = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 40,
  maxInstances: 50,
};
const SCHEDULED_BATCH = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};
// Stripe recurring Price ID for the Pro Seller plan ($14.99/mo). Set via
// `firebase functions:secrets:set STRIPE_PRO_PRICE_ID` after creating the
// Product + Price in the Stripe Dashboard.
const stripeProPriceId = defineSecret("STRIPE_PRO_PRICE_ID");

// Tier-based platform fees. Free sellers pay 6.5%; Pro Seller subscribers
// ($14.99/mo) pay 3%. Break-even is ~$385/mo of GMV. Keep these in sync
// with the marketing copy in the Pro upgrade modal in index.html.
const PLATFORM_FEE_PERCENT = 0.065;
const PLATFORM_FEE_PERCENT_PRO = 0.03;
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
    // Pass checkRevoked=true so server-side revocations (logout-everywhere,
    // password reset, tier change, seller-verification) take effect on the
    // very next API call rather than waiting for the 1h ID-token TTL.
    return await admin.auth().verifyIdToken(idToken, true);
  } catch (err) {
    logger.warn("Invalid ID token:", err.message);
    return null;
  }
}

// SHA-256 prefix of an email, used in error logs to avoid leaking PII while
// still letting us trace a recurring failure to a specific account.
const emailHash = (e) => e ? require("crypto").createHash("sha256")
    .update(String(e)).digest("hex").slice(0, 12) : null;

// ─────────────────────────────────────────────────────────────
// checkRateLimit — generic per-UID rolling-window throttle.
//   Stored at users/{uid}/rateLimits/{key}. Server-only (Admin
//   SDK bypasses rules) so no Firestore rule is required.
//
//   Maintains an array of recent request timestamps within the
//   last 60s. Drops anything older, then admits or rejects based
//   on `maxPerMinute`. A Firestore transaction guards against
//   races between concurrent requests from the same UID.
//
//   Fail-open by design: if Firestore is unavailable, we log and
//   admit the request rather than break the user-facing flow
//   (e.g. checkout). Stripe idempotency + per-listing reservation
//   remain the hard correctness guarantees; this is just throttle.
//
//   Returns { ok: true } or { ok: false, retryAfterSec }.
// ─────────────────────────────────────────────────────────────
async function checkRateLimit(uid, key, maxPerMinute) {
  if (!uid || !key) return {ok: true};
  const WINDOW_MS = 60 * 1000;
  const db = admin.firestore();
  const ref = db
      .collection("users").doc(uid)
      .collection("rateLimits").doc(key);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const cutoff = now - WINDOW_MS;
      const prev = snap.exists ? (snap.data().hits || []) : [];
      // Trim and cap defensively so a buggy client can't grow the
      // array unboundedly across windows.
      const recent = prev
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > cutoff)
          .slice(-maxPerMinute * 2);
      if (recent.length >= maxPerMinute) {
        const oldest = recent[0];
        const retryAfterSec = Math.max(
            1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
        return {ok: false, retryAfterSec};
      }
      recent.push(now);
      tx.set(ref, {
        hits: recent,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      return {ok: true};
    });
  } catch (err) {
    logger.error(`checkRateLimit(${key}) failed; failing open`, err);
    return {ok: true};
  }
}

// ─────────────────────────────────────────────────────────────
// createPaymentIntent
//   - Buyer must be authenticated (Firebase ID token)
//   - Price is pulled from Firestore, never trusted from client
//   - Listing is atomically reserved before the PI is created
// ─────────────────────────────────────────────────────────────
exports.createPaymentIntent = onRequest(
  {
    secrets: [stripeSecret],
    cors: ALLOWED_ORIGINS,
    // Sizing — this is the critical hot path for revenue. Keep one warm
    // instance to eliminate cold-start checkout drop-off at peak.
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
    concurrency: 80,
    minInstances: 1,
    maxInstances: 50,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({error: "Method not allowed"});
    }

    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return res.status(401).json({error: "Not authenticated"});
    }
    // TODO(audit): wire IP + card fingerprint capture for ban evasion
    // detection (see design doc). Phase 2 — no implementation in this PR.
    // Bare-minimum block: deny a checkout from a user the admin queue
    // has banned (users/{uid}.banned == true).
    try {
      const banSnap = await admin.firestore()
          .doc(`users/${authUser.uid}`).get();
      if (banSnap.exists && banSnap.data() && banSnap.data().banned === true) {
        return res.status(403).json({error: "Account suspended"});
      }
    } catch (_e) { /* best-effort — never block legitimate checkout on Firestore hiccup */ }
    if (!authUser.email_verified) {
      return res.status(412).json({
        error: "Please verify your email before continuing.",
      });
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
      // Per-UID rate limit: 60 req / rolling 60s. Stripe idempotency
      // and the per-listing reservation already prevent double-charges,
      // but without this a buyer could hammer createPaymentIntent across
      // many listingIds (scraping pricing, locking inventory in pending,
      // burning Stripe API quota). Fail-open inside checkRateLimit so a
      // Firestore blip doesn't break checkout.
      const rl = await checkRateLimit(buyerId, "createPaymentIntent", 60);
      if (!rl.ok) {
        if (rl.retryAfterSec) {
          res.set("Retry-After", String(rl.retryAfterSec));
        }
        return res.status(429).json({
          error: "Too many checkout attempts. " +
            "Please wait a moment and try again.",
        });
      }

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
        // for legacy single-unit listings. quantityReserved tracks units
        // currently held in PI-pending state across concurrent buyers so a
        // race can't oversell — e.g. two buyers reserving the last unit
        // simultaneously. Lazy-reset: if the listing's pendingUntil window
        // has already elapsed we treat current reserved as 0 so the next
        // buyer can take over rather than wait for a sweeper.
        const totalQty = Math.max(1, Number(listing.quantity || 1));
        const soldQty = Math.max(0, Number(listing.quantitySold || 0));
        const remaining = totalQty - soldQty;
        const reservedNow = (pendingUntilMs > 0 && pendingUntilMs < now)
          ? 0
          : Math.max(0, Number(listing.quantityReserved || 0));
        if (qty + reservedNow > remaining) {
          const free = Math.max(0, remaining - reservedNow);
          throw new HttpError(
            409,
            `Only ${free} available right now — please try a smaller quantity.`
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
        const isLastUnit = (qty + reservedNow === remaining);
        const newReserved = reservedNow + qty;
        tx.update(listingRef, isLastUnit ? {
          status: "pending",
          pendingBuyer: buyerId,
          pendingUntil: admin.firestore.Timestamp.fromMillis(
            now + PENDING_WINDOW_MS
          ),
          quantityReserved: newReserved,
        } : {
          // Reserve units atomically without locking the whole listing.
          // The Stripe webhook commits the increment to quantitySold and
          // decrements quantityReserved in the same tx; here we just keep
          // the listing active.
          pendingBuyer: buyerId,
          pendingUntil: admin.firestore.Timestamp.fromMillis(
            now + PENDING_WINDOW_MS
          ),
          quantityReserved: newReserved,
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

      // Tier-aware platform fee. Pro Seller subscribers ($14.99/mo,
      // tier === 'pro') pay 3%; everyone else pays 6.5%. The tier value
      // is server-written by stripeWebhook on customer.subscription.*
      // events, so a malicious client can't fabricate it (the firestore
      // rules whitelist also blocks client writes to `tier`).
      const sellerTier = sellerData.tier === "pro" ? "pro" : "free";
      const feeRate = sellerTier === "pro"
        ? PLATFORM_FEE_PERCENT_PRO
        : PLATFORM_FEE_PERCENT;
      const platformFeeCents = Math.round(reservation.priceCents * feeRate);
      const sellerPayoutCents = reservation.priceCents - platformFeeCents;

      // Roll back the reservation: revert status if we flipped it, clear
      // pending pointers, and decrement quantityReserved by exactly the
      // qty this request added. Shared between the seller-not-onboarded
      // branch and the Stripe-API-throw catch below.
      const rollbackReservation = async () => {
        try {
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(listingRef);
            if (!snap.exists) return;
            const cur = snap.data();
            const curReserved = Math.max(
              0, Number(cur.quantityReserved || 0));
            const nextReserved = Math.max(0, curReserved - reservation.qty);
            const update = {
              pendingBuyer: admin.firestore.FieldValue.delete(),
              pendingUntil: admin.firestore.FieldValue.delete(),
              pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
              quantityReserved: nextReserved,
            };
            // Only flip status back to active if we were the ones who
            // moved it to pending (last-unit reservation).
            if (cur.status === "pending" && reservation.isLastUnit) {
              update.status = "active";
            }
            tx.update(listingRef, update);
          });
        } catch (rollbackErr) {
          logger.error("createPaymentIntent: rollback failed", rollbackErr);
        }
      };

      if (!stripeAccountId || !stripeChargesEnabled) {
        await rollbackReservation();
        return res.status(409).json({
          error: "This seller hasn't finished setting up payouts yet. " +
            "Please come back in a bit, or message them via the listing.",
        });
      }

      const stripeClient = stripe(stripeSecret.value());

      // Truncate description to Stripe's 1000-char limit, defensively.
      const description = `teebox — ${reservation.title}`.slice(0, 200);

      // Idempotency: same buyer + listing + qty + 5-minute bucket → same
      // PI. Including qty in the key matters: without it, a buyer who
      // tweaks the quantity selector and retries within 5 min would get
      // back the original PI for the wrong amount.
      const idempotencyKey = `pi_${listingId}_${buyerId}_${reservation.qty}_${Math.floor(
        Date.now() / (5 * 60 * 1000)
      )}`;

      // Stripe Connect destination charge: platform receives the funds,
      // automatically transfers (priceCents - applicationFee) to the
      // seller's connected account. Stripe handles the split — no manual
      // payouts, no holding funds on our books.
      let paymentIntent;
      try {
        paymentIntent = await stripeClient.paymentIntents.create(
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
              sellerTier,
              feeRateBps: String(Math.round(feeRate * 10000)),
            },
          },
          {idempotencyKey}
        );
      } catch (stripeErr) {
        // Stripe API blew up — we successfully reserved the listing but
        // failed to create the PI. Roll the reservation back so the
        // listing doesn't sit in pending until the sweeper cleans it.
        logger.error("createPaymentIntent: Stripe API threw", stripeErr);
        await rollbackReservation();
        throw stripeErr;
      }

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
  {
    secrets: [stripeSecret, webhookSecret],
    // Stripe retries on non-2xx, so we need fast acks even under burst.
    // High concurrency + bigger memory + tight timeout — webhook bodies
    // are small but order-creation transactions need headroom.
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
    concurrency: 200,
    maxInstances: 50,
  },
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

    // ── Event-id replay protection (H3 ordering) ──
    // We READ the marker first. If the event is already recorded
    // (ok=true or permanent=true), short-circuit. The marker WRITE
    // happens after the handler succeeds (success) or after we classify
    // as a permanent failure — never before, so a transient failure
    // doesn't leave the marker set and silently swallow the retry.
    const db = admin.firestore();
    const markerRef = db.collection("processedStripeEvents").doc(event.id);
    try {
      const markerSnap = await markerRef.get();
      if (markerSnap.exists) {
        const m = markerSnap.data() || {};
        // Either a previous success OR a recorded permanent failure —
        // both mean: don't run the handler again.
        if (m.ok === true || m.permanent === true) {
          logger.info(
            `Stripe event ${event.id} (${event.type}) already processed ` +
              `(ok=${!!m.ok} permanent=${!!m.permanent}) — skipping`,
          );
          return res.json({received: true, duplicate: true});
        }
        // Marker exists but neither flag set — legacy marker from the
        // old write-first scheme. Treat as already-processed to preserve
        // existing semantics for in-flight events.
        if (!m.ok && !m.permanent) {
          logger.info(
            `Stripe event ${event.id} (${event.type}) has legacy marker ` +
              "— skipping",
          );
          return res.json({received: true, duplicate: true});
        }
      }
    } catch (readErr) {
      // Couldn't read the marker — log and continue. Handler dedupe
      // (per-order tx etc.) still protects us; worst case is a rollup
      // counter double-counts, which is preferable to silently dropping.
      logger.error("processedStripeEvents read failed", readErr);
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
        case "payment_intent.processing":
          await handlePaymentProcessing(event.data.object);
          break;
        case "account.updated":
          // Seller's Connect status changed (finished onboarding,
          // requirement added, etc.). Mirror it into Firestore so the
          // app can gate Buy Now + show payout-status banners.
          await syncConnectAccountStatus(event.data.object);
          break;
        case "account.application.deauthorized":
          await handleAccountDeauthorized(event);
          break;
        case "charge.dispute.created":
          await handleDisputeOpened(event.data.object);
          break;
        case "charge.dispute.funds_withdrawn":
          await handleDisputeFundsWithdrawn(
              event.data.object, stripeClient);
          break;
        case "charge.dispute.funds_reinstated":
          await handleDisputeFundsReinstated(event.data.object);
          break;
        case "payout.failed":
          await handlePayoutFailed(event);
          break;
        case "identity.verification_session.verified":
        case "identity.verification_session.requires_input":
        case "identity.verification_session.canceled":
          await handleIdentitySessionUpdate(event);
          break;
        // ── Pro Seller subscription lifecycle ──
        // We listen on the subscription object directly (rather than
        // checkout.session.completed) so renewals, plan changes, and
        // cancellations all flow through one handler. Stripe's Smart
        // Retries handles dunning on payment failures — the subscription
        // stays in `past_due` (still active) for the retry window and
        // only flips to `canceled` if all retries fail.
        // H4: pass event.created for out-of-order guard inside the handler.
        case "customer.subscription.created":
        case "customer.subscription.updated":
          await handleSubscriptionUpsert(event.data.object, event.created);
          break;
        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(event.data.object, event.created);
          break;
        // H5: Pro subscription payment failure (after Smart Retries window).
        case "invoice.payment_failed": {
          const invoice = event.data.object;
          if (invoice && invoice.subscription) {
            const sub = await stripeClient.subscriptions.retrieve(
              invoice.subscription,
            );
            await handlePaymentFailed(invoice, sub, event.created);
          }
          break;
        }
        // H6: 3DS / SCA challenge required on a renewal.
        case "invoice.payment_action_required": {
          const invoice = event.data.object;
          if (invoice && invoice.subscription) {
            await handlePaymentActionRequired(invoice, event.created);
          }
          break;
        }
        // H7: subscription invoice refunded → flip user back to free.
        // We discriminate marketplace charges (handled by refundOrder
        // callable) from subscription-invoice charges via charge.invoice.
        case "charge.refunded": {
          const charge = event.data.object;
          if (charge && charge.invoice) {
            const invoice = await stripeClient.invoices.retrieve(
              charge.invoice,
            );
            if (invoice && invoice.subscription) {
              await handleSubscriptionChargeRefunded(charge, event.created);
            }
          }
          break;
        }
        default:
          logger.info(`Unhandled event type: ${event.type}`);
      }
      // H3: success — record marker AFTER handler completed. Retries on
      // *this* event id will now short-circuit at the read above.
      try {
        await markerRef.set({
          type: event.type,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          ok: true,
        });
      } catch (markerErr) {
        // Couldn't record success marker — log but don't fail the
        // response (we'd rather Stripe occasionally redeliver than
        // burn its retry budget for a marker-write failure).
        logger.error("processedStripeEvents success write failed", markerErr);
      }
      return res.json({received: true});
    } catch (err) {
      logger.error(`Error handling ${event.type}:`, err);
      // Classify the error so we don't burn Stripe's retry budget on
      // permanently-broken events. Firestore "unavailable" / "deadline
      // exceeded" are transient — return 500 so Stripe retries with
      // exponential backoff. Anything else is permanent (bad metadata,
      // unknown listing/account shape, etc.) — return 200 so Stripe
      // stops retrying. The event will still be visible in our
      // Cloud Functions logs for manual triage.
      const code = err && (err.code || err.status);
      // H2: handlers throw `err.transient = true` for "user not found
      // yet, retry me" — funnel that into the same retry path as the
      // gRPC unavailable/deadline codes.
      const transient = (err && err.transient === true) ||
        code === 14 || code === 4 ||
        code === "UNAVAILABLE" || code === "DEADLINE_EXCEEDED" ||
        code === "unavailable" || code === "deadline-exceeded" ||
        code === "internal" ||
        (typeof code === "string" && /unavailable|deadline/i.test(code));
      if (transient) {
        // H3: do NOT write the marker — we want Stripe to retry.
        return res.status(500).send("Error processing webhook (retryable)");
      }
      // H3: permanent — record marker so we don't replay forever.
      try {
        await markerRef.set({
          type: event.type,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          permanent: true,
          error: String((err && err.message) || err),
        });
      } catch (markerErr) {
        logger.error(
          "processedStripeEvents permanent write failed", markerErr);
      }
      return res.status(200).json({received: true, error: "permanent"});
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Pro Seller subscription handlers
//
// Implementation lives in ./lib/subscription so the daily smoke test
// (functions/smokeTest.js) can call the EXACT same writes the webhook
// fires — otherwise the smoke would silently drift from reality.
// See SMOKE_TEST_OPS.md for the contract.
//
// We map Stripe's customer.id → users/{uid} via the stripeCustomerId
// field stored on the user doc when createSubscriptionCheckout fires.
// The `tier` field is the source of truth for fee calculation in
// createPaymentIntent — it must only ever be written by the helpers in
// ./lib/subscription (server-side) or the firestore rules whitelist
// will catch the client.
// ─────────────────────────────────────────────────────────────
const {
  handleSubscriptionUpsert,
  handleSubscriptionDeleted,
  findUserByStripeCustomer,
  mirrorTierToProfile,
} = require("./lib/subscription");

// Local twin of lib/subscription.findUserByMetadataFallback — we need
// it here for the invoice.* + charge.refunded handlers below, which
// also need to gracefully back-fill a missing stripeCustomerId. Kept
// in sync with the lib version (intentional duplication to avoid
// reaching into the lib's private surface).
async function findUserByMetadataUidFallback(uidOrSub) {
  const fallbackUid = (typeof uidOrSub === "string") ?
    uidOrSub :
    (uidOrSub && uidOrSub.metadata && uidOrSub.metadata.firebaseUid);
  if (!fallbackUid) return null;
  const ref = admin.firestore().doc(`users/${fallbackUid}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return {id: fallbackUid, ref, data: () => snap.data()};
}

// H5: invoice.payment_failed handler — after Stripe's Smart Retries
// dunning has exhausted (or for the very first failed renewal). The
// subscription status is the source of truth for fee tier; this handler
// just stamps failure timestamps + counters so the in-app billing UI
// + subscriptionLifecycle.js triggers (email/push) have something to
// read.
async function handlePaymentFailed(invoice, sub, _eventCreatedSec) {
  if (!invoice) return;
  let userDoc = await findUserByStripeCustomer(invoice.customer);
  if (!userDoc && sub && sub.metadata && sub.metadata.firebaseUid) {
    userDoc = await findUserByMetadataUidFallback(sub.metadata.firebaseUid);
  }
  if (!userDoc) {
    const err = new Error(
      `invoice.payment_failed for unknown customer ${invoice.customer}`,
    );
    err.transient = true;
    throw err;
  }
  await userDoc.ref.set({
    proPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    proPaymentFailureCount: admin.firestore.FieldValue.increment(1),
    proLastInvoiceStatus: "payment_failed",
  }, {merge: true});
  // Best-effort in-app notification. Email / push are handled by the
  // subscriptionLifecycle.js Firestore triggers — this is just the
  // notification-bell entry.
  try {
    await writeNotification(userDoc.id, {
      type: "pro_payment_failed",
      title: "Pro Seller payment failed",
      body: "Update your payment method to keep your Pro benefits.",
      deepLink: "teebox://billing",
    });
  } catch (e) {
    logger.error("writeNotification failed (payment_failed)", e);
  }
  logger.info(
    `invoice.payment_failed → flagged ${userDoc.id} (sub=${sub && sub.id})`,
  );
}

// H6: invoice.payment_action_required handler — 3DS / SCA challenge
// needed for a renewal. Stripe will NOT retry on its own; the user
// must complete the challenge via the hosted invoice/portal URL.
async function handlePaymentActionRequired(invoice, _eventCreatedSec) {
  if (!invoice) return;
  let userDoc = await findUserByStripeCustomer(invoice.customer);
  if (!userDoc) {
    // Invoice doesn't carry subscription metadata directly; fall back
    // via customer-id only. If still missing, ask Stripe to retry.
    const err = new Error(
      `invoice.payment_action_required for unknown customer ` +
      `${invoice.customer}`,
    );
    err.transient = true;
    throw err;
  }
  await userDoc.ref.set({
    proPaymentActionRequiredAt:
      admin.firestore.FieldValue.serverTimestamp(),
    proLastInvoiceStatus: "payment_action_required",
  }, {merge: true});
  try {
    await writeNotification(userDoc.id, {
      type: "pro_payment_action_required",
      title: "Action required to renew Pro Seller",
      body: "Your bank needs you to confirm the payment. Open billing " +
        "to finish.",
      deepLink: "teebox://billing",
    });
  } catch (e) {
    logger.error("writeNotification failed (payment_action_required)", e);
  }
  logger.info(`invoice.payment_action_required → flagged ${userDoc.id}`);
}

// H7: charge.refunded for subscription invoices. A refund issued from
// the Stripe Dashboard (or by support) won't fire customer.subscription.
// deleted, so without this handler the user keeps the Pro tier despite
// having their money back. We discriminate marketplace charges in the
// outer switch (charge.invoice must be set and invoice.subscription
// must be set).
async function handleSubscriptionChargeRefunded(charge, _eventCreatedSec) {
  if (!charge) return;
  let userDoc = await findUserByStripeCustomer(charge.customer);
  if (!userDoc) {
    const err = new Error(
      `charge.refunded for unknown customer ${charge.customer}`,
    );
    err.transient = true;
    throw err;
  }
  await userDoc.ref.set({
    tier: "free",
    proSubscriptionStatus: "refunded",
    proSubscriptionRefundedAt:
      admin.firestore.FieldValue.serverTimestamp(),
    proSubscriptionUpdatedAt:
      admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  await mirrorTierToProfile(userDoc.id, false);
  try {
    await admin.auth().revokeRefreshTokens(userDoc.id);
  } catch (e) {
    logger.warn(
      `revokeRefreshTokens after refund failed for ${userDoc.id}: ${e.message}`);
  }
  logger.info(`charge.refunded → downgraded ${userDoc.id} to free`);
}

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
  const orderRef = db.collection("orders").doc(dispute.payment_intent);

  // Wrap in a tx so disputeCreatedAt is written ONCE — on the very first
  // dispute event for the order. Subsequent dispute updates (status
  // changes, additional evidence requested) re-fire the webhook and we
  // don't want to clobber the original timestamp the seller's evidence
  // deadline counter is anchored on.
  let sellerId = null;
  let listingTitle = "your listing";
  let evidenceDueByMs = null;
  try {
    const due = dispute.evidence_details && dispute.evidence_details.due_by;
    if (due) evidenceDueByMs = Number(due) * 1000;
  } catch (_e) { /* ignore */ }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    const existing = snap.exists ? snap.data() : {};
    sellerId = existing.sellerId || null;
    const update = {
      disputed: true,
      disputeId: dispute.id,
      disputeReason: dispute.reason || "",
      disputeAmountCents: dispute.amount || 0,
      disputeStatus: dispute.status || "needs_response",
    };
    if (!existing.disputeCreatedAt) {
      update.disputeCreatedAt = admin.firestore.FieldValue.serverTimestamp();
    }
    if (evidenceDueByMs) {
      update.disputeEvidenceDueBy =
          admin.firestore.Timestamp.fromMillis(evidenceDueByMs);
    }
    tx.set(orderRef, update, {merge: true});
  });

  // Pull the order doc fresh so we have sellerId + listingTitle for the
  // notification fan-out + disputes/{id} email write below. We do this
  // outside the tx to avoid the transaction having to re-read after
  // we've already written.
  let orderBuyerId = null;
  let orderListingId = null;
  if (sellerId) {
    try {
      const orderSnap = await orderRef.get();
      if (orderSnap.exists) {
        const o = orderSnap.data();
        sellerId = sellerId || o.sellerId;
        orderBuyerId = o.buyerId || null;
        orderListingId = o.listingId || null;
        if (o.listingId) {
          const lsnap = await db.collection("listings").doc(o.listingId)
              .get().catch(() => null);
          if (lsnap && lsnap.exists) {
            listingTitle = lsnap.data().title || listingTitle;
          }
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  // Notify the seller via in-app notification (push fan-out happens
  // inside writeNotification). Email is handled by the JSX dispute
  // trigger (onDisputeOpenedEmail) further down — see disputes/{id}
  // write below. We intentionally no longer send an inline-HTML email
  // from here to avoid duplicate seller emails.
  if (sellerId) {
    try {
      await writeNotification(sellerId, {
        kind: "chargeback",
        type: "chargeback",
        orderId: dispute.payment_intent,
        listingTitle,
        disputeId: dispute.id,
        reason: dispute.reason || "",
        amountCents: dispute.amount || 0,
      }).catch((e) => logger.warn("chargeback notif failed", e));
    } catch (notifyErr) {
      logger.warn(
        `handleDisputeOpened: notification fan-out failed: ${notifyErr.message}`);
    }
  }

  // Mirror the refund pattern — write disputes/{stripeDisputeId} so the
  // JSX email trigger (onDisputeOpenedEmail in emailTriggers.js) can fan
  // out to BOTH buyer + seller via DisputeOpenedBuyer.jsx /
  // DisputeOpenedSeller.jsx. Use .create() so Stripe webhook replays
  // surface as ALREADY_EXISTS and get swallowed (idempotency).
  try {
    await db.collection("disputes").doc(dispute.id).create({
      orderId: dispute.payment_intent,
      buyerId: orderBuyerId,
      sellerId: sellerId || null,
      listingId: orderListingId,
      amountCents: dispute.amount || 0,
      currency: dispute.currency || "usd",
      reason: dispute.reason || "",
      stripeDisputeId: dispute.id,
      evidenceDueBy: (dispute.evidence_details &&
          dispute.evidence_details.due_by) || null,
      status: dispute.status || "needs_response",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (writeErr) {
    const code = writeErr && (writeErr.code || writeErr.status);
    if (code === 6 || code === "already-exists" ||
        /already exists/i.test(String(writeErr && writeErr.message))) {
      logger.info(
          `handleDisputeOpened: disputes/${dispute.id} already exists — Stripe replay`);
    } else {
      logger.warn(
          `handleDisputeOpened: failed to write disputes/${dispute.id}: ${writeErr.message}`);
    }
  }

  logger.warn(`Dispute opened on order ${dispute.payment_intent}: ${dispute.reason}`);
}

// ─────────────────────────────────────────────────────────────
// handleDisputeFundsWithdrawn — Stripe pulled money back from the
// destination account to cover the chargeback. We respond by reversing
// the original transfer (with refund_application_fee=true so the seller
// — not the platform — also eats their share of the fee). The order is
// tagged with disputeFundsWithdrawn so the seller dashboard can show a
// clear "balance debited" status.
// ─────────────────────────────────────────────────────────────
async function handleDisputeFundsWithdrawn(dispute, stripeClient) {
  if (!dispute || !dispute.payment_intent) return;
  const db = admin.firestore();
  const orderRef = db.collection("orders").doc(dispute.payment_intent);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    logger.warn(
      `funds_withdrawn for unknown order ${dispute.payment_intent}`);
    return;
  }
  const order = orderSnap.data();

  let transferId = order.transferId || null;
  // Backstop: if we didn't capture the transfer id when the PI succeeded
  // (e.g. older orders, or transfer was created async), pull it from the
  // PI now via Stripe.
  if (!transferId) {
    try {
      const pi = await stripeClient.paymentIntents.retrieve(
          dispute.payment_intent, {expand: ["charges.data.transfer"]});
      const ch = pi && pi.charges && pi.charges.data && pi.charges.data[0];
      transferId = ch && ch.transfer
        ? (typeof ch.transfer === "string" ? ch.transfer : ch.transfer.id)
        : null;
    } catch (e) {
      logger.warn("funds_withdrawn: PI retrieve failed", e.message);
    }
  }

  if (!transferId) {
    logger.error(
      `funds_withdrawn: no transferId for ${dispute.payment_intent}; ` +
      "cannot reverse seller payout");
    await orderRef.set({
      disputeFundsWithdrawn: true,
      sellerDebited: false,
      disputeFundsWithdrawnAt:
        admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return;
  }

  const sellerPayoutCents = Number(order.sellerPayoutCents || 0);
  try {
    await stripeClient.transfers.createReversal(transferId, {
      amount: sellerPayoutCents > 0 ? sellerPayoutCents : undefined,
      refund_application_fee: true,
      metadata: {
        reason: "chargeback",
        disputeId: dispute.id,
      },
    });
  } catch (revErr) {
    logger.error("funds_withdrawn: transfer reversal failed", revErr);
  }

  await orderRef.set({
    disputeFundsWithdrawn: true,
    sellerDebited: true,
    disputeFundsWithdrawnAt:
      admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

// ─────────────────────────────────────────────────────────────
// handleDisputeFundsReinstated — Stripe reversed the withdrawal because
// the dispute was won. We can't undo our transfer reversal, but we
// note it on the order so the dashboard reflects reality.
// ─────────────────────────────────────────────────────────────
async function handleDisputeFundsReinstated(dispute) {
  if (!dispute || !dispute.payment_intent) return;
  const db = admin.firestore();
  await db.collection("orders").doc(dispute.payment_intent).set({
    disputeFundsReinstated: true,
    disputeFundsReinstatedAt:
      admin.firestore.FieldValue.serverTimestamp(),
    disputeStatus: dispute.status || "won",
  }, {merge: true});
  logger.info(`Dispute funds reinstated on ${dispute.payment_intent}`);
}

// ─────────────────────────────────────────────────────────────
// handlePayoutFailed — Stripe couldn't deposit to the seller's bank.
// Notify them so they can update their account before the next attempt.
// ─────────────────────────────────────────────────────────────
async function handlePayoutFailed(event) {
  const accountId = event && event.account;
  const payout = event && event.data && event.data.object;
  if (!accountId || !payout) return;
  const db = admin.firestore();
  const usersSnap = await db.collection("users")
      .where("stripeAccountId", "==", accountId).limit(1).get();
  if (usersSnap.empty) {
    logger.warn(`payout.failed for unknown account ${accountId}`);
    return;
  }
  const uid = usersSnap.docs[0].id;
  const amountCents = Number(payout.amount || 0);
  const failureMsg = payout.failure_message ||
      payout.failure_code || "unknown reason";
  await writeNotification(uid, {
    kind: "payout_failed",
    type: "payout_failed",
    amountCents,
    failureMessage: failureMsg,
    payoutId: payout.id || null,
  }).catch((e) => logger.warn("payout_failed notif failed", e));

  try {
    const seller = await lookupUser(uid);
    if (seller && seller.email) {
      const body = `<p>Stripe couldn't deposit
        <strong>$${(amountCents / 100).toFixed(2)}</strong> into your bank
        account.</p>
        <p><strong>Reason:</strong> ${failureMsg}</p>
        <p>Open your Stripe Dashboard to update your bank account and
        retry the payout.</p>`;
      await sendEmail({
        to: seller.email,
        subject: "Payout failed — action required",
        html: emailShell(
            "Payout failed", body, "Open Stripe Dashboard",
            "https://dashboard.stripe.com/payouts"),
      });
    }
  } catch (e) {
    logger.warn("payout_failed: email fan-out failed", e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// handleAccountDeauthorized — seller disconnected the Stripe Connect
// account from our platform (e.g. via Stripe Dashboard). Clear their
// payouts state so the buy flow refuses to charge buyers for items
// the seller can no longer get paid for.
// ─────────────────────────────────────────────────────────────
async function handleAccountDeauthorized(event) {
  const accountId = event && (event.account ||
      (event.data && event.data.object && event.data.object.id));
  if (!accountId) return;
  const db = admin.firestore();
  const usersSnap = await db.collection("users")
      .where("stripeAccountId", "==", accountId).limit(1).get();
  if (usersSnap.empty) {
    logger.warn(`account.deauthorized for unknown account ${accountId}`);
    return;
  }
  const ref = usersSnap.docs[0].ref;
  await ref.update({
    stripeAccountId: admin.firestore.FieldValue.delete(),
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    stripeDetailsSubmitted: false,
    stripeAccountDeauthorizedAt:
      admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`Cleared Connect state for ${usersSnap.docs[0].id} ` +
    `(account ${accountId} deauthorized)`);
}

// ─────────────────────────────────────────────────────────────
// handlePaymentProcessing — ACH / SEPA / wallet redirects can sit in
// `processing` for hours-to-days before settling. Record a placeholder
// pendingOrder so the listing stays reserved during that window and we
// don't trigger releaseListingOnFailure if the PI never reaches a
// terminal failure event.
// ─────────────────────────────────────────────────────────────
async function handlePaymentProcessing(pi) {
  if (!pi || !pi.id) return;
  const db = admin.firestore();
  const {listingId, buyerId, sellerId} = pi.metadata || {};
  const amountCents = Number(pi.amount || 0);
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
  const pendingUntilMs = Date.now() + TEN_DAYS_MS;
  await db.collection("pendingOrders").doc(pi.id).set({
    paymentIntentId: pi.id,
    listingId: listingId || null,
    buyerId: buyerId || null,
    sellerId: sellerId || null,
    amountCents,
    processingStartedAt:
      admin.firestore.FieldValue.serverTimestamp(),
    pendingUntil:
      admin.firestore.Timestamp.fromMillis(pendingUntilMs),
  }, {merge: true});
  if (listingId) {
    try {
      await db.collection("listings").doc(listingId).set({
        pendingUntil:
          admin.firestore.Timestamp.fromMillis(pendingUntilMs),
      }, {merge: true});
    } catch (e) {
      logger.warn("payment.processing: listing extend failed", e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// handleIdentitySessionUpdate — Stripe Identity verification finished,
// needs more input, or was canceled. Flip the corresponding flags on
// users/{uid} so the app can gate identity-required surfaces.
// ─────────────────────────────────────────────────────────────
async function handleIdentitySessionUpdate(event) {
  const obj = event && event.data && event.data.object;
  if (!obj) return;
  const uid = obj.metadata && obj.metadata.uid;
  if (!uid) {
    logger.warn(
      `identity event ${event.type} missing metadata.uid`);
    return;
  }
  const db = admin.firestore();
  const update = {
    identityUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (event.type === "identity.verification_session.verified") {
    update.identityVerified = true;
    update.identityPending = false;
    update.identityVerifiedAt =
      admin.firestore.FieldValue.serverTimestamp();
  } else if (event.type === "identity.verification_session.requires_input") {
    update.identityVerified = false;
    update.identityPending = true;
    update.identityRequiresInput = true;
  } else if (event.type === "identity.verification_session.canceled") {
    update.identityVerified = false;
    update.identityPending = false;
    update.identityCanceledAt =
      admin.firestore.FieldValue.serverTimestamp();
  }
  await db.collection("users").doc(uid).set(update, {merge: true});
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

  // Capture the destination-charge transferId so charge.dispute.
  // funds_withdrawn can reverse it without a round-trip back to Stripe.
  // PI shape: pi.charges.data[0].transfer is the Connect transfer object
  // (or its id string, depending on expand state).
  let transferId = null;
  try {
    const ch = pi && pi.charges && pi.charges.data && pi.charges.data[0];
    if (ch && ch.transfer) {
      transferId = typeof ch.transfer === "string"
        ? ch.transfer
        : ch.transfer.id || null;
    }
  } catch (_e) { /* tolerate missing fields */ }

  const orderRef = db.collection("orders").doc(pi.id);
  const listingRef = listingId
    ? db.collection("listings").doc(listingId)
    : null;

  // alreadyProcessed flag lets us skip the priceHistory + globalStats
  // rollups below when the order doc already existed — without this,
  // a webhook redelivery would double-count GMV on the homepage and
  // append a duplicate sale to the model's sparkline.
  let alreadyProcessed = false;

  await db.runTransaction(async (tx) => {
    const [existingOrder, listingSnap] = await Promise.all([
      tx.get(orderRef),
      listingRef ? tx.get(listingRef) : Promise.resolve(null),
    ]);

    if (existingOrder.exists) {
      logger.info(`Order ${pi.id} already processed, skipping`);
      alreadyProcessed = true;
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
      transferId: transferId || null,
      // Buyer's shipping destination from Stripe AddressElement.
      // Without this the seller has no way to know where to ship —
      // previously the field was never written and the Sold-tab Ship-To
      // column always rendered "—". (Launch blocker fix.)
      shipping: pi.shipping || null,
      receiptEmail: pi.receipt_email || null,
      status: "paid",
      fulfillmentStatus: "awaiting_seller_shipment",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (listingSnap && listingSnap.exists) {
      const listing = listingSnap.data();
      const totalQty = Math.max(1, Number(listing.quantity || 1));
      const newSold = Math.max(0, Number(listing.quantitySold || 0)) + orderQty;
      const fullySold = newSold >= totalQty;
      // Decrement quantityReserved by exactly the orderQty that this PI
      // had reserved, clamped at 0. Increment quantitySold in the same
      // tx so the two counters never drift.
      const curReserved = Math.max(
          0, Number(listing.quantityReserved || 0));
      const nextReserved = Math.max(0, curReserved - orderQty);
      tx.update(listingRef, fullySold ? {
        status: "sold",
        quantitySold: newSold,
        quantityReserved: nextReserved,
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
        quantityReserved: nextReserved,
        pendingBuyer: admin.firestore.FieldValue.delete(),
        pendingUntil: admin.firestore.FieldValue.delete(),
        pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      });
    } else if (listingId) {
      logger.warn(`Listing ${listingId} not found for order ${pi.id}`);
    }
  });

  // Early-out on redelivery so we never double-count rollups.
  if (alreadyProcessed) return;

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

  // Denormalized homepage stats — `globalStats/all` is a single doc the
  // homepage reads with one getDoc() instead of scanning priceHistory.
  // Atomic increment so concurrent webhook deliveries don't lose writes.
  // Best-effort, non-fatal: a failure here can't block order recording.
  try {
    await db.collection("globalStats").doc("all").set(
      {
        totalGmvCents: admin.firestore.FieldValue.increment(pi.amount),
        totalSold: admin.firestore.FieldValue.increment(1),
        lastSaleAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true}
    );
  } catch (err) {
    logger.warn("globalStats bump failed:", err.message);
  }

  logger.info(`Order ${pi.id} recorded for listing ${listingId}`);
}

async function releaseListingOnFailure(pi) {
  const db = admin.firestore();
  const {listingId, quantity} = pi.metadata || {};
  if (!listingId) return;
  const releasedQty = Math.max(1, parseInt(quantity || "1", 10));

  const listingRef = db.collection("listings").doc(listingId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(listingRef);
    if (!snap.exists) return;
    const listing = snap.data();

    const matchesThisPI = listing.pendingPaymentIntentId === pi.id;
    const isPending = listing.status === "pending";
    // We decrement quantityReserved whenever this PI matches even on
    // multi-stock listings that stayed `active` — otherwise concurrent
    // buyers would see stale reservation counts. Clamp at 0 so a
    // double-fired failure event can't drag it negative.
    const curReserved = Math.max(
        0, Number(listing.quantityReserved || 0));
    const nextReserved = Math.max(0, curReserved - releasedQty);

    if (isPending && matchesThisPI) {
      tx.update(listingRef, {
        status: "active",
        quantityReserved: nextReserved,
        pendingBuyer: admin.firestore.FieldValue.delete(),
        pendingUntil: admin.firestore.FieldValue.delete(),
        pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      });
      logger.info(`Released listing ${listingId} after PI ${pi.id} failed`);
    } else if (matchesThisPI) {
      // Multi-stock listing stayed active — just unwind the reservation.
      tx.update(listingRef, {
        quantityReserved: nextReserved,
        pendingBuyer: admin.firestore.FieldValue.delete(),
        pendingUntil: admin.firestore.FieldValue.delete(),
        pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      });
    } else if (curReserved > 0 && listing.pendingPaymentIntentId == null) {
      // Stale reservation cleanup edge-case: no PI pointer but reserved
      // count > 0. Best-effort decrement so we don't leak units.
      tx.update(listingRef, {
        quantityReserved: nextReserved,
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// expireListings (scheduled, daily 03:00 America/Chicago)
//   Flips active listings whose expiresAt < now to status='expired'.
//   Sellers can renew from their dashboard.
// ─────────────────────────────────────────────────────────────
exports.expireListings = onSchedule(
  {
    schedule: "every day 03:00",
    timeZone: "America/Chicago",
    // Batch can read up to 500 listings + write them — give it room.
    memory: "512MiB",
    timeoutSeconds: 300,
  },
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
exports.moderateImage = onCall({...USER_CALLABLE, memory: "512MiB"}, async (request) => {
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
//       from: "TeeBox <noreply@mail.teeboxmarket.com>",
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
exports.requestSellerVerification = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  if (!request.auth.token || !request.auth.token.email_verified) {
    throw new HttpsError(
      "failed-precondition",
      "Please verify your email before continuing.");
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

  // Revoke refresh tokens so the seller-verified state propagates
  // immediately on the next API call (otherwise the listing-create
  // rules check would block until the existing ID token expires).
  try {
    await admin.auth().revokeRefreshTokens(uid);
  } catch (e) {
    logger.warn(
      `revokeRefreshTokens after sellerVerified failed for ${uid}: ${e.message}`);
  }

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
exports.deleteUserAccount = onCall({
  ...USER_CALLABLE,
  timeoutSeconds: 300,
  secrets: [stripeSecret],
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();

  // ── 1. Mark all the seller's listings as removed. Page through with
  // a cursor so we don't silently truncate at 400 like the old code did
  // — power sellers can have hundreds of listings.
  const LISTINGS_PAGE = 400;
  let listingsCursor = null;
  let listingsTouched = 0;
  while (true) {
    let q = db.collection("listings")
      .where("sellerId", "==", uid)
      .orderBy("__name__")
      .limit(LISTINGS_PAGE);
    if (listingsCursor) q = q.startAfter(listingsCursor);
    const snap = await q.get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.forEach((doc) => {
      batch.update(doc.ref, {
        status: "removed",
        removedAt: now,
        removedReason: "seller_account_deleted",
      });
    });
    await batch.commit();
    listingsTouched += snap.size;
    if (snap.size < LISTINGS_PAGE) break;
    listingsCursor = snap.docs[snap.docs.length - 1];
  }

  // ── 2. Recursively delete user-owned subcollections. These hold PII
  // (saved searches, FCM tokens, watchlist, notifications, rate limits)
  // that we shouldn't keep around after a deletion request.
  const deleteSubcollection = async (path) => {
    const PAGE = 500;
    while (true) {
      const snap = await db.collection(path).limit(PAGE).get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < PAGE) return;
    }
  };
  const subcollections = [
    "watchlist",
    "savedSearches",
    "fcmTokens",
    "notifications",
    "rateLimits",
  ];
  for (const sub of subcollections) {
    try {
      await deleteSubcollection(`users/${uid}/${sub}`);
    } catch (e) {
      logger.warn(`deleteUserAccount: ${sub} sweep failed: ${e.message}`);
    }
  }

  // ── 3. Storage prefixes — wipe listing photos + avatars for this UID.
  // Stripping these lets us free bucket cost and honor the data-deletion
  // request. We don't fail-stop on bucket errors (e.g. wrong project) —
  // the auth deletion below is the user-visible "done" signal.
  try {
    const bucket = admin.storage().bucket();
    await bucket.deleteFiles({prefix: `listings/${uid}/`})
        .catch((e) => logger.warn(`listings/${uid}/ wipe failed`, e.message));
    await bucket.deleteFiles({prefix: `avatars/${uid}/`})
        .catch((e) => logger.warn(`avatars/${uid}/ wipe failed`, e.message));
  } catch (e) {
    logger.warn(`deleteUserAccount: Storage sweep failed: ${e.message}`);
  }

  // ── 4. Pull the user doc so we can grab Stripe ids before clearing.
  let userSnap;
  try {
    userSnap = await db.doc(`users/${uid}`).get();
  } catch (_e) { userSnap = null; }
  const userData = (userSnap && userSnap.exists) ? userSnap.data() : {};

  // ── 5. Stripe customer + subscription teardown. Best-effort: Stripe
  // refuses to delete accounts with balance/dispute history, and we
  // don't want that to block the user's account deletion request.
  if (userData.stripeCustomerId) {
    try {
      const stripeClient = stripe(stripeSecret.value());
      // Cancel any active subscriptions first — `customers.del` returns
      // success even if subs are still active, but they keep billing,
      // which we never want.
      try {
        const subs = await stripeClient.subscriptions.list({
          customer: userData.stripeCustomerId,
          status: "all",
          limit: 20,
        });
        for (const s of (subs.data || [])) {
          if (s.status === "active" || s.status === "trialing" ||
              s.status === "past_due" || s.status === "unpaid") {
            await stripeClient.subscriptions.cancel(s.id)
                .catch((e) => logger.warn(
                    `subs.cancel ${s.id} failed`, e.message));
          }
        }
      } catch (e) {
        logger.warn(
            `deleteUserAccount: subs.list failed: ${e.message}`);
      }
      await stripeClient.customers.del(userData.stripeCustomerId)
          .catch((e) => logger.warn(
              `customers.del ${userData.stripeCustomerId} failed`,
              e.message));
    } catch (e) {
      logger.warn(`deleteUserAccount: Stripe customer teardown ${e.message}`);
    }
  }

  if (userData.stripeAccountId) {
    try {
      const stripeClient = stripe(stripeSecret.value());
      await stripeClient.accounts.del(userData.stripeAccountId)
          .catch((e) => logger.warn(
              `accounts.del ${userData.stripeAccountId} failed`,
              e.message));
    } catch (e) {
      logger.warn(`deleteUserAccount: Stripe account teardown ${e.message}`);
    }
  }

  // ── 6. Anonymize the public profile. We keep the doc rather than
  // deleting it so order/dispute history rendered on the other party's
  // side still resolves (the listing renders "Deleted user").
  // NOTE: Skipping message anonymization (would damage marketplace
  // trust + delete legitimate conversation history). Display name is
  // shown as "Deleted user" anywhere their handle would normally appear.
  await db.doc(`profiles/${uid}`).set({
    displayName: "Deleted user",
    bio: "",
    location: "",
    handicap: null,
    avatarUrl: null,
    deleted: true,
    deletedAt: now,
  }, {merge: true});

  // ── 7. Clear the private user doc. We zero out Stripe references and
  // tier as well as the existing fields so a future Auth-record re-use
  // (same uid in a new sign-up) can't inherit stale Connect/customer
  // state from the deleted account.
  await db.doc(`users/${uid}`).set({
    phone: null,
    displayName: "Deleted user",
    deleted: true,
    deletedAt: now,
    sellerVerified: false,
    stripeCustomerId: admin.firestore.FieldValue.delete(),
    stripeAccountId: admin.firestore.FieldValue.delete(),
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    stripeDetailsSubmitted: false,
    tier: "free",
    watchlist: admin.firestore.FieldValue.delete(),
    blocked: admin.firestore.FieldValue.delete(),
  }, {merge: true});

  // ── 8. Finally delete the Auth record. This frees the phone number
  // and signs the user out everywhere.
  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    logger.warn(`Auth delete failed for ${uid}: ${err.message}`);
    throw new HttpsError("internal", "Could not finalize account deletion");
  }

  logger.info(
    `User account ${uid} deleted at user request ` +
    `(listings=${listingsTouched})`);
  return {deleted: true, listingsRemoved: listingsTouched};
});

// ─────────────────────────────────────────────────────────────
// exchangeIdTokenForCustomToken
//   Bridges native iOS OAuth (Google / Apple via the Capacitor
//   @capacitor-firebase/authentication plugin) to the Firebase JS
//   SDK auth instance running inside the WKWebView.
//
//   Why we don't just call signInWithCredential() on the client:
//   on iOS WKWebView the JS-SDK's signInWithCredential() path hangs
//   indefinitely at the identitytoolkit accounts:signInWithIdp call
//   (confirmed at G5/A5 across Builds 40-45 even after switching
//   to inMemoryPersistence). signInWithCustomToken() uses a different
//   identitytoolkit endpoint (accounts:signInWithCustomToken) which
//   does NOT hang in WKWebView. So we mint a custom token server-side
//   and the client signs in with that.
//
//   Inputs (callable):
//     { idToken, providerId, rawNonce? }
//       providerId: 'google.com' | 'apple.com'
//       rawNonce:   required for Apple (the un-hashed nonce that the
//                   plugin generated; Apple's id_token includes the
//                   SHA-256 hash of it in the `nonce` claim)
//
//   Verification:
//     - Google: google-auth-library.OAuth2Client.verifyIdToken with
//       the iOS OAuth client_id as audience.
//     - Apple: fetch JWKS from https://appleid.apple.com/auth/keys,
//       jwt-verify with issuer = https://appleid.apple.com and
//       audience = the iOS bundle ID (com.teeboxmarket.app). If
//       rawNonce is provided, also confirm sha256(rawNonce) == nonce.
//
//   Then look up (or create) a Firebase Auth user keyed off the
//   verified email + provider sub, and mint a custom token.
//
//   Rate limit: 20 exchanges/min/sub (per OAuth subject id) — generous
//   enough that retries on flaky networks don't trip it, but tight
//   enough that a stolen idToken can't be replayed thousands of times.
// ─────────────────────────────────────────────────────────────

// iOS GoogleSignIn client ID (from ios/App/App/GoogleService-Info.plist).
// Tokens minted by the Capacitor plugin's native Google flow have this
// value in `aud`. Hard-coded rather than secret — these are public
// identifiers, like the firebaseConfig in index.html.
const IOS_GOOGLE_CLIENT_ID =
    "982122063122-1pjjhvrnpcqhfvaumi9hlmvtsgnlm8kb.apps.googleusercontent.com";
// Web Auth client ID used by the Firebase JS SDK when running in a
// browser. Accept both audiences so the same Cloud Function can serve
// the (currently unused) web-side bridge if we ever need it.
const WEB_GOOGLE_CLIENT_ID =
    "982122063122-web.apps.googleusercontent.com"; // placeholder; web flow uses popup
// Apple audience = iOS bundle id.
const APPLE_BUNDLE_ID = "com.teeboxmarket.app";
// Lazy singletons — instantiated on first call so cold-start cost
// only hits the first auth attempt, not unrelated requests.
let _googleAuthClient = null;
let _appleJwks = null;

async function _verifyGoogleIdToken(idToken) {
  const {OAuth2Client} = require("google-auth-library");
  if (!_googleAuthClient) _googleAuthClient = new OAuth2Client();
  const ticket = await _googleAuthClient.verifyIdToken({
    idToken,
    audience: [IOS_GOOGLE_CLIENT_ID, WEB_GOOGLE_CLIENT_ID],
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new HttpsError("unauthenticated", "Google token has no sub");
  }
  return {
    sub: payload.sub,
    email: payload.email || null,
    emailVerified: payload.email_verified === true,
    name: payload.name || null,
  };
}

async function _verifyAppleIdToken(idToken, rawNonce) {
  const jose = require("jose");
  const crypto = require("crypto");
  if (!_appleJwks) {
    _appleJwks = jose.createRemoteJWKSet(
        new URL("https://appleid.apple.com/auth/keys"),
    );
  }
  const {payload} = await jose.jwtVerify(idToken, _appleJwks, {
    issuer: "https://appleid.apple.com",
    audience: APPLE_BUNDLE_ID,
  });
  if (!payload || !payload.sub) {
    throw new HttpsError("unauthenticated", "Apple token has no sub");
  }
  // Apple's `nonce` claim is SHA-256(rawNonce) base64url-encoded
  // (Firebase's plugin hashes it before passing to ASAuthorization).
  // Tightened: always verify when Apple included a nonce in the token,
  // even if the client didn't pass us a rawNonce. The previous gate
  // `rawNonce && payload.nonce` skipped the check whenever the client
  // omitted rawNonce, defeating Apple's replay protection.
  if (payload.nonce) {
    if (!rawNonce || typeof rawNonce !== "string") {
      throw new HttpsError(
        "unauthenticated",
        "Apple sign-in requires a rawNonce when the id_token has one.");
    }
    const hashed = crypto
        .createHash("sha256")
        .update(String(rawNonce))
        .digest("hex");
    // Apple may return either the hex hash or the base64url-encoded
    // hash depending on SDK version — accept both shapes.
    const hashedB64 = crypto
        .createHash("sha256")
        .update(String(rawNonce))
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    if (payload.nonce !== hashed && payload.nonce !== hashedB64) {
      logger.warn("Apple nonce mismatch", {
        claimed: payload.nonce,
        expectedHex: hashed,
      });
      throw new HttpsError("unauthenticated", "Apple nonce mismatch");
    }
  }
  return {
    sub: payload.sub,
    email: payload.email || null,
    emailVerified: payload.email_verified === true ||
        payload.email_verified === "true",
    name: null, // Apple only returns name on first sign-in via separate field
  };
}

async function _findOrCreateUser(provider, verified) {
  const auth = admin.auth();
  // 1. Try to find by email first — email is the natural primary key.
  //    SECURITY: Only fuse accounts when the incoming provider matches
  //    one of the providers already on file. Otherwise an attacker who
  //    controls an Apple/Google account for someone else's email could
  //    take over their existing password account just by signing in.
  //    Force the user to sign in with the original method first and
  //    explicitly link the new provider from settings.
  if (verified.email) {
    try {
      const existing = await auth.getUserByEmail(verified.email);
      const matches = (existing.providerData || []).some(
          (p) => p && p.providerId === provider);
      if (!matches) {
        throw new HttpsError(
          "already-exists",
          "This email is registered with a different sign-in method. " +
          "Sign in with that method first, then link this provider " +
          "from settings.");
      }
      return existing.uid;
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      if (err.code !== "auth/user-not-found") throw err;
    }
  }
  // 2. Fall back to provider:sub (deterministic UID so repeat sign-ins
  //    without an email — e.g. Apple "Hide My Email" later revoked —
  //    still land on the same account).
  const synthUid = `${provider.replace(".", "_")}_${verified.sub}`.slice(0, 128);
  try {
    const existing = await auth.getUser(synthUid);
    return existing.uid;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  // 3. Create.
  const created = await auth.createUser({
    uid: synthUid,
    email: verified.email || undefined,
    emailVerified: verified.emailVerified,
    displayName: verified.name || undefined,
  });
  return created.uid;
}

exports.exchangeIdTokenForCustomToken = onCall(
    {...USER_CALLABLE},
    async (request) => {
      const idToken = request.data && request.data.idToken;
      const providerId = request.data && request.data.providerId;
      const rawNonce = request.data && request.data.rawNonce;
      if (!idToken || typeof idToken !== "string") {
        throw new HttpsError("invalid-argument", "idToken required");
      }
      if (providerId !== "google.com" && providerId !== "apple.com") {
        throw new HttpsError(
            "invalid-argument",
            "providerId must be google.com or apple.com",
        );
      }
      // Apple replay protection — force the client to send the raw
      // nonce that was hashed into the id_token. Without it,
      // _verifyAppleIdToken can't verify and we'd be accepting any
      // valid-shape Apple token (incl. replays from another app).
      if (providerId === "apple.com") {
        if (typeof rawNonce !== "string" || !rawNonce) {
          throw new HttpsError(
              "invalid-argument",
              "rawNonce required for Apple sign-in",
          );
        }
      }
      let verified;
      try {
        if (providerId === "google.com") {
          verified = await _verifyGoogleIdToken(idToken);
        } else {
          verified = await _verifyAppleIdToken(idToken, rawNonce);
        }
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        logger.warn(`Token exchange — bad ${providerId} idToken: ${err.message}`);
        throw new HttpsError("unauthenticated", "Invalid ID token");
      }

      // Rate limit replays on the same OAuth subject. We use the verified
      // sub as the synthetic "uid" key so this works pre-Firebase-auth.
      // 20/min is generous (network retries, etc) but stops a leaked token
      // from being replayed indefinitely.
      const rlKey = `${providerId}:${verified.sub}`.slice(0, 100);
      const rl = await checkRateLimit(`oauth_${rlKey}`, "exchangeIdToken", 20);
      if (!rl.ok) {
        throw new HttpsError(
            "resource-exhausted",
            "Too many sign-in attempts. Please wait a moment and try again.",
        );
      }

      let uid;
      try {
        uid = await _findOrCreateUser(providerId, verified);
      } catch (err) {
        // Propagate the explicit "already-exists" pre-takeover error so
        // the client can show the right "sign in with the other method"
        // copy. Anything else gets bucketed as internal.
        if (err instanceof HttpsError) throw err;
        logger.error("exchangeIdTokenForCustomToken: _findOrCreateUser failed", {
          providerId,
          sub: verified && verified.sub,
          // Email PII redacted to a short SHA-256 prefix so the log is
          // still useful for grouping duplicate failures without
          // exposing the user's address.
          emailHash: emailHash(verified && verified.email),
          errCode: err && err.code,
          errMessage: err && err.message,
          errStack: err && err.stack,
        });
        throw new HttpsError(
            "internal",
            `findOrCreateUser: ${err && err.message ? err.message : "unknown"}`,
        );
      }
      const additionalClaims = {};
      // Note: do NOT include `email` in additional claims — it's a reserved
      // Firebase JWT claim and `createCustomToken` will reject it.
      try {
        const customToken = await admin.auth().createCustomToken(
            uid, additionalClaims,
        );
        return {customToken};
      } catch (err) {
        logger.error("exchangeIdTokenForCustomToken: createCustomToken failed", {
          uid,
          errCode: err && err.code,
          errMessage: err && err.message,
          errStack: err && err.stack,
        });
        throw new HttpsError(
            "internal",
            `createCustomToken: ${err && err.message ? err.message : "unknown"}`,
        );
      }
    },
);

// ─────────────────────────────────────────────────────────────
// onReviewCreated (Firestore trigger)
//   When a buyer leaves a review at reviews/{orderId}, recompute
//   seller aggregates (count, avg rating, 5-star %) on the
//   seller's public profile so listing/profile cards can render
//   them without an N+1 read.
// ─────────────────────────────────────────────────────────────
exports.onReviewCreated = onDocumentCreated(
  {document: "reviews/{orderId}", ...LIGHT_TRIGGER},
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

      // Cap the rollup at 1000 reviews — past that the average is statistically
      // stable and the function is just paying for cold storage reads. If a
      // seller crosses this we'll switch to an incremental counter.
      const db = admin.firestore();
      const snap = await db
        .collection("reviews")
        .where("sellerId", "==", sellerId)
        .limit(1000)
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
//   Bumps a sharded counter on listings/{listingId} (fields
//   views_0..views_9), throttled to one count per user per
//   listing per 24h via a marker doc in listingViews. Returns
//   the fresh total so the caller can render it.
//
//   Sharding rationale (SCALING_AUDIT #2): a single document
//   field is capped at ~1 sustained write/sec by Firestore.
//   On a viral listing that ceiling caused contention/staleness.
//   Spreading writes across 10 random shard fields lifts the
//   effective ceiling to ~10 writes/sec/listing.
//
//   Document shape:
//     listings/{id}.views_0 .. views_9  (number, server-owned)
//     listings/{id}.views                (legacy — pre-shard
//       counter; still readable. New writes never touch it, and
//       the read path treats it as an additional shard for
//       backward compat. No migration required.)
//     listings/{id}.lastViewedAt         (server timestamp)
// ─────────────────────────────────────────────────────────────
// High-frequency callable — every product detail view fires this. Bump
// concurrency so a single instance can soak up the bursts.
const VIEW_SHARD_COUNT = 10;
exports.incrementListingView = onCall(
  {...USER_CALLABLE, concurrency: 200, timeoutSeconds: 15},
  async (request) => {
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
      // Pick a random shard so concurrent viewers spread their
      // writes across 10 fields instead of contending on one.
      const shard = Math.floor(Math.random() * VIEW_SHARD_COUNT);
      await listingRef.update({
        [`views_${shard}`]: admin.firestore.FieldValue.increment(1),
        lastViewedAt: admin.firestore.FieldValue.serverTimestamp(),
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

    // Sum the shards (plus the legacy `views` field, if present)
    // so the caller renders the correct total even on listings
    // that still hold pre-shard counts.
    const fresh = await listingRef.get();
    let views = 0;
    if (fresh.exists) {
      const d = fresh.data() || {};
      views = Number(d.views) || 0;
      for (let i = 0; i < VIEW_SHARD_COUNT; i++) {
        views += Number(d[`views_${i}`]) || 0;
      }
    }
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
  {document: "conversations/{cid}/messages/{messageId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const msg = event.data && event.data.data();
      if (!msg) return;

      const db = admin.firestore();
      let listingId = msg.listingId || null;
      let sellerId = msg.sellerId || null;

      // Fall back to the parent conversation doc if the message
      // doesn't carry the listingId/sellerId itself. The client only
      // writes {senderId, text, createdAt} on each message — the
      // conversation doc holds participants/listingId/sellerId.
      const conversationId = event.params.cid || msg.conversationId;
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
// moderateMessage (Firestore trigger)
//   Authoritative server-side re-scan of every new chat message
//   for off-platform / PII content. Client runs the same detector
//   for UX (confirm-before-send) but anything written here is what
//   actually drives the inbound interstitial + risk-score counters.
//
//   On a HARD match:
//     • writes messageFlags/{messageId} (admin-only read via rules)
//     • increments users/{senderId}.offPlatformFlags
//     • increments users/{recipientId}.offPlatformSoftFlags
//     • increments conversations/{cid}.flaggedMessageCount
//     • patches the message doc with {flagged: {severity, types[]}}
//       so the client renders the warning on next snapshot.
//
//   v1 is regex + keyword only (deterministic, no per-message cost).
//   TODO: enable Gemini classifier in v2 for ambiguous SOFT-only hits;
//   gate by users/{uid}.modLlmCallsToday = {date, n} at 100/day/user.
// ─────────────────────────────────────────────────────────────
const MOD_OFF_PLATFORM_REGEXES = [
  {name: "phone_us", severity: "HARD",
    re: /(?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/},
  {name: "email", severity: "HARD",
    re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/},
  {name: "messaging_url", severity: "HARD",
    re: /\b(?:wa\.me|t\.me|signal\.me|m\.me|bit\.ly|tinyurl\.com)\/\S+/i},
  {name: "external_marketplace", severity: "HARD",
    re: /\b(?:ebay|mercari|grailed|golfwrx|facebook ?marketplace|fb ?marketplace|craigslist|offerup|poshmark|depop)\b/i},
  {name: "cashtag", severity: "HARD",
    re: /(?:^|\s)\$[a-zA-Z][a-zA-Z0-9_]{2,15}\b/},
];
const MOD_OFF_PLATFORM_KEYWORDS_HARD = [
  "venmo", "zelle", "cashapp", "cash app", "paypal", "apple pay", "google pay", "gpay",
  "wire transfer", "western union", "moneygram", "chime",
  "btc", "bitcoin", "ethereum", "usdc", "crypto",
  "f&f", "friends and family", "f and f", "no g&s", "no goods and services",
  "text me at", "call me at", "signal me",
  "whatsapp", "telegram", "wa.me", "t.me",
  "outside teebox", "outside the app", "off the app", "off platform", "off-platform",
  "save the fee", "save fees", "skip the fee", "cut the fee", "no fees",
  "avoid the fee", "direct deal", "skip the platform", "pay outside", "cash only",
  "dm me directly", "take this off teebox", "take this off the app",
];
const MOD_OFF_PLATFORM_KEYWORDS_SOFT = [
  "instagram", "ig:", "insta:", "discord",
  "meet in person", "meet up", "come pick up", "local pickup",
];

function modEscapeKw(k) {
  return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modDetectOffPlatform(text) {
  if (!text) return {matched: false, severity: null, types: [], patterns: []};
  const s = String(text);
  const lc = s.toLowerCase();
  const patterns = [];
  const types = new Set();
  let severity = null;
  for (const p of MOD_OFF_PLATFORM_REGEXES) {
    const m = s.match(p.re);
    if (m) {
      patterns.push({type: "regex", name: p.name, match: m[0].slice(0, 80)});
      types.add(p.name);
      if (p.severity === "HARD") severity = "HARD";
      else if (!severity) severity = "SOFT";
    }
  }
  for (const kw of MOD_OFF_PLATFORM_KEYWORDS_HARD) {
    if (new RegExp("\\b" + modEscapeKw(kw) + "\\b", "i").test(lc)) {
      patterns.push({type: "keyword", name: kw, severity: "HARD"});
      types.add("kw:" + kw);
      severity = "HARD";
    }
  }
  if (severity !== "HARD") {
    for (const kw of MOD_OFF_PLATFORM_KEYWORDS_SOFT) {
      if (new RegExp("\\b" + modEscapeKw(kw) + "\\b", "i").test(lc)) {
        patterns.push({type: "keyword", name: kw, severity: "SOFT"});
        types.add("kw:" + kw);
        if (!severity) severity = "SOFT";
      }
    }
  }
  return {
    matched: patterns.length > 0,
    severity,
    types: Array.from(types),
    patterns: patterns.slice(0, 12),
  };
}

exports.moderateMessage = onDocumentCreated(
  {
    document: "conversations/{cid}/messages/{messageId}",
    ...LIGHT_TRIGGER,
    secrets: [geminiSecret],
  },
  async (event) => {
    try {
      const msg = event.data && event.data.data();
      if (!msg) return;
      const text = msg.text || "";
      if (!text) return;

      // TODO: enable Gemini classifier in v2 for ambiguous SOFT-only
      // messages. v1 is deterministic regex + keyword only.
      const det = modDetectOffPlatform(text);
      if (!det.matched) return;

      const db = admin.firestore();
      const cid = event.params.cid;
      const messageId = event.params.messageId;
      const senderId = msg.senderId || msg.fromUid || null;

      // Resolve the recipient from the parent conversation's participants.
      let recipientId = null;
      let listingId = msg.listingId || null;
      try {
        const convSnap = await db.collection("conversations").doc(cid).get();
        if (convSnap.exists) {
          const conv = convSnap.data() || {};
          listingId = listingId || conv.listingId || null;
          const parts = Array.isArray(conv.participants) ? conv.participants : [];
          recipientId = parts.find((u) => u && u !== senderId) || null;
        }
      } catch (e) {
        logger.warn("moderateMessage: conv lookup failed", e);
      }

      const FieldValue = admin.firestore.FieldValue;
      const flagDoc = {
        messageId,
        conversationId: cid,
        listingId,
        senderId,
        recipientId,
        severity: det.severity,
        types: det.types,
        patterns: det.patterns,
        textPreview: text.slice(0, 240),
        createdAt: FieldValue.serverTimestamp(),
      };

      // Best-effort fan-out: flag doc first (the audit trail), then the
      // counters and the message-doc patch. Each await is isolated so one
      // missing/locked doc can't bury the others.
      try {
        await db.collection("messageFlags").doc(messageId).set(flagDoc);
      } catch (e) {
        logger.warn("moderateMessage: messageFlags write failed", e);
      }

      try {
        await db.collection("conversations").doc(cid).set({
          flaggedMessageCount: FieldValue.increment(1),
          lastFlaggedAt: FieldValue.serverTimestamp(),
        }, {merge: true});
      } catch (e) {
        logger.warn("moderateMessage: conv counter failed", e);
      }

      if (senderId) {
        const senderInc = det.severity === "HARD" ?
          {offPlatformFlags: FieldValue.increment(1)} :
          {offPlatformSoftFlags: FieldValue.increment(1)};
        try {
          await db.collection("users").doc(senderId).set(senderInc, {merge: true});
        } catch (e) {
          logger.warn("moderateMessage: sender counter failed", e);
        }
      }
      if (recipientId) {
        // Recipient always gets a soft increment so the system tracks
        // both ends of every flagged exchange.
        try {
          await db.collection("users").doc(recipientId).set({
            offPlatformSoftFlags: FieldValue.increment(1),
          }, {merge: true});
        } catch (e) {
          logger.warn("moderateMessage: recipient counter failed", e);
        }
      }

      // Patch the message doc so the existing onSnapshot listener picks
      // up the flag and renders the interstitial on the recipient's UI.
      try {
        await event.data.ref.update({
          flagged: {severity: det.severity, types: det.types},
        });
      } catch (e) {
        logger.warn("moderateMessage: msg patch failed", e);
      }

      logger.info(
          `moderateMessage: flagged ${messageId} severity=${det.severity} types=${det.types.join(",")}`,
      );
    } catch (err) {
      logger.error("moderateMessage error", err);
    }
  },
);

// ─────────────────────────────────────────────────────────────
// ADMIN MODERATION ACTIONS — banUser / suspendUser /
//   takeDownListing / onReportCreate.
//
//   adminGate() — single source of truth for who can call the
//   privileged onCall functions. Keep ADMIN_EMAILS in sync with the
//   front-end MODERATION_ADMIN_EMAILS list and the isAdmin() helper
//   inside firestore.rules / storage.rules.
//
//   Every admin action writes to adminActions/{auto} with admin uid,
//   email, target ref, reason, and a serverTimestamp — the runbook
//   relies on this audit log for "who removed listing X" forensics.
// ─────────────────────────────────────────────────────────────
const ADMIN_MOD_EMAILS = new Set(["jakenair23@gmail.com"]);

function adminGate(req) {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in required");
  }
  const email = (req.auth.token && req.auth.token.email) || "";
  const verified = !!(req.auth.token && req.auth.token.email_verified);
  if (!verified || !ADMIN_MOD_EMAILS.has(String(email).toLowerCase())) {
    throw new HttpsError("permission-denied", "Admin only");
  }
}

async function logAdminAction(req, action, targetType, targetId, reason, metadata) {
  try {
    await admin.firestore().collection("adminActions").add({
      adminUid: req.auth.uid,
      adminEmail: req.auth.token && req.auth.token.email,
      action,
      targetType,
      targetId,
      reason: reason || "",
      metadata: metadata || {},
      performedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn("logAdminAction failed", e);
  }
}

exports.banUser = onCall({...USER_CALLABLE}, async (req) => {
  adminGate(req);
  const {uid, reason} = req.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid required");
  }
  const db = admin.firestore();
  await db.doc(`users/${uid}`).set({
    banned: true,
    bannedAt: admin.firestore.FieldValue.serverTimestamp(),
    banReason: String(reason || "").slice(0, 500),
  }, {merge: true});
  // Revoke any active sessions so the user is signed out on next API call.
  try {
    await admin.auth().revokeRefreshTokens(uid);
  } catch (e) {
    logger.warn("banUser: revokeRefreshTokens failed", e);
  }
  // Pull all of their active listings off the marketplace.
  const ls = await db.collection("listings")
      .where("sellerId", "==", uid)
      .where("status", "==", "active").get();
  if (!ls.empty) {
    const batch = db.batch();
    ls.forEach((d) => batch.update(d.ref, {
      status: "removed",
      removedAt: admin.firestore.FieldValue.serverTimestamp(),
      removedReason: "admin_ban",
    }));
    await batch.commit();
  }
  await logAdminAction(req, "ban_user", "user", uid, reason, {listingsRemoved: ls.size});
  return {ok: true, listingsRemoved: ls.size};
});

exports.suspendUser = onCall({...USER_CALLABLE}, async (req) => {
  adminGate(req);
  const {uid, hours, reason} = req.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid required");
  }
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) {
    throw new HttpsError("invalid-argument", "hours must be 1..8760");
  }
  const until = new Date(Date.now() + h * 3600 * 1000);
  await admin.firestore().doc(`users/${uid}`).set({
    suspended: true,
    suspendedUntil: admin.firestore.Timestamp.fromDate(until),
    suspendReason: String(reason || "").slice(0, 500),
  }, {merge: true});
  await logAdminAction(req, "suspend_user", "user", uid, reason, {hours: h});
  return {ok: true, suspendedUntil: until.toISOString()};
});

exports.takeDownListing = onCall({...USER_CALLABLE}, async (req) => {
  adminGate(req);
  const {listingId, reason} = req.data || {};
  if (!listingId || typeof listingId !== "string") {
    throw new HttpsError("invalid-argument", "listingId required");
  }
  await admin.firestore().doc(`listings/${listingId}`).update({
    status: "removed",
    removedAt: admin.firestore.FieldValue.serverTimestamp(),
    removedReason: String(reason || "admin_takedown").slice(0, 200),
  });
  await logAdminAction(req, "take_down_listing", "listing", listingId, reason);
  return {ok: true};
});

// onReportCreate — bump users/{targetUid}.reportCount when an abuse
// report comes in. Cheap aggregate that lets the admin queue surface
// "this user has been reported N times" without a sub-query.
exports.onReportCreate = onDocumentCreated(
  {document: "reports/{reportId}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const r = event.data && event.data.data();
      if (!r) return;
      const targetUid = r.targetUid ||
        (r.targetType === "user" ? r.targetId : null);
      if (!targetUid) return;
      await admin.firestore().doc(`users/${targetUid}`).set({
        reportCount: admin.firestore.FieldValue.increment(1),
        lastReportedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    } catch (err) {
      logger.error("onReportCreate error", err);
    }
  },
);

// ─────────────────────────────────────────────────────────────
// syncWatchlistCount (Firestore trigger)
//   Watchlist is stored as a map on users/{uid}.watchlist (not a
//   subcollection). When the user doc updates, diff before/after
//   to find listings added/removed, then ±1 listings/{id}.watchlistCount
//   accordingly. Without this trigger, watchlistCount is read by the
//   dashboard but never written — every listing shows 0 watchers.
// ─────────────────────────────────────────────────────────────
exports.syncWatchlistCount = onDocumentUpdated(
  {document: "users/{uid}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const before = (event.data && event.data.before && event.data.before.data()) || {};
      const after = (event.data && event.data.after && event.data.after.data()) || {};
      const beforeIds = new Set(Object.keys(before.watchlist || {}));
      const afterIds = new Set(Object.keys(after.watchlist || {}));
      const added = [];
      const removed = [];
      for (const id of afterIds) if (!beforeIds.has(id)) added.push(id);
      for (const id of beforeIds) if (!afterIds.has(id)) removed.push(id);
      if (added.length === 0 && removed.length === 0) return;
      const db = admin.firestore();
      const batch = db.batch();
      for (const id of added) {
        batch.set(
            db.collection("listings").doc(id),
            {watchlistCount: admin.firestore.FieldValue.increment(1)},
            {merge: true},
        );
      }
      for (const id of removed) {
        batch.set(
            db.collection("listings").doc(id),
            {watchlistCount: admin.firestore.FieldValue.increment(-1)},
            {merge: true},
        );
      }
      await batch.commit();
    } catch (err) {
      logger.error("syncWatchlistCount error", err);
    }
  },
);

// ─────────────────────────────────────────────────────────────
// aggregateSellerStats (Firestore trigger)
//   When an order transitions to fulfillmentStatus='delivered',
//   roll up sales count + revenue onto the seller's profile.
//   Idempotent on the before/after diff so re-writes don't
//   double-count.
// ─────────────────────────────────────────────────────────────
exports.aggregateSellerStats = onDocumentUpdated(
  {document: "orders/{orderId}", ...LIGHT_TRIGGER},
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
// generateDailyBingoPuzzle — DELETED 2026-05-12.
//
// This scheduled function previously wrote dailyGames/{YYYY-MM-DD}
// with 9 randomly-picked course IDs, but no client ever read the
// collection (the bingo client derives its daily puzzle locally via
// a deterministic seeded shuffle of bingo-courses.js — see
// `dailySeed` in index.html). The function used Math.random(), so
// even if a reader appeared it would disagree with the client's
// deterministic output.
//
// Removed: the scheduled job, the BINGO_COURSE_POOL constant, the
// pickNRandom helper, and the local todayUtcDateKey helper.
// SCHEDULED_BATCH (sizing preset) is retained — used by other jobs.
//
// Post-deploy action required: run `firebase deploy --only functions`
// to delete the function from the live Cloud Functions deployment.
// Until then, the scheduled job will continue to run in production
// against an empty BINGO_COURSE_POOL signature (well, it will run
// the OLD deployed code unchanged — only the next deploy retires it).
//
// The corresponding /dailyGames/{date} rule was also removed from
// firestore.rules. See BINGO_CACHING_AUDIT.md for original analysis.
// ─────────────────────────────────────────────────────────────

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
    // Listings store category as `cat` (per sell-form), older docs may
    // have `category`. Accept either. (Bug fix: previously only checked
    // listing.category, which meant every saved search with a category
    // filter silently returned false for every listing ever created —
    // saved-search match notifications never fired for category filters.)
    const lc = String(listing.cat || listing.category || "").toLowerCase();
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
  {document: "listings/{listingId}", ...LIGHT_TRIGGER, memory: "512MiB"},
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
      const listingTitle = listing.title || "a new listing";
      const listingPrice = Number.isFinite(Number(listing.ask))
        ? Number(listing.ask)
        : null;

      searchesSnap.forEach((doc) => {
        const search = doc.data();
        const userId = search.userId;
        if (!userId) return;
        // Don't self-notify the seller for their own listing.
        if (userId === listing.sellerId) return;

        if (!listingMatchesSavedSearch(listing, search.query)) return;

        // Write to users/{uid}/notifications — that's the path the
        // pushNotificationDispatch trigger listens on. The legacy
        // top-level notifications/ path was a bug: it created docs
        // that no dispatcher ever read.
        const notifRef = db
          .collection("users").doc(userId)
          .collection("notifications").doc();
        writes.push(
          notifRef.set({
            userId,
            kind: "saved-search-match",
            listingId,
            listingTitle,
            listingPrice,
            searchId: doc.id,
            searchName: search.name || null,
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
  {
    schedule: "every 1 hours",
    memory: "512MiB",
    timeoutSeconds: 300,
  },
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

exports.generateReferralCode = onCall(USER_CALLABLE, async (request) => {
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
  {document: "orders/{orderId}", ...LIGHT_TRIGGER},
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
  {schedule: "every 4 hours", ...SCHEDULED_BATCH},
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
// NSFW / SafeSearch helpers (Cloud Vision)
//
// Cloud Vision SafeSearch returns five signals on each image:
//   adult, racy, violence, medical, spoof
// each as one of:
//   VERY_UNLIKELY | UNLIKELY | POSSIBLE | LIKELY | VERY_LIKELY
//
// Policy: TeeBox is a public golf-gear marketplace. We block any
// image that is LIKELY/VERY_LIKELY adult or racy, OR VERY_LIKELY
// violence. We do NOT block on `medical` or `spoof` (would catch
// too many legitimate listings — clubhouse selfies, etc.).
//
// COST NOTE: Cloud Vision SafeSearch billing is $1.50 per 1,000
// calls after the first 1,000 free per month. At 100 listings/mo
// (~3 photos each = 300 calls) → free tier covers it. At 10,000
// listings/mo (~30k calls) → ~$43.50/mo. Acceptable given the
// liability cost of leaving porn on a marketplace App Store
// reviewers visit. See MODERATION_RUNBOOK.md for the full math.
// ─────────────────────────────────────────────────────────────
const SAFE_SEARCH_BLOCK_LEVEL = new Set(["LIKELY", "VERY_LIKELY"]);
function isSafeForMarketplace(annotation) {
  if (!annotation) return true; // Vision API failed open — log + allow.
  const adult = annotation.adult || "VERY_UNLIKELY";
  const racy = annotation.racy || "VERY_UNLIKELY";
  const violence = annotation.violence || "VERY_UNLIKELY";
  if (SAFE_SEARCH_BLOCK_LEVEL.has(adult)) return false;
  if (SAFE_SEARCH_BLOCK_LEVEL.has(racy)) return false;
  if (violence === "VERY_LIKELY") return false;
  return true;
}
function describeSafeSearchTrip(annotation) {
  if (!annotation) return "unknown";
  const reasons = [];
  if (SAFE_SEARCH_BLOCK_LEVEL.has(annotation.adult)) reasons.push(`adult=${annotation.adult}`);
  if (SAFE_SEARCH_BLOCK_LEVEL.has(annotation.racy)) reasons.push(`racy=${annotation.racy}`);
  if (annotation.violence === "VERY_LIKELY") reasons.push(`violence=${annotation.violence}`);
  return reasons.join(",") || "unknown";
}

// Hardcoded admin UID list. Email gate (jakenair23@gmail.com) is
// resolved on first flagged-listing notification — see
// notifyAdminOfFlaggedListing below — so we don't need to hardcode
// the UID here. We mirror flagged listings to a top-level
// `flaggedListings` collection that the admin queue UI queries
// directly (avoiding cross-user notification clutter).

// ─────────────────────────────────────────────────────────────
// optimizeListingPhoto (Storage trigger)
//   Runs whenever a new image is uploaded to listings/{id}/photos.
//   Strips EXIF (privacy: removes geolocation), resizes to a sensible
//   max dimension, and rewrites as WebP. The original is replaced
//   in-place to keep URLs stable. Skips files that are already
//   processed (have a content-disposition or webp content-type).
//
//   After optimization, runs Cloud Vision SafeSearch. If the photo
//   is NSFW (adult/racy LIKELY+, or violence VERY_LIKELY), the file
//   is deleted from Storage and the parent listing is flagged for
//   manual review. See MODERATION_RUNBOOK.md.
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
      const bucket = admin.storage().bucket(obj.bucket);
      const file = bucket.file(obj.name);
      try {
        const sharp = require("sharp");
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
        // Don't return — still try to run SafeSearch on the unoptimized
        // upload below so a sharp failure doesn't bypass moderation.
      }

      // ── Cloud Vision SafeSearch ──
      // Path is `listings/{sellerId}/{listingId}/{file}`.
      const parts = obj.name.split("/");
      if (parts.length < 4) return;
      const sellerId = parts[1];
      const listingId = parts[2];
      let safeSearch = null;
      try {
        // Lazy-require so the function still cold-starts if the dep
        // isn't installed yet (e.g. before a deploy).
        const vision = require("@google-cloud/vision");
        const client = new vision.ImageAnnotatorClient();
        const gcsUri = `gs://${obj.bucket}/${obj.name}`;
        const [result] = await client.safeSearchDetection(gcsUri);
        safeSearch = result && result.safeSearchAnnotation;
      } catch (err) {
        // If Vision isn't enabled or quota is hit, fail OPEN — we
        // still get the text-based moderation pass and the report
        // button as backstops. Log loudly so it shows in alerting.
        logger.error("SafeSearch detection failed", obj.name, err && err.message);
        return;
      }

      if (isSafeForMarketplace(safeSearch)) return;

      const reason = describeSafeSearchTrip(safeSearch);
      logger.warn("moderation: NSFW photo flagged", {
        path: obj.name,
        sellerId,
        listingId,
        reason,
        signals: safeSearch,
      });

      // 1. Delete the offending photo immediately.
      try {
        await file.delete({ignoreNotFound: true});
      } catch (e) {
        logger.error("moderation: photo delete failed", obj.name, e);
      }

      // 2. Flag the parent listing — only if it still exists. The
      //    text-side moderateListingOnCreate may have already deleted
      //    the doc; in that case we don't want to recreate an orphan
      //    via merge:true. We also short-circuit the rest if so.
      const db = admin.firestore();
      const listingRef = db.collection("listings").doc(listingId);
      let listingData = null;
      try {
        const snap = await listingRef.get();
        if (!snap.exists) {
          logger.info("moderation: listing already gone, skipping flag", listingId);
          return;
        }
        listingData = snap.data();
        await listingRef.update({
          status: "flagged",
          moderationFlags: {
            reason,
            signals: safeSearch || {},
            flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
            offendingPath: obj.name,
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        logger.error("moderation: listing flag write failed", listingId, e);
      }

      // 3. Mirror into flaggedListings/{listingId} for the admin
      //    queue UI to read (admin queue queries this collection,
      //    not the listings collection — keeps the moderation
      //    surface area tight). listingData is set in step 2 only
      //    if the listing still existed; default to {} otherwise.
      try {
        const data = listingData || {};
        await db.collection("flaggedListings").doc(listingId).set({
          listingId,
          sellerId,
          title: data.title || "(unknown)",
          brand: data.brand || "",
          photos: data.photos || [],
          reason,
          signals: safeSearch || {},
          offendingPath: obj.name,
          status: "pending",
          flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      } catch (e) {
        logger.error("moderation: flaggedListings write failed", listingId, e);
      }

      // 4. Notify the seller (in-app). pushNotificationDispatch
      //    will pick this up and send FCM if they have tokens.
      try {
        await db.collection("users").doc(sellerId)
          .collection("notifications").add({
            kind: "listing-under-review",
            subject: "Listing under review",
            body: "One of your photos couldn't be approved automatically. Our team is taking a look.",
            listingId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            read: false,
          });
      } catch (e) {
        logger.error("moderation: seller notification failed", sellerId, e);
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
  {document: "users/{uid}/notifications/{notifId}", ...LIGHT_TRIGGER},
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
        title = data.searchName
          ? `New match for "${data.searchName}"`
          : "New listing matches your saved search";
        const priceStr = (data.listingPrice != null)
          ? ` — $${data.listingPrice}`
          : "";
        body = `${data.listingTitle || "Tap to view"}${priceStr}`;
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
          // Mirror kind to a snake_case `type` for native handlers that
          // key off the saved-search-match payload (saved_search_match).
          type: String(data.kind || "").replace(/-/g, "_"),
          listingId: String(data.listingId || ""),
          savedSearchId: String(data.searchId || ""),
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
const FROM_EMAIL = "TeeBox <noreply@mail.teeboxmarket.com>";
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
// Legacy order email triggers removed (2026-05-13)
//   `notifyOnOrderCreated` and `notifyOnOrderUpdated` were duplicate
//   senders alongside the JSX path in emailTriggers.js
//   (`onOrderCreatedEmail`, `onOrderShippingStatusEmail`,
//   `onOrderLabelEmail`). They also bypassed `preflightAllowed`
//   (no unsubscribe footer / physical address / GDPR consent gate).
//   The canonical replacements live in `functions/emailTriggers.js`
//   and render through React Email templates that include compliant
//   footers. The `trackingUrl` helper went with them — only the
//   legacy shipped-email body referenced it.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// notifyOnOfferCreated — push + email seller when a buyer offers
// ─────────────────────────────────────────────────────────────
exports.notifyOnOfferCreated = onDocumentCreated(
  {document: "offers/{offerId}", secrets: [RESEND_KEY], ...EMAIL_TRIGGER},
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
  {document: "offers/{offerId}", secrets: [RESEND_KEY], ...EMAIL_TRIGGER},
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
// Throttle window: a recipient receives at most one email per
// (thread × 4 hours). Subsequent messages within the window bump only
// the in-app notification + a pending-count doc, so the next email
// can advertise "N+1 new messages" rather than spamming inboxes.
const MESSAGE_EMAIL_THROTTLE_MS = 4 * 60 * 60 * 1000;

exports.notifyOnNewMessage = onDocumentCreated(
  {document: "conversations/{cid}/messages/{messageId}", secrets: [RESEND_KEY], ...EMAIL_TRIGGER},
  async (event) => {
    try {
      const msg = event.data && event.data.data();
      if (!msg) return;
      const db = admin.firestore();
      const FieldValue = admin.firestore.FieldValue;
      const conversationId = event.params.cid;
      const messageId = event.params.messageId;
      const senderId = msg.senderId || msg.fromUid;
      // Resolve the recipient from the parent conversation. Client only
      // writes {senderId, text, createdAt} on the message itself
      // (index.html sendMessage), so participants live on the conv doc.
      let recipientUid = msg.recipientId || msg.toUid;
      let listingId = msg.listingId || null;
      if (!recipientUid || !listingId) {
        const conv = await db.collection("conversations").doc(conversationId).get();
        if (conv.exists) {
          const c = conv.data();
          if (!recipientUid) {
            recipientUid = (c.participants || []).find((p) => p !== senderId);
          }
          if (!listingId) listingId = c.listingId || null;
        }
      }
      if (!recipientUid) return;
      if (recipientUid === senderId) return;
      const [recipient, sender] = await Promise.all([
        lookupUser(recipientUid),
        lookupUser(senderId),
      ]);
      const fromName = (sender && sender.displayName) || "A buyer";
      const preview = String(msg.text || msg.body || "").slice(0, 120);

      // In-app notification ALWAYS fires (badge / inbox dot).
      await writeNotification(recipientUid, {
        kind: "new-message",
        listingId,
        conversationId,
        fromName,
        preview,
      });

      // Phone-only / no-email recipients: nothing else to do.
      if (!recipient || !recipient.email) return;

      // ── Throttling: read the recipient's last-email-sent timestamp for
      // this thread. If we're inside the 4-hour cooldown, bump a
      // pending-count doc and exit (no email send).
      const userRef = db.doc(`users/${recipientUid}`);
      const pendingRef = db
        .collection("conversations").doc(conversationId)
        .collection("pendingNotifyCounts").doc(recipientUid);

      const now = Date.now();
      const userSnap = await userRef.get();
      const lastByThread =
        (userSnap.exists && userSnap.data().lastMessageNotificationByThread) || {};
      const lastAt = lastByThread[conversationId];
      const lastAtMs =
        (lastAt && typeof lastAt.toMillis === "function" && lastAt.toMillis()) ||
        (typeof lastAt === "number" ? lastAt : 0);

      if (lastAtMs && (now - lastAtMs) < MESSAGE_EMAIL_THROTTLE_MS) {
        await pendingRef.set({
          count: FieldValue.increment(1),
          lastMessageId: messageId,
          lastAt: FieldValue.serverTimestamp(),
        }, {merge: true});
        logger.info(
          `notifyOnNewMessage: throttled — last email ${Math.round((now - lastAtMs) / 60000)}m ago ` +
          `for ${recipientUid} in ${conversationId}`,
        );
        return;
      }

      // Outside the cooldown (or first message): include any pending
      // batched count in the subject, then send + clear the pending doc.
      let batchedCount = 0;
      try {
        const pendingSnap = await pendingRef.get();
        if (pendingSnap.exists) {
          batchedCount = Number(pendingSnap.data().count || 0);
        }
      } catch (e) {
        logger.warn("notifyOnNewMessage: pending read failed", e);
      }

      const totalNew = batchedCount + 1;
      const subject = totalNew > 1
        ? `You have ${totalNew} new messages from ${fromName}`
        : `New message from ${fromName}`;
      const safePreview = preview.replace(/[<>]/g, "");
      const headline = totalNew > 1
        ? `${totalNew} new messages from ${fromName}`
        : `Message from ${fromName}`;
      const intro = totalNew > 1
        ? `<p><strong>${fromName}</strong> sent you ${totalNew} new messages. Latest:</p>`
        : `<p><strong>${fromName}</strong> sent you a message:</p>`;
      const body = `${intro}
        <blockquote style="border-left:3px solid #c5a253;padding:8px 14px;
          margin:14px 0;color:#4a4a4a;font-style:italic;">${safePreview}</blockquote>
        <p>Reply in the app — buyers and sellers chat directly inside TeeBox.</p>`;
      await sendEmail({
        to: recipient.email,
        subject,
        html: emailShell(headline, body, "Open Inbox", `${APP_URL}/?inbox=1`),
      });

      // Stamp the watermark (per-thread) so the next 4 hours are silent.
      await userRef.set({
        lastMessageNotificationByThread: {[conversationId]: FieldValue.serverTimestamp()},
      }, {merge: true});

      // Clear the batched-count doc — it's been folded into the email we
      // just sent.
      if (batchedCount > 0) {
        try {
          await pendingRef.delete();
        } catch (e) {
          logger.warn("notifyOnNewMessage: pending delete failed", e);
        }
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
  {document: "users/{uid}", secrets: [RESEND_KEY], ...EMAIL_TRIGGER},
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
// BRANDED AUTH EMAILS — password reset + email verification
//
//   Firebase Auth's built-in `sendPasswordResetEmail()` and
//   `sendEmailVerification()` deliver from `noreply@<project>.
//   firebaseapp.com`, which has no DKIM/SPF for our domain and
//   often hits spam. These two callables instead:
//     1. Use the Admin SDK to *generate* the action link (no email
//        is sent automatically — we get the URL back).
//     2. Wrap it in our branded `emailShell` HTML.
//     3. Ship it via Resend from `noreply@mail.teeboxmarket.com`
//        (DKIM/SPF/DMARC-signed for deliverability).
//
//   Both functions are conservative on enumeration:
//     - sendBrandedPasswordReset always returns success even if
//       the email isn't on file.
//     - sendBrandedVerification requires auth, so it can't be
//       used to probe for accounts.
// ─────────────────────────────────────────────────────────────
const AUTH_EMAIL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// continueURL Firebase appends to the action link as `?continueUrl=`.
// After the user finishes the action on Firebase's hosted handler, they
// land here. `?launch=auth` re-opens the app to the auth screen on web
// and is a registered Universal Link target for iOS so the Capacitor
// app can resume cleanly.
const AUTH_CONTINUE_URL = `${APP_URL}/?launch=auth`;
const AUTH_ACTION_CODE_SETTINGS = {
  url: AUTH_CONTINUE_URL,
  handleCodeInApp: false,
};

exports.sendBrandedPasswordReset = onCall(
  {...USER_CALLABLE, secrets: [RESEND_KEY]},
  async (request) => {
    const data = request.data || {};
    const rawEmail = typeof data.email === "string" ? data.email.trim() : "";
    const email = rawEmail.toLowerCase();
    if (!email || !AUTH_EMAIL_EMAIL_RE.test(email)) {
      throw new HttpsError("invalid-argument", "A valid email is required.");
    }

    // Rate-limit per-email (not per-UID — the caller is unauthed).
    // 5/min is enough for a fat-fingered user retry but cuts off
    // scripted abuse. Key namespace: `pwReset:<email>` under the
    // throwaway uid `_pwReset` so we share the same Firestore
    // schema as authed limits.
    const rl = await checkRateLimit(
        "_pwReset", `email:${email}`, 5);
    if (!rl.ok) {
      throw new HttpsError(
          "resource-exhausted",
          `Too many requests. Try again in ${rl.retryAfterSec}s.`,
      );
    }

    let resetUrl = null;
    try {
      resetUrl = await admin.auth().generatePasswordResetLink(
          email, AUTH_ACTION_CODE_SETTINGS);
    } catch (err) {
      // Anti-enumeration: if the user doesn't exist, swallow and
      // return ok. Anything else (Firebase quota, transient) we log
      // but still return ok so timing + response shape don't leak
      // existence either.
      const code = err && err.code;
      if (code !== "auth/user-not-found" &&
          code !== "auth/email-not-found") {
        logger.error("sendBrandedPasswordReset: generateLink failed", err);
      }
      return {ok: true};
    }

    // Revoke existing sessions on other devices. If an attacker still
    // has a stolen ID token (or the user just wants a clean reset),
    // this kills it server-side. We do this BEFORE sending the email
    // so a race where the user clicks the link before the revoke lands
    // is impossible. Best-effort lookup — failures don't block the
    // email send.
    try {
      const u = await admin.auth().getUserByEmail(email).catch(() => null);
      if (u && u.uid) {
        await admin.auth().revokeRefreshTokens(u.uid);
      }
    } catch (e) {
      logger.warn(
        `sendBrandedPasswordReset: revokeRefreshTokens failed: ${e.message}`);
    }

    if (resetUrl) {
      const body = `<p>We received a request to reset your TeeBox password.
        Click the button below to set a new one. If you didn't make this
        request, you can safely ignore this email — your password won't
        change.</p>
        <p style="color:#777;font-size:13px;margin-top:18px;">
          This link expires in 1 hour.
        </p>`;
      try {
        await sendEmail({
          to: email,
          subject: "Reset your TeeBox password",
          html: emailShell(
              "Reset your password", body, "Reset Password", resetUrl),
        });
      } catch (err) {
        // sendEmail already logs internally; never surface to the
        // caller (anti-enumeration).
        logger.error("sendBrandedPasswordReset: send failed", err);
      }
    }
    return {ok: true};
  },
);

exports.sendBrandedVerification = onCall(
  {...USER_CALLABLE, secrets: [RESEND_KEY]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;

    const rl = await checkRateLimit(uid, "verifyEmail", 3);
    if (!rl.ok) {
      throw new HttpsError(
          "resource-exhausted",
          `Too many requests. Try again in ${rl.retryAfterSec}s.`,
      );
    }

    let authUser;
    try {
      authUser = await admin.auth().getUser(uid);
    } catch (err) {
      logger.error("sendBrandedVerification: getUser failed", err);
      throw new HttpsError("not-found", "User not found.");
    }
    if (!authUser.email) {
      throw new HttpsError(
          "failed-precondition",
          "No email on file for this account.",
      );
    }
    if (authUser.emailVerified) {
      return {ok: true, alreadyVerified: true};
    }

    let verifyUrl;
    try {
      verifyUrl = await admin.auth().generateEmailVerificationLink(
          authUser.email, AUTH_ACTION_CODE_SETTINGS);
    } catch (err) {
      logger.error("sendBrandedVerification: generateLink failed", err);
      throw new HttpsError("internal", "Could not generate link.");
    }

    const body = `<p>Confirm your email address to start buying and
      selling on TeeBox. Click the button below — it only takes a
      second.</p>
      <p style="color:#777;font-size:13px;margin-top:18px;">
        If you didn't sign up for TeeBox, ignore this email.
      </p>`;
    try {
      await sendEmail({
        to: authUser.email,
        subject: "Verify your email for TeeBox",
        html: emailShell(
            "Welcome to TeeBox", body, "Verify Email", verifyUrl),
      });
    } catch (err) {
      logger.error("sendBrandedVerification: send failed", err);
      throw new HttpsError("internal", "Could not send email.");
    }
    return {ok: true};
  },
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
    if (!request.auth.token || !request.auth.token.email_verified) {
      throw new HttpsError(
        "failed-precondition",
        "Please verify your email before continuing.");
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
  {secrets: [stripeSecret], ...USER_CALLABLE},
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
// createStripeLoginLink (callable)
//   Mints a single-use Stripe Express dashboard login URL for the
//   authenticated seller. Lets them check their payout history, KYC
//   status, etc. without us re-implementing all of that UI.
//
//   TODO(audit): wire from Account hub UI — currently nothing in the
//   client calls this function. Add a "Manage payouts" button on the
//   account screen that resolves this and opens the URL in a new tab.
// ─────────────────────────────────────────────────────────────
exports.createStripeLoginLink = onCall(
  {secrets: [stripeSecret], ...USER_CALLABLE},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const db = admin.firestore();
    const userSnap = await db.collection("users").doc(uid).get();
    const user = userSnap.exists ? userSnap.data() : {};
    if (!user.stripeAccountId) {
      throw new HttpsError(
        "failed-precondition",
        "Finish Stripe onboarding before opening the dashboard.");
    }
    try {
      const stripeClient = stripe(stripeSecret.value());
      const result = await stripeClient.accounts.createLoginLink(
          user.stripeAccountId);
      return {url: result.url};
    } catch (err) {
      logger.error("createStripeLoginLink failed", err);
      throw new HttpsError("internal", "Could not open Stripe dashboard.");
    }
  },
);

// ─────────────────────────────────────────────────────────────
// revokeMySession (callable)
//   Server-side refresh-token revoke for "sign out everywhere" + as a
//   pre-step before client-side fbSignOut. The next verifyIdToken with
//   checkRevoked=true (we pass true in getAuthedUser) will reject any
//   ID token issued before this revoke timestamp.
// ─────────────────────────────────────────────────────────────
exports.revokeMySession = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const uid = request.auth.uid;
  try {
    await admin.auth().revokeRefreshTokens(uid);
  } catch (err) {
    logger.error(`revokeMySession failed for ${uid}`, err);
    throw new HttpsError("internal", "Could not sign out.");
  }
  return {revoked: true};
});

// ─────────────────────────────────────────────────────────────
// PRO SELLER — subscription checkout + customer portal
//
// createSubscriptionCheckout (callable)
//   - Creates (or reuses) a Stripe Customer for the user
//   - Spins up a Stripe-hosted Checkout Session in subscription mode
//     against STRIPE_PRO_PRICE_ID
//   - Returns { url } for the client to redirect into
//   The customer.id is persisted on first creation so the webhook can
//   reverse-look-up the user when the subscription event lands.
//
// createBillingPortalSession (callable)
//   - Opens Stripe's hosted billing portal so a Pro subscriber can
//     update card / cancel / view invoices without us building any UI.
//   - Configure the portal once in the Stripe Dashboard → Settings →
//     Billing → Customer portal.
// ─────────────────────────────────────────────────────────────
exports.createSubscriptionCheckout = onCall(
  {secrets: [stripeSecret, stripeProPriceId]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const priceId = stripeProPriceId.value();
    // M1: validate the price-ID shape — catches placeholder strings or
    // mis-pasted values that would otherwise surface as opaque Stripe
    // errors at session.create.
    if (!priceId || !/^price_[A-Za-z0-9]{10,}$/.test(priceId)) {
      throw new HttpsError(
        "failed-precondition",
        "Pro plan is not configured yet. Try again soon.",
      );
    }
    const uid = request.auth.uid;
    const db = admin.firestore();
    const stripeClient = stripe(stripeSecret.value());
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const user = userSnap.exists ? userSnap.data() : {};

    // Refuse to spin up a 2nd subscription if the user already has one
    // active. They should use the billing portal to manage it.
    if (user.tier === "pro" && user.proSubscriptionId) {
      throw new HttpsError(
        "already-exists",
        "You're already on Pro. Open Manage subscription to change " +
          "payment details or cancel.",
      );
    }

    // Fetch email + name for the Stripe customer record. Stripe needs an
    // email for receipt + dunning emails — required by best practice.
    let email; let displayName;
    try {
      const authUser = await admin.auth().getUser(uid);
      email = authUser.email || undefined;
      displayName = authUser.displayName || user.displayName || undefined;
    } catch (_e) { /* swallow — Checkout will collect email if needed */ }

    // Reuse the customer.id if we created one previously. Stops the
    // user from accumulating duplicate Customer records in Stripe if
    // they bounce out of Checkout multiple times.
    let customerId = user.stripeCustomerId;
    try {
      if (!customerId) {
        // L1: idempotency key — a double-tap during slow customer
        // create gets the same customer back instead of duplicates.
        const customer = await stripeClient.customers.create({
          email,
          name: displayName,
          metadata: {firebaseUid: uid},
        }, {idempotencyKey: `customer-create-${uid}`});
        customerId = customer.id;
        await userRef.set({
          stripeCustomerId: customerId,
          stripeCustomerCreatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }

      // H1: server-side guard against two-tab / two-device double-subscribe.
      // The local users/{uid} check above only catches users whose webhook
      // has already landed; between paying on Stripe and the webhook
      // arriving (seconds to minutes), a second tab could otherwise spin
      // up a duplicate subscription. Stripe is the source of truth.
      const existing = await stripeClient.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 5,
      });
      const blocking = existing.data.find((s) =>
        ["active", "trialing", "past_due", "incomplete"].includes(s.status),
      );
      if (blocking) {
        throw new HttpsError(
          "already-exists",
          "You already have a Pro subscription. Use Manage subscription " +
            "to make changes.",
          {subscriptionId: blocking.id, status: blocking.status},
        );
      }

      const session = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{price: priceId, quantity: 1}],
        success_url: `${APP_URL}/?checkout=pro_success`,
        cancel_url: `${APP_URL}/?checkout=pro_cancel`,
        // Tag the session + the resulting subscription with the firebase
        // uid as a belt-and-suspenders backup for the customer-id lookup.
        client_reference_id: uid,
        subscription_data: {metadata: {firebaseUid: uid}},
        // Allow_promotion_codes lets us run launch / referral coupons
        // without code changes — they're configured in the Stripe Dashboard.
        allow_promotion_codes: true,
      }, {
        // L1: idempotency key with a 60s bucket — a double-tap within
        // the same minute returns the same Checkout Session url. A new
        // minute = new session (acceptable; user retried after a delay).
        idempotencyKey:
          `checkout-session-${uid}-${(Date.now() / 60000) | 0}`,
      });

      return {url: session.url, sessionId: session.id};
    } catch (e) {
      // M1: translate Stripe SDK errors into useful client-facing
      // messages instead of opaque `internal`.
      if (e instanceof HttpsError) throw e;
      if (e && e.type === "StripeCardError") {
        throw new HttpsError("aborted", e.message, {code: e.code});
      }
      if (e && e.type === "StripeInvalidRequestError") {
        logger.error("createSubscriptionCheckout Stripe error", e);
        throw new HttpsError(
          "failed-precondition",
          "Pro plan is not properly configured. Try again later.",
          {code: e.code},
        );
      }
      throw e; // unknown — let onCall wrap as internal
    }
  },
);

exports.createBillingPortalSession = onCall(
  {secrets: [stripeSecret]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const db = admin.firestore();
    const userSnap = await db.collection("users").doc(uid).get();
    const user = userSnap.exists ? userSnap.data() : {};
    if (!user.stripeCustomerId) {
      throw new HttpsError(
        "failed-precondition",
        "No subscription found for this account.",
      );
    }
    const stripeClient = stripe(stripeSecret.value());
    const session = await stripeClient.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${APP_URL}/?billing=portal_return`,
    });
    return {url: session.url};
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
    const {orderId, reason, amount} = request.data || {};
    if (!orderId || typeof orderId !== "string") {
      throw new HttpsError("invalid-argument", "orderId required");
    }
    const db = admin.firestore();
    const orderRef = db.collection("orders").doc(orderId);

    // ── Pre-flight read (outside tx) just to validate the caller before
    // we burn a Stripe API call. The authoritative re-check happens
    // inside the tx below, after the Stripe refund succeeds.
    const preSnap = await orderRef.get();
    if (!preSnap.exists) {
      throw new HttpsError("not-found", "Order not found");
    }
    const pre = preSnap.data();
    if (pre.sellerId !== request.auth.uid) {
      throw new HttpsError(
        "permission-denied", "Only the seller can refund this order.");
    }
    if (pre.refunded && !Number.isFinite(Number(amount))) {
      throw new HttpsError(
        "failed-precondition", "Order is already refunded.");
    }

    // Optional partial-refund amount in cents. Must be > 0, must not
    // exceed (orderAmount - alreadyRefunded). Falls through to a full
    // refund when amount is omitted.
    const orderAmountCents = Number(pre.amountCents ||
        Math.round(Number(pre.amount || 0) * 100));
    const priorRefundedCents = Number(pre.refundedAmountCents || 0);
    let refundAmountCents = null;
    if (amount != null) {
      const parsed = parseInt(amount, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HttpsError(
          "invalid-argument", "amount must be a positive integer (cents).");
      }
      if (parsed + priorRefundedCents > orderAmountCents) {
        throw new HttpsError(
          "invalid-argument",
          `Refund exceeds remaining balance ($${
            ((orderAmountCents - priorRefundedCents) / 100).toFixed(2)}).`);
      }
      refundAmountCents = parsed;
    }

    const stripeClient = stripe(stripeSecret.value());

    // Call Stripe BETWEEN the validation read and the commit-side
    // listing rollback tx. The tx wraps the rollback writes only —
    // Stripe calls can't sit inside a Firestore tx (they're network
    // ops and tx retries would double-charge).
    const refundParams = {
      payment_intent: orderId,
      reason: ["duplicate", "fraudulent", "requested_by_customer"]
        .includes(reason) ? reason : "requested_by_customer",
      refund_application_fee: true,
      reverse_transfer: true,
    };
    if (refundAmountCents != null) refundParams.amount = refundAmountCents;

    let refund;
    try {
      // Idempotency key so a transient client retry can't issue a
      // second refund. Stripe replays the cached refund for the same
      // key. Key is order-scoped — partial refunds on the same order
      // need distinct calls (Stripe enforces this server-side).
      refund = await stripeClient.refunds.create(refundParams, {
        idempotencyKey: `refund_${orderId}` +
          (refundAmountCents != null ? `_${refundAmountCents}` : ""),
      });
    } catch (stripeErr) {
      logger.error("refundOrder: Stripe API failed", stripeErr);
      throw new HttpsError("internal",
          `Refund failed: ${stripeErr.message || "unknown"}`);
    }

    const isFullRefund = (refundAmountCents == null) ||
        (refundAmountCents + priorRefundedCents >= orderAmountCents);

    // Commit-side tx: roll back listing inventory + flag the order as
    // refunded. The Stripe refund is already done at this point; if
    // the tx fails, the order doc just won't reflect it and we log —
    // a follow-up admin sync can patch it.
    await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        throw new Error(`order ${orderId} vanished mid-refund`);
      }
      const order = orderSnap.data();
      const qty = Math.max(1, Number(order.quantity || 1));
      const listingId = order.listingId;
      let listingSnap = null;
      let listingRef = null;
      if (listingId) {
        listingRef = db.collection("listings").doc(listingId);
        listingSnap = await tx.get(listingRef);
      }

      const orderUpdate = {
        refundId: refund.id,
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        refundedAmountCents: priorRefundedCents +
            (refundAmountCents != null ? refundAmountCents : orderAmountCents),
      };
      if (isFullRefund) {
        orderUpdate.refunded = true;
        orderUpdate.status = "refunded";
        orderUpdate.fulfillmentStatus = "refunded";
      } else {
        orderUpdate.partiallyRefunded = true;
      }
      tx.update(orderRef, orderUpdate);

      // Only restore inventory on a FULL refund — partial refunds keep
      // the unit "sold" from the listing's perspective.
      if (isFullRefund && listingRef && listingSnap && listingSnap.exists) {
        const listing = listingSnap.data();
        const totalQty = Math.max(1, Number(listing.quantity || 1));
        const curSold = Math.max(0, Number(listing.quantitySold || 0));
        const nextSold = Math.max(0, curSold - qty);
        // Only flip status back to active if there's remaining sellable
        // inventory. Listings that were `removed` / `expired` stay in
        // whatever terminal state they were in.
        const remaining = totalQty - nextSold;
        const update = {
          quantitySold: nextSold,
          soldAt: admin.firestore.FieldValue.delete(),
          soldTo: admin.firestore.FieldValue.delete(),
          orderId: admin.firestore.FieldValue.delete(),
        };
        if (listing.status === "sold" && remaining > 0) {
          update.status = "active";
        }
        tx.update(listingRef, update);
      }
    });

    // ── Email producer for the buyer-facing refund email (audit #24).
    // The downstream onRefundEmail trigger in emailTriggers.js listens
    // on refunds/{id} creates and emails the buyer via the
    // RefundIssued.jsx template. Without this write the trigger never
    // fires. Doc id = Stripe refund id → idempotent: a retried
    // refundOrder call returns the same Stripe refund (Stripe's own
    // idempotency key replays it) so the second create() is a no-op
    // for the trigger (existing doc → no onCreate event).
    //
    // We write OUTSIDE the inventory tx for two reasons:
    //   1. The tx wraps writes that need rollback if order/listing
    //      state shifts mid-flight. The refund-email producer doesn't
    //      need that — Stripe has already refunded the buyer.
    //   2. If the inventory tx fails we still want the buyer to get
    //      their refund email (the refund itself succeeded). Putting
    //      it after the tx means we always email on a successful
    //      Stripe refund, even if Firestore inventory rollback fails.
    const refundDocAmountCents = refundAmountCents != null ?
        refundAmountCents : orderAmountCents;
    try {
      await db.collection("refunds").doc(refund.id).create({
        orderId,
        buyerId: pre.buyerId || null,
        sellerId: pre.sellerId,
        listingId: pre.listingId || null,
        amount: refundDocAmountCents / 100,
        amountCents: refundDocAmountCents,
        currency: refund.currency || "usd",
        reason: refundParams.reason,
        stripeRefundId: refund.id,
        refundedBy: request.auth.uid,
        fullRefund: isFullRefund,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (writeErr) {
      // `create()` throws ALREADY_EXISTS if the doc already exists,
      // which means a previous run of refundOrder for this same Stripe
      // refund id already wrote it. That's the desired idempotency
      // path — swallow it so we don't fail the callable. Any other
      // error: log but don't throw, because the Stripe refund DID
      // succeed and we already returned that fact to the seller.
      const code = writeErr && (writeErr.code || writeErr.status);
      if (code === 6 || code === "already-exists" ||
          /already exists/i.test(String(writeErr && writeErr.message))) {
        logger.info(
            `refundOrder: refunds/${refund.id} already exists — skip`);
      } else {
        logger.error(
            `refundOrder: refunds/${refund.id} write failed`, writeErr);
      }
    }

    return {
      refundId: refund.id,
      status: refund.status,
      amountCents: refund.amount,
      fullRefund: isFullRefund,
    };
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
    if (!request.auth.token || !request.auth.token.email_verified) {
      throw new HttpsError(
        "failed-precondition",
        "Please verify your email before continuing.");
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
      "gemini-2.0-flash:generateContent?key=" + encodeURIComponent(apiKey);

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

// ─────────────────────────────────────────────────────────────
// suggestListingPrice
//   Callable that asks Gemini 1.5 Flash to suggest a fair list
//   price (with a low/high band and reasoning) for a listing
//   draft, grounded in recent comparable solds pulled from the
//   `listings` collection.
//   - Auth required
//   - 30 calls/min/UID via the shared checkRateLimit helper
//   - Reads up to 200 sold listings from the last 90 days
//     (`listings` collection, status=="sold", ordered by
//     createdAt DESC), filtered to brand or title-keyword overlap
//     and capped at 50 comps for the prompt — read-only.
//   - Multimodal: optional `inlineImages: [{data,mimeType}]`
//     (base64, already client-side compressed) OR
//     `photos: [storagePath]` (downloaded from the default bucket
//     when paths are under listings/<uid>/...). Capped at 3 images
//     so we don't blow the per-call token budget.
//   - Returns { suggested, low, high, reasoning, comps[], compsCount }
// ─────────────────────────────────────────────────────────────
exports.suggestListingPrice = onCall(
  {...USER_CALLABLE, secrets: [geminiSecret]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in.");
    }
    if (!request.auth.token || !request.auth.token.email_verified) {
      throw new HttpsError(
        "failed-precondition",
        "Please verify your email before continuing.");
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
    const optString = (key, max) => {
      const v = data[key];
      if (v == null || typeof v !== "string") return "";
      const trimmed = v.trim();
      return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
    };

    const title = requireString("title", 200);
    const brand = optString("brand", 200);
    const model = optString("model", 200);
    const condition = optString("condition", 200);
    const category = optString("category", 200);

    // ── Rate limit (30/min/UID) ──
    const rl = await checkRateLimit(uid, "suggestListingPrice", 30);
    if (!rl.ok) {
      throw new HttpsError(
          "resource-exhausted",
          `Too many requests. Try again in ${rl.retryAfterSec}s.`,
      );
    }

    const db = admin.firestore();

    // ── Pull recent solds (last 90 days), then score ──
    // Uses the existing status+createdAt index. We over-fetch (200)
    // and re-rank by brand/title overlap so brand-light queries
    // still get useful signal. Final comps capped at 50.
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoffTs = admin.firestore.Timestamp.fromMillis(
        Date.now() - NINETY_DAYS_MS);

    const titleLower = title.toLowerCase();
    const modelLower = model.toLowerCase();
    const brandLower = brand.toLowerCase();
    const tokens = (titleLower + " " + modelLower)
        .split(/[^a-z0-9]+/i)
        .filter((t) => t && t.length > 2);

    let rawSolds = [];
    try {
      const snap = await db.collection("listings")
          .where("status", "==", "sold")
          .where("createdAt", ">=", cutoffTs)
          .orderBy("createdAt", "desc")
          .limit(200)
          .get();
      snap.forEach((doc) => {
        const d = doc.data() || {};
        const ask = Number(d.ask || 0);
        if (!ask || ask <= 0) return;
        rawSolds.push({
          id: doc.id,
          title: String(d.title || ""),
          brand: String(d.brand || ""),
          condition: String(d.condition || ""),
          ask,
        });
      });
    } catch (err) {
      // Fail soft on Firestore — we can still ask Gemini without comps.
      logger.warn("suggestListingPrice: solds query failed", err);
      rawSolds = [];
    }

    const scored = rawSolds.map((s) => {
      const lt = (s.title || "").toLowerCase();
      const lb = (s.brand || "").toLowerCase();
      const overlap = tokens.filter((t) => lt.includes(t)).length;
      const brandHit = brandLower && lb === brandLower ? 1 : 0;
      // brand match (3) + per-token overlap (1).
      const score = brandHit * 3 + overlap;
      return {...s, score};
    }).filter((s) => s.score >= 1);
    scored.sort((a, b) => b.score - a.score);
    const comps = scored.slice(0, 50);

    // ── Build prompt ──
    const compsLines = comps.map((c, i) =>
      `${i + 1}. "${c.title}" — ${c.brand || "?"}, ` +
      `${c.condition || "?"} — sold $${c.ask}`,
    ).join("\n");

    const promptText =
      "You are a pricing expert for a peer-to-peer used golf marketplace " +
      "(TeeBox). Suggest a fair list price in USD for a new listing, " +
      "grounded in the comparable recent sales below. Consider brand, " +
      "model, and condition. Be conservative — pricing too high stalls " +
      "the listing.\n\n" +
      "RECENT COMPARABLE SALES (last 90 days, may be empty):\n" +
      (compsLines || "(no close comps)") + "\n\n" +
      "NEW LISTING DRAFT:\n" +
      `Title: ${title}\n` +
      `Brand: ${brand || "(unspecified)"}\n` +
      `Model: ${model || "(unspecified)"}\n` +
      `Category: ${category || "(unspecified)"}\n` +
      `Condition: ${condition || "(unspecified)"}\n\n` +
      "Return ONLY a strict JSON object with this exact shape, no prose, " +
      "no markdown fences:\n" +
      "{\"suggested\": <number USD>, \"low\": <number USD>, " +
      "\"high\": <number USD>, " +
      "\"reasoning\": \"<one-sentence explanation, max 160 chars>\"}\n" +
      "Where low <= suggested <= high. Use whole dollars or .99 endings.";

    // ── Build multimodal parts (cap at 3 images) ──
    const parts = [{text: promptText}];
    const inlineImages = Array.isArray(data.inlineImages) ?
      data.inlineImages.slice(0, 3) : [];
    for (const img of inlineImages) {
      if (!img || typeof img !== "object") continue;
      const b64 = typeof img.data === "string" ? img.data : "";
      const mt = typeof img.mimeType === "string" ?
        img.mimeType : "image/jpeg";
      // Cap base64 payload at ~2MB per image (raw ~1.5MB).
      if (!b64 || b64.length > 2_000_000) continue;
      if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(mt)) continue;
      parts.push({inlineData: {data: b64, mimeType: mt}});
    }

    const photoPaths = Array.isArray(data.photos) ?
      data.photos.slice(0, 3) : [];
    if (parts.length === 1 && photoPaths.length > 0) {
      // No inline images — try to download up to 3 from default bucket.
      try {
        const bucket = admin.storage().bucket();
        for (const p of photoPaths) {
          if (typeof p !== "string" || !p) continue;
          if (p.length > 1024) continue;
          // Defense-in-depth: only allow paths under listings/<uid>/...
          if (!p.startsWith(`listings/${uid}/`)) continue;
          try {
            const [buf] = await bucket.file(p).download();
            if (!buf || buf.length === 0) continue;
            if (buf.length > 4 * 1024 * 1024) continue;
            parts.push({
              inlineData: {
                data: buf.toString("base64"),
                mimeType: "image/jpeg",
              },
            });
          } catch (e) {
            logger.warn("suggestListingPrice: photo download failed", p);
          }
        }
      } catch (e) {
        logger.warn("suggestListingPrice: bucket access failed", e);
      }
    }

    // ── Call Gemini 1.5 Flash via REST ──
    const apiKey = geminiSecret.value();
    if (!apiKey) {
      logger.error("suggestListingPrice: GEMINI_API_KEY missing");
      throw new HttpsError("internal", "AI service not configured.");
    }
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      "gemini-2.0-flash:generateContent?key=" + encodeURIComponent(apiKey);

    let aiResp;
    try {
      aiResp = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          contents: [{parts}],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 256,
            responseMimeType: "application/json",
          },
        }),
      });
    } catch (err) {
      logger.error("suggestListingPrice: fetch failed", err);
      throw new HttpsError("internal", "Could not reach AI service.");
    }

    if (!aiResp.ok) {
      const body = await aiResp.text().catch(() => "");
      logger.error(
          "suggestListingPrice: Gemini error",
          aiResp.status,
          body.slice(0, 500),
      );
      throw new HttpsError("internal", "AI service returned an error.");
    }

    let payload;
    try {
      payload = await aiResp.json();
    } catch (err) {
      logger.error("suggestListingPrice: bad JSON envelope", err);
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

    // ── Parse Gemini's JSON, fall back to median of comps ──
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
    };

    const fallbackFromComps = () => {
      if (!comps.length) return null;
      const asks = comps.map((c) => c.ask).sort((a, b) => a - b);
      const median = asks[Math.floor(asks.length / 2)];
      const low = asks[Math.floor(asks.length * 0.25)] || median;
      const high = asks[Math.floor(asks.length * 0.75)] || median;
      return {
        suggested: median,
        low,
        high,
        reasoning: `Median of ${asks.length} recent comparable sales.`,
      };
    };

    let parsed = null;
    if (typeof text === "string" && text.trim()) {
      try {
        // Strip code fences if Gemini ignored responseMimeType.
        const cleaned = text.trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/```\s*$/i, "");
        parsed = JSON.parse(cleaned);
      } catch (err) {
        logger.warn(
            "suggestListingPrice: bad JSON in candidate",
            text.slice(0, 200),
        );
      }
    }

    let suggested = parsed && num(parsed.suggested);
    let low = parsed && num(parsed.low);
    let high = parsed && num(parsed.high);
    let reasoning = parsed && typeof parsed.reasoning === "string" ?
      parsed.reasoning.slice(0, 240) : "";

    if (!suggested || !low || !high) {
      const fb = fallbackFromComps();
      if (!fb) {
        throw new HttpsError(
            "internal",
            "Couldn't suggest a price right now.",
        );
      }
      suggested = fb.suggested;
      low = fb.low;
      high = fb.high;
      reasoning = reasoning || fb.reasoning;
    }

    // Clamp the band so low <= suggested <= high.
    if (low > suggested) low = suggested;
    if (high < suggested) high = suggested;

    // Slim public comps payload — title + ask only, capped at 8 for UI.
    const publicComps = comps.slice(0, 8).map((c) => ({
      title: c.title,
      brand: c.brand,
      condition: c.condition,
      ask: c.ask,
    }));

    return {
      suggested,
      low,
      high,
      reasoning: reasoning || "Based on recent comparable sales.",
      comps: publicComps,
      compsCount: comps.length,
    };
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
    {document: "listings/{listingId}", ...LIGHT_TRIGGER},
    async (event) => {
      const snap = event.data;
      if (!snap) return;
      const d = snap.data();
      // Cover every freeform string field a seller controls. `cat` and
      // `condition` are dropdowns client-side but a malicious client
      // could POST anything, so we sweep them too.
      const haystack = [d.title, d.brand, d.desc, d.cat, d.condition]
          .filter(Boolean).join(" ");
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

// ──────────────────────────────────────────────────────────────────────
// moderateProfileOnWrite
//
// Profile displayName / bio are freeform — a malicious user could put
// slurs there. Mirror the listing blocklist sweep. We don't delete the
// profile (the user still needs an account), we just clear the
// offending field. Profile updates are idempotent so this is safe.
// ──────────────────────────────────────────────────────────────────────
exports.moderateProfileOnWrite = onDocumentUpdated(
    "profiles/{userId}",
    async (event) => {
      const after = event.data && event.data.after && event.data.after.data();
      if (!after) return;
      const fields = ["displayName", "bio", "location"];
      const updates = {};
      for (const f of fields) {
        const val = after[f];
        const term = findExplicitTerm(val);
        if (term) {
          updates[f] = "";
          logger.warn("moderation: cleared profile field", {
            userId: event.params.userId,
            field: f,
            term,
          });
        }
      }
      if (Object.keys(updates).length === 0) return;
      try {
        await event.data.after.ref.set(updates, {merge: true});
      } catch (e) {
        logger.error("moderation: profile clear failed", e);
      }
    },
);

// ─────────────────────────────────────────────────────────────
// backfillGlobalStats (admin-only callable, ONE-TIME)
//   Sums every paid order's amount + count and seeds the
//   `globalStats/all` denormalized doc the homepage reads. Idempotent
//   via merge-overwrite, so safe to call again if needed. Run once
//   after the perf migration that swaps the homepage scan for a
//   single-doc read.
//
//   USER ACTION: after `firebase deploy --only functions:backfillGlobalStats`
//   call this once from the browser as the admin (jakenair23@gmail.com):
//
//     firebase.functions().httpsCallable('backfillGlobalStats')()
//
//   Or via gcloud / `firebase functions:shell`. Returns {totalGmvCents,
//   totalSold, ordersScanned}.
// ─────────────────────────────────────────────────────────────
const ADMIN_EMAILS = ["jakenair23@gmail.com"];
exports.backfillGlobalStats = onCall(
    {...USER_CALLABLE, timeoutSeconds: 300, memory: "512MiB"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Must be signed in");
      }
      const email = request.auth.token && request.auth.token.email;
      const verified = request.auth.token &&
        request.auth.token.email_verified === true;
      if (!verified || !ADMIN_EMAILS.includes(email)) {
        throw new HttpsError("permission-denied", "Admin only");
      }

      const db = admin.firestore();
      // Page through paid orders to avoid blowing past Firestore limits.
      // We only need amountCents per doc — keep batching defensive.
      let totalGmvCents = 0;
      let totalSold = 0;
      let lastSaleMs = 0;
      let cursor = null;
      const PAGE = 500;

      while (true) {
        let q = db.collection("orders")
            .where("status", "==", "paid")
            .orderBy("createdAt", "asc")
            .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const data = d.data();
          const cents = Number(data.amountCents) ||
            Math.round(Number(data.amount || 0) * 100);
          if (Number.isFinite(cents) && cents > 0) {
            totalGmvCents += cents;
            totalSold += 1;
          }
          const ts = data.createdAt && data.createdAt.toMillis ?
            data.createdAt.toMillis() : 0;
          if (ts > lastSaleMs) lastSaleMs = ts;
        }
        cursor = snap.docs[snap.docs.length - 1];
        if (snap.size < PAGE) break;
      }

      const payload = {
        totalGmvCents,
        totalSold,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        backfilledAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (lastSaleMs > 0) {
        payload.lastSaleAt = admin.firestore.Timestamp.fromMillis(lastSaleMs);
      }
      await db.collection("globalStats").doc("all").set(payload, {merge: true});

      logger.info(
          `backfillGlobalStats: seeded ${totalSold} orders, ` +
        `$${(totalGmvCents / 100).toFixed(2)} GMV`
      );
      return {totalGmvCents, totalSold, ordersScanned: totalSold};
    }
);

// ─────────────────────────────────────────────────────────────
// sendMessage (onCall callable) — authoritative rate-limit + abuse
// prevention middleware. Every in-app chat send goes through this;
// the client no longer calls addDoc directly on the messages
// subcollection. The four rules enforced:
//   1. New accounts (createdAt within newAccountWindowHours): cap of
//      newAccountMessageLimit sends. Reject with rate_limited_new_account.
//   2. Any account: max breadthRecipientLimit DISTINCT recipients per
//      breadthWindowHours. Reject with rate_limited_breadth.
//   3. Identical message text to >= duplicateRecipientThreshold
//      distinct recipients within duplicateWindowHours: hold (not
//      delivered, queued in messageHolds/{id} for moderator review).
//   4. PII-flagged messages (clientFlag.severity === 'HARD'): max
//      piiPerRecipientLimit per recipient per piiPerRecipientWindowHours.
//      First PII msg is delivered normally (existing interstitial
//      handles UX); subsequent PII msg to the SAME recipient inside
//      the window is held.
//
// Limits live in Firestore at `config/messaging` so we can tune them
// without redeploying. Read is cached in-memory for 60s per instance
// to avoid hot-doc reads under fan-out.
//
// Pruning strategy: IN-LINE on each call (we filter stale entries out
// of the user-doc maps before counting). This trades a slightly larger
// user-doc payload for skipping a daily collection-group scan, which
// the prompt explicitly calls out as the cheap option.
// ─────────────────────────────────────────────────────────────
const MESSAGING_CONFIG_DEFAULTS = {
  newAccountWindowHours: 24,
  newAccountMessageLimit: 10,
  breadthWindowHours: 1,
  breadthRecipientLimit: 20,
  duplicateWindowHours: 1,
  duplicateRecipientThreshold: 3,
  piiPerRecipientWindowHours: 24,
  piiPerRecipientLimit: 1,
  enabled: true,
};

// Per-instance cache. Cloud Functions v2 keeps warm instances around
// across invocations, so this stays populated between calls in a way
// that costs us 0 reads beyond the first per 60s window.
let CONFIG_CACHE = {data: null, fetchedAt: 0};
const CONFIG_TTL_MS = 60 * 1000;

async function loadMessagingConfig() {
  const now = Date.now();
  if (CONFIG_CACHE.data && (now - CONFIG_CACHE.fetchedAt) < CONFIG_TTL_MS) {
    return CONFIG_CACHE.data;
  }
  const db = admin.firestore();
  const ref = db.collection("config").doc("messaging");
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      // First read after deploy — seed defaults so admins can tune
      // from the Firebase console immediately.
      try {
        await ref.set(MESSAGING_CONFIG_DEFAULTS, {merge: false});
      } catch (e) {
        logger.warn("loadMessagingConfig: seed failed", e);
      }
      CONFIG_CACHE = {data: {...MESSAGING_CONFIG_DEFAULTS}, fetchedAt: now};
      return CONFIG_CACHE.data;
    }
    const data = {...MESSAGING_CONFIG_DEFAULTS, ...(snap.data() || {})};
    CONFIG_CACHE = {data, fetchedAt: now};
    return data;
  } catch (err) {
    logger.error("loadMessagingConfig: read failed, using defaults", err);
    // Fail open with defaults — we'd rather rate-limit at the default
    // numbers than block every send if the config doc is briefly
    // unreachable.
    return {...MESSAGING_CONFIG_DEFAULTS};
  }
}

function hashMessageContent(text) {
  const norm = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  return require("crypto").createHash("sha256").update(norm).digest("hex");
}

function tsToMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds) return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  if (v instanceof Date) return v.getTime();
  return 0;
}

exports.sendMessage = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in to send messages.");
  }
  const senderId = request.auth.uid;
  const data = request.data || {};
  const conversationId = String(data.conversationId || "").slice(0, 200);
  const recipientId = String(data.recipientId || "").slice(0, 200);
  const text = String(data.text || "");
  const clientFlag = data.clientFlag && typeof data.clientFlag === "object" ?
    data.clientFlag : null;

  if (!conversationId || !recipientId || !text.trim()) {
    throw new HttpsError("invalid-argument", "Missing conversationId, recipientId, or text.");
  }
  if (text.length > 2000) {
    throw new HttpsError("invalid-argument", "Message too long (max 2000 chars).");
  }
  if (recipientId === senderId) {
    throw new HttpsError("invalid-argument", "Cannot message yourself.");
  }

  const config = await loadMessagingConfig();
  if (config.enabled === false) {
    // Kill-switch: if an admin flips `enabled` to false we skip ALL
    // rate-limit checks but still verify conversation membership and
    // write the message via the Admin SDK.
  }

  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const now = Date.now();
  const nowTs = admin.firestore.Timestamp.now();

  // Verify the conversation exists and the sender is a participant.
  // Fail closed — the rules already enforce this on the client path,
  // but since we write via Admin SDK we MUST re-check here.
  const convRef = db.collection("conversations").doc(conversationId);
  const convSnap = await convRef.get();
  if (!convSnap.exists) {
    throw new HttpsError("not-found", "Conversation does not exist.");
  }
  const conv = convSnap.data() || {};
  const participants = Array.isArray(conv.participants) ? conv.participants : [];
  if (!participants.includes(senderId)) {
    throw new HttpsError("permission-denied", "Not a participant of this conversation.");
  }
  if (!participants.includes(recipientId)) {
    throw new HttpsError("invalid-argument", "recipientId is not a participant.");
  }

  // Block check — same semantics as firestore.rules notBlockedByRecipient().
  try {
    const rUserSnap = await db.collection("users").doc(recipientId).get();
    if (rUserSnap.exists) {
      const blocked = (rUserSnap.data() || {}).blocked || {};
      if (blocked && Object.prototype.hasOwnProperty.call(blocked, senderId)) {
        throw new HttpsError("permission-denied", "Recipient has blocked you.");
      }
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.warn("sendMessage: block check failed (continuing)", e);
  }

  // Load sender user doc up-front; all four rules read it.
  const senderRef = db.collection("users").doc(senderId);
  const senderSnap = await senderRef.get();
  const sender = senderSnap.exists ? (senderSnap.data() || {}) : {};

  // ──── Rule 1: new-account send cap ────
  if (config.enabled !== false) {
    const createdAtMs = tsToMillis(sender.createdAt);
    const newAccountWindowMs = config.newAccountWindowHours * 3600 * 1000;
    if (createdAtMs > 0 && (now - createdAtMs) < newAccountWindowMs) {
      // In-line decay: if lastDecayAt is older than the window, reset
      // the counter before checking. Otherwise the user would be
      // limited forever after their first 10 sends.
      const lastDecayAtMs = tsToMillis(sender.lastDecayAt);
      let counter = Number(sender.messagesSent24h) || 0;
      if (lastDecayAtMs > 0 && (now - lastDecayAtMs) >= newAccountWindowMs) {
        counter = 0;
      }
      if (counter >= config.newAccountMessageLimit) {
        throw new HttpsError(
            "resource-exhausted",
            "New accounts can send a limited number of messages in their first 24 hours.",
            {ruleId: "rate_limited_new_account"},
        );
      }
    }
  }

  // ──── Rule 2: breadth cap (distinct recipients/hour) ────
  const breadthWindowMs = config.breadthWindowHours * 3600 * 1000;
  const recentRecipients = (sender.recentRecipients && typeof sender.recentRecipients === "object") ?
    sender.recentRecipients : {};
  // In-line prune: only count entries inside the window.
  const freshRecipients = {};
  for (const [rid, ts] of Object.entries(recentRecipients)) {
    const ms = tsToMillis(ts);
    if (ms > 0 && (now - ms) < breadthWindowMs) {
      freshRecipients[rid] = ts;
    }
  }
  if (config.enabled !== false) {
    const distinctCount = Object.keys(freshRecipients).length;
    const alreadyMessaged = Object.prototype.hasOwnProperty.call(freshRecipients, recipientId);
    // Only NEW recipients tick the count past the limit.
    if (!alreadyMessaged && distinctCount >= config.breadthRecipientLimit) {
      throw new HttpsError(
          "resource-exhausted",
          "You're messaging too many different people too quickly.",
          {ruleId: "rate_limited_breadth"},
      );
    }
  }

  // ──── Rule 3: duplicate-spam-pattern hold ────
  const hash = hashMessageContent(text);
  const duplicateWindowMs = config.duplicateWindowHours * 3600 * 1000;
  const contentHashes = (sender.contentHashes && typeof sender.contentHashes === "object") ?
    sender.contentHashes : {};
  const existingHash = contentHashes[hash] || null;
  let firstSentAtMs = 0;
  let priorRecipients = [];
  if (existingHash) {
    firstSentAtMs = tsToMillis(existingHash.firstSentAt);
    if (firstSentAtMs > 0 && (now - firstSentAtMs) < duplicateWindowMs) {
      priorRecipients = Array.isArray(existingHash.recipients) ? existingHash.recipients : [];
    } else {
      // Stale entry; treat as fresh for this send.
      firstSentAtMs = 0;
      priorRecipients = [];
    }
  }
  const newRecipient = !priorRecipients.includes(recipientId);
  const wouldBeCount = priorRecipients.length + (newRecipient ? 1 : 0);
  let heldByRule3 = false;
  if (
    config.enabled !== false &&
    newRecipient &&
    wouldBeCount >= config.duplicateRecipientThreshold
  ) {
    heldByRule3 = true;
  }

  // ──── Rule 4: PII-per-recipient cap ────
  const piiWindowMs = config.piiPerRecipientWindowHours * 3600 * 1000;
  const isHardPii = !!(clientFlag && clientFlag.severity === "HARD");
  const piiSentTo = (sender.piiSentTo && typeof sender.piiSentTo === "object") ?
    sender.piiSentTo : {};
  let heldByRule4 = false;
  if (config.enabled !== false && isHardPii) {
    const lastPiiAtMs = tsToMillis(piiSentTo[recipientId]);
    if (lastPiiAtMs > 0 && (now - lastPiiAtMs) < piiWindowMs) {
      // Already sent piiPerRecipientLimit (default 1) PII msg in the
      // window — subsequent ones get held.
      heldByRule4 = true;
    }
  }

  // ──── Hold path: write messageHolds/{id}, skip the convo write. ────
  if (heldByRule3 || heldByRule4) {
    const reason = heldByRule3 ? "duplicate_spam_pattern" : "pii_repeated_recipient";
    const holdRef = db.collection("messageHolds").doc();
    try {
      await holdRef.set({
        sender: senderId,
        recipient: recipientId,
        conversationId,
        text,
        reason,
        hash: heldByRule3 ? hash : null,
        clientFlag: clientFlag || null,
        createdAt: FieldValue.serverTimestamp(),
        status: "pending",
      });
    } catch (e) {
      logger.error("sendMessage: messageHolds write failed", e);
      throw new HttpsError("internal", "Could not queue message for review.");
    }
    // Don't bump counters on a held message — the user shouldn't be
    // penalized further for one that won't reach the recipient.
    return {ok: false, held: true, reason};
  }

  // ──── Deliver: Admin-SDK write into conversations/{cid}/messages ────
  const messagePayload = {
    senderId,
    text,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (clientFlag) messagePayload.clientFlag = clientFlag;
  const msgRef = convRef.collection("messages").doc();
  try {
    await msgRef.set(messagePayload);
  } catch (e) {
    logger.error("sendMessage: message write failed", e);
    throw new HttpsError("internal", "Could not send message.");
  }

  // Bump the conversation's last-message fields (the client used to
  // do this; we own it now so the inbox sort and unread badge stay
  // accurate).
  try {
    await convRef.set({
      lastMessageAt: FieldValue.serverTimestamp(),
      lastMessageText: text.slice(0, 100),
      lastMessageSenderId: senderId,
      lastRead: {[senderId]: FieldValue.serverTimestamp()},
    }, {merge: true});
  } catch (e) {
    logger.warn("sendMessage: conv lastMessage bump failed", e);
  }

  // ──── Update sender counters / maps. Single set() with merge so
  // every field lands atomically and we don't pay multiple writes.
  const senderUpdate = {
    messagesSent24h: FieldValue.increment(1),
    lastDecayAt: sender.lastDecayAt || nowTs,
    [`recentRecipients.${recipientId}`]: nowTs,
  };
  // Reset lastDecayAt if we crossed the window — keeps the counter
  // honest under the in-line decay strategy.
  const lastDecayAtMs = tsToMillis(sender.lastDecayAt);
  const newAccountWindowMs = config.newAccountWindowHours * 3600 * 1000;
  if (!lastDecayAtMs || (now - lastDecayAtMs) >= newAccountWindowMs) {
    senderUpdate.messagesSent24h = 1;
    senderUpdate.lastDecayAt = nowTs;
  }

  // contentHashes: append recipient to the hash bucket (or seed a
  // fresh bucket if the previous one had aged out).
  const updatedRecipients = priorRecipients.includes(recipientId) ?
    priorRecipients : priorRecipients.concat([recipientId]);
  senderUpdate[`contentHashes.${hash}`] = {
    recipients: updatedRecipients,
    firstSentAt: firstSentAtMs > 0 ?
      admin.firestore.Timestamp.fromMillis(firstSentAtMs) : nowTs,
  };

  if (isHardPii) {
    senderUpdate[`piiSentTo.${recipientId}`] = nowTs;
  }

  try {
    await senderRef.set(senderUpdate, {merge: true});
  } catch (e) {
    // Counters are best-effort — the message already shipped. Log loudly
    // so we can see if a sender starts evading rate limits because their
    // user doc keeps failing to write.
    logger.error("sendMessage: counter update failed", e);
  }

  return {ok: true, messageId: msgRef.id};
});

// ─────────────────────────────────────────────────────────────
// Push notification triggers (offer / order / payout / saved-search).
// Lives in its own file to keep this monolith from growing further.
// Re-exports its onDocumentCreated/Updated handlers via this require —
// `firebase deploy --only functions` picks them up automatically.
// ─────────────────────────────────────────────────────────────
Object.assign(exports, require("./pushTriggers"));

// Logo Bingo daily push triggers (morning reminder + 9pm streak saver).
// Isolated in its own file so deploys can't blast-radius the offer / order
// triggers above. See bingoPushTriggers.js for the schedule + de-dupe logic.
Object.assign(exports, require("./bingoPushTriggers"));

// Email system (transactional + security + lifecycle + webhooks).
// All Cloud Functions for email live in ./emailTriggers — see that file
// + EMAIL_OPS_RUNBOOK.md for ramp + DNS + bounce-handling docs.
Object.assign(exports, require("./emailTriggers"));

// GDPR marketing-consent capture (updateMarketingConsent +
// dismissMarketingBanner callables). Required by lib/email.js
// preflightAllowed() for any marketing-category send. See
// GDPR_CONSENT_SCHEMA.md for the field shape + audit-trail design.
Object.assign(exports, require("./gdprConsent"));

// Premium subscription lifecycle (email + push). Observes users/{uid}
// tier / proSubscriptionStatus / proCancelAtPeriodEnd transitions written
// by handleSubscriptionUpsert + handleSubscriptionDeleted. See
// PREMIUM_NOTIFICATIONS_TEST.md for the verification runbook.
Object.assign(exports, require("./subscriptionLifecycle"));

// Daily Pro Seller subscription smoke test (04:00 ET). See
// SMOKE_TEST_OPS.md for the runbook + secret setup.
Object.assign(exports, require("./smokeTest"));

// Logo Bingo offline-play sync. Receives the local game state from the
// client after a tap or on reconnect-drain and writes the durable mirror
// to users/{uid}/bingoGames/{date}. See ./bingoSync.js for the validation
// model.
Object.assign(exports, require("./bingoSync"));

// Logo Bingo leaderboards — daily-percentile / friends / country /
// global-streak surfaces. Reacts to users/{uid}/bingoGames/{date}
// creates (written by syncBingoProgress in ./bingoSync.js) via the
// onBingoWinAggregate trigger; exposes four callables for the post-win
// results panel in index.html (getBingoPercentile,
// getBingoCountryPercentile, getBingoFriendsBoard,
// getBingoGlobalStreakRecord).
Object.assign(exports, require("./bingoLeaderboards"));

// Daily transactional email smoke test (04:00 ET). Sends 4 templates to
// SMOKE_EMAIL_INBOX via Resend, waits 60s, verifies last_event via the
// Resend API. See EMAIL_SMOKE_OPS.md for the runbook + secret setup.
Object.assign(exports, require("./emailSmokeTest"));

// AbandonedCart lifecycle scheduler — daily 15:00 ET. Sends the
// AbandonedCart email to users with >=$100 of watchlist value, no purchase
// in the last 7d, no abandonedCart email in the last 30d, and GDPR
// marketing consent. See ./abandonedCartTrigger.js for the heuristic.
Object.assign(exports, require("./abandonedCartTrigger"));

// Missing email producers per EMAIL_TRIGGER_AUDIT.md sections #23, #24,
// #26, #27. Wires a Stripe Connect webhook (payout.paid → payouts/{id}),
// the saved-search match scheduler V2 (correct schema), and the price-
// drop producer+emailer. See ./missingProducers.js header for detail.
// NOTE: Producer 2 (refund-issued) is wired inline in `refundOrder`
// above — it writes refunds/{stripeRefundId} after the Stripe refund
// succeeds.
Object.assign(exports, require("./missingProducers"));

// Marketing pause-30-days toggle (setMarketingPause callable). Writes
// users/{uid}.marketingPausedUntil so the email send gate can skip
// marketing-cat sends without revoking GDPR consent. Backs the
// "Pause all marketing" toggle in account-settings → Email preferences.
Object.assign(exports, require("./emailPauseToggle"));

// Security + listing-live email producers per EMAIL_TRIGGER_AUDIT.md
// sections #2, #4, #5, #6, #7, #8, #9. Exposes `notifySecurityEvent`
// (callable, fired from index.html security handlers after a successful
// password / email / payout / deletion / verify event) and the
// `onListingLive` Firestore trigger. See ./securityEmailTriggers.js
// header for the metadata-capture + idempotency policy.
Object.assign(exports, require("./securityEmailTriggers"));


// Email usage monitor — alerts when Resend Free-tier 100/day cap approaches.
Object.assign(exports, require("./emailUsageMonitor"));
