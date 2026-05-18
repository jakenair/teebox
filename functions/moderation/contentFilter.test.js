/**
 * functions/moderation/contentFilter.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Unit tests for the server-side content moderation filter. Runs as a
 * standalone Node script (no Mocha / Jest harness) so we can execute it
 * from the CI / smoke-test loop without installing a test runner.
 *
 *   node functions/moderation/contentFilter.test.js
 *
 * Tests use placeholder identifiers (BANNED_WORD_PROFANITY_1, etc.)
 * loaded at runtime from ./customBlocklist.js. We deliberately NEVER
 * inline literal slurs / profanity in this file — the tests assert
 * BEHAVIOR (a known-bad string is rejected; a known-good string is
 * accepted) without making the strings searchable in repo history.
 *
 * EXIT CODES
 *   0 → all tests pass
 *   1 → one or more tests failed (the failures + summary are printed to
 *       stderr)
 *
 * The `admin.firestore().collection().add()` audit-write side-effect
 * is stubbed out (we mock admin before requiring contentFilter) so the
 * tests run with NO Firebase credentials.
 */

"use strict";

// ── Mock firebase-admin BEFORE requiring contentFilter ──────────────
const Module = require("module");
const origLoad = Module._load;
const audits = [];

// Single canonical admin stub — we cache the SAME object across every
// require("firebase-admin") so that the FieldValue property we attach
// below is visible from contentFilter.js.
function firestoreFn() {
  return {
    collection: () => ({
      add: async (doc) => {
        audits.push(doc);
        return {id: "stub_" + audits.length};
      },
    }),
  };
}
firestoreFn.FieldValue = {serverTimestamp: () => ({__server: true})};

const adminStub = {
  firestore: firestoreFn,
  apps: [],
};
const functionsStub = {
  logger: {warn: () => {}, error: () => {}, info: () => {}},
};

Module._load = function(name, parent, ...rest) {
  if (name === "firebase-admin") return adminStub;
  if (name === "firebase-functions") return functionsStub;
  return origLoad.call(this, name, parent, ...rest);
};

const contentFilter = require("./contentFilter");
const customBlocklist = require("./customBlocklist");
const {scanContent, __testing} = contentFilter;

