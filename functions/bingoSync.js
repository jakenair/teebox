// ─────────────────────────────────────────────────────────────────────────────
// Logo Bingo offline sync
// ─────────────────────────────────────────────────────────────────────────────
// The bingo client now plays fully offline: it writes every tap to
// localStorage and queues a sync to this callable. When the device
// reconnects, the queue drains and we receive a state blob per (uid, date).
//
// What we store (CANONICAL — owned by this endpoint):
//   users/{uid}/bingoGames/{date}  →  { date, cells, solvedAt, attempts,
//                                       startedAt, correctCount, syncedAt }
//
// What we ALSO write (DENORMALIZED FANOUT — see BINGO_SCHEMA_RECONCILIATION.md):
//   gameScores/{date}_{uid}        →  { uid, date, correctCount, attempts,
//                                       streak, solvedAt, timeSec,
//                                       displayName, country, completedAt }
//
// We deliberately keep the bingoGames collection scoped under the user doc —
// rules (in /firestore.rules) allow owner-read but deny client writes; Admin
// SDK in this callable is the only writer. The legacy `gameScores` collection
// was historically populated by writeLeaderboardScore() in index.html (which
// continues to write best-effort), powering the in-app leaderboard query and
// the daily-push "did user play today?" check. We mirror to it from here so
// the canonical bingoGames doc is the single source of truth even when the
// client-side legacy write is rejected/dropped (e.g. offline, rule mismatch).
// Cost: 1 extra Firestore write per solve ($0.000002). Negligible.
//
// Validation philosophy: the public site already ships bingo-courses.js
// (every answer is sitting in the user's browser), so we can't crypto-attest
// correctness server-side without architectural change. We do the most we
// can — date freshness, structure, timestamp plausibility — and let the
// audit recommend cheat-proof hashing for the next iteration.
// ─────────────────────────────────────────────────────────────────────────────

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

// Match the sizing presets used elsewhere in this codebase.
const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  concurrency: 80,
  maxInstances: 100,
};

// How far back the client may sync. A reasonable golfer-on-poor-signal
// window: they finish a round, fly home, finally land in wifi a few days
// later. Anything older than 7 days is rejected as backfill abuse.
const SYNC_MAX_AGE_DAYS = 7;

// Hard cap on a single round's elapsed wall time. Even a casual player
// finishes in under an hour; values beyond this almost certainly indicate
// a malformed payload, not a real long game.
const MAX_GAME_DURATION_MS = 6 * 60 * 60 * 1000; // 6h is generous

