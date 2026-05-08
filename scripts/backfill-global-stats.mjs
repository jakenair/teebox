#!/usr/bin/env node
// One-shot backfill for `globalStats/all`.
//
// Why: homepage reads a denormalized `globalStats/all` doc instead of scanning
// orders. The `backfillGlobalStats` callable in functions/index.js does the
// same thing but requires a verified browser session — this is the CLI escape
// hatch using Application Default Credentials. Idempotent (merge: true).
// Mirror any schema changes in functions/index.js exports.backfillGlobalStats.
//
// Prereqs (one-time):
//   gcloud auth application-default login
//   gcloud config set project teebox-market
//
// Run:
//   npm run backfill:stats              # actually writes
//   npm run backfill:stats -- --dry-run # reads + prints, skips write
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// Reuse firebase-admin from functions/ — avoids a duplicate top-level install.
const admin = require('../functions/node_modules/firebase-admin');

const DRY_RUN = process.argv.includes('--dry-run');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

if (HELP) {
  console.log('Usage: node scripts/backfill-global-stats.mjs [--dry-run]');
  console.log('  Sums paid orders and writes globalStats/all. Run `gcloud auth application-default login` first.');
  process.exit(0);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'teebox-market',
  });
}
const db = admin.firestore();

async function main() {
  let totalGmvCents = 0;
  let totalSold = 0;
  let lastSaleMs = 0;
  let cursor = null;
  let batchNum = 0;
  const PAGE = 500;

  // Drop orderBy + cursor pagination — for a sum the order doesn't matter,
  // and skipping orderBy avoids requiring a (status ASC + createdAt ASC)
  // composite index. Caps at PAGE writes; if a future TeeBox has > 500 paid
  // orders we'll re-introduce a paginated query (and the index).
  while (batchNum < 1) {
    const q = db.collection('orders')
        .where('status', '==', 'paid')
        .limit(PAGE);
    const snap = await q.get();
    if (snap.empty) break;
    batchNum++;
    for (const d of snap.docs) {
      const data = d.data();
      const cents = Number(data.amountCents) ||
        Math.round(Number(data.amount || 0) * 100);
      if (Number.isFinite(cents) && cents > 0) {
        totalGmvCents += cents;
        totalSold += 1;
      }
      const ts = data.createdAt && data.createdAt.toMillis ?
        data.createdAt.toMillis() : 0;
      if (ts > lastSaleMs) lastSaleMs = ts;
    }
    const dollars = (totalGmvCents / 100).toFixed(2);
    console.log(`[batch ${batchNum}] cumulative: $${dollars} across ${totalSold} orders`);
    if (snap.size >= PAGE) {
      console.warn(`⚠ hit PAGE cap (${PAGE}) — re-add paginated orderBy query if you have more than ${PAGE} paid orders`);
    }
  }

  const payload = {
    totalGmvCents,
    totalSold,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    backfilledAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (lastSaleMs > 0) {
    payload.lastSaleAt = admin.firestore.Timestamp.fromMillis(lastSaleMs);
  }
  const lastIso = lastSaleMs ? new Date(lastSaleMs).toISOString() : '(none)';
  const dollars = (totalGmvCents / 100).toFixed(2);

  if (DRY_RUN) {
    console.log(`\n[dry-run] would write globalStats/all: $${dollars}, ${totalSold} orders, last ${lastIso}`);
    return;
  }
  await db.collection('globalStats').doc('all').set(payload, { merge: true });
  console.log(`\n✓ Backfilled globalStats/all — $${dollars} across ${totalSold} orders, last sale ${lastIso}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Fatal:', e && e.message ? e.message : e);
    console.error('Hint: did you run `gcloud auth application-default login` and `gcloud config set project teebox-market`?');
    process.exit(1);
  });
