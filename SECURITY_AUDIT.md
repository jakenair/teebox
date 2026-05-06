# TeeBox Security Audit — May 2026

Paranoid line-by-line audit of the live production stack:
**index.html** + **firestore.rules** + **storage.rules** + **functions/index.js**.
Branch from `main` @ `96d5fec`.

Severity scale: **Critical** (active exploit, fix immediately) → **High** (fix this release) → **Medium** (fix soon) → **Low** (defense-in-depth) → **Info** (FYI).

---

## TL;DR

No Critical or High findings. Three Medium findings (App Check
not yet enforced, GitHub-Pages-served security headers missing,
no per-user rate limit on `createPaymentIntent`); one Low fix
applied (defense-in-depth listing-create whitelist); a handful of
informational notes. The Firestore + Storage rule surface area is
in good shape — the previous hardening pass (commit `133`) covered
the load-bearing collections and the new rules are defensively
written.

---

## Findings

### Critical

_None._

### High

_None._

### Medium

**M1 — App Check is not yet enforced (planned)**
- **Where:** `firestore.rules:14`, `storage.rules:9`
- **Description:** `function appCheckOk() { return true; }` in both
  rule files. App Check tokens flow from clients (web reCAPTCHA
  Enterprise + iOS via the Firebase plugin), but the server still
  accepts requests without a valid token. Result: a stolen Web
  API key can hit Firestore from any non-allowlisted origin
  (subject to per-collection rules). Tracked as task **#137**.
- **Fix applied:** None. **Recommendation:** keep as-is until
  task #137 confirms 100% of production traffic shows valid App
  Check tokens in the dashboard. Flipping enforcement before that
  will lock real users out (single-page no-rebuild outage).
- **Manual step:** see `index.html:4030-4038` for the enable
  procedure once the dashboard is green for a full 24h.

**M2 — Security headers not served on the GitHub Pages origin**
- **Where:** `firebase.json:38-48` declares HSTS,
  X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  Permissions-Policy, COOP — but `CNAME` points
  teeboxmarket.com at GitHub Pages, so `firebase.json hosting`
  configuration is dead code in production.
- **Description:** Pages does send a default HSTS for custom
  domains, but the rest are absent. CSP is delivered via
  `<meta http-equiv>` (works), so not catastrophic, but X-Frame-
  Options/COOP/Permissions-Policy aren't enforceable from a
  meta tag.
