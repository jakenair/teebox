/**
 * functions/lib/subscription.js — Pro Seller subscription lifecycle helpers.
 *
 * Single source of truth for translating a Stripe `subscription` object into
 * the Firestore writes that flip a user between `tier='free'` and
 * `tier='pro'`. Imported by:
 *   • functions/index.js — invoked from the stripeWebhook router on
 *     customer.subscription.{created,updated,deleted}.
 *   • functions/smokeTest.js — invoked from the daily smoke so the smoke
 *     exercises the SAME logic the live webhook fires.
 *
 * Keeping this in one module is what makes the smoke meaningful: if it
 * drifted from the webhook handler, the smoke could pass while the real
 * webhook silently broke.
 *
 * Public surface:
 *   handleSubscriptionUpsert(sub)   — customer.subscription.{created,updated}
 *   handleSubscriptionDeleted(sub)  — customer.subscription.deleted
 *   findUserByStripeCustomer(cid)   — reverse-lookup helper, exposed for tests
 *   mirrorTierToProfile(uid, isPro) — public-profile mirror (also used by
 *                                     manual repair scripts)
 *
 * Status mapping (must match the comment above handleSubscriptionUpsert in
 * the original webhook router):
 *   active | trialing            → tier='pro'
 *   past_due                     → tier='pro' (Smart Retries window)
 *   canceled | unpaid | incomplete_expired → tier='free'
 *   incomplete                   → leave as-is (not paid yet)
 */

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");

const PRO_ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
const PRO_INACTIVE_STATUSES = new Set([
  "canceled", "unpaid", "incomplete_expired",
]);

