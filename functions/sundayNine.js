// ─────────────────────────────────────────────────────────────────────────────
// Sunday Nine sync + server scoring
// ─────────────────────────────────────────────────────────────────────────────
// The client plays from localStorage and sends its RAW GUESS LOG here
// ({cell, pid} in order, plus gaveUp). Nothing the client computes is
// trusted: this callable rebuilds the day's grid, replays the log through
// the shared engine (functions/lib/sundayNineCore.js, generated from
// sunday-nine/engine.js) and stores the server's own score, streak and
// counts. Logo Bingo lessons applied up front:
//   - score server-side from raw input; never accept a client count/score
//   - the guess log is APPEND-ONLY once synced, so a wrong guess can't be
//     taken back by re-sending a shorter or edited log
//   - a finished round is frozen; re-syncs can't improve it
//   - the only shared collection (sundayNineDaily/{date}) is an anonymous
//     aggregate: no uid, no display name, auth-required read
//
// What we store:
//   users/{uid}/sundayNineGames/{date}   the round (owner-read, server-write)
//   users/{uid}/sundayNineStats/summary  streak, best, played (owner-read)
//   sundayNineDaily/{date}               plays, score histogram, answer picks
// ─────────────────────────────────────────────────────────────────────────────

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const core = require("./lib/sundayNineCore");
const {adminGate, ADMIN_ALLOWLIST} = require("./lib/adminGate");
const PLAYERS = require("./data/sunday-nine-players.json").players;
const PINNED = require("./data/sunday-nine-grids.json").grids;
// Rule set per date: a copy of /sunday-nine/rules.json (the file clients
// fetch), written by scripts/sync-sunday-nine.mjs. Falls back to the engine's
// built-in schedule if it is ever missing or unreadable.
const RULES_SCHEDULE = (() => {
  try {
    return core.parseRulesSchedule(require("./data/sunday-nine-rules.json"));
  } catch (_e) {
    return null;
  }
})();

const PLAYERS_BY_ID = Object.fromEntries(PLAYERS.map((p) => [p.id, p]));
const SYNC_MAX_AGE_DAYS = 7;
const MAX_GUESSES = 9 * core.MAX_ATTEMPTS;
const STREAK_LOOKBACK = 120;

const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  concurrency: 80,
  maxInstances: 100,
};

function sanitizeGuesses(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_GUESSES) return null;
  const out = [];
  for (const g of raw) {
    if (!g || !Number.isInteger(g.cell) || g.cell < 0 || g.cell > 8) return null;
    if (typeof g.pid !== "string" || !/^[a-z0-9-]{1,80}$/.test(g.pid)) return null;
    out.push({cell: g.cell, pid: g.pid});
  }
  return out;
}

const sameGuess = (a, b) => a.cell === b.cell && a.pid === b.pid;

// One-guess rules (core.oneGuess(date)): a square takes exactly one answer.
// Any later answer for a square that already has one is discarded before the
// log is scored or stored, so it can never count. The save itself succeeds:
// a stale three-guess client (an r404 tab left open past the switch) keeps
// its round and streak instead of having every later sync refused.
function keepFirstAnswerPerSquare(date, guesses) {
  if (!core.oneGuess(date)) return {guesses, dropped: 0};
  const seen = new Set();
  const out = [];
  for (const g of guesses) {
    if (seen.has(g.cell)) continue;
    seen.add(g.cell);
    out.push(g);
  }
  return {guesses: out, dropped: guesses.length - out.length};
}

// The rule set a round is scored with. A round already stored keeps the
// rules it started with (a later schedule edit can never re-score it); a new
// round takes the schedule's rules for its date. Rounds stored before rule
// ids existed are v1.
function rulesForRound(date, stored) {
  if (stored && stored.guesses) {
    return core.resolveRules({rules: stored.rules || "v1", maxMisses: stored.maxMisses}) ||
      core.rulesFor(date, RULES_SCHEDULE);
  }
  return core.rulesFor(date, RULES_SCHEDULE);
}

// Strike-limit rules (v3): the round ends on the miss that uses the last
// ball (or when all nine are solved). Every guess after that is dropped
// before the log is scored or stored, so it can never count. The save still
// succeeds (same spirit as keepFirstAnswerPerSquare): a stale client that
// kept guessing keeps its round and streak.
function dropAfterRoundEnd(grid, guesses, rules) {
  if (!rules.maxMisses) return {guesses, dropped: 0};
  const r = core.scoreGame(grid, PLAYERS_BY_ID, guesses, false, rules);
  if (r.endedAt === null || r.endedAt >= guesses.length) return {guesses, dropped: 0};
  return {guesses: guesses.slice(0, r.endedAt), dropped: guesses.length - r.endedAt};
}

