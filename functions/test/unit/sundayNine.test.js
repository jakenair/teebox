// functions/test/unit/sundayNine.test.js
// Sunday Nine: generated-core freshness, grid rules, server scoring and the
// append-only guess log. No emulator. Run: npm test

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const path = require("node:path");
const core = require("../../lib/sundayNineCore");
const {__test: S} = require("../../sundayNine");

const ROOT = path.resolve(__dirname, "../../..");
const PLAYERS = S.PLAYERS;
const BY_ID = Object.fromEntries(PLAYERS.map((p) => [p.id, p]));

test("generated server core matches sunday-nine/*.js (run sync-sunday-nine.mjs)", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts/sync-sunday-nine.mjs"), "--check"], {stdio: "pipe"});
});

test("every pinned grid: >= 3 answers per square and a 9-different-player solution", () => {
  const dates = Object.keys(S.PINNED);
  assert.ok(dates.length >= 60);
  for (const d of dates) {
    const g = S.PINNED[d];
    const res = core.checkGrid({date: d, rows: g.rows, cols: g.cols}, PLAYERS);
    assert.ok(res.ok, `${d}: ${res.why}`);
    assert.deepEqual(res.counts, g.counts, `${d}: counts drifted from grids.json`);
  }
});

test("pinned grids are what the generator produces (deterministic)", () => {
  // 2026-11-08..14 were pinned before the 2026-11-06 college/threshold
  // change and keep their original grids; later dates are regenerated.
  for (const d of Object.keys(S.PINNED).filter((x) => x >= "2026-11-15").slice(0, 10)) {
    const g = core.generateGrid(d, PLAYERS);
    assert.deepEqual([g.rows, g.cols], [S.PINNED[d].rows, S.PINNED[d].cols], d);
  }
});

test("unverified (yellow) field never matches its category", () => {
  const p = {id: "x", n: "X", c: "England", col: "Texas", ncaa: "Y", maj: [1, 0, 0, 0], pl: "N",
    fx: "N", cup: "R", w1: "N", liv: "N", dec: "1990s", oly: "N", wins: 3, ua: "N", unk: ["college", "cup"]};
  assert.equal(core.matches(p, core.CATEGORY_BY_ID["col-texas"]), false);
  assert.equal(core.matches(p, core.CATEGORY_BY_ID["ryder"]), false);
  assert.equal(core.matches(p, core.CATEGORY_BY_ID["masters"]), true);
  assert.equal(core.matches({...p, unk: undefined}, core.CATEGORY_BY_ID["col-texas"]), true);
});

test("Lowry/Aphibarnrat college and Demaret/Lema decade are unknown", () => {
  const find = (n) => PLAYERS.find((p) => p.n === n);
  for (const [n, f] of [["Shane Lowry", "college"], ["Kiradech Aphibarnrat", "college"],
    ["Jimmy Demaret", "decade"], ["Tony Lema", "decade"]]) {
    const p = find(n);
    assert.ok(p, n);
    assert.ok(p.unk && p.unk.includes(f), `${n} ${f} should be unknown`);
  }
});

test("no sponsor category in v1, no blank-college match", () => {
  assert.ok(!core.CATEGORIES.some((c) => /sponsor|staffer/i.test(c.id + c.label)));
  const blank = PLAYERS.filter((p) => p.col === "");
  for (const c of core.CATEGORIES.filter((x) => x.group === "college")) {
    assert.ok(!blank.some((p) => core.matches(p, c)));
  }
});

function answerFor(grid, i, used) {
  return core.validAnswers(grid, i, PLAYERS).find((p) => !used.has(p.id));
}
function wrongFor(grid, i) {
  return PLAYERS.find((p) => !core.validAnswers(grid, i, PLAYERS).includes(p));
}

test("scoring: nine first-try answers = 18, Sunday Red", () => {
  const date = Object.keys(S.PINNED)[0];
  const grid = core.gridForDate(date, PLAYERS, S.PINNED);
  // Use a real perfect assignment (greedy can paint itself into a corner).
  const lists = [];
  for (let i = 0; i < 9; i++) lists.push(core.validAnswers(grid, i, PLAYERS));
  const owner = new Map();
  const assign = (i, seen) => {
    for (const p of lists[i]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!owner.has(p.id) || assign(owner.get(p.id), seen)) { owner.set(p.id, i); return true; }
    }
    return false;
  };
  for (let i = 0; i < 9; i++) assign(i, new Set());
  const guesses = [...owner.entries()].map(([pid, cell]) => ({cell, pid}));
  const r = core.scoreGame(grid, BY_ID, guesses, false);
  assert.equal(r.complete, true);
  assert.equal(r.strokes, 18);
  assert.equal(r.sundayRed, true);
  assert.match(core.shareText(date, r), /Sunday Red 18 \(−9\)/);
});

