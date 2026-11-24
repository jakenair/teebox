"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {reasonOf, logRefusals} = require("../../lib/checkoutRefusal");
const H = require("../../lib/shipFromHold");

test("refusals get a specific reason", () => {
  for (const [b, r] of [[{error: "age-required"}, "age_18_not_confirmed"], [{code: "no_ship_from", error: "x"}, "no_ship_from"], [{error: "Not authenticated"}, "not_signed_in"], [{error: "Something new"}, "Something new"], [null, "http_500"]]) assert.equal(reasonOf(b, 500), r);
});

test("logs refusals only, passes the answer through, never an email", () => {
  const out = [];
  const mk = () => ({statusCode: 200, sent: null, status(c) { this.statusCode = c; return this; }, json(b) { this.sent = b; return this; }});
  const req = {body: {listingId: "L1", guest: true, email: "a@b.test"}, headers: {}};
  const logger = {warn: (m, o) => out.push([m, o])};
  let res = mk(); logRefusals(req, res, {uid: null, logger}); res.status(200).json({ok: 1});
  assert.equal(out.length, 0); assert.deepEqual(res.sent, {ok: 1});
  res = mk(); logRefusals(req, res, {uid: null, logger}); res.status(412).json({error: "age-required"});
  assert.equal(out.length, 1); assert.equal(out[0][1].reason, "age_18_not_confirmed"); assert.equal(out[0][1].buyer, "guest");
  assert.ok(!JSON.stringify(out).includes("a@b.test"));
  res = mk(); logRefusals(req, res, {uid: null, logger: {warn() { throw new Error("x"); }}}); res.status(400).json({error: "e"});
  assert.deepEqual(res.sent, {error: "e"});
});

test("ship-from hold: only clubs and bags, only without an address", async () => {
  const run = async (l, u) => { let up = null; const db = {runTransaction: (f) => f({get: async () => ({exists: true, data: () => l}), update: (_r, o) => { up = o; }})}; const r = await H.holdIfNeeded(db, {serverTimestamp: () => 1}, {}, u); return [r, up]; };
  const A = {shippingFrom: {line1: "1", city: "X", state: "IL", postal_code: "60647"}};
  assert.equal((await run({status: "active", cat: "clubs"}, {}))[1].hiddenReason, H.REASON);
  assert.equal((await run({status: "active", cat: "clubs"}, A))[0], false);
  assert.equal((await run({status: "active", cat: "apparel"}, {}))[0], false);
  assert.equal((await run({status: "hidden", cat: "clubs"}, {}))[0], false);
});
