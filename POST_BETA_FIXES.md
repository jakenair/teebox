# Post-Beta Fix Backlog

Tracked items NOT shipped in the pre-beta hardening pass (2026-05-17). Address before public launch.

---

## DISABLED PRE-LAUNCH — re-enable before public launch

Two automated daily jobs were paused on **2026-05-19** while pre-launch (to stop Anthropic credit burn + smoke-test email noise). **Dual mechanism** was used because the functions deploy is blocked by #22 — a code-only flag could not take effect without a deploy:

1. **Cloud Scheduler job PAUSED** — the immediate, deploy-free disable (effective now).
2. **Code feature-flag added** — keeps the schedule a no-op once #22 is fixed and the function is redeployed (a `firebase deploy` recreates the scheduler in the ENABLED state, so the flag is the durable guard).

Only the scheduled triggers are gated; the manual `*Manual` onRequest endpoints still work for on-demand runs.

### Daily founder briefings
- **Function**: `dailyFounderBriefing` (`functions/founderBriefing.js`) — 07:00 America/New_York; calls Anthropic API (burns credits); emails `jakenair23@gmail.com`.
- **Disabled via**: scheduler job `firebase-schedule-dailyFounderBriefing-us-central1` **PAUSED** + guard `if (process.env.DAILY_BRIEFINGS_ENABLED !== "true") return;` on the scheduled handler.
- **Re-enable (do BOTH)**:
  1. Set `DAILY_BRIEFINGS_ENABLED=true` in the function's runtime env, then redeploy `dailyFounderBriefing` (requires #22 resolved).
  2. `gcloud scheduler jobs resume firebase-schedule-dailyFounderBriefing-us-central1 --location=us-central1 --project=teebox-market`
  - A successful redeploy recreates the scheduler ENABLED, so step 2 may be redundant post-deploy — verify with `gcloud scheduler jobs describe`.

### Daily smoke-test emails
- **Function**: `dailyEmailSmoke` (`functions/emailSmokeTest.js`) — 04:00 America/New_York; sends Resend smoke emails (subjects `"… — Smoke"` / `"Smoke Test"`) to `SMOKE_EMAIL_INBOX`.
- **Disabled via**: scheduler job `firebase-schedule-dailyEmailSmoke-us-central1` **PAUSED** + guard `if (process.env.DAILY_EMAIL_SMOKE_ENABLED !== "true") return;` on the scheduled handler.
- **Re-enable (do BOTH)**:
  1. Set `DAILY_EMAIL_SMOKE_ENABLED=true` in the function's runtime env, then redeploy `dailyEmailSmoke` (requires #22 resolved).
  2. `gcloud scheduler jobs resume firebase-schedule-dailyEmailSmoke-us-central1 --location=us-central1 --project=teebox-market`

> **NOT disabled** (left running, by explicit decision 2026-05-19): `smokeProUpgrade` (`functions/smokeTest.js`, daily 04:00) — webhook-only Stripe-TEST Pro-upgrade smoke; sends no email; out of scope.

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

## From real-world testing (2026-05-17)

### 21. Photo upload preview stacks on top of the placeholder JPG icon
- **File**: `index.html:6884-6915` (`addFiles` / `renderPreviews` in the sell-listing photo upload component) and `index.html:4386-4393` (the `#uploadPreviews` and `#uploadZone` DOM siblings inside `.sell-form`)
- **Issue**: when the seller selects photos, the preview tiles render in `#uploadPreviews` while the placeholder upload zone (`#uploadZone` with its camera icon + "Click to upload or drag & drop" copy) stays visible underneath them. Visually this looks like the photos are stacked on top of the placeholder JPG / camera icon instead of replacing it. `renderPreviews` only toggles `uploadZone.style.display` to `none` when `selectedFiles.length >= 10` (the max) — for 1–9 photos the placeholder remains visible
- **Fix shape**: add a state flag like `hasPreviewPhotos` (or just key off `selectedFiles.length > 0`) and toggle the placeholder's `display` based on it inside `renderPreviews`. Specifically: change the existing `uploadZone.style.display = selectedFiles.length >= 10 ? 'none' : 'block'` to `'none'` whenever any photos are selected. Optionally surface a smaller "+ Add more" tile inside `#uploadPreviews` so the seller can still add more files without re-revealing the full placeholder
- **Effort**: 30-45 min
- **Status**: per founder spec — DO NOT FIX in build 57. Document only

---

## From the 2026-05-17 evening deploy push (post-Phase-1 of multi-fix)

