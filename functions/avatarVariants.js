/**
 * functions/avatarVariants.js — profile avatar WebP derivatives (founder go
 * 2026-09-24, queued after Phase 3).
 *
 * Required by functions/index.js with one line:
 *     Object.assign(exports, require("./avatarVariants"));
 *
 * WHY: measured on prod 2026-09-24 — 15 avatar objects, 4.2MB total, MEDIAN
 * 92KB, worst 1677KB. Every one of them renders inside a circle of at most
 * 88px (.profile-avatar); most render at 20-40px (.card-seller-avatar,
 * .msg-avatar, .chat-header-avatar). Two avatars on the homepage cost 195KB
 * to paint ~40px circles — after r264 that was the largest remaining image
 * cost on the page. The client already downscales new uploads to 512px
 * (downscaleAvatar in index.html), which is why the median is 92KB rather
 * than 1MB, but 512px is still ~6x more than the biggest slot needs.
 *
 * WHAT: on every avatar finalize, emit two WebP derivatives and record their
 * download URLs on profiles/{uid} under avatarVariants.<basename>:
 *     w96  — every slot rendered at <= 48 CSS px, through 2x
 *     w256 — the 88px profile header, through 3x
 * The original is left byte-for-byte alone and stays the fallback.
 *
 * Mirrors writePassportPhotoVariants / writeListingPhotoVariants:
 *  - onObjectFinalized, NEVER onUpdate (#34 — an onUpdate trigger re-fires on
 *    its own writes and bills a loop).
 *  - keyed by BASENAME, not a bare index: avatars are named {Date.now()}.{ext}
 *    and a user can re-upload at any time. Keying by basename means a slow
 *    trigger for the OLD avatar can never clobber the variants of the NEW one.
 *  - fit "inside", so nothing is cropped server-side; every avatar slot
 *    already applies `object-fit: cover` in CSS.
 *
 * DELIBERATELY NOT INCLUDED — avatars get no SafeSearch pass here. The
 * listings and passport triggers moderate and can purge an object; that is a
 * destructive path and was not part of this ruling. Avatars are currently
 * UNMODERATED (see OPEN_THREADS — flagged, awaiting a ruling). This function
 * is purely additive: it never deletes, never rewrites the original, and
 * never touches avatarUrl.
 */
const {onObjectFinalized} = require("firebase-functions/v2/storage");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const BUCKET = "teebox-market.firebasestorage.app";
// [field, longest edge px, webp quality]
const SIZES = [["w96", 96, 80], ["w256", 256, 82]];

/**
 * Normalise the CloudEvent payload into a GCS object record.
 *
 * Eventarc delivers storage triggers in GCS_NOTIFICATION mode and, depending
 * on the framework path, `data` arrives as (a) the StorageObjectData, (b) a
 * Pub/Sub wrapper {message:{data:<base64 JSON>}}, (c) a raw JSON string or
 * Buffer, or (d) not at all — in which case `subject` still carries
 * "objects/<name>". Handle all four, exactly as optimizePassportPhoto does;
 * this shape was established by the 2026-09-17 audit and is load-bearing.
 *
 * @param {object} event CloudEvent as delivered by Eventarc.
 * @return {Promise<object|null>} object record with .name, or null.
 */
async function unwrapStorageEvent(event) {
  let obj = event && event.data;
  if (!obj && event && typeof event.name === "string" && event.name) obj = event;
  try {
    if (Buffer.isBuffer(obj)) obj = JSON.parse(obj.toString("utf8"));
    else if (typeof obj === "string") obj = JSON.parse(obj);
    if (obj && obj.message && obj.message.data && !obj.name) {
      obj = JSON.parse(Buffer.from(obj.message.data, "base64").toString("utf8"));
    }
  } catch (e) {
    logger.error("optimizeAvatar: could not parse event data", e && e.message);
    return null;
  }
  if (obj && obj.name) return obj;
  const subject = (event && event.subject) || "";
  const name = subject.startsWith("objects/") ? subject.slice("objects/".length) : "";
  if (!name) return null;
  const srcBucket = ((event && event.source) || "").split("/buckets/")[1] || BUCKET;
  try {
    const [meta] = await admin.storage().bucket(srcBucket).file(name).getMetadata();
    return {name, bucket: srcBucket, contentType: meta.contentType, metadata: meta.metadata};
  } catch (e) {
    logger.error("optimizeAvatar: could not rebuild object from subject", name, e && e.message);
    return null;
  }
}

