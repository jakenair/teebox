# Sitemap deploy plan

## ✅ Decision (2026-05-15): Firebase Hosting rewrite

Founder picked Firebase Hosting as the serving path. Implementation:

1. **`regenerateSitemap` scheduled function** — runs hourly, writes XML to Firestore `sitemap/latest` (unchanged from original scaffold).
2. **`serveSitemap` HTTPS function** (added 2026-05-15 to `functions/sitemapRegenerator.js`) — reads `sitemap/latest`, returns XML with `Content-Type: application/xml` + `Cache-Control: public, max-age=3600`.
3. **Firebase Hosting rewrite** — `firebase.json` now contains `{ "source": "/sitemap.xml", "function": "serveSitemap" }` so `https://teebox-market.web.app/sitemap.xml` serves the live XML.

**The single source of truth is the `sitemap/latest` Firestore doc.** No GitHub Pages CI sync. No Cloud Storage. The XML is generated on a server schedule, cached in Firestore, served on demand via the rewrite.

### Cross-domain caveat

`teeboxmarket.com` is currently on **GitHub Pages**, not Firebase Hosting. The serving URL is therefore on the `.web.app` domain (`https://teebox-market.web.app/sitemap.xml`), not the apex. Two paths from here:

- **Path A (current state)**: keep apex on GitHub Pages. Update `robots.txt` on GitHub Pages to add `Sitemap: https://teebox-market.web.app/sitemap.xml`. Search engines honor cross-domain `Sitemap:` directives but Google Search Console will warn — minor SEO friction, no penalty.
- **Path B (post-launch)**: move apex DNS to Firebase Hosting. Then `https://teeboxmarket.com/sitemap.xml` works directly. ~10 min DNS change + GitHub Pages turn-off.

For TestFlight beta + initial public launch, Path A is fine. Path B is on the post-launch list.

### Verification after deploy

```bash
# After regenerateSitemap fires once (force via gcloud, see below):
curl -i https://teebox-market.web.app/sitemap.xml | head -20

# Force-run the regenerator if you don't want to wait an hour:
gcloud scheduler jobs run firebase-schedule-regenerateSitemap-us-central1 \
  --location=us-central1 --project=teebox-market
```

---

## What ships in this PR

- `functions/sitemapRegenerator.js` — a scheduled Cloud Function
  (`regenerateSitemap`, every 60 minutes) that:
  1. Reads up to 5 000 active listings created in the last 90 days.
  2. Builds a well-formed `sitemap.xml` in memory (mirroring the 45
     hand-curated static URLs from the repo-root `sitemap.xml`).
  3. Writes the XML string to Firestore at `sitemap/latest` along with
     `generatedAt`, `listingCount`, `staticCount`.

What the function does **not** do (intentional): it does **not** push
the XML to the public origin. The deploy mechanism for the public
`https://teeboxmarket.com/sitemap.xml` is the user's call.

## Why this is a half-deliverable

Today `https://teeboxmarket.com/sitemap.xml` is served from GitHub
Pages (per `CNAME` at the repo root and the deploy-pipeline note that
this site is GH Pages, not Firebase Hosting). Cloud Functions cannot
push files into a GitHub repo without:

- a personal-access-token secret on the function, plus
- a commit + push every hour, plus
- a CI gate to keep that loop from racing manual commits.

That's a meaningful piece of infra to ship, and the user/founder
should pick the right home for the file before we ship it.

## Three options

### Option A — GitHub Pages (status quo origin)

A separate workflow (`.github/workflows/sitemap-sync.yml`) runs
hourly, calls a tiny Cloud Function callable that returns
`sitemap/latest.xml`, writes it to `sitemap.xml` at the repo root,
commits, and pushes.

- Pro: zero infra change. SEO works without DNS edits.
- Con: ~24 commits/day cluttering history; touches main branch from
  CI; risk of merge churn if a human edits `sitemap.xml` manually.

### Option B — Cloud Storage + DNS rewrite

Write `sitemap.xml` to a public-read Cloud Storage object
(`gs://teebox-market.appspot.com/sitemap.xml`) and route
`teeboxmarket.com/sitemap.xml` to it via Cloud CDN or a Firebase
Hosting rewrite. Requires moving `sitemap.xml` away from GH Pages
origin.

- Pro: real-time updates. No commits. Aligns with where the rest of
  Firebase infra lives.
- Con: requires DNS / hosting reconfiguration. Marginal Cloud CDN
  cost. Risk of the GH Pages 404 fallback catching the URL first if
  the rewrite isn't watertight.

### Option C — Hybrid (Firebase Hosting on a single path)

Keep GH Pages for the rest of the site; add `firebase.json` rewrites
for **just** `/sitemap.xml` and point `teeboxmarket.com` DNS to
Firebase Hosting (with GH Pages as a CNAME fallback). The Hosting
function reads `sitemap/latest` from Firestore and serves the XML
inline.

- Pro: minimal disruption. Realtime. No CI commits.
- Con: now have two CDNs on the same hostname; need to make sure
  Hosting catches `/sitemap.xml` and forwards everything else to GH
  Pages.

## Recommended action

Option A for v1 (cheapest, no DNS surgery). Migrate to Option C once
listing volume crosses ~500 active.

A skeleton GitHub Actions workflow for Option A:

```yaml
# .github/workflows/sitemap-sync.yml
name: Sync sitemap
on:
  schedule: [{cron: '17 * * * *'}]   # 17 past every hour
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    permissions: {contents: write}
    steps:
      - uses: actions/checkout@v4
      - name: Pull sitemap/latest from Firestore
        env:
          GOOGLE_APPLICATION_CREDENTIALS_JSON: ${{ secrets.FIREBASE_CI_SA }}
        run: |
          echo "$GOOGLE_APPLICATION_CREDENTIALS_JSON" > /tmp/sa.json
          GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json \
            node scripts/dump-sitemap.js > sitemap.xml
      - name: Commit if changed
        run: |
          if ! git diff --quiet sitemap.xml; then
            git config user.email "ci@teeboxmarket.com"
            git config user.name "TeeBox CI"
            git add sitemap.xml
            git commit -m "chore(sitemap): hourly regen"
            git push
          fi
```

The companion `scripts/dump-sitemap.js` would be a 20-line Firestore
client that reads `sitemap/latest.xml` and prints it to stdout.

## Verification once a path is chosen

1. Hit `https://teeboxmarket.com/sitemap.xml` and confirm dynamic
   listing entries appear after the static brand pages.
2. Submit the sitemap in Google Search Console; check the "Last
   read" timestamp updates within 24h.
3. Confirm `regenerateSitemap` Cloud Function shows successful
   invocations every hour in Cloud Logging.
4. Confirm `sitemap/latest` doc in Firestore has `generatedAt` within
   the last 75 minutes at all times.

## Open questions

- Should we also generate a sitemap-index when listing count > 5 000?
  Sitemaps.org caps a single sitemap at 50 000 URLs / 50 MB; we have
  ~5 000 listing-page headroom before splitting becomes necessary.
- Should listing pages have their own server-rendered HTML (currently
  the listing is a query-param modal on `index.html`)? If not, the
  crawl-value of the sitemap is reduced — Google still crawls but
  can't snapshot the listing-specific OG meta. Tracked under PATH C10
  in `LAUNCH_READINESS.md`.
