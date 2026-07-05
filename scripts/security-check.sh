#!/usr/bin/env bash
# scripts/security-check.sh — nightly read-only security regression check for TeeBox.
# Idempotent. Exits non-zero if ANY check finds a problem. Prints a dated summary.
# READ-ONLY: greps files + one live unauthenticated Firestore read probe. No writes.
set -uo pipefail

REPO="${TEEBOX_REPO:-/Users/jakenair/dev/teebox}"
cd "$REPO" || { echo "FATAL: repo not found at $REPO"; exit 2; }

RULES="firestore.rules"
STORAGE="storage.rules"
FUNCS="functions/index.js"
CLIENT="index.html"
PROJECT_ID="teebox-market"

DATE="$(date '+%Y-%m-%d %H:%M:%S %Z')"
FINDINGS=0
note()  { echo "  [!] $*"; FINDINGS=$((FINDINGS+1)); }
ok()    { echo "  [ok] $*"; }
section(){ echo; echo "== $* =="; }

echo "================================================================"
echo "TeeBox security-check  —  $DATE"
echo "repo: $REPO   branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "================================================================"

# ---------- 1. Deterministic grep checks (no LLM) ----------
section "Over-broad rule check (firestore + storage)"
# Flag any 'allow ...write: if true' (the known-intentional public reads use read-only rules).
if grep -nE 'allow[[:space:]]+(read[[:space:]]*,[[:space:]]*)?write[[:space:]]*:[[:space:]]*if[[:space:]]+true' "$RULES" "$STORAGE" >/tmp/sc_write_true 2>/dev/null; then
  note "'allow write: if true' present:"; cat /tmp/sc_write_true
else
  ok "no 'allow write: if true'"
fi

section "App Check enforcement"
# appCheckOk()'s body may span lines, so scan the function definition + next few
# lines for a bare 'return true' (grep is line-based; a single-line regex misses it).
if grep -A4 'function appCheckOk()' "$RULES" | grep -qE '^\s*return\s+true\s*;'; then
  note "$RULES: appCheckOk() still returns true (App Check NOT enforced)"
else
  ok "firestore appCheckOk() no longer a hard 'return true'"
fi
if grep -A4 'function appCheckOk()' "$STORAGE" | grep -qE '^\s*return\s+true\s*;'; then
  note "$STORAGE: appCheckOk() still returns true (App Check NOT enforced)"
else
  ok "storage appCheckOk() no longer a hard 'return true'"
fi

section "Secret material in client bundle ($CLIENT)"
# Firebase web apiKey (AIzaSy...) is EXPECTED public — do not flag it.
if grep -nE 'sk_live_|sk_test_|rk_live_|whsec_|-----BEGIN[A-Z ]*PRIVATE KEY-----|service_account|"private_key"|re_[A-Za-z0-9]{20,}|phx_[A-Za-z0-9]{20,}' "$CLIENT" >/tmp/sc_secrets 2>/dev/null; then
  note "possible secret in client bundle:"; sed -E 's/(.{0,24}).*/\1…[REDACTED]/' /tmp/sc_secrets
else
  ok "no sk_live/whsec_/private-key/service-account/Resend/PostHog secrets in $CLIENT"
fi

section "Unauthenticated write path in functions (onCall/onRequest without auth guard)"
# Heuristic: every onCall/onRequest handler should reference an auth/signature guard
# within ~60 lines. Flag exported handlers that never do (manual confirm on any hit;
# the Stripe webhook is signature-gated by design and may show here).
awk '
  /exports\.[A-Za-z0-9_]+ *= *(onCall|onRequest)\(/ { name=$0; buf=""; c=0; capture=1 }
  capture { buf=buf"\n"$0; c++; if (c>60){ if (buf !~ /request\.auth|getAuthedUser|adminGate|req\.auth|webhooks\.constructEvent|constructEvent/) print "UNGUARDED?: " name; capture=0 } }
' "$FUNCS" >/tmp/sc_unguarded 2>/dev/null
if [ -s /tmp/sc_unguarded ]; then
  note "handlers with no visible auth guard (verify manually):"
  cat /tmp/sc_unguarded
else
  ok "every onCall/onRequest references an auth/signature guard"
fi

section "Client price-trust regression (money path)"
# createPaymentIntent/refund must derive amount from listing.ask, never a client-supplied amount/price.
if grep -nE 'amount[[:space:]]*[:=][[:space:]]*(req\.body|request\.data|data)\.(amount|price)' "$FUNCS" >/tmp/sc_price 2>/dev/null; then
  note "functions may trust client amount/price:"; cat /tmp/sc_price
else
  ok "no client-supplied amount/price used in functions money path"
fi

section "Live read-only IDOR probe (unauthenticated Firestore REST)"
for col in orders users conversations messages offers reports; do
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    "https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}?pageSize=1")"
  if [ "$code" = "200" ]; then
    note "PRIVATE collection '$col' is WORLD-READABLE (HTTP 200) — IDOR!"
  else
    ok "$col not public (HTTP $code)"
  fi
done

# ---------- 2. Semantic re-audit via headless Claude ----------
# Requires the `claude` CLI on PATH. Skipped gracefully if absent.
section "Semantic rules re-audit (claude -p)"
if command -v claude >/dev/null 2>&1; then
  VERDICT="$(claude -p "Read $REPO/firestore.rules. Answer with ONLY 'PASS' or 'FAIL: <one-line reason>'. FAIL if any collection holding private data (orders, users, messages, conversations, offers, bids, disputes) is readable or writable by someone who is not its owner/participant/admin, or if any 'allow ... : if true' grants WRITE, or if a private field (email, phone, stripeAccountId, totalRevenue) is exposed to public read." \
    --allowedTools "Read" 2>/dev/null)"
  echo "  claude: $VERDICT"
  case "$VERDICT" in
    PASS*) ok "semantic rules audit passed" ;;
    *)     note "semantic rules audit: $VERDICT" ;;
  esac
else
  echo "  [skip] claude CLI not on PATH — semantic re-audit skipped"
fi

# ---------- Summary ----------
echo
echo "================================================================"
if [ "$FINDINGS" -eq 0 ]; then
  echo "RESULT: PASS — 0 findings  ($DATE)"
  exit 0
else
  echo "RESULT: FAIL — $FINDINGS finding(s)  ($DATE)"
  exit 1
fi