### 22. Functions deploy discovery-phase hang (Monday AM investigation)
- **Symptom**: `firebase deploy --only functions` hangs at `i functions: Loading and analyzing source code for codebase default to determine what to deploy` for 5-15+ min with no progress. Hit at `FUNCTIONS_DISCOVERY_TIMEOUT=60`, 120, 300, 600, 900 (all fail). Earlier in the day a 600s timeout succeeded once (after the push-fix agent pre-flight); subsequent deploys after Agent X's content-moderation additions (commit `5439bcb`) consistently fail at 600s
- **Observed `require('./index.js')` time locally**: 245s in one isolated test on 2026-05-17 18:25 CDT
- **Suspected contributors** (Agent X flagged):
  - `bad-words@3.0.4` dictionary load + leet-folding setup at `functions/moderation/contentFilter.js` import
  - 7 new Firestore trigger declarations Agent X added to `functions/index.js`
  - Orphaned `firebase-functions /Users/.../functions` discovery server children after each killed deploy (5+ orphans accumulated before cleanup)
  - Node 22.x package-resolution overhead with `functions/index.js` declaring 49+ exports + many top-level requires
  - Local disk pressure on `/dev/disk1s2` (was at 98-99% earlier 2026-05-17; founder cleared ~7GB DerivedData + iOS DeviceSupport by 18:30 CDT → 48% capacity / 11GB free)
- **Impact today**: Agent X's content-moderation + unread-count Firestore triggers (commit `5439bcb`) are COMMITTED but NOT DEPLOYED. Client-side moderation toast (Agent Y, commit `c864d02`) is wired but dormant in production. Unread badge falls back to client-side count (intentional fallback Agent Y added). No regression from pre-Phase-1 behavior — just the new server-side protections aren't enforcing yet
- **Fix investigation steps** (run from clean shell Monday AM):
  1. `pkill -f "firebase-functions"` to clear orphan discovery procs
  2. Free additional cache: `npm cache clean --force` (in both root + functions/), `rm -rf ~/Library/Caches/Homebrew/*`, `rm -rf /tmp/*` (low urgency but cheap)
  3. Time the bare `require()`: `cd functions && time node -e "require('./index.js')"`. If still 200s+, profile with `--cpu-prof` to find the hot spot. If <120s, deploy with `FUNCTIONS_DISCOVERY_TIMEOUT=300` should land
  4. If `bad-words` is the culprit (dictionary load): consider lazy-init pattern — defer `new BadWordsFilter()` until first scan rather than at module load
  5. As a structural fix: split `functions/index.js` into per-domain modules (e.g. `functions/orders.js`, `functions/listings.js`) and wire via `Object.assign(exports, require(...))` like `founderBriefing.js` already does. The 6,307-line monolith is the underlying problem
- **Effort**: 30 min investigation, possibly 1-2 hr for the split if needed
- **Severity**: HIGH (every future functions deploy is at risk until this is resolved)
- **Update 2026-05-19 — late-night continuation** (post-EOD): **gcloud-direct deploy CONFIRMED as a working escape hatch for #22.** Both target functions (`updateListing` + `moderateListingOnUpdate`) deployed successfully via `gcloud functions deploy --gen2 --source=./functions` — Cloud Build chewed through the same require chain in seconds that hung 180+s locally. Wall-clock 106s / 101s. State=ACTIVE, gen2, Node 22, both matching the in-code `USER_CALLABLE` / `LIGHT_TRIGGER` configs. **Reference deploy commands** (template for future use until #22 is resolved structurally):
  ```
  gcloud functions deploy updateListing --gen2 --runtime=nodejs22 --region=us-central1 \
    --source=./functions --entry-point=updateListing \
    --trigger-http --allow-unauthenticated --memory=256Mi --timeout=30s \
    --project=teebox-market

  gcloud functions deploy moderateListingOnUpdate --gen2 --runtime=nodejs22 --region=us-central1 \
    --source=./functions --entry-point=moderateListingOnUpdate \
    --trigger-event-filters="type=google.cloud.firestore.document.v1.updated" \
    --trigger-event-filters="database=(default)" \
    --trigger-event-filters="namespace=(default)" \
    --trigger-event-filters-path-pattern="document=listings/{listingId}" \
    --trigger-location=nam5 --memory=256Mi --timeout=60s \
    --project=teebox-market
  ```
  Gotchas (cost ~30s on retry): Firestore database lives in **`nam5`** (not us-central1) so the Eventarc trigger requires `--trigger-location=nam5`; sister `moderateListingOnCreate`'s trigger config showed a `namespace=(default)` filter that the docs example omits — include it. `gcloud functions delete <name> --gen2 --region=us-central1 --project=teebox-market --quiet` for rollback (only one function name per `delete` invocation; gcloud rejects multiple positional args).
