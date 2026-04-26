# TeeBox — App Store launch playbook

This is the end-to-end checklist to get TeeBox onto the iOS App Store
and Google Play, starting from the Capacitor scaffold already in this
repo.

Estimated wall-clock time: **2–4 weeks** (most of it is Apple's review
queue and the developer-account approval window).

---

## 0. What's already done in the repo

| | Status |
|---|---|
| Capacitor 7 installed (`@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`) | ✅ |
| `capacitor.config.ts` — bundle id `com.teeboxmarket.app`, splash + status bar config | ✅ |
| `dist/` build script (`npm run build:web`) — copies the static site into the bundle | ✅ |
| `.capacitorignore` — keeps git/firebase/functions out of the bundle | ✅ |
| Android platform scaffolded (`android/`) | ✅ |
| Android adaptive icons + splash screens (every density) | ✅ |
| iOS app icon set pre-rendered (every required size in `resources/ios/`) | ✅ |
| iOS splash images | ✅ |
| **iOS platform scaffolded (`ios/`)** | ❌ — needs CocoaPods, see step 2 |

---

## 1. Sign up for the developer accounts (do this first — has lead time)

### Apple Developer Program — **$99/year** — 24–48h approval
- https://developer.apple.com/programs/enroll/
- Requires: Apple ID with 2FA, your full legal name, address, phone.
- For an LLC/corporation: also a **D-U-N-S number** (free from Dun &
  Bradstreet, takes ~2 weeks). Personal enrollment skips this.
- Choose "Individual" if you're a sole proprietor — fastest.

