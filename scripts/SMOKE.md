# Smoke walk — `scripts/smoke.mjs`

Re-run after every web release. It drives the real site in a phone-sized Chromium under Chrome's
**Slow 3G** preset (50 KB/s, 2 s RTT) and walks the money path end to end, stopping before any
card details are entered.

## What it does

| Leg | Steps | Network |
|---|---|---|
| Guest | cold load → first product card, scroll, open a listing, close | Slow 3G |
| Sign-up | tap Sell → auth screen → Create Account with a throwaway email; measures time to signed-in; retries and records the server-side account state | Slow 3G (falls back to Fast 3G and says so if it cannot complete) |
| List | admin-verifies the throwaway email, photo + category + apparel specs, Post it → "You're live" dialog | current profile |
| Buyer | second throwaway signs in, opens the test listing (expects "Seller is finishing setup — tap to get notified"), opens a real buyable listing, Buy Now → checkout opens → **STOP** | Slow 3G load, Fast 3G sign-in |

Every step is screenshotted to `smoke-out/`, and `smoke-out/report.json` lists loading states over
2 s, frozen buttons (clicked, still disabled, no outcome), console errors, failed requests, and the
cleanup result.

## Data it touches, and how it cleans up

- Creates **two throwaway Auth accounts** (`<tag>-seller@teeboxqa.dev`, `<tag>-buyer@teeboxqa.dev`)
  and **one test listing** titled `PW WALK TEST polo (delete me)` with one photo.
- Opening checkout places the normal 15-minute reservation on the real listing it buys from
  (`JAKE_LISTING` in the script, one of Jake's own) and leaves an *incomplete* PaymentIntent in
  Stripe (no charge).
- `finally` deletes the listing and its Storage objects, both accounts (plus their
  `users/`, `profiles/`, rate-limit and notification docs), and releases the reservation. If the
  script is killed mid-run, re-run it: cleanup is keyed by the throwaway uids and the listing title.

## Running

```
npx playwright install chromium          # once
gcloud auth application-default login    # Firestore/Auth admin on teebox-market
node scripts/smoke.mjs                   # production, full walk
BASE=http://127.0.0.1:8788 node scripts/smoke.mjs   # a local gzip-served copy
MODE=guest  node scripts/smoke.mjs       # read-only: cold load + browse, no accounts
MODE=signup node scripts/smoke.mjs       # stop after account creation
node scripts/smoke.mjs --pixel           # also report Meta pixel events (PageView, ViewContent,
                                         # AddToCart, InitiateCheckout) with content_ids / value
```

Baselines (iPhone 14, Slow 3G), 2026-10-19: before r349 first card 33 s and sign-up impossible
(30 s SDK timeout); after r349 first card ~8 s and sign-up ~5 s.
