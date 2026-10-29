// functions/test/unit/linkPolicy.test.js — 2026-10-30 anti-phishing friction
// tuning: link allowlist, link vs plain-text mention, flagged sender, the
// composed per-message decision, and the hold-alert/digest helpers.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../moderation/messageRisk");
const {modClassifyHosts, modDetectOffPlatform} = require("../../moderation/offPlatform");
const {decideMessageOutcome} = require("../../moderation/messageDecision");
const {requireFreshAdminAuth} = require("../../lib/adminGate");

const H = 3600 * 1000;
const NEW = {accountAgeMs: 1 * H, hasCompletedTx: false};
const TRUSTED = {accountAgeMs: 400 * 24 * H, hasCompletedTx: true};

test("allowlist: exact domain + any subdomain, never a suffix trick", () => {
  const ok = ["titleist.com", "www.titleist.com", "m.youtube.com", "youtu.be", "i.imgur.com",
    "www.instagram.com", "apps.apple.com", "teeboxmarket.com", "shop.pgatoursuperstore.com",
    "www.2ndswing.com", "TITLEIST.COM.", "golfgalaxy.com", "vokey.com", "footjoy.com"];
  for (const h of ok) assert.equal(R.isAllowlistedHost(h), true, h);
  const bad = ["titleist.com.evil.top", "evil-titleist.com", "titleistcom.net", "xtitleist.com",
    "youtube.com.co", "apple.com", "fakeapps.apple.com.co", "ping.com.ru", "notping.com",
    "instagram.com-login.xyz", "xn--titleist-xyz.com"];
  for (const h of bad) assert.equal(R.isAllowlistedHost(h), false, h);
});

test("allowlist covers every domain Jake listed", () => {
  for (const d of ["teeboxmarket.com", "apps.apple.com", "youtube.com", "youtu.be", "imgur.com",
    "instagram.com", "titleist.com", "callaway.com", "taylormadegolf.com", "ping.com",
    "cobragolf.com", "mizunogolf.com", "srixon.com", "scottycameron.com", "vokey.com",
    "footjoy.com", "golfgalaxy.com", "pgatoursuperstore.com", "2ndswing.com", "globalgolf.com"]) {
    assert.ok(R.DEFAULT_LINK_ALLOWLIST.includes(d), d);
  }
});

test("resolveLinkAllowlist: config override replaces default; junk ignored; own domain kept", () => {
  assert.deepEqual(R.resolveLinkAllowlist({}), R.DEFAULT_LINK_ALLOWLIST);
  assert.deepEqual(R.resolveLinkAllowlist({linkAllowlist: []}), R.DEFAULT_LINK_ALLOWLIST);
  assert.deepEqual(R.resolveLinkAllowlist({linkAllowlist: ["Foo.com", "", "nodot", 7]}),
      ["foo.com", "teeboxmarket.com"]);
});

test("classifier: scheme URL = link (real host via WHATWG URL); bare = plain", () => {
  assert.deepEqual(modClassifyHosts("see https://www.titleist.com/x and titleist.com"),
      {linkHosts: ["www.titleist.com"], plainHosts: ["titleist.com"]});
  assert.deepEqual(modClassifyHosts("https://titleist.com@evil-pay.com/x").linkHosts, ["evil-pay.com"]);
  assert.deepEqual(modClassifyHosts("HTTPS://Evil.Example.net/pay.").linkHosts, ["evil.example.net"]);
  assert.deepEqual(modClassifyHosts("http://192.168.4.20/pay").linkHosts, ["192.168.4.20"]);
  // IDN look-alike comes back as punycode → never allowlisted
  const idn = modClassifyHosts("https://tіtleist.com/x").linkHosts[0]; // Cyrillic і
  assert.ok(idn.startsWith("xn--"), idn);
  assert.equal(R.isAllowlistedHost(idn), false);
  assert.deepEqual(modClassifyHosts("https://teeboxmarket.com/l/1"), {linkHosts: [], plainHosts: []});
  assert.deepEqual(modClassifyHosts("Great condition.Thanks, 10.5 shoes v1.2"),
      {linkHosts: [], plainHosts: []});
});

test("isFlaggedSender: reviewFlag set or offPlatformFlags > 0", () => {
  assert.equal(R.isFlaggedSender({}), false);
  assert.equal(R.isFlaggedSender(null), false);
  assert.equal(R.isFlaggedSender({offPlatformFlags: 0, offPlatformSoftFlags: 9}), false);
  assert.equal(R.isFlaggedSender({offPlatformFlags: 1}), true);
  assert.equal(R.isFlaggedSender({reviewFlag: true}), true);
  assert.equal(R.isFlaggedSender({reviewFlag: {reason: "new_account_seller_burst"}}), true);
});

