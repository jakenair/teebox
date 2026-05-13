# TeeBox Push Notification Test Plan

Manual QA plan for the push-notification system. Run on a physical iOS
device + a physical Android device. Capacitor 7 + Firebase Cloud Messaging
on both sides. The simulator does NOT receive APNs — physical only.

## Prerequisites

1. Install `@capacitor/push-notifications` (not yet committed):
   ```bash
   npm i @capacitor/push-notifications
   npx cap sync ios && npx cap sync android
   ```
2. iOS: add Push Notifications capability to the `App` target in Xcode,
   plus Background Modes → Remote notifications.
3. iOS: add the Notification Service Extension target (scaffolded under
   `ios/App/TeeBoxNotificationService/`). Bundle id
   `com.teeboxmarket.app.NotificationService`. Add the Podfile target
   block (see "Podfile changes" below) and run `pod install`.
4. iOS: optionally add the Notification Content Extension
   (`ios/App/TeeBoxNotificationContent/`). Bundle id
   `com.teeboxmarket.app.NotificationContent`.
5. iOS: in `App.entitlements`, add an App Group
   `group.com.teeboxmarket.app` and enable it on BOTH the main App target
   and the NSE so the extension can share cached state.
6. Android: ensure `google-services.json` is present in `android/app/`
   (it should already be — verify FCM is enabled in Firebase console).
7. Backend: deploy functions
   `firebase deploy --only functions:pushOnOfferCreated,functions:pushOnOfferUpdated,functions:pushOnOrderCreated,functions:pushOnOrderUpdated,functions:pushOnPayoutReleased,functions:pushSavedSearchDailyDigest`.

## Podfile changes

Add to `ios/App/Podfile` AFTER the `target 'App' do` block:

```ruby
target 'TeeBoxNotificationService' do
  platform :ios, '14.0'
  use_frameworks!
  pod 'Firebase/Messaging'
end

target 'TeeBoxNotificationContent' do
  platform :ios, '14.0'
  use_frameworks!
end
```

Then `cd ios/App && pod install`.

## Scenarios

### S1 — Foreground (app open)

1. Sign into the app on Device A.
2. From Device B (or Firestore Console), trigger an offer on A's listing.
3. **Expected**: Device A shows in-app toast (no OS banner). Notification
   panel badge increments.

### S2 — Background (app behind another app)

1. Open the app on Device A, then press Home so it's backgrounded.
2. Trigger an offer.
3. **Expected**: APNs/FCM banner appears with the listing thumbnail (NSE
   downloaded it). Tap → app foregrounds → My Offers opens with the new
   offer.

### S3 — Terminated (app force-quit)

1. Force-quit the app on Device A (swipe away from app switcher).
2. Trigger an offer.
3. **Expected**: Banner appears. Tap → app launches cold → routes to My
   Offers (deep link parses `teebox://offer/{id}` from `data.url`).

### S4 — Locked screen

1. Lock Device A.
2. Trigger a "new message" (owned by message agent — verify integration).
3. **Expected**: Banner appears with sender avatar + preview. Setting
   "Show previews → When unlocked" should hide the body until unlock.

### S5 — iOS Focus / Do Not Disturb

1. Enable Focus mode (Do Not Disturb) on Device A.
2. Trigger an offer that is NOT urgent (no 1h expiry).
3. **Expected**: No banner (Focus suppresses it).
4. Now trigger an offer with `expiresAt` < 1h from now → server sets
   `interruption-level: time-sensitive`.
5. **Expected**: Banner breaks through Focus.

### S6 — Android Do Not Disturb

1. Enable DND on Device B.
2. Trigger an offer → no banner.
3. In DND settings, override `teebox_offers` channel to "can interrupt".
4. Trigger again → banner appears.

### S7 — Notification grouping (iOS)

1. Trigger 3 offers on the SAME listing within 5 seconds.
2. **Expected**: iOS collapses into one notification with a stack count.
   `thread-id` is `listing-{listingId}` for all three.

### S8 — Notification grouping (Android)

1. Same as S7 on Device B.
2. **Expected**: Group summary notification appears on top of the
   expandable stack (`MessagingNotificationHelper.emitGroupSummary`).

### S9 — Pre-permission modal

1. Fresh install. Sign in. Do NOT touch settings.
2. **Expected**: NO iOS permission prompt at launch.
3. Create your first listing.
4. **Expected**: Pre-permission modal "Get buyer alerts" appears
   ~1.5s after the success toast. Tap "Not now".
5. **Expected**: No iOS system dialog fires. Firestore `pushPromptHistory`
   has `{context: 'first-listing', answered: 'no'}`.
6. Add a listing to your watchlist (different context).
7. **Expected**: "Track price drops" modal appears (different context, not
   cooled down). Tap "Turn on" → iOS system dialog fires.

### S10 — Preferences screen

1. Go to Profile → Account hub → "Notifications".
2. Toggle Offers OFF, set quiet hours 14:00–16:00 (current time inside).
3. Trigger a non-urgent offer → no banner (`category-off:offers`).
4. Toggle Offers back ON. Trigger a non-urgent order (different category)
   inside quiet hours → no banner (`quiet-hours`).
5. Trigger an urgent order (e.g. order-shipped marked urgent=true) → does
   come through (quiet-hours bypassed).

### S11 — Rich image attachment

1. Trigger an offer on a listing that has `photos[0]` set.
2. **Expected on iOS**: NSE downloads the image, attaches it. Long-press
   → preview shows the image. (Without the NSE, the banner is plain text.)
3. **Expected on Android**: BigPictureStyle shows the image (price-drop
   category only — others show as standard).

### S12 — Inline reply (messages)

1. (Owned by message agent — sanity check the infrastructure exists.)
2. On Android, trigger a new message. Banner should expose "Reply" action
   with inline text input via `RemoteInput`. The receiver wiring lives in
   the message agent's PR.

### S13 — Token cleanup

1. Uninstall the app from Device A.
2. Trigger a notification.
3. **Expected**: First send fails with
   `messaging/registration-token-not-registered`. `sendPush()` prunes the
   token from `users/{uid}/fcmTokens/{token}`.
4. Verify the doc no longer exists in Firestore.

### S14 — Deep-link routing matrix

For each trigger, verify the tap action lands on the correct screen:

| Trigger          | URL                          | Lands on            |
|------------------|------------------------------|---------------------|
| offer created    | teebox://offer/{id}          | My Offers           |
| offer accepted   | teebox://offer/{id}          | My Offers           |
| order created    | teebox://order/{id}          | My Orders           |
| order shipped    | teebox://order/{id}          | My Orders           |
| order delivered  | teebox://order/{id}          | My Orders           |
| payout released  | teebox://payouts             | My Shop dashboard   |
| saved-search     | teebox://search/{savedId}    | Saved Searches      |
| price drop       | teebox://listing/{id}        | Listing detail      |

### S15 — Saved-search daily digest

1. Add a saved search that will match a new listing.
2. Have an admin trigger a new matching listing.
3. Wait for the next hourly run of `pushSavedSearchDailyDigest`.
4. **Expected**: If user's local time is 8am, they get ONE batched
   notification "3 new listings match [name]". If not 8am, queue fills
   silently and dispatches when it ticks over.
