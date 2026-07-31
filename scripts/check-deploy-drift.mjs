#!/usr/bin/env node
// Deploy-drift check (2026-07-31). Compares every DEPLOYED Cloud Function
// against main at FUNCTION granularity and prints only genuine lag — the same
// method the 2026-07-31 audit used, codified so it survives.
//
// Two signals, best-available wins per function:
//   1. MANIFEST (precise): .deploy-manifest.json records the git SHA each
//      function was last deployed at (written by scripts/deploy-fn.sh). If an
//      entry exists, lag = "does any commit in <sha>..HEAD touch this
//      function's own line-range (or its bundled email template)?" Immune to
//      clock skew; catches redeploys-from-an-old-checkout.
//   2. TIMESTAMP FALLBACK (for functions not yet deployed through the wrapper):
//      compare gcloud updateTime against the git commit-time of the last change
//      to the function's line-range. Over-reports slightly on clock skew; still
//      honest.
// Also cross-checks: if gcloud shows a deploy NEWER than the manifest SHA's
// commit, the function was deployed OUTSIDE the wrapper → flagged "reconcile"
// (this is how a raw `gcloud functions deploy` becomes self-announcing).
//
// Exit 0 always in WARN mode (default) so it never blocks a push. Pass
// --strict to exit 1 on any genuine lag (for CI, not the pre-push hook).

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const FN_DIR = path.join(ROOT, "functions");
const MANIFEST = path.join(ROOT, ".deploy-manifest.json");
const STRICT = process.argv.includes("--strict");
const sh = (c) => execSync(c, { encoding: "utf8", cwd: ROOT }).trim();

// 1. Deployed functions + updateTime
let deployed;
try {
  deployed = JSON.parse(sh(
    "gcloud functions list --project=teebox-market --v2 " +
    "--format=json 2>/dev/null"))
    .map((f) => ({ name: f.name.split("/").pop(), updateTime: f.updateTime }));
} catch (e) {
  // Do NOT print a clean-looking success here. A failed list means we checked
  // NOTHING — reporting that as "skipping" and exiting 0 would be the exact
  // instrument-lies-clean bug this tool exists to prevent. Say so loudly.
  console.log("\n⚠ deploy-drift: COULD NOT VERIFY — `gcloud functions list` failed (auth/network?).");
  console.log("  This is NOT a clean bill of health; drift status is UNKNOWN.\n");
  process.exit(STRICT ? 1 : 0); // warn mode: don't block push, but never claim clean
}

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};

// Map function name → defining file (grep exports.<name>) + line range.
function locate(name) {
  let hit;
  try {
    hit = sh(`grep -rln "exports.${name} =\\|exports.${name}=" functions/*.js`)
      .split("\n").filter(Boolean)[0];
  } catch { return null; }
  if (!hit) return null;
  const file = hit;
  const startLine = Number(sh(`grep -n "exports.${name} " ${file} | head -1 | cut -d: -f1`) || 0);
  // end = the next `exports.` after startLine, else EOF
  let endLine;
  try {
    endLine = Number(sh(`awk 'NR>${startLine} && /^exports\\./ {print NR; exit}' ${file}`) || 0);
  } catch { endLine = 0; }
  if (!endLine) endLine = Number(sh(`wc -l < ${file}`));
  // email senders bundle a template — flag them so the reader knows to also
  // eyeball templates (full template→function mapping is out of v1 scope).
  const isEmailSender = /loadEmailTemplate|sendEmailCanonical|sendTemplated|templateName|emails\//.test(
    sh(`sed -n '${startLine},${endLine}p' ${file}`));
  return { file, startLine, endLine, isEmailSender };
}

