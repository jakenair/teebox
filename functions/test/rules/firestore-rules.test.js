// functions/test/rules/firestore-rules.test.js
//
// Firestore security-rules tests. These require the Firestore EMULATOR (Java),
// so they do NOT run in the default `npm test`. Run them with:
//   npm run test:rules          (from functions/, needs Java)
// or in CI via .github/workflows/rules-tests.yml (Java is free there).
//
// What they lock — the exact invariants the guest-browse diagnosis relied on:
//   • listings are world-READABLE (anon guests must see the marketplace)…
//   • …but NOT world-writable (anon cannot create/modify listings)
//   • users / orders / conversations are private to their owner/participants
//     (anon and unrelated signed-in users are denied)

const {test, before, after, beforeEach} = require("node:test");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {doc, getDoc, setDoc} = require("firebase/firestore");

// Resolve the rules file relative to THIS file, so cwd doesn't matter.
const RULES_PATH = path.join(__dirname, "..", "..", "..", "firestore.rules");

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-teebox", // demo- prefix => emulator runs with no creds
    firestore: {rules: readFileSync(RULES_PATH, "utf8")},
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// Seed a doc bypassing rules (admin-equivalent context).
async function seed(collPath, id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), collPath, id), data);
  });
}

const db = (ctx) => ctx.firestore();

test("listings: anonymous guest CAN read (guest-browse guarantee)", async () => {
  await seed("listings", "L1", {title: "Scotty Cameron", status: "active"});
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(anon), "listings", "L1")));
});

test("listings: anonymous guest CANNOT write (not world-writable)", async () => {
  const anon = testEnv.unauthenticatedContext();
  await assertFails(
      setDoc(doc(db(anon), "listings", "L2"), {title: "hacked"}));
});

test("users/{uid}: only the owner can read; others + anon denied", async () => {
  await seed("users", "alice", {tier: "free", email: "a@x.com"});
  const alice = testEnv.authenticatedContext("alice");
  const bob = testEnv.authenticatedContext("bob");
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(alice), "users", "alice")));
  await assertFails(getDoc(doc(db(bob), "users", "alice")));
  await assertFails(getDoc(doc(db(anon), "users", "alice")));
});

test("orders/{id}: buyer and seller can read; unrelated user + anon denied", async () => {
  await seed("orders", "O1", {buyerId: "alice", sellerId: "carol", amount: 100});
  const alice = testEnv.authenticatedContext("alice"); // buyer
  const carol = testEnv.authenticatedContext("carol"); // seller
  const mallory = testEnv.authenticatedContext("mallory"); // unrelated
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(alice), "orders", "O1")));
  await assertSucceeds(getDoc(doc(db(carol), "orders", "O1")));
  await assertFails(getDoc(doc(db(mallory), "orders", "O1")));
  await assertFails(getDoc(doc(db(anon), "orders", "O1")));
});

test("conversations/{id}: only participants can read; non-participant + anon denied", async () => {
  await seed("conversations", "C1", {participants: ["alice", "carol"]});
  const alice = testEnv.authenticatedContext("alice");
  const mallory = testEnv.authenticatedContext("mallory");
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(alice), "conversations", "C1")));
  await assertFails(getDoc(doc(db(mallory), "conversations", "C1")));
  await assertFails(getDoc(doc(db(anon), "conversations", "C1")));
});

// ─────────────────────────────────────────────────────────────
// Audit 2026-09-17 — Course Passport + messaging hardening invariants.
// ─────────────────────────────────────────────────────────────
const {serverTimestamp, updateDoc, addDoc, collection} = require("firebase/firestore");
const STORAGE_URL = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/passport%2Fu1%2Fpine-valley%2F1.jpg?alt=media";

test("passport: owner can create a round with server createdAt; others cannot", async () => {
  const me = testEnv.authenticatedContext("u1");
  const other = testEnv.authenticatedContext("u2");
  const round = {courseId: "pine-valley", grade: "A+", photos: [STORAGE_URL], hasPhotos: true, createdAt: serverTimestamp()};
  await assertSucceeds(setDoc(doc(db(me), "passport/u1/played", "pine-valley"), round));
  await assertFails(setDoc(doc(db(other), "passport/u1/played", "pine-valley"), round));
});

