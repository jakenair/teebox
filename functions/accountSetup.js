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

// users/{uid}.createdAt value: the Auth record's creationTime, falling back
// to the server clock only if Auth somehow has none.
function authCreatedAtTs(authUser) {
  const ct = authUser && authUser.metadata && authUser.metadata.creationTime;
  const ms = ct ? Date.parse(ct) : NaN;
  return isNaN(ms) ? admin.firestore.FieldValue.serverTimestamp() :
    admin.firestore.Timestamp.fromMillis(ms);
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
  //    createdAt = Firebase Auth metadata.creationTime (the account's real
  //    age; sendMessage's new-account rules key off it). Filled whenever it
  //    is missing, so a doc the client bootstrapped first still gets it.
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const createdAt = authCreatedAtTs(authUser);
  if (!userSnap.exists) {
    await userRef.set({...(effectiveName ? {displayName: effectiveName} : {}), createdAt, accountSetupAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    out.userDocCreated = true;
  } else {
    const ud = userSnap.data() || {};
    const patch = {};
    if (effectiveName && !(ud.displayName || "").trim()) patch.displayName = effectiveName;
    if (!ud.createdAt) patch.createdAt = createdAt;
    if (Object.keys(patch).length) await userRef.set(patch, {merge: true});
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

// setAccountEmail (callable) — 2.6.1. A Facebook sign-in can arrive with NO
// email (phone-only Facebook account, or the user declined the email
// permission). Order/sale/shipping emails need one, so the client prompts
// right after sign-in and calls this. Only for accounts that have no email
// yet (changing an existing address stays a support task: it would need
// re-verification of the old one and touches Stripe/receipts).
//   data: { email: string }
//   returns: { ok, verificationEmail }
// Enumeration protection is ON for this project, so the client SDK's
// updateEmail is unavailable — this is the admin-side equivalent. The
// address is stored UNVERIFIED and the branded verification email goes
// out through sendVerificationEmailOnce; nothing is sent to it until the
// user clicks that link (emailVerifiedLive gates elsewhere).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
exports.setAccountEmail = onCall({...USER_CALLABLE, secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET]}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const email = String((request.data && request.data.email) || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpsError("invalid-argument", "Enter a valid email address.");
  const authUser = await admin.auth().getUser(uid);
  if (authUser.email) {
    if (authUser.email.toLowerCase() === email) return {ok: true, verificationEmail: await sendVerificationEmailOnce(uid)};
    throw new HttpsError("failed-precondition", "This account already has an email. Contact support@teeboxmarket.com to change it.");
  }
  try {
    await admin.auth().updateUser(uid, {email, emailVerified: false});
  } catch (e) {
    if (e && /email-already-exists/.test(String(e.code))) {
      throw new HttpsError("already-exists", "That email already belongs to another TeeBox account. Sign in to that account and connect Facebook from Account \u2192 Connected sign-in methods.");
    }
    logger.error("[setAccountEmail] updateUser failed", {uid, code: e && e.code, message: e && e.message});
    throw new HttpsError("internal", "Could not save that email. Try again.");
  }
  await admin.firestore().collection("users").doc(uid).set({emailAddedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true}).catch(() => {});
  const verificationEmail = await sendVerificationEmailOnce(uid);
  logger.info(`[setAccountEmail] ${uid}`, {verificationEmail});
  return {ok: true, verificationEmail};
});

exports.__accountSetupLoaded = true;
module.exports.sendVerificationEmailOnce = sendVerificationEmailOnce;
