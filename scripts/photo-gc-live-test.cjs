#!/usr/bin/env node
/* Live proof (2026-11-19): an updateListing edit that removes a photo deletes
 * that photo (original + WebP variants) from Storage, keeps the other, and
 * re-keys photoVariants. Uses a QA account (qa_ uid = test account) and a
 * listing that is HIDDEN the whole time (status hidden, reason
 * payouts_pending: no buyer surface, no live/reminder notifications).
 * Cleans up everything on exit, including on failure.
 *   cd functions && NODE_PATH=$PWD/node_modules node ../scripts/photo-gc-live-test.cjs
 */
"use strict";
const crypto = require("crypto");
const admin = require("firebase-admin");
admin.initializeApp({projectId: "teebox-market", credential: admin.credential.applicationDefault()});
const db = admin.firestore();
const bucket = admin.storage().bucket("teebox-market.firebasestorage.app");
const API_KEY = "AIzaSyAQ7vikZutCQfAaXybQnJcfgnlqpXxHTr4"; // public web key (firebase-messaging-sw.js)
const ts = Date.now();
const uid = `qa_photogc_${ts}`;
const lid = `qa_photogc_${ts}`;
const folder = `listings/${uid}/${lid}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (d !== undefined ? "  " + JSON.stringify(d) : "")); };

async function cleanup() {
  await bucket.deleteFiles({prefix: folder}).catch(() => {});
  await db.doc(`listings/${lid}`).delete().catch(() => {});
  await db.doc(`users/${uid}`).delete().catch(() => {});
  await db.doc(`payoutReminders/${uid}`).delete().catch(() => {});
  await admin.auth().deleteUser(uid).catch(() => {});
  const [left] = await bucket.getFiles({prefix: folder});
  const l = await db.doc(`listings/${lid}`).get();
  console.log(`cleanup: storage objects left ${left.length}, listing exists ${l.exists}`);
}

(async () => {
  try {
    const pw = crypto.randomBytes(18).toString("base64url");
    await admin.auth().createUser({uid, email: `photogc-${ts}@teeboxqa.dev`, emailVerified: true, displayName: "QA PhotoGC", password: pw});
    await db.doc(`users/${uid}`).set({displayName: "QA PhotoGC", isTestAccount: true, sellerVerified: true});
    await db.doc(`listings/${lid}`).set({sellerId: uid, title: "QA photo cleanup test", brand: "QA", cat: "accessories",
      ask: 20, condition: "Good", desc: "", status: "hidden", hiddenReason: "payouts_pending", isTest: true, isTestListing: true,
      photos: [], quantity: 1, quantitySold: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(ts + 864e5)});
    const sharp = require("sharp");
    const urls = [];
    for (const i of [0, 1]) {
      const jpg = await sharp({create: {width: 800, height: 800, channels: 3, background: i ? "#0f3d2e" : "#E3BB45"}}).jpeg().toBuffer();
      const name = `${folder}${ts}_${i}_qa.jpg`;
      const token = crypto.randomUUID();
      await bucket.file(name).save(jpg, {contentType: "image/jpeg", metadata: {metadata: {firebaseStorageDownloadTokens: token}}});
      urls.push(`https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(name)}?alt=media&token=${token}`);
    }
    await db.doc(`listings/${lid}`).update({photos: urls});
    // wait for optimizeListingPhoto to write both variant sets
    let pv = {};
    for (let i = 0; i < 40; i++) {
      pv = ((await db.doc(`listings/${lid}`).get()).data() || {}).photoVariants || {};
      if (pv["0"] && pv["1"]) break;
      await sleep(3000);
    }
    const [before] = await bucket.getFiles({prefix: folder});
    const beforeNames = before.map((f) => f.name.replace(folder, "")).sort();
    check("setup: 2 photos + variants in Storage", !!(pv["0"] && pv["1"]), beforeNames);
    const cur = (await db.doc(`listings/${lid}`).get()).data();

    // sign in as the QA seller and call the deployed updateListing, removing photo 0
    const tok = (await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({email: `photogc-${ts}@teeboxqa.dev`, password: pw, returnSecureToken: true})})).json()).idToken;
    const t0 = new Date().toISOString();
    const r = await fetch("https://us-central1-teebox-market.cloudfunctions.net/updateListing", {method: "POST",
      headers: {"Content-Type": "application/json", "Authorization": "Bearer " + tok},
      body: JSON.stringify({data: {listingId: lid, title: "QA photo cleanup test", brand: "QA", cat: "accessories",
        condition: "Good", desc: "", ask: 20, quantity: 1, photos: [cur.photos[1]]}})});
    const body = await r.json();
    check("updateListing accepted the edit", r.status === 200 && body.result && body.result.ok, {status: r.status, body});
    await sleep(3000);
    const [after] = await bucket.getFiles({prefix: folder});
    const afterNames = after.map((f) => f.name.replace(folder, "")).sort();
    const p0 = `${ts}_0_qa.jpg`; const p1 = `${ts}_1_qa.jpg`;
    check("removed photo deleted from Storage (original + variants)", !afterNames.some((n) => n.startsWith(p0)), afterNames);
    check("kept photo still in Storage (original + variants)", afterNames.includes(p1) && afterNames.filter((n) => n.startsWith(p1)).length >= 2, afterNames);
    const l2 = (await db.doc(`listings/${lid}`).get()).data();
    check("photoVariants re-keyed: index 0 = the kept photo's variants", JSON.stringify(l2.photoVariants) === JSON.stringify({"0": pv["1"]}), Object.keys(l2.photoVariants || {}));
    check("listing stayed hidden", l2.status === "hidden");
    await sleep(8000);
    const {execFileSync} = require("child_process");
    const errs = execFileSync("gcloud", ["logging", "read",
      `resource.labels.service_name="updatelisting" AND severity>=WARNING AND timestamp>="${t0}"`,
      "--project=teebox-market", "--format=value(textPayload,jsonPayload.message)", "--limit=10"], {encoding: "utf8"}).trim();
    const gcLine = execFileSync("gcloud", ["logging", "read",
      `resource.labels.service_name="updatelisting" AND jsonPayload.message:"listing photo GC" AND timestamp>="${t0}"`,
      "--project=teebox-market", "--format=value(jsonPayload.message,jsonPayload.count)", "--limit=3"], {encoding: "utf8"}).trim();
    check("updateListing logged no warnings/errors", errs === "", errs.slice(0, 300));
    check("GC log line present", /removed photos deleted/.test(gcLine), gcLine);
  } catch (e) {
    console.error("FAILED:", e && e.message);
    results.push(false);
  } finally {
    await cleanup();
  }
  console.log(results.every(Boolean) ? "ALL PASS" : "SOME FAILED");
  process.exit(results.every(Boolean) ? 0 : 1);
})();
