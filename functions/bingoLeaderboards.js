/**
 * functions/bingoLeaderboards.js — Logo Bingo leaderboards (additive).
 *
 * Required by functions/index.js with one line at the bottom:
 *     Object.assign(exports, require("./bingoLeaderboards"));
 *
 * Adds four leaderboard surfaces on top of the existing daily Logo Bingo
 * game. Strictly ADDITIVE — never refactors offline-play's syncBingoProgress
 * or the users/{uid}/bingoGames/{date} schema; instead reacts to it via a
 * Firestore onDocumentCreated trigger and exposes four callables that the
 * client can poll after a win is synced.
 *
 *  1. Global daily ………… percentile of your solve time vs everyone today.
 *  2. Friends …………………… top 10 + your rank among your followed/transacted users.
 *  3. Country …………………… percentile scoped to your country (if `users.country`).
 *  4. All-time streak ……… global current/all-time record + your personal best.
 *
 * Schema (server-owned; client cannot write):
 *   bingoLeaderboard/{YYYY-MM-DD}
 *     totalPlayers:   number
 *     totalSolvers:   number
 *     histogram:      { '0-30s': N, '31-60s': N, '61-120s': N,
 *                       '121-300s': N, '301-600s': N, '601+': N }
 *     byAttempts:     { '1': N, '2': N, '3': N, '4+': N }
 *     generatedAt:    Timestamp
 *
 *   bingoLeaderboard/{date}/countries/{ISO-3166-1-alpha-2}
 *     totalSolvers:   number
 *     histogram:      { same buckets as global }
 *
 *   bingoGlobalStats/all
 *     currentLongestActiveStreak: { uid, displayName, streak, sinceDate }
 *     allTimeLongestStreak:       { uid, displayName, streak, atDate }
 *
 *   users/{uid}.bingoBestStreak:    number   (NEW)
 *   users/{uid}.bingoBestStreakAt:  Timestamp (NEW)
 *
 * Race-safety: aggregation uses FieldValue.increment exclusively. The
 * trigger fires once per user per day (onDocumentCreated, not onUpdated),
 * so double-counting cannot happen even if syncBingoProgress retries.
 *
 * Cost model (per solve):
 *   - 1 user read (for country / best-streak comparison)
 *   - 1 aggregate write (global histogram)
 *   - 1 conditional aggregate write (country histogram, if country set)
 *   - 1 conditional user update (if this is a new personal best streak)
 *   - 1 conditional global stats update (if new global record)
 *
 * Cost model (per callable):
 *   - getBingoPercentile:        2 reads (user game doc + global doc)
 *   - getBingoCountryPercentile: 2 reads (user game + country doc)
 *   - getBingoFriendsBoard:      1 + N reads (user doc + up to 50 friend games)
 *   - getBingoGlobalStreakRecord: 1 read  (bingoGlobalStats/all)
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

// Re-use the sizing constants from index.js without importing it (avoid
// circular requires — index.js requires us at the bottom). These values
// mirror USER_CALLABLE / LIGHT_TRIGGER from index.js exactly.
const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  concurrency: 80,
  maxInstances: 100,
};
const LIGHT_TRIGGER = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 80,
  maxInstances: 100,
};

// ─── Bucketing helpers ──────────────────────────────────────────────
// Time buckets are coarse enough that one slow solve doesn't move the
// percentile noticeably, but fine enough that the median solver lands
// in a different bucket than a speed-runner. Adjust if real-world
// distribution skews; histogram math doesn't care about the labels.
const TIME_BUCKETS = [
  "0-30s", "31-60s", "61-120s", "121-300s", "301-600s", "601+",
];
function bucketTime(timeSec) {
  const t = Number(timeSec) || 0;
  if (t <= 30) return "0-30s";
  if (t <= 60) return "31-60s";
  if (t <= 120) return "61-120s";
  if (t <= 300) return "121-300s";
  if (t <= 600) return "301-600s";
  return "601+";
}
function bucketAttempts(attempts) {
  const a = Number(attempts) || 0;
  if (a <= 1) return "1";
  if (a === 2) return "2";
  if (a === 3) return "3";
  return "4+";
}

// Compute solve duration in seconds from the offline-play schema, which
// stores epoch-ms `startedAt` and `solvedAt` rather than a denormalized
// timeSec. Returns 601 ("601+" bucket, neutral) when we genuinely can't
// determine the duration.
function timeSecFromGame(game) {
  const s = Number(game && game.solvedAt) || 0;
  const t = Number(game && game.startedAt) || 0;
  if (!s || !t || s <= t) return 601;
  return Math.round((s - t) / 1000);
}

/**
 * Pro-rated percentile from a discrete histogram.
 * Returns the percentage of solvers SLOWER than `userTimeSec`.
 * Within the user's own bucket we assume uniform distribution and
 * split the bucket in half — gives a stable answer when one bucket
 * dominates the total.
 *
 * Returns an integer 0..99 (never 100, since you can't beat yourself).
 */
