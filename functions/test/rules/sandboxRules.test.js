// Nobody can reach sandbox_* (or the API's own) collections from a client.
const {test, before, after} = require("node:test");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {initializeTestEnvironment, assertFails} = require("@firebase/rules-unit-testing");
const {doc, getDoc, setDoc, deleteDoc, collection, getDocs, collectionGroup} = require("firebase/firestore");
const {COLLECTIONS} = require("../../lib/sandboxDb");

let env;
before(async () => {
  env = await initializeTestEnvironment({projectId: "demo-teebox-sandbox-rules",
    firestore: {rules: readFileSync(path.join(__dirname, "..", "..", "..", "firestore.rules"), "utf8")}});
  await env.withSecurityRulesDisabled(async (c) => {
    for (const n of COLLECTIONS) await setDoc(doc(c.firestore(), `sandbox_${n}/x`), {sellerId: "u1", uid: "u1", status: "active"});
    await setDoc(doc(c.firestore(), "sandbox_users/u1/rateLimits/bulkListingCreate"), {count: 1});
  });
});
after(async () => { if (env) await env.cleanup(); });

const WHO = [["signed out", () => env.unauthenticatedContext()],
  ["seller", () => env.authenticatedContext("u1", {email: "u1@example.test", email_verified: true})],
  ["admin claim", () => env.authenticatedContext("adm", {email: "adm@example.test", email_verified: true, admin: true})]];

for (const n of COLLECTIONS.map((c) => "sandbox_" + c)) {
  test(`${n}: no client read, list, write or delete`, async () => {
    for (const [, ctx] of WHO) {
      const db = ctx().firestore();
      await assertFails(getDoc(doc(db, `${n}/x`)));
      await assertFails(getDocs(collection(db, n)));
      await assertFails(setDoc(doc(db, `${n}/y`), {a: 1}));
      await assertFails(deleteDoc(doc(db, `${n}/x`)));
    }
  });
}
test("sandbox_users subcollections are closed too", async () => {
  const db = env.authenticatedContext("u1", {email_verified: true}).firestore();
  await assertFails(getDoc(doc(db, "sandbox_users/u1/rateLimits/bulkListingCreate")));
  await assertFails(getDocs(collectionGroup(db, "rateLimits")));
});
