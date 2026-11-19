// functions/test/unit/guestCheckout.test.js — r421 guest checkout helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../../lib/guestCheckout");
const {resolveUserEmail} = require("../../lib/emailRecipient");

test("normalizeEmail accepts real addresses, rejects junk", () => {
  assert.equal(G.normalizeEmail("  Jo.Smith+golf@Gmail.com "), "jo.smith+golf@gmail.com");
  for (const bad of ["", "a@b", "no-at.com", "x@y.c", "a b@c.com", null, 7, "<a>@b.com"]) assert.equal(G.normalizeEmail(bad), null, String(bad));
});
test("self-purchase identity: +tags and gmail dots match, other domains don't merge dots", () => {
  assert.ok(G.sameIdentity("seller@gmail.com", "Sel.ler+buy@googlemail.com"));
  assert.ok(G.sameIdentity("a.b@yahoo.com", "a.b+x@yahoo.com"));
  assert.ok(!G.sameIdentity("a.b@yahoo.com", "ab@yahoo.com"));
  assert.ok(!G.sameIdentity("a@x.com", "b@x.com"));
  assert.ok(!G.sameIdentity("bad", "bad"));
});
test("guestBuyerId is stable, case-insensitive, and recognisable", () => {
  const a = G.guestBuyerId("Buyer@Example.com");
  assert.equal(a, G.guestBuyerId("buyer@example.com"));
  assert.ok(G.isGuestBuyerId(a));
  assert.ok(!G.isGuestBuyerId("guest_abc"));
  assert.ok(!G.isGuestBuyerId("rz4NKLuid"));
  assert.notEqual(a, G.guestBuyerId("other@example.com"));
});
test("claim tokens: hash ids, decision rules", () => {
  const t = G.newClaimToken();
  assert.equal(G.claimDocId(t.raw), t.id);
  assert.equal(G.claimDocId("short"), null);
  assert.equal(G.claimDocId("../../etc/passwd/........................"), null);
  const now = Date.now();
  const ok = {email: "a@b.com", guestBuyerId: G.guestBuyerId("a@b.com"), expiresAtMs: now + 1000};
  assert.deepEqual(G.claimDecision(ok, now), {ok: true});
  assert.equal(G.claimDecision(null, now).code, "not-found");
  assert.equal(G.claimDecision({...ok, usedAt: 1}, now).code, "used");
  assert.equal(G.claimDecision({...ok, expiresAtMs: now - 1}, now).code, "expired");
  assert.equal(G.claimDecision({...ok, guestBuyerId: "uid123"}, now).code, "invalid");
});
test("resolveUserEmail guest fallback uses the order email, never Auth", async () => {
  const gid = G.guestBuyerId("g@example.com");
  let authCalled = false;
  const r = await resolveUserEmail(gid, "g@example.com", async () => { authCalled = true; return {email: "x@y.com"}; });
  assert.deepEqual(r, {email: "g@example.com", source: "guest"});
  assert.equal(authCalled, false);
  assert.equal((await resolveUserEmail(gid, null, async () => ({}))).email, null);
  // signed-in buyers unchanged
  assert.equal((await resolveUserEmail("realUid", null, async () => ({email: "r@x.com"}))).source, "auth");
});
test("guestRateLimit: allows max then blocks with retry-after; fails open on error", async () => {
  const store = {};
  const db = {collection: () => ({doc: (id) => ({id})}),
    runTransaction: async (fn) => fn({get: async (ref) => ({exists: !!store[ref.id], data: () => store[ref.id]}),
      set: (ref, v) => { store[ref.id] = v; }})};
  const FV = {serverTimestamp: () => 0};
  const rule = {max: 2, windowMs: 60000};
  const t0 = 1e12;
  assert.equal((await G.guestRateLimit(db, FV, "ip:1", rule, t0)).ok, true);
  assert.equal((await G.guestRateLimit(db, FV, "ip:1", rule, t0 + 1)).ok, true);
  const third = await G.guestRateLimit(db, FV, "ip:1", rule, t0 + 2);
  assert.equal(third.ok, false); assert.ok(third.retryAfterSec >= 59);
  assert.equal((await G.guestRateLimit(db, FV, "ip:2", rule, t0 + 2)).ok, true, "separate key");
  assert.equal((await G.guestRateLimit(db, FV, "ip:1", rule, t0 + 60001)).ok, true, "window slid");
  const broken = {collection: db.collection, runTransaction: async () => { throw new Error("blip"); }};
  assert.equal((await G.guestRateLimit(broken, FV, "ip:1", rule)).ok, true);
});