function publicState(date, grid, guesses, gaveUp, result, rules) {
  return {
    rules: rules.id,
    maxMisses: rules.maxMisses,
    misses: result.misses || 0,
    date,
    rows: grid.rows,
    cols: grid.cols,
    guesses,
    gaveUp: !!gaveUp,
    cells: result.cells.map((c) => ({pid: c.pid, tries: c.tries, wrong: c.wrong, done: c.done})),
    strokes: result.strokes,
    toPar: result.toPar,
    correct: result.correct,
    complete: result.complete,
    sundayRed: result.sundayRed,
  };
}

// Before grid #1 (SUNDAY_NINE_EPOCH) there is no public grid. The admin
// allowlist (server-side, verified email — currently only the founder) may
// play grid #1 early as a phone test; that round is stored under the real
// date with preview: true and never counts toward stats or the aggregate.
function isPreviewDate(date) {
  return core.dayDiff(core.SUNDAY_NINE_EPOCH, date) < 0;
}

// Pure core of the callable, exported for unit tests.
// Under strike-limit rules a reply whose guesses were dropped carries
// conflict: true, so every client (including r407 and older, which only know
// that flag) adopts the server's log and shows the round as over.
function scoreSubmission(date, guesses, gaveUp, stored) {
  const gridDate = isPreviewDate(date) ? core.SUNDAY_NINE_EPOCH : date;
  const grid = core.gridForDate(gridDate, PLAYERS, PINNED);
  const rules = rulesForRound(date, stored);
  const prev = (stored && stored.guesses) || [];
  // Append-only: the new log must start with everything already synced.
  const extends_ = guesses.length >= prev.length &&
    prev.every((g, i) => sameGuess(g, guesses[i]));
  if (stored && stored.complete) {
    // Frozen. Under v3, guesses sent after the round ended are dropped.
    const dropped = rules.maxMisses && extends_ ? guesses.length - prev.length : 0;
    return {state: stored, changed: false, conflict: dropped > 0, dropped};
  }
  if (!extends_) {
    return {state: stored, changed: false, conflict: true, dropped: 0};
  }
  const gave = !!gaveUp || !!(stored && stored.gaveUp);
  const kept = dropAfterRoundEnd(grid, guesses, rules);
  const result = core.scoreGame(grid, PLAYERS_BY_ID, kept.guesses, gave, rules);
  return {
    state: publicState(date, grid, kept.guesses, gave, result, rules),
    changed: true, conflict: kept.dropped > 0, dropped: kept.dropped,
  };
}

exports.syncSundayNine = onCall({...USER_CALLABLE, secrets: [ADMIN_ALLOWLIST]}, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to save your round.");
  const data = request.data || {};
  const {date} = data;
  if (!core.isDateKey(date)) throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD");
  const today = core.todayKey();
  const age = core.dayDiff(date, today);
  if (age < 0) throw new HttpsError("invalid-argument", "date is in the future");
  if (age > SYNC_MAX_AGE_DAYS) throw new HttpsError("failed-precondition", "round too old to sync");
  const preview = isPreviewDate(date);
  if (preview) {
    try {
      adminGate(request);
    } catch (_e) {
      throw new HttpsError("failed-precondition", "Sunday Nine tees off " + core.SUNDAY_NINE_EPOCH);
    }
  }
  const sanitized = sanitizeGuesses(data.guesses);
  if (!sanitized) throw new HttpsError("invalid-argument", "guesses malformed");
  const {guesses, dropped} = keepFirstAnswerPerSquare(date, sanitized);
  if (dropped) logger.info("syncSundayNine: second answers discarded", {uid, date, dropped});

  const db = admin.firestore();
  const userRef = db.collection("users").doc(uid);
  const gameRef = userRef.collection("sundayNineGames").doc(date);

  let outcome;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const stored = snap.exists ? snap.data() : null;
    outcome = scoreSubmission(date, guesses, data.gaveUp === true, stored);
    outcome.newlyComplete = outcome.changed && outcome.state.complete && !(stored && stored.complete);
    if (!outcome.changed) return;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const doc = {...outcome.state, updatedAt: now};
    if (preview) doc.preview = true;
    if (!stored) doc.startedAt = now;
    if (outcome.newlyComplete) doc.completedAt = now;
    tx.set(gameRef, doc, {merge: true});
  });

  let stats = null;
  if (outcome.newlyComplete && !preview) {
    stats = await updateStats(db, userRef, date, outcome.state);
    await updateDaily(db, date, outcome.state).catch((e) =>
      logger.warn("syncSundayNine: daily aggregate failed", {date, err: e.message}));
  } else {
    const s = await userRef.collection("sundayNineStats").doc("summary").get();
    stats = s.exists ? s.data() : null;
  }
  // The client says which rules it played (r408+). Never trusted for
  // scoring; logged so a stale client or a rules.json deploy-order slip shows.
  const clientRules = typeof data.rules === "string" ? data.rules.slice(0, 8) : null;
  const serverRules = outcome.state && outcome.state.rules;
  if (serverRules && clientRules !== serverRules && (clientRules || serverRules !== "v1")) {
    logger.info("syncSundayNine: client rules differ", {uid, date, client: clientRules, server: outcome.state.rules});
  }
  if (outcome.dropped) {
    logger.info("syncSundayNine: guesses after the round ended discarded",
        {uid, date, dropped: outcome.dropped, rules: outcome.state && outcome.state.rules});
  } else if (outcome.conflict) {
    logger.info("syncSundayNine: non-append log rejected", {uid, date});
  }
  return {state: outcome.state, stats: stats && publicStats(stats), conflict: outcome.conflict, preview};
});

