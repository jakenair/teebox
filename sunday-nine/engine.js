// sunday-nine/engine.js — Sunday Nine game rules: daily grid selection,
// answer matching, golf scoring, share text.
//
// Single authored copy, shared by the browser, scripts/build-sunday-nine.mjs
// and the Cloud Function (via the generated functions/lib/sundayNineCore.js —
// run `node scripts/sync-sunday-nine.mjs` after editing this file or
// categories.js). The server re-scores every game from the raw guess list with
// THIS code, so a client can never write its own score, streak or counts.

import {CATEGORIES, CATEGORY_BY_ID, matches, groupsClash} from "./categories.js";

// Grid #1. A Sunday, naturally.
export const SUNDAY_NINE_EPOCH = "2026-11-08";
export const SUNDAY_NINE_TZ = "America/Chicago";
export const PAR_PER_HOLE = 3;
export const PAR = 27;
export const MAX_ATTEMPTS = 3;
// One guess per square from this grid on (founder, 2026-11-09): right is a
// birdie (2), wrong or unanswered is a double bogey (5). Earlier dates keep
// the three-guess rules, so rounds already played or in progress never
// change. Set to the first grid that starts AFTER the release is live.
// Off (Dylan, 2026-11-10): No. 4 and later keep 3 guesses per square until the
// 3-misses-per-grid rule ships. The one-guess code stays but never activates.
export const RULES_V2_FROM = "9999-12-31";
export function oneGuess(date) { return !!date && date >= RULES_V2_FROM; }
export function attemptsFor(date) { return oneGuess(date) ? 1 : MAX_ATTEMPTS; }

// ── Rule sets ───────────────────────────────────────────────────────────
// v1  three guesses per square, strokes = tries + 1 (birdie/par/bogey),
//     three misses on a square or giving up = double bogey (5).
// v2  one guess per square (dormant, see RULES_V2_FROM).
// v3  three misses for the WHOLE grid (founder, 2026-11-10). Any open square
//     can be guessed until the player has missed maxMisses times in total;
//     the miss that uses the last ball ends the round. A solved square is a
//     birdie (2) however many misses came before it (misses cost balls, not
//     strokes); every square still open at the end is a double bogey (5).
//     Sunday Red = all nine solved with no misses (18).
// The rule set for a date comes from a schedule. The built-in one below is
// the fallback; the live one is /sunday-nine/rules.json (same shape), which
// the client fetches (the iOS app from teeboxmarket.com) and the Cloud
// Function bundles (functions/data/sunday-nine-rules.json, kept identical by
// scripts/sync-sunday-nine.mjs). The server returns the rule set it scored
// with, and a started round keeps the rule set it started with.
export const RULES_V3_FROM = "2026-11-13"; // grid No. 6
export const V3_MAX_MISSES = 3;
export const RULE_SETS = {
  v1: {id: "v1", perSquare: MAX_ATTEMPTS, maxMisses: 0},
  v2: {id: "v2", perSquare: 1, maxMisses: 0},
  v3: {id: "v3", perSquare: 0, maxMisses: V3_MAX_MISSES},
};
export const RULES_SCHEDULE = [
  {from: SUNDAY_NINE_EPOCH, rules: "v1"},
  {from: RULES_V3_FROM, rules: "v3", maxMisses: V3_MAX_MISSES},
  {from: RULES_V2_FROM, rules: "v2"},
];

// {rules: "v3", maxMisses: 3} (a schedule entry, a stored round or a server
// reply) -> a full rule set, or null when the id is unknown to this build.
export function resolveRules(spec) {
  if (!spec) return null;
  const id = typeof spec === "string" ? spec : (spec.rules || spec.id);
  const base = RULE_SETS[id];
  if (!base) return null;
  const out = {id: base.id, perSquare: base.perSquare, maxMisses: base.maxMisses};
  if (base.maxMisses && spec && typeof spec === "object" && Number.isInteger(spec.maxMisses) &&
      spec.maxMisses >= 1 && spec.maxMisses <= 9) {
    out.maxMisses = spec.maxMisses;
  }
  return out;
}

// A rules.json body -> a clean schedule (sorted, known ids only), or null.
export function parseRulesSchedule(doc) {
  const list = doc && Array.isArray(doc.schedule) ? doc.schedule : null;
  if (!list) return null;
  const out = [];
  for (const e of list) {
    if (!e || !isDateKey(e.from) || !resolveRules(e)) continue;
    const entry = {from: e.from, rules: e.rules};
    if (Number.isInteger(e.maxMisses)) entry.maxMisses = e.maxMisses;
    out.push(entry);
  }
  if (!out.length) return null;
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return out;
}

