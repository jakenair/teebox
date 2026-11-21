"use strict";
// Carrier-adjustment tracking (Shippo invoice.v1 Reporting API).
//
// Shippo bills carrier adjustments (box bigger/heavier than declared) to our
// Shippo account 30-60 days after shipment, with no webhook. Two jobs:
//
//   reconcileShippingAdjustments  daily 06:15 America/Chicago
//     Runs invoice.v1 over the last 45 days (clipped to data_availability),
//     picks the adjustment rows (lib/shippoReporting.isAdjustmentRow), matches
//     them to orders (shippoTransactionId, then trackingNumber) and writes
//     shippingAdjustments/{invoice_item_object_id}. Run log:
//     shippingAdjustmentRuns/{YYYY-MM-DD} (counts, ALL raw item types seen,
//     run id, errors).
//
//   shippingAdjustmentsDigest     Mondays 08:00 America/Chicago
//     Emails config/shipping.opsEmail a per-seller summary of adjustments
//     first imported in the last 7 days. Always sends, even with zero rows,
//     so silence means the pipeline is broken.
//
// TRACK ONLY. Nothing here charges, refunds, deducts or touches payouts.
// Collections are admin-SDK only (default-deny rules).

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const rep = require("./lib/shippoReporting");
const {boxName, getShippingConfig} = require("./lib/shippingParcels");
const {RESEND_API_KEY} = require("./lib/email");

// Same secret as shippoIntegration.js (a second defineSecret of the same
// name is the documented sharing pattern).
const SHIPPO_API_KEY = defineSecret("SHIPPO_API_KEY");

const PROD_PROJECT_ID = "teebox-market";
const WINDOW_DAYS = 45;
const POLL_BUDGET_MS = 7 * 60 * 1000; // inside the 540s timeout
const COL_ADJ = "shippingAdjustments";
const COL_RUNS = "shippingAdjustmentRuns";
const DAY_MS = 86400 * 1000;

const SCHED_FN = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 540,
};

function utcDateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnightSec(ms) {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Orders for the given Shippo transaction ids / tracking numbers.
 * Firestore `in` takes up to 30 values per query.
 */
async function loadOrderLookup(db, txIds, trackingNumbers) {
  const byTransactionId = new Map();
  const byTracking = new Map();
  const run = async (field, values, into) => {
    for (const part of chunk([...new Set(values.filter(Boolean))], 30)) {
      const snap = await db.collection("orders").where(field, "in", part).get();
      snap.forEach((d) => {
        const v = d.get(field);
        if (v && !into.has(v)) into.set(v, {...d.data(), id: d.id});
      });
    }
  };
  await run("shippoTransactionId", txIds, byTransactionId);
  await run("trackingNumber", trackingNumbers, byTracking);
  return {byTransactionId, byTracking};
}

/**
 * Create the day's run (idempotent per UTC date) and poll it to completion.
 * One fresh retry on a transient FAILED. Returns {run, runIds, errors}.
 */
async function createAndPoll(api, {start, end, dateKey, nowFn, deadlineMs}) {
  const errors = [];
  const runIds = [];
  const baseKey = `teebox-shipadj-${dateKey}`;
  let created;
  try {
    created = await rep.createRun(api, {start, end, idempotencyKey: baseKey});
  } catch (e) {
    // Same key, different body (data_availability moved since an earlier
    // attempt today): key the interval in too.
    if (e.code !== "idempotency-conflict") throw e;
    errors.push(`create: ${e.message}`);
    created = await rep.createRun(api, {start, end, idempotencyKey: `${baseKey}-${start}-${end}`});
  }
  runIds.push(created.id);
  let run = await rep.pollRun(api, created.id, {maxWaitMs: Math.max(30000, deadlineMs - nowFn())});
  const transient = new Set(["run_timeout", "run_processing_failed", "run_failed", "service_unavailable"]);
  if (run.status === "FAILED") {
    const code = (run.error && run.error.code) || "unknown";
    errors.push(`run ${created.id} FAILED: ${code}`);
    if (transient.has(code) && deadlineMs - nowFn() > 90000) {
      const retry = await rep.createRun(api, {start, end, idempotencyKey: `${baseKey}-${start}-${end}-retry1`});
      runIds.push(retry.id);
      run = await rep.pollRun(api, retry.id, {maxWaitMs: Math.max(30000, deadlineMs - nowFn())});
      if (run.status === "FAILED") errors.push(`run ${retry.id} FAILED: ${(run.error && run.error.code) || "unknown"}`);
    }
  }
  return {run, runIds, errors};
}

/**
 * The daily reconcile. Dependencies are injectable so this can be driven by
 * a script against a stub; the scheduled wrapper passes the real ones.
 */
async function runReconcile({db, apiKey, fetch, sleep, now = () => Date.now(), project}) {
  const startedMs = now();
  const dateKey = utcDateKey(startedMs);
  const logRef = db.collection(COL_RUNS).doc(dateKey);
  const log = {
    date: dateKey,
    status: "started",
    startedAt: new Date(startedMs),
    runIds: [],
    errors: [],
    rawTypes: [],
    rowCount: 0,
    adjustmentCount: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    newCount: 0,
    totalCents: 0,
  };
  const finish = async (status) => {
    log.status = status;
    log.finishedAt = new Date(now());
    log.durationMs = now() - startedMs;
    await logRef.set(log, {merge: true});
    logger.info("reconcileShippingAdjustments", {
      status, date: dateKey, runIds: log.runIds, rows: log.rowCount,
      adjustments: log.adjustmentCount, matched: log.matchedCount,
      newCount: log.newCount, errors: log.errors.length,
    });
    return log;
  };

  if (!apiKey) {
    log.errors.push("SHIPPO_API_KEY not set");
    return finish("skipped-no-key");
  }
  const isTestKey = apiKey.startsWith("shippo_test_");
  log.keyEnv = isTestKey ? "test" : "live";
  // Mirrors the createShippingLabel prod guard: a test key in prod would
  // report on the test account and look like "no adjustments".
  if (isTestKey && project === PROD_PROJECT_ID) {
    log.errors.push("test key in prod project; skipped");
    logger.warn("reconcileShippingAdjustments: test SHIPPO_API_KEY in prod, skipping");
    return finish("skipped-test-key");
  }

  const api = {apiKey, fetch, sleep, now};
  const deadlineMs = startedMs + POLL_BUDGET_MS;
  try {
    const meta = await rep.getReportType(api);
    const av = (meta && meta.data_availability) || null;
    log.dataAvailability = av;
    // End at today's UTC midnight so every attempt on one date sends the
    // same body (idempotency key per UTC date). Today's partial day is
    // picked up tomorrow; the 45-day window overlaps heavily anyway.
    const win = rep.computeWindow(utcMidnightSec(startedMs), av, WINDOW_DAYS);
    if (!win) {
      log.errors.push(`no runnable window (availability ${JSON.stringify(av)})`);
      return finish("no-window");
    }
    log.window = win;

    const {run, runIds, errors} = await createAndPoll(api, {...win, dateKey, nowFn: now, deadlineMs});
    log.runIds = runIds;
    log.errors.push(...errors);
    if (run.status !== "SUCCEEDED") return finish("run-failed");

    const text = await rep.downloadReport(api, run.result.download.url);
    const rows = rep.csvToObjects(text);
    log.rowCount = rows.length;
    log.reportedRowCount = (run.result && run.result.row_count) ?? null;
    log.rawTypes = rep.countTypes(rows);

    const adjRows = rows.filter(rep.isAdjustmentRow);
    log.adjustmentCount = adjRows.length;
    // A few raw samples of what we classified, to tune the classifier.
    log.adjustmentSamples = adjRows.slice(0, 5).map((r) => ({
      type: r.invoice_item_type || "", description: String(r.invoice_item_description || "").slice(0, 200),
      amount: r.invoice_item_amount || "",
    }));
    if (!adjRows.length) return finish("ok");

    const lookup = await loadOrderLookup(db,
        adjRows.map((r) => String(r.transaction_object_id || "").trim()),
        adjRows.map((r) => String(r.tracking_number || "").trim()));
    const docs = rep.buildAdjustmentDocs(adjRows, lookup);

    // importedAt = first time we saw the item (the digest keys on it), so
    // only stamp it on new docs; lastSeenAt moves every run.
    const refs = docs.map((d) => db.collection(COL_ADJ).doc(d.id));
    const existing = new Set();
    for (const part of chunk(refs, 300)) {
      const snaps = await db.getAll(...part);
      snaps.forEach((s) => {
        if (s.exists) existing.add(s.id);
      });
    }
    const ts = admin.firestore.FieldValue.serverTimestamp();
    for (const part of chunk(docs, 400)) {
      const batch = db.batch();
      for (const d of part) {
        const data = {...d.data, lastSeenAt: ts, lastRunDate: dateKey};
        if (!existing.has(d.id)) data.importedAt = ts;
        batch.set(db.collection(COL_ADJ).doc(d.id), data, {merge: true});
      }
      await batch.commit();
    }
    log.newCount = docs.filter((d) => !existing.has(d.id)).length;
    log.matchedCount = docs.filter((d) => d.data.matched).length;
    log.unmatchedCount = docs.length - log.matchedCount;
    log.totalCents = docs.reduce((s, d) => s + (d.data.amountCents || 0), 0);
    return finish("ok");
  } catch (e) {
    log.errors.push(String((e && e.message) || e).slice(0, 500));
    logger.error("reconcileShippingAdjustments failed", {err: e && e.message, code: e && e.code});
    return finish("error");
  }
}

exports.reconcileShippingAdjustments = onSchedule({
  schedule: "every day 06:15",
  timeZone: "America/Chicago",
  secrets: [SHIPPO_API_KEY],
  ...SCHED_FN,
}, async () => {
  let apiKey = "";
  try {
    apiKey = SHIPPO_API_KEY.value() || "";
  } catch (_e) {
    apiKey = "";
  }
  await runReconcile({
    db: admin.firestore(),
    apiKey,
    fetch: globalThis.fetch,
    project: process.env.GCLOUD_PROJECT,
  });
});

// ── Weekly digest ────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function money(cents) {
  const c = Math.round(Number(cents) || 0);
  const sign = c < 0 ? "-" : "";
  return `${sign}$${(Math.abs(c) / 100).toFixed(2)}`;
}

