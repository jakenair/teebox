/**
 * functions/budgetGuard.js — turns the Seller API off when TeeBox's Google
 * Cloud spend for the month reaches $100 (founder, 2026-11-23).
 *
 * Billing budget "TeeBox API guard $100" → Pub/Sub teebox-budget-guard → here.
 * Off = lib/apiSwitch (Cloud Run refuses outside requests; nothing else is
 * affected). Turn it back on with scripts/api-switch.cjs. State and history:
 * config/apiGuard. Billing data can lag by hours, so this limits a runaway
 * bill; it is not an exact stop at $100.
 */
"use strict";
const {onMessagePublished} = require("firebase-functions/v2/pubsub");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {decide} = require("./lib/budgetGuardCore");
const {setApiOpen} = require("./lib/apiSwitch");

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const LIMIT_USD = 100;

exports.budgetGuard = onMessagePublished(
    {topic: "teebox-budget-guard", region: "us-central1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 1, retry: true,
      secrets: [RESEND_API_KEY]},
    async (event) => {
      const m = event.data.message;
      let msg = {};
      try { msg = JSON.parse(Buffer.from(m.data || "", "base64").toString("utf8")); } catch (_e) { /* decide() refuses it */ }
      const ref = admin.firestore().doc("config/apiGuard");
      const snap = await ref.get();
      const last = (snap.exists && snap.data().last) || {};
      const d = decide(msg, {attrs: m.attributes || {}, budgetId: process.env.GUARD_BUDGET_ID || "", limit: LIMIT_USD, last});
      logger.info("budgetGuard", {fire: d.fire, why: d.why, cost: d.cost, month: d.month});
      if (!d.fire) return;
      const simulated = (m.attributes || {}).simulated === "true";
      let error = null;
      try {
        const {access_token: token} = await admin.app().options.credential.getAccessToken();
        await setApiOpen(false, {token});
      } catch (e) {
        error = String(e && e.message || e).slice(0, 300);
        logger.error("budgetGuard: COULD NOT turn the API off", {error});
      }
      const to = process.env.GUARD_EMAIL;
      if (to) {
        const {sendEmail} = require("./lib/email");
        const line = error ?
          `The Seller API could NOT be turned off automatically: ${error}. Turn it off by hand now.` :
          "The Seller API is off. The app, checkout, feeds and everything else are running normally.";
        await sendEmail({to, category: "transactional", template: "BudgetGuard",
          subject: `${simulated ? "[TEST] " : ""}Seller API ${error ? "could NOT be turned off" : "turned off"}: spend reached $${d.cost.toFixed(2)}`,
          html: `<p>Google Cloud spend for TeeBox this month is $${d.cost.toFixed(2)} (limit $${LIMIT_USD}).</p><p>${line}</p>` +
            "<p>Turn it back on: <code>node functions/scripts/api-switch.cjs on --apply</code>, or ask Claude to.</p>",
          idempotencyKey: `budget-guard-${m.messageId || Date.now()}${error ? "-err" : ""}`}).catch((e) =>
          logger.error("budgetGuard: email failed", {error: String(e && e.message || e)}));
      }
      if (error) throw new Error("budgetGuard: will retry"); // Pub/Sub redelivers
      await ref.set({open: false, last: {month: d.month, step: d.step, cost: d.cost, simulated,
        at: admin.firestore.FieldValue.serverTimestamp()},
      history: admin.firestore.FieldValue.arrayUnion({month: d.month, step: d.step, cost: d.cost, simulated, at: new Date().toISOString()})},
      {merge: true});
    });
