# Bingo Schema Reconciliation

**Decision date:** 2026-05-12
**Status:** Fanout pattern in place. Migration to single canonical schema deferred.

## Why two schemas exist

The Logo Bingo feature accumulated two parallel result schemas during
incremental development:

### Legacy: `gameScores/{date}_{uid}`

- **Owner:** the browser, via `writeLeaderboardScore()` in `index.html`
  (around line 15850).
- **Shape:** `{ uid, date, correctCount, attempts, streak, completedAt }`
  (best-effort client write; the in-app code path catches and swallows rule
  rejections).
- **Read by:**
  - The in-app leaderboard query (`loadLeaderboard()` in `index.html`,
    ~line 15410) — `where('date', 'in', [...])` + `orderBy('correctCount')`.
  - The daily-push agent (`functions/bingoPushTriggers.js`) — checks
    `gameScores/{today}_{uid}.correctCount > 0` to decide whether the
    "you haven't played today" push should fire.
  - The same module's `_currentStreak()` fallback reads
    `gameScores/{yesterday}_{uid}.streak`.

### New: `users/{uid}/bingoGames/{date}`

- **Owner:** the `syncBingoProgress` callable (`functions/bingoSync.js`,
  Admin SDK only; clients cannot write).
- **Shape:** `{ date, uid, cells[9], correctCount, attempts, startedAt,
  solvedAt, clientWonAt, syncedAt }` — `solvedAt` and `startedAt` are
  **epoch milliseconds** (numbers), not Firestore Timestamps.
- **Read by:**
  - The aggregation trigger `onBingoWinAggregate`
    (`functions/bingoLeaderboards.js`) — produces
    `bingoLeaderboard/{date}` histograms.
  - The four leaderboard callables (`getBingoPercentile`,
    `getBingoCountryPercentile`, `getBingoFriendsBoard`,
    `getBingoGlobalStreakRecord`).

## Which schema is canonical for which read path

| Read path | Canonical source |
|---|---|
| In-app leaderboard (Today / This Week tabs) | `gameScores/{date}_{uid}` |
| Daily-push "played today?" check | `gameScores/{date}_{uid}` |
| Daily-push streak fallback | `gameScores/{date}_{uid}` |
| Global percentile / country percentile | `users/{uid}/bingoGames/{date}` |
| Friends leaderboard | `users/{uid}/bingoGames/{date}` |
| Streak aggregation + personal best | `users/{uid}/bingoGames/{date}` |
| Offline-play history | `users/{uid}/bingoGames/{date}` |

## The fanout pattern (implemented 2026-05-12)

`syncBingoProgress` now performs an additional best-effort write to
`gameScores/{date}_{uid}` after the canonical `bingoGames` transaction
commits. The mirrored fields are:

| Field | Source | Notes |
|---|---|---|
| `uid` | path param | |
| `date` | path param | |
| `correctCount` | canonical doc | |
| `attempts` | canonical doc | |
| `streak` | `users/{uid}.bingoCurrentStreak` if set, else 1-or-2 fallback from prior-day `bingoGames` doc | |
| `solvedAt` | canonical doc `solvedAt` (epoch ms) | **Converted to Firestore `Timestamp`** for legacy compat |
| `timeSec` | derived: `(solvedAt - startedAt) / 1000` | Omitted if `startedAt` is null |
| `displayName` | `profiles/{uid}.displayName`, then `users/{uid}.displayName` | Omitted if neither exists |
| `country` | `users/{uid}.country` | Omitted if not set |
| `completedAt` | server timestamp | Matches legacy client write semantics |

The fanout uses `set(..., { merge: true })` so any fields the legacy
client wrote (e.g. its own `completedAt`) are preserved. Only writes when
`solvedAt` is non-null — pre-solve partials don't belong in the
leaderboard collection.

The fanout is best-effort: failures are logged and swallowed. The
canonical `bingoGames` doc is the source of truth; this is a denormalized
mirror for legacy readers.

## Cost

- **2x writes per solve:** one to `users/{uid}/bingoGames/{date}`, one to
  `gameScores/{date}_{uid}`.
- At Firestore's $0.18 per 100k writes: **~$0.0000018 extra per solve**.
- At 10k DAU × 1 solve/day × 30 days: **~$0.54/month extra**. Negligible.

## Migration plan — retiring `gameScores`

Three readers depend on `gameScores`. They must be rewritten before the
fanout can be removed.

1. **In-app leaderboard query** (`index.html` `loadLeaderboard()`):
   - Currently does a collection-group-style `where('date', 'in', dates)`
     across the top-level `gameScores` collection.
   - To migrate: replace with a server-side callable (e.g.
     `getBingoLeaderboardTop`) that reads `bingoLeaderboard/{date}` for
     today/week and returns the top-N. Or fan out into a server-owned
     `bingoLeaderboardEntries/{date}_{uid}` flat collection at win time.
   - Rewriting the query directly against `users/{uid}/bingoGames` is NOT
     possible — Firestore cannot query a subcollection across users
     without a `collectionGroup` query, and `bingoGames` isn't currently
     indexed as a group.

2. **Push trigger "played today?" check** (`bingoPushTriggers.js`
   `_playedToday()`):
   - Easy rewrite: read `users/{uid}/bingoGames/{today}` instead and
     check `solvedAt` (or `correctCount > 0`). Admin SDK can read the
     subcollection directly.

3. **Push trigger streak fallback** (`bingoPushTriggers.js`
   `_currentStreak()`):
   - The aggregation trigger now writes `users/{uid}.bingoBestStreak`,
     but **not** `bingoCurrentStreak`. To migrate this fallback, either
     (a) add a `bingoCurrentStreak` write in `onBingoWinAggregate`, or
     (b) have the fallback walk back through `bingoGames` docs.

### Suggested migration order

1. Migrate `_playedToday()` and `_currentStreak()` (1-2 line changes).
2. Build a server-side leaderboard callable powered by the existing
   `bingoLeaderboard/{date}` aggregates.
3. Rewrite `loadLeaderboard()` to call it.
4. Drop the fanout from `syncBingoProgress`.
5. Stop writing `gameScores` from the legacy client path (currently
   already failing the rule check — see below).
6. Eventually drop the `gameScores` collection + its firestore.rules
   block.

## A note on the legacy rule

`firestore.rules` for `/gameScores/{scoreId}` requires a `userId` field,
but the client at `index.html:15859` writes `uid` instead. The legacy
client write has been silently rejected for some unknown duration. The
fanout (Admin SDK) bypasses rules and works correctly. We deliberately
do not "fix" the legacy rule because the migration above will retire the
whole collection.

## Files touched in this reconciliation

- `functions/bingoSync.js` — added `_resolveStreakForFanout`,
  `_fanoutToGameScores`, and the post-transaction fanout call (and a
  small `startedAt` carry-forward fix inside the transaction so timeSec
  computation stays stable across retries).
- `firestore.rules` — unchanged for `gameScores` (rules already deny
  tampering; Admin SDK bypasses them).
- This document.