/**
 * Pure: adjustments (+ seller names, + the week's run logs) -> email.
 * @param {Object} p
 * @param {Object[]} p.adjustments shippingAdjustments docs (data)
 * @param {Object<string,string>} [p.names] uid -> displayName
 * @param {Object[]} [p.runs] shippingAdjustmentRuns docs for the 7 days
 * @return {{subject: string, html: string, text: string, count: number, totalCents: number}}
 */
function buildDigest({adjustments, names = {}, runs = []}) {
  const list = adjustments || [];
  const count = list.length;
  const totalCents = list.reduce((s, a) => s + (a.amountCents || 0), 0);
  const runsOk = runs.filter((r) => r && r.status === "ok").length;
  const runsLine = `Daily imports in the last 7 days: ${runsOk} ok, ${runs.length - runsOk} not ok, ${7 - runs.length} missing.`;
  const td = "padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:left;font-size:14px;";
  const wrap = (inner) => `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px;">${inner}` +
    `<p style="font-size:12px;color:#666;margin-top:16px;">${esc(runsLine)}<br>Tracking only. Nothing was charged to or deducted from anyone.</p></div>`;

  if (!count) {
    const line = "No carrier adjustments this week.";
    return {
      subject: "No carrier adjustments this week",
      html: wrap(`<p style="font-size:15px;">${esc(line)}</p>`),
      text: `${line}\n\n${runsLine}\nTracking only. Nothing was charged to or deducted from anyone.\n`,
      count, totalCents,
    };
  }

  const sellers = new Map();
  const unmatched = {count: 0, cents: 0};
  for (const a of list) {
    if (!a.sellerId) {
      unmatched.count++; unmatched.cents += a.amountCents || 0;
      continue;
    }
    const s = sellers.get(a.sellerId) || {uid: a.sellerId, count: 0, cents: 0, boxes: new Set()};
    s.count++;
    s.cents += a.amountCents || 0;
    s.boxes.add(a.parcelKey ? boxName(a.parcelKey) : "Unknown box");
    sellers.set(a.sellerId, s);
  }
  const rows = [...sellers.values()].sort((x, y) => y.cents - x.cents);

  const sellerLabel = (s) => (names[s.uid] ? `${names[s.uid]} (${s.uid})` : s.uid);
  const headline = `${count} carrier adjustment${count === 1 ? "" : "s"} this week, ${money(totalCents)} total.`;
  let subject = `Carrier adjustments: ${count}, ${money(totalCents)}`;
  if (subject.length > 50) subject = subject.slice(0, 50);

  const th = `${td}font-weight:bold;background:#f5f5f5;`;
  const tableRows = rows.map((s) => `<tr><td style="${td}">${esc(sellerLabel(s))}</td>` +
    `<td style="${td}">${s.count}</td><td style="${td}">${esc(money(s.cents))}</td>` +
    `<td style="${td}">${esc([...s.boxes].join(", "))}</td></tr>`).join("");
  const unmatchedRow = `<tr><td style="${td}">Unmatched (no order found)</td><td style="${td}">${unmatched.count}</td>` +
    `<td style="${td}">${esc(money(unmatched.cents))}</td><td style="${td}"></td></tr>`;
  const html = wrap(`<p style="font-size:15px;">${esc(headline)}</p>` +
    `<table style="border-collapse:collapse;width:100%;">` +
    `<tr><th style="${th}">Seller</th><th style="${th}">Count</th><th style="${th}">Total</th><th style="${th}">Box type</th></tr>` +
    `${tableRows}${unmatchedRow}</table>`);
  const text = [
    headline, "",
    ...rows.map((s) => `${sellerLabel(s)}: ${s.count}, ${money(s.cents)}, ${[...s.boxes].join(", ")}`),
    `Unmatched (no order found): ${unmatched.count}, ${money(unmatched.cents)}`,
    "", runsLine,
    "Tracking only. Nothing was charged to or deducted from anyone.", "",
  ].join("\n");
  return {subject, html, text, count, totalCents};
}

