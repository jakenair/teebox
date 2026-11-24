#!/bin/bash
# Shipping estimates, tracking, reminders. Shippo + Resend stubbed. Needs Java.
set -euo pipefail
cd "$(dirname "$0")/../../.."
npx --yes firebase-tools emulators:exec --only firestore --project=demo-teebox "node functions/test/e2e/shipInfo.e2e.cjs"
