// functions/test/unit/adminGate.test.js — admin = the custom claim, nothing else.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {adminGate, isAdminAuth} = require("../../lib/adminGate");
const ROOT = path.join(__dirname, "../../..");

test("only admin === true passes; an email never does", () => {
  assert.doesNotThrow(() => adminGate({auth: {uid: "a", token: {admin: true}}}));
  assert.throws(() => adminGate({}), (e) => e.code === "unauthenticated");
  for (const token of [{}, {admin: "true"}, {admin: 1}, {admin: false}, {email: "owner@example.test", email_verified: true}]) {
    assert.throws(() => adminGate({auth: {uid: "a", token}}), (e) => e.code === "permission-denied", JSON.stringify(token));
    assert.equal(isAdminAuth({token}), false);
  }
});

test("no email-based admin check is left in functions, rules or the site", () => {
  const files = ["firestore.rules", "storage.rules", "index.html", "admin/review/index.html"];
  for (const d of ["js", "functions", "functions/lib"]) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith(".js")) files.push(path.join(d, f));
  }
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(s, /ADMIN_ALLOWLIST|isAdminEmail|MODERATION_ADMIN_EMAILS|token\.email in \[/, f);
  }
});
