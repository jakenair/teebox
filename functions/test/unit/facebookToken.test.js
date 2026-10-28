// Unit tests for lib/facebookToken — Limited Login OIDC verification with a local key.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jose = require("jose");
const {verifyFacebookIdToken, FB_APP_ID, FB_ISSUER} = require("../../lib/facebookToken");

let kp, jwks;
test.before(async () => {
  kp = await jose.generateKeyPair("RS256");
  const pub = await jose.exportJWK(kp.publicKey); pub.kid = "k1"; pub.alg = "RS256"; pub.use = "sig";
  jwks = jose.createLocalJWKSet({keys: [pub]});
});
const RAW = "abc-DEF_123.xyz";
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
async function mint(claims = {}, opts = {}) {
  return new jose.SignJWT({nonce: hex(RAW), email: "fb@example.com", name: "FB User", picture: "https://p/x.jpg", ...claims})
      .setProtectedHeader({alg: "RS256", kid: "k1"})
      .setIssuer(opts.iss || FB_ISSUER).setAudience(opts.aud || FB_APP_ID).setSubject(opts.sub || "10223")
      .setIssuedAt().setExpirationTime(opts.exp || "5m").sign(kp.privateKey);
}

test("valid Limited Login token → sub/email/name, emailVerified true", async () => {
  const r = await verifyFacebookIdToken({idToken: await mint(), rawNonce: RAW, jwks});
  assert.deepEqual(r, {sub: "10223", email: "fb@example.com", emailVerified: true, name: "FB User", picture: "https://p/x.jpg"});
});
test("token without email (phone-only / declined) → email null, emailVerified false", async () => {
  const r = await verifyFacebookIdToken({idToken: await mint({email: undefined}), rawNonce: RAW, jwks});
  assert.equal(r.email, null); assert.equal(r.emailVerified, false); assert.equal(r.sub, "10223");
});
test("base64url nonce form accepted", async () => {
  const b64 = crypto.createHash("sha256").update(RAW).digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const r = await verifyFacebookIdToken({idToken: await mint({nonce: b64}), rawNonce: RAW, jwks});
  assert.equal(r.sub, "10223");
});
test("nonce mismatch → rejected", async () => {
  await assert.rejects(verifyFacebookIdToken({idToken: await mint(), rawNonce: "other", jwks}), /nonce/i);
});
test("missing nonce claim → rejected", async () => {
  await assert.rejects(verifyFacebookIdToken({idToken: await mint({nonce: undefined}), rawNonce: RAW, jwks}), /nonce/i);
});
test("wrong audience (another Meta app) → rejected", async () => {
  await assert.rejects(verifyFacebookIdToken({idToken: await mint({}, {aud: "999"}), rawNonce: RAW, jwks}), /aud/i);
});
test("wrong issuer → rejected", async () => {
  await assert.rejects(verifyFacebookIdToken({idToken: await mint({}, {iss: "https://evil.example"}), rawNonce: RAW, jwks}), /iss/i);
});
test("expired → rejected", async () => {
  await assert.rejects(verifyFacebookIdToken({idToken: await mint({}, {exp: Math.floor(Date.now() / 1000) - 60}), rawNonce: RAW, jwks}), /exp|timestamp/i);
});
test("missing rawNonce → rejected before any network", async () => {
  await assert.rejects(verifyFacebookIdToken({idToken: "x.y.z", rawNonce: ""}), /rawNonce/);
});
