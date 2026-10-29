#!/usr/bin/env node
// scripts/backfill-createdAt.cjs
//
// One-off, idempotent backfill (2026-10-29 anti-phishing hardening):
// stamp users/{uid}.createdAt from the Firebase Auth record's
// metadata.creationTime wherever the field is MISSING. No signup path wrote
// it (client rules whitelist excludes it), so sendMessage's new-account
// rules read tsToMillis(undefined)=0 and silently skipped every sender.
// sendMessage now reads Auth directly, so this backfill is for consistency
// and for any other reader of users.createdAt — it is not load-bearing.
//
// DEFAULT IS DRY-RUN. Nothing is written unless --apply is passed.
//   • Only sets createdAt where it is missing (never overwrites).
//   • Only touches EXISTING users docs (update(), never creates one —
//     creating a doc would suppress the client's first-sign-in bootstrap).
//   • Prints counts by provider and truncated uids only. No emails, names,
//     or any other PII.
//
// Usage (from repo root, ADC with access to teebox-market):
//   NODE_PATH="$(pwd)/functions/node_modules" node scripts/backfill-createdAt.cjs           # dry run
//   NODE_PATH="$(pwd)/functions/node_modules" node scripts/backfill-createdAt.cjs --apply   # write

const admin = require("firebase-admin");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const db = admin.firestore();
const short = (uid) => String(uid).slice(0, 6) + "…";

/** Provider bucket for reporting: google / apple / facebook / password / phone / synthetic-* / other. */
function providerOf(u) {
  const ids = (u.providerData || []).map((p) => p && p.providerId).filter(Boolean);
  if (ids.includes("google.com")) return "google";
  if (ids.includes("apple.com")) return "apple";
  if (ids.includes("facebook.com")) return "facebook";
  if (ids.includes("password")) return "password";
  if (ids.includes("phone")) return "phone";
  const m = /^(google_com|apple_com)_/.exec(u.uid || "");
  if (m) return m[1] === "google_com" ? "google(synthetic)" : "apple(synthetic)";
  return "other";
}

function bump(tbl, prov, key) {
  tbl[prov] = tbl[prov] || {authUsers: 0, noUserDoc: 0, hadCreatedAt: 0, missingCreatedAt: 0, noAuthTime: 0, written: 0};
  tbl[prov][key]++;
}

(async () => {
  console.log(APPLY ? "MODE: APPLY (writing)" : "MODE: DRY-RUN (no writes; pass --apply to write)");
  const tbl = {};
  const toWrite = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    const refs = page.users.map((u) => db.collection("users").doc(u.uid));
    const snaps = refs.length ? await db.getAll(...refs) : [];
    page.users.forEach((u, i) => {
      const prov = providerOf(u);
      bump(tbl, prov, "authUsers");
      const snap = snaps[i];
      if (!snap || !snap.exists) { bump(tbl, prov, "noUserDoc"); return; }
      if (snap.get("createdAt")) { bump(tbl, prov, "hadCreatedAt"); return; }
      bump(tbl, prov, "missingCreatedAt");
      const ms = Date.parse((u.metadata && u.metadata.creationTime) || "");
      if (isNaN(ms)) { bump(tbl, prov, "noAuthTime"); return; }
      toWrite.push({uid: u.uid, prov, ms});
    });
    pageToken = page.pageToken;
  } while (pageToken);

  if (APPLY) {
    for (let i = 0; i < toWrite.length; i += 400) {
      const batch = db.batch();
      for (const w of toWrite.slice(i, i + 400)) {
        batch.update(db.collection("users").doc(w.uid),
            {createdAt: admin.firestore.Timestamp.fromMillis(w.ms)});
      }
      await batch.commit();
      for (const w of toWrite.slice(i, i + 400)) bump(tbl, w.prov, "written");
    }
  }

  // BEFORE = users docs with createdAt now; AFTER = what it will be (dry run)
  // or is (apply).
  const rows = Object.entries(tbl).sort();
  const tot = {authUsers: 0, noUserDoc: 0, hadCreatedAt: 0, missingCreatedAt: 0, noAuthTime: 0, written: 0};
  console.log("\nprovider            auth  noDoc  before(has)  missing  noAuthTime  after(has)" + (APPLY ? "  written" : ""));
  for (const [prov, r] of rows) {
    for (const k of Object.keys(tot)) tot[k] += r[k];
    const fillable = r.missingCreatedAt - r.noAuthTime;
    const after = r.hadCreatedAt + (APPLY ? r.written : fillable);
    console.log(prov.padEnd(18) + String(r.authUsers).padStart(6) + String(r.noUserDoc).padStart(7) +
      String(r.hadCreatedAt).padStart(13) + String(r.missingCreatedAt).padStart(9) +
      String(r.noAuthTime).padStart(12) + String(after).padStart(12) + (APPLY ? String(r.written).padStart(9) : ""));
  }
  const totAfter = tot.hadCreatedAt + (APPLY ? tot.written : tot.missingCreatedAt - tot.noAuthTime);
  console.log("TOTAL".padEnd(18) + String(tot.authUsers).padStart(6) + String(tot.noUserDoc).padStart(7) +
    String(tot.hadCreatedAt).padStart(13) + String(tot.missingCreatedAt).padStart(9) +
    String(tot.noAuthTime).padStart(12) + String(totAfter).padStart(12) + (APPLY ? String(tot.written).padStart(9) : ""));
  console.log(`\n${APPLY ? "wrote" : "would write"} createdAt on ${APPLY ? tot.written : toWrite.length} users docs.`);
  if (VERBOSE) for (const w of toWrite.slice(0, 50)) console.log("  " + short(w.uid) + "  " + w.prov);
  process.exit(0);
})().catch((e) => { console.error("ERR:", e && e.message); process.exit(1); });
