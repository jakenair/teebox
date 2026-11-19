#!/bin/bash
# r422 list-now-publish-after-payouts + payout reminders end-to-end. Needs Java.
set -euo pipefail
cd "$(dirname "$0")"
cp ../../../firestore.rules .
npx --yes firebase-tools emulators:exec --config firebase.guest.json --only firestore,auth --project=demo-teebox-await "node awaiting.e2e.cjs"
