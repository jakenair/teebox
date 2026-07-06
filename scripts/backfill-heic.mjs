#!/usr/bin/env node
// scripts/backfill-heic.mjs
// ───────────────────────────────────────────────────────────────────────────
// Backfill for the HEIC image bug (Defect 1). Historical listings whose photos
// were uploaded as Apple HEVC-HEIC were stored as unrenderable image/heic AND
// flagged image_scan_error by the fail-closed moderator. This script finds
// them, converts the raw HEIC objects to WebP using the EXACT same
// convertToWebp() the live optimizeListingPhoto trigger now uses (imported from
// functions/lib/imageConvert.js — one implementation, no drift), then clears
// the flag.
//
// DEFAULT BEHAVIOR: DRY-RUN. Enumerates + classifies + reports. Writes NOTHING
// to Firestore or Storage. Run with --apply to perform writes.
//
//   node scripts/backfill-heic.mjs             # dry-run (report only)
//   node scripts/backfill-heic.mjs --apply     # perform the backfill
//   node scripts/backfill-heic.mjs --limit=50  # cap listings scanned (either mode)
//   node scripts/backfill-heic.mjs --only=<id> # one listing only; SKIPS the
//                                              # global reconciliation pass
//
// Also runs a RECONCILIATION pass (skipped under --only): deletes any
// flaggedListings/{id} whose parent listing is gone OR already status:'active'
// (stale moderation-queue noise). Dry-run reports; --apply deletes.
//
// Auth: firebase-admin default credentials (ADC). Either
//   gcloud auth application-default login
// or  GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
//
// CLASSIFICATION (only listings whose ONLY moderationFlags.reason is
// 'image_scan_error' are eligible; anything else is left untouched):
//   (a) convertible  — Storage object(s) present AND true bytes are HEIC
//                      (sniffed via the ISO-BMFF 'ftyp' brand — we do NOT trust
//                      the .jpg name or the contentType, both of which lie).
//                      → real run: convert HEIC objects → webp, clear the
//                        image_scan_error flag, set status:'active', delete
//                        flaggedListings/{id}.
//   (b) dangling     — flagged image_scan_error but the Storage prefix is EMPTY
//                      (the objects are gone, e.g. the "Bulova" listing).
//                      → real run: set needsReupload marker + REPORT. NEVER
//                        flip to active — there is no renderable image.
//   (c) skip         — flagged for a reason OTHER than image_scan_error (e.g.
//                      NSFW). Left completely alone.
//   (d) present-not-heic — flagged image_scan_error but the object(s) are
//                      already renderable (jpeg/webp/avif), not HEIC. These were
//                      swept up by the Vision outage, NOT the HEIC bug, so this
//                      HEIC backfill does NOT touch them; they clear when Vision
//                      is re-enabled (Step 5). Reported for visibility only.
//
// NOTE: backfilled images are NOT SafeSearch-scanned here — Vision is still off
// at this step (Step 5 enables it). That is expected and no worse than before:
// these images were never successfully moderated in the first place (the scan
// failed closed), so converting + un-flagging them does not skip a check that
// previously ran. A post-Vision re-scan sweep can cover them later if desired.
//
// Idempotent + re-runnable. Every write logs before/after and is appended to a
// JSON audit file so a bad run is auditable/reversible.

import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { argv } from 'process';

const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
// The SAME convert used by the deployed trigger — no second implementation.
const { convertToWebp } = require('../functions/lib/imageConvert.js');

const APPLY = argv.includes('--apply');
const LIMIT = (() => {
  const a = argv.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
// --only=<listingId> restricts classification + apply to a single listing and
// SKIPS the global reconciliation pass. Used for the synthetic --apply test so
// it can never touch real listings or the real flaggedListings queue.
const ONLY = (() => {
  const a = argv.find((x) => x.startsWith('--only='));
  return a ? a.split('=')[1] : null;
})();
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'teebox-market';
const BUCKET = 'teebox-market.firebasestorage.app';
const REPORT_PATH = `/tmp/backfill-heic-report.${APPLY ? 'apply' : 'dryrun'}.json`;
const ELIGIBLE_REASON = 'image_scan_error';
const VARIANT_RE = /_w(?:400|800)\.webp$/i;

if (!admin.apps.length) {
  admin.initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET });
}
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);
const { FieldValue } = admin.firestore;

// Sniff the leading bytes for the real format. iPhone HEIC = ISO-BMFF with an
// 'ftyp' box whose brand is a HEVC/HEIF brand. AVIF shares the 'mif1' brand, so
// check for the 'avif' brand FIRST to disambiguate (sharp CAN decode AVIF).
const HEIC_BRANDS = new Set(
    ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevm', 'hevs', 'heif', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
function sniffFormat(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brands = [buf.toString('ascii', 8, 12)];
    for (let o = 16; o + 4 <= buf.length; o += 4) brands.push(buf.toString('ascii', o, o + 4));
    if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
    if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
    return 'isobmff-other';
  }
  return 'other';
}

