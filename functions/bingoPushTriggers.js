/**
 * functions/bingoPushTriggers.js — Daily Logo Bingo push triggers.
 *
 * Wired into functions/index.js via:
 *     Object.assign(exports, require("./bingoPushTriggers"));
 *
 * Two scheduled functions:
 *
 *   pushBingoDailyReminder    — every hour. Fires the morning "today's
 *                               puzzle is live" push to any user whose
 *                               bingoPushPrefs.reminderHour matches their
 *                               current local hour (computed from their
 *                               pushPrefs.quietHours.tz). Skips users who
 *                               already played today (gameScores doc with
 *                               correctCount > 0) and de-dupes via
 *                               bingoPushPrefs.lastDailyReminderSent.
 *
 *   pushBingoStreakSaver      — every hour. At 9pm local for users with
 *                               an active streak (>= 7 days) who have NOT
 *                               played today, sends "don't lose your streak."
 *                               De-dupes via bingoPushPrefs.lastStreakSaverSent.
 *
 * Both bypass quiet hours (urgent flag set on the streak saver only;
 * the daily reminder uses the explicit-time bypass — the user picked
 * the hour, so quiet hours would be self-contradictory).
 *
 * Schema additions (new fields under users/{uid}):
 *   pushPrefs.bingo                       (bool, default true)
 *   bingoPushPrefs.dailyReminder          (bool, default true)
 *   bingoPushPrefs.reminderHour           (int 0..23, default 8)
 *   bingoPushPrefs.streakSaver            (bool, default true)
 *   bingoPushPrefs.lastDailyReminderSent  (date string YYYY-MM-DD)
 *   bingoPushPrefs.lastStreakSaverSent    (date string YYYY-MM-DD)
 *   bingoCurrentStreak                    (int, optional — falls back to
 *                                          reading max streak from
 *                                          gameScores if not denormalized)
 *
 * Scaling note: this is the naive "scan all opted-in users every hour"
 * approach (~24 full-collection scans/day). Fine at <100k users. Above
 * that, denormalize a `bingoPushSchedule/{utcHour}/users/{uid}` index
 * keyed by the user's computed UTC reminder hour, and only read the
 * current-hour bucket. See README / runbook TODO.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const {sendPush} = require("./lib/push");

const SCHEDULED_BATCH = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};

// ── helpers ─────────────────────────────────────────────────────────

/** UTC date string YYYY-MM-DD — matches the bingo gameScores doc id prefix. */
function _todayUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Resolve the user's local hour (0..23) using the same tz field that
 * powers quiet hours. Defaults to America/New_York if missing or invalid. */
function _localHour(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour12: false, hour: "2-digit", timeZone: tz || "America/New_York",
    }).formatToParts(new Date());
    return Number(parts.find((p) => p.type === "hour").value);
  } catch (_e) {
    return -1;
  }
}

/** True if the user has a gameScores doc for today with at least 1
 * correct guess. We treat "played" as "made at least one correct
 * guess" (matches the in-app streak logic — pure attempts don't count). */
async function _playedToday(uid, dateStr) {
  try {
    const snap = await admin.firestore()
      .collection("gameScores")
      .doc(`${dateStr}_${uid}`)
      .get();
    if (!snap.exists) return false;
    const d = snap.data() || {};
    // correctCount > 0 means they engaged meaningfully; 0 means a stale
    // record (shouldn't happen but be defensive).
    return Number(d.correctCount || 0) > 0;
  } catch (_e) {
    return false;
  }
}

/** Resolve current streak. Prefer the denormalized user doc field
 * (bingoCurrentStreak), fall back to the most-recent gameScores write
 * (yesterday's puzzle's recorded streak). */
async function _currentStreak(uid, userData) {
  if (userData && Number.isFinite(Number(userData.bingoCurrentStreak))) {
    return Number(userData.bingoCurrentStreak);
  }
  // Fallback: look up yesterday's gameScores streak field.
  try {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const yesterday = `${y}-${m}-${day}`;
    const snap = await admin.firestore()
      .collection("gameScores")
      .doc(`${yesterday}_${uid}`)
      .get();
    if (snap.exists) {
      return Number(snap.data().streak || 0);
    }
  } catch (_e) {}
  return 0;
}

