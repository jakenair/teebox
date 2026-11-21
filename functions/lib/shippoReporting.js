"use strict";
// Shippo Reporting API (invoice.v1) helpers for carrier-adjustment tracking.
//
// Shippo bills carrier adjustments (box bigger/heavier than declared) to our
// Shippo account 30-60 days after a label ships. There is no webhook, so a
// daily job (shippingAdjustments.js) runs an invoice.v1 report, finds the
// adjustment rows and matches them to orders. TRACK ONLY: nothing here moves
// money or deducts anything from anyone.
//
// Flow: GET /reports/invoice.v1 (data_availability) -> POST /runs -> poll
// GET /runs/{id} until SUCCEEDED/FAILED -> GET result.download.url (signed,
// no auth header) -> gunzip -> CSV -> rows.
// All Shippo timestamps on the API are epoch SECONDS; the CSV cells for
// *_created_at / *_at come back as ISO strings (seen on a live test run
// 2026-11-21), parseTimestamp() accepts both.
//
// Every network call takes an injected `fetch` so tests can stub it.

const zlib = require("zlib");

const BASE = "https://api.goshippo.com/v2/reporting";
const REPORT_TYPE = "invoice.v1";
const MAX_INTERVAL_SEC = 92 * 86400;

// Columns we request (all listed in invoice.v1 available_columns).
const COLUMNS = [
  "invoice_item_object_id",
  "invoice_item_type",
  "invoice_item_description",
  "invoice_item_amount",
  "invoice_item_currency",
  "invoice_item_created_at",
  "invoice_number",
  "invoice_ready_for_charge_at",
  "transaction_object_id",
  "tracking_number",
  "carrier",
  "service_level_token",
  "parcel_length",
  "parcel_width",
  "parcel_height",
  "parcel_dimension_unit",
  "parcel_weight",
  "parcel_weight_unit",
  "rate_amount",
  "insurance_fee_amount",
];

class ShippoReportingError extends Error {
  constructor(message, {status, code, transient} = {}) {
    super(message);
    this.name = "ShippoReportingError";
    this.status = status || null;
    this.code = code || null; // problem `type` last segment, or run error.code
    this.transient = !!transient;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function problemCode(body) {
  const t = body && typeof body === "object" ? body.type : null;
  if (typeof t !== "string" || !t) return null;
  const parts = t.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return {raw: String(text).slice(0, 300)};
  }
}

/**
 * One JSON call to the Reporting API. Retries 503 / network errors a few
 * times. Throws ShippoReportingError on any other non-2xx.
 * @return {Promise<{status: number, body: Object}>}
 */
async function apiCall({apiKey, fetch, sleep = defaultSleep}, method, path, body, {tries = 3} = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Authorization": `ShippoToken ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      lastErr = new ShippoReportingError(`network: ${e && e.message}`, {transient: true});
      await sleep(1000 * (i + 1));
      continue;
    }
    const json = await readJson(res);
    if (res.status >= 200 && res.status < 300) return {status: res.status, body: json};
    const code = problemCode(json);
    const detail = (json && (json.detail || json.title)) || "";
    lastErr = new ShippoReportingError(
        `${method} ${path} -> ${res.status}${code ? ` ${code}` : ""}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`,
        {status: res.status, code, transient: res.status === 503 || res.status === 429});
    if (!lastErr.transient) throw lastErr;
    await sleep(2000 * (i + 1));
  }
  throw lastErr;
}

/** GET /reports/invoice.v1 -> {data_availability, available_columns, ...} */
async function getReportType(opts) {
  const {body} = await apiCall(opts, "GET", `/reports/${REPORT_TYPE}`);
  return body;
}

/**
 * The run interval: `days` back from `endSec`, clipped to data_availability
 * and the 92-day cap. Returns null when nothing is runnable.
 * @param {number} endSec desired end (epoch seconds)
 * @param {Object|null} availability {status, start, end}
 * @param {number} days
 */
function computeWindow(endSec, availability, days = 45) {
  const av = availability || {};
  if (av.status && av.status !== "ready") return null;
  let end = Math.floor(endSec);
  if (Number.isFinite(av.end)) end = Math.min(end, Math.floor(av.end));
  let start = end - Math.min(days * 86400, MAX_INTERVAL_SEC);
  if (Number.isFinite(av.start)) start = Math.max(start, Math.ceil(av.start));
  if (!(end > start)) return null;
  return {start, end};
}

/**
 * POST /runs. 201 = new, 200 = idempotent replay of the same body.
 * @return {Promise<Object>} the run ({id, status, ...})
 */
