#!/usr/bin/env node
// scripts/migrate-marketing-consent.mjs
// ───────────────────────────────────────────────────────────────────────
// One-time migration to populate users/{uid}.marketingConsent for the
// pre-GDPR-rollout cohort. See GDPR_CONSENT_SCHEMA.md for the schema.
//
// DEFAULT BEHAVIOR: dry-run. Reads every users/{uid} doc, classifies the
// user, prints a report, writes /tmp/marketing-consent-migration-report.json.
// Does NOT touch Firestore.
//
// To actually run the migration:   node scripts/migrate-marketing-consent.mjs --apply
//
// Auth: uses firebase-admin's default credentials. Set
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
// (Firebase Console → Project Settings → Service Accounts → Generate key).
//
// Migration policy (conservative — favor compliance over engagement):
//
//   For each user:
//     - If marketingConsent already exists → skip (already migrated).
//     - Else write:
//         marketingConsent: {
//           granted: false,
//           grantedAt: null,
//           revokedAt: now,
//           source: 'migration_default_off',
//           version: 1,
//           history: [{ granted: false, at: now, source: 'migration_default_off' }]
//         }
//   The re-opt-in banner then asks each user to opt back in. This is
//   conservative — we lose some engagement short-term but stay GDPR-compliant.

import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { argv } from 'process';

const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');

const APPLY = argv.includes('--apply');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'teebox-market';

if (!admin.apps.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
}
const db = admin.firestore();

// Mirror MARKETING_PREF_KEYS from functions/gdprConsent.js. Kept in sync
// manually; a mismatch only affects the classification accuracy of the
// dry-run report, not the migration write itself.
const MARKETING_PREF_KEYS = [
  'savedSearchMatches',
  'priceDrops',
  'abandonedDraft',
  'abandonedCart',
  'reviewRequests',
  'winBack',
  'weeklyDigest',
  'productUpdates',
];

const REPORT_PATH = '/tmp/marketing-consent-migration-report.json';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function bucketBySignupYear(ts) {
  if (!ts || typeof ts.toMillis !== 'function') return 'unknown';
  const y = new Date(ts.toMillis()).getUTCFullYear();
  if (y < 2026) return 'pre-2026';
  if (y === 2026) return '2026';
  return String(y);
}

async function countMarketingSendsLast30d(uid) {
  // Best-effort — emailSends/ might be large. We scope by uid + sentAt to
  // hit the existing (uid, sentAt) index. Skip if the query fails so the
  // migration still produces a report.
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - THIRTY_DAYS_MS);
    const snap = await db.collection('emailSends')
        .where('uid', '==', uid)
        .where('sentAt', '>=', cutoff)
        .get();
    let n = 0;
    for (const d of snap.docs) {
      const data = d.data();
      // Only count successful marketing sends. Skipped sends and
      // transactional don't move the "affected cohort" needle.
      if (data.status !== 'sent') continue;
      if (data.category === 'transactional') continue;
      n++;
    }
    return n;
  } catch (_e) {
    return -1; // sentinel: query failed
  }
}

