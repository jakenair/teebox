# Ban-Evasion Roadmap

**Owner**: Jake Nair
**Status**: V1 shipped pre-launch (2026-05-15)
**Tracking-ref**: LAUNCH_READINESS.md CRITICAL #8

## Why this exists

Pre-V1, the only ban defense in TeeBox was a `users/{uid}.banned == true`
check inside `createPaymentIntent`. A user banned for fraud, harassment,
or shill-bidding could create a fresh account in 30 seconds and walk
right back in — same IP, same card, same device. The audit flagged
this as a launch blocker.

## What V1 ships (this PR)

V1 captures two signals and cross-references them against banned users:

| Signal             | When captured                 | Reliability |
|--------------------|-------------------------------|-------------|
| Client IP          | pre-charge (createPaymentIntent) | low         |
| Stripe card fingerprint | post-charge (handlePaymentSucceeded webhook) | high        |

- **IP check is pre-charge, blocking.** If the incoming IP matches a
  prior signal owned by a banned user, the new account is banned and
  the checkout is rejected with HTTP 403 before Stripe is even called.
- **Card-fingerprint check is post-charge, retroactive.** Stripe doesn't
  expose the card fingerprint until the charge actually settles. If the
  fingerprint matches a banned user, the new account is banned, the
  order is flagged with `fraudFlag: "ban-evasion-card-match"`, and
  support is expected to refund via the existing refund flow.

Helper: `functions/banEvasion.js`. Storage: `fraudSignals/{uid}_{YYYY-MM-DD-HH}`
(hour-bucketed merge writes — one doc per uid per active hour).

### V1 limitations (known + accepted)

1. **IP false positives.** Corporate / college / hotel wifi, mobile
   carrier NATs, and VPNs all share IPs across thousands of users.
   We are explicitly accepting these false positives: the alternative
   is letting banned users walk in. If complaint volume becomes a
   problem, dial down the IP check (e.g. require *two* matching signals
   before banning) or move the IP check to "flag for admin review" mode
   instead of auto-ban.
2. **No coverage for non-card payment methods.** Apple Pay / Google Pay
   that resolve to a card *do* surface the card fingerprint, but bank-
   debit / ACH / wallet-only flows do not. ACH isn't enabled in V1, so
   this is theoretical for now.
3. **Fingerprint capture is best-effort.** Every helper in
   `banEvasion.js` fails open on Firestore errors. Real ban defense
   remains the direct `users/{uid}.banned` check inside
   `createPaymentIntent`; this module is defense-in-depth.
4. **No required Firestore indexes yet.** The single-field queries
   `fraudSignals.ip == X` and `fraudSignals.cardFingerprint == X` ride
   on Firestore's auto-single-field indexes. Add to
   `firestore.indexes.json` if/when volume justifies composite indexes
   (e.g. ip + sampledAt for admin-tool scans).

## What Phase 2 should add

In rough priority order:

1. **Client-side device fingerprint (FingerprintJS or open-source equiv).**
   This is the single highest-leverage Phase-2 add. A device fingerprint
   survives clearing cookies, changing networks, even (mostly) using
   incognito mode. The current V1 stack (IP + card) is bypassable by a
   determined attacker who uses a VPN and a fresh prepaid Visa.
   - Implementation sketch: load fingerprintjs on the listing-detail
     page (lazy import so it doesn't bloat the homepage bundle), pass
     the resulting `visitorId` to `createPaymentIntent` as a field on
     the request body, then store it on the same `fraudSignals` doc.
   - Adds a single field; the cross-reference query gets a third `where`
     clause. Minimal additional infra.

2. **Email-domain heuristics.** Banned user signs up with a fresh Gmail
   address that's identical to the banned one except for `.` placement
   (Gmail ignores dots). Normalize on the server before checking.

3. **Phone-number cross-reference.** If we ever require phone verification
   for sellers (Apple/Google would like us to), add the verified phone
   to `fraudSignals` and cross-reference. Highest-trust signal we'd
   have access to.

4. **Decay window for IP-only signals.** A 1-year-old IP match should
   probably not auto-ban — hotel wifi, ISP rotation, etc. Add a
   `sampledAt` filter so we only flag matches from the last N days.
   (V1 has the field but doesn't filter on it; trivial change.)

5. **Admin review queue.** Instead of auto-banning on every match, route
   high-uncertainty matches (e.g. IP-only, no card match) to an admin
   queue. V1 is intentionally aggressive because volume is low and false
   negatives (letting a banned user back in) are worse than false
   positives (one support email about "I can't check out") at this
   stage. Re-evaluate at 1000+ daily checkouts.

## Verification

- `node -e "require('./banEvasion.js')"` from `functions/` — must not throw.
- Unit test: create a banned user A with a signal doc on IP X, then
  call `checkFingerprintAgainstBanned({ip:'X'})` — must return
  `{banned: true, matchedUid: A, matchedField: 'ip'}`.
- Manual end-to-end:
  1. Buyer A checks out successfully (creates signal doc).
  2. Admin sets `users/A.banned = true`.
  3. Same machine, fresh Gmail signup → buyer B.
  4. Buyer B clicks Buy → should see "Account not eligible for purchases".
