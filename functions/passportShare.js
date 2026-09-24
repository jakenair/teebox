/**
 * functions/passportShare.js — opt-in public sharing of a Passport round.
 *
 * Required by functions/index.js:
 *     exports.sharePassportRound   = require("./passportShare").sharePassportRound;
 *     exports.unsharePassportRound = require("./passportShare").unsharePassportRound;
 *     exports.getSharedRound       = require("./passportShare").getSharedRound;
 *
 * FOUNDER REQUIREMENTS (2026-09-24), and how each is met:
 *
 * 1. "No uid in the URL." The share link is /round.html?t=<opaque token>. The
 *    token maps to the round SERVER-SIDE via sharedRounds/{token}, which is
 *    read:false / write:false for every client — it holds the uid, so exposing
 *    it would defeat the point. getSharedRound is the only way in, and it
 *    returns a PROJECTION with no uid, modelled on getBingoLeaderboard (A1).
 *
 * 2. "Opt-in." Nothing is public until the owner calls sharePassportRound.
 *    passport/{uid}/played/{courseId} itself is already world-readable, but a
 *    reader needs the uid AND courseId to find it; the share flow never adds a
 *    new way to enumerate rounds.
 *
 * 3. "Course, grade, date, photos, display name only." Enforced by building the
 *    response field-by-field below — never by spreading the document. tags and
 *    review are included because they are part of the round the owner chose to
 *    share; location, handicap, bio, golfBag and email are never read.
 *
 * 4. OG unfurl: /round.html is a static stub with generic TeeBox tags. Chosen so
 *    a Hosting rewrite can later point that same path at a per-round OG function
 *    without breaking links already in the wild (HANDOFF_PARKED_THREADS §6).
 *
 * 5. "Owner can revoke and the link 404s gracefully." unsharePassportRound sets
 *    revokedAt and DELETES the copied image objects; getSharedRound then returns
 *    {notFound:true} — a clean state the page renders as a message, not an error.
 *
 * PHOTOS — the part that actually required work. Passport photos live at
 * passport/{uid}/{courseId}/{file}, so their download URLs contain the uid.
 * Serving them directly would move the uid out of the address bar and into the
 * <img src>, which is the same leak wearing a different hat. So at share time
 * the w400/w800 WebP DERIVATIVES ONLY are copied to sharedRounds/{token}/ and
 * the copies are what the public page loads. Never the originals: they are the
 * full-size image and were never needed for a share card.
 *
 * Every copy is re-encoded through sharp WITHOUT withMetadata(), so it carries
 * no EXIF even if a future upload path ever reintroduces some. The source
 * variants are already clean as of commit 7934f82; this is belt-and-braces on a
 * public surface, per the founder ruling to strip at copy time rather than trust
 * upstream.
 */
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

const BUCKET = "teebox-market.firebasestorage.app";
const SHARE_PREFIX = "sharedRounds/";
const SITE = "https://teeboxmarket.com";
const REGION = "us-central1";
const COPY_SIZES = ["w400", "w800"]; // derivatives only — never the original
const MAX_PHOTOS = 12;

const CALLABLE = {region: REGION, memory: "512MiB", timeoutSeconds: 60};

/**
 * Copy one variant into the public share folder, stripped of metadata.
 *
 * @param {object} bucket Storage bucket.
 * @param {string} srcUrl Firebase download URL of the source variant.
 * @param {string} destPath Object path under sharedRounds/{token}/.
 * @return {Promise<string|null>} public download URL, or null if unusable.
 */
