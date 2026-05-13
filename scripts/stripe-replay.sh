#!/usr/bin/env bash
#
# stripe-replay.sh — replay a historical Stripe event to a webhook endpoint.
#
# Usage:
#   ./stripe-replay.sh evt_xxx                 # → production webhook
#   ./stripe-replay.sh evt_xxx <endpoint-url>  # → custom endpoint
#
# Requires:
#   - stripe CLI installed (https://stripe.com/docs/stripe-cli)
#   - `stripe login` already done; the CLI session must match the mode
#     (test vs live) the event was originally generated in.
#
# Triggering synthetic events instead of replaying real ones:
#   stripe trigger checkout.session.completed
#   stripe trigger customer.subscription.created
#   stripe trigger customer.subscription.updated
#   stripe trigger customer.subscription.deleted
#   stripe trigger invoice.payment_succeeded
#   stripe trigger invoice.payment_failed
#   stripe trigger invoice.payment_action_required
#   stripe trigger charge.refunded
#   stripe trigger charge.dispute.created
#
# For local replay against the emulator/firebase serve:
#   stripe listen --forward-to http://localhost:5001/teebox-market/us-central1/stripeWebhook
#   ./stripe-replay.sh evt_xxx http://localhost:5001/teebox-market/us-central1/stripeWebhook

set -euo pipefail

EVENT_ID="${1:-}"
ENDPOINT="${2:-https://us-central1-teebox-market.cloudfunctions.net/stripeWebhook}"

if [[ -z "$EVENT_ID" ]]; then
  echo "Usage: $0 evt_xxx [endpoint-url]" >&2
  echo "  default endpoint: https://us-central1-teebox-market.cloudfunctions.net/stripeWebhook" >&2
  exit 2
fi

if ! command -v stripe >/dev/null 2>&1; then
  echo "stripe CLI not found. Install: https://stripe.com/docs/stripe-cli" >&2
  exit 127
fi

echo "Replaying $EVENT_ID → $ENDPOINT"
stripe events resend "$EVENT_ID" --webhook-endpoint "$ENDPOINT"
