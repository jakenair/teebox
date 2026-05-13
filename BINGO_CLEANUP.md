# Bingo Cleanup — Dead Code Removal

**Decision date:** 2026-05-12

## What was removed

### 1. `generateDailyBingoPuzzle` scheduled Cloud Function

`functions/index.js` lines 2698-2778 (the `BINGO_COURSE_POOL` constant,
`pickNRandom` helper, `todayUtcDateKey` local helper, and the `onSchedule`
job itself) were deleted. A short header comment was left in their place
documenting the removal.

**Why it was dead:**

- The function wrote `dailyGames/{YYYY-MM-DD}` with 9 randomly-picked
  course IDs.
- No client reads the `dailyGames` collection. The bingo client derives
  its daily puzzle locally via a deterministic seeded shuffle of
  `bingo-courses.js` (see `dailySeed()` in `index.html`).
- Even if a reader appeared, it would disagree with the client: the
  function used `Math.random()` while the client uses a mulberry32 PRNG
  seeded by date hash.

**Helpers verified unused before removal:**

- `BINGO_COURSE_POOL` — only used here.
- `pickNRandom` — only used here.
- `todayUtcDateKey` — only used here. (Identical helpers exist in other
  files but are scoped locally.)
- `SCHEDULED_BATCH` (sizing preset) — kept, used by other jobs.
- No `defineSecret` references were owned by this function.

### 2. `dailyGames/{date}` Firestore rule

`firestore.rules` lines 834-842 (the `match /dailyGames/{date}` block
allowing `read: if true`) were replaced with a short comment documenting
the removal.

## Post-deploy action required

The function code is removed from the repo, but the function **continues
to run in production** against its old deployed code until the user
redeploys. To retire the live deployment:

```
firebase deploy --only functions
```

When Firebase detects a function that exists in the project but is no
longer in the codebase, it prompts to delete it. Confirm to remove
`generateDailyBingoPuzzle` from the live Cloud Functions deployment.

Until then, the scheduled job will continue writing to `dailyGames/{date}`
every UTC midnight. The collection writes are wasteful but harmless — no
reader consumes them.

To redeploy the rules (also required):

```
firebase deploy --only firestore:rules
```

This will remove the (now-orphaned) `dailyGames` rule from production.

## Files touched

- `functions/index.js` — deleted lines 2698-2778 (~81 lines), replaced
  with a ~22-line comment block documenting the removal.
- `firestore.rules` — deleted lines 834-842 (the `dailyGames` rule),
  replaced with a ~6-line comment block.
- `BINGO_CACHING_AUDIT.md` — appended a one-line resolution note.
- This document.
