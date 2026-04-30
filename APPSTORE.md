# TeeBox — App Store Connect submission packet

Copy-paste reference for the App Store Connect listing fields.
Generated 2026-04-26 from a full code audit of `index.html`,
`firestore.rules`, `functions/index.js`, `Info.plist`, and the
manifest.

---

## ⚠️ Critical pre-submission steps — do these BEFORE submitting

### A. Whitelist a test phone number in Firebase (5 min)

The app uses **phone-number-only auth with no guest mode**. Apple
reviewers cannot receive SMS, so they cannot get past the login
screen — this is the #1 rejection reason for SMS-auth marketplace
apps.

1. Go to https://console.firebase.google.com → your TeeBox project
   → **Authentication** → **Sign-in method** tab
2. Click **Phone** to expand
3. Scroll down to **Phone numbers for testing (optional)**
4. Click **Add phone number**
5. Phone: `+1 555-555-1234`
6. Verification code: `123456`
7. Save

This whitelists that number — Firebase will return a successful
auth without actually sending an SMS. The reviewer signs in with
this combo and gets a real authenticated session.

### B. Authorize the Capacitor domain in Firebase (3 min)

In WKWebView the page loads from `capacitor://localhost`, which
Firebase Auth doesn't accept by default — the reCAPTCHA verifier
will fail.

1. In the same **Authentication** section → **Settings** tab
2. Scroll to **Authorized domains**
3. Click **Add domain**
4. Add each of these (one at a time):
   - `localhost`
   - `capacitor.localhost`
   - `app.localhost`
5. Save

### C. Deploy the new account-deletion Cloud Function (5 min)

We added an in-app **Delete account** button (Apple guideline
5.1.1(vi) requires this since iOS 15). The button calls a callable
Cloud Function — you need to deploy it before the button works:

```bash
cd /Users/jakenair/Desktop/teebox
firebase deploy --only functions:deleteUserAccount
```

If you haven't authenticated the Firebase CLI in this terminal:
```bash
firebase login
firebase use teebox-market   # or whatever your project ID is
```

### D. Bump build number and re-upload to TestFlight (10 min)

Code changes mean Build 1 in TestFlight is now stale. To submit the
fixed version:

1. `npm run cap:sync` — copies new web bundle into the iOS app
2. In Xcode, with the App target selected:
   - **Signing & Capabilities** tab → bump **Build** from `1` to `2`
3. **Product → Archive** → Organizer → **Distribute App** →
   **App Store Connect** → **Upload**
4. Wait for Build 2 to finish processing (~10–30 min)
5. Attach Build 2 to the App Store version in App Store Connect
   (replace Build 1 in the Build section)

---

## 1. App Information (one-time, set under "App Information")

| Field | Value |
|---|---|
| Bundle ID | `com.teeboxmarket.app` |
| SKU | `teebox-ios-001` |
| Primary Language | English (U.S.) |
| Name | `TeeBox` |
| Subtitle | `Buy & sell golf gear` |
| Primary Category | **Shopping** |
| Secondary Category | **Sports** |
| Content Rights | Does not contain, show, or access third-party content |
| Age Rating | **12+** (see questionnaire below) |

### URLs

| Field | Value |
|---|---|
| Privacy Policy URL | `https://teeboxmarket.com/?launch=privacy` ✅ verified live |
| Support URL | `https://teeboxmarket.com/` |
| Marketing URL (optional) | `https://teeboxmarket.com/` |

---

## 2. Version 1.0 fields (set under "1.0 Prepare for Submission")

### Promotional Text (170 char max — can update without re-review)

```
The peer-to-peer marketplace for golfers. Buy and sell clubs, apparel, and gear at transparent prices — with secure payments and shipping protection.
```
(167 chars)

### Description (4000 char max)

