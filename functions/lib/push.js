/**
 * functions/lib/push.js — central FCM dispatch helper.
 *
 *   sendPush(uid, payload, category, opts)
 *
 * Responsibilities:
 *   1. Resolve per-user preferences (`users/{uid}.pushPrefs[category]`).
 *   2. Respect global quiet hours (skip non-urgent inside the window).
 *   3. Collect every registered FCM token from `users/{uid}/fcmTokens/*`
 *      (each doc id IS the token; created by the client wiring in
 *      index.html / native Capacitor wrapper).
 *   4. Build a unified APNs + Android payload (rich images, thread-id,
 *      grouping, time-sensitive flag, deep link, category for tap-routing).
 *   5. Call admin.messaging().sendEachForMulticast and prune dead tokens.
 *
 * This helper is intentionally side-effect-light and synchronous-ish so it
 * can be safely awaited inside other Firestore triggers. Errors are logged
 * but NEVER rethrown — push is always best-effort.
 */

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");

// Valid category keys that map 1:1 to users/{uid}.pushPrefs.<key>.
// Anything else falls through to the "news" bucket (which defaults OFF).
const VALID_CATEGORIES = new Set([
  "messages",
  "offers",
  "orders",
  "savedSearches",
  "priceDrops",
  "news",
  // "bingo" — Logo Bingo daily reminders + streak-saver alerts. Default
  // ON: Bingo is the entry-point feature, so opt-out (not opt-in) makes
  // sense at the prefs level. The 8am-local reminder uses urgent=true to
  // bypass quiet hours since the user explicitly chose that delivery time.
  "bingo",
  // "likes" — someone saved/favorited your listing (notifyLike). Default ON;
  // batched/deduped at the producer so toggling can't fan out.
  "likes",
]);

// Sensible defaults if the user has never opened the preferences screen.
// Conservative: every category that has clear transactional value is ON,
// marketing/"news" is OFF. Quiet hours default to 9pm–8am America/New_York.
const DEFAULT_PREFS = {
  messages: true,
  offers: true,
  orders: true,
  savedSearches: true,
  priceDrops: true,
  news: false,
  // Bingo default ON — see VALID_CATEGORIES comment above for rationale.
  bingo: true,
  likes: true,
  quietHours: {start: "21:00", end: "08:00", tz: "America/New_York"},
};

/**
 * sendPush — the only public entry point. Other triggers call this.
 *
 * @param {string} uid   recipient firebase auth uid
 * @param {object} payload  visual payload (see "payload schema" below)
 * @param {string} category one of VALID_CATEGORIES
 * @param {object} [opts] { urgent: bool, threadId: string, imageUrl: string }
 *
 * Payload shape:
 *   {
 *     title: "Counter offer: $190",
 *     body: "Jake countered your offer on Scotty Cameron",
 *     deepLink: "teebox://offer/abc123",      // routed by index.html
 *     imageUrl: "https://.../listing.jpg",    // optional, NSE downloads
 *     data: { kind: "offer-countered", offerId: "abc", ... }, // strings only
 *   }
 *
 * opts.urgent=true forces delivery during quiet hours and lifts iOS focus
 * (interruption-level: time-sensitive). Use for offer-expiring-in-1h,
 * dispute opened, payout failed.
 */
