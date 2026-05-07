#!/usr/bin/env bash
# launch-preflight.sh — verify TeeBox prod is ready BEFORE deploy/submit.
# Idempotent: safe to re-run.

set -u

# Repo root = parent of this script's directory.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Colors (skip if not a TTY).
if [ -t 1 ]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; CYAN=""; BOLD=""; RESET=""
fi

PASS=0
FAIL=0
WARN=0
SUMMARY=""

ok()    { printf "  %s✅%s %s\n" "$GREEN" "$RESET" "$1"; PASS=$((PASS+1)); SUMMARY="${SUMMARY}OK   $1\n"; }
fail()  { printf "  %s❌%s %s\n" "$RED"   "$RESET" "$1"; FAIL=$((FAIL+1)); SUMMARY="${SUMMARY}FAIL $1\n"; }
warn()  { printf "  %s⚠️ %s %s\n" "$YELLOW" "$RESET" "$1"; WARN=$((WARN+1)); SUMMARY="${SUMMARY}WARN $1\n"; }
section(){ printf "\n%s%s%s\n" "$BOLD" "$1" "$RESET"; }

printf "%s%sTeeBox launch preflight%s — %s\n" "$BOLD" "$CYAN" "$RESET" "$(date '+%Y-%m-%d %H:%M:%S')"

# 1. firebase CLI authed.
section "Firebase CLI"
if ! command -v firebase >/dev/null 2>&1; then
  fail "firebase CLI not on PATH"
else
  LOGIN_OUT="$(firebase login:list 2>&1 || true)"
  if printf "%s" "$LOGIN_OUT" | grep -qiE "no (authorized )?accounts|not logged"; then
    fail "firebase CLI not authenticated — run 'firebase login'"
  elif printf "%s" "$LOGIN_OUT" | grep -qE "@"; then
    ok "firebase CLI authenticated"
  else
    warn "firebase login:list returned unexpected output"
  fi

  # 2. Project = teebox-market.
  USE_OUT="$(firebase use 2>&1 || true)"
  if printf "%s" "$USE_OUT" | grep -q "teebox-market"; then
    ok "active firebase project = teebox-market"
  else
    fail "active firebase project is not teebox-market (got: $(printf "%s" "$USE_OUT" | head -1))"
  fi
fi

# 3+4. Secrets — discover names from functions/index.js, then verify each.
section "Secrets"
if [ ! -f functions/index.js ]; then
  fail "functions/index.js missing"
