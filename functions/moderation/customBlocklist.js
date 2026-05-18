/**
 * functions/moderation/customBlocklist.js
 * ─────────────────────────────────────────────────────────────────────────
 * TeeBox-specific additions and tunings layered on top of the
 * `bad-words` npm package's default list. We DO NOT enumerate the
 * contents anywhere outside this file (no console.log, no commit
 * messages, no audit-log fields). Treat the lists below as internal
 * data.
 *
 * Categories:
 *   • SLUR_TERMS — racial / ethnic / anti-LGBTQ / sexual slurs the
 *     `bad-words` default list misses or under-covers. These are HARD
 *     blocks at any byte position, no word-boundary leniency.
 *   • HARASSMENT_PATTERNS — common harassment / threat phrasing the
 *     bad-words package doesn't catch (e.g. "kill yourself" variants).
 *     Regex patterns, case-insensitive.
 *   • ALLOWLIST — common-English collisions with `bad-words` that we
 *     want to UN-block (Scunthorpe problem). Anything matching here is
 *     never flagged even if the upstream filter catches it.
 *
 * Detection layers in contentFilter.js consult these in order:
 *   1. ALLOWLIST consult — if the input only contains allowlisted
 *      collisions, short-circuit to clean.
 *   2. SLUR_TERMS — case-insensitive substring on a normalized version
 *      of the input (lower-cased, leetspeak-folded, unicode-normalized).
 *   3. HARASSMENT_PATTERNS — regex sweep on the normalized input.
 *   4. bad-words.isProfane on the original input.
 *
 * Normalization in contentFilter.js folds these common evasions:
 *   • Leetspeak: 0→o, 1→i/l, 3→e, 4→a, 5→s, 7→t, @→a, $→s, !→i.
 *   • Unicode lookalikes (Cyrillic а→Latin a, Cyrillic о→Latin o, etc.)
 *   • Fullwidth digits / letters → ASCII.
 *   • Punctuation stripping (`f*ck`, `f-ck`, `f.ck` all collapse to `fck`
 *     which then leet-folds against the canonical list).
 *
 * IMPORTANT: When updating this file, NEVER enumerate the contents in
 * commit messages, PR descriptions, or chat output. The repo treats
 * these strings as sensitive internal data. If you need to add a term,
 * add it; describe the action category-by-category only.
 */

"use strict";

// ── SLUR_TERMS ────────────────────────────────────────────────────────
// Conservative coverage of the four obvious slur categories. The
// `bad-words` default list misses several common variants and a handful
// of contemporary additions. We canonicalize to the lowercase, leet-
// folded form — the detector folds the input the same way before
// substring-matching so leetspeak / unicode evasions land here too.
//
// (DO NOT enumerate these in any external surface — log/commit/chat.)
const SLUR_TERMS = [
  // racial
  "nigger", "nigga", "negro", "kike", "spic", "chink", "gook",
  "wetback", "beaner", "raghead", "towelhead", "sandnigger",
  "coon", "jigaboo",
  // ethnic
  "wop", "dago", "kraut", "polack",
  // anti-LGBTQ
  "faggot", "fag", "tranny", "dyke", "queer",
  // sexual / vulgar slurs (overlap with bad-words but kept for
  // word-boundary-free substring matching against leet evasions)
  "cunt", "whore", "slut",
  // ableist (often used as harassment)
  "retard", "retarded", "spaz",
];

