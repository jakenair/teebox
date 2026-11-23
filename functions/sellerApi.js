"use strict";
// Seller API v1: Firebase wiring. Logic lives in lib/sellerApiCore.js and
// lib/sellerApiKeys.js; environment in lib/sellerApiConfig.js.
//
//   sellerApi              (HTTPS)    the partner API, served at api.teeboxmarket.com/v1
//   listApiPartners        (callable) tools a seller can connect (Profile > Connected tools)
//   createApiConnection    (callable) seller creates a connection key for one tool (shown once)
//   listApiConnections     (callable) seller's connections, never the keys
//   revokeApiConnection    (callable) seller disconnects a tool
//   requestApiAccess       (callable) seller asks for access for a tool not listed yet; alerts Jake
//
// Partners and their keys are issued by an admin with scripts/api-partner.cjs.
//
// NO payments, payouts, refunds, transfers, orders or Stripe anywhere in here
// (founder hard rule; test/unit/noMoneyIntegrations.test.js enforces it).

const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const core = require("./lib/sellerApiCore");
const keys = require("./lib/sellerApiKeys");
const config = require("./lib/sellerApiConfig");
const {sandboxDeps} = require("./lib/sellerApiSandbox");
const {fetchPhoto, storeListingPhoto, photoSlots} = require("./lib/photoFetch");
const {opsAlert, OPS_ALERT_WEBHOOK} = require("./opsAlert");

const REGION = "us-central1";

async function scanText(fields, uid) {
  const {scanFields} = require("./moderation/contentFilter");
  try {
    return await scanFields(fields, "listing", uid, null);
  } catch (e) {
    // Same failure mode as updateListing: never pass content unchecked
    // silently; let it through flagged for a human (needsReview on edits;
    // moderateListingOnCreate still scans every create).
    logger.error("sellerApi: content scan threw", e);
    return {clean: true, degraded: true};
  }
}

