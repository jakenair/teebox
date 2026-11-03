#!/bin/bash
# Point the site + CAPI at a new Meta dataset (pixel) ID.
#   scripts/meta-switch-dataset.sh <NEW_DATASET_ID>
# Rewrites the old ID everywhere it appears in tracked files and in the
# generated listing/ pages (fb-pixel.js, every <noscript> fallback,
# scripts/generate-listing-pages.mjs, functions/metaCapi.js default).
# The CAPI token is NOT handled here: it goes to Secret Manager only
# (META_CAPI_TOKEN), never into a file.
set -euo pipefail
OLD=4535316483381655
NEW=${1:?usage: meta-switch-dataset.sh <NEW_DATASET_ID>}
[[ "$NEW" =~ ^[0-9]{12,20}$ ]] || { echo "not a dataset id: $NEW"; exit 1; }
cd "$(git rev-parse --show-toplevel)"
files=$( { git grep -l "$OLD" -- . ':!ios' ':!android' ':!perf' ':!.internal-docs' || true; grep -rl "$OLD" listing 2>/dev/null || true; } | sort -u)
for f in $files; do sed -i '' "s/$OLD/$NEW/g" "$f"; done
echo "rewrote $(echo "$files" | grep -c .) files"
left=$(git grep -l "$OLD" -- . ':!ios' ':!android' ':!perf' ':!.internal-docs' || true)
[ -z "$left" ] && echo "no old ID left" || { echo "OLD ID STILL IN:"; echo "$left"; exit 1; }
