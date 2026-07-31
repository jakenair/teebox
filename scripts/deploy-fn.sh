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
# Usage:  scripts/deploy-fn.sh <functionName> [<functionName> ...]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "$#" -lt 1 ]; then echo "usage: scripts/deploy-fn.sh <fn> [<fn> ...]"; exit 1; fi
if [ -n "$(git status --porcelain functions/)" ]; then
  echo "⚠ functions/ has uncommitted changes — commit first so the manifest SHA is meaningful."
  exit 1
fi
SHA="$(git rev-parse HEAD)"
MANIFEST=".deploy-manifest.json"
[ -f "$MANIFEST" ] || echo "{}" > "$MANIFEST"

for FN in "$@"; do
  echo "→ deploying $FN @ ${SHA:0:7}"
  gcloud functions deploy "$FN" --source=./functions --region=us-central1 \
    --gen2 --project=teebox-market --quiet
  # stamp the manifest (node for safe JSON edit)
  node -e "
    const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$MANIFEST','utf8'));
    m['$FN']={sha:'$SHA', at:new Date().toISOString().slice(0,10)};
    fs.writeFileSync('$MANIFEST', JSON.stringify(m, Object.keys(m).sort().reduce((a,k)=>(a,a),0)?undefined:null, 2)+'\n');
  "
  echo "✓ $FN deployed + manifest stamped"
done
echo "→ commit .deploy-manifest.json so the record persists."
