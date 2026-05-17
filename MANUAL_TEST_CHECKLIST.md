# TeeBox Manual Test Checklist (TestFlight Beta)

**Updated**: 2026-05-17 (added BF1-BF6 pre-beta bug-fix verification block)

Hand this list to whoever does the TestFlight smoke. Run them in order; each should take 30s-2min. Items marked **(was EXPECTED FAIL, now FIXED)** are previously-broken paths that just landed — pay extra attention to those.

---

## Pre-beta bug-fix verification (run before inviting testers)

These tests verify the 4 fixes that landed on 2026-05-17. Run in order — each unblocks the next.

- [ ] **BF1 — Web live-mode Stripe Connect KYC** (PR 1): After PR 1 lands, sign in on web. Click "Set up payouts" (or "Become a seller" → fill form → "Submit Listing" which surfaces the prompt). Complete the FULL Stripe Connect Express flow with real bank/SSN data in LIVE mode. Confirm:
  - The Stripe-hosted page loads with no error toasts
  - After clicking "Done" in Stripe, return URL contains `?stripe=onboarded`
  - Within ~10 sec, `users/{your-uid}.stripeChargesEnabled` flips to `true` in Firestore (check via Firebase Console)
  - Subsequent "Submit Listing" succeeds — listing appears in marketplace
  - **This is the highest-value pre-beta smoke test. Per funnel data, 0 of 23 users have ever completed this end-to-end.**

- [ ] **BF2 — iOS Stripe handoff** (PR 2): After PR 2 lands AND a new TestFlight build is uploaded and installed, repeat the Stripe flow on iOS. Confirm:
  - "Set up payouts" opens Safari (NOT the in-app WebView) IF you've installed PR 6's `@capacitor/browser` change — for THIS round (build 55), it'll still use the in-app WebView; we're deferring the Safari migration to post-beta. Mark as "expected limitation" and move on.
  - Pre-listing precheck modal appears with the new "Your seller payouts aren't fully set up yet" copy (NOT "sign out, sign back in")
  - After KYC completes (if not already done in BF1), publish a listing on iOS — success

- [ ] **BF3 — iOS publish flow end-to-end** (PR 2): After BF2 confirms KYC works, on iOS: open Sell modal, fill a test listing, submit. Confirm:
  - Submit button shows loading state, not stuck
  - On success: listing appears in your shop tab + marketplace home
  - No misleading error toasts surface

- [ ] **BF4 — AI Write Description** (PR 3): After PR 3 lands, open Sell modal on web or iOS. Type a title (e.g., "Scotty Cameron Newport 2 putter"). Click "AI write description" (or whatever the button is labeled). Confirm:
  - Response arrives within ~3 sec
  - Generated text is reasonable English describing the item
  - Try 3 different titles to verify it's not a one-shot fluke
  - If it fails: error message should now say "Daily AI limit reached" (not the old "Couldn't generate")

- [ ] **BF5 — Crashlytics smoke** (PR 4): After PR 4 lands + new TestFlight build installed on iPhone:
  - Open the app, navigate to Settings
  - Find the small version-number text "TeeBox v1.5.0 (build 55)"
  - **Triple-tap the version number** within ~500ms
  - The app should immediately crash (this is the hidden test trigger)
  - Within ~5-10 min, open Firebase Console → Crashlytics → Issues tab
  - You should see a new crash entry: "TeeBox: Crashlytics test crash trigger"
  - If the tab is still empty after 30 min: the install didn't take — escalate

- [ ] **BF6 — Reproduce Bug 5 with Crashlytics on** (PR 4 follow-up): After BF5 confirms Crashlytics is receiving data, walk through screens where you previously saw freezes:
  - Bingo board (open Logo Bingo from home tab)
  - Watchlist (deep-scroll if possible)
  - Marketplace home (scroll past 50 listings)
  - Open a listing with many photos, swipe through gallery
  - Messages list (if any conversations exist)
  - Note the timestamp when any screen stutters or freezes
  - Check Firebase Console → Crashlytics → Issues sorted by "Last Seen"
  - Match timestamps; the issue stack trace tells us the actual offender (one of the 5 unbounded-query candidates from the triage report, or something else)
  - Report findings — this informs whether PR 5 (cap unbounded queries) is actually the right fix

