// Seller Integrations Phase 0: the server-side listing check must match the
// app's Sell form and firestore.rules. See functions/lib/listingSchema.js.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const S = require("../../lib/listingSchema");

const ROOT = path.join(__dirname, "..", "..", "..");
const FV = {serverTimestamp: () => ({__sentinel: "serverTimestamp"})};
const TS = {fromMillis: (ms) => ({toMillis: () => ms})};

const driver = (over) => ({
  title: "TaylorMade Qi10 Driver 10.5 Stiff", brand: "TaylorMade", category: "driver",
  condition: "like new", price: "289.99", quantity: "", description: "Great shape.",
  specs: {model: "Qi10", loft: "10.5", flex: "s", dexterity: "rh"}, photoCount: 3, ...over,
});

test("specs JSON matches the Sell form (gen-listing-specs --check)", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "gen-listing-specs.mjs"), "--check"], {stdio: "pipe"});
});

test("create whitelist matches firestore.rules isValidListingCreate exactly", () => {
  const rules = readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  const fn = rules.slice(rules.indexOf("function isValidListingCreate"));
  const m = fn.match(/d\.keys\(\)\.hasOnly\(\[([\s\S]*?)\]\)/);
  assert.ok(m, "hasOnly list not found in rules");
  const fromRules = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual([...S.CREATE_WHITELIST].sort(), fromRules);
  assert.match(rules, /function categoryFloor\(cat\) \{\s*return 5;/, "rules price floor changed: update PRICE_FLOOR");
});

test("a valid driver row normalises like the Sell form", () => {
  const r = S.validateListingInput(driver());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.condition, "Like New");
  assert.equal(r.value.cat, "clubs");
  assert.equal(r.value.specCategory, "driver");
  assert.deepEqual(r.value.specs, {model: "Qi10", loft: "10.5°", flex: "S", dexterity: "RH", brand: "TaylorMade"});
  assert.equal(r.value.ask, 289.99);
  assert.equal(r.value.quantity, 1);
});

test("required specs, floor, bad select values and condition are rejected with clear messages", () => {
  const r = S.validateListingInput(driver({price: "4", condition: "mint", specs: {model: "", loft: "99", flex: "S", dexterity: "RH"}}));
  assert.equal(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ["condition", "price", "spec:loft", "spec:model"]);
  assert.match(r.errors.find((e) => e.field === "price").message, /Minimum listing price is \$5/);
});

test("every listing needs 1 photo, at any price; max 10", () => {
  assert.equal(S.validateListingInput(driver({price: "300", photoCount: 1})).ok, true);
  assert.equal(S.validateListingInput(driver({price: "5000", photoCount: 1})).ok, true);
  assert.equal(S.validateListingInput(driver({photoCount: 0})).ok, false);
  assert.equal(S.validateListingInput(driver({photoCount: 11})).ok, false);
});

test("'other' needs a browse category; quantity 1-99 whole numbers; price format", () => {
  const other = {title: "Range finder", brand: "Bushnell", category: "other", condition: "Good", price: "120", photoCount: 2};
  assert.equal(S.validateListingInput(other).ok, false);
  assert.equal(S.validateListingInput({...other, cat: "accessories"}).ok, true);
  assert.equal(S.validateListingInput(driver({quantity: "100"})).ok, false);
  assert.equal(S.validateListingInput(driver({quantity: "2.5"})).ok, false);
  assert.equal(S.validateListingInput(driver({quantity: "12"})).value.quantity, 12);
  assert.equal(S.validateListingInput(driver({price: "$1,250.00", photoCount: 4})).value.ask, 1250);
  assert.equal(S.validateListingInput(driver({price: "12.345"})).ok, false);
});

test("built document passes the rules mirror and is field-for-field the Sell form's", () => {
  const v = S.validateListingInput(driver({price: "450", photoCount: 5})).value;
  const d = S.buildListingDoc(v, {uid: "u1", source: "csv", FieldValue: FV, Timestamp: TS, nowMs: 1e12});
  assert.deepEqual(S.rulesCreateCheck(d), []);
  assert.deepEqual(Object.keys(d).sort(), ["ask", "authReviewState", "badge", "brand", "cat", "condition", "createdAt",
    "desc", "expiresAt", "photos", "quantity", "quantitySold", "requiresAuth", "sellerId", "source", "specCategory",
    "specs", "status", "title"]);
  assert.equal(d.requiresAuth, true);
  assert.equal(d.authReviewState, "pending");
  assert.equal(d.status, "active");
  assert.deepEqual(d.photos, []);
  assert.equal(d.expiresAt.toMillis(), 1e12 + 182 * 864e5);
  assert.throws(() => S.buildListingDoc(v, {uid: "u1", source: "bingo", FieldValue: FV, Timestamp: TS}));
});

test("rules mirror rejects what the rules reject", () => {
  const v = S.validateListingInput(driver()).value;
  const base = S.buildListingDoc(v, {uid: "u1", source: "api", FieldValue: FV, Timestamp: TS});
  assert.deepEqual(S.rulesCreateCheck({...base, soldAt: 1}), ["not-allowed:soldAt"]);
  assert.deepEqual(S.rulesCreateCheck({...base, status: "pending"}), ["status"]);
  assert.deepEqual(S.rulesCreateCheck({...base, photos: ["https://evil.example/x.jpg"]}), ["photos"]);
  assert.deepEqual(S.rulesCreateCheck({...base, ask: 4.99}), ["ask"]);
  assert.deepEqual(S.rulesCreateCheck(base, {allowServerSource: false}), ["source"]);
});
