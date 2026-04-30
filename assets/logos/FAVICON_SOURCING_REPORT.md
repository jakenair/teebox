# Logo Bingo: Favicon/OG-Image Sourcing Report

Generated: 2026-04-30T20:41:27.087Z

## Totals
- Total courses in bingo-courses.js: **185**
- Already had a logo (skipped): **2**
- Processed via favicon scraping: **13**

## Sourced successfully (7)
- `oakmont`  ←  apple-touch-icon  (https://oakmontgc.com/)
- `bandon-dunes`  ←  apple-touch-icon  (https://bandon.com/)
- `seminole`  ←  apple-touch-icon  (https://www.seminolegolfclub.com/)
- `pinehurst-no-2`  ←  apple-touch-icon  (https://www.pinehurst.com/)
- `royal-county-down`  ←  og:image  (https://www.royalcountydowngolfclub.com/)
- `tara-iti`  ←  og:image  (https://taraiti.com/)
- `quail-hollow`  ←  og:image  (https://www.quailhollow.com/)


## No website found (5)
- `augusta-national`
- `pine-valley`
- `cypress-point`
- `los-angeles-cc-north`
- `whistling-straits`

## Website found, but no usable icon found in HTML (0)
(none)

## Icon found but rejected (too small / placeholder / unreadable) (1)
- `inverness` — dim too small (32x33)

## Blocked by robots.txt (0)
(none)

## Website fetch failed (0)
(none)

## Methodology

For each course missing a logo, the script:
1. Queried Wikipedia's MediaWiki API for the course's page, extracted `| website = ` from the infobox wikitext, falling back to `prop=externallinks` and matching against the slug.
2. Tried predictable URL guesses (`{slug}.com`, `{slug}gc.com`, etc.) when no Wikipedia link was found.
3. Fetched the homepage HTML (subject to robots.txt) and parsed `<link rel="apple-touch-icon">`, `<meta property="og:image">`, `<link rel="icon" sizes="...">`, and `/favicon.ico` in priority order.
4. Downloaded each candidate, ran it through `sharp` (or `sips` for .ico), rejected anything <2KB, <64×64, or matching default-placeholder URL patterns.
5. Resized to 256×256 PNG with `fit: 'contain'` + transparent background, saved to `assets/logos/{slug}.png`.

The 45 verified pre-existing logos were left untouched.

These crests are trademarked logos used here under nominative fair use to identify each club in an editorial brand-identification quiz.
