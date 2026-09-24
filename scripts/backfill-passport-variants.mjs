#!/usr/bin/env node
// scripts/backfill-passport-variants.mjs
// ───────────────────────────────────────────────────────────────────────────
// Backfill for Passport photo variants (founder ruling 2026-09-21). Photos
// uploaded before the optimizePassportPhoto variants rework are stored as
// single full-res JPEGs (0.4–0.6MB each) with no w400/w800 — the feed loads
// multi-MB per post. This script mirrors the reworked trigger EXACTLY for
// existing objects:
//   1. convert the original via the SAME convertToWebp() the live triggers
//      use (functions/lib/imageConvert.js — one implementation, no drift)
//      and replace it in place (1600px WebP, EXIF stripped, download token
//      PRESERVED so the URL stored on the round doc keeps working),
//   2. emit <name>_w400.webp + <name>_w800.webp siblings,
//   3. merge photoVariants.<basename> = {w400, w800} onto the round doc.
//
// No SafeSearch here: every existing object already passed the live
// trigger's fail-closed scan when it was uploaded (metadata.optimized=true).
// Objects whose round doc is missing or does not reference them are ORPHANS:
// reported, never processed, never deleted (deletion is a founder call).
//
// DEFAULT: DRY-RUN — enumerates + classifies + reports; writes NOTHING.
//
//   node scripts/backfill-passport-variants.mjs            # dry-run
//   node scripts/backfill-passport-variants.mjs --apply    # perform writes
//   node scripts/backfill-passport-variants.mjs --limit=10 # cap originals
//
// Auth: ADC (gcloud auth application-default login).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const { convertToWebp } = require('../functions/lib/imageConvert.js');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = (() => {
  const a = argv.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();

admin.initializeApp({
  projectId: 'teebox-market',
  credential: admin.credential.applicationDefault(),
  storageBucket: 'teebox-market.firebasestorage.app',
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

const VARIANT_RE = /_w(?:400|800)\.webp$/i;

async function main() {
  const [files] = await bucket.getFiles({ prefix: 'passport/' });
  const byName = new Map(files.map((f) => [f.name, f]));
  const originals = files.filter((f) => !VARIANT_RE.test(f.name));

  const rounds = new Map(); // docPath -> round data (cached)
  const todo = [];
  const done = [];
  const orphans = [];
  let bytes = 0;

  for (const f of originals) {
    const parts = f.name.split('/');
    if (parts.length < 4) { orphans.push(f.name + ' (bad path shape)'); continue; }
    const [, uid, courseId, fileName] = parts;
    const docPath = `passport/${uid}/played/${courseId}`;
    if (!rounds.has(docPath)) {
      const snap = await db.doc(docPath).get();
      rounds.set(docPath, snap.exists ? snap.data() : null);
    }
    const round = rounds.get(docPath);
    const referenced = !!(round && (round.photos || []).some((u) =>
      typeof u === 'string' && u.includes(encodeURIComponent(f.name))));
    if (!round) { orphans.push(f.name + ' (round doc missing)'); continue; }
    if (!referenced) { orphans.push(f.name + ' (not referenced by round)'); continue; }
    const basename = fileName.replace(/\.[^.]+$/, '');
    const hasW400 = byName.has(`${f.name}_w400.webp`);
    const hasW800 = byName.has(`${f.name}_w800.webp`);
    const hasDocKey = !!(round.photoVariants && round.photoVariants[basename]);
    if (hasW400 && hasW800 && hasDocKey) { done.push(f.name); continue; }
    if (todo.length >= LIMIT) continue;
    bytes += Number(f.metadata.size || 0);
    todo.push({ file: f, docPath, basename, hasW400, hasW800, hasDocKey });
  }

  console.log('── backfill-passport-variants ' + (APPLY ? '(APPLY)' : '(DRY-RUN)') + ' ──');
  console.log('storage objects under passport/:', files.length,
    '| originals:', originals.length, '| variant files:', files.length - originals.length);
  console.log('already complete:', done.length);
  console.log('orphans (skipped, untouched):', orphans.length);
  orphans.forEach((o) => console.log('   orphan:', o));
  console.log('TODO:', todo.length, 'originals,',
    (bytes / 1024 / 1024).toFixed(1) + 'MB source bytes');
  const byRound = {};
  todo.forEach((t) => { byRound[t.docPath] = (byRound[t.docPath] || 0) + 1; });
  Object.entries(byRound).forEach(([k, n]) => console.log('   ', k, '→', n, 'photo(s)'));

  if (!APPLY) { console.log('\nDry-run only — nothing written. Re-run with --apply.'); return; }

  let ok = 0, failed = 0;
  for (const t of todo) {
    try {
      const [buf] = await t.file.download();
      const [meta] = await t.file.getMetadata();
      const token = (meta.metadata && meta.metadata.firebaseStorageDownloadTokens) ||
        crypto.randomUUID();
      const { baseSharp, webp } = await convertToWebp(buf);
      // 1) in-place original → 1600px webp, token preserved (URL stable)
      await t.file.save(webp, {
        metadata: {
          contentType: 'image/webp',
          cacheControl: 'public, max-age=31536000, immutable',
          metadata: { optimized: 'true', firebaseStorageDownloadTokens: token },
        },
        resumable: false,
      });
      // 2) variants (identical params to the trigger)
      const urls = {};
      for (const [key, px, q] of [['w400', 400, 78], ['w800', 800, 82]]) {
        const vbuf = await baseSharp.clone()
          .resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true })
          // No .withMetadata() — kept identical to the live trigger, which
          // dropped it 2026-09-24 because withMetadata RETAINS EXIF. If this
          // line and the trigger ever disagree, the backfill writes objects
          // with different privacy properties than live uploads.
          .webp({ quality: q })
          .toBuffer();
        const path = `${t.file.name}_${key}.webp`;
        const vtoken = crypto.randomUUID();
        await bucket.file(path).save(vbuf, {
          metadata: {
            contentType: 'image/webp',
            cacheControl: 'public, max-age=31536000, immutable',
            metadata: { optimized: 'true', firebaseStorageDownloadTokens: vtoken },
          },
          resumable: false,
        });
        urls[key] = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
          `/o/${encodeURIComponent(path)}?alt=media&token=${vtoken}`;
      }
      // 3) record on the round doc
      await db.doc(t.docPath).set({ photoVariants: { [t.basename]: urls } }, { merge: true });
      ok++;
      console.log('done', t.file.name, '(' + webp.length + 'B webp)');
    } catch (e) {
      failed++;
      console.error('FAILED (original left untouched):', t.file.name, e && e.message);
    }
  }
  console.log(`\napply complete: ${ok} ok, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0));
