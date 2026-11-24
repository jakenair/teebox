// functions/test/unit/apiGuardrails.test.js — refusal summary, budget guard, API switch, quiet test uploads.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {RefusalStats, keyLabel} = require("../../lib/refusalStats");
const {decide} = require("../../lib/budgetGuardCore");
const SW = require("../../lib/apiSwitch");

test("refusals: one summary per minute, counted by status, key and address, no key material", () => {
  const r = new RefusalStats(); const T = 60000 * 1000;
  const key = "pk_test_" + "A".repeat(43);
  for (let i = 0; i < 5; i++) assert.equal(r.note({status: 401, partnerKey: key, ip: "1.2.3.4", nowMs: T + i}), null);
  r.note({status: 429, partnerKey: "", ip: "5.6.7.8", nowMs: T + 9});
  const s = r.note({status: 413, partnerKey: "junk", ip: "1.2.3.4", nowMs: T + 60000});
  assert.equal(s.total, 6); assert.deepEqual(s.byStatus, {401: 5, 429: 1});
  assert.equal(s.topKeys[0].n, 5); assert.match(s.topKeys[0].id, /^pk_test_#[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(s).includes("AAAA") && !JSON.stringify(s).includes("1.2.3.4"));
  assert.equal(r.note({status: 401, nowMs: T + 60001}), null);
  assert.equal(keyLabel("sk_conn_test_x"), "malformed");
});
test("refusals: bounded memory", () => {
  const r = new RefusalStats();
  for (let i = 0; i < 9000; i++) r.note({status: 401, partnerKey: "", ip: "ip" + i, nowMs: 1});
  assert.ok(r.ips.size <= 2000); assert.equal(r.total, 9000);
});
test("budget guard fires once per $100 step per month, only for its own budget, only in USD", () => {
  const o = (last) => ({attrs: {budgetId: "b"}, budgetId: "b", limit: 100, last});
  const m = (cost, x) => ({costAmount: cost, costIntervalStart: "2026-11-01T08:00:00Z", currencyCode: "USD", ...x});
  assert.equal(decide(m(99.99), o({})).fire, false);
  assert.equal(decide(m(100), o({})).fire, true);
  assert.equal(decide(m(150), o({month: "2026-11", step: 1})).fire, false);
  assert.equal(decide(m(205), o({month: "2026-11", step: 1})).fire, true);
  assert.equal(decide(m(120), o({month: "2026-10", step: 1})).fire, true);
  assert.equal(decide(m(500), {attrs: {budgetId: "other"}, budgetId: "b", limit: 100, last: {}}).fire, false);
  assert.equal(decide(m(500, {currencyCode: "EUR"}), o({})).fire, false);
  for (const bad of [{}, null, m("x"), m(500, {costIntervalStart: "soon"})]) assert.equal(decide(bad, o({})).fire, false);
});
test("switch: changes only sellerapi's ingress, confirms it took, asks again if lost, and fails loudly", async () => {
  const calls = []; let state = SW.ON; let lose = 1;
  const fake = async (u, i) => {
    calls.push([u, i]);
    if (i.method === "PATCH") { if (lose-- <= 0) state = JSON.parse(i.body).ingress; return {ok: true}; }
    return {ok: true, json: async () => ({ingress: state})};
  };
  assert.equal(await SW.setApiOpen(false, {token: "t", fetchFn: fake, waitMs: 0}), SW.OFF);
  const patches = calls.filter((c) => c[1].method === "PATCH");
  assert.equal(patches.length, 2, "the lost change was asked for again");
  assert.match(patches[0][0], /services\/sellerapi\?updateMask=ingress,template\.revision$/);
  assert.deepEqual(JSON.parse(patches[0][1].body), {ingress: SW.OFF, template: {revision: ""}});
  await assert.rejects(SW.setApiOpen(true, {token: "t", waitMs: 0, fetchFn: async () => ({ok: false, status: 403, text: async () => "no"})}), /403/);
  await assert.rejects(SW.setApiOpen(true, {token: "t", waitMs: 0, tries: 3, fetchFn: async (u, i) => ({ok: true, json: async () => ({ingress: SW.OFF})})}), /not INGRESS_TRAFFIC_ALL yet/);
});
test("test uploads alert nobody; real ones still do", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../index.js"), "utf8");
  const i = src.indexOf("exports.optimizeListingPhoto");
  const seg = src.slice(i, src.indexOf("createIdentitySession (callable)", i));
  assert.equal((seg.match(/opsAlert\(/g) || []).length, (seg.match(/isTestUpload\([^)]*\)\) await opsAlert\(/g) || []).length);
  const {isTestListingDoc} = require("../../lib/testAccounts");
  assert.equal(isTestListingDoc({sellerId: "qa_x"}, "L"), true);
  assert.equal(isTestListingDoc({sellerId: "realSeller1", isTest: true}, "L"), true);
  assert.equal(isTestListingDoc({sellerId: "realSeller1"}, "AbC123"), false);
});
