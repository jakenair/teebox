# TeeBox — iOS Device Push (FCM→APNs) Plan

**Date:** 2026-06-05
**Type:** DESIGN / RECON ONLY. No code written, nothing deployed. Read-only audit of existing plumbing + forward plan.
**Scope:** device push for (A) new inquiry/chat messages and (B) new offers, on iOS via Capacitor.

---

## 0. Headline — this is NOT greenfield. It is ~90% built.

A near-complete FCM→APNs stack already exists end-to-end: server-side send triggers for both target events, a central `sendPush` helper, device-token storage with Firestore rules, web **and** native client registration code, iOS entitlements, `GoogleService-Info.plist` wired into Xcode, a deep-link tap router, and even rich-push notification-extension Swift source on disk.

**The feature does not need building. It needs the iOS-native last mile finished and the whole loop verified on a real device.** The single most important finding is a **token-type mismatch** (§4) that almost certainly means no iOS device is receiving pushes today even though every other piece is in place.

This plan therefore reframes from "build push" to **"close the iOS token gap, then verify."**

---

## 1. What already fires on new-message / new-offer create (Q1)

Both events have **three separate onCreate producers** with clean separation of concerns — in-app, email, and push are independent, so there is **no duplication risk**.

### New message — `conversations/{cid}/messages/{messageId}` (onCreate, path verified correct)
| Function | file:line | Does |
|---|---|---|
| `notifyOnNewMessage` | `functions/index.js:4159` | In-app `writeNotification(kind:"new-message")` + throttled Resend email (4h/thread). **No push.** |
| `pushOnNewMessage` | `functions/pushTriggers.js:490` | **Sends the device push** → `sendPush(recipientId, …, "messages")`. Presence-gated (skips if recipient is viewing the thread), burst-coalesced via `pushPending/*`. |
| `incrementListingMessage` | `functions/index.js:2493` | Bumps `listings/{id}.messageCount`. No notify. |

> Historical bug status: the old top-level `messages/{messageId}` trigger that never fired is **commented out** (`index.js:1773`); the live trigger listens on the correct subcollection path. **Fixed.**

### New offer — `offers/{offerId}` (onCreate)
| Function | file:line | Does |
|---|---|---|
| `notifyOnOfferCreated` | `functions/index.js:4006` | In-app `writeNotification(kind:"offer-received")` + Resend email (`OfferCreated`). **No push.** |
| `pushOnOfferCreated` | `functions/pushTriggers.js:83` | **Sends the device push** → `sendPush(sellerId, …, "offers")`. |

**Where FCM "slots in": it already has.** `sendPush` IS the push channel. No new send-site is needed for either event. The only reason to touch these functions later is to tweak payload/copy — not to add push.

