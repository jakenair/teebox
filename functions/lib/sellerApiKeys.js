"use strict";
// Seller API v1: keys. Founder decisions 2026-11-20.
//
// Two keys on every request:
//   X-TeeBox-Partner-Key: pk_live_...       issued by TeeBox to an approved partner
//   Authorization: Bearer sk_conn_live_...  created by a seller for ONE partner
// A connection key only works together with the partner key it was made for,
// so a leaked connection key is useless to anyone else.
//
// Storage (server-only collections; firestore.rules deny all client access):
//   apiPartners/{partnerId}       name, status active|disabled, mode, keyHash, keyLast4
//   apiConnections/{connectionId} uid, partnerId, status active|revoked, keyHash, keyLast4
//   apiConsents/{id}              append-only record of every grant and revoke (lib/sellerApiConsent.js)
//   apiKeys/{sha256(key)}         {kind: "partner", partnerId} | {kind: "connection", connectionId, partnerId, uid}
// Only the SHA-256 of a key is stored; the key itself is shown once.
//
// KILL SWITCH: setting apiPartners/{id}.status = "disabled" refuses that
// partner's key AND every seller connection made for it on the very next
// request (both are read fresh on every request, never cached).

const crypto = require("node:crypto");
const {checkConsent} = require("./sellerApiConsent");

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_RE = /^(pk_(live|test)_|sk_conn_(live|test)_)[0-9A-Za-z]{43}$/;

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || null;
  }
}

/** 43 base62 chars = 256 bits of randomness. */
function randomToken(bytes = crypto.randomBytes(64)) {
  let out = "";
  for (let i = 0; out.length < 43; i++) {
    if (i >= bytes.length) { bytes = crypto.randomBytes(64); i = 0; }
    const b = bytes[i];
    if (b < 248) out += ALPHABET[b % 62]; // rejection sampling, no modulo bias
  }
  return out;
}

function newKey(prefix) { return prefix + randomToken(); }
function hashKey(key) { return crypto.createHash("sha256").update(String(key)).digest("hex"); }
function last4(key) { return String(key).slice(-4); }
function keyMode(key) {
  const m = String(key).match(/^(?:pk|sk_conn)_(live|test)_/);
  return m ? m[1] : null;
}

function header(headers, name) {
  const h = headers || {};
  const v = h[name] !== undefined ? h[name] : h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : (v == null ? "" : String(v));
}

/**
 * Read and check the two keys' shape. No database access. The keys' own prefix
 * decides the environment, so this runs before any database handle is chosen.
 * @return {{pk: string, ck: string, mode: "live"|"test"}}
 */
function readKeys(headers) {
  const pk = header(headers, "x-teebox-partner-key").trim();
  const bearer = header(headers, "authorization").trim();
  const ck = bearer.replace(/^Bearer\s+/i, "");
  if (!pk) throw new ApiError(401, "missing_partner_key", "Send your partner key in the X-TeeBox-Partner-Key header.");
  if (!bearer || ck === bearer) throw new ApiError(401, "missing_connection_key", "Send the seller's connection key as: Authorization: Bearer sk_conn_...");
  if (!KEY_RE.test(pk) || !pk.startsWith("pk_")) throw new ApiError(401, "invalid_partner_key", "That partner key isn't valid.");
  if (!KEY_RE.test(ck) || !ck.startsWith("sk_conn_")) throw new ApiError(401, "invalid_connection_key", "That connection key isn't valid.");
  const mode = keyMode(pk);
  if (mode !== keyMode(ck)) {
    throw new ApiError(401, "wrong_environment", "Use a test partner key with a test connection key, or a live one with a live one. They can't be mixed.");
  }
  return {pk, ck, mode: mode === "live" ? "live" : "test"};
}

/**
 * Authenticate a request. Reads the partner, the connection and the seller
 * fresh every time (that is what makes the kill switch instant). `db` must be
 * the handle for the keys' own environment.
 * @return {Promise<{partnerId, partner, connectionId, connection, uid, user}>}
 */
