# perf/ — the one way TeeBox performance gets measured

Any claim that a change made the site faster or slower has to come from here.

```bash
npm run perf                       # live site, 5 runs per logged-out state
node perf/measure.mjs --runs 5 --state logged-out-cold --json perf/results/rNNN.json
node perf/investigate.mjs frames   # what a first-time visitor sees at 1s / 2s / 3s
node perf/investigate.mjs profile && node perf/analyze-profile.mjs
node perf/investigate.mjs reads     # every Firestore read the home page issues
```

## Why this exists

The first perf pass (r320–r323) used a hand-rolled CDP harness that dismissed the
auth gate programmatically. That injected layout shifts of its own and moved the
LCP element around. On effectively identical code it returned LCP anywhere from
352ms to 9336ms. Two "improvements" were shipped off the back of it and both had
to be reverted. One of them looked like it cost 6.6s of LCP; after reverting, LCP
did not move — the harness had been the whole signal.

So: **median of 5, with the spread shown, or it is not a number.**

## The rules the scripts enforce

- **Median and range, never a single run.** A single Lighthouse run on this page
  is not reproducible and must never be quoted.
- **LCP spread > 20% of the median = UNSTABLE.** The run set is printed but
  marked, and it may not be used to justify a change. Fix the harness first.
- **The auth gate is never dismissed.** A logged-out visitor meets the gate;
  that is the page, and faking past it measures something no user ever sees.
- **Cold and warm are different pages, never averaged.** The service worker makes
  a second visit a materially different load.
- **A lost run is reported, not hidden.** A headless renderer under 4× CPU
  throttling on a 1.5MB document does occasionally die
  (`Protocol error (Page.enable): Session closed`). Each run gets 3 attempts; if
  all 3 are lost the state reports a smaller `n` and says so on screen.

## States

| state | profile | what it represents |
|---|---|---|
| `logged-out-cold` | fresh | first-time visitor from a reel — the acquisition path |
| `logged-out-warm` | persistent, primed | same visitor returning, SW installed |
| `logged-in-cold` | fresh + storageState | **needs a test account — currently skipped** |
| `logged-in-warm` | persistent + storageState | **needs a test account — currently skipped** |

### Wiring up the signed-in states

They are scaffolded in `lh-config.mjs` (`auth: true`) and skipped at runtime
rather than faked. To enable them, create a dedicated throwaway account — never
a real user's, and never an admin — and store its session, then drop the
`auth` flag. Two things to respect when you do:

- Seed that account with a realistic watchlist and a couple of orders. An empty
  account skips most of the boot read chain and flatters the numbers.
- Keep its credentials out of the repo and out of commits.

## Targets (`TARGETS` in lh-config.mjs)

LCP < 2000ms · CLS < 0.05 · TBT < 300ms · FCP < 1800ms, at Lighthouse mobile
(slow 4G: 1.6 Mbps / 150ms RTT, 4× CPU, 412×823 @2.625).

## Results

`perf/results/*.json` holds every baseline, keyed by the web revision it was
taken against. Keep them — a trend across revisions is worth more than any
single table, and it is the only way to catch a slow regression.

## Font fallbacks (r334)

`perf/fonts/` holds the tooling that computed the `@font-face` override faces
at the top of index.html's stylesheet (`DM Sans Fallback`, `Playfair Fallback`):

- `vmetrics.mjs` — hhea/typo/win tables from the served woff2 + local fallbacks (needs `npm i fontkit` in that dir)
- `widths.mjs` — average advance width per weight as Chrome's canvas measures it (the only honest width)
- `reflow.mjs` — renders the gate with fonts.gstatic.com blocked vs allowed and compares every element's height
- `vmetrics.json`, `widths.json` — the raw numbers the percentages came from

Recompute if the Google Fonts request (weights or families) ever changes. A
fallback face is only as good as the weight it was measured at.
