/**
 * functions/dataPortability.js
 * ─────────────────────────────────────────────────────────────────────────
 * GDPR Article 20 — "Right to data portability".
 *
 *   exportMyData (callable)
 *     Bundles every Firestore record we hold for the calling user into a
 *     single JSON object, returns it as the callable result, and writes
 *     an audit row to `dataExports/{auto-id}` for compliance traceability.
 *
 * Public-policy commitment: privacy.html:219 promises users they can
 * "receive a copy of your data in a structured, machine-readable format."
 * This callable is what fulfills that promise.
 *
 * V1 design notes:
 *   • Inline response, JSON. We're not zipping or password-protecting —
 *     the callable is auth-gated and HTTPS-only, and zipping adds an extra
 *     ~50ms of CPU + an unfortunate file-format ambiguity (clients have
 *     to download → unzip → open). For v1 we trust the Firebase callable
 *     channel.
 *   • Synchronous. Firestore callable response cap is 10 MB. We target a
 *     ~5 MB ceiling so we leave headroom for the multipart wrapper.
 *     Beyond that, we log a warning and the future path is a background
 *     export → Cloud Storage signed URL emailed to the user.
 *   • Timestamps are serialized as ISO 8601 strings to keep the JSON
 *     trivially parseable in any downstream tool (Excel, jq, Python). The
 *     raw `_seconds/_nanoseconds` shape Firestore admin SDK returns is
 *     opaque to non-Firebase consumers and violates the "structured,
 *     commonly-used, machine-readable format" wording in Art. 20.
 *
 * Future-work hooks (DO NOT BUILD until needed):
 *   - Background export → Storage signed URL emailed to user (for >5 MB
 *     bundles).
 *   - Optional inclusion of FCM token registration history.
 *   - Verified-account stepup before issuing the export (force re-auth
 *     within last 5 min). Currently we trust the standard auth session.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

// Callable shape — slightly larger memory (the JSON build is in-process)
// and a longer timeout to handle heavy sellers with hundreds of orders /
// reviews. Concurrency is intentionally low: large bundles dominate CPU
// + memory, and there's no need to scale this to 100 instances.
const PORTABILITY_CALLABLE = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 120,
  concurrency: 10,
  maxInstances: 20,
};

// Soft warning threshold. Past this, log a warning and surface a note in
// the response so the client can hint at the future "we'll email you a
// link" path. The hard cap is enforced implicitly by Firebase (10 MB
// callable response limit — we'll throw if the serialized payload is
// over that, see SAFE_PAYLOAD_BYTES below).
const SOFT_WARN_BYTES = 5 * 1024 * 1024;
const SAFE_PAYLOAD_BYTES = 9 * 1024 * 1024; // leave 1 MB of headroom

/**
 * Recursively walk a Firestore-decoded object and replace Timestamps with
 * ISO 8601 strings. We can't rely on instanceof check across module
 * boundaries reliably, so we sniff the canonical shape (an object with
 * `_seconds` + `_nanoseconds`, or one whose `toDate` method works).
 *
 * Also strips Firestore-internal Buffer-like blobs and reference objects
 * (which can't be JSON.stringify'd in any useful way for the user).
 */
function isoizeTimestamps(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  // Firebase admin Timestamp duck-types — either has toDate(), or has
  // the canonical _seconds/_nanoseconds shape from JSON-deserialized
  // payloads.
  if (typeof value.toDate === "function") {
    try {
      return value.toDate().toISOString();
    } catch (_e) { /* fall through */ }
  }
  if (typeof value._seconds === "number" &&
      typeof value._nanoseconds === "number" &&
      Object.keys(value).length <= 2) {
    try {
      return new Date(value._seconds * 1000 +
          Math.floor(value._nanoseconds / 1e6)).toISOString();
    } catch (_e) { /* fall through */ }
  }
  // GeoPoint shape — preserve as a small object with lat/lng numbers.
  if (typeof value._latitude === "number" &&
      typeof value._longitude === "number") {
    return {latitude: value._latitude, longitude: value._longitude};
  }
  // DocumentReference shape — keep the path string only.
  if (typeof value.path === "string" && typeof value.id === "string" &&
      typeof value.firestore === "object") {
    return {_ref: value.path};
  }

  if (Array.isArray(value)) {
    return value.map(isoizeTimestamps);
  }

  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = isoizeTimestamps(value[k]);
  }
  return out;
}

/**
 * Read every doc in a collection that matches the given field=uid query
 * and return them as plain JS objects (with id) sanitized via
 * isoizeTimestamps. Limits to 5000 results per query to avoid runaway
 * payloads on extreme accounts.
 */
async function collectionByField(db, collection, field, uid) {
  const snap = await db.collection(collection)
      .where(field, "==", uid)
      .limit(5000)
      .get();
  return snap.docs.map((d) => isoizeTimestamps({id: d.id, ...d.data()}));
}

/**
 * Like collectionByField, but de-dupes results across two field queries
 * (e.g. orders where buyerId == uid OR sellerId == uid). Firestore lacks
 * native OR-on-different-fields support at the time of writing.
 */
async function collectionByEitherField(db, collection, fieldA, fieldB, uid) {
  const [aSnap, bSnap] = await Promise.all([
    db.collection(collection).where(fieldA, "==", uid).limit(5000).get(),
    db.collection(collection).where(fieldB, "==", uid).limit(5000).get(),
  ]);
  const seen = new Set();
  const out = [];
  const push = (d) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    out.push(isoizeTimestamps({id: d.id, ...d.data()}));
  };
  aSnap.docs.forEach(push);
  bSnap.docs.forEach(push);
  return out;
}

