/**
 * functions/lib/analytics.js
 *
 * Server-side PostHog event helper for TeeBox Cloud Functions.
 *
 * ───────────────────────────────────────────────────────────────
 * Secret config
 * ───────────────────────────────────────────────────────────────
 * The private project-key for posthog-node is loaded from the
 * Firebase Functions secret `POSTHOG_API_KEY`. Set it once with:
 *
 *   firebase functions:secrets:set POSTHOG_API_KEY
 *
 * Then attach the secret to any function that calls
 * `captureServerEvent()`:
 *
 *   exports.myFn = onCall(
 *     { secrets: [posthogSecret] },
 *     async (req) => { ... captureServerEvent({...}); ... }
 *   );
 *
 * Where `posthogSecret` is exported below.
 *
 * ───────────────────────────────────────────────────────────────
 * Why singleton
 * ───────────────────────────────────────────────────────────────
 * posthog-node maintains an internal batch queue + interval flusher.
 * Allocating a fresh client on each invocation would lose batched
 * events when the Cloud Functions runtime evicts the instance. We
 * memoize per-process so warm invocations share a queue and we get
 * the network savings PostHog's batching is designed to provide.
 *
 * ───────────────────────────────────────────────────────────────
 * Idempotency note
 * ───────────────────────────────────────────────────────────────
 * PostHog dedupes events by `(distinct_id, event, timestamp)`. When
 * a Stripe webhook redelivers, our handler is idempotent at the
 * Firestore layer (see processedStripeEvents/) — but the redelivery
 * also re-invokes captureServerEvent. To keep PostHog clean we set
 * an explicit `timestamp` derived from the source event (Stripe
 * event.created, refund.created, dispute.created) when known, so
 * PostHog's dedupe collapses replays into one row.
 *
 * Callers SHOULD pass `props.serverTimestamp` (ISO 8601) or
 * `props.eventTimestampMs` when a deterministic timestamp is
 * available. If absent we stamp "now" and accept duplicates on
 * webhook replays (rare, and downstream dashboards can de-dupe).
 *
 * ───────────────────────────────────────────────────────────────
 * Safety
 * ───────────────────────────────────────────────────────────────
 * captureServerEvent NEVER throws. Analytics must never crash a
 * production function. All errors are logger.warn()-ed and
 * swallowed.
 */

const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions/v2");

// Exported so callers can attach to their function definitions:
//   exports.foo = onCall({secrets: [posthogSecret]}, ...);
const posthogSecret = defineSecret("POSTHOG_API_KEY");

let _client = null;
let _clientInitFailed = false;

/**
 * Returns the lazily-initialized singleton PostHog client, or null
 * if the secret is unavailable / init failed. Callers must tolerate
 * null (treat as "analytics disabled in this env").
 */
function getClient() {
  if (_client) return _client;
  if (_clientInitFailed) return null;
  let apiKey;
  try {
    apiKey = posthogSecret.value();
  } catch (err) {
    // Secret not bound to this function — caller forgot to add
    // `{ secrets: [posthogSecret] }` to the function definition.
    // Log once and short-circuit so we don't spam.
    logger.warn(
      "[analytics] POSTHOG_API_KEY secret not available; " +
      "captureServerEvent calls will be no-ops. " +
      "Add { secrets: [posthogSecret] } to this function. " +
      `(err: ${err && err.message})`);
    _clientInitFailed = true;
    return null;
  }
  if (!apiKey || /placeholder/i.test(apiKey)) {
    logger.warn(
      "[analytics] POSTHOG_API_KEY is empty or placeholder; " +
      "captureServerEvent calls will be no-ops.");
    _clientInitFailed = true;
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const {PostHog} = require("posthog-node");
    _client = new PostHog(apiKey, {
      host: "https://us.i.posthog.com",
      // Short flush interval — Cloud Functions are short-lived, we
      // want events to leave the process before the instance is
      // evicted. The shutdown() helper below is the belt-and-
      // suspenders path; this just shortens the worst-case window.
      flushAt: 10,
      flushInterval: 5000,
    });
    return _client;
  } catch (err) {
    logger.warn(
      `[analytics] PostHog client init failed: ${err && err.message}`);
    _clientInitFailed = true;
    return null;
  }
}

