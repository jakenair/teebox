// GENERATED FILE - DO NOT EDIT.
// Built from /bingo-select.mjs by scripts/sync-bingo-select.mjs.
// Edit the source, then re-run that script (or `npm run build:web`).
// source-sha256: 3b6e2552fb4b65db

// bingo-select.mjs
//
// THE board-selection algorithm for Logo Bingo. Single source of truth.
//
// This file is the ONLY implementation. It is imported by:
//   - the web client          (index.html, <script type="module">)
//   - the iOS bundle          (copied verbatim by `npm run build:web`)
//   - the Cloud Function      (copied to functions/lib/ by the canon generator)
//   - the parity test         (scripts/test-bingo-cross-platform.mjs)
//
// Every copy must be byte-identical; scripts/check-bingo-single-source.mjs
// fails the build if any of them drifts. Do not re-implement this logic
// anywhere — a re-implementation is exactly how the 2026-10-01 divergence
// went unnoticed (the old parity test compared the server against its own
// third copy, so it could never see that the shipped iOS bundle disagreed).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THERE ARE TWO ALGORITHMS
//
// `legacySelect` (dates before CUTOVER_DATE) is the original algorithm,
// preserved verbatim so every historical board stays reproducible forever.
// Do not touch it. Puzzle docs are immutable once their date has passed,
// and bingoSync scores saved games positionally against the stored board.
//
// `stableSelect` (CUTOVER_DATE onward) replaces it because the legacy one
// couples the board to the POOL LENGTH in two places:
//   - windowCount = floor(poolSize / 9)  -> shifts cycle and windowIndex
//   - a Fisher-Yates over the whole pool -> a different-length array against
//     the same RNG stream yields an entirely different permutation
// so retiring a single logo (r295, royal-county-down) re-rolled every future
// board. Measured over 30 days: a one-course pool change rewrote an average
// of 8.37 of 9 tiles, worst case 9 of 9.
//
// `stableSelect` scores each course independently as hash(seed:date:id) and
// takes the nine lowest. No pool length, no array index — a course's score
// depends only on its own id and the date, so adding or retiring a course
// can only displace the selection boundary. Same measurement: average 0.10
// of 9 tiles, worst case 1.
//
// The 3-day lookback restores the "never the same logo two days running"
// property that the legacy cycle gave for free. It bans what was ACTUALLY
// shown on each of the previous three days.
//
// Banning each prior day's final board (rather than its unfiltered top-9)
// is required for correctness, and the first implementation got this wrong:
// using unfiltered rankings, 2026-10-06 repeated skene-valley from 10-05,
// because 10-05's real board had been filtered against the legacy days at
// the seam and no longer matched its own top-9. Measured cost of doing it
// properly: drift goes from 0.10 to 0.17 average (worst 1 -> 2 of 9), which
// is still ~50x better than the legacy algorithm's 8.37.
//
// Because each day's board depends on the three before it, the chain is
// computed FORWARD and memoized, and it starts at
// max(CUTOVER_DATE, date - CHAIN_WARMUP_DAYS) so the work stays bounded
// however far in the future we go. Both server and client apply the same
// rule, so they agree exactly. The warmup is far longer than the 3-day
// window that actually determines a board, so it only has to be stable,
// not long.
//
// Tuning: scripts/bingo-k-sweep.mjs sweeps the lookback window. Re-run it
// if the pool grows a lot.
// ─────────────────────────────────────────────────────────────────────────

const SEED = "teebox-bingo-canon-v3";
const EPOCH_UTC = "2026-01-01T00:00:00Z";
const BOARD_SIZE = 9;

// Founder ruling 2026-10-01: boards on and after this UTC date use
// stableSelect. 2026-10-01..04 were already generated and in some cases
// already played, so they keep the legacy algorithm.
// NOTE: this is a UTC date. The switch lands at 00:00 UTC on 2026-10-05,
// which is 7:00pm US Central on 2026-10-04.
const CUTOVER_DATE = "2026-10-05";

const LOOKBACK_DAYS = 3;

// How far back the forward-computed chain starts, so cost stays bounded for
// dates far past the cutover. Must stay comfortably above LOOKBACK_DAYS and
// must NEVER change once boards are live — it is part of the definition of
// a board, so changing it would re-roll every future puzzle.
const CHAIN_WARMUP_DAYS = 30;

