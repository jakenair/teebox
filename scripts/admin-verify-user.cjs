#!/usr/bin/env node
// scripts/admin-verify-user.cjs
// Manually mark one account's email verified (the wall is gone since
// 2026-09-13, but this stays handy for native-app users on old bundles or
// one-off support). Reversible: pass --unverify to flip it back.
//
// Usage (from repo root):
//   NODE_PATH="$(pwd)/functions/node_modules" node scripts/admin-verify-user.cjs <uid|email> [--unverify]

const admin = require("firebase-admin");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});

const who = process.argv[2];
const unverify = process.argv.includes("--unverify");
if (!who) { console.error("usage: node scripts/admin-verify-user.cjs <uid|email> [--unverify]"); process.exit(1); }

(async () => {
  let user;
  try { user = who.includes("@") ? await admin.auth().getUserByEmail(who) : await admin.auth().getUser(who); }
  catch (e) { console.error("user not found:", e.message); process.exit(1); }
  console.log(`BEFORE: ${user.email} verified=${user.emailVerified}`);
  await admin.auth().updateUser(user.uid, {emailVerified: !unverify});
  const after = await admin.auth().getUser(user.uid);
  console.log(`AFTER:  ${after.email} verified=${after.emailVerified}`);
  console.log(unverify ? "✓ unverified" : "✓ verified");
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
