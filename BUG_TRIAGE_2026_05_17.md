# Pre-Beta Bug Triage — 2026-05-17

## Verdict

**4 of 5 critical bugs block beta.** Bug 1, Bug 2, Bug 4, and Bug 5 (Crashlytics-missing) MUST be fixed before TestFlight goes wide. Bug 3 is **not actually a bug on web** — the kill-switch works as designed — but **does manifest on iOS** because the bundled `ios/App/App/public/index.html` is a stale May-11 snapshot that predates the kill-switch. Bug 1, Bug 2, and Bug 3-on-iOS all share the same upstream cause: the iOS bundle is stale and the founder's `users/{uid}` doc has a leftover **test-mode Stripe Connect account id** that the live-mode platform can't read. Fixing that one Firestore field unblocks Bug 1 immediately; rebuilding the iOS Capacitor bundle unblocks Bug 2 and Bug 3.

---

## Bug-by-bug

### Bug 1 — Web "Could not verify your payout setup. Please try again."

**Status (2026-05-17, post-authorization)**: 🔧 In progress — PR 1, Agent A

- **Root cause**: `users/l1Z3m8do75WKVbJm5HBwvCreJtx2.stripeAccountId = "acct_1TTP7BPJFAmv2puf"` is a **TEST-MODE** Connect account id, but the deployed `STRIPE_SECRET_KEY` secret is a **LIVE** key (`sk_live_51TNLBC…`). The callable `getStripeAccountStatus` (functions/index.js:4478) calls `stripeClient.accounts.retrieve(user.stripeAccountId)` against the live API, which throws `StripeInvalidRequestError: The account acct_1TTP7BPJFAmv2puf was a test account created with a testmode key, and therefore can only be used with testmode keys.` The client `submitListing` catches this in functions/index.js logs as `httpsCallable` → "Could not verify your payout setup" toast (index.html:7057).
- **Code reference**:
  - Throw site: functions/index.js:4492 — `await stripeClient.accounts.retrieve(user.stripeAccountId)`
  - Error catch + toast: index.html:7046–7058 (`window.submitListing` catch block)
  - Confirmed in production logs: Cloud Run `getstripeaccountstatus` at 2026-05-17T18:17:46Z (full stack trace shows `StripeResource.js:59:31` → `Accounts.js:24:25` → `index.js:4492:46`).
- **Founder's Stripe state** (verified via Firebase Admin SDK + Stripe REST API):
  - Firestore `users/l1Z3m8do75WKVbJm5HBwvCreJtx2`:
    - `stripeAccountId = "acct_1TTP7BPJFAmv2puf"`
    - `stripeChargesEnabled = false`
    - `stripePayoutsEnabled = false`
    - `stripeDetailsSubmitted = false`
    - `sellerVerified = true`
  - Live-mode Stripe API `GET /v1/accounts` → **0 connected accounts** (zero — none of the 23 users have a live-mode Connect account).
  - Live-mode Stripe API `GET /v1/accounts/acct_1TTP7BPJFAmv2puf` → 400 error: "was a test account created with a testmode key".
- **Severity**: **CRITICAL** — blocks every existing seller account that touched the test-mode platform during pre-launch. The founder cannot publish a listing, period.
- **Effort**: 5 min (one-shot Admin SDK write to clear the field) + 30 min (defensive code fix to catch the error class).
- **Proposed fix**:
  1. **Immediate, one-shot**: clear stale test-mode `stripeAccountId` from any user doc whose value matches the test-mode prefix (`acct_1T…` is a Sept-2025 testmode prefix on this Stripe account). A one-shot Admin SDK script that nulls `stripeAccountId` + clears the three boolean caches for any user whose stored id can't be retrieved via the LIVE key. This forces the next "Set up payouts" click to create a fresh live-mode account.
  2. **Defensive code change** (functions/index.js:4486-4509): wrap `stripeClient.accounts.retrieve()` in try/catch. On `StripeInvalidRequestError` with substring "test account" OR `resource_missing`, treat the stored id as orphaned: clear `stripeAccountId` from the user doc and return `{ connected: false, recovered: true }`. Without this, any future test/live mode mistake reproduces the same bug.
