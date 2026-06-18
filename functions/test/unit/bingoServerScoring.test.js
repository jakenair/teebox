// functions/test/unit/bingoServerScoring.test.js
// Verifies the server-side scoring core (the Step-1 verify checklist), against
// the real canon answer data. No Firestore/emulator — scoreCellsServerSide is
// pure. Run: npm test

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {scoreCellsServerSide} = require("../../bingoSync").__test;
const CANON = require("../../data/bingo-puzzle-data.json");

// A real 9-id answer key + each course's correct answer string (shortName).
const answerIds = Object.keys(CANON.courseData).slice(0, 9);
const correctNames = answerIds.map((id) => CANON.courseData[id].shortName);

// Build a 9-cell sanitized array. `guesses`/`states` are per-cell.
function cells(guesses, states) {
  return Array.from({length: 9}, (_, i) => ({
    state: states[i],
    attempts: 1,
    guess: guesses[i],
    tappedAt: null,
    resolvedAt: null,
    points: 0,
  }));
}

test("HONEST: correct guesses score full marks, no drift", () => {
  const c = cells(correctNames, Array(9).fill("correct"));
  const {correctCount, serverScored} = scoreCellsServerSide(c, answerIds);
  assert.equal(serverScored, true);
  assert.equal(correctCount, 9); // matches what an honest client would claim
});

test("SPOOF: state:'correct' but non-matching guesses → scored WRONG", () => {
  // Client lies: every cell marked correct, but the guesses don't match.
  const c = cells(Array(9).fill("zzz not a course"), Array(9).fill("correct"));
  const {correctCount, serverScored} = scoreCellsServerSide(c, answerIds);
  assert.equal(serverScored, true);
  assert.equal(correctCount, 0); // server ignores the lie, scores from guess
  // (clientClaimedCorrect would be 9 → drift canary fires)
});

test("NO GUESS (old client): falls back to client state, no regression", () => {
  // Old client populated state but no guess text. Server can't re-derive, so
  // it trusts state per-cell.
  const c = cells(Array(9).fill(null), Array(9).fill("correct"));
  const {correctCount, serverScored} = scoreCellsServerSide(c, answerIds);
  assert.equal(serverScored, true);
  assert.equal(correctCount, 9); // == client state count, no regression
});

test("NO ANSWER KEY: skip re-score, trust client state", () => {
  const c = cells(correctNames, ["correct", "correct", "revealed", "pending",
    "pending", "pending", "pending", "pending", "pending"]);
  const {correctCount, serverScored} = scoreCellsServerSide(c, null);
  assert.equal(serverScored, false);
  assert.equal(correctCount, 2); // count of state==='correct'
});

test("MIXED: only genuinely-matching guesses count, lies dropped", () => {
  // cells 0-3 honest correct; cells 4-8 marked correct but wrong guess.
  const guesses = [
    correctNames[0], correctNames[1], correctNames[2], correctNames[3],
    "wrong", "wrong", "wrong", "wrong", "wrong",
  ];
  const c = cells(guesses, Array(9).fill("correct"));
  const {correctCount, serverScored} = scoreCellsServerSide(c, answerIds);
  assert.equal(serverScored, true);
  assert.equal(correctCount, 4); // only the 4 real matches
});
