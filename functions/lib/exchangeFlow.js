// functions/lib/exchangeFlow.js
//
// Turns an account-linking decision into the exchangeIdTokenForCustomToken
// response, with a compatibility gate for the iOS builds already in the
// App Store (≤ 2.5.5 / build 118).
//
// Those builds call the function with a plain fetch and only understand
//   200 → {result:{customToken}}   (anything else on 200 → "Token exchange
//                                    returned no customToken" → generic error)
//   non-2xx → generic "Could not sign in with Apple" error
// and they never send `intent`. Phase 2 clients (web r367+, next iOS build)
// always send `intent` ("signin" | "create" | "link"), so its presence is the
// protocol version. Legacy callers keep the pre-Phase-2 behaviour:
//   • same email, other method → 409 already-exists (exactly as before)
//   • brand-new relay email     → create the account (as before, but with the
//                                 apple.com provider actually linked)
// instead of the {needsLink} / {relayChoice} bodies they cannot render.
// Remove the gate once every App Store build in use sends `intent`.

const {HttpsError} = require("firebase-functions/v2/https");
const accountLinking = require("./accountLinking");

const LEGACY_ALREADY_EXISTS_MSG =
  "This email is registered with a different sign-in method. " +
  "Sign in with that method first, then link this provider from settings.";
const OTHER_ACCOUNT_MSG =
  "That sign-in method is already its own TeeBox account. " +
  "Email support@teeboxmarket.com and we will merge them for you.";

/** Legacy = any caller that does not speak the Phase 2 protocol. */
function isLegacyClient(data) {
  return !(data && typeof data.intent === "string");
}

/**
 * @return {Promise<{response:object}|{uid:string}>} either a body to return
 *   as-is, or the uid to mint a custom token for. Throws HttpsError.
 */
async function decideExchange({auth, providerId, verified, callerUid, intent, legacyClient}) {
  const base = {auth, providerId, verified, callerUid};
  let d = await accountLinking.resolveFederatedSignIn({...base, intent});
  if (legacyClient) {
    if (d.mode === "needs-link") throw new HttpsError("already-exists", LEGACY_ALREADY_EXISTS_MSG);
    if (d.mode === "relay-choice") d = await accountLinking.resolveFederatedSignIn({...base, intent: "create"});
  }
  if (d.mode === "needs-link") {
    return {response: {needsLink: {email: d.email, methods: d.methods, unverified: d.unverified === true}}};
  }
  if (d.mode === "relay-choice") return {response: {relayChoice: true}};
  if (d.mode === "linked") return {response: {linked: true, uid: d.uid}};
  if (d.mode === "refused") {
    if (d.reason === "identity-belongs-to-other-account") throw new HttpsError("already-exists", OTHER_ACCOUNT_MSG);
    throw new HttpsError("failed-precondition", d.reason);
  }
  return {uid: d.uid};
}

module.exports = {isLegacyClient, decideExchange, LEGACY_ALREADY_EXISTS_MSG, OTHER_ACCOUNT_MSG};