function computePercentile(userTimeSec, histogram, totalSolvers) {
  if (!totalSolvers || totalSolvers < 1) return 0;
  const h = histogram || {};
  const userBucket = bucketTime(userTimeSec);
  const userBucketIdx = TIME_BUCKETS.indexOf(userBucket);
  let slowerCount = 0;
  for (let i = userBucketIdx + 1; i < TIME_BUCKETS.length; i++) {
    slowerCount += Number(h[TIME_BUCKETS[i]]) || 0;
  }
  // Pro-rate within the user's own bucket.
  const sameBucketCount = Number(h[userBucket]) || 1;
  slowerCount += sameBucketCount / 2;
  const pct = Math.round((slowerCount / totalSolvers) * 100);
  return Math.max(0, Math.min(99, pct));
}

// ─── Cross-trigger / cross-callable helpers ─────────────────────────
async function fetchUserDoc(db, uid) {
  try {
    const snap = await db.doc(`users/${uid}`).get();
    return snap.exists ? (snap.data() || {}) : {};
  } catch (e) {
    logger.warn(`bingoLeaderboards: user fetch failed for ${uid}`, e);
    return {};
  }
}

async function fetchDisplayName(db, uid) {
  // profiles is public-read (per firestore.rules) so this works even
  // when we're returning data about another user to the requester.
  try {
    const snap = await db.doc(`profiles/${uid}`).get();
    if (snap.exists) {
      const d = snap.data() || {};
      if (d.displayName) return String(d.displayName);
    }
  } catch (_e) { /* ignore */ }
  return `Player ${String(uid).slice(-4).toUpperCase()}`;
}

/**
 * If `streak` exceeds the current all-time global record, update it.
 * Also tracks the longest CURRENTLY ACTIVE streak so we can show
 * "global record: 312 days — alive 47 days". The active record can
 * decay; the all-time record is monotonic.
 *
 * Idempotent: re-running with the same uid/streak/date is a no-op.
 */
async function maybeUpdateGlobalStreakRecord(db, uid, displayName, streak, date) {
  if (!streak || streak < 1) return;
  const statsRef = db.doc("bingoGlobalStats/all");
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(statsRef);
      const cur = snap.exists ? (snap.data() || {}) : {};
      const allTime = cur.allTimeLongestStreak || {};
      const active = cur.currentLongestActiveStreak || {};
      const patch = {};
      if ((Number(allTime.streak) || 0) < streak) {
        patch.allTimeLongestStreak = {
          uid, displayName, streak, atDate: date,
        };
      }
      // The active record is replaced if this user's streak is now
      // longer than the previously tracked active leader. Active
      // leader expiration (when someone breaks their streak) is
      // best-effort — we don't track it here; the next win after a
      // break will overwrite it.
      if ((Number(active.streak) || 0) < streak || active.uid === uid) {
        patch.currentLongestActiveStreak = {
          uid, displayName, streak, sinceDate: date,
        };
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        tx.set(statsRef, patch, {merge: true});
      }
    });
  } catch (e) {
    logger.warn("maybeUpdateGlobalStreakRecord failed", e);
  }
}

