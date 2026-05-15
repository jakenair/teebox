/**
 * functions/founderBriefing.js
 * ─────────────────────────────────────────────────────────────────────────
 * AI founder briefing agent.
 *
 * WHAT IT DOES
 *   Every morning at 07:00 America/New_York, queries the previous 24h of
 *   marketplace activity (midnight-ET to midnight-ET), computes 7d/30d
 *   baselines, surfaces "notable events" worth a glance, and asks Claude
 *   to write a ~200-word plain-English summary + a ranked "Top 3 things
 *   to act on today" section. Result is emailed to the founder via
 *   ./lib/email.js (Resend), POSTed to an optional Slack webhook, and
 *   persisted to Firestore at founderBriefings/{YYYY-MM-DD}.
 *
 * WHEN IT RUNS
 *   - dailyFounderBriefing (onSchedule): every day 07:00 America/New_York
 *   - dailyFounderBriefingManual (onRequest): POST with header
 *       `X-Briefing-Trigger: 1`. Same trivial speed-bump pattern as
 *       dailyEmailSmokeManual in ./emailSmokeTest.js.
 *
 * SECRETS
 *   - ANTHROPIC_API_KEY        Required for the AI summary. If unset
 *                              we log a warning and send a plain-stats
 *                              email (no AI prose) — never crash.
 *   - SLACK_BRIEFING_WEBHOOK   Optional. If set, we POST a condensed
 *                              version to it after the email send.
 *   - RESEND_API_KEY           Required for the email itself (shared
 *                              with the rest of the email pipeline via
 *                              ./lib/email.js).
 *
 * MANUAL TEST
 *   1. Deploy: `firebase deploy --only functions:dailyFounderBriefingManual`
 *   2. POST to the function URL with the trigger header:
 *        curl -X POST -H "X-Briefing-Trigger: 1" \
 *          https://us-central1-teebox-market.cloudfunctions.net/dailyFounderBriefingManual
 *   3. Briefing emails will land in jakenair23@gmail.com within ~15s.
 *      The Firestore doc at founderBriefings/{YYYY-MM-DD} shows the
 *      full metric payload + Claude output for debugging.
 *
 * SCHEMA ASSUMPTIONS (see verification report for caveats)
 *   - orders/{id}.createdAt is a Firestore Timestamp
 *   - orders/{id}.amountCents, .platformFeeCents are integers (cents)
 *   - orders/{id}.refundedAt is set on refund (Timestamp)
 *   - orders/{id}.refundedAmountCents is the cumulative refund total
 *   - users/{uid}.createdAt is a Firestore Timestamp (TBD: NOT confirmed
 *     in functions/index.js — see verification report)
 *   - listings/{id}.createdAt, .cat (category), .flaggedForReview (bool)
 *   - disputes/{orderId}.status, .createdAt
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
const cfg = require("./founderBriefingConfig");

// ── Secrets ────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const SLACK_BRIEFING_WEBHOOK = defineSecret("SLACK_BRIEFING_WEBHOOK");

const SCHED_FN = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};

// ─────────────────────────────────────────────────────────────────
// Scheduled trigger — 07:00 ET. We chose 07:00 (not 04:00 like the
// smoke tests) because the briefing is meant to be READ over morning
// coffee, not buried at the bottom of a 4am-alerts batch. The 24h
// window we report on ends at the previous midnight ET, so by 07:00
// the data is settled (Stripe webhooks have flushed, dispute creates
// from yesterday evening have landed).
// ─────────────────────────────────────────────────────────────────
exports.dailyFounderBriefing = onSchedule({
  schedule: "every day 07:00",
  timeZone: "America/New_York",
  secrets: [ANTHROPIC_API_KEY, SLACK_BRIEFING_WEBHOOK, RESEND_API_KEY],
  ...SCHED_FN,
}, async () => {
  await runBriefing({trigger: "schedule"});
});

// ─────────────────────────────────────────────────────────────────
// Manual trigger — POST with X-Briefing-Trigger: 1.
//
//   curl -X POST -H "X-Briefing-Trigger: 1" \
//     https://us-central1-<project>.cloudfunctions.net/dailyFounderBriefingManual
//
// The header gate is the same pattern as dailyEmailSmokeManual; abuse
// is bounded because every run only ever emails the hardcoded
// RECIPIENT_EMAIL in founderBriefingConfig.js.
// ─────────────────────────────────────────────────────────────────
exports.dailyFounderBriefingManual = onRequest({
  secrets: [ANTHROPIC_API_KEY, SLACK_BRIEFING_WEBHOOK, RESEND_API_KEY],
  ...SCHED_FN,
}, async (req, res) => {
  if (req.method !== "POST" || req.get("X-Briefing-Trigger") !== "1") {
    res.status(404).send("Not found");
    return;
  }
  try {
    const result = await runBriefing({trigger: "manual"});
    res.status(200).json(result);
  } catch (e) {
    logger.error("[BRIEFING] manual trigger failed", {err: e.message || e});
    res.status(500).json({ok: false, error: e.message || String(e)});
  }
});

// ═════════════════════════════════════════════════════════════════
// Core orchestrator
// ═════════════════════════════════════════════════════════════════
async function runBriefing({trigger}) {
  const startedAt = Date.now();
  // The "report date" is yesterday in ET — i.e. the day whose midnight-
  // to-midnight window we're reporting on. At 07:00 ET on the 16th we're
  // reporting on the 15th.
  const {windowStart, windowEnd, reportDate} = computeReportWindow();

  logger.info("[BRIEFING] start", {
    trigger,
    reportDate,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  });

  // ── 1. Collect raw metrics for the 24h window ────────────────
  const metrics = await collectMetrics(windowStart, windowEnd);

  // ── 2. Compute baselines (7d, 30d) and z-scores ─────────────
  const baselines = await computeBaselines(windowEnd);
  const flagged = flagDeviations(metrics, baselines);

  // ── 3. Notable events (first sale, big sale, etc.) ──────────
  const notableEvents = await findNotableEvents(windowStart, windowEnd);

  // ── Quiet-day short circuit ─────────────────────────────────
  const isQuiet = metrics.ordersCount === 0 &&
                  metrics.newUsersCount === 0 &&
                  metrics.newListingsCount === 0;
  if (isQuiet && cfg.SKIP_ON_QUIET_DAY) {
    logger.info("[BRIEFING] quiet day — skipping per config", {reportDate});
    await writeBriefingDoc({
      reportDate,
      metrics,
      baselines,
      flagged,
      notableEvents,
      briefingText: "",
      model: null,
      tokensUsed: null,
      deliveryStatus: {email: "skipped-quiet", slack: "skipped-quiet"},
      durationMs: Date.now() - startedAt,
      trigger,
    });
    return {ok: true, skipped: "quiet-day", reportDate};
  }

  // ── 4. AI summary via Anthropic ─────────────────────────────
  const ai = await callClaude({metrics, baselines, flagged, notableEvents, reportDate});

  // ── 5. Deliver: email + optional Slack ──────────────────────
  const deliveryStatus = await deliver({
    reportDate,
    metrics,
    notableEvents,
    briefingText: ai.text,
    aiSkipped: ai.skipped,
  });

  // ── 6. Persist for audit / debugging ────────────────────────
  await writeBriefingDoc({
    reportDate,
    metrics,
    baselines,
    flagged,
    notableEvents,
    briefingText: ai.text,
    model: ai.model,
    tokensUsed: ai.tokensUsed,
    deliveryStatus,
    durationMs: Date.now() - startedAt,
    trigger,
  });

  logger.info("[BRIEFING] done", {
    reportDate,
    trigger,
    durationMs: Date.now() - startedAt,
    deliveryStatus,
    aiSkipped: ai.skipped,
  });
  return {ok: true, reportDate, deliveryStatus};
}

// ═════════════════════════════════════════════════════════════════
// 1. collectMetrics — raw counts/sums for the [start, end) window.
//
// We default-everything-to-zero so a query that returns no docs (genuine
// quiet day) yields a well-formed payload rather than NaN. Each sub-
// query is wrapped in try/catch so a missing/unindexed collection
// degrades gracefully (logged + recorded as `null` rather than crashing
// the whole briefing).
// ═════════════════════════════════════════════════════════════════
async function collectMetrics(windowStart, windowEnd) {
  const db = admin.firestore();
  const m = {
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
    // Users
    newUsersCount: 0,
    newUsersBySource: {},
    // Listings
    newListingsCount: 0,
    newListingsByCategory: {},
    flaggedListingsCount: 0,
    // Orders / GMV
    ordersCount: 0,
    gmvCents: 0,
    platformFeeCents: 0,
    aovCents: 0,
    // Refunds
    refundsCount: 0,
    refundedAmountCents: 0,
    // Disputes
    disputesCount: 0,
    disputesByStatus: {},
    // Support / errors — may not exist; populated as null if so
    supportTicketsCount: null,
    emailErrorRate: null,
    emailSendsTotal: null,
    emailSendsErrors: null,
    // Not instrumented — declared for shape stability
    paymentSuccessRate: null,
    appCrashRate: null,
    notes: [],
  };

  // ── Users ─────────────────────────────────────────────────
  // ASSUMPTION: users/{uid}.createdAt is a Firestore Timestamp. The
  // schema in firestore.rules and index.js doesn't show a server-stamped
  // createdAt field on user docs (the welcome flow stamps it implicitly
  // via the auth.users record, not the Firestore doc). If this query
  // returns zero on a day with real signups, the field is missing —
  // see verification report.
  try {
    const snap = await db.collection("users")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .get();
    m.newUsersCount = snap.size;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const src = data.signupSource || "unknown";
      m.newUsersBySource[src] = (m.newUsersBySource[src] || 0) + 1;
    }
  } catch (e) {
    m.notes.push(`users query failed: ${e.message || e}`);
    logger.warn("[BRIEFING] users query failed", {err: e.message || e});
  }

  // ── Listings ──────────────────────────────────────────────
  try {
    const snap = await db.collection("listings")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .get();
    m.newListingsCount = snap.size;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const cat = data.cat || "uncategorized";
      m.newListingsByCategory[cat] = (m.newListingsByCategory[cat] || 0) + 1;
      if (data.flaggedForReview === true) m.flaggedListingsCount += 1;
    }
  } catch (e) {
    m.notes.push(`listings query failed: ${e.message || e}`);
    logger.warn("[BRIEFING] listings query failed", {err: e.message || e});
  }

  // ── Orders / GMV ──────────────────────────────────────────
  // Orders are created by the Stripe webhook with `status: "paid"`. We
  // count "completed transactions" as any order with createdAt in the
  // window (refunds reduce GMV but don't un-count the order).
  try {
    const snap = await db.collection("orders")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .get();
    m.ordersCount = snap.size;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      m.gmvCents += Number(data.amountCents || 0);
      m.platformFeeCents += Number(data.platformFeeCents || 0);
    }
    m.aovCents = m.ordersCount > 0 ?
      Math.round(m.gmvCents / m.ordersCount) : 0;
  } catch (e) {
    m.notes.push(`orders query failed: ${e.message || e}`);
    logger.warn("[BRIEFING] orders query failed", {err: e.message || e});
  }

  // ── Refunds (orders where refundedAt is in the window) ────
  // Refunds are stamped on the existing order doc, so we query by
  // refundedAt rather than the order's createdAt.
  try {
    const snap = await db.collection("orders")
      .where("refundedAt", ">=", windowStart)
      .where("refundedAt", "<", windowEnd)
      .get();
    m.refundsCount = snap.size;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      // refundedAmountCents is cumulative on the order; for partial
      // refunds this overstates today's portion, but for the daily
      // briefing it's a defensible approximation.
      m.refundedAmountCents += Number(
        data.refundedAmountCents || data.amountCents || 0);
    }
  } catch (e) {
    m.notes.push(`refunds query failed: ${e.message || e}`);
    logger.warn("[BRIEFING] refunds query failed", {err: e.message || e});
  }

  // ── Disputes ──────────────────────────────────────────────
  try {
    const snap = await db.collection("disputes")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .get();
    m.disputesCount = snap.size;
    for (const doc of snap.docs) {
      const status = (doc.data() || {}).status || "unknown";
      m.disputesByStatus[status] = (m.disputesByStatus[status] || 0) + 1;
    }
  } catch (e) {
    m.notes.push(`disputes query failed: ${e.message || e}`);
    logger.warn("[BRIEFING] disputes query failed", {err: e.message || e});
  }

  // ── Support tickets (collection may not exist) ────────────
  try {
    const snap = await db.collection("supportTickets")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .limit(500)
      .get();
    m.supportTicketsCount = snap.size;
  } catch (e) {
    // Most likely a missing-index or missing-collection error. Don't
    // treat as a failure — just leave the metric null.
    m.notes.push(`supportTickets unavailable: ${e.message || e}`);
    logger.info("[BRIEFING] supportTickets unavailable (skipping)",
      {err: e.message || e});
  }

  // ── Email error rate (emailSends/) ────────────────────────
  // Source of truth for send health is the emailSends/ collection that
  // every sendEmail() write hits (lib/email.js#recordSend). We can't
  // easily count both "sent" and "send-error" in a single trip without
  // an index, so we issue two count() queries.
  try {
    const sentRef = db.collection("emailSends")
      .where("status", "==", "sent")
      .where("sentAt", ">=", windowStart);
    const errRef = db.collection("emailSends")
      .where("status", "==", "send-error")
      .where("sentAt", ">=", windowStart);
    const [sentAgg, errAgg] = await Promise.all([
      typeof sentRef.count === "function" ?
        sentRef.count().get().then((r) => r.data().count) :
        sentRef.select().get().then((s) => s.size),
      typeof errRef.count === "function" ?
        errRef.count().get().then((r) => r.data().count) :
        errRef.select().get().then((s) => s.size),
    ]);
    m.emailSendsTotal = sentAgg + errAgg;
    m.emailSendsErrors = errAgg;
    m.emailErrorRate = m.emailSendsTotal > 0 ?
      Number((errAgg / m.emailSendsTotal).toFixed(4)) : 0;
  } catch (e) {
    m.notes.push(`emailSends query failed: ${e.message || e}`);
    logger.warn("[BRIEFING] emailSends query failed", {err: e.message || e});
  }

  return m;
}

// ═════════════════════════════════════════════════════════════════
// 2. computeBaselines — for each numeric metric, compute the trailing
// 7-day and 30-day mean + stddev. We do this by walking the
// founderBriefings/ collection (each prior briefing persisted its own
// metrics payload). On day 1 there's no history → mean=current,
// stddev=0, and z-scores all collapse to 0 (no deviations flagged).
// ═════════════════════════════════════════════════════════════════
async function computeBaselines(windowEnd) {
  const db = admin.firestore();
  // Look back 30 calendar days (capped at 30 docs).
  const lookbackStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
  let docs = [];
  try {
    const snap = await db.collection("founderBriefings")
      .where("generatedAt", ">=", lookbackStart)
      .where("generatedAt", "<", windowEnd)
      .orderBy("generatedAt", "desc")
      .limit(30)
      .get();
    docs = snap.docs.map((d) => d.data().metrics || {});
  } catch (e) {
    // Likely a missing-index error on first run — degrade quietly.
    logger.info("[BRIEFING] baseline history unavailable",
      {err: e.message || e});
    docs = [];
  }

  const numericFields = [
    "newUsersCount",
    "newListingsCount",
    "flaggedListingsCount",
    "ordersCount",
    "gmvCents",
    "platformFeeCents",
    "aovCents",
    "refundsCount",
    "refundedAmountCents",
    "disputesCount",
  ];

  const baselines = {};
  for (const field of numericFields) {
    const last7 = docs.slice(0, 7).map((d) => Number(d[field] || 0));
    const last30 = docs.map((d) => Number(d[field] || 0));
    baselines[field] = {
      mean7: mean(last7),
      stddev7: stddev(last7),
      mean30: mean(last30),
      stddev30: stddev(last30),
      samples7: last7.length,
      samples30: last30.length,
    };
  }
  return baselines;
}

function flagDeviations(metrics, baselines) {
  const out = [];
  for (const field of Object.keys(baselines)) {
    const b = baselines[field];
    if (b.samples30 < 3) continue; // not enough data to flag
    const v = Number(metrics[field] || 0);
    const z = b.stddev30 > 0 ? (v - b.mean30) / b.stddev30 : 0;
    if (Math.abs(z) >= cfg.STDDEV_MULTIPLIER) {
      out.push({
        field,
        value: v,
        mean30: b.mean30,
        stddev30: b.stddev30,
        z: Number(z.toFixed(2)),
        direction: z >= 0 ? "above" : "below",
      });
    }
  }
  return out;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mu = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// ═════════════════════════════════════════════════════════════════
// 3. findNotableEvents — individual events worth surfacing in the
// briefing as standalone items (not just aggregates).
//
// Today we surface 4 types:
//   - first_sale          A seller whose first sale ever happened in the
//                         window. Heuristic: at start-of-window the
//                         seller's order count was 0; at end ≥ 1.
//   - large_order         Any single order at or above LARGE_ORDER_USD.
//   - dispute_on_flagged  Any new dispute whose listing has
//                         flaggedForReview === true.
//   - high_fraud_signup   Any new user with fraudScore > threshold.
//                         (Field not currently populated — see header.)
// ═════════════════════════════════════════════════════════════════
async function findNotableEvents(windowStart, windowEnd) {
  const db = admin.firestore();
  const events = [];

  // ── Big-ticket orders ─────────────────────────────────────
  try {
    const thresholdCents = cfg.LARGE_ORDER_USD * 100;
    const snap = await db.collection("orders")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const cents = Number(d.amountCents || 0);
      if (cents >= thresholdCents) {
        events.push({
          type: "large_order",
          orderId: doc.id,
          amountCents: cents,
          sellerId: d.sellerId || null,
          buyerId: d.buyerId || null,
          listingId: d.listingId || null,
          summary: `Order ${doc.id.slice(0, 8)} — ${formatUsd(cents)} ` +
                   `(seller ${shortId(d.sellerId)})`,
        });
      }
    }
  } catch (e) {
    logger.warn("[BRIEFING] large_order scan failed", {err: e.message || e});
  }

  // ── First-sale detection ──────────────────────────────────
  // For each seller with at least one order in the window, check
  // whether they had any orders before windowStart. If not, today is
  // their first sale.
  try {
    const snap = await db.collection("orders")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .get();
    const sellersToday = new Set();
    const orderBySeller = new Map();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (!d.sellerId) continue;
      sellersToday.add(d.sellerId);
      if (!orderBySeller.has(d.sellerId)) orderBySeller.set(d.sellerId, doc);
    }
    for (const sellerId of sellersToday) {
      const priorSnap = await db.collection("orders")
        .where("sellerId", "==", sellerId)
        .where("createdAt", "<", windowStart)
        .limit(1)
        .get();
      if (priorSnap.empty) {
        const doc = orderBySeller.get(sellerId);
        const d = doc.data() || {};
        events.push({
          type: "first_sale",
          sellerId,
          orderId: doc.id,
          amountCents: Number(d.amountCents || 0),
          summary: `Seller ${shortId(sellerId)} made their first sale ` +
                   `(${formatUsd(d.amountCents || 0)}, order ${doc.id.slice(0, 8)})`,
        });
      }
    }
  } catch (e) {
    logger.warn("[BRIEFING] first_sale scan failed", {err: e.message || e});
  }

  // ── Disputes on flagged listings ──────────────────────────
  try {
    const snap = await db.collection("disputes")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      // Dispute doc id IS the orderId per firestore.rules. Look up the
      // order → listing → flaggedForReview.
      try {
        const orderSnap = await db.doc(`orders/${doc.id}`).get();
        const listingId = orderSnap.exists ?
          (orderSnap.data().listingId || null) : null;
        if (!listingId) continue;
        const listingSnap = await db.doc(`listings/${listingId}`).get();
        const flagged = listingSnap.exists &&
          listingSnap.data().flaggedForReview === true;
        if (flagged) {
          events.push({
            type: "dispute_on_flagged",
            orderId: doc.id,
            listingId,
            reason: d.reason || null,
            summary: `Dispute opened on flagged listing ` +
                     `${listingId.slice(0, 8)} (order ${doc.id.slice(0, 8)}, ` +
                     `reason: ${d.reason || "unspecified"})`,
          });
        }
      } catch (_inner) { /* skip individual lookups that fail */ }
    }
  } catch (e) {
    logger.warn("[BRIEFING] dispute_on_flagged scan failed",
      {err: e.message || e});
  }

  // ── High-fraud-score signups (field not currently populated) ─
  // We probe defensively. If the field doesn't exist on any user doc,
  // the query returns zero rows — exactly the right behavior.
  try {
    const snap = await db.collection("users")
      .where("createdAt", ">=", windowStart)
      .where("createdAt", "<", windowEnd)
      .where("fraudScore", ">", cfg.FRAUD_SCORE_THRESHOLD)
      .limit(50)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      events.push({
        type: "high_fraud_signup",
        uid: doc.id,
        fraudScore: d.fraudScore || null,
        summary: `Signup ${shortId(doc.id)} flagged with fraudScore=` +
                 `${d.fraudScore}`,
      });
    }
  } catch (_e) {
    // Composite index probably missing. Silently skip — feature isn't
    // wired up yet anyway. Documented in header.
  }

  return events;
}