test("scoring: birdie/par/bogey/double, reuse and repeats ignored", () => {
  const date = Object.keys(S.PINNED)[1];
  const grid = core.gridForDate(date, PLAYERS, S.PINNED);
  const used = new Set();
  const a0 = answerFor(grid, 0, used); used.add(a0.id);
  const w = wrongFor(grid, 1);
  const a1 = answerFor(grid, 1, used);
  const guesses = [
    {cell: 0, pid: a0.id}, // birdie
    {cell: 1, pid: w.id}, {cell: 1, pid: w.id}, // repeat ignored
    {cell: 1, pid: a0.id}, // already used elsewhere: ignored
    {cell: 1, pid: a1.id}, // par
    {cell: 2, pid: "not-a-player"}, // ignored
  ];
  const r = core.scoreGame(grid, BY_ID, guesses, false);
  assert.equal(core.strokesFor(r.cells[0]), 2);
  assert.equal(core.strokesFor(r.cells[1]), 3);
  assert.equal(r.cells[2].tries, 0);
  assert.equal(r.complete, false);
  const g = core.scoreGame(grid, BY_ID, guesses, true);
  assert.equal(g.complete, true);
  assert.equal(g.strokes, 2 + 3 + 7 * 5);
  assert.equal(g.sundayRed, false);
});

test("server: a re-sent log must extend the stored one (no take-backs)", () => {
  const date = Object.keys(S.PINNED)[2];
  const grid = core.gridForDate(date, PLAYERS, S.PINNED);
  const w = wrongFor(grid, 0);
  const first = S.scoreSubmission(date, [{cell: 0, pid: w.id}], false, null);
  assert.equal(first.changed, true);
  // Dropping the wrong guess is rejected; the stored state stands.
  const cheat = S.scoreSubmission(date, [], false, first.state);
  assert.equal(cheat.conflict, true);
  assert.equal(cheat.state.cells[0].tries, 1);
  // A finished round is frozen.
  const done = S.scoreSubmission(date, first.state.guesses, true, first.state);
  assert.equal(done.state.complete, true);
  const after = S.scoreSubmission(date, first.state.guesses.concat([{cell: 1, pid: w.id}]), false, done.state);
  assert.equal(after.changed, false);
  assert.equal(after.state.strokes, done.state.strokes);
});

test("guess sanitizing rejects junk", () => {
  assert.equal(S.sanitizeGuesses("x"), null);
  assert.equal(S.sanitizeGuesses([{cell: 9, pid: "a"}]), null);
  assert.equal(S.sanitizeGuesses([{cell: 0, pid: "../x"}]), null);
  assert.equal(S.sanitizeGuesses(new Array(28).fill({cell: 0, pid: "a"})), null);
  assert.deepEqual(S.sanitizeGuesses([{cell: 0, pid: "rory-mcilroy", extra: 1}]), [{cell: 0, pid: "rory-mcilroy"}]);
});

test("streak, names, dates", () => {
  assert.equal(core.streakFrom(["2026-11-08", "2026-11-09", "2026-11-10"], "2026-11-10"), 3);
  assert.equal(core.streakFrom(["2026-11-08", "2026-11-09"], "2026-11-10"), 2);
  assert.equal(core.streakFrom(["2026-11-07", "2026-11-09"], "2026-11-09"), 1);
  assert.equal(core.normName("Ludvig Åberg"), "ludvig aberg");
  assert.equal(core.normName("Thomas Bjørn"), "thomas bjorn");
  assert.ok(core.searchPlayers(PLAYERS, "thomas bjørn").some((p) => p.n === "Thomas Bjorn"));
  assert.equal(core.searchPlayers(PLAYERS, "Jose Maria Olazábal")[0].n, "Jose Maria Olazabal");
  // 11pm Chicago on Nov 8 is already Nov 9 in UTC; the grid date stays Nov 8.
  assert.equal(core.todayKey(new Date("2026-11-09T04:59:00Z")), "2026-11-08");
  assert.equal(core.todayKey(new Date("2026-11-09T06:01:00Z")), "2026-11-09");
});

