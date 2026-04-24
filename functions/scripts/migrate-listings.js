#!/usr/bin/env node
// One-shot migration for the 2026-04-24 security hardening.
//   - Backfills `status: 'active'` on every listing that lacks the field.
//   - Strips the `sellerPhone` field (was world-readable; now lives on the
//     private user doc only).
//
// Usage (requires Application Default Credentials — either
// `gcloud auth application-default login` or a service-account JSON via
// GOOGLE_APPLICATION_CREDENTIALS):
//
//   cd functions
//   node scripts/migrate-listings.js             # dry run, prints what would change
//   node scripts/migrate-listings.js --apply     # actually writes
//
// Safe to run multiple times — idempotent.

const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const PROJECT_ID = process.env.GCLOUD_PROJECT || "teebox-market";

admin.initializeApp({projectId: PROJECT_ID});

const db = admin.firestore();

async function main() {
  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} — migrating listings in project ${PROJECT_ID}`
  );

  const snap = await db.collection("listings").get();
  console.log(`Found ${snap.size} listing(s)\n`);

  let touched = 0;
  const batchSize = 400;
  let batch = db.batch();
  let pending = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const update = {};

    if (data.status === undefined) {
      update.status = "active";
    }
    if (data.sellerPhone !== undefined) {
      update.sellerPhone = admin.firestore.FieldValue.delete();
    }

    if (Object.keys(update).length === 0) continue;

    touched += 1;
    console.log(
      `  ${doc.id.padEnd(24)}  ${Object.keys(update).join(", ")}`
    );

    if (APPLY) {
      batch.update(doc.ref, update);
      pending += 1;
      if (pending >= batchSize) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
  }

  if (APPLY && pending > 0) {
    await batch.commit();
  }

  console.log(`\n${touched} listing(s) ${APPLY ? "updated" : "would be updated"}`);
  if (!APPLY && touched > 0) {
    console.log("Re-run with --apply to write changes.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
