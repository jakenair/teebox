#!/usr/bin/env node
"use strict";
// One-off: give the admin account the admin:true custom claim (2026-11-23).
//
//   node scripts/set-admin-claim.cjs --project teebox-market            # dry run
//   node scripts/set-admin-claim.cjs --project teebox-market --apply
//   node scripts/set-admin-claim.cjs --project teebox-market --apply --uid <uid> [--remove]
//
// Without --uid it uses the old ADMIN_ALLOWLIST secret (read in process, never
// printed) and refuses unless that names exactly one verified account. Other
// claims on the account are kept. The claim reaches the browser on the next
// token refresh (up to an hour, or sign out and in).
const {execFileSync} = require("node:child_process");
const admin = require("firebase-admin");
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i < 0 ? "" : argv[i + 1] || ""; };
const project = opt("--project");
if (!project) { console.error("--project <id> is required"); process.exit(2); }
admin.initializeApp({projectId: project});

(async () => {
  let user;
  if (opt("--uid")) {
    user = await admin.auth().getUser(opt("--uid"));
  } else {
    const list = execFileSync("gcloud", ["secrets", "versions", "access", "latest",
      "--secret=ADMIN_ALLOWLIST", `--project=${project}`], {encoding: "utf8"})
        .split(",").map((x) => x.trim()).filter(Boolean);
    if (list.length !== 1) throw new Error(`the allowlist names ${list.length} accounts; pass --uid`);
    user = await admin.auth().getUserByEmail(list[0]);
  }
  if (!user.emailVerified) throw new Error("account email is not verified");
  if (user.disabled) throw new Error("account is disabled");
  const claims = {...(user.customClaims || {})};
  console.log(`account ${user.uid} · providers ${user.providerData.map((p) => p.providerId).join(", ")}` +
    ` · admin claim now: ${claims.admin === true}`);
  if (!argv.includes("--apply")) { console.log("dry run: nothing changed (add --apply)"); return; }
  if (argv.includes("--remove")) delete claims.admin; else claims.admin = true;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  const after = await admin.auth().getUser(user.uid);
  console.log(`admin claim after: ${!!(after.customClaims && after.customClaims.admin)}`);
})().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
