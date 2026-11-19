#!/usr/bin/env node
/* r422 one-time migration: live listings whose seller is NOT payment-ready
 * become "Almost live" (status hidden, hiddenReason awaiting_payouts), so they
 * leave browse/search/feeds and publish automatically once Stripe enables
 * charges. RUN ONLY AFTER JAKE CONFIRMS HIS PERSONAL SELLER EMAILS WENT OUT.
 *
 *   node scripts/migrate-awaiting-payouts.cjs                 # dry run (read-only): prints the list
 *   node scripts/migrate-awaiting-payouts.cjs --apply --expect=5
 *        flips exactly the listed docs (refuses if the count != --expect),
 *        seeds each seller's reminder log so NO reminder goes out today
 *        (founder emails went out today); the next one is 24h later.
 *        Writes a ledger for rollback.
 *   --exclude=<listingId,...> leaves specific listings live (e.g. a seller
 *        who didn't get a founder email yet).
 *   node scripts/migrate-awaiting-payouts.cjs --rollback=<ledger.json>
 *        puts those listings back to active (only ones still awaiting) and
 *        deletes the reminder logs the migration created.
 *
 * Run from functions/ with NODE_PATH=$PWD/node_modules (ADC credentials).
 * Prints titles + first names only; no emails.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});
const db = admin.firestore();
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}`)); return a ? (a.split("=")[1] || true) : null; };
const LEDGER_DIR = path.join(__dirname, "..", ".internal-docs");
// Founder rules: never touch this seller/listing in any bulk operation.
const NEVER_SELLERS = new Set(["X45aLaMOybZic0a7XzHHosWNpQF3"]);
const NEVER_LISTINGS = new Set(["NaTCuADyHd25Vw6t7WeI"]);

async function candidates() {
  const tl = require(path.join(process.cwd(), "lib/testAccounts.js"));
  const ctx = tl.adminCtx(new Map());
  const snap = await db.collection("listings").where("status", "==", "active").get();
  const bySeller = new Map();
  snap.docs.forEach((d) => { const s = d.data().sellerId; if (s) (bySeller.get(s) || bySeller.set(s, []).get(s)).push(d); });
  const ids = [...bySeller.keys()];
  const users = ids.length ? await db.getAll(...ids.map((u) => db.collection("users").doc(u))) : [];
  const out = [];
  for (const us of users) {
    if (us.exists && us.data().stripeChargesEnabled === true) continue;
    if (NEVER_SELLERS.has(us.id)) continue;
    if (await tl.isTestUid(us.id, ctx)) continue;
    const name = String((us.exists && (us.data().displayName || us.data().firstName)) || "?").split(" ")[0];
    for (const d of bySeller.get(us.id)) {
      if (NEVER_LISTINGS.has(d.id)) continue;
      if (tl.isTestListingDoc(d.data(), d.id)) continue;
      out.push({listingId: d.id, sellerId: us.id, seller: name, title: String(d.data().title || "").slice(0, 60),
        hasStripeAccount: !!(us.exists && us.data().stripeAccountId)});
    }
  }
  return out;
}

(async () => {
  const rb = arg("rollback");
  if (rb) {
    const led = JSON.parse(fs.readFileSync(rb, "utf8"));
    let n = 0;
    for (const r of led.rows) {
      const ref = db.collection("listings").doc(r.listingId);
      const ok = await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists || s.data().status !== "hidden" || s.data().hiddenReason !== "awaiting_payouts") return false;
        tx.update(ref, {status: "active", hiddenReason: admin.firestore.FieldValue.delete(),
          awaitingSince: admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
        return true;
      });
      if (ok) n++;
    }
    for (const uid of new Set(led.rows.map((r) => r.sellerId))) {
      const ref = db.collection("payoutReminders").doc(uid);
      const s = await ref.get();
      if (s.exists && s.data().migratedR422 === true && !Object.keys(s.data().sent || {}).length) await ref.delete();
    }
    console.log(`rollback: ${n}/${led.rows.length} listings back to active`);
    process.exit(0);
  }

  const excl = new Set(String(arg("exclude") || "").split(",").filter(Boolean));
  const rows = (await candidates()).filter((r) => !excl.has(r.listingId));
  if (excl.size) console.log(`excluding ${excl.size} listing(s): ${[...excl].join(", ")}`);
  console.table(rows.map((r) => ({listing: r.listingId, seller: r.seller, title: r.title, stripeAccount: r.hasStripeAccount ? "yes, payments off" : "none"})));
  console.log(`${rows.length} live listing(s) from ${new Set(rows.map((r) => r.sellerId)).size} seller(s) who aren't payment-ready.`);
  if (!arg("apply")) { console.log("DRY RUN: nothing changed. Re-run with --apply --expect=" + rows.length + " after the founder emails go out."); process.exit(0); }
  const expect = Number(arg("expect"));
  if (!Number.isFinite(expect) || expect !== rows.length) {
    console.error(`REFUSING: --expect=${arg("expect")} but found ${rows.length}. Re-check the list.`);
    process.exit(1);
  }
  const now = Date.now();
  const ledger = {at: new Date(now).toISOString(), rows: []};
  for (const r of rows) {
    const ref = db.collection("listings").doc(r.listingId);
    const ok = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== "active") return false;
      tx.update(ref, {status: "hidden", hiddenReason: "awaiting_payouts",
        awaitingSince: admin.firestore.Timestamp.fromMillis(now), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      return true;
    });
    if (ok) ledger.rows.push(r);
  }
  for (const uid of new Set(ledger.rows.map((r) => r.sellerId))) {
    // No reminder today (the founder's personal email went out today); the
    // 24h reminder is the first one they get.
    await db.collection("payoutReminders").doc(uid).set({
      anchorMs: now, createdAtMs: now, migratedR422: true,
      skipped: {1: {atMs: now, reason: "founder-email-day"}},
    }, {merge: true});
  }
  const f = path.join(LEDGER_DIR, `r422-migration-ledger-${new Date(now).toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(f, JSON.stringify(ledger, null, 2));
  console.log(`applied: ${ledger.rows.length}/${rows.length}. Ledger (for --rollback): ${f}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
