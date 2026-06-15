// functions/opsAlert.js
//
// Lightweight ops alerting for CRITICAL money-path + notification failures.
// Reuses the existing SMOKE_ALERT_WEBHOOK channel (the same one the Bingo
// cross-platform monitor posts to). Every alert is ALSO logged via
// logger.error with an [OPS_ALERT] prefix, so it is greppable in Cloud Logging
// even when the webhook secret is unset or the POST fails.
//
// Design contract: opsAlert() is BEST-EFFORT and NEVER throws. It is called
// from inside catch blocks on the payment / refund / notification paths, so it
// must not be able to turn an already-handled failure into an unhandled one.
// Any function that calls opsAlert MUST include OPS_ALERT_WEBHOOK in its
// `secrets:` array (and, for gcloud deploys, in --set-secrets) so the value is
// readable at runtime. If the secret is absent the log line still lands.

const http = require("http");
const https = require("https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");

// Same secret NAME the Bingo monitor uses — one shared alert channel. Defining
// the same param in two modules is fine; the params registry keys by name.
const OPS_ALERT_WEBHOOK = defineSecret("SMOKE_ALERT_WEBHOOK");

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
    }, (resp) => {
      // Drain + resolve on any response; we never retry webhook delivery.
      resp.on("data", () => {});
      resp.on("end", () => resolve(resp.statusCode));
    });
    req.on("timeout", () => req.destroy(new Error("webhook POST timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Fire a best-effort ops alert. NEVER throws.
 * @param {string} severity  "critical" | "warn"
 * @param {string} title     short human headline
 * @param {object} [details] structured context (orderId, refundId, error, ...)
 */
async function opsAlert(severity, title, details = {}) {
  const sev = String(severity || "warn").toUpperCase();
  // Always log first — this is the durable record, independent of the webhook.
  try {
    logger.error(`[OPS_ALERT][${sev}] ${title}`, details);
  } catch (_e) { /* logging must never break the caller */ }

  let url;
  try {
    url = OPS_ALERT_WEBHOOK.value();
  } catch (_e) {
    return; // secret not bound at runtime — the log line above is the record
  }
  if (!url) return;

  try {
    const lines = Object.entries(details)
        .map(([k, v]) =>
          `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");
    const message =
      `\u{1F6A8} TeeBox OPS ALERT [${sev}]\n` +
      `${title}\n` +
      (lines ? `${lines}\n` : "");
    const body = JSON.stringify({text: message, content: message, message});
    await postJson(url, body);
  } catch (err) {
    logger.error(
        `[OPS_ALERT] webhook POST failed: ${err && err.message || err}`);
  }
}

module.exports = {opsAlert, OPS_ALERT_WEBHOOK};