---

## Auth

- [ ] **A1**: Email signup with a real address → verification email lands in <60s, link verifies (deep-links back to app on iOS)
- [ ] **A2**: Sign in with Apple on a fresh device → `users/{uid}` doc is created with a non-anonymous displayName
- [ ] **A3**: Same flow on web (Safari + Chrome) → popup completes, redirects back signed in
- [ ] **A4**: Forgot password → email arrives, link opens reset page, new password takes effect on next sign-in
- [ ] **A5**: Account → Delete account → type DELETE → confirm full deletion: profile shows "Deleted user" on completed orders; Stripe customer/account both terminated; auth record gone
- [ ] **A6**: Sign out → relaunch → land on guest browse. Sign back in → state restored
- [ ] **A7**: New signup → marketing-consent checkbox is visible, defaulted unchecked, submitting without checking it writes `users/{uid}.marketingConsent.granted=false`

## Seller

- [ ] **B1**: New seller with no Stripe Connect → Sell button → Stripe-required modal appears, "Set up payouts" routes to Connect onboarding. Complete KYC. Return → submitListing now succeeds
- [ ] ~~**[DEPRECATED 2026-05-17]** Send Stripe Connect test event from Dashboard to verify signature wiring — superseded by BF1 above, which exercises the real live-mode KYC → webhook → user-doc flow end-to-end.~~
- [ ] **B1b**: Try to create a listing in Firestore console as a user with `stripeChargesEnabled !== true` → rule blocks the write
- [ ] **B2**: Upload 1, 3, 6, 10 photos in sequence. Try $0.01, $10000.01, $0 → correct gate behavior
- [ ] **B2c**: Listing with >=$300 price requires 4 photos (verification photo)
- [ ] **B5**: Delete listing → disappears from feed, search, your shop

## Buyer

- [ ] **C8**: Place an order with Stripe test card `4242 4242 4242 4242` → success
- [ ] **C8a**: Test card `4000 0027 6000 3184` (3DS required) → 3DS prompt appears, completes
- [ ] **C8b**: Test card `4000 0000 0000 0002` (decline) → friendly error
- [ ] **C9**: Confirm `orders/{id}` doc exists, OrderPlacedBuyer + OrderPlacedSeller emails land within 5min (now with iPostal address + unsubscribe footer)
- [ ] **C6** (was EXPECTED FAIL, now FIXED): Send message → push notification fires on recipient device, in-app notification fires, email arrives after the 4h-throttle window
- [ ] **C6b**: Send message containing "venmo me at $cash" → interstitial warning. Server flags

## Fulfillment

- [ ] **D1**: Seller marks shipped (with tracking) → buyer gets OrderShipped email; carrier/tracking renders
- [ ] **D3**: Seller marks delivered → buyer gets DeliveredBuyer (7-day dispute window copy); seller gets DeliveredSeller (Stripe payout schedule copy). **No "48h inspection" anywhere**
- [ ] **D4**: Stripe payout fires per schedule → FundsReleased email lands
- [ ] **D5**: Buyer submits 4-star review → appears on seller profile; rating average updates
- [ ] **D7**: Buyer opens dispute → both parties get email; dispute appears in admin queue

## Messaging

- [ ] **E1**: Send 3 messages to a test account. Conversations list orders by most recent, unread badge correct
- [ ] **E5**: Block a user → their listings disappear from your feed, they cannot DM you
- [ ] **E6**: Report a listing → `reports/{auto}` doc appears and admin queue picks it up

## Profile / Settings