// ═════════════════════════════════════════════════════════════════
// 4. callClaude — Anthropic Messages API via Node https.
//
// We avoid a new dependency on @anthropic-ai/sdk to keep cold-start
// lean. The Messages API is a simple POST and the response shape is
// stable. If ANTHROPIC_API_KEY isn't set or the call fails, we return
// `{skipped: true}` and the caller falls back to a non-AI plain-stats
// briefing — the email still goes out.
// ═════════════════════════════════════════════════════════════════
async function callClaude({metrics, baselines, flagged, notableEvents, reportDate}) {
  let apiKey;
  try {
    apiKey = ANTHROPIC_API_KEY.value();
  } catch (_e) {
    apiKey = null;
  }
  if (!apiKey) {
    logger.warn("[BRIEFING] ANTHROPIC_API_KEY not set — falling back to plain-stats briefing");
    return {
      skipped: true,
      text: buildFallbackBriefing(metrics, notableEvents),
      model: null,
      tokensUsed: null,
    };
  }

  const userPayload = {
    reportDate,
    metrics,
    baselines,
    flaggedDeviations: flagged,
    notableEvents,
  };

  const requestBody = JSON.stringify({
    model: cfg.ANTHROPIC_MODEL,
    max_tokens: cfg.ANTHROPIC_MAX_TOKENS,
    system: cfg.ANTHROPIC_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          "Here is the structured data for today's TeeBox briefing.\n\n" +
          "```json\n" + JSON.stringify(userPayload, null, 2) + "\n```\n\n" +
          "Write the briefing now per your instructions.",
      },
    ],
  });

  try {
    const resp = await anthropicMessages(apiKey, requestBody);
    const text = extractText(resp);
    const tokensUsed = (resp && resp.usage) ? {
      input_tokens: resp.usage.input_tokens || 0,
      output_tokens: resp.usage.output_tokens || 0,
    } : null;
    return {
      skipped: false,
      text: text || buildFallbackBriefing(metrics, notableEvents),
      model: resp.model || cfg.ANTHROPIC_MODEL,
      tokensUsed,
    };
  } catch (e) {
    logger.error("[BRIEFING] Anthropic API call failed",
      {err: e.message || String(e)});
    return {
      skipped: true,
      text: buildFallbackBriefing(metrics, notableEvents),
      model: null,
      tokensUsed: null,
    };
  }
}

