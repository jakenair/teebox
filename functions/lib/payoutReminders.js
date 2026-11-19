"use strict";
/**
 * Payout-setup reminders (r422, founder approval 2026-11-19).
 *
 * Who: a seller with at least one listing waiting on payouts
 *      (status "hidden", hiddenReason "awaiting_payouts").
 * When: right after the listing saves, then 24h, 3 days and 7 days after the
 *      first one. 4 reminders at most, then stop. Cancelled the moment the
 *      seller is charges-enabled.
 * How:  push first; email (Resend, category payoutReminders, honors
 *      unsubscribe) only when no push was delivered (no valid token / push
 *      category off). No sends 21:00-08:00 in the seller's time zone
 *      (pushPrefs.quietHours.tz when they have one, otherwise Central).
 *
 * Log: payoutReminders/{uid} — one doc per seller, server-only (no rule, so
 * clients are denied). Every stage is claimed in a transaction before it is
 * sent and recorded after, so a re-run (scheduler retry, onListingLive retry,
 * two triggers at once) never double-sends.
 *
 * Producers: onListingLive (stage 1, right after save) and the
 * payoutSetupReminders schedule (every 30 min; stages 2-4, plus stage 1 when
 * the save happened in quiet hours). No onUpdate trigger (#34).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const CADENCE_MS = [0, 1 * DAY, 3 * DAY, 7 * DAY];
const MAX_REMINDERS = CADENCE_MS.length; // 4
// Two reminders never land closer than this, even after a quiet-hours
// deferral or a scheduler outage.
const MIN_GAP_MS = 12 * HOUR;
// A claim older than this is treated as abandoned (the send crashed).
const CLAIM_STALE_MS = 10 * 60 * 1000;
const QUIET_START_MIN = 21 * 60; // 21:00
const QUIET_END_MIN = 8 * 60; //   08:00
const DEFAULT_TZ = "America/Chicago";
// Same threshold as the listing-card view badge (js/app-main.js
// VIEW_BADGE_MIN). Below it, the reminder never mentions views.
const VIEW_BADGE_MIN = 10;
const AWAITING_STATUS = "hidden";
const AWAITING_REASON = "awaiting_payouts";
const EMAIL_CATEGORY = "payoutReminders";
const PUSH_CATEGORY = "orders"; // seller-ops bucket, default ON, user can turn off
const LOG_COLLECTION = "payoutReminders";
const SETUP_URL = "https://teeboxmarket.com/?payouts=setup";
const SETUP_DEEPLINK = "teebox://payouts/setup";

// ── pure helpers ────────────────────────────────────────────────────────

function handledStages(log) {
  const s = new Set();
  Object.keys((log && log.sent) || {}).forEach((k) => s.add(Number(k)));
  Object.keys((log && log.skipped) || {}).forEach((k) => s.add(Number(k)));
  return s;
}

function lastSentMs(log) {
  let m = 0;
  Object.values((log && log.sent) || {}).forEach((v) => {
    const t = Number(v && v.atMs) || 0;
    if (t > m) m = t;
  });
  return m;
}

/**
 * Which stage (1-4) is due now, or null. When several are overdue (scheduler
 * outage), only the LATEST is sent; the earlier ones come back in
 * `supersede` so the caller records them as skipped instead of firing a burst.
 * @return {{stage:number, supersede:number[]}|{stage:null, reason:string}}
 */
function dueStage(log, nowMs) {
  if (!log || !Number.isFinite(Number(log.anchorMs))) return {stage: null, reason: "no-anchor"};
  if (log.cancelledAtMs) return {stage: null, reason: "cancelled"};
  if (log.doneAtMs) return {stage: null, reason: "done"};
  if (log.skipUntilMs && nowMs < Number(log.skipUntilMs)) return {stage: null, reason: "skip-window"};
  const handled = handledStages(log);
  if (handled.size >= MAX_REMINDERS || Number(log.count || 0) >= MAX_REMINDERS) {
    return {stage: null, reason: "max"};
  }
  const anchor = Number(log.anchorMs);
  let due = null;
  const open = [];
  for (let n = 1; n <= MAX_REMINDERS; n++) {
    if (handled.has(n)) continue;
    if (nowMs >= anchor + CADENCE_MS[n - 1]) { open.push(n); due = n; }
  }
  if (due == null) return {stage: null, reason: "not-due"};
  const last = lastSentMs(log);
  if (last && nowMs - last < MIN_GAP_MS) return {stage: null, reason: "min-gap"};
  return {stage: due, supersede: open.filter((n) => n !== due)};
}