- **Fix applied:** None — GitHub Pages doesn't allow custom
  response headers. **Recommendation:** plan migration of the
  primary origin to Firebase Hosting (`teebox-market.web.app`)
  or Cloudflare Pages with custom-headers config. Until then,
  the most-impactful protections (CSP `default-src 'self'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `frame-ancestors` via the meta CSP) are present.

**M3 — `createPaymentIntent` has no per-user rate limit**
- **Where:** `functions/index.js:62-261`
- **Description:** The function uses Stripe's `idempotencyKey`
  to dedupe within a 5-minute window, and the per-listing
  reservation transaction prevents double-reserving stock, but
  there's no Firestore-side rate counter that throttles a
  single buyer hammering the endpoint with different
  `listingId`s. Stripe's API rate limits eventually kick in
  (~25 req/sec/account); a determined attacker could still
  burn function invocations.
- **Fix applied:** None — this would change behavior under
  legitimate load and is out of scope for a no-deploy change.
  **Recommendation:** add a 30 req/min per UID counter at
  `users/{uid}/rateLimits/createPaymentIntent` similar to
  `aiUsage` (line 2504). File for next pass.

### Low

**L1 — Listing-create field whitelist (defense-in-depth)**
- **Where:** `firestore.rules:48-97` (`isValidListingCreate`)
- **Description:** The previous rule used a per-field deny
  list (`!('soldAt' in d.keys())` × ~10) but did not enforce
  `keys().hasOnly(...)`. A malicious client could write
  arbitrary novel fields to a listing on create — for example,
  `disputed: false`, `refunded: false`, `featured: true`, or
  any future server-only field added later. None of these
  currently affect read paths, but they're a footgun if a
  future Cloud Function reads them without re-validation.
- **Fix applied:** Added a `keys().hasOnly([...20])` whitelist
  to `isValidListingCreate`, plus typed validation for
  `quantity` (1–99), `quantitySold` (must equal 0 on create),
  `requiresAuth` (bool), and `authReviewState` (`'na'` or
  `'pending'`).
- **Side effect:** none — the client at `index.html:4931`
  writes exactly these fields.

### Info

**I1 — `quantitySold` blocked on create, server-controlled**
After L1 the client may seed `quantitySold: 0` but cannot
spoof a higher value. The webhook (Admin SDK) is the only
writer that increments it.

**I2 — `exchangeIdTokenForCustomToken` is intentionally
unauthenticated.** It accepts an unauth call because the
caller is signing in *via* this path. Security comes from
`admin.auth().verifyIdToken(idToken)` (cryptographic
signature check). Stolen ID tokens would already grant the
attacker the user's identity, so re-minting a custom token
adds no new privilege.

**I3 — No `eval()` / `new Function()` use.** Verified across
`index.html` and `functions/index.js`.

**I4 — XSS sinks all use `safeText` / `safeAttr` /
`safeImgUrl`.** Inbox preview uses `escapeInboxText`; chat
messages use an inline 5-char escape.
`safeImgUrl` whitelists only `https://*.firebasestorage.app/`,
`https://firebasestorage.googleapis.com/`, and `blob:`.

**I5 — Open redirect surface.** Every `window.location.href = url`
in `index.html` (4 occurrences, 11019/11021/11058/11082) sets
the URL to a value returned by a Stripe callable that we
own server-side (`createSubscriptionCheckout`,
`createBillingPortalSession`, `createStripeOnboardingLink`).
No user-supplied URL flows into a redirect.

**I6 — Stripe webhook signature verification is correct.**
`functions/index.js:276` calls
`stripeClient.webhooks.constructEvent(req.rawBody, sig, webhookSecret.value())`,
and on signature failure returns 400 immediately (line 282).
`payment_intent.succeeded` handler is idempotent via the
`existingOrder.exists` check at line 493.

**I7 — Storage rules are tight.**
- 5MB cap on listing photos / 2MB on avatars (lines 27, 44).
- Content-type whitelist excludes SVG (the JS-injection
  hazard) and all non-raster types.
- Path encodes `sellerId` so ownership is verifiable from
  the path alone — no Firestore round-trip needed.
- Default-deny at line 50.

**I8 — Firestore rule coverage is complete.**
Every collection touched by the app has explicit rules.
Subcollections that aren't enumerated (`users/{uid}/aiUsage`,
top-level `listingViews`) are caught by the
`match /{document=**}` default-deny at line 714.

**I9 — Server-only fields are blocked on `users/{uid}`.**
Whitelisted fields:
`['phone','termsAgreed','termsAgreedAt','displayName','watchlist','blocked']`.
Anything outside that list (including `tier`, `stripeAccountId`,
`sellerVerified`, `proSubscriptionStatus`, `credits`, etc.)
is blocked from the client and only writable via the Admin
SDK in Cloud Functions.

**I10 — No secrets in the repo.**
- `.env` is in `.gitignore`.
- No Firebase service-account JSON anywhere.
- No `sk_live_` / `sk_test_` keys (only `pk_test_` in
  `index.html:3672`, which is the publishable key — safe).
- Gemini API key, Stripe secret, webhook secret, Resend key,
  Stripe Pro Price ID all loaded via `defineSecret(...)` and
  only ever passed to `.value()` inside server-side function
  bodies. Grep confirms no `logger.info` includes any
  `*.value()` call (`functions/index.js`, all 30+ usages).
- Public Firebase Web API key (`AIzaSy…HTr4`) appears in
  index.html and brand pages — this is by design (Web API
  keys are not secret; security is enforced by rules).

**I11 — CSP review.**
- `default-src 'self'` ✅
- `object-src 'none'` ✅
- `base-uri 'self'` ✅
- `form-action 'self'` ✅
- `frame-src` allows Stripe + Google for sign-in ✅
- `script-src` allows `'unsafe-inline'` (needed for inline
  bootstrap; `script-src-attr 'none'` blocks event-handler
  attributes — XSS via `onclick="..."` is impossible)
- No `'unsafe-eval'` ✅

**I12 — Dead-code triggers (functional, not security).**
`incrementListingMessage` (line 959) and `notifyOnNewMessage`
(line 2074) listen on the top-level `messages/{messageId}`
collection, but actual messages live at
`conversations/{convId}/messages/{msgId}`. These triggers
never fire. Tracked separately under feature backlog — flagged
here for completeness because a fix would change app
behavior (push notifications for chat would start working)
and is out of scope for a security pass.

