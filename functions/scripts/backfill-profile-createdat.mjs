// One-shot backfill (2026-07-30, Jake-approved): stamp profiles/{uid}.createdAt
// from the Firebase Auth record's metadata.creationTime for every existing
// account. No signup path ever wrote this field (client whitelists exclude
// it), so "member since" / tenure-tier surfaces silently no-op'd. Admin SDK
// bypasses rules; the field stays out of client hasOnly() whitelists so it
// remains forge-proof. Idempotent: skips profiles that already have createdAt.
// Run:  cd functions && GOOGLE_CLOUD_PROJECT=teebox-market node scripts/backfill-profile-createdat.mjs
import admin from "firebase-admin";

admin.initializeApp({projectId: "teebox-market"});
const db = admin.firestore();

let stamped = 0, skipped = 0, missingAuthTime = 0;
let pageToken = undefined;
do {
  const page = await admin.auth().listUsers(1000, pageToken);
  for (const u of page.users) {
    const created = u.metadata && u.metadata.creationTime;
    if (!created) { missingAuthTime++; continue; }
    const ref = db.collection("profiles").doc(u.uid);
    const snap = await ref.get();
    if (snap.exists && snap.data().createdAt) { skipped++; continue; }
    await ref.set(
        {createdAt: admin.firestore.Timestamp.fromDate(new Date(created))},
        {merge: true});
    stamped++;
  }
  pageToken = page.pageToken;
} while (pageToken);

console.log(`done: stamped=${stamped} skipped(already had)=${skipped} noAuthTime=${missingAuthTime}`);
process.exit(0);
