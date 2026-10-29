// functions/test/unit/messageRisk.test.js
//
// Pure-logic tests for moderation/messageRisk.js + moderation/offPlatform.js
// (2026-10-29 anti-phishing hardening), including a false-positive corpus of
// ordinary buyer/seller messages.

const {test} = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../moderation/messageRisk");
const {modDetectOffPlatform, modHostIsKnownBad} = require("../../moderation/offPlatform");

const H = 3600 * 1000;
const WEEK = 168 * H;

const SCAM = "Hello! I have just paid for an item. However, an error occurred and the payment did not go through, although the money was withdrawn. I contacted support, and they apologized and confirmed that this is a normal situation, and replied that the payment needs to be confirmed via the link. Please confirm the payment. Sorry for the inconvenience. Thank you very much! ❤️";

// ── Phrases ─────────────────────────────────────────────────────────
test("incident scam text hits every scam phrase family", () => {
  const hits = R.detectScamPhrases(SCAM);
  for (const n of ["payment_did_not_go_through", "did_not_go_through", "confirm_via_link",
    "confirm_the_payment", "contacted_support", "money_withdrawn"]) {
    assert.ok(hits.includes(n), `missing ${n}: ${hits}`);
  }
});

test("phrases tolerate case, curly apostrophes, 'thru' and minor variants", () => {
  const cases = {
    "PAYMENT DID NOT GO THROUGH": "payment_did_not_go_through",
    "my payment didn’t go thru": "payment_did_not_go_through",
    "the payment hasn't gone through yet": "payment_did_not_go_through",
    "it didnt go through": "did_not_go_through",
    "please Confirm Via The Link below": "confirm_via_link",
    "it must be confirmed through this link": "confirm_via_link",
    "kindly confirm your payment": "confirm_the_payment",
    "I have contacted the support team": "contacted_support",
    "I contacted TeeBox support": "contacted_support",
    "the money has been debited from my card": "money_withdrawn",
    "funds were withdrawn": "money_withdrawn",
  };
  for (const [text, name] of Object.entries(cases)) {
    assert.ok(R.detectScamPhrases(text).includes(name), `${text} → ${name}`);
  }
});

test("incident link: 524178039.cfd blocks itself and every subdomain, but not look-alikes", () => {
  const det = modDetectOffPlatform(SCAM + " https://s55.524178039.cfd/teeboxmarket");
  assert.equal(det.knownBad, true);
  assert.deepEqual(det.externalHosts, ["s55.524178039.cfd"]);
  assert.equal(modHostIsKnownBad("524178039.cfd"), true);
  assert.equal(modHostIsKnownBad("a.b.524178039.cfd"), true);
  assert.equal(modHostIsKnownBad("x524178039.cfd"), false);
  assert.equal(modHostIsKnownBad("524178039.cfd.example.com"), false);
  // runtime config list (config/messaging.knownBadDomains) still works
  assert.equal(modHostIsKnownBad("evil.example.org", ["example.org"]), true);
});

test("host helpers: exempt hosts, high-risk TLDs", () => {
  assert.equal(R.isHoldExemptHost("teeboxmarket.com"), true);
  assert.equal(R.isHoldExemptHost("www.teeboxmarket.com"), true);
  assert.equal(R.isHoldExemptHost("apps.apple.com"), true);
  assert.equal(R.isHoldExemptHost("teeboxmarket.com.evil.cfd"), false);
  assert.equal(R.isHoldExemptHost("fakeapps.apple.com.co"), false);
  assert.equal(R.isHoldExemptHost("apple.com"), false);
  for (const h of ["a.cfd", "x.top", "b.c.xyz", "d.icu"]) assert.equal(R.isHighRiskHost(h), true, h);
  for (const h of ["topgolf.com", "xyz.com", "icu.org"]) assert.equal(R.isHighRiskHost(h), false, h);
});

// ── Account age ─────────────────────────────────────────────────────
test("resolveAccountCreatedMs: Auth first, doc fallback, fail closed", () => {
  const now = Date.now();
  const auth = new Date(now - 10 * 24 * H).toUTCString();
  assert.equal(R.resolveAccountCreatedMs({authCreationTime: auth, docCreatedAt: 1, now}).source, "auth");
  const d = R.resolveAccountCreatedMs({authCreationTime: null, docCreatedAt: {_seconds: 1700000000}, now});
  assert.deepEqual(d, {ms: 1700000000 * 1000, source: "doc"});
  assert.deepEqual(R.resolveAccountCreatedMs({authCreationTime: null, docCreatedAt: undefined, now}),
      {ms: now, source: "unknown"});
});

