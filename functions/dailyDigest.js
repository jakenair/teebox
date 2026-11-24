/**
 * functions/dailyDigest.js — the daily activity digest (2026-11-23).
 * 7:00 AM Central, covering the Central day before. Writes
 * metrics_daily/{date} and emails DIGEST_RECIPIENTS (comma-separated, set on
 * the function). Counting rules are in lib/dailyDigestCore.js.
 */
"use strict";
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const core = require("./lib/dailyDigestCore");
const {adminGate} = require("./lib/adminGate");
const {opsAlert, OPS_ALERT_WEBHOOK} = require("./opsAlert");
const {sendEmail, CATEGORIES, RESEND_API_KEY, UNSUBSCRIBE_SECRET} = require("./lib/email");

/**
 * @param {object} db
 * @param {string} date
 * @param {{to: string[], test: (boolean|undefined), partial: (boolean|undefined), runId: (string|undefined)}} o
 *   a test run writes no snapshot and may be sent more than once
 */
async function runDigest(db, date, o) {
  const ref = db.doc(`metrics_daily/${date}`);
  // A repeat of the same day sends what the first run counted.
  const prior = o.test ? null : await ref.get();
  let m = prior && prior.exists ? prior.data() : null;
  if (!m) {
    m = await core.collect(db, date);
    if (!o.test) await ref.set({...m, createdAt: admin.firestore.FieldValue.serverTimestamp()});
  }
  const monday = core.isMonday(core.addDays(date, 1));
  const want = monday ? 14 : 1; // yesterday's numbers, or two weeks of days on Mondays
  const days = (await db.getAll(...Array.from({length: want}, (_, i) => db.doc(`metrics_daily/${core.addDays(date, -(i + 1))}`))))
      .map((s) => s.exists ? s.data() : null);
  const x = {prev: days[0], test: o.test, partial: o.partial, week: null, lastWeek: null};
  if (monday) {
    x.week = core.weekly([m, ...days.slice(0, 6)].filter(Boolean));
    x.lastWeek = core.weekly(days.slice(6, 13).filter(Boolean));
  }
  const mail = core.render(m, x);
  const results = await Promise.all(o.to.map(async (to, i) => {
    try {
      const r = await sendEmail({to, subject: mail.subject, html: mail.html, text: mail.text, category: CATEGORIES.TRANSACTIONAL,
        template: "DailyDigest", tags: [{name: "kind", value: "daily-digest"}], idempotencyKey: `digest-${date}-${o.runId || "daily"}-${i}`});
      return !!(r && (r.sent || r.id));
    } catch (e) { logger.error("dailyDigest: send failed", {i, error: String(e && e.message || e)}); return false; }
  }));
  return {metrics: m, sent: results.filter(Boolean).length, of: o.to.length, results};
}

exports.dailyActivityDigest = onSchedule(
    {schedule: "0 7 * * *", timeZone: core.TZ, region: "us-central1", memory: "512MiB", timeoutSeconds: 120, maxInstances: 1,
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET, OPS_ALERT_WEBHOOK]},
    async () => {
      const date = core.addDays(core.ctDate(Date.now()), -1);
      try {
        const to = String(process.env.DIGEST_RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!to.length) throw new Error("DIGEST_RECIPIENTS is not set");
        const r = await runDigest(admin.firestore(), date, {to});
        logger.info("dailyActivityDigest", {date, sent: r.sent, of: r.of, errors: r.metrics.errors.length});
        if (r.sent < r.of) throw new Error(`sent ${r.sent} of ${r.of}`);
      } catch (e) {
        await opsAlert("warn", "Daily digest did not go out", {date, error: String(e && e.message || e)});
        throw e;
      }
    },
);

/** Admin only: the last 35 snapshots for /admin/metrics. */
exports.listDailyMetrics = onCall({region: "us-central1", memory: "256MiB", timeoutSeconds: 30, maxInstances: 3}, async (req) => {
  adminGate(req);
  const s = await admin.firestore().collection("metrics_daily").orderBy("date", "desc").limit(35).get();
  return {days: s.docs.map((d) => { const {createdAt: _c, ...m} = d.data(); return m; })};
});

module.exports.runDigest = runDigest;
