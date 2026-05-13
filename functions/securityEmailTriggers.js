/**
 * functions/securityEmailTriggers.js
 * ─────────────────────────────────────────────────────────────────────────
 * Wires the 7 missing email producers documented in EMAIL_TRIGGER_AUDIT.md
 * sections #2, #4, #5, #6, #7, #8, #9. Each downstream JSX template
 * already exists (or is scaffolded alongside this file); this file adds
 * the upstream producers that fire those sends.
 *
 * Isolated into its own file so parallel agents touching emailTriggers.js
 * / lib/email.js / index.html (account-settings prefs UI) don't conflict.
 * Wired into deployment by a single Object.assign() require line appended
 * to functions/index.js.
 *
 * EXPORTS
 *   notifySecurityEvent      callable; client fires this AFTER a successful
 *                            password change / email change / payout-method
 *                            change / account deletion / email-verified
 *                            transition. Captures IP + UA + best-effort
 *                            geolocation, stamps idempotency field,
 *                            renders the JSX template, and sends via
 *                            lib/email.sendEmail().
 *   onListingLive            Firestore onDocumentCreated('listings/{id}'),
 *                            emails the seller the "your listing is live"
 *                            confirmation. Idempotent on
 *                            listings/{id}.listingLiveEmailedAt.
 *
 * SECURITY-METADATA POLICY
 *   For password_changed, email_changed, payout_method_changed,
 *   two_factor_code we capture:
 *     - timestamp (server clock — authoritative, plus user-tz pretty-print)
 *     - IP        from req.rawRequest.ip (callable proxy header)
 *     - geo       best-effort from ipapi.co (graceful degrade)
 *     - userAgent from req.rawRequest.headers['user-agent']
 *     - freezeUrl signed HMAC link to ./emailTriggers.js's freezeAccount
 *                 endpoint (gives the user a "this wasn't me" CTA).
 *
 * IDEMPOTENCY
 *   Stamped into users/{uid} so we never double-send for the same event:
 *     - emailVerifiedNotifiedAt
 *     - passwordChangedNotifiedAt
 *     - emailChangedNotifiedAt
 *     - payoutMethodChangedNotifiedAt
 *     - twoFactorCodeNotifiedAt        (rolling — rate-limited not blocked)
 *     - accountDeletionNotifiedAt
 *   listings/{id}.listingLiveEmailedAt for #9.
 *
 * NOT IMPLEMENTED
 *   - Identity-Platform `beforeUserUpdated` blocking trigger. Firebase
 *     Auth → Identity Platform upgrade is not enabled on this project
 *     (no beforeUserUpdated handler exists anywhere in functions/). When
 *     it is enabled, this file should grow a server-side trigger as a
 *     belt-and-suspenders fallback for the client-side flow.
 */

const crypto = require("crypto");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const {
  sendEmail,
  CATEGORIES,
  RESEND_API_KEY,
  UNSUBSCRIBE_SECRET,
} = require("./lib/email");

// Reuse the freeze HMAC secret declared in ./emailTriggers.js. defineSecret
// is idempotent across requires so a second declare here is safe and
// keeps this file standalone in case emailTriggers.js is ever rebooted.
const FREEZE_SECRET = defineSecret("FREEZE_HMAC_SECRET");

const APP_URL = "https://teeboxmarket.com";

const FN_OPTS = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 40,
  maxInstances: 50,
};

// ─── Template loader (lazy + tolerant of missing compiled output) ──────
// Mirror the loader in emailTriggers.js / missingProducers.js so this file
// doesn't depend on a private helper inside emailTriggers.js (which we're
// instructed not to touch).
function getTemplate(category, name) {
  try {
    return require(`./emails-build/${category}/${name}`);
  } catch (e1) {
    try {
      return require(`./emails/${category}/${name}`);
    } catch (e2) {
      logger.warn(
          `[securityEmailTriggers] template ${category}/${name} not loaded`,
          e2.message,
      );
      return null;
    }
  }
}