// ─── Trigger: onBingoWinAggregate ───────────────────────────────────
// Fires every time syncBingoProgress writes users/{uid}/bingoGames/{date}.
// We aggregate exactly ONCE per (uid, date) — on the document write where
// `solvedAt` transitions from null/missing to a number. Subsequent updates
// (e.g. re-syncs from the offline-play queue) are no-ops.
//
// Doc shape we observe (from ./bingoSync.js — DO NOT REFACTOR):
//   { date, uid, cells, correctCount, attempts,
//     startedAt: epoch ms | null,
//     solvedAt:  epoch ms | null,
//     clientWonAt, syncedAt }
//
// Notes:
//   - `solvedAt` is a NUMBER (epoch ms), not a Firestore Timestamp.
//   - `timeSec` is derived from solvedAt - startedAt (NOT stored on the doc).
//   - streak is NOT stored on the doc — we compute it server-side from the
//     prior consecutive-day doc(s), capped to avoid runaway reads.
//
// Why onDocumentWritten and not onDocumentCreated?
//   syncBingoProgress writes with set({merge:true}). The doc is typically
//   CREATED on the user's first tap (partial progress, no solvedAt) and
//   UPDATED with a solvedAt later when they complete the puzzle. The win
//   we care about is therefore an update, not a create.
exports.onBingoWinAggregate = onDocumentWritten(
  {document: "users/{uid}/bingoGames/{date}", ...LIGHT_TRIGGER},
  async (event) => {
    try {
      const after = event.data && event.data.after && event.data.after.data();
      const before = event.data && event.data.before && event.data.before.data();
      if (!after) return;            // doc deleted — nothing to do
      if (!after.solvedAt) return;   // not solved yet
      // Idempotency guard: aggregate exactly once per (uid, date), on the
      // write where solvedAt first becomes non-null. Any later write with
      // solvedAt already set is a re-sync; skip.
      if (before && before.solvedAt) return;

      const {uid, date} = event.params;
      const solvedAtMs = Number(after.solvedAt) || 0;
      const startedAtMs = Number.isFinite(after.startedAt)
        ? Number(after.startedAt) : null;
      // Duration: solvedAt - startedAt. If startedAt was nulled out by
      // syncBingoProgress's plausibility check, fall back to a generous
      // bucket so the solve still counts but doesn't skew the histogram
      // toward "fast" — assume worst-case 601+ when we genuinely don't know.
      let timeSec;
      if (startedAtMs && solvedAtMs > startedAtMs) {
        timeSec = Math.round((solvedAtMs - startedAtMs) / 1000);
      } else {
        timeSec = 601; // unknown → "601+" bucket, neutral effect on percentile
      }
      const attempts = Number(after.attempts) || 0;
      const timeBucket = bucketTime(timeSec);
      const attemptsBucket = bucketAttempts(attempts);

      const db = admin.firestore();
      const user = await fetchUserDoc(db, uid);
      const country = user.country || null;

      // Atomic global aggregate. Using set({merge:true}) with increments
      // means we never read-modify-write; concurrent solves can't race.
      const globalRef = db.doc(`bingoLeaderboard/${date}`);
      await globalRef.set({
        totalPlayers: admin.firestore.FieldValue.increment(1),
        totalSolvers: admin.firestore.FieldValue.increment(1),
        [`histogram.${timeBucket}`]: admin.firestore.FieldValue.increment(1),
        [`byAttempts.${attemptsBucket}`]: admin.firestore.FieldValue.increment(1),
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});

      // Country-scoped aggregate (only if user has a country set).
      if (country && typeof country === "string" && country.length <= 8) {
        const countryRef = db.doc(
          `bingoLeaderboard/${date}/countries/${country}`,
        );
        await countryRef.set({
          totalSolvers: admin.firestore.FieldValue.increment(1),
          [`histogram.${timeBucket}`]: admin.firestore.FieldValue.increment(1),
        }, {merge: true});
      }

      // ── Streak (server-computed) ──────────────────────────────────
      // The doc doesn't carry a streak field, so we derive it: walk
      // back day-by-day looking for solved bingoGames docs. Cap the
      // walk at MAX_STREAK_LOOKBACK to keep this trigger O(1) per event.
      const MAX_STREAK_LOOKBACK = 30;
      let streak = 1;
      try {
        let cursor = date;
        for (let i = 0; i < MAX_STREAK_LOOKBACK; i++) {
          const prev = prevDateUtc(cursor);
          const prevSnap = await db
            .doc(`users/${uid}/bingoGames/${prev}`).get();
          if (!prevSnap.exists) break;
          const pd = prevSnap.data() || {};
          if (!pd.solvedAt) break;
          streak += 1;
          cursor = prev;
        }
      } catch (e) {
        logger.warn(`streak walk failed for ${uid}/${date}`, e);
      }

      // Personal best — only update if this run is strictly better.
      const currentBest = Number(user.bingoBestStreak) || 0;
      if (streak > currentBest) {
        try {
          await db.doc(`users/${uid}`).set({
            bingoBestStreak: streak,
            bingoBestStreakAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
        } catch (e) {
          logger.warn(`bingoBestStreak update failed for ${uid}`, e);
        }
        const displayName = await fetchDisplayName(db, uid);
        await maybeUpdateGlobalStreakRecord(db, uid, displayName, streak, date);
      }

      logger.info(
        `onBingoWinAggregate: ${uid} solved ${date} in ${timeSec}s (${timeBucket}, ${attemptsBucket} attempts)${country ? ` [${country}]` : ""} streak=${streak}${streak > currentBest ? " PB" : ""}`,
      );
    } catch (err) {
      logger.error("onBingoWinAggregate error", err);
    }
  },
);

// Returns YYYY-MM-DD one day before the given date, computed in UTC.
function prevDateUtc(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ─── Callable: getBingoPercentile ───────────────────────────────────
// Returns the user's global percentile rank for `date`. Reads:
//   - users/{uid}/bingoGames/{date}   (user's own solve)
//   - bingoLeaderboard/{date}         (global histogram)
//
// If the user hasn't solved (or hasn't synced yet), returns
// { synced: false } so the client can show "Will calculate when you
// reconnect" without an error toast.
exports.getBingoPercentile = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const date = String((request.data && request.data.date) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD");
  }

  const db = admin.firestore();
  const [gameSnap, lbSnap] = await Promise.all([
    db.doc(`users/${uid}/bingoGames/${date}`).get(),
    db.doc(`bingoLeaderboard/${date}`).get(),
  ]);

  if (!gameSnap.exists) return {synced: false};
  const game = gameSnap.data() || {};
  if (!game.solvedAt) return {synced: false, solved: false};

  const lb = lbSnap.exists ? (lbSnap.data() || {}) : {};
  const histogram = lb.histogram || {};
  const totalSolvers = Number(lb.totalSolvers) || 0;
  const yourTimeSec = timeSecFromGame(game);
  const yourAttempts = Number(game.attempts) || 0;

  // If aggregation hasn't fired yet (race between the win sync and
  // the trigger), surface a hint to the client to retry shortly.
  if (totalSolvers < 1) {
    return {
      synced: true,
      solved: true,
      pending: true,
      yourTimeSec,
      yourAttempts,
    };
  }

  return {
    synced: true,
    solved: true,
    percentile: computePercentile(yourTimeSec, histogram, totalSolvers),
    totalSolvers,
    yourTimeSec,
    yourAttempts,
  };
});

// ─── Callable: getBingoCountryPercentile ────────────────────────────
// Same shape as global, scoped to the requester's country. If the user
// has no country field set, returns { countrySet: false } so the
// client renders the "Add your country to see this leaderboard" CTA.
exports.getBingoCountryPercentile = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const date = String((request.data && request.data.date) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD");
  }

  const db = admin.firestore();
  const user = await fetchUserDoc(db, uid);
  const country = user.country || null;
  if (!country) return {countrySet: false};

  const [gameSnap, countrySnap] = await Promise.all([
    db.doc(`users/${uid}/bingoGames/${date}`).get(),
    db.doc(`bingoLeaderboard/${date}/countries/${country}`).get(),
  ]);
  if (!gameSnap.exists) return {countrySet: true, country, synced: false};
  const game = gameSnap.data() || {};
  if (!game.solvedAt) {
    return {countrySet: true, country, synced: false, solved: false};
  }

  const lb = countrySnap.exists ? (countrySnap.data() || {}) : {};
  const histogram = lb.histogram || {};
  const totalSolvers = Number(lb.totalSolvers) || 0;
  const yourTimeSec = timeSecFromGame(game);

  if (totalSolvers < 1) {
    return {
      countrySet: true, country, synced: true, solved: true, pending: true,
      yourTimeSec,
    };
  }
  return {
    countrySet: true,
    country,
    synced: true,
    solved: true,
    percentile: computePercentile(yourTimeSec, histogram, totalSolvers),
    totalSolvers,
    yourTimeSec,
  };
});

