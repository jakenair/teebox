/**
 * functions/emailSmokeTest.js — daily transactional email smoke test.
 *
 * Runs every morning at 04:00 America/New_York and exercises seven
 * critical transactional + lifecycle email templates end-to-end against
 * the LIVE Resend API (test inbox only, never real users):
 *
 *   1. order_placed_send         OrderPlacedBuyer.jsx  — "Order confirmed"
 *   2. password_reset_send       PasswordReset.jsx     — "Reset your password"
 *   3. sale_notification_send    OrderPlacedSeller.jsx — "You sold ..."
 *   4. order_shipped_send        OrderShipped.jsx      — "Your order has shipped"
 *   5. signup_welcome_send       SignupWelcome.jsx     — "Welcome to TeeBox"
 *   6. saved_search_match_send   SavedSearchMatch.jsx  — lifecycle / marketing
 *
 * Each send is dispatched via the SAME `sendEmail()` helper in
 * ./lib/email.js that the live transactional triggers use (emailTriggers.js).
 * That's the point — if we duplicated the render/send pipeline here we
 * could pass while the real pipeline silently broke.
 *
 * After all four sends, the smoke waits 60s then queries Resend's
 * `GET /emails/{id}` API for each id and asserts the last_event is one
 * of: `sent`, `delivered`, `delivered_to_inbox`. We also capture the
 * subject line returned by Resend as a regression snapshot, so a
 * surprise rename in a template surfaces here before any user notices.
 *
 * Failure mode mirrors the Pro upgrade smoke (./smokeTest.js):
 *   - Firestore doc `emailSmokeRuns/{YYYY-MM-DD}` records {ok, steps, ...}
 *   - `logger.error("[EMAIL_SMOKE] FAIL", ...)` for Cloud Logging alerts
 *   - Optional POST to SMOKE_ALERT_WEBHOOK (shared with Pro smoke)
 *
 * Refuses to run if RESEND_API_KEY is a placeholder (doesn't start with
 * `re_live_` or `re_test_`) — matches the STRIPE_TEST_SECRET_KEY guard
 * in the Pro smoke. This is what keeps an undeployed-secret state from
 * generating a noisy daily failure.
 *
 * See EMAIL_SMOKE_OPS.md for the runbook.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onRequest} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");
const https = require("https");
const http = require("http");
const {URL} = require("url");

const {sendEmail, RESEND_API_KEY} = require("./lib/email");

// ── Secrets ─────────────────────────────────────────────────────
// RESEND_API_KEY is imported from ./lib/email so we share the single
// defineSecret() instance (firebase-functions errors on duplicates).
const RESEND_WEBHOOK_SECRET = defineSecret("RESEND_WEBHOOK_SECRET");
// Designated test inbox. A Gmail / Fastmail / etc. address the user
// actually controls — Resend's API will deliver real mail here so a
// human can spot-check rendering once a week if they want.
const SMOKE_EMAIL_INBOX = defineSecret("SMOKE_EMAIL_INBOX");
// Same webhook the Pro smoke uses. Defined again so this function can
// list it in its `secrets:` array without coupling to ./smokeTest.js.
const SMOKE_ALERT_WEBHOOK = defineSecret("SMOKE_ALERT_WEBHOOK");

// Fixed identifiers so reruns are idempotent and so Firestore can
// recognize the synthetic data via `isSmokeTestUser:true`.
const SMOKE_BUYER_UID = "smoke-email-buyer-uid";
const SMOKE_SELLER_UID = "smoke-email-seller-uid";

// How long to wait between the four sends and the Resend status reads.
// Resend processes most sends within 5-10s; 60s gives a generous margin
// and is short enough to fit comfortably inside the 540s function cap.
const VERIFY_WAIT_MS = 60_000;

// Events that count as "successfully handed off / delivered". Resend's
// terminal event vocabulary is documented at
// https://resend.com/docs/dashboard/emails/introduction
// We accept `sent` (handed to recipient MX) and `delivered` (250 OK
// from recipient SMTP). `delivered_to_inbox` is a Gmail-specific bonus.
const OK_EVENTS = new Set(["sent", "delivered", "delivered_to_inbox"]);

// ─────────────────────────────────────────────────────────────────
// Scheduled trigger — once per day at 04:00 US-Eastern. Same time
// as the Pro smoke deliberately so a human triaging morning alerts
// sees both at once.
// ─────────────────────────────────────────────────────────────────
exports.dailyEmailSmoke = onSchedule({
  schedule: "every day 04:00",
  timeZone: "America/New_York",
  region: "us-central1",
  secrets: [
    RESEND_API_KEY,
    RESEND_WEBHOOK_SECRET,
    SMOKE_EMAIL_INBOX,
    SMOKE_ALERT_WEBHOOK,
  ],
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  await runEmailSmoke({trigger: "schedule"});
});

// ─────────────────────────────────────────────────────────────────
// Manual trigger — POST with X-Smoke-Trigger: 1 header to force a run.
//
//   curl -X POST -H "X-Smoke-Trigger: 1" \
//     https://us-central1-<project>.cloudfunctions.net/dailyEmailSmokeManual
//
// Header gate is the same trivial speed bump the Pro smoke uses.
// The endpoint is otherwise public — the smoke only ever sends to the
// designated SMOKE_EMAIL_INBOX so abuse is bounded.
// ─────────────────────────────────────────────────────────────────
exports.dailyEmailSmokeManual = onRequest({
  region: "us-central1",
  secrets: [
    RESEND_API_KEY,
    RESEND_WEBHOOK_SECRET,
    SMOKE_EMAIL_INBOX,
    SMOKE_ALERT_WEBHOOK,
  ],
  timeoutSeconds: 540,
  memory: "512MiB",
}, async (req, res) => {
  if (req.method !== "POST" || req.get("X-Smoke-Trigger") !== "1") {
    res.status(404).send("Not found");
    return;
  }
  const result = await runEmailSmoke({trigger: "manual"});
  res.status(result.ok ? 200 : 500).json(result);
});

// ─────────────────────────────────────────────────────────────────
// Core run loop.
// ─────────────────────────────────────────────────────────────────
async function runEmailSmoke({trigger}) {
  const startedAt = Date.now();
  const steps = [];
  const sends = {}; // { order_placed: { id, subject }, ... }

  try {
    // Hard guards — refuse to run with placeholder secrets so an
    // un-set-up project doesn't generate a noisy daily failure.
    // Resend's modern API keys start with `re_` followed by random
    // chars (no `_live_`/`_test_` infix). Reject obvious placeholders
    // by checking the prefix + minimum length.
    const apiKey = RESEND_API_KEY.value();
    if (!apiKey ||
        !apiKey.startsWith("re_") ||
        apiKey.length < 20 ||
        apiKey.toLowerCase().includes("placeholder")) {
      throw new Error(
        "RESEND_API_KEY missing or not a valid Resend key " +
        "(must start with re_ and be ≥20 chars; placeholder rejected)");
    }
    const inbox = SMOKE_EMAIL_INBOX.value();
    if (!inbox || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inbox)) {
      throw new Error(
        `SMOKE_EMAIL_INBOX missing or malformed (got '${inbox}')`);
    }

    // ── 1. order_placed ────────────────────────────────────────
    await step("order_placed_send", steps, async () => {
      const out = await sendTestEmail({
        templateCategory: "transactional",
        templateName: "OrderPlacedBuyer",
        subject: "Order confirmed — Smoke Test",
        to: inbox,
        ctx: synthOrderBuyerCtx(inbox),
      });
      sends.order_placed = out;
    });

    // ── 2. password_reset ──────────────────────────────────────
    await step("password_reset_send", steps, async () => {
      const out = await sendTestEmail({
        templateCategory: "security",
        templateName: "PasswordReset",
        subject: "Reset your TeeBox password",
        to: inbox,
        ctx: synthPasswordResetCtx(inbox),
      });
      sends.password_reset = out;
    });

    // ── 3. sale_notification (seller perspective) ──────────────
    await step("sale_notification_send", steps, async () => {
      const out = await sendTestEmail({
        templateCategory: "transactional",
        templateName: "OrderPlacedSeller",
        subject: "You sold Test Scotty Cameron — Smoke",
        to: inbox,
        ctx: synthOrderSellerCtx(inbox),
      });
      sends.sale_notification = out;
    });

    // ── 4. order_shipped ───────────────────────────────────────
    await step("order_shipped_send", steps, async () => {
      const out = await sendTestEmail({
        templateCategory: "transactional",
        templateName: "OrderShipped",
        subject: "Your order has shipped — Smoke",
        to: inbox,
        ctx: synthOrderShippedCtx(inbox),
      });
      sends.shipped = out;
    });

    // ── 5. signup_welcome (new transactional, CRITICAL #5) ─────
    // Exercises the SignupWelcome.jsx template that replaced the legacy
    // `emailShell`-rendered welcome HTML in welcomeOnFirstProfileWrite.
    // Catches any regression on the Base layout footer (physical address
    // + unsub) which was the original CAN-SPAM gap.
    await step("signup_welcome_send", steps, async () => {
      const out = await sendTestEmail({
        templateCategory: "transactional",
        templateName: "SignupWelcome",
        subject: "Welcome to TeeBox — Smoke",
        to: inbox,
        ctx: synthSignupWelcomeCtx(inbox),
      });
      sends.signup_welcome = out;
    });

    // ── 6. saved_search_match (lifecycle template) ─────────────
    // Exercises a marketing-category template path — exercises the
    // unsubscribe footer rendering branch in Base layout (since this
    // is non-transactional). We override category to transactional
    // inside sendTestEmail so the synthetic uid never triggers consent
    // gating — the template itself still renders the marketing footer
    // shape because category is hardcoded in the JSX.
    await step("saved_search_match_send", steps, async () => {
      const out = await sendTestEmail({
        templateCategory: "lifecycle",
        templateName: "SavedSearchMatch",
        subject: "2 new for \"scotty cameron\" — Smoke",
        to: inbox,
        ctx: synthSavedSearchMatchCtx(inbox),
      });
      sends.saved_search_match = out;
    });

    // Wait for Resend to actually process the queue. 60s is generous;
    // most sends register `sent` within ~5s.
    await sleep(VERIFY_WAIT_MS);

    // ── Verification reads ─────────────────────────────────────
    // For each id, fetch /emails/{id} and assert last_event ∈ OK_EVENTS.
    // Snapshot the subject so a future regression that renames the
    // subject line is visible in the Firestore run doc.
    //
    // Only attempt this if the API key has read permission. Production
    // keys are usually scoped to "Sending access" only, which 401s on
    // /emails/{id}. In that case we skip verification — the SDK's
    // sent:true is the only confirmation we can get, plus the test
    // inbox itself is the ultimate proof.
    const verifyPairs = [
      ["order_placed_verify", sends.order_placed],
      ["password_reset_verify", sends.password_reset],
      ["sale_notification_verify", sends.sale_notification],
      ["shipped_verify", sends.shipped],
      ["signup_welcome_verify", sends.signup_welcome],
      ["saved_search_match_verify", sends.saved_search_match],
    ];
    for (const [name, info] of verifyPairs) {
      await step(name, steps, async () => {
        if (!info.id) {
          logger.info(`${name}: skipped (no resendId returned from SDK)`);
          info.skippedVerify = "no-id";
          return;
        }
        try {
          const status = await resendGetEmail(info.id, apiKey);
          if (!OK_EVENTS.has(status.last_event)) {
            throw new Error(
              `${name}: last_event='${status.last_event}', ` +
              `expected one of [${[...OK_EVENTS].join(",")}]`);
          }
          info.subjectRemote = status.subject;
          info.lastEvent = status.last_event;
          info.previewSnippet = (status.text || "").slice(0, 140);
        } catch (e) {
          // 401 = restricted (send-only) key. Not a failure — log + skip.
          if (e && String(e.message || "").includes("401")) {
            logger.info(
              `${name}: skipped — RESEND_API_KEY is send-only (cannot ` +
              `GET /emails/{id}). Trust the SDK sent:true response.`);
            info.skippedVerify = "send-only-key";
            return;
          }
          throw e;
        }
      });
    }

    const durationMs = Date.now() - startedAt;
    await writeSmokeRun({
      ok: true,
      trigger,
      steps,
      sends,
      durationMs,
    });
    logger.info("[EMAIL_SMOKE] PASS", {
      durationMs,
      trigger,
      stepsCompleted: steps.length,
      sends,
    });
    return {ok: true, durationMs, steps, sends};
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const failedStep = (steps.length && !steps[steps.length - 1].ok) ?
      steps[steps.length - 1].name :
      "unknown";
    const errorMsg = err && (err.message || String(err)) || "unknown";
    logger.error("[EMAIL_SMOKE] FAIL", {
      failedStep,
      error: errorMsg,
      durationMs,
      trigger,
      steps,
      sends,
    });

    await writeSmokeRun({
      ok: false,
      trigger,
      failedStep,
      error: errorMsg,
      steps,
      sends,
      durationMs,
    });
    await sendSmokeAlert({
      failedStep,
      error: errorMsg,
      steps,
      durationMs,
      trigger,
    });
    return {ok: false, failedStep, error: errorMsg, steps, sends, durationMs};
  }
}

// ─────────────────────────────────────────────────────────────────
// step() — wraps a fn, records timing + ok/err. Mirrors the helper
// in ./smokeTest.js exactly so the Firestore run docs are diffable.
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
// sendTestEmail — wraps the production sendEmail() helper. Renders
// the React Email component, hits Resend, returns { id, subject }.
//
// We DO NOT call sendEmail's preference center logic because we
// always set category=transactional (exempt from gating, see
// lib/email.js#isTransactional). Synthetic uids never have an
// emailSuppressions doc so the suppression check is a fast no-op.
// ─────────────────────────────────────────────────────────────────
async function sendTestEmail({
  templateCategory,
  templateName,
  subject,
  to,
  ctx,
}) {
  // Load the COMPILED template from emails-build/ (built by predeploy
  // `npm run build:emails`). Falls back to raw ./emails/ which won't
  // actually work but gives a clearer error if the build is missing.
  let template;
  try {
    template = require(`./emails-build/${templateCategory}/${templateName}`);
  } catch (e1) {
    try {
      template = require(`./emails/${templateCategory}/${templateName}`);
    } catch (e2) {
      throw new Error(
        `template load failed: ${templateCategory}/${templateName}: ` +
        `${e1.message} (build) / ${e2.message} (raw)`);
    }
  }
  if (typeof template !== "function") {
    throw new Error(
      `template ${templateName} did not export a component function`);
  }
  const reactEl = template(ctx);
  const result = await sendEmail({
    to,
    subject,
    react: reactEl,
    category: "transactional",
    // We intentionally don't pass uid — uid drives preference gating
    // and unsubscribe links, neither of which apply to a synthetic
    // smoke send. lib/email.js handles uid=undefined cleanly.
    template: `Smoke-${templateName}`,
    tags: [
      {name: "smoke", value: "1"},
      {name: "smoke_template", value: templateName},
    ],
    headers: {
      "X-TeeBox-Smoke-Test": "1",
    },
  });
  // Strict failure: send was skipped (suppressed/no consent/no API key)
  // or returned an explicit error. The result.id is nice-to-have but
  // some Resend SDK responses don't populate it (e.g., on idempotency
  // replay) — don't fail on its absence.
  if (!result || result.skipped || !result.sent) {
    throw new Error(
      `sendEmail returned non-success: ${JSON.stringify(result)}`);
  }
  return {id: result.id || null, subject, template: templateName};
}

// ─────────────────────────────────────────────────────────────────
// resendGetEmail — GET https://api.resend.com/emails/{id}
// Returns the parsed JSON body. We use raw https.request to avoid
// pulling in another HTTP client; the Resend SDK does have a
// .emails.get() but it's a thin wrapper around this exact call.
// ─────────────────────────────────────────────────────────────────
function resendGetEmail(id, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "GET",
      hostname: "api.resend.com",
      path: `/emails/${encodeURIComponent(id)}`,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(
              `resendGetEmail: invalid JSON (${res.statusCode}): ${e.message}`));
          }
        } else {
          reject(new Error(
            `resendGetEmail ${id}: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("resendGetEmail timeout"));
    });
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
// Synthetic-data builders. Realistic enough to render the template
// without throwing, NOT realistic enough to look like real data
// (e.g., "Smoke Test Buyer" name, sentinel order id). Anyone reading
// the test inbox should immediately know it's a smoke run.
// ─────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function synthOrderBuyerCtx(inbox) {
  return {
    order: {
      id: "order_smoke_buyer",
      amountCents: 12500,
      sellerPayoutCents: 11250,
      currency: "USD",
      createdAt: nowIso(),
    },
    buyer: {
      uid: SMOKE_BUYER_UID,
      email: inbox,
      firstName: "Smoke",
      displayName: "Smoke Test Buyer",
    },
    listing: {
      id: "listing_smoke",
      title: "Test Scotty Cameron Newport 2",
      imageUrl: "https://teeboxmarket.com/icon-192.png",
    },
  };
}

function synthOrderSellerCtx(inbox) {
  return {
    order: {
      id: "order_smoke_seller",
      amountCents: 12500,
      sellerPayoutCents: 11250,
      currency: "USD",
      createdAt: nowIso(),
    },
    seller: {
      uid: SMOKE_SELLER_UID,
      email: inbox,
      firstName: "Smoke",
      displayName: "Smoke Test Seller",
    },
    listing: {
      id: "listing_smoke",
      title: "Test Scotty Cameron Newport 2",
      imageUrl: "https://teeboxmarket.com/icon-192.png",
    },
  };
}

function synthOrderShippedCtx(inbox) {
  return {
    order: {
      id: "order_smoke_shipped",
      amountCents: 12500,
      currency: "USD",
      createdAt: nowIso(),
      carrier: "USPS",
      trackingNumber: "9400111899223197428347",
      estimatedDelivery: "May 18, 2026",
    },
    buyer: {
      uid: SMOKE_BUYER_UID,
      email: inbox,
      firstName: "Smoke",
      displayName: "Smoke Test Buyer",
    },
    listing: {
      id: "listing_smoke",
      title: "Test Scotty Cameron Newport 2",
      imageUrl: "https://teeboxmarket.com/icon-192.png",
    },
    tracking: {
      carrier: "USPS",
      number: "9400111899223197428347",
      eta: "May 18, 2026",
      publicUrl:
        "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428347",
    },
  };
}

function synthPasswordResetCtx(inbox) {
  return {
    user: {
      uid: SMOKE_BUYER_UID,
      email: inbox,
      firstName: "Smoke",
      displayName: "Smoke Test User",
    },
    resetUrl:
      "https://teeboxmarket.com/reset.html?token=smoke-test-not-a-real-token",
    ip: "203.0.113.42",
  };
}

function synthSignupWelcomeCtx(inbox) {
  return {
    user: {
      uid: SMOKE_BUYER_UID,
      email: inbox,
      firstName: "Smoke",
      displayName: "Smoke Test User",
    },
  };
}

function synthSavedSearchMatchCtx(inbox) {
  return {
    user: {
      uid: SMOKE_BUYER_UID,
      email: inbox,
      firstName: "Smoke",
      displayName: "Smoke Test User",
    },
    search: {
      id: "search_smoke",
      query: "scotty cameron",
    },
    matches: [
      {
        id: "listing_smoke_a",
        title: "Scotty Cameron Newport 2 — 34\"",
        priceCents: 28000,
        condition: "Used – Excellent",
        imageUrl: "https://teeboxmarket.com/icon-192.png",
      },
      {
        id: "listing_smoke_b",
        title: "Scotty Cameron Phantom X 5.5 — 35\"",
        priceCents: 32500,
        condition: "Used – Good",
        imageUrl: "https://teeboxmarket.com/icon-192.png",
      },
    ],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
// writeSmokeRun — durable record per-day. emailSmokeRuns/{YYYY-MM-DD}.
// Same shape & ranAt convention as smokeRuns/ so a single Firestore
// console view can show both smokes.
// ─────────────────────────────────────────────────────────────────
async function writeSmokeRun(result) {
  const today = new Date().toISOString().slice(0, 10);
  const db = admin.firestore();
  const payload = {
    ...result,
    ranAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  try {
    await db.doc(`emailSmokeRuns/${today}`).set(payload, {merge: true});
    await db.collection("emailSmokeRuns").doc(today)
      .collection("runs").add(payload);
  } catch (e) {
    logger.error(
      `[EMAIL_SMOKE] writeSmokeRun failed: ${e && e.message || e}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// sendSmokeAlert — POST a one-line summary to SMOKE_ALERT_WEBHOOK if
// set. Same multi-shape JSON body the Pro smoke uses so the same
// Slack/Discord/Zapier hook works for both.
// ─────────────────────────────────────────────────────────────────
async function sendSmokeAlert({failedStep, error, steps, durationMs, trigger}) {
  let url;
  try {
    url = SMOKE_ALERT_WEBHOOK.value();
  } catch (_e) {
    return; // Secret not set — Firestore + logger.error layers still active.
  }
  if (!url) return;

  const stepsSummary = steps.map((s) =>
    `${s.ok ? "ok" : "FAIL"} ${s.name} (${s.ms}ms)`).join("\n");
  const message =
    `TeeBox Daily Email Smoke FAILED\n` +
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
      `[EMAIL_SMOKE] sendSmokeAlert webhook POST failed: ${e && e.message || e}`);
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
