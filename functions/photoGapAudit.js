/**
 * functions/photoGapAudit.js
 * ─────────────────────────────────────────────────────────────────────────
 * photoGapAuditMonthly — 1st of every month, 06:00 America/Chicago.
 * Reconciles listings.photos[] against Storage (lib/photoGapAudit) and
 * emails the founder ONLY when it finds a gap (dead URL in a doc) or an
 * orphan (object with no listing). Quiet months write the result doc and
 * nothing else. Same on-demand check: `node scripts/audit-photo-gaps.mjs`.
 *
 * Email goes through lib/email.sendEmail as transactional (internal ops
 * mail, same lane as the daily founder briefing).
 */
"use strict";
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {sendEmail, RESEND_API_KEY} = require("./lib/email");
const {runPhotoGapAudit, formatReport} = require("./lib/photoGapAudit");
const cfg = require("./founderBriefingConfig");

const BUCKET = "teebox-market.firebasestorage.app";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

exports.photoGapAuditMonthly = onSchedule(
    {
      schedule: "0 6 1 * *",
      timeZone: "America/Chicago",
      region: "us-central1",
      memory: "512MiB",
      timeoutSeconds: 300,
      secrets: [RESEND_API_KEY],
    },
    async () => {
      const db = admin.firestore();
      const bucket = admin.storage().bucket(BUCKET);
      const report = await runPhotoGapAudit(db, bucket);
      const month = report.generatedAt.slice(0, 7);
      await db.collection("photoGapAudits").doc(month).set({
        ...report.stats,
        gaps: report.gaps,
        orphans: report.orphans,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      const noisy = report.stats.gaps > 0 || report.stats.orphans > 0;
      logger.info("photoGapAuditMonthly", {...report.stats, emailed: noisy});
      if (!noisy) return;

      const text = formatReport(report);
      const html = `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` +
        `<p style="font:13px system-ui">Fix a gap: remove the dead URL from the listing (approveFlaggedListing ` +
        `prunes these automatically from now on). Orphans: safe to delete with ` +
        `<code>gsutil rm</code>, or leave them.</p>`;
      const res = await sendEmail({
        to: cfg.RECIPIENT_EMAIL,
        subject: `TeeBox photo audit ${month}: ${report.stats.gaps} gap(s), ${report.stats.orphans} orphan(s)`,
        html,
        text,
        category: "transactional",
        template: "PhotoGapAudit",
        tags: [{name: "internal", value: "1"}],
        idempotencyKey: `photo-gap-audit-${month}`,
      });
      if (!(res && res.sent)) logger.warn("photoGapAuditMonthly: email not sent", res);
    },
);