// ─── Callable: getBingoFriendsBoard ─────────────────────────────────
// Resolves "friends" — preferring users/{uid}.following[] if present;
// otherwise falling back to recent order counterparties (capped at 50).
// Returns the top 10 (sorted by solved DESC, attempts ASC, timeSec ASC)
// plus the requester's own row if they're outside the top 10.
exports.getBingoFriendsBoard = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const date = String((request.data && request.data.date) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD");
  }

  const db = admin.firestore();
  const user = await fetchUserDoc(db, uid);

  // 1. Resolve the friend uid set.
  let friendUids = [];
  if (Array.isArray(user.following) && user.following.length) {
    friendUids = user.following.filter(
      (id) => typeof id === "string" && id.length > 0 && id !== uid,
    ).slice(0, 100);
  } else {
    // Fallback: order counterparties. Two parallel queries because
    // there's no OR operator that hits both buyerId and sellerId
    // efficiently without a composite index we don't have.
    try {
      const [asBuyer, asSeller] = await Promise.all([
        db.collection("orders").where("buyerId", "==", uid)
          .orderBy("createdAt", "desc").limit(50).get(),
        db.collection("orders").where("sellerId", "==", uid)
          .orderBy("createdAt", "desc").limit(50).get(),
      ]);
      const set = new Set();
      asBuyer.forEach((d) => {
        const v = d.data() || {};
        if (v.sellerId && v.sellerId !== uid) set.add(v.sellerId);
      });
      asSeller.forEach((d) => {
        const v = d.data() || {};
        if (v.buyerId && v.buyerId !== uid) set.add(v.buyerId);
      });
      friendUids = [...set].slice(0, 50);
    } catch (e) {
      // Composite index might be missing in some envs — log + continue
      // with an empty friend set rather than failing the whole call.
      logger.warn("getBingoFriendsBoard: orders fallback failed", e);
      friendUids = [];
    }
  }

  // Always include the requester so they see their own row.
  const allUids = [...new Set([uid, ...friendUids])];

  // 2. Fetch each friend's bingoGames/{date} in parallel. One read per
  // friend; capped at 51 reads (50 friends + self). Acceptable.
  const gameSnaps = await Promise.all(
    allUids.map((fid) => db.doc(`users/${fid}/bingoGames/${date}`).get()),
  );

  // 3. Resolve display names + avatars in parallel from /profiles
  // (public-read). Best-effort; missing profiles get a placeholder.
  const profileSnaps = await Promise.all(
    allUids.map((fid) => db.doc(`profiles/${fid}`).get().catch(() => null)),
  );

  const rows = [];
  let friendsWhoSolved = 0;
  allUids.forEach((fid, i) => {
    const gs = gameSnaps[i];
    const ps = profileSnaps[i];
    const profile = (ps && ps.exists) ? (ps.data() || {}) : {};
    const displayName = profile.displayName
      || `Player ${String(fid).slice(-4).toUpperCase()}`;
    const photoUrl = profile.avatarUrl || null;
    if (gs && gs.exists) {
      const g = gs.data() || {};
      const solved = !!g.solvedAt;
      if (solved && fid !== uid) friendsWhoSolved += 1;
      rows.push({
        uid: fid,
        displayName,
        photoUrl,
        timeSec: solved ? timeSecFromGame(g) : 0,
        attempts: Number(g.attempts) || 0,
        solved,
        isYou: fid === uid,
      });
    } else {
      rows.push({
        uid: fid,
        displayName,
        photoUrl,
        timeSec: 0,
        attempts: 0,
        solved: false,
        isYou: fid === uid,
      });
    }
  });

  // 4. Sort: solved first, then fewer attempts, then faster time.
  rows.sort((a, b) => {
    if (a.solved !== b.solved) return a.solved ? -1 : 1;
    if (a.attempts !== b.attempts) return a.attempts - b.attempts;
    return a.timeSec - b.timeSec;
  });

  // 5. Top 10 + always include self.
  const top = rows.slice(0, 10);
  const youIdx = rows.findIndex((r) => r.isYou);
  const yourRank = youIdx >= 0 ? youIdx + 1 : null;
  if (youIdx >= 10) top.push(rows[youIdx]);

  return {
    entries: top.map((r) => ({
      uid: r.uid,
      displayName: r.displayName,
      photoUrl: r.photoUrl,
      timeSec: r.timeSec,
      attempts: r.attempts,
      solved: r.solved,
      isYou: r.isYou,
    })),
    yourRank,
    totalFriends: friendUids.length,
    friendsWhoSolved,
  };
});

// ─── Callable: getBingoGlobalStreakRecord ───────────────────────────
// One read: bingoGlobalStats/all. Also returns the requester's personal
// best streak so the UI can render both numbers without a second call.
exports.getBingoGlobalStreakRecord = onCall(USER_CALLABLE, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const uid = request.auth.uid;
  const db = admin.firestore();
  const [statsSnap, userSnap] = await Promise.all([
    db.doc("bingoGlobalStats/all").get(),
    db.doc(`users/${uid}`).get(),
  ]);
  const stats = statsSnap.exists ? (statsSnap.data() || {}) : {};
  const user = userSnap.exists ? (userSnap.data() || {}) : {};
  return {
    allTimeLongestStreak: stats.allTimeLongestStreak || null,
    currentLongestActiveStreak: stats.currentLongestActiveStreak || null,
    yourBestStreak: Number(user.bingoBestStreak) || 0,
    yourBestStreakAt: user.bingoBestStreakAt || null,
  };
});