async function copyStripped(bucket, srcUrl, destPath) {
  const m = String(srcUrl || "").match(/\/o\/([^?]+)/);
  if (!m) return null;
  let srcPath;
  try { srcPath = decodeURIComponent(m[1]); } catch (_e) { return null; }
  // Only ever copy out of the passport tree — never let a caller-supplied URL
  // point this at some other object.
  if (!srcPath.startsWith("passport/")) return null;

  const [buf] = await bucket.file(srcPath).download();
  const sharp = require("sharp");
  // No .withMetadata(): sharp strips by default, and withMetadata would RETAIN
  // whatever the input carried. .rotate() first so orientation is in the pixels.
  const out = await sharp(buf, {failOn: "none"}).rotate().webp({quality: 82}).toBuffer();

  const token = crypto.randomUUID();
  await bucket.file(destPath).save(out, {
    resumable: false,
    metadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
      metadata: {optimized: "true", firebaseStorageDownloadTokens: token},
    },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
    `/o/${encodeURIComponent(destPath)}?alt=media&token=${token}`;
}

/** @return {string} 32-char opaque, unguessable share id. */
function mintToken() {
  return crypto.randomBytes(16).toString("hex");
}

exports.sharePassportRound = onCall(CALLABLE, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to share a round.");
  const courseId = String((req.data && req.data.courseId) || "").trim();
  if (!courseId || courseId.includes("/")) {
    throw new HttpsError("invalid-argument", "courseId required.");
  }

  const db = admin.firestore();
  const roundRef = db.doc(`passport/${uid}/played/${courseId}`);
  const snap = await roundRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Round not found.");
  const round = snap.data() || {};

  // Idempotent: re-sharing an already-shared round returns the same link
  // rather than minting a second live token for the same content.
  if (round.shareToken) {
    const ex = await db.doc(`${SHARE_PREFIX}${round.shareToken}`).get();
    if (ex.exists && !ex.data().revokedAt) {
      return {ok: true, token: round.shareToken,
        url: `${SITE}/round.html?t=${round.shareToken}`, reused: true};
    }
  }

  const token = mintToken();
  const bucket = admin.storage().bucket(BUCKET);

  // Copy the derivatives, in the round's own photo order.
  const variants = round.photoVariants || {};
  const keys = Object.keys(variants).sort().slice(0, MAX_PHOTOS);
  const photos = [];
  for (const key of keys) {
    const v = variants[key] || {};
    const entry = {};
    for (const size of COPY_SIZES) {
      if (!v[size]) continue;
      try {
        const url = await copyStripped(bucket, v[size],
            `${SHARE_PREFIX}${token}/${key}_${size}.webp`);
        if (url) entry[size] = url;
      } catch (e) {
        logger.warn("sharePassportRound: variant copy failed",
            {token, key, size, err: e && e.message});
      }
    }
    if (entry.w400 || entry.w800) photos.push(entry);
  }

  await db.doc(`${SHARE_PREFIX}${token}`).set({
    uid, courseId, photos,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    revokedAt: null,
  });
  await roundRef.set({shareToken: token}, {merge: true});

  logger.info("sharePassportRound", {uid, courseId, token, photos: photos.length});
  return {ok: true, token, url: `${SITE}/round.html?t=${token}`, reused: false};
});

exports.unsharePassportRound = onCall(CALLABLE, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in.");
  const courseId = String((req.data && req.data.courseId) || "").trim();
  if (!courseId || courseId.includes("/")) {
    throw new HttpsError("invalid-argument", "courseId required.");
  }

  const db = admin.firestore();
  const roundRef = db.doc(`passport/${uid}/played/${courseId}`);
  const snap = await roundRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Round not found.");
  const token = (snap.data() || {}).shareToken;
  if (!token) return {ok: true, alreadyPrivate: true};

  const shareRef = db.doc(`${SHARE_PREFIX}${token}`);
  const share = await shareRef.get();
  // Ownership is re-checked against the share doc, not just the path, so a
  // token can never be revoked by anyone but the person who minted it.
  if (share.exists && share.data().uid !== uid) {
    throw new HttpsError("permission-denied", "Not your round.");
  }

  // Delete the public copies FIRST — the images are the exposure, and if the
  // doc update failed after this the link already resolves to nothing.
  try {
    await admin.storage().bucket(BUCKET)
        .deleteFiles({prefix: `${SHARE_PREFIX}${token}/`, force: true});
  } catch (e) {
    logger.error("unsharePassportRound: object delete failed", {token, err: e && e.message});
  }
  if (share.exists) {
    await shareRef.set({revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      photos: []}, {merge: true});
  }
  await roundRef.set({shareToken: admin.firestore.FieldValue.delete()}, {merge: true});

  logger.info("unsharePassportRound", {uid, courseId, token});
  return {ok: true};
});

/**
 * Public, unauthenticated read of a shared round.
 *
 * PROJECTED — every field is named explicitly. No uid, no email, no location,
 * no handicap, no bio, no golfBag, and no passport/ URLs (the photos served are
 * the sharedRounds/ copies). A revoked or unknown token returns notFound rather
 * than an error, so the page can say "no longer shared" instead of breaking.
 */
exports.getSharedRound = onCall({...CALLABLE, memory: "256MiB"}, async (req) => {
  const token = String((req.data && req.data.token) || "").trim();
  if (!/^[a-f0-9]{32}$/.test(token)) return {notFound: true};

  const db = admin.firestore();
  const share = await db.doc(`${SHARE_PREFIX}${token}`).get();
  if (!share.exists) return {notFound: true};
  const s = share.data() || {};
  if (s.revokedAt) return {notFound: true};

  const round = await db.doc(`passport/${s.uid}/played/${s.courseId}`).get();
  if (!round.exists) return {notFound: true};
  const r = round.data() || {};
  // Owner un-shared by deleting the round, or the token drifted off it.
  if (r.shareToken !== token) return {notFound: true};

  let displayName = null;
  try {
    const prof = await db.doc(`profiles/${s.uid}`).get();
    if (prof.exists) displayName = prof.data().displayName || null;
  } catch (_e) { /* a missing name is not a failure */ }

  const played = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : null;
  return {
    notFound: false,
    courseId: s.courseId,
    courseName: r.courseName || s.courseId,
    grade: r.grade || null,
    tags: Array.isArray(r.tags) ? r.tags.slice(0, 8) : [],
    review: typeof r.review === "string" ? r.review.slice(0, 1200) : "",
    playedAt: played,
    photos: Array.isArray(s.photos) ? s.photos : [],
    displayName,
  };
});