function isValidDateString(s) {
  if (typeof s !== "string" || s.length !== 10) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

function daysBetweenUtc(aIso, bIso) {
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  return Math.round((a - b) / 86400000);
}

function todayUtcDateKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// A "cell" matches the client shape in index.html: each entry of the 9-element
// array has { state, attempts, guess, tappedAt, resolvedAt, points }.
// We accept (with bounds) anything plausible; we don't require all fields.
function sanitizeCell(raw) {
  if (!raw || typeof raw !== "object") return null;
  const VALID_STATES = ["pending", "correct", "wrong", "revealed"];
  const state = VALID_STATES.includes(raw.state) ? raw.state : "pending";
  const attempts = Number.isInteger(raw.attempts)
    ? Math.max(0, Math.min(20, raw.attempts))
    : 0;
  // guess: trimmed string, capped — store for product analytics only.
  const guess =
    typeof raw.guess === "string"
      ? raw.guess.slice(0, 80)
      : null;
  const tappedAt = Number.isFinite(raw.tappedAt) ? raw.tappedAt : null;
  const resolvedAt = Number.isFinite(raw.resolvedAt) ? raw.resolvedAt : null;
  const points = Number.isInteger(raw.points)
    ? Math.max(0, Math.min(1000, raw.points))
    : 0;
  return {state, attempts, guess, tappedAt, resolvedAt, points};
}

// ── Legacy gameScores fanout ───────────────────────────────────────────────
// Mirror the essential fields of users/{uid}/bingoGames/{date} into
// gameScores/{date}_{uid} so the legacy in-app leaderboard query (in
// index.html) and the daily-push "played today?" check (in
// bingoPushTriggers.js) keep working off the canonical write path.
//
// Schema reconciliation: this is a temporary fanout while we migrate
// readers off gameScores onto bingoGames. See BINGO_SCHEMA_RECONCILIATION.md.
//
// Merge semantics: if the legacy client already wrote a gameScores doc for
// this (date, uid), we MERGE — preserving any fields it set that we don't
// know about (e.g. completedAt serverTimestamp from the client) while
// overwriting the canonical ones we own.
//
// Streak resolution: prefer the denormalized users/{uid}.bingoCurrentStreak
// field if set; otherwise fall back to the prior-day bingoGames doc + 1.
// Returns 0 when neither is available (first solve, or a gap day).
async function _resolveStreakForFanout(db, uid, date) {
  try {
    const userSnap = await db.doc(`users/${uid}`).get();
    const userData = userSnap.exists ? (userSnap.data() || {}) : {};
    if (Number.isFinite(Number(userData.bingoCurrentStreak))) {
      return Number(userData.bingoCurrentStreak);
    }
    // Walk back exactly one day: prior bingoGames doc tells us yesterday's
    // streak. The aggregate trigger walks further; here a single hop keeps
    // the fanout cheap.
    const [y, m, d] = String(date).split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    const prevDate = `${yyyy}-${mm}-${dd}`;
    const prevSnap = await db
      .doc(`users/${uid}/bingoGames/${prevDate}`).get();
    if (prevSnap.exists) {
      const pd = prevSnap.data() || {};
      if (pd.solvedAt) return 2; // yesterday solved + today solved = at least 2
    }
    return 1; // today is a solve, but no chain found
  } catch (_e) {
    return 0;
  }
}

async function _fanoutToGameScores(db, uid, date, finalState) {
  try {
    const {
      correctCount,
      attempts,
      startedAtVal,
      solvedAtVal,
    } = finalState;

    // Only mirror once the puzzle is solved — pre-solve partials don't
    // belong in the leaderboard collection.
    if (!Number.isFinite(solvedAtVal) || !solvedAtVal) return;

    const streak = await _resolveStreakForFanout(db, uid, date);

    // Resolve display name + country. Prefer /profiles (public-read) for
    // displayName since that's where the in-app leaderboard ALSO looks
    // for it; fall back to /users for country (private, owner-only).
    let displayName = null;
    let country = null;
    try {
      const profSnap = await db.doc(`profiles/${uid}`).get();
      if (profSnap.exists) {
        const p = profSnap.data() || {};
        if (typeof p.displayName === "string") displayName = p.displayName;
      }
    } catch (_e) {}
    try {
      const uSnap = await db.doc(`users/${uid}`).get();
      if (uSnap.exists) {
        const u = uSnap.data() || {};
        if (!displayName && typeof u.displayName === "string") {
          displayName = u.displayName;
        }
        if (typeof u.country === "string" && u.country.length > 0) {
          country = u.country;
        }
      }
    } catch (_e) {}

    // Convert epoch-ms solvedAt → Firestore Timestamp for the legacy
    // schema (which the in-app leaderboard query expects).
    const solvedAtTs =
      admin.firestore.Timestamp.fromMillis(Math.floor(solvedAtVal));

    // Derive timeSec from startedAt → solvedAt. Null when startedAt is
    // missing/implausible (the canonical doc already nulled it out).
    let timeSec = null;
    if (Number.isFinite(startedAtVal) && startedAtVal > 0
        && solvedAtVal > startedAtVal) {
      timeSec = Math.round((solvedAtVal - startedAtVal) / 1000);
    }

    const ref = db.doc(`gameScores/${date}_${uid}`);
    const patch = {
      uid,
      date,
      correctCount: Number(correctCount) || 0,
      attempts: Number(attempts) || 0,
      streak: Number(streak) || 0,
      solvedAt: solvedAtTs,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (timeSec !== null) patch.timeSec = timeSec;
    if (displayName) patch.displayName = displayName;
    if (country) patch.country = country;

    await ref.set(patch, {merge: true});
  } catch (err) {
    // Fanout is best-effort — never block the user's sync on it. The
    // canonical bingoGames doc is the source of truth; this is a
    // denormalized mirror for legacy readers.
    logger.warn(`gameScores fanout failed for ${uid}/${date}`, err);
  }
}

exports.syncBingoProgress = onCall(USER_CALLABLE, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to sync.");
  }

  const data = request.data || {};
  const {date, cells, solvedAt, attempts, startedAt, clientWonAt} = data;

  // ── 1. Date validation ───────────────────────────────────────────────
  if (!isValidDateString(date)) {
    throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD");
  }
  const today = todayUtcDateKey();
  const ageDays = daysBetweenUtc(today, date);
  if (ageDays < 0) {
    // Future date — clock skew or tampering. Reject.
    throw new HttpsError("invalid-argument", "date is in the future");
  }
  if (ageDays > SYNC_MAX_AGE_DAYS) {
    throw new HttpsError(
      "failed-precondition",
      `date too old (>${SYNC_MAX_AGE_DAYS}d)`
    );
  }

  // ── 2. Cells validation ──────────────────────────────────────────────
  if (!Array.isArray(cells) || cells.length !== 9) {
    throw new HttpsError("invalid-argument", "cells must be a 9-element array");
  }
  const sanitized = cells.map(sanitizeCell);
  if (sanitized.some((c) => c === null)) {
    throw new HttpsError("invalid-argument", "cell payload malformed");
  }
  const correctCount = sanitized.filter((c) => c.state === "correct").length;

  // ── 3. Timestamp plausibility ────────────────────────────────────────
  const now = Date.now();
  // solvedAt: optional, but if present must be a recent epoch ms.
  let solvedAtVal = null;
  if (solvedAt !== null && solvedAt !== undefined) {
    if (!Number.isFinite(solvedAt)) {
      throw new HttpsError("invalid-argument", "solvedAt must be a number");
    }
    // Allow the client to be up to 7d behind ours (offline delay) and a
    // little ahead for clock skew. Anything wildly outside that is bogus.
    if (solvedAt > now + 60 * 1000) {
      throw new HttpsError("invalid-argument", "solvedAt is in the future");
    }
    if (solvedAt < now - SYNC_MAX_AGE_DAYS * 86400000) {
      throw new HttpsError("invalid-argument", "solvedAt too old");
    }
    solvedAtVal = solvedAt;
  }

  let startedAtVal = null;
  if (Number.isFinite(startedAt)) {
    startedAtVal = startedAt;
  }
  if (startedAtVal !== null && solvedAtVal !== null) {
    const dur = solvedAtVal - startedAtVal;
    if (dur < 0 || dur > MAX_GAME_DURATION_MS) {
      // Drop the implausible duration, but don't reject the whole sync —
      // the rest of the payload may still be useful. Just null out
      // startedAt so analytics don't aggregate garbage.
      startedAtVal = null;
    }
  }

  const attemptsTotal = Number.isInteger(attempts)
    ? Math.max(0, Math.min(1000, attempts))
    : sanitized.reduce((acc, c) => acc + (c.attempts || 0), 0);

  // ── 4. Write ────────────────────────────────────────────────────────
  // Last-write-wins on solvedAt: if a sync arrives that *claims* a solve
  // but our existing record already shows a solve at an earlier time, we
  // keep the earlier time. This makes the endpoint safely idempotent —
  // the same date can be synced repeatedly without flipping the "when
  // did you finish" timestamp on every retry.
  const db = admin.firestore();
  const ref = db
    .collection("users")
    .doc(uid)
    .collection("bingoGames")
    .doc(date);

  // Capture the post-transaction final values so the gameScores fanout
  // (below) sees the same solvedAt the canonical doc was written with.
  // The fanout itself runs OUTSIDE the transaction — it's best-effort
  // denormalization, not a correctness-critical step.
  let finalSolvedAtOut = null;
  let finalStartedAtOut = startedAtVal;
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      const prev = existing.exists ? existing.data() : null;

      let finalSolvedAt = solvedAtVal;
      if (
        prev &&
        Number.isFinite(prev.solvedAt) &&
        Number.isFinite(solvedAtVal)
      ) {
        finalSolvedAt = Math.min(prev.solvedAt, solvedAtVal);
      } else if (prev && Number.isFinite(prev.solvedAt) && solvedAtVal === null) {
        finalSolvedAt = prev.solvedAt;
      }

      // Carry the existing startedAt forward when the current sync nulled
      // it out (e.g. plausibility check failed) but a prior write recorded
      // a valid value — keeps timeSec computation stable across retries.
      let finalStartedAt = startedAtVal;
      if (finalStartedAt === null && prev && Number.isFinite(prev.startedAt)) {
        finalStartedAt = prev.startedAt;
      }

      finalSolvedAtOut = finalSolvedAt;
      finalStartedAtOut = finalStartedAt;

      tx.set(
        ref,
        {
          date,
          uid,
          cells: sanitized,
          correctCount,
          attempts: attemptsTotal,
          startedAt: finalStartedAt,
          solvedAt: finalSolvedAt,
          clientWonAt: Number.isFinite(clientWonAt) ? clientWonAt : null,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
    });
  } catch (err) {
    logger.error("syncBingoProgress write failed", {uid, date, err});
    throw new HttpsError("internal", "Could not save progress.");
  }

  // ── 5. Legacy gameScores fanout ──────────────────────────────────────
  // Mirror the solve into the legacy gameScores/{date}_{uid} schema so
  // the in-app leaderboard + push-trigger "played today?" check keep
  // working off this canonical write. Best-effort; never blocks the
  // caller. See BINGO_SCHEMA_RECONCILIATION.md for the full plan.
  await _fanoutToGameScores(db, uid, date, {
    correctCount,
    attempts: attemptsTotal,
    startedAtVal: finalStartedAtOut,
    solvedAtVal: finalSolvedAtOut,
  });

  return {ok: true, correctCount};
});
