/**
 * functions/founderBriefingConfig.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tunable knobs for the dailyFounderBriefing scheduled function in
 * ./founderBriefing.js.
 *
 * Why a JS module instead of `config/founderBriefing` in Firestore?
 *   - Editing a Firestore doc still requires the operator to know what's
 *     allowed (no schema enforcement on a free-form map). For thresholds
 *     that should be reviewed alongside code, plain JS is safer.
 *   - The briefing function is also one of the few that touches the
 *     Anthropic API; pinning model + prompt in code (with `git blame`) is
 *     intentional — a tweak to the "voice" is a deploy event we want to
 *     audit, not a one-click Firestore edit.
 *
 * Anything genuinely runtime-tunable (recipient address, skip-on-quiet)
 * lives here as exported scalars/strings. Re-deploy to change. That cost
 * is acceptable for an internal-only daily email.
 */

// ─── Notable-event thresholds ─────────────────────────────────────────
// A single order at or above this dollar amount surfaces as a "big sale"
// notable event. $500 because TeeBox's median sale is in the $80–$150
// range; a $500+ ticket is a putter / iron set / something worth a glance.
const LARGE_ORDER_USD = 500;

// Optional fraud-score threshold. Today the codebase does NOT compute a
// `fraudScore` field on user docs — the field is reserved for future
// signup-anomaly detection. If/when it lands, anything above this value
// gets flagged as a notable signup. Until then `findNotableEvents()` will
// simply find zero matches; documented in the function header.
const FRAUD_SCORE_THRESHOLD = 80; // 0–100 scale (placeholder; field TBD)

// ─── Statistical flagging ─────────────────────────────────────────────
// How many standard deviations away from the trailing-30 mean before we
// call out a metric as "abnormal" in the structured payload sent to
// Claude. 2.0 ≈ flag the top/bottom ~5% of days under a normal
// distribution. We bias toward higher (less noisy) because the operator
// reads this every morning — false positives erode trust fast.
const STDDEV_MULTIPLIER = 2.0;

// ─── Delivery ─────────────────────────────────────────────────────────
// Founder inbox. Hardcoded recipient because the briefing is internal —
// changing who reads it is a deploy event. (We do NOT want this email
// to be one Firestore-doc edit away from leaking GMV figures.)
const RECIPIENT_EMAIL = "jakenair23@gmail.com";

// If true and the previous 24h had zero orders + zero new users + zero
// new listings, skip sending entirely. Default false: a "quiet day"
// email is still useful because absence of activity is itself signal.
const SKIP_ON_QUIET_DAY = false;

// ─── Anthropic ────────────────────────────────────────────────────────
// Pinned to claude-sonnet-4-6 per the briefing spec. Bump alongside a
// human review of the resulting voice — see CLAUDE_BRIEFING_OPS.md
// (TODO: write once we have a few weeks of output to compare).
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// 800 tokens is comfortably more than the spec's ~200-word summary plus
// the "Top 3 things to act on today" section. Hard cap so a runaway
// generation doesn't quietly burn $1+ of API credit on one briefing.
const ANTHROPIC_MAX_TOKENS = 800;

// System prompt — kept here (not in Firestore) so changes are reviewable
// in git history. Long enough to anchor the voice, short enough that
// caching it across days is cheap. The model gets the structured
// metrics JSON in the *user* message; that's where day-to-day variation
// lives.
const ANTHROPIC_SYSTEM_PROMPT = `You are the operations briefing analyst for TeeBox Market, a
peer-to-peer marketplace for used golf equipment. You write a daily
briefing email for the founder, Jake.

You will receive a JSON object describing the last 24 hours of activity
plus 7-day and 30-day baselines. Your job:

1. Write a ~200-word plain-English summary of what happened in the last
   24 hours. Lead with the headline number (GMV or order count,
   whichever is more notable). Mention any metric that is more than 2
   standard deviations away from its 30-day mean — say whether it's
   higher or lower than usual, and by how much.
2. After the summary, output a section titled "Top 3 things to act on
   today" with exactly three numbered, ranked items. Each item should
   be one short imperative sentence Jake can do today (e.g. "Review the
   3 disputes opened yesterday — 2 are still unanswered").
3. If any "notable events" are surfaced in the payload (big sales,
   first-time sellers, disputes on flagged listings), mention them
   explicitly by name/id in either the summary or the Top 3.

Tone: terse, founder-to-founder. No marketing fluff, no emoji, no
exclamation points. If the day was genuinely quiet (no orders, no new
users), say so directly — don't pad. Plain text only (no Markdown
headers or bullets) — the surrounding template adds visual structure.`;

module.exports = {
  LARGE_ORDER_USD,
  FRAUD_SCORE_THRESHOLD,
  STDDEV_MULTIPLIER,
  RECIPIENT_EMAIL,
  SKIP_ON_QUIET_DAY,
  ANTHROPIC_MODEL,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_SYSTEM_PROMPT,
};
