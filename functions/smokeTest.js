/**
 * functions/smokeTest.js — daily Pro Seller subscription smoke test.
 *
 * Runs every morning at 04:00 America/New_York and exercises the FULL
 * Pro upgrade lifecycle end-to-end against Stripe TEST mode:
 *
 *   1. setup_user            ensure smoke Firebase user exists & is clean
 *   2. create_customer       fresh Stripe TEST customer w/ firebaseUid
 *   3. attach_pm             test card 4242…  attach + set as default
 *   4. create_subscription   subscribe to STRIPE_TEST_PRO_PRICE_ID
 *   5. verify_pro_flip       trigger upsert handler, assert tier='pro'
 *   6. cancel_at_period_end  set cancel_at_period_end=true
 *   7. verify_cancel_pending tier still 'pro', proCancelAtPeriodEnd=true
 *   8. immediate_cancel      stripe.subscriptions.cancel(id)
 *   9. verify_downgrade      tier='free', profile isPro=false, status='canceled'
 *  10. teardown              delete Stripe customer + reset user doc fields
 *
 * Every step is wrapped in `step()` which records {name, ok, ms, err}. On
 * any uncaught error OR failed assertion the function:
 *   - writes Firestore `smokeRuns/{YYYY-MM-DD}` with `{ok:false, ...}`
 *   - emits `logger.error("[SMOKE] FAIL", ...)` for Cloud Logging alerts
 *   - POSTs to SMOKE_ALERT_WEBHOOK if set (Slack/Discord/Zapier)
 *   - best-effort tears down the Stripe customer so we don't accumulate
 *     orphan TEST objects
 *
 * Idempotent: every run resets the smoke user's billing fields back to a
 * clean baseline at setup, so a previous run that crashed mid-flight
 * doesn't poison today's run.
 *
 * The smoke deliberately calls the SAME handleSubscriptionUpsert /
 * handleSubscriptionDeleted that the live webhook router calls (both
 * import from ./lib/subscription) — that's the point. If we duplicated
 * the upsert logic here, the smoke could pass while the real webhook
 * silently broke. See SMOKE_TEST_OPS.md.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onRequest} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");
const stripe = require("stripe");
const https = require("https");
const http = require("http");
const {URL} = require("url");

const {
  handleSubscriptionUpsert,
  handleSubscriptionDeleted,
} = require("./lib/subscription");

// ── Secrets ─────────────────────────────────────────────────────
// These MUST be Stripe TEST-mode credentials. setup() guards against a
// live-mode key being pasted by accident (sk_live_...) — see step 1.
const STRIPE_TEST_SECRET_KEY = defineSecret("STRIPE_TEST_SECRET_KEY");
const STRIPE_TEST_PRO_PRICE_ID = defineSecret("STRIPE_TEST_PRO_PRICE_ID");
// Optional. If set, we POST { text } to this URL on failure. Designed for
// Slack/Discord/Zapier inbound webhooks — anything that accepts a plain
// JSON POST and routes to a human within minutes.
const SMOKE_ALERT_WEBHOOK = defineSecret("SMOKE_ALERT_WEBHOOK");

// Fixed identifiers so reruns are idempotent. `.invalid` TLD is reserved
// by RFC 2606 and CANNOT route real email — safe to use as a dummy.
const SMOKE_UID = "smoke-test-pro-uid";
const SMOKE_EMAIL = "smoke-test@teeboxmarket.invalid";

// How long to poll for the post-upsert Firestore writes to land. The
// handler itself is sync (we await it), but if we ever switch to firing
// via Stripe's webhook for parity, this poll already handles that case.
const VERIFY_POLL_MS = 30_000;
const VERIFY_POLL_INTERVAL_MS = 500;

// ─────────────────────────────────────────────────────────────────
// Scheduled trigger — once per day at 04:00 US-Eastern.
// 04:00 was chosen because:
//   • after the nightly Stripe payout cutoff (so we don't race it)
//   • before US morning traffic (so a failure has hours of human
//     working time to be triaged before the day starts)
//   • America/New_York is the user's TZ (see SMOKE_TEST_OPS.md if
//     this ever needs to follow the sun for an EU team)
// ─────────────────────────────────────────────────────────────────
exports.smokeProUpgrade = onSchedule({
  schedule: "every day 04:00",
  timeZone: "America/New_York",
  region: "us-central1",
  secrets: [
    STRIPE_TEST_SECRET_KEY,
    STRIPE_TEST_PRO_PRICE_ID,
    SMOKE_ALERT_WEBHOOK,
  ],
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  await runSmoke({trigger: "schedule"});
});

// ─────────────────────────────────────────────────────────────────
// Manual trigger — POST to this URL (admin-only) to force a run.
//
//   curl -X POST -H "X-Smoke-Trigger: 1" \
//     https://us-central1-<project>.cloudfunctions.net/smokeProUpgradeManual
//
// We require the X-Smoke-Trigger header as a trivial speed bump against
// crawlers. The endpoint is otherwise public — there's nothing to abuse
// because the smoke is rate-limited by its own duration (~30s) and only
// ever touches the dedicated smoke user + Stripe TEST mode.
// ─────────────────────────────────────────────────────────────────
exports.smokeProUpgradeManual = onRequest({
  region: "us-central1",
  secrets: [
    STRIPE_TEST_SECRET_KEY,
    STRIPE_TEST_PRO_PRICE_ID,
    SMOKE_ALERT_WEBHOOK,
  ],
  timeoutSeconds: 540,
  memory: "512MiB",
}, async (req, res) => {
  if (req.method !== "POST" || req.get("X-Smoke-Trigger") !== "1") {
    res.status(404).send("Not found");
    return;
  }
  const result = await runSmoke({trigger: "manual"});
  res.status(result.ok ? 200 : 500).json(result);
});

// ─────────────────────────────────────────────────────────────────
// Core run loop.
// ─────────────────────────────────────────────────────────────────
async function runSmoke({trigger}) {
  const startedAt = Date.now();
  const steps = [];
  const ctx = {
    stripeClient: null,
    testCustomerId: null,
    testSubId: null,
    testPaymentMethodId: null,
  };

  try {
    // Hard guard against accidentally running against live Stripe.
    const key = STRIPE_TEST_SECRET_KEY.value();
    if (!key || !key.startsWith("sk_test_")) {
      throw new Error(
        "STRIPE_TEST_SECRET_KEY missing or not a test-mode key " +
        "(must start with sk_test_)");
    }
    const priceId = STRIPE_TEST_PRO_PRICE_ID.value();
    if (!priceId || !priceId.startsWith("price_")) {
      throw new Error(
        "STRIPE_TEST_PRO_PRICE_ID missing or malformed " +
        "(must start with price_)");
    }
    ctx.stripeClient = stripe(key);

    await step("setup_user", steps, () => setupUser(ctx));
    await step("create_customer", steps, () => createCustomer(ctx));
    await step("attach_pm", steps, () => attachPaymentMethod(ctx));
    await step("create_subscription", steps,
      () => createSubscription(ctx, priceId));
    await step("verify_pro_flip", steps, () => verifyProFlip(ctx));
    await step("cancel_at_period_end", steps,
      () => cancelAtPeriodEnd(ctx));
    await step("verify_cancel_pending", steps,
      () => verifyCancelPending(ctx));
    await step("immediate_cancel", steps, () => immediateCancel(ctx));
    await step("verify_downgrade", steps, () => verifyDowngrade(ctx));
    await step("teardown", steps, () => teardown(ctx));

    const durationMs = Date.now() - startedAt;
    await writeRunResult({
      ok: true,
      trigger,
      steps,
      durationMs,
      stepsCompleted: steps.map((s) => s.name),
    });
    logger.info("[SMOKE] PASS", {durationMs, trigger, stepsCompleted: steps.length});
    return {ok: true, durationMs, steps};
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const failedStep = (steps.length && !steps[steps.length - 1].ok) ?
      steps[steps.length - 1].name :
      "unknown";
    const errorMsg = err && (err.message || String(err)) || "unknown";
    logger.error("[SMOKE] FAIL", {
      failedStep,
      error: errorMsg,
      durationMs,
      trigger,
      steps,
    });

    // Best-effort teardown so we don't accumulate orphan Stripe TEST
    // objects across failed runs. Swallow every error here — we're
    // already in the error path, the alert has the real info.
    if (ctx.stripeClient && ctx.testCustomerId) {
      try {
        await ctx.stripeClient.customers.del(ctx.testCustomerId);
      } catch (_e) { /* swallow */ }
    }
    // Also wipe the smoke user's billing fields so tomorrow starts clean.
    try {
      await admin.firestore().doc(`users/${SMOKE_UID}`).set({
        stripeCustomerId: admin.firestore.FieldValue.delete(),
        proSubscriptionId: admin.firestore.FieldValue.delete(),
        proSubscriptionStatus: admin.firestore.FieldValue.delete(),
        proCurrentPeriodEnd: admin.firestore.FieldValue.delete(),
        proCancelAtPeriodEnd: admin.firestore.FieldValue.delete(),
        tier: "free",
      }, {merge: true});
    } catch (_e) { /* swallow */ }

    await writeRunResult({
      ok: false,
      trigger,
      failedStep,
      error: errorMsg,
      steps,
      durationMs,
    });
    await sendAlert({failedStep, error: errorMsg, steps, durationMs, trigger});
    return {ok: false, failedStep, error: errorMsg, steps, durationMs};
  }
}