/** Minutes since local midnight in `tz` (falls back to Central on a bad tz). */
function localMinutes(nowMs, tz) {
  const fmt = (zone) => new Intl.DateTimeFormat("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", timeZone: zone,
  }).formatToParts(new Date(nowMs));
  let parts;
  try { parts = fmt(tz || DEFAULT_TZ); } catch (_e) { parts = fmt(DEFAULT_TZ); }
  const hh = Number(parts.find((p) => p.type === "hour").value) % 24;
  const mm = Number(parts.find((p) => p.type === "minute").value);
  return hh * 60 + mm;
}

function parseHHMM(s) {
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(String(s || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Seller's quiet window: their own pushPrefs.quietHours when set (start/end
 * and tz), otherwise 21:00-08:00 Central. The fixed 21-08 window always
 * applies on top, so a custom setting can only widen it.
 */
function quietWindowFor(user) {
  const qh = (user && user.pushPrefs && user.pushPrefs.quietHours) || null;
  const tz = (qh && typeof qh.tz === "string" && qh.tz) || DEFAULT_TZ;
  const start = qh ? parseHHMM(qh.start) : null;
  const end = qh ? parseHHMM(qh.end) : null;
  return {tz, start, end};
}

function inWindow(nowMin, start, end) {
  if (start == null || end == null || start === end) return false;
  if (start < end) return nowMin >= start && nowMin < end;
  return nowMin >= start || nowMin < end;
}

function isQuietNow(user, nowMs) {
  const w = quietWindowFor(user);
  const nowMin = localMinutes(nowMs, w.tz);
  return inWindow(nowMin, QUIET_START_MIN, QUIET_END_MIN) || inWindow(nowMin, w.start, w.end);
}

/** Short item name for copy: listing title, trimmed at a word to 40 chars. */
function itemLabel(listing) {
  const raw = String((listing && (listing.title || listing.brand)) || "").replace(/\s+/g, " ").trim();
  if (!raw) return "listing";
  if (raw.length <= 40) return raw;
  const cut = raw.slice(0, 40);
  const sp = cut.lastIndexOf(" ");
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,.;:-]+$/, "");
}

/** Real 7-day views from the r421 viewDays buckets (never invented). */
function realViews7d(listing, nowMs) {
  try {
    const {sumWindow} = require("./listingViews");
    return sumWindow(listing && listing.viewDays, nowMs);
  } catch (_e) {
    return 0;
  }
}

/**
 * Copy for a stage. Plain text, no emoji. `views` is only used when it is a
 * real count at or above VIEW_BADGE_MIN, and never on stage 1.
 * @return {{title:string, body:string, emailIntro:string, viewsUsed:number}}
 */
function copyFor(stage, {label, more = 0, views = 0}) {
  const many = more > 0;
  const name = many ? `${label} and ${more} more` : label;
  const isAre = many ? "are" : "is";
  const isntArent = many ? "aren't" : "isn't";
  const useViews = stage >= 2 && Number(views) >= VIEW_BADGE_MIN;
  if (useViews) {
    return {
      title: `Buyers are already looking at your ${label}`,
      body: "Finish payout setup so they can buy it. About 3 minutes.",
      emailIntro: `Your ${label} has had ${Number(views)} views in the last 7 days, ` +
        "but buyers can't check out until your payout setup is done.",
      viewsUsed: Number(views),
    };
  }
  switch (stage) {
    case 1:
      return {
        title: `Your ${name} ${isAre} almost live`,
        body: "Finish payout setup to start selling. About 3 minutes.",
        emailIntro: `Your ${name} ${isAre} saved. ` +
          "Buyers will see it as soon as your payout setup is done.",
        viewsUsed: 0,
      };
    case 2:
      return {
        title: `Your ${name} ${isntArent} live yet`,
        body: "Buyers can't see it until payout setup is done. About 3 minutes.",
        emailIntro: `Your ${name} ${isntArent} visible to buyers yet. ` +
          "Finish payout setup and it publishes right away.",
        viewsUsed: 0,
      };
    case 3:
      return {
        title: `Your ${name} ${isAre} still waiting`,
        body: "Finish payout setup and it goes live right away.",
        emailIntro: `Your ${name} ${isAre} still waiting on payout setup. ` +
          "It goes live the moment you finish.",
        viewsUsed: 0,
      };
    default:
      return {
        title: `Last reminder: your ${name} ${isntArent} live`,
        body: "Finish payout setup any time and it publishes automatically.",
        emailIntro: `This is the last reminder. Your ${name} ${isAre} saved and ` +
          "will publish automatically whenever you finish payout setup.",
        viewsUsed: 0,
      };
  }
}