### The in-app store is `users/{uid}/notifications/*`, not `__notifCache`
There is **no `__notifCache`** anywhere in the tree (the brief's term). The in-app notification center is the `users/{uid}/notifications/{notifId}` subcollection, written by `writeNotification()` (`index.js:3917`). The client subscribes to it for the badge/inbox. Push is a parallel channel to this, not a consumer of it — so an FCM send does not double-notify the in-app center.

### Double-send guard already exists
A legacy fan-out, `pushNotificationDispatch` (`index.js:3742`, onCreate on `users/{uid}/notifications/*`), also called `admin.messaging()`. It is **kill-switched OFF** by default (`config/features.legacyPushDispatch`, fails closed) so `pushTriggers.js` is the sole canonical push path. ⚠️ **Do not re-enable it** — that would double-push every notification.

---

## 2. onCreate vs at-risk onUpdate (Q2)

✅ **Both target events ride safe `onDocumentCreated` triggers.** New-message push = onCreate on the messages subcollection; new-offer push = onCreate on `offers/{offerId}`.

⚠️ The at-risk **onUpdate** twins exist but handle a *different* event — offer **status changes** (accepted/declined/countered → notify the buyer), not new offers:
- `notifyOnOfferUpdated` (`index.js:4075`) — **#34 at-risk**
- `pushOnOfferUpdated` (`pushTriggers.js:129`) — **#34 at-risk** (onUpdate)
- `onParticipantStateReadCount` (`messageReadState.js:159`) — **#34 at-risk**, on the messaging feature but not in the new-message push path.

**Net:** delivering push for the two requested events does **not** depend on any at-risk onUpdate trigger. (Deploy caveat in §6.)

---

## 3. Existing token storage & plugin — PARTIAL, fully schema'd (Q3)

Not greenfield.

- **Plugin installed:** `@capacitor/push-notifications@7.0.6` (`package.json:39`, pod in `Podfile:16` / `Podfile.lock`).
- **Token storage schema:** `users/{uid}/fcmTokens/{token}` — **the doc ID is the token**; body `{createdAt, platform, userAgent}`. Written by both client paths; read server-side by `sendPush` (`lib/push.js:102-107`) which prunes dead tokens (`:138`).
- **Firestore rules allow it:** `match /fcmTokens/{token} { allow read, write: if request.auth.uid == userId }` (`firestore.rules:351-355`). (Owner-scoped; note: no App Check gate on this subcollection, unlike the parent user doc.)
- **Client registration code exists, both web and native:**
  - Web: `maybeRegisterPush` (`index.html:6352`) — `Notification.requestPermission` → registers `/firebase-messaging-sw.js` → `getToken({vapidKey})`. Real VAPID key configured.
  - Native: `maybeRegisterPushNative` (`index.html:6505`) — `PushNotifications.requestPermissions/register`, listeners for `registration` / `pushNotificationReceived` / `pushNotificationActionPerformed → routePushNotificationTap`.
  - Both fire ~4s after auth (`index.html:5787`).
- **Web push is genuinely wired:** `firebase-messaging-sw.js` is a real, functional background handler (not a stub).

---

## 4. Architecture — as-built, and the one decision that matters (Q4)

The architecture is essentially already chosen in-code. Documenting it, then the gap.

- **Token type: FCM (not raw APNs).** The server uses `admin.messaging().sendEachForMulticast()` (`lib/push.js:121`), which requires **FCM registration tokens**. This is the correct, multi-device-friendly choice and it is already committed to server-side.
- **Token storage shape (multi-device):** already correct — one doc per token under `users/{uid}/fcmTokens/{token}`, so a user with iPhone + iPad + web each contributes a token doc; `sendPush` multicasts to all and prunes dead ones. No change needed.
- **Permission UX/timing:** currently auto-requested ~4s after auth (`index.html:5787`). This works but is a **cold prompt** — iOS gives you exactly one shot at the system permission dialog. Recommended (optional) improvement: gate behind a soft pre-prompt ("Get notified when you receive offers and messages?") shown contextually (e.g. after a user makes/receives their first offer), then call the native request only on accept. Not a blocker; the current timing is functional.
- **Deep-link routing on tap:** already built — `routePushNotificationTap` (`index.html:6433`) parses `teebox://conversation|offer|order/...`, matching the `deepLink` payloads the server sends. No change needed.

### ⚠️ THE CRITICAL GAP — token-type mismatch (why iOS likely receives nothing today)

The server expects **FCM tokens**, but the **native iOS path as currently wired yields raw APNs tokens**, which `sendEachForMulticast` cannot deliver to:

1. **No `FirebaseMessaging` pod** (`Podfile`/`Podfile.lock` — only `FirebaseAuth`, `Crashlytics`, `AppCheck`). Without it, iOS has no FCM SDK to mint an FCM token.
2. **`FirebaseAppDelegateProxyEnabled = false`** (`Info.plist:62`) **and** `AppDelegate.swift` forwards the APNs device token only to `Auth.auth().setAPNSToken` (`:68`) — there is **no** `Messaging.messaging().apnsToken = deviceToken` and no `MessagingDelegate`. So even if the pod were added, the APNs→FCM bridge isn't connected.
3. Result: `@capacitor/push-notifications`'s `registration` event on iOS returns the **APNs token**, which gets written into `fcmTokens/` and then silently fails at `sendEachForMulticast`. Tokens are stored; pushes never arrive.

**Decision to make:** how to make iOS hand the server an FCM token. Two options:

| Option | What it is | Trade-off |
|---|---|---|
| **A (recommended): add `FirebaseMessaging` pod + bridge in AppDelegate** | `import FirebaseMessaging`, set `Messaging.messaging().apnsToken`, add `MessagingDelegate.didReceiveRegistrationToken`, store *that* FCM token. Keep `@capacitor/push-notifications` for permission + tap handling. | Minimal churn; matches the already-built server + storage exactly. ~1 native file + 1 pod. |
| **B: swap to `@capacitor-firebase/messaging`** | A Capacitor plugin that returns FCM tokens directly. | Replaces the registration path; larger client refactor; redundant with the bridge you'd otherwise add once. |

→ **Recommend Option A.** It's the smallest change that makes the existing, deployed server pipeline actually deliver to iOS.

---

## 5. Remaining work inventory (what's actually left)

Everything below is the *only* outstanding work. Server send-side is complete.

| # | Gap | Surface | Notes |
|---|-----|---------|-------|
| G1 | No `FirebaseMessaging` pod | iOS native | Add pod; `pod install`. |
| G2 | AppDelegate doesn't bridge APNs→FCM | iOS native | `import FirebaseMessaging` + `apnsToken` + `MessagingDelegate`; store FCM token (fixes §4 mismatch). |
| G3 | Native registration stores APNs token, not FCM | client | Falls out of G1+G2 (or Option B). |
| G4 | Notification-service extensions not in Xcode project | iOS native | `TeeBoxNotificationService` / `TeeBoxNotificationContent` Swift exist on disk but appear in **no** `PBXNativeTarget` (`project.pbxproj` has only "App"). Rich push (images/category actions) won't run until added as targets + App Group. **Optional** — basic push works without it; rich push doesn't. |
| G5 | No `UNNotificationCategory` registration in AppDelegate | iOS native | The extension's `TEEBOX_OFFER`/`TEEBOX_MESSAGE` action buttons have nothing to bind to in the main app. Optional, pairs with G4. |
| G6 | APNs auth key upload + App-ID Push capability | **manual console** | A `.p8` (`~/Downloads/AuthKey_T683S23476.p8`) may be the key, but upload to Firebase → Cloud Messaging and the App-ID capability are **unverifiable from repo** — treat as a manual TODO to confirm. |
| G7 | `aps-environment` hard-coded `production` (`App.entitlements:5`) | iOS native | No sandbox variant; fine for TestFlight/App Store, but dev-device debugging against APNs sandbox would need a variant. Minor. |

Already done (do **not** redo): plugin install, `fcmTokens` schema + rules, web push, `sendPush` + both onCreate triggers, deep-link router, entitlements (`aps-environment`, `UIBackgroundModes=remote-notification`), `GoogleService-Info.plist` in Xcode (GCM enabled).

---

## 6. Build sequence — server (deployable now) vs client (gated behind App Store build)

### Phase 0 — Verify before touching anything (no deploy)
- Confirm the push triggers are actually **live in prod** (the functions monolith has the #22 deploy hang; pushTriggers is bundled via `Object.assign(exports, require("./pushTriggers"))` at `index.js:6915`, so it ships with any functions deploy). Check `gcloud functions list` for `pushOnNewMessage` / `pushOnOfferCreated` = ACTIVE.
- Confirm G6: is the APNs key uploaded to Firebase Cloud Messaging? Is Push enabled on the App ID? (Console check, 5 min — this alone may be the whole blocker.)
- Confirm `legacyPushDispatch` feature flag is OFF (avoid double-send).

### Phase 1 — Server (already built; deployable now, but gated by #22, NOT by an App Store build)
- **No server code change is required for the two target events.** If any payload/copy tweak is ever wanted, it lives in `pushTriggers.js` and deploys via the existing functions path.
- ⚠️ **Deploy caveat (#22 / #34):** `pushTriggers.js` cannot be deployed in isolation — it's part of the monolith that hits the discovery hang, and the same deploy re-registers the at-risk onUpdate triggers (`notifyOnOfferUpdated`, `pushOnOfferUpdated`, `onParticipantStateReadCount`). So any server-side push change inherits the full BD-01/BD-04 deploy risk from `PERF_AUDIT.md`. **Prefer to change nothing server-side.**

### Phase 2 — Client / iOS native (gated behind a new App Store / TestFlight build)
Order: **G1 → G2/G3** (the mismatch fix — makes basic push work), then optionally **G4 → G5** (rich push), then **G7** if dev-sandbox debugging is needed.
- These are native Xcode/pod changes → require `npm run cap:sync`, an Xcode archive, a build-number bump, and a TestFlight submission. Nothing here deploys to the web or functions.
- This is the half that is genuinely gated behind an App Store build; it is **independent** of the server half and carries **zero** #34 risk.

### Phase 3 — Verify on device (the real acceptance test)
- TestFlight build on a physical iPhone: accept permission → confirm an `fcmTokens/{token}` doc appears that is an **FCM** token (not a raw APNs hex). 
- Have a second account create an offer and send a message → confirm both pushes arrive, the presence-gate suppresses the message push when the thread is open, and the deep-link tap routes correctly.
- Existing test scripts/docs to lean on: `PUSH_TEST_PLAN.md`, `MESSAGE_PUSH_TEST.md`, `PUSH_DEEP_LINKS.md`, `PREMIUM_NOTIFICATIONS_TEST.md`.

---

## 7. Open questions for the founder
1. **G6 status** — is `AuthKey_T683S23476.p8` already uploaded to Firebase Cloud Messaging? This may be the single thing standing between "all built" and "working."
2. Rich push (images + action buttons via the on-disk extensions, G4/G5) — in scope for v1, or ship basic banner push first?
3. Permission timing — keep the current auto-prompt-4s-after-auth, or add a soft pre-prompt (§4)?
4. `moderateUserDocOnUpdate` (named on the #34 list) was **not located** as an active export in this scan — worth a direct confirm it still exists before relying on it elsewhere; not in the push path.

---

## 8. Scope boundary (not audited)
- Android device push (triggers/payload are cross-platform in `sendPush`, but the Android client path + FCM setup were not reviewed here).
- Order-status / bingo pushes (other `pushTriggers.js` producers exist; out of scope for this message/offer plan).
- Whether the prod functions deployment actually contains the current `pushTriggers.js` (Phase 0 verification, not provable from source).
- Live APNs/FCM console state (key upload, App-ID capability) — inferred from repo only.
