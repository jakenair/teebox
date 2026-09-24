#!/bin/bash
# Sanctioned Cloud Function deploy (2026-07-31). This is THE way to deploy a
# function — it deploys via the gcloud house lane AND stamps
# .deploy-manifest.json with the git SHA that shipped, so check-deploy-drift.mjs
# can tell function-level truth instead of guessing from timestamps.
#
# Raw `gcloud functions deploy` still works, but it does NOT bump the manifest,
# so check-deploy-drift will flag that function as "deployed outside wrapper —
# reconcile" on the next run. That nag is deliberate: it makes the raw path
# self-announcing rather than silently rotting the manifest.
#
# REGION (founder ruling 2026-09-24): this script used to hardcode
# --region=us-central1. That was safe only while every function lived there.
# Three now live in us-east1 (optimizeListingPhoto, optimizePassportPhoto,
# optimizeAvatar — all Storage triggers on the us-east1 bucket), and a
# hardcoded region would not have failed loudly: `gcloud functions deploy`
# CREATES a function when none exists in the target region, so deploying
# optimizePassportPhoto would have silently stood up a SECOND copy in
# us-central1 while the real one kept serving from us-east1. Two live copies
# of a Storage trigger means every upload processed twice.
#
# So the region is now resolved from the function's OWN live deployment, and
# anything ambiguous is a hard stop:
#   - found in exactly one region  → deploy there
#   - not deployed anywhere        → refuse (see below)
#   - found in more than one       → refuse (a past mis-deploy; reconcile first)
#
# This script deliberately cannot CREATE a function. A new function needs its
# trigger flags (event type, bucket, trigger region, service account), which
# only the author knows; creating it here from defaults is how you get a
# function wired to the wrong thing. Create new functions with explicit raw
# gcloud flags matched to a deployed sibling, then use this script forever
# after — and stamp the manifest by hand for that first deploy.
#
# Usage:  scripts/deploy-fn.sh <functionName> [<functionName> ...]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PROJECT="teebox-market"

if [ "$#" -lt 1 ]; then echo "usage: scripts/deploy-fn.sh <fn> [<fn> ...]"; exit 1; fi
if [ -n "$(git status --porcelain functions/)" ]; then
  echo "⚠ functions/ has uncommitted changes — commit first so the manifest SHA is meaningful."
  exit 1
fi
SHA="$(git rev-parse HEAD)"
MANIFEST=".deploy-manifest.json"
[ -f "$MANIFEST" ] || echo "{}" > "$MANIFEST"

# One API call for the whole project; emits "<name> <region>" per line.
echo "→ resolving deployed regions…"
REGION_MAP="$(mktemp)"
trap 'rm -f "$REGION_MAP"' EXIT
gcloud functions list --project="$PROJECT" --format=json \
  | node -e "
    let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
      let j; try { j = JSON.parse(s); } catch (e) { process.exit(3); }
      for (const f of j) {
        const m = String(f.name||'').match(/\/locations\/([^/]+)\/functions\/(.+)\$/);
        if (m) console.log(m[2] + ' ' + m[1]);
      }
    });" > "$REGION_MAP"

if [ ! -s "$REGION_MAP" ]; then
  echo "✖ could not list deployed functions — refusing to guess a region."
  exit 1
fi

# Resolve every requested function BEFORE deploying any of them, so a typo in
# the third argument doesn't leave the first two half-shipped.
for FN in "$@"; do
  MATCHES="$(awk -v f="$FN" '$1==f{print $2}' "$REGION_MAP")"
  COUNT="$(printf '%s\n' "$MATCHES" | grep -c . || true)"
  if [ "$COUNT" -eq 0 ]; then
    echo "✖ $FN is not deployed in any region."
    echo "  This script only UPDATES existing functions — it will not create one,"
    echo "  because a new function needs trigger flags it cannot infer."
    echo "  Create it with raw gcloud (flags matched to a deployed sibling), then"
    echo "  stamp $MANIFEST by hand. See the header of this script."
    exit 1
  fi
  if [ "$COUNT" -gt 1 ]; then
    echo "✖ $FN is deployed in MORE THAN ONE region:"
    printf '    %s\n' $MATCHES
    echo "  That is a past mis-deploy. Delete the wrong one before shipping."
    exit 1
  fi
done

for FN in "$@"; do
  REGION="$(awk -v f="$FN" '$1==f{print $2}' "$REGION_MAP")"
  echo "→ deploying $FN @ ${SHA:0:7} to $REGION"
  gcloud functions deploy "$FN" --source=./functions --region="$REGION" \
    --gen2 --project="$PROJECT" --quiet
  # stamp the manifest (node for safe JSON edit; region recorded so drift
  # checks and future readers can see where this actually landed)
  FN="$FN" REGION="$REGION" SHA="$SHA" MANIFEST="$MANIFEST" node -e "
    const fs=require('fs');
    const M=process.env.MANIFEST;
    const m=JSON.parse(fs.readFileSync(M,'utf8'));
    m[process.env.FN]={sha:process.env.SHA, at:new Date().toISOString().slice(0,10), region:process.env.REGION};
    const sorted={}; Object.keys(m).sort().forEach(k=>sorted[k]=m[k]);
    fs.writeFileSync(M, JSON.stringify(sorted,null,2)+'\n');
  "
  echo "✓ $FN deployed to $REGION + manifest stamped"
done
echo "→ commit .deploy-manifest.json so the record persists."