test("before grid #1 a round is a preview of grid #1", () => {
  assert.equal(S.isPreviewDate("2026-11-07"), true);
  assert.equal(S.isPreviewDate("2026-11-08"), false);
  const r = S.scoreSubmission("2026-11-06", [], false, null);
  assert.deepEqual([r.state.rows, r.state.cols], [S.PINNED["2026-11-08"].rows, S.PINNED["2026-11-08"].cols]);
});

test("one-guess is OFF (2026-11-10): No. 4 and later keep 3 guesses per square; server keeps every answer", () => {
  for (const date of ["2026-11-11", "2026-11-12", "2026-12-25"]) {
    assert.equal(core.oneGuess(date), false, date);
    assert.equal(core.attemptsFor(date), 3, date);
  }
  const log = [{cell: 3, pid: "a"}, {cell: 3, pid: "b"}, {cell: 4, pid: "c"}];
  const k = S.keepFirstAnswerPerSquare("2026-11-11", log);
  assert.deepEqual(k.guesses, log);
  assert.equal(k.dropped, 0);
  // A wrong first answer then the right one: the square is solved on the 2nd try.
  const grid = core.gridForDate("2026-11-11", PLAYERS, S.PINNED);
  const a0 = answerFor(grid, 0, new Set());
  const w0 = wrongFor(grid, 0);
  const out = S.scoreSubmission("2026-11-11", [{cell: 0, pid: w0.id}, {cell: 0, pid: a0.id}], false, null);
  assert.equal(out.state.cells[0].pid, a0.id);
  assert.notEqual(core.strokesFor(out.state.cells[0]), 5);
});

test("stats lookback: a 120-day id range, auto-indexed (r406 fix for the missing desc index)", () => {
  const {lookbackStart} = require("../../sundayNine").__test;
  assert.equal(lookbackStart("2026-11-11"), "2026-07-14");
  assert.equal(lookbackStart("2026-03-01"), "2025-11-01");
});

// ── v3: three misses for the whole grid (from 2026-11-13, No. 6) ──────────
const V3_DATE = "2026-11-13";
const V1_LAST = "2026-11-12";
function perfectAssignment(grid) {
  const lists = [];
  for (let i = 0; i < 9; i++) lists.push(core.validAnswers(grid, i, PLAYERS));
  const owner = new Map();
  const assign = (i, seen) => {
    for (const p of lists[i]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!owner.has(p.id) || assign(owner.get(p.id), seen)) { owner.set(p.id, i); return true; }
    }
    return false;
  };
  for (let i = 0; i < 9; i++) assign(i, new Set());
  const byCell = [];
  for (const [pid, cell] of owner.entries()) byCell[cell] = pid;
  return byCell; // byCell[i] = pid
}
// n distinct wrong answers for square i, none from the perfect assignment.
function wrongsFor(grid, i, n, avoid) {
  const ok = new Set(core.validAnswers(grid, i, PLAYERS).map((p) => p.id));
  return PLAYERS.filter((p) => !ok.has(p.id) && !(avoid || []).includes(p.id)).slice(0, n).map((p) => p.id);
}
const gridOf = (date) => core.gridForDate(date, PLAYERS, S.PINNED);

test("rules lookup: built-in schedule, v1 through No. 5, v3 from No. 6", () => {
  for (const d of ["2026-11-08", "2026-11-10", "2026-11-11", V1_LAST]) {
    assert.equal(core.rulesFor(d).id, "v1", d);
    assert.equal(core.rulesFor(d, S.RULES_SCHEDULE).id, "v1", d);
  }
  for (const d of [V3_DATE, "2026-11-20", "2027-06-01"]) {
    assert.deepEqual(core.rulesFor(d), {id: "v3", perSquare: 0, maxMisses: 3}, d);
    assert.deepEqual(core.rulesFor(d, S.RULES_SCHEDULE), {id: "v3", perSquare: 0, maxMisses: 3}, d);
  }
  assert.equal(core.gridNumber(V3_DATE), 6);
  // Pre-epoch (admin preview) dates are v1.
  assert.equal(core.rulesFor("2026-11-01").id, "v1");
});