// Base (non-variant, non-directory) photo objects under a listing's prefix.
async function listBaseObjects(sellerId, listingId) {
  const prefix = `listings/${sellerId}/${listingId}/`;
  const [files] = await bucket.getFiles({ prefix });
  return files.filter((f) => !VARIANT_RE.test(f.name) && !f.name.endsWith('/'));
}

async function sniffObject(file) {
  try {
    const [buf] = await file.download({ start: 0, end: 63 });
    return sniffFormat(buf);
  } catch (e) {
    return `error:${e.code || e.message}`;
  }
}

const audit = [];
const groups = { convertible: [], dangling: [], skip: [], present_not_heic: [] };

async function classify(docSnap) {
  const d = docSnap.data() || {};
  const listingId = docSnap.id;
  const sellerId = d.sellerId || (d.moderationFlags && String(d.moderationFlags.offendingPath || '').split('/')[1]);
  const reason = d.moderationFlags && d.moderationFlags.reason;
  const base = { listingId, sellerId, title: d.title || '(untitled)', reason: reason || '(none)' };

  // Only image_scan_error is eligible; everything else is untouchable skip (c).
  if (reason !== ELIGIBLE_REASON) {
    groups.skip.push(base);
    return;
  }
  if (!sellerId) {
    groups.skip.push({ ...base, note: 'no sellerId — cannot resolve Storage prefix' });
    return;
  }

  const objects = await listBaseObjects(sellerId, listingId);
  if (objects.length === 0) {
    groups.dangling.push({ ...base, objects: 0 });
    return;
  }

  const sniffed = [];
  for (const f of objects) sniffed.push({ name: f.name, fmt: await sniffObject(f) });
  const heic = sniffed.filter((s) => s.fmt === 'heic');
  const photosLen = Array.isArray(d.photos) ? d.photos.length : null;
  const partialMissing = photosLen != null && objects.length < photosLen;

  if (heic.length > 0) {
    groups.convertible.push({
      ...base, objects: objects.length, heicCount: heic.length,
      heicPaths: heic.map((s) => s.name), partialMissing,
    });
  } else {
    groups.present_not_heic.push({
      ...base, objects: objects.length,
      formats: [...new Set(sniffed.map((s) => s.fmt))], partialMissing,
    });
  }
}