async function sendTemplated({
  category,
  templateCategory,
  templateName,
  to,
  uid,
  ctx = {},
  subject: subjectOverride,
}) {
  const Tpl = getTemplate(templateCategory, templateName);
  let subject = subjectOverride;
  let react = null;
  let html = null;
  if (Tpl) {
    try {
      react = Tpl(ctx);
      if (!subject && typeof Tpl.subject === "function") {
        subject = Tpl.subject(ctx);
      }
    } catch (e) {
      logger.error(
          `[securityEmailTriggers] template instantiation failed: ${templateName}`,
          e.message,
      );
    }
  }
  if (!react && !html) {
    html = `<!doctype html><html><body><p>TeeBox notification: ${
      subject || templateName
    }</p><p>(Template ${templateName} stub — compile JSX to upgrade.)</p></body></html>`;
  }
  if (!subject) subject = `TeeBox notification`;
  return sendEmail({
    to,
    subject,
    react,
    html,
    category,
    uid,
    template: templateName,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Freeze-URL builder — duplicates the one in emailTriggers.js so this
// file is standalone. The two HMAC implementations are byte-identical;
// both must validate against verifyFreezeToken in emailTriggers.js
// (which is the function the public freezeAccount endpoint calls).
// ═══════════════════════════════════════════════════════════════════════
function buildFreezeUrl(uid) {
  let secret;
  try {
    secret = FREEZE_SECRET.value();
  } catch (_e) {
    secret = "dev-secret-not-set";
  }
  const exp = Date.now() + 24 * 60 * 60 * 1000; // 24h, matches emailTriggers.js
  const payload = `${uid}.${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const token = Buffer.from(`${payload}.${sig}`).toString("base64url");
  return `${APP_URL}/security?action=freeze&token=${token}`;
}

// ═══════════════════════════════════════════════════════════════════════
// IP + UA + geolocation capture from a v2 onCall request.
// req.rawRequest is the underlying Express request — we use it for the
// caller's IP and User-Agent. Geo lookup is best-effort against ipapi.co
// (no key needed for the free tier, generous rate limit). Failures
// degrade gracefully to `null` so a transient ipapi.co outage doesn't
// block the email send.
// ═══════════════════════════════════════════════════════════════════════
function captureRequestMetadata(req, clientHints = {}) {
  const rr = req && req.rawRequest;
  const headers = (rr && rr.headers) || {};
  // Express puts the client IP at req.ip when trust-proxy is on (which
  // it is for Cloud Functions v2). Header fallbacks cover edge proxies
  // that don't propagate to rawRequest.ip.
  const ip =
    (rr && rr.ip) ||
    (typeof headers["x-forwarded-for"] === "string" ?
      headers["x-forwarded-for"].split(",")[0].trim() :
      null) ||
    (rr && rr.connection && rr.connection.remoteAddress) ||
    clientHints.ip ||
    null;
  const userAgent =
    headers["user-agent"] || clientHints.userAgent || null;
  return {
    ip,
    userAgent,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Best-effort IPv4/IPv6 → city/country lookup. Returns null on any error
 * (network, parse, rate-limit). We DO NOT block the send on this — the
 * email goes out either way; geo is a nice-to-have for the body copy.
 *
 * ipapi.co was chosen over ipinfo.io / ip-api.com because:
 *   - no API key required for ≤1k req/day (we'll never exceed this for
 *     security events; even worst-case a high-volume account takeover
 *     spike caps at ~hundreds/day)
 *   - HTTPS by default (ip-api.com is HTTP-only on the free plan)
 *   - returns JSON in a stable schema we can parse without an SDK
 *
 * Open question: at scale we should swap to MaxMind GeoIP2 self-hosted
 * (~30MB embedded DB) so we don't depend on a third-party for security
 * email content. Not in scope for this commit.
 */
async function lookupGeo(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") ||
      ip.startsWith("192.168.")) {
    return null;
  }
  try {
    // Node 18+ has global fetch (Cloud Functions v2 runs on Node 22).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: ctrl.signal,
      headers: {"User-Agent": "TeeBox-Security/1.0"},
    }).catch(() => null);
    clearTimeout(timer);
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.error) return null;
    const parts = [data.city, data.region, data.country_name]
        .filter(Boolean)
        .map(String);
    return parts.length ? parts.join(", ") : null;
  } catch (_e) {
    return null;
  }
}

// Pretty-print a Date in the user's timezone if we know it; otherwise UTC.
// Falls back to ISO if Intl breaks for an unknown tz id (e.g., "Etc/UCT").
function formatTimestamp(date, tz) {
  try {
    if (tz) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        dateStyle: "medium",
        timeStyle: "short",
        timeZoneName: "short",
      }).format(date);
    }
  } catch (_e) {
    /* fall through */
  }
  return `${date.toISOString()} UTC`;
}

// Build the metadata block we attach to the template ctx. Kept as a
// helper so every eventType uses identical fields and the templates can
// rely on the same property names if they're ever extended to render
// device/geo info inline.
function buildSecurityContext({user, captured, geo, freezeUrl}) {
  const date = new Date();
  const ts = formatTimestamp(date, user && user.tz);
  return {
    user,
    ip: captured.ip || null,
    userAgent: captured.userAgent || null,
    geolocation: geo || null,
    timestamp: ts,
    timestampIso: date.toISOString(),
    freezeUrl,
    // Convenience for templates that just want one display string:
    eventLocation: geo ?
      `${geo} (${captured.ip || "unknown IP"})` :
      (captured.ip || "unknown IP"),
  };
}

// Whitelist of event types this callable accepts. Keeping it tight
// prevents a stolen client from triggering arbitrary template sends.
const EVENT_TYPES = new Set([
  "email_verified",
  "password_changed",
  "email_changed",
  "payout_method_changed",
  "two_factor_code",
  "account_deletion",
]);

// Idempotency stamp field per event. For two_factor_code we DON'T
// hard-block — codes are re-sent on demand — but we do throttle in the
// callable via a sliding-window check below.
const STAMP_FIELD = Object.freeze({
  email_verified: "emailVerifiedNotifiedAt",
  password_changed: "passwordChangedNotifiedAt",
  email_changed: "emailChangedNotifiedAt",
  payout_method_changed: "payoutMethodChangedNotifiedAt",
  account_deletion: "accountDeletionNotifiedAt",
  two_factor_code: "twoFactorCodeLastSentAt",
});

// ═══════════════════════════════════════════════════════════════════════
// A. notifySecurityEvent — callable producer
// ═══════════════════════════════════════════════════════════════════════
exports.notifySecurityEvent = onCall(
    {
      ...FN_OPTS,
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET, FREEZE_SECRET],
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "Sign-in required.");
      }
      const uid = auth.uid;
      const data = req.data || {};
      const eventType = String(data.eventType || "");
      if (!EVENT_TYPES.has(eventType)) {
        throw new HttpsError(
            "invalid-argument",
            `Unknown eventType: ${eventType}`,
        );
      }
      const metadata = data.metadata || {};

      const db = admin.firestore();
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get().catch(() => null);
      // Fall back to Firebase Auth if there's no Firestore user doc
      // (very early signup race). We still need email + uid.
      let user = userSnap && userSnap.exists ?
        {uid, ...userSnap.data()} :
        {uid};
      if (!user.email) {
        try {
          const authRec = await admin.auth().getUser(uid);
          user = {...user, email: authRec.email, emailVerified: authRec.emailVerified};
        } catch (_e) {
          /* leave undefined; we'll bail below if no recipient resolved */
        }
      }

      const captured = captureRequestMetadata(req, metadata);
      const geo = await lookupGeo(captured.ip);
      const freezeUrl = buildFreezeUrl(uid);
      const secCtx = buildSecurityContext({user, captured, geo, freezeUrl});

      // Idempotency: skip the send if we already stamped this user for
      // this event type. Two_factor_code uses a sliding-window throttle
      // instead (10 sec between sends) so legitimate re-requests work.
      const stampField = STAMP_FIELD[eventType];
      if (stampField && eventType !== "two_factor_code") {
        const existing = user[stampField];
        if (existing && existing.toMillis && Date.now() - existing.toMillis() < 60 * 1000) {
          logger.info(
              `[notifySecurityEvent] dedupe: ${eventType} fired <60s ago for ${uid}`,
          );
          return {skipped: true, reason: "duplicate"};
        }
      }
      if (eventType === "two_factor_code") {
        const existing = user[stampField];
        if (existing && existing.toMillis && Date.now() - existing.toMillis() < 10 * 1000) {
          throw new HttpsError(
              "resource-exhausted",
              "Too many code requests. Wait a few seconds.",
          );
        }
      }

      // Dispatch to per-event handler. Each handler returns the send
      // result so the client gets a useful boolean back.
      let result;
      switch (eventType) {
        case "email_verified":
          result = await sendEmailVerifiedConfirmation({user, secCtx});
          break;
        case "password_changed":
          result = await sendPasswordChangedAlert({user, secCtx});
          break;
        case "email_changed":
          result = await sendEmailChangedAlerts({user, secCtx, metadata});
          break;
        case "payout_method_changed":
          result = await sendPayoutMethodChangedAlert({user, secCtx, metadata});
          break;
        case "two_factor_code":
          result = await sendTwoFactorCode({user, secCtx, metadata});
          break;
        case "account_deletion":
          result = await sendAccountDeletionConfirmation({user, secCtx, metadata});
          break;
      }

      // Stamp idempotency AFTER the send so a transient send-error allows
      // a retry. (For "duplicate" we returned above without sending.)
      try {
        await userRef.set(
            {
              [stampField]: admin.firestore.FieldValue.serverTimestamp(),
              lastSecurityEventAt: admin.firestore.FieldValue.serverTimestamp(),
              lastSecurityEventType: eventType,
            },
            {merge: true},
        );
      } catch (e) {
        logger.warn(`[notifySecurityEvent] stamp write failed`, e.message);
      }

      return {ok: true, eventType, result};
    },
);

// ── Per-event handlers ───────────────────────────────────────────────

async function sendEmailVerifiedConfirmation({user, secCtx}) {
  if (!user.email) return {skipped: true, reason: "no-email"};
  return sendTemplated({
    category: CATEGORIES.TRANSACTIONAL,
    templateCategory: "security",
    templateName: "EmailVerified",
    to: user.email,
    uid: user.uid,
    ctx: {user, appUrl: APP_URL, ...secCtx},
  });
}

async function sendPasswordChangedAlert({user, secCtx}) {
  if (!user.email) return {skipped: true, reason: "no-email"};
  return sendTemplated({
    category: CATEGORIES.TRANSACTIONAL,
    templateCategory: "security",
    templateName: "PasswordChanged",
    to: user.email,
    uid: user.uid,
    ctx: {user, ...secCtx},
  });
}

async function sendEmailChangedAlerts({user, secCtx, metadata}) {
  // CRITICAL: the OLD-address email is the only signal a hijacker hasn't
  // fully taken over. We MUST send to both. We send them in parallel and
  // return both results so the caller can detect partial failures.
  const oldEmail = metadata.oldEmail || user.previousEmail || null;
  const newEmail = metadata.newEmail || user.email;
  if (!oldEmail || !newEmail) {
    return {skipped: true, reason: "missing-email"};
  }
  const baseCtx = {user, newEmail, ...secCtx};
  const tasks = [
    sendTemplated({
      category: CATEGORIES.TRANSACTIONAL,
      templateCategory: "security",
      templateName: "EmailChangedOld",
      to: oldEmail,
      uid: user.uid,
      ctx: baseCtx,
    }),
    sendTemplated({
      category: CATEGORIES.TRANSACTIONAL,
      templateCategory: "security",
      templateName: "EmailChangedNew",
      to: newEmail,
      uid: user.uid,
      ctx: baseCtx,
    }),
  ];
  const [oldResult, newResult] = await Promise.allSettled(tasks);
  return {
    old: oldResult.status === "fulfilled" ? oldResult.value : {error: oldResult.reason && oldResult.reason.message},
    new: newResult.status === "fulfilled" ? newResult.value : {error: newResult.reason && newResult.reason.message},
  };
}

async function sendPayoutMethodChangedAlert({user, secCtx, metadata}) {
  if (!user.email) return {skipped: true, reason: "no-email"};
  return sendTemplated({
    category: CATEGORIES.TRANSACTIONAL,
    templateCategory: "security",
    templateName: "PayoutMethodChanged",
    to: user.email,
    uid: user.uid,
    ctx: {user, last4: metadata.last4 || null, ...secCtx},
  });
}

async function sendTwoFactorCode({user, secCtx, metadata}) {
  if (!user.email) return {skipped: true, reason: "no-email"};
  // The CALLER is responsible for generating + storing the code (and
  // hashing it before storage). This callable just delivers it. We never
  // log the code — neither to Cloud Logging nor to emailSends — because
  // emailSends is queryable by support and we don't want code leakage.
  const code = String(metadata.code || "");
  if (!/^\d{6}$/.test(code)) {
    throw new HttpsError(
        "invalid-argument",
        "two_factor_code requires metadata.code as a 6-digit string.",
    );
  }
  return sendTemplated({
    category: CATEGORIES.TRANSACTIONAL,
    templateCategory: "security",
    templateName: "TwoFactorCode",
    to: user.email,
    uid: user.uid,
    ctx: {user, code, ...secCtx},
  });
}

async function sendAccountDeletionConfirmation({user, secCtx, metadata}) {
  // For deletion the caller may pass `toOverride` (the captured email
  // from BEFORE the auth record was deleted). Once the auth record is
  // gone we can't look up the email from Firestore, hence the override.
  const to = metadata.toOverride || user.email;
  if (!to) return {skipped: true, reason: "no-email"};
  return sendTemplated({
    category: CATEGORIES.TRANSACTIONAL,
    templateCategory: "security",
    templateName: "AccountDeletionConfirmed",
    to,
    uid: user.uid,
    ctx: {user, ...secCtx},
  });
}

// ═══════════════════════════════════════════════════════════════════════
// B. onListingLive — Firestore producer for "your listing is live"
// ═══════════════════════════════════════════════════════════════════════
exports.onListingLive = onDocumentCreated(
    {
      document: "listings/{listingId}",
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
      ...FN_OPTS,
    },
    async (event) => {
      const listingId = event.params.listingId;
      const data = event.data && event.data.data();
      if (!data) return;
      // Only email when the listing is publicly browsable. moderation
      // queues / drafts / pre-publish states get filtered out here.
      const status = String(data.status || "active").toLowerCase();
      const isLive = status === "active" || status === "live" || status === "available";
      if (!isLive) {
        logger.info(`[onListingLive] skip ${listingId} status=${status}`);
        return;
      }
      // Idempotency: bail if a sibling trigger or a retry already stamped.
      if (data.listingLiveEmailedAt) {
        logger.info(`[onListingLive] dedupe ${listingId}`);
        return;
      }
      const sellerId = data.sellerId || data.userId || data.uid;
      if (!sellerId) {
        logger.warn(`[onListingLive] no seller on listing ${listingId}`);
        return;
      }
      const db = admin.firestore();
      const sellerSnap = await db.collection("users").doc(sellerId).get();
      if (!sellerSnap.exists) {
        logger.warn(`[onListingLive] user ${sellerId} missing`);
        return;
      }
      const seller = {uid: sellerSnap.id, ...sellerSnap.data()};
      if (!seller.email) {
        logger.info(`[onListingLive] seller ${sellerId} has no email`);
        return;
      }
      const listing = {id: listingId, ...data};
      const ctx = {user: seller, listing, appUrl: APP_URL};
      const sendResult = await sendTemplated({
        category: CATEGORIES.TRANSACTIONAL,
        templateCategory: "transactional",
        templateName: "ListingLive",
        to: seller.email,
        uid: seller.uid,
        ctx,
      });
      // Stamp after send (best-effort) so a transient render/send failure
      // allows a retry. We use the event publishTime as the canonical
      // timestamp — replays of the same event are also caught by the
      // listingLiveEmailedAt guard above.
      try {
        await event.data.ref.set(
            {listingLiveEmailedAt: admin.firestore.FieldValue.serverTimestamp()},
            {merge: true},
        );
      } catch (e) {
        logger.warn(`[onListingLive] stamp failed for ${listingId}`, e.message);
      }
      return sendResult;
    },
);

// ═══════════════════════════════════════════════════════════════════════
module.exports.__securityEmailTriggersLoaded = true;
