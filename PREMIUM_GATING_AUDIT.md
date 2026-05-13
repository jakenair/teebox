# TeeBox Premium-Feature Gating Audit

Audit date: 2026-05-12
Scope: every Pro-tier gate in source (client `index.html`, Cloud Functions, Firestore rules) and every Pro-tier marketing claim in user-facing copy. Build outputs (`dist 2/`, `ios/App/App/public/index.html`, `android/app/src/main/assets/public/index.html`) are static copies of `index.html` and inherit its behaviour — they were spot-checked and contain the same gates with the same line shapes; they aren't double-listed.

The bar (per the user's spec):

1. Every Pro-tier feature must be **gated server-side**.
2. Every gate must **read fresh data**.
3. Every gate must **fail closed** (default to `'free'` on error).
4. Every gate must **show an upgrade CTA** to free users at the point of the gate.

Plus: every advertised premium feature must have a corresponding gate.

---

## TOP-LINE VERDICT

**The fee gate is correct.** `functions/index.js:339` reads `sellerData.tier` from a freshly fetched `users/{sellerId}` doc on every payment intent, uses strict `=== "pro"` equality (defaults to `"free"` on undefined/null/anything else), and applies 3% vs 6.5% based on server constants. Free users cannot fabricate a Pro tier via Firestore: the rules whitelist on `match /users/{userId}` (`firestore.rules:209`) excludes `tier` from the allowed client-writable keys. Net: no path from a free seller to the 3% fee.

But the marketing copy in the **Pro upgrade modal** (`index.html:2826-2862`) advertises **four** benefits. Only **one** is actually implemented as a gate (3% fee). The other three are either unenforced or partly cosmetic — see the reverse audit below for the bait-and-switch risk.

---

## Phase 1 — Forward Audit (every gate in code)

### 1.1 Every premium-tier reference in source

Grep results, filtered to source files (excluding `node_modules`, `dist 2/`, `ios/`, `android/`, build artefacts):

| # | File:line | Code | Category |
|---|---|---|---|
| 1 | `functions/index.js:339` | `const sellerTier = sellerData.tier === "pro" ? "pro" : "free";` | **Server gate (GOOD)** — the only revenue-relevant gate |
| 2 | `functions/index.js:340-342` | `const feeRate = sellerTier === "pro" ? PLATFORM_FEE_PERCENT_PRO : PLATFORM_FEE_PERCENT;` | **Server gate (GOOD)** — applies fee |
| 3 | `functions/index.js:65-66` | `const PLATFORM_FEE_PERCENT = 0.065; const PLATFORM_FEE_PERCENT_PRO = 0.03;` | Constants |
| 4 | `functions/index.js:631-634` | `PRO_ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"])` | Tier-state-machine input |
| 5 | `functions/index.js:640-651` | `mirrorTierToProfile(uid, isPro)` | Writes `profiles/{uid}.isPro` |
| 6 | `functions/index.js:653-700` | `handleSubscriptionUpsert(sub)` — writes `users/{uid}.tier`, mirrors to profile, `revokeRefreshTokens` | **Server write** |
| 7 | `functions/index.js:683` | `await userDoc.ref.set(update, {merge: true})` | Writes `tier` |
| 8 | `functions/index.js:685` | `await mirrorTierToProfile(userDoc.id, update.tier === "pro")` | Mirrors |
| 9 | `functions/index.js:690` | `await admin.auth().revokeRefreshTokens(userDoc.id)` | **Cache invalidation (GOOD)** |
| 10 | `functions/index.js:702-717` | `handleSubscriptionDeleted` — writes `tier: "free"` | **Server downgrade** |
| 11 | `functions/index.js:710` | `tier: "free"` (on delete) | Forces free on cancel |
| 12 | `functions/index.js:1646` | `tier: "free"` (in create-user flow) | Default value for new users |
| 13 | `functions/index.js:4293` | `if (user.tier === "pro" && user.proSubscriptionId) { throw "already-exists" }` | Idempotency check on second Checkout |
| 14 | `firestore.rules:204` | `hasOnly(['phone','termsAgreed','termsAgreedAt','displayName','watchlist','blocked'])` on `users/` create | **Rule (GOOD)** — `tier` excluded from client-writable keys |
| 15 | `firestore.rules:210` | Same on `users/` update | **Rule (GOOD)** |
| 16 | `firestore.rules:527-538` | `hasOnly(['displayName','bio','avatarUrl','location','handicap','golfBag','pinnedListingId','updatedAt'])` on `profiles/` create + update | **Rule (GOOD)** — `isPro` excluded from client-writable keys |
| 17 | `index.html:6541` | `const isPro = !!(prof && prof._user && prof._user.isPro);` (inside `hydrateSellerProPills`) | **Display-only (BENIGN)** — paints Pro pill on listing cards |
| 18 | `index.html:8944` | `tier = data.tier === 'pro' ? 'pro' : 'free';` (inside `renderProTierBanner`) | **Display-only (BENIGN)** — paints banner copy |
| 19 | `index.html:8948` | `if (tier === 'pro') { … }` (banner render branch) | **Display-only (BENIGN)** |
| 20 | `index.html:12195` | `const isPro = pSnap.exists() && pSnap.data() && pSnap.data().isPro === true;` (inside `loadProfile`) | **Display-only (BENIGN)** — feeds the profile-modal Pro pill |
| 21 | `index.html:12204` | `isPro: u.tier === 'pro' || isPro,` (combines private + public flags) | **Display-only (BENIGN)** |
| 22 | `index.html:12207`, `12213`, `12295` | Various fallbacks defaulting `isPro: false` | **Fails closed (GOOD)** |
| 23 | `index.html:12297` | `if (u.isPro) { badges += <span class="pro-pill">Pro Seller</span> }` | **Display-only (BENIGN)** |
| 24 | `index.html:13571-13588` | `A['open-pro-upgrade']` — opens upgrade modal (signed-in check, iOS guard) | UI handler |
| 25 | `index.html:13589-13628` | `A['upgrade-to-pro']` — calls `createSubscriptionCheckout` callable | UI handler |
| 26 | `index.html:13629-13659` | `A['manage-subscription']` — calls `createBillingPortalSession` callable | UI handler |

**Categorisation tally:**

- Server gates with revenue impact: **1** (`functions/index.js:339-342`, the fee calc)
- Server state writes (tier transitions): **3** (`handleSubscriptionUpsert`, `handleSubscriptionDeleted`, `mirrorTierToProfile`)
- Server idempotency check: **1** (`createSubscriptionCheckout` line 4293)
- Firestore-rule deny-list entries: **3** (`users/` create + update, `profiles/` update)
- Client display-only Pro reads: **7** (pill in listing cards, profile modal, dashboard banner)
- Auth-token cache invalidation: **1** (`revokeRefreshTokens` on tier change)

There is **no client-only gate that controls a paid feature**. The only "gate" on the client is the dashboard banner copy and the `Pro Seller` badge — both display-only.

### 1.2 Per-gate 4-bar table

Listing only gates that actually control behaviour (not purely cosmetic display) plus the cosmetic ones for completeness:

| File:line | Feature being gated | Server-side? | Fresh data? | Fails closed? | Upgrade CTA shown? |
|---|---|---|---|---|---|
| `functions/index.js:339` | Platform fee rate (3% vs 6.5%) | **Yes** — runs inside the `createPaymentIntent` HTTP handler with Admin SDK | **Yes** — `await db.collection("users").doc(reservation.sellerId).get()` at line 327-329, no cache | **Yes** — `sellerData.tier === "pro" ? "pro" : "free"`; undefined/null/missing/anything-else falls to `"free"` → 6.5% | N/A — server-side, no UI surface |
| `functions/index.js:4293` | Block second concurrent subscription | **Yes** — callable | **Yes** — `await userRef.get()` line 4288 | **Yes** — `user.tier === "pro"` is false when undefined → falls through to Checkout creation, which is the correct path for non-Pro users | N/A |
| `functions/index.js:653-700` | Tier state transitions on subscription events | **Yes** — Stripe webhook | **Yes** — reads event payload + customer lookup, fresh DB | **Yes** — uses explicit `PRO_ACTIVE_STATUSES` Set; statuses not in either set leave tier unchanged (no privilege escalation) | N/A |
| `firestore.rules:204,210,527-538` | Block client writes to `tier`/`isPro` | **Yes** — Firestore Security Rules | **Yes** — evaluated at write time | **Yes** — `hasOnly()` whitelist means *anything* not in the list (including `tier` and `isPro`) is rejected | N/A |
| `index.html:8929` `renderProTierBanner` | Dashboard banner: upsell vs Pro status | No (cosmetic) | **Yes** — fresh `await getDoc(doc(db,'users',u.uid))` every render; not cached | **Yes** — `try { … } catch (_e) { /* fall through to free */ }`; on read error, `tier` stays `'free'` → user sees the upgrade CTA, which is the safe failure direction | **Yes** — line 8979 renders `<button data-action="open-pro-upgrade">Upgrade to Pro</button>` when `tier !== 'pro'` |
| `index.html:6527` `hydrateSellerProPills` | Pro pill on other sellers' listing cards | No (cosmetic) | **Stale risk** — uses `PROFILE_CACHE` (per-tab in-memory map; populated on first `loadProfile` and held until the tab is reloaded or the cache is cleared on logout via line 5232) | **Yes** — falsy `isPro` skips the pill | N/A — buyer-facing, no CTA expected |
| `index.html:12173` `loadProfile` | `_user.isPro` for profile-modal badge | No (cosmetic) | **Stale risk** — same `PROFILE_CACHE`. For the *signed-in viewer's own* profile, this reads `users/{uid}` directly (fresh) and OR-combines with the public mirror | **Yes** — defaults `_user.isPro: false` on every error path | N/A |

### 1.3 Primary gate deep-dive: `createPaymentIntent`

Read `functions/index.js:300-345`:

- Line 327-329: `const sellerSnap = await db.collection("users").doc(reservation.sellerId).get();` — fresh Firestore read, no cache.
- Line 330: `const sellerData = sellerSnap.exists ? sellerSnap.data() : {};` — fails closed: if the seller doc doesn't exist for some reason, sellerData is `{}`, and `{}.tier === "pro"` is false → 6.5% fee.
- Line 339: `const sellerTier = sellerData.tier === "pro" ? "pro" : "free";` — strict equality; any value other than the exact string `"pro"` (including `undefined`, `null`, `"Pro"`, `"PRO"`, numbers, etc.) maps to `"free"`. Safe.
- Line 340-342: applies `PLATFORM_FEE_PERCENT_PRO = 0.03` when Pro, else `PLATFORM_FEE_PERCENT = 0.065`. Matches the advertised rates.
- Line 343: `Math.round(reservation.priceCents * feeRate)` — integer cents, no floating-point drift across many sales.
- Runs on **every** payment intent (the function has no across-call cache).

**Verdict: GOOD.** All four bars met for the revenue-relevant gate.

### 1.4 Subscription-change cache invalidation

`handleSubscriptionUpsert` (`functions/index.js:653-700`):

- Line 683: writes the new `tier` to `users/{uid}` (server write — passes the rules deny-list).
- Line 685: mirrors `isPro` to `profiles/{uid}` so buyers' UIs see the badge change.
- Line 690: `await admin.auth().revokeRefreshTokens(userDoc.id)` — **forces token refresh on next client request**. This guarantees any code that ever uses custom claims is invalidated. Today nothing uses custom claims, so this is belt-and-suspenders, but it's correct and future-proof.

Client side:

- The fee gate reads Firestore at call time, so no client cache matters there.
- `renderProTierBanner` re-reads Firestore on every dashboard open — fresh.
- `loadProfile` caches in `PROFILE_CACHE` (in-memory Map) for the tab's lifetime. **This is the only staleness window for the Pro pill on listing cards / other sellers' profile modals.** Effect: a seller who cancels Pro could keep their badge visible to buyers in the buyer's *open tab* until the buyer refreshes; once cleared on logout (line 5232) or via tab reload, fresh data is fetched. No revenue impact — the fee calc doesn't care about this cache.

---

## Phase 2 — Reverse Audit (every advertised premium feature)

### 2.1 Marketing claims found

**Source 1: Pro upgrade modal** (`index.html:2826-2862`):

1. "3% transaction fee instead of the standard 6.5% — keep more of every sale." (line 2837)
2. "Pro Seller badge on every listing — buyers see you're a trusted, high-volume seller." (line 2841)
3. "Priority support — disputes and payout questions get fast-tracked." (line 2845)
4. "Cancel anytime — manage your subscription from the same dashboard." (line 2849)

**Source 2: Dashboard banner** (`index.html:8974-8980`):

5. "Cut your transaction fee from 6.5% to 3% for $14.99/month." (line 8977 — restates claim #1)

**Source 3: `terms.html:154`:**

6. "Pro Sellers: 3% of the item sale price, available with a TeeBox Pro Seller subscription at $14.99 per month." (restates claim #1)

**Source 4: `STRIPE_PRO_SETUP.md`** (internal doc, not user-facing):

- `tier=pro → 3% fee, 6.5% otherwise` — restates claim #1.

**Source 5: `privacy.html:196-197`, `refunds.html:178-180`:**

- Only describes billing mechanics (Stripe / Apple / refund window). Not benefit claims.

### 2.2 Claim → gate mapping

| # | Claim | Implementation in code | Status |
|---|---|---|---|
| 1 | **3% transaction fee** instead of 6.5% | `functions/index.js:339-343` reads fresh `users/{sellerId}.tier`, applies 0.03 vs 0.065 | **GATED CORRECTLY** |
| 2 | **Pro Seller badge** on every listing | `hydrateSellerProPills` (`index.html:6527`) paints `<span class="pro-pill">Pro</span>` on listing cards when `_user.isPro`. Data sourced from `profiles/{uid}.isPro` mirror (`functions/index.js:640-651`), written by webhook. | **GATED CORRECTLY** (purely a badge — no behavioural privilege, no enforcement needed beyond writing the mirror server-side, which is done) |
| 3 | **Priority support** — disputes & payout questions fast-tracked | Searched `functions/*.js` for any `priority`/`priorityFlag`/`isPro`-keyed branching in email triggers, dispute handlers, or push: **none.** Pro subscribers' emails to `hello@`/`dmca@`/`disputes@` get no flag, no separate inbox, no SLA marker, no metadata. | **OVER-PROMISED / MISSING** — see HIGH bug below |
| 4 | **Cancel anytime** — manage from dashboard | `A['manage-subscription']` (`index.html:13629`) opens Stripe Billing Portal via `createBillingPortalSession` callable (`functions/index.js:4346`). Stripe Portal supports cancel. On iOS, banner instructs user to manage at teeboxmarket.com. | **GATED CORRECTLY** |

### 2.3 Specific findings the user asked about

| Check | Finding |
|---|---|
| Listing rank boost for Pro | `buildProducts` (`index.html:6390`) + `applyFilters` (`index.html:6310`) sort by `price-asc / price-desc / brand / discover / newest` only. No `tier` weighting. Pro confers no rank advantage. — Not claimed in marketing; no mismatch. |
| Verified badge for Pro | The Pro pill *is* the badge. `hydrateSellerProPills` paints it. — Matches claim #2. |
| Listing limits | `submitListing` (`index.html:6022`) has no quota check. No `MAX_LISTINGS` / `activeListings` cap by tier in client or in functions. — Not claimed in marketing; no mismatch. |
| Pro-only analytics | `renderShopStats` / `openShopDashboard` (`index.html:8381+`) render the same widgets for all sellers (Total Revenue, Items Sold, Active Listings, Avg Sale, Total Views, Conversion Rate, Revenue Over Time). No Pro-gated dashboard surface. — Not claimed in marketing; no mismatch. |
| Featured slot for Pro | The hero featured carousel (`heroFeatured` in `index.html:3887`) is not Pro-keyed; the `pinnedListingId` feature is available to all sellers via the profile edit. — Not claimed in marketing; no mismatch. |
| Pro-only categories | `sellCat` options (`index.html:4094`) are static, not tier-gated. — Not claimed; no mismatch. |
| Fee structure differentials beyond 3%/6.5% | Searched for tier-keyed shipping subsidy, withdrawal-fee waiver: **none.** 3% vs 6.5% is the only differential. — Matches claim #1. |
| Priority support flag in inbound email | Grep across `functions/` for `priority` returned only the FCM `priority: "high"` for push, unrelated to tier. — Mismatch with claim #3. |

---

## Critical bugs & fixes

### HIGH-1: "Priority support" is advertised but not implemented

**Claim** (`index.html:2845`): "Priority support — disputes and payout questions get fast-tracked."

**Reality:** No code path treats messages from a Pro user differently. Inbound emails to `hello@teeboxmarket.com` / `dmca@teeboxmarket.com` arrive in the same queue. Outgoing email triggers (`functions/emailTriggers.js`, `functions/emails/`) don't tag the sender's tier. No Zendesk-style priority flag, no SLA marker, no separate inbox routing.

**Severity:** HIGH — false advertising. A Pro subscriber paying $14.99/mo who quotes this feature in a dispute will be correct that they were told they'd get fast-tracked. If TeeBox is unable to demonstrate the fast-track existed, this is a consumer-protection risk (CA/EU "misleading commercial practices"), and any reasonable refund request based on "promised feature not delivered" is hard to refuse.

**Fix sketch (don't apply, per audit instructions):**

- Option A — soften the copy. Edit `index.html:2845` to "Priority responses from the TeeBox team" only if there's a real (even manual) SLA Pro subscribers get. Anything more than that needs supporting infrastructure.
- Option B — implement the feature. Plumb the sender's `users/{uid}.tier` into inbound-email auto-classification (e.g., the existing email-trigger handler could look up the sender by `from:` email → uid → tier, and prepend `[PRO]` to the subject before forwarding to support). Combine with a documented internal SLA (e.g., 1 business day for Pro, 3 for free).
- Option C — remove the claim entirely from the upgrade modal until built.

Recommended: **Option C** for the immediate release; revisit with **Option B** once the support workflow is operationalised.

### MED-1: `loadProfile` profile-modal Pro badge can lag on cancel

**File:** `index.html:12173-12215` (`loadProfile`).

**Behaviour:** `PROFILE_CACHE` is an in-memory Map keyed by uid; first read of a profile in a session is fresh, subsequent reads in the same tab are served from cache. If seller X cancels Pro, buyer Y (who has X's profile already cached) will continue to see the "Pro Seller" pill on listing cards and on X's profile modal until: (a) Y reloads the page, or (b) Y logs out (which calls `PROFILE_CACHE.clear()` at line 5232), or (c) the explicit invalidations at lines 13039/13076 fire.

**Severity:** MED — cosmetic only. The 3% fee gate reads Firestore live, so canceled-Pro sellers immediately pay 6.5% on the next sale regardless of the cache.

**Fix sketch:** Add a TTL to the cache (e.g., 5 min) or invalidate cached entries when their `isProUpdatedAt` differs from the cached copy. Lower-cost alternative: bust the cache on Firebase `onSnapshot` of `profiles/{uid}` for the seller of any visible listing — overkill for a cosmetic pill.

### LOW-1: `renderProTierBanner` fails open in *one* direction

**File:** `index.html:8929-8982`.

**Behaviour:** On Firestore read error, `tier` stays `'free'`, so a Pro user who hits a transient Firestore outage briefly sees the free-tier "Upgrade to Pro" banner with `data-action="open-pro-upgrade"`. If they click it, `createSubscriptionCheckout` (`functions/index.js:4271`) re-reads Firestore directly and throws `already-exists` (line 4294-4298) — the toast at `index.html:13619-13620` informs them. So no double-charge, just a confusing UX moment.

**Severity:** LOW — UX glitch, not a revenue or security issue.

**Fix sketch:** On the catch branch in `renderProTierBanner`, render a neutral "Loading subscription status…" placeholder rather than the upsell, so a Pro user never sees the upgrade prompt during a transient outage.

### COSMETIC-1: iOS native users see no Pro upsell at all

This is **intentional and correct** per Apple Guideline 3.1.1 (digital subscriptions in-app must use IAP). `index.html:8968-8973` returns empty HTML for free users on Capacitor native. Both the modal handler (`13577-13580`) and the Checkout callable (`13593-13597`) refuse on native. Free iOS users learn about Pro from `teeboxmarket.com` instead. Pro iOS users see a status-only banner with "Manage at teeboxmarket.com" copy (line 8958).

Not a bug — flagging only to confirm it's deliberate. The flow is documented at `STRIPE_PRO_SETUP.md:19-22`.

### COSMETIC-2: Pro pill anchored to the wrong source-of-truth on stale data

`index.html:12204`: `isPro: u.tier === 'pro' || isPro`. For the signed-in viewer's *own* profile, this prefers the private `users/{uid}.tier` (always fresh because the viewer can read their own user doc). For other users' profiles, `users/{uid}` is unreadable (rules block cross-user reads), so the OR falls through to the public mirror `profiles/{uid}.isPro`. This is the correct design pattern — flagging just to confirm the OR isn't a bug.

---

## Open questions for the user

1. **Priority support (HIGH-1):** is there a real internal SLA for Pro subscribers in 2026-05? If yes, I missed the routing. If no, the modal copy at `index.html:2845` should be edited or removed before next release. Which path do you want?
2. **iOS App Store IAP plans:** the current code defers Pro to web on iOS. Once Apple enrollment is approved (your memory notes 2026-04-26 enrollment, 24-48h pending), do you plan to add IAP-backed Pro inside the iOS app? If so, the `tier` state machine has to accept Apple receipts as a parallel source-of-truth alongside Stripe — that's a non-trivial expansion of `handleSubscriptionUpsert`.
3. **Profile cache TTL:** the in-tab `PROFILE_CACHE` can stale-show a "Pro Seller" pill for a canceled seller until the buyer reloads. Worth adding a TTL, or accept the cosmetic lag?

---

## Summary numbers

- **Total Pro-tier code references:** 26 (table 1.1).
- **Server-side gates:** 1 revenue-relevant (`createPaymentIntent`), 3 state-transition handlers (`handleSubscriptionUpsert/Deleted`, `mirrorTierToProfile`), 1 idempotency check (`createSubscriptionCheckout`).
- **Firestore-rule deny-list entries:** 3 (`users/` create+update, `profiles/` update — both correctly exclude `tier`/`isPro`).
- **Client-only gates that control sensitive behaviour:** 0.
- **Client display-only references:** 7 (all default to free on error).
- **Advertised Pro features:** 4 (in the upgrade modal).
- **Gated correctly:** 3 of 4 (3% fee, Pro badge, cancel anytime).
- **Missing / over-promised:** 1 of 4 (priority support).
