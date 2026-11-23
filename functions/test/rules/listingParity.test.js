// Seller Integrations Phase 0: lib/listingSchema.rulesCreateCheck must agree
// with firestore.rules isValidListingCreate on every fixture. If someone
// changes the create rule and not the server check (or the other way round),
// this fails. Needs the Firestore emulator (Java):
//   npm run test:rules
const {test, before, after} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {initializeTestEnvironment} = require("@firebase/rules-unit-testing");
const {doc, setDoc, serverTimestamp, Timestamp} = require("firebase/firestore");
const S = require("../../lib/listingSchema");

const RULES_PATH = path.join(__dirname, "..", "..", "..", "firestore.rules");
let env;
before(async () => {
  env = await initializeTestEnvironment({projectId: "demo-teebox-parity",
    firestore: {rules: readFileSync(RULES_PATH, "utf8")}});
});
after(async () => { if (env) await env.cleanup(); });

const BUCKET = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/listings%2Fu1%2FL%2F1.jpg?alt=media";
const valid = () => {
  const v = S.validateListingInput({title: "Titleist T100 Irons 4-PW", brand: "Titleist", category: "iron-set",
    condition: "Very Good", price: "650", specs: {model: "T100", setFrom: "4", setTo: "PW", flex: "S", dexterity: "RH"},
    photoCount: 4}).value;
  assert.ok(v, "fixture must validate");
  const d = S.buildListingDoc(v, {uid: "u1", source: "csv",
    FieldValue: {serverTimestamp}, Timestamp, nowMs: Date.now()});
  delete d.source; // the app path never sends csv/api; parity is checked on the shared shape
  return d;
};

const FIXTURES = [
  ["valid server-built doc", (d) => d],
  ["valid with bucket photo", (d) => ({...d, photos: [BUCKET]})],
  ["valid with bingo source", (d) => ({...d, source: "bingo"})],
  ["source csv (server-only value)", (d) => ({...d, source: "csv"})],
  ["extra field soldAt", (d) => ({...d, soldAt: Timestamp.now()})],
  ["extra field watchlistCount", (d) => ({...d, watchlistCount: 5})],
  ["status pending", (d) => ({...d, status: "pending"})],
  ["price below floor", (d) => ({...d, ask: 4.99})],
  ["price at floor", (d) => ({...d, ask: 5})],
  ["price too high", (d) => ({...d, ask: 1000000})],
  ["title empty", (d) => ({...d, title: ""})],
  ["title 121 chars", (d) => ({...d, title: "x".repeat(121)})],
  ["brand 61 chars", (d) => ({...d, brand: "b".repeat(61)})],
  ["cat 41 chars", (d) => ({...d, cat: "c".repeat(41)})],
  ["condition 41 chars", (d) => ({...d, condition: "c".repeat(41)})],
  ["desc 4001 chars", (d) => ({...d, desc: "d".repeat(4001)})],
  ["foreign photo URL", (d) => ({...d, photos: ["https://evil.example/x.jpg"]})],
  ["11 photos", (d) => ({...d, photos: Array(11).fill(BUCKET)})],
  ["quantity 0", (d) => ({...d, quantity: 0})],
  ["quantity 100", (d) => ({...d, quantity: 100})],
  ["quantity 1.5", (d) => ({...d, quantity: 1.5})],
  ["quantitySold 1", (d) => ({...d, quantitySold: 1})],
  ["authReviewState approved", (d) => ({...d, authReviewState: "approved"})],
  ["requiresAuth string", (d) => ({...d, requiresAuth: "yes"})],
  ["specCategory 21 chars", (d) => ({...d, specCategory: "s".repeat(21)})],
  ["31 specs", (d) => ({...d, specs: Object.fromEntries(Array.from({length: 31}, (_, i) => ["k" + i, "v"]))})],
  ["missing expiresAt", (d) => { const x = {...d}; delete x.expiresAt; return x; }],
  ["volume 3", (d) => ({...d, volume: 3})],
];

for (const [name, mutate] of FIXTURES) {
  test(`parity: ${name}`, async () => {
    const d = mutate(valid());
    const serverOk = S.rulesCreateCheck(d, {allowServerSource: false}).length === 0;
    const ctx = env.authenticatedContext("u1", {email_verified: true});
    let rulesOk = true;
    try { await setDoc(doc(ctx.firestore(), "listings", "L" + Math.random().toString(36).slice(2)), d); } catch (_e) { rulesOk = false; }
    assert.equal(serverOk, rulesOk, `server check says ${serverOk ? "allow" : "deny"} (${S.rulesCreateCheck(d, {allowServerSource: false}).join(",")}), rules say ${rulesOk ? "allow" : "deny"}`);
  });
}