### Google Play Console — **$25 one-time** — ~1–2 day approval
- https://play.google.com/console/signup
- Identity verification required (driver's license / passport).

### Stripe Connect (recommended before going live)
- See the broader project notes — without Connect, **all payments still
  go to your personal Stripe account** and you have to pay sellers
  manually. App Store policy is fine with this for physical-goods
  marketplaces, but it's not a sustainable operating model.

---

## 2. Install the local toolchain

### Xcode (macOS, ~12 GB)
```bash
# From the Mac App Store: search "Xcode", install. Or:
xcode-select --install        # for command-line tools (already done)
sudo xcodebuild -license accept
```

### Homebrew (if not installed) — needed for CocoaPods on modern macOS
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### CocoaPods
```bash
brew install cocoapods
pod --version           # should print 1.16.x or newer
```

### Android Studio (~3 GB) OR JDK 17 + Android SDK
- https://developer.android.com/studio
- On first launch, accept the SDK license dialogs.
- Install Android SDK Platform 34, Build-Tools 34.0.0, Platform-Tools.

---

## 3. Add the iOS platform (one-time, after step 2 is done)

```bash
cd /Users/jakenair/Desktop/teebox
npx cap add ios
```

This creates the `ios/` folder with a full Xcode project. Capacitor
runs `pod install` automatically.

### Drop in the pre-rendered icons
Open the new `ios/App/App/Assets.xcassets/AppIcon.appiconset` in Finder
and replace the placeholder PNGs with the matching files from
`resources/ios/AppIcon-XX.png`. Sizes Apple wants:

| Filename in AppIcon.appiconset | Source from `resources/ios/` |
|---|---|
| `AppIcon-20x20@2x.png` (40×40)    | AppIcon-40.png  |
| `AppIcon-20x20@3x.png` (60×60)    | AppIcon-60.png  |
| `AppIcon-29x29@2x.png` (58×58)    | AppIcon-58.png  |
| `AppIcon-29x29@3x.png` (87×87)    | AppIcon-87.png  |
| `AppIcon-40x40@2x.png` (80×80)    | AppIcon-80.png  |
| `AppIcon-40x40@3x.png` (120×120)  | AppIcon-120.png |
| `AppIcon-60x60@2x.png` (120×120)  | AppIcon-120.png |
| `AppIcon-60x60@3x.png` (180×180)  | AppIcon-180.png |
| `AppIcon-1024x1024.png`           | AppIcon-1024.png |

(Easier: run `npx @capacitor/assets generate --ios` after `cap add ios`
— it does this automatically using `resources/icon.png` and
`resources/splash.png`.)

---

## 4. Test locally before submitting

```bash
# Build the web bundle into dist/, sync to native platforms
npm run cap:sync

# iOS — opens Xcode; pick a simulator and click ▶
npm run cap:ios

# Android — opens Android Studio; pick a device/emulator and click ▶
npm run cap:android
```

Walk through every flow: sign in, list, search, message, bid, buy
(Stripe test card `4242 4242 4242 4242`), watchlist, profile.

---

## 5. iOS-specific configuration in Xcode

Open `ios/App/App.xcodeproj` in Xcode. In the **Signing & Capabilities**
tab of the `App` target:

1. **Team**: pick your Apple Developer team.
2. **Bundle Identifier**: `com.teeboxmarket.app` (matches
   `capacitor.config.ts`). Apple needs this to match what you'll create
   in App Store Connect.
3. **Capabilities**:
   - "Push Notifications" — only if/when you wire FCM.
   - "Associated Domains" — for universal links to teeboxmarket.com.

In `ios/App/App/Info.plist`, set permission strings (Apple **rejects**
apps that use APIs without describing why):

```xml
<key>NSCameraUsageDescription</key>
<string>TeeBox uses the camera to take photos of items you list for sale.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>TeeBox lets you choose photos for your listings from your library.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>TeeBox can save listing receipts to your photos.</string>
```

---

## 6. Android-specific configuration

Open `android/` in Android Studio.

1. In `android/app/build.gradle`, set:
   ```
   applicationId "com.teeboxmarket.app"
   versionCode 1
   versionName "1.0.0"
   ```
2. Generate a **signed release keystore** (Android Studio: Build →
   Generate Signed Bundle/APK → Android App Bundle → Create new key).
   Store the `.jks` file outside the repo and **never commit it**.

---

## 7. Firebase + Capacitor wiring

The web app uses Firebase Auth via `signInWithPhoneNumber` which
relies on reCAPTCHA. In Capacitor the page loads from
`capacitor://localhost` (iOS) and `https://localhost` (Android), which
isn't whitelisted by default.

In the Firebase console → **Authentication** → **Settings** → **Authorized
domains**, add:
- `localhost`
- `capacitor.localhost`
- `app://localhost` (Android)

If reCAPTCHA still fails inside the webview, swap in the
`@capacitor-firebase/authentication` plugin which uses **native**
phone-auth dialogs on each platform. Documented at
https://github.com/capawesome-team/capacitor-firebase

---

## 8. App Store Connect submission (iOS)

### One-time setup
1. Sign in to https://appstoreconnect.apple.com → **My Apps** → **+** →
   **New App**.
2. Bundle ID: `com.teeboxmarket.app`. SKU: anything unique
   (`teebox-ios-001`). Primary language: English (U.S.).
3. **App Information**:
   - Subtitle: "Buy & sell golf gear"
   - Category: Shopping (primary), Sports (secondary)
   - Privacy Policy URL: `https://teeboxmarket.com/?launch=privacy` (or
     a dedicated /privacy.html — write one if needed).

### App Privacy questionnaire
Apple asks what data you collect. Answers for TeeBox:
- **Phone number** — used for sign-in, linked to user, *not* used for tracking
- **Photos** — uploaded by user as part of listings
- **Purchase history** — order records
- **Identifiers** — device ID is collected by Stripe for fraud
- **Crash data** — only if you add Crashlytics (you haven't)

### Each release
1. `npm run cap:sync && npm run cap:ios`
2. In Xcode: select **Any iOS Device** (not a simulator) → **Product** → **Archive**
3. Window → Organizer → **Distribute App** → App Store Connect → Upload
4. Wait ~30 min for processing in App Store Connect
5. Add to a TestFlight internal-testing group, smoke-test on real
   devices for 24h
6. Submit for review (Apple typically responds in 1–3 days)

### Common rejection reasons (and how to avoid)
- **4.2 Minimum Functionality** ("looks like a wrapper of a website") —
  We pass this because: (a) bundled web assets, not remote URL; (b)
  native splash + status bar handling; (c) home-screen install with
  shortcuts; (d) offline support via service worker. **Do not** point
  the bundle at `https://teeboxmarket.com` directly.
- **3.1.1 In-App Purchase** — only applies to digital goods. Physical
  goods (golf clubs, apparel) are explicitly allowed via Stripe.
- **5.1.1 Data Collection** — we ask for phone number for sign-in;
  this is fine as long as it's documented in the privacy questionnaire.

---

## 9. Google Play Console submission (Android)

1. Sign in to https://play.google.com/console → **Create app**.
2. App name: TeeBox · Default language: English (US) · App or game: App
   · Free or paid: Free.
3. Build the release bundle:
   ```bash
   npm run cap:sync
   cd android && ./gradlew bundleRelease
   ```
   The signed `.aab` ends up at
   `android/app/build/outputs/bundle/release/app-release.aab`.
4. Upload to **Internal testing** track first.
5. Fill out the **Data safety** form, **Content rating**, **Target audience**,
   **News apps** ("not a news app"), **Ads** ("does not contain ads"), and
   **Privacy policy URL**.
6. Move from internal → closed → open testing → production over a few
   days as you test.

---

## 10. Post-launch monitoring

- **Crashlytics** — `npm install @capacitor-community/firebase-crashlytics`
  to wire crash reporting from native iOS/Android.
- **App-store reviews** — monitor App Store Connect daily for the first
  two weeks; respond to every review.
- **Server-side**: keep your Cloud Functions error rate visible in the
  Firebase console.

---

## Reference: the build script

```
npm run build:web   # rm -rf dist && cp …
npm run cap:sync    # build:web + npx cap sync
npm run cap:ios     # cap:sync + opens Xcode
npm run cap:android # cap:sync + opens Android Studio
npm run cap:icons   # regenerate all platform icons from resources/
```

## Reference: bundle identifier

`com.teeboxmarket.app` — set in:
- `capacitor.config.ts` → `appId`
- iOS Xcode → Target → General → Bundle Identifier
- Android `build.gradle` → `applicationId`
- App Store Connect → bundle ID
- Google Play → package name

These **must all match** or App Store / Play Store will reject the upload.
