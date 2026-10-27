#!/usr/bin/env node
// scripts/scorecard.mjs — print the weekly founder scorecard from prod (ADC).
//   node scripts/scorecard.mjs          # markdown table
//   node scripts/scorecard.mjs --json   # raw numbers
// Aggregates only; never prints a uid, email, or document.
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "functions", "package.json"));
const admin = require("firebase-admin");
const {collectScorecard, formatScorecardMarkdown} = require("../functions/lib/scorecard.js");

admin.initializeApp({projectId: process.env.GOOGLE_CLOUD_PROJECT || "teebox-market"});
const sc = await collectScorecard(admin.firestore(), admin.auth(), new Date());
if (process.argv.includes("--json")) console.log(JSON.stringify(sc, null, 2));
else console.log(formatScorecardMarkdown(sc));
process.exit(0);
