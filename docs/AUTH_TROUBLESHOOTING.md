# TeeBox Auth Troubleshooting Playbook

Console-side configuration steps for the three pieces of auth wiring
that **only the user** can fix (no code change). The code in `index.html`
is already correct after commits `4c03d54` (IS_NATIVE scoping fix),
`1126851` (Firebase imports hoisted to `window`), and `a2220bc`
(Apple `skipNativeAuth: true`). Anything that still fails on the client
points at one of the consoles below.

Audience: project owner with access to Firebase Console, Google Cloud
Console, and Apple Developer Console under team `teebox-market`.

---

## Quick map of which console owns which credential

| Surface | Identity provider | Configured in |
|---|---|---|
| Web Google sign-in (popup) | OAuth Web Client (auto-created by Firebase) | Google Cloud Console → APIs & Services → Credentials |
| Web Apple sign-in (popup) | Apple **Services ID** + private key | Apple Developer + Firebase Console → Auth → Apple |
| iOS Google sign-in (native) | iOS OAuth Client (`CLIENT_ID` in `GoogleService-Info.plist`) | Already wired — no action needed |
| iOS Apple sign-in (native) | App ID's Sign In with Apple capability | Already wired — entitlement enabled |

---

## 1. Web Google sign-in — fixing `auth/internal-error`

The on-page diagnostic `[diag native=false plugin=no code=auth/internal-error]`
means the popup opened (or attempted to), Firebase received a result,
then Google's identity-toolkit rejected it. **In 90% of cases this is
an Authorized JavaScript origins / Authorized redirect URIs mismatch
on the OAuth Web Client.**

### Step-by-step fix

1. Open https://console.cloud.google.com and **switch to the
   `teebox-market` project** (top-left project picker).
2. Left nav: **APIs & Services** → **Credentials**.
3. Under **OAuth 2.0 Client IDs**, find the entry whose name starts with
   `Web client (auto created by Google Service)` (created by Firebase
   the first time Google Sign-In was enabled). Click it.
4. **Authorized JavaScript origins** must contain *all of these*
   (one per line, no trailing slash):
   ```
   https://teeboxmarket.com
   https://www.teeboxmarket.com
   https://teebox-market.firebaseapp.com
   https://teebox-market.web.app
   http://localhost
   http://localhost:5000
   ```
   If `https://teeboxmarket.com` is missing, **add it** and click **Save**.
5. **Authorized redirect URIs** must contain:
   ```
   https://teebox-market.firebaseapp.com/__/auth/handler
   ```
   This is the Firebase Auth callback. Without it, Firebase's SDK
   can't complete the popup-based OAuth code exchange — exact symptom
   is `auth/internal-error` with no further detail.
6. Click **Save**. Changes are live in ~10 seconds (no Firebase redeploy
   required).
7. **Verify** (incognito Chrome, hard refresh):
   - Open https://teeboxmarket.com/?signin=1
   - Click **Continue with Google**
   - The Google account picker should open in a popup
   - After picking an account, the popup closes and the sign-in screen
     fades out → user is signed in.

### Cross-check: Firebase authorized domains

While in the consoles, also verify:

1. Firebase Console → **Authentication** → **Settings** tab → **Authorized
   domains**. Must contain at minimum:
   - `localhost`
   - `teebox-market.firebaseapp.com`
   - `teebox-market.web.app`
   - `teeboxmarket.com`
   - `www.teeboxmarket.com`

   If `teeboxmarket.com` is **not** in this list, Firebase will reject
   the OAuth callback with `auth/unauthorized-domain` (different code,
   easier to spot — but worth ruling out).

---

## 2. Web Apple sign-in — Services ID setup (one-time, ~20 min)

Apple Sign-In on the web is **completely separate** from native iOS
Apple Sign-In. The native iOS flow uses the App ID's "Sign In with
Apple" capability and works without any extra setup once the
entitlement is on (already done — see commit `c4fe9ce`). The web
flow needs:

- An Apple **Services ID** (think: client ID for the web — must be a
  different identifier from the iOS App ID)
