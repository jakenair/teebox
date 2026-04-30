# Logo Bingo: Favicon/OG-Image Sourcing Report

Generated: 2026-04-30T20:23:08.471Z

## Totals
- Total courses in bingo-courses.js: **185**
- Already had a logo (skipped): **0**
- Processed via favicon scraping: **8**

## Sourced successfully (3)
- `seminole`  ←  apple-touch-icon  (https://www.seminolegolfclub.com/)
- `los-angeles-cc-north`  ←  apple-touch-icon  (https://www.thelacc.org/?p=home&e=6&gotofile=%2ffiles%2fNorthCourse_Commemorative_Edition.pdf)
- `tara-iti`  ←  og:image  (https://taraiti.com/)


## No website found (1)
- `shadow-creek`

## Website found, but no usable icon found in HTML (0)
(none)

## Icon found but rejected (too small / placeholder / unreadable) (2)
- `wade-hampton` — too small (1150B)
- `whispering-pines` — download failed: Command failed: curl -L -sS --fail --max-time 45 -A Mozilla/5.0 (compatible; TeeBox-Logo-Sourcing/1.0; +https://teeboxmarket.app) -o /tmp/fav-whispering-pines.ico https://www.whisperingpines.com/favicon.ico
curl: (56) The requested URL returned error: 404


## Blocked by robots.txt (2)
- `augusta-national` — https://www.augustanationalgolfclub.com/
- `sand-hills` — https://www.sandhillsgc.com/

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
