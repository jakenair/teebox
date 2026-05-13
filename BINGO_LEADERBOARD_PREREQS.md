# Bingo Leaderboard Prerequisites

**Decision date:** 2026-05-12
**Status:** Country + friends leaderboards deployed, gracefully degraded.
Product work below is required to fully light them up.

## Current behavior

The four bingo leaderboard callables in `functions/bingoLeaderboards.js`
were added with graceful degradation built in for users missing optional
profile fields.

### `getBingoCountryPercentile`

Reads `users/{uid}.country`. If unset:

```js
if (!country) return { countrySet: false };
```

(`functions/bingoLeaderboards.js:417`)

The client receives `{ countrySet: false }` and renders nothing for the
country row. The previous "Add your country to your profile" CTA was
removed from `index.html` `renderResultsPanel()` — empty until a country
field exists.

### `getBingoFriendsBoard`

Reads `users/{uid}.following[]` if present; otherwise falls back to
recent order counterparties (buyer/seller relationships in the `orders`
collection, capped at 50). Returns:

```js
{ entries: [...], yourRank, totalFriends, friendsWhoSolved }
```

`totalFriends === 0` is a valid return state. The client's
`renderResultsPanel()` (in `index.html`) already hides the friends row
entirely when `totalFriends === 0` — only the global percentile + streak
rows are guaranteed visible.

## Rules whitelist gap

`firestore.rules` for `/users/{userId}` permits only the following
client-writable fields:

```
['phone','termsAgreed','termsAgreedAt','displayName','watchlist','blocked']
```

(at lines 204 and 210 of `firestore.rules`)

Both `country` and `following` are absent from this whitelist. Without
adding them, the client cannot write either field — meaning country and
friends leaderboards will never have data to surface, even though the
callables are deployed and the UI hides gracefully.

## Path to enabling country leaderboard

1. **Rules:** add `country` to the `hasOnly()` whitelist for both
   `allow create` and `allow update` on `/users/{userId}` in
   `firestore.rules:204` and `:210`. Add a type/length check (e.g.
   ISO-3166-1 alpha-2: exactly 2 uppercase letters).
2. **UI:** surface a country picker in the profile-edit screen. A simple
   `<select>` populated from a country list, written to
   `users/{uid}.country` on save.
3. **Optional seed:** at signup, server-side IP-geo lookup
   (CloudFlare/Vercel headers, or a callable that hits `ipinfo.io`) to
   pre-fill the field. Reduces drop-off vs. asking the user.
4. **Test:** verify `getBingoCountryPercentile` now returns
   `{ countrySet: true, country, percentile, ... }` and the client
   detail-row renders the country bullet.

**Implementation cost:** ~half a day. Mostly UI + a rules patch.

## Path to enabling friends leaderboard

There are two routes; the **fallback already exists** in the callable so
this is optional polish, not blocking.

### Route A — explicit follow graph

1. **Rules:** add `following` to the `hasOnly()` whitelist on
   `/users/{userId}`. Type-check as `list`, cap size (e.g. 200 entries)
   to prevent unbounded growth. Each entry must be a string uid.
2. **UI:** add a "Follow" button on the seller profile page. On tap,
   append the seller's uid to `users/{uid}.following`. Add a "Following"
   tab somewhere visible (settings or profile) listing followed users.
3. **Test:** with a populated `following[]`, verify the friends board
   ranks among the chosen set rather than the order-counterparty
   fallback.

### Route B — keep using the transaction-counterparty fallback

The callable already resolves "friends" from recent `orders` documents
where the requester is `buyerId` or `sellerId` (capped at 50 most recent
counterparties). No additional schema or UI work required. The friends
row simply surfaces "people you've bought from / sold to" — a
serviceable definition for a marketplace.

This is the path of least resistance and matches the marketplace's
existing social graph. Route A is only worth doing if user research
shows people want to follow sellers they haven't transacted with.

## Files referenced

- Callable graceful-degrade logic: `functions/bingoLeaderboards.js:404-449`
  (country) + `:456-581` (friends).
- Rules whitelist: `firestore.rules:204` + `:210`.
- Client renderer: `index.html` `renderResultsPanel()` (~line 16087).