- **CRITICAL gotcha for gcloud-direct deploys**: `gcloud functions deploy` does NOT run npm `predeploy` hooks (those are a firebase-tools-only convention). `functions/emails-build/` (esbuild output, 362 MB, gitignored, regenerated by `cd functions && npm run build:emails`) **must exist on disk before any gcloud-direct deploy of an email-sending function** — anything that imports `./lib/email` and references the bundled templates (e.g. `sendMessage`, `dailyEmailSmoke`, the email-triggers cluster) — or the deployed function crashes at runtime on first send because the bundles aren't present in the uploaded source tarball. This is why we kept `emails-build/` on disk during disk hygiene rather than deleting it for 362 MB of reclaim. Rebuild before any gcloud-direct deploy of an email function: `(cd functions && npm run build:emails)`.
- **Open question for tomorrow** — **moderateListingOnUpdate didn't fire in the smoke test.** Both functions deployed cleanly; smoke flow exercised (created clean `listings/smoke-edit-test-<ts>` with `sellerId` marker, confirmed survived `moderateListingOnCreate`, updated title with profane string, polled 30s). Result: title was NOT reverted, and ZERO `moderationLog` rows written for the marker uid. **Per user instruction**: rolled back both functions immediately (deleted via gcloud), did NOT attempt diagnosis tonight. Hypotheses to test tomorrow (do not commit any of this until validated): (a) Eventarc trigger needs 5-10 min post-deploy propagation before it starts receiving events — 30s polling window may have been too short; (b) gcloud may not auto-wire IAM bindings that `firebase deploy` does (e.g., Eventarc/Cloud Run invoker bindings for the function's service account); (c) the `namespace=(default)` filter for Firestore default-namespace databases may need to be omitted on this database flavor (the docs example doesn't include it, but the sister `moderateListingOnCreate` does — needs verification). Repro recipe: redeploy via the same gcloud commands, then check `gcloud functions logs read moderateListingOnUpdate --gen2 --region=us-central1 --limit=20` after a test Firestore update to see if invocations are arriving.
- **Update 2026-05-19** (EOD investigation): step 4 (lazy-init `bad-words`) applied in `functions/moderation/contentFilter.js:85-91` as memoized `getFilter()`; 29/29 contentFilter tests still pass. Lazy-init wrappers ALSO drafted for `./lib/analytics`, `./banEvasion`, `./lib/email`, `./moderation/contentFilter` destructures at the top of `functions/index.js` — these are tangled in the working tree with uncommitted edit-listings WIP (`updateListing` + `moderateListingOnUpdate` at lines 5879/6008) and deferred. Three deploy probes (no-op redeploy of `moderateListingOnCreate`) at `FUNCTIONS_DISCOVERY_TIMEOUT` 10s/60s/180s ALL timed out exactly at the configured limit — discovery server starts (`Serving at port <N>`) and never determines a backend spec. DerivedData cleared (~2.6 GB recovered, 9.1 GiB free / 54% capacity); did not move the needle. **Conclusion**: lazy-init is necessary but insufficient on this machine. The deeper bottleneck is cold-I/O FS thrash on a disk-pressured laptop combined with the `Object.assign(exports, require("./xyz"))` cluster at `functions/index.js:6742-6869` — even with all heavy app-level SDKs deferred, walking the internal require tree exceeds 180s. **Step 5 (monolith split) is the remaining durable fix**, gated behind explicit user authorization — deferred to a focused future session. Pre-split alternatives worth trying first: deploy from a different machine / fresh boot / external SSD; or trigger deploy via Firebase Console bypassing local CLI discovery.

### 23. Disk-pressure monitoring + npm/Homebrew cache hygiene
- **Issue**: local dev machine hit 98-99% disk usage on 2026-05-17 ~17:00 CDT (4.1GB free on `/dev/disk1s2`). Caused `cp -R assets` to wedge for ~10 min during Agent Y's `build:web` step. Founder cleared ~7GB by removing DerivedData + iOS DeviceSupport, now at 48% capacity / 11GB free
- **What was hogging space** (founder's reported finds):
  - Xcode DerivedData
  - iOS DeviceSupport archives (older iOS SDK simulator support)
  - (Probable additional contributors not yet cleared: npm caches, Homebrew caches, `/tmp/*`, browser profiles, Docker volumes if any)
- **Fix shape** (preventive):
  - Add a recurring (e.g. `launchd` plist or weekly script) cleanup: `rm -rf ~/Library/Developer/Xcode/DerivedData/*`, `xcrun simctl delete unavailable`, `npm cache clean --force`, `brew cleanup -s --prune=all`
  - Monitor via `df -h /` in a startup banner or as part of `npm run build:web`'s preamble — abort the build with a clear error if `<5GB free` rather than hanging
- **Effort**: 30-60 min (a small `scripts/preflight-disk-check.mjs` + plist)
- **Severity**: MEDIUM (recurs naturally as Xcode builds accumulate; flagged because it ate ~30 min of agent runtime on 2026-05-17)

---

## Tracking

When an item ships, move it to `LAUNCH_READINESS.md` as ✅ FIXED and reference the commit SHA. Keep this doc focused on the active backlog so it shrinks visibly as work lands.
