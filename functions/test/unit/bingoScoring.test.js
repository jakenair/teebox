// functions/test/unit/bingoScoring.test.js
// Parity + correctness for the server-side bingo matcher. No emulator/Java.
// Run: npm test

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {norm, courseTerms, matchesCourse} = require("../../lib/bingoScoring");
const CANON = require("../../data/bingo-puzzle-data.json");

// ── norm(): hand-verified outputs (must equal the client's index.html norm) ──
test("norm strips 'the', generic golf-club filler, punctuation, diacritics", () => {
  assert.equal(norm("The Old Course"), "old course");
  assert.equal(norm("Pebble Beach Golf Links"), "pebble beach");
  assert.equal(norm("Augusta National GC"), "augusta national");
  // bare "Club" is NOT filler (only "golf club"/"country club" are) — matches client
  assert.equal(norm("Cypress Point Club"), "cypress point club");
  assert.equal(norm("Oakmont Country Club"), "oakmont");
  assert.equal(norm("  Café  "), "cafe"); // diacritic-insensitive
  assert.equal(norm("St. Andrews!!"), "st andrews"); // punctuation → space
  assert.equal(norm(""), "");
  assert.equal(norm(null), "");
});

// ── matchesCourse(): synthetic course, the cases server scoring relies on ──
test("matchesCourse accepts name / shortName / aliases, case & punct insensitive", () => {
  const c = {
    name: "Pine Valley Golf Club",
    shortName: "Pine Valley",
    aliases: ["pine valley gc", "PV"],
  };
  assert.equal(matchesCourse("Pine Valley", c), true);
  assert.equal(matchesCourse("  pine   valley  ", c), true);
  assert.equal(matchesCourse("Pine Valley Golf Club", c), true); // filler stripped
  assert.equal(matchesCourse("pine valley gc", c), true); // alias
  assert.equal(matchesCourse("pv", c), true); // alias
  assert.equal(matchesCourse("Pebble Beach", c), false);
  assert.equal(matchesCourse("", c), false);
});

test("courseTerms dedups and drops empties", () => {
  const terms = courseTerms({name: "Pine Valley Golf Club", shortName: "Pine Valley", aliases: ["Pine Valley GC"]});
  assert.deepEqual([...new Set(terms)], terms); // no dups
  assert.ok(!terms.includes("")); // no empties
  assert.ok(terms.includes("pine valley"));
});

// ── Canon sweep: every real course must match its OWN name + shortName ──
// This is the parity/self-consistency canary across all 117 courses — if a
// course's own name doesn't normalize into its own term set, scoring would
// mark the correct answer wrong.
test("every canon course matches its own name and shortName", () => {
  const ids = Object.keys(CANON.courseData);
  assert.ok(ids.length >= 100, `expected the full canon, got ${ids.length}`);
  const failures = [];
  for (const id of ids) {
    const cd = CANON.courseData[id];
    if (norm(cd.name) === "" && norm(cd.shortName) === "") {
      failures.push(`${id}: both name+shortName normalize to empty`);
      continue;
    }
    if (norm(cd.name) && !matchesCourse(cd.name, cd)) {
      failures.push(`${id}: name "${cd.name}" does not match itself`);
    }
    if (norm(cd.shortName) && !matchesCourse(cd.shortName, cd)) {
      failures.push(`${id}: shortName "${cd.shortName}" does not match itself`);
    }
  }
  assert.equal(failures.length, 0, "self-match failures:\n" + failures.join("\n"));
});

test("a wrong guess never matches a real course", () => {
  const someId = Object.keys(CANON.courseData)[0];
  const cd = CANON.courseData[someId];
  assert.equal(matchesCourse("zzz not a golf course 123", cd), false);
});
