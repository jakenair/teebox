/**
 * functions/moderation/contentFilter.js
 * ─────────────────────────────────────────────────────────────────────────
 * Server-side content moderation for user-generated content. Applied to
 * listing fields (title / desc / brand / condition), direct messages,
 * profile displayName + bio, and offer message bodies.
 *
 * Apple App Store guideline 1.2 requires UGC apps to filter offensive
 * content. This module is the canonical chokepoint — every UGC write
 * path either calls `scanContent()` directly before persisting (callable
 * pre-write) or relies on a Firestore trigger in `index.js` that calls
 * `scanContent()` and deletes/clears the offending doc.
 *
 * PUBLIC API
 * ──────────────────────────────────────────────────────────────────────
 *   scanContent(text, contentType, uid, request) →
 *     {clean: bool, category: string|null, redactedExcerpt: string|null}
 *
 *   When `clean === false` we ALSO write to `moderationLog/{auto_id}`
 *   with the redacted excerpt + originating IP. The caller is
 *   responsible for the actual reject path (throwing HttpsError, or
 *   deleting the Firestore doc). This module never throws on
 *   detection — only on internal errors (logged and propagated).
 *
 * NORMALIZATION (the source of evasion-resistance)
 * ──────────────────────────────────────────────────────────────────────
 *   normalize(input):
 *     1. NFKC unicode fold (fullwidth → ASCII, ligature unification)
 *     2. Map Cyrillic / Greek confusables to Latin
 *     3. Lowercase
 *     4. Leetspeak fold (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s, !→i)
 *     5. Strip punctuation/whitespace WITHIN tokens (collapse f*ck → fck,
 *        f-ck → fck, b!tch → bitch). Token boundaries preserved.
 *
 *   The detector matches SLUR_TERMS against this normalized form via
 *   substring (not word boundary) so `nigg3r` → `nigger` collides on
 *   the same byte sequence as the unobfuscated spelling.
 *
 * REDACTION FORMAT
 * ──────────────────────────────────────────────────────────────────────
 *   redactedExcerpt = first 10 chars + "***" + last 5 chars, capped at
 *   100 total chars. Used so moderation queue admins can spot patterns
 *   without us logging full UGC bodies. We deliberately do NOT log the
 *   matched term — that would leak our blocklist over time via the
 *   audit collection.
 *
 * SECURITY NOTES
 * ──────────────────────────────────────────────────────────────────────
 *   • SLUR_TERMS / HARASSMENT_PATTERNS / ALLOWLIST live in
 *     ./customBlocklist.js. NEVER enumerate their contents in any
 *     external surface (console.log, commit, chat).
 *   • Originating IP is extracted best-effort from the callable's
 *     `request.rawRequest.headers['x-forwarded-for']`. For Firestore
 *     triggers we don't have that — `request` is null and IP is null.
 *   • moderationLog writes are non-throwing (best-effort) so a
 *     Firestore hiccup never blocks the reject path. The console.warn
 *     line on failure is intentionally generic (no excerpt, no term).
 */

"use strict";

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");
// NOTE: `bad-words` is intentionally NOT required at module scope. Its
// default dictionary load is heavy enough to push the functions-discovery
// phase past the deploy CLI's timeout when the monolith `index.js` (6.8k
// LOC) also gets parsed in the same cold-start window (POST_BETA_FIXES
// #22 — discovery-hang on 2026-05-17). Lazy-loaded inside getFilter()
// so it's paid on first scan, not on every cold start before any
// callable / trigger has been invoked.
const {
  SLUR_TERMS,
  HARASSMENT_PATTERNS,
  ALLOWLIST,
  PROFANITY_SKELETONS,
  LEET_MAP,
  UNICODE_LOOKALIKES,
} = require("./customBlocklist");

// Build the bad-words filter once per cold start. The allowlist option
// pulls anything in our ALLOWLIST set OUT of the default list so the
// Scunthorpe family (`class`, `grass`, `assist`, etc.) won't trip on
// the embedded `ass` substring.
let _filter = null;
let _Filter = null;
function getFilter() {
  if (_filter) return _filter;
  if (!_Filter) {
    // Deferred require — see comment at top of file. Only paid when a
    // moderation path actually runs (first listing/profile/message scan).
    _Filter = require("bad-words");
  }
  const f = new _Filter();
  // bad-words exposes `removeWords` to drop entries from its default
  // list. We pull anything in our ALLOWLIST out so the substring match
  // doesn't fire on the legitimate token. The allowlist itself is also
  // consulted at token-time as a backstop (in case bad-words later
  // changes its list shape).
  try {
    if (typeof f.removeWords === "function" && ALLOWLIST.size > 0) {
      f.removeWords(...ALLOWLIST);
    }
  } catch (_e) {
    // older bad-words versions name this differently — fail open.
  }
  _filter = f;
  return _filter;
}

