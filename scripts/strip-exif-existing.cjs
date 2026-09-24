#!/usr/bin/env node
/**
 * scripts/strip-exif-existing.cjs — remediate PUBLIC objects that already
 * carry EXIF, written before the server-side strip landed (commit 7934f82).
 *
 *   node scripts/strip-exif-existing.cjs           # DRY RUN (default)
 *   node scripts/strip-exif-existing.cjs --apply   # rewrite the objects
 *
 * WHY: `.withMetadata({})` RETAINED input EXIF instead of stripping it, so
 * any photo that reached the server with metadata intact had it published at
 * a public URL. Audit 2026-09-24 found 9 live objects carrying a GPS IFD
 * (lat/lon/altitude/timestamp/bearing) plus camera identity, and 4 more
 * carrying camera identity alone.
 *
 * HOW: the stored objects are WebP. Rather than re-encode (which would cost a
 * generation of quality on an already-lossy image), this performs RIFF
 * container surgery: drop the EXIF and XMP chunks, clear the matching flag
 * bits in the VP8X extended header, and fix the RIFF size. The compressed
 * image chunks (VP8/VP8L/ALPH) are copied through untouched, so the decoded
 * pixels are bit-identical — which this script VERIFIES per object before
 * writing, and refuses to write if they are not.
 *
 * Storage metadata (contentType, cacheControl, and crucially
 * firebaseStorageDownloadTokens) is preserved exactly, so every existing
 * download URL keeps working and no Firestore doc needs rewriting.
 */
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const BUCKET = "teebox-market.firebasestorage.app";
const PREFIXES = ["passport/", "listings/", "avatars/"];

admin.initializeApp({
  projectId: "teebox-market",
  credential: admin.credential.applicationDefault(),
  storageBucket: BUCKET,
});

/** Chunks carrying metadata rather than image data. */
const META_CHUNKS = new Set(["EXIF", "XMP "]);
// VP8X flag bits, per the WebP container spec.
const FLAG_XMP = 0x04;
const FLAG_EXIF = 0x08;

/**
 * Remove EXIF/XMP chunks from a WebP RIFF container without re-encoding.
 *
 * @param {Buffer} buf original WebP bytes
 * @return {{out: Buffer, removed: string[]}|null} null if not a RIFF/WEBP
 */
function stripWebpMetadata(buf) {
  if (buf.length < 12) return null;
  if (buf.toString("latin1", 0, 4) !== "RIFF") return null;
  if (buf.toString("latin1", 8, 12) !== "WEBP") return null;

  const kept = [];
  const removed = [];
  let p = 12;
  while (p + 8 <= buf.length) {
    const fourcc = buf.toString("latin1", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const padded = size + (size % 2); // chunks are even-aligned
    const end = p + 8 + padded;
    if (end > buf.length) break; // truncated tail — stop, keep what parsed
    const chunk = buf.slice(p, end);
    if (META_CHUNKS.has(fourcc)) removed.push(fourcc.trim() || fourcc);
    else kept.push({fourcc, chunk});
    p = end;
  }
  if (!removed.length) return {out: buf, removed: []};

  // Clear the EXIF/XMP bits in VP8X so decoders do not look for chunks that
  // are no longer there.
  for (const k of kept) {
    if (k.fourcc === "VP8X" && k.chunk.length >= 9) {
      const c = Buffer.from(k.chunk);
      c[8] = c[8] & ~(FLAG_EXIF | FLAG_XMP);
      k.chunk = c;
    }
  }

  const body = Buffer.concat(kept.map((k) => k.chunk));
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(4 + body.length, 4); // "WEBP" + chunks
  out.write("WEBP", 8, "latin1");
  body.copy(out, 12);
  return {out, removed};
}

/**
 * Remove EXIF/XMP APP1 segments from a JPEG without re-encoding.
 *
 * Needed because two avatar originals are raw iPhone JPEGs: downscaleAvatar()
 * returns the file UNCHANGED when it is already within AVATAR_MAX (512px), so
 * a small camera photo skips the canvas re-encode that strips metadata on
 * every other path and lands in Storage with its EXIF intact.
 *
 * Walks the marker chain and copies everything except APP1 segments whose
 * payload begins with the Exif or XMP identifier. Entropy-coded scan data is
 * copied verbatim, so the decoded image is unchanged.
 *
 * @param {Buffer} buf original JPEG bytes
 * @return {{out: Buffer, removed: string[]}|null} null if not a JPEG
 */
function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  const parts = [buf.slice(0, 2)]; // SOI
  const removed = [];
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xFF) break; // desync — bail and keep the remainder
    const marker = buf[p + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      parts.push(buf.slice(p, p + 2)); p += 2; continue;
    }
    if (marker === 0xDA) { parts.push(buf.slice(p)); p = buf.length; break; } // SOS → rest verbatim
    const len = buf.readUInt16BE(p + 2);
    const end = p + 2 + len;
    if (end > buf.length) break;
    const seg = buf.slice(p, end);
    if (marker === 0xE1) {
      const id = buf.toString("latin1", p + 4, Math.min(p + 4 + 29, end));
      if (id.startsWith("Exif\0") || id.startsWith("http://ns.adobe.com/xap/")) {
        removed.push(id.startsWith("Exif\0") ? "EXIF" : "XMP");
        p = end; continue; // drop it
      }
    }
    parts.push(seg);
    p = end;
  }
  if (p < buf.length && parts[parts.length - 1] !== buf.slice(p)) {
    // any unparsed tail (shouldn't happen after SOS handling) is preserved
    if (!removed.length) return {out: buf, removed: []};
  }
  return {out: Buffer.concat(parts), removed};
}

