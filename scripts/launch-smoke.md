# TeeBox Launch Smoke Test (~5 minutes)

Run this immediately after `npm run launch:deploy` succeeds. Each step
should complete in seconds — if anything stalls or errors, capture
console + Firebase logs before continuing.

## Pre-flight: clean client

- [ ] Open **incognito** window → https://teeboxmarket.com
- [ ] Hard-refresh (Cmd+Shift+R)
- [ ] DevTools console is **clean** (no red errors, no failed fetches)
- [ ] DevTools → Application → Service Workers: active SW version string matches `CACHE_VERSION` in `sw.js`

## Auth

- [ ] Click Sign In → phone tab
- [ ] Enter test number `+1 555-555-1234`
- [ ] Enter test code `123456`
- [ ] Lands on home, header shows signed-in avatar

## Browse + bid

- [ ] Home feed loads listings (no skeleton stuck)
- [ ] Open any listing detail page
- [ ] Place a test bid (min increment) → bid appears in offer/bid list

## Messaging → email

- [ ] From a listing, send seller a test message ("smoke test")
- [ ] Confirm seller receives email (check Resend dashboard → Logs, or seller inbox)
- [ ] Email subject + body render correctly (no `{{template}}` leaks)

## Seller dashboard

- [ ] Open **My Shop**
- [ ] Top analytics row populates (views / messages / bids / earnings)
- [ ] Advanced insights section loads without error
- [ ] No `Missing or insufficient permissions` in console

## Stripe checkout

- [ ] Find a $0.50 (or cheapest) test listing — or temporarily list one
- [ ] Buy with card `4242 4242 4242 4242`, any future expiry, CVC `123`, ZIP `12345`
- [ ] Stripe redirects back → order confirmation page
- [ ] Buyer receives **order confirmation email**

## Shipping notification

- [ ] As seller, open the test order → **Mark shipped** (paste any tracking number)
- [ ] Buyer receives **shipment email** (Resend logs again)
- [ ] Order status updates to "Shipped" for buyer

## Account-deletion modal (do NOT delete)

- [ ] Settings → Delete account → modal opens, copy reads correctly
- [ ] Cancel out — verify no `deleteUserAccount` call fires until confirm

---

If every box is checked: launch is green. If any item failed, file
the symptom in `LAUNCH.md` under "Known issues" and decide go/no-go
before App Store submission.
