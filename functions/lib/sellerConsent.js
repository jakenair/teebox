"use strict";
// Once-per-account seller consent (r428, founder ruling 2026-11-20).
// A seller confirms 18+ and the Seller Terms ONCE, in TeeBox, by their own
// hand. Both are stored server-side by requestSellerVerification:
//   sellerVerified (true), sellerAge18At (timestamp), sellerTermsVersion.
// Listing tools (CSV, API, browser extensions) never tick those boxes; a
// listing from a seller without both gets a clear "confirm in TeeBox" error.
// sellerAge18At / sellerVerified / sellerTermsVersion are not client-writable
// (firestore.rules users whitelist), so a tool can't fake them.

const SELLER_TERMS_VERSION = "2026-11-17";

// Sellers who agreed before versions were recorded (no sellerTermsVersion)
// count as agreeing to the version in force then; only a LATER bump of
// SELLER_TERMS_VERSION asks them again. Bump REQUIRE_FROM with it.
const REQUIRE_FROM = "2026-11-17";

const CONFIRM_MESSAGE =
  "Confirm you're 18 or older and agree to the Seller Terms in TeeBox first: " +
  "open teeboxmarket.com, tap Sell, and tick both boxes yourself. " +
  "Listing tools can't confirm for you.";

/** @return {{ok: boolean, missing: string[]}} */
function sellerConsentStatus(user) {
  const u = user || {};
  const missing = [];
  if (u.sellerVerified !== true) missing.push("seller_terms");
  if (!u.sellerAge18At) missing.push("age18");
  const v = typeof u.sellerTermsVersion === "string" ? u.sellerTermsVersion : "";
  if (u.sellerVerified === true && v && v < REQUIRE_FROM) missing.push("seller_terms_version");
  return {ok: missing.length === 0, missing};
}

module.exports = {SELLER_TERMS_VERSION, REQUIRE_FROM, CONFIRM_MESSAGE, sellerConsentStatus};
