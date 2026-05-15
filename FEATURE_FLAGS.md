# TeeBox Feature Flags

**Storage**: Firestore document `config/features`
**Rule access**: `allow read: if request.auth != null;` — anyone signed
in can read; only admins can write (see `firestore.rules:982`).
**Client cache**: `window.FEATURE_FLAGS` (populated once per page session
by `loadFeatureFlags()` in `index.html`).
**Server access**: Cloud Functions read the same doc directly via the
Admin SDK. *Never* trust the client-cached value for security/cost
decisions — always re-read server-side.

## Current flags

| Flag                | Default | Owner | Read by                              | Notes |
|---------------------|---------|-------|--------------------------------------|-------|
| `aiPriceEnabled`    | `false` | Jake  | `suggestListingPrice` (server) + `index.html#aiPriceBtn` (client) | Gates the AI suggest-price button + the server Gemini call. Flip to `true` once comp coverage exceeds 100 listings per category — earlier than that, the Gemini suggestion has nothing to ground against and burns API quota for low-quality output. |

## How to flip a flag in production

1. Open the Firebase console → Firestore Data → `config` → `features`.
   Create the doc if missing.
2. Edit (or add) the boolean field.
3. Server reads on every call (no cache). Clients pick up the change
   on next page load.

## How to add a new flag

1. Pick a `camelCase` name. Default to OFF (`false`) — kill-switch
   semantics. If your flag is feature-on by default, name it like
   `feature*Disabled` so the default missing-field value behaves
   correctly (`false → enabled`).
2. Server side: read with
   ```
   const featSnap = await admin.firestore().doc("config/features").get();
   const featData = featSnap.exists ? (featSnap.data() || {}) : {};
   if (featData.myFlag !== true) {
     // ...short-circuit
   }
   ```
   Always fail closed on Firestore read errors when the flag is a
   cost / safety kill-switch. Fail open only for cosmetic gating.
3. Client side: read via `await window.loadFeatureFlags()` then check
   `window.FEATURE_FLAGS.myFlag`. The loader is cached per-session.
4. Update this table.
5. Don't deploy a hard-coded `default: true` for a flag whose Firestore
   doc doesn't exist yet — the missing-field read returns `undefined`
   and your code will skip the feature. Always seed the doc first.

## Flags users may want next (parking lot)

These are *not* implemented — listed here so we don't reinvent the
naming each time someone proposes one:

- `aiDescriptionEnabled` — sibling of `aiPriceEnabled` for the "Write
  description for me" button. Currently always on. Add if/when Gemini
  costs become non-trivial.
- `shippingLabelsEnabled` — gates the Shippo integration once that
  ships. Until then the "Buy a label" CTA stays hidden.
- `offersEnabled` — currently the offers UI is hidden via CSS
  `[data-feature="offers"]{display:none}` (index.html:209) because
  `createPaymentIntent` doesn't honor accepted offer amounts. Move to
  Firestore once the server flow is fixed.
- `proSellerSignupEnabled` — kill-switch for the Pro Seller upgrade
  modal if/when we need to pause sign-ups during a Stripe outage or
  pricing change.
- `pushNotificationsEnabled` — global mute for push triggers during
  incident response.
- `aiCompCoverageThreshold` (number, not boolean) — instead of a
  hand-flipped `aiPriceEnabled`, a per-category integer threshold that
  the server uses to auto-gate the suggestion. Future work.

## Anti-patterns

- **Do NOT** read `config/features` on the homepage critical path. The
  current loader is lazy — only fetched when openSellModal runs. A
  homepage read would block first-paint.
- **Do NOT** stash flags in localStorage as a cache. Firestore reads
  are cheap enough; localStorage means users won't see a kill-switch
  flip until they manually refresh.
- **Do NOT** add per-user-percentage rollout to this doc. If we need
  that, build it on top of PostHog feature flags or a dedicated table —
  this doc is the global-bool surface only.
