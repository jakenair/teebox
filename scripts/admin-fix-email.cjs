#!/usr/bin/env node
// scripts/admin-fix-email.cjs
// Correct a user's email address. There is NO built-in admin UI for this —
// the email lives in Firebase Auth (and mirrored on the users doc), so this
// is the Admin-SDK path. Use for typo'd signups (e.g. kadevidovic@yahoo.con).
//
// Usage (from repo root):
//   NODE_PATH="$(pwd)/functions/node_modules" node scripts/admin-fix-email.cjs <uid|oldEmail> <newEmail> [--verify]
//     --verify  also mark the corrected address emailVerified (skip only if you
//               want them to verify the new address themselves).
//
// NOTE: this does NOT change the email on their Stripe Connect account — if
// they've onboarded, update that in the Stripe dashboard separately. Writes
// to prod Auth + Firestore; needs Application Default Credentials.

const admin = require("firebase-admin");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});

const [ , , who, newEmail ] = process.argv;
const doVerify = process.argv.includes("--verify");

if (!who || !newEmail) {
  console.error("usage: node scripts/admin-fix-email.cjs <uid|oldEmail> <newEmail> [--verify]");
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(newEmail)) {
  console.error(`refusing: '${newEmail}' does not look like a valid email.`);
  process.exit(1);
}

(async () => {
  // Resolve the user by uid or current email.
  let user;
  try {
    user = who.includes("@") ? await admin.auth().getUserByEmail(who) : await admin.auth().getUser(who);
  } catch (e) {
    console.error("user not found:", e.message);
    process.exit(1);
  }
  console.log(`BEFORE: uid=${user.uid} email=${user.email} verified=${user.emailVerified}`);

  // Guard: don't collide with an existing account on the new address.
  try {
    const clash = await admin.auth().getUserByEmail(newEmail);
    if (clash && clash.uid !== user.uid) {
      console.error(`refusing: ${newEmail} already belongs to uid ${clash.uid}.`);
      process.exit(1);
    }
  } catch (_e) { /* not found → good, address is free */ }

  await admin.auth().updateUser(user.uid, {email: newEmail, ...(doVerify ? {emailVerified: true} : {})});
  // Mirror onto the users doc (best-effort — some flows read it).
  try {
    await admin.firestore().collection("users").doc(user.uid).set({email: newEmail}, {merge: true});
  } catch (e) { console.warn("users-doc mirror failed (non-fatal):", e.message); }

  const after = await admin.auth().getUser(user.uid);
  console.log(`AFTER:  uid=${after.uid} email=${after.email} verified=${after.emailVerified}`);
  console.log("✓ email corrected" + (doVerify ? " + verified" : ""));
  if (user.email && user.email !== newEmail) console.log(`  (was: ${user.email})`);
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
