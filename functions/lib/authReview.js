"use strict";
// High-value authenticity review (2026-11-23).
//
// A listing at $300+ is created with requiresAuth: true and
// authReviewState: "pending". Until now nothing ever moved it on. The states:
//   na        under $300, no review
//   pending   waiting for an admin
//   approved  an admin approved it (decideAuthReview)
//   rejected  an admin rejected it, with a reason
//
// The ask is checked as well as the flag: the client writes both fields when
// it creates a listing, so the flag alone could be left off.

const HIGH_VALUE_USD = 300;

/** @param {object} l listing @return {boolean} */
function needsAuthReview(l) {
  return !!l && (l.requiresAuth === true || l.authReviewState === "rejected" ||
    Number(l.ask) >= HIGH_VALUE_USD);
}

/** True when the listing may be advertised: no review needed, or approved. */
function authReviewPassed(l) {
  return !needsAuthReview(l) || l.authReviewState === "approved";
}

/** Statuses where a decision still means something. */
const DECIDABLE = new Set(["active", "hidden", "expired", "flagged"]);

/**
 * Pure: what a decision does to a listing, or why it can't be made.
 * A reject takes the listing down (status "removed", like an admin takedown);
 * a later approve puts back exactly the status it had.
 * @param {object} l listing
 * @param {"approve"|"reject"} decision
 * @param {string} reason
 * @return {{error: (string|undefined), noop: (boolean|undefined), update: (object|undefined)}}
 *   `update` values of undefined mean "delete the field".
 */
function planDecision(l, decision, reason) {
  if (decision !== "approve" && decision !== "reject") return {error: "decision must be approve or reject"};
  if (!needsAuthReview(l)) return {error: "This listing doesn't need an authenticity review."};
  if (decision === "reject" && !String(reason || "").trim()) return {error: "A reason is required to reject."};
  const target = decision === "approve" ? "approved" : "rejected";
  if (l.authReviewState === target) return {noop: true};
  // Never change a listing while a buyer is paying for it.
  if (l.status === "pending" || Number(l.quantityReserved || 0) > 0) {
    return {error: "A buyer is checking out right now. Try again in a few minutes."};
  }
  const takenDown = l.status === "removed" && l.authReviewState === "rejected";
  if (!DECIDABLE.has(l.status) && !takenDown) {
    return {error: `This listing is ${l.status}; there is nothing to decide.`};
  }
  if (decision === "reject") {
    return {update: {authReviewState: "rejected", authReviewReason: String(reason).trim().slice(0, 500),
      status: "removed", removedReason: "authenticity_review", authReviewPrevStatus: l.status}};
  }
  const update = {authReviewState: "approved", authReviewReason: undefined, authReviewPrevStatus: undefined};
  if (takenDown) {
    update.status = l.authReviewPrevStatus || "active";
    update.removedReason = undefined;
    update.removedAt = undefined;
  }
  return {update};
}

module.exports = {HIGH_VALUE_USD, needsAuthReview, authReviewPassed, planDecision};