async function sendPush(uid, payload, category, opts) {
  opts = opts || {};
  if (!uid || !payload || !category) return {sent: 0, skipped: "missing-args"};
  if (!VALID_CATEGORIES.has(category)) category = "news";

  const db = admin.firestore();

  // 1. Load user pref doc + decide if we should send at all.
  let prefs = DEFAULT_PREFS;
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      if (u && u.pushPrefs) prefs = {...DEFAULT_PREFS, ...u.pushPrefs};
    }
  } catch (e) { /* fall through with defaults */ }

  if (prefs[category] === false) {
    return {sent: 0, skipped: `category-off:${category}`};
  }
  if (!opts.urgent && isInQuietHours(prefs.quietHours)) {
    // Non-urgent → silently swallow until morning. We still write the
    // in-app notification doc upstream, so the user sees a badge.
    return {sent: 0, skipped: "quiet-hours"};
  }

  // 2. Gather tokens. Schema is users/{uid}/fcmTokens/{token} where the
  // DOC ID is the token itself (matches existing pushNotificationDispatch).
  let tokens = [];
  try {
    const snap = await db.collection("users").doc(uid)
      .collection("fcmTokens").get();
    snap.forEach((d) => tokens.push(d.id));
  } catch (e) {
    logger.error("sendPush: token fetch failed", uid, e);
    return {sent: 0, skipped: "token-fetch-error"};
  }
  if (!tokens.length) return {sent: 0, skipped: "no-tokens"};

  // 3. Build the multicast message. Mirror all flags into both apns and
  // android blocks so platform-specific behavior works.
  const message = buildMulticast(tokens, payload, category, opts);

  let resp;
  try {
    resp = await admin.messaging().sendEachForMulticast(message);
  } catch (e) {
    logger.error("sendPush: send error", uid, e);
    return {sent: 0, skipped: "send-error"};
  }

  // 4. Prune stale tokens.
  const dead = [];
  resp.responses.forEach((r, i) => {
    if (!r.success && r.error && (
      r.error.code === "messaging/registration-token-not-registered" ||
      r.error.code === "messaging/invalid-registration-token"
    )) dead.push(tokens[i]);
  });
  if (dead.length) {
    const batch = db.batch();
    dead.forEach((t) => batch.delete(
      db.collection("users").doc(uid).collection("fcmTokens").doc(t)
    ));
    try { await batch.commit(); } catch (_e) {}
    logger.info(`sendPush: pruned ${dead.length} dead tokens for ${uid}`);
  }

  return {sent: resp.successCount, failed: resp.failureCount};
}

/**
 * Construct the platform-specific MulticastMessage. Splits FCM "data" (string
 * map, available in both fg + bg + terminated states) from "notification"
 * (rendered by the OS when bg/terminated). We always set BOTH so the OS shows
 * a banner AND the app can read structured data on tap.
 */
function buildMulticast(tokens, payload, category, opts) {
  const dataMap = {
    // data values MUST be strings (FCM strict typing).
    kind: String(payload.kind || (payload.data && payload.data.kind) || category),
    category: String(category),
    url: String(payload.deepLink || ""),
    threadId: String(opts.threadId || ""),
    ...stringifyAll(payload.data || {}),
  };

  const apnsAlert = {
    title: payload.title || "TeeBox",
    body: payload.body || "",
  };

  const apnsPayload = {
    aps: {
      alert: apnsAlert,
      // mutable-content REQUIRED so the Notification Service Extension fires
      // and can attach the rich image. Without this iOS shows the plain text.
      "mutable-content": 1,
      sound: opts.urgent ? "default" : "default",
      "thread-id": opts.threadId || `${category}-${dataMap.listingId || "_"}`,
      "interruption-level": opts.urgent ? "time-sensitive" : "active",
      category: apnsCategoryFor(category),
    },
    // Custom keys are siblings of aps; NSE reads them via request.content.userInfo.
    imageUrl: payload.imageUrl || "",
    deepLink: payload.deepLink || "",
  };

  const androidNotif = {
    title: payload.title || "TeeBox",
    body: payload.body || "",
    // The notification icon name (drawable in android/app/src/main/res/drawable).
    // Falls back to the app icon if missing.
    icon: "ic_stat_teebox",
    color: "#1f4827",
    // tag enables collapse when the same identifier fires twice; we want
    // grouping not collapse, so leave undefined and use group + group_summary.
    sound: "default",
    channelId: androidChannelFor(category),
    // Big-picture style on Android — only fires if imageUrl is present.
    imageUrl: payload.imageUrl || undefined,
    clickAction: "FCM_PLUGIN_ACTIVITY",
  };

  const androidConfig = {
    priority: opts.urgent ? "high" : "high",
    // ttl: 12h — most marketplace events lose value past half a day.
    ttl: 12 * 60 * 60 * 1000,
    notification: androidNotif,
    data: {
      group: opts.threadId || `${category}`,
      groupSummary: "false",
    },
  };

  return {
    tokens,
    // Top-level notification block — FCM uses this for "auto-display" mode
    // when the app is bg/terminated. We duplicate into apns/android blocks
    // so each platform can override.
    notification: {title: payload.title || "TeeBox", body: payload.body || ""},
    data: dataMap,
    apns: {
      payload: apnsPayload,
      headers: {
        "apns-priority": opts.urgent ? "10" : "5",
        "apns-push-type": "alert",
      },
    },
    android: androidConfig,
  };
}

