#!/usr/bin/env node
/* r422 live proof on a THROWAWAY account (never a real seller):
 *   1. creates one test listing in hidden/awaiting_payouts (never visible:
 *      hidden status + isTest flag), for the throwaway uid
 *   2. reminder 1 via the real module -> real FCM push to the throwaway's
 *      device (sign the throwaway in on a phone first so it has a token)
 *   3. resets the log and sends reminder 1 again with push forced off ->
 *      real Resend email to the throwaway's inbox
 *   4. cancel-on-onboard: runs the real onSellerChargesReady(uid), then asks
 *      for a reminder 8 days on -> must send nothing
 *   cleanup (always, also on failure): deletes the listing and the log,
 *   restores the user doc fields it touched.
 *
 *   cd functions && NODE_PATH=$PWD/node_modules \
 *     RESEND_API_KEY=... UNSUBSCRIBE_SECRET=... node ../scripts/payout-reminder-live-test.cjs <throwawayUid>
 * Secrets are loaded in-process by the caller (Secret Manager); never echoed.
 * REFUSES unless the uid is a test account (users.isTestAccount or QA email).
 */
"use strict";
const path = require("path");
const admin = require("firebase-admin");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});
const db = admin.firestore();
const FN = process.cwd();
const uid = process.argv[2];
if (!uid) { console.error("usage: <throwawayUid>"); process.exit(1); }

(async () => {
  const tl = require(path.join(FN, "lib/testAccounts.js"));
  if (!(await tl.isTestUid(uid, tl.adminCtx(new Map())))) {
    console.error("REFUSING: not a test account. Set users/{uid}.isTestAccount=true on the throwaway first.");
    process.exit(1);
  }
  const userRef = db.collection("users").doc(uid);
  const before = (await userRef.get()).data() || {};
  const listingRef = db.collection("listings").doc(`qa_r422_${Date.now()}`);
  const logRef = db.collection("payoutReminders").doc(uid);
  const cleanup = async () => {
    await listingRef.delete().catch(() => {});
    await logRef.delete().catch(() => {});
    await userRef.set({stripeChargesEnabled: before.stripeChargesEnabled === true}, {merge: true}).catch(() => {});
    console.log("cleanup: test listing + reminder log deleted, user flag restored");
  };
  process.on("SIGINT", async () => { await cleanup(); process.exit(130); });
  const results = [];
  try {
    await userRef.set({stripeChargesEnabled: false}, {merge: true});
    await logRef.delete().catch(() => {});
    await listingRef.set({sellerId: uid, title: "TeeBox QA Putter (test)", brand: "QA", cat: "clubs", ask: 99,
      condition: "Good", status: "hidden", hiddenReason: "awaiting_payouts", isTest: true, isTestListing: true,
      photos: [], createdAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: new Date(Date.now() + 864e5)});
    const PR = require(path.join(FN, "lib/payoutReminders.js"));

    const r1 = await PR.runReminderForSeller(uid, {trigger: "live-test"});
    console.log("push:", JSON.stringify(r1));
    results.push(["push reminder delivered to FCM", r1.sent && r1.channel === "push"]);

    await logRef.delete();
    const d = require(path.join(FN, "lib/payoutReminders.js"));
    const deps = {
      db, logger: console,
      sendPush: async () => ({sent: 0, skipped: "no-tokens"}), // force the email fallback
      sendEmail: require(path.join(FN, "lib/email.js")).sendEmail,
      loadTemplate: (n) => require(path.join(FN, "emails-build/transactional", n)),
      authEmail: async (u) => (await admin.auth().getUser(u)).email || null,
    };
    const r2 = await d.runReminderForSeller(uid, {trigger: "live-test-email", deps});
    console.log("email:", JSON.stringify(r2));
    results.push(["email reminder sent via Resend", r2.sent && r2.channel === "email"]);

    await require(path.join(FN, "lib/listFirstCore.js")).onSellerChargesReady(uid);
    const log = (await logRef.get()).data() || {};
    results.push(["onboarding cancels the reminder log", !!log.cancelledAtMs]);
    const r3 = await PR.runReminderForSeller(uid, {trigger: "live-test", nowMs: Date.now() + 8 * 864e5});
    results.push(["no reminder after onboarding (8 days on)", !r3.sent]);
    const l = (await listingRef.get()).data() || {};
    results.push(["test listing never became visible", l.status === "hidden"]);
  } catch (e) {
    console.error("FAILED:", e && e.message);
    results.push(["no exception", false]);
  } finally {
    await cleanup();
  }
  for (const [n, ok] of results) console.log((ok ? "PASS " : "FAIL ") + n);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})();
