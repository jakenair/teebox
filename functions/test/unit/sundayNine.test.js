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
