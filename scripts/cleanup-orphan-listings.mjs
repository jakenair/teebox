#!/usr/bin/env node
// Cleanup utility for orphan listings.
//
// Background: when a listing is created in Firestore but the photo upload
// step fails (e.g. Storage 403, network blip, App Check rejection), the app
// previously left the listing doc behind with `photos: []`. Buyers see a
// broken card. The submitListing flow now rolls back automatically, but
// this script cleans up the historical orphans.
//
// Usage:
//   node scripts/cleanup-orphan-listings.mjs                  # dry-run
//   CONFIRM=yes node scripts/cleanup-orphan-listings.mjs      # actually delete
//
// Auth: uses firebase-admin's default credentials. Easiest is to point at the
// service-account key from the Firebase Console (Project Settings → Service
// Accounts → Generate new private key) via:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/cleanup-orphan-listings.mjs
//
// Criteria for "orphan":
//   - photos field is missing OR an empty array
//   - createdAt is more than 5 minutes ago (gives in-progress uploads a
//     buffer so we don't race with a user who's mid-submit right now)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// firebase-admin lives in functions/node_modules — reuse it instead of
// installing a second copy at the repo root.
const admin = require('../functions/node_modules/firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'teebox-market',
  });
}

const db = admin.firestore();
const FIVE_MIN_MS = 5 * 60 * 1000;

async function main() {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - FIVE_MIN_MS);

  // We can't use a single compound query (Firestore can't combine an array
  // equality with an inequality across different fields without a composite
  // index, and `photos` may also be missing entirely). Filter client-side.
  const snap = await db.collection('listings').get();

  const orphans = [];
  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    const photos = d.photos;
    const isEmpty = !Array.isArray(photos) || photos.length === 0;
    if (!isEmpty) continue;

    const createdAt = d.createdAt;
    // Skip docs where createdAt isn't a Firestore Timestamp yet (server
    // hasn't assigned the sentinel) — that means it's actively being written.
    if (!createdAt || typeof createdAt.toMillis !== 'function') continue;
    if (createdAt.toMillis() > cutoff.toMillis()) continue;

    orphans.push({
      id: docSnap.id,
      sellerId: d.sellerId || '(unknown)',
      title: d.title || '(untitled)',
      createdAt: createdAt.toDate().toISOString(),
      status: d.status || '(unknown)',
    });
  }

  if (!orphans.length) {
    console.log('No orphan listings found.');
    return;
  }

  console.log(`Found ${orphans.length} orphan listing(s):`);
  for (const o of orphans) {
    console.log(`  ${o.id}  seller=${o.sellerId}  title="${o.title}"  created=${o.createdAt}  status=${o.status}`);
  }

  if (process.env.CONFIRM !== 'yes') {
    console.log('');
    console.log(`About to delete ${orphans.length} listings. Set CONFIRM=yes env var to proceed.`);
    return;
  }

  console.log('');
  console.log('CONFIRM=yes — deleting…');
  let deleted = 0;
  let failed = 0;
  // Delete sequentially so we can see per-doc errors clearly. A few hundred
  // is fine; if you ever have thousands, switch to a batched writer.
  for (const o of orphans) {
    try {
      await db.collection('listings').doc(o.id).delete();
      deleted++;
      console.log(`  deleted ${o.id}`);
    } catch (e) {
      failed++;
      console.warn(`  FAILED ${o.id}: ${e.message}`);
    }
  }
  console.log('');
  console.log(`Done. Deleted ${deleted}, failed ${failed}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