function hashStr(s) {
  let h = 2166136261 >>> 0; // FNV-1a 32-bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daysSinceEpoch(dateStr) {
  const today = new Date(dateStr + "T00:00:00Z");
  const epoch = new Date(EPOCH_UTC);
  return Math.max(0, Math.floor((today - epoch) / 86400000));
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ── LEGACY (dates < CUTOVER_DATE). Frozen. Do not modify. ────────────────
function legacySelect(dateStr, pool) {
  const pool0 = pool;
  const daysSince = daysSinceEpoch(dateStr);
  const poolSize = pool0.length;
  const windowCount = Math.max(1, Math.floor(poolSize / BOARD_SIZE));
  const cycle = Math.floor(daysSince / windowCount);
  const windowIndex = daysSince % windowCount;
  const cycleShuffle = (cyc) => {
    const rng = mulberry32(hashStr(SEED + ":cycle:" + cyc));
    const p = pool0.slice();
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    return p;
  };
  const arr = cycleShuffle(cycle);
  if (cycle > 0) {
    const prev = cycleShuffle(cycle - 1);
    const forbidden = new Set(
        prev.slice((windowCount - 1) * BOARD_SIZE, windowCount * BOARD_SIZE)
            .map((c) => c.id));
    for (let i = 0; i < BOARD_SIZE; i++) {
      if (forbidden.has(arr[i].id)) {
        for (let j = poolSize - 10; j >= BOARD_SIZE; j--) {
          if (!forbidden.has(arr[j].id)) {
            const t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
            break;
          }
        }
      }
    }
  }
  const start = windowIndex * BOARD_SIZE;
  return arr.slice(start, start + BOARD_SIZE);
}

// ── STABLE (dates >= CUTOVER_DATE) ───────────────────────────────────────

/** Every course scored for one date, ascending. Ties break on id so the
 * order never depends on the pool's own ordering. */
function rankForDate(dateStr, pool) {
  return pool
      .map((c) => ({course: c, h: hashStr(SEED + ":" + dateStr + ":" + c.id)}))
      .sort((a, b) =>
        (a.h - b.h) || (a.course.id < b.course.id ? -1 : 1))
      .map((x) => x.course);
}

/** One day's board given the ban set, with no recursion. */
function pickWithBan(dateStr, pool, banned) {
  const ranked = rankForDate(dateStr, pool);
  const out = [];
  for (const c of ranked) {
    if (out.length === BOARD_SIZE) break;
    if (!banned.has(c.id)) out.push(c);
  }
  // Degenerate safety net: a pool barely larger than the ban set could come
  // up short. Backfill in rank order so a board is always exactly 9.
  if (out.length < BOARD_SIZE) {
    const have = new Set(out.map((c) => c.id));
    for (const c of ranked) {
      if (out.length === BOARD_SIZE) break;
      if (!have.has(c.id)) out.push(c);
    }
  }
  return out;
}

// pool array -> Map<dateStr, board>. WeakMap so a caller passing a different
// pool (tests, the K sweep) gets its own chain and can't poison the real one.
const chainCache = new WeakMap();

function stableSelect(dateStr, pool) {
  let cache = chainCache.get(pool);
  if (!cache) {
    cache = new Map();
    chainCache.set(pool, cache);
  }
  if (cache.has(dateStr)) return cache.get(dateStr);

  // Walk forward from the chain start, filling the cache as we go. Every
  // day's ban set is the ACTUAL board of the three days before it; days
  // before the cutover contribute their real legacy board, which is what
  // makes the seam honest (2026-10-05 excludes what players saw on 10-04).
  const warmStart = shiftDate(dateStr, -CHAIN_WARMUP_DAYS);
  let cursor = warmStart < CUTOVER_DATE ? CUTOVER_DATE : warmStart;

  const boardFor = (d) => {
    if (d < CUTOVER_DATE) return legacySelect(d, pool);
    return cache.get(d) || null;
  };

  while (cursor <= dateStr) {
    if (!cache.has(cursor)) {
      const banned = new Set();
      for (let i = 1; i <= LOOKBACK_DAYS; i++) {
        const prev = boardFor(shiftDate(cursor, -i));
        // null only when a prior in-chain day fell outside the warmup
        // window; that day simply contributes nothing to the ban set.
        if (prev) for (const c of prev) banned.add(c.id);
      }
      cache.set(cursor, pickWithBan(cursor, pool, banned));
    }
    cursor = shiftDate(cursor, 1);
  }
  return cache.get(dateStr);
}

/**
 * The nine courses for a UTC date. Returns entries from `pool` itself, in
 * board order.
 *
 * @param {string} dateStr UTC date, "YYYY-MM-DD".
 * @param {Array<{id: string}>} pool Eligible courses (COURSES filtered by
 *   LOGOS_AVAILABLE on the client; the canon array on the server). Both
 *   sides must pass the same pool or the boards will not match.
 * @return {Array<object>} Nine course objects, in order.
 */
function selectBoard(dateStr, pool) {
  if (!Array.isArray(pool) || pool.length < BOARD_SIZE) return [];
  return dateStr < CUTOVER_DATE ?
      legacySelect(dateStr, pool) :
      stableSelect(dateStr, pool);
}

/** Convenience: just the ids. */
function selectBoardIds(dateStr, pool) {
  return selectBoard(dateStr, pool).map((c) => c.id);
}

module.exports = {
  SEED,
  EPOCH_UTC,
  BOARD_SIZE,
  CUTOVER_DATE,
  LOOKBACK_DAYS,
  CHAIN_WARMUP_DAYS,
  hashStr,
  mulberry32,
  selectBoard,
  selectBoardIds,
};