// ─────────────────────────────────────────────────────────────────
// step() — wraps a fn, records timing, propagates errors.
// ─────────────────────────────────────────────────────────────────
async function step(name, accum, fn) {
  const t = Date.now();
  try {
    await fn();
    accum.push({name, ok: true, ms: Date.now() - t});
  } catch (e) {
    accum.push({
      name,
      ok: false,
      ms: Date.now() - t,
      err: e && (e.message || String(e)) || "unknown",
    });
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 1 — setup_user. Ensure the smoke user exists in Firebase Auth
// + has a baseline users/{uid} doc. Wipe any leftover billing state
// from a crashed prior run so the test starts clean every time.
// ─────────────────────────────────────────────────────────────────
async function setupUser() {
  let userRecord = null;
  try {
    userRecord = await admin.auth().getUser(SMOKE_UID);
  } catch (e) {
    if (e && e.code === "auth/user-not-found") {
      userRecord = await admin.auth().createUser({
        uid: SMOKE_UID,
        email: SMOKE_EMAIL,
        emailVerified: false,
        displayName: "TeeBox Pro Smoke",
        disabled: false,
      });
    } else {
      throw e;
    }
  }
  if (!userRecord || userRecord.uid !== SMOKE_UID) {
    throw new Error(`setup_user: unexpected user record ${userRecord && userRecord.uid}`);
  }

  // Baseline reset — wipe any leftover billing state. Note we use
  // FieldValue.delete() not null so the firestore.where queries that
  // look up by stripeCustomerId don't accidentally match a stale doc.
  const db = admin.firestore();
  await db.doc(`users/${SMOKE_UID}`).set({
    email: SMOKE_EMAIL,
    isSmokeTestUser: true,
    tier: "free",
    stripeCustomerId: admin.firestore.FieldValue.delete(),
    proSubscriptionId: admin.firestore.FieldValue.delete(),
    proSubscriptionStatus: admin.firestore.FieldValue.delete(),
    proCurrentPeriodEnd: admin.firestore.FieldValue.delete(),
    proCancelAtPeriodEnd: admin.firestore.FieldValue.delete(),
    proSubscriptionUpdatedAt: admin.firestore.FieldValue.delete(),
  }, {merge: true});
  await db.doc(`profiles/${SMOKE_UID}`).set({
    isPro: false,
    isSmokeTestUser: true,
    isProUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

// ─────────────────────────────────────────────────────────────────
// Step 2 — create_customer. Fresh Stripe TEST customer per run, with
// metadata.firebaseUid mirroring what createSubscriptionCheckout
// would set in production. Persist the id on users/{uid} so the
// upsert handler's reverse-lookup (findUserByStripeCustomer) hits.
// ─────────────────────────────────────────────────────────────────
async function createCustomer(ctx) {
  const customer = await ctx.stripeClient.customers.create({
    email: SMOKE_EMAIL,
    description: "TeeBox daily smoke test customer (TEST mode)",
    metadata: {firebaseUid: SMOKE_UID, isSmokeTest: "1"},
  });
  ctx.testCustomerId = customer.id;
  await admin.firestore().doc(`users/${SMOKE_UID}`).set({
    stripeCustomerId: customer.id,
  }, {merge: true});
}

// ─────────────────────────────────────────────────────────────────
// Step 3 — attach_pm. Use Stripe's well-known test PaymentMethod token
// (pm_card_visa) instead of constructing one from raw card numbers —
// the raw-card path requires `card` API access which restricted keys
// might not have. pm_card_visa is the canonical "successful charge"
// test PM and is equivalent to 4242 4242 4242 4242.
// ─────────────────────────────────────────────────────────────────
async function attachPaymentMethod(ctx) {
  // Test PaymentMethod helper. Equivalent to 4242 4242 4242 4242 / any
  // future date / any CVC. Stripe maintains this — see
  // https://docs.stripe.com/testing#cards
  const pm = await ctx.stripeClient.paymentMethods.create({
    type: "card",
    card: {token: "tok_visa"},
  });
  ctx.testPaymentMethodId = pm.id;
  await ctx.stripeClient.paymentMethods.attach(pm.id, {
    customer: ctx.testCustomerId,
  });
  await ctx.stripeClient.customers.update(ctx.testCustomerId, {
    invoice_settings: {default_payment_method: pm.id},
  });
}

// ─────────────────────────────────────────────────────────────────
// Step 4 — create_subscription. Same shape as createSubscriptionCheckout
// would produce server-side, minus the Checkout UI wrapper. Expanding
// latest_invoice.payment_intent lets us see PI status if it's stuck
// (3DS authentication required, etc.) for richer error messages.
// ─────────────────────────────────────────────────────────────────
async function createSubscription(ctx, priceId) {
  const sub = await ctx.stripeClient.subscriptions.create({
    customer: ctx.testCustomerId,
    items: [{price: priceId}],
    default_payment_method: ctx.testPaymentMethodId,
    payment_behavior: "default_incomplete",
    expand: ["latest_invoice.payment_intent"],
    metadata: {firebaseUid: SMOKE_UID, isSmokeTest: "1"},
  });
  ctx.testSubId = sub.id;

  // payment_behavior:'default_incomplete' makes Stripe leave the sub
  // in `incomplete` and expose the PI so we can confirm it. Confirm
  // the PI with our test PM to activate the subscription.
  const pi = sub.latest_invoice && sub.latest_invoice.payment_intent;
  if (pi && pi.status !== "succeeded") {
    await ctx.stripeClient.paymentIntents.confirm(pi.id, {
      payment_method: ctx.testPaymentMethodId,
    });
  }

  // Re-read to get the updated status after PI confirmation.
  const fresh = await ctx.stripeClient.subscriptions.retrieve(sub.id);
  if (fresh.status !== "active" && fresh.status !== "trialing") {
    throw new Error(
      `create_subscription: expected active/trialing, got status='${fresh.status}'`);
  }
  ctx.activeSub = fresh;
}

// ─────────────────────────────────────────────────────────────────
// Step 5 — verify_pro_flip. Call the SAME handler the live webhook
// fires (imported from ./lib/subscription) and poll the user doc.
// We poll rather than just assert immediately so we'd catch a future
// regression where the handler ever becomes async-via-trigger.
// ─────────────────────────────────────────────────────────────────
async function verifyProFlip(ctx) {
  await handleSubscriptionUpsert(ctx.activeSub);

  const userSnap = await pollForUserDoc((data) =>
    data && data.tier === "pro" &&
    data.proSubscriptionStatus === "active" &&
    data.proCurrentPeriodEnd);
  const data = userSnap.data();

  // The upsert helper writes proCurrentPeriodEnd as a Firestore
  // Timestamp. Convert defensively — depending on emulator vs prod
  // it could come back as a Timestamp instance or a plain object.
  const cpe = data.proCurrentPeriodEnd;
  const cpeMillis = cpe && typeof cpe.toMillis === "function" ?
    cpe.toMillis() :
    cpe && cpe._seconds ? cpe._seconds * 1000 :
    cpe && cpe.seconds ? cpe.seconds * 1000 : 0;
  if (cpeMillis <= Date.now()) {
    throw new Error(
      `verify_pro_flip: proCurrentPeriodEnd not in future (got ${cpeMillis})`);
  }

  const profileSnap = await admin.firestore()
    .doc(`profiles/${SMOKE_UID}`).get();
  if (!profileSnap.exists || profileSnap.data().isPro !== true) {
    throw new Error("verify_pro_flip: profiles/{uid}.isPro is not true");
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 6 — cancel_at_period_end. Standard "soft cancel" path the
// Customer Portal exposes. Subscription stays active, tier stays
// 'pro' until the period actually ends.
// ─────────────────────────────────────────────────────────────────
async function cancelAtPeriodEnd(ctx) {
  const updated = await ctx.stripeClient.subscriptions.update(
    ctx.testSubId, {cancel_at_period_end: true});
  if (!updated.cancel_at_period_end) {
    throw new Error(
      "cancel_at_period_end: Stripe didn't accept cancel_at_period_end=true");
  }
  ctx.pendingCancelSub = updated;
}

// ─────────────────────────────────────────────────────────────────
// Step 7 — verify_cancel_pending. Re-fire upsert with the new sub
// object, expect tier='pro' still + proCancelAtPeriodEnd=true.
// This protects the buyer-still-sees-pro-badge invariant during
// the wind-down window — if it breaks, sellers who cancel today
// lose their pro fees retroactively, which is a billing bug.
// ─────────────────────────────────────────────────────────────────
async function verifyCancelPending(ctx) {
  await handleSubscriptionUpsert(ctx.pendingCancelSub);

  const userSnap = await pollForUserDoc((data) =>
    data && data.proCancelAtPeriodEnd === true && data.tier === "pro");
  const data = userSnap.data();
  if (data.proSubscriptionStatus !== "active" &&
      data.proSubscriptionStatus !== "trialing") {
    throw new Error(
      "verify_cancel_pending: proSubscriptionStatus dropped from active");
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 8 — immediate_cancel. Simulate the period actually ending.
// `stripe.subscriptions.cancel(id)` is the test-friendly equivalent
// of waiting ~30 days for the period to roll over.
// ─────────────────────────────────────────────────────────────────
async function immediateCancel(ctx) {
  const canceled = await ctx.stripeClient.subscriptions.cancel(
    ctx.testSubId);
  if (canceled.status !== "canceled") {
    throw new Error(
      `immediate_cancel: expected status='canceled', got '${canceled.status}'`);
  }
  ctx.canceledSub = canceled;
}

// ─────────────────────────────────────────────────────────────────
// Step 9 — verify_downgrade. Fire the deleted handler the same way
// the customer.subscription.deleted webhook does, then verify the
// user is fully reverted to free + the public profile flag flipped.
// ─────────────────────────────────────────────────────────────────
async function verifyDowngrade(ctx) {
  await handleSubscriptionDeleted(ctx.canceledSub);

  const userSnap = await pollForUserDoc((data) =>
    data && data.tier === "free" &&
    data.proSubscriptionStatus === "canceled");

  const profileSnap = await admin.firestore()
    .doc(`profiles/${SMOKE_UID}`).get();
  if (!profileSnap.exists || profileSnap.data().isPro !== false) {
    throw new Error("verify_downgrade: profiles/{uid}.isPro is not false");
  }
  // Belt-and-suspenders: proCancelAtPeriodEnd should have been cleared
  // by handleSubscriptionDeleted so a future re-subscribe doesn't
  // immediately appear to be "ending".
  if (userSnap.data().proCancelAtPeriodEnd === true) {
    throw new Error(
      "verify_downgrade: proCancelAtPeriodEnd should have been cleared");
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 10 — teardown. Delete the Stripe TEST customer (cascades to
// the subscription, the invoices, the PM) and zero out billing fields
// on users/{SMOKE_UID}. Leave the user doc itself in place so the next
// run can skip the auth.createUser hop.
// ─────────────────────────────────────────────────────────────────
async function teardown(ctx) {
  if (ctx.testCustomerId) {
    try {
      await ctx.stripeClient.customers.del(ctx.testCustomerId);
    } catch (e) {
      // If the customer is already gone (manual cleanup, prior crash),
      // that's fine. Anything else, surface it.
      if (!/No such customer/i.test(e && e.message || "")) throw e;
    }
  }
  await admin.firestore().doc(`users/${SMOKE_UID}`).set({
    stripeCustomerId: admin.firestore.FieldValue.delete(),
    proSubscriptionId: admin.firestore.FieldValue.delete(),
  }, {merge: true});
}

// ─────────────────────────────────────────────────────────────────
// pollForUserDoc — poll users/{SMOKE_UID} until predicate returns
// truthy or we hit VERIFY_POLL_MS. The handler we call is sync
// (awaited), so in practice the first poll always wins — but the
// poll guards against future async refactors.
// ─────────────────────────────────────────────────────────────────
async function pollForUserDoc(predicate) {
  const start = Date.now();
  const ref = admin.firestore().doc(`users/${SMOKE_UID}`);
  let lastData = null;
  while (Date.now() - start < VERIFY_POLL_MS) {
    const snap = await ref.get();
    if (snap.exists) {
      lastData = snap.data();
      if (predicate(lastData)) return snap;
    }
    await sleep(VERIFY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `pollForUserDoc timeout after ${VERIFY_POLL_MS}ms ` +
    `(last data keys: ${lastData ? Object.keys(lastData).join(",") : "<none>"})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
// Run results — durable record per-day. `smokeRuns/{YYYY-MM-DD}`.
// We use the date as the doc id so the most-recent run for a given
// day overwrites the prior; if you need historical detail, list the
// subcollection `runs` we also append to.
// ─────────────────────────────────────────────────────────────────
async function writeRunResult(result) {
  const today = new Date().toISOString().slice(0, 10);
  const db = admin.firestore();
  const payload = {
    ...result,
    ranAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  try {
    await db.doc(`smokeRuns/${today}`).set(payload, {merge: true});
    // Append-only history. Smoke runs rarely — keeping every run is fine.
    await db.collection("smokeRuns").doc(today)
      .collection("runs").add(payload);
  } catch (e) {
    logger.error(
      `[SMOKE] writeRunResult failed: ${e && e.message || e}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// sendAlert — POST a one-line summary to SMOKE_ALERT_WEBHOOK if set.
// Compatible with Slack ("text"), Discord ("content"), and the
// generic { text } shape Zapier/etc. accept. We send all three keys
// so a single webhook URL works regardless of which service it is.
// ─────────────────────────────────────────────────────────────────
async function sendAlert({failedStep, error, steps, durationMs, trigger}) {
  let url;
  try {
    url = SMOKE_ALERT_WEBHOOK.value();
  } catch (_e) {
    // Secret not set — that's fine, the Firestore + logger.error layers
    // are still active. Documented behavior.
    return;
  }
  if (!url) return;

  const stepsSummary = steps.map((s) =>
    `${s.ok ? "ok" : "FAIL"} ${s.name} (${s.ms}ms)`).join("\n");
  const message =
    `TeeBox Pro Subscription Smoke FAILED\n` +
    `Step: ${failedStep}\n` +
    `Error: ${error}\n` +
    `Trigger: ${trigger}\n` +
    `Duration: ${durationMs}ms\n` +
    `Steps:\n${stepsSummary}`;

  const body = JSON.stringify({
    text: message, content: message, message,
  });

  try {
    await postJson(url, body);
  } catch (e) {
    logger.error(
      `[SMOKE] sendAlert webhook POST failed: ${e && e.message || e}`);
  }
}

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (e) {
      reject(new Error(`invalid SMOKE_ALERT_WEBHOOK URL: ${e.message}`));
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10_000,
    }, (res) => {
      // Drain so the socket can close.
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`webhook POST returned ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("webhook POST timeout"));
    });
    req.write(body);
    req.end();
  });
}