async function findUserByStripeCustomer(customerId) {
  if (!customerId) return null;
  const db = admin.firestore();
  const snap = await db.collection("users")
    .where("stripeCustomerId", "==", customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

// Mirror the Pro tier flag to the public profile doc so other users
// (buyers browsing listings) can see the badge. profiles/{uid} is
// publicly readable; users/{uid} is self-only. We write a single
// boolean (`isPro`) to keep the public surface area minimal.
async function mirrorTierToProfile(uid, isPro) {
  if (!uid) return;
  const db = admin.firestore();
  try {
    await db.doc(`profiles/${uid}`).set({
      isPro: !!isPro,
      isProUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  } catch (e) {
    logger.warn(`mirrorTierToProfile failed for ${uid}: ${e.message}`);
  }
}

// H2 helper: look up the user by `sub.metadata.firebaseUid` and back-fill
// `users/{uid}.stripeCustomerId` if missing. Returns a userDoc-shaped
// object compatible with findUserByStripeCustomer (so callers can use
// `.ref` + `.id` + `.data()` uniformly).
async function findUserByMetadataFallback(sub) {
  const fallbackUid = sub && sub.metadata && sub.metadata.firebaseUid;
  if (!fallbackUid) return null;
  const ref = admin.firestore().doc(`users/${fallbackUid}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  // Back-fill the stripeCustomerId so subsequent webhooks resolve fast.
  if (sub.customer) {
    try {
      await ref.set({stripeCustomerId: sub.customer}, {merge: true});
    } catch (e) {
      logger.warn(`back-fill stripeCustomerId failed: ${e.message}`);
    }
  }
  // Shape this like a Firestore DocumentSnapshot: callers use
  // userDoc.ref, userDoc.id, and userDoc.data().
  return {
    id: fallbackUid,
    ref,
    data: () => snap.data(),
  };
}

async function handleSubscriptionUpsert(sub, eventCreatedSec) {
  if (!sub || !sub.id) return;
  let userDoc = await findUserByStripeCustomer(sub.customer);
  if (!userDoc) {
    // H2: try the metadata.firebaseUid fallback before giving up. This
    // catches the race where users/{uid}.stripeCustomerId hasn't been
    // written yet (e.g. checkout completed but createSubscriptionCheckout
    // didn't get to flush the user doc).
    userDoc = await findUserByMetadataFallback(sub);
  }
  if (!userDoc) {
    // H2: transient — a read-replica may be stale, or the user doc
    // simply hasn't been written yet. Tell Stripe to retry instead of
    // silently dropping the event (the idempotency marker would
    // otherwise permanently swallow it).
    const err = new Error(
      `No user found for customer ${sub.customer} ` +
      "or metadata.firebaseUid",
    );
    err.transient = true;
    throw err;
  }
  // H4: out-of-order guard. Stripe doesn't guarantee event ordering —
  // an older `customer.subscription.updated` can arrive after a newer
  // one (or after subscription.deleted). Compare event.created to the
  // last upsert timestamp on the user doc and bail if we're older.
  const docData = (typeof userDoc.data === "function") ?
    (userDoc.data() || {}) : (userDoc.data || {});
  const existingUpdatedAt = docData.proSubscriptionUpdatedAt;
  const eventTimeMs = (eventCreatedSec || 0) * 1000;
  if (existingUpdatedAt && typeof existingUpdatedAt.toMillis === "function" &&
      eventTimeMs > 0 && eventTimeMs < existingUpdatedAt.toMillis()) {
    logger.info(
      `Skipping out-of-order subscription event for ${userDoc.id}: ` +
      `event.created=${new Date(eventTimeMs).toISOString()} ` +
      `< proSubscriptionUpdatedAt=${existingUpdatedAt.toDate().toISOString()}`,
    );
    return;
  }
  const status = sub.status || "incomplete";
  const update = {
    proSubscriptionId: sub.id,
    proSubscriptionStatus: status,
    proSubscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (PRO_ACTIVE_STATUSES.has(status)) {
    update.tier = "pro";
    if (sub.current_period_end) {
      update.proCurrentPeriodEnd = admin.firestore.Timestamp.fromMillis(
        sub.current_period_end * 1000,
      );
    }
    if (sub.cancel_at_period_end) {
      update.proCancelAtPeriodEnd = true;
    } else {
      update.proCancelAtPeriodEnd = false;
    }
  } else if (PRO_INACTIVE_STATUSES.has(status)) {
    update.tier = "free";
  }
  // For status='incomplete' we don't downgrade — the user just hasn't
  // paid yet. They stay on whatever tier they had before.
  await userDoc.ref.set(update, {merge: true});
  if (update.tier) {
    await mirrorTierToProfile(userDoc.id, update.tier === "pro");
    // Revoke refresh tokens so the new tier propagates immediately —
    // otherwise the user's stale ID token (up to 1h old) would still
    // report the previous tier when the client reads custom claims.
    try {
      await admin.auth().revokeRefreshTokens(userDoc.id);
    } catch (e) {
      logger.warn(
        `revokeRefreshTokens after tier change failed for ${userDoc.id}: ${e.message}`);
    }
  }
  logger.info(
    `Subscription ${sub.id} → ${status} for ${userDoc.id} ` +
    `(tier=${update.tier || "unchanged"})`,
  );
}

async function handleSubscriptionDeleted(sub, eventCreatedSec) {
  if (!sub || !sub.id) return;
  let userDoc = await findUserByStripeCustomer(sub.customer);
  if (!userDoc) {
    // H2: same metadata fallback as upsert.
    userDoc = await findUserByMetadataFallback(sub);
  }
  if (!userDoc) {
    const err = new Error(
      `subscription.deleted for unknown customer ${sub.customer}`,
    );
    err.transient = true;
    throw err;
  }
  // H4: out-of-order guard. If a newer event already downgraded the
  // user, don't replay an older deleted event. (Deleted is the terminal
  // state, so this guard mainly protects against deleted-then-updated
  // races where Stripe re-fires an old "updated" after deletion.)
  const docData = (typeof userDoc.data === "function") ?
    (userDoc.data() || {}) : (userDoc.data || {});
  const existingUpdatedAt = docData.proSubscriptionUpdatedAt;
  const eventTimeMs = (eventCreatedSec || 0) * 1000;
  if (existingUpdatedAt && typeof existingUpdatedAt.toMillis === "function" &&
      eventTimeMs > 0 && eventTimeMs < existingUpdatedAt.toMillis()) {
    logger.info(
      `Skipping out-of-order subscription.deleted for ${userDoc.id}`,
    );
    return;
  }
  await userDoc.ref.set({
    tier: "free",
    proSubscriptionStatus: "canceled",
    proSubscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    proCancelAtPeriodEnd: false,
  }, {merge: true});
  await mirrorTierToProfile(userDoc.id, false);
  logger.info(`Subscription ${sub.id} canceled for ${userDoc.id}`);
}

module.exports = {
  PRO_ACTIVE_STATUSES,
  PRO_INACTIVE_STATUSES,
  findUserByStripeCustomer,
  mirrorTierToProfile,
  handleSubscriptionUpsert,
  handleSubscriptionDeleted,
};
