/**
 * functions/sellerInviteCampaign.js
 * ─────────────────────────────────────────────────────────────────────────
 * runSellerInviteCampaign — admin-only callable. One-shot "List 5 items,
 * get featured" push to recently-active accounts that have never listed.
 *
 * SAFE BY DEFAULT. dryRun is true unless the caller passes dryRun:false.
 * A dry run touches nothing and returns a histogram of why each account is
 * or is not eligible, including how many are excluded ONLY by the marketing
 * consent gate, so the opt-in-vs-opt-out policy call can be made on a
 * number rather than a guess.
 *
 * A live run sends through sendEmail() in lib/email.js, which re-applies
 * suppression + consent + per-category opt-out on its own. This module never
 * bypasses that gate; its own classification exists so the dry run can
 * REPORT the gate's effect without sending. Each successful send stamps
 * users/{uid}.sellerInviteSentAt, so a re-run is resumable and idempotent,
 * and a call sends at most `limit` emails.
 *
 * Cohort comes from Firebase Auth (lastSignInTime), not users.lastActiveAt:
 * the client never writes lastActiveAt (grep index.html), so the winBack
 * query pattern would return nothing.
 *
 * Returns aggregates only. No email address, name or uid leaves the function.
 *
 * Input:  { dryRun?: boolean = true, activeDays?: number = 30, limit?: number = 50 }
 * Output: { dryRun, activeDays, scanned, reasons: {reason: n}, eligible,
 *           eligibleIfNoConsentGate, sent, skipped, errors, remaining }
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {sendEmail, CATEGORIES, RESEND_API_KEY, UNSUBSCRIBE_SECRET} =
  require("./lib/email");

const ADMIN_ALLOWLIST = defineSecret("ADMIN_ALLOWLIST");

const FN = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 540,
  concurrency: 1,
  maxInstances: 1,
};

const TEMPLATE = "SellerInvite";
const CAMPAIGN_TAG = "seller_invite_2026_10";
const SENT_FLAG = "sellerInviteSentAt";
const DEFAULT_ACTIVE_DAYS = 30;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const REPLY_TO = "support@teeboxmarket.com";

const TEST_EMAIL_RE =
  /teeboxtest|teeboxmarket\.invalid|teeboxtest\.invalid|modtest-|smoke-test/i;

// Same parse as index.js getAdminList — duplicated rather than imported
// because index.js does not export it and requiring index.js from a sibling
// module would load every function at cold start.
let _adminList = null;
function adminEmails() {
  if (_adminList) return _adminList;
  let raw = "";
  try {
    raw = ADMIN_ALLOWLIST.value() || "";
  } catch (_e) {
    raw = "";
  }
  _adminList = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return _adminList;
}
function adminGate(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const email = (req.auth.token && req.auth.token.email) || "";
  const verified = !!(req.auth.token && req.auth.token.email_verified);
  if (!verified || !adminEmails().includes(String(email).toLowerCase())) {
    throw new HttpsError("permission-denied", "Admin only");
  }
}

function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "number") return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pure classifier. Returns the FIRST reason that excludes the account, or
 * "eligible". Order matters: cheap/structural reasons first, the consent
 * gate last, so `reasons["no-consent"]` is exactly "would have been sent
 * under an opt-out policy".
 *
 * @param {Object} authUser  {uid, email, emailVerified, metadata:{lastSignInTime}}
 * @param {Object|null} userDoc  users/{uid} data (may be null)
 * @param {Object} ctx  {sellerUids:Set, suppressedUids:Set, cutoffMs:number, nowMs:number}
 */
function classifyUser(authUser, userDoc, ctx) {
  const email = authUser && authUser.email;
  if (!email) return "no-email";
  if (TEST_EMAIL_RE.test(email)) return "test-email";
  if (!authUser.emailVerified) return "unverified";
  const last = toMs(authUser.metadata && (authUser.metadata.lastSignInTime ||
    authUser.metadata.lastRefreshTime));
  if (last < ctx.cutoffMs) return "inactive";
  if (ctx.sellerUids.has(authUser.uid)) return "seller";
  const d = userDoc || {};
  if (d[SENT_FLAG]) return "already-sent";
  if (ctx.suppressedUids.has(authUser.uid) || d.emailSuppressed === true) {
    return "suppressed";
  }
  if (d.emailPrefs && d.emailPrefs[CATEGORIES.PRODUCT_UPDATES] === false) {
    return "opted-out";
  }
  const pausedMs = toMs(d.marketingPausedUntil);
  if (pausedMs && pausedMs > ctx.nowMs) return "paused";
  if (!d.marketingConsent || d.marketingConsent.granted !== true) {
    return "no-consent";
  }
  return "eligible";
}

function loadTemplate() {
  try {
    return require(`./emails-build/lifecycle/${TEMPLATE}`);
  } catch (e) {
    logger.warn(`sellerInvite: compiled template missing (${e.message})`);
    return null;
  }
}