async function authenticate({db, auth, cfg}, {pk, ck}) {
  if (keyMode(pk) !== cfg.mode || keyMode(ck) !== cfg.mode) {
    throw new ApiError(401, "wrong_environment", "These keys belong to the other environment.");
  }
  const [pSnap, cSnap] = await Promise.all([
    db.doc(`apiKeys/${hashKey(pk)}`).get(), db.doc(`apiKeys/${hashKey(ck)}`).get()]);
  const pRef = pSnap.exists ? pSnap.data() : null;
  const cRef = cSnap.exists ? cSnap.data() : null;
  if (!pRef || pRef.kind !== "partner") throw new ApiError(401, "invalid_partner_key", "That partner key isn't valid.");
  if (!cRef || cRef.kind !== "connection") throw new ApiError(401, "invalid_connection_key", "That connection key isn't valid, or the seller revoked it.");

  const [partnerSnap, connSnap] = await Promise.all([
    db.doc(`apiPartners/${pRef.partnerId}`).get(), db.doc(`apiConnections/${cRef.connectionId}`).get()]);
  const partner = partnerSnap.exists ? partnerSnap.data() : null;
  const connection = connSnap.exists ? connSnap.data() : null;
  if (!partner || partner.keyHash !== hashKey(pk)) throw new ApiError(401, "invalid_partner_key", "That partner key isn't valid (it may have been replaced).");
  if (partner.status !== "active") {
    throw new ApiError(403, "partner_disabled", "This partner's API access is paused. Contact TeeBox.");
  }
  if (!connection || connection.keyHash !== hashKey(ck)) throw new ApiError(401, "invalid_connection_key", "That connection key isn't valid, or the seller revoked it.");
  if (connection.status !== "active") throw new ApiError(401, "connection_revoked", "The seller disconnected this tool. Ask them to connect it again in TeeBox.");
  if (connection.partnerId !== pRef.partnerId) {
    throw new ApiError(403, "connection_partner_mismatch", "This connection key was made for a different tool.");
  }

  const uid = connection.uid;
  let authUser;
  try { authUser = await auth.getUser(uid); } catch (_e) {
    throw new ApiError(401, "seller_not_found", "The seller's TeeBox account no longer exists.");
  }
  if (authUser.disabled) throw new ApiError(403, "seller_disabled", "The seller's TeeBox account is disabled.");
  const uSnap = await db.doc(`users/${uid}`).get();
  const user = uSnap.exists ? (uSnap.data() || {}) : {};
  if (user.banned === true) throw new ApiError(403, "seller_disabled", "The seller's TeeBox account can't list items.");

  return {partnerId: pRef.partnerId, partner, connectionId: cRef.connectionId, connection, uid, user, authUser};
}

/**
 * Issue a partner (admin only; scripts/api-partner.cjs). Returns the key ONCE.
 */
