# Stripe webhook handler — subscription-flow audit

**Scope:** `exports.stripeWebhook` and its helpers in
`/Users/jakenair/Desktop/teebox/functions/index.js`. Read-only audit. No
code or config modified.

**Date:** 2026-05-12.

**Author note:** TL;DR up top, full event-by-event matrix and the bug
inventory in §3-§4, replay tooling in §6.

---

## 1. TL;DR

The handler does five things very well:

1. **Signature verification** is via `stripeClient.webhooks.constructEvent`
   with the live `STRIPE_WEBHOOK_SECRET` binding (`functions/index.js:483`).
   Any signature failure short-circuits to `400` before any business logic
   runs (`functions/index.js:488-491`).
2. **Idempotency** is enforced by an atomic `create()` on
   `processedStripeEvents/{event.id}` (`functions/index.js:504-527`) —
   the *only* approach that's safe given Stripe's at-least-once delivery.
   `FieldValue.increment` calls in `handlePaymentSucceeded` and rollups
   are protected by this guard.
3. **Latency** is bounded by `timeoutSeconds: 30` and `concurrency: 200`
   (`functions/index.js:472-475`). Subscription handlers do 1-2
   Firestore reads + 1-2 writes + an Auth token-revoke — well under 30s.
4. **Retry semantics** are explicit and correct: transient errors
   (Firestore `UNAVAILABLE`/`DEADLINE_EXCEEDED`) return 500 so Stripe
   retries; permanent errors (bad metadata, unknown account) return 200
   so Stripe stops (`functions/index.js:594-603`).
5. **No trial path.** `createSubscriptionCheckout` does not set
   `trial_period_days` and does not pass `subscription_data.trial_*`
   (`functions/index.js:4327-4340`). `trial_will_end` is therefore
   unreachable today.

The handler is **subscription-vs-marketplace safe**: marketplace
payments fire `payment_intent.succeeded` (Connect destination charge,
goes to `handlePaymentSucceeded`); subscription payments fire
`invoice.payment_succeeded` and `customer.subscription.*` (subscription
mode in Checkout, no PI flows through `handlePaymentSucceeded`). The
PI handler looks up `pi.metadata.listingId/buyerId/sellerId`, which a
subscription PI does not have — so even if one slipped through, it
would no-op gracefully.

**There are still 6 gaps worth fixing.** None are payment-data-loss
bombs. The HIGHs are (a) `invoice.payment_failed` not handled (no
dunning UI hook), (b) `charge.refunded` not handled for subscription
refunds (Pro stays `pro` after a Stripe Dashboard refund), and (c)
out-of-order create-vs-update on subscription events can leave the
user without the proper `proSubscriptionId` write.

---

## 2. Event coverage table

| # | Event | Handled? | Signature | Idempotent | Latency | Retry | Out-of-order |
|---|---|---|---|---|---|---|---|
| 1 | `checkout.session.completed` | **No** | n/a | n/a | n/a | n/a | n/a — we listen on `subscription.*` instead, by design |
| 2 | `customer.subscription.created` | Yes — `handleSubscriptionUpsert` | Yes | Yes (event-id guard + `set({merge:true})` with deterministic fields) | <1s (2 reads, 2 writes, 1 Auth revoke) | Transient→500, perm→200, but `findUserByStripeCustomer` empty returns 2xx without retry — see §4 bug B1 | **Broken** if it arrives after `subscription.updated`: see bug B3 |
| 3 | `customer.subscription.updated` | Yes — same handler | Yes | Yes | <1s | same as #2 | Last-write-wins; no `event.created` check — see bug B3 |
| 4 | `customer.subscription.deleted` | Yes — `handleSubscriptionDeleted` | Yes | Yes | <1s | same | OK — deletion is terminal |
| 5 | `customer.subscription.trial_will_end` | **No** | n/a | n/a | n/a | n/a | **Not applicable** — no trial configured in `createSubscriptionCheckout` (verified `:4327-4340`). Skip. |
| 6 | `invoice.payment_succeeded` | **No** | n/a | n/a | n/a | n/a | Renewals still flip via the subsequent `customer.subscription.updated`, so this is mostly redundant — but receipt-style notifications go unwritten. See §3 missing. |
| 7 | `invoice.payment_failed` | **No** | n/a | n/a | n/a | n/a | **HIGH** — no dunning UI hook. See bug B4. |
| 8 | `invoice.payment_action_required` | **No** | n/a | n/a | n/a | n/a | HIGH — 3DS renewal silently fails. See bug B5. |
| 9 | `charge.refunded` | **No** | n/a | n/a | n/a | n/a | HIGH for **subscription** refunds (Pro stays Pro). Marketplace refunds are handled via the callable `refundOrder` path, not this event. See bug B6. |
| 10 | `charge.dispute.created` | Yes — `handleDisputeOpened` (marketplace only) | Yes | Partially — uses tx to write `disputeCreatedAt` once, but writeNotification not idempotency-guarded against double event delivery | ~1-2s | same | OK |