test("passport: createdAt must be server time on create and immutable on update (no feed pinning)", async () => {
  const me = testEnv.authenticatedContext("u1");
  const future = new Date("2100-01-01");
  await assertFails(setDoc(doc(db(me), "passport/u1/played", "pine-valley"),
    {courseId: "pine-valley", grade: "A", createdAt: future}));
  await seed("passport/u1/played", "pine-valley", {courseId: "pine-valley", grade: "A", createdAt: new Date("2026-09-01")});
  await assertFails(updateDoc(doc(db(me), "passport/u1/played", "pine-valley"), {createdAt: future}));
  await assertSucceeds(updateDoc(doc(db(me), "passport/u1/played", "pine-valley"), {review: "great"}));
});

test("passport: photos must be our Storage bucket; courseId must be slug-shaped", async () => {
  const me = testEnv.authenticatedContext("u1");
  await assertFails(setDoc(doc(db(me), "passport/u1/played", "pine-valley"),
    {courseId: "pine-valley", grade: "A", photos: ["https://evil.example/x.jpg"], createdAt: serverTimestamp()}));
  await assertFails(setDoc(doc(db(me), "passport/u1/played", "Not A Slug!"),
    {courseId: "Not A Slug!", grade: "A", createdAt: serverTimestamp()}));
});

test("passport: likes/comments require an existing parent round; comment createdAt is server time", async () => {
  const fan = testEnv.authenticatedContext("u2");
  // no parent round yet → both denied
  await assertFails(setDoc(doc(db(fan), "passport/u1/played/pine-valley/likes", "u2"), {createdAt: serverTimestamp()}));
  await assertFails(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u2", text: "nice", createdAt: serverTimestamp()}));
  await seed("passport/u1/played", "pine-valley", {courseId: "pine-valley", grade: "A", createdAt: new Date()});
  await assertSucceeds(setDoc(doc(db(fan), "passport/u1/played/pine-valley/likes", "u2"), {createdAt: serverTimestamp()}));
  await assertSucceeds(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u2", text: "nice", createdAt: serverTimestamp()}));
  // client-supplied createdAt or spoofed author → denied
  await assertFails(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u2", text: "nice", createdAt: new Date("2100-01-01")}));
  await assertFails(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u1", text: "as someone else", createdAt: serverTimestamp()}));
});

test("conversations: create rejects a seeded lastMessageText preview (moderation bypass)", async () => {
  await seed("listings", "L1", {sellerId: "seller", title: "Putter"});
  const buyer = testEnv.authenticatedContext("buyer");
  const base = {participants: ["buyer", "seller"], listingId: "L1", buyerId: "buyer", sellerId: "seller", createdAt: serverTimestamp(), lastMessageAt: serverTimestamp()};
  await assertSucceeds(addDoc(collection(db(buyer), "conversations"), base));
  await assertFails(addDoc(collection(db(buyer), "conversations"), {...base, lastMessageText: "Payment failed — confirm at evil.shop"}));
  await assertFails(addDoc(collection(db(buyer), "conversations"), {...base, lastRead: {seller: serverTimestamp()}}));
});

test("conversations: create denied when the other participant has blocked the creator", async () => {
  await seed("listings", "L1", {sellerId: "seller", title: "Putter"});
  await seed("users", "seller", {blocked: {buyer: {blockedAt: new Date()}}});
  const buyer = testEnv.authenticatedContext("buyer");
  await assertFails(addDoc(collection(db(buyer), "conversations"),
    {participants: ["buyer", "seller"], listingId: "L1", buyerId: "buyer", sellerId: "seller", createdAt: serverTimestamp()}));
});

test("conversations: update allows only own lastRead/hidden keys; lastMessage* is callable-only", async () => {
  await seed("conversations", "C1", {participants: ["buyer", "seller"], listingId: "L1", buyerId: "buyer", sellerId: "seller", lastRead: {}, hidden: {}});
  const buyer = testEnv.authenticatedContext("buyer");
  await assertSucceeds(updateDoc(doc(db(buyer), "conversations", "C1"), {"lastRead.buyer": serverTimestamp()}));
  await assertSucceeds(updateDoc(doc(db(buyer), "conversations", "C1"), {"hidden.buyer": serverTimestamp()}));
  await assertFails(updateDoc(doc(db(buyer), "conversations", "C1"), {"lastRead.seller": serverTimestamp()}));
  await assertFails(updateDoc(doc(db(buyer), "conversations", "C1"), {lastMessageText: "spoofed preview"}));
  await assertFails(updateDoc(doc(db(buyer), "conversations", "C1"), {lastMessageSenderId: "buyer", lastMessageAt: serverTimestamp()}));
});