function publicStats(s) {
  return {
    current: s.current || 0, best: s.best || 0, played: s.played || 0,
    sundayReds: s.sundayReds || 0, lastCompleted: s.lastCompleted || null,
    bestStrokes: s.bestStrokes || null,
  };
}

// Streak is recomputed from the finished game docs every time — never
// incremented from a client claim — so out-of-order offline syncs still
// land on the right number.
// Doc ids are YYYY-MM-DD, one game per day, so the last STREAK_LOOKBACK days
// hold every game the streak can reach. A range on the id ascending uses the
// automatic index; the previous orderBy(documentId, "desc") needed a composite
// index that doesn't exist and failed every finished round with a 500 (no
// stats, no daily aggregate) from launch until r406.
function lookbackStart(date) {
  const d = new Date(String(date) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - STREAK_LOOKBACK);
  return d.toISOString().slice(0, 10);
}
async function updateStats(db, userRef, date, state) {
  const games = await userRef.collection("sundayNineGames")
      .where(admin.firestore.FieldPath.documentId(), ">=", lookbackStart(date))
      .get();
  const finished = games.docs
      .filter((d) => d.get("complete") === true && d.get("preview") !== true)
      .map((d) => d.id)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const statsRef = userRef.collection("sundayNineStats").doc("summary");
  let out;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(statsRef);
    const prev = snap.exists ? snap.data() : {};
    const latest = finished.length ? finished[0] : date;
    const current = core.streakFrom(finished, latest);
    out = {
      current,
      best: Math.max(prev.best || 0, current),
      played: (prev.played || 0) + 1,
      sundayReds: (prev.sundayReds || 0) + (state.sundayRed ? 1 : 0),
      lastCompleted: latest,
      bestStrokes: prev.bestStrokes ? Math.min(prev.bestStrokes, state.strokes) : state.strokes,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    tx.set(statsRef, out, {merge: true});
  });
  return out;
}

// Anonymous per-day aggregate: how many finished, the score spread, and how
// often each player was picked per square (for "rarity" after the round).
// No uid or name is written here.
async function updateDaily(db, date, state) {
  const inc = admin.firestore.FieldValue.increment;
  // Nested objects, not dotted keys: set(..., {merge: true}) treats a
  // dotted key as a literal field name.
  const picks = {};
  state.cells.forEach((c, i) => {
    if (c.pid) picks["c" + i] = {[c.pid]: inc(1)};
  });
  const upd = {
    plays: inc(1),
    strokes: {[String(state.strokes)]: inc(1)},
    picks,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (state.sundayRed) upd.sundayReds = inc(1);
  await db.collection("sundayNineDaily").doc(date).set(upd, {merge: true});
}

exports.__test = {
  lookbackStart, scoreSubmission, sanitizeGuesses, isPreviewDate, keepFirstAnswerPerSquare,
  rulesForRound, dropAfterRoundEnd, RULES_SCHEDULE, PLAYERS, PINNED,
};
