#!/usr/bin/env node
// Read-only prod counts: accounts, sellers (Stripe Connect), listings, orders,
// Logo Bingo. Test data is ALWAYS excluded (founder rule 2026-11-03):
//   - users/{uid}.isTestAccount, listings.isTest
//   - emails on the smoke/QA domains (@teeboxtest.invalid, @teeboxqa.dev)
//   - TeeBox's own Connect accounts (the two LLC accounts + rehearsal seller)
//
//   NODE_PATH=functions/node_modules STRIPE_KEY=$(gcloud secrets versions access \
//     latest --secret=STRIPE_SECRET_KEY --project=teebox-market) node scripts/metrics.mjs
//
// Makes GET requests only. Stripe is skipped when STRIPE_KEY is unset.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "teebox-market" });
const db = admin.firestore();

const TEST_EMAIL = /@(teeboxtest\.invalid|teeboxqa\.dev)$/i;
const OWN_CONNECT = new Set([
  "acct_1Tq1HePBddCQpkdY", // TEEBOX MARKET LLC ("Olympia Fields CC")
  "acct_1TYBmuAlNzaweGMC", // TEEBOX MARKET LLC ("TeeBox Seller Account")
  "acct_1TzNS2AYplGZAEfA", // rehearsal seller
]);
const DAY = 864e5, now = Date.now();
const ts = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
const within = (d, days) => !!d && now - d.getTime() <= days * DAY;

// Auth is the source of truth for who exists; the test set is built from it.
const testUids = new Set();
const auth = { total: 0, d7: 0, d30: 0, active7: 0 };
let tok;
do {
  const r = await admin.auth().listUsers(1000, tok);
  for (const u of r.users) {
    if (TEST_EMAIL.test(u.email || "")) { testUids.add(u.uid); continue; }
    auth.total++;
    const c = new Date(u.metadata.creationTime);
    if (within(c, 7)) auth.d7++;
    if (within(c, 30)) auth.d30++;
    if (within(u.metadata.lastRefreshTime && new Date(u.metadata.lastRefreshTime), 7)) auth.active7++;
  }
  tok = r.pageToken;
} while (tok);
(await db.collection("users").where("isTestAccount", "==", true).select().get())
  .forEach((d) => testUids.add(d.id));

const L = await db.collection("listings").select("status", "createdAt", "sellerId", "isTest", "source").get();
const listings = { total: 0, byStatus: {}, d7: 0, d30: 0, fromBingo: 0, sellers: new Set() };
L.forEach((d) => {
  const x = d.data();
  if (x.isTest || testUids.has(x.sellerId)) return;
  listings.total++;
  listings.byStatus[x.status || "none"] = (listings.byStatus[x.status || "none"] || 0) + 1;
  if (within(ts(x.createdAt), 7)) listings.d7++;
  if (within(ts(x.createdAt), 30)) listings.d30++;
  if (x.source === "bingo") listings.fromBingo++;
  listings.sellers.add(x.sellerId);
});

const O = await db.collection("orders").select("status", "createdAt", "buyerId", "sellerId").get();
const orders = { total: 0, byStatus: {}, d30: 0 };
O.forEach((d) => {
  const x = d.data();
  if (testUids.has(x.buyerId) || testUids.has(x.sellerId)) return;
  orders.total++;
  orders.byStatus[x.status || "none"] = (orders.byStatus[x.status || "none"] || 0) + 1;
  if (within(ts(x.createdAt), 30)) orders.d30++;
});

const games = await db.collectionGroup("bingoGames").select().get();
const byDate = {}, players = new Set();
games.forEach((d) => {
  const uid = d.ref.parent.parent.id;
  if (testUids.has(uid)) return;
  players.add(uid);
  byDate[d.id] = (byDate[d.id] || 0) + 1;
});
const last14 = Object.keys(byDate).sort().slice(-14).map((k) => `${k.slice(5)}:${byDate[k]}`);

let sellers = null;
if (process.env.STRIPE_KEY) {
  const r = await fetch("https://api.stripe.com/v1/accounts?limit=100", {
    headers: { Authorization: `Bearer ${process.env.STRIPE_KEY}` },
  });
  const all = ((await r.json()).data || [])
    .filter((a) => !OWN_CONNECT.has(a.id) && !TEST_EMAIL.test(a.email || "") &&
      !testUids.has((a.metadata || {}).firebaseUid));
  const ready = all.filter((a) => a.charges_enabled && a.payouts_enabled);
  const people = (xs) => new Set(xs.map((a) => a.email || a.id)).size;
  const started30 = all.filter((a) => now - a.created * 1000 <= 30 * DAY);
  sellers = {
    accounts: all.length, people: people(all), readyPeople: people(ready),
    started30d: people(started30), finished30d: people(started30.filter((a) => ready.includes(a))),
  };
}

console.log(JSON.stringify({
  excludedTestUids: testUids.size,
  accounts: auth,
  sellers,
  listings: { ...listings, sellers: listings.sellers.size },
  orders,
  bingo: { signedInGames: games.size, players: players.size, last14 },
}, null, 2));
