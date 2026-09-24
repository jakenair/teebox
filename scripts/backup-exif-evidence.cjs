#!/usr/bin/env node
/**
 * scripts/backup-exif-evidence.cjs — preserve the record BEFORE
 * strip-exif-existing.cjs rewrites anything.
 *
 *   node scripts/backup-exif-evidence.cjs          # DRY RUN
 *   node scripts/backup-exif-evidence.cjs --apply  # copy + write manifest
 *
 * Copies every public object that currently carries GPS or camera-identity
 * EXIF to admin-evidence/exif-<date>/, which is PRIVATE: storage.rules ends in
 * a `match /{allPaths=**} { allow read, write: if false; }` default-deny and
 * admin-evidence/ has no matching rule, so no client can read it. Only the
 * Admin SDK (which bypasses rules) can.
 *
 * Writes a manifest recording, per object: object path, owning uid, listing or
 * avatar id, whether GPS was present, which identity tags were present, EXIF
 * byte count, and the SHA-256 of the ORIGINAL bytes — so the pre-strip state
 * is provable after the fact without anyone having to re-read the images.
 */
const admin = require("firebase-admin");
const crypto = require("crypto");

const APPLY = process.argv.includes("--apply");
const BUCKET = "teebox-market.firebasestorage.app";
const PREFIXES = ["passport/", "listings/", "avatars/"];
const DATE = new Date().toISOString().slice(0, 10);
const DEST = `admin-evidence/exif-${DATE}/`;

admin.initializeApp({
  projectId: "teebox-market",
  credential: admin.credential.applicationDefault(),
  storageBucket: BUCKET,
});

/**
 * Parse EXIF for GPS presence and identity tags.
 *
 * @param {Buffer} buf raw EXIF blob
 * @return {object|null} summary
 */
function exifSummary(buf) {
  if (!buf) return null;
  let o = 0;
  if (buf.toString("latin1", 0, 4) === "Exif") o = 6;
  const le = buf.toString("latin1", o, o + 2) === "II";
  const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
  try {
    const i0 = o + u32(o + 4);
    const n = u16(i0);
    const t = {};
    for (let i = 0; i < n; i++) {
      const e = i0 + 2 + i * 12;
      t[u16(e)] = {off: u32(e + 8), cnt: u32(e + 4)};
    }
    const str = (k) => {
      const x = t[k];
      if (!x || x.cnt <= 4) return null;
      return buf.toString("latin1", o + x.off, o + x.off + x.cnt - 1).trim();
    };
    const gps = !!t[0x8825];
    return {
      exifBytes: buf.length,
      gpsPresent: gps,
      gpsTagCount: gps ? u16(o + t[0x8825].off) : 0,
      make: str(0x10f), model: str(0x110), software: str(0x131),
    };
  } catch (_e) {
    return {exifBytes: buf.length, parseError: true};
  }
}

/**
 * Derive owner uid and the listing/avatar/course id from an object path.
 *
 * @param {string} name object path
 * @return {object} {kind, uid, id}
 */
function identify(name) {
  const p = name.split("/");
  if (p[0] === "listings") return {kind: "listing", uid: p[1], id: p[2] || null};
  if (p[0] === "passport") return {kind: "passport", uid: p[1], id: p[2] || null};
  if (p[0] === "avatars") return {kind: "avatar", uid: p[1], id: null};
  return {kind: "unknown", uid: null, id: null};
}

(async () => {
  const sharp = require("sharp");
  const bucket = admin.storage().bucket();
  const rows = [];

  for (const prefix of PREFIXES) {
    const [files] = await bucket.getFiles({prefix});
    for (const f of files) {
      let buf;
      try { [buf] = await f.download(); } catch (_e) { continue; }
      let meta;
      try { meta = await sharp(buf, {failOn: "none"}).metadata(); } catch (_e) { continue; }
      if (!meta || !meta.exif) continue;
      const s = exifSummary(meta.exif);
      if (!s) continue;
      const identifying = s.make || s.model || s.software;
      if (!s.gpsPresent && !identifying) continue; // benign minimal block
      const who = identify(f.name);
      rows.push({
        objectPath: f.name,
        ownerUid: who.uid,
        kind: who.kind,
        listingOrAvatarId: who.id,
        gpsPresent: !!s.gpsPresent,
        gpsTagCount: s.gpsTagCount || 0,
        identityTags: [s.make, s.model, s.software].filter(Boolean),
        exifBytes: s.exifBytes,
        format: meta.format,
        dimensions: `${meta.width}x${meta.height}`,
        bytes: buf.length,
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
        backupPath: DEST + f.name,
      });
      if (APPLY) {
        await bucket.file(DEST + f.name).save(buf, {
          resumable: false,
          metadata: {contentType: meta.format === "webp" ? "image/webp" : "image/jpeg"},
        });
      }
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    reason: "Pre-remediation record. .withMetadata({}) retained input EXIF on " +
      "every server image path; these PUBLIC objects carried GPS and/or camera " +
      "identity before scripts/strip-exif-existing.cjs rewrote them.",
    forwardFixCommit: "7934f82",
    destination: DEST,
    destinationIsPrivate: "storage.rules default-deny: match /{allPaths=**} " +
      "{ allow read, write: if false } — admin-evidence/ has no matching rule",
    objectCount: rows.length,
    withGps: rows.filter((r) => r.gpsPresent).length,
    ownersAffected: [...new Set(rows.map((r) => r.ownerUid))],
    objects: rows,
  };

  console.log(`objects to preserve: ${rows.length} (with GPS: ${manifest.withGps})`);
  for (const r of rows) {
    console.log(`  ${r.gpsPresent ? "GPS " : "    "}${r.kind.padEnd(8)} ${r.ownerUid}  ` +
      `${r.sha256.slice(0, 12)}…  ${r.objectPath}`);
  }
  console.log(`\nowners affected: ${manifest.ownersAffected.join(", ")}`);

  const local = "/private/tmp/claude-501/-Users-jakenair-dev-teebox/" +
    "655f183b-dd47-49c8-b032-5f52abe102d0/scratchpad/exif-evidence-manifest.json";
  if (APPLY) {
    await bucket.file(DEST + "MANIFEST.json").save(
        JSON.stringify(manifest, null, 2),
        {resumable: false, metadata: {contentType: "application/json"}});
    require("fs").writeFileSync(local, JSON.stringify(manifest, null, 2));
    console.log(`\ncopied ${rows.length} objects + MANIFEST.json to ${DEST}`);
    console.log(`local copy of manifest: ${local}`);
  } else {
    require("fs").writeFileSync(local, JSON.stringify(manifest, null, 2));
    console.log(`\nDRY RUN — nothing copied. Manifest previewed at ${local}`);
  }
  process.exit(0);
})();
