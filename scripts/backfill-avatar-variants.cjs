#!/usr/bin/env node
/**
 * scripts/backfill-avatar-variants.cjs — one-shot backfill for avatars that
 * were uploaded before the optimizeAvatar Storage trigger existed.
 *
 *   node scripts/backfill-avatar-variants.cjs          # DRY RUN (default)
 *   node scripts/backfill-avatar-variants.cjs --apply  # actually write
 *
 * Scoped deliberately to each profile's CURRENT avatar — the object named by
 * profiles/{uid}.avatarUrl — not to every object under avatars/. Users
 * re-upload, so the bucket holds stale avatars nobody renders; generating
 * derivatives for those would just add objects to pay for. The client only
 * ever looks up the basename of the avatar it is about to draw.
 *
 * Runs the SAME writeAvatarVariants() the trigger runs, imported from
 * functions/avatarVariants.js, so the backfill cannot drift from live
 * behaviour. Idempotent: a basename already present in avatarVariants is
 * skipped, so re-running is free and safe.
 */
const admin = require("firebase-admin");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const BUCKET = "teebox-market.firebasestorage.app";

admin.initializeApp({
  projectId: "teebox-market",
  credential: admin.credential.applicationDefault(),
  storageBucket: BUCKET,
});

const {writeAvatarVariants} =
  require(path.join(__dirname, "..", "functions", "avatarVariants.js"));

/**
 * Pull the Storage object path out of a Firebase download URL.
 *
 * @param {string} url profiles/{uid}.avatarUrl
 * @return {string|null} object path, or null if this is not a Storage URL
 *   for our bucket (Google/Auth photoURLs and gravatars live elsewhere).
 */
function objectPathFromUrl(url) {
  if (typeof url !== "string") return null;
  if (!url.includes("firebasestorage.googleapis.com")) return null;
  const m = url.match(/\/o\/([^?]+)/);
  if (!m) return null;
  try {
    const p = decodeURIComponent(m[1]);
    return p.startsWith("avatars/") ? p : null;
  } catch (_e) {
    return null;
  }
}

(async () => {
  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const snap = await db.collection("profiles").get();

  const work = [];
  const skipped = {noAvatar: 0, external: 0, alreadyDone: 0, missingObject: 0};

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (!d.avatarUrl) { skipped.noAvatar++; continue; }
    const objName = objectPathFromUrl(d.avatarUrl);
    if (!objName) { skipped.external++; continue; }
    const basename = String(objName.split("/").pop()).replace(/\.[^.]+$/, "");
    if (d.avatarVariants && d.avatarVariants[basename]) { skipped.alreadyDone++; continue; }
    const file = bucket.file(objName);
    const [exists] = await file.exists();
    if (!exists) {
      skipped.missingObject++;
      console.log(`  MISSING OBJECT  ${doc.id}  ${objName}`);
      continue;
    }
    const [meta] = await file.getMetadata();
    work.push({uid: doc.id, objName, basename, bytes: Number(meta.size || 0)});
  }

  console.log(`profiles scanned: ${snap.size}`);
  console.log(`  no avatar:            ${skipped.noAvatar}`);
  console.log(`  non-Storage avatar:   ${skipped.external}`);
  console.log(`  variants already set: ${skipped.alreadyDone}`);
  console.log(`  object missing:       ${skipped.missingObject}`);
  console.log(`  TO PROCESS:           ${work.length}`);
  const totalKb = Math.round(work.reduce((a, w) => a + w.bytes, 0) / 1024);
  console.log(`  originals total:      ${totalKb}KB\n`);
  work.forEach((w) => console.log(
      `  ${APPLY ? "PROCESS" : "would process"}  ${w.uid}  ${Math.round(w.bytes / 1024)}KB  ${w.objName}`));

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to execute.");
    process.exit(0);
  }

  console.log("\n--apply given; writing variants…\n");
  let ok = 0; let failed = 0; let after = 0;
  for (const w of work) {
    try {
      const [buf] = await bucket.file(w.objName).download();
      const res = await writeAvatarVariants(bucket, w.objName, buf);
      if (!res) { failed++; console.log(`  SKIP  ${w.uid}  (unusable basename)`); continue; }
      const [a] = await bucket.file(`${w.objName}_w96.webp`).getMetadata();
      const [b] = await bucket.file(`${w.objName}_w256.webp`).getMetadata();
      after += Number(a.size || 0) + Number(b.size || 0);
      ok++;
      console.log(`  OK    ${w.uid}  ${Math.round(w.bytes / 1024)}KB -> ` +
        `w96 ${Math.round(Number(a.size) / 1024 * 10) / 10}KB, ` +
        `w256 ${Math.round(Number(b.size) / 1024 * 10) / 10}KB`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${w.uid}  ${w.objName}: ${e && e.message}`);
    }
  }
  console.log(`\ndone: ${ok} ok, ${failed} failed. ` +
    `Derivatives added: ${Math.round(after / 1024)}KB total ` +
    `(originals they replace at render time: ${totalKb}KB).`);
  process.exit(failed ? 1 : 0);
})();
