#!/usr/bin/env node
"use strict";
// Fill the Seller API SANDBOX with fake sellers and listings, at least one
// listing in every category. Writes only sandbox_* collections, through
// lib/sandboxDb.js, so it can't reach real data in any project. No Auth users,
// no Storage files, no triggers.
//
//   node scripts/seed-sandbox.cjs --project <id>            fill or reset
//   node scripts/seed-sandbox.cjs --project <id> --clear    remove only what this script made
//
// Safe to re-run: fixed ids. Listings are validated and built by listingSchema,
// the same code the API uses. Set FIRESTORE_EMULATOR_HOST for the emulator
// (required for demo-* projects).

const {sandboxDb} = require("../lib/sandboxDb");

/** Pure: may the seed run? @return {string|null} why not, or null */
function refuse(project, env) {
  if (!project || !/^[a-z][a-z0-9-]{4,40}$/.test(project)) return "--project <id> is required";
  if (project.startsWith("demo-") && !env.FIRESTORE_EMULATOR_HOST) return "refusing: demo projects only run on the emulator";
  if (!project.startsWith("demo-") && env.FIRESTORE_EMULATOR_HOST) return "refusing: FIRESTORE_EMULATOR_HOST is set for a real project";
  return null;
}

// A public image that always loads; the sandbox stores URLs, never files.
const PHOTO = (n) => `https://teeboxmarket.com/icon-512.png?sandbox=${n}`;

const SELLERS = [
  {id: "sbseller-ready", name: "Fairway Finds", ready: true},
  {id: "sbseller-shop", name: "Back Nine Golf Shop", ready: true, approved: true},
  {id: "sbseller-nopayouts", name: "New Seller", ready: false},
];

// category, title, brand, condition, price, specs, {quantity, status, seller, cat}
const ITEMS = [
  ["driver", "TaylorMade Qi10 Driver 10.5 Stiff", "TaylorMade", "Very Good", 279.99, {model: "Qi10", shaftBrand: "Fujikura", shaftModel: "Ventus Blue 60"}],
  ["driver", "Callaway Paradym Ai Smoke Max", "Callaway", "Like New", 329, {model: "Paradym Ai Smoke Max"}],
  ["fairway", "Titleist TSR2 3 Wood", "Titleist", "Good", 159.5, {model: "TSR2"}],
  ["hybrid", "Ping G430 Hybrid", "Ping", "Very Good", 139, {model: "G430"}, {status: "sold"}],
  ["iron-set", "Mizuno Pro 245 Iron Set", "Mizuno", "Like New", 749, {model: "Pro 245"}],
  ["single-iron", "Srixon ZX5 Mk II Single Iron", "Srixon", "Good", 69, {model: "ZX5 Mk II"}],
  ["wedge", "Titleist Vokey SM9 Wedge", "Titleist", "Good", 89, {model: "Vokey SM9"}, {quantity: 3, sold: 1}],
  ["wedge", "Cleveland RTX 6 Zipcore Wedge", "Cleveland", "Fair", 45, {model: "RTX 6 Zipcore"}, {status: "expired"}],
  ["putter", "Odyssey Ai-One Seven Putter", "Odyssey", "Very Good", 189, {model: "Ai-One Seven"}],
  ["shaft", "Project X HZRDUS Smoke Shaft", "Project X", "Like New", 119, {model: "HZRDUS Smoke", weight: "60g"}],
  ["balls", "Titleist Pro V1 Practice Balls", "Titleist", "New with Tags", 42, {model: "Pro V1"}, {quantity: 12}],
  ["bag", "Sun Mountain 4.5LS Stand Bag", "Sun Mountain", "Very Good", 145, {model: "4.5LS"}],
  ["apparel", "Peter Millar Performance Polo", "Peter Millar", "New with Tags", 48, {}, {quantity: 4}],
  ["shoes", "FootJoy Premiere Series Golf Shoes", "FootJoy", "Like New", 85, {model: "Premiere Series"}],
  ["headcover", "Blue Tartan Driver Headcover", "Unbranded", "New with Tags", 28, {}, {quantity: 6}],
  ["accessories", "Bushnell Tour V5 Rangefinder", "Bushnell", "Good", 169, {itemType: "Rangefinder"}],
  ["other", "Vintage Course Scorecard Set", "Unbranded", "Good", 20, {}, {cat: "accessories"}],
  ["putter", "Scotty Cameron Special Select Newport", "Scotty Cameron", "Very Good", 259, {model: "Special Select Newport"}, {seller: "sbseller-nopayouts"}],
];