test("detector: allowlisted link adds no HARD; non-allowlisted link is HARD; plain is SOFT", () => {
  assert.equal(modDetectOffPlatform("specs https://www.titleist.com/gt2").matched, false);
  assert.equal(modDetectOffPlatform("specs https://www.pingtour.com/g430").severity, "HARD");
  const p = modDetectOffPlatform("cheaper at rockbottomgolf.com");
  assert.equal(p.severity, "SOFT");
  assert.deepEqual(p.countedHosts, []);
  const f = modDetectOffPlatform("cheaper at rockbottomgolf.com", [], {senderFlagged: true});
  assert.equal(f.severity, "HARD");
  assert.deepEqual(f.countedHosts, ["rockbottomgolf.com"]);
  // other HARD signals are untouched by the allowlist
  assert.equal(modDetectOffPlatform("venmo me, https://youtu.be/x").severity, "HARD");
});

test("phrases: alone → delivered + card; + non-allowlisted link → held; + allowlisted → card", () => {
  const phrase = "My payment didn't go through, please confirm the payment";
  for (const who of [NEW, TRUSTED]) {
    assert.equal(decideMessageOutcome({text: phrase, ...who}).decision, "delivered+card");
    const held = decideMessageOutcome({text: phrase + " https://secure-pay.example.net/x", ...who});
    assert.equal(held.decision, "held");
    assert.equal(held.reason, "scam_phrase_with_link");
    assert.equal(decideMessageOutcome({text: phrase + " https://youtu.be/x", ...who}).decision,
        "delivered+card");
  }
});

test("Jake's 10 legit messages: none held, none carded (new AND trusted)", () => {
  const legit = [
    "Here are the specs https://www.titleist.com/golf-clubs/drivers/gt2",
    "Great review of this putter on YouTube https://youtu.be/abc123",
    "check titleist.com for the specs",
    "Photos of the scuffs: https://imgur.com/a/xyz",
    "Is this still available? Can you do $60?",
    "Here's the Ping fitting chart https://ping.com/en-us/clubs/irons/i530",
    "Same model on pgatoursuperstore.com is $120 new",
    "Can you send more pics? Or a video on YouTube?",
  ];
  for (const t of legit) {
    for (const who of [NEW, TRUSTED]) {
      assert.equal(decideMessageOutcome({text: t, ...who}).decision, "delivered", t);
    }
  }
  // "payment didn't go through" is a scam phrase → card, never held
  const pay = decideMessageOutcome({text: "My payment didn't go through, I'll try another card", ...NEW});
  assert.equal(pay.decision, "delivered+card");
  // instagram link: allowlisted (the SOFT 'instagram' keyword is logged only)
  const ig = decideMessageOutcome({text: "Here's my instagram https://www.instagram.com/golfguy/", ...NEW});
  assert.equal(ig.decision, "delivered");
});

test("attacker cases", () => {
  const inc = "Hello! the payment did not go through, confirmed via the link https://s55.524178039.cfd/teeboxmarket";
  assert.equal(decideMessageOutcome({text: inc, ...TRUSTED}).decision, "blocked");
  const a2 = decideMessageOutcome({text: "confirm payment here https://titleist.com.evil.top/pay", ...TRUSTED});
  assert.deepEqual([a2.decision, a2.reason], ["held", "high_risk_tld_link"]);
  const a3 = decideMessageOutcome({text: "go to secure-pay.xyz", ...TRUSTED});
  assert.deepEqual([a3.decision, a3.reason], ["held", "high_risk_tld_link"]);
  // a different .cfd on another subdomain is still held by TLD
  assert.equal(decideMessageOutcome({text: "https://a.b.other.cfd/x", ...TRUSTED}).decision, "held");
});

test("trusted sender + non-allowlisted link → delivered + card (unchanged)", () => {
  const r = decideMessageOutcome({text: "specs https://www.pingtour.com/g430", ...TRUSTED});
  assert.deepEqual([r.decision, r.reason], ["delivered+card", "external_link"]);
  const n = decideMessageOutcome({text: "specs https://www.pingtour.com/g430", ...NEW});
  assert.deepEqual([n.decision, n.reason], ["held", "new_account_external_link"]);
});

test("requireFreshAdminAuth: ≤5 min passes, older/missing throws reauthRequired", () => {
  const now = 1_800_000_000;
  requireFreshAdminAuth({auth: {token: {auth_time: now - 60}}}, now);
  for (const t of [now - 301, undefined]) {
    assert.throws(() => requireFreshAdminAuth({auth: {token: {auth_time: t}}}, now),
        (e) => e.code === "failed-precondition" && e.details.reauthRequired === true);
  }
});
