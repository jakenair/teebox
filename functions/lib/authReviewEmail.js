"use strict";
// The seller email for every authenticity-review change: approve, reject
// (decideAuthReview) and reopen (updateListing, after an edit to an approved
// listing). One template, one idempotency key per change.
const admin = require("firebase-admin");

/**
 * @param {{id: string, sellerId: string, title: string, status: string, decisionN: number}} listing
 * @param {"approve"|"reject"|"reopen"} decision
 * @param {string} reason
 * @return {Promise<boolean>} false when the seller has no email
 */
async function sendReviewEmail(listing, decision, reason) {
  const {resolveUserEmail} = require("./emailRecipient");
  const {email} = await resolveUserEmail(listing.sellerId, null, (u) => admin.auth().getUser(u));
  if (!email) return false;
  const Tpl = require("../emails-build/transactional/AuthReviewDecision");
  const ctx = {listingId: listing.id, title: listing.title || "your listing", decision, reason,
    live: listing.status === "active"};
  await require("./email").sendEmail({
    to: email,
    uid: listing.sellerId,
    subject: Tpl.subject(ctx),
    react: Tpl(ctx),
    category: "transactional",
    template: "AuthReviewDecision",
    idempotencyKey: `auth-review-${listing.id}-${decision}-${listing.decisionN}`,
  });
  return true;
}

module.exports = {sendReviewEmail};
