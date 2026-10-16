#!/usr/bin/env node
// scripts/audit-photo-gaps.mjs — on-demand photo reconciliation (read-only).
//
//   node scripts/audit-photo-gaps.mjs            # human-readable report
//   node scripts/audit-photo-gaps.mjs --json     # machine-readable
//
// gap    = listings.photos[] URL whose Storage object is gone (dead image in
//          the app and a 404 in the Meta catalog feed)
// orphan = original object under listings/ that no listing references
// Also lists active/pending photos with no photoVariants (grid loads the
// full-size original). Same logic as the monthly photoGapAuditMonthly
// function — functions/lib/photoGapAudit.js is the single implementation.
//
// Auth: Application Default Credentials (gcloud auth application-default login).
// Exit code: 0 clean, 2 if any gap or orphan was found (handy in a cron).
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "functions", "package.json"));
const admin = require("firebase-admin");
const {runPhotoGapAudit, formatReport} = require(path.join(ROOT, "functions", "lib", "photoGapAudit.js"));

const AS_JSON = process.argv.includes("--json");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});

const report = await runPhotoGapAudit(admin.firestore(), admin.storage().bucket("teebox-market.firebasestorage.app"));
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report));
process.exit(report.stats.gaps || report.stats.orphans ? 2 : 0);