test("rules lookup: rules.json parses, matches the built-in table and the server copy", () => {
  const fs = require("node:fs");
  const web = JSON.parse(fs.readFileSync(path.join(ROOT, "sunday-nine/rules.json"), "utf8"));
  const fn = require("../../data/sunday-nine-rules.json");
  assert.deepEqual(fn, web);
  const sch = core.parseRulesSchedule(web);
  assert.deepEqual(sch, S.RULES_SCHEDULE);
  // The bundled fallback and the shipped JSON agree on every pinned date, so
  // an app that can't fetch rules.json plays the same rules as one that can.
  for (const d of Object.keys(S.PINNED)) {
    assert.deepEqual(core.rulesFor(d, sch), core.rulesFor(d), d);
  }
});

test("rules lookup: a remote schedule moves the start; junk and unknown ids fall back", () => {
  const later = core.parseRulesSchedule({schedule: [
    {from: "2026-11-08", rules: "v1"}, {from: "2026-11-20", rules: "v3", maxMisses: 4}]});
  assert.equal(core.rulesFor(V3_DATE, later).id, "v1");
  assert.deepEqual(core.rulesFor("2026-11-20", later), {id: "v3", perSquare: 0, maxMisses: 4});
  // Unknown id / bad dates are skipped; nothing left -> null -> built-in.
  assert.equal(core.parseRulesSchedule({schedule: [{from: "2026-11-08", rules: "v9"}, {from: "nope", rules: "v1"}]}), null);
  assert.equal(core.parseRulesSchedule(null), null);
  assert.equal(core.parseRulesSchedule({schedule: "x"}), null);
  assert.equal(core.rulesFor(V3_DATE, null).id, "v3");
  const mixed = core.parseRulesSchedule({schedule: [
    {from: "2026-11-13", rules: "v3"}, {from: "2026-11-08", rules: "v1"}, {from: "2026-11-15", rules: "v7"}]});
  assert.deepEqual(mixed.map((e) => e.rules), ["v1", "v3"]); // sorted, unknown dropped
  // maxMisses only applies to strike rules and stays in 1..9.
  assert.equal(core.resolveRules({rules: "v3", maxMisses: 0}).maxMisses, 3);
  assert.equal(core.resolveRules({rules: "v3", maxMisses: 50}).maxMisses, 3);
  assert.equal(core.resolveRules({rules: "v1", maxMisses: 3}).maxMisses, 0);
  assert.equal(core.resolveRules("v2").perSquare, 1);
  assert.equal(core.resolveRules("nope"), null);
});

test("v1 dates unchanged: three guesses per square, tries+1 strokes, v1 share marks", () => {
  const grid = gridOf(V1_LAST);
  const sol = perfectAssignment(grid);
  const w = wrongsFor(grid, 0, 3, sol);
  const w2 = wrongsFor(grid, 2, 2, sol);
  const w1 = wrongsFor(grid, 1, 1, sol);
  const guesses = [
    {cell: 0, pid: w[0]}, {cell: 0, pid: w[1]}, {cell: 0, pid: w[2]}, // 3 misses: double bogey
    {cell: 1, pid: w1[0]}, {cell: 1, pid: sol[1]}, // par
    {cell: 2, pid: w2[0]}, {cell: 2, pid: w2[1]}, {cell: 2, pid: sol[2]}, // bogey
    {cell: 3, pid: sol[3]}, // birdie
  ];
  const r = core.scoreGame(grid, BY_ID, guesses, false);
  // Same as passing v1 explicitly, and no strike fields.
  assert.deepEqual(r, core.scoreGame(grid, BY_ID, guesses, false, "v1"));
  assert.equal(r.misses, undefined);
  assert.deepEqual([0, 1, 2, 3].map((i) => core.strokesFor(r.cells[i])), [5, 3, 4, 2]);
  assert.equal(r.complete, false); // 6 misses, round still open under v1
  const done = core.scoreGame(grid, BY_ID, guesses, true);
  assert.equal(done.strokes, 5 + 3 + 4 + 2 + 5 * 5);
  const txt = core.shareText(V1_LAST, done).split("\n");
  assert.equal(txt[0], "TeeBox Sunday Nine #5");
  assert.equal(txt[2], "⬛⬜🟦");
  assert.equal(txt[3], "🟥⬛⬛");
  // Server: nothing dropped, every guess stored.
  const out = S.scoreSubmission(V1_LAST, guesses, false, null);
  assert.equal(out.dropped, 0);
  assert.equal(out.conflict, false);
  assert.equal(out.state.guesses.length, guesses.length);
  assert.equal(out.state.rules, "v1");
});

