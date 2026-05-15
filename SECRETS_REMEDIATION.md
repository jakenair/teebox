# Secrets Remediation Runbook

**Author:** investigation produced 2026-05-15
**Scope:** four API secrets pasted into Claude chat history during the May 2026 launch-hardening push (`re_JWccjuFJ_...`, `whsec_rFNk5kVCQ0c1/...`, `whsec_CYjeMGBP0wFIjwZ9...`, `sk-ant-api03-sDaQMhVcNOXre4JGl...`).
**Status:** investigation only — no rotations have been performed and no history has been rewritten. The founder must execute the steps below.

---

## 1. Summary

| Secret | Exposure vector | In git history? | In tracked source? | In shell history? | Severity |
|---|---|:-:|:-:|:-:|:-:|
| `RESEND_API_KEY` (`re_JWccjuFJ_…`) | Chat history only | No | No | No | LOW |
| `RESEND_WEBHOOK_SECRET` (`whsec_rFNk5kVCQ0c1/…`) | Chat history only | No | No | No | LOW |
| `STRIPE_CONNECT_WEBHOOK_SECRET` (`whsec_CYjeMGBP0wFIjwZ9…`) | Chat history only | No | No | No | LOW |
| `ANTHROPIC_API_KEY` (`sk-ant-api03-sDaQMhVcNOXre4JGl…`) | Chat history only | No | No | No | LOW-to-MED (charges $500/mo personal account) |

**Headline:** zero of the four secrets ever entered the git repository. No history scrub is required. The remediation reduces to (a) provider-side rotation and (b) installing a pre-commit secret scanner so future pastes can't slip in.

### Severity ranking (highest first)

1. **`ANTHROPIC_API_KEY`** — bills against Jake's personal Anthropic account up to a $500/mo cap. Worst case if abused: $500 of charges before revoke. Rotate first.
2. **`RESEND_API_KEY`** — send-only key for `mail.teeboxmarket.com`. Worst case: third party sends spam from the domain, burning sender reputation that took weeks to build.
3. **`STRIPE_CONNECT_WEBHOOK_SECRET`** — lets a third party forge Connect-account webhook events (`payout.paid`, etc.). Idempotency keys + Firestore-side state checks limit damage to event-noise.
4. **`RESEND_WEBHOOK_SECRET`** — lets a third party forge bounce/suppression notifications. Lowest impact: at worst, fake "bounce" events suppress real send addresses; we already trust-but-verify payloads.

---

## 2. Per-secret rotation steps

The pattern is identical for all four: rotate at the provider dashboard, then write the new value to the Firebase Secret Manager (which becomes `:latest`), then redeploy every function that lists the secret in its `secrets: [...]` array. Firebase auto-resolves `:latest` at cold-start time, but live function instances keep the old value until they restart — so redeploy is mandatory.

Always use the **interactive** form of `firebase functions:secrets:set` (it prompts for the value on stdin; the value does **not** appear in your shell history or in `ps`). Never use `--data-file=-` with an inline `printf`, and never paste the value as a command-line argument.

### 2.1 `RESEND_API_KEY` (rotate first because send reputation matters)

1. Resend dashboard → API Keys → revoke the existing `re_JWccjuFJ_*` key.
2. Create a new key, scope = "Sending access" on domain `mail.teeboxmarket.com` (send-only — do **not** grant `domains:read` or `emails:read`).
3. Copy the new value to clipboard (one-time view).
4. Set in Firebase:
   ```sh
   firebase functions:secrets:set RESEND_API_KEY --project=teebox-market
   # Paste at the interactive prompt. Do NOT echo or printf the value.
   ```
5. Redeploy every function that uses it. From the code these are:
   ```sh
   firebase deploy --only \
     functions:resendWebhook,\
   functions:onOrderCreated,functions:onOrderShipped,functions:onOrderDelivered,\
   functions:onPayoutPaid,functions:onRefundCreated,functions:onDisputeCreated,\
   functions:emailSmokeTest,\
   functions:digestDailyBuyer,functions:digestDailySeller,functions:digestDailyAdmin,functions:digestWeeklySeller,\
   functions:freezeAccountEmail,\
   functions:abandonedCartReminder,\
   functions:dailyFounderBriefing,functions:dailyFounderBriefingManual \
     --project=teebox-market
   ```
   (Function names verified from `functions/emailTriggers.js`, `functions/emailSmokeTest.js`, `functions/abandonedCartTrigger.js`, `functions/founderBriefing.js`. Run `firebase functions:list` first to sanity-check the exact deployed names.)
6. Verify with the existing smoke test:
   ```sh
   firebase functions:call emailSmokeTest --project=teebox-market
   ```
   It refuses to run if `RESEND_API_KEY` is a placeholder, so a green run confirms the new key is live.