Marketplace-only events also handled (out of scope but verified):
`payment_intent.succeeded`, `payment_intent.payment_failed`,
`payment_intent.canceled`, `payment_intent.processing`, `account.updated`,
`account.application.deauthorized`, `charge.dispute.funds_withdrawn`,
`charge.dispute.funds_reinstated`, `payout.failed`,
`identity.verification_session.*`.

---

## 3. What we don't handle but should (subscription side)

| Event | Why it matters | Severity |
|---|---|---|
| `invoice.payment_failed` | First retry from Stripe's Smart Retries dunning. Without it we can't show "your card was declined" UI in-app; users only learn about it via Stripe's email. The `customer.subscription.updated` event flips `status=past_due` so fee calc is correct, but the user UX is silent. | HIGH |
| `invoice.payment_action_required` | 3DS challenge on renewal. Without a notification the user never opens the billing portal to authenticate — sub will canceled out after the retry window. | HIGH |
| `charge.refunded` (subscription invoice) | If support refunds a Pro charge via the Stripe Dashboard, today nothing flips `tier=free`. The user keeps Pro fee tier until the next sub.updated event (which may not fire for a manual refund). | HIGH |
| `customer.subscription.paused` / `customer.subscription.resumed` | Only relevant if we ever turn on pause-collection. Not configured today — skip until we are. | LOW |
| `checkout.session.completed` | Useful as a "first-touch" success signal for in-app toast, but the success_url already serves that purpose. Subscription state is canonical via `subscription.*`. Skip. | INFO |
| `invoice.payment_succeeded` | Nice-to-have receipt write to `users/{uid}/billingHistory`, but the sub.updated event covers the state flip. Skip until we want in-app receipts. | LOW |

---

## 4. Bug inventory

### B1. `handleSubscriptionUpsert` swallows "user not found" silently — HIGH

**Location:** `functions/index.js:655-659`

```js
const userDoc = await findUserByStripeCustomer(sub.customer);
if (!userDoc) {
  logger.warn(`subscription event for unknown customer ${sub.customer}`);
  return;
}
```

The function returns normally; the outer handler then returns 2xx; the
event is recorded in `processedStripeEvents`. If the user-doc lookup is
racy (e.g. `createSubscriptionCheckout` did `customers.create` but the
Firestore `set({stripeCustomerId})` hadn't propagated to the secondary
read replica when the webhook landed seconds later), the event is
**permanently dropped**. Stripe will not retry.

**Fix sketch:**
- Throw a sentinel error (e.g. `Error("customer-not-yet-linked")`) and
  classify it as transient at lines `:594-599` so Stripe retries.
- **Better**: delete the `processedStripeEvents` doc on this path so
  the retry re-runs cleanly, OR write the marker only after the handler
  succeeds (two-phase: read marker → run handler → write marker — but
  needs its own tx to be race-free).
- **Best**: read `event.data.object.metadata.firebaseUid` as a fallback
  (we already set it at `:4318` and `:4336`), then back-fill
  `stripeCustomerId` on the user doc if the reverse lookup fails. This
  is the belt-and-suspenders the comment on line `:4334` promises but
  the code doesn't actually consume.

### B2. `event.id` marker is written *before* the handler runs — HIGH

**Location:** `functions/index.js:504-527`

The atomic `create` on `processedStripeEvents/{event.id}` happens
**before** the switch dispatches to the handler. If the handler then
throws a transient error and we 500 back, Stripe will retry, but our
marker will fail with `ALREADY_EXISTS` and we'll short-circuit to
"duplicate, skipping" without ever re-running the handler — a silent
permanent drop.

**Fix sketch:** write the marker *after* successful handler execution.
Use a Firestore tx that reads the marker first; if present → skip; if
absent → run handler → write marker in same tx. Or simpler: keep
current write-first pattern but on transient-error, delete the marker
before returning 500 (small race window, but bounded).