const lag = [];
const unlocatable = [];
for (const fn of deployed) {
  const loc = locate(fn.name);
  if (!loc) { unlocatable.push(fn.name); continue; } // can't map to source — UNCHECKED, tracked below
  const range = `${loc.startLine},${loc.endLine}:${loc.file}`;
  const entry = manifest[fn.name];

  // Email senders bundle a template at deploy — a template-only edit is
  // invisible to a code-line diff (this is the exact class that stranded
  // onDisputeOpenedEmail). So for email senders, also treat any change under
  // functions/emails(-build)/ as a reason to redeploy.
  const tplChanged = (sinceRef) => {
    if (!loc.isEmailSender) return 0;
    try {
      return Number(sh(`git log ${sinceRef}..HEAD --format=%h -- functions/emails functions/emails-build 2>/dev/null | grep -c "^" || true`));
    } catch { return 0; }
  };
  const tplChangedSince = (isoTime) => {
    if (!loc.isEmailSender) return false;
    try {
      const t = sh(`git log -1 --format=%cI -- functions/emails functions/emails-build 2>/dev/null`);
      return t && new Date(t) > new Date(isoTime);
    } catch { return false; }
  };

  if (entry && entry.sha) {
    // MANIFEST path: any commit touching the function's lines OR (for email
    // senders) any template, in sha..HEAD?
    let touched;
    try {
      touched = String(Number(sh(`git log ${entry.sha}..HEAD --format="%h %s" -L ${range} 2>/dev/null | grep -c "^" || true`)) + tplChanged(entry.sha));
    } catch { touched = "0"; }
    // Reconcile check: was it deployed newer than the manifest sha's commit?
    const shaTime = sh(`git show -s --format=%cI ${entry.sha} 2>/dev/null || echo ""`);
    if (shaTime && new Date(fn.updateTime) > new Date(shaTime) + 0 && Number(touched) === 0) {
      // deployed after the manifest sha but manifest wasn't bumped: raw deploy
      lag.push({ ...fn, why: "deployed outside wrapper — reconcile manifest", commits: "" });
      continue;
    }
    if (Number(touched) > 0) {
      const commits = sh(`git log ${entry.sha}..HEAD --format="%h %s" -L ${range} 2>/dev/null | grep -E "^[0-9a-f]{7} " | head -3 | tr '\\n' '; '`);
      lag.push({ ...fn, why: `${touched} commit(s) since deploy sha`, commits });
    }
  } else {
    // TIMESTAMP fallback: last commit-time touching the function's lines
    let lastTouch;
    try {
      lastTouch = sh(`git log -1 --format=%cI -L ${range} 2>/dev/null | head -1`);
    } catch { lastTouch = ""; }
    const codeStale = lastTouch && new Date(lastTouch) > new Date(fn.updateTime);
    const tplStale = tplChangedSince(fn.updateTime);
    if (codeStale || tplStale) {
      const commits = tplStale && !codeStale
        ? sh(`git log -1 --format="%h %s (email template)" -- functions/emails functions/emails-build 2>/dev/null`)
        : sh(`git log --format="%h %s" -L ${range} 2>/dev/null | grep -E "^[0-9a-f]{7} " | head -3 | tr '\\n' '; '`);
      lag.push({ ...fn, why: tplStale && !codeStale ? "email TEMPLATE changed since deploy (no manifest entry)" : "deploy older than last function-level change (no manifest entry)", commits });
    }
  }
}

const checked = deployed.length - unlocatable.length;
// "clean" is always qualified by how much was actually checked — a green
// result must never hide functions the tool couldn't inspect.
const coverage = `${checked}/${deployed.length} deployed functions checked` +
  (unlocatable.length ? `; ${unlocatable.length} UNCHECKED (no source match): ${unlocatable.slice(0, 8).join(", ")}${unlocatable.length > 8 ? "…" : ""}` : "");

if (!lag.length) {
  if (unlocatable.length) {
    console.log(`⚠ deploy-drift: no lag among checked, but ${coverage}.`);
    console.log(`  Not a full clean bill — the UNCHECKED functions above were not inspected.`);
  } else {
    console.log(`✓ deploy-drift: no genuine function-level lag detected (${coverage}).`);
  }
  process.exit(0);
}
console.log(`\n⚠ deploy-drift: ${lag.length} function(s) behind main (${coverage}):\n`);
for (const l of lag) {
  console.log(`  ${l.name}  (deployed ${l.updateTime.slice(0, 10)})`);
  console.log(`     ${l.why}`);
  if (l.commits) console.log(`     ${l.commits}`);
}
console.log(`\n  → redeploy via: scripts/deploy-fn.sh <name>\n`);
process.exit(STRICT ? 1 : 0);