async function createPartner({db, FieldValue, cfg}, {partnerId, name, contactEmail}) {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(String(partnerId || ""))) throw new Error("partnerId: lowercase letters, digits, dashes (2-40)");
  if (!name) throw new Error("name required");
  const ref = db.doc(`apiPartners/${partnerId}`);
  if ((await ref.get()).exists) throw new Error(`partner ${partnerId} already exists (use rotate)`);
  const key = newKey(cfg.partnerPrefix);
  const h = hashKey(key);
  const batch = db.batch();
  batch.set(ref, {name: String(name).slice(0, 80), contactEmail: String(contactEmail || "").slice(0, 200),
    status: "active", mode: cfg.mode, keyHash: h, keyLast4: last4(key),
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
  batch.set(db.doc(`apiKeys/${h}`), {kind: "partner", partnerId, createdAt: FieldValue.serverTimestamp()});
  await batch.commit();
  return {partnerId, key};
}

/** Replace a partner's key; the old key stops working immediately. */
async function rotatePartnerKey({db, FieldValue, cfg}, {partnerId}) {
  const ref = db.doc(`apiPartners/${partnerId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`no partner ${partnerId}`);
  const key = newKey(cfg.partnerPrefix);
  const h = hashKey(key);
  const batch = db.batch();
  batch.delete(db.doc(`apiKeys/${snap.data().keyHash}`));
  batch.set(db.doc(`apiKeys/${h}`), {kind: "partner", partnerId, createdAt: FieldValue.serverTimestamp()});
  batch.update(ref, {keyHash: h, keyLast4: last4(key), updatedAt: FieldValue.serverTimestamp()});
  await batch.commit();
  return {partnerId, key};
}

/** The kill switch. status "disabled" pauses the partner and all its connections. */
async function setPartnerStatus({db, FieldValue}, {partnerId, status, reason}) {
  if (!["active", "disabled"].includes(status)) throw new Error("status must be active or disabled");
  const ref = db.doc(`apiPartners/${partnerId}`);
  if (!(await ref.get()).exists) throw new Error(`no partner ${partnerId}`);
  await ref.update({status, statusReason: String(reason || "").slice(0, 200),
    statusChangedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
  return {partnerId, status};
}

/**
 * A seller connects a tool: one connection key for one active partner.
 * Called from the createApiConnection callable (signed-in seller).
 */
async function createConnection({db, FieldValue, cfg}, {uid, partnerId, consent, method}) {
  let agreed;
  try { agreed = checkConsent(consent, method); } catch (_e) {
    throw new ApiError(400, "consent_required", "Review what this tool can do and agree before connecting it.");
  }
  const pSnap = await db.doc(`apiPartners/${String(partnerId || "")}`).get();
  if (!pSnap.exists || pSnap.data().status !== "active") throw new ApiError(404, "partner_not_found", "That tool isn't available to connect.");
  const existing = await db.collection("apiConnections")
      .where("uid", "==", uid).where("partnerId", "==", partnerId).where("status", "==", "active").get();
  const key = newKey(cfg.connectionPrefix);
  const h = hashKey(key);
  const ref = db.collection("apiConnections").doc();
  const batch = db.batch();
  // One live connection per seller per tool: connecting again replaces the old key.
  existing.forEach((d) => {
    batch.update(d.ref, {status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedReason: "replaced"});
    batch.delete(db.doc(`apiKeys/${d.data().keyHash}`));
    batch.set(db.collection("apiConsents").doc(), {event: "revoked", uid, partnerId, partnerName: d.data().partnerName || partnerId,
      connectionId: d.id, method: "replaced_by_new_connection", at: FieldValue.serverTimestamp()});
  });
  const partnerName = pSnap.data().name || partnerId;
  batch.set(ref, {uid, partnerId, partnerName, status: "active",
    mode: cfg.mode, keyHash: h, keyLast4: last4(key), createdAt: FieldValue.serverTimestamp(),
    consent: {...agreed, at: FieldValue.serverTimestamp()}});
  // When and how the seller authorized this tool. Same batch as the key: one
  // can't exist without the other.
  batch.set(db.collection("apiConsents").doc(), {event: "granted", uid, partnerId, partnerName, connectionId: ref.id,
    ...agreed, at: FieldValue.serverTimestamp()});
  batch.set(db.doc(`apiKeys/${h}`), {kind: "connection", connectionId: ref.id, partnerId, uid,
    createdAt: FieldValue.serverTimestamp()});
  await batch.commit();
  return {connectionId: ref.id, partnerId, partnerName: pSnap.data().name || partnerId, key, replaced: existing.size};
}

/** A seller disconnects a tool. Only the owner can revoke. */
async function revokeConnection({db, FieldValue}, {uid, connectionId, method}) {
  const ref = db.doc(`apiConnections/${String(connectionId || "")}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== uid) throw new ApiError(404, "connection_not_found", "No such connection.");
  if (snap.data().status === "revoked") return {connectionId, status: "revoked"};
  const batch = db.batch();
  batch.update(ref, {status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedReason: "seller"});
  batch.delete(db.doc(`apiKeys/${snap.data().keyHash}`));
  batch.set(db.collection("apiConsents").doc(), {event: "revoked", uid, partnerId: snap.data().partnerId,
    partnerName: snap.data().partnerName || snap.data().partnerId, connectionId: ref.id,
    method: String(method || "connected_tools_screen").slice(0, 40), at: FieldValue.serverTimestamp()});
  await batch.commit();
  return {connectionId, status: "revoked"};
}

/** The seller's connections, for Profile > Connected tools. Never returns keys. */
async function listConnections({db}, {uid}) {
  const snap = await db.collection("apiConnections").where("uid", "==", uid).get();
  return snap.docs.map((d) => {
    const c = d.data();
    const ms = (t) => (t && t.toMillis ? t.toMillis() : null);
    return {connectionId: d.id, partnerId: c.partnerId, partnerName: c.partnerName, status: c.status,
      keyLast4: c.keyLast4, createdAt: ms(c.createdAt), lastUsedAt: ms(c.lastUsedAt), revokedAt: ms(c.revokedAt),
      authorizedHow: (c.consent && c.consent.method) || null, authorizedOn: (c.consent && c.consent.surface) || null};
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Active partners a seller can connect to. */
async function listPartners({db}) {
  const snap = await db.collection("apiPartners").where("status", "==", "active").get();
  return snap.docs.map((d) => ({partnerId: d.id, name: d.data().name || d.id}))
      .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  ApiError, readKeys, authenticate, createPartner, rotatePartnerKey, setPartnerStatus,
  createConnection, revokeConnection, listConnections, listPartners,
  newKey, hashKey, keyMode, randomToken, header, KEY_RE,
};
