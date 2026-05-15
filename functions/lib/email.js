/**
 * functions/lib/email.js
 * ─────────────────────────────────────────────────────────────────────────
 * Central send helper for TeeBox transactional + lifecycle email.
 *
 * Primary ESP: Resend (https://resend.com). We picked Resend over Postmark
 * (simpler React Email integration, cheaper at our scale, better DX) and
 * over SES (no SPF/DKIM management burden, no warm-up). If Resend ever
 * fails us on deliverability we can swap to Postmark by changing this file
 * only — the rest of the codebase calls sendEmail() and never imports the
 * Resend SDK directly.
 *
 * USAGE
 *   const { sendEmail, makeUnsubscribeUrl } = require('./lib/email');
 *   await sendEmail({
 *     to: 'user@example.com',
 *     subject: 'Your order is on the way',
 *     react: OrderShipped({ order, buyer }),
 *     category: 'transactional',     // see CATEGORIES below
 *     uid: 'abc123',                  // required for unsubscribe link
 *     tags: [{ name: 'template', value: 'OrderShipped' }],
 *     headers: { 'X-Entity-Ref-ID': order.id },
 *   });
 *
 * Sends are no-ops in dev when RESEND_API_KEY isn't set (logs only).
 * Suppression list is honored automatically (hard bounces, complaints).
 */

const crypto = require("crypto");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

// Lazy require — React Email components and the resend client are heavy.
let _resendClient = null;
let _renderFn = null;

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const UNSUBSCRIBE_SECRET = defineSecret("UNSUBSCRIBE_HMAC_SECRET");

const FROM_NAME = "TeeBox";
// Separate transactional + marketing From addresses keeps the two
// reputation pools independent on the receiving side (Gmail Postmaster,
// Microsoft SNDS treat them as different identities). A bounce spike on
// marketing won't drag down transactional inboxing.
const FROM_ADDRESS = "noreply@mail.teeboxmarket.com";        // transactional
const FROM_ADDRESS_MARKETING = "hello@mail.teeboxmarket.com"; // marketing / Broadcasts
const FROM = `${FROM_NAME} <${FROM_ADDRESS}>`;
const FROM_MARKETING = `${FROM_NAME} <${FROM_ADDRESS_MARKETING}>`;
const REPLY_TO = "support@teeboxmarket.com";              // transactional
const REPLY_TO_MARKETING = "noreply@mail.teeboxmarket.com"; // marketing — no human reply expected
const COMPANY_NAME = "TeeBox, Inc.";
const COMPANY_ADDRESS = "16649 Oak Park Ave, Ste H #1160, Tinley Park, IL 60477, USA";
const BASE_URL = "https://teeboxmarket.com";
const UNSUBSCRIBE_BASE = `${BASE_URL}/unsubscribe.html`;

/**
 * Categories drive (a) the unsubscribe link in Base layout, (b) the
 * preference-center check before sending, (c) the Resend tag for reporting.
 * `transactional` is exempt from unsubscribe gating per CAN-SPAM 16 CFR 316.
 */
const CATEGORIES = Object.freeze({
  TRANSACTIONAL: "transactional",
  SAVED_SEARCH: "savedSearchMatches",
  PRICE_DROP: "priceDrops",
  ABANDONED_DRAFT: "abandonedDraft",
  ABANDONED_CART: "abandonedCart",
  REVIEW_REQUEST: "reviewRequests",
  WIN_BACK: "winBack",
  WEEKLY_DIGEST: "weeklyDigest",
  PRODUCT_UPDATES: "productUpdates",
});

const TRANSACTIONAL_CATEGORIES = new Set([CATEGORIES.TRANSACTIONAL]);

/**
 * Marketing categories — gated on GDPR-compliant affirmative consent
 * (users/{uid}.marketingConsent.granted === true). Adding a category here
 * makes it require opt-in; removing makes it transactional-equivalent
 * (don't do that without legal review).
 */