**I13 — `notifyOnSavedSearchMatch` writes to wrong path for push.**
Writes to top-level `notifications/{auto}`, but
`pushNotificationDispatch` listens on
`users/{uid}/notifications/{notifId}`. Same class of bug as
I12 — push not delivered for saved-search matches. Again,
behavior change, deferred.

---

## What was already correct

- `firestore.rules` enforces self-only reads on `/users/{uid}`,
  with a `hasOnly()` whitelist on writes that excludes every
  Stripe / tier / verification field.
- `/profiles/{uid}` is publicly readable (necessary — buyers
  need to see seller name + rating) but writes are
  whitelist-only and exclude all aggregate / Pro fields.
- Listing **update** rule already restricts `affectedKeys` to
  user-editable fields and validates each.
- Reviews are immutable (`allow update, delete: if false`) and
  authorship is enforced by the `{orderId}_{role}` doc-id
  convention plus a cross-check against the parent order's
  `buyerId`/`sellerId`. Helpful-vote is one-shot per user
  (immutable until deleted).
- Bids cannot be self-bid (sellerId != auth.uid check at
  line 246) and the listingId must reference a real listing.
- Conversations require the *other* participant to be the
  listing's actual seller — no spamming arbitrary UIDs.
- Messages in conversations must be authored by a participant
  AND `senderId == auth.uid` AND `createdAt == request.time`
  (server-clock check prevents backdated messages).
- Orders can only transition along the documented state
  machine (`awaiting_seller_shipment` → `shipped` by seller →
  `delivered` by buyer), with `affectedKeys()` constrained per
  branch.
- Offers status is a strict enum (`pending` →
  `accepted|declined|countered`) and only the seller can
  change it. Buyer-side `message` edit is one-shot.
- `gameScores` are immutable post-create (no update/delete
  from client) — prevents leaderboard spam.
- Storage paths encode `sellerId` so ownership is path-derived;
  size + content-type are validated; default-deny at the bottom.
- Cloud Functions: every `onCall` requiring auth checks
  `request.auth` at the top; every `onRequest` (only
  `createPaymentIntent`, `stripeWebhook`) verifies a Firebase
  ID token / Stripe signature respectively before touching
  state.
- Stripe webhook is idempotent via order doc id == payment
  intent id; the existing-order check at line 493 prevents
  double-fulfillment on webhook retries.
- `optimizeListingPhoto` strips EXIF (incl. GPS) on upload —
  important privacy property.
- `generateListingDescription` has a verified-seller gate
  (line 2493), input length validation (200 char cap on each
  field), AND a 30 calls/user/day rate limit (line 2511) —
  the gold-standard pattern for AI endpoints.
- `refundOrder` checks `order.sellerId == auth.uid` (line
  2418) and refuses to double-refund.
- `deleteUserAccount` anonymizes profile + user docs and
  deletes the auth record (Apple guideline 5.1.1(vi)).

---

## Manual steps required from the user

1. **Task #137 — verify App Check tokens in dashboard.**
   Once the dashboard shows a green graph for 24h on
   Firestore, Storage, and Cloud Functions, flip enforcement
   in the Firebase console AND change `appCheckOk()` to
   `return request.app != null;` in both `firestore.rules`
   and `storage.rules`, then `firebase deploy --only
   firestore:rules,storage:rules`.

2. **Plan to migrate the primary origin** off GitHub Pages
   so the security headers in `firebase.json` actually fire
   (M2). Alternative: add equivalent headers via Cloudflare
   in front of Pages.

3. **Add per-user rate limits** to `createPaymentIntent`
   following the `aiUsage` pattern (M3). Out of scope for this
   audit — file as a separate task.

4. **Consider rotating the reCAPTCHA Enterprise site key**
   in `index.html:4041` if the public key has ever been
   accidentally used in a non-allowlisted origin. (Site keys
   are public by design but the allowlist matters.)

---

## Files changed in this audit

- `firestore.rules` — added `keys().hasOnly()` whitelist +
  typed validation to `isValidListingCreate` (L1).
- `sw.js` — bumped CACHE_VERSION r64 → r65.
- `SECURITY_AUDIT.md` — this file.
