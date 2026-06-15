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