// ── HARASSMENT_PATTERNS ──────────────────────────────────────────────
// Regex-based detection for phrases bad-words cannot reach because
// they're multi-word constructs or carry meaning only as a sequence.
// All patterns run against the NORMALIZED input (lowercased, leet-
// folded, punctuation-stripped). Keep these tight — false positives
// here block users from sending legitimate messages.
const HARASSMENT_PATTERNS = [
  // self-harm encouragement
  /\bkill\s*your\s*self\b/,
  /\bkys\b/,
  /\bgo\s*die\b/,
  /\bhang\s*your\s*self\b/,
  // direct violence threats
  /\bi(?:m| am|'m)?\s*(?:gonna|going to|will)\s*kill\s*(?:you|u)\b/,
  /\b(?:gonna|going to|will)\s*beat\s*(?:you|u)\s*up\b/,
  /\bi(?:m| am|'m)?\s*(?:gonna|going to|will)\s*find\s*(?:you|u)\b/,
  // doxx threats
  /\bi\s*know\s*where\s*(?:you|u)\s*live\b/,
];

// ── ALLOWLIST ────────────────────────────────────────────────────────
// The Scunthorpe problem and friends. If the `bad-words` package
// flags an input solely because of one of these substrings, we
// override to clean. Matched as case-insensitive whole words (the
// detector splits the input on whitespace + punctuation before
// consulting this list).
//
// Pattern: substring-of-input that is itself benign. The detector
// will pull the offending word out of the input and check if it
// matches any entry here exactly (case-insensitive). If yes, ignore
// the flag for that token.
const ALLOWLIST = new Set([
  // Geographic / proper nouns (Scunthorpe problem family)
  "scunthorpe", "scunthorpian",
  "penistone", "lightwater",
  // Common English words that contain bad-words triggers
  "class", "classes", "classy", "classic", "classical", "classify",
  "grass", "grasses", "grassy", "grassland",
  "bass", "brass", "glass", "glasses", "glassy",
  "assist", "assistant", "assistance", "assess", "assessment",
  "assign", "assignment", "assume", "assumption",
  "passage", "passages", "compass", "compassion",
  "embarrass", "embarrassing", "harass", "harassment",
  "mass", "masses", "amass",
  // Anatomy & medical terms a P2P golf marketplace user could use
  "analysis", "analyst", "analyze",
  "cockpit", // off chance someone references airline / aviation
  // Golf-domain words
  "shaft", "shafts", "shafted", // grip/shaft component talk
  "spec", "specs", "specced",
  "stroke", "strokes", "stroked",
  "putter", "putters", "putt", "putts", "putting",
  "stiff", "stiffer", "stiffness", // shaft flex
  "wedge", "wedges", "wedged",
  "rough", "roughest",
  "lie", "lies", "lied", "lying", // club lie angle
  "rip", "ripped", "rips", // descriptive
]);

// ── PROFANITY_SKELETONS ─────────────────────────────────────────────
// Consonant-cluster signatures of common profanity, used to catch
// vowel-elision evasions (`f*ck` → fck → matches; `f@ck` → if @ doesn't
// fold to `u`, the leet pass produces `fack` which still won't match
// `fuck`, but the skeleton `fck` lands here).
//
// Detector strips all vowels from each token in the collapsed/leet form
// and checks against this list. Tokens shorter than the skeleton don't
// match (`fc`, `f` won't hit `fck`).
//
// Keep these very tight — a false positive blocks innocent acronyms.
// Add only when the consonant skeleton has no benign English meaning.
const PROFANITY_SKELETONS = new Set([
  "fck", "fcks", "fcked", "fcking", "fckr", "fckers",
  "sht", "shts", "shty", "shtty", "bshtt",
  "btch", "btchs", "btches", "btchy",
  "cnt", "cnts", // matches "cunt" skeleton; allowed inside ALLOWLIST tokens
  "dmn",         // damn
  "ngr", "ngrs", // racial-slur skeleton; same allowlist guard
  "fggt", "fggts", // anti-LGBTQ slur skeleton
]);

// ── LEETSPEAK / UNICODE FOLDING ──────────────────────────────────────
// Single source of truth used by contentFilter.js. Keep the two
// modules in lockstep — the test suite asserts the obvious evasions
// (f*ck, f@ck, f-ck, Cyrillic а, fullwidth digits) all land on the
// same canonical form as the unobfuscated spelling.
const LEET_MAP = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t",
  "8": "b", "9": "g",
  "@": "a", "$": "s", "!": "i", "+": "t",
};

// Unicode lookalikes commonly substituted for Latin characters in
// evasion attempts. Confusables list trimmed to the high-value
// pairs — the full Unicode confusables.txt is 8k lines; we keep
// just what real-world abuse uses.
const UNICODE_LOOKALIKES = {
  // Cyrillic
  "а": "a", "е": "e", "о": "o", "р": "p",
  "с": "c", "х": "x", "у": "y", "ӏ": "l",
  "и": "n", "к": "k", "м": "m", "в": "b",
  // Greek
  "α": "a", "ε": "e", "ο": "o", "ρ": "p",
  "κ": "k", "ν": "v", "τ": "t",
  // Fullwidth ASCII (U+FF01..U+FF5E) handled programmatically in
  // contentFilter.js — too many entries to enumerate here.
};

// ── _TEST_SAMPLES ────────────────────────────────────────────────────
// Categorized sample picks for the test harness. Exposed ONLY for
// contentFilter.test.js so the test file doesn't need to enumerate
// any literal slur — it pulls one canonical entry per category from
// this map. Production code never reads this export.
//
// Each entry is the FIRST term from the named category cluster
// inside SLUR_TERMS. If the categorization shifts (e.g. new entries
// inserted above), update the indices below to keep the test stable.
const _TEST_SAMPLES = Object.freeze({
  racial: SLUR_TERMS[0],
  ethnic: SLUR_TERMS.find((t) =>
    SLUR_TERMS.indexOf(t) >= 13 && SLUR_TERMS.indexOf(t) <= 17) ||
    SLUR_TERMS[14],
  homophobic: SLUR_TERMS.find((t) =>
    SLUR_TERMS.indexOf(t) >= 17 && SLUR_TERMS.indexOf(t) <= 22) ||
    SLUR_TERMS[17],
});

module.exports = {
  SLUR_TERMS,
  HARASSMENT_PATTERNS,
  ALLOWLIST,
  PROFANITY_SKELETONS,
  LEET_MAP,
  UNICODE_LOOKALIKES,
  _TEST_SAMPLES,
};