/** Pick the listing to name: the most-viewed one when views are real, else the newest. */
function pickListing(listings, nowMs) {
  const rows = (listings || []).map((l) => ({l, v: realViews7d(l, nowMs)}));
  if (!rows.length) return {listing: null, views: 0};
  const top = rows.slice().sort((a, b) => b.v - a.v)[0];
  if (top.v >= VIEW_BADGE_MIN) return {listing: top.l, views: top.v};
  const ms = (l) => (l.createdAt && l.createdAt.toMillis ? l.createdAt.toMillis() : 0);
  const newest = rows.slice().sort((a, b) => ms(b.l) - ms(a.l))[0];
  return {listing: newest.l, views: 0};
}

function anchorFrom(listings, nowMs) {
  let a = 0;
  for (const l of listings || []) {
    const t = (l.awaitingSince && l.awaitingSince.toMillis && l.awaitingSince.toMillis()) ||
      (l.createdAt && l.createdAt.toMillis && l.createdAt.toMillis()) || 0;
    if (t && (!a || t < a)) a = t;
  }
  return a && a <= nowMs ? a : nowMs;
}

// ── Firestore + channels ────────────────────────────────────────────────

function defaultDeps() {
  const admin = require("firebase-admin");
  return {
    admin,
    db: admin.firestore(),
    sendPush: require("./push").sendPush,
    sendEmail: require("./email").sendEmail,
    loadTemplate: (name) => {
      try { return require(`../emails-build/transactional/${name}`); } catch (_e) {
        try { return require(`../emails/transactional/${name}`); } catch (_e2) { return null; }
      }
    },
    authEmail: async (uid) => {
      try { const u = await admin.auth().getUser(uid); return u.email || null; } catch (_e) { return null; }
    },
    logger: require("firebase-functions").logger,
  };
}

async function awaitingListings(db, uid) {
  const snap = await db.collection("listings")
      .where("sellerId", "==", uid)
      .where("status", "==", AWAITING_STATUS)
      .where("hiddenReason", "==", AWAITING_REASON)
      .limit(50).get();
  return snap.docs.map((d) => ({id: d.id, ...d.data()}));
}

/** Stop all future reminders for a seller. Idempotent; never throws. */
async function cancelReminders(uid, reason, deps) {
  deps = deps || defaultDeps();
  const ref = deps.db.collection(LOG_COLLECTION).doc(uid);
  try {
    await deps.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return;
      const d = s.data() || {};
      if (d.cancelledAtMs) return;
      tx.set(ref, {cancelledAtMs: Date.now(), cancelReason: String(reason || "charges-enabled"),
        claim: null}, {merge: true});
    });
    return true;
  } catch (e) {
    deps.logger.warn(`[payoutReminders] cancel failed ${uid}`, e && e.message);
    return false;
  }
}

/**
 * Send whichever reminder is due for this seller, if any. Safe to call from
 * any number of producers at once.
 * @return {Promise<object>} outcome summary (for logs/tests)
 */