- [ ] **F3**: Toggle push notifications off → seller sends offer → no push
- [ ] **F4**: Pause emails for 30 days → next marketing email is blocked; transactional still fires
- [ ] **F6** (was EXPECTED FAIL, now FIXED): Account → "Download my data" → JSON file downloads with users/orders/listings/messages/reviews data
- [ ] **F6b**: Account → "Manage payouts" (only visible when Stripe Connect KYC is complete) → opens Stripe Express dashboard in new tab

## Admin

- [ ] **H1**: Sign in as `jakenair23@gmail.com` → `?admin=moderation` opens queue
- [ ] **H2**: Upload an NSFW image → photo deleted from Storage, listing flagged for review
- [ ] **H3**: Submit a user report → admin queue shows it. Test ban → user can't checkout
- [ ] **H4** (was EXPECTED FAIL, now FIXED): As admin, refund any order via the callable. Buyer receives refund email with "issued by admin" subject; balances correct

## Email pipeline (deliverability)

- [ ] **J-all**: Fire each of the 12 templates and check (a) rendering in Gmail web + iOS, (b) rendering in Apple Mail, (c) mail-tester.com score ≥ 9/10 for the 5 most-sent templates, (d) DKIM/SPF/DMARC all pass
- [ ] **J-footer**: Open OrderPlacedBuyer in inbox → physical address (`16649 Oak Park Ave, Ste H #1160`) is visible
- [ ] **J-welcome** (was EXPECTED FAIL, now FIXED): Fresh signup → welcome email arrives, rendered with `<Base/>` layout, footer compliant (iPostal address + unsub link)
- [ ] **J-smoke**: `curl -X POST -H "X-Smoke-Trigger: 1" https://us-central1-teebox-market.cloudfunctions.net/dailyEmailSmokeManual` → 200 OK + Firestore `emailSmokeRuns/{today}` updated. Now covers 6 templates (was 4)

## Edge cases

- [ ] **I2**: Drop network mid-checkout, retry → same PaymentIntent returned (no double-charge)
- [ ] **I4**: Background app for 5 min → return → still signed in, no spurious sign-out modal
- [ ] **G8**: Lighthouse Mobile audit on homepage → score ≥ 70 perf (homepage now has preconnect/dns-prefetch hints; if score is still <70, refer to `PERF_AUDIT.md` for phase-2 candidates)

## Logo Bingo

- [ ] **LB1**: Open Logo Bingo on web AND on iOS within the same UTC date → **same 9 logos in the same order**. Today's puzzle: `old-sandwich · pacific-dunes · castle-pines · sleepy-hollow · dedham-country-and-polo-club · atlanta-athletic-club · the-hay · shoreacres · bellerive`

## PostHog instrumentation verification (new)

- [ ] **PH1**: Sign in to web → trigger a tracked action (search, view listing, send message) → event appears in https://us.posthog.com/project/425810 activity feed within ~30s with your Firebase UID
- [ ] **PH2**: Same from iOS (TestFlight or simulator) → events tagged `deviceType: "ios"`

---

## What's still EXPECTED FAIL (known gaps post-fix)

- **C9b** (Shippo): "Print label & ship" button in OrderPlacedSeller goes to support.html#shipping instead of generating a label. v1 limitation — see `SHIPPING_LABELS_DEPLOY.md`
- **G1b** (Sitemap apex): `https://teeboxmarket.com/sitemap.xml` returns the static 45-URL file from GitHub Pages. Dynamic sitemap is at `https://teebox-market.web.app/sitemap.xml` — Path B (DNS migration) closes this. See `SITEMAP_DEPLOY.md`
- **HIGH-1** (OG tags for crawlers): Slack/iMessage in-app preview works because they execute JS. Twitter/Facebook share previews still show site-wide OG. v1 limitation
- **E7** (Ban-evasion): IP + card fingerprint capture now in place, but no device fingerprint yet (FingerprintJS is post-launch — see `BAN_EVASION_ROADMAP.md`)
- **CRITICAL #6** (2FA): No UI to enable 2FA. Producer + template exist for future wire-up; marketing surface is clean (no false claims)
