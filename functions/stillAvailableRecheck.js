"use strict";
// One-shot pre-send recheck for the 2026-11-16 "still available" email
// (Jake 2026-11-15). Cloud Scheduler job still-available-recheck-2026-11-16
// calls this at 09:30 America/Chicago, 30 minutes before the 105 Resend emails
// scheduled for 10:00 go out.
//
// For every scheduled email in the server-only ledger
// (Firestore emailCampaigns/still_available_2026_11_16 — default-deny rules,
// uid + version + Resend id + listing ids, no addresses) it re-runs the
// marketing gate (lib/email.js preflightAllowed, category weeklyDigest) plus
// account existence/disabled and, for version (a), "is any listed item still
// active". Ineligible = the scheduled Resend email is cancelled.
//
// Then it emails Jake one line (kept / cancelled / errors), or a FAILED line,
// and deletes its own Scheduler job. Idempotent: a second call after a
// successful run does nothing but report. After the send time it refuses to
// act (cancelling then is pointless) and only cleans up the job.
//
// Private: deployed without public access; only the Scheduler job's OIDC
// identity (run.invoker) can call it.

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {GoogleAuth} = require("google-auth-library");
const {preflightAllowed} = require("./lib/email");

const RESEND_KEY = defineSecret("RESEND_API_KEY");
const CAMPAIGN = "still_available_2026_11_16";
const JOB = "projects/teebox-market/locations/us-central1/jobs/still-available-recheck-2026-11-16";
const REPORT_TO = "jakenair@teeboxmarket.com";
const FROM = "TeeBox Ops <hello@mail.teeboxmarket.com>";

const sleep = (n) => new Promise((r) => setTimeout(r, n));

async function deleteJob() {
  try {
    const client = await new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]}).getClient();
    await client.request({url: `https://cloudscheduler.googleapis.com/v1/${JOB}`, method: "DELETE"});
    return "deleted";
  } catch (e) {
    const code = e && e.response && e.response.status;
    if (code === 404) return "already-gone";
    logger.warn("stillAvailableRecheck: job delete failed", {err: e && e.message});
    return "delete-failed";
  }
}

async function mail(resend, subject, text) {
  const r = await resend.emails.send({from: FROM, to: [REPORT_TO], subject, text,
    tags: [{name: "category", value: "ops"}, {name: "template", value: "still_available_recheck"}]});
  if (r.error) throw new Error("report email failed: " + r.error.message);
}

/**
 * Pure: why a ledger entry must be cancelled, or "" to keep it.
 * @param {object} p {user (Auth record or null), gate ({allowed, reason}), entry, activeIds (Set)}
 * @return {string}
 */
function cancelReason({user, gate, entry, activeIds}) {
  if (!user) return "account-deleted";
  if (user.disabled) return "disabled";
  if (!user.email) return "no-email";
  if (gate && gate.allowed === false) return gate.reason || "not-allowed";
  if (entry.version === "viewed" && !(entry.items || []).some((id) => activeIds.has(id))) return "all-items-gone";
  return "";
}

