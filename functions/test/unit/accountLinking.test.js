// Unit tests for lib/accountLinking — the one-person-one-account rules.
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../lib/accountLinking");

// Minimal in-memory Admin Auth double.
function fakeAuth(seed = []) {
  const users = new Map(seed.map((u) => [u.uid, {providerData: [], emailVerified: false, ...u}]));
  const nf = () => Object.assign(new Error("not found"), {code: "auth/user-not-found"});
  const api = {
    calls: [],
    async getUser(uid) { if (!users.has(uid)) throw nf(); return users.get(uid); },
    async getUserByEmail(email) { const u = [...users.values()].find((x) => (x.email || "").toLowerCase() === email.toLowerCase()); if (!u) throw nf(); return u; },
    async getUserByProviderUid(providerId, sub) { const u = [...users.values()].find((x) => (x.providerData || []).some((p) => p.providerId === providerId && p.uid === sub)); if (!u) throw nf(); return u; },
    async updateUser(uid, patch) {
      api.calls.push(["updateUser", uid, patch]);
      const u = users.get(uid); if (!u) throw nf();
      if (patch.providerToLink) {
        const taken = [...users.values()].find((x) => x.uid !== uid && (x.providerData || []).some((p) => p.providerId === patch.providerToLink.providerId && p.uid === patch.providerToLink.uid));
        if (taken) throw Object.assign(new Error("The provider uid is already in use"), {code: "auth/provider-already-linked"});
        u.providerData = [...(u.providerData || []), {providerId: patch.providerToLink.providerId, uid: patch.providerToLink.uid}];
      }
      return u;
    },
    async createUser(p) { const uid = "new_" + (users.size + 1); const u = {uid, providerData: [], ...p}; users.set(uid, u); api.calls.push(["createUser", uid, p]); return u; },
    users,
  };
  return api;
}
const G = (sub, email, extra = {}) => ({sub, email, emailVerified: true, name: "T", ...extra});

test("returning user via real provider link → token for that uid", async () => {
  const auth = fakeAuth([{uid: "u1", email: "a@b.co", emailVerified: true, providerData: [{providerId: "google.com", uid: "g1"}]}]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "google.com", verified: G("g1", "a@b.co")});
  assert.deepEqual(r, {mode: "token", uid: "u1"});
});

test("legacy synthetic apple account → token + provider link healed", async () => {
  const auth = fakeAuth([{uid: "apple_com_s1", email: "x@privaterelay.appleid.com", emailVerified: true}]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "apple.com", verified: G("s1", "x@privaterelay.appleid.com")});
  assert.deepEqual(r, {mode: "token", uid: "apple_com_s1"});
  assert.ok(auth.users.get("apple_com_s1").providerData.some((p) => p.providerId === "apple.com" && p.uid === "s1"));
});

test("web-Google account, first iOS Apple sign-in with the same verified email → needs-link (NOT a new account, NOT refused)", async () => {
  const auth = fakeAuth([{uid: "u1", email: "a@b.co", emailVerified: true, providerData: [{providerId: "google.com", uid: "g1"}]}]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "apple.com", verified: G("s9", "a@b.co")});
  assert.equal(r.mode, "needs-link"); assert.equal(r.email, "a@b.co"); assert.deepEqual(r.methods, ["google.com"]); assert.equal(r.unverified, false);
  assert.equal(auth.calls.filter((c) => c[0] === "createUser").length, 0);
});

test("existing password account with UNVERIFIED email → needs-link flagged unverified (no auto-link)", async () => {
  const auth = fakeAuth([{uid: "u2", email: "p@b.co", emailVerified: false, providerData: [{providerId: "password", uid: "p@b.co"}]}]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "google.com", verified: G("g2", "p@b.co")});
  assert.equal(r.mode, "needs-link"); assert.equal(r.unverified, true); assert.deepEqual(r.methods, ["password"]);
});

test("link intent: signed-in user attaches a new provider to their own account", async () => {
  const auth = fakeAuth([{uid: "u1", email: "a@b.co", emailVerified: true, providerData: [{providerId: "google.com", uid: "g1"}]}]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "apple.com", verified: G("s9", "hidden@privaterelay.appleid.com"), callerUid: "u1", intent: "link"});
  assert.deepEqual(r, {mode: "linked", uid: "u1"});
  assert.ok(auth.users.get("u1").providerData.some((p) => p.providerId === "apple.com"));
});

test("link intent: identity already owned by ANOTHER account → refused (no silent merge)", async () => {
  const auth = fakeAuth([{uid: "u1", email: "a@b.co", emailVerified: true}, {uid: "apple_com_s9", email: "r@privaterelay.appleid.com", emailVerified: true}]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "apple.com", verified: G("s9", "r@privaterelay.appleid.com"), callerUid: "u1", intent: "link"});
  assert.deepEqual(r, {mode: "refused", reason: "identity-belongs-to-other-account"});
});

test("link intent without a signed-in caller → refused", async () => {
  const auth = fakeAuth([]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "google.com", verified: G("g1", "a@b.co"), intent: "link"});
  assert.equal(r.reason, "link-requires-sign-in");
});

test("brand-new relay-email Apple sign-in → relay-choice first; create only on explicit intent", async () => {
  const auth = fakeAuth([]);
  const v = G("s5", "zz@privaterelay.appleid.com");
  assert.deepEqual(await L.resolveFederatedSignIn({auth, providerId: "apple.com", verified: v}), {mode: "relay-choice"});
  const r = await L.resolveFederatedSignIn({auth, providerId: "apple.com", verified: v, intent: "create"});
  assert.equal(r.mode, "token"); assert.ok(auth.users.get(r.uid).providerData.some((p) => p.providerId === "apple.com"));
});

test("brand-new real-email sign-in → account created WITH the provider linked", async () => {
  const auth = fakeAuth([]);
  const r = await L.resolveFederatedSignIn({auth, providerId: "google.com", verified: G("g7", "new@b.co")});
  assert.equal(r.mode, "token");
  const u = auth.users.get(r.uid); assert.equal(u.email, "new@b.co"); assert.equal(u.emailVerified, true);
  assert.ok(u.providerData.some((p) => p.providerId === "google.com" && p.uid === "g7"));
});

test("helpers: syntheticUid / isRelayEmail / methodsOf", () => {
  assert.equal(L.syntheticUid("apple.com", "abc"), "apple_com_abc");
  assert.equal(L.isRelayEmail("x@privaterelay.appleid.com"), true);
  assert.equal(L.isRelayEmail("x@gmail.com"), false);
  assert.deepEqual(L.methodsOf({uid: "apple_com_1", providerData: []}), ["apple.com"]);
  assert.deepEqual(L.methodsOf({uid: "u", providerData: [{providerId: "password"}, {providerId: "google.com"}]}), ["password", "google.com"]);
});