async function main() {
  console.log(`[migrate-marketing-consent] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[migrate-marketing-consent] project = ${PROJECT_ID}`);
  if (APPLY) {
    console.log('[migrate-marketing-consent] ⚠️  WILL WRITE TO FIRESTORE');
  }

  const snap = await db.collection('users').get();
  console.log(`[migrate-marketing-consent] read ${snap.size} user docs`);

  const report = {
    runAt: new Date().toISOString(),
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    project: PROJECT_ID,
    totals: {
      users: 0,
      alreadyHasConsent: 0,
      missingConsent_wouldOptOut: 0,
      missingConsent_implicitlyOptedIn: 0,
      missingConsent_alreadyOptedOutPerPrefs: 0,
      deleted: 0,
      admin: 0,
      test: 0,
    },
    bySignupYear: { 'pre-2026': 0, '2026': 0, 'unknown': 0 },
    byRecentSends: { got1Plus: 0, gotZero: 0, queryFailed: 0 },
    writes: { attempted: 0, succeeded: 0, failed: 0 },
    samples: { affectedCohort: [], alreadyOpted: [] },
  };

  // Process sequentially to avoid hammering the emailSends index. For
  // very large user bases (>50k), parallelize with a worker pool.
  for (const docSnap of snap.docs) {
    const uid = docSnap.id;
    const data = docSnap.data() || {};
    report.totals.users++;

    // Skip soft-deleted accounts. The field name is `deleted` per
    // the EMAIL_CONTENT_AUDIT — but we also accept `deletedAt` if a
    // separate cleanup job uses that.
    if (data.deleted === true || data.deletedAt) {
      report.totals.deleted++;
      continue;
    }

    // Tag admin / test accounts so they're visible in the report but
    // STILL get migrated (admins shouldn't get marketing email either).
    if (data.role === 'admin' || data.isAdmin === true) report.totals.admin++;
    if (data.isTestAccount === true || (data.email || '').endsWith('@example.com')) {
      report.totals.test++;
    }

    if (data.marketingConsent && typeof data.marketingConsent === 'object') {
      report.totals.alreadyHasConsent++;
      if (report.samples.alreadyOpted.length < 5) {
        report.samples.alreadyOpted.push({ uid, granted: !!data.marketingConsent.granted });
      }
      continue;
    }

    // Classify based on existing emailPrefs.
    const prefs = data.emailPrefs || {};
    const anyMarketingNotFalse = MARKETING_PREF_KEYS.some((k) => prefs[k] !== false);
    if (anyMarketingNotFalse) {
      report.totals.missingConsent_implicitlyOptedIn++;
    } else {
      report.totals.missingConsent_alreadyOptedOutPerPrefs++;
    }
    // Always count as "would be defaulted off" — the migration policy
    // is conservative: every user without explicit consent goes to
    // granted=false until they re-opt-in via the banner.
    report.totals.missingConsent_wouldOptOut++;

    // Signup-year bucketing.
    const yearBucket = bucketBySignupYear(
        data.createdAt || data.signupAt || data.termsAgreedAt || null,
    );
    report.bySignupYear[yearBucket] = (report.bySignupYear[yearBucket] || 0) + 1;

    // Recent-sends bucketing (skip lookup in apply mode — too slow).
    if (!APPLY) {
      const n = await countMarketingSendsLast30d(uid);
      if (n === -1) report.byRecentSends.queryFailed++;
      else if (n >= 1) report.byRecentSends.got1Plus++;
      else report.byRecentSends.gotZero++;

      if (n >= 1 && report.samples.affectedCohort.length < 5) {
        report.samples.affectedCohort.push({ uid, recentMarketingSends: n });
      }
    }

    if (APPLY) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const update = {
        marketingConsent: {
          granted: false,
          grantedAt: null,
          revokedAt: now,
          source: 'migration_default_off',
          version: 1,
          history: [
            {
              granted: false,
              at: admin.firestore.Timestamp.now(),
              source: 'migration_default_off',
              ip: null,
              userAgent: null,
            },
          ],
        },
      };
      report.writes.attempted++;
      try {
        await db.collection('users').doc(uid).set(update, { merge: true });
        report.writes.succeeded++;
      } catch (e) {
        report.writes.failed++;
        console.warn(`[migrate-marketing-consent] write failed for ${uid}:`, e.message);
      }
    }
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log('MARKETING CONSENT MIGRATION — REPORT');
  console.log('──────────────────────────────────────────────────');
  console.log(`Mode:                       ${report.mode}`);
  console.log(`Total users scanned:        ${report.totals.users}`);
  console.log(`  Soft-deleted (skipped):   ${report.totals.deleted}`);
  console.log(`  Admin tagged:             ${report.totals.admin}`);
  console.log(`  Test-account tagged:      ${report.totals.test}`);
  console.log(`Already has marketingConsent (skip):`);
  console.log(`                            ${report.totals.alreadyHasConsent}`);
  console.log(`Missing marketingConsent:`);
  console.log(`  Implicitly opted in (will be migrated to opt-out):`);
  console.log(`                            ${report.totals.missingConsent_implicitlyOptedIn}`);
  console.log(`  Already opted out via emailPrefs:`);
  console.log(`                            ${report.totals.missingConsent_alreadyOptedOutPerPrefs}`);
  console.log(`  TOTAL to migrate:         ${report.totals.missingConsent_wouldOptOut}`);
  console.log('\nBy signup year:');
  for (const [y, n] of Object.entries(report.bySignupYear)) {
    console.log(`  ${y.padEnd(10)} ${n}`);
  }
  if (!APPLY) {
    console.log('\nBy marketing-email send activity (last 30d):');
    console.log(`  Got 1+ marketing emails (affected cohort): ${report.byRecentSends.got1Plus}`);
    console.log(`  Got zero marketing emails:                 ${report.byRecentSends.gotZero}`);
    if (report.byRecentSends.queryFailed > 0) {
      console.log(`  Query failed (index missing?):             ${report.byRecentSends.queryFailed}`);
    }
  }
  if (APPLY) {
    console.log('\nWrites:');
    console.log(`  Attempted: ${report.writes.attempted}`);
    console.log(`  Succeeded: ${report.writes.succeeded}`);
    console.log(`  Failed:    ${report.writes.failed}`);
  } else {
    console.log('\n(No writes — dry-run. Pass --apply to migrate.)');
  }

  try {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nFull report → ${REPORT_PATH}`);
  } catch (e) {
    console.warn('Failed to write report:', e.message);
  }
  console.log('──────────────────────────────────────────────────\n');
}

main().catch((e) => {
  console.error('[migrate-marketing-consent] FATAL', e);
  process.exit(1);
});
