// functions/lib/securityEventDedup.js
// Pure idempotency decision for security-event emails. Extracted so it can
// be unit-tested without the emulator (see test/unit/securityEventDedup.test.js).
//
// Background: the client re-fires `email_verified` ~4.5s after EVERY app
// open for password accounts. The original guard deduped on a 60-SECOND
// window, so every session more than a minute apart sent another
// "your email is verified" email (376 to one account, 22 of 34 users hit).
// `email_verified` (and `account_deletion`) are ONCE-EVER events: if the
// user has ever been stamped, never send again. Repeatable events
// (password_changed, payout_method_changed) keep the short window, which
// only collapses accidental double-fires while still letting a genuine
// later change re-notify. `two_factor_code` is throttled elsewhere and is
// never hard-skipped here.

const ONCE_EVER_EVENTS = new Set(["email_verified", "account_deletion"]);
const DEFAULT_WINDOW_MS = 60 * 1000;

/**
 * Decide whether to skip sending a security-event email.
 * @param {object} args
 * @param {string} args.eventType   event name
 * @param {number|null} args.stampMillis  ms timestamp of the last send for
 *   this event+user, or null/0/NaN when never sent
 * @param {number} args.nowMillis   current time in ms
 * @param {number} [args.windowMs]  dedupe window for repeatable events
 * @return {{skip: boolean, reason: (string|null)}}
 */
function shouldSkipSecurityEvent({
  eventType,
  stampMillis,
  nowMillis,
  windowMs = DEFAULT_WINDOW_MS,
}) {
  // Codes are re-sent on demand; throttling lives in the callable.
  if (eventType === "two_factor_code") return {skip: false, reason: null};

  const hasStamp = Number.isFinite(stampMillis) && stampMillis > 0;

  if (ONCE_EVER_EVENTS.has(eventType)) {
    // Send exactly once, ever. Presence of the stamp is the whole test.
    return hasStamp ?
      {skip: true, reason: "already-sent"} :
      {skip: false, reason: null};
  }

  // Repeatable events: short window only collapses accidental double-fires.
  if (hasStamp && (nowMillis - stampMillis) < windowMs) {
    return {skip: true, reason: "duplicate"};
  }
  return {skip: false, reason: null};
}

module.exports = {ONCE_EVER_EVENTS, DEFAULT_WINDOW_MS, shouldSkipSecurityEvent};
