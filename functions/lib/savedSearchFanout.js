"use strict";
// Saved-search fan-out for a newly created listing (moved out of
// index.js notifyOnSavedSearchMatch, 2026-11-16, so the QA exclusion is
// unit-testable with a fake Firestore).
//
// Writes users/{uid}/notifications docs (kind "saved-search-match") — the
// path pushNotificationDispatch turns into a push/email. A TEST listing
// (lib/testAccounts) writes NOTHING: QA listings must never reach real users.

const {isTestListing} = require("./testAccounts");

/**
 * @param {object} p
 * @param {object} p.db              Firestore (admin or fake)
 * @param {object} p.listing         listing data
 * @param {string} p.listingId
 * @param {function} p.matches       (listing, query) => boolean
 * @param {number} p.scanCap
 * @param {function} p.now           () => FieldValue.serverTimestamp() (or a Date in tests)
 * @param {object} p.testCtx         {db, auth, cache} for lib/testAccounts
 * @param {object} [p.log]           logger
 * @return {Promise<{matched: number, skipped?: string}>}
 */
async function savedSearchFanout(p) {
  const {db, listing, listingId, matches, scanCap, now, testCtx} = p;
  const log = p.log || {info() {}, warn() {}};
  if (!listing || listing.status !== "active") return {matched: 0, skipped: "not-active"};
  if (await isTestListing(listing, listingId, testCtx)) {
    log.info(`savedSearchFanout: ${listingId} is a TEST listing — no notifications`);
    return {matched: 0, skipped: "test-listing"};
  }
  const searchesSnap = await db.collection("savedSearches")
      .where("notifyOnNew", "==", true)
      .limit(scanCap + 1)
      .get();
  if (searchesSnap.size > scanCap) {
    log.warn(`notifyOnSavedSearchMatch: more than ${scanCap} saved searches with notifyOnNew=true; skipping listing ${listingId}`);
    return {matched: 0, skipped: "scan-cap"};
  }
  const listingTitle = listing.title || "a new listing";
  const listingPrice = Number.isFinite(Number(listing.ask)) ? Number(listing.ask) : null;
  const writes = [];
  searchesSnap.forEach((doc) => {
    const search = doc.data();
    const userId = search.userId;
    if (!userId) return;
    if (userId === listing.sellerId) return; // never self-notify the seller
    if (!matches(listing, search.query)) return;
    const notifRef = db.collection("users").doc(userId).collection("notifications").doc();
    writes.push(notifRef.set({
      userId,
      kind: "saved-search-match",
      listingId,
      listingTitle,
      listingPrice,
      searchId: doc.id,
      searchName: search.name || null,
      createdAt: now(),
      read: false,
    }));
  });
  await Promise.all(writes);
  return {matched: writes.length};
}

module.exports = {savedSearchFanout};
