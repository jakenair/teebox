"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const rep = require("../../lib/shippoReporting");
const {_internal: SA} = require("../../shippingAdjustments");

// ── CSV parser ──────────────────────────────────────────────────────────
test("parseCsv: quotes, escaped quotes, commas and newlines in quotes, CRLF, BOM", () => {
  const csv = "﻿a,b,c\r\n1,\"x, y\",\"say \"\"hi\"\"\"\r\n2,\"line1\nline2\",\r\n";
  assert.deepEqual(rep.parseCsv(csv), [
    ["a", "b", "c"],
    ["1", "x, y", "say \"hi\""],
    ["2", "line1\nline2", ""],
  ]);
});

test("parseCsv: LF, no trailing newline, empty quoted field, blank lines dropped", () => {
  assert.deepEqual(rep.parseCsv("a,b\n\"\",2\n\n3,4"), [["a", "b"], ["", "2"], ["3", "4"]]);
  assert.deepEqual(rep.parseCsv(""), []);
  assert.deepEqual(rep.parseCsv("a,b\n"), [["a", "b"]]);
});

test("csvToObjects maps header to values (real test-mode row shape)", () => {
  const csv = "invoice_item_object_id,invoice_item_type,invoice_item_description,invoice_item_amount\n" +
    "50e2,LABEL_PAYMENT,\"\",6.80\n";
  assert.deepEqual(rep.csvToObjects(csv), [{
    invoice_item_object_id: "50e2", invoice_item_type: "LABEL_PAYMENT",
    invoice_item_description: "", invoice_item_amount: "6.80",
  }]);
});

// ── toCents / timestamps ─────────────────────────────────────────────────
test("toCents", () => {
  assert.equal(rep.toCents("12.34"), 1234);
  assert.equal(rep.toCents("6.80"), 680);
  assert.equal(rep.toCents("0.29"), 29);
  assert.equal(rep.toCents("1.005"), 101);
  assert.equal(rep.toCents("-3.5"), -350);
  assert.equal(rep.toCents("0.00000"), 0);
  assert.equal(rep.toCents("1,234.56"), 123456);
  assert.equal(rep.toCents(".5"), 50);
  assert.equal(rep.toCents(""), null);
  assert.equal(rep.toCents("abc"), null);
  assert.equal(rep.toCents(null), null);
  assert.equal(rep.toCents(2.5), 250);
});

test("parseTimestamp: ISO, epoch seconds, epoch ms, blank", () => {
  assert.equal(rep.parseTimestamp("2026-09-29T00:18:29.109Z"), Date.parse("2026-09-29T00:18:29.109Z"));
  assert.equal(rep.parseTimestamp("1704067200"), 1704067200000);
  assert.equal(rep.parseTimestamp("1704067200000"), 1704067200000);
  assert.equal(rep.parseTimestamp(""), null);
  assert.equal(rep.parseTimestamp("nope"), null);
});

// ── Classifier ───────────────────────────────────────────────────────────
test("isAdjustmentRow", () => {
  assert.equal(rep.isAdjustmentRow({invoice_item_type: "LABEL_PAYMENT", invoice_item_description: ""}), false);
  assert.equal(rep.isAdjustmentRow({invoice_item_type: "LABEL_REFUND", invoice_item_description: "Refund"}), false);
  assert.equal(rep.isAdjustmentRow({invoice_item_type: "CARRIER_ADJUSTMENT"}), true);
  assert.equal(rep.isAdjustmentRow({invoice_item_type: "LABEL_PAYMENT", invoice_item_description: "UPS weight correction"}), true);
  assert.equal(rep.isAdjustmentRow({invoice_item_type: "OTHER", invoice_item_description: "Dimensional weight audit"}), true);
  assert.equal(rep.isAdjustmentRow({invoice_item_type: "", invoice_item_description: "Address Surcharge"}), true);
  assert.equal(rep.isAdjustmentRow({invoice_item_type: "Reweigh"}), true);
  assert.equal(rep.isAdjustmentRow(null), false);
  assert.equal(rep.isAdjustmentRow({}), false);
});

