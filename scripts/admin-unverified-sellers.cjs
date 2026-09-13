#!/usr/bin/env node
// scripts/admin-unverified-sellers.cjs
// ON-DEMAND admin report: who is unverified, and has anyone gotten stuck
// mid-sell? Since 2026-09-13 email verification no longer walls selling
// (Stripe KYC is the gate), so this is now a health check — mainly for
// native-app users on OLD bundles that still carry the client-side email
// wall until the next iOS build.
//
// Usage (from repo root):
//   NODE_PATH="$(pwd)/functions/node_modules" node scripts/admin-unverified-sellers.cjs
//   ...add `--days 7` to limit to signups in the last N days.
//
// Read-only. Needs Application Default Credentials (gcloud auth application-default login).

const admin = require("firebase-admin");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});
const db = admin.firestore();

const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) : null;
const isTest = (e) => /teeboxtest|teeboxmarket\.invalid|teeboxtest\.invalid|modtest-|smoke-test/i.test(e || "");
const badEmail = (e) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e || "") || /\.(con|cmo|vom|xom|ocm|comm|om)$/i.test(e || "");

(async () => {
  let users = [], token;
  do { const r = await admin.auth().listUsers(1000, token); users = users.concat(r.users); token = r.pageToken; } while (token);

  const cutoff = DAYS ? Date.now() - DAYS * 864e5 : 0;
  const unverified = users.filter((u) =>
    (u.providerData.some((p) => p.providerId === "password") || u.providerData.length === 0) &&
    !u.emailVerified && !isTest(u.email) &&
    (!cutoff || new Date(u.metadata.creationTime).getTime() >= cutoff));

  // Cross-reference: did they get far enough to start selling?
  const rows = [];
  for (const u of unverified) {
    let hasListing = false, hasStripe = false;
    try { const ls = await db.collection("listings").where("sellerId", "==", u.uid).limit(1).get(); hasListing = !ls.empty; } catch (_e) {}
    try { const d = await db.collection("users").doc(u.uid).get(); hasStripe = !!(d.exists && d.data().stripeAccountId); } catch (_e) {}
    rows.push({email: u.email, name: u.displayName || "(no name)", uid: u.uid,
      created: u.metadata.creationTime, hasListing, hasStripe, badEmail: badEmail(u.email)});
  }
  rows.sort((a, b) => new Date(b.created) - new Date(a.created));

  const tried = rows.filter((r) => r.hasListing || r.hasStripe);
  const malformed = rows.filter((r) => r.badEmail);
  console.log(`\n=== UNVERIFIED password accounts${DAYS ? ` (last ${DAYS}d)` : ""}: ${rows.length} ===`);
  console.log(`  tried to sell (listing/stripe started): ${tried.length}`);
  console.log(`  malformed email (won't receive mail): ${malformed.length}`);
  if (tried.length) {
    console.log(`\n  -- STUCK MID-SELL (approve/onboard these) --`);
    tried.forEach((r) => console.log(`    ${r.email} | ${r.name} | listing=${r.hasListing} stripe=${r.hasStripe} | ${r.uid}`));
  }
  console.log(`\n  -- all unverified (newest first) --`);
  rows.forEach((r) => console.log(`    ${r.created} | ${r.email}${r.badEmail ? " ⚠typo" : ""} | ${r.name} | ${r.uid}`));
  console.log(`\n  To verify one:  node scripts/admin-verify-user.cjs <uid|email>`);
  console.log(`  To fix an email: node scripts/admin-fix-email.cjs <uid|email> <newEmail>`);
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
