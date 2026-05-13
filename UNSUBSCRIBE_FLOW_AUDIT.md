# Unsubscribe Flow Audit — TeeBox

**Date:** 2026-05-13
**Scope:** End-to-end audit of the unsubscribe flow (click-through, RFC 8058 one-click, post-unsubscribe behavior, re-subscribe, preference center, CAN-SPAM compliance). **Read-only.**

---

## TL;DR test-case matrix

| # | Test case                                              | Expected                                                                                  | Actual                                                                                                                                          | Verdict        |
|---|--------------------------------------------------------|-------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| 1 | Click unsub link from marketing email                  | Land on prefs page OR global unsub (must be consistent)                                   | Lands on `unsubscribe.html`; auto-POSTs token; **per-category** unsubscribe; success copy points users to a non-existent `/account?tab=email`.   | **CONCERN**    |
| 2 | One-click via `List-Unsubscribe` header                | Works for Gmail/Apple Mail one-click POST                                                 | Header + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` set; backend POST has no auth, supports POST/GET, RFC 8058-compliant.               | **PASS**       |
| 3 | After unsub, latency to stop sends                     | < 10 min (target instant)                                                                 | `handleUnsubscribe` writes `users/{uid}.emailPrefs.{cat}=false` synchronously and awaits before 200; `preflightAllowed` reads that on next send. | **PASS**       |
| 4 | Unsubscribed users still receive transactional         | Yes (CAN-SPAM exempt)                                                                     | `isTransactional()` bypass at top of `preflightAllowed`; transactional emails do NOT include unsubscribe header or footer link.                  | **PASS**       |
| 5 | Re-subscribe from settings                             | Re-enables that category                                                                  | `updateEmailPreferences` callable exists and would flip the bit back to true — but **no UI calls it** anywhere in `index.html` or other pages.  | **FAIL**       |
| 6 | Preference center categories visible to user           | Order updates / saved searches / price drops / newsletter / etc. toggleable                | **No preference center UI exists.** The destination `/account?tab=email` linked from unsubscribe.html and email footers is a dead link.          | **FAIL — HIGH**|

---

## HIGH-severity findings

1. **No preference center UI.** `unsubscribe.html:105` and `emails/layout/Base.jsx:139` both link to `https://teeboxmarket.com/account?tab=email`, but `index.html` has zero references to `account`, `tab=email`, or `emailPrefs` (confirmed via grep). The `updateEmailPreferences` callable exists in `functions/emailTriggers.js:743-760` and the unsubscribe write path works, but a recipient has **no way to re-subscribe** or fine-tune prefs once unsubscribed. CAN-SPAM "as easy as subscribe" is technically satisfied for unsub (one click), but users cannot manage. Recommend: build the prefs modal (toggles for the 8 `PREF_KEYS` categories) and call `updateEmailPreferences`.

2. **`unsubscribe@mail.teeboxmarket.com` mailbox is not provisioned.** `functions/lib/email.js:302` sets the mailto fallback in `List-Unsubscribe`. Per `EMAIL_DELIVERABILITY_AUDIT.md:241,261`, the role mailbox is "aspirational, not implemented." If a user replies to the mailto from a client that uses mailto-only unsubscribe (rare, but exists), the mail bounces and they remain subscribed. Recommend: stand up Cloudflare Email Routing for `mail.teeboxmarket.com` to forward `unsubscribe@` to either a monitored inbox OR (better) an inbound parser that processes auto-unsubscribe.

3. **`unsubscribe.html` is not in `dist/`.** `firebase.json:24` declares `hosting.public: "dist"` and `dist/` contains no `unsubscribe.html`. Per project memory, production serves from GitHub Pages off the repo root, not Firebase Hosting, so this works in prod — but anyone deploying to Firebase Hosting would 404 the unsubscribe page. Recommend: copy `unsubscribe.html` into the dist build step, or document explicitly that hosting is GH Pages.