/** Pure: the listing documents, validated by the same code the API uses. */
function buildListings({FieldValue, Timestamp, nowMs}) {
  const schema = require("../lib/listingSchema");
  return ITEMS.map(([category, title, brand, condition, price, specs, o = {}], i) => {
    const id = `sandbox${String(i + 1).padStart(3, "0")}`;
    const seller = SELLERS.find((s) => s.id === (o.seller || (i % 2 ? "sbseller-shop" : "sbseller-ready")));
    const filled = {...specs};
    for (const f of schema.SPECS.categories[category].fields) {
      if (f.req && filled[f.k] === undefined) {
        const opts = f.options || [];
        filled[f.k] = opts[Math.min(1, opts.length - 1)];
      }
    }
    const photoCount = price >= schema.HIGH_VALUE ? 4 : 2;
    const v = schema.validateListingInput({title, brand, category, cat: o.cat, condition, price, quantity: o.quantity || 1,
      description: "Sandbox listing. Not a real item.", specs: filled, photoCount});
    if (!v.ok) throw new Error(`${id} ${title}: ${JSON.stringify(v.errors)}`);
    const doc = schema.buildListingDoc(v.value, {uid: seller.id, source: "api", FieldValue, Timestamp, nowMs, paymentReady: seller.ready});
    const failed = schema.rulesCreateCheck(doc);
    if (failed.length) throw new Error(`${id}: ${failed.join(", ")}`);
    const at = Timestamp.fromMillis(nowMs - (ITEMS.length - i) * 3600e3);
    Object.assign(doc, {createdAt: at, updatedAt: at, sandboxSeed: true,
      photos: Array.from({length: photoCount}, (_, n) => PHOTO(`${id}-${n}`))});
    if (o.sold) doc.quantitySold = o.sold;
    if (o.status) doc.status = o.status;
    if (o.status === "sold") { doc.soldAt = at; doc.quantitySold = doc.quantity; }
    return {id, doc};
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf("--project");
  const project = pi >= 0 ? argv[pi + 1] : "";
  const why = refuse(project, process.env);
  if (why) { console.error(why); process.exit(2); }
  const admin = require("firebase-admin");
  admin.initializeApp({projectId: project});
  const db = sandboxDb(admin.firestore());
  const {FieldValue, Timestamp} = admin.firestore;

  if (argv.includes("--clear")) {
    const mine = await db.collection("listings").where("sandboxSeed", "==", true).get();
    const b = db.batch();
    mine.docs.forEach((d) => b.delete(d.ref));
    for (const s of SELLERS) {
      b.delete(db.doc(`users/${s.id}/rateLimits/bulkListingCreate`));
      b.delete(db.doc(`users/${s.id}/rateLimits/apiPhotoDownloads`));
      b.delete(db.doc(`users/${s.id}`));
    }
    await b.commit();
    console.log(`cleared ${mine.size} sandbox listings, ${SELLERS.length} sandbox sellers`);
    return;
  }
  const listings = buildListings({FieldValue, Timestamp, nowMs: Date.now()});
  const b = db.batch();
  for (const s of SELLERS) {
    b.set(db.doc(`users/${s.id}`), {displayName: s.name, sandboxSeed: true, emailVerified: true,
      sellerVerified: true, sellerAge18At: FieldValue.serverTimestamp(),
      sellerTermsVersion: require("../lib/sellerConsent").SELLER_TERMS_VERSION,
      stripeChargesEnabled: s.ready, ...(s.approved ? {integrationsApproved: true} : {})});
  }
  for (const l of listings) b.set(db.doc(`listings/${l.id}`), l.doc);
  await b.commit();
  const byCat = {};
  for (const l of listings) byCat[l.doc.specCategory] = (byCat[l.doc.specCategory] || 0) + 1;
  console.log(`seeded ${project}: ${SELLERS.length} sellers, ${listings.length} listings`, JSON.stringify(byCat));
}

module.exports = {refuse, buildListings, SELLERS, ITEMS};
if (require.main === module) main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