/**
 * iOS notification CATEGORY → UNNotificationCategory identifier registered
 * by AppDelegate / Capacitor PushNotifications plugin. Drives action buttons
 * (Accept / Decline on offers, View on price drops, Reply on messages).
 */
function apnsCategoryFor(category) {
  switch (category) {
    case "offers": return "TEEBOX_OFFER";
    case "orders": return "TEEBOX_ORDER";
    case "messages": return "TEEBOX_MESSAGE";
    case "priceDrops": return "TEEBOX_PRICE_DROP";
    case "savedSearches": return "TEEBOX_SAVED_SEARCH";
    case "bingo": return "TEEBOX_BINGO";
    default: return "TEEBOX_DEFAULT";
  }
}

/**
 * Android channel IDs. Must be created on first launch by the client (we
 * register them in MessagingNotificationHelper.kt). Channels drive sound,
 * vibration, and importance settings the user can tweak in system settings.
 */
function androidChannelFor(category) {
  switch (category) {
    case "offers": return "teebox_offers";
    case "orders": return "teebox_orders";
    case "messages": return "teebox_messages";
    case "priceDrops": return "teebox_price_drops";
    case "savedSearches": return "teebox_saved_searches";
    case "bingo": return "teebox_bingo";
    default: return "teebox_default";
  }
}

/**
 * Coerce all values in an object to strings. FCM rejects non-string data
 * fields with INVALID_ARGUMENT, and the existing pushNotificationDispatch
 * trigger has the same pattern. Null/undefined → "".
 */
function stringifyAll(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    out[k] = (v == null) ? "" : String(v);
  }
  return out;
}

/**
 * isInQuietHours — check the user's pushPrefs.quietHours window in their
 * declared timezone. Defaults to America/New_York if tz is missing.
 *
 * Returns true if "now" in the user's tz is inside [start, end). Handles
 * wrap-around (21:00 → 08:00 spans midnight).
 */
function isInQuietHours(quietHours) {
  if (!quietHours) return false;
  const start = parseHHMM(quietHours.start || "21:00");
  const end = parseHHMM(quietHours.end || "08:00");
  if (start == null || end == null) return false;
  const tz = quietHours.tz || "America/New_York";

  // Use Intl to extract the user's local hour:minute right now.
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit", timeZone: tz,
    }).formatToParts(new Date());
  } catch (_e) {
    return false;
  }
  const hh = Number(parts.find((p) => p.type === "hour").value);
  const mm = Number(parts.find((p) => p.type === "minute").value);
  const nowMin = hh * 60 + mm;

  if (start === end) return false;
  if (start < end) return nowMin >= start && nowMin < end;
  // wrap-around (e.g. 21:00 → 08:00)
  return nowMin >= start || nowMin < end;
}

function parseHHMM(s) {
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(String(s || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

module.exports = {sendPush, isInQuietHours, DEFAULT_PREFS, VALID_CATEGORIES};
