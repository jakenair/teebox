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

/**
 * A listing's specs as one comparable string. Key order, empty values and the
 * shipping box size don't count; nor does the copy of the brand the Sell form
 * keeps in specs (the brand is compared on its own).
 */
function specsKey(l) {
  const t = (v) => String(v == null ? "" : v).trim();
  const s = l.specs && typeof l.specs === "object" ? l.specs : {};
  return JSON.stringify(Object.keys(s).sort()
      .filter((k) => k !== "shipBox" && t(s[k]) && !(k === "brand" && t(s[k]) === t(l.brand)))
      .map((k) => [k, t(s[k])]));
}

/**
 * What a seller's edit changed that an approval covered: photos, title,
 * brand, category, specs or condition. Empty unless the listing needs review
 * and is approved now. Price, description, quantity and photo ORDER don't
 * count. A field missing from `next` was not edited.
 * @param {object} cur listing before the edit
 * @param {{title: string, brand: string, photos: string[], cat: (string|undefined), specCategory: (string|undefined),
 *   specs: (object|undefined), condition: (string|undefined)}} next
 * @return {string[]}
 */
function reviewChanges(cur, next) {
  if (!needsAuthReview(cur) || cur.authReviewState !== "approved") return [];
  const t = (v) => String(v == null ? "" : v).trim();
  const set = (a) => JSON.stringify([...new Set((Array.isArray(a) ? a : []).map(String))].sort());
  const out = [];
  if (set(cur.photos) !== set(next.photos)) out.push("photos");
  if (t(cur.title) !== t(next.title)) out.push("title");
  if (t(cur.brand) !== t(next.brand)) out.push("brand");
  const changed = (k) => next[k] !== undefined && t(cur[k]) !== t(next[k]);
  if (changed("cat") || changed("specCategory")) out.push("category");
  if (next.specs !== undefined && specsKey(cur) !== specsKey(next)) out.push("specs");
  if (changed("condition")) out.push("condition");
  return out;
}

module.exports = {HIGH_VALUE_USD, needsAuthReview, authReviewPassed, planDecision, reviewChanges};
