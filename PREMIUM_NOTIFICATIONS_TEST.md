# Premium Subscription Lifecycle — Notifications Test Plan

Manual / preview / validation runbook for the seven Pro Seller subscription
notifications.

| # | Trigger | Email template | Push |
|---|---|---|---|
| 1 | free → pro, status=active | `ProWelcome.jsx` | "You're on Pro Seller — fees are now 3%" |
| 2 | Each successful charge | none (Stripe sends receipt) | — |
| 3 | 3 days before period end | `ProRenewalReminder.jsx` | — |
| 4 | status → past_due | `ProPaymentFailed.jsx` | "Pro Seller payment failed" |
| 5 | past_due → active | `ProPaymentRetrySucceeded.jsx` | "Pro Seller renewed" |
| 6 | cancelAtPeriodEnd → true | `ProCanceled.jsx` | — |
| 7 | tier pro → free | `ProDowngraded.jsx` | "Pro Seller ended — fees are now 6.5%" |

All emails are `category: 'transactional'` per CAN-SPAM 16 CFR 316: subscription
status emails relate to an existing transaction (the subscription) and cannot
be unsubscribed from.

---

## File map

- Templates: `functions/emails/subscription/Pro*.jsx`
- Triggers: `functions/subscriptionLifecycle.js`
- Wired from: `functions/index.js` (`Object.assign(exports, require("./subscriptionLifecycle"))`)
- Helpers: `functions/lib/email.js` (`sendEmail`), `functions/lib/push.js` (`sendPush`)
- Shared layout: `functions/emails/layout/Base.jsx`

---

## (1) Stripe Dashboard — REQUIRED user action

