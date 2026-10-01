// functions/lib/safeSearch.js
//
// Single source of truth for calling Cloud Vision SafeSearch. Extracted from
// index.js so the retry logic can be unit-tested with no network, and so there
// is exactly ONE copy of it.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE EXISTS — incident 2026-10-01
//
// optimizeListingPhoto and optimizePassportPhoto each carried their own
// byte-identical copy of this retry loop, and both copies had the same bug:
// they only caught *thrown* errors.
//
// Vision reports per-request failures for `gcsImageUri` inside an HTTP 200
// body, as `result.error` — NOT as a rejected promise. So when Vision returned
// RESOURCE_EXHAUSTED (code 8), the await resolved normally, the catch never
// ran, the backoff never engaged, `lastErr` stayed null, and the caller's
// `!safeSearch` test fired on the FIRST attempt.
//
// Consequences: six of one seller's listings were set to `flagged` and became
// invisible to buyers, with no retry, no logged error (the error line lived in
// the catch, which never ran), and no Cloud Monitoring signal — Vision records
// these as 2xx, so the API dashboard showed 150/151 successful. On the passport
// path the same failure PURGES the photo outright.
//
// Two fixes, both here:
//   1. Surface `result.error` as a throw so the existing backoff actually runs.
//   2. Prefer sending image BYTES over a gs:// URI. The callers already hold
//      the decoded buffer; making Vision re-fetch from GCS added a network hop
//      that could fail on its own. Bytes remove that failure mode entirely.
//
// Related bug class: an API that reports failure inside a success envelope.
// See also lib/email.js sendEmail(), which never throws (audit finding T3-04).
// ─────────────────────────────────────────────────────────────────────────

const SAFE_SEARCH_ATTEMPTS = 3;
const SAFE_SEARCH_BACKOFF_MS = 600;

/**
 * Run SafeSearch against an image, retrying transient failures.
 *
 * Returns `{annotation, error}`:
 *   - `{annotation: {...}, error: null}` — verified; caller applies policy.
 *   - `{annotation: null, error: Error}` — genuinely could not verify after
 *     every attempt. The caller decides what that means (listings flag for
 *     review, passport purges).
 *
 * Never throws: an exhausted retry is a return value, not an exception, so a
 * caller cannot accidentally conflate "unsafe" with "unverified".
 *
 * @param {Buffer|null} imageBuffer Decoded image bytes. Strongly preferred.
 * @param {string} gcsUri `gs://bucket/object`, used only as a fallback and for
 *   log lines.
 * @param {string} logLabel Caller name, for log attribution.
 * @param {object} [opts] Seams for tests: `client`, `sleep`, `logger`,
 *   `attempts`.
 * @return {Promise<{annotation: object|null, error: Error|null}>} Result.
 */
async function runSafeSearchWithRetry(imageBuffer, gcsUri, logLabel, opts = {}) {
  const attempts = opts.attempts || SAFE_SEARCH_ATTEMPTS;
  const log = opts.logger || console;
  const sleep = opts.sleep ||
      ((ms) => new Promise((r) => setTimeout(r, ms)));

  let client = opts.client;
  if (!client) {
    // Lazy-require so the function still cold-starts if the dep is missing.
    const vision = require("@google-cloud/vision");
    client = new vision.ImageAnnotatorClient();
  }

  // Bytes avoid Vision's GCS fetch entirely; fall back to the URI only if the
  // caller could not hand us a buffer (e.g. the convert step failed upstream).
  const image = imageBuffer && imageBuffer.length ?
      {content: imageBuffer} :
      {source: {gcsImageUri: gcsUri}};

  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const [result] = await client.safeSearchDetection({image});

      // THE FIX. A per-request error arrives on a RESOLVED promise. Convert it
      // to a throw so it reaches the backoff below instead of silently
      // degrading into "no annotation" and failing closed on attempt one.
      if (result && result.error &&
          (result.error.code || result.error.message)) {
        const e = new Error(
            `Vision per-response error ${result.error.code}: ` +
            `${result.error.message || "(no message)"}`);
        e.visionCode = result.error.code;
        throw e;
      }

      const annotation = result && result.safeSearchAnnotation;
      if (!annotation) {
        // Also retryable: a 200 with neither an annotation nor an error is a
        // Vision-side anomaly, not evidence about the image.
        throw new Error("Vision returned no safeSearchAnnotation and no error");
      }
      return {annotation, error: null};
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) {
        await sleep(SAFE_SEARCH_BACKOFF_MS * (attempt + 1));
      }
    }
  }

  log.error(
      `${logLabel}: SafeSearch failed after ${attempts} attempts`,
      gcsUri, lastErr && lastErr.message);
  return {annotation: null, error: lastErr};
}

module.exports = {
  runSafeSearchWithRetry,
  SAFE_SEARCH_ATTEMPTS,
  SAFE_SEARCH_BACKOFF_MS,
};