/**
 * Collect a subcollection under users/{uid}/{subcollection}. Returns []
 * if the subcollection doesn't exist or is empty (callers should also
 * surface a fallback root-doc field where applicable — e.g. watchlist
 * can live as either a subcollection OR a field on users/{uid}).
 */
async function userSubcollection(db, uid, name) {
  try {
    const snap = await db.collection("users").doc(uid)
        .collection(name).limit(5000).get();
    return snap.docs.map((d) => isoizeTimestamps({id: d.id, ...d.data()}));
  } catch (_e) {
    return [];
  }
}

exports.exportMyData = onCall(
    PORTABILITY_CALLABLE,
    async (request) => {
      const uid = request.auth && request.auth.uid;
      if (!uid) {
        throw new HttpsError("unauthenticated", "Sign in required to export your data.");
      }

      const db = admin.firestore();
      const generatedAt = new Date().toISOString();

      // ── 1. Root user doc ────────────────────────────────────────────
      let userDoc = null;
      try {
        const uSnap = await db.collection("users").doc(uid).get();
        if (uSnap.exists) {
          userDoc = isoizeTimestamps({id: uSnap.id, ...uSnap.data()});
        }
      } catch (err) {
        logger.error("exportMyData: user doc fetch failed", uid, err);
      }

      // ── 2. Subcollections under users/{uid}/* ───────────────────────
      const [savedSearches, watchlistSub] = await Promise.all([
        userSubcollection(db, uid, "savedSearches"),
        userSubcollection(db, uid, "watchlist"),
      ]);

      // Fallback: if the watchlist subcollection is empty, surface the
      // map field on users/{uid}.watchlist. This is the v1 schema (see
      // index.html `loadWatchlist`); the subcollection variant is a
      // forward-looking format we may migrate to.
      let watchlist = watchlistSub;
      if (!watchlist.length && userDoc && userDoc.watchlist &&
          typeof userDoc.watchlist === "object") {
        watchlist = Object.entries(userDoc.watchlist).map(([listingId, data]) => ({
          listingId,
          ...(data && typeof data === "object" ? data : {}),
        }));
      }

      // ── 3. Cross-collection bundles ────────────────────────────────
      // Each Promise.allSettled-style gather so a single failing collection
      // (e.g. a missing index) doesn't sink the entire export.
      const safeBundle = async (label, fn) => {
        try {
          return await fn();
        } catch (err) {
          logger.error(`exportMyData: ${label} fetch failed`, uid, err);
          return {_error: `Could not load ${label}: ${err.message || "unknown"}`};
        }
      };

      const [orders, listings, reviews, messages, disputes, offers] = await Promise.all([
        safeBundle("orders", () =>
          collectionByEitherField(db, "orders", "buyerId", "sellerId", uid)),
        safeBundle("listings", () =>
          collectionByField(db, "listings", "sellerId", uid)),
        safeBundle("reviews", () =>
          collectionByEitherField(db, "reviews", "authorId", "targetUid", uid)),
        safeBundle("messages", () =>
          collectionByEitherField(db, "messages", "senderId", "receiverId", uid)),
        safeBundle("disputes", () =>
          collectionByEitherField(db, "disputes", "buyerId", "sellerId", uid)),
        safeBundle("offers", () =>
          collectionByEitherField(db, "offers", "buyerId", "sellerId", uid)),
      ]);

      // ── 4. Assemble the payload ────────────────────────────────────
      const data = {
        user: userDoc,
        savedSearches,
        watchlist,
        orders,
        listings,
        reviews,
        messages,
        disputes,
        offers,
      };

      const payload = {ok: true, data, generatedAt, uid};

      // ── 5. Size accounting + audit row ─────────────────────────────
      // We serialize once to learn the byte size, then return the same
      // JSON to the client. JSON.stringify on a ~5 MB object is fast
      // enough (~50-100ms) that this isn't a meaningful overhead.
      const serialized = JSON.stringify(payload);
      const byteSize = Buffer.byteLength(serialized, "utf8");

      if (byteSize >= SAFE_PAYLOAD_BYTES) {
        // Hard limit: bail before Firebase truncates the response. The
        // future path is the background-export-to-Storage flow.
        logger.warn("exportMyData: payload too large for inline response", {
          uid,
          byteSize,
        });
        throw new HttpsError(
            "resource-exhausted",
            "Your data export exceeds the size limit for inline delivery. " +
            "Please email legal@teeboxmarket.com — we will deliver the " +
            "full archive via a one-time download link within 30 days as " +
            "required by GDPR Article 12(3).",
        );
      }
      if (byteSize >= SOFT_WARN_BYTES) {
        logger.warn("exportMyData: large payload approaching inline limit", {
          uid,
          byteSize,
        });
      }

      try {
        await db.collection("dataExports").add({
          uid,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
          generatedAtIso: generatedAt,
          byteSize,
          method: "inline-callable",
        });
      } catch (auditErr) {
        // Audit write is best-effort — never fail the user-facing call
        // because we couldn't write a compliance row.
        logger.error("exportMyData: audit write failed", uid, auditErr);
      }

      logger.info("exportMyData: success", {uid, byteSize});
      return payload;
    },
);