- A private key (`.p8` file) authorizing that Services ID
- A domain-association file served at
  `https://teeboxmarket.com/.well-known/apple-developer-domain-association.txt`
  to prove ownership of the domain to Apple
- Those credentials wired into Firebase's Apple provider so it can
  exchange Apple's authorization code for an ID token server-side

Until this is done, web Apple sign-in fails with `auth/operation-not-allowed`
and the in-app catch surfaces "Apple Sign In is not enabled yet. Use email
or Google for now." (by design).

### Identifiers you'll need

| Field | Value |
|---|---|
| Apple Team ID | `L434SWLF3L` |
| iOS App ID (already exists) | `com.teeboxmarket.app` |
| **New** Services ID (to be created in Phase A) | `com.teeboxmarket.app.signin` |
| Apple Developer login | `jacobnair2002@icloud.com` |
| Firebase login | `jakenair23@gmail.com` |
| Firebase project | `teebox-market` |
| Firebase auth handler URL | `https://teebox-market.firebaseapp.com/__/auth/handler` |
| Production domain | `teeboxmarket.com` |

### Phase A — Apple Developer Console: create the Services ID

Sign in as `jacobnair2002@icloud.com` at https://developer.apple.com/account.

1. **Certificates, IDs & Profiles** → **Identifiers** → click **+**.
2. Choose **Services IDs** → **Continue**.
3. **Description**: `TeeBox Web Sign In`.
4. **Identifier**: `com.teeboxmarket.app.signin`
   (must be **different** from the iOS App ID `com.teeboxmarket.app` —
   Apple rejects matching identifiers).
5. Click **Continue** → **Register**.
6. Click the new Services ID in the list → check **Sign in with Apple**
   → click **Configure**.
7. **Primary App ID**: select `com.teeboxmarket.app`.
8. **Domains and Subdomains** (no `https://`, no `www.`, no trailing slash):
   ```
   teeboxmarket.com
   ```
9. **Return URLs**:
   ```
   https://teebox-market.firebaseapp.com/__/auth/handler
   ```
10. Click **Next** → **Done** → **Continue** → **Save**.
11. Apple now prompts to **verify domain ownership**. **Download** the
    `apple-developer-domain-association.txt` file Apple provides — keep
    that browser tab open.
12. Replace the placeholder in the repo at
    `.well-known/apple-developer-domain-association.txt` with Apple's exact
    file contents (do not edit, do not add a trailing newline that wasn't
    there).
13. Deploy:
    - **GitHub Pages (current)**: `git add .well-known && git commit -m "auth: apple domain verification" && git push`
    - **Firebase Hosting (post-migration)**: `npm run deploy:hosting`
    Then verify the file is live by opening
    `https://teeboxmarket.com/.well-known/apple-developer-domain-association.txt`
    in a browser — the response body must match Apple's content **byte-for-byte**.
14. Back in Apple Developer Console: click **Verify** for the domain.
    Should flip to "Verified" within a few seconds. If it errors, hard-refresh
    the file URL (cache) and re-click Verify.

> The `firebase.json` `hosting.headers` block already pins
> `Content-Type: text/plain; charset=utf-8` for this path under Firebase
> Hosting. GitHub Pages serves `.txt` as `text/plain` by default, so it
> works either way.

### Phase B — Apple Developer Console: generate the Sign in with Apple key

Still signed in as `jacobnair2002@icloud.com`.

1. **Keys** (left nav) → click **+**.
2. **Key Name**: `TeeBox Sign In with Apple Key`.
3. Check **Sign in with Apple** → click **Configure** next to it.
4. **Primary App ID**: select `com.teeboxmarket.app`
   (the iOS App ID — **not** the new Services ID; Apple wants the
   original App ID here).
5. **Save** → **Continue** → **Register**.
6. **Download the `.p8` file.** ⚠️ **You can ONLY download it once.**
   Save it to a password manager (e.g. 1Password) immediately. If you
   lose it, you have to revoke and regenerate, which means re-pasting
   into Firebase.
7. Note the **Key ID** shown on this page (10-char alphanumeric string).
8. Note your **Team ID**: `L434SWLF3L` (10-char, also visible top-right
   in your account membership view).

### Phase C — Firebase Console: wire the Apple provider

