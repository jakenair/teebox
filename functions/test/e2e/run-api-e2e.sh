#!/bin/bash
# Seller API v1 end-to-end test (Firestore/Auth/Storage emulators). Needs Java.
# Copies the CURRENT rules in (the emulator only reads files inside this folder).
set -euo pipefail
cd "$(dirname "$0")"
cp ../../../firestore.rules ../../../storage.rules .
npx --yes firebase-tools emulators:exec --only firestore,auth,storage --project=demo-teebox "node sellerApi.e2e.cjs"