async function run(resend, dryRun) {
  const db = admin.firestore();
  const ref = db.collection("emailCampaigns").doc(CAMPAIGN);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("ledger doc emailCampaigns/" + CAMPAIGN + " is missing");
  const L = snap.data();
  if (L.recheck && L.recheck.doneAt) return {already: true, summary: L.recheck.summary};
  const sendAt = Date.parse(L.scheduledAt || "");
  if (!Number.isFinite(sendAt)) throw new Error("ledger has no scheduledAt");
  if (Date.now() >= sendAt) return {tooLate: true};

  const entries = L.entries || {};
  const uids = Object.keys(entries).filter((u) => !entries[u].cancelled);
  const users = {};
  for (let i = 0; i < uids.length; i += 100) {
    const r = await admin.auth().getUsers(uids.slice(i, i + 100).map((uid) => ({uid})));
    r.users.forEach((u) => { users[u.uid] = u; });
  }
  const itemIds = [...new Set(uids.flatMap((u) => entries[u].version === "viewed" ? (entries[u].items || []) : []))];
  const activeIds = new Set();
  for (let i = 0; i < itemIds.length; i += 100) {
    const docs = await db.getAll(...itemIds.slice(i, i + 100).map((id) => db.collection("listings").doc(id)));
    docs.forEach((d) => { if (d.exists && d.data().status === "active") activeIds.add(d.id); });
  }

  const out = {checked: uids.length, kept: 0, cancelled: 0, cancelFailed: 0, reasons: {}};
  const updates = {};
  for (const uid of uids) {
    const e = entries[uid];
    const user = users[uid] || null;
    const gate = user && user.email ? await preflightAllowed({uid, to: user.email, category: "weeklyDigest"}) : null;
    const why = cancelReason({user, gate, entry: e, activeIds});
    if (!why) { out.kept++; continue; }
    if (dryRun) { out.cancelled++; out.reasons[why] = (out.reasons[why] || 0) + 1; continue; }
    const r = await resend.emails.cancel(e.id);
    if (r.error) {
      out.cancelFailed++;
      logger.warn("stillAvailableRecheck: cancel failed", {uid: uid.slice(0, 6), err: r.error.message});
    } else {
      out.cancelled++;
      out.reasons[why] = (out.reasons[why] || 0) + 1;
      updates[`entries.${uid}.cancelled`] = why;
    }
    await sleep(550); // Resend: 2 requests/second
  }
  const summary = `kept ${out.kept}, cancelled ${out.cancelled}` +
    (Object.keys(out.reasons).length ? ` (${Object.entries(out.reasons).map(([k, v]) => `${k} ${v}`).join(", ")})` : "") +
    (out.cancelFailed ? `, ${out.cancelFailed} cancel FAILED` : "") + ` of ${out.checked}`;
  if (dryRun) return {dryRun: true, summary};
  updates["recheck"] = {doneAt: admin.firestore.FieldValue.serverTimestamp(), summary, ...out};
  await ref.update(updates);
  return {summary, out};
}

exports.stillAvailableRecheck = onRequest(
    {region: "us-central1", memory: "256MiB", timeoutSeconds: 300, maxInstances: 1, secrets: [RESEND_KEY]},
    async (req, res) => {
      let resend = null;
      const dryRun = req.query && req.query.dryRun === "1";
      try {
        const {Resend} = require("resend");
        resend = new Resend(RESEND_KEY.value());
        // ?dryRun=1: report what WOULD be cancelled; no cancel, no write, no email, job kept.
        const r = await run(resend, dryRun);
        if (r.dryRun) {
          res.status(200).send("DRY RUN (nothing cancelled): " + r.summary);
          return;
        }
        if (r.already) {
          logger.info("stillAvailableRecheck: already ran", {summary: r.summary});
          const job = await deleteJob();
          res.status(200).send("already ran: " + r.summary + "; job " + job);
          return;
        }
        if (r.tooLate) {
          const job = await deleteJob();
          await mail(resend, "Still-available recheck SKIPPED (past send time)",
              `The recheck ran after the 10:00 send time, so nothing was cancelled. Scheduler job ${job}.`);
          res.status(200).send("too late; job " + job);
          return;
        }
        const job = await deleteJob();
        logger.info("stillAvailableRecheck: done", {...r.out, job});
        await mail(resend, `Still-available recheck: ${r.summary}`,
            `Still-available email recheck (send 10:00 CT): ${r.summary}. Scheduler job ${job}.`);
        res.status(200).send(r.summary);
      } catch (e) {
        logger.error("stillAvailableRecheck: FAILED", {err: e && e.message});
        try {
          if (resend && !dryRun) {
            await mail(resend, "Still-available recheck FAILED",
                `The 09:30 recheck failed: ${String(e && e.message).slice(0, 300)}. ` +
                "Nothing was cancelled after the failure point; the 10:00 emails are still scheduled. " +
                "Cancel all: node scripts/still-available-email.cjs --cancel --ledger <ledger>, or Resend dashboard -> Emails -> Scheduled.");
          }
        } catch (_e) { /* logged above */ }
        res.status(500).send("failed");
      }
    },
);

exports._stillAvailableRecheck = {cancelReason, CAMPAIGN, JOB};
