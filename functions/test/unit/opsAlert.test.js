// functions/test/unit/opsAlert.test.js — one id per alert, one retry, both mailboxes.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

async function withServer(handler, fn) {
  const got = [];
  const srv = http.createServer((q, s) => {
    let b = ""; q.on("data", (c) => { b += c; }); q.on("end", () => { got.push(JSON.parse(b)); handler(got.length, s); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.SMOKE_ALERT_WEBHOOK = `http://127.0.0.1:${srv.address().port}/x?t=1`;
  try { await fn(got); } finally { srv.closeAllConnections(); srv.close(); }
}
const {opsAlert} = require("../../opsAlert");
const {_internal: R} = require("../../opsAlertRelay");

test("delivered first time: one post with its own id", async () => {
  await withServer((n, s) => s.end("ok"), async (got) => {
    await opsAlert("warn", "a", {x: 1}); await opsAlert("warn", "a", {x: 1});
    assert.equal(got.length, 2);
    assert.match(got[0].alertId, /^[0-9a-f-]{36}$/);
    assert.notEqual(got[0].alertId, got[1].alertId);
  });
});
test("relay error, then fine: retried once with the same id", async () => {
  await withServer((n, s) => { s.statusCode = n === 1 ? 502 : 200; s.end(); }, async (got) => {
    await opsAlert("critical", "b");
    assert.equal(got.length, 2); assert.equal(got[0].alertId, got[1].alertId);
  });
});
test("relay hangs, then fine: retried", async () => {
  await withServer((n, s) => { if (n > 1) s.end("ok"); }, async (got) => {
    await opsAlert("warn", "c", {}, {timeoutMs: 150});
    assert.equal(got.length, 2); assert.equal(got[0].alertId, got[1].alertId);
  });
});
test("never throws and never tries a third time", async () => {
  await withServer((n, s) => { s.statusCode = 500; s.end(); }, async (got) => {
    await opsAlert("warn", "d"); assert.equal(got.length, 2);
  });
  process.env.SMOKE_ALERT_WEBHOOK = "not a url";
  await opsAlert("warn", "e");
});
test("relay: both mailboxes once each, ids kept or made, junk ids replaced", () => {
  const box = R.recipients("")[0];
  assert.deepEqual(R.recipients("ops@example.test"), ["ops@example.test", box]);
  assert.deepEqual(R.recipients(box.toUpperCase()), [box]);
  assert.equal(R.alertIdOf({alertId: "abcd-1234-efgh"}), "abcd-1234-efgh");
  for (const bad of [{}, null, "x", {alertId: "a b"}, {alertId: "x".repeat(99)}]) assert.match(R.alertIdOf(bad), /^[0-9a-f-]{36}$/);
});