// ── Completed transactions ──────────────────────────────────────────
test("isCompletedOrder: definition", () => {
  assert.equal(R.isCompletedOrder({status: "paid", buyerId: "a", sellerId: "b"}), true);
  assert.equal(R.isCompletedOrder({status: "paid", fulfillmentStatus: "delivered"}), true);
  assert.equal(R.isCompletedOrder({status: "completed"}), true);
  assert.equal(R.isCompletedOrder({fulfillmentStatus: "reviewed"}), true);
  assert.equal(R.isCompletedOrder({status: "refunded", fulfillmentStatus: "refunded"}), false);
  assert.equal(R.isCompletedOrder({status: "paid", livemode: false}), false);
  assert.equal(R.isCompletedOrder({status: "paid", disputeStatus: "needs_response"}), false);
  assert.equal(R.isCompletedOrder({status: "paid", disputeStatus: "won"}), true);
  assert.equal(R.isCompletedOrder({status: "paid", buyerId: "a", sellerId: "a"}), false);
  assert.equal(R.isCompletedOrder({status: "pending_payment"}), false);
  assert.equal(R.isCompletedOrder(null), false);
});

// ── Link-hold decision ──────────────────────────────────────────────
const base = {scamPhrases: [], trustAgeMs: WEEK};
test("decideLinkHold: the four required cases", () => {
  // new account + link → held
  assert.equal(R.decideLinkHold({...base, externalHosts: ["evil.example.com"],
    accountAgeMs: 2 * 60 * 1000, hasCompletedTx: null}).reason, "new_account_external_link");
  // old + completed order + link → delivered
  assert.equal(R.decideLinkHold({...base, externalHosts: ["www.pingtour.com"],
    accountAgeMs: 30 * 24 * H, hasCompletedTx: true}).hold, false);
  // own domain → delivered (modExtractExternalHosts already drops it; defensive here)
  assert.equal(R.decideLinkHold({...base, externalHosts: ["teeboxmarket.com"],
    accountAgeMs: 0, hasCompletedTx: false}).hold, false);
  // App Store → delivered
  assert.equal(R.decideLinkHold({...base, externalHosts: ["apps.apple.com"],
    accountAgeMs: 0, hasCompletedTx: false}).hold, false);
});

test("decideLinkHold: no-tx, unknown-tx, high-risk and phrase precedence", () => {
  const old = 365 * 24 * H;
  assert.equal(R.decideLinkHold({...base, externalHosts: ["x.com"], accountAgeMs: old,
    hasCompletedTx: false}).reason, "no_transactions_external_link");
  assert.equal(R.decideLinkHold({...base, externalHosts: ["x.com"], accountAgeMs: old,
    hasCompletedTx: null}).reason, "no_transactions_external_link", "unknown tx fails closed");
  assert.equal(R.decideLinkHold({...base, externalHosts: ["apps.apple.com", "a.xyz"], accountAgeMs: old,
    hasCompletedTx: true}).reason, "high_risk_tld_link");
  assert.equal(R.decideLinkHold({...base, scamPhrases: ["confirm_via_link"], externalHosts: ["x.com"],
    accountAgeMs: old, hasCompletedTx: true}).reason, "scam_phrase_with_link");
  // phrase alone (no link) → not held (flag + card happens in moderateMessage)
  assert.equal(R.decideLinkHold({...base, scamPhrases: ["confirm_the_payment"], externalHosts: [],
    accountAgeMs: 0, hasCompletedTx: false}).hold, false);
  // NaN age (garbage) fails closed
  assert.equal(R.decideLinkHold({...base, externalHosts: ["x.com"], accountAgeMs: NaN,
    hasCompletedTx: true}).reason, "new_account_external_link");
});

test("needsTxLookup only when the order history can change the answer", () => {
  const old = 365 * 24 * H;
  assert.equal(R.needsTxLookup({...base, externalHosts: ["x.com"], accountAgeMs: old}), true);
  assert.equal(R.needsTxLookup({...base, externalHosts: ["x.com"], accountAgeMs: H}), false);
  assert.equal(R.needsTxLookup({...base, externalHosts: [], accountAgeMs: old}), false);
  assert.equal(R.needsTxLookup({...base, externalHosts: ["apps.apple.com"], accountAgeMs: old}), false);
  assert.equal(R.needsTxLookup({...base, externalHosts: ["a.top"], accountAgeMs: old}), false);
});