async function createRun(opts, {start, end, idempotencyKey, columns = COLUMNS, outputFormat = "csv_gzip"}) {
  const body = {
    report_type: REPORT_TYPE,
    interval: {start, end},
    columns,
    output_format: outputFormat,
  };
  if (idempotencyKey) body.idempotency_key = idempotencyKey;
  const {status, body: run} = await apiCall(opts, "POST", "/runs", body);
  if (!run || !run.id) throw new ShippoReportingError(`createRun: no run id (HTTP ${status})`, {status});
  return {...run, _replayed: status === 200};
}

/** GET /runs/{id} */
async function getRun(opts, runId) {
  const {body} = await apiCall(opts, "GET", `/runs/${encodeURIComponent(runId)}`);
  return body;
}

/**
 * Poll a run until it is terminal AND (if SUCCEEDED) its download is
 * available. Bounded by maxWaitMs (default 7 min, inside a 540s function).
 * Backoff: 2s, 4s, 6s ... capped at 15s.
 * FAILED comes back as HTTP 200 with error.code; it is returned, not thrown.
 * @return {Promise<Object>} run with status SUCCEEDED (download available) or FAILED
 */
async function pollRun(opts, runId, {maxWaitMs = 7 * 60 * 1000, initialDelayMs = 2000, maxDelayMs = 15000} = {}) {
  const sleep = opts.sleep || defaultSleep;
  const now = opts.now || (() => Date.now());
  const deadline = now() + maxWaitMs;
  let delay = initialDelayMs;
  let last = null;
  for (;;) {
    last = await getRun(opts, runId);
    const st = last && last.status;
    if (st === "FAILED") return last;
    if (st === "SUCCEEDED") {
      const dl = last.result && last.result.download;
      if (dl && dl.status === "available" && dl.url) return last;
      // download unavailable -> re-fetch the run for a fresh URL
    }
    if (now() + delay > deadline) {
      throw new ShippoReportingError(`pollRun: run ${runId} still ${st || "unknown"} after ${Math.round(maxWaitMs / 1000)}s`,
          {code: "poll_timeout", transient: true});
    }
    await sleep(delay);
    delay = Math.min(delay + initialDelayMs, maxDelayMs);
  }
}

