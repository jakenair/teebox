# Bug F — Seller Onboarding Redesign (post-beta v1.1)

**Status**: Deferred to v1.1 (post-closed-beta). Wireframe-level proposal, not yet scoped for implementation.

**Triage source**: BUG_TRIAGE_2026_05_17.md (the "## Bug F" section), expanded with the founder's safety-net Q&A from 2026-05-17.

## Problem

The Stripe Connect KYC wall is discovered too late, after the seller has invested 2-5 minutes filling out a listing form. Funnel data (snapshot 2026-05-17): 23 total users, 7 have flipped `sellerVerified=true`, but **0 have completed live-mode KYC** (`stripeChargesEnabled=true`). Friction concentrates at the moment of "Submit Listing," where the user hits a wall they had no prior visibility into. The redesign moves the KYC prompt earlier in the funnel (passive day-1 nudge + active pre-Sell-tap modal) and migrates the iOS handoff from in-app WebView to Safari via `@capacitor/browser` for cookie-state reliability.

1. Sellers don't learn payouts setup exists until they try to submit a listing — canonical form-abandonment anti-pattern.
2. iOS uses an in-app WKWebView for the Stripe-hosted form, which has known cookie-state and camera-permission issues.
3. `sellerVerified=true` is decoupled from `stripeChargesEnabled=true`, so the UI says "you're a seller" while the Firestore rule blocks publish.
4. Test-mode artifacts from pre-launch (the founder's stale `acct_1TTP7BPJFAmv2puf`) silently break the live-mode `accounts.retrieve` call with no self-healing path.

## Current flow (verified 2026-05-17)

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

## Friction points

1. **Hidden until step 4.** The seller fills out a listing form (title, brand, photos, description) — 2-5 minutes of work — BEFORE they discover the Stripe wall. This is the canonical "form abandonment" anti-pattern. **#1 leverage point.**
2. **No first-login nudge.** There's no "Welcome — finish payout setup" card on the home tab. The `renderStripeConnectBanner` (index.html:9995-10039) only renders inside the Payouts dashboard tab — which sellers don't visit until they expect payouts.
3. **In-app WebView for Stripe.** iOS uses `window.location.href` to navigate to Stripe inside the Capacitor WKWebView. Stripe's onboarding form has known issues with iframed/embedded WebViews: state loss on `Done`, occasional cookie partitioning issues, identity-document upload sometimes fails to access the camera roll without an explicit user-prompt the WebView can't trigger. **#2 leverage point.**
4. **`sellerVerified=true` decoupled from `stripeChargesEnabled=true`.** The founder's account is `sellerVerified: true` AND `stripeChargesEnabled: false`. The UI says "you're a verified seller" (Sell tab visible), but the Firestore rule says "you can't actually publish." That mismatch is what makes the error message at the publish step feel like a system bug rather than a user todo.
5. **Test-mode lingering data.** The founder's `stripeAccountId` is a pre-launch test-mode artifact (Bug 1). There's no cleanup migration that ran when the project flipped to live mode on 2026-04-17. **Other users may have the same issue** (per Admin SDK: 2 users have a `stripeAccountId` set, 0 have `stripeChargesEnabled: true` — meaning both stored ids are likely test-mode orphans).

## Stripe Connect funnel data (2026-05-17 snapshot)

Firestore-derived, via Admin SDK:

- **Total users**: 23
- **`stripeAccountId` set**: 2 (8.7%) — both likely test-mode orphans
- **`stripeChargesEnabled = true`**: 0 (0%)
- **`isVerifiedSeller` or `sellerVerified` = true**: 7 (30.4%)
- **Sellers who completed full KYC**: **0**

Caveat: beta-stage data with N=23 is noisy and dominated by the founder + a few test accounts. PostHog dashboard (separate query in PostHog UI, no SDK key available locally) should be checked for the same funnel post-beta to get meaningful numbers. Specifically the founder should verify the `seller_intent` → `stripe_onboarding_start` → `stripe_onboarding_complete` event chain.

## Proposed redesign (4 screens)

### Screen A — First-login banner
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

### Screen B — Pre-Sell pre-listing modal
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

### Screen C — Stripe-hosted onboarding (external)
Same Stripe-hosted page as today, BUT opened differently on iOS — via Safari through the `@capacitor/browser` plugin instead of the in-app WebView. See "How does it hand off to Stripe?" below for reasoning.

### Screen D — "You're ready" return screen
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

## Decisions

### When should KYC happen?

**Defer until first sell intent (tap "Sell" tab), BUT show a proactive nudge from day 1.**

Two reasons:
1. Buyers shouldn't be asked for bank info at signup — most users browse first.
2. The proactive nudge captures intent-curious users who would otherwise abandon when they discover the wall at step 4.

This matches what major peer-to-peer marketplaces (Poshmark, Depop, Mercari) do: payouts setup is gated at first-sell-intent, surfaced earlier as a passive banner.

### How does it hand off to Stripe?

**Safari via `@capacitor/browser` plugin, NOT in-app WebView, NOT Stripe Embedded Components.**

Reasoning:
- Stripe Connect Express onboarding sets multiple session cookies on `connect.stripe.com` that don't reliably persist across a `window.location.href` round-trip from the Capacitor app to Stripe and back. Users have reported being kicked back to step 1 of KYC after closing/reopening the app mid-flow.
- Identity document upload (live-mode requirement for the founder's region) needs camera access. WKWebView's camera-permission prompt is awkward inside a Capacitor shell; Safari's is native and well-understood by users.
- Universal links (`apple-app-site-association`) already cover `https://teeboxmarket.com/?stripe=onboarded` (path `/` is in the AASA), so Safari will deep-link the user back into the app on Stripe's "Done" click. This gives us the best of both worlds: trusted Safari for KYC, app return for the "you're ready" screen.

### What do we show users about KYC status?

The 4 screens above (A: passive day-1 banner, B: pre-Sell-tap modal, C: external Safari KYC, D: success return) plus a non-blocking banner that re-surfaces every 7 days if KYC remains incomplete (`onboardingNudgeDismissedAt + 7d`). After 5 dismissals (`onboardingNudgeCount >= 5`) the banner stops rendering, but the pre-Sell-tap modal (Screen B) still fires every time — Sell intent is the hard gate, the banner is just intent-curious nudging.

### Safety net — what if a seller publishes before KYC completes?

**Recommendation: stick with hard block at publish. Do NOT implement "list now, KYC later" for v1.1.**

Tradeoff table:

| Model | Pro | Con |
|---|---|---|
| Hard block at publish (current + redesign) | Money flow clean; no edge cases; Stripe-supported | Seller discovers wall at sell-intent = friction |
| List now, KYC at first sale | Lowest possible friction | Buyer pays → money sits → seller must KYC before payout. If seller never KYCs: refund chargebacks. Adds escrow-monitoring Cloud Function + refund-on-timeout + buyer notification flow. ~2-3 days of work. Operational complexity not worth marginal lift. |

Revisit "list now, KYC later" only if post-beta funnel data shows seller drop-off at the new pre-Sell modal exceeds ~30%.

## Implementation checklist (when v1.1 scope is approved)

1. Add `pod '@capacitor/browser'` to `ios/App/Podfile` + `npm i @capacitor/browser`
2. Replace `window.location.href = url` with `await Browser.open({ url })` at `index.html:15336-15341`
3. Add Screen A banner component — render conditionally based on `users/{uid}.onboardingNudgeCount < 5` + `!stripeChargesEnabled`
4. Add Screen B modal — fires on "Sell" tab click (the existing `become-seller` action) BEFORE the existing Sell modal opens
5. Add Screen D return screen — listen for `?stripe=onboarded` URL param + poll `getStripeAccountStatus` up to 10s
6. Add `users/{uid}.onboardingNudgeCount` + `users/{uid}.onboardingNudgeDismissedAt` fields
7. Update `firestore.rules` to allow user docs to write these new fields
8. PostHog events: `onboarding_banner_shown`, `onboarding_banner_dismissed`, `presell_modal_shown`, `presell_modal_continued`, `presell_modal_deferred`, `kyc_complete_returned`, `first_listing_after_kyc`
9. Update `MANUAL_TEST_CHECKLIST.md` with the new screens

## Estimated effort: 2-4 hours of code work + 1 hour of design polish + 30 min TestFlight rebuild
