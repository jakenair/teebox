#!/usr/bin/env node
"use strict";
// Seller API platform switch, by hand.
//   node functions/scripts/api-switch.cjs status
//   node functions/scripts/api-switch.cjs on  --apply
//   node functions/scripts/api-switch.cjs off --apply
const {execFileSync} = require("node:child_process");
const {setApiOpen, readApiOpen} = require("../lib/apiSwitch");
const token = () => execFileSync("gcloud", ["auth", "print-access-token"], {encoding: "utf8"}).trim();
const cmd = process.argv[2];
(async () => {
  const t = token();
  if (cmd === "status") { console.log("API is", await readApiOpen({token: t}) ? "ON" : "OFF"); return; }
  if (!["on", "off"].includes(cmd)) { console.error("status | on --apply | off --apply"); process.exit(2); }
  if (!process.argv.includes("--apply")) { console.log("dry run: would turn the API", cmd, "(add --apply)"); return; }
  await setApiOpen(cmd === "on", {token: t});
  console.log("the API is now", cmd.toUpperCase(), "(outside traffic follows within about a minute)");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