/** True for gzip magic bytes. */
function isGzip(buf) {
  return buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * GET the signed download URL (no Shippo auth header) -> CSV text.
 * Gunzips when the payload is gzip.
 */
async function downloadReport({fetch}, url) {
  const res = await fetch(url, {method: "GET"});
  if (!res.ok) {
    throw new ShippoReportingError(`download -> HTTP ${res.status}`,
        {status: res.status, code: "download_failed", transient: res.status === 403 || res.status >= 500});
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return isGzip(buf) ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

/**
 * RFC 4180 CSV -> array of records (arrays of strings).
 * Handles quoted fields, "" escaped quotes, commas/newlines inside quotes,
 * CRLF or LF line endings, a leading BOM, and a trailing newline.
 * @param {string} text
 * @return {string[][]}
 */
function parseCsv(text) {
  const s = String(text || "").replace(/^﻿/, "");
  const out = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (inQuotes) {
      if (c === "\"") {
        if (s[i + 1] === "\"") {
          field += "\"";
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === "\"") {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
      i += (c === "\r" && s[i + 1] === "\n") ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    out.push(row);
  }
  // drop blank lines (a record that is a single empty field)
  return out.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** CSV text with a header row -> array of {column: value} objects. */
function csvToObjects(text) {
  const recs = parseCsv(text);
  if (!recs.length) return [];
  const header = recs[0].map((h) => h.trim());
  return recs.slice(1).map((r) => {
    const o = {};
    header.forEach((h, idx) => {
      o[h] = r[idx] !== undefined ? r[idx] : "";
    });
    return o;
  });
}

/**
 * "12.34" -> 1234, "-3.5" -> -350, "0.00000" -> 0. Null for blank/garbage.
 * Rounds half away from zero to the cent.
 */
function toCents(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v == null ? "" : v).trim().replace(/[$,\s]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const neg = s.startsWith("-");
  const abs = Math.round(Math.abs(parseFloat(s)) * 100 + 1e-9);
  return neg ? -abs : abs;
}

/** ISO string or epoch seconds/ms -> ms since epoch, or null. */
function parseTimestamp(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    return num > 1e12 ? Math.round(num) : Math.round(num * 1000);
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// ── Adjustment classifier ────────────────────────────────────────────────
// !! RE-CHECK AGAINST REAL ROWS. Shippo does not document the
// invoice_item_type values. A live TEST-key run on 2026-11-21 returned only
// "LABEL_PAYMENT" (plain label purchases, empty description). The pattern
// below is a guess at how adjustment items are named. Every run logs ALL raw
// types it saw (shippingAdjustmentRuns/{date}.rawTypes) so this can be tuned
// once the first real adjustment shows up on a live invoice.
const ADJUSTMENT_RE = /adjust|correction|surcharge|audit|reweigh|dimension/i;

/**
 * True if an invoice.v1 row looks like a carrier adjustment. A plain label
 * purchase (e.g. LABEL_PAYMENT with no adjustment wording) is not one.
 * @param {Object} row CSV row object
 */
function isAdjustmentRow(row) {
  if (!row || typeof row !== "object") return false;
  const type = String(row.invoice_item_type || "");
  const desc = String(row.invoice_item_description || "");
  return ADJUSTMENT_RE.test(type) || ADJUSTMENT_RE.test(desc);
}

/** Parcel columns from a row, or null when the row has none. */
function rowParcel(row) {
  const r = row || {};
  const p = {
    length: r.parcel_length || "",
    width: r.parcel_width || "",
    height: r.parcel_height || "",
    weight: r.parcel_weight || "",
    distance_unit: r.parcel_dimension_unit || "",
    mass_unit: r.parcel_weight_unit || "",
  };
  return (p.length || p.width || p.height || p.weight) ? p : null;
}

/** Firestore-safe id for an invoice item (doc ids can't contain "/"). */
function docIdFor(row) {
  const id = String((row && row.invoice_item_object_id) || "").trim();
  if (!id || id === "." || id === ".." || id.length > 700) return null;
  return id.replace(/\//g, "_");
}

/**
 * Pure: adjustment rows + order lookup -> Firestore docs.
 * Match by transaction_object_id first (orders.shippoTransactionId), then
 * tracking_number (orders.trackingNumber). Unmatched rows still produce a
 * doc with orderId null.
 * @param {Object[]} rows already filtered with isAdjustmentRow
 * @param {{byTransactionId: Map<string,Object>, byTracking: Map<string,Object>}} lookup
 *   values are {id, ...orderData}
 * @return {{id: string, data: Object}[]}
 */
function buildAdjustmentDocs(rows, lookup) {
  const byTx = (lookup && lookup.byTransactionId) || new Map();
  const byTrk = (lookup && lookup.byTracking) || new Map();
  const out = [];
  for (const row of rows || []) {
    const id = docIdFor(row);
    if (!id) continue;
    const tx = String(row.transaction_object_id || "").trim();
    const trk = String(row.tracking_number || "").trim();
    let order = null;
    let matchedBy = null;
    if (tx && byTx.has(tx)) {
      order = byTx.get(tx); matchedBy = "transaction";
    } else if (trk && byTrk.has(trk)) {
      order = byTrk.get(trk); matchedBy = "tracking";
    }
    const dateMs = parseTimestamp(row.invoice_item_created_at) ?? parseTimestamp(row.invoice_ready_for_charge_at);
    out.push({
      id,
      data: {
        orderId: order ? order.id : null,
        sellerId: (order && order.sellerId) || null,
        listingId: (order && order.listingId) || null,
        amountCents: toCents(row.invoice_item_amount),
        currency: String(row.invoice_item_currency || "").toUpperCase() || null,
        reason: String(row.invoice_item_description || "") || null,
        type: String(row.invoice_item_type || "") || null,
        date: dateMs != null ? new Date(dateMs) : null,
        invoiceNumber: String(row.invoice_number || "") || null,
        transactionId: tx || null,
        trackingNumber: trk || null,
        carrier: String(row.carrier || "") || null,
        serviceLevel: String(row.service_level_token || "") || null,
        declaredParcel: (order && order.labelParcel) || null,
        // Parcel columns on the invoice row. Unverified whether Shippo
        // fills these with the carrier's billed dims or with the parcel we
        // submitted; compare against declaredParcel before relying on it.
        billedParcel: rowParcel(row),
        parcelKey: (order && order.shippingParcelKey) || null,
        matched: !!order,
        matchedBy,
      },
    });
  }
  return out;
}

/** Count raw invoice_item_type values -> [{type, count}] (sorted). */
function countTypes(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const t = String((r && r.invoice_item_type) || "") || "(blank)";
    m.set(t, (m.get(t) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({type, count}));
}

module.exports = {
  BASE,
  REPORT_TYPE,
  COLUMNS,
  ADJUSTMENT_RE,
  ShippoReportingError,
  apiCall,
  getReportType,
  computeWindow,
  createRun,
  getRun,
  pollRun,
  downloadReport,
  isGzip,
  parseCsv,
  csvToObjects,
  toCents,
  parseTimestamp,
  isAdjustmentRow,
  rowParcel,
  docIdFor,
  buildAdjustmentDocs,
  countTypes,
};