function extractText(resp) {
  if (!resp || !Array.isArray(resp.content)) return "";
  return resp.content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("\n\n")
    .trim();
}

function buildFallbackBriefing(metrics, notableEvents) {
  const lines = [];
  lines.push(
    `Last 24h: ${metrics.ordersCount} orders for ` +
    `${formatUsd(metrics.gmvCents)} GMV, ` +
    `${metrics.newUsersCount} new users, ` +
    `${metrics.newListingsCount} new listings, ` +
    `${metrics.disputesCount} disputes, ` +
    `${metrics.refundsCount} refunds.`,
  );
  if (notableEvents.length > 0) {
    lines.push("");
    lines.push(`Notable events (${notableEvents.length}):`);
    for (const ev of notableEvents.slice(0, 5)) {
      lines.push(`- ${ev.summary || ev.type}`);
    }
  }
  return lines.join("\n");
}

function anthropicMessages(apiKey, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "POST",
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      timeout: 60_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Anthropic: invalid JSON: ${e.message}`));
          }
        } else {
          reject(new Error(
            `Anthropic HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Anthropic timeout")));
    req.write(body);
    req.end();
  });
}

// ═════════════════════════════════════════════════════════════════
// 5. deliver — email + optional Slack post.
// ═════════════════════════════════════════════════════════════════
async function deliver({reportDate, metrics, notableEvents, briefingText, aiSkipped}) {
  const status = {email: "pending", slack: "skipped"};

  // ── Email ────────────────────────────────────────────────
  try {
    // emails-build/internal/FounderBriefing is produced by
    // `npm run build:emails` (esbuild) before deploy. Same pattern as
    // every other template required dynamically from a Cloud Function.
    let FounderBriefing;
    try {
      FounderBriefing = require("./emails-build/internal/FounderBriefing");
    } catch (_e) {
      // Fall back to source if the build artifact is missing — happens
      // in `firebase functions:shell` runs that bypass the predeploy
      // hook. The JSX is requireable when esbuild has emitted the .cjs.
      FounderBriefing = require("./emails/internal/FounderBriefing");
    }
    const reactEl = FounderBriefing({
      date: reportDate,
      briefingText,
      metrics,
      notableEvents,
      aiSkipped,
    });
    const subject = `TeeBox daily briefing — ${reportDate}`;
    const result = await sendEmail({
      to: cfg.RECIPIENT_EMAIL,
      subject,
      react: reactEl,
      category: "transactional",
      template: "FounderBriefing",
      tags: [
        {name: "internal", value: "1"},
        {name: "briefing_date", value: reportDate},
      ],
      headers: {"X-TeeBox-Founder-Briefing": "1"},
      idempotencyKey: `founder-briefing-${reportDate}`,
    });
    if (result && result.sent) {
      status.email = "sent";
    } else if (result && result.skipped) {
      status.email = `skipped-${result.reason || "unknown"}`;
    } else {
      status.email = "failed";
    }
  } catch (e) {
    logger.error("[BRIEFING] email delivery failed", {err: e.message || e});
    status.email = "failed";
  }

  // ── Slack ────────────────────────────────────────────────
  let slackUrl = null;
  try {
    slackUrl = SLACK_BRIEFING_WEBHOOK.value();
  } catch (_e) {
    slackUrl = null;
  }
  if (slackUrl) {
    try {
      const condensed =
        `*TeeBox daily briefing — ${reportDate}*\n` +
        `Orders: ${metrics.ordersCount}  ·  GMV: ${formatUsd(metrics.gmvCents)}  ·  ` +
        `AOV: ${formatUsd(metrics.aovCents)}\n` +
        `New users: ${metrics.newUsersCount}  ·  New listings: ${metrics.newListingsCount}  ·  ` +
        `Disputes: ${metrics.disputesCount}  ·  Refunds: ${metrics.refundsCount}\n` +
        (notableEvents.length ? `Notable: ${notableEvents.length} event(s)\n` : "") +
        `\n${briefingText || "(no briefing text)"}`;
      await postJson(slackUrl, JSON.stringify({
        text: condensed,
        content: condensed,
      }));
      status.slack = "sent";
    } catch (e) {
      logger.error("[BRIEFING] Slack POST failed", {err: e.message || e});
      status.slack = "failed";
    }
  }

  return status;
}

