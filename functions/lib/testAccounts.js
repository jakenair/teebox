"use strict";
// ONE shared "is this QA?" check (founder, 2026-11-16).
//
// Test accounts and test listings must never fan out to real people, ad
// platforms or public pages: saved-search matches, price drops, pushes,
// lifecycle emails, the Meta/TikTok catalog feed, CAPI events, the sitemap
// and the static listing pages all call through here. Found because one
// real customer's saved search ("clubs") had received 29 in-app alerts for
// money-gate and QA listings since September.
//
// A user is TEST when ANY of:
//   - users/{uid}.isTestAccount === true   (smoke.mjs, money-gate, QA scripts set it)
//   - the Auth email is a QA address        (@teeboxqa.dev, @teeboxtest.invalid,
//                                            jakenair+qa…@teeboxmarket.com)
//   - the uid is a fixed QA uid             (mg_*, qa_*, pwbuyer_*)
// A listing is TEST when ANY of:
//   - listing.isTest === true or listing.isTestListing === true
//   - the listing id is a fixed QA id       (mg_*, qa_*)
//   - its seller is a TEST user
//
// The async helpers cache per call-context (pass the same `cache` Map for a
// whole batch) and FAIL OPEN on lookup errors for real traffic: a transient
// Auth/Firestore error must never stop a real seller's listing from reaching
// buyers. Pure helpers are exported for tests.

const TEST_EMAIL_RE = /(@(teeboxqa\.dev|teeboxtest\.invalid)$)|(^jakenair\+qa[^@]*@teeboxmarket\.com$)/i;
const TEST_UID_RE = /^(mg_|qa_|pwbuyer_)/;
const TEST_LISTING_ID_RE = /^(mg_|qa_)/;

function isTestEmail(email) {
  return TEST_EMAIL_RE.test(String(email || "").trim());
}
function isTestUserDoc(doc) {
  return !!(doc && doc.isTestAccount === true);
}
/** Pure: listing-level flags only (no seller lookup). */
function isTestListingDoc(listing, listingId) {
  const l = listing || {};
  if (l.isTest === true || l.isTestListing === true) return true;
  if (listingId && TEST_LISTING_ID_RE.test(String(listingId))) return true;
  if (l.sellerId && TEST_UID_RE.test(String(l.sellerId))) return true;
  return false;
}

/**
 * @param {string} uid
 * @param {{db: object, auth: object, cache?: Map}} ctx
 * @return {Promise<boolean>}
 */
async function isTestUid(uid, ctx) {
  if (!uid) return false;
  const id = String(uid);
  if (TEST_UID_RE.test(id)) return true;
  const cache = ctx.cache;
  if (cache && cache.has("u:" + id)) return cache.get("u:" + id);
  let test = false;
  try {
    const snap = await ctx.db.collection("users").doc(id).get();
    if (snap.exists && isTestUserDoc(snap.data())) test = true;
  } catch (_e) { /* fail open */ }
  if (!test && ctx.auth) {
    try {
      const u = await ctx.auth.getUser(id);
      if (u && isTestEmail(u.email)) test = true;
    } catch (_e) { /* user-not-found / transient: fail open */ }
  }
  if (cache) cache.set("u:" + id, test);
  return test;
}

/**
 * @param {object} listing listing data (needs sellerId for the seller check)
 * @param {string} listingId
 * @param {{db: object, auth: object, cache?: Map}} ctx
 * @return {Promise<boolean>}
 */
async function isTestListing(listing, listingId, ctx) {
  if (isTestListingDoc(listing, listingId)) return true;
  return isTestUid(listing && listing.sellerId, ctx);
}

/** Load a listing by id and classify it; a missing listing is NOT test. */
async function isTestListingId(listingId, ctx) {
  if (!listingId) return false;
  if (TEST_LISTING_ID_RE.test(String(listingId))) return true;
  try {
    const snap = await ctx.db.collection("listings").doc(String(listingId)).get();
    if (!snap.exists) return false;
    return isTestListing(snap.data(), String(listingId), ctx);
  } catch (_e) {
    return false;
  }
}

/**
 * Batch helper for feeds / sitemaps / page generators: every TEST uid we can
 * identify up front (flagged users docs + QA Auth emails).
 * @param {{db: object, auth: object}} ctx
 * @return {Promise<Set<string>>}
 */
async function loadTestUids(ctx) {
  const out = new Set();
  const flagged = await ctx.db.collection("users").where("isTestAccount", "==", true).select().get();
  flagged.docs.forEach((d) => out.add(d.id));
  if (ctx.auth) {
    let token;
    do {
      const page = await ctx.auth.listUsers(1000, token);
      page.users.forEach((u) => { if (isTestEmail(u.email) || TEST_UID_RE.test(u.uid)) out.add(u.uid); });
      token = page.pageToken;
    } while (token);
  }
  return out;
}

/** Default ctx from firebase-admin (lazy so pure tests never load it). */
function adminCtx(cache) {
  const admin = require("firebase-admin");
  return {db: admin.firestore(), auth: admin.auth(), cache: cache || new Map()};
}

module.exports = {
  TEST_EMAIL_RE, TEST_UID_RE, TEST_LISTING_ID_RE,
  isTestEmail, isTestUserDoc, isTestListingDoc,
  isTestUid, isTestListing, isTestListingId, loadTestUids, adminCtx,
};