// ── normalize() ─────────────────────────────────────────────────────
// Fold an input into the canonical comparison form. Pure function;
// safe to call on huge strings (linear in input length).
function normalize(input) {
  if (input == null) return "";
  let s = String(input);

  // 1. NFKC compose — collapses fullwidth digits/letters, ligatures,
  // combining marks. Ｂｉｔｃｈ → Bitch, ﬁsh → fish.
  try {
    s = s.normalize("NFKC");
  } catch (_e) { /* ignore — non-Latin scripts already are NFKC */ }

  // 2. Confusable substitution. Done before lowercase so we replace
  // both cases in the same pass.
  let out = "";
  for (const ch of s) {
    const sub = UNICODE_LOOKALIKES[ch] ||
                UNICODE_LOOKALIKES[ch.toLowerCase()] ||
                ch;
    out += sub;
  }
  s = out;

  // 3. Lowercase.
  s = s.toLowerCase();

  // 4. Leetspeak fold. Done character-by-character (no regex) so a
  // long leet-string like `b!t(h` lands on `bitch` (after step 5
  // collapses the `(` punctuation).
  let leet = "";
  for (const ch of s) {
    leet += LEET_MAP[ch] || ch;
  }
  s = leet;

  return s;
}

// ── collapsePunctuation() ───────────────────────────────────────────
// Strip non-alphanumeric characters out of each whitespace-separated
// token. `f*ck` → `fck`, `b!tch` → `bitch` (after leet fold), `f-ck`
// → `fck`. Tokens stay separate so allowlist matching can still walk
// the original word list.
function collapsePunctuation(normalized) {
  return normalized
      .split(/\s+/)
      .map((tok) => tok.replace(/[^a-z0-9]+/gi, ""))
      .filter((tok) => tok.length > 0)
      .join(" ");
}

// ── containsSlurTerm() ───────────────────────────────────────────────
// Substring sweep over the normalized + collapsed form. Returns the
// matched term (caller uses this only for categorization, NEVER for
// logging). Returns null if clean.
//
// We walk token-by-token so a slur match that's contained inside an
// ALLOWLIST token (Scunthorpe → cunt, classic → ass) gets skipped.
// Only tokens with a slur hit that is NOT inside an allowlist token
// trigger.
function containsSlurTerm(normalized) {
  const collapsed = collapsePunctuation(normalized);
  if (!collapsed) return null;
  const tokens = collapsed.split(/\s+/).filter(Boolean);
  // Per-token sweep: a slur hit inside an allowlisted token is
  // benign (Scunthorpe contains "cunt", classic contains "ass").
  for (const tok of tokens) {
    if (ALLOWLIST.has(tok)) continue;
    for (const term of SLUR_TERMS) {
      if (tok.includes(term)) return term;
    }
  }
  // Also check concatenated form (catches multi-token slurs like
  // `sand nigger` collapsed to `sandnigger`). We re-allowlist by
  // pulling out every allowlisted run before scanning.
  let flat = tokens.filter((t) => !ALLOWLIST.has(t)).join("");
  for (const term of SLUR_TERMS) {
    if (flat.includes(term)) return term;
  }
  return null;
}

// ── containsSkeleton() ───────────────────────────────────────────────
// Strip vowels from each collapsed token and check against
// PROFANITY_SKELETONS. Catches vowel-elision evasions like `f*ck`,
// `f-ck`, `s.h.i.t` (collapses to `sht`). Tokens that survive
// vowel-stripping with length < 3 are skipped (acronym false-positive
// guard).
//
// IMPORTANT: A token is only flagged if it has ANY non-vowel obfuscation
// in the original (i.e. some punctuation, special char, or substituted
// vowel was used). Plain "fck" as an acronym wouldn't trigger because
// we require the original token to differ from its vowel-stripped form
// — i.e. the user had to do something to evade.
//
// Token-by-token; allowlisted tokens skipped. Returns true if any
// non-allowlisted token's vowel-stripped form is in PROFANITY_SKELETONS
// AND the original token signals obfuscation.
function containsSkeleton(originalInput, normalized) {
  if (!originalInput) return false;
  const collapsed = collapsePunctuation(normalized);
  if (!collapsed) return false;
  const tokens = collapsed.split(/\s+/).filter(Boolean);
  // Split the original at whitespace so we can align tokens.
  const origTokens = String(originalInput).toLowerCase()
      .split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (ALLOWLIST.has(tok)) continue;
    if (tok.length < 3) continue;
    const skel = tok.replace(/[aeiou]/g, "");
    if (skel.length < 3) continue;
    if (!PROFANITY_SKELETONS.has(skel)) continue;
    // Require an obfuscation signal in the original token: it must
    // contain a non-letter that we stripped to reach the skeleton,
    // OR its leet-folded form differs from its plain-lowercase form.
    const orig = origTokens[i] || tok;
    const hasNonLetter = /[^a-z]/i.test(orig);
    if (hasNonLetter) return true;
    // No obfuscation char but the consonant skeleton matches — could
    // be a benign acronym. Skip.
  }
  return false;
}