function storagePath(url) {
  const m = String(url || "").match(/\/o\/([^?]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (_e) { return null; }
}

// Two requests per instance may hold photos (up to 150 MB each); others wait 30 s.
const photoSlot = photoSlots(2, 30000);

function liveDeps() {
  const cfg = config.resolve("live");
  const bucket = admin.storage().bucket(cfg.bucket);
  return {
    db: admin.firestore(), auth: admin.auth(),
    FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp,
    cfg, scanText, photoSlot,
    fetchPhoto: (url) => fetchPhoto(url),
    storePhoto: ({uid, listingId, index, buffer, contentType, ext}) =>
      storeListingPhoto({bucket, uid, listingId, index, buffer, contentType, ext}),
    // Photos replaced by an API edit: delete the old files, only inside the
    // listing's own folder, with their resized copies (same rule as
    // updateListing's photo GC).
    deleteRemovedPhotos: async (before, after, listingId) => {
      const keep = new Set((after || []).map(storagePath));
      for (const u of before || []) {
        const p = storagePath(u);
        if (!p || keep.has(p) || !p.startsWith("listings/") || p.split("/")[2] !== listingId) continue;
        for (const f of [p, `${p}_w400.webp`, `${p}_w800.webp`, `${p}_w1200.webp`]) {
          await bucket.file(f).delete({ignoreNotFound: true}).catch((e) =>
            logger.warn("sellerApi: photo GC failed", {listingId, f, err: e && e.message}));
        }
      }
    },
    notifyReviewReopened: (l, what) => require("./lib/authReviewEmail").sendReviewEmail(l, "reopen", what),
    logError,
  };
}

const logError = (msg, e) => logger.error(msg, e);

// The keys' prefix picks the environment. Live is refused until the founder
// turns it on (config.LIVE_API_ENABLED); everything else is the sandbox.
const environments = {
  logError,
  forMode: (mode) => {
    if (mode === "live") {
      if (!config.liveEnabled()) {
        throw new keys.ApiError(403, "live_not_open", "The live API isn't open yet. Use your test keys.");
      }
      return liveDeps();
    }
    return sandboxDeps({firestore: admin.firestore(), FieldValue: admin.firestore.FieldValue,
      Timestamp: admin.firestore.Timestamp, logError});
  },
};

// The platform parses the body (up to 32 MB) before this code runs, and the
// worst JSON body measured takes about 1.3 GB. Memory and concurrency are set
// so an instance survives two of those at once; maxInstances caps the cost.
exports.sellerApi = onRequest(
    {region: REGION, memory: "4GiB", cpu: 2, timeoutSeconds: 120, concurrency: 2, maxInstances: 20, cors: false},
    async (req, res) => {
      const out = await core.handle(environments, {
        method: req.method, path: req.path, query: req.query || {}, headers: req.headers || {},
        body: req.body, bodyBytes: req.rawBody ? req.rawBody.length : 0, ip: req.ip,
      });
      for (const [k, v] of Object.entries(out.headers || {})) res.set(k, v);
      res.status(out.status).send(JSON.stringify(out.body));
    },
);

function toHttps(e) {
  if (e instanceof keys.ApiError) {
    const code = e.status === 404 ? "not-found" : e.status === 403 ? "permission-denied" : "failed-precondition";
    return new HttpsError(code, e.message);
  }
  logger.error("seller api callable: unexpected error", e);
  return new HttpsError("internal", "Something went wrong. Please try again.");
}

function signedIn(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
}

const CALLABLE = {region: REGION, memory: "256MiB", timeoutSeconds: 30};

exports.listApiPartners = onCall(CALLABLE, async (req) => {
  signedIn(req);
  try { return {partners: await keys.listPartners({db: admin.firestore()})}; } catch (e) { throw toHttps(e); }
});

exports.createApiConnection = onCall(CALLABLE, async (req) => {
  const uid = signedIn(req);
  if (!config.liveEnabled()) throw new HttpsError("failed-precondition", "Connected tools aren't open yet.");
  const d = {db: admin.firestore(), FieldValue: admin.firestore.FieldValue, cfg: config.resolve("live")};
  try {
    const r = await keys.createConnection(d, {uid, partnerId: String((req.data || {}).partnerId || "")});
    logger.info("createApiConnection", {uid, partnerId: r.partnerId, connectionId: r.connectionId, replaced: r.replaced});
    return r; // the key is returned this once and never stored
  } catch (e) { throw toHttps(e); }
});

exports.listApiConnections = onCall(CALLABLE, async (req) => {
  const uid = signedIn(req);
  try { return {connections: await keys.listConnections({db: admin.firestore()}, {uid})}; } catch (e) { throw toHttps(e); }
});

exports.revokeApiConnection = onCall(CALLABLE, async (req) => {
  const uid = signedIn(req);
  try {
    return await keys.revokeConnection({db: admin.firestore(), FieldValue: admin.firestore.FieldValue},
        {uid, connectionId: String((req.data || {}).connectionId || "")});
  } catch (e) { throw toHttps(e); }
});

exports.requestApiAccess = onCall({...CALLABLE, secrets: [OPS_ALERT_WEBHOOK]}, async (req) => {
  const uid = signedIn(req);
  const d = req.data || {};
  const tool = String(d.tool || "").trim().slice(0, 80);
  const note = String(d.note || "").trim().slice(0, 500);
  if (!tool) throw new HttpsError("invalid-argument", "Tell us which tool you want to connect.");
  const db = admin.firestore();
  const ref = db.doc(`apiAccessRequests/${uid}`);
  // One request a day, however many arrive at once.
  const fresh = await db.runTransaction(async (tx) => {
    const prev = await tx.get(ref);
    const last = prev.exists && prev.data().requestedAt ? prev.data().requestedAt.toMillis() : 0;
    if (Date.now() - last < 24 * 3600000) return false;
    tx.set(ref, {uid, tool, note, requestedAt: admin.firestore.FieldValue.serverTimestamp(), status: "new"});
    return true;
  });
  if (!fresh) return {ok: true, already: true};
  try {
    await opsAlert("info", `API access request: a seller wants to connect "${tool}". Review it in apiAccessRequests/${uid}.`,
        {uid, tool, note});
  } catch (e) { logger.warn("requestApiAccess: alert failed", e); }
  return {ok: true};
});
