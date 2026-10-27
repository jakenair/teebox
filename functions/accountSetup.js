// functions/accountSetup.js
//
// completeAccountSetup (callable) — IDEMPOTENT server-side finish for a new
// email/password account. Replaces the client-side tail of sign-up
// (updateProfile → users doc → profiles doc → verification email), which
// was skipped whenever the browser's createUser call timed out on a slow
// network (2026-10-19 Slow-3G walk: the SDK gives up at 30 s, the server
// creates the account ~30–45 s later, and the user is left with no display
// name, no users/{uid} doc and no verification email).
//
// Safe to call any number of times, from sign-up AND from every later
// sign-in: each step checks before it writes.
//   data: { displayName?: string }
//   returns: { ok, displayNameSet, userDocCreated, profileDocCreated,
//              verificationEmail: 'sent' | 'skipped-verified' | 'skipped-recent' | 'skipped-no-email' | 'error' }

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {sendEmail, CATEGORIES, RESEND_API_KEY, UNSUBSCRIBE_SECRET} = require("./lib/email");

const USER_CALLABLE = {region: "us-central1", memory: "256MiB", timeoutSeconds: 30, concurrency: 80, maxInstances: 100};
const APP_URL = "https://teeboxmarket.com";
const AUTH_ACTION_CODE_SETTINGS = {url: `${APP_URL}/?launch=auth`, handleCodeInApp: false}; // = index.js AUTH_CONTINUE_URL
const VERIFY_EMAIL_COOLDOWN_MS = 10 * 60 * 1000;
const RESERVED_NAMES = /^(admin|administrator|teebox|teebox\s*market|support|moderator|mod|staff|official)$/i;

function loadTemplate(category, name) {
  try { return require(`./emails-build/${category}/${name}`); } catch (e1) {
    try { return require(`./emails/${category}/${name}`); } catch (e2) { logger.warn(`[accountSetup] template ${category}/${name} not loaded`, e2.message); return null; }
  }
}

async function cleanName(raw, uid) {
  const name = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (name.length < 2) return null;
  if (RESERVED_NAMES.test(name)) return null;
  try {
    const {scanFields} = require("./moderation/contentFilter");
    const r = await scanFields({displayName: name}, "profile", uid, null);
    if (r && r.clean === false) return null;
  } catch (e) { logger.warn("[accountSetup] name scan failed open", e && e.message); }
  return name;
}

// Exported for reuse by other producers; never throws.
async function sendVerificationEmailOnce(uid) {
  const db = admin.firestore();
  let authUser;
  try { authUser = await admin.auth().getUser(uid); } catch (_) { return "error"; }
  if (!authUser.email) return "skipped-no-email";
  if (authUser.emailVerified) return "skipped-verified";
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get().catch(() => null);
  const last = snap && snap.exists && snap.data().verificationEmailSentAt;
  if (last && last.toMillis && Date.now() - last.toMillis() < VERIFY_EMAIL_COOLDOWN_MS) return "skipped-recent";
  try {
    const verificationUrl = await admin.auth().generateEmailVerificationLink(authUser.email, AUTH_ACTION_CODE_SETTINGS);
    const Tpl = loadTemplate("security", "EmailVerification");
    const ctx = {user: {uid, email: authUser.email, firstName: (authUser.displayName || "").split(" ")[0] || "", displayName: authUser.displayName || ""}, verificationUrl};
    const res = await sendEmail({
      to: authUser.email, uid,
      subject: (Tpl && Tpl.subject) ? Tpl.subject(ctx) : "Verify your TeeBox email",
      react: Tpl ? Tpl(ctx) : null,
      html: Tpl ? null : `<p>Verify your TeeBox email: <a href="${verificationUrl}">${verificationUrl}</a></p>`,
      category: CATEGORIES.TRANSACTIONAL, template: "EmailVerification",
    });
    await ref.set({verificationEmailSentAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true}).catch(() => {});
    return (res && (res.sent || res.id)) ? "sent" : "error";
  } catch (e) {
    logger.error("[accountSetup] verification email failed", e && e.message);
    return "error";
  }
}

exports.completeAccountSetup = onCall({...USER_CALLABLE, secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET]}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const db = admin.firestore();
  const out = {ok: true, displayNameSet: false, userDocCreated: false, profileDocCreated: false, verificationEmail: "skipped"};
  const authUser = await admin.auth().getUser(uid);
  const wanted = await cleanName(request.data && request.data.displayName, uid);

  // 1. Auth displayName — only fill a BLANK one (never overwrite a name the
  //    user set elsewhere; the name gate / updateProfile own edits).
  let effectiveName = (authUser.displayName || "").trim();
  if (!effectiveName && wanted) {
    await admin.auth().updateUser(uid, {displayName: wanted});
    effectiveName = wanted; out.displayNameSet = true;
  }

  // 2. users/{uid} — create if missing; fill displayName if blank.
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({...(effectiveName ? {displayName: effectiveName} : {}), createdAt: admin.firestore.FieldValue.serverTimestamp(), accountSetupAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    out.userDocCreated = true;
  } else if (effectiveName && !(userSnap.data().displayName || "").trim()) {
    await userRef.set({displayName: effectiveName}, {merge: true});
  }

  // 3. profiles/{uid} — the public doc every render site reads.
  const profRef = db.collection("profiles").doc(uid);
  const profSnap = await profRef.get();
  if (!profSnap.exists) {
    await profRef.set({...(effectiveName ? {displayName: effectiveName} : {}), createdAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    out.profileDocCreated = true;
  } else if (effectiveName && !(profSnap.data().displayName || "").trim()) {
    await profRef.set({displayName: effectiveName}, {merge: true});
  }

  // 4. Verification email — once per 10 min, never when already verified.
  out.verificationEmail = await sendVerificationEmailOnce(uid);
  logger.info(`[accountSetup] ${uid}`, out);
  return out;
});

exports.__accountSetupLoaded = true;
module.exports.sendVerificationEmailOnce = sendVerificationEmailOnce;
