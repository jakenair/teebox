// Shared image decode+encode. ONE implementation, imported by BOTH the
// optimizeListingPhoto Storage trigger (functions/index.js) and the
// scripts/backfill-heic.mjs backfill — so the backfill converts bytes exactly
// the way the live trigger does, with no risk of drift.
//
// Decode an uploaded image and produce the 2048px WebP stored as the original,
// plus the sharp instance used to derive the 400/800/1200px variants.
// (Was 1600px / q82 until 2026-10-19 — phones at 3x stretched the 800px
// variant; the original now carries enough pixels for a sharp detail view.)
//   JPEG/PNG/WebP/AVIF decode natively via sharp. Apple HEVC-HEIC (what iPhones
//   shoot) does NOT: the bundled libvips has libheif but no HEVC decoder, so
//   sharp throws ("bad seek" / "plugin not built in"). We detect that by TRYING
//   sharp first and, only if it throws, falling back to heic-convert (WASM
//   libheif + libde265) to decode to JPEG, then run the same sharp pipeline.
//   Trying-then-falling-back avoids brand-sniffing ambiguity (AVIF shares the
//   'mif1' ftyp brand with HEIC but sharp CAN decode AVIF).
//   Throws with code IMG_DECODE_FAILED if neither path can decode the bytes —
//   callers MUST fail loud and never store the undecodable original as if done.
// Requires are lazy (inside the function) to match the trigger's original
// cold-start behavior.
async function convertToWebp(inputBuf) {
  const sharp = require("sharp");
  const encode = async (raster) => {
    const baseSharp = sharp(raster).rotate(); // honor EXIF orientation
    const webp = await baseSharp.clone()
      .resize({width: 2048, height: 2048, fit: "inside", withoutEnlargement: true})
      // NO .withMetadata() — sharp strips metadata by default, and
      // withMetadata() RETAINS it (the opposite of what the old comment here,
      // "match existing EXIF handling", implied). Verified 2026-09-24: a JPEG
      // carrying Make/Model came back out of this pipeline with those tags
      // intact. Uploads were only ever clean because the CLIENT canvas
      // re-encode drops EXIF first — a protection the server must not rely on,
      // since these objects are served at public URLs.
      // Orientation is safe: .rotate() above already baked it into the pixels,
      // so there is no orientation tag left to preserve — and re-attaching the
      // original EXIF would re-attach a tag that no longer applies.
      .webp({quality: 84})
      .toBuffer();
    return {baseSharp, webp};
  };
  try {
    return await encode(inputBuf);
  } catch (sharpErr) {
    let jpeg;
    try {
      const heicConvert = require("heic-convert");
      jpeg = await heicConvert({buffer: inputBuf, format: "JPEG", quality: 1});
    } catch (heicErr) {
      const e = new Error(
          `image decode failed — sharp: ${sharpErr && sharpErr.message}; ` +
          `heic-convert: ${heicErr && heicErr.message}`);
      e.code = "IMG_DECODE_FAILED";
      throw e;
    }
    return await encode(jpeg);
  }
}

// Biggest photo an import may hold: 60 megapixels (a 48MP phone fits).
const MAX_IMPORT_PIXELS = 60e6;

/** Largest width x height a HEIC file declares (its "ispe" boxes), or 0. */
function heicPixels(buf) {
  const head = buf.subarray(0, 256 * 1024);
  let max = 0;
  for (let i = head.indexOf("ispe"); i >= 0; i = head.indexOf("ispe", i + 4)) {
    if (i + 16 > head.length) break;
    max = Math.max(max, head.readUInt32BE(i + 8) * head.readUInt32BE(i + 12));
  }
  return max;
}

let decodeQueue = Promise.resolve();

/**
 * Would convertToWebp be able to read this file? Runs the same decode (without
 * the encode), one photo at a time per instance because a HEIC decode is
 * large. Used before an imported photo is stored, so a file the safety
 * scanner can't read never reaches a listing.
 * @param {Buffer} buf
 * @return {Promise<string|null>} why not (for the seller), or null
 */
function checkDecodes(buf) {
  const run = decodeQueue.then(() => decodeProblem(buf));
  decodeQueue = run.catch(() => {});
  return run;
}

async function decodeProblem(buf) {
  const sharp = require("sharp");
  const tooBig = "the photo has too many pixels (60 megapixels at most)";
  try {
    const m = await sharp(buf).metadata();
    if ((m.width || 0) * (m.height || 0) > MAX_IMPORT_PIXELS) return tooBig;
  } catch (_e) { /* not sharp-readable: the decode below decides */ }
  try {
    await sharp(buf).rotate()
        .resize({width: 2048, height: 2048, fit: "inside", withoutEnlargement: true}).raw().toBuffer();
    return null;
  } catch (_e) { /* maybe HEIC */ }
  const px = heicPixels(buf);
  if (px > MAX_IMPORT_PIXELS) return tooBig;
  if (px > 0) {
    try {
      const jpeg = await require("heic-convert")({buffer: buf, format: "JPEG", quality: 1});
      await sharp(jpeg).rotate().resize({width: 64}).raw().toBuffer();
      return null;
    } catch (_e) { /* falls through */ }
  }
  return "the file is damaged or isn't a photo we can read";
}

module.exports = {convertToWebp, checkDecodes, heicPixels, MAX_IMPORT_PIXELS};
