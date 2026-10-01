// functions/test/unit/safeSearch.test.js
//
// Regression tests for the 2026-10-01 listing-flagging incident.
//
// The headline test is "per-response error is retried, not swallowed". Against
// the pre-incident code that test FAILS: the old loop only caught thrown
// errors, so a Vision RESOURCE_EXHAUSTED delivered inside a resolved promise
// produced `{annotation: undefined}` on the first attempt with zero retries,
// and the caller flagged a legitimate listing.

const test = require("node:test");
const assert = require("node:assert");
const {runSafeSearchWithRetry} = require("../../lib/safeSearch");

const SAFE = {
  adult: "VERY_UNLIKELY",
  racy: "UNLIKELY",
  violence: "VERY_UNLIKELY",
  medical: "VERY_UNLIKELY",
  spoof: "VERY_UNLIKELY",
};

// A client stub that returns a scripted sequence of Vision responses and
// records every request it was handed.
function stubClient(responses) {
  const calls = [];
  return {
    calls,
    safeSearchDetection: async (req) => {
      calls.push(req);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (typeof r === "function") return r();
      return [r];
    },
  };
}

const noSleep = async () => {};
const quietLogger = {error: () => {}};
const opts = (client) => ({client, sleep: noSleep, logger: quietLogger});

test("THE INCIDENT: per-response RESOURCE_EXHAUSTED is retried, not swallowed",
    async () => {
      // Exactly what Vision returned on 2026-10-01: HTTP 200, resolved
      // promise, error in the body, no annotation.
      const client = stubClient([
        {error: {code: 8, message: "Resource has been exhausted (e.g. check quota)."}},
      ]);
      const {annotation, error} = await runSafeSearchWithRetry(
          Buffer.from("x"), "gs://b/o.jpg", "test", opts(client));

      // Old code: 1 call, then the caller flagged the listing.
      assert.strictEqual(client.calls.length, 3,
          "must exhaust all 3 attempts before giving up");
      assert.strictEqual(annotation, null);
      assert.ok(error, "must report an error rather than a null annotation");
      assert.strictEqual(error.visionCode, 8);
      assert.match(error.message, /Resource has been exhausted/);
    });

test("a transient per-response error recovers on retry", async () => {
  // This is the real-world case: one blip, then Vision is fine. The old code
  // flagged the listing permanently; the fix returns a clean verdict.
  let n = 0;
  const client = stubClient([() => {
    n++;
    if (n === 1) return [{error: {code: 8, message: "exhausted"}}];
    return [{safeSearchAnnotation: SAFE}];
  }]);
  const {annotation, error} = await runSafeSearchWithRetry(
      Buffer.from("x"), "gs://b/o.jpg", "test", opts(client));
  assert.strictEqual(error, null);
  assert.deepStrictEqual(annotation, SAFE);
  assert.strictEqual(client.calls.length, 2, "should stop as soon as it succeeds");
});

test("a thrown (rejected-promise) error is still retried — old behaviour kept",
    async () => {
      let n = 0;
      const client = stubClient([() => {
        n++;
        if (n < 3) throw new Error("ECONNRESET");
        return [{safeSearchAnnotation: SAFE}];
      }]);
      const {annotation, error} = await runSafeSearchWithRetry(
          Buffer.from("x"), "gs://b/o.jpg", "test", opts(client));
      assert.strictEqual(error, null);
      assert.deepStrictEqual(annotation, SAFE);
      assert.strictEqual(client.calls.length, 3);
    });

test("a 200 with neither annotation nor error is retried, not trusted",
    async () => {
      const client = stubClient([{}]);
      const {annotation, error} = await runSafeSearchWithRetry(
          Buffer.from("x"), "gs://b/o.jpg", "test", opts(client));
      assert.strictEqual(client.calls.length, 3);
      assert.strictEqual(annotation, null);
      assert.ok(error);
    });

test("clean first response returns immediately — no wasted Vision calls",
    async () => {
      const client = stubClient([{safeSearchAnnotation: SAFE}]);
      const {annotation, error} = await runSafeSearchWithRetry(
          Buffer.from("x"), "gs://b/o.jpg", "test", opts(client));
      assert.strictEqual(error, null);
      assert.deepStrictEqual(annotation, SAFE);
      assert.strictEqual(client.calls.length, 1);
    });

test("sends image BYTES when a buffer is supplied (no GCS round trip)",
    async () => {
      const buf = Buffer.from("imagedata");
      const client = stubClient([{safeSearchAnnotation: SAFE}]);
      await runSafeSearchWithRetry(buf, "gs://b/o.jpg", "test", opts(client));
      assert.deepStrictEqual(client.calls[0].image.content, buf);
      assert.strictEqual(client.calls[0].image.source, undefined,
          "must not ask Vision to fetch from GCS when we already have bytes");
    });

test("falls back to the gs:// URI when no buffer is available", async () => {
  const client = stubClient([{safeSearchAnnotation: SAFE}]);
  await runSafeSearchWithRetry(null, "gs://b/o.jpg", "test", opts(client));
  assert.strictEqual(client.calls[0].image.source.gcsImageUri, "gs://b/o.jpg");
  assert.strictEqual(client.calls[0].image.content, undefined);
});

test("an empty buffer is treated as no buffer", async () => {
  const client = stubClient([{safeSearchAnnotation: SAFE}]);
  await runSafeSearchWithRetry(
      Buffer.alloc(0), "gs://b/o.jpg", "test", opts(client));
  assert.strictEqual(client.calls[0].image.source.gcsImageUri, "gs://b/o.jpg");
});

test("never throws — an exhausted retry is a return value", async () => {
  const client = stubClient([() => {
    throw new Error("total failure");
  }]);
  const res = await runSafeSearchWithRetry(
      Buffer.from("x"), "gs://b/o.jpg", "test", opts(client));
  assert.strictEqual(res.annotation, null);
  assert.ok(res.error);
});

test("backs off between attempts, not after the last one", async () => {
  const waits = [];
  const client = stubClient([{error: {code: 8, message: "exhausted"}}]);
  await runSafeSearchWithRetry(Buffer.from("x"), "gs://b/o.jpg", "test",
      {client, logger: quietLogger, sleep: async (ms) => {
        waits.push(ms);
      }});
  assert.deepStrictEqual(waits, [600, 1200],
      "3 attempts means 2 sleeps, increasing");
});
