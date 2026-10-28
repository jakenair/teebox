// functions/lib/facebookToken.js
//
// Verifies a Facebook *Limited Login* OIDC id token (iOS, 2.6.1+). The app never
// shows the App Tracking Transparency prompt, so the FB SDK can never hand us a
// classic access token on iOS 14.5+; the Capacitor plugin is therefore called
// with useLimitedLogin:true and returns an id token + the raw nonce it hashed
// into the request (sha256 hex, FacebookAuthProviderHandler.swift).
//
// Checks (RFC-style OIDC + Meta's docs): RS256 signature against Meta's JWKS,
// iss https://www.facebook.com, aud = our App ID, exp/iat, and the nonce claim
// must equal sha256(rawNonce) — hex (plugin) or base64url, same tolerance as
// the Apple verifier in index.js. Emails in a Facebook token are confirmed
// addresses, so emailVerified mirrors "email present".
const crypto = require("crypto");

const FB_ISSUER = "https://www.facebook.com";
const FB_JWKS_URL = "https://www.facebook.com/.well-known/oauth/openid/jwks/";
const FB_APP_ID = "1869309951087087";

class FacebookTokenError extends Error {
  constructor(message, code) { super(message); this.code = code || "invalid"; }
}

let _remoteJwks = null;
function remoteJwks(jose) {
  if (!_remoteJwks) _remoteJwks = jose.createRemoteJWKSet(new URL(FB_JWKS_URL));
  return _remoteJwks;
}

function nonceMatches(claim, rawNonce) {
  const h = crypto.createHash("sha256").update(String(rawNonce));
  const hex = crypto.createHash("sha256").update(String(rawNonce)).digest("hex");
  const b64 = h.digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return claim === hex || claim === b64;
}

/**
 * @param {object} p
 * @param {string} p.idToken   Facebook Limited Login id token (JWT)
 * @param {string} p.rawNonce  the un-hashed nonce the plugin generated
 * @param {object} [p.jwks]    jose key resolver (tests inject a local key); default = Meta's remote JWKS
 * @param {string} [p.appId]   audience (default FB_APP_ID)
 * @return {Promise<{sub:string,email:string|null,emailVerified:boolean,name:string|null,picture:string|null}>}
 */
async function verifyFacebookIdToken({idToken, rawNonce, jwks, appId}) {
  const jose = require("jose");
  if (!idToken || typeof idToken !== "string") throw new FacebookTokenError("idToken required", "invalid-argument");
  if (!rawNonce || typeof rawNonce !== "string") throw new FacebookTokenError("rawNonce required for Facebook sign-in", "invalid-argument");
  const {payload} = await jose.jwtVerify(idToken, jwks || remoteJwks(jose), {
    issuer: FB_ISSUER,
    audience: appId || FB_APP_ID,
    algorithms: ["RS256"],
  });
  if (!payload || !payload.sub) throw new FacebookTokenError("Facebook token has no sub");
  // Limited Login tokens always carry the nonce we supplied; refuse one without it
  // (a token minted for another flow) and refuse a mismatch (replay).
  if (!payload.nonce || !nonceMatches(String(payload.nonce), rawNonce)) {
    throw new FacebookTokenError("Facebook nonce mismatch", "nonce");
  }
  const email = payload.email ? String(payload.email).trim().toLowerCase() : null;
  return {
    sub: String(payload.sub),
    email,
    emailVerified: !!email,
    name: payload.name ? String(payload.name) : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}

module.exports = {verifyFacebookIdToken, FacebookTokenError, FB_APP_ID, FB_ISSUER, FB_JWKS_URL};