```
TeeBox is the peer-to-peer marketplace built for golfers.

Buy and sell clubs, apparel, accessories, and memorabilia at transparent market prices, directly from other golfers. No middlemen, no inflated retail markups — just gear changing hands at fair prices.

WHY TEEBOX

• Transparent pricing — see live ask and bid prices on popular models, plus historical price data, so you know exactly what gear is worth before you buy or list.
• Secure payments — every transaction runs through Stripe with Visa, Mastercard, Amex, Apple Pay, and Google Pay. Funds are held until the buyer confirms delivery, like the marketplace giants.
• No counterfeits — sellers verify their phone number and agree to seller terms before listing. Counterfeit, stolen, or misrepresented items are prohibited and removed.
• Direct messaging — ask the seller anything before you commit. Request more photos, confirm condition, negotiate price.
• Place a bid — don't love the asking price? Submit an offer and the seller can accept, decline, or counter.

HOW IT WORKS

1. Browse listings — explore thousands of golf items posted directly by sellers. Buy at the listed ask or place a bid.
2. Message the seller — ask questions, request more photos, and confirm condition before you commit. Every conversation is logged.
3. Ship & receive — sellers ship the item directly. Funds are held until the buyer confirms delivery.

WHAT YOU CAN BUY OR SELL

• Drivers, irons, wedges, putters, and full sets
• Golf bags, push carts, and travel cases
• Apparel — polos, outerwear, hats, gloves, shoes
• Accessories — rangefinders, GPS devices, training aids
• Memorabilia — signed items, vintage clubs, collectibles

FOR SELLERS

• 6.5% transaction fee on completed sales — no listing fees, no monthly fees, no hidden charges
• List in seconds with photos from your phone
• Built-in dashboard tracks your active listings, sold items, and earnings
• Get paid out via Stripe after the buyer confirms delivery

FOR BUYERS

• Zero buyer fees
• Watchlist saves items you're interested in
• Saved searches notify you when matching items are listed
• Buyer protection on every order

PRIVACY & SECURITY

• Your phone number is private to your account, never shown publicly
• We never store your card details — Stripe handles all payment data directly
• No third-party advertising trackers, no data sales, no spam
• Conversations are visible only to the two members in them

Available now in the U.S. Your golf bag, your terms.

Questions? Email hello@teeboxmarket.com
```

### Keywords (100 char max, comma-separated, NO spaces after commas)

```
golf,marketplace,clubs,gear,resell,putter,driver,irons,bag,apparel,sell,buy,sports,equipment
```
(100 chars exactly — count before pasting)

### Support URL
`https://teeboxmarket.com/`

### Marketing URL (optional)
`https://teeboxmarket.com/`

### What's New in This Version

```
Initial release.
```

### Copyright

```
© 2026 TeeBox Market
```

---

## 3. App Privacy questionnaire

Set under "App Privacy" in the left sidebar of App Store Connect.

For each data type, Apple asks: (a) Is it collected? (b) Linked to user identity? (c) Used for tracking? (d) What purposes?

### ✅ Data COLLECTED and LINKED to user

| Data Type | Apple Category | Purposes | Tracking? |
|---|---|---|---|
| Phone number | Contact Info → Phone Number | App Functionality | NO |
| Display Name | Contact Info → Name | App Functionality | NO |
| Photos (listings + avatar) | User Content → Photos or Videos | App Functionality | NO |
| Listing descriptions | User Content → Other User Content | App Functionality | NO |
| Messages between users | User Content → Other User Content | App Functionality | NO |
| Reviews / ratings | User Content → Customer Support | App Functionality | NO |
| Purchase history | Purchases → Purchase History | App Functionality | NO |
| Order records | Purchases → Purchase History | App Functionality | NO |
| Profile bio | User Content → Other User Content | App Functionality | NO |
| Profile location (optional, user-typed text) | Location → Coarse Location | App Functionality | NO |

### ❌ Data NOT collected

- Email address
- Physical address
- Precise location
- Browsing history (no analytics enabled)
- Search history (server-side; saved searches are user-initiated only)
- Contacts
- Health & fitness
- Financial info (Stripe handles all payment data — does not flow through TeeBox)
- Payment info (card numbers — never touch our servers)
- Sensitive info
- Device ID
- Advertising data
- Product interaction (no telemetry)
- Crash data (Crashlytics not installed)
- Performance data
- Other diagnostic data

### Tracking
**NO TRACKING.** TeeBox does not use third-party advertising trackers,
does not share user data with data brokers, and does not link user
data with data from other apps/websites for advertising or measurement.
This means **App Tracking Transparency prompt is NOT required.**

---

## 4. Age Rating questionnaire

Apple's questionnaire — answer each question:

| Question | Answer |
|---|---|
| Cartoon or Fantasy Violence | None |
| Realistic Violence | None |
| Prolonged Graphic or Sadistic Realistic Violence | None |
| Profanity or Crude Humor | None |
| Mature/Suggestive Themes | None |
| Horror/Fear Themes | None |
| Sexual Content or Nudity | None |
| Graphic Sexual Content and Nudity | None |
| Alcohol, Tobacco, or Drug Use or References | None |
| Simulated Gambling | None |
| Medical/Treatment Information | None |
| Contests | None |
| Unrestricted Web Access | **No** |
| Gambling and Contests | None |
| **User Generated Content** | **Yes** (listings, photos, messages, reviews) |

**Resulting age rating: 12+**