/**
 * Parse an EXIF blob far enough to report GPS presence and camera identity.
 *
 * @param {Buffer} buf raw EXIF
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
    return {
      bytes: buf.length,
      gps: !!t[0x8825],
      gpsTags: t[0x8825] ? u16(o + t[0x8825].off) : 0,
      ident: [str(0x10f), str(0x110), str(0x131)].filter(Boolean).join("/") || null,
    };
  } catch (_e) {
    return {bytes: buf.length, parseErr: true};
  }
}

(async () => {
  const sharp = require("sharp");
  const bucket = admin.storage().bucket();

  const targets = [];
  for (const prefix of PREFIXES) {
    const [files] = await bucket.getFiles({prefix});
    for (const f of files) {
      let buf;
      try { [buf] = await f.download(); } catch (_e) { continue; }
      let meta;
      try { meta = await sharp(buf, {failOn: "none"}).metadata(); } catch (_e) { continue; }
      if (!meta || !meta.exif) continue;
      const s = exifSummary(meta.exif);
      if (!s || (!s.gps && !s.ident)) continue; // benign minimal block
      targets.push({file: f, buf, sum: s, fmt: meta.format,
        w: meta.width, h: meta.height});
    }
  }

  console.log(`objects carrying GPS or camera identity: ${targets.length}\n`);
  for (const t of targets) {
    console.log(`  ${t.sum.gps ? "GPS(" + t.sum.gpsTags + ")" : "ident    "}  ` +
      `${String(t.sum.bytes).padStart(6)}B exif  ${t.sum.ident || ""}  ${t.file.name}`);
  }
  if (!targets.length) { console.log("nothing to do."); process.exit(0); }

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — verifying each rewrite is pixel-identical…\n`);
  let ok = 0; let skipped = 0; let failed = 0;
  for (const t of targets) {
    const name = t.file.name;
    if (t.fmt !== "webp" && t.fmt !== "jpeg" && t.fmt !== "jpg") {
      console.log(`  SKIP  ${name} — format ${t.fmt}, no lossless strip implemented`);
      skipped++; continue;
    }
    const res = t.fmt === "webp"
      ? stripWebpMetadata(t.buf)
      : stripJpegMetadata(t.buf);
    if (!res || !res.removed.length) {
      console.log(`  SKIP  ${name} — no EXIF/XMP chunk found in container`);
      skipped++; continue;
    }
    // PROOF of losslessness: decode both and compare raw pixels.
    let before; let after;
    try {
      before = await sharp(t.buf).raw().toBuffer();
      after = await sharp(res.out).raw().toBuffer();
    } catch (e) {
      console.log(`  FAIL  ${name} — decode after strip failed: ${e.message}`);
      failed++; continue;
    }
    const identical = before.length === after.length && Buffer.compare(before, after) === 0;
    const m2 = await sharp(res.out).metadata();
    if (!identical || m2.width !== t.w || m2.height !== t.h) {
      console.log(`  FAIL  ${name} — NOT pixel-identical, refusing to write`);
      failed++; continue;
    }
    if (m2.exif) {
      console.log(`  FAIL  ${name} — EXIF still present after strip, refusing`);
      failed++; continue;
    }
    const saved = t.buf.length - res.out.length;
    console.log(`  ${APPLY ? "WROTE" : "would"} ${name}`);
    console.log(`         removed [${res.removed.join(",")}] -${saved}B, ` +
      `${m2.width}x${m2.height} pixel-identical, exif now: none`);

    if (APPLY) {
      const [md] = await t.file.getMetadata();
      await t.file.save(res.out, {
        resumable: false,
        metadata: {
          contentType: md.contentType,
          cacheControl: md.cacheControl,
          metadata: md.metadata, // preserves firebaseStorageDownloadTokens
        },
      });
    }
    ok++;
  }
  console.log(`\n${APPLY ? "rewrote" : "would rewrite"}: ${ok} | skipped: ${skipped} | failed: ${failed}`);
  if (!APPLY) console.log("DRY RUN — nothing written. Re-run with --apply.");
  process.exit(failed ? 1 : 0);
})();