### B3. Out-of-order `subscription.updated` before `subscription.created` — MEDIUM

**Location:** `functions/index.js:653-700`

Both events go to `handleSubscriptionUpsert` and do
`set({merge:true})` with deterministic fields → the final state is
last-write-wins by webhook arrival order, not by Stripe's event timeline.
In practice this is usually fine (Stripe normally delivers in order),
but `updated` can land before `created` when there are rapid-fire status
changes (e.g. immediate 3DS auth) or when the dashboard "Resend" is
clicked out of order. The handler reads `sub.status` from each event's
own snapshot, so the last delivered (not last in time) wins. If the
*earlier* event delivers second, we'd persist stale state.

**Fix sketch:** compare `event.created` (or
`sub.metadata.updated_at` if you set one) against the
`proSubscriptionUpdatedAt` we already persist; if incoming is older,
no-op. Pseudocode:

```js
const incomingTs = event.created * 1000; // Stripe gives seconds
const existing = (await userDoc.ref.get()).data();
const persistedTs =
  existing.proSubscriptionUpdatedAt &&
  existing.proSubscriptionUpdatedAt.toMillis();
if (persistedTs && persistedTs > incomingTs) return; // stale
```

This requires passing `event` (not just `event.data.object`) into the
handler — small refactor at `:574-577`.

### B4. No `invoice.payment_failed` handler — HIGH

**Location:** not present; would belong near `functions/index.js:574`.

Stripe Smart Retries handles the dunning attempts, but nothing in
TeeBox writes a `users/{uid}.proPaymentFailedAt` flag, sends an in-app
notification, or fires an email. The user only learns from Stripe's
generic dunning email, which is suboptimal launch UX.

**Fix sketch:** new handler that:
1. Looks up the user via `invoice.customer`.
2. Writes `proPaymentFailedAt` + `proPaymentFailureCount` on the user doc
   (use `FieldValue.increment(1)` — **only safe because we already
   have event-id idempotency on the outer wrapper**).
3. `writeNotification(uid, { kind: "pro_payment_failed", ... })`.
4. Sends `sendEmail()` with "Update your card" CTA → `createBillingPortalSession`.

### B5. No `invoice.payment_action_required` handler — HIGH

**Location:** not present.

3DS challenges on renewal → user is silent-canceled at the end of the
retry window. Same fix pattern as B4 but with a different notification
kind (`pro_3ds_required`) and a more urgent email body.

### B6. No `charge.refunded` handler for subscription invoices — HIGH

**Location:** not present. Marketplace refunds are handled
**synchronously** via the callable `refundOrder` (`:4377-4530`), which
writes its own `orders/{pi}` updates — it doesn't rely on the
`charge.refunded` webhook. But a Stripe-Dashboard-initiated refund on
a **Pro subscription** invoice has no code path at all.

**Fix sketch:** handler that:
1. Reads `charge.invoice` (only present for subscription charges) and
   `charge.payment_intent`.
2. If `charge.invoice` is null → it's a marketplace charge → no-op
   (refundOrder handles it). This is the marketplace/subscription
   discriminator.
3. If `charge.invoice` is set → retrieve the invoice's `subscription` →
   flip the user's `tier='free'` and write `proRefundedAt`.

### B7. `mirrorTierToProfile` failure is silently logged but not retried — LOW

**Location:** `functions/index.js:642-651`

If `profiles/{uid}` write fails (transient Firestore unavailable) we
log a warn and continue. The user's `users/{uid}.tier` is correct but
the public `profiles/{uid}.isPro` is stale → buyer-side Pro badge
won't render. Severity low because (a) the user can refresh by
re-subscribing or by any subsequent subscription event re-firing the
mirror, and (b) it's a display issue not a payments issue.

