# TeeBox — backlog

Cross-cutting tasks not tied to a specific web rev or iOS build. iOS-build-only
prep lives in `ios/IOS_BUILD_PREP.md`.

## Backend

- [ ] **Mirror `sellerVerified` → public `profiles/{uid}`** via the
      `account.updated` Stripe webhook, using the same pattern already used for
      `isPro` and `chargesReady`.
      - **Why:** `sellerVerified` currently lives only on `users/{uid}`, which is
        read-self-only (Firestore rules). A buyer can never read a seller's
        `users` doc, so `loadProfile()._user.sellerVerified` is always `false`
        for buyers — the "Verified" seller pill renders **only on the seller's
        own view**, never to buyers on listing detail or checkout.
      - **Prerequisite for:** finishing CRO **P3**'s "Verified before pay" goal.
        r138 shipped the seller **name** + no-flash (synchronous `PROFILE_CACHE`
        read) and fixed a latent bug (name was read from the non-existent
        `_user.displayName`); the **Verified pill for buyers is the remaining
        piece** and is blocked on this mirror.
      - **After the mirror exists:** update `sellerMetaHtml()` (detail identity
        row) and the `openCheckout` seller line to read the public flag. Keep
        the two call sites identical so detail + checkout stay consistent.
