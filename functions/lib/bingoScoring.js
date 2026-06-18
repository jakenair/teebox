// functions/lib/bingoScoring.js
//
// Server-side Logo Bingo answer matching. These three functions are a
// VERBATIM port of the client logic in index.html (norm / courseTerms /
// matchesCourse, ~line 17870). They MUST stay byte-for-byte equivalent to the
// client: server scoring re-derives correctCount by running matchesCourse over
// the player's per-cell `guess` against the canonical answer course, so any
// divergence here would mark honest correct answers wrong on the leaderboard.
// The parity is locked by functions/test/unit/bingoScoring.test.js — if you
// touch either copy, update the other and run `npm test`.

// Normalize a course name / guess to a comparable token. Order of operations
// matches the client exactly: lowercase → strip diacritics → drop punctuation
// → remove generic "golf club / cc / the" filler → collapse whitespace.
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9 ]+/g, " ") // drop punctuation
    .replace(
      /\bgolf club\b|\bgolf links\b|\bgolf course\b|\bcountry club\b|\bgc\b|\bcc\b|\bgl\b/g,
      "",
    )
    .replace(/\bthe\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The set of accepted normalized answer strings for a course: its name,
// shortName, and any aliases. `course` here is the canon courseData entry
// ({name, shortName, aliases}) — same fields the client reads from
// /bingo-courses.js.
function courseTerms(course) {
  const out = new Set();
  out.add(norm(course && course.name));
  out.add(norm(course && course.shortName));
  ((course && course.aliases) || []).forEach((a) => out.add(norm(a)));
  out.delete("");
  return [...out];
}

// True iff the player's raw guess normalizes to one of the course's terms.
function matchesCourse(input, course) {
  const q = norm(input);
  if (!q) return false;
  return courseTerms(course).some((t) => t === q);
}

module.exports = {norm, courseTerms, matchesCourse};