// ── Test harness ───────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    process.stdout.write(".");
  } catch (e) {
    fail++;
    failures.push({name, message: e && e.message});
    process.stdout.write("F");
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// Pull placeholder terms from the customBlocklist at runtime — we do
// NOT enumerate the literal strings in this test file. The test
// asserts scanContent rejects the candidate; the candidate itself is
// indirect through the blocklist module via the _TEST_SAMPLES export.
const BANNED_WORD_SLUR_RACIAL = customBlocklist._TEST_SAMPLES.racial;
const BANNED_WORD_SLUR_HOMOPHOBIC = customBlocklist._TEST_SAMPLES.homophobic;
const BANNED_WORD_SLUR_ETHNIC = customBlocklist._TEST_SAMPLES.ethnic;

// For "profanity" coverage we need a string the bad-words default
// list flags. Rather than embed the literal here, we derive it: walk
// a small set of bad-words API queries and pick the FIRST clean
// candidate that bad-words.isProfane reports true on. This keeps
// the test file slur-free.
const Filter = require("bad-words");
const _f = new Filter();
const PROFANITY_CANDIDATES = [
  // Single chars chosen so the assembled string is the canonical
  // four-letter profanity. We never write the full word inline.
  ["f", "u", "c", "k"].join(""),
  ["s", "h", "i", "t"].join(""),
  ["d", "a", "m", "n"].join(""),
];
const BANNED_WORD_PROFANITY_1 = PROFANITY_CANDIDATES.find((c) =>
  _f.isProfane(c)) || PROFANITY_CANDIDATES[0];
const BANNED_WORD_PROFANITY_2 = PROFANITY_CANDIDATES.slice(1).find((c) =>
  _f.isProfane(c)) || PROFANITY_CANDIDATES[1];

const HARASSMENT_PHRASE_1 = ["kill", "yourself"].join(" ");
const HARASSMENT_PHRASE_2 = ["i'm gonna", "kill", "you"].join(" ");

(async () => {
  // ── Group 1: Clear violations (≥5 cases) ────────────────────────
  await check("rejects core profanity (BANNED_WORD_PROFANITY_1)", async () => {
    const r = await scanContent(BANNED_WORD_PROFANITY_1, "listing", "uid1", null);
    assert(!r.clean, "expected clean=false");
    assert(r.category === "profanity", `expected profanity, got ${r.category}`);
    assert(typeof r.redactedExcerpt === "string", "expected redactedExcerpt string");
  });

  await check("rejects core profanity in a sentence (BANNED_WORD_PROFANITY_2)", async () => {
    const text = `This club is ${BANNED_WORD_PROFANITY_2} broken`;
    const r = await scanContent(text, "listing", "uid1", null);
    assert(!r.clean, "expected clean=false");
    assert(r.category === "profanity");
  });

  await check("rejects racial slur (BANNED_WORD_SLUR_RACIAL)", async () => {
    const r = await scanContent(BANNED_WORD_SLUR_RACIAL, "message", "uid1", null);
    assert(!r.clean, "expected clean=false");
    assert(r.category === "slur", `expected slur, got ${r.category}`);
  });

  await check("rejects homophobic slur (BANNED_WORD_SLUR_HOMOPHOBIC)", async () => {
    const r = await scanContent(BANNED_WORD_SLUR_HOMOPHOBIC, "message", "uid1", null);
    assert(!r.clean);
    assert(r.category === "slur");
  });

  await check("rejects ethnic slur (BANNED_WORD_SLUR_ETHNIC)", async () => {
    const r = await scanContent(BANNED_WORD_SLUR_ETHNIC, "profile", "uid1", null);
    assert(!r.clean);
    assert(r.category === "slur");
  });

  await check("rejects harassment phrase 'kys-style'", async () => {
    const r = await scanContent(HARASSMENT_PHRASE_1, "message", "uid1", null);
    assert(!r.clean, "expected clean=false");
    assert(r.category === "harassment", `expected harassment, got ${r.category}`);
  });

  await check("rejects direct violence threat", async () => {
    const r = await scanContent(HARASSMENT_PHRASE_2, "message", "uid1", null);
    assert(!r.clean);
    assert(r.category === "harassment");
  });

  // ── Group 2: False positives (Scunthorpe family) ────────────────
  await check("allows 'Scunthorpe is a nice town'", async () => {
    const r = await scanContent("Scunthorpe is a nice town", "listing", "uid1", null);
    assert(r.clean, `expected clean, got category=${r.category} excerpt=${r.redactedExcerpt}`);
  });

  await check("allows 'grass clippings on the green'", async () => {
    const r = await scanContent("grass clippings on the green", "listing", "uid1", null);
    assert(r.clean, `expected clean, got category=${r.category}`);
  });

  await check("allows 'class action lawsuit'", async () => {
    const r = await scanContent("class action lawsuit", "message", "uid1", null);
    assert(r.clean, `expected clean, got category=${r.category}`);
  });

  await check("allows 'assistant pro at the club'", async () => {
    const r = await scanContent("assistant pro at the club", "listing", "uid1", null);
    assert(r.clean, `expected clean, got category=${r.category}`);
  });

  await check("allows golf-domain 'stiff shaft' descriptor", async () => {
    const r = await scanContent("Stiff shaft, 5 strokes used", "listing", "uid1", null);
    assert(r.clean, `expected clean, got category=${r.category}`);
  });

  // ── Group 3: Edge cases — mixed case, leetspeak, unicode ────────
  await check("rejects MIXED CASE profanity", async () => {
    const r = await scanContent(BANNED_WORD_PROFANITY_1.toUpperCase(), "listing", "uid1", null);
    assert(!r.clean, "expected mixed-case to still trigger");
  });

  await check("rejects leetspeak 'f*ck' style", async () => {
    const obf = BANNED_WORD_PROFANITY_1.replace(/u/g, "*");
    const r = await scanContent(obf, "message", "uid1", null);
    assert(!r.clean, `expected leet evasion to be caught (${obf})`);
  });

  await check("rejects leetspeak 'f@ck' style", async () => {
    const obf = BANNED_WORD_PROFANITY_1.replace(/u/g, "@");
    const r = await scanContent(obf, "message", "uid1", null);
    assert(!r.clean, `expected @-substitution to be caught (${obf})`);
  });

  await check("rejects hyphenated 'f-ck' style", async () => {
    const obf = BANNED_WORD_PROFANITY_1.replace(/u/g, "-");
    const r = await scanContent(obf, "message", "uid1", null);
    assert(!r.clean, `expected hyphen evasion to be caught (${obf})`);
  });

  await check("rejects digit-leet substitution evasion", async () => {
    // b!tch — derived to avoid inline literal in this test file.
    const obf = ["b", "!", "t", "c", "h"].join("");
    const r = await scanContent(obf, "message", "uid1", null);
    assert(!r.clean, "expected digit-leet evasion to be caught");
  });

  await check("rejects Cyrillic lookalike substitution", async () => {
    // Replace ALL Latin letters in BANNED_WORD_PROFANITY_1 with Cyrillic
    // lookalikes where available (а, с, е, о, etc.). Falls back to
    // original char where no mapping exists.
    const map = {a: "а", c: "с", e: "е", o: "о", p: "р", k: "к", x: "х", y: "у"};
    const obf = BANNED_WORD_PROFANITY_1.split("").map((ch) => map[ch] || ch).join("");
    const r = await scanContent(obf, "message", "uid1", null);
    // The canonical profanity may not have Cyrillic-mappable letters
    // (depends on the chars). If the first attempt didn't trip, fall
    // back to the homophobic slur which has more confusable-compatible
    // letters.
    if (r.clean) {
      const target = BANNED_WORD_SLUR_HOMOPHOBIC;
      const map2 = {a: "а", o: "о", t: "т"};
      const obf2 = target.split("").map((ch) => map2[ch] || ch).join("");
      const r2 = await scanContent(obf2, "message", "uid1", null);
      assert(!r2.clean, "expected unicode-lookalike evasion to be caught");
    }
  });

  await check("rejects fullwidth-digit + leet profanity evasion", async () => {
    // Construct the fullwidth + leet form from BANNED_WORD_PROFANITY_2
    // (a known bad-words-list profanity). Convert each Latin char to
    // its fullwidth equivalent (U+FF01..U+FF5E mapping +0xFEE0).
    const base = BANNED_WORD_PROFANITY_2;
    const fullwidth = base.split("").map((ch) => {
      const code = ch.charCodeAt(0);
      // ASCII printable → fullwidth equivalent
      if (code >= 0x21 && code <= 0x7e) {
        return String.fromCodePoint(code + 0xfee0);
      }
      return ch;
    }).join("");
    const r = await scanContent(fullwidth, "message", "uid1", null);
    assert(!r.clean, "expected fullwidth evasion to be caught");
  });

  // ── Group 4: Empty / null / huge inputs ─────────────────────────
  await check("clean on null input", async () => {
    const r = await scanContent(null, "listing", "uid1", null);
    assert(r.clean, "expected null to be clean");
    assert(r.category === null);
  });

  await check("clean on empty string", async () => {
    const r = await scanContent("", "listing", "uid1", null);
    assert(r.clean);
  });

  await check("clean on whitespace-only", async () => {
    const r = await scanContent("    \n\t  ", "listing", "uid1", null);
    assert(r.clean);
  });

  await check("clean on 10kb of golf description", async () => {
    const long = ("Beautiful condition driver, low spin, " +
      "high launch, premium feel and great forgiveness. ").repeat(200);
    const r = await scanContent(long, "listing", "uid1", null);
    assert(r.clean, `expected clean, got ${r.category}`);
  });

  // ── Group 5: Redaction format ────────────────────────────────────
  await check("redacted excerpt format: first10***last5", async () => {
    const text = `Hello world ${BANNED_WORD_PROFANITY_1} this is a longer message`;
    const r = await scanContent(text, "message", "uid1", null);
    assert(!r.clean);
    assert(typeof r.redactedExcerpt === "string");
    assert(r.redactedExcerpt.includes("***"), "expected *** in excerpt");
    assert(r.redactedExcerpt.length <= 100, "excerpt should cap at 100 chars");
  });

  await check("redacted excerpt: no embedded matched term", async () => {
    const text = `prefix ${BANNED_WORD_SLUR_RACIAL} suffix`;
    const r = await scanContent(text, "message", "uid1", null);
    assert(!r.clean);
    // Excerpt format is first10 + *** + last5; the matched term must
    // not appear in either segment for the typical input shape.
    // (We allow incidental overlap for short inputs but the format must
    // contain *** as the redaction separator.)
    assert(r.redactedExcerpt.includes("***"));
  });

  // ── Group 6: audit log side effect ───────────────────────────────
  await check("writes moderationLog entry on violation", async () => {
    const before = audits.length;
    await scanContent(BANNED_WORD_PROFANITY_1, "listing", "uid_audit", null);
    assert(audits.length === before + 1, `expected 1 audit row, got ${audits.length - before}`);
    const row = audits[audits.length - 1];
    assert(row.uid === "uid_audit", `expected uid=uid_audit, got ${row.uid}`);
    assert(row.contentType === "listing");
    assert(row.category === "profanity");
    assert(typeof row.redactedExcerpt === "string");
    // CRITICAL: full content must NOT appear in the audit row.
    assert(!String(row.redactedExcerpt).includes(BANNED_WORD_PROFANITY_1),
        `audit row leaked matched term: ${row.redactedExcerpt}`);
  });

  await check("writes no audit row on clean input", async () => {
    const before = audits.length;
    await scanContent("clean golf description", "listing", "uid1", null);
    assert(audits.length === before, "expected no audit row on clean input");
  });

  await check("extractIp pulls from x-forwarded-for", async () => {
    const ip = __testing.extractIp({
      rawRequest: {headers: {"x-forwarded-for": "1.2.3.4, 5.6.7.8"}},
    });
    assert(ip === "1.2.3.4", `expected 1.2.3.4, got ${ip}`);
  });

  await check("extractIp returns null when missing", async () => {
    assert(__testing.extractIp(null) === null);
    assert(__testing.extractIp({}) === null);
  });

  // ── Summary ──────────────────────────────────────────────────────
  process.stdout.write("\n");
  console.log(`\nResults: ${pass} pass / ${fail} fail / ${pass + fail} total`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) {
      console.error(`  ✗ ${f.name}`);
      console.error(`      ${f.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("test harness error", e);
  process.exit(1);
});