The 12+ rating comes from the user-generated content disclosure.
TeeBox has block, report, and dispute features which qualifies for
12+ rather than 17+.

---

## 5. App Review Information (CRITICAL — this is the reviewer notes field)

### Sign-In Required
**Yes** (toggle "Sign-in required" = ON)

### Demo Account
| Field | Value |
|---|---|
| Username | `+1 555-555-1234` |
| Password | `123456` |

(After you whitelist this number in Firebase per the instructions
at the top of this doc.)

### Notes (paste exactly into the App Review Notes field)

```
Thank you for reviewing TeeBox.

SIGN IN INSTRUCTIONS:
TeeBox uses phone-number authentication via SMS. We have whitelisted a test phone number specifically for App Review:

  Phone: +1 555-555-1234
  Verification code: 123456

To sign in:
1. Launch the app
2. On the welcome screen, tap "Sign In"
3. Enter the phone number above (with country code +1)
4. Tap "Send code" — no real SMS will be sent
5. Enter the verification code 123456
6. You will be signed in as a test account

WHAT TO TRY:
• Browse listings on the home screen
• Tap any listing to see details, then "Place Bid" or "Message Seller"
• Tap "Sell" in the bottom nav to create a new listing
• Tap your profile icon (top right) to view your account

PAYMENTS:
The app uses Stripe for payments. For App Review, please do not complete an actual purchase. The checkout flow can be opened to verify the UI without confirming payment.

CONTENT MODERATION:
TeeBox includes user-generated content (listings, photos, messages, reviews). The app has built-in reporting (per-message and per-listing), user blocking, and a dispute resolution system. Inappropriate content is reviewed and removed within 24 hours of report.

CONTACT:
For any review questions: hello@teeboxmarket.com
```

### Contact Information (for the Apple reviewer to reach you)
| Field | Value |
|---|---|
| First Name | Jake |
| Last Name | Nair |
| Phone | (your phone) |
| Email | jakenair23@gmail.com |

---

## 6. Pricing and Availability

| Field | Value |
|---|---|
| Price | **Free** |
| Availability | Recommend: **United States only** for v1 (expand later) |
| App Distribution | Public on App Store |
| Pre-Orders | Off |

---

## 7. Build attached
Build 1 (1.0) — already uploaded, status "Ready to Submit". Click **+ Add Build** in the version page and select build 1.

---

## 8. Screenshots (ONLY YOU can do this — required before submission)

Apple requires screenshots for at least one device size:

| Size | Resolution | Required? |
|---|---|---|
| 6.7" iPhone (Pro Max) | 1290 × 2796 | **YES** (1 minimum, 10 max) |
| 6.5" iPhone | 1242 × 2688 | optional |
| 5.5" iPhone | 1242 × 2208 | optional |
| iPad 12.9" | 2048 × 2732 | only if iPad-supported |

**How to take them:**
1. Install TeeBox via TestFlight on your iPhone (Pro/Pro Max ideally)
2. Sign in with the test phone number
3. Press Volume Up + Side button simultaneously to screenshot
4. Capture: home/browse, search results, listing detail, messaging, profile, sell flow

Recommended 5–6 screenshots covering: hero/home, listing detail with bid, messages, profile/dashboard, sell flow.

---

## 9. Last-mile checklist (before clicking Submit for Review)

- [ ] Firebase test phone number whitelisted (`+1 555-555-1234` / `123456`)
- [ ] Build 1 attached to Version 1.0
- [ ] All 14 metadata fields filled in App Store Connect
- [ ] Screenshots uploaded (at least 1 × 6.7")
- [ ] App Privacy questionnaire completed
- [ ] Age rating questionnaire completed
- [ ] Pricing set to Free
- [ ] Availability selected
- [ ] Demo account in App Review Information
- [ ] Personal contact info in App Review Information
- [ ] Test the app on your phone via TestFlight first — find any crash, fix it, upload build 2 if needed

When all are checked → blue **Submit for Review** button activates → click → Apple reviews in 1–3 days.

---

## 10. Things to know about the review

**Likely review timeline:** 24–72 hours for first submission.

**Most common rejection reasons for this kind of app:**
- 2.1 App Completeness — reviewer can't sign in. Mitigated by the test phone number.
- 4.0 Design — minimum functionality / "feels like a website wrapper". Mitigated by native splash, status bar, offline mode, install shortcuts.
- 5.1.1 Data Collection — privacy disclosure mismatch. Privacy policy and questionnaire align, so this should pass.

If rejected, Apple sends a Resolution Center message — read it carefully, fix exactly what they cite, reply in the Resolution Center (don't always need a new build).