- **Proposed new error message** (when `getStripeAccountStatus` legitimately fails — network blip, not the stale-id case):
  > "Your payout setup couldn't be checked right now. **[Open Stripe setup]** — this will start fresh if needed."
  >
  > Replace the dead-end toast at index.html:7057 with the existing `showStripeRequiredDialog(status)` modal (already implemented at index.html:10971), tuned to show a "Try again" + "Reset payout setup" pair of CTAs. On click "Reset payout setup", call `createStripeOnboardingLink` which already creates a fresh account if the stored id has been cleared by the fix above.

---

### Bug 2 — iOS "Permission denied. Sign out, sign back in, and try again."

**Status**: 🔧 In progress — PR 2, Agent D

- **Root cause**: iOS Capacitor bundle (`ios/App/App/public/index.html`, last modified 2026-05-11, 768 KB) is **stale**. The current web bundle (`./index.html`, modified 2026-05-15, 960 KB) added a client-side Stripe-precheck gate in `submitListing` (index.html:7043-7066) that calls `getStripeAccountStatus` and shows `showStripeRequiredDialog` on `chargesEnabled=false`. The iOS bundle does NOT have that gate (ios/App/App/public/index.html:5299–5400) — it goes straight to `addDoc(collection(db,'listings'), …)`. Firestore rule for listing create (firestore.rules:70-82) requires `sellerStripeReady(uid)` which reads `users/{uid}.stripeChargesEnabled == true`. The founder's flag is `false` (see Bug 1), so Firestore returns `permission-denied`. The catch block at ios index.html:5391–5394 then matches `code.includes('permission-denied')` → "Permission denied. Sign out, sign back in, and try again." This is misleading: sign-out won't help because the rule is gating on `stripeChargesEnabled`, not auth state.
- **Code reference**:
  - Stale iOS bundle's `submitListing`: ios/App/App/public/index.html:5299–5400 (no `getStripeAccountStatus` call)
  - The misleading message: ios/App/App/public/index.html:5392–5393 (also still present in current web at index.html:7190-7191 as a backstop)
  - The Firestore rule: firestore.rules:70-82, helper `sellerStripeReady` at firestore.rules:51-54
  - The Stripe-precheck gate that's MISSING from iOS: index.html:7043-7066 (added on web on/before May 15)
- **Race-condition window** (theoretical, but not the cause here):
  - `handleConnectAccountUpdated` (functions/missingProducers.js:268-305) writes `stripeChargesEnabled` synchronously inside the webhook handler. Stripe fires `account.updated` within ~1-3s of KYC completion. From the user clicking "Done" in Stripe → return URL → first listing-publish attempt, the typical floor is 5-10s of UI navigation, so the webhook is almost always faster. The race is real but the founder is NOT in it; their account flag is `false` because they never completed KYC against a live-mode account.
- **Severity**: **CRITICAL** — every iOS seller who hasn't fully completed live-mode Stripe KYC will hit this and get a useless "sign out" instruction.
- **Effort**: 1 hr (rebuild and re-sync iOS bundle via `npx cap sync ios`, smoke-test in simulator) + 30 min (improve the catch-block error mapping in current web index.html so even the backstop is actionable).
- **Proposed fix**:
  1. Rebuild iOS bundle: `npx cap sync ios` from repo root so the May-15 web index.html replaces the May-11 bundle. Verify after sync that ios/App/App/public/index.html grep `'Checking payout setup'` returns a hit (the precheck gate string).
  2. Sharpen the still-existing fallback in index.html:7188-7199. On `permission-denied`, instead of telling the user to sign out, call `getStripeAccountStatus` to discriminate (KYC incomplete vs auth state vs something else) and route into the appropriate modal:
     - If `getStripeAccountStatus` returns `connected: false` OR `chargesEnabled: false` → `showStripeRequiredDialog(status)` (existing modal).
     - If the status callable itself errors → "Something went wrong checking your account. Please reopen the app and try again."
     - **NEVER** "sign out, sign back in" — that copy should be deleted entirely.
