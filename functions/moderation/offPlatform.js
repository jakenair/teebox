// functions/moderation/offPlatform.js
//
// Off-platform / PII / external-link detector for chat messages. Moved out of
// index.js verbatim (2026-10-29) so it can be unit-tested without loading the
// whole functions bundle; index.js re-imports every symbol below. Behaviour
// is unchanged except for the 524178039.cfd blocklist seed.

const {logger} = require("firebase-functions");

const MOD_OFF_PLATFORM_REGEXES = [
  {name: "phone_us", severity: "HARD",
    re: /(?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/},
  {name: "email", severity: "HARD",
    re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/},
  {name: "messaging_url", severity: "HARD",
    re: /\b(?:wa\.me|t\.me|signal\.me|m\.me|bit\.ly|tinyurl\.com)\/\S+/i},
  {name: "external_marketplace", severity: "HARD",
    re: /\b(?:ebay|mercari|grailed|golfwrx|facebook ?marketplace|fb ?marketplace|craigslist|offerup|poshmark|depop)\b/i},
  {name: "cashtag", severity: "HARD",
    re: /(?:^|\s)\$[a-zA-Z][a-zA-Z0-9_]{2,15}\b/},
];
const MOD_OFF_PLATFORM_KEYWORDS_HARD = [
  "venmo", "zelle", "cashapp", "cash app", "paypal", "apple pay", "google pay", "gpay",
  "wire transfer", "western union", "moneygram", "chime",
  "btc", "bitcoin", "ethereum", "usdc", "crypto",
  "f&f", "friends and family", "f and f", "no g&s", "no goods and services",
  "text me at", "call me at", "signal me",
  "whatsapp", "telegram", "wa.me", "t.me",
  "outside teebox", "outside the app", "off the app", "off platform", "off-platform",
  "save the fee", "save fees", "skip the fee", "cut the fee", "no fees",
  "avoid the fee", "direct deal", "skip the platform", "pay outside", "cash only",
  "dm me directly", "take this off teebox", "take this off the app",
];
const MOD_OFF_PLATFORM_KEYWORDS_SOFT = [
  "instagram", "ig:", "insta:", "discord",
  "meet in person", "meet up", "come pick up", "local pickup",
];

// ── Known-bad domains ────────────────────────────────────────────────
// Hard blocklist. A message referencing any of these is BLOCKED outright
// (callable path) or QUARANTINED/deleted (trigger backstop) — not merely
// flagged. Seeded from the 2026-06-25 credential-phishing campaign
// ("payment didn't go through… confirm via link", s55.form76510.shop).
// Match is host-exact OR any subdomain (foo.form76510.shop). Admins can
// extend at runtime via config.messaging.knownBadDomains (string[]).
const MOD_KNOWN_BAD_DOMAINS = new Set([
  "form76510.shop",
  "tr.ee", // 2026-09-18 credential-phish campaign (tr.ee/teeboxmarket)
  // 2026-10-28 fake "payment did not go through" campaign
  // (https://s55.524178039.cfd/teeboxmarket). Subdomains match too.
  "524178039.cfd",
]);

// ── Generic external-URL detection (the durable fix) ─────────────────
// The off-platform regexes only knew a FIXED shortener list, so any novel
// domain (form76510.shop) sailed through with flagged:null. This extracts
// every external host (scheme optional, bare host.tld/path included) that
// is not teeboxmarket.com. The TLD set is broad but bounded so prose like
// "3.5 in." or "v1.2" doesn't read as a URL.
// Hostname shape only — the TLD is validated against the real IANA list
// (moderation/tlds.js) instead of a hand-written allowlist. The old
// allowlist omitted .ee, which is how the 2026-09-18 tr.ee phishing link
// reached four sellers completely undetected; it also omitted .ly, making
// bit.ly invisible. Capture groups: 1=scheme 2=host 3=tld 4=path.
const MOD_URL_SOURCE =
  "(?:(https?:\\/\\/)|\\b)((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+" +
  "([a-z]{2,24}))(\\/[^\\s)<>\"']*)?";

function modExtractExternalHosts(text) {
  const hosts = [];
  if (!text) return hosts;
  const {TLD_SET} = require("./tlds");
  const re = new RegExp(MOD_URL_SOURCE, "gi");
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const scheme = m[1];
    const host = m[2].toLowerCase().replace(/\.$/, "");
    const tld = m[3].toLowerCase();
    const path = m[4];
    // Must be a real TLD, otherwise "v1.2" / "10.5 shoes" read as hosts.
    if (!TLD_SET.has(tld)) continue;
    // Sentence run-on guard: "Great condition.Thanks" is prose, not a host.
    // A bare capitalised word with no scheme and no path is never a URL.
    if (!scheme && !path && /^[A-Z]/.test(m[3])) continue;
    if (/(^|\.)teeboxmarket\.com$/.test(host)) continue; // our own domain is fine
    if (hosts.indexOf(host) === -1) hosts.push(host);
  }
  return hosts;
}