/**
 * Emit w96/w256 WebP derivatives for one avatar object and merge their
 * download URLs onto profiles/{uid}.
 *
 * Exported so the backfill script runs the identical code path rather than a
 * second implementation that can drift.
 *
 * @param {object} bucket Storage bucket handle.
 * @param {string} objName Full object path, "avatars/{uid}/{stamp}.{ext}".
 * @param {Buffer} buf Original image bytes.
 * @return {Promise<object|null>} {basename, urls} or null when skipped.
 */
async function writeAvatarVariants(bucket, objName, buf) {
  const sharp = require("sharp");
  const crypto = require("crypto");
  const parts = objName.split("/");
  if (parts.length !== 3) return null;
  const uid = parts[1];
  const fileName = String(parts[2]);
  const basename = fileName.replace(/\.[^.]+$/, "");
  // Firestore field-path segment: a dot would silently nest the write.
  if (!uid || !basename || basename.includes(".")) {
    logger.warn("optimizeAvatar: unusable basename", objName);
    return null;
  }

  const base = sharp(buf, {failOn: "none"}).rotate(); // rotate() applies EXIF
  const urls = {};
  for (const [key, px, q] of SIZES) {
    // Square center-crop, NOT fit:"inside". Every avatar slot in the app is a
    // circle that already applies `object-fit: cover` over a square box, so
    // sharp's cover/centre crop lands on exactly the same visible pixels the
    // browser would have chosen — while guaranteeing the full px budget on
    // the short edge. With fit:"inside" a 384x512 portrait yields a 72px-wide
    // w96, which is soft inside an 80-device-px circle on a 2x screen.
    const out = await base.clone()
        .resize({width: px, height: px, fit: "cover", position: "centre",
          withoutEnlargement: true})
        // No .withMetadata() — it RETAINS EXIF rather than stripping it. See
        // the note in lib/imageConvert.js. base was produced with .rotate(),
        // so orientation is already in the pixels.
        .webp({quality: q})
        .toBuffer();
    const path = `${objName}_${key}.webp`;
    const token = crypto.randomUUID();
    await bucket.file(path).save(out, {
      metadata: {
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
        metadata: {optimized: "true", firebaseStorageDownloadTokens: token},
      },
      resumable: false,
    });
    urls[key] = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
      `/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  }

  // Merge onto the EXISTING profile only. The avatar object is uploaded
  // before updateProfile writes avatarUrl, so on a cold trigger the doc can
  // lag — but a profile doc that never appears means there is no profile to
  // decorate, and set({merge:true}) would conjure a phantom one.
  const ref = admin.firestore().collection("profiles").doc(uid);
  for (let attempt = 0; attempt < 4; attempt++) {
    const snap = await ref.get();
    if (snap.exists) {
      await ref.update({[`avatarVariants.${basename}`]: urls});
      return {basename, urls};
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
  }
  logger.warn("optimizeAvatar: profile doc never appeared — variants stored, doc skipped",
      {objName});
  return {basename, urls};
}

exports.writeAvatarVariants = writeAvatarVariants;

exports.optimizeAvatar = onObjectFinalized(
    {memory: "1GiB", region: "us-east1", bucket: BUCKET},
    async (event) => {
      const obj = await unwrapStorageEvent(event);
      if (!obj || !obj.name) return;
      // Every finalize on the bucket reaches this trigger (listings, passport
      // photos, everything) — bail before logging to keep the logs quiet.
      if (!obj.name.startsWith("avatars/")) return;
      // Our own output. Two independent guards because a loop here bills
      // real money: the filename suffix and the metadata stamp.
      if (/_w\d+\.webp$/.test(obj.name)) return;
      if (obj.metadata && obj.metadata.optimized === "true") return;
      const contentType = obj.contentType || "";
      if (!contentType.startsWith("image/")) return;

      logger.info("optimizeAvatar: event", {name: obj.name, contentType});
      try {
        const bucket = admin.storage().bucket(obj.bucket || BUCKET);
        const [buf] = await bucket.file(obj.name).download();
        const res = await writeAvatarVariants(bucket, obj.name, buf);
        if (res) {
          logger.info("optimizeAvatar: variants written",
              {name: obj.name, basename: res.basename, sizes: Object.keys(res.urls)});
        }
      } catch (e) {
        // Best-effort, exactly like the listing/passport variant writes: a
        // failed derivative never touches the original, and the client falls
        // back to avatarUrl. Nothing here is load-bearing for correctness.
        logger.error("optimizeAvatar: variant write failed", obj.name, e && e.message);
      }
    });
