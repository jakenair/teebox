// ─────────────────────────────────────────────────────────────────────────────
// Logo Bingo — daily puzzle generator (server-side single source of truth)
// ─────────────────────────────────────────────────────────────────────────────
// Re-introduces a scheduled Cloud Function that writes the canonical 9-course
// puzzle for every UTC date to Firestore at `dailyPuzzles/{YYYY-MM-DD}`.
//
// History: the previous `generateDailyBingoPuzzle` was deleted on
// 2026-05-12 (see BINGO_CLEANUP.md) because it used `Math.random()` and
// disagreed with the client's deterministic mulberry32 shuffle. This
// rewrite uses the SAME mulberry32 + canonical seed string + epoch the
// client uses today, so the function output is bit-for-bit equal to what
// `dailySeed()` in index.html would produce — except now both clients
// can fetch it instead of recomputing it locally. The web and iOS
// WebView clients then render from one document; no chance of drift
// from a stale iOS bundle copy of bingo-courses.js or manifest.js.
//
// Schema written:
//   dailyPuzzles/{YYYY-MM-DD} = {
//     date: "2026-05-15",
//     seed: "teebox-bingo-canon-v3",
//     courses: [
//       { id, shortName, logoUrl }, ... (9 entries, in order)
//     ],
//     generatedAt: serverTimestamp,
//     generatorVersion: 1,
//     daysSinceEpoch: 134,
//     windowStart: 27,
//     poolSize: 117,
//   }
//
// CDN URLs in `courses[].logoUrl` are absolute and point at the live
// public origin (https://teeboxmarket.com/...). That matters for iOS:
// even if a stale IPA carries an older bingo-courses.js, the rendered
// <img src> from this doc still points at the live PNGs.
//
// Schedule: every UTC midnight. The doc id is the UTC date string, and
// the manual `runGenerateDailyPuzzles` callable lets the founder pre-
// generate the next N days for backfill.
//
// Validation guarantee: this file imports the SAME canon data the web
// client filters on, via functions/data/bingo-puzzle-data.json. That
// JSON is regenerated from /bingo-courses.js + /assets/logos/manifest.js
// on every deploy (predeploy hook). The cross-platform regression test
// at scripts/test-bingo-cross-platform.mjs asserts the function and
// client produce identical 9-course arrays for the same date.
// ─────────────────────────────────────────────────────────────────────────────

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const path = require("path");

const SCHEDULED_BATCH = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
};

const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  concurrency: 80,
  maxInstances: 100,
};

// Bump this if the algorithm (NOT the input data) ever changes — that
// way a fresh deploy doesn't silently rewrite yesterday's puzzle with a
// different selection. The generator skips re-writes when an existing
// doc has the same generatorVersion.
const GENERATOR_VERSION = 1;

// ── Canon data ──────────────────────────────────────────────────────────────
// Single source of truth for the course pool the function operates on.
// Generated at deploy time by functions/scripts/generate-bingo-canon.mjs
// from the same /bingo-courses.js + /assets/logos/manifest.js the web
// client imports — so this and dailySeed() in index.html are reading
// the same list, in the same order, with the same logo filter.
const CANON_PATH = path.join(__dirname, "data", "bingo-puzzle-data.json");
const CANON = require(CANON_PATH);

// ── Hash + PRNG — must match index.html dailySeed() byte for byte ──────────
// hashStr is FNV-1a 32-bit. mulberry32 is the standard 32-bit PRNG.
// Both are copied verbatim from index.html so the function and client
// generate the exact same sequence for the exact same seed input.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Deterministic 9-course selection ────────────────────────────────────────
// Same windowed-walk algorithm as the web client. Given a YYYY-MM-DD
// string, returns 9 courses from CANON.courses in the canonical order.
//
// IMPORTANT: any change here MUST be mirrored in index.html dailySeed()
// AND increment GENERATOR_VERSION above. The cross-platform regression
// test (scripts/test-bingo-cross-platform.mjs) will fail otherwise.
function selectDailyCourses(dateStr) {
  const rngOrder = mulberry32(hashStr(CANON.seed));
  const pool = CANON.courses.slice();
  // Fisher-Yates shuffle, last-to-first, matching index.html exactly.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rngOrder() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  const today = new Date(dateStr + "T00:00:00Z");
  const epoch = new Date(CANON.epoch);
  const daysSince = Math.max(0, Math.floor((today - epoch) / 86400000));
  const windowCount = Math.max(1, Math.floor(pool.length / 9));
  const windowIndex = daysSince % windowCount;
  const start = windowIndex * 9;
  return {
    courses: pool.slice(start, start + 9),
    daysSinceEpoch: daysSince,
    windowStart: windowIndex,
    poolSize: pool.length,
  };
}

