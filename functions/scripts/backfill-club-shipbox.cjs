#!/usr/bin/env node
"use strict";
// Give every club listing without specs.shipBox a box type (2026-11-21).
//
//   node scripts/backfill-club-shipbox.cjs --project teebox-market            # dry run (default)
//   node scripts/backfill-club-shipbox.cjs --project teebox-market --apply    # write
//
// Rule (founder): default to "single" unless the title/specs say set/irons.
// Uses the same classifier the server quotes with (lib/shippingParcels.js),
// so a listing quotes the same box before and after the backfill.
// Writes ONLY specs.shipBox — no updatedAt, so
// no listing re-sorts and no onListingPriceUpdate work (ask unchanged).
// Every listing the classifier wasn't sure about is written to
// ~/Desktop/teebox-private/club-shipbox-<project>-<date>.csv for review.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const admin = require("firebase-admin");
const SP = require("../lib/shippingParcels");

const argv = process.argv.slice(2);
const pi = argv.indexOf("--project");
if (pi < 0 || !argv[pi + 1]) {
  console.error("--project <id> is required"); process.exit(2);
}
const project = argv[pi + 1];
const apply = argv.includes("--apply");
admin.initializeApp({projectId: project});
const db = admin.firestore();

const csv = (v) => `"${String(v == null ? "" : v).replace(/"/g, "\"\"")}"`;

(async () => {
  const snap = await db.collection("listings").where("cat", "==", "clubs").get();
  const rows = [];
  const counts = {single: 0, partial: 0, full: 0};
  let alreadySet = 0;
  const writes = [];
  for (const d of snap.docs) {
    const l = d.data();
    if (SP.CLUB_BOX_KEYS.includes(l.specs && l.specs.shipBox)) { alreadySet++; continue; }
    const c = SP.classifyClubBox(l);
    counts[c.box]++;
    if (!c.confident) {
      rows.push([d.id, l.status || "", c.box, c.why, (l.title || "").slice(0, 120), l.specCategory || ""]);
    }
    writes.push({ref: d.ref, box: c.box});
  }
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(os.homedir(), "Desktop", "teebox-private");
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const f = path.join(dir, `club-shipbox-${project}-${date}.csv`);
  fs.writeFileSync(f, ["listingId,status,assigned,why,title,specCategory",
    ...rows.map((r) => r.map(csv).join(","))].join("\n") + "\n", {mode: 0o600});

  console.log(`club listings: ${snap.size}; already have shipBox: ${alreadySet}; to set: ${writes.length}`);
  console.log(`  single ${counts.single} · partial ${counts.partial} · full ${counts.full}`);
  console.log(`  not sure (review list): ${rows.length} -> ${f}`);
  if (!apply) { console.log("dry run: nothing written (add --apply)"); return; }
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    for (const w of writes.slice(i, i + 400)) {
      b.update(w.ref, {"specs.shipBox": w.box});
    }
    await b.commit();
  }
  console.log(`wrote ${writes.length}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
