#!/usr/bin/env bash
# launch-deploy.sh — TeeBox prod deploy in safe order, with confirmations.
# Use --yes to skip prompts. Idempotent: each step can be re-run.

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; CYAN=""; BOLD=""; RESET=""
fi

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      cat <<EOF
Usage: bash scripts/launch-deploy.sh [--yes]

Runs the TeeBox prod deploy in this order:
  1. launch-preflight.sh   (abort on fail)
  2. firestore:indexes
  3. firestore:rules + storage:rules
  4. fast-path functions  (notifyOnNewMessage, incrementListingMessage, deleteUserAccount)
  5. ALL functions        (slow — explicit confirm)
  6. git push             (Pages deploy — explicit confirm)

Flags:
  --yes, -y   skip confirm prompts
EOF
      exit 0
      ;;
  esac
done

step()  { printf "\n%s%s== %s ==%s\n" "$BOLD" "$CYAN" "$1" "$RESET"; }
ok()    { printf "%s✅%s %s\n" "$GREEN" "$RESET" "$1"; }
warnp() { printf "%s⚠️ %s %s\n" "$YELLOW" "$RESET" "$1"; }
abort() { printf "%s❌ %s%s\n" "$RED" "$1" "$RESET"; exit 1; }

confirm() {
  local prompt="$1"
  if [ "$ASSUME_YES" -eq 1 ]; then
    printf "%s» auto-confirm:%s %s\n" "$YELLOW" "$RESET" "$prompt"
    return 0
  fi
  printf "%s» %s [y/N]:%s " "$YELLOW" "$prompt" "$RESET"
  read -r REPLY </dev/tty || REPLY=""
  case "$REPLY" in
    y|Y|yes|YES) return 0 ;;
    *) abort "aborted by user" ;;
  esac
}

trap 'echo; printf "%s❌ deploy aborted on error (exit=%d)%s\n" "$RED" "$?" "$RESET"' ERR

# 1. Preflight.
step "1/6 launch-preflight.sh"
bash scripts/launch-preflight.sh || abort "preflight failed — fix issues and retry"

# 2. Firestore indexes.
step "2/6 firestore:indexes"
confirm "Deploy firestore:indexes?"
firebase deploy --only firestore:indexes
ok "firestore indexes deployed"

# 3. Rules (firestore + storage).
step "3/6 firestore:rules + storage:rules"
confirm "Deploy firestore:rules and storage:rules?"
firebase deploy --only firestore:rules,storage
ok "rules deployed"

# 4. Fast-path functions.
step "4/6 fast-path functions"
confirm "Deploy notifyOnNewMessage, incrementListingMessage, deleteUserAccount?"
firebase deploy --only functions:notifyOnNewMessage,functions:incrementListingMessage,functions:deleteUserAccount
ok "fast-path functions deployed"

# 5. ALL functions (slow — explicit confirm always).
step "5/6 ALL functions (slow)"
warnp "This deploys every Cloud Function and can take 5-15 minutes."
confirm "Deploy ALL functions now?"
firebase deploy --only functions
ok "all functions deployed"

# 6. git push (Pages).
step "6/6 git push (GitHub Pages → teeboxmarket.com)"
if [ -n "$(git status -s)" ]; then
  abort "working tree dirty — commit before pushing"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
warnp "About to: git push origin $BRANCH"
confirm "Push to origin/$BRANCH (triggers Pages deploy)?"
git push origin "$BRANCH"
ok "pushed to origin/$BRANCH — Pages will build shortly"

step "DEPLOY COMPLETE"
printf "%s%sNext:%s open scripts/launch-smoke.md and run the 5-min checklist.\n" "$BOLD" "$GREEN" "$RESET"
printf "  npm run launch:smoke\n"
exit 0