// ── Date utils ──────────────────────────────────────────────────────────────
function isValidDateString(s) {
  if (typeof s !== "string" || s.length !== 10) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

function todayUtcDateKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysUtc(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ── Core writer ─────────────────────────────────────────────────────────────
// Generates the puzzle for a single date and writes it to Firestore. Idempotent:
// if the doc already exists with the same generatorVersion AND the same
// course IDs in the same order, we leave it untouched (no write). This
// keeps repeated invocations from chewing through Firestore writes.
async function writePuzzleForDate(db, dateStr) {
  if (!isValidDateString(dateStr)) {
    throw new Error(`invalid date: ${dateStr}`);
  }
  const {courses, daysSinceEpoch, windowStart, poolSize} =
    selectDailyCourses(dateStr);
  const ref = db.doc(`dailyPuzzles/${dateStr}`);
  const existing = await ref.get();
  if (existing.exists) {
    const prev = existing.data() || {};
    const sameVersion = Number(prev.generatorVersion) === GENERATOR_VERSION;
    const prevIds = Array.isArray(prev.courses) ?
      prev.courses.map((c) => c && c.id).join(",") : "";
    const newIds = courses.map((c) => c.id).join(",");
    if (sameVersion && prevIds === newIds) {
      return {status: "unchanged", date: dateStr, courses};
    }
  }
  await ref.set({
    date: dateStr,
    seed: CANON.seed,
    courses,
    daysSinceEpoch,
    windowStart,
    poolSize,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {status: "written", date: dateStr, courses};
}

// ── Scheduled trigger ───────────────────────────────────────────────────────
// Runs at UTC midnight. The cron string `0 0 * * *` in UTC means
// "every day at 00:00 UTC" — same instant for every user worldwide.
// We also pre-generate the next 7 days so a clock-skew client or one
// running slightly ahead of UTC midnight finds the next puzzle ready.
exports.generateDailyBingoPuzzle = onSchedule(
    {schedule: "0 0 * * *", timeZone: "UTC", ...SCHEDULED_BATCH},
    async () => {
      const db = admin.firestore();
      const today = todayUtcDateKey();
      const dates = [];
      for (let i = 0; i < 7; i++) dates.push(addDaysUtc(today, i));

      const results = [];
      for (const date of dates) {
        try {
          const out = await writePuzzleForDate(db, date);
          results.push({date, status: out.status});
        } catch (err) {
          logger.error(
              `[bingoDailyPuzzle] write failed for ${date}: ${err && err.message || err}`,
          );
          results.push({date, status: "error", error: String(err)});
        }
      }
      logger.info(
          "[bingoDailyPuzzle] daily generation complete",
          {results},
      );
    },
);

// ── Manual callable — pre-generate a range of dates ─────────────────────────
// Founder-only callable that backfills/regenerates a date range. Useful
// for the initial seed-the-collection step and for re-runs after a
// canon change (e.g. a new logo was added and the doc needs to reflect
// the larger pool). UID allow-list is the same one used by other admin
// callables — keep this list in sync.
const FOUNDER_UIDS = new Set([
  // Populated at deploy time via firebase functions:secrets:set or
  // hardcoded by the founder. Left empty here so a leaked SDK key
  // can't trigger mass writes — failure-closed by default.
]);

exports.runGenerateDailyPuzzles = onCall(USER_CALLABLE, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in.");
  }
  // Soft-gated by Firestore: only users with admin:true on their
  // /users doc may invoke. (We avoid a hardcoded allow-list here so
  // the founder can grant access without a redeploy.)
  let isAdmin = false;
  try {
    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    const u = userSnap.exists ? userSnap.data() : null;
    isAdmin = !!(u && u.admin === true);
  } catch (_e) {
    // Fall through — isAdmin stays false.
  }
  if (!isAdmin && !FOUNDER_UIDS.has(uid)) {
    throw new HttpsError("permission-denied", "Admin only.");
  }

  const data = request.data || {};
  const startDate = isValidDateString(data.startDate) ?
    data.startDate : todayUtcDateKey();
  const days = Math.max(1, Math.min(30, Number(data.days) || 7));

  const db = admin.firestore();
  const results = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysUtc(startDate, i);
    try {
      const out = await writePuzzleForDate(db, date);
      results.push({date, status: out.status});
    } catch (err) {
      results.push({date, status: "error", error: String(err)});
    }
  }
  return {ok: true, startDate, days, results};
});

// ── Exports for cross-platform regression test ──────────────────────────────
// scripts/test-bingo-cross-platform.mjs imports these so the test can
// invoke `selectDailyCourses(date)` without spinning up Firestore. We
// export the canon too so the test can compare against the web client.
exports.__test = {
  selectDailyCourses,
  hashStr,
  mulberry32,
  CANON,
  GENERATOR_VERSION,
};