- **Proposed new error message** (replacing index.html:7191 and ios/App/App/public/index.html:5393):
  > "Your seller payouts aren't fully set up yet. **[Complete payout setup]** — about 3 minutes via Stripe."

---

### Bug 3 — AI Suggest Price button visible but broken

**Status**: 🔧 In progress — PR 2 (same iOS bundle refresh as Bug 2)

- **Root cause (split by platform)**:
  - **Web (current bundle, May 15)**: kill-switch is wired correctly. Button HTML at index.html:4424 starts with `style="display:none"`; `openSellModal` (index.html:10682-10721) calls `applyAiPriceFlagVisibility()` (index.html:10673-10680) which reads `config/features.aiPriceEnabled` from Firestore via `loadFeatureFlags()` (index.html:10649-10667). Since `config/features` doc **does not exist in Firestore** (verified via Admin SDK), the flag defaults to falsy → button stays hidden. Server callable `suggestListingPrice` (functions/index.js:5198-5211) also returns `{enabled: false}` when the flag isn't `=== true`, so even a stale-cached client gets a no-op. **The web kill-switch is functioning as designed.**
  - **iOS (May-11 stale bundle)**: The kill-switch was added AFTER May 11. ios/App/App/public/index.html:3877 declares the button with NO `style="display:none"` default. There is NO `applyAiPriceFlagVisibility` function (grep returns 0 matches). There is NO `loadFeatureFlags` function. There is NO `d.enabled === false` short-circuit in `aiSuggestPrice` (ios/App/App/public/index.html:8662-8748) — when the server returns `{enabled:false}` the iOS client tries to read `d.suggested` / `d.low` / `d.high` (all undefined) and throws `Error('bad-shape')`, which surfaces as "Couldn't suggest a price right now." That's the founder's exact reproduction.