We rely on Stripe to send the per-charge subscription receipt (notification #2).
Verify the following before going live:

1. **Branding** — Stripe Dashboard → Settings → Branding
   - Logo: upload the TeeBox icon (use `web/icon-512.png` or higher)
   - Brand color: primary green `#0b3d2e`
   - Accent color: gold `#d6a900`
   - Icon (favicon-style): the small TeeBox mark

2. **Public business info** — Settings → Public details
   - Support email: `support@teeboxmarket.com`
   - Support phone: optional but adds trust to receipt footer
   - Statement descriptor: `TEEBOX PRO` (≤22 chars)

3. **Email receipts** — Settings → Customer emails
   - Toggle **Successful payments** to ON (this drives notification #2)
   - Toggle **Refunds** to ON
   - Toggle **Successful subscription renewals** to ON (separate switch on some accounts)
   - Optional: leave **Failed payments** OFF — our own `ProPaymentFailed`
     email has better copy and a working CTA. If you leave Stripe's failed-
     payment dunning ON you'll double-notify; pick one.

4. **Smart Retries** — Settings → Subscriptions and emails → Manage failed
   payments
   - Confirm Smart Retries is ON (it is by default)
   - Confirm "Cancel subscription if all retries fail" is set to the
     desired horizon (7 days is the default; matches the copy in
     `ProPaymentFailed.jsx` — "we'll retry in 3 days").

5. **Customer.email population** — Audit in code:
   `functions/index.js:4271-4344` (`createSubscriptionCheckout`) passes
   `email` to `stripe.customers.create` when it creates the customer for
   the first time, so all new subscribers have it. For users who had a
   `stripeCustomerId` BEFORE this code path existed, check the Stripe
   Customers list and confirm `customer.email` is set — if not, Stripe
   silently won't send receipts.

---

## (2) Local preview — render a template to HTML

Templates are `.jsx` and require a transpile step that hasn't been wired
into `functions/package.json` yet. The two options:

### Option A — React Email's dev server (best DX)

```bash
cd functions
npx react-email dev
# Opens http://localhost:3000 with all templates rendered live
```

This works without any code changes because `@react-email/components` is
already a dependency.

### Option B — One-shot render via Node (CI / scripts)

```bash
cd functions
# Requires the JSX build step described in EMAIL_OPS_RUNBOOK.md to be wired
# first (esbuild or babel-register). After that:
node -e "
  require('@babel/register')({presets:['@babel/preset-react']});
  const Tpl = require('./emails/subscription/ProWelcome');
  const {render} = require('@react-email/render');
  render(Tpl({user:{firstName:'Jake',uid:'u1'}})).then(html => {
    require('fs').writeFileSync('/tmp/ProWelcome.html', html);
    console.log('wrote /tmp/ProWelcome.html');
  });
"
open /tmp/ProWelcome.html
```

Repeat for each of the six templates with realistic context:

```js
ProWelcome:                {user:{firstName:'Jake',uid:'u1'}}
ProRenewalReminder:        {user:{firstName:'Jake',uid:'u1'},renewal:{renewsOnLabel:'May 15',amountLabel:'$14.99',cardBrand:'Visa',cardLast4:'4242'}}
ProPaymentFailed:          {user:{firstName:'Jake',uid:'u1'}}
ProPaymentRetrySucceeded:  {user:{firstName:'Jake',uid:'u1'}}
ProCanceled:               {user:{firstName:'Jake',uid:'u1'},subscription:{endsOnLabel:'May 15'}}
ProDowngraded:             {user:{firstName:'Jake',uid:'u1'}}
```

---

## (3) End-to-end test plan (once email infra is live)

Prerequisites:

1. Resend project created + sending domain verified (SPF + DKIM + DMARC).
   See `EMAIL_OPS_RUNBOOK.md` for DNS specifics.
2. `firebase functions:secrets:set RESEND_API_KEY` set to a real Resend key.
   (Use a *test* key first — Resend has a sandbox mode that doesn't send
   to real inboxes.)
3. `firebase functions:secrets:set UNSUBSCRIBE_HMAC_SECRET` set to a random
   32-byte value (`openssl rand -base64 32`).
4. JSX → JS build step wired into `npm run build` and `firebase deploy`
   (esbuild or babel; see `EMAIL_OPS_RUNBOOK.md`).
5. Deploy: `firebase deploy --only functions:proWelcomeEmail,functions:proPaymentFailedEmail,functions:proPaymentRetryEmail,functions:proCanceledEmail,functions:proDowngradedEmail,functions:proRenewalReminderScheduled`.

### Per-trigger manual fire (via Firestore Console)

Pick a test user UID (`users/test-uid`). Each row below is a single edit
in the Firestore Console UI that should produce one email + (where listed)
one push.

| # | Edit on `users/test-uid` | Expected output |
|---|---|---|
| 1 | set `tier='pro'`, `proSubscriptionStatus='active'` | ProWelcome email + push |
| 4 | set `proSubscriptionStatus='past_due'` | ProPaymentFailed email + push |
| 5 | set `proSubscriptionStatus='active'` (after #4) | ProPaymentRetrySucceeded email + push |
| 6 | set `proCancelAtPeriodEnd=true` | ProCanceled email (no push) |
| 7 | set `tier='free'` (after `tier` was `pro`) | ProDowngraded email + push |
| 3 | set `proCurrentPeriodEnd` to ~3 days from now + wait ≤1 h | ProRenewalReminder email |

For #2 (Stripe receipt): use the Stripe Dashboard → Customers → test
customer → Payment methods → "Send a test charge" OR trigger via the
Stripe CLI (`stripe trigger invoice.payment_succeeded`).

### Idempotency check

After firing #1, set `users/test-uid.tier` back to `'free'` and then back
to `'pro'` with `proSubscriptionStatus='active'`. The Welcome email
should NOT fire a second time because
`users/test-uid.lifecycleEmailsSent.proWelcome` is already stamped. (To
explicitly re-test, manually delete that field in the console.)

For #5 the stamp key includes the current `proCurrentPeriodEnd` millis,
so a *new* retry cycle (after a future renewal) will fire again
automatically.

### Receive on real inboxes

Send to your own address and verify on all of these clients:

- Gmail web (Chrome)
- Gmail iOS app
- Apple Mail macOS (light + dark mode)
- Apple Mail iOS (light + dark mode)
- Outlook.com web
- Outlook desktop (Windows) — the most opinionated renderer

Check:

- [ ] Logo loads, header background is brand green
- [ ] Body container is 600px wide on desktop, full-width on mobile
- [ ] CTA button is visible, tappable, and links correctly
- [ ] Footer has "transactional — cannot be unsubscribed" copy (no unsub link)
- [ ] Plain-text fallback is readable when you "View source" / hit Reply
- [ ] Subject line shows in inbox preview without truncation
- [ ] Preview-snippet text shows in inbox list view (≤90 chars rendered)

---

## (4) HTML compatibility audit (per template)

Each template was checked against the rules below. Findings recorded inline.

| Rule | ProWelcome | ProRenewalReminder | ProPaymentFailed | ProPaymentRetrySucceeded | ProCanceled | ProDowngraded |
|---|---|---|---|---|---|---|
| Max-width 600 (via Base) | OK | OK | OK | OK | OK | OK |
| Inline styles only | OK | OK | OK | OK | OK | OK |
| Web-safe font stack | OK | OK | OK | OK | OK | OK |
| `<img>` w/h explicit (via Base logo) | OK | OK | OK | OK | OK | OK |
| CTA = styled `<a>` (Button helper) | OK | OK | OK | OK | OK | OK |
| Plain-text fallback (render) | auto | auto | auto | auto | auto | auto |
| Dark-mode friendly | NOTE | NOTE | NOTE | NOTE | NOTE | NOTE |
| `alt` on every img | OK | OK | OK | OK | OK | OK |
| Contrast ratio ≥ 4.5:1 | OK | OK | OK | OK | OK | OK |

**Dark-mode NOTE** — `Base.jsx` sets `<meta name="color-scheme" content="light only">` and `<meta name="supported-color-schemes" content="light">`, which signals Apple Mail and Outlook to NOT invert colors. This is intentional: TeeBox's brand greens look wrong when auto-inverted. Test once on Apple Mail dark mode to confirm; if you want a true dark variant we'd add a `@media (prefers-color-scheme: dark)` block to Base.

**Subject-length audit** (≤50 chars enforced by reviewer):

| Template | Subject | Length |
|---|---|---|
| ProWelcome | `Welcome to Pro Seller — fees are now 3%` | 39 |
| ProRenewalReminder | `Pro Seller renews May 15` (example) | 24 |
| ProPaymentFailed | `Action needed: Pro Seller payment failed` | 40 |
| ProPaymentRetrySucceeded | `Pro Seller renewed — payment received` | 38 |
| ProCanceled | `Pro Seller ends May 15` (example) | 22 |
| ProDowngraded | `Pro Seller ended — fees are now 6.5%` | 36 |

All within budget.

**Preview-text-length audit** (≤90 chars):

| Template | Preview | Length |
|---|---|---|
| ProWelcome | `<name>, your seller fee dropped from 6.5% to 3%.` | ~50 |
| ProRenewalReminder | `$14.99 will be charged on May 15.` | ~33 |
| ProPaymentFailed | `Update your payment method to keep Pro Seller fees at 3%.` | 57 |
| ProPaymentRetrySucceeded | `Your card was charged successfully. Pro Seller is renewed.` | 58 |
| ProCanceled | `You keep Pro Seller until May 15. Reactivate any time.` | ~55 |
| ProDowngraded | `Reactivate any time to drop your seller fee back to 3%.` | 55 |

All within budget.

---

## (5) Cross-client preview without 6 real inboxes

The above test plan requires you to own real accounts on Gmail / Outlook /
Apple Mail. For a faster pre-launch sweep, use one of:

- **Litmus Email Previews** (https://litmus.com) — ~$99/mo, sends a test
  email and renders it on ~90 client/version combinations including
  Outlook 2016/2019/365 desktop, the most fragile ones.
- **Email on Acid** (https://www.emailonacid.com) — similar, ~$89/mo.
- **Resend's built-in preview** — Resend Dashboard → Emails → click any
  sent email → renders the HTML inline. Free, but only shows the
  source-fidelity render, not per-client visual diffs.

Recommendation: skip the paid tools for the first launch; rely on the 6
real inboxes above + Resend's preview. Subscribe to Litmus only if a
deliverability or rendering complaint comes in from a real user.

---

## (6) Known limitations

- **#5 (payment retry succeeded) can't be tested until #4 fires first.**
  In Stripe test mode, use payment method `4000000000000341` (charges
  succeed once then fail on retry) to drive a real past_due transition,
  then update the customer's default payment method to a working card
  to trigger the recovery.
- **Renewal reminder (#3)** is a `onSchedule('every 1 hours', ...)` cron.
  It only fires after deploy + after the scheduled run completes once
  with a user in the 3-day window. To manually trigger, set
  `proCurrentPeriodEnd` to ~3 days from now and run
  `firebase functions:shell` → call `proRenewalReminderScheduled()`.
- **Card brand / last4 in the renewal reminder** — we don't currently
  cache the user's default payment method on `users/{uid}`. The template
  shows generic "card on file" text. Future enhancement: fetch
  `customer.invoice_settings.default_payment_method` in
  `handleSubscriptionUpsert` and store `proCardBrand` + `proCardLast4`
  on the user doc.
- **Cross-client visual rendering** cannot be validated automatically —
  requires live sends to real inboxes. See section (3).

---

## (7) Open questions for the product owner

1. **Do we want a 3-day renewal reminder at all?** Some subscription
   businesses skip it deliberately to reduce churn (the reminder
   surfaces "wait, am I getting value from this?" friction). Other
   businesses are required to send it for legal/UX reasons (e.g.,
   California ARLA). Current default: send it. Flag this for a UX
   decision before launch.
2. **Stripe's "failed payment" dunning emails — leave ON or OFF?**
   Leaving them ON double-notifies the user (Stripe's email + our
   `ProPaymentFailed`). Our email has better copy and a working CTA;
   recommendation is OFF.
3. **Push for #6 (cancel)?** Spec says no push. Argument for adding one:
   confirms the cancel landed and reduces "did my cancel go through?"
   support tickets. Argument against: cancellation is a low-urgency
   acknowledgement and email is sufficient. Current: email only.
4. **Reactivation CTA in `ProCanceled` and `ProDowngraded`** currently
   links to `/account?tab=billing`. If we build a dedicated
   `/pro-reactivate` flow with one-click checkout, swap the URLs.