test("v3 scoring: solved = birdie (2) whatever came before, open at the end = double bogey (5)", () => {
  const grid = gridOf(V3_DATE);
  const sol = perfectAssignment(grid);
  const w = wrongsFor(grid, 4, 2, sol);
  const guesses = [
    {cell: 4, pid: w[0]}, {cell: 4, pid: w[1]}, {cell: 4, pid: sol[4]}, // two misses, then right
    {cell: 0, pid: sol[0]},
  ];
  const r = core.scoreGame(grid, BY_ID, guesses, false);
  assert.equal(r.rules, "v3");
  assert.equal(r.misses, 2);
  assert.equal(r.complete, false);
  assert.equal(core.strokesFor(r.cells[4], core.rulesFor(V3_DATE)), 2);
  assert.equal(r.strokes, 4);
  assert.equal(r.toPar, -2);
  assert.equal(r.cells[1].done, false); // open squares stay open after a miss
  const gave = core.scoreGame(grid, BY_ID, guesses, true);
  assert.equal(gave.complete, true);
  assert.equal(gave.strokes, 2 * 2 + 7 * 5);
  assert.equal(gave.sundayRed, false);
});

test("v3: 9/9 with no misses is Sunday Red 18; 9/9 with misses is 18 but not a Sunday Red", () => {
  const grid = gridOf(V3_DATE);
  const sol = perfectAssignment(grid);
  const clean = sol.map((pid, cell) => ({cell, pid}));
  const r = core.scoreGame(grid, BY_ID, clean, false);
  assert.equal(r.complete, true);
  assert.equal(r.strokes, 18);
  assert.equal(r.sundayRed, true);
  assert.equal(r.endedAt, 9);
  assert.equal(core.shareText(V3_DATE, r),
      "TeeBox Sunday Nine #6\nSunday Red 18 (−9)\n🟩🟩🟩\n🟩🟩🟩\n🟩🟩🟩\nteeboxmarket.com/sunday-nine");
  const w = wrongsFor(grid, 0, 2, sol);
  const messy = [{cell: 0, pid: w[0]}, {cell: 5, pid: w[1]}].concat(clean);
  const m = core.scoreGame(grid, BY_ID, messy, false);
  assert.equal(m.strokes, 18);
  assert.equal(m.misses, 2);
  assert.equal(m.sundayRed, false);
  assert.equal(core.shareText(V3_DATE, m).split("\n")[1], "18 (−9)");
});

test("v3 strike limit: the 3rd miss ends the round, the 4th miss and later guesses are ignored", () => {
  const grid = gridOf(V3_DATE);
  const sol = perfectAssignment(grid);
  const wr = (i) => wrongsFor(grid, i, 1, sol)[0];
  const log = [
    {cell: 0, pid: sol[0]},
    {cell: 1, pid: wr(1)}, {cell: 2, pid: wr(2)},
    {cell: 1, pid: wr(1)}, // repeat in the same square: not a miss
    {cell: 3, pid: wr(3)}, // 3rd miss: round over
    {cell: 4, pid: wr(4)}, // 4th miss: ignored
    {cell: 5, pid: sol[5]}, // right, but after the end: ignored
  ];
  const r = core.scoreGame(grid, BY_ID, log, false);
  assert.equal(r.misses, 3);
  assert.equal(r.complete, true);
  assert.equal(r.endedAt, 5);
  assert.equal(r.correct, 1);
  assert.equal(r.cells[5].pid, null);
  assert.equal(r.cells[4].tries, 0);
  assert.equal(r.strokes, 2 + 8 * 5);
  assert.ok(r.cells.every((c) => c.done));
  const txt = core.shareText(V3_DATE, r).split("\n");
  assert.deepEqual(txt.slice(1, 5), ["42 (+15)", "🟩🟥🟥", "🟥🟥🟥", "🟥🟥🟥"]);
  // Server drops the tail, keeps the save, tells the client to adopt it.
  const out = S.scoreSubmission(V3_DATE, log, false, null);
  assert.equal(out.changed, true);
  assert.equal(out.dropped, 2);
  assert.equal(out.conflict, true);
  assert.deepEqual(out.state.guesses, log.slice(0, 5));
  assert.equal(out.state.complete, true);
  assert.equal(out.state.misses, 3);
  assert.equal(out.state.maxMisses, 3);
  assert.equal(out.state.rules, "v3");
  // Re-sending the long log to the frozen round: dropped again, never re-scored.
  const again = S.scoreSubmission(V3_DATE, log, false, out.state);
  assert.equal(again.changed, false);
  assert.equal(again.dropped, 2);
  assert.equal(again.state.strokes, out.state.strokes);
});