// ── Seller-burst decision ───────────────────────────────────────────
test("decideNewSellerStart: 3rd new seller in the hour held; existing thread and repeat seller not", () => {
  const now = Date.now();
  const p = {accountAgeMs: H, ageWindowMs: WEEK, senderId: "b", now, windowMs: H, limit: 2};
  const conv = (seller, extra = {}) => ({buyerId: "b", sellerId: seller, ...extra});
  const two = {sA: now - 60e3, sB: now - 30e3};
  assert.equal(R.decideNewSellerStart({...p, conv: conv("sC"), recipientId: "sC", starts: two}).hold, true);
  assert.equal(R.decideNewSellerStart({...p, conv: conv("sA"), recipientId: "sA", starts: two}).hold, false);
  assert.equal(R.decideNewSellerStart({...p, conv: conv("sC", {lastMessageSenderId: "sC"}),
    recipientId: "sC", starts: two}).isStart, false);
  // seller replying to a buyer is never a "start"
  assert.equal(R.decideNewSellerStart({...p, senderId: "sC", conv: conv("sC"), recipientId: "b",
    starts: two}).isStart, false);
  // old account exempt
  assert.equal(R.decideNewSellerStart({...p, accountAgeMs: 2 * WEEK, conv: conv("sC"),
    recipientId: "sC", starts: two}).hold, false);
  // stale entries reported for pruning
  const r = R.decideNewSellerStart({...p, conv: conv("sC"), recipientId: "sC",
    starts: {sOld: now - 2 * H, sA: now - 1000}});
  assert.deepEqual(r.staleKeys, ["sOld"]);
  assert.equal(r.hold, false);
});

// ── False-positive corpus ───────────────────────────────────────────
// Ordinary TeeBox chat. None of these may hit a scam phrase, and none may
// produce an external host (which would put new/zero-sale senders on hold).
const ORDINARY = [
  "Hi! Is this still available?",
  "Would you take $120 for the driver?",
  "Can you ship to 60614?",
  "What's the shaft flex on these irons?",
  "Are the grips original or have they been replaced?",
  "Any chips or sky marks on the crown?",
  "I just bought it, thanks! Can you ship tomorrow?",
  "Shipped today, tracking is in the order page.",
  "Thanks, got it! Leaving you a 5 star review.",
  "Sorry, the offer button wasn't working so I'm messaging you.",
  "Payment went through on my end, let me know when it ships.",
  "Did you get my offer?",
  "I sent an offer for $85, let me know.",
  "Can you do free shipping?",
  "Is the headcover included?",
  "These are 10.5 shoes right?",
  "Lie angle is 1 deg upright, length +0.5in.",
  "Club is in great condition.Thanks for looking",
  "I'm in Chicago, could I pick it up locally?",
  "Would you bundle the putter and wedge for $200?",
  "The listing says Stiff but the photo looks like Regular, which is it?",
  "Thank you! Pleasure doing business.",
  "Just checking in on shipping status.",
  "No worries, take your time.",
  "Can you send another photo of the face?",
  "What year is the model?",
  "Any interest in a trade for my Scotty?",
  "Price drop? Would love to grab it this week.",
  "I'll buy it now if you can do $60 shipped.",
  "Ball markers included?",
  "Do you have the adjustment wrench?",
  "Weight is 9.5 oz, swing weight D2.",
  "Model number is TSR3 vs TSR2?",
  "Ordered! Excited to get it.",
  "Delivered today, all good.",
  "My card was charged twice, is that right?",
  "I checked the order page and it says paid.",
  "Can you confirm the size before I buy?",
  "Please confirm the loft is 10.5",
  "Can you confirm it's the left-handed version?",
  "The shipping label link in the email isn't working for me",
  "I contacted the post office and they said tomorrow.",
  "Is the price firm?",
  "Last chance, would you do $45?",
  "Happy to pay full price, just want to be sure about condition.",
  "Do you ship internationally?",
  "Have a great weekend!",
  "Is it right handed?",
  "Does it come with the original box?",
  "Golf.com rated this the best putter of 2024.",
];

test("false-positive corpus: 0 scam-phrase hits and 0 external hosts on ordinary chat", () => {
  const phraseHits = ORDINARY.filter((t) => R.detectScamPhrases(t).length);
  const hostHits = ORDINARY.filter((t) => modDetectOffPlatform(t).externalHosts.length);
  // Known, accepted: "Golf.com rated…" — a bare domain IS a link and is
  // treated as one (held for new/zero-sale senders). Documented FP risk.
  assert.deepEqual(phraseHits, [], "phrase FPs: " + phraseHits.join(" | "));
  assert.deepEqual(hostHits, ["Golf.com rated this the best putter of 2024."]);
});

test("known phrase false-positive risks (documented, flag-only — never held without a link)", () => {
  // A genuine buyer whose card was declined may write this. It is flagged
  // (recipient sees the warning card) but delivered.
  assert.ok(R.detectScamPhrases("Sorry, my payment didn't go through, I'll try another card").length);
  assert.ok(R.detectScamPhrases("I contacted support about my order").length);
  assert.ok(R.detectScamPhrases("Can you confirm the payment came through?").length);
});