async function runDigest({db, sendEmail, now = () => Date.now()}) {
  const nowMs = now();
  const since = new Date(nowMs - 7 * DAY_MS);
  const snap = await db.collection(COL_ADJ).where("importedAt", ">=", since).get();
  const adjustments = snap.docs.map((d) => ({id: d.id, ...d.data()}));

  const uids = [...new Set(adjustments.map((a) => a.sellerId).filter(Boolean))];
  const names = {};
  for (const part of chunk(uids, 100)) {
    const snaps = await db.getAll(...part.map((u) => db.collection("users").doc(u)));
    snaps.forEach((s) => {
      const n = s.exists && s.get("displayName");
      if (typeof n === "string" && n.trim()) names[s.id] = n.trim().slice(0, 80);
    });
  }
  const runRefs = [];
  for (let i = 0; i < 7; i++) runRefs.push(db.collection(COL_RUNS).doc(utcDateKey(nowMs - i * DAY_MS)));
  const runs = (await db.getAll(...runRefs)).filter((s) => s.exists).map((s) => s.data());

  const cfg = await getShippingConfig(db, nowMs);
  const digest = buildDigest({adjustments, names, runs});
  const res = await sendEmail({
    to: cfg.opsEmail,
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
    category: "transactional",
    template: "ShippingAdjustmentsDigest",
    idempotencyKey: `ShippingAdjustmentsDigest-${utcDateKey(nowMs)}`,
  });
  logger.info("shippingAdjustmentsDigest", {count: digest.count, totalCents: digest.totalCents, sent: !!(res && res.sent)});
  return {digest, res};
}

exports.shippingAdjustmentsDigest = onSchedule({
  schedule: "every monday 08:00",
  timeZone: "America/Chicago",
  secrets: [RESEND_API_KEY],
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 120,
}, async () => {
  await runDigest({db: admin.firestore(), sendEmail: require("./lib/email").sendEmail});
});

exports._internal = {runReconcile, runDigest, buildDigest, loadOrderLookup, createAndPoll, utcDateKey, utcMidnightSec, money};
