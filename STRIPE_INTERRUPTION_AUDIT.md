# Stripe Premium-Upgrade Interruption / Race Audit

Scope: read-only audit of the "Upgrade to Pro" flow against five mid-flow interruption / race scenarios. No code modified. Companion to `STRIPE_FAILURE_AUDIT.md` (different agent).

Codebase pointers (verified line numbers, not the prompt's guesses):
- `functions/index.js:4271-4344` — `createSubscriptionCheckout`
- `functions/index.js:465-606` — `stripeWebhook` dispatcher
- `functions/index.js:653-700` — `handleSubscriptionUpsert`
- `functions/index.js:702-717` — `handleSubscriptionDeleted`
- `functions/index.js:4346-4369` — `createBillingPortalSession`
- `index.html:13589-13628` — `A['upgrade-to-pro']` handler
- `index.html:13571-13588` — `A['open-pro-upgrade']` (modal-open + button reset)
- `index.html:11610-11625` — `?checkout=pro_success` / `?checkout=pro_cancel` URL handlers
- `index.html:2825-2863` — Pro upgrade modal markup
- `index.html:8929-8982` — `renderProTierBanner` (the banner re-render)
- `index.html:8444` — single fire-and-forget call site for the banner

---

## Verdict table

| # | Scenario | Verdict | Severity |
|---|----------|---------|----------|
| 1 | User closes the app mid-checkout | PASS | NONE |
| 2 | Network drops between Stripe success page and our `success_url` | PARTIAL — webhook is authoritative, but the in-session banner does not re-render | LOW |
| 3 | User backgrounds the app for 5 min mid-checkout | PASS | NONE |
| 4 | Double-tap on Upgrade | PARTIAL — second-press protection is good, but `customers.create` has **no idempotency key** | LOW |
| 5 | Two tabs / two devices simultaneously | **FAIL** — race window allows two concurrent subscriptions; user can be double-charged | **HIGH** |

---

## Scenario 1 — User closes the app mid-checkout

### Expected
- `createSubscriptionCheckout` writes *only* durable identity data (a `stripeCustomerId` if missing), not a "pending upgrade" flag.
- Webhook does NOT react to `checkout.session.expired` by flipping anything to Pro.
- Stripe-side, the Checkout Session expires after 24h with no DB side-effects.

### Actual (cited)
`functions/index.js:4313-4325`:
```
let customerId = user.stripeCustomerId;
if (!customerId) {
  const customer = await stripeClient.customers.create({ ... });
  customerId = customer.id;
  await userRef.set({
    stripeCustomerId: customerId,
    stripeCustomerCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}
```
Only `stripeCustomerId` + `stripeCustomerCreatedAt` are written. There is **no `pendingUpgrade`, `proPending`, `checkoutSessionId`, or equivalent flag** on the user doc.

`functions/index.js:529-583` (the `switch (event.type)`): the only subscription events handled are `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. `checkout.session.expired` is **not** in the list — it falls through to `default` (`logger.info("Unhandled event type: ...")`). No tier flip on expiry.

### Verdict
PASS, no fix needed. Closing the tab leaves the user in a clean state — they can retry the upgrade flow indefinitely. The persisted `stripeCustomerId` is durable and is correctly reused on retry.

---

## Scenario 2 — Network drops between Stripe success page and our `success_url`

### Expected
- Webhook is the single source of truth for the tier flip.
- The `?checkout=pro_success` URL handler is decorative — no callable to "confirm" the upgrade.
- On reload after the webhook has run, the banner reflects Pro status.

### Actual (cited)
`index.html:11610-11617`:
```js
if (__checkoutQ === 'pro_success') {
  setTimeout(() => {
    if (typeof showToast === 'function') {
      showToast("You're on Pro Seller — fees are now 3%. Welcome aboard.", 'success');
    }
  }, 600);
  try { history.replaceState({}, '', location.pathname); } catch (_e) {}
}
```
The success handler is **purely cosmetic** — toast + URL clean-up. No client-side tier write. No "confirm" callable. Good.

`functions/index.js:653-700` (`handleSubscriptionUpsert`) is invoked from `customer.subscription.created`/`.updated` regardless of the user's browser state, and is wrapped in event-id replay protection at `functions/index.js:504-527` (`processedStripeEvents/{event.id}` atomic create). The webhook **is** authoritative.

`handleSubscriptionUpsert` also calls `admin.auth().revokeRefreshTokens(userDoc.id)` (`functions/index.js:690`) so the new tier propagates to the next ID-token refresh — though see note below.

**Gap:** `renderProTierBanner` (`index.html:8929-8982`) is called exactly once from `renderShopTables` (`index.html:8444`) — it's a fetch-once on dashboard open. There is **no `onSnapshot` listener** on `users/{uid}` (verified by grep — only one `getDoc` reads the user doc in this banner code path). Consequence:

- User pays, Stripe redirects to `?checkout=pro_success`.
- The success toast fires (600ms timeout).
- Webhook commits `tier='pro'` in the same second.
- But the banner the user is staring at was rendered *before* the webhook landed, so it still shows the "Upgrade to Pro" free-tier CTA. Only navigating away and back re-paints.

### Verdict
LOW. Not a correctness bug (the next dashboard re-render is correct), but a user-experience inconsistency that will generate "I paid but it still says Upgrade" support tickets.

### Recommended fix sketch
At `index.html:11610`, after the success toast, schedule a `renderProTierBanner()` re-render with a small delay to let the webhook commit, and ideally attach a short-lived `onSnapshot(doc(db, 'users', uid))` for ~30s so the banner flips live:

```js
if (__checkoutQ === 'pro_success') {
  setTimeout(() => {
    if (typeof showToast === 'function') showToast("...", 'success');
    // Re-paint a few times — webhook may not have landed yet.
    [1500, 4000, 10000].forEach(t =>
      setTimeout(() => { try { renderProTierBanner(); } catch (_e) {} }, t)
    );
  }, 600);
  // ...
}
```

Bonus: also force-refresh the ID token (`window.CURRENT_USER.getIdToken(true)`) so custom claims / rules see the new tier without a sign-out cycle. Note: `revokeRefreshTokens` at `functions/index.js:690` does NOT immediately sign the user out — the current ID token stays valid up to its 1h expiry. So no auth screen interruption.

---

## Scenario 3 — User backgrounds the app for 5 min mid-checkout

### Expected
- No client-side timeout / polling / "session in progress" flag that assumes the user returns within N seconds.
- If the auth session refreshes during the wait, the webhook still works (Admin SDK).

### Actual (cited)
Grep of `index.html` for `setTimeout`/`setInterval` constrained to `pro|checkout|upgrade|tier`-adjacent code returned **only** the two cosmetic toasts at lines 11611 and 11619 (both 600ms — these fire on return, not waiting for it). No polling. No in-progress flag. The upgrade-to-pro handler awaits `httpsCallable` once, gets a URL, navigates. No state to expire.

`A['open-pro-upgrade']` (`index.html:13583-13584`) defensively resets `btn.disabled = false; btn.textContent = 'Upgrade now'` every time the modal opens — so even if the user comes back hours later and re-opens, the button isn't stuck in "Opening Stripe…".

Webhook side: uses Admin SDK (`functions/index.js:478` initializes `stripeClient`; subscription handlers use `admin.firestore()` and `admin.auth()` directly — no end-user auth context required). Works whether the user is signed in, signed out, or on a different device.

### Verdict
PASS. The flow is genuinely stateless on the client between the redirect to Stripe and the return.

Sub-finding (not a bug): if the user's ID token expires during the wait (1h), the webhook still completes the upgrade correctly. The user will see a stale-token error only if they try to *do* something post-return — at which point Firebase Auth auto-refreshes. The post-webhook `revokeRefreshTokens` (`functions/index.js:690`) is the only thing that could surprise: it forces the next refresh to fail, so a user whose token expires AFTER the upgrade webhook will be signed out and need to re-auth. Acceptable trade-off (it's how the new tier propagates to the next session).

---

## Scenario 4 — Double-tap on Upgrade

### Expected
- Button disables synchronously on click, before any await.
- `createSubscriptionCheckout` is idempotent enough that a race doesn't create two `Customer` records.

### Actual (cited)
`index.html:13598-13605`:
```js
const btn = document.getElementById('proUpgradeBtn');
if (btn) { btn.disabled = true; btn.textContent = 'Opening Stripe…'; }
try {
  const { getFunctions, httpsCallable } =
    await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
  const fns = getFunctions();
  const fn = httpsCallable(fns, 'createSubscriptionCheckout');
  const res = await fn();
```

- `btn.disabled = true` is set **synchronously before any `await`**. Good — a same-frame second tap is dropped by the browser because `disabled` buttons don't dispatch click events.
- BUT: the underlying `data-action="upgrade-to-pro"` dispatch is via the action map `A[...]`. If the host's action-dispatcher invokes the handler before the DOM repaint (e.g. queued events from a fast scripted double-tap or accessibility tools), there's a microtask window where two invocations could race. Hard to trigger in practice.

`functions/index.js:4313-4325` (the Customer-create path):
```js
let customerId = user.stripeCustomerId;
if (!customerId) {
  const customer = await stripeClient.customers.create({
    email,
    name: displayName,
    metadata: {firebaseUid: uid},
  });
  ...
}
```
**No `idempotencyKey` passed to `customers.create`.** If two parallel calls land for a user without a `stripeCustomerId`, both will create a Stripe Customer — leaving one orphaned (the loser's Customer is not referenced from any user doc). Both Checkout Sessions get returned. The user's browser navigates to whichever URL the first promise resolves to; the second is silently discarded.

`functions/index.js:4291-4299`:
```js
if (user.tier === "pro" && user.proSubscriptionId) {
  throw new HttpsError(
    "already-exists",
    "You're already on Pro. ...",
  );
}
```
The `already-exists` guard exists and the client at `index.html:13619` handles it gracefully (`showToast("You're already on Pro...")`).

### Verdict
LOW. No double-charge (only one Checkout Session URL can be completed by the user — the second URL is just discarded by the redirect). But:

- **Orphan Stripe Customer records** when a user with no `stripeCustomerId` double-fires. Pollutes the Stripe dashboard; mildly hurts billing analytics. Severity LOW because the volume should be tiny.
- **The `already-exists` guard reads users/{uid}.tier — which is webhook-updated.** During the brief window between Checkout completion and the webhook landing, a re-tap *could* succeed in creating a second subscription. See scenario 5 — same root cause.

### Recommended fix sketches
1. Pass an idempotency key to `customers.create` keyed off the firebase UID:
```js
const customer = await stripeClient.customers.create(
  { email, name: displayName, metadata: {firebaseUid: uid} },
  { idempotencyKey: `customer_${uid}` },
);
```
This guarantees two parallel calls return the *same* Customer object — no orphans.

2. Also wrap the `checkout.sessions.create` call (`functions/index.js:4327-4340`) with a per-uid + minute-bucketed idempotency key:
```js
{ idempotencyKey: `checkout_${uid}_${Math.floor(Date.now() / 60000)}` }
```
That way a double-tap inside a 60-second window returns the same Checkout Session URL, not two. Lower bound on cost: zero. Hard to argue against.

---

## Scenario 5 — Two tabs / two devices simultaneously

### Expected
- Server-side guard rejects a second Checkout creation if the user already has an active subscription.
- Otherwise, a back-end check or Stripe-Portal config prevents two simultaneous subscriptions on the same Customer.

### Actual (cited)
`functions/index.js:4291-4299` — the only guard:
```js
if (user.tier === "pro" && user.proSubscriptionId) {
  throw new HttpsError("already-exists", "...");
}
```
The guard reads `users/{uid}.tier`, which is **only** set by `handleSubscriptionUpsert` *after* a `customer.subscription.created` webhook lands.

`functions/index.js:653-683` (`handleSubscriptionUpsert`) overwrites:
```js
const update = {
  proSubscriptionId: sub.id,
  proSubscriptionStatus: status,
  ...
};
```
`proSubscriptionId` is **set, not appended** — whichever webhook fires last clobbers the earlier subscription's id, orphaning it in Firestore (Stripe still bills both).

There is **no call to `stripeClient.subscriptions.list({customer, status:'active'})`** in `createSubscriptionCheckout` (verified by grep — the only `subscriptions.list` call in the file is in the account-deletion path at `functions/index.js:1577`).

### Failure sequence (concrete)
1. T=0: Free user opens tab A on desktop, taps Upgrade. `createSubscriptionCheckout` runs, reads `tier='free'`, returns Checkout URL A.
2. T=2s: Same user opens tab B on phone, taps Upgrade. `createSubscriptionCheckout` runs, reads `tier='free'` (Checkout A hasn't completed yet), returns Checkout URL B.
3. T=30s: User completes Checkout A. Stripe creates Subscription S_A, charges $14.99, fires `customer.subscription.created` webhook. `handleSubscriptionUpsert` writes `tier='pro'`, `proSubscriptionId='S_A'`.
4. T=60s: User completes Checkout B. Stripe creates Subscription S_B (no Stripe-side guard against multiple subs on one Customer), charges another $14.99, fires `customer.subscription.created` webhook. `handleSubscriptionUpsert` writes `proSubscriptionId='S_B'` — **orphaning S_A**.
5. The user is now charged $29.98/month. The `manage-subscription` button (`functions/index.js:4346-4369`) opens the Stripe Customer Portal, which (depending on Stripe Dashboard configuration) may or may not show both subscriptions.

### Verdict
**FAIL — HIGH severity.** Real customer-facing double-charge with no automatic refund. The window is small (the two checkouts must both complete before either webhook fires), but it's a real failure mode for a determined or just-impatient user.

### Recommended fix sketch (server-side, defensive — recommended)
In `createSubscriptionCheckout`, before creating the Checkout Session (i.e. between `functions/index.js:4325` and `:4327`), list active subscriptions on the Stripe customer:

```js
// After ensuring customerId exists, before checkout.sessions.create:
const existing = await stripeClient.subscriptions.list({
  customer: customerId,
  status: "all",
  limit: 5,
});
const hasActive = (existing.data || []).some(s =>
  s.status === "active" ||
  s.status === "trialing" ||
  s.status === "past_due" ||
  s.status === "incomplete"   // <- key: catches the "Checkout A done, webhook not yet processed" window
);
if (hasActive) {
  throw new HttpsError(
    "already-exists",
    "You already have a Pro subscription in progress. Open Manage subscription to continue.",
  );
}
```
Including `'incomplete'` is the crucial detail — Stripe creates the subscription in `incomplete` status the moment Checkout is paid but before the payment fully captures. Our existing Firestore guard misses this window because it only reads `tier`, which is only set on `active`/`trialing`/`past_due`.

### Recommended fix sketch (Stripe-side, also do this)
- In the Stripe Dashboard → **Customer Portal settings**, enable **"Limit subscriptions per customer to 1"**. This makes Stripe itself reject a second subscription creation on the same Customer. Belt-and-suspenders with the server check above.
- This can't be verified from the code alone — see "What I couldn't determine" below.

### Recommended hardening of `handleSubscriptionUpsert`
Even with the guard, race conditions on retries / webhook reordering could still occur. Make the upsert idempotent and refusing-to-clobber-a-different-active-sub:

```js
// In handleSubscriptionUpsert, before the .set():
const existing = userDoc.data() || {};
if (
  existing.proSubscriptionId &&
  existing.proSubscriptionId !== sub.id &&
  PRO_ACTIVE_STATUSES.has(existing.proSubscriptionStatus)
) {
  logger.error(
    `Multiple active subscriptions for ${userDoc.id}: existing=${existing.proSubscriptionId}, new=${sub.id}. Auto-canceling the newer one.`,
  );
  await stripeClient.subscriptions.cancel(sub.id, {
    cancellation_details: { comment: "Auto-cancel: user already has active sub " + existing.proSubscriptionId },
  });
  // Refund the most recent invoice for sub.id
  return;
}
```
That way, if the guard ever fails and a second subscription does come through, we self-heal: cancel the newer one immediately and the user's Customer Portal will show only the original.

### Stale `stripeCustomerId` (sub-question raised in the prompt)
`functions/index.js:4313-4325` does not verify the cached `stripeCustomerId` still exists in Stripe before creating the Checkout Session. If a customer was deleted out-of-band (e.g. via Stripe Dashboard during testing), `checkout.sessions.create({customer: customerId, ...})` will throw `resource_missing` and the user sees the generic toast at `index.html:13624` ("Could not start the upgrade. Try again in a moment."). They can never recover without admin intervention.

Severity LOW (only happens with manual Stripe-side deletion), but easy to handle:

```js
if (customerId) {
  try {
    const cust = await stripeClient.customers.retrieve(customerId);
    if (cust && cust.deleted) customerId = null;
  } catch (e) {
    if (e && e.code === 'resource_missing') customerId = null;
    else throw e;
  }
}
if (!customerId) {
  // existing create path
}
```

---

## Critical bugs (HIGH only)

### B1. Two-tab / two-device double-charge (`functions/index.js:4291-4299` + `handleSubscriptionUpsert`)
**Single HIGH-severity bug in this audit.** See Scenario 5 above. Fix sketch: server-side `stripeClient.subscriptions.list` check including `'incomplete'` status, plus Stripe Dashboard "Limit subscriptions per customer = 1", plus a defensive auto-cancel in `handleSubscriptionUpsert` when a different `proSubscriptionId` shows up while one is already active. Effort: ~30 LOC + a Dashboard toggle.

---

## Recommended fixes — ranked by ROI

| Rank | Fix | Effort | Risk reduction |
|------|-----|--------|----------------|
| 1 | **Stripe Dashboard: "Limit subscriptions per customer = 1"** | 30 sec toggle | Eliminates scenario 5 entirely at the Stripe layer |
| 2 | **Server-side `subscriptions.list` guard in `createSubscriptionCheckout`** (include `'incomplete'`) | ~10 LOC | Closes the same-window race even if dashboard toggle is missed |
| 3 | **`idempotencyKey` on `customers.create` and `checkout.sessions.create`** | 2 LOC | Eliminates orphan Customers from scenario 4 |
| 4 | **Re-render banner on `pro_success`** (or attach short-lived `onSnapshot`) | ~8 LOC | Fixes UX gap from scenario 2 |
| 5 | **Stale-customer recovery in `createSubscriptionCheckout`** | ~10 LOC | Self-heals deleted Stripe Customers |
| 6 | **Defensive upsert in `handleSubscriptionUpsert`** (refuse to clobber different active sub; auto-cancel new one) | ~15 LOC | Belt-and-suspenders for scenario 5 |

Items 1+2 should ship together as a unit. Items 3-6 are cleanup that pays for itself in support-ticket avoidance.

---

## What I couldn't determine from code alone

- **Stripe Customer Portal configuration**: Whether "Limit subscriptions per customer = 1" is enabled in the Stripe Dashboard. This is configured in the Dashboard UI (Settings → Billing → Customer Portal) and is not in code. **Action item for user**: please verify this in Stripe.
- **Stripe Checkout session expiry**: I assumed the default 24h. If `expires_at` is set elsewhere (it isn't in the visible `checkout.sessions.create` call at `functions/index.js:4327-4340`), the assumption may differ. From the code, no custom expiry is configured → default applies.
- **Webhook endpoint event subscriptions**: I can see what events the handler dispatches on (`functions/index.js:529-583`), but not which events are actually enabled in the Stripe Dashboard webhook config. If `customer.subscription.created` is *not* enabled on the Stripe-side webhook endpoint, the entire flow is broken (no tier flip ever). Confirm in Dashboard.
- **Whether `revokeRefreshTokens` is the right post-upgrade UX**: it forces the user to re-authenticate on next refresh (within 1h). Comment in `functions/index.js:686-688` says this is intentional ("so the new tier propagates immediately"). Acceptable but mildly user-hostile. Not a bug.
- **`processedStripeEvents` collection TTL**: I see events get written but no TTL/cleanup. Over years this collection grows unboundedly. Not in scope for this audit but worth flagging separately.

---

## Open questions for the user

1. Is "Limit subscriptions per customer = 1" enabled in the Stripe Dashboard Customer Portal settings? If yes, scenario 5 severity drops from HIGH to MED (because Stripe rejects at the API layer — though the failure surface is "Stripe error → generic toast", which is worse UX than a graceful in-app block). Recommend implementing both.
2. Has scenario 5 actually been observed in production support tickets? If yes, prioritize fix #1 + #2 above this week.
3. Is there an existing manual-refund process for double-charges? If a user trips this race today, what's the operational playbook?
4. Should the banner re-render fix (item 4 above) instead be a global `onSnapshot(users/{uid})` listener that the dashboard uses? That would also future-proof other tier-dependent UI. Currently the banner reads via a one-shot `getDoc` — same goes for several other tier-gated surfaces.
5. Is the `revokeRefreshTokens` after upgrade intentionally aggressive? An alternative is to set a Firebase custom claim for `tier` and let the client opt-in to refresh via `getIdToken(true)` after the success URL — same propagation guarantee, no forced re-auth.