// ── Real-run writers (only invoked with --apply) ────────────────────────────
async function applyConvertible(rec) {
  const listingRef = db.collection('listings').doc(rec.listingId);
  const snap = await listingRef.get();
  const before = snap.data() || {};
  // Idempotency: if it's no longer flagged for the scan error, it's already done.
  if (!before.moderationFlags || before.moderationFlags.reason !== ELIGIBLE_REASON) {
    return { listingId: rec.listingId, group: 'convertible', action: 'skip-already-done' };
  }
  const objects = await listBaseObjects(rec.sellerId, rec.listingId);
  const converted = [];
  for (const file of objects) {
    const [meta] = await file.getMetadata();
    if (meta.metadata && meta.metadata.optimized === 'true') continue; // already webp
    const [buf] = await file.download();
    const { webp } = await convertToWebp(buf);
    // Preserve the existing download token so client-captured URLs keep working.
    const existingToken = meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
    const token = existingToken || require('crypto').randomUUID();
    await file.save(webp, {
      metadata: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000',
        metadata: { optimized: 'true', firebaseStorageDownloadTokens: token },
      },
      resumable: false,
    });
    converted.push({ path: file.name, bytes: webp.length });
  }
  await listingRef.update({
    status: 'active',
    moderationFlags: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.collection('flaggedListings').doc(rec.listingId).delete();
  return {
    listingId: rec.listingId, group: 'convertible', action: 'converted+activated',
    converted,
    before: { status: before.status, moderationFlags: before.moderationFlags || null },
    after: { status: 'active', moderationFlags: null, flaggedListingsDeleted: true },
  };
}

async function applyDangling(rec) {
  const listingRef = db.collection('listings').doc(rec.listingId);
  const snap = await listingRef.get();
  const before = snap.data() || {};
  if (before.needsReupload === true) {
    return { listingId: rec.listingId, group: 'dangling', action: 'skip-already-marked' };
  }
  await listingRef.update({
    needsReupload: true,
    needsReuploadAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  // Keep it flagged (no valid image) but make the queue reason explicit.
  await db.collection('flaggedListings').doc(rec.listingId).set({
    reason: 'image_missing_needs_reupload',
    needsReupload: true,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return {
    listingId: rec.listingId, group: 'dangling', action: 'marked-needsReupload',
    before: { status: before.status, needsReupload: before.needsReupload || false },
    after: { status: before.status, needsReupload: true, note: 'NOT activated — no renderable image' },
  };
}

// Reconciliation: a flaggedListings/{id} queue entry is an ORPHAN if its parent
// listing no longer exists OR is already status:'active' (no live flag reason) —
// stale moderation-queue noise. Returns the delete candidates; deletes them only
// under --apply. Keeps the queue honest as real flags come and go.
async function reconcileFlaggedOrphans(doApply) {
  const [flSnap, candidates] = [await db.collection('flaggedListings').get(), []];
  for (const fdoc of flSnap.docs) {
    const lref = db.collection('listings').doc(fdoc.id);
    const l = await lref.get();
    let why = null;
    if (!l.exists) why = 'parent listing deleted';
    else if (l.data().status === 'active') why = 'parent listing is active (no live flag)';
    if (!why) continue;
    const rec = { id: fdoc.id, reason: (fdoc.data() || {}).reason || '(none)', why };
    if (doApply) {
      try { await db.collection('flaggedListings').doc(fdoc.id).delete(); rec.deleted = true; }
      catch (e) { rec.error = e.message; }
    }
    candidates.push(rec);
  }
  return candidates;
}

function sample(arr, n = 5) {
  return arr.slice(0, n).map((r) => ({
    listingId: r.listingId, seller: r.sellerId, title: r.title,
    objects: r.objects, heicCount: r.heicCount, formats: r.formats,
    partialMissing: r.partialMissing || undefined, note: r.note,
  }));
}

async function main() {
  console.log(`\n=== backfill-heic (${APPLY ? 'APPLY — WILL WRITE' : 'DRY-RUN — no writes'}) ===`);
  console.log(`project=${PROJECT_ID} bucket=${BUCKET} limit=${LIMIT}${ONLY ? ` only=${ONLY}` : ''}\n`);

  let scanned = 0;
  if (ONLY) {
    const one = await db.collection('listings').doc(ONLY).get();
    if (one.exists) { await classify(one); scanned = 1; }
    else console.log(`  --only listing ${ONLY} not found`);
  } else {
    const snap = await db.collection('listings').where('status', '==', 'flagged').get();
    for (const docSnap of snap.docs) {
      if (scanned >= LIMIT) break;
      scanned++;
      await classify(docSnap);
      if (scanned % 50 === 0) console.log(`  …classified ${scanned} flagged listings`);
    }
  }

  const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
  console.log('\n── CLASSIFICATION (flagged listings scanned: ' + scanned + ') ──');
  console.log(`  (a) convertible (HEIC present)      : ${counts.convertible}`);
  console.log(`  (b) dangling (objects gone)         : ${counts.dangling}`);
  console.log(`  (c) skip (other reason)             : ${counts.skip}`);
  console.log(`  (d) present-not-heic (Vision sweep) : ${counts.present_not_heic}`);
  console.log('\n  sample (a) convertible :', JSON.stringify(sample(groups.convertible), null, 0));
  console.log('  sample (b) dangling    :', JSON.stringify(sample(groups.dangling), null, 0));
  console.log('  sample (d) present-nh  :', JSON.stringify(sample(groups.present_not_heic), null, 0));

  const report = { mode: APPLY ? 'apply' : 'dryrun', scanned, counts, groups };

  // Reconciliation pass (skipped under --only, which is scoped to one listing).
  if (!ONLY) {
    const reconcile = await reconcileFlaggedOrphans(APPLY);
    report.reconcile = reconcile;
    console.log(`\n── RECONCILE flaggedListings orphans (${APPLY ? 'DELETED' : 'would delete'}: ${reconcile.length}) ──`);
    for (const r of reconcile.slice(0, 10)) {
      console.log(`   ${r.id} — ${r.why}${r.deleted ? ' [DELETED]' : ''}${r.error ? ' ERROR:' + r.error : ''}`);
    }
  }

  if (APPLY) {
    console.log('\n── APPLYING (groups a + b only) ──');
    for (const rec of groups.convertible) {
      try { const r = await applyConvertible(rec); audit.push(r); console.log('  [a]', r.listingId, r.action); }
      catch (e) { const r = { listingId: rec.listingId, group: 'convertible', action: 'ERROR', error: e.message }; audit.push(r); console.error('  [a] ERROR', rec.listingId, e.message); }
    }
    for (const rec of groups.dangling) {
      try { const r = await applyDangling(rec); audit.push(r); console.log('  [b]', r.listingId, r.action); }
      catch (e) { const r = { listingId: rec.listingId, group: 'dangling', action: 'ERROR', error: e.message }; audit.push(r); console.error('  [b] ERROR', rec.listingId, e.message); }
    }
    report.audit = audit;
    console.log(`\n  wrote ${audit.length} change records`);
  } else {
    console.log('\n  DRY-RUN — no writes. Re-run with --apply after review.');
  }

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n  full report → ${REPORT_PATH}\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
