# Post-Beta Fix Backlog

Tracked items NOT shipped in the pre-beta hardening pass (2026-05-17). Address before public launch.

---

## From the Stripe popup-blocker investigation (commit `44d1d82`)

### 1. `A['manage-subscription']` has the same popup-blocker bug
- **File**: `index.html:15316`
- **Issue**: `window.open(url, '_blank', 'noopener')` after `await fn()` — same pattern that broke Stripe Connect onboarding, same popup-blocker behavior on Chrome/Safari/Firefox
- **Impact**: Pro subscribers clicking "Manage subscription" hit the same silent-fail
- **Why deferred**: zero Pro subscribers exist yet (closed beta hasn't started). Not on critical path
- **Fix shape**: change `window.open(url, '_blank', 'noopener')` → `window.location.href = url` (mirror what the Stripe Connect fix did)
- **Effort**: 5 min

---

## From `LOGO_BINGO_LEADERBOARD_AUDIT_2026_05_17.md`

### 2. Logo Bingo B3 — Date convention mismatch (UTC vs Eastern)
- **Files**:
  - `index.html:16221` (`todayUTC()` — misnamed; actually returns Eastern via `America/New_York`)
  - `index.html:17119-17124` (the "Today" tab query — builds date using true UTC `getUTCFullYear/Month/Date`)
- **Issue**: writes use Eastern date as the key; reads ask for UTC date. For ~4 hours every day (UTC midnight → Eastern midnight = **19:00–23:00 CDT/CST**), the leaderboard's "Today" tab queries a date string that's one ahead of any score written, so it silently returns empty
- **Reproducer**: at 8 PM Central, open Logo Bingo → "Today" tab → empty leaderboard regardless of how many people solved
- **Validated against live data**: 4/4 production `gameScores` docs are keyed by Eastern date
- **Fix shape**: pick ONE timezone, use it everywhere. Recommend Eastern (since that's what writes use today). Rename `todayUTC()` to `todayEastern()`, update the query at `:17119-17124` to use the same helper
- **Effort**: 30-45 min (one helper rename + audit every caller)

### 3. Logo Bingo B2 — Zero-score docs pollute the leaderboard
- **Files**:
  - `firestore.rules:921` (rule allows `correctCount >= 0`)
  - `functions/bingoSync.js:147-221` (Admin SDK fanout has no `>= 1` guard)
  - `index.html:17119-17124` (leaderboard sorts by `correctCount DESC` only)
- **Issue**: a `gameScores` doc with `correctCount: 0` exists (founder, 2026-05-15). On a quiet day, zero-score docs appear at top of leaderboard
- **Fix shape**: add `&& correctCount >= 1` clause to the rule, the fanout filter, and the read query. Plus a one-shot cleanup script for the existing zero-score doc(s)
- **Effort**: 30-45 min

### 4. Logo Bingo — `solvedAt` Timestamp-vs-number guard fragility
- **File**: `functions/bingoSync.js:158`
- **Issue**: `Number.isFinite(solvedAt)` rejects Firestore Timestamp objects. The fanout silently skipped a production solve (founder, 2026-05-16) because `solvedAt` came in as a Timestamp instead of epoch ms
- **Fix shape**: normalize Timestamp → ms before the `isFinite` check (`const t = solvedAt instanceof admin.firestore.Timestamp ? solvedAt.toMillis() : solvedAt;`)
- **Effort**: 10 min

---

## From `SECURITY_AUDIT_2026_05_17.md` (post-beta items, not in scope of HIGH-1/2 or MEDIUM-1/2/3)

### 5. HIGH-1 Phase 2 — App Check enforcement flip
- **Files**: `firestore.rules` (`appCheckOk()` helper at lines 24-30 area) + functions/index.js (`enforceAppCheck: true` on 5 high-value callables: `createPaymentIntent`, `refundOrder`, `exportMyData`, `createStripeOnboardingLink`, `deleteMyAccount`)
- **Issue**: Phase 1 (client init) shipped 2026-05-17 in commit `7a8fb75`. Phase 2 is the enforcement flip.
- **Prerequisites**: 24-48h of dashboard monitor data confirming >95% of legitimate traffic is sending valid App Check tokens
- **Fix shape**: flip `appCheckOk()` from `return true` to `return request.app != null` + add `enforceAppCheck: true` to the 5 callables + flip dashboard services from Unenforced → Enforced
- **Rollback**: flip dashboard service back to Unenforced (instant, no code change) or revert the SHA
- **Effort**: 20-30 min once the monitor window completes

### 6. HIGH-3 / HIGH-4 — npm dependency vulns
- **Files**: `package.json` (root) → `@capacitor/assets` → transitive `tar` (8 HIGH, no upstream fix); `functions/package.json` → `prismjs` + `esbuild` (4 MODERATE)
- **Issue**: dev-tooling, not runtime production code
- **Fix shape**: pin to versions without vulns once upstream lands, OR add `npm audit --omit=dev` policy
- **Effort**: variable (waiting on Capacitor upstream)

### 7-15. Remaining MEDIUM/LOW security items
See `SECURITY_AUDIT_2026_05_17.md` Section 2 for full details. Highlights:
- MEDIUM-4: `config/*` documents readable by any authenticated user
- MEDIUM-5: Unicode lookalike bypass on PII detector
- MEDIUM-6 / MEDIUM-7: cross-user info disclosure via `priceHistory/{model}` and `globalStats/all`
- MEDIUM-8: spam-report attack via `reports/{reportId}` write rule
- MEDIUM-9: Cloud Vision fail-open on SafeSearch errors

---

## From `NOTIFICATION_AUDIT_2026_05_17.md` (deferred items, post-push-fix)

### 16. 11 unwired notification events
Per the audit's 33-event matrix — `NOT WIRED` events:
- New device sign-in security alert
- Listing about to expire
- Stripe Connect KYC incomplete reminder
- Payout sent vs payout paid
- Watchlist sold-to-someone-else (FOMO)
- Refund-issued push (email exists, push doesn't)
- Dispute-filed push (email exists, push doesn't)
- Email verification reminder (no reminder if user doesn't verify)
- Listing taken down by moderation reason notification
- Important platform announcement (broadcast)
- Account banned with reason

### 17. FCM token cleared-on-signout
- **File**: `index.html:5890-5949` (`window.signOut`)
- **Issue**: doesn't delete the device's token from Firestore on sign-out. Next user on the same device receives previous user's pushes
- **Severity**: MEDIUM (privacy + cross-account leak)
- **Effort**: 30 min

### 18. iOS in-app banner for declined push permission
- **File**: `index.html:6199-6260` (pre-permission modal exists; recovery banner does not)
- **Issue**: 30-day cooldown after "Maybe later" with no in-app reminder until cooldown expires. Users who tap declined never get a recovery prompt
- **Effort**: 1-2 hr (UI work)

### 19. Push smoke-test endpoint
- **File**: no producer exists
- **Issue**: there's no callable to fire a test push to a specific user's device. Debugging "my pushes aren't arriving" is painful
- **Fix shape**: callable `sendTestPush` that fires a "hello world" push to the calling user's tokens
- **Effort**: 30 min

---

## From `BUG_TRIAGE_2026_05_17.md`

### 20. Bug F — Seller onboarding redesign
- **Doc**: `BUG_F_ONBOARDING_REDESIGN.md` (full 4-screen wireframe)
- **Issue**: KYC discovery happens after a 5-min listing form. Recommended: proactive nudge banner on first home tab + pre-Sell modal before listing form opens
- **Effort**: 2-4 hr (v1.1 scope)

---

## Tracking

When an item ships, move it to `LAUNCH_READINESS.md` as ✅ FIXED and reference the commit SHA. Keep this doc focused on the active backlog so it shrinks visibly as work lands.
