// functions/moderation/messageRisk.js
//
// Pure decision logic for the chat anti-phishing gates in sendMessage
// (2026-10-29 hardening after the 2026-10-28 fake-payment phish). Nothing in
// here touches Firestore or Auth, so every rule is unit-testable; index.js
// does the I/O and feeds the results in.
//
// What lives here:
//   • detectScamPhrases()      — fake-payment-confirmation script phrases
//   • DEFAULT_LINK_ALLOWLIST / resolveLinkAllowlist / isAllowlistedHost —
//                                links that are never held and get no card
//   • isFlaggedSender()        — reviewFlag or offPlatformFlags > 0
//   • isHighRiskHost()         — .cfd / .top / .xyz / .icu (always held)
//   • resolveAccountCreatedMs() — account age, Auth first, FAIL CLOSED
//   • isCompletedOrder()       — what counts as a completed transaction
//   • decideLinkHold()         — Rule 5 (rewritten): link + untrusted sender
//   • decideNewSellerStart()   — Rule 6: new account starting threads with
//                                too many different sellers per hour

// ── Scam phrases ─────────────────────────────────────────────────────
// Each is matched against a lightly normalised copy of the text (lowercase,
// curly quotes folded, whitespace collapsed, "thru" → "through") so minor
// variants ("didnt go thru", "has not gone through", "confirmed via the
// link") still hit. Phrase hit + any non-exempt link → HOLD. Phrase hit alone
// → delivered but flagged HARD (recipient sees the warning card).
const SCAM_PHRASES = [
  {name: "payment_did_not_go_through",
    re: /\bpayment\s+(?:did\s*not|didn'?t|has\s*not|hasn'?t|had\s*not|hadn'?t|was\s*not|wasn'?t|could\s*not|couldn'?t|failed\s+to|never)\s+(?:go|gone|went|been\s+processed|process(?:ed)?)\b/},
  {name: "did_not_go_through",
    re: /\b(?:did\s*not|didn'?t|has\s*not|hasn'?t|have\s*not|haven'?t)\s+(?:go|gone)\s+through\b/},
  {name: "confirm_via_link",
    re: /\bconfirm(?:ed|s|ing|ation)?\b[^.!?\n]{0,40}?\b(?:via|through|using|with|by|from|at|on|in)\s+(?:the|this|that|a|my|your|our)?\s*link\b/},
  {name: "confirm_the_payment",
    re: /\bconfirm(?:ed|ing)?\s+(?:the|your|my|this|that)\s+(?:payment|transaction|transfer)\b/},
  {name: "contacted_support",
    re: /\b(?:contacted|called|messaged|reached\s+out\s+to|spoke\s+(?:to|with)|talked\s+to)\s+(?:the\s+)?(?:\w+\s+)?support\b/},
  {name: "money_withdrawn",
    re: /\b(?:money|funds|amount|payment|balance)\s+(?:was|were|has\s+been|have\s+been|had\s+been|got|is)\s+(?:already\s+)?(?:withdrawn|debited|deducted)\b/},
];

function normalizeForPhrases(text) {
  return String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[‘’ʼ`´]/g, "'")
      .replace(/\bthru\b/g, "through")
      .replace(/\s+/g, " ");
}

/** @return {string[]} names of the scam phrases present (deduped). */
function detectScamPhrases(text) {
  const s = normalizeForPhrases(text);
  if (!s) return [];
  const out = [];
  for (const p of SCAM_PHRASES) if (p.re.test(s)) out.push(p.name);
  return out;
}

// ── Hosts ────────────────────────────────────────────────────────────
// LINK ALLOWLIST (2026-10-30, Jake's list). A link to one of these domains —
// the domain itself or any subdomain (www., m., …) — is never held, never
// shows the warning card, and doesn't count toward the Rule 4 PII cap.
// Matching is label-exact: "titleist.com.evil.top" and "evil-titleist.com"
// do NOT match titleist.com.
// Runtime override: config/messaging.linkAllowlist (string[]) REPLACES this
// list when present and non-empty; teeboxmarket.com is always included.
const DEFAULT_LINK_ALLOWLIST = [
  "teeboxmarket.com",
  "apps.apple.com",
  "youtube.com", "youtu.be",
  "imgur.com",
  "instagram.com",
  // Major golf brands / retailers
  "titleist.com", "callaway.com", "taylormadegolf.com", "ping.com",
  "cobragolf.com", "mizunogolf.com", "srixon.com", "scottycameron.com",
  "vokey.com", "footjoy.com", "golfgalaxy.com", "pgatoursuperstore.com",
  "2ndswing.com", "globalgolf.com",
];
// Back-compat names (pre-2026-10-30 tests/importers).
const HOLD_EXEMPT_DOMAINS = DEFAULT_LINK_ALLOWLIST;
const HOLD_EXEMPT_HOSTS = [];

// Cheap TLDs that dominate phishing feeds. Any link on one is held
// regardless of how old or trusted the sender is.
const HIGH_RISK_TLDS = ["cfd", "top", "xyz", "icu"];

function normHost(h) {
  return String(h || "").trim().toLowerCase().replace(/\.$/, "");
}

/** host equals a list entry or is a subdomain of one. */
function hostMatchesDomainList(host, list) {
  const h = normHost(host);
  if (!h || !Array.isArray(list)) return false;
  for (const raw of list) {
    const d = normHost(raw).replace(/^\*?\./, "");
    if (d && (h === d || h.endsWith("." + d))) return true;
  }
  return false;
}

/** Effective allowlist from config/messaging (override) or the code default. */
function resolveLinkAllowlist(config) {
  const c = config || {};
  const list = Array.isArray(c.linkAllowlist) ?
    c.linkAllowlist.map(normHost).filter((d) => d && d.includes(".")) : [];
  const out = list.length ? list : DEFAULT_LINK_ALLOWLIST.slice();
  if (!out.includes("teeboxmarket.com")) out.push("teeboxmarket.com");
  return out;
}

function isAllowlistedHost(host, list) {
  return hostMatchesDomainList(host, Array.isArray(list) ? list : DEFAULT_LINK_ALLOWLIST);
}

function isHoldExemptHost(host) {
  return isAllowlistedHost(host, DEFAULT_LINK_ALLOWLIST);
}

// ── Flagged sender ───────────────────────────────────────────────────
// An account is "flagged" when users/{uid}.reviewFlag is set (Rule 6 burst,
// or an admin) or it has ≥1 server-recorded HARD off-platform message
// (offPlatformFlags > 0, incremented by moderateMessage / the known-bad
// block). For a flagged sender, a plain-text domain mention counts as a link.
function isFlaggedSender(user) {
  const u = user || {};
  return !!u.reviewFlag || Number(u.offPlatformFlags || 0) > 0;
}

function isHighRiskHost(host, tlds) {
  const h = normHost(host);
  const tld = h.slice(h.lastIndexOf(".") + 1);
  return (Array.isArray(tlds) && tlds.length ? tlds : HIGH_RISK_TLDS)
      .map((t) => String(t).toLowerCase().replace(/^\./, "")).includes(tld);
}

// ── Account age ──────────────────────────────────────────────────────
function tsToMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = Date.parse(v); return isNaN(n) ? 0 : n; }
  if (v.toMillis) return v.toMillis();
  if (v._seconds) return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  if (v instanceof Date) return v.getTime();
  return 0;
}

/**
 * Source of truth = Firebase Auth metadata.creationTime. The users-doc
 * `createdAt` is only a fallback for when the Auth lookup failed. If both are
 * unknown the account is treated as brand new (ms = now → age 0): FAIL CLOSED.
 * @param {object} p
 * @param {string|null} p.authCreationTime  UserRecord.metadata.creationTime
 * @param {*} p.docCreatedAt                users/{uid}.createdAt (any ts shape)
 * @param {number} p.now
 * @return {{ms:number, source:"auth"|"doc"|"unknown"}}
 */
function resolveAccountCreatedMs({authCreationTime, docCreatedAt, now}) {
  const a = tsToMillis(authCreationTime);
  if (a > 0) return {ms: a, source: "auth"};
  const d = tsToMillis(docCreatedAt);
  if (d > 0) return {ms: d, source: "doc"};
  return {ms: now, source: "unknown"};
}

// ── Completed transactions ───────────────────────────────────────────
// An order counts as a completed transaction for EITHER party when the money
// actually moved and was not given back:
//   • status ∈ {paid, completed, delivered} — the Stripe webhook writes
//     status "paid" only after a captured PaymentIntent; or
//     fulfillmentStatus ∈ {delivered, reviewed}
//   • NOT refunded / canceled / failed (status or fulfillmentStatus), and no
//     open-or-lost dispute (disputeStatus other than "won")
//   • NOT a Stripe test-mode order (livemode === false); orders that predate
//     the livemode field (undefined) still count
//   • buyer ≠ seller
const COMPLETED_STATUSES = ["paid", "completed", "delivered"];
const COMPLETED_FULFILLMENT = ["delivered", "reviewed"];
const VOID_STATUSES = ["refunded", "canceled", "cancelled", "failed",
  "payment_failed", "disputed", "reversed"];

function isCompletedOrder(o) {
  if (!o || typeof o !== "object") return false;
  if (o.livemode === false) return false;
  if (o.buyerId && o.sellerId && o.buyerId === o.sellerId) return false;
  const st = String(o.status || "").toLowerCase();
  const fs = String(o.fulfillmentStatus || "").toLowerCase();
  if (VOID_STATUSES.includes(st) || VOID_STATUSES.includes(fs)) return false;
  if (o.disputeStatus && String(o.disputeStatus).toLowerCase() !== "won") return false;
  return COMPLETED_STATUSES.includes(st) || COMPLETED_FULFILLMENT.includes(fs);
}

// ── Rule 5 (rewritten): link holds ───────────────────────────────────
/**
 * @param {object} p
 * @param {string[]} p.externalHosts     hosts that COUNT as links (detector
 *                                        countedHosts: scheme links + plain
 *                                        mentions promoted by TLD/flag/phrase)
 * @param {string[]} [p.allowlist]       resolveLinkAllowlist(config)
 * @param {string[]} p.scamPhrases       detectScamPhrases() result
 * @param {number}   p.accountAgeMs
 * @param {number}   p.trustAgeMs        config (default 168 h)
 * @param {boolean|null} p.hasCompletedTx null = not looked up (only needed
 *                                        when nothing else already holds)
 * @param {string[]} [p.highRiskTlds]
 * @return {{hold:boolean, reason:string|null, holdableHosts:string[]}}
 *   reason precedence: high_risk_tld_link > scam_phrase_with_link >
 *   new_account_external_link > no_transactions_external_link.
 */
function decideLinkHold({externalHosts, scamPhrases, accountAgeMs, trustAgeMs,
  hasCompletedTx, highRiskTlds, allowlist}) {
  const holdableHosts = (externalHosts || [])
      .filter((h) => !isAllowlistedHost(h, allowlist));
  if (!holdableHosts.length) return {hold: false, reason: null, holdableHosts};
  if (holdableHosts.some((h) => isHighRiskHost(h, highRiskTlds))) {
    return {hold: true, reason: "high_risk_tld_link", holdableHosts};
  }
  if (scamPhrases && scamPhrases.length) {
    return {hold: true, reason: "scam_phrase_with_link", holdableHosts};
  }
  if (!(accountAgeMs >= trustAgeMs)) {
    return {hold: true, reason: "new_account_external_link", holdableHosts};
  }
  // Fail closed: an unknown transaction history is treated as none.
  if (hasCompletedTx !== true) {
    return {hold: true, reason: "no_transactions_external_link", holdableHosts};
  }
  return {hold: false, reason: null, holdableHosts};
}

/** True when decideLinkHold needs the (costly) order lookup to decide. */
function needsTxLookup({externalHosts, scamPhrases, accountAgeMs, trustAgeMs, highRiskTlds,
  allowlist}) {
  const r = decideLinkHold({externalHosts, scamPhrases, accountAgeMs, trustAgeMs,
    hasCompletedTx: true, highRiskTlds, allowlist});
  // If it would hold even with a completed transaction, or there is nothing
  // holdable, the lookup can't change the answer.
  return !r.hold && r.holdableHosts.length > 0;
}

// ── Rule 6: new-account seller-burst cap ─────────────────────────────
/**
 * A sender younger than `ageWindowMs` may START conversations with at most
 * `limit` DIFFERENT sellers per rolling `windowMs`. "Starting" = the
 * conversation has no delivered message yet (no server-written
 * lastMessageSenderId) and the recipient is the conversation's seller.
 * Continuing a thread that already has a delivered message is never counted.
 * @param {object} p
 * @param {object} p.starts   users/{uid}.newSellerStarts {sellerUid: ts}
 * @return {{isStart:boolean, hold:boolean, freshSellers:string[],
 *           staleKeys:string[]}}
 */
function decideNewSellerStart({accountAgeMs, ageWindowMs, conv, senderId,
  recipientId, starts, now, windowMs, limit}) {
  const c = conv || {};
  const map = (starts && typeof starts === "object") ? starts : {};
  const freshSellers = [];
  const staleKeys = [];
  for (const [uid, ts] of Object.entries(map)) {
    const ms = tsToMillis(ts);
    if (ms > 0 && (now - ms) < windowMs) freshSellers.push(uid);
    else staleKeys.push(uid);
  }
  const recipientIsSeller = c.sellerId ? c.sellerId === recipientId : true;
  const senderIsBuyer = c.buyerId ? c.buyerId === senderId : true;
  const hasDelivered = !!c.lastMessageSenderId;
  const isNew = !(accountAgeMs >= ageWindowMs);
  const isStart = isNew && recipientIsSeller && senderIsBuyer && !hasDelivered;
  if (!isStart) return {isStart: false, hold: false, freshSellers, staleKeys};
  const already = freshSellers.includes(recipientId);
  const hold = !already && freshSellers.length >= limit;
  return {isStart, hold, freshSellers, staleKeys};
}

module.exports = {
  DEFAULT_LINK_ALLOWLIST,
  resolveLinkAllowlist,
  isAllowlistedHost,
  isFlaggedSender,
  SCAM_PHRASES,
  HIGH_RISK_TLDS,
  HOLD_EXEMPT_DOMAINS,
  HOLD_EXEMPT_HOSTS,
  detectScamPhrases,
  normalizeForPhrases,
  hostMatchesDomainList,
  isHoldExemptHost,
  isHighRiskHost,
  tsToMillis,
  resolveAccountCreatedMs,
  isCompletedOrder,
  decideLinkHold,
  needsTxLookup,
  decideNewSellerStart,
};