async function listAllUsers() {
  const out = [];
  let token;
  do {
    const r = await admin.auth().listUsers(1000, token);
    out.push(...r.users);
    token = r.pageToken;
  } while (token);
  return out;
}

exports.runSellerInviteCampaign = onCall(
    {...FN, secrets: [ADMIN_ALLOWLIST, RESEND_API_KEY, UNSUBSCRIBE_SECRET]},
    async (req) => {
      adminGate(req);
      const data = req.data || {};
      const dryRun = data.dryRun !== false; // anything but an explicit false
      const activeDays = Math.max(1, Math.min(365,
          Number(data.activeDays) || DEFAULT_ACTIVE_DAYS));
      const limit = Math.max(1, Math.min(MAX_LIMIT,
          Number(data.limit) || DEFAULT_LIMIT));
      const nowMs = Date.now();
      const cutoffMs = nowMs - activeDays * 86400000;
      const db = admin.firestore();

      // Cohort inputs. Three bulk reads, then everything is in memory.
      const [users, listingSnap, supSnap] = await Promise.all([
        listAllUsers(),
        db.collection("listings").select("sellerId").get(),
        db.collection("emailSuppressions").select().get(),
      ]);
      const sellerUids = new Set();
      listingSnap.docs.forEach((d) => {
        const sid = d.get("sellerId");
        if (sid) sellerUids.add(sid);
      });
      const suppressedUids = new Set(supSnap.docs.map((d) => d.id));

      // Only fetch users/{uid} for accounts that survive the Auth-only
      // checks — the doc is needed from "already-sent" onward.
      const ctx = {sellerUids, suppressedUids, cutoffMs, nowMs};
      const reasons = {};
      const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
      const needDoc = [];
      for (const u of users) {
        const pre = classifyUser(u, null, ctx);
        // With a null doc the classifier can only stop at the Auth-level
        // reasons or fall through to "no-consent"; anything else needs the doc.
        if (["no-email", "test-email", "unverified", "inactive", "seller"].includes(pre)) {
          bump(pre);
        } else {
          needDoc.push(u);
        }
      }
      const docs = new Map();
      for (let i = 0; i < needDoc.length; i += 300) {
        const chunk = needDoc.slice(i, i + 300);
        const refs = chunk.map((u) => db.collection("users").doc(u.uid));
        const snaps = await db.getAll(...refs);
        snaps.forEach((s) => docs.set(s.id, s.exists ? s.data() : null));
      }
      const eligible = [];
      for (const u of needDoc) {
        const r = classifyUser(u, docs.get(u.uid), ctx);
        bump(r);
        if (r === "eligible") eligible.push(u);
      }

      const result = {
        dryRun,
        activeDays,
        scanned: users.length,
        reasons,
        eligible: eligible.length,
        eligibleIfNoConsentGate: eligible.length + (reasons["no-consent"] || 0),
        sent: 0,
        skipped: 0,
        errors: 0,
        remaining: eligible.length,
      };

      if (!dryRun) {
        const Tpl = loadTemplate();
        const subject = (Tpl && typeof Tpl.subject === "function") ?
          Tpl.subject() : "List 5 items on TeeBox and we'll feature you";
        const batch = eligible.slice(0, limit);
        for (const u of batch) {
          let res;
          try {
            res = await sendEmail({
              to: u.email,
              subject,
              react: Tpl ? Tpl({user: {uid: u.uid}}) : null,
              html: Tpl ? null :
                `<!doctype html><html><body><p>${subject}</p></body></html>`,
              category: CATEGORIES.PRODUCT_UPDATES,
              uid: u.uid,
              template: TEMPLATE,
              replyTo: REPLY_TO,
              tags: [{name: "campaign", value: CAMPAIGN_TAG}],
              idempotencyKey: `seller-invite-${u.uid}`,
            });
          } catch (e) {
            res = {sent: false, error: e.message || String(e)};
          }
          if (res && res.sent) {
            result.sent++;
            await db.collection("users").doc(u.uid).set({
              [SENT_FLAG]: admin.firestore.FieldValue.serverTimestamp(),
            }, {merge: true}).catch(() => {});
          } else if (res && res.skipped) {
            result.skipped++;
          } else {
            result.errors++;
          }
        }
        result.remaining = Math.max(0, eligible.length - result.sent);
      }

      try {
        await db.collection("adminActions").add({
          adminUid: req.auth.uid,
          adminEmail: req.auth.token && req.auth.token.email,
          action: dryRun ? "sellerInviteCampaign.dryRun" : "sellerInviteCampaign.send",
          targetType: "campaign",
          targetId: CAMPAIGN_TAG,
          reason: "",
          metadata: result,
          performedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        logger.warn("sellerInviteCampaign: audit write failed", e.message);
      }
      logger.info("sellerInviteCampaign", result);
      return result;
    },
);

// Exported for unit tests.
exports._classifyUser = classifyUser;
exports._SENT_FLAG = SENT_FLAG;