// The rule set for a date: the last schedule entry starting on or before it.
// Falls back to the built-in schedule when none is given or nothing matches.
export function rulesFor(date, schedule) {
  for (const sch of [schedule, RULES_SCHEDULE]) {
    if (!Array.isArray(sch)) continue;
    let hit = null;
    for (const e of sch) if (e && e.from <= (date || "")) hit = e;
    const r = resolveRules(hit);
    if (r) return r;
  }
  return resolveRules("v1");
}
export const MIN_ANSWERS_PER_SQUARE = 3;
// Groups with many mutually exclusive values. Two of them may share an axis
// (two countries as rows is a fine grid), never opposite axes.
const MULTI_GROUPS = {college: 1, country: 1, decade: 1};

// ── Dates ────────────────────────────────────────────────────────────────
export function dateKeyInTz(when, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || SUNDAY_NINE_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(when || new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

export function todayKey(now) {
  return dateKeyInTz(now || new Date(), SUNDAY_NINE_TZ);
}

export function isDateKey(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
}

export function dayDiff(a, b) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86400000);
}

export function addDays(s, n) {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Grid number shown in the share text ("Sunday Nine #12").
export function gridNumber(date) {
  return dayDiff(SUNDAY_NINE_EPOCH, date) + 1;
}

// ── Names ────────────────────────────────────────────────────────────────
// Accent- and punctuation-insensitive: "Åberg", "Aberg" and "aberg" match.
export function normName(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ł/g, "l")
      .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Autocomplete: every query word must prefix some word of the name (or an
// alias). "rory mc" -> Rory McIlroy; "aberg" -> Ludvig Aberg.
export function searchPlayers(players, query, limit) {
  const q = normName(query);
  if (!q) return [];
  const qw = q.split(" ");
  const hits = [];
  for (const p of players) {
    const names = [p.n].concat(p.aka || []);
    let best = -1;
    for (const nm of names) {
      const words = normName(nm).split(" ");
      if (qw.every((w) => words.some((x) => x.startsWith(w)))) {
        const full = normName(nm);
        const score = full === q ? 3 : full.startsWith(q) ? 2 : 1;
        if (score > best) best = score;
      }
    }
    if (best >= 0) hits.push({p, best});
  }
  hits.sort((a, b) => b.best - a.best || a.p.n.localeCompare(b.p.n));
  return hits.slice(0, limit || 8).map((h) => h.p);
}

// ── Deterministic RNG (same constants as the Logo Bingo selector) ───────
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Grid ────────────────────────────────────────────────────────────────
// A grid is {date, rows:[catId x3], cols:[catId x3]}. Square i is
// rows[floor(i/3)] x cols[i%3].
export function squareCats(grid, i) {
  return [CATEGORY_BY_ID[grid.rows[Math.floor(i / 3)]], CATEGORY_BY_ID[grid.cols[i % 3]]];
}

export function validAnswers(grid, i, players) {
  const [r, c] = squareCats(grid, i);
  return players.filter((p) => matches(p, r) && matches(p, c));
}

// Can all nine squares be filled with nine DIFFERENT players? (Kuhn's
// bipartite matching — a player may only be used once per grid.)
export function hasPerfectGrid(lists) {
  const owner = new Map();
  const tryCell = (i, seen) => {
    for (const p of lists[i]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!owner.has(p.id) || tryCell(owner.get(p.id), seen)) {
        owner.set(p.id, i);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < lists.length; i++) {
    if (!tryCell(i, new Set())) return false;
  }
  return true;
}

// Checks every rule a published grid must meet. Returns {ok, counts, why}.
export function checkGrid(grid, players) {
  const ids = grid.rows.concat(grid.cols);
  if (ids.length !== 6 || new Set(ids).size !== 6) return {ok: false, why: "categories not distinct"};
  const cats = ids.map((id) => CATEGORY_BY_ID[id]);
  if (cats.some((c) => !c)) return {ok: false, why: "unknown category"};
  const rows = cats.slice(0, 3);
  const cols = cats.slice(3);
  for (const r of rows) {
    for (const c of cols) {
      if (groupsClash(r, c)) return {ok: false, why: "clash " + r.id + " x " + c.id};
    }
  }
  for (const axis of [rows, cols]) {
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        if (axis[a].group === axis[b].group && !MULTI_GROUPS[axis[a].group]) {
          return {ok: false, why: "same group on one axis " + axis[a].group};
        }
      }
    }
  }
  const lists = [];
  for (let i = 0; i < 9; i++) lists.push(validAnswers(grid, i, players));
  const counts = lists.map((l) => l.length);
  if (counts.some((n) => n < MIN_ANSWERS_PER_SQUARE)) return {ok: false, counts, why: "square under " + MIN_ANSWERS_PER_SQUARE};
  if (!hasPerfectGrid(lists)) return {ok: false, counts, why: "no perfect grid"};
  return {ok: true, counts};
}

// How often each kind of category is drawn. Colleges, countries and
// decades are many small categories, so they are drawn as a group first.
const GROUP_WEIGHTS = {
  masters: 3, pga: 3, usopen: 3, open: 3, majorcount: 2, players: 3, fedex: 2,
  ryder: 3, presidents: 3, world1: 2, liv: 3, ncaa: 2, usam: 2, olympic: 2,
  wins: 2, college: 12, country: 6, decade: 4,
};
// A square with more answers than this is too easy; a grid may have a few.
const EASY_SQUARE = 45;
const MAX_EASY_SQUARES = 3;

function weightedPick(rng, items, weightOf) {
  const total = items.reduce((a, it) => a + weightOf(it), 0);
  let x = rng() * total;
  for (const it of items) {
    x -= weightOf(it);
    if (x < 0) return it;
  }
  return items[items.length - 1];
}

// Can `c` join this axis? Distinct, and a second category from one group
// only for the multi-value groups (two countries as rows is fine).
function axisAccepts(axis, c) {
  return axis.every((a) => a !== c && (a.group !== c.group || MULTI_GROUPS[c.group]));
}

// A category needs this many verified players to be drawn at all (lowered
// from 8 to 6 on 2026-11-06 to bring in more colleges). It is only a cheap
// pre-filter: checkGrid still guarantees >= MIN_ANSWERS_PER_SQUARE answers
// in every square and a 9-different-player solution for every grid.
const MIN_CATEGORY_SIZE = 6;

// The grid for a date. Pure function of (date, players): same answer on
// every device and on the server. Built row-first: draw three row
// categories, then draw columns only from categories that give every row at
// least MIN_ANSWERS_PER_SQUARE answers, so small categories (a college, a
// country) get into grids instead of being rejected by blind draws.
// Pre-generated grids (grids.json) pin the published dates so a later data
// edit can't change a grid already played.
export function generateGrid(date, players) {
  const rng = mulberry32(hashStr("sunday-nine:" + date));
  const members = {};
  for (const c of CATEGORIES) {
    members[c.id] = new Set(players.filter((p) => matches(p, c)).map((p) => p.id));
  }
  const pool = CATEGORIES.filter((c) => members[c.id].size >= MIN_CATEGORY_SIZE);
  const groupSize = {};
  for (const c of pool) groupSize[c.group] = (groupSize[c.group] || 0) + 1;
  // Each GROUP gets its weight, split across that group's categories.
  const w = (c) => GROUP_WEIGHTS[c.group] / groupSize[c.group];
  const overlap = (a, b) => {
    let n = 0;
    for (const id of members[a.id]) if (members[b.id].has(id)) n++;
    return n;
  };
  for (let attempt = 0; attempt < 5000; attempt++) {
    const rows = [];
    while (rows.length < 3) {
      const options = pool.filter((c) => axisAccepts(rows, c));
      rows.push(weightedPick(rng, options, w));
    }
    let cand = pool.filter((c) => rows.every((r) => !groupsClash(r, c) && overlap(r, c) >= MIN_ANSWERS_PER_SQUARE));
    const cols = [];
    while (cols.length < 3 && cand.length) {
      const c = weightedPick(rng, cand, w);
      cols.push(c);
      cand = cand.filter((x) => axisAccepts(cols, x));
    }
    if (cols.length < 3) continue;
    // Half the time, swap axes so a college or country shows on either side.
    const flip = rng() < 0.5;
    const grid = {
      date,
      rows: (flip ? cols : rows).map((c) => c.id),
      cols: (flip ? rows : cols).map((c) => c.id),
    };
    const res = checkGrid(grid, players);
    if (!res.ok) continue;
    if (res.counts.filter((n) => n > EASY_SQUARE).length > MAX_EASY_SQUARES) continue;
    return grid;
  }
  throw new Error("sunday-nine: no valid grid for " + date);
}

export function gridForDate(date, players, pinned) {
  const hit = pinned && pinned[date];
  if (hit) return {date, rows: hit.rows.slice(), cols: hit.cols.slice()};
  return generateGrid(date, players);
}

// ── Scoring ─────────────────────────────────────────────────────────────
// Each square is a par-3 hole. v1: correct on the first guess = birdie (2),
// second = par (3), third = bogey (4); three misses, or giving up on the
// square, = double bogey (5). Nine birdies (18, -9) is a Sunday Red.
// v2 (one guess per square) is the same formula with one try. v3: a solved
// square is always a birdie (2), an unsolved one at the end a double bogey.
export function strokesFor(cell, rules) {
  if (cell.pid) return rules && rules.maxMisses ? 2 : cell.tries + 1;
  if (cell.done) return PAR_PER_HOLE + 2;
  return null;
}

// Replay a raw guess log. guesses: [{cell: 0-8, pid}] in order. gaveUp ends
// the round (open squares score double bogey). Invalid entries are ignored,
// never trusted: an unknown player, a player already placed in another
// square, a repeat guess in the same square, or a guess on a closed square.
// rules defaults to rulesFor(grid.date). Under v3 every guess after the round
// ended (last ball used, or all nine solved) is ignored; endedAt is the
// number of log entries up to and including the guess that ended it.
export function scoreGame(grid, playersById, guesses, gaveUp, rules) {
  const R = resolveRules(rules) || rulesFor(grid && grid.date);
  const maxTries = R.perSquare || Infinity;
  const strikeOut = R.maxMisses || 0;
  const cells = [];
  for (let i = 0; i < 9; i++) cells.push({pid: null, tries: 0, wrong: [], done: false});
  const used = new Set();
  const cats = [];
  for (let i = 0; i < 9; i++) cats.push(squareCats(grid, i));
  let misses = 0;
  let endedAt = null;
  const log = guesses || [];
  for (let k = 0; k < log.length; k++) {
    const g = log[k];
    if (strikeOut && endedAt !== null) break;
    if (!g || !Number.isInteger(g.cell) || g.cell < 0 || g.cell > 8) continue;
    const cell = cells[g.cell];
    if (cell.done) continue;
    const p = playersById[g.pid];
    if (!p) continue;
    if (used.has(p.id) || cell.wrong.indexOf(p.id) !== -1) continue;
    cell.tries++;
    if (matches(p, cats[g.cell][0]) && matches(p, cats[g.cell][1])) {
      cell.pid = p.id;
      cell.done = true;
      used.add(p.id);
      if (strikeOut && cells.every((c) => c.pid)) endedAt = k + 1;
    } else {
      cell.wrong.push(p.id);
      misses++;
      if (cell.tries >= maxTries) cell.done = true;
      if (strikeOut && misses >= strikeOut) endedAt = k + 1;
    }
  }
  if (gaveUp || endedAt !== null) cells.forEach((c) => { c.done = true; });
  const complete = cells.every((c) => c.done);
  let strokes = 0;
  let played = 0;
  for (const c of cells) {
    const s = strokesFor(c, R);
    if (s !== null) { strokes += s; played++; }
  }
  const correct = cells.filter((c) => c.pid).length;
  const sundayRed = complete && (strikeOut
    ? correct === 9 && misses === 0
    : cells.every((c) => c.pid && c.tries === 1));
  const out = {
    cells, complete, strokes, correct, sundayRed,
    // Running score vs par for the holes finished so far.
    toPar: strokes - played * PAR_PER_HOLE,
  };
  if (strikeOut) {
    out.rules = R.id;
    out.maxMisses = strikeOut;
    out.misses = misses;
    out.endedAt = endedAt;
  }
  return out;
}

export function formatToPar(n) {
  if (n === 0) return "E";
  return n > 0 ? "+" + n : "−" + Math.abs(n);
}

export function holeName(strokes) {
  return ({2: "Birdie", 3: "Par", 4: "Bogey", 5: "Double bogey"})[strokes] || "";
}

// Wordle-style share text. The only place Sunday Nine uses emoji.
const SHARE_MARKS_V1 = {2: "🟥", 3: "⬜", 4: "🟦", 5: "⬛"};
// One-guess rules: green = birdie, red = miss (founder, 2026-11-09).
// v3 uses the same: green = solved, red = left open.
const SHARE_MARKS_V2 = {2: "🟩", 5: "🟥"};
export function shareText(date, result, rules) {
  const R = resolveRules(rules) || rulesFor(date);
  const SHARE_MARKS = R.id === "v1" ? SHARE_MARKS_V1 : SHARE_MARKS_V2;
  const num = gridNumber(date);
  const lines = ["TeeBox Sunday Nine" + (num >= 1 ? " #" + num : "")];
  lines.push(result.sundayRed
    ? "Sunday Red " + result.strokes + " (" + formatToPar(result.strokes - PAR) + ")"
    : result.strokes + " (" + formatToPar(result.strokes - PAR) + ")");
  for (let r = 0; r < 3; r++) {
    let row = "";
    for (let c = 0; c < 3; c++) row += SHARE_MARKS[strokesFor(result.cells[r * 3 + c], R)] || SHARE_MARKS[5];
    lines.push(row);
  }
  lines.push("teeboxmarket.com/sunday-nine");
  return lines.join("\n");
}

// ── Streak ──────────────────────────────────────────────────────────────
// Consecutive finished days ending at `date` (or the day before, so a streak
// isn't shown as broken before today's round is played).
export function streakFrom(finishedDates, date) {
  const set = new Set(finishedDates);
  let d = set.has(date) ? date : addDays(date, -1);
  let n = 0;
  while (set.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

