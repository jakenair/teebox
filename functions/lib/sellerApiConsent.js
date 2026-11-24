"use strict";
// What a seller agrees to when they connect a listing tool, and the record of
// it (2026-11-23). The screen shows exactly this text; the version and the
// text's hash are stored with every grant, so a later wording change can't
// rewrite what was agreed. Change the text and the version together.
//
// apiConsents/{autoId} is append-only and server-only (rules default deny):
//   {event: "granted"|"revoked", uid, partnerId, partnerName, connectionId,
//    method, surface, consentVersion, consentHash, at}
const crypto = require("node:crypto");

const CONSENT = {
  version: "2026-11-23",
  allows: [
    "Create listings on TeeBox for you",
    "Edit and end your listings",
    "See your listings and whether they have sold",
  ],
  never: [
    "See your orders, buyers, messages, payouts or bank details",
    "Take or refund payments",
    "Agree to TeeBox's terms for you",
  ],
};
CONSENT.hash = crypto.createHash("sha256")
    .update(JSON.stringify([CONSENT.version, CONSENT.allows, CONSENT.never])).digest("hex").slice(0, 32);

const SURFACES = ["web", "ios", "android", "admin_script"];

/**
 * @param {object} c {accepted, version, surface} from the caller
 * @param {string} method how it was given, e.g. "connected_tools_screen"
 * @return {object} the fields to store, or throws Error("consent_required")
 */
function checkConsent(c, method) {
  if (!c || c.accepted !== true || c.version !== CONSENT.version) throw new Error("consent_required");
  return {method: String(method || "unknown").slice(0, 40), surface: SURFACES.includes(c.surface) ? c.surface : "web",
    consentVersion: CONSENT.version, consentHash: CONSENT.hash};
}

module.exports = {CONSENT, checkConsent};
