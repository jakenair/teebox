#!/bin/bash
# r421 guest checkout end-to-end, Stripe + Resend STUBBED. Needs Java.
set -euo pipefail
cd "$(dirname "$0")"
cp ../../../firestore.rules .
npx --yes firebase-tools emulators:exec --config firebase.guest.json --only firestore,auth --project=demo-teebox-guest "node guest.e2e.cjs"
