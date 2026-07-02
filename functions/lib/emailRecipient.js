// functions/lib/emailRecipient.js
//
// Resolve a user's deliverable email address. The CANONICAL source is Firebase
// Auth. The users/{uid} Firestore doc does NOT carry an `email` field for real
// accounts — the doc-create whitelist excludes it, so email lives only in Auth.
//
// This is the exact bug that silently skipped EVERY real order email:
// onOrderCreatedEmail read `users/{uid}.email` (absent on real accounts) and the
// `if (email)` guard dropped the send with no error. lookupUser (message path)
// already resolved via admin.auth().getUser().email — this brings order emails
// onto the same, correct source.
//
// Pure + dependency-injected (authGetter) so it is unit-testable with node:test
// and can never silently regress: the smoke test and unit tests both drive the
// no-doc-email / auth-has-email shape through this function.

"use strict";

/**
 * @param {string} uid
 * @param {string|null|undefined} docEmail  email already loaded from the
 *   users/{uid} doc, if any (legacy/smoke fallback only).
 * @param {(uid:string)=>Promise<{email?:string}|null>} authGetter  e.g.
 *   (u) => admin.auth().getUser(u).
 * @returns {Promise<{email:(string|null), source:string}>}
 *   source ∈ 'auth' | 'doc-fallback' | 'no-uid' | 'unresolved'.
 *   email === null means NO deliverable address — callers MUST record/alert,
 *   never silently skip.
 */
async function resolveUserEmail(uid, docEmail, authGetter) {
  if (!uid) return {email: null, source: "no-uid"};
  try {
    const u = await authGetter(uid);
    if (u && u.email) return {email: u.email, source: "auth"};
  } catch (_e) {
    // auth/user-not-found or transient lookup failure → try the doc fallback.
  }
  if (docEmail) return {email: String(docEmail), source: "doc-fallback"};
  return {email: null, source: "unresolved"};
}

module.exports = {resolveUserEmail};