test("computeWindow clips to availability and caps", () => {
  const D = 86400;
  const end = 1795219200;
  assert.deepEqual(rep.computeWindow(end, {status: "ready", start: 0, end: end + 999}, 45), {start: end - 45 * D, end});
  assert.deepEqual(rep.computeWindow(end, {status: "ready", start: end - 10 * D, end: end - D}, 45),
      {start: end - 10 * D, end: end - D});
  assert.equal(rep.computeWindow(end, {status: "pending", start: 0, end}, 45), null);
  assert.equal(rep.computeWindow(end, {status: "ready", start: end, end: end - 5}, 45), null);
  const w = rep.computeWindow(end, null, 200);
  assert.equal(w.end - w.start, 92 * D);
});

// ── Polling with a stubbed fetch ─────────────────────────────────────────
function res(status, body) {
  return {
    status, ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

function scripted(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, method: (init && init.method) || "GET", headers: (init && init.headers) || {}, body: init && init.body});
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return typeof next === "function" ? next(url, init) : next;
  };
  return {fetch, calls};
}

function fakeClock() {
  let t = 1_000_000;
  return {now: () => t, sleep: async (ms) => {
    t += ms;
  }};
}

const OK_DL = {status: "available", url: "https://dl.example/abc?sig=1", expires: 1};