// host matches a known-bad entry exactly, or is a subdomain of one.
function modHostIsKnownBad(host, extraDomains) {
  const check = (set) => {
    for (const bad of set) {
      if (host === bad || host.endsWith("." + bad)) return true;
    }
    return false;
  };
  if (check(MOD_KNOWN_BAD_DOMAINS)) return true;
  if (extraDomains && extraDomains.length && check(extraDomains)) return true;
  return false;
}

// ── 2026-10-30: link vs plain-text mention ──────────────────────────
// A "link" is a URL with an http(s) scheme. The chat UI renders message text
// escaped with NO auto-linking (js/app-main.js renderMessages), and neither
// WKWebView (dataDetectorTypes default none) nor Android WebView linkify page
// text, so a bare "titleist.com" is not clickable anywhere TeeBox renders it.
// Scheme URLs are parsed with WHATWG URL so userinfo tricks
// ("https://titleist.com@evil.top/") resolve to the host a browser would
// actually open, and IDN look-alikes come back as punycode (xn--…), which
// never matches an allowlist entry.
const MOD_SCHEME_URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function modClassifyHosts(text) {
  const linkHosts = [];
  const plainHosts = [];
  if (!text) return {linkHosts, plainHosts};
  const s = String(text);
  const own = (h) => /(^|\.)teeboxmarket\.com$/.test(h);
  let rest = s;
  const re = new RegExp(MOD_SCHEME_URL_RE.source, "gi");
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[0].replace(/[.,;:!?)\]}]+$/, "");
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    } catch (_e) {
      const hm = /^https?:\/\/([^/?#\s]+)/i.exec(raw);
      host = hm ? hm[1].toLowerCase().replace(/^.*@/, "").replace(/:\d+$/, "") : "";
    }
    if (host && !own(host) && linkHosts.indexOf(host) === -1) linkHosts.push(host);
    rest = rest.replace(m[0], " ");
  }
  for (const h of modExtractExternalHosts(rest)) {
    if (linkHosts.indexOf(h) === -1 && plainHosts.indexOf(h) === -1) plainHosts.push(h);
  }
  return {linkHosts, plainHosts};
}