// ── trigger 1 — morning daily reminder ──────────────────────────────
//
// Runs hourly. Selects users with bingoPushPrefs.dailyReminder == true,
// then per-user filters to those whose local hour matches their
// configured reminderHour. Skips users who already played today, and
// users who've already been pinged today.
exports.pushBingoDailyReminder = onSchedule(
    {schedule: "every 60 minutes", ...SCHEDULED_BATCH},
    async () => {
      const db = admin.firestore();
      const today = _todayUTC();
      let dispatched = 0;
      let scanned = 0;
      try {
        const users = await db.collection("users")
            .where("bingoPushPrefs.dailyReminder", "==", true)
            .get();
        scanned = users.size;

        for (const u of users.docs) {
          try {
            const data = u.data() || {};
            const bpp = data.bingoPushPrefs || {};
            // Default hour is 8 (8am local). The query above guarantees
            // dailyReminder is on, so we don't re-check it here.
            const reminderHour = Number.isFinite(Number(bpp.reminderHour))
                ? Number(bpp.reminderHour) : 8;
            const tz = (data.pushPrefs && data.pushPrefs.quietHours && data.pushPrefs.quietHours.tz)
                || "America/New_York";
            if (_localHour(tz) !== reminderHour) continue;

            // De-dupe: same-day repeat send guard.
            if (bpp.lastDailyReminderSent === today) continue;

            // Already played today? Skip the reminder.
            if (await _playedToday(u.id, today)) continue;

            // Build copy. Streak >= 1 gets the streak-flavored body.
            const streak = await _currentStreak(u.id, data);
            const body = streak >= 1
                ? `Day ${streak + 1} of your streak — keep it going.`
                : "9 logos, 1 chance to solve. Tap to play.";

            await sendPush(u.id, {
              title: "Today's Logo Bingo is live",
              body,
              deepLink: "teebox://bingo",
              kind: "bingo-daily-reminder",
              data: {date: today, streak: String(streak)},
            }, "bingo", {
              // Bypass quiet hours — the user explicitly picked this time
              // by setting their reminderHour. Marking urgent is the
              // simplest way to bypass without refactoring sendPush().
              urgent: true,
              threadId: `bingo-${today}`,
            });

            // Record the send timestamp so the next hourly tick (or a
            // redeployed sweep) doesn't double-fire.
            await db.collection("users").doc(u.id).set({
              bingoPushPrefs: {lastDailyReminderSent: today},
            }, {merge: true});
            dispatched += 1;
          } catch (perUserErr) {
            logger.warn("pushBingoDailyReminder: per-user error", u.id, perUserErr);
          }
        }
        logger.info(
            `pushBingoDailyReminder: scanned=${scanned} dispatched=${dispatched}`);
      } catch (err) {
        logger.error("pushBingoDailyReminder error", err);
      }
    },
);

// ── trigger 2 — 9pm streak-protection alert ─────────────────────────
//
// Runs hourly. Selects users with bingoPushPrefs.streakSaver == true.
// Only fires for users whose local hour is exactly 21, who have a
// streak >= 7, and who have not yet played today.
exports.pushBingoStreakSaver = onSchedule(
    {schedule: "every 60 minutes", ...SCHEDULED_BATCH},
    async () => {
      const db = admin.firestore();
      const today = _todayUTC();
      let dispatched = 0;
      let scanned = 0;
      try {
        const users = await db.collection("users")
            .where("bingoPushPrefs.streakSaver", "==", true)
            .get();
        scanned = users.size;

        for (const u of users.docs) {
          try {
            const data = u.data() || {};
            const bpp = data.bingoPushPrefs || {};
            const tz = (data.pushPrefs && data.pushPrefs.quietHours && data.pushPrefs.quietHours.tz)
                || "America/New_York";
            // Only at exactly 21:00 local. (21–22 inclusive of the
            // first hour; we don't re-fire later because of the
            // lastStreakSaverSent guard.)
            if (_localHour(tz) !== 21) continue;

            if (bpp.lastStreakSaverSent === today) continue;

            const streak = await _currentStreak(u.id, data);
            if (streak < 7) continue;

            // Already played → no need to warn.
            if (await _playedToday(u.id, today)) continue;

            await sendPush(u.id, {
              title: "Don't lose your streak",
              body: `Day ${streak} of Logo Bingo — 3 hours left to keep your streak alive.`,
              deepLink: "teebox://bingo",
              kind: "bingo-streak-saver",
              data: {date: today, streak: String(streak)},
            }, "bingo", {
              // Urgent: bypass quiet hours (most users' quiet hours start
              // at 21:00 — edge case where they'd otherwise miss it).
              urgent: true,
              threadId: `bingo-${today}`,
            });

            await db.collection("users").doc(u.id).set({
              bingoPushPrefs: {lastStreakSaverSent: today},
            }, {merge: true});
            dispatched += 1;
          } catch (perUserErr) {
            logger.warn("pushBingoStreakSaver: per-user error", u.id, perUserErr);
          }
        }
        logger.info(
            `pushBingoStreakSaver: scanned=${scanned} dispatched=${dispatched}`);
      } catch (err) {
        logger.error("pushBingoStreakSaver error", err);
      }
    },
);
