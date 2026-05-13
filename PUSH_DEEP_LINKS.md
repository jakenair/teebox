# TeeBox Push Deep-Link Reference

URL scheme used in push notification `data.url` / `data.deepLink` and
also accepted by the iOS Universal Links + Android App Links handlers.

## Scheme

All custom URLs use `teebox://` (registered in iOS Info.plist
`CFBundleURLSchemes` and Android `intent-filter` on MainActivity). Web /
SMS / email contexts use the HTTPS equivalent
`https://teeboxmarket.com/?...`. The same router (`routeDeepLink` in
`index.html`) accepts both forms.

## URL → handler map

| URL                              | Cloud function trigger              | Client handler              | Screen          |
|----------------------------------|-------------------------------------|-----------------------------|-----------------|
| `teebox://offer/{offerId}`       | pushOnOfferCreated/Updated          | openMyOffers()              | My Offers       |
| `teebox://order/{orderId}`       | pushOnOrderCreated/Updated          | openOrders()                | My Orders       |
| `teebox://listing/{listingId}`   | pushOnPriceDrop (existing)          | openDetailModal(id)         | Listing detail  |
| `teebox://search/{savedId}`      | pushSavedSearchDailyDigest          | openSavedSearches()         | Saved Searches  |
| `teebox://payouts`               | pushOnPayoutReleased                | openShopDashboard()         | My Shop         |
| `teebox://conversation/{cid}`    | (message agent)                     | openChatFromConversation()  | Chat thread     |
| `teebox://inbox`                 | (message agent)                     | openInbox()                 | Inbox           |

## Equivalent HTTPS routes (for SMS/email)

| URL                                                        | Resolves to             |
|------------------------------------------------------------|-------------------------|
| `https://teeboxmarket.com/?offer={id}`                     | (TODO — currently uses listings query) |
| `https://teeboxmarket.com/?order={id}`                     | (TODO)                  |
| `https://teeboxmarket.com/?listing={id}`                   | openDetailModal — wired |
| `https://teeboxmarket.com/?launch=watchlist`               | openWatchlist — wired   |

## Adding a new deep link

1. Pick a new entity prefix (e.g. `dispute`).
2. Add a case to `routeDeepLink()` in `index.html` (right next to
   `offer`/`order` cases — see the extended router wrapper that calls into
   the message agent's `routePushNotificationTap`).
3. If the trigger sends from server, set `payload.deepLink =
   'teebox://dispute/' + id` in `functions/pushTriggers.js`.
4. Update this table.

## Native registration

### iOS (Info.plist)

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>teebox</string></array>
  </dict>
</array>
```

Plus an `apple-app-site-association` file on `teeboxmarket.com` for
Universal Links (the repo already has one at
`/apple-app-site-association`).

### Android (AndroidManifest.xml)

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="teebox" />
</intent-filter>
```

## Capacitor wiring

The native plugins forward URL → JS:

- `@capacitor/app` emits `appUrlOpen` for both custom-scheme + universal
  link launches. The JS handler reads `event.url` and calls
  `routeDeepLink()`.
- `@capacitor/push-notifications` emits `pushNotificationActionPerformed`
  on tap. The JS handler reads `action.notification.data.url` and calls
  `routePushNotificationTap()` (which delegates to `routeDeepLink()` for
  the offer/order/listing/search/payouts cases).