**Fix sketch:** retry once with exponential backoff, OR write the
mirror as part of the same Firestore tx that writes the user doc (it
isn't currently — the user-doc `set` is plain `set` not a tx).

### B8. `revokeRefreshTokens` failure is non-fatal but log-only — LOW

**Location:** `functions/index.js:689-694`

If we can't revoke, the user's stale ID token (up to 1h old) keeps
reporting the old tier in custom claims — only matters if you also
mirror `tier` into custom claims (search shows you don't today). Today
this is essentially dead code that hedges against a future feature.
Leave it.

### B9. `processedStripeEvents` has no TTL — LOW

**Location:** `processedStripeEvents/{event.id}` writes — no TTL set.

Stripe only retries for ~3 days, but the marker docs accumulate
forever. At 100 events/day that's 36k docs/year — totally fine, but
a Firestore TTL on `receivedAt` set to 30d would keep the collection
trim and reduce backup size. Configure via `firestore.indexes.json` or
the console.

---

## 5. Specific bug-class checks from the original brief

| Check | Result |
|---|---|
| Wrong signing secret (test vs live) | **Cannot verify from code.** Code reads `STRIPE_WEBHOOK_SECRET` (one secret). User must confirm in dashboard that the binding matches the LIVE endpoint's signing secret. See §7. |
| 2xx swallowing retries | **Mostly correct.** B1 is the one case where a "user not found" silently returns 2xx and Stripe won't retry — flagged HIGH. Otherwise the transient/permanent classification at `:594-603` is sound. |
| No idempotency guard | **Guarded.** `processedStripeEvents/{event.id}` atomic create handles it; `FieldValue.increment` calls in `handlePaymentSucceeded` are downstream of this guard. The one exception is B2 (marker written *before* handler runs → broken retries). |
| Synchronous slow work | **Within budget.** Subscription handler is 2 reads + 2 writes + 1 Auth revoke. The dispute handler does 4 Firestore reads + 1 email + 1 push + 1 notif — still well under 30s, but the closest to the line. No queueing needed today. |
| Out-of-order convergence | **B3** — last-write-wins by delivery, not by `event.created`. Usually fine, not robust. |
| Dispute / refund flip for sub | **B6** — no handler. |
| Trial fields | **None.** `createSubscriptionCheckout` has no `trial_period_days` or `subscription_data.trial_*`. `trial_will_end` is unreachable. |
| Connect vs subscription confusion | **Clean separation.** PI handler reads `pi.metadata.listingId` — subscription PIs don't have that, so the PI handler would no-op. Subscription PIs never have a Connect transfer either. |

---

## 6. Replay script

`/Users/jakenair/Desktop/teebox/scripts/stripe-replay.sh` (created
alongside this audit).

Usage:

```bash
# Replay a specific event ID to production
./scripts/stripe-replay.sh evt_1QXXX

# Replay to a local stripe listen --forward-to endpoint
./scripts/stripe-replay.sh evt_1QXXX http://localhost:5001/.../stripeWebhook

# Trigger synthetic events for each subscription-flow event type
stripe trigger checkout.session.completed
stripe trigger customer.subscription.created
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_succeeded
stripe trigger invoice.payment_failed
stripe trigger charge.refunded
stripe trigger charge.dispute.created
```

Requires `stripe` CLI authenticated against the right mode (test vs
live) — use `stripe login --project-name teebox-live` first.

---

## 7. What the user must verify in the Stripe Dashboard

These cannot be verified from code:

1. **Signing secret match.** Stripe Dashboard → Developers → Webhooks →
   *live* TeeBox endpoint → Signing secret. Confirm it matches the
   value currently bound to `STRIPE_WEBHOOK_SECRET`:

   ```bash
   firebase functions:secrets:access STRIPE_WEBHOOK_SECRET
   ```

   If they differ, every event will 400 on signature verification and
   you'd see it in Cloud Logging as `Webhook signature verification
   failed`. Rotate the secret if needed.

2. **Event subscriptions.** Webhook endpoint must be subscribed to,
   at minimum:
   - `payment_intent.succeeded`, `.payment_failed`, `.canceled`,
     `.processing`
   - `customer.subscription.created`, `.updated`, `.deleted`
   - `account.updated`, `account.application.deauthorized`
   - `charge.dispute.created`, `.funds_withdrawn`, `.funds_reinstated`
   - `payout.failed`
   - `identity.verification_session.verified`, `.requires_input`, `.canceled`

   Once B4/B5/B6 fixes land, also add:
   - `invoice.payment_failed`
   - `invoice.payment_action_required`
   - `charge.refunded`

3. **Retry config.** Stripe Dashboard → Developers → Webhooks → endpoint
   → … → "Retry strategy". Confirm default 3-day exponential is on.
   Custom retry is rarely better.

4. **Smart Retries on subscriptions.** Stripe Dashboard → Settings →
   Billing → Subscriptions and emails → Smart Retries. Should be **on**
   so that `past_due` subs auto-retry; the webhook handler relies on
   Stripe doing dunning, not us.

5. **Customer portal config** (per `STRIPE_PRO_SETUP.md`) — verify the
   live-mode portal is activated; configurations are per-mode.