function modEscapeKw(k) {
  return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// r173: lazy accessor for contentFilter's normalize — same pipeline the
// profanity scanner uses (NFKC → confusables → lowercase → leet fold).
function modNormalizeText(t) {
  return require("./contentFilter").normalize(t);
}

/**
 * @param {string} text
 * @param {string[]} [extraBadDomains] config.messaging.knownBadDomains
 * @param {object} [opts]
 * @param {string[]} [opts.allowlist]   link allowlist (domain + subdomains);
 *                                      default messageRisk.DEFAULT_LINK_ALLOWLIST
 * @param {boolean}  [opts.senderFlagged] messageRisk.isFlaggedSender(user)
 * @param {string[]} [opts.highRiskTlds]
 */
function modDetectOffPlatform(text, extraBadDomains, opts) {
  const o = opts || {};
  if (!text) {
    return {matched: false, severity: null, knownBad: false,
      externalHosts: [], linkHosts: [], plainHosts: [], countedHosts: [],
      allowlistedHosts: [], scamPhrases: [], types: [], patterns: []};
  }
  const s = String(text);
  const lc = s.toLowerCase();
  const patterns = [];
  const types = new Set();
  let severity = null;
  for (const p of MOD_OFF_PLATFORM_REGEXES) {
    const m = s.match(p.re);
    if (m) {
      patterns.push({type: "regex", name: p.name, match: m[0].slice(0, 80)});
      types.add(p.name);
      if (p.severity === "HARD") severity = "HARD";
      else if (!severity) severity = "SOFT";
    }
  }
  for (const kw of MOD_OFF_PLATFORM_KEYWORDS_HARD) {
    if (new RegExp("\\b" + modEscapeKw(kw) + "\\b", "i").test(lc)) {
      patterns.push({type: "keyword", name: kw, severity: "HARD"});
      types.add("kw:" + kw);
      severity = "HARD";
    }
  }
  if (severity !== "HARD") {
    for (const kw of MOD_OFF_PLATFORM_KEYWORDS_SOFT) {
      if (new RegExp("\\b" + modEscapeKw(kw) + "\\b", "i").test(lc)) {
        patterns.push({type: "keyword", name: kw, severity: "SOFT"});
        types.add("kw:" + kw);
        if (!severity) severity = "SOFT";
      }
    }
  }

  // ── r173: obfuscation folding ─────────────────────────────────────
  // The raw-text layers above miss trivially disguised contact info. Fold
  // the text through moderation/contentFilter's normalize() (NFKC →
  // confusables → lowercase → leet) plus three targeted folds, and rescan.
  // Consequence of a hit here matches the regular HARD path (interstitial /
  // hold rules) — these are detectors, not new penalties.
  try {
    const norm = modNormalizeText(s);
    // (a) Leet/confusable keyword pass — catches v3nmo, PayPa1, vеnmo
    // (Cyrillic е). Two variants because contentFilter's leet map folds
    // 1→i (right for slurs); payment brands need 1→l too.
    const normL = lc.replace(/[0134578$@!]/g,
        (ch) => ({"0": "o", "1": "l", "3": "e", "4": "a", "5": "s",
          "7": "t", "8": "b", "$": "s", "@": "a", "!": "i"}[ch] || ch));
    // (b) Separator-tolerant pass — catches "v e n m o", "pay pal",
    // "z-e-l-l-e". Boundary-anchored letters-with-separators regex (NOT a
    // squashed substring — that flagged "gazelle" for zelle). Scoped to
    // keywords whose letters run ≥5 to bound false positives.
    const SEP = "[\\s.\\-_*+/\\\\|·]*";
    for (const kw of MOD_OFF_PLATFORM_KEYWORDS_HARD) {
      const letters = kw.replace(/[^a-z0-9]/gi, "");
      if (letters.length < 5) continue; // btc/f&f/gpay too FP-prone separated
      let hit = false;
      for (const v of [norm, normL]) {
        if (new RegExp("\\b" + modEscapeKw(kw) + "\\b", "i").test(v)) { hit = true; break; }
        const sepRe = new RegExp(
            "\\b" + letters.split("").map((c) => modEscapeKw(c)).join(SEP) + "\\b", "i");
        if (sepRe.test(v)) { hit = true; break; }
      }
      if (hit && !types.has("kw:" + kw)) {
        patterns.push({type: "keyword", name: kw, severity: "HARD", obfuscated: true});
        types.add("kw:" + kw);
        types.add("obfuscated_keyword");
        severity = "HARD";
      }
    }
    // (b2) Social-handle mentions — SOFT (flag/log, no hard consequence):
    // "@mikegolf on insta", "IG: mikegolf". The bare-word insta/ig SOFT
    // keywords below can't match ":"-suffixed forms with \b.
    if (severity !== "HARD") {
      if (/(?:^|\s)@[a-z0-9_.]{3,30}\b/i.test(s) ||
          /\b(?:ig|insta)\s*[:\-]?\s*[a-z0-9_.]{3,30}\b/i.test(lc)) {
        patterns.push({type: "regex", name: "social_handle", severity: "SOFT"});
        types.add("social_handle");
        if (!severity) severity = "SOFT";
      }
    }
    // (c) Spelled-out phone numbers: "five one two five five five ...".
    const DIGIT_WORDS = {zero: "0", oh: "0", one: "1", two: "2", three: "3",
      four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9"};
    const digitFolded = lc.replace(
        /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,
        (w) => DIGIT_WORDS[w]);
    const digitRun = digitFolded.replace(/[^0-9]+/g, " ").split(" ")
        .filter(Boolean).join("");
    if (digitRun.length >= 10 && digitRun.length <= 13 &&
        /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/.test(lc)) {
      patterns.push({type: "regex", name: "phone_words", severity: "HARD",
        match: digitRun.slice(0, 20)});
      types.add("phone_words");
      severity = "HARD";
    }
    // (d) Spelled-out emails/domains: "mike at gmail dot com",
    // "mike[at]gmail[dot]com", "sketchy dot com".
    const SPELLED_EMAIL_RE =
      /\b[a-z0-9._%+\-]+\s*[([{]?\s*at\s*[)\]}]?\s*[a-z0-9\-]+\s*[([{]?\s*dot\s*[)\]}]?\s*[a-z]{2,10}\b/i;
    const SPELLED_DOMAIN_RE =
      /\b[a-z0-9\-]{3,}\s+dot\s+(?:com|net|org|io|co|me|app|shop|link|gg)\b/i;
    if (SPELLED_EMAIL_RE.test(lc)) {
      patterns.push({type: "regex", name: "spelled_email", severity: "HARD"});
      types.add("spelled_email");
      severity = "HARD";
    } else if (SPELLED_DOMAIN_RE.test(lc)) {
      patterns.push({type: "regex", name: "spelled_domain", severity: "HARD"});
      types.add("spelled_domain");
      severity = "HARD";
    }
  } catch (e) {
    // Folding layer is additive — a throw must never kill the base scan.
    logger.warn("modDetectOffPlatform obfuscation layer threw", e);
  }

  // Generic external-URL layer (the durable phishing fix), 2026-10-30 tuning:
  //   • allowlisted hosts (config linkAllowlist / DEFAULT_LINK_ALLOWLIST,
  //     domain + subdomains) never count — no card, no hold, no Rule 4 tick;
  //   • a scheme link to any other host is HARD (card; sendMessage decides hold);
  //   • a plain-text mention (no scheme — not clickable in TeeBox) is HARD only
  //     when it is on a high-risk TLD, known-bad, the sender is flagged
  //     (reviewFlag / offPlatformFlags > 0), or it sits next to a scam phrase;
  //     otherwise it is a SOFT "plain_domain" signal (logged, no card).
  // A known-bad host (any form) sets `knownBad` → callers BLOCK/QUARANTINE.
  const risk = require("./messageRisk");
  const allowlist = Array.isArray(o.allowlist) ? o.allowlist : risk.DEFAULT_LINK_ALLOWLIST;
  const scamPhrases = risk.detectScamPhrases(s);
  const {linkHosts, plainHosts} = modClassifyHosts(s);
  const externalHosts = modExtractExternalHosts(s);
  for (const h of [...linkHosts, ...plainHosts]) {
    if (externalHosts.indexOf(h) === -1) externalHosts.push(h);
  }
  let knownBad = false;
  for (const h of externalHosts) {
    if (modHostIsKnownBad(h, extraBadDomains)) knownBad = true;
  }
  const allowlistedHosts = [];
  const countedHosts = [];
  const plainUncounted = [];
  for (const h of linkHosts) {
    if (risk.isAllowlistedHost(h, allowlist)) allowlistedHosts.push(h);
    else countedHosts.push(h);
  }
  for (const h of plainHosts) {
    if (risk.isAllowlistedHost(h, allowlist)) { allowlistedHosts.push(h); continue; }
    if (risk.isHighRiskHost(h, o.highRiskTlds) || modHostIsKnownBad(h, extraBadDomains) ||
        o.senderFlagged === true || scamPhrases.length) {
      countedHosts.push(h);
    } else {
      plainUncounted.push(h);
    }
  }
  if (countedHosts.length || knownBad) {
    patterns.push({type: "url", name: knownBad ? "known_bad_domain" : "external_url",
      match: (countedHosts.length ? countedHosts : externalHosts)
          .slice(0, 3).join(",").slice(0, 80)});
    types.add("external_url");
    if (knownBad) types.add("known_bad_domain");
    severity = "HARD";
  } else if (plainUncounted.length) {
    patterns.push({type: "url", name: "plain_domain", severity: "SOFT",
      match: plainUncounted.slice(0, 3).join(",").slice(0, 80)});
    types.add("plain_domain");
    if (!severity) severity = "SOFT";
  }

  return {
    matched: patterns.length > 0,
    severity,
    knownBad,
    externalHosts,
    linkHosts,
    plainHosts,
    countedHosts,
    allowlistedHosts,
    scamPhrases,
    types: Array.from(types),
    patterns: patterns.slice(0, 12),
  };
}

module.exports = {
  MOD_OFF_PLATFORM_REGEXES,
  MOD_OFF_PLATFORM_KEYWORDS_HARD,
  MOD_OFF_PLATFORM_KEYWORDS_SOFT,
  MOD_KNOWN_BAD_DOMAINS,
  MOD_URL_SOURCE,
  MOD_SCHEME_URL_RE,
  modExtractExternalHosts,
  modClassifyHosts,
  modHostIsKnownBad,
  modDetectOffPlatform,
};