/**
 * captureServerEvent({ userId, event, props })
 *
 * Fire a single product event to PostHog from a Cloud Function.
 *
 *   userId  string|null  — Firebase Auth UID, or null for system
 *                          events (cron jobs, webhook-triggered
 *                          flows where no user is the actor).
 *                          For null we use a stable "system" id so
 *                          PostHog doesn't create a fresh anon
 *                          profile each call.
 *   event   string       — snake_case event name (e.g.
 *                          'purchase_completed'). MUST match a
 *                          name from events.md.
 *   props   object       — custom props for this event. The helper
 *                          attaches standard server props
 *                          automatically — do not duplicate them.
 *
 * Standard server props injected automatically:
 *   deviceType:       "server"
 *   source:           "cloud-function"
 *   serverTimestamp:  ISO 8601 of fire-time (may be overridden by
 *                     caller passing props.serverTimestamp)
 *
 * Never throws. Returns nothing.
 */
function captureServerEvent({userId, event, props}) {
  try {
    if (!event || typeof event !== "string") {
      logger.warn(
        "[analytics] captureServerEvent: missing/invalid event name");
      return;
    }
    const client = getClient();
    if (!client) return; // already logged in getClient()

    const properties = Object.assign(
      {
        // Standard server property bag — never duplicate these
        // from the caller.
        deviceType: "server",
        source: "cloud-function",
        serverTimestamp: new Date().toISOString(),
      },
      props || {},
    );

    // Resolve distinct_id. PostHog requires a non-empty string;
    // null userIds get a stable system id so anonymous server
    // events don't fan out into thousands of throwaway profiles.
    const distinctId = userId && typeof userId === "string" ?
      userId : "system:cloud-function";

    // Optional deterministic timestamp for replay-safety. If the
    // caller supplied either a numeric eventTimestampMs OR an
    // ISO serverTimestamp string we anchor PostHog's `timestamp`
    // to it, so Stripe webhook replays collapse to one row.
    let timestamp = null;
    if (typeof properties.eventTimestampMs === "number" &&
        Number.isFinite(properties.eventTimestampMs)) {
      timestamp = new Date(properties.eventTimestampMs);
    } else if (typeof properties.serverTimestamp === "string") {
      // If a deterministic ISO string was supplied (e.g. derived
      // from stripe event.created) use it; otherwise our injected
      // now() value provides ordering without dedupe semantics.
      const d = new Date(properties.serverTimestamp);
      if (!Number.isNaN(d.getTime())) timestamp = d;
    }

    client.capture({
      distinctId,
      event,
      properties,
      timestamp: timestamp || undefined,
    });
  } catch (err) {
    // Analytics must NEVER crash a function. Log + swallow.
    logger.warn(
      `[analytics] captureServerEvent('${event}') failed: ${
        err && err.message}`);
  }
}

/**
 * Optional: identify a user (set/update person properties) from
 * the server. Useful for stamping role / verifiedSeller / tier
 * flips that happen entirely server-side (e.g. Stripe webhook
 * promoting a user to Pro).
 *
 * Never throws.
 */
function identifyServer({userId, traits}) {
  try {
    if (!userId || typeof userId !== "string") return;
    const client = getClient();
    if (!client) return;
    client.identify({
      distinctId: userId,
      properties: traits || {},
    });
  } catch (err) {
    logger.warn(
      `[analytics] identifyServer failed: ${err && err.message}`);
  }
}

/**
 * Best-effort flush. Cloud Functions on Node 22 can be evicted
 * any time after the entry-point returns; calling shutdown() at
 * the tail of a handler that captured events guarantees the
 * batch is sent before the runtime tears down.
 *
 * Most callers should NOT bother — the batching window is short
 * enough that next-warm-invocation will flush for them. Only call
 * this from rarely-invoked handlers (webhooks, scheduled jobs)
 * where the next invocation might be hours away.
 *
 * Never throws.
 */
async function shutdownAnalytics() {
  try {
    if (!_client) return;
    await _client.shutdown();
  } catch (err) {
    logger.warn(
      `[analytics] shutdownAnalytics failed: ${err && err.message}`);
  }
}

module.exports = {
  posthogSecret,
  captureServerEvent,
  identifyServer,
  shutdownAnalytics,
};
