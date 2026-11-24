// functions/opsAlertRelay.js — 2026-10-29
//
// Delivery target for opsAlert(): the SMOKE_ALERT_WEBHOOK secret points at THIS
// function's URL (with ?t=<OPS_ALERT_RELAY_TOKEN>). opsAlert POSTs a bare JSON
// body {text, content, message} with no auth header, so it cannot talk to Resend
// or Telegram directly; this relay fans the alert out to
//   1. email  → OPS_ALERT_EMAIL (default jakenair@teeboxmarket.com) via lib/email (Resend)
//   2. Telegram → OPS_TELEGRAM_TOKEN / OPS_TELEGRAM_CHAT_ID when both secrets exist
//                 (a SEPARATE "TeeBox Ops" chat, never the EdgeFinder bot's chat)
// Token-gated so the public URL cannot be used to spam the inbox. Best-effort:
// Answers 502 when no email went out, so opsAlert tries once more.
// Each alert carries an id; emails are keyed on id + address.
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const crypto = require("crypto");
const https = require("https");
const {sendEmail, CATEGORIES, RESEND_API_KEY, UNSUBSCRIBE_SECRET} = require("./lib/email");

const OPS_ALERT_RELAY_TOKEN = defineSecret("OPS_ALERT_RELAY_TOKEN");
const OPS_TELEGRAM_TOKEN = defineSecret("OPS_TELEGRAM_TOKEN");
const OPS_TELEGRAM_CHAT_ID = defineSecret("OPS_TELEGRAM_CHAT_ID");
// Ops alerts go to the configured address AND the TeeBox mailbox (founder,
// 2026-11-23: keep both).
const TEEBOX_MAILBOX = "jakenair@teeboxmarket.com";
function recipients(env) {
  return [...new Set([...String(env || "").split(","), TEEBOX_MAILBOX].map((a) => a.trim().toLowerCase()).filter(Boolean))];
}

/** Constant-time token compare; false on any shape mismatch. */
function tokenOk(given, expected) {
  if (!given || !expected || typeof given !== "string") return false;
  const a = Buffer.from(given); const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The alert's own id, or a fresh one (older callers don't send it). */
function alertIdOf(body) {
  const id = body && typeof body === "object" ? String(body.alertId || "") : "";
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : crypto.randomUUID();
}

/** Pull the alert text out of whatever opsAlert posted. */
function alertText(body) {
  const b = (body && typeof body === "object") ? body : {};
  const t = b.text || b.message || b.content || (typeof body === "string" ? body : "");
  return String(t || "").slice(0, 4000);
}

/** Subject = severity + headline, trimmed to the email reviewer's 50 chars. */
function subjectFor(text) {
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const sev = /\[(CRITICAL|ERROR|WARN)\]/.exec(lines[0] || "");
  const head = lines[1] || lines[0] || "Ops alert";
  return `TeeBox ops ${sev ? sev[1] : "ALERT"}: ${head}`.slice(0, 50);
}

function telegram(token, chatId, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({chat_id: chatId, text: text.slice(0, 3900)});
    const req = https.request({method: "POST", hostname: "api.telegram.org", path: `/bot${token}/sendMessage`, headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload)}, timeout: 8000}, (res) => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode)); });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", () => resolve(0)); req.write(payload); req.end();
  });
}

exports.opsAlertRelay = onRequest(
    {region: "us-central1", memory: "256MiB", timeoutSeconds: 20, maxInstances: 2,
      secrets: [OPS_ALERT_RELAY_TOKEN, OPS_TELEGRAM_TOKEN, OPS_TELEGRAM_CHAT_ID, RESEND_API_KEY, UNSUBSCRIBE_SECRET]},
    async (req, res) => {
      if (req.method !== "POST") { res.status(405).send("POST only"); return; }
      let expected = ""; try { expected = OPS_ALERT_RELAY_TOKEN.value(); } catch (_e) { expected = ""; }
      if (!tokenOk(String(req.query.t || ""), expected)) { res.status(401).send("bad token"); return; }
      const text = alertText(req.body);
      if (!text) { res.status(400).send("empty"); return; }
      const out = {email: "skipped", telegram: "skipped"};
      const alertId = alertIdOf(req.body);
      const to = recipients(process.env.OPS_ALERT_EMAIL);
      const html = `<pre style="font:14px/1.4 Menlo,monospace;white-space:pre-wrap">${text.replace(/[<>&]/g, (c) => ({"<": "&lt;", ">": "&gt;", "&": "&amp;"}[c]))}</pre>`;
      const each = await Promise.all(to.map(async (addr, n) => {
        try {
          const r = await sendEmail({to: addr, subject: subjectFor(text), text, html, category: CATEGORIES.TRANSACTIONAL,
            template: "OpsAlert", tags: [{name: "kind", value: "ops-alert"}], idempotencyKey: `ops-${alertId}-${n}`});
          return (r && (r.sent || r.id)) ? "sent" : (r && r.reason) || "error";
        } catch (e) {
          logger.error("opsAlertRelay: email failed", {message: e && e.message});
          return "error";
        }
      }));
      const sent = each.filter((x) => x === "sent").length;
      out.email = sent === to.length ? "sent" : sent ? `sent ${sent} of ${to.length}` : each[0];
      out.alertId = alertId;
      try {
        let tg = "", chat = ""; try { tg = OPS_TELEGRAM_TOKEN.value(); chat = OPS_TELEGRAM_CHAT_ID.value(); } catch (_e) { /* optional */ }
        // Placeholder secret versions ("unset") exist so deploys don't fail; only real-looking values count.
        if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(tg) && /^-?\d+$/.test(chat)) out.telegram = (await telegram(tg, chat, text)) === 200 ? "sent" : "error";
      } catch (e) { out.telegram = "error"; }
      logger.info("opsAlertRelay delivered", out);
      // Not every mailbox got it: say so, and the caller tries once more. The
      // ones that did are protected by the idempotency key.
      res.status(sent === to.length || out.telegram === "sent" ? 200 : 502).json(out);
    },
);

module.exports._internal = {tokenOk, alertText, subjectFor, recipients, alertIdOf};