### 2.2 `RESEND_WEBHOOK_SECRET`

1. Resend dashboard → Webhooks → endpoint `https://resendwebhook-…/cloudfunctions.net/resendWebhook` → "Roll signing secret".
2. Capture the new `whsec_…` value.
3. Set:
   ```sh
   firebase functions:secrets:set RESEND_WEBHOOK_SECRET --project=teebox-market
   ```
4. Redeploy:
   ```sh
   firebase deploy --only functions:resendWebhook,functions:emailSmokeTest --project=teebox-market
   ```
5. Verify: send a test event from the Resend dashboard ("Send test event"). Function should accept the new signature and reject the previous one (signature-verification log line in Cloud Logging).

### 2.3 `STRIPE_CONNECT_WEBHOOK_SECRET`

1. Stripe dashboard → Developers → Webhooks → **Connected accounts** endpoint (the one that receives `payout.*`, `account.updated`, etc., not the platform endpoint) → "Roll secret".
2. Capture the new `whsec_…`.
3. Set:
   ```sh
   firebase functions:secrets:set STRIPE_CONNECT_WEBHOOK_SECRET --project=teebox-market
   ```
4. Redeploy. The Connect webhook handler lives in `functions/missingProducers.js`; run `firebase functions:list | grep -i connect` to confirm the deployed function name, then:
   ```sh
   firebase deploy --only functions:stripeConnectWebhook --project=teebox-market
   ```
   (Adjust the function name if `functions:list` reports something different.)
5. Verify: replay a recent Connect event from the Stripe dashboard. New signing secret should validate; the old one should fail.

### 2.4 `ANTHROPIC_API_KEY` (rotate first if the $500/mo cap is the highest-leverage threat)

1. `console.anthropic.com` → API Keys → revoke the key labelled `teebox-market-prod` (or whatever the founder-briefing key is named).
2. Create a new key. Recommended hardening:
   - **Move the budget off Jake's personal account** if there is a Teebox Market workspace billing entity. If not, create one and re-issue from there.
   - Set a per-key monthly limit (currently $500 at the org level — set the per-key cap to $50 or whatever covers daily briefing usage with margin).
3. Set:
   ```sh
   firebase functions:secrets:set ANTHROPIC_API_KEY --project=teebox-market
   ```
4. Redeploy the only function that uses it:
   ```sh
   firebase deploy --only functions:dailyFounderBriefing,functions:dailyFounderBriefingManual --project=teebox-market
   ```
5. Verify:
   ```sh
   curl -X POST -H "X-Briefing-Trigger: 1" \
     https://<region>-teebox-market.cloudfunctions.net/dailyFounderBriefingManual
   ```
   The function logs `[BRIEFING] ANTHROPIC_API_KEY not set` if the secret is missing/placeholder; a successful AI-written briefing email confirms the new key works.

### 2.5 Clean up old secret versions (optional, after verification)

Firebase keeps every prior secret version forever unless you destroy it. After confirming the new version is in use and stable for ~24h, destroy the old version to remove the leaked value from Google Secret Manager:

```sh
gcloud secrets versions list RESEND_API_KEY              --project=teebox-market
gcloud secrets versions destroy <OLD_VERSION> --secret=RESEND_API_KEY              --project=teebox-market
# repeat for RESEND_WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET, ANTHROPIC_API_KEY
```

`destroy` is irreversible; only run it after the new version has cycled through every deployed function (give it 48h after the last redeploy to be safe).

---

## 3. Git history scrub procedure

### 3.1 Verdict: not required

The pickaxe search results were:

```sh
git log --all --full-history -p -S "re_JWccjuFJ"                  # 0 matches
git log --all --full-history -p -S "whsec_rFNk5kVCQ0c1"           # 0 matches
git log --all --full-history -p -S "whsec_CYjeMGBP0wFIjwZ9"       # 0 matches
git log --all --full-history -p -S "sk-ant-api03-sDaQMhVcNOXre4JGl" # 0 matches
```

No commit on any branch added or removed any of the four substrings, across the full 231-commit history. **No history rewrite is needed.**

Additionally, the working tree contains zero hardcoded secret literals: `git grep` for the high-entropy patterns `re_*`, `whsec_*`, `sk-ant-api03-*`, `sk_live_*`, `sk_test_*` finds only false-positives (`require_*`, `capture_*`) and one **public** PostHog client key (`PUBLIC_POSTHOG_KEY` in `index.html`, which is intentionally public — PostHog project keys are designed for client embedding). The committed `ios/App/App/GoogleService-Info.plist` and the per-brand HTML files also contain Firebase Web API keys (`AIzaSy…`) — these are public client identifiers, restricted server-side by Firebase App Check + API key restrictions, and are not in scope for this remediation.

### 3.2 If a future scrub IS ever needed (template)

