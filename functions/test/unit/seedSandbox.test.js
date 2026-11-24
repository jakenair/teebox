// The sandbox seed: valid listings in every category, sandbox_* only.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {refuse, buildListings, SELLERS} = require("../../scripts/seed-sandbox.cjs");
const schema = require("../../lib/listingSchema");

test("refuses a missing project and mixed emulator settings", () => {
  for (const p of ["", undefined, "../x"]) assert.ok(refuse(p, {}), String(p));
  assert.ok(refuse("demo-teebox", {}));
  assert.ok(refuse("teebox-market", {FIRESTORE_EMULATOR_HOST: "x"}));
  assert.equal(refuse("demo-teebox", {FIRESTORE_EMULATOR_HOST: "x"}), null);
});

test("only the guarded handle, and no Auth, Storage or other service", () => {
  const src = readFileSync(path.join(__dirname, "../../scripts/seed-sandbox.cjs"), "utf8");
  assert.equal(src.split("admin.firestore()").length - 1, 1);
  assert.match(src, /const db = sandboxDb\(admin\.firestore\(\)\);/);
  assert.doesNotMatch(src, /admin\.(auth|storage|messaging)\(/);
});

test("seeds every category with valid listings", () => {
  const Timestamp = {fromMillis: (m) => ({toMillis: () => m})};
  const ls = buildListings({FieldValue: {serverTimestamp: () => "ts"}, Timestamp, nowMs: 1e12});
  assert.deepEqual([...new Set(ls.map((l) => l.doc.specCategory))].sort(), Object.keys(schema.SPECS.categories).sort());
  for (const st of ["active", "sold", "expired", "hidden"]) assert.ok(ls.some((l) => l.doc.status === st), st);
  for (const l of ls) {
    assert.match(l.id, /^[A-Za-z0-9]+$/);
    assert.equal(l.doc.sandboxSeed, true);
    assert.ok(SELLERS.some((s) => s.id === l.doc.sellerId));
    if (l.doc.ask >= 300) assert.deepEqual([l.doc.photos.length >= 4, l.doc.authReviewState], [true, "pending"]);
  }
  assert.equal(new Set(ls.map((l) => l.id)).size, ls.length);
});