## MEDIUM findings

4. **Token expiry is 30 days** (`email.js:86`). For long-cadence emails (e.g., 90-day win-back) the unsub link in older emails will expire and show "Link not valid." `unsubscribe.html:113-114` falls back to "Sign in and update your preferences" — but there is no preferences UI to do so (see #1). Recommend: extend to 1y, OR show a stub form on the page that asks for email and POSTs an auth'd request.

5. **`emailPrefs.unsubscribedAt` audit trail missing.** `handleUnsubscribe` writes the bit + `emailPrefsUpdatedAt` but doesn't record source ("one-click", "footer", "prefs-toggle"). For compliance audits (CAN-SPAM record-keeping), capture provenance.

6. **Cross-origin POST is wide-open.** `handleUnsubscribe` sets `Access-Control-Allow-Origin: *` (`emailTriggers.js:911`). Combined with the HMAC token requirement this is OK (no CSRF risk without the token), but a leaked token in a server log could be replayed by anyone. The HMAC + 30-day expiry mitigate; no change required, but document.

7. **`emailSuppressions` doc check at preflight is per-user-wide** (`email.js:164-167`). A user that hard-bounces gets globally suppressed (correct). But the doc holds no `email` field check vs `to` — so if a user changes their email address, the new address is still suppressed. Edge-case; flag for follow-up.

## LOW findings

8. **Re-rendering the success page on POST refresh** — `unsubscribe.html` re-POSTs on every page load because the script fires on `DOMContentLoaded`. Idempotent (re-writing `false` is fine), but spends a Cloud Function invocation per refresh. Not urgent.

9. **`preflightAllowed` fails-open on Firestore read errors** (`email.js:166-168`). A transient Firestore outage would let a user who unsubscribed receive one more email. Acceptable trade-off (better than dropping transactional during partial outage), but document.

10. **`PREF_KEYS` set in `emailTriggers.js:732-741`** does NOT include `transactional` (correct — transactional cannot be unsubscribed). It DOES include all 8 marketing categories that match `CATEGORIES` in `email.js:55-65`. Consistent.

---

## Detailed evidence by section

### 1. Click-through unsubscribe (footer link)

- **URL generator:** `functions/lib/email.js:78-91` `makeUnsubscribeUrl({uid, category})`.
  - Pattern: `https://teeboxmarket.com/unsubscribe.html?t=<base64url(uid.category.expMs.sig)>`. **Note:** uses `?t=`, not `?token=`. Both the page (`unsubscribe.html:92`) and the function (`emailTriggers.js:917-920`) read `?t=`, so consistent.
  - 30-day expiry, HMAC-SHA256 keyed on `UNSUBSCRIBE_HMAC_SECRET` (Firebase secret).
- **Token validation:** `functions/lib/email.js:97-126` `verifyUnsubscribeToken` — constant-time compare, expiry check, returns `{ok, uid, category}`.
- **Server handler:** `functions/emailTriggers.js:908-943` `handleUnsubscribe`. Verifies token → writes `users/{uid}.emailPrefs.{category}=false` + `emailPrefsUpdatedAt` server timestamp via `merge:true`. Returns JSON `{ok:true, uid, category}` on success, `{ok:false, error}` on failure.
- **Landing page:** `unsubscribe.html` auto-POSTs to the Cloud Function on load. Shows green "You're unsubscribed" panel with the pretty category name. **Per-category unsubscribe, not global.** Suppressing only the one category the user clicked from.
- **Footer link in emails:** `functions/emails/layout/Base.jsx:131-145` renders an "Unsubscribe" link (uses the same `makeUnsubscribeUrl`) plus a "manage preferences" link to `https://teeboxmarket.com/account?tab=email` — **the latter is a dead link** (no such route exists in `index.html`).

### 2. One-click via `List-Unsubscribe` header

- **Headers set:** `functions/lib/email.js:300-304`:
  - `List-Unsubscribe: <https://teeboxmarket.com/unsubscribe.html?t=...>, <mailto:unsubscribe@mail.teeboxmarket.com?subject=unsubscribe-{category}>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  - Only set when `!isTransactional(category) && uid` (correct — transactional must NOT include unsub).
- **POST handler:** `functions/emailTriggers.js:911-921`. Accepts both POST and GET, reads token from body OR query, returns JSON. CORS-permissive (`Access-Control-Allow-Origin: *`). **No auth required** — RFC 8058 compliant (one-click MUST NOT require sign-in). HMAC token is the only credential.
- **Mailto fallback:** Header includes `mailto:unsubscribe@mail.teeboxmarket.com?subject=unsubscribe-{category}`. **Mailbox is not provisioned** per `EMAIL_DELIVERABILITY_AUDIT.md:241,261`. Bounces silently.

### 3. Post-unsubscribe behavior

- **Preflight check:** `functions/lib/email.js:159-183` `preflightAllowed({uid, to, category})`:
  - Line 160: `if (isTransactional(category)) return {allowed: true};` → transactional always passes.
  - Line 163-167: reads `emailSuppressions/{uid}` (hard-bounce + complaint suppression) → blocks.
  - Line 169-181: reads `users/{uid}`:
    - `data.emailSuppressed === true` → blocks (used for global suppression by bounce webhook).
    - `prefs[category] === false` → blocks (per-category opt-out).
- **Latency:** The unsub write is `await`ed before `handleUnsubscribe` returns 200. Next send invocation reads fresh from Firestore in `preflightAllowed` (no caching). Worst case is in-flight emails already past preflight at the moment of unsub — order of seconds. Well under 10 min.
- **Transactional bypass:** Confirmed. `isTransactional()` short-circuits before any pref read. Also confirmed via `Base.jsx:100-102`: transactional emails do not even include an unsubscribe link in the footer (replaced with "this is a transactional message" text).

### 4. Re-subscribe flow

- **Callable exists:** `functions/emailTriggers.js:743-760` `updateEmailPreferences`. Auth-required, validates keys against `PREF_KEYS` whitelist (lines 732-741), writes `emailPrefs.{key} = !!v` for each. Returns `{updated: n}`.
- **No UI calls it.** Grepping `index.html`, `unsubscribe.html`, and all `.html` in repo (excluding `node_modules`, `dist`) for `updateEmailPreferences` returns zero hits in any user-facing surface. The only callers are the function itself and `emailTriggers.js`. **Re-subscribe is currently impossible from the UI.**
- **Manual workaround:** A re-subscribe could be performed by an admin via Admin SDK or by a user via the (non-existent) preference center. There is no link from `unsubscribe.html` to "resubscribe" either.

### 5. Preference center

- **No UI.** No modal, no page, no toggles in `index.html`. The `pushPrefs` modal exists (`index.html:3088, 5702-5862`) for FCM push prefs but is entirely separate from `emailPrefs`. Both unsubscribe.html (`:105`) and Base.jsx (`:139`) link to `/account?tab=email`, which is a dead URL.
- **Backend ready:** The `updateEmailPreferences` callable is fully implemented and would handle the writes. The 8 toggleable categories per `PREF_KEYS` in `emailTriggers.js:732-741` are:
  - `savedSearchMatches`
  - `priceDrops`
  - `abandonedDraft`
  - `abandonedCart`
  - `reviewRequests`
  - `winBack`
  - `weeklyDigest`
  - `productUpdates`
- **Tampering protected:** `firestore.rules:198-210` restricts client writes to `users/{uid}` to a whitelist of `['phone','termsAgreed','termsAgreedAt','displayName','watchlist','blocked']`. `emailPrefs` is NOT in the list, so direct Firestore writes are rejected. Only the Admin-SDK-backed `updateEmailPreferences` callable and `handleUnsubscribe` HTTP function can mutate prefs. This is correct: users cannot tamper, server enforces.

### 6. CAN-SPAM compliance

- **No login required for unsub:** Confirmed. HMAC-signed token, public Cloud Function endpoint, public HTML page.
- **As easy as subscribe:** Single click in email → auto-POST on page load → done. No captcha, no confirmation step. PASS.
- **Latency:** Instant (synchronous write + Firestore read on next send). Well under the 10-business-day CAN-SPAM ceiling.
- **Physical address:** `Base.jsx:33-34` includes `"TeeBox, Inc. · 1234 Fairway Ln, Suite 200, Chicago, IL 60601, USA"` in every email footer. Verify this address is real before going live.
- **Unsubscribe records:** `emailPrefsUpdatedAt` timestamp written but no provenance log. Recommend audit collection.
- **Re-subscribe path:** **NOT compliant in spirit.** CAN-SPAM does not require a self-service preference center, but Gmail's Postmaster guidelines do. Without one, users blocked by accident have no recourse.

---

## Manual test plan (6 steps, once Resend is wired)

1. **Send a test marketing email** (e.g., trigger `savedSearchMatchScheduler` against a test account with one matching listing). Inspect the received email's source in Gmail (Show Original) and confirm:
   - `List-Unsubscribe: <https://teeboxmarket.com/unsubscribe.html?t=...>, <mailto:unsubscribe@mail.teeboxmarket.com?subject=unsubscribe-savedSearchMatches>`
   - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
   - Footer renders "Unsubscribe" link with same URL.

2. **One-click test (Gmail).** In Gmail web, click the gray "Unsubscribe" link Gmail surfaces next to the sender name. Confirm: Gmail POSTs to the URL, our `handleUnsubscribe` returns 200, and `users/{uid}.emailPrefs.savedSearchMatches` is now `false`. Verify via `firebase firestore:get users/{uid}`.

3. **Browser click-through test.** Click the in-footer "Unsubscribe" link. Confirm `unsubscribe.html` shows green success state with "saved-search matches" pretty name. Refresh the page: should re-POST and still show success (idempotent).

4. **Latency test.** Within 10 seconds of step 3, manually trigger a fresh `savedSearchMatchScheduler` run against the same user. Confirm `emailSends/{id}` shows `status: "skipped-opted-out"`. Confirm no email arrives.

5. **Transactional bypass test.** With prefs still set to opted-out from step 3, place a test order (or write to `orders/` directly). Confirm `OrderPlacedBuyer` email arrives despite the global opt-out, AND that the footer reads "This is a transactional message... cannot be unsubscribed from" with NO unsub link or `List-Unsubscribe` header.

6. **Token expiry + bad signature test.** (a) Manually construct a token with `expMs = Date.now() - 1000` and POST to `handleUnsubscribe` — expect `{ok:false, error:"expired"}`. (b) Tamper one hex char in the signature — expect `{ok:false, error:"bad-signature"}`. (c) Drop the token entirely — expect `{ok:false, error:"no-token"}`.

---

## File references

- `/Users/jakenair/Desktop/teebox/functions/lib/email.js` — sender, preflight, HMAC token helpers
- `/Users/jakenair/Desktop/teebox/functions/emailTriggers.js` — `handleUnsubscribe`, `updateEmailPreferences`, all triggers
- `/Users/jakenair/Desktop/teebox/functions/emails/layout/Base.jsx` — email footer with unsub link
- `/Users/jakenair/Desktop/teebox/unsubscribe.html` — landing page
- `/Users/jakenair/Desktop/teebox/firestore.rules` — `users/{uid}` whitelist (lines 198-210)
- `/Users/jakenair/Desktop/teebox/index.html` — confirmed NO email preference UI exists
- `/Users/jakenair/Desktop/teebox/EMAIL_DELIVERABILITY_AUDIT.md` — pre-existing audit noting role-mailbox gap