else
  # Extract secret names from defineSecret("NAME") (skip commented lines).
  SECRETS="$(grep -E "^[^/]*defineSecret\([\"']([A-Z0-9_]+)[\"']\)" functions/index.js \
    | grep -oE "defineSecret\([\"'][A-Z0-9_]+[\"']\)" \
    | sed -E "s/defineSecret\([\"']([A-Z0-9_]+)[\"']\)/\1/" \
    | sort -u)"
  if [ -z "$SECRETS" ]; then
    warn "no defineSecret() calls found in functions/index.js"
  else
    while IFS= read -r SECRET; do
      [ -z "$SECRET" ] && continue
      if firebase functions:secrets:access "$SECRET" >/dev/null 2>&1; then
        ok "secret set: $SECRET"
      else
        fail "secret missing: $SECRET (firebase functions:secrets:set $SECRET)"
      fi
    done <<< "$SECRETS"
  fi
fi

# 5. Cloud Functions present remotely.
section "Cloud Functions"
LOCAL_FNS="$(grep -nE "^exports\.[A-Za-z0-9_]+ *=" functions/index.js \
  | sed -E 's/^[0-9]+:exports\.([A-Za-z0-9_]+).*/\1/' \
  | sort -u)"
if [ -z "$LOCAL_FNS" ]; then
  warn "no exports.<name> found in functions/index.js"
else
  REMOTE_LIST="$(firebase functions:list 2>&1 || true)"
  if printf "%s" "$REMOTE_LIST" | grep -qiE "error|denied"; then
    fail "could not fetch remote functions list"
  else
    MISSING=""
    while IFS= read -r FN; do
      [ -z "$FN" ] && continue
      # functions:list output usually shows name in a column; whole-word match.
      if printf "%s" "$REMOTE_LIST" | grep -qE "(^|[^A-Za-z0-9_])${FN}([^A-Za-z0-9_]|$)"; then
        :
      else
        MISSING="${MISSING}${FN} "
      fi
    done <<< "$LOCAL_FNS"
    if [ -z "$MISSING" ]; then
      COUNT="$(printf "%s\n" "$LOCAL_FNS" | wc -l | tr -d ' ')"
      ok "all $COUNT local exports found in remote functions list"
    else
      fail "remote missing functions: $MISSING"
    fi
  fi
fi

# 6. Working tree clean.
section "Git"
if [ -n "$(git status -s 2>/dev/null)" ]; then
  fail "working tree dirty — commit or stash before deploy"
else
  ok "working tree clean"
fi

# 7. sw.js CACHE_VERSION format & age.
section "Service worker"
SW_LINE="$(grep -E "CACHE_VERSION *= *['\"]teebox-" sw.js | head -1 || true)"
if [ -z "$SW_LINE" ]; then
  fail "CACHE_VERSION not found in sw.js"
else
  CV="$(printf "%s" "$SW_LINE" | sed -E "s/.*['\"](teebox-v[0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}-r[0-9]+)['\"].*/\1/")"
  if printf "%s" "$CV" | grep -qE "^teebox-v[0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}-r[0-9]+$"; then
    ok "sw.js CACHE_VERSION = $CV"
    SW_DATE="$(printf "%s" "$CV" | sed -E "s/^teebox-v[0-9]+-([0-9]{4}-[0-9]{2}-[0-9]{2})-r[0-9]+$/\1/")"
    # macOS BSD date.
    SW_EPOCH="$(date -j -f "%Y-%m-%d" "$SW_DATE" "+%s" 2>/dev/null || date -d "$SW_DATE" "+%s" 2>/dev/null || echo "")"
    NOW_EPOCH="$(date "+%s")"
    if [ -n "$SW_EPOCH" ]; then
      DIFF=$(( (NOW_EPOCH - SW_EPOCH) / 86400 ))
      if [ "$DIFF" -gt 7 ]; then
        warn "sw.js CACHE_VERSION is $DIFF days old (>7) — bump before deploy"
      else
        ok "sw.js CACHE_VERSION is $DIFF day(s) old"
      fi
    else
      warn "could not parse sw.js date"
    fi
  else
    fail "sw.js CACHE_VERSION malformed (expected teebox-vN-YYYY-MM-DD-rNN), got: $CV"
  fi
fi

# 8. origin = github.com.
section "Remote (Pages deploys)"
REMOTES="$(git remote -v 2>/dev/null || true)"
if printf "%s" "$REMOTES" | grep -E "^origin\s" | grep -q "github.com"; then
  ok "origin remote points to github.com"
else
  fail "origin remote does not point to github.com (Pages won't deploy)"
fi

# 9. No tracked secrets.
section "Tracked-secrets scan"
LEAKED="$(git ls-files 2>/dev/null | grep -E "(\.env([.\-].*)?$|serviceAccountKey)" || true)"
if [ -z "$LEAKED" ]; then
  ok "no .env / serviceAccountKey files tracked"
else
  fail "tracked secret-like files: $(printf "%s" "$LEAKED" | tr '\n' ' ')"
fi

# Summary.
section "Summary"
printf "%s✅ %d passed   %s❌ %d failed   %s⚠️  %d warnings%s\n" \
  "$GREEN" "$PASS" "$RED" "$FAIL" "$YELLOW" "$WARN" "$RESET"

if [ "$FAIL" -gt 0 ]; then
  printf "%s%sPreflight FAILED — fix the ❌ items before deploying.%s\n" "$BOLD" "$RED" "$RESET"
  exit 1
fi
printf "%s%sPreflight OK — proceed with launch-deploy.sh%s\n" "$BOLD" "$GREEN" "$RESET"
exit 0
