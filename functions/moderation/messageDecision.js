// functions/moderation/messageDecision.js — 2026-10-30
//
// One pure function that composes the per-message anti-phishing layers the
// way sendMessage + moderateMessage apply them, so the offline replay and the
// unit tests ask exactly the question production answers:
//
//   blocked         known-bad domain (sendMessage rejects; never written)
//   held            Rule 5 link hold (messageHolds/{id}; recipient sees nothing)
//   delivered+card  delivered; moderateMessage flags HARD → warning card
//   delivered       delivered, no card (SOFT signals are logged only)
//
// Stateful rules (1 send cap, 2 breadth, 3 duplicate blast, 4 repeat-PII per
// recipient, 6 new-account seller burst) depend on the sender's history and
// are NOT modelled here — sendMessage still applies them first.
const {modDetectOffPlatform} = require("./offPlatform");
const {decideLinkHold, resolveLinkAllowlist} = require("./messageRisk");

/**
 * @param {object} p
 * @param {string} p.text
 * @param {number} p.accountAgeMs
 * @param {boolean|null} p.hasCompletedTx
 * @param {boolean} [p.senderFlagged]
 * @param {object} [p.config]  config/messaging (linkAllowlist, highRiskTlds,
 *                             knownBadDomains, linkHoldTrustAgeHours)
 */
function decideMessageOutcome({text, accountAgeMs, hasCompletedTx, senderFlagged, config}) {
  const c = config || {};
  const allowlist = resolveLinkAllowlist(c);
  const highRiskTlds = c.highRiskTlds;
  const det = modDetectOffPlatform(text, Array.isArray(c.knownBadDomains) ? c.knownBadDomains : [],
      {allowlist, senderFlagged: senderFlagged === true, highRiskTlds});
  const base = {det, allowlist};
  if (det.knownBad) {
    return {...base, decision: "blocked", reason: "known_bad_domain"};
  }
  const hold = decideLinkHold({
    externalHosts: det.countedHosts,
    scamPhrases: det.scamPhrases,
    accountAgeMs,
    trustAgeMs: Number(c.linkHoldTrustAgeHours || 168) * 3600 * 1000,
    hasCompletedTx,
    highRiskTlds,
    allowlist,
  });
  if (hold.hold) return {...base, decision: "held", reason: hold.reason};
  // moderateMessage: a scam phrase alone forces HARD (card).
  const hard = det.severity === "HARD" || det.scamPhrases.length > 0;
  if (hard) {
    const why = det.scamPhrases.length ? "scam_phrase" :
      det.countedHosts.length ? "external_link" :
      det.types.filter((t) => t !== "plain_domain").join(",") || "hard_signal";
    return {...base, decision: "delivered+card", reason: why};
  }
  const soft = det.types.length ? det.types.join(",") : null;
  return {...base, decision: "delivered",
    reason: det.allowlistedHosts.length ? "allowlisted_link" + (soft ? " (+" + soft + " soft)" : "") :
      soft ? soft + " (soft, logged only)" : "clean"};
}

module.exports = {decideMessageOutcome};