test("pollRun: QUEUED -> PROCESSING -> SUCCEEDED", async () => {
  const {fetch, calls} = scripted([
    res(200, {id: "r1", status: "QUEUED"}),
    res(200, {id: "r1", status: "PROCESSING"}),
    res(200, {id: "r1", status: "SUCCEEDED", result: {row_count: 2, download: OK_DL}}),
  ]);
  const run = await rep.pollRun({apiKey: "k", fetch, ...fakeClock()}, "r1");
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${rep.BASE}/runs/r1`);
  assert.equal(calls[0].headers.Authorization, "ShippoToken k");
});

test("pollRun: FAILED (HTTP 200) is returned, not thrown", async () => {
  const {fetch} = scripted([
    res(200, {id: "r1", status: "PROCESSING"}),
    res(200, {id: "r1", status: "FAILED", error: {code: "run_timeout", message: "x"}}),
  ]);
  const run = await rep.pollRun({apiKey: "k", fetch, ...fakeClock()}, "r1");
  assert.equal(run.status, "FAILED");
  assert.equal(run.error.code, "run_timeout");
});

test("pollRun: SUCCEEDED but download unavailable -> refetch the run", async () => {
  const {fetch, calls} = scripted([
    res(200, {id: "r1", status: "SUCCEEDED", result: {download: {status: "unavailable"}}}),
    res(200, {id: "r1", status: "SUCCEEDED", result: {download: OK_DL}}),
  ]);
  const run = await rep.pollRun({apiKey: "k", fetch, ...fakeClock()}, "r1");
  assert.equal(run.result.download.url, OK_DL.url);
  assert.equal(calls.length, 2);
});

test("pollRun: bounded; throws poll_timeout", async () => {
  const fetch = async () => res(200, {id: "r1", status: "PROCESSING"});
  await assert.rejects(rep.pollRun({apiKey: "k", fetch, ...fakeClock()}, "r1", {maxWaitMs: 60000}),
      (e) => e.code === "poll_timeout");
});

test("apiCall: 503 retried, 400 problem+json thrown with type segment", async () => {
  const a = scripted([res(503, {type: "https://x/errors/service-unavailable"}), res(200, {data_availability: {status: "ready"}})]);
  const meta = await rep.getReportType({apiKey: "k", fetch: a.fetch, ...fakeClock()});
  assert.equal(meta.data_availability.status, "ready");
  const b = scripted([res(400, {type: "https://x/errors/invalid-column", title: "bad", status: 400})]);
  await assert.rejects(rep.getReportType({apiKey: "k", fetch: b.fetch, ...fakeClock()}),
      (e) => e.code === "invalid-column" && e.status === 400);
});

test("createRun: sends spec body; 200 marks replay", async () => {
  const {fetch, calls} = scripted([res(200, {id: "r9", status: "SUCCEEDED"})]);
  const run = await rep.createRun({apiKey: "k", fetch}, {start: 1, end: 2, idempotencyKey: "kk"});
  assert.equal(run._replayed, true);
  const body = JSON.parse(calls[0].body);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(body.interval, {start: 1, end: 2});
  assert.equal(body.report_type, "invoice.v1");
  assert.equal(body.output_format, "csv_gzip");
  assert.equal(body.idempotency_key, "kk");
  assert.ok(body.columns.includes("invoice_item_type"));
});

test("downloadReport: gunzips gzip, passes plain csv, no auth header", async () => {
  const csv = "a,b\n1,2\n";
  const {fetch, calls} = scripted([res(200, zlib.gzipSync(Buffer.from(csv))), res(200, csv)]);
  assert.equal(await rep.downloadReport({fetch}, "https://dl/1"), csv);
  assert.equal(await rep.downloadReport({fetch}, "https://dl/2"), csv);
  assert.equal(calls[0].headers.Authorization, undefined);
});

// ── Row -> doc mapping / matching ────────────────────────────────────────
const ROW = (o) => ({
  invoice_item_object_id: "ii1", invoice_item_type: "CARRIER_ADJUSTMENT",
  invoice_item_description: "UPS dimension correction", invoice_item_amount: "12.34",
  invoice_item_currency: "usd", invoice_item_created_at: "2026-11-10T12:00:00Z", invoice_number: "INV1",
  transaction_object_id: "tx1", tracking_number: "1Z1", carrier: "UPS", service_level_token: "ups_ground",
  parcel_length: "50", parcel_width: "10", parcel_height: "8", parcel_dimension_unit: "in",
  parcel_weight: "14", parcel_weight_unit: "lb", ...o,
});
const ORDER = {id: "pi_1", sellerId: "s1", listingId: "L1", shippingParcelKey: "clubs:partial",
  labelParcel: {length: "48", width: "10", height: "8", weight: "12"}};

test("buildAdjustmentDocs: match by transaction id", () => {
  const [d] = rep.buildAdjustmentDocs([ROW()], {byTransactionId: new Map([["tx1", ORDER]]), byTracking: new Map()});
  assert.equal(d.id, "ii1");
  assert.equal(d.data.orderId, "pi_1");
  assert.equal(d.data.sellerId, "s1");
  assert.equal(d.data.listingId, "L1");
  assert.equal(d.data.amountCents, 1234);
  assert.equal(d.data.currency, "USD");
  assert.equal(d.data.reason, "UPS dimension correction");
  assert.equal(d.data.type, "CARRIER_ADJUSTMENT");
  assert.equal(d.data.date.toISOString(), "2026-11-10T12:00:00.000Z");
  assert.equal(d.data.invoiceNumber, "INV1");
  assert.deepEqual(d.data.declaredParcel, ORDER.labelParcel);
  assert.deepEqual(d.data.billedParcel, {length: "50", width: "10", height: "8", weight: "14", distance_unit: "in", mass_unit: "lb"});
  assert.equal(d.data.parcelKey, "clubs:partial");
  assert.equal(d.data.matched, true);
  assert.equal(d.data.matchedBy, "transaction");
});

test("buildAdjustmentDocs: tracking fallback, then unmatched with null orderId", () => {
  const lookup = {byTransactionId: new Map(), byTracking: new Map([["1Z1", ORDER]])};
  const docs = rep.buildAdjustmentDocs([
    ROW(),
    ROW({invoice_item_object_id: "ii2", transaction_object_id: "txX", tracking_number: "nope",
      parcel_length: "", parcel_width: "", parcel_height: "", parcel_weight: ""}),
    ROW({invoice_item_object_id: ""}), // no id -> skipped
    ROW({invoice_item_object_id: "a/b"}),
  ], lookup);
  assert.equal(docs.length, 3);
  assert.equal(docs[0].data.matchedBy, "tracking");
  assert.equal(docs[0].data.orderId, "pi_1");
  assert.equal(docs[1].data.matched, false);
  assert.equal(docs[1].data.orderId, null);
  assert.equal(docs[1].data.sellerId, null);
  assert.equal(docs[1].data.declaredParcel, null);
  assert.equal(docs[1].data.billedParcel, null);
  assert.equal(docs[2].id, "a_b");
});

test("countTypes", () => {
  assert.deepEqual(rep.countTypes([{invoice_item_type: "A"}, {invoice_item_type: "B"}, {invoice_item_type: "A"}, {}]),
      [{type: "A", count: 2}, {type: "B", count: 1}, {type: "(blank)", count: 1}]);
});

// ── Fake Firestore for the orchestration tests ───────────────────────────
function fakeDb(seed = {}) {
  const store = new Map(); // path -> data
  for (const [p, d] of Object.entries(seed)) store.set(p, d);
  const snapOf = (path) => {
    const data = store.get(path);
    const id = path.split("/").pop();
    return {id, exists: data !== undefined, data: () => data, get: (f) => (data ? data[f] : undefined)};
  };
  const ref = (path) => ({
    id: path.split("/").pop(), path,
    get: async () => snapOf(path),
    set: async (data, opt) => {
      store.set(path, opt && opt.merge ? {...(store.get(path) || {}), ...data} : data);
    },
  });
  const collection = (name) => {
    const docsIn = () => [...store.keys()].filter((k) => k.startsWith(`${name}/`) && k.split("/").length === 2);
    const q = (filters) => ({
      where: (f, op, v) => q([...filters, [f, op, v]]),
      get: async () => {
        const docs = docsIn().map(snapOf).filter((s) => filters.every(([f, op, v]) => {
          const x = s.get(f);
          if (op === "==") return x === v;
          if (op === "in") return v.includes(x);
          if (op === ">=") return x instanceof Date && x >= v;
          throw new Error(op);
        }));
        return {docs, forEach: (fn) => docs.forEach(fn)};
      },
    });
    return {doc: (id) => ref(`${name}/${id}`), where: (f, op, v) => q([[f, op, v]])};
  };
  return {
    store,
    collection,
    doc: (p) => ref(p),
    getAll: async (...refs) => refs.map((r) => snapOf(r.path)),
    batch: () => {
      const ops = [];
      return {set: (r, d, o) => ops.push([r, d, o]), commit: async () => {
        for (const [r, d, o] of ops) await r.set(d, o);
      }};
    },
  };
}

function csvOf(rows) {
  const cols = rep.COLUMNS;
  const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, "\"\"")}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c] ?? "")).join(","))].join("\r\n") + "\r\n";
}

test("runReconcile: test key in prod project is skipped and logged", async () => {
  const db = fakeDb();
  const log = await SA.runReconcile({db, apiKey: "shippo_test_x", fetch: async () => {
    throw new Error("must not call");
  }, project: "teebox-market", now: () => Date.parse("2026-11-21T12:15:00Z")});
  assert.equal(log.status, "skipped-test-key");
  assert.equal(db.store.get("shippingAdjustmentRuns/2026-11-21").status, "skipped-test-key");
});

test("runReconcile: end to end with stubbed Shippo + fake Firestore", async () => {
  const nowMs = Date.parse("2026-11-21T12:15:00Z");
  const db = fakeDb({
    "orders/pi_1": {...ORDER, id: undefined, shippoTransactionId: "tx1", trackingNumber: "1Z1"},
    "shippingAdjustments/ii0": {importedAt: new Date(nowMs - 3 * 86400000), amountCents: 1},
  });
  const csv = csvOf([
    ROW({invoice_item_object_id: "lab1", invoice_item_type: "LABEL_PAYMENT", invoice_item_description: ""}),
    ROW(),
    ROW({invoice_item_object_id: "ii0", transaction_object_id: "zzz", tracking_number: "zzz", invoice_item_amount: "-2.00"}),
  ]);
  const {fetch, calls} = scripted([
    res(200, {data_availability: {status: "ready", start: 1685488753, end: 1795263667}}),
    res(201, {id: "run1", status: "QUEUED"}),
    res(200, {id: "run1", status: "PROCESSING"}),
    res(200, {id: "run1", status: "SUCCEEDED", result: {row_count: 3, download: OK_DL}}),
    res(200, zlib.gzipSync(Buffer.from(csv))),
  ]);
  const clock = fakeClock();
  const log = await SA.runReconcile({db, apiKey: "shippo_live_x", fetch, sleep: clock.sleep, now: () => nowMs, project: "teebox-market"});
  assert.equal(log.status, "ok", JSON.stringify(log.errors));
  const created = JSON.parse(calls[1].body);
  assert.equal(created.idempotency_key, "teebox-shipadj-2026-11-21");
  assert.equal(created.interval.end, Date.parse("2026-11-21T00:00:00Z") / 1000);
  assert.equal(created.interval.end - created.interval.start, 45 * 86400);
  assert.equal(log.rowCount, 3);
  assert.equal(log.adjustmentCount, 2);
  assert.equal(log.matchedCount, 1);
  assert.equal(log.unmatchedCount, 1);
  assert.equal(log.newCount, 1);
  assert.equal(log.totalCents, 1034);
  assert.deepEqual(log.rawTypes, [{type: "CARRIER_ADJUSTMENT", count: 2}, {type: "LABEL_PAYMENT", count: 1}]);
  const d = db.store.get("shippingAdjustments/ii1");
  assert.equal(d.orderId, "pi_1");
  assert.equal(d.sellerId, "s1");
  assert.ok(d.importedAt, "new doc gets importedAt");
  const old = db.store.get("shippingAdjustments/ii0");
  assert.ok(old.importedAt instanceof Date, "existing importedAt kept");
  assert.equal(old.matched, false);
  assert.equal(db.store.has("shippingAdjustments/lab1"), false);
  assert.equal(db.store.get("shippingAdjustmentRuns/2026-11-21").runIds[0], "run1");
});

test("runReconcile: FAILED transient run retried once with a fresh key", async () => {
  const nowMs = Date.parse("2026-11-21T12:15:00Z");
  const db = fakeDb();
  const {fetch, calls} = scripted([
    res(200, {data_availability: {status: "ready", start: 0, end: 1795263667}}),
    res(201, {id: "run1", status: "QUEUED"}),
    res(200, {id: "run1", status: "FAILED", error: {code: "run_failed"}}),
    res(201, {id: "run2", status: "QUEUED"}),
    res(200, {id: "run2", status: "SUCCEEDED", result: {row_count: 0, download: OK_DL}}),
    res(200, csvOf([])),
  ]);
  const log = await SA.runReconcile({db, apiKey: "shippo_live_x", fetch, sleep: async () => {}, now: () => nowMs});
  assert.equal(log.status, "ok");
  assert.deepEqual(log.runIds, ["run1", "run2"]);
  assert.match(JSON.parse(calls[3].body).idempotency_key, /-retry1$/);
  assert.equal(log.errors.length, 1);
});

// ── Digest ───────────────────────────────────────────────────────────────
test("buildDigest: zero adjustments still produces a one-line email", () => {
  const d = SA.buildDigest({adjustments: [], runs: [{status: "ok"}]});
  assert.equal(d.subject, "No carrier adjustments this week");
  assert.match(d.text, /No carrier adjustments this week/);
  assert.match(d.text, /1 ok, 0 not ok, 6 missing/);
});

test("buildDigest: per-seller rows, box names, unmatched, subject <= 50", () => {
  const d = SA.buildDigest({
    adjustments: [
      {sellerId: "s1", amountCents: 1234, parcelKey: "clubs:partial"},
      {sellerId: "s1", amountCents: 500, parcelKey: "bags"},
      {sellerId: "s2", amountCents: 300, parcelKey: null},
      {sellerId: null, amountCents: 999},
    ],
    names: {s1: "Pro <Shop>"},
  });
  assert.ok(d.subject.length <= 50);
  assert.equal(d.subject, "Carrier adjustments: 4, $30.33");
  assert.equal(d.count, 4);
  assert.equal(d.totalCents, 3033);
  assert.match(d.html, /Pro &lt;Shop&gt; \(s1\)/);
  assert.match(d.text, /Pro <Shop> \(s1\): 2, \$17\.34, Partial set \/ 4-7 clubs, Bag box/);
  assert.match(d.text, /s2: 1, \$3\.00, Unknown box/);
  assert.match(d.text, /Unmatched \(no order found\): 1, \$9\.99/);
  assert.doesNotMatch(d.html, /[\u{1F300}-\u{1FAFF}]/u);
});

test("runDigest: queries last 7 days by importedAt and sends to opsEmail", async () => {
  require("../../lib/shippingParcels")._resetConfigCache();
  const nowMs = Date.parse("2026-11-23T14:00:00Z");
  const db = fakeDb({
    "shippingAdjustments/a": {importedAt: new Date(nowMs - 86400000), sellerId: "s1", amountCents: 700, parcelKey: "clubs:full"},
    "shippingAdjustments/b": {importedAt: new Date(nowMs - 9 * 86400000), sellerId: "s1", amountCents: 100},
    "users/s1": {displayName: "Seller One"},
    "shippingAdjustmentRuns/2026-11-23": {status: "ok"},
    "config/shipping": {opsEmail: "ops@example.com"},
  });
  let sent = null;
  const {digest} = await SA.runDigest({db, now: () => nowMs, sendEmail: async (o) => {
    sent = o; return {sent: true};
  }});
  assert.equal(digest.count, 1);
  assert.equal(sent.to, "ops@example.com");
  assert.equal(sent.category, "transactional");
  assert.equal(sent.template, "ShippingAdjustmentsDigest");
  assert.match(sent.text, /Seller One \(s1\): 1, \$7\.00, Full set \/ 8\+ clubs/);
});