test("v3: guesses after giving up are ignored; End round works as before", () => {
  const grid = gridOf(V3_DATE);
  const sol = perfectAssignment(grid);
  const first = S.scoreSubmission(V3_DATE, [{cell: 0, pid: sol[0]}], true, null);
  assert.equal(first.state.complete, true);
  assert.equal(first.state.strokes, 2 + 8 * 5);
  const later = S.scoreSubmission(V3_DATE, [{cell: 0, pid: sol[0]}, {cell: 1, pid: sol[1]}], false, first.state);
  assert.equal(later.changed, false);
  assert.equal(later.dropped, 1);
  assert.equal(later.state.correct, 1);
});

test("v3 refresh/merge: synced in pieces = synced at once; a round keeps the rules it started with", () => {
  const grid = gridOf(V3_DATE);
  const sol = perfectAssignment(grid);
  const wr = (i) => wrongsFor(grid, i, 1, sol)[0];
  const log = [{cell: 0, pid: sol[0]}, {cell: 2, pid: wr(2)}, {cell: 1, pid: sol[1]}, {cell: 6, pid: wr(6)}, {cell: 3, pid: sol[3]}];
  let stored = null;
  for (let n = 1; n <= log.length; n++) {
    const o = S.scoreSubmission(V3_DATE, log.slice(0, n), false, stored);
    assert.equal(o.changed, true);
    assert.equal(o.conflict, false);
    stored = o.state;
  }
  const once = S.scoreSubmission(V3_DATE, log, false, null).state;
  assert.deepEqual(stored, once);
  assert.equal(stored.misses, 2);
  assert.equal(stored.complete, false);
  // A local reload replays the same saved log: same result as the server.
  const local = core.scoreGame(grid, BY_ID, log, false, {rules: stored.rules, maxMisses: stored.maxMisses});
  assert.equal(local.strokes, stored.strokes);
  assert.equal(local.misses, stored.misses);
  // Take-backs still refused under v3.
  const cheat = S.scoreSubmission(V3_DATE, log.slice(0, 3), false, stored);
  assert.equal(cheat.conflict, true);
  assert.equal(cheat.state.misses, 2);
  // Third miss after a merge ends the round.
  const end = S.scoreSubmission(V3_DATE, log.concat([{cell: 8, pid: wr(8)}]), false, stored);
  assert.equal(end.state.complete, true);
  assert.equal(end.state.strokes, 3 * 2 + 6 * 5);
  // A round stored before rule ids existed stays v1 on a v3 date.
  const legacy = {...stored, rules: undefined, maxMisses: undefined};
  assert.equal(S.rulesForRound(V3_DATE, legacy).id, "v1");
  assert.equal(S.rulesForRound(V3_DATE, null).id, "v3");
  assert.equal(S.rulesForRound(V3_DATE, {...stored, rules: "v3", maxMisses: 4}).maxMisses, 4);
  const v1Round = S.scoreSubmission(V3_DATE, log.concat([{cell: 8, pid: wr(8)}, {cell: 7, pid: wr(7)}]), false, legacy);
  assert.equal(v1Round.state.rules, "v1");
  assert.equal(v1Round.dropped, 0);
  assert.equal(v1Round.state.complete, false);
});

test("v3 server: dropAfterRoundEnd is a no-op under v1 and before the end", () => {
  const grid = gridOf(V3_DATE);
  const sol = perfectAssignment(grid);
  const many = [0, 1, 2, 3, 4].map((cell) => ({cell, pid: wrongsFor(grid, cell, 1, sol)[0]}));
  assert.equal(S.dropAfterRoundEnd(grid, many, core.resolveRules("v1")).dropped, 0);
  assert.equal(S.dropAfterRoundEnd(grid, many.slice(0, 2), core.rulesFor(V3_DATE)).dropped, 0);
  const d = S.dropAfterRoundEnd(grid, many, core.rulesFor(V3_DATE));
  assert.equal(d.dropped, 2);
  assert.equal(d.guesses.length, 3);
});
