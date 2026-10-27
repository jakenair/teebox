#!/usr/bin/env node
/**
 * functions/scripts/backfill-photo-variants.mjs — one-off repair.
 *
 * Generates the 400/800px WebP variants for listing photos that have none.
 * Today that is the six listings flagged `image_scan_error` during the
 * 2026-10-01 Vision incident and approved by hand: variants are only written
 * on the clean-scan branch, so approval left them serving 1600px originals.
 *
 *   node functions/scripts/backfill-photo-variants.mjs            # DRY RUN (default): prints the plan
 *   node functions/scripts/backfill-photo-variants.mjs --apply    # writes variants + photoVariants
 *   …add --status active,pending,sold to widen (default: active,pending)
 *   …add --upgrade to also regenerate photos whose variants predate w1200 (2026-10-19)
 *
 * Uses lib/listingPhotoVariants.backfillVariantsForPhoto — the same encoder
 * the live trigger and approveFlaggedListing use. Idempotent: photos that
 * already have a w400 entry are skipped. Aggregates + listing ids only.
 */
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = path.resolve(HERE, "..");
const require = createRequire(path.join(FUNCTIONS, "package.json"));
const admin = require("firebase-admin");
const {variantGaps, objectPathFromUrl} = require(path.join(FUNCTIONS, "lib", "photoPrune.js"));
const {backfillVariantsForPhoto, SIZES} = require(path.join(FUNCTIONS, "lib", "listingPhotoVariants.js"));
const NEWEST_KEY = SIZES[SIZES.length - 1][0];

const APPLY = process.argv.includes("--apply");
const UPGRADE = process.argv.includes("--upgrade");
const sIdx = process.argv.indexOf("--status");
const STATUSES = (sIdx > -1 ? process.argv[sIdx + 1] : "active,pending").split(",").map((s) => s.trim());

admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});
const db = admin.firestore();
const bucket = admin.storage().bucket("teebox-market.firebasestorage.app");

const snap = await db.collection("listings").where("status", "in", STATUSES).get();
const plan = [];
for (const d of snap.docs) {
  const data = d.data();
  const gaps = new Set(variantGaps(data));
  if (UPGRADE) {
    (data.photos || []).forEach((_u, i) => {
      const v = (data.photoVariants || {})[String(i)];
      if (!v || !v[NEWEST_KEY]) gaps.add(i);
    });
  }
  for (const idx of [...gaps].sort((a, b) => a - b)) {
    const objPath = objectPathFromUrl((data.photos || [])[idx]);
    let exists = false; let bytes = null;
    if (objPath) {
      const f = bucket.file(objPath);
      [exists] = await f.exists();
      if (exists) { const [m] = await f.getMetadata(); bytes = Number(m.size || 0); }
    }
    plan.push({listingId: d.id, status: data.status, index: idx, of: (data.photos || []).length, objPath, exists, bytes});
  }
}
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — statuses ${STATUSES.join(",")} — ${snap.size} listings scanned — ${plan.length} photo(s) ${UPGRADE ? "missing " + NEWEST_KEY : "missing variants"}s across ${new Set(plan.map((p) => p.listingId)).size} listing(s)`);
for (const p of plan) {
  console.log(`  ${p.listingId} [${p.status}] photo ${p.index + 1}/${p.of}  ${p.exists ? `${(p.bytes / 1024).toFixed(0)} KB` : "OBJECT MISSING"}  → ${p.objPath ? p.objPath.split("/").pop() : "(non-storage url)"}_w400.webp + _w800.webp`);
}
if (!APPLY) { console.log("\nNothing written. Re-run with --apply to generate."); process.exit(0); }
let ok = 0; let failed = 0;
for (const p of plan) {
  if (!p.exists) { failed++; console.log(`  ✖ ${p.listingId}#${p.index}: object missing`); continue; }
  try {
    const r = await backfillVariantsForPhoto(bucket, p.listingId, p.objPath, p.index);
    if (r.ok) { ok++; console.log(`  ✓ ${p.listingId}#${p.index}`); } else { failed++; console.log(`  ✖ ${p.listingId}#${p.index}: ${r.reason}`); }
  } catch (e) { failed++; console.log(`  ✖ ${p.listingId}#${p.index}: ${e.message}`); }
}
console.log(`done: ${ok} written, ${failed} failed`);
process.exit(failed ? 1 : 0);
