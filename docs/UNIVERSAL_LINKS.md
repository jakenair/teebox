# iOS Universal Links — TeeBox

When a user taps a shared `https://teeboxmarket.com/listing/<id>` link
on an iPhone that has TeeBox installed, iOS should open the listing
**inside the app** instead of bouncing through Safari. That behavior
is "Universal Links" and depends on three things lining up:

1. The Apple App Site Association (AASA) file served from
   `teeboxmarket.com`.
2. The "Associated Domains" capability + entitlement on the iOS app.
3. The app actually handling the inbound URL once iOS hands it over.

If any one of these is wrong, iOS silently falls back to Safari.

---

## 1. AASA file (web side)

Lives in **two** places in the repo so Apple finds it regardless of
which path it probes:

- `/apple-app-site-association` (legacy path)
- `/.well-known/apple-app-site-association` (modern path, preferred)

Both files are identical and contain:

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "L434SWLF3L.com.teeboxmarket.app",
        "paths": [
          "/",
          "/listing/*",
          "/seller/*",
          "/brand/*",
          "/bingo*",
          "NOT /privacy*",
          "NOT /terms*"
        ]
      }
    ]
  },
  "webcredentials": {
    "apps": ["L434SWLF3L.com.teeboxmarket.app"]
  }
}
```

- `L434SWLF3L` = TeeBox Apple Team ID (verified against
  `DEVELOPMENT_TEAM` in `ios/App/App.xcodeproj/project.pbxproj`).
- `com.teeboxmarket.app` = bundle identifier.
- The AASA file must be **valid JSON** — no comments, no trailing
  commas. Apple's CDN caches the file aggressively; any parse error
  breaks Universal Links until the cache flushes (~24h).
- File must be served over HTTPS with **no redirects** and no
  authentication. GitHub Pages serves it as
  `application/octet-stream`, which iOS 15+ accepts. (Firebase
  Hosting was previously configured to set `application/json` via
  `firebase.json` headers — kept there for completeness, but
  teeboxmarket.com is GitHub Pages, so those headers don't apply.)

### Verify it's live

```bash
curl -sI https://teeboxmarket.com/.well-known/apple-app-site-association
curl -sI https://teeboxmarket.com/apple-app-site-association
curl -s  https://teeboxmarket.com/.well-known/apple-app-site-association | python3 -m json.tool
```

Both should return `200`. The body must round-trip through `json.tool`
without errors. Apple's own validator:
<https://app-site-association.cdn-apple.com/a/v1/teeboxmarket.com>

---

## 2. Associated Domains capability (iOS side)

This is **NOT** something we add to `App.entitlements` by hand. Like
"Sign In with Apple", it must be added through Xcode so the
provisioning profile is regenerated with the matching entitlement.

### Steps

1. Open `ios/App/App.xcodeproj` in Xcode.
2. Select the `App` target → **Signing & Capabilities** tab.
3. Click **+ Capability** → choose **Associated Domains**.
4. Add these entries:
   - `applinks:teeboxmarket.com`
   - `applinks:www.teeboxmarket.com`
   - `webcredentials:teeboxmarket.com` (so password autofill / SIWA
     can use the same domain)
5. Xcode automatically writes:
   ```xml
   <key>com.apple.developer.associated-domains</key>
   <array>
     <string>applinks:teeboxmarket.com</string>
     <string>applinks:www.teeboxmarket.com</string>
     <string>webcredentials:teeboxmarket.com</string>
   </array>
   ```
   into `ios/App/App/App.entitlements`.
6. **Re-archive** the app (`Product → Archive`) and upload a new
   build to TestFlight. The entitlement only takes effect through a
   freshly signed binary.

### How to verify it's actually in the build

After archiving:

```bash
codesign -d --entitlements - "<path-to-App.app>" 2>&1 | grep -A 5 associated-domains
```

If `applinks:teeboxmarket.com` doesn't appear, the build was signed
**without** the entitlement and Universal Links will not work.

---

## 3. App-side URL handling

Capacitor's `ApplicationDelegateProxy.shared.application(_:continue:
restorationHandler:)` already forwards inbound `NSUserActivity`
payloads to the JS layer via the `@capacitor/app` plugin's
`appUrlOpen` event. Our `AppDelegate.swift` already wires this:

```swift
func application(_ application: UIApplication,
                 continue userActivity: NSUserActivity,
                 restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
    return ApplicationDelegateProxy.shared.application(
        application, continue: userActivity,
        restorationHandler: restorationHandler)
}
```

**Heads-up:** `index.html` does not currently subscribe to
`Capacitor.Plugins.App.addListener('appUrlOpen', …)`. Universal Link
taps will still launch the app — Capacitor restores the WebView at
the deep-linked path on **cold start** automatically — but warm-start
(app already in memory) will leave the WebView on whatever route was
showing. If we want robust warm-start handling, add (somewhere after
the SDK is ready):

```js
const Cap = window.Capacitor;
const App = Cap?.Plugins?.App;
if (App) {
  App.addListener('appUrlOpen', ({ url }) => {
    try {
      const u = new URL(url);
      const target = u.pathname + u.search + u.hash;
      if (target && target !== location.pathname + location.search) {
        history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    } catch {}
  });
}
```

This is a polish item, not a blocker — Build 36 will work for cold
launches without it.

---

## Common gotchas

- **AASA cached by Apple's CDN** — after editing the file, expect up
  to 24h before iOS picks it up. Force-refresh by toggling Airplane
  Mode + reinstalling the app, or use a fresh device.
- **Wrong Team ID in AASA** — silently fails. Always cross-check
  against `DEVELOPMENT_TEAM` in `project.pbxproj`.
- **`Content-Type` matters on iOS < 15** — we're targeting iOS 14+
  (`platform :ios, '14.0'` in Podfile). GitHub Pages serves
  `application/octet-stream`, which iOS 14 accepts for AASA as long
  as the body parses as JSON. If we ever see flakiness on iOS 14
  devices, move hosting to Firebase or add a `_headers` rule (not
  supported by GitHub Pages out of the box — would need a Cloudflare
  Worker in front).
- **Associated Domains added but not in build** — happens when you
  add the capability in Xcode but don't re-archive. The entitlement
  is baked into the signed binary, not pushed OTA.