const MARKETING_CATEGORIES = new Set([
  CATEGORIES.SAVED_SEARCH,
  CATEGORIES.PRICE_DROP,
  CATEGORIES.ABANDONED_DRAFT,
  CATEGORIES.ABANDONED_CART,
  CATEGORIES.REVIEW_REQUEST,
  CATEGORIES.WIN_BACK,
  CATEGORIES.WEEKLY_DIGEST,
  CATEGORIES.PRODUCT_UPDATES,
]);

function isTransactional(category) {
  return TRANSACTIONAL_CATEGORIES.has(category);
}

function isMarketing(category) {
  return MARKETING_CATEGORIES.has(category);
}

/**
 * Build the signed one-click unsubscribe URL. Token = HMAC-SHA256 of
 * `${uid}.${category}.${expMs}` keyed on UNSUBSCRIBE_HMAC_SECRET.
 * 30-day validity matches our digest cadence + a margin for slow inboxes.
 */
function makeUnsubscribeUrl({uid, category}) {
  if (!uid || !category) return UNSUBSCRIBE_BASE;
  let secret;
  try {
    secret = UNSUBSCRIBE_SECRET.value();
  } catch (_e) {
    secret = "dev-secret-not-set";
  }
  const expMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `${uid}.${category}.${expMs}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const token = Buffer.from(`${payload}.${sig}`).toString("base64url");
  return `${UNSUBSCRIBE_BASE}?t=${token}`;
}

/**
 * Validate a token from the unsubscribe page. Returns { ok, uid, category }.
 * Side-effect free — caller decides what to do with the result.
 */
function verifyUnsubscribeToken(token) {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const parts = raw.split(".");
    if (parts.length !== 4) return {ok: false, error: "malformed"};
    const [uid, category, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) {
      return {ok: false, error: "expired"};
    }
    let secret;
    try {
      secret = UNSUBSCRIBE_SECRET.value();
    } catch (_e) {
      secret = "dev-secret-not-set";
    }
    const expected = crypto
        .createHmac("sha256", secret)
        .update(`${uid}.${category}.${expStr}`)
        .digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return {ok: false, error: "bad-signature"};
    }
    return {ok: true, uid, category};
  } catch (_e) {
    return {ok: false, error: "decode"};
  }
}

/** Lazy load Resend so cold-starts on non-email functions stay fast. */
function getResend() {
  if (_resendClient) return _resendClient;
  let key = null;
  try {
    key = RESEND_API_KEY.value();
  } catch (_e) {
    key = null;
  }
  if (!key) return null;
  const {Resend} = require("resend");
  _resendClient = new Resend(key);
  return _resendClient;
}

/** Lazy load @react-email/render. */
function getRender() {
  if (_renderFn) return _renderFn;
  try {
    const mod = require("@react-email/render");
    _renderFn = mod.render || mod.default;
  } catch (_e) {
    _renderFn = null;
  }
  return _renderFn;
}

/**
 * Check Firestore suppression + preference center + GDPR marketing consent.
 *
 * Order of checks:
 *   1. Transactional categories bypass everything (caller is responsible
 *      for not classifying marketing as transactional).
 *   2. emailSuppressions/{uid} doc → hard suppress (bounce/complaint).
 *   3. users/{uid}.emailSuppressed === true → user-requested suppression.
 *   4. Marketing categories require users/{uid}.marketingConsent.granted
 *      === true (GDPR Art. 6(1)(a) / Art. 7 affirmative opt-in). Missing
 *      consent field = no consent.
 *   5. emailPrefs[category] === false → per-category opt-out (lets a user
 *      keep marketing consent globally but unsubscribe from one channel).
 *
 * Returns { allowed: boolean, reason?: string }.
 */
async function preflightAllowed({uid, to, category}) {
  // Transactional bypasses prefs + consent. A hard-bounce-suppressed
  // address still gets transactional attempts; Resend's suppression
  // list catches them at the send layer if the bounce was theirs.
  // (Matches original behavior — change here would affect order
  // confirmation deliverability and isn't in scope for this commit.)
  if (isTransactional(category)) return {allowed: true};
  if (!uid) return {allowed: true}; // no uid, no prefs to check
  const db = admin.firestore();
  try {
    const supSnap = await db.collection("emailSuppressions").doc(uid).get();
    if (supSnap.exists) return {allowed: false, reason: "suppressed"};
  } catch (_e) {
    /* ignore — fail open on read error */
  }
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    const data = userSnap.exists ? userSnap.data() : {};
    if (data.emailSuppressed === true) {
      return {allowed: false, reason: "user-suppressed"};
    }
    // GDPR marketing-consent gate. Applies to all marketing categories.
    // Reason is dash-delimited to match the existing `skipped-${reason}`
    // status convention in recordSend (yields skipped-no-marketing-consent).
    if (isMarketing(category)) {
      const consent = data.marketingConsent;
      if (!consent || consent.granted !== true) {
        return {allowed: false, reason: "no-marketing-consent"};
      }
    }
    const prefs = data.emailPrefs || {};
    if (prefs[category] === false) {
      return {allowed: false, reason: "opted-out"};
    }
  } catch (_e) {
    /* fail open */
  }
  return {allowed: true};
}

/**
 * Log every send (and skip) to emailSends/ for the deliverability dashboard.
 * Caller doesn't have to await — best-effort write.
 */
async function recordSend({
  to,
  uid,
  category,
  template,
  status,
  resendId,
  error,
}) {
  try {
    const db = admin.firestore();
    await db.collection("emailSends").add({
      to,
      uid: uid || null,
      category: category || "unknown",
      template: template || "unknown",
      status,
      resendId: resendId || null,
      error: error || null,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn("recordSend failed", e.message || e);
  }
}

/**
 * Render a React Email component to {html, text}. Falls back to {html, ''}.
 */
async function renderTemplate(reactEl) {
  const render = getRender();
  if (!render || !reactEl) return {html: null, text: null};
  try {
    const html = await render(reactEl, {pretty: false});
    const text = await render(reactEl, {plainText: true});
    return {html, text};
  } catch (e) {
    logger.error("renderTemplate failed", e.message || e);
    return {html: null, text: null};
  }
}

/**
 * MAIN API
 *
 * @param {Object} opts
 * @param {string|string[]} opts.to        Recipient email(s).
 * @param {string} opts.subject            ≤ 50 chars enforced by reviewer.
 * @param {Object} [opts.react]            React Email element.
 * @param {string} [opts.html]             Raw HTML override.
 * @param {string} [opts.text]             Plain-text override.
 * @param {string} opts.category           One of CATEGORIES.
 * @param {string} [opts.uid]              User id for prefs + unsubscribe.
 * @param {string} [opts.template]         Template name for analytics.
 * @param {Array}  [opts.tags]             Resend tags (max 10).
 * @param {Object} [opts.headers]          Extra SMTP headers.
 * @param {string} [opts.replyTo]          Override default reply-to.
 */
async function sendEmail(opts) {
  const {
    to,
    subject,
    react,
    html: rawHtml,
    text: rawText,
    category = CATEGORIES.TRANSACTIONAL,
    uid,
    template,
    tags = [],
    headers = {},
    replyTo,
    idempotencyKey: explicitIdempotencyKey,
  } = opts || {};

  if (!to || !subject) {
    logger.warn("sendEmail: missing to/subject", {to, subject});
    return {skipped: true, reason: "missing-fields"};
  }

  // Pick From/Reply-To per category. Marketing uses a separate sending
  // identity to keep transactional reputation insulated.
  const isMarketingCat = isMarketing(category);
  const fromAddr = isMarketingCat ? FROM_MARKETING : FROM;
  const replyToAddr = replyTo || (isMarketingCat ? REPLY_TO_MARKETING : REPLY_TO);

  // Preference + suppression check.
  const gate = await preflightAllowed({uid, to, category});
  if (!gate.allowed) {
    logger.info(`sendEmail skipped (${gate.reason})`, {to, category, template});
    await recordSend({to, uid, category, template, status: `skipped-${gate.reason}`});
    return {skipped: true, reason: gate.reason};
  }

  // Render.
  let html = rawHtml || null;
  let text = rawText || null;
  if (react && (!html || !text)) {
    const out = await renderTemplate(react);
    html = html || out.html;
    text = text || out.text;
  }
  if (!html) {
    logger.warn("sendEmail: no html rendered", {template, subject});
    await recordSend({to, uid, category, template, status: "render-failed"});
    return {skipped: true, reason: "render-failed"};
  }

  const resend = getResend();
  if (!resend) {
    logger.info(
        `[email skipped] RESEND_API_KEY not set — would send "${subject}" to ${to}`,
    );
    await recordSend({to, uid, category, template, status: "skipped-no-key"});
    return {skipped: true, reason: "no-key"};
  }

  // RFC 8058 one-click + List-Unsubscribe headers for non-transactional.
  const finalHeaders = {...headers};
  if (!isTransactional(category) && uid) {
    const unsubUrl = makeUnsubscribeUrl({uid, category});
    finalHeaders["List-Unsubscribe"] = `<${unsubUrl}>, <mailto:unsubscribe@mail.teeboxmarket.com?subject=unsubscribe-${category}>`;
    finalHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  finalHeaders["X-Entity-Ref-ID"] =
    finalHeaders["X-Entity-Ref-ID"] || `${template || "send"}-${Date.now()}`;

  const finalTags = [
    {name: "category", value: category},
    ...(template ? [{name: "template", value: template}] : []),
    ...tags,
  ].slice(0, 10);

  // Idempotency key: caller can provide one (recommended for doc-trigger
  // sends where the trigger may replay), else derive a deterministic one
  // from template + uid + minute-bucket. Resend treats duplicate keys
  // within 24h as the same send and skips re-delivery.
  const idempotencyKey = explicitIdempotencyKey ||
    `${template || "send"}-${uid || "anon"}-${Math.floor(Date.now() / 60000)}`;

  try {
    const result = await resend.emails.send({
      from: fromAddr,
      to,
      subject,
      html,
      text: text || undefined,
      reply_to: replyToAddr,
      headers: finalHeaders,
      tags: finalTags,
    }, {idempotencyKey});
    // Resend Node SDK v3+ does NOT throw on API errors. It returns
    // `{ data: null, error: {...} }`. Without this check, suppressed/
    // invalid/rate-limited sends are silently recorded as `sent`.
    if (result && result.error) {
      const errMsg =
        (result.error && (result.error.message ||
          (typeof result.error === "string" ? result.error :
            JSON.stringify(result.error)))) ||
        "unknown Resend API error";
      logger.error("sendEmail Resend API error", {err: errMsg, template, to});
      await recordSend({
        to, uid, category, template,
        status: "send-error",
        error: errMsg,
      });
      return {sent: false, error: errMsg};
    }
    const resendId = (result && result.data && result.data.id) || null;
    await recordSend({to, uid, category, template, status: "sent", resendId});
    return {sent: true, id: resendId};
  } catch (e) {
    logger.error("sendEmail Resend error", {
      err: e.message || String(e),
      template,
      to,
    });
    await recordSend({
      to,
      uid,
      category,
      template,
      status: "send-error",
      error: e.message || String(e),
    });
    return {sent: false, error: e.message || String(e)};
  }
}

module.exports = {
  sendEmail,
  makeUnsubscribeUrl,
  verifyUnsubscribeToken,
  isTransactional,
  isMarketing,
  CATEGORIES,
  MARKETING_CATEGORIES,
  RESEND_API_KEY,
  UNSUBSCRIBE_SECRET,
  FROM,
  REPLY_TO,
  COMPANY_NAME,
  COMPANY_ADDRESS,
  BASE_URL,
};
