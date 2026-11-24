// Seller Integrations Phase 0: photo-URL fetching must never reach internal
// addresses (SSRF). See functions/lib/photoFetch.js.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../lib/photoFetch");

test("private, loopback, link-local, metadata, CGNAT and reserved IPs are not public", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1",
    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "2001:db8::1", "64:ff9b::a00:1", "2002:a00:1::1"]) {
    assert.equal(P.isPublicIp(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "142.250.72.14", "172.32.0.1", "2607:f8b0:4009:80b::200e", "::ffff:8.8.8.8"]) {
    assert.equal(P.isPublicIp(ip), true, ip);
  }
});

test("URL pre-checks: https only, no credentials, no odd ports, no internal names", () => {
  assert.equal(P.checkUrl("http://example.com/a.jpg").ok, false);
  assert.equal(P.checkUrl("ftp://example.com/a.jpg").ok, false);
  assert.equal(P.checkUrl("https://user:pw@example.com/a.jpg").ok, false);
  assert.equal(P.checkUrl("https://example.com:8443/a.jpg").ok, false);
  assert.equal(P.checkUrl("https://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(P.checkUrl("https://[::1]/a.jpg").ok, false);
  assert.equal(P.checkUrl("https://localhost/a.jpg").ok, false);
  assert.equal(P.checkUrl("https://metadata.google.internal/").ok, false);
  assert.equal(P.checkUrl("not a url").ok, false);
  assert.equal(P.checkUrl("https://cdn.example.com/photos/a.jpg?x=1").ok, true);
});

test("a hostname that resolves to ANY private address is refused before connecting", async () => {
  const lookupPrivate = async () => [{address: "93.184.216.34", family: 4}, {address: "10.1.2.3", family: 4}];
  assert.equal(await P.resolvePublic("rebind.example.com", lookupPrivate), null);
  const lookupMeta = async () => [{address: "169.254.169.254", family: 4}];
  await assert.rejects(P.fetchPhoto("https://sneaky.example.com/a.jpg", {lookup: lookupMeta}), /not allowed/);
  const lookupPublic = async () => [{address: "93.184.216.34", family: 4}];
  assert.deepEqual(await P.resolvePublic("ok.example.com", lookupPublic), {address: "93.184.216.34", family: 4});
});