// ═════════════════════════════════════════════════════════════════
// 6. writeBriefingDoc — durable per-day record. Doc id is the report
// date (YYYY-MM-DD), so re-running for the same day overwrites
// (the manual trigger is intentionally idempotent).
// ═════════════════════════════════════════════════════════════════
async function writeBriefingDoc({
  reportDate,
  metrics,
  baselines,
  flagged,
  notableEvents,
  briefingText,
  model,
  tokensUsed,
  deliveryStatus,
  durationMs,
  trigger,
}) {
  const db = admin.firestore();
  try {
    await db.doc(`founderBriefings/${reportDate}`).set({
      reportDate,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      metrics,
      baselines,
      flaggedDeviations: flagged,
      notableEvents,
      briefingText,
      model: model || null,
      tokensUsed: tokensUsed || null,
      deliveryStatus,
      durationMs,
      trigger,
    }, {merge: true});
  } catch (e) {
    logger.error("[BRIEFING] writeBriefingDoc failed",
      {err: e.message || e});
  }
}

// ═════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════

// Yields the [start, end) window for "yesterday in ET" and the date
// label used as the report id. We compute it by:
//   1. Now → ET local time string ("YYYY-MM-DD HH:MM").
//   2. Strip to the date, subtract one day → report date.
//   3. Window = [reportDateMidnightET, reportDateMidnightET + 24h).
//
// We deliberately don't pull in a tz library — Intl.DateTimeFormat is
// in the Node 22 stdlib and handles DST correctly.
function computeReportWindow(now = new Date()) {
  // Format `now` as ET wall-clock to extract the date components.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(now).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  // Subtract one day from the ET wall-clock date.
  const etTodayUtcMidnight = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
  );
  const reportUtcMidnight = etTodayUtcMidnight - 24 * 60 * 60 * 1000;
  // Convert that UTC-midnight back to actual ET-midnight by adjusting
  // for the ET offset. Doing it this way keeps DST-correct: we use
  // the same formatter on a probe Date at the report-date noon to find
  // the offset that applied THAT day.
  const probe = new Date(reportUtcMidnight + 12 * 60 * 60 * 1000);
  const probeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(probe).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  // ET hour at UTC noon tells us the offset for that calendar day.
  // (e.g. EDT: probe hour=08, offset=-4h; EST: probe hour=07, offset=-5h)
  const etHourAtUtcNoon = Number(probeParts.hour);
  const offsetHours = 12 - etHourAtUtcNoon;
  // True ET-midnight in UTC = UTC-midnight + offset (offset is positive
  // for west-of-UTC, hence +).
  const reportMidnightEtUtc = reportUtcMidnight + offsetHours * 60 * 60 * 1000;
  const windowStart = new Date(reportMidnightEtUtc);
  const windowEnd = new Date(reportMidnightEtUtc + 24 * 60 * 60 * 1000);
  const reportDate =
    `${probeParts.year}-${probeParts.month}-${probeParts.day}`;
  return {windowStart, windowEnd, reportDate};
}

function formatUsd(cents) {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

function shortId(id) {
  if (!id) return "—";
  return String(id).slice(0, 8);
}

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (e) {
      reject(new Error(`invalid webhook URL: ${e.message}`));
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
    req.on("timeout", () => req.destroy(new Error("webhook timeout")));
    req.write(body);
    req.end();
  });
}

// Exported for unit tests / introspection. Not registered as Cloud
// Functions endpoints — those are dailyFounderBriefing /
// dailyFounderBriefingManual above.
module.exports.runBriefing = runBriefing;
module.exports.collectMetrics = collectMetrics;
module.exports.computeBaselines = computeBaselines;
module.exports.findNotableEvents = findNotableEvents;
module.exports.callClaude = callClaude;
module.exports.deliver = deliver;
module.exports.computeReportWindow = computeReportWindow;