- **Code reference**:
  - Web (working): index.html:4420-4427, 10649-10680, 10906-10915
  - iOS (broken): ios/App/App/public/index.html:3877 (no display:none), 8662-8748 (no kill-switch check), 0 hits on grep for `aiPriceEnabled` / `applyAiPriceFlagVisibility`
  - Firestore: `config/features` doc does not exist (Admin SDK confirms; the flag defaults to OFF, which is the intended state pre-launch per LAUNCH_READINESS.md CRITICAL #10).
- **Severity**: **HIGH** (iOS only). Doesn't burn quota on Gemini (server kill-switch is closed) but shows a visible button that returns a confusing error → erodes trust in AI features. On web this is **not a bug**.
- **Effort**: 0 hrs incremental beyond rebuilding the iOS bundle (Bug 2 fix already includes `cap sync ios`).
- **Proposed fix**: same as Bug 2 — `npx cap sync ios` pulls in the May-15 kill-switch. No standalone fix required.

---

### Bug 4 — AI Write Description not working

**Status**: 🔧 In progress — PR 3 (Gemini key rotation, handled interactively in chat)

- **Diagnosis**: Cloud Function `generateListingDescription` is deployed (confirmed via `gcloud functions list`). The function calls Gemini 2.0 Flash via REST (functions/index.js:5097-5099). **The Gemini API key is hitting a free-tier quota of LIMIT=0.**
- **Function deployment status**: ✓ deployed (GEN_2, in `gcloud functions list` output).
- **Secret binding**: `GEMINI_API_KEY` secret exists (created 2026-05-04). Bound to the function (functions/index.js:5004 `{secrets: [geminiSecret], cors: true}`).
- **Log evidence** (Cloud Logging `generatelistingdescription` service, 2026-05-17T18:01:34Z):
  ```
  ERROR: generateListingDescription: Gemini error 429
  "code": 429,
  "message": "You exceeded your current quota...
  Quota exceeded for metric:
    generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0
    GenerateRequestsPerMinutePerProjectPerModel-FreeTier, limit: 0
    GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 0",
  "status": "RESOURCE_EXHAUSTED"
  ```
  The key is associated with a Google AI Studio project that has **free-tier quota explicitly set to 0** on `gemini-2.0-flash`. This means either:
  - (a) The Google Cloud project the key was minted in does not have billing enabled (most likely), OR
  - (b) The key was generated for a different/personal AI Studio project that was rate-limited.
- **What the user sees**: function returns HttpsError("internal", "AI service returned an error.") → client toast at index.html:10837 "Couldn't generate. Try again."
- **Severity**: **HIGH** — feature is broken for 100% of users. But not strictly beta-blocking (AI description is a nice-to-have; manual entry still works).
- **Effort**: 10-30 min if billing is enabled on the right project (rotate the key from a billed AI Studio project, paste into Secret Manager). Could be longer if a different cloud project needs to be set up first.
- **Proposed fix**:
  1. Open Google AI Studio (https://aistudio.google.com/), confirm which Google Cloud project the current key is tied to (free-tier indicator visible in the Quotas tab).
  2. Either enable billing on that project, OR mint a new key from a billed project, OR switch to `gemini-1.5-flash` (sometimes has different free-tier quotas — but verify in Quotas tab before deploying).
  3. Update `GEMINI_API_KEY` secret: `gcloud secrets versions add GEMINI_API_KEY --data-file=- --project=teebox-market`.
  4. Re-run the function (no redeploy needed — Cloud Run picks up the new secret on next cold start). Smoke-test from the sell modal.
  5. **Code change (optional, recommended)**: When `generateListingDescription` catches a 429 with `RESOURCE_EXHAUSTED`, throw `HttpsError("resource-exhausted", "AI is at quota. Try again later.")` so the client (index.html:10830-10831) shows "Daily limit reached. Edit manually." instead of the generic "Couldn't generate."

---

### Bug 5 — iOS app freezes on multiple screens

**Status**: 🔧 In progress — PR 4 (Crashlytics install) by Agent C. PR 5 (query caps) deferred until Crashlytics signal arrives.

- **Crashlytics install status**: **NOT INSTALLED.**
  - Podfile (ios/App/Podfile:1-40): zero hits on `Crashlytics`, `FirebaseCrashlytics`. Only Firebase pods linked are `FirebaseCore`, `FirebaseAuth`, `CapacitorFirebaseAuthentication`.
  - `ios/App/App/AppDelegate.swift:1-60`: imports `FirebaseCore`, `FirebaseAuth` only. No `import FirebaseCrashlytics`. No `Crashlytics.crashlytics()` call. Only `FirebaseApp.configure()` (line 12).
  - **This contradicts the founder's memory note** (`observability-stack.md`) which says Crashlytics covers iOS crashes. **It does not.** iOS crashes are currently going to /dev/null — no Crashlytics, no Sentry. The only signal the founder has is "the app froze."
- **Recommendation**: **Adding Crashlytics is itself a beta-blocker** for any iOS-freeze diagnosis. Until it's installed, every reproducer of Bug 5 is a black box. Approximate effort to add: 30-60 min (add `pod 'FirebaseCrashlytics'` to Podfile, `pod install`, add `import FirebaseCrashlytics` + run-script build phase for dSYM upload to the App target).
- **Slow Cloud Functions check** (via `gcloud logging read` for `httpRequest.latency>"3s"`, 2026-05-17 last hour): nothing user-facing standing out. All hits are scheduled background jobs (`notifyOnWatchlistPriceDrop`, `aggregateEmailMetrics`, `pushBingoStreakSaver`, `regenerateSitemap`, `checkEmailUsage`) plus the broken `getStripeAccountStatus` (3.8s — Stripe-side retry delay before throwing). No interactive callable is taking >3s in production traffic.
- **Candidate culprits** (unbounded queries + heavy ops, file:line):
  1. **`index.html:9211-9217` — pending-offers fetch with NO `limit()`**. Function uses `where('sellerId','==',uid).where('status','==','pending').orderBy('createdAt','desc')`. If a power seller ever accumulates hundreds of pending offers (theoretical pre-launch, real post-launch), this returns everything to the WebView in one blocking promise. Same shape (and same lack of limit) appears at index.html:11988-11993.
  2. **`index.html:11234-11237` — savedSearches enumeration with NO `limit()`**. `getDocs(query(collection(db, 'users', uid, 'savedSearches'), orderBy('createdAt','desc')))` — no cap. A user with many saved searches blocks the modal render.
  3. **`index.html:12465-12482` — three sequential savedSearches scans** (top-level `savedSearches` collection — global!) without `limit()`. Line 12466 + 12472 are global-collection queries; if the schema ever pollutes (multi-user docs), this scales with TOTAL savedSearches across the platform, not the current user's.
  4. **`index.html:6968-6998` — `loadListings` fetches 200 listings, then runs three sequential `.filter()` + `deriveHotBadges()` (median sort) + `deriveTickerFromProducts()` + `buildProducts()` + `buildTrending()` + `buildTicker()` + `updateLiveStats()` all synchronously**. On a cold marketplace load with 200 listings × 10 photos each in `photos: []`, this is a big synchronous JSON parse + DOM reflow on the WebView main thread. Combine with WKWebView's narrower JS heap budget vs Mobile Safari, and this is the prime suspect for the "homepage feels stuck" symptom.
  5. **`index.html:14236` — `getDocs(collection(db,'reviews',rid,'helpfulVotes'))`, NO `limit()`**, NO `where`. For any popular review, this enumerates EVERY helpful-vote subdoc to render a button counter that already lives on the parent review doc. Cold open of a product modal that triggers review render = unbounded read.
- **Severity**: **HIGH** (Crashlytics gap), **MEDIUM** (unbounded queries — won't bite at 23 users but will surface in TestFlight if anyone has a populated dashboard).
- **Effort**: 30-60 min (Crashlytics install), 1-2 hrs (cap the five queries above with `limit(50)` ceilings).
- **Founder instructions** (post-Crashlytics-install):
  > After landing the Crashlytics PR + a fresh TestFlight upload, check Firebase Console → Crashlytics → Issues. Look for `EXC_BAD_ACCESS` or hung-state ANR-style entries on WebView render paths. Then reproduce each frozen screen and note the timestamp — Crashlytics organizes by issue group, not by screen, so a timestamp-anchored cross-reference is the fastest path.

---

## Bug F — Seller onboarding redesign

**Status**: ⏸ Deferred to post-beta v1.1. Full wireframe-level proposal moved to BUG_F_ONBOARDING_REDESIGN.md.

### Current flow (web + iOS, both use index.html)

1. **Signup** (index.html, auth modal): email/password or Google/Apple/phone → `onAuthStateChanged` fires, `welcomeOnFirstProfileWrite` Cloud Function creates the user doc with `stripeChargesEnabled: false` (functions/index.js:1242, 1956). No Stripe touchpoint at signup. No banner shown.
2. **Browse** (default state): user lands on marketplace, can browse, watchlist, message — all without Stripe. NO proactive nudge to set up payouts.
3. **Tap "Sell"** (mobile bottom tab → `become-seller` action): if `IS_VERIFIED_SELLER` is false, opens the Seller Agreement modal (index.html:3055 — `becomeSellerBtn`). User clicks "Agree & Become a Seller" → `becomeSeller()` flips `sellerVerified: true` on user doc → modal closes → Sell modal opens.
4. **Fill listing form** → click "Submit Listing" → **first contact with Stripe** at index.html:7043 — `submitListing` calls `getStripeAccountStatus` for the precheck. **This is where they discover the wall.**
   - If `chargesEnabled: false`, `showStripeRequiredDialog(status)` opens (index.html:10971), surfacing the cta modal with a "Set up payouts" button.
   - That button fires `A['stripe-connect']` (index.html:15294-15346) → `createStripeOnboardingLink` callable → opens the Stripe Express onboarding URL.
5. **On iOS**: `window.location.href = url` (index.html:15337-15338) — navigates the **in-app WebView** to Stripe. `@capacitor/browser` plugin is NOT installed (per index.html:15588 comment).
6. **Stripe collects** name, address, DOB, SSN (last 4), bank routing/account, identity-document upload (live-mode hard requirement).
7. **Return**: Stripe redirects to `https://teeboxmarket.com/?stripe=onboarded` (functions/index.js:4471). On iOS, this URL hits the universal-link `applinks` paths in `apple-app-site-association` (root `/` is listed) → opens the app, NOT Safari. **BUT** during the Stripe session on iOS, the in-app WebView was used (step 5), so cookies set by Stripe live in WKWebView only. On return, the user is back in the Capacitor shell; the WebView state for the original page is gone and Stripe's "Done" navigation lands on a freshly-loaded `index.html?stripe=onboarded`.
8. **Webhook**: `stripeConnectWebhook` (Cloud Function, registered in functions/missingProducers.js:268-305) receives `account.updated` and writes `stripeChargesEnabled: true` to the user doc.
9. **Race**: between step 7 (return-to-app) and step 8 (webhook commit). If the user immediately re-taps Submit, the precheck might still see `false`. Web bundle now handles this with the `getStripeAccountStatus` precheck (which re-reads from Stripe live, not from the cached flag) — but the iOS bundle is stale (Bug 2) and bypasses the precheck.

### Friction points

1. **Hidden until step 4.** The seller fills out a listing form (title, brand, photos, description) — 2-5 minutes of work — BEFORE they discover the Stripe wall. This is the canonical "form abandonment" anti-pattern. **#1 leverage point.**
2. **No first-login nudge.** There's no "Welcome — finish payout setup" card on the home tab. The `renderStripeConnectBanner` (index.html:9995-10039) only renders inside the Payouts dashboard tab — which sellers don't visit until they expect payouts.
3. **In-app WebView for Stripe.** iOS uses `window.location.href` to navigate to Stripe inside the Capacitor WKWebView. Stripe's onboarding form has known issues with iframed/embedded WebViews: state loss on `Done`, occasional cookie partitioning issues, identity-document upload sometimes fails to access the camera roll without an explicit user-prompt the WebView can't trigger. **#2 leverage point.**
4. **`sellerVerified=true` decoupled from `stripeChargesEnabled=true`.** The founder's account is `sellerVerified: true` AND `stripeChargesEnabled: false`. The UI says "you're a verified seller" (Sell tab visible), but the Firestore rule says "you can't actually publish." That mismatch is what makes the error message at the publish step feel like a system bug rather than a user todo.
5. **Test-mode lingering data.** The founder's `stripeAccountId` is a pre-launch test-mode artifact (Bug 1). There's no cleanup migration that ran when the project flipped to live mode on 2026-04-17. **Other users may have the same issue** (per Admin SDK: 2 users have a `stripeAccountId` set, 0 have `stripeChargesEnabled: true` — meaning both stored ids are likely test-mode orphans).

### Stripe Connect funnel data (Firestore-derived, via Admin SDK)

- **Total users**: 23
- **`stripeAccountId` set**: 2 (8.7%) — both likely test-mode orphans
- **`stripeChargesEnabled = true`**: 0 (0%)
- **`isVerifiedSeller` or `sellerVerified` = true**: 7 (30.4%)
- **Sellers who completed full KYC**: **0**

Caveat: beta-stage data with N=23 is noisy and dominated by the founder + a few test accounts. PostHog dashboard (separate query in PostHog UI, no SDK key available locally) should be checked for the same funnel post-beta to get meaningful numbers. Specifically the founder should verify the `seller_intent` → `stripe_onboarding_start` → `stripe_onboarding_complete` event chain.

### Proposed redesign (wireframe-level)

#### Screen A — Home, first login post-signup (banner)
```
┌───────────────────────────────────────────────────┐
│  Welcome to TeeBox!                               │
│                                                   │
│   ┌────────────────────────────────────────────┐  │
│   │ 💸  Want to sell? Get paid first.          │  │
│   │  Set up payouts now — takes 3 min.         │  │
│   │  We won't take a cut until you sell.       │  │
│   │  [ Set up payouts ]    [ Maybe later ✕ ]   │  │
│   └────────────────────────────────────────────┘  │
│                                                   │
│  [Marketplace grid below]                         │
└───────────────────────────────────────────────────┘
```
- Show ONLY on first 5 home-tab views post-signup (track in `users/{uid}.onboardingNudgeCount`); user can dismiss with the ✕.
- Renders independent of "Sell intent" — proactive.
- "Maybe later" sets `onboardingNudgeDismissedAt`; banner re-surfaces after 7 days if still incomplete.

#### Screen B — Tap "Sell" tab (pre-listing payout check)
```
┌───────────────────────────────────────────────────┐
│  Before you list                                  │
│                                                   │
│  TeeBox needs your bank info before you can       │
│  publish a listing. This is a one-time setup —    │
│  next time you list, this step is skipped.        │
│                                                   │
│  ✓ Free to sellers                                │
│  ✓ 3 minutes via Stripe                           │
│  ✓ Daily payouts after each sale                  │
│                                                   │
│  [ Continue to Stripe ]   [ Save draft, do later] │
└───────────────────────────────────────────────────┘
```
- Replaces today's "fill the whole form first, THEN get blocked" flow.
- Triggered on `become-seller` action BEFORE opening the Sell modal, when `stripeChargesEnabled !== true`.
- "Save draft, do later" lets the user fill the form anyway, but Submit button shows "Set up payouts to publish" (disabled with tooltip) until KYC clears.

#### Screen C — Stripe Connect (external)
- Same Stripe-hosted page as today, BUT opened differently on iOS.

#### Screen D — Return from Stripe ("you're ready" screen)
```
┌───────────────────────────────────────────────────┐
│  🎉  You're ready to sell on TeeBox.              │
│                                                   │
│  Your payout setup is complete. Buyers can now    │
│  pay you, and Stripe will send earnings to your   │
│  bank daily.                                      │
│                                                   │
│  [ List your first item ]                         │
└───────────────────────────────────────────────────┘
```
- Triggered when URL contains `?stripe=onboarded` AND `stripeChargesEnabled` is now `true` (poll for up to 10s, surface the screen as soon as the webhook commits, fall back to a "Stripe is verifying — you'll get an email" state if the webhook hasn't fired by 10s).
- If user had a saved draft (Screen B "Save draft"), "List your first item" pre-fills the form.

### KYC timing recommendation

**Defer KYC until "Sell" tab is tapped, BUT show the proactive nudge from day 1.** Two reasons:
1. Buyers shouldn't be asked for bank info at signup — most users browse first.
2. The proactive nudge captures intent-curious users who would otherwise abandon when they discover the wall at step 4.

This matches what major peer-to-peer marketplaces (Poshmark, Depop, Mercari) do: payouts setup is gated at first-sell-intent, surfaced earlier as a passive banner.

### Capacitor in-app WebView vs Safari decision

**Recommendation: Safari (via `@capacitor/browser` plugin), NOT the in-app WebView.**

Reasoning:
- Stripe Connect Express onboarding sets multiple session cookies on `connect.stripe.com` that don't reliably persist across a `window.location.href` round-trip from the Capacitor app to Stripe and back. Users have reported being kicked back to step 1 of KYC after closing/reopening the app mid-flow.
- Identity document upload (live-mode requirement for the founder's region) needs camera access. WKWebView's camera-permission prompt is awkward inside a Capacitor shell; Safari's is native and well-understood by users.
- Universal links (`apple-app-site-association`) already cover `https://teeboxmarket.com/?stripe=onboarded` (path `/` is in the AASA), so Safari will deep-link the user back into the app on Stripe's "Done" click. This gives us the best of both worlds: trusted Safari for KYC, app return for the "you're ready" screen.

Implementation: add `pod '@capacitor/browser'` to ios/App/Podfile (currently NOT in there per ios/App/Podfile inspection), `npm i @capacitor/browser`, then change index.html:15336-15341 from `window.location.href = url` to `await Browser.open({ url })`. Effort: 15-30 min plus a Capacitor sync + TestFlight upload.

---

## Recommended fix order

1. **[5 min, immediate] Clear stale `stripeAccountId` on the founder doc.** One-shot Admin SDK update: `db.doc('users/l1Z3m8do75WKVbJm5HBwvCreJtx2').update({stripeAccountId: admin.firestore.FieldValue.delete(), stripeChargesEnabled: false, stripePayoutsEnabled: false, stripeDetailsSubmitted: false})`. Same for the other 1 user with a `stripeAccountId` set (whichever uid that is — sweep with `WHERE stripeAccountId != null AND stripeChargesEnabled = false` and clear if the live-mode retrieve throws "test account"). This **unblocks Bug 1 immediately** (next "Set up payouts" creates a fresh live-mode account) and gives the founder a path to test live-mode KYC end-to-end before any code lands.
2. **[10-30 min] Rotate `GEMINI_API_KEY`** to a billed Google AI Studio project. Fixes Bug 4. Independent of all other work.
3. **[30-60 min] Install Crashlytics on iOS.** Without this, every TestFlight crash report is invisible. Adds `pod 'FirebaseCrashlytics'`, the `import` in AppDelegate, `Crashlytics.crashlytics()` init call, and the dSYM upload build phase. Required even if no other code change ships.
4. **[1 hr] Rebuild iOS bundle: `npx cap sync ios`.** Fixes Bug 2 (brings the Stripe-precheck gate to iOS) and Bug 3 (brings the AI-price kill-switch). Plus a TestFlight build + upload (incremental ~45 min).
5. **[30 min] Defensive code in `getStripeAccountStatus`** (functions/index.js:4486-4509): catch `StripeInvalidRequestError` / `resource_missing` and self-heal by clearing the orphaned id. Prevents Bug 1 recurrence forever. Deploy.
6. **[1-2 hrs] Cap the unbounded queries listed under Bug 5** with `.limit(50)` defaults. Pre-emptive fix for iOS freezes once the user base grows past beta.
7. **[2-4 hrs, post-beta] Implement Bug F redesign** — proactive nudge banner + pre-Sell-tab KYC modal + `@capacitor/browser` for Stripe + return-success screen. Substantial UX work; can ship post-beta as a v1.1 conversion-rate fix.

## Total estimated effort

- **Beta-unblock minimum**: 5 min (founder doc fix) + 30 min (Gemini key) + 60 min (Crashlytics) + 60 min (cap sync iOS + TestFlight build) + 30 min (defensive code in `getStripeAccountStatus`) = **~3 hrs of active work**, plus TestFlight processing time (~30-60 min) before testers can be invited.
- **Including unbounded-query caps + Bug F redesign**: +3-6 hrs (would not block beta but smooths the experience).

## Beta upload unblock

**First 5 testers can be invited in ~4 hours from now**, assuming:
- 3 hrs of fixes per above
- 30 min TestFlight processing
- 30 min smoke test of the full publish flow on a clean device

If the Crashlytics install slips or the Gemini key rotation requires a billing-setup detour, push to next morning rather than ship blind to testers.