// ── containsHarassmentPattern() ──────────────────────────────────────
// Regex sweep on the normalized (punctuation preserved between tokens)
// form. Whitespace inside the regex bodies tolerates leetspeak gaps.
function containsHarassmentPattern(normalized) {
  for (const re of HARASSMENT_PATTERNS) {
    if (re.test(normalized)) return true;
  }
  return false;
}

// ── isAllowlistedToken() ─────────────────────────────────────────────
// True if the only bad-words match is a token that lives in our
// ALLOWLIST (e.g. "class action" tripping on the embedded "ass").
// Walks the original (non-folded) tokens against the allowlist.
function isAllowlistedToken(originalInput) {
  if (!originalInput) return false;
  const f = getFilter();
  // Lowercase original then split on whitespace.
  const tokens = String(originalInput).toLowerCase()
      .split(/[^a-z0-9']+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // If every token is either clean (per bad-words) or in our
  // ALLOWLIST, the input is clean.
  for (const tok of tokens) {
    if (ALLOWLIST.has(tok)) continue;
    try {
      if (f.isProfane(tok)) return false;
    } catch (_e) {
      return false;
    }
  }
  return true;
}

// ── redact() ─────────────────────────────────────────────────────────
// First 10 chars + "***" + last 5 chars, total cap 100. Strips
// newlines so the audit log stays grep-friendly. Returns "" for empty
// inputs.
function redact(input) {
  if (input == null) return "";
  const s = String(input).replace(/\s+/g, " ").trim();
  if (s.length === 0) return "";
  if (s.length <= 15) {
    // Short input — show first half, mask second half. We deliberately
    // never echo the full string even if it's <= 15 chars.
    const half = Math.ceil(s.length / 2);
    return (s.slice(0, half) + "***").slice(0, 100);
  }
  const first = s.slice(0, 10);
  const last = s.slice(-5);
  return (first + "***" + last).slice(0, 100);
}

// ── extractIp() ──────────────────────────────────────────────────────
// Pull the originating IP from a v2 onCall `request` object. Returns
// null for Firestore triggers (no rawRequest available) or when the
// header is absent.
function extractIp(request) {
  if (!request) return null;
  const raw = request.rawRequest;
  if (!raw || !raw.headers) return null;
  const xff = raw.headers["x-forwarded-for"];
  if (!xff) return raw.ip || null;
  const first = String(xff).split(",")[0];
  return (first && first.trim()) || null;
}

// ── writeAuditLog() ──────────────────────────────────────────────────
// Best-effort write to moderationLog/{auto_id}. Never throws — a
// Firestore hiccup must not block the reject path.
async function writeAuditLog({uid, contentType, category, redactedExcerpt, originatingIp}) {
  try {
    await admin.firestore().collection("moderationLog").add({
      uid: uid || null,
      contentType,
      category,
      redactedExcerpt,
      originatingIp: originatingIp || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    // Generic warn — no excerpt, no category-specific detail. The
    // alert path here is dashboard monitoring of moderation function
    // error rates, not the contents of the violation.
    logger.warn("moderation: audit log write failed");
  }
}

// ── scanContent() ────────────────────────────────────────────────────
// Public entry point. Categorizes the violation and returns a structured
// result. Side effect: writes moderationLog when not clean.
//
//   text         — the candidate string (any UGC field)
//   contentType  — one of "listing" | "message" | "profile" | "offer"
//   uid          — author's auth uid (or null for unauthenticated)
//   request      — v2 onCall request (for IP), or null for triggers
//
// Returns: {clean, category, redactedExcerpt}
//   clean=true  → category=null, redactedExcerpt=null
//   clean=false → category in {profanity, slur, harassment},
//                 redactedExcerpt is the 10+5 char masked form
async function scanContent(text, contentType, uid, request) {
  // Empty / null / whitespace-only: clean.
  if (text == null) return {clean: true, category: null, redactedExcerpt: null};
  const original = String(text);
  if (original.trim().length === 0) {
    return {clean: true, category: null, redactedExcerpt: null};
  }

  // Hard cap: scan at most the first 8000 chars. Listings are capped
  // at 4000 (rules), messages at 2000, profile bio at 600, offer
  // message at 500. 8000 gives headroom + DoS protection.
  const trimmed = original.length > 8000 ? original.slice(0, 8000) : original;

  const normalized = normalize(trimmed);

  // Layer 1: HARASSMENT_PATTERNS (highest severity short of slurs).
  if (containsHarassmentPattern(normalized)) {
    const excerpt = redact(trimmed);
    await writeAuditLog({
      uid, contentType,
      category: "harassment",
      redactedExcerpt: excerpt,
      originatingIp: extractIp(request),
    });
    return {clean: false, category: "harassment", redactedExcerpt: excerpt};
  }

  // Layer 2: SLUR_TERMS (substring on the normalized form).
  if (containsSlurTerm(normalized)) {
    const excerpt = redact(trimmed);
    await writeAuditLog({
      uid, contentType,
      category: "slur",
      redactedExcerpt: excerpt,
      originatingIp: extractIp(request),
    });
    return {clean: false, category: "slur", redactedExcerpt: excerpt};
  }

  // Layer 2b: PROFANITY_SKELETONS — vowel-elision evasion catcher.
  // Fires for tokens like `f*ck`, `f-ck`, `s.h.i.t` whose vowel-
  // stripped collapsed form matches a known profanity skeleton AND
  // the original token contained a non-letter obfuscation signal.
  if (containsSkeleton(trimmed, normalized)) {
    const excerpt = redact(trimmed);
    await writeAuditLog({
      uid, contentType,
      category: "profanity",
      redactedExcerpt: excerpt,
      originatingIp: extractIp(request),
    });
    return {clean: false, category: "profanity", redactedExcerpt: excerpt};
  }

  // Layer 3: bad-words default profanity sweep on the ORIGINAL input,
  // gated by the allowlist short-circuit.
  let profane = false;
  let degraded = false;
  try {
    profane = getFilter().isProfane(trimmed);
  } catch (_e) {
    // bad-words can throw on weird unicode — fall back to clean rather
    // than block a benign message, but SIGNAL the degradation so callers
    // (e.g. updateListing) can flag-for-review instead of silently
    // trusting a "clean" that was really a failed scan layer.
    profane = false;
    degraded = true;
  }
  if (profane && isAllowlistedToken(trimmed)) {
    profane = false;
  }
  // Belt-and-suspenders: also run the bad-words filter on the leet-
  // folded form so `f*ck` / `f@ck` evasions land here.
  if (!profane) {
    try {
      const collapsed = collapsePunctuation(normalized);
      if (collapsed && getFilter().isProfane(collapsed)) {
        // One more allowlist check on the collapsed tokens.
        const tokens = collapsed.split(/\s+/).filter(Boolean);
        const anyBlocked = tokens.some((t) => {
          if (ALLOWLIST.has(t)) return false;
          try {
            return getFilter().isProfane(t);
          } catch (_e) {
            return false;
          }
        });
        if (anyBlocked) profane = true;
      }
    } catch (_e) { degraded = true; }
  }
  if (profane) {
    const excerpt = redact(trimmed);
    await writeAuditLog({
      uid, contentType,
      category: "profanity",
      redactedExcerpt: excerpt,
      originatingIp: extractIp(request),
    });
    return {clean: false, category: "profanity", redactedExcerpt: excerpt};
  }

  // Clean — but surface `degraded` if any profanity layer failed open so
  // callers can flag-for-review rather than silently trust the verdict.
  return {clean: true, category: null, redactedExcerpt: null, degraded};
}

// ── scanFields() ─────────────────────────────────────────────────────
// Helper for callers that need to sweep multiple fields on a single
// document (listings, profiles). Returns the FIRST violation
// encountered (writes the audit row at that point) or a clean result.
async function scanFields(fields, contentType, uid, request) {
  let degraded = false;
  for (const [, value] of Object.entries(fields || {})) {
    if (value == null) continue;
    if (typeof value !== "string") continue;
    if (value.trim().length === 0) continue;
    const result = await scanContent(value, contentType, uid, request);
    if (!result.clean) return result;
    if (result.degraded) degraded = true;
  }
  return {clean: true, category: null, redactedExcerpt: null, degraded};
}

// shouldHoldListing — moderation ACTION decision for listings. A content
// violation OR a degraded/errored scan both HOLD the listing for review
// (fail CLOSED). Never silent-delete, never silent-pass. Pure + exported so
// the fail-closed behavior is deterministically testable.
function shouldHoldListing(result) {
  const r = result || {};
  if (r.clean === false) return {hold: true, reason: "content_violation"};
  if (r.degraded === true) return {hold: true, reason: "scan_error"};
  return {hold: false, reason: null};
}

module.exports = {
  scanContent,
  scanFields,
  shouldHoldListing,
  // Exposed for unit tests only. Do NOT import these elsewhere — the
  // public surface is scanContent / scanFields.
  __testing: {
    normalize,
    collapsePunctuation,
    containsSlurTerm,
    containsHarassmentPattern,
    containsSkeleton,
    isAllowlistedToken,
    redact,
    extractIp,
  },
};