Keep this section as the playbook for the next time a real secret enters history. **Do not run this now.**

Pre-conditions before any history rewrite:
- The founder has explicitly approved the rewrite.
- Every collaborator and CI integration has been notified — they will need to re-clone or hard-reset their working copies.
- The secret has already been rotated at the provider. (Scrubbing without rotation is theatre — anyone who already cloned has the secret regardless.)

Procedure (using `git-filter-repo`, which is faster and safer than BFG and doesn't require Java):

```sh
# 1. Install git-filter-repo (Homebrew)
brew install git-filter-repo

# 2. Make a fresh, dedicated mirror clone (filter-repo refuses to run on a clone
#    with other tools/IDEs attached — work in an isolated directory).
cd ~/Desktop
git clone --mirror git@github.com:jakenair/teebox.git teebox-scrub.git
cd teebox-scrub.git

# 3. Write a replacements.txt file listing each secret value, one per line, in
#    the form  <literal>==><REDACTED>  (filter-repo's text-replacement syntax).
#    DO NOT commit replacements.txt to any repo.
cat > /tmp/replacements.txt <<'EOF'
re_JWccjuFJ_REDACTED_FULL_VALUE==><REDACTED:RESEND_API_KEY>
whsec_rFNk5kVCQ0c1/a7A4e2RyihcTierVPNB==><REDACTED:RESEND_WEBHOOK_SECRET>
whsec_CYjeMGBP0wFIjwZ9XM70jKVL7fjKxT4M==><REDACTED:STRIPE_CONNECT_WEBHOOK_SECRET>
sk-ant-api03-sDaQMhVcNOXre4JGl…<remainder>==><REDACTED:ANTHROPIC_API_KEY>
EOF

# 4. Dry-run first. --refs HEAD limits to default branch initially; remove for
#    a full all-refs scrub once you trust the result.
git filter-repo --replace-text /tmp/replacements.txt --dry-run

# 5. Inspect the dry-run output, verify the right blobs were touched, then run
#    for real:
git filter-repo --replace-text /tmp/replacements.txt

# 6. Force-push every ref (this is destructive — every other clone now diverges):
git push --force --all
git push --force --tags

# 7. Shred the replacements file:
shred -u /tmp/replacements.txt    # or: rm -P on macOS

# 8. Invalidate caches: nuke any CI build caches (GitHub Actions cache, Firebase
#    Functions deploy cache, npm cache that might have rehydrated from history).
#    Specifically:
#      - GitHub: Settings → Actions → Caches → delete all
#      - Firebase: irrelevant (Firebase doesn't cache git history)
#      - Any local clones on other machines: `git fetch --all && git reset --hard origin/<branch>`,
#        or simpler: re-clone from scratch.

# 9. Confirm the secret is gone from all refs:
git log --all --full-history -p -S "<secret-substring>"   # should be empty
git rev-list --all | xargs git grep "<secret-substring>"  # should be empty

# 10. Treat the secret as compromised forever, regardless of scrub success.
#     Anyone who fetched between the leak and the scrub still has the value
#     locally. Rotation is the only reliable mitigation.
```

**Critical safety notes:**
- Rewriting history breaks every existing clone and PR. If there are open PRs, they must be re-based or re-created after the scrub.
- GitHub caches old SHAs for ~90 days at `https://github.com/jakenair/teebox/commit/<old-sha>` even after force-push. Contact GitHub Support to expedite cache eviction if the secret is high-value (Stripe live keys, PII).
- Tags pointing to rewritten commits become orphaned; re-create any tags you care about after the scrub.

---

## 4. Pre-commit hook recommendation

The repo currently has **no** secret-scanning hook (`.husky/`, `.github/workflows/`, and `.git/hooks/` contain only Git samples). Recommend installing **gitleaks** — it is single-binary Go, no runtime deps, and has the lowest false-positive rate of the three options (`gitleaks` / `trufflehog` / `git-secrets`).

### 4.1 Install gitleaks locally

```sh
brew install gitleaks
```

### 4.2 Add a project pre-commit hook

The repo has no Husky setup yet and no other Node-based hook framework. The lightest path is a plain Git hook plus a tiny `gitleaks.toml`. Create the following two files (the founder can copy them in — do not commit them via this remediation PR; treat installation as a follow-up):

**`.git/hooks/pre-commit`** (executable, not tracked — install on every clone):

```sh
#!/usr/bin/env bash
set -euo pipefail
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed; install with: brew install gitleaks" >&2
  exit 0   # do not block commits if the tool isn't available
fi
gitleaks protect --staged --redact --config "$(git rev-parse --show-toplevel)/.gitleaks.toml"
```

Make it executable: `chmod +x .git/hooks/pre-commit`. (Or commit it under `scripts/git-hooks/pre-commit` and add `git config core.hooksPath scripts/git-hooks` to the project README so it's discoverable.)

**`.gitleaks.toml`** (tracked at repo root):

```toml
title = "TeeBox Market gitleaks config"

[extend]
useDefault = true

# Allow the public PostHog client key in index.html — these are designed to
# be embedded in the browser bundle, not secrets.
[[allowlist]]
description = "Public PostHog project key"
regexes = ['phc_[A-Za-z0-9]+']
paths = ['^index\.html$', '^functions/founderBriefingConfig\.js$']

# Allow Firebase Web/iOS API keys — these are public client identifiers,
# secured server-side via App Check + API key restrictions.
[[allowlist]]
description = "Firebase Web / iOS API key"
regexes = ['AIzaSy[A-Za-z0-9_-]{20,}']
paths = ['\.html$', 'GoogleService-Info\.plist$', 'google-services\.json$']

# Custom high-confidence rules layered on top of the default set.
[[rules]]
id = "resend-api-key"
description = "Resend send key"
regex = '''re_[A-Za-z0-9_]{20,}'''

[[rules]]
id = "resend-webhook-secret"
description = "Resend or Stripe whsec_ value"
regex = '''whsec_[A-Za-z0-9/+]{20,}'''

[[rules]]
id = "anthropic-key"
description = "Anthropic API key"
regex = '''sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}'''

[[rules]]
id = "stripe-live"
description = "Stripe live secret key"
regex = '''sk_live_[A-Za-z0-9]{20,}'''
```

### 4.3 Add a GitHub Action as a second layer

Pre-commit hooks rely on individual clones; the GitHub Action catches anything that slips past (or any contributor who hasn't installed gitleaks). Create `.github/workflows/secret-scan.yml`:

```yaml
name: secret-scan
on:
  push:
    branches: ['**']
  pull_request:
    branches: ['**']
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # full history so gitleaks can scan new commits in PRs
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          config-path: .gitleaks.toml
```

(Note: the repo currently has no `.github/workflows/` directory at all, so this would be the first workflow. The deploy pipeline runs on GitHub Pages from `main`, so existing deploy behaviour won't change.)

---

## 5. Anti-recurrence checklist (5 habit changes, ranked by leverage)

1. **Never paste a secret as a command argument.** Use the interactive form of `firebase functions:secrets:set <NAME>` (which prompts on stdin) and never the `--data-file=-` / `echo "$SECRET" |` / `printf "$SECRET" |` variants. This keeps the value out of shell history, `ps`, and any tee'd terminal log. *Leverage: highest — single biggest behavioural delta.*

2. **Don't paste real secrets into Claude/chat at all. Refer to them by name.** When asking the assistant about a key, say "the Resend send key in `RESEND_API_KEY`" — never paste the value. The four leaks happened during legitimate troubleshooting flows where a quick "is this key correct?" felt easier than reading via `gcloud secrets versions access`. It is not easier; it is what got us here. *Leverage: high — this is the actual root cause.*

3. **Install a pre-commit secret scanner today (gitleaks).** See section 4. The repo got lucky this time (zero secrets reached git), but luck is not a control. *Leverage: high — converts a class of leaks from human-judgement to mechanical-block.*

4. **After any command that touched a secret, `history -d $(history 1 | awk '{print $1}')` immediately.** And `unset RESEND_API_KEY ANTHROPIC_API_KEY ...` in the same shell session before the next command. (Even though the interactive `firebase functions:secrets:set` doesn't echo the value, copying-pasting it from a clipboard into the terminal can still leave it in clipboard-history apps; macOS users should also `pbcopy </dev/null` to clear the clipboard.) *Leverage: medium — defence in depth.*

5. **Treat any secret that ever appeared in a chat as compromised — rotate on a schedule.** Quarterly rotation of `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, and both `whsec_` values; immediate rotation after any "did I just paste that?" moment. Put a calendar reminder. *Leverage: medium — accepts that humans will leak and limits the window.*

---

## 6. Out-of-scope / could-not-determine

- **Screenshots:** if any of these secrets ever appeared in a screenshot (in a Slack DM, a tweet, a screen-share recording) we can't audit that channel. None of the four secrets are believed to have been screenshotted, but flagging the possibility.
- **Clipboard history apps** (Maccy, Paste, Raycast clipboard) may retain pasted secret values for days. The founder should clear clipboard-history app caches after rotation.
- **`~/.bash_history` does not exist** on this machine (zsh-only), so there is no bash-history exposure surface; `~/.zsh_history` was searched and contains none of the four substrings and no `firebase functions:secrets:set` commands (consistent with always using the interactive form, which is the good outcome).
- **No `.env` files exist in the working tree** (`find . -name '.env*'` returns nothing outside `node_modules`), so there is no local-file leak path.