Sign in as `jakenair23@gmail.com` at https://console.firebase.google.com.

1. Open the **teebox-market** project → **Authentication** →
   **Sign-in method** tab.
2. Click the **Apple** row in the providers list (it's already enabled
   for native iOS — you're just expanding the configuration).
3. Expand **OAuth code flow configuration** (this section is **only**
   used by web; native iOS doesn't read it).
4. **Services ID**: `com.teeboxmarket.app.signin` (from Phase A step 4).
5. **Apple Team ID**: `L434SWLF3L`.
6. **Key ID**: paste the value from Phase B step 7.
7. **Private key**: paste the **full contents** of the `.p8` file —
   this includes the `-----BEGIN PRIVATE KEY-----` line, the body, and
   the `-----END PRIVATE KEY-----` line. Don't trim or alter anything.
8. Click **Save**.

### Phase D — Verify it works

1. Hard-refresh https://teeboxmarket.com (or open in an incognito window
   to bypass the service worker).
2. Click **Continue with Apple**.
3. Apple's `appleid.apple.com` popup opens. Sign in with any Apple ID.
4. First auth: Apple asks "Share My Email" / "Hide My Email" — either is
   fine. The popup closes and you land back in TeeBox, signed in.
5. Confirm in **Firebase Console → Authentication → Users** that the new
   user row shows `apple.com` as the provider.

### Common errors and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `auth/operation-not-allowed` | Phase C not completed (Firebase OAuth code flow blank). | Re-check Services ID, Key ID, Team ID, `.p8` contents in Firebase Console. |
| `auth/invalid-credential` | `.p8` was not pasted in full (BEGIN/END lines stripped). | Re-paste, including both delimiter lines. |
| "Domain not verified" in Apple console | Phase A steps 13/14 weren't done, or the deployed file doesn't match Apple's. | Open the file URL in a browser and diff against what Apple gave you. Redeploy. Click **Verify** again. |
| 404 on `/.well-known/apple-developer-domain-association.txt` | `.well-known/` not deployed. | Confirm the file exists in `dist/.well-known/` after `npm run build:web`. The `build:web` script already does `(test -d .well-known && cp -R .well-known dist/.well-known || true)`. |
| `auth/popup-closed-by-user` after Apple popup | User dismissed the popup. | Silent-retry by app. |
| Works on `teebox-market.firebaseapp.com` but not `teeboxmarket.com` | `teeboxmarket.com` not on Firebase **Authorized domains** list. | Firebase Console → Auth → Settings → Authorized domains → add it. |

---

## 3. iOS native Apple/Google — already wired, just need a build

Build 35 of TestFlight already verified Google native works. Apple
native fails with `auth/missing-or-invalid-nonce` because Build 35
predates commit `a2220bc`, which added `skipNativeAuth: true` to the
Apple plugin call (otherwise the Capacitor plugin consumes the Apple
identity token before the JS SDK can use it — Apple tokens are
single-use).

**Action**: archive Build 36 in Xcode and upload to TestFlight. No
console changes needed.

```bash
npm run cap:sync
npx cap open ios
# In Xcode: Product → Archive → Distribute App → App Store Connect
```

---

## 4. "Verify it worked" checklist

After completing 1 + 2 above, run all four flows in incognito:

- [ ] **Web Google** — https://teeboxmarket.com → sign-in screen →
      "Continue with Google" → popup → pick account → signed in.
- [ ] **Web Apple** — same path, "Continue with Apple" → Apple popup →
      sign in → signed in.
- [ ] **iOS Google** (TestFlight Build 36+) — open app → sign-in →
      "Continue with Google" → native Google sheet → signed in.
- [ ] **iOS Apple** (TestFlight Build 36+) — open app → sign-in →
      "Continue with Apple" → native Apple Face ID/Touch ID sheet →
      signed in.

---

## 5. Common error code lookup

| Code | Means | Fix |
|---|---|---|
| `auth/internal-error` | Firebase identity-toolkit rejected the OAuth result. | Most likely Authorized origins/redirect URIs mismatch (see §1). |
| `auth/unauthorized-domain` | The page's origin isn't in Firebase Auth's authorized domains list. | Add the domain in Firebase Console → Authentication → Settings (see end of §1). |
| `auth/operation-not-allowed` | The provider is disabled in Firebase Console. | Enable it in Authentication → Sign-in method. |
| `auth/popup-blocked` | Browser blocked the popup. | User-side: allow popups for the origin, or use email sign-in. |
| `auth/popup-closed-by-user` | User dismissed the popup before completing. | Ignored by the app — silent retry. |
| `auth/missing-or-invalid-nonce` | Apple identity token was already consumed (native iOS only). | `skipNativeAuth: true` on the plugin call. **Already fixed in `a2220bc` — needs Build 36 upload.** |
| `auth/account-exists-with-different-credential` | Same email already exists with a different sign-in method. | Sign in with the original method first; we surface a clean message. |
| `auth/network-request-failed` | Client lost connectivity mid-flow. | User-side: retry on a stable network. |

---

## 6. Things that are NOT the cause (already ruled out)

- **App Check enforcement.** `firestore.rules` and `storage.rules`
  both have `function appCheckOk() { return true; }` — App Check is
  in monitoring mode, not enforcing. App Check tokens are not gating
  Firebase Auth requests.
- **CSP blocking.** `index.html` line 6 explicitly allows
  `https://accounts.google.com`, `https://*.firebaseapp.com`,
  `https://www.google.com` in `frame-src` and `connect-src`.
- **JS scoping bug.** Confirmed `window.signInWithPopup`,
  `window.GoogleAuthProvider`, `window.OAuthProvider`,
  `window.signInWithCredential` are all populated at module load
  (`index.html` lines 4485-4488). The `[diag plugin=no native=false]`
  diagnostic in the user-visible error confirms the handler
  successfully read the `IS_NATIVE` and `FBAuthPlugin` mirrors —
  i.e. the JS bridge isn't broken.
- **iOS REVERSED_CLIENT_ID drift.** `Info.plist` URL scheme
  (`com.googleusercontent.apps.982122063122-1pjjhvrnpcqhfvaumi9hlmvtsgnlm8kb`)
  matches `GoogleService-Info.plist`'s `REVERSED_CLIENT_ID` — Build
  35's working Google sign-in already proved this.
- **Service Worker caching.** `sw.js` uses **network-first** for HTML
  navigation (lines 84-106 of `sw.js`); a hard-refresh always pulls
  fresh `index.html`. SW would only mask a deploy if the deploy
  itself didn't ship — verify `dist/index.html` matches `index.html`
  pre-push (`diff index.html dist/index.html` → empty).

---

## 7. Useful commands while debugging

```bash
# Confirm web bundle is in sync with source
diff /Users/jakenair/Desktop/teebox/index.html \
     /Users/jakenair/Desktop/teebox/dist/index.html

# Confirm iOS bundle is in sync with source
diff /Users/jakenair/Desktop/teebox/index.html \
     /Users/jakenair/Desktop/teebox/ios/App/App/public/index.html

# Confirm window-mirrored auth helpers are present
grep -c 'window.signInWithPopup' /Users/jakenair/Desktop/teebox/index.html
# expect: 3

# Confirm REVERSED_CLIENT_ID is consistent
grep REVERSED_CLIENT_ID /Users/jakenair/Desktop/teebox/ios/App/App/Info.plist \
                        /Users/jakenair/Desktop/teebox/ios/App/App/GoogleService-Info.plist
```

---

## 8. What to send Claude if it's still broken after all of the above

1. Screenshot of Chrome DevTools **Console** tab after clicking
   "Continue with Google" (incognito, with **Preserve log** on).
2. Screenshot of Chrome DevTools **Network** tab filtered to
   `identitytoolkit` after the same click — specifically the response
   body of any 4xx response.
3. Screenshot of the OAuth Web Client's **Authorized JavaScript
   origins** + **Authorized redirect URIs** lists (Google Cloud Console).
4. Screenshot of Firebase Console → Auth → Sign-in method → Apple
   row's **OAuth code flow configuration** panel (with the private
   key field redacted).

These four together are enough to pinpoint any remaining gap.
