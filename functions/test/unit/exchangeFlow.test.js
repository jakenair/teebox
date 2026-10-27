// Compatibility gate for exchangeIdTokenForCustomToken (lib/exchangeFlow).
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../../lib/exchangeFlow");

function fakeAuth(seed = []) {
  const users = new Map(seed.map((u) => [u.uid, {providerData: [], emailVerified: false, ...u}]));
  const nf = () => Object.assign(new Error("not found"), {code: "auth/user-not-found"});
  return {
    users,
    async getUser(uid) { if (!users.has(uid)) throw nf(); return users.get(uid); },
    async getUserByEmail(email) { const u = [...users.values()].find((x) => (x.email || "").toLowerCase() === email.toLowerCase()); if (!u) throw nf(); return u; },
    async getUserByProviderUid(pid, sub) { const u = [...users.values()].find((x) => (x.providerData || []).some((p) => p.providerId === pid && p.uid === sub)); if (!u) throw nf(); return u; },
    async updateUser(uid, patch) { const u = users.get(uid); if (!u) throw nf(); if (patch.providerToLink) u.providerData = [...u.providerData, {providerId: patch.providerToLink.providerId, uid: patch.providerToLink.uid}]; return u; },
    async createUser(p) { const uid = "new_" + (users.size + 1); const u = {uid, providerData: [], ...p}; users.set(uid, u); return u; },
  };
}
const V = (sub, email) => ({sub, email, emailVerified: true});
const webGoogle = () => fakeAuth([{uid: "u1", email: "a@b.co", emailVerified: true, providerData: [{providerId: "google.com", uid: "g1"}]}]);

test("isLegacyClient: App Store builds (no intent) are legacy; Phase 2 clients send intent", () => {
  assert.equal(F.isLegacyClient({idToken: "x", providerId: "apple.com", rawNonce: "n"}), true);
  assert.equal(F.isLegacyClient(undefined), true);
  assert.equal(F.isLegacyClient({idToken: "x", providerId: "apple.com", intent: "signin"}), false);
});

test("legacy client + same email on another method → 409 already-exists with the pre-Phase-2 message", async () => {
  await assert.rejects(
      F.decideExchange({auth: webGoogle(), providerId: "apple.com", verified: V("s9", "a@b.co"), intent: "signin", legacyClient: true}),
      (e) => e.code === "already-exists" && e.httpErrorCode.status === 409 && e.message === F.LEGACY_ALREADY_EXISTS_MSG);
});

test("legacy client + new relay email → account created with apple.com linked (never a relay-choice body)", async () => {
  const auth = fakeAuth([]);
  const out = await F.decideExchange({auth, providerId: "apple.com", verified: V("s5", "zz@privaterelay.appleid.com"), intent: "signin", legacyClient: true});
  assert.ok(out.uid && !out.response);
  assert.ok(auth.users.get(out.uid).providerData.some((p) => p.providerId === "apple.com" && p.uid === "s5"));
});

test("Phase 2 client + same email on another method → needsLink body", async () => {
  const out = await F.decideExchange({auth: webGoogle(), providerId: "apple.com", verified: V("s9", "a@b.co"), intent: "signin", legacyClient: false});
  assert.deepEqual(out, {response: {needsLink: {email: "a@b.co", methods: ["google.com"], unverified: false}}});
});

test("Phase 2 client + new relay email → relayChoice body, then create on intent:create", async () => {
  const auth = fakeAuth([]);
  const v = V("s5", "zz@privaterelay.appleid.com");
  assert.deepEqual(await F.decideExchange({auth, providerId: "apple.com", verified: v, intent: "signin", legacyClient: false}), {response: {relayChoice: true}});
  const out = await F.decideExchange({auth, providerId: "apple.com", verified: v, intent: "create", legacyClient: false});
  assert.ok(out.uid);
});

test("identity owned by another account on link → 409 with the support-merge message (both protocols)", async () => {
  const auth = fakeAuth([{uid: "u1", email: "a@b.co", emailVerified: true}, {uid: "apple_com_s9", email: "r@privaterelay.appleid.com", emailVerified: true}]);
  await assert.rejects(
      F.decideExchange({auth, providerId: "apple.com", verified: V("s9", "r@privaterelay.appleid.com"), callerUid: "u1", intent: "link", legacyClient: false}),
      (e) => e.code === "already-exists" && e.message === F.OTHER_ACCOUNT_MSG);
});
