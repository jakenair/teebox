"use strict";
// decideAuthReview / listAuthReviews against the Firestore emulator. Email is stubbed.
// Run: firebase emulators:exec --only firestore --project=demo-teebox "node test/e2e/authReview.e2e.cjs"
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("emulator only"); process.exit(2); }
process.env.GCLOUD_PROJECT = "demo-teebox";
process.env.ADMIN_ALLOWLIST = "admin@example.test";
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
admin.initializeApp({projectId: "demo-teebox"});
const db = admin.firestore();
const sent = [];
const path = require("node:path");
const stub = (p, exp) => { const f = require.resolve(path.join("../..", p)); require.cache[f] = {id: f, filename: f, loaded: true, exports: exp}; };
stub("lib/email", {sendEmail: async (m) => { sent.push(m); return {ok: true}; }});
stub("lib/emailRecipient", {resolveUserEmail: async (uid) => ({email: uid === "noemail" ? null : `${uid}@example.test`})});
const {decideAuthReview, listAuthReviews} = require("../../authReviewAdmin");
const {_feed: F} = require("../../metaFeed");
const now = () => Math.floor(Date.now() / 1000);
const auth = (o) => ({uid: "adm", token: {email: "admin@example.test", email_verified: true, auth_time: now(), ...o}});
const run = (fn, data, a) => fn.run({auth: a === undefined ? auth() : a, data, rawRequest: {}});
const fails = async (p, code) => { try { await p; } catch (e) { assert.equal(e.code, code, e.message); return e; } throw new Error("expected " + code); };
const L = (o) => ({title: "Putter", brand: "B", cat: "clubs", ask: 400, sellerId: "s1", status: "active", requiresAuth: true,
  authReviewState: "pending", condition: "Good", createdAt: admin.firestore.Timestamp.now(),
  photos: ["https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg?alt=media"], ...o});
let n = 0; const ok = (m) => { n++; console.log("ok", n, m); };
(async () => {
  for (const [id, o] of Object.entries({listA1: {}, listB2: {}, listC3: {status: "pending"}, listD4: {ask: 50, requiresAuth: false, authReviewState: "na"},
    listE5: {authReviewState: "approved"}, listF6: {status: "sold"}, listG7: {sellerId: "noemail"}})) await db.doc("listings/" + id).set(L(o));
  const get = async (id) => (await db.doc("listings/" + id).get()).data();
  await fails(run(decideAuthReview, {listingId: "listA1", decision: "approve"}, null), "unauthenticated"); ok("signed out refused");
  await fails(run(decideAuthReview, {listingId: "listA1", decision: "approve"}, auth({email: "x@example.test"})), "permission-denied"); ok("non-admin refused");
  await fails(run(decideAuthReview, {listingId: "listA1", decision: "approve"}, auth({email_verified: false})), "permission-denied"); ok("unverified email refused");
  const e = await fails(run(decideAuthReview, {listingId: "listA1", decision: "approve"}, auth({auth_time: now() - 900})), "failed-precondition");
  assert.equal(e.details.reauthRequired, true); ok("stale sign-in asks for re-auth");
  await fails(run(listAuthReviews, {}, auth({email: "x@example.test"})), "permission-denied"); ok("list is admin only");
  assert.deepEqual((await run(listAuthReviews, {})).items.map((i) => i.listingId).sort(), ["listA1", "listB2", "listC3", "listG7"]); ok("queue = undecided, live ones only");
  assert.equal(F.feedRow({id: "listA1", ...await get("listA1")}), null); ok("not in the feed while pending");
  let r = await run(decideAuthReview, {listingId: "listA1", decision: "approve"});
  assert.deepEqual([r.ok, r.status, r.emailed], [true, "active", true]);
  let l = await get("listA1"); assert.equal(l.authReviewState, "approved"); assert.equal(l.authReviewedBy, "adm"); ok("approve recorded");
  assert.equal(F.feedRow({id: "listA1", ...l}).availability, "in stock"); ok("in the feed once approved");
  assert.equal(sent[0].subject, "Approved: Putter"); assert.equal(sent[0].to, "s1@example.test"); ok("approve email");
  r = await run(decideAuthReview, {listingId: "listA1", decision: "approve"}); assert.equal(r.noop, true); assert.equal(sent.length, 1); ok("second approve: no-op, no second email");
  await fails(run(decideAuthReview, {listingId: "listB2", decision: "reject", reason: " "}), "failed-precondition"); ok("reject needs a reason");
  r = await run(decideAuthReview, {listingId: "listB2", decision: "reject", reason: "Serial number missing"});
  l = await get("listB2"); assert.deepEqual([l.status, l.authReviewState, l.authReviewReason], ["removed", "rejected", "Serial number missing"]); ok("reject takes it down");
  const {render} = require("@react-email/render"); const html = await render(sent[1].react);
  assert.ok(html.includes("Serial number missing") && sent[1].subject === "Not approved: Putter"); ok("reject email carries the reason");
  r = await run(decideAuthReview, {listingId: "listB2", decision: "approve"}); l = await get("listB2");
  assert.deepEqual([l.status, l.authReviewState, l.authReviewReason, l.removedAt, l.removedReason], ["active", "approved", undefined, undefined, undefined]); ok("approve after reject restores it");
  assert.notEqual(sent[2].idempotencyKey, sent[1].idempotencyKey); ok("each decision has its own email key");
  await fails(run(decideAuthReview, {listingId: "listC3", decision: "reject", reason: "x"}), "failed-precondition"); ok("refused during checkout");
  await fails(run(decideAuthReview, {listingId: "listD4", decision: "approve"}), "failed-precondition"); ok("under $300 refused");
  await fails(run(decideAuthReview, {listingId: "listF6", decision: "approve"}), "failed-precondition"); ok("sold refused");
  await fails(run(decideAuthReview, {listingId: "nothere", decision: "approve"}), "not-found"); ok("missing listing");
  r = await run(decideAuthReview, {listingId: "listG7", decision: "approve"}); assert.equal(r.emailed, false); assert.equal((await get("listG7")).authReviewState, "approved"); ok("no seller email: decision still saved, reported");
  assert.equal((await db.collection("adminActions").get()).size, 4); ok("every decision logged");
  console.log(`PASS ${n}`); process.exit(0);
})().catch((err) => { console.error("FAIL", err); process.exit(1); });
