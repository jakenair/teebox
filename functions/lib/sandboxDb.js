"use strict";
// The only database handle the Seller API sandbox ever gets (2026-11-23).
//
// Two layers:
//   strictSandboxDb(db)  throws on ANY path whose first segment isn't a
//                        sandbox_ collection, in every entry point, including
//                        refs handed to transactions and batches
//   sandboxDb(db)        strict, plus the API's own collection names mapped to
//                        their sandbox_ twins ("listings" → "sandbox_listings").
//                        A name that isn't in the map is NOT mapped, so it
//                        reaches the strict layer and throws.
//
// Clients can't read or write sandbox_*: firestore.rules default deny.

const PREFIX = "sandbox_";
const COLLECTIONS = ["listings", "users", "apiPartners", "apiConnections", "apiKeys", "apiIdempotency",
  "apiAudit", "apiRate", "listingApiOrigin", "apiConsents",
  "apiConnectionSlots"];

class SandboxIsolationError extends Error {}

function assertPath(path) {
  const root = String(path || "").split("/")[0];
  if (!/^sandbox_[A-Za-z]+$/.test(root)) {
    throw new SandboxIsolationError(`sandbox: refused access to "${root}"`);
  }
  return path;
}
function assertRef(ref) {
  // Queries carry no .path; only document refs may enter a transaction or batch.
  if (!ref || typeof ref.path !== "string") throw new SandboxIsolationError("sandbox: only sandbox_ document refs are allowed here");
  assertPath(ref.path);
  return ref;
}

const guardWriter = (w, extra) => {
  const out = {...extra};
  for (const m of ["create", "set", "update", "delete"]) {
    out[m] = (ref, ...rest) => { w[m](assertRef(ref), ...rest); return out; };
  }
  return out;
};

/** @param {object} db Firestore @return {object} guarded handle (no other methods) */
function strictSandboxDb(db) {
  return Object.freeze({
    doc: (path) => db.doc(assertPath(path)),
    collection: (path) => db.collection(assertPath(path)),
    getAll: (...refs) => { refs.forEach(assertRef); return db.getAll(...refs); },
    batch: () => {
      const b = db.batch();
      return guardWriter(b, {commit: () => b.commit()});
    },
    runTransaction: (fn, opts) => db.runTransaction((tx) => fn(guardWriter(tx, {
      get: (ref) => tx.get(assertRef(ref)),
      getAll: (...refs) => { refs.forEach(assertRef); return tx.getAll(...refs); },
    })), opts),
  });
}

function mapPath(path) {
  const parts = String(path || "").split("/");
  if (COLLECTIONS.includes(parts[0])) parts[0] = PREFIX + parts[0];
  return parts.join("/");
}

/** @param {object} db Firestore @return {object} guarded handle that speaks the API's own collection names */
function sandboxDb(db) {
  const strict = strictSandboxDb(db);
  return Object.freeze({...strict, doc: (p) => strict.doc(mapPath(p)), collection: (p) => strict.collection(mapPath(p))});
}

module.exports = {sandboxDb, strictSandboxDb, SandboxIsolationError, COLLECTIONS, PREFIX};
