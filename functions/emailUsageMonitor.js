/**
 * functions/emailUsageMonitor.js
 * ─────────────────────────────────────────────────────────────────────────
 * Watches Resend send volume and alerts when we approach the Free-tier
 * 100-emails/day cap.
 *
 * Threshold: 70 emails in a rolling 24-hour window → fire alert.
 *   - 30-email buffer before we'd actually hit the cap and start dropping
 *     messages, so operator has time to upgrade to Pro before users notice.
 *
 * Cooldown: don't re-alert if we've already alerted within the last 6h.
 * Avoids paging the operator every hour while they're already aware.
 *
 * Alert layers (mirror the Pro / email smoke pattern):
 *   1. Firestore doc `emailUsageAlerts/{YYYY-MM-DD-HH}` — durable record
 *   2. logger.error("[EMAIL_USAGE] ALERT") — picked up by GCP log-based alerts
 *   3. POST to SMOKE_ALERT_WEBHOOK if the secret is set (Slack/Discord)
 *
 * Source of truth for "how many emails were sent": the `emailSends/`
 * collection. Every send hits `recordSend()` in `functions/lib/email.js`,
 * which writes one doc per attempt (`status: "sent" | "skipped-*" | ...`).
 * We count only successful sends (`status === "sent"`).
 *
 * Required composite index on `emailSends`:
 *   collection: emailSends
 *   fields:     status (Asc), sentAt (Asc)
 *   (or just sentAt single-field if you'd rather count all attempts.)
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const https = require("https");
const {URL} = require("url");

// Reuse the existing alert webhook so a single Slack/Discord channel
// receives all smoke / monitoring alerts. Optional.
const SMOKE_ALERT_WEBHOOK = defineSecret("SMOKE_ALERT_WEBHOOK");

// Tunable from server-side config (config/email.usageMonitor). If not set,
// these defaults apply. Lets the operator raise the threshold post-Pro
// upgrade without a redeploy.
const DEFAULT_THRESHOLD = 70;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_COOLDOWN_HOURS = 6;

const SCHED_FN = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
};

async function loadConfig() {
  try {
    const snap = await admin.firestore().doc("config/email").get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const u = data.usageMonitor || {};
    return {
      threshold: Number.isFinite(u.threshold) ? u.threshold : DEFAULT_THRESHOLD,
      windowHours: Number.isFinite(u.windowHours) ? u.windowHours : DEFAULT_WINDOW_HOURS,
      cooldownHours: Number.isFinite(u.cooldownHours) ? u.cooldownHours : DEFAULT_COOLDOWN_HOURS,
      enabled: u.enabled !== false,
    };
  } catch (_e) {
    return {
      threshold: DEFAULT_THRESHOLD,
      windowHours: DEFAULT_WINDOW_HOURS,
      cooldownHours: DEFAULT_COOLDOWN_HOURS,
      enabled: true,
    };
  }
}

exports.checkEmailUsage = onSchedule(
    {
      schedule: "every 60 minutes",
      timeZone: "America/New_York",
      secrets: [SMOKE_ALERT_WEBHOOK],
      ...SCHED_FN,
    },
    async () => {
      const cfg = await loadConfig();
      if (!cfg.enabled) {
        logger.info("[EMAIL_USAGE] monitor disabled via config");
        return;
      }

      const db = admin.firestore();
      const now = Date.now();
      const windowStart = new Date(now - cfg.windowHours * 60 * 60 * 1000);

      // Count successful sends in the rolling window. Use aggregate query
      // when supported (firebase-admin >= 11.x); else fall back to count.
      let sentCount = 0;
      try {
        const ref = db
            .collection("emailSends")
            .where("status", "==", "sent")
            .where("sentAt", ">=", windowStart);
        if (typeof ref.count === "function") {
          const agg = await ref.count().get();
          sentCount = agg.data().count;
        } else {
          const snap = await ref.select().get();
          sentCount = snap.size;
        }
      } catch (e) {
        logger.error(`[EMAIL_USAGE] count query failed: ${e.message || e}`);
        return;
      }

      logger.info(
          `[EMAIL_USAGE] ${sentCount} sends in last ${cfg.windowHours}h ` +
          `(threshold: ${cfg.threshold})`,
      );

      if (sentCount < cfg.threshold) return;

      // Threshold hit. Check cooldown to avoid alert storms.
      const lastAlertSnap = await db
          .collection("emailUsageAlerts")
          .orderBy("alertedAt", "desc")
          .limit(1)
          .get();
      if (!lastAlertSnap.empty) {
        const lastAlertAt = lastAlertSnap.docs[0].data().alertedAt;
        const lastMs = lastAlertAt && lastAlertAt.toMillis ? lastAlertAt.toMillis() : 0;
        if (lastMs && (now - lastMs) < cfg.cooldownHours * 60 * 60 * 1000) {
          logger.info(
              `[EMAIL_USAGE] threshold hit (${sentCount}) but in cooldown ` +
              `(last alert ${Math.round((now - lastMs) / 60000)}m ago)`,
          );
          return;
        }
      }

      // Fire alert across all 3 layers.
      const docId = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 13);
      await db.doc(`emailUsageAlerts/${docId}`).set({
        sentCount,
        threshold: cfg.threshold,
        windowHours: cfg.windowHours,
        alertedAt: admin.firestore.FieldValue.serverTimestamp(),
        message: `Resend usage at ${sentCount}/${cfg.threshold} in ${cfg.windowHours}h`,
      });

      logger.error(
          "[EMAIL_USAGE] ALERT — Resend Free-tier cap approaching",
          {sentCount, threshold: cfg.threshold, windowHours: cfg.windowHours},
      );

      let url = null;
      try {
        url = SMOKE_ALERT_WEBHOOK.value();
      } catch (_e) {
        url = null;
      }
      if (url) {
        const message =
          `TeeBox email-usage alert\n` +
          `${sentCount} sends in the last ${cfg.windowHours}h ` +
          `(threshold ${cfg.threshold}, Resend Free cap 100/day).\n` +
          `Time to upgrade to Pro: https://resend.com/billing`;
        const body = JSON.stringify({text: message, content: message, message});
        try {
          await postJson(url, body);
        } catch (e) {
          logger.error(
              `[EMAIL_USAGE] webhook POST failed: ${e && e.message || e}`,
          );
        }
      }
    },
);

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlString);
    } catch (e) {
      reject(e);
      return;
    }
    const opts = {
      method: "POST",
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10_000,
    };
    const req = https.request(opts, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("webhook timeout"));
    });
    req.write(body);
    req.end();
  });
}
