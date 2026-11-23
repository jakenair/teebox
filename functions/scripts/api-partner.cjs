#!/usr/bin/env node
"use strict";
// Issue and manage Seller API partners. Admin only (uses your gcloud ADC).
//
//   node scripts/api-partner.cjs --project teebox-market --env sandbox create vendoo "Vendoo" dev@vendoo.example
//   node scripts/api-partner.cjs --project teebox-market --env sandbox test-connection vendoo <sandboxSellerId>
//   node scripts/api-partner.cjs --project teebox-market --env sandbox rotate vendoo
//   node scripts/api-partner.cjs --project teebox-market --env sandbox list
//   node scripts/api-partner.cjs --project teebox-market --env sandbox disable vendoo "reason"   # KILL SWITCH
//   node scripts/api-partner.cjs --project teebox-market --env sandbox enable vendoo
//
// --env sandbox issues pk_test_ / sk_conn_test_ keys and can only reach
// sandbox_* collections (lib/sandboxDb.js). --env live can only disable and
// list while LIVE_API_ENABLED is false.
//
// Keys are NEVER printed. A new key is written to
// ~/.teebox/partner-keys/ (never Desktop or Documents: iCloud syncs those)
// as <project>-<env>-<partner>.txt (mode 600)
// for you to send to the partner over a secure channel, then delete.
// --project and --env are required, so a live key can't be issued by accident.
// Set FIRESTORE_EMULATOR_HOST to run against the emulator.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const admin = require("firebase-admin");
const keys = require("../lib/sellerApiKeys");
const config = require("../lib/sellerApiConfig");

const {sandboxDb} = require("../lib/sandboxDb");

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf("--" + name);
  return i < 0 ? "" : String(argv.splice(i, 2)[1] || "");
}
const project = flag("project");
const envName = flag("env");
if (!project || !["sandbox", "live"].includes(envName)) {
  console.error("--project <id> and --env <sandbox|live> are required"); process.exit(2);
}
const [cmd, partnerId, ...rest] = argv;
const live = envName === "live";
if (live && !["disable", "list"].includes(cmd) && !config.liveEnabled({...process.env, GCLOUD_PROJECT: project})) {
  console.error("refusing: the live API is off (LIVE_API_ENABLED)"); process.exit(2);
}

admin.initializeApp({projectId: project});
const db = live ? admin.firestore() : sandboxDb(admin.firestore());
const cfg = config.resolve(live ? "live" : "test", {GCLOUD_PROJECT: project});
const d = {db, FieldValue: admin.firestore.FieldValue, cfg};

function saveKey(kind, id, key) {
  const dir = path.join(os.homedir(), ".teebox", "partner-keys");
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(path.dirname(dir), 0o700);
  fs.chmodSync(dir, 0o700);
  const f = path.join(dir, `${project}-${envName}-${id}${kind === "connection" ? "-test-connection" : ""}.txt`);
  fs.writeFileSync(f, key + "\n", {mode: 0o600});
  return f;
}

(async () => {
  switch (cmd) {
    case "create": {
      const [name, email] = rest;
      const r = await keys.createPartner(d, {partnerId, name, contactEmail: email});
      console.log(`created partner ${r.partnerId} (${cfg.mode}); key saved to ${saveKey("partner", r.partnerId, r.key)}`);
      break;
    }
    case "rotate": {
      const r = await keys.rotatePartnerKey(d, {partnerId});
      console.log(`rotated ${r.partnerId}; old key stopped working; new key saved to ${saveKey("partner", r.partnerId, r.key)}`);
      break;
    }
    case "disable": case "enable": {
      const r = await keys.setPartnerStatus(d, {partnerId, status: cmd === "disable" ? "disabled" : "active", reason: rest.join(" ")});
      console.log(`${r.partnerId} is now ${r.status}${r.status === "disabled" ? " (its key and every seller connection made for it are refused)" : ""}`);
      break;
    }
    case "list": {
      const s = await db.collection("apiPartners").get();
      for (const p of s.docs) {
        const n = await db.collection("apiConnections").where("partnerId", "==", p.id).where("status", "==", "active").count().get();
        console.log(`${p.id}\t${p.data().status}\t${p.data().name}\tkey …${p.data().keyLast4}\t${n.data().count} active connections`);
      }
      break;
    }
    case "test-connection": {
      // Sandbox only: make a connection key for a seeded sandbox seller.
      if (cfg.live) throw new Error("test-connection is sandbox only");
      const [uid] = rest;
      if (!uid) throw new Error("usage: test-connection <partnerId> <sandboxSellerId>");
      if (!(await db.doc(`users/${uid}`).get()).exists) throw new Error(`no sandbox seller ${uid} (run seed-sandbox.cjs)`);
      const r = await keys.createConnection(d, {uid, partnerId});
      console.log(`connection ${r.connectionId} for ${uid}; key saved to ${saveKey("connection", partnerId, r.key)}`);
      break;
    }
    default:
      console.error("commands: create | rotate | disable | enable | list | test-connection"); process.exit(2);
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
