#!/bin/bash
# Takedown / missing-listing refund / delete guard end to end. Needs Java.
set -euo pipefail
cd "$(dirname "$0")"
cp ../../../firestore.rules .
npx --yes firebase-tools emulators:exec --config firebase.guest.json --only firestore,auth --project=demo-teebox-guest "node checkoutGuards.e2e.cjs"
