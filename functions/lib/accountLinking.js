// functions/lib/accountLinking.js
//
// One person = one TeeBox account, whatever the sign-in provider (Phase 2,
// 2026-10-26). Pure decision logic over an injected Firebase Admin Auth
// client so it can be unit-tested without a project.
//
// Background: the native (Capacitor) sign-in path never used Firebase's own
// provider linking. exchangeIdTokenForCustomToken verified the Google/Apple
// id token itself, then `_findOrCreateUser` either (a) refused when the email
// already belonged to an account with a different provider (the web-Google →
// iOS lockout), or (b) created a "synthetic" account `apple_com_<sub>` with
// NO providerData. 154 such accounts exist; 89 of them carry an Apple relay
// address, which can never match the owner's web account by email.
//
// Rules implemented here (Jake, 2026-10-26):
//   • Auto-link only on a VERIFIED email on both sides. Never merge on an
//     unverified email.
//   • A provider identity that already belongs to a different account is
//     never silently merged (that would be a data migration) — refused.
//   • A signed-in user may always attach a new provider to their own
//     account (explicit action from Account → Connected sign-in methods);
//     that is how relay-email Apple users connect without a duplicate.
//   • A relay-email sign-in with no matching account asks the user first
//     (create new vs. "I already have an account") instead of silently
//     creating a second account.

const RELAY_RE = /@privaterelay\.appleid\.com$/i;

/** @return {string} the legacy synthetic uid for a provider identity */
function syntheticUid(providerId, sub) {
  return `${String(providerId).replace(".", "_")}_${sub}`.slice(0, 128);
}

function isRelayEmail(email) {
  return RELAY_RE.test(String(email || ""));
}

/** Methods a user can sign in with on an existing account, for the prompt. */
function methodsOf(userRecord) {
  const out = new Set();
  for (const p of (userRecord.providerData || [])) if (p && p.providerId) out.add(p.providerId);
  // Legacy synthetic accounts have no providerData; infer from the uid.
  const m = /^(google_com|apple_com)_/.exec(userRecord.uid || "");
  if (m) out.add(m[1].replace("_", "."));
  if (!out.size && userRecord.passwordHash) out.add("password");
  return [...out];
}

async function getUserOrNull(auth, fn) {
  try { return await fn(); } catch (e) {
    if (e && e.code === "auth/user-not-found") return null;
    throw e;
  }
}

/**
 * Find the account that already owns this provider identity, if any:
 * a real provider link (getUserByProviderUid) or a legacy synthetic uid.
 */
async function findIdentityOwner(auth, providerId, sub) {
  const byLink = await getUserOrNull(auth, () => auth.getUserByProviderUid(providerId, sub));
  if (byLink) return byLink;
  return getUserOrNull(auth, () => auth.getUser(syntheticUid(providerId, sub)));
}

/** Attach the provider to uid (idempotent: already-linked is fine). */
async function linkProvider(auth, uid, providerId, verified) {
  const providerToLink = {providerId, uid: String(verified.sub)};
  if (verified.email) providerToLink.email = verified.email;
  if (verified.name) providerToLink.displayName = verified.name;
  try {
    await auth.updateUser(uid, {providerToLink});
    return true;
  } catch (e) {
    // Already linked to this very account → fine. Linked elsewhere → caller
    // already checked findIdentityOwner, so surface anything else.
    if (e && /already|exists/i.test(String(e.message || e.code))) return false;
    throw e;
  }
}

/**
 * Decide what a federated (Google/Apple) sign-in should do.
 *
 * @param {object} p
 * @param {object} p.auth        firebase-admin Auth (getUser, getUserByEmail, getUserByProviderUid, updateUser, createUser)
 * @param {string} p.providerId  "google.com" | "apple.com"
 * @param {object} p.verified    {sub, email, emailVerified, name} from the verified id token
 * @param {string} [p.callerUid] signed-in uid when intent === "link"
 * @param {string} [p.intent]    "signin" (default) | "create" | "link"
 * @return {Promise<object>} one of
 *   {mode:"token", uid}                       → mint a custom token for uid
 *   {mode:"linked", uid}                      → provider attached to callerUid
 *   {mode:"needs-link", email, methods, unverified} → client must sign in with an existing method first
 *   {mode:"relay-choice"}                     → ask: create new account or sign in to an existing one
 *   {mode:"refused", reason}                  → identity belongs to another account / bad request
 */
async function resolveFederatedSignIn({auth, providerId, verified, callerUid, intent}) {
  const mode = intent || "signin";
  const sub = String(verified.sub || "");
  if (!sub) return {mode: "refused", reason: "no-subject"};
  const email = verified.email ? String(verified.email).trim().toLowerCase() : "";
  const owner = await findIdentityOwner(auth, providerId, sub);

  if (mode === "link") {
    if (!callerUid) return {mode: "refused", reason: "link-requires-sign-in"};
    if (owner && owner.uid !== callerUid) {
      return {mode: "refused", reason: "identity-belongs-to-other-account"};
    }
    if (!owner) await linkProvider(auth, callerUid, providerId, verified);
    return {mode: "linked", uid: callerUid};
  }

  // Returning user: identity already attached (or legacy synthetic uid).
  if (owner) {
    // Heal legacy synthetic accounts: give them a real provider link so the
    // Firebase SDK sees apple.com/google.com in providerData from now on.
    if (!(owner.providerData || []).some((p) => p.providerId === providerId)) {
      try { await linkProvider(auth, owner.uid, providerId, verified); } catch (_e) { /* non-fatal */ }
    }
    return {mode: "token", uid: owner.uid};
  }

  // New identity. Does the email already belong to someone?
  if (email) {
    const existing = await getUserOrNull(auth, () => auth.getUserByEmail(email));
    if (existing) {
      const bothVerified = verified.emailVerified === true && existing.emailVerified === true;
      return {
        mode: "needs-link",
        email,
        methods: methodsOf(existing),
        // Auto-link is allowed only when both sides are verified; otherwise the
        // client tells the user to sign in with the existing method and verify
        // (linking stays available from Account settings afterwards).
        unverified: !bothVerified,
      };
    }
  }

  // Nobody owns the identity or the email. A relay address can't be matched to
  // an existing account, so ask before creating a second one — unless the
  // client already asked and the user chose "create".
  if (isRelayEmail(email) && mode !== "create") return {mode: "relay-choice"};

  const created = await auth.createUser({
    email: email || undefined,
    emailVerified: verified.emailVerified === true,
    displayName: verified.name || undefined,
  });
  try { await linkProvider(auth, created.uid, providerId, verified); } catch (_e) { /* non-fatal */ }
  return {mode: "token", uid: created.uid};
}

module.exports = {
  resolveFederatedSignIn,
  syntheticUid,
  isRelayEmail,
  methodsOf,
  findIdentityOwner,
  linkProvider,
};
