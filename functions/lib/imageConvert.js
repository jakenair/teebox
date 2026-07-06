// Shared image decode+encode. ONE implementation, imported by BOTH the
// optimizeListingPhoto Storage trigger (functions/index.js) and the
// scripts/backfill-heic.mjs backfill — so the backfill converts bytes exactly
// the way the live trigger does, with no risk of drift.
//
// Decode an uploaded image and produce the 1600px WebP stored as the original,
// plus the sharp instance used to derive the 400/800px variants.
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
      .resize({width: 1600, height: 1600, fit: "inside", withoutEnlargement: true})
      .withMetadata({}) // match existing EXIF handling
      .webp({quality: 82})
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

module.exports = {convertToWebp};