async function runReminderForSeller(uid, opts = {}) {
  const deps = opts.deps || defaultDeps();
  const db = deps.db;
  const nowMs = opts.nowMs || Date.now();
  const trigger = opts.trigger || "schedule";
  const logRef = db.collection(LOG_COLLECTION).doc(uid);

  const userSnap = await db.collection("users").doc(uid).get();
  const user = userSnap.exists ? (userSnap.data() || {}) : {};
  if (user.stripeChargesEnabled === true) {
    await cancelReminders(uid, "charges-enabled", deps);
    return {uid, sent: false, reason: "charges-enabled"};
  }
  const listings = await awaitingListings(db, uid);
  if (!listings.length) return {uid, sent: false, reason: "no-awaiting-listings"};
  if (isQuietNow(user, nowMs)) return {uid, sent: false, reason: "quiet-hours"};

  // Claim the stage (transaction) so concurrent producers can't both send.
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(logRef);
    const log = s.exists ? (s.data() || {}) : {};
    const patch = {};
    if (!Number.isFinite(Number(log.anchorMs))) {
      log.anchorMs = anchorFrom(listings, nowMs);
      patch.anchorMs = log.anchorMs;
      patch.createdAtMs = nowMs;
    }
    if (log.claim && log.claim.atMs && nowMs - Number(log.claim.atMs) < CLAIM_STALE_MS) {
      if (Object.keys(patch).length) tx.set(logRef, patch, {merge: true});
      return {stage: null, reason: "claimed-elsewhere"};
    }
    const d = dueStage(log, nowMs);
    if (!d.stage) {
      if (Object.keys(patch).length) tx.set(logRef, patch, {merge: true});
      return d;
    }
    const skipped = {};
    (d.supersede || []).forEach((n) => { skipped[n] = {atMs: nowMs, reason: "superseded"}; });
    tx.set(logRef, {...patch, claim: {stage: d.stage, atMs: nowMs, trigger},
      ...(Object.keys(skipped).length ? {skipped} : {})}, {merge: true});
    return {stage: d.stage};
  });
  if (!claimed.stage) return {uid, sent: false, reason: claimed.reason};
  const stage = claimed.stage;

  const {listing, views} = pickListing(listings, nowMs);
  const label = itemLabel(listing);
  const copy = copyFor(stage, {label, more: listings.length - 1, views});

  let channel = null;
  let pushRes = null;
  let emailRes = null;
  try {
    pushRes = await deps.sendPush(uid, {
      title: copy.title,
      body: copy.body,
      deepLink: SETUP_DEEPLINK,
      imageUrl: (listing && listing.photos && listing.photos[0]) || "",
      kind: "payout-setup-reminder",
      // No listingId on purpose: the web push click handler opens
      // /?listing=<id> when one is present, and this listing isn't public.
      data: {kind: "payout-setup-reminder", stage: String(stage), webUrl: "/?payouts=setup"},
    }, PUSH_CATEGORY, {threadId: "payouts"});
  } catch (e) {
    pushRes = {sent: 0, skipped: "push-error"};
  }
  if (pushRes && pushRes.sent > 0) {
    channel = "push";
  } else if (pushRes && pushRes.skipped === "quiet-hours") {
    // sendPush's own quiet window (user prefs) disagreed with ours: release
    // the claim and let the next run try again.
    await logRef.set({claim: null}, {merge: true});
    return {uid, sent: false, reason: "quiet-hours-push", stage};
  } else {
    const to = (await deps.authEmail(uid)) || user.email || null;
    const Tpl = deps.loadTemplate("PayoutSetupReminder");
    if (to && Tpl) {
      const ctx = {user: {uid, ...user}, listing, label, more: listings.length - 1,
        stage, copy, setupUrl: SETUP_URL};
      try {
        emailRes = await deps.sendEmail({
          to, uid, react: Tpl(ctx), subject: Tpl.subject(ctx),
          category: EMAIL_CATEGORY, template: "PayoutSetupReminder",
          idempotencyKey: `payout-reminder-${uid}-${stage}`,
        });
      } catch (e) {
        emailRes = {skipped: true, reason: "email-error"};
      }
      if (emailRes && emailRes.sent === true) channel = "email";
    }
  }

  const pushWhy = pushRes ? (pushRes.skipped || `sent=${pushRes.sent || 0}`) : "none";
  if (channel) {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(logRef);
      const log = s.exists ? (s.data() || {}) : {};
      const count = Number(log.count || 0) + 1;
      tx.set(logRef, {
        sent: {[stage]: {atMs: nowMs, channel, listingId: listing ? listing.id : null,
          title: copy.title, viewsUsed: copy.viewsUsed, trigger, pushWhy}},
        count,
        claim: null,
        ...(stage >= MAX_REMINDERS ? {doneAtMs: nowMs} : {}),
      }, {merge: true});
    });
    deps.logger.info(`[payoutReminders] sent stage ${stage} to ${uid} via ${channel} (${trigger})`);
    return {uid, sent: true, stage, channel, title: copy.title};
  }
  // No channel reached the seller (no token AND no email / unsubscribed).
  // Record it so the stage isn't retried every 30 minutes forever.
  await logRef.set({
    skipped: {[stage]: {atMs: nowMs, reason: "no-channel", pushWhy,
      emailWhy: emailRes ? (emailRes.reason || emailRes.error || "not-sent") : "no-email-or-template"}},
    claim: null,
    ...(stage >= MAX_REMINDERS ? {doneAtMs: nowMs} : {}),
  }, {merge: true});
  return {uid, sent: false, reason: "no-channel", stage};
}

module.exports = {
  CADENCE_MS, MAX_REMINDERS, MIN_GAP_MS, CLAIM_STALE_MS, VIEW_BADGE_MIN,
  AWAITING_STATUS, AWAITING_REASON, EMAIL_CATEGORY, PUSH_CATEGORY, LOG_COLLECTION,
  SETUP_URL, SETUP_DEEPLINK, DEFAULT_TZ,
  dueStage, isQuietNow, quietWindowFor, localMinutes, itemLabel, copyFor,
  pickListing, anchorFrom, realViews7d,
  runReminderForSeller, cancelReminders, awaitingListings,
};
