// functions/lib/watch.js — likes ("watch list"), Phase 3 of the Vinted-UX
// project (2026-10-27).
//
// Graph: listings/{id}/watchers/{uid} {addedAt, priceWhenAdded} is the server
// -owned source of truth (one doc per liker, so a user can like a listing
// once). listings.watchlistCount is written ONLY here, inside the same
// transaction that writes the watcher doc, so the count can never drift from
// the graph by a dropped trigger. users/{uid}.watchlist stays as a mirror of
// the same graph: the Likes screen, notifyLike and the old app bundles read
// it, and the price-drop fan-out will walk the watchers subcollection.
//
// Pure functions over an injected Firestore so they run against the emulator
// in tests without a project.

function _code(code, message) {
  return Object.assign(new Error(message), {code});
}

/**
 * Set a user's like on a listing (idempotent).
 * @return {Promise<{on:boolean,count:number,changed:boolean}>}
 */
async function setWatch({db, FieldValue, uid, listingId, on}) {
  if (!uid) throw _code("unauthenticated", "Sign in to like listings.");
  const id = String(listingId || "").trim();
  if (!id || id.includes("/")) throw _code("invalid-argument", "listingId required");
  const listingRef = db.collection("listings").doc(id);
  const watcherRef = listingRef.collection("watchers").doc(uid);
  const userRef = db.collection("users").doc(uid);
  return db.runTransaction(async (tx) => {
    const [lSnap, wSnap] = await Promise.all([tx.get(listingRef), tx.get(watcherRef)]);
    if (!lSnap.exists) throw _code("not-found", "That listing no longer exists.");
    const count = Math.max(0, Number(lSnap.get("watchlistCount") || 0));
    const has = wSnap.exists;
    if (Boolean(on) === has) return {on: has, count, changed: false};
    if (on) {
      const entry = {addedAt: FieldValue.serverTimestamp()};
      const ask = Number(lSnap.get("ask") || 0);
      if (ask > 0) entry.priceWhenAdded = ask;
      tx.set(watcherRef, entry);
      tx.set(userRef, {watchlist: {[id]: entry}}, {merge: true});
      tx.set(listingRef, {watchlistCount: count + 1}, {merge: true});
      return {on: true, count: count + 1, changed: true};
    }
    tx.delete(watcherRef);
    tx.set(userRef, {watchlist: {[id]: FieldValue.delete()}}, {merge: true});
    tx.set(listingRef, {watchlistCount: Math.max(0, count - 1)}, {merge: true});
    return {on: false, count: Math.max(0, count - 1), changed: true};
  });
}

/**
 * Legacy shim: app bundles shipped before Phase 3 still write the
 * users/{uid}.watchlist map directly. Converge the graph from a map diff —
 * every step checks the watcher doc first, so a redelivered event or a map
 * change that setWatch already applied is a no-op (no double counting).
 * @return {Promise<{added:string[],removed:string[],applied:number}>}
 */
async function syncWatchersFromMapDiff({db, FieldValue, uid, before, after}) {
  const beforeIds = new Set(Object.keys((before && before.watchlist) || {}));
  const afterIds = new Set(Object.keys((after && after.watchlist) || {}));
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id));
  let applied = 0;
  for (const id of added) {
    const entry = (after.watchlist || {})[id] || {};
    applied += await db.runTransaction(async (tx) => {
      const listingRef = db.collection("listings").doc(id);
      const watcherRef = listingRef.collection("watchers").doc(uid);
      const [lSnap, wSnap] = await Promise.all([tx.get(listingRef), tx.get(watcherRef)]);
      if (!lSnap.exists || wSnap.exists) return 0;
      const doc = {addedAt: entry.addedAt || FieldValue.serverTimestamp()};
      if (Number(entry.priceWhenAdded) > 0) doc.priceWhenAdded = Number(entry.priceWhenAdded);
      tx.set(watcherRef, doc);
      tx.set(listingRef, {watchlistCount: Math.max(0, Number(lSnap.get("watchlistCount") || 0)) + 1}, {merge: true});
      return 1;
    });
  }
  for (const id of removed) {
    applied += await db.runTransaction(async (tx) => {
      const listingRef = db.collection("listings").doc(id);
      const watcherRef = listingRef.collection("watchers").doc(uid);
      const [lSnap, wSnap] = await Promise.all([tx.get(listingRef), tx.get(watcherRef)]);
      if (!wSnap.exists) return 0;
      tx.delete(watcherRef);
      if (lSnap.exists) tx.set(listingRef, {watchlistCount: Math.max(0, Number(lSnap.get("watchlistCount") || 0) - 1)}, {merge: true});
      return 1;
    });
  }
  return {added, removed, applied};
}

/** Self-heal one listing's count from its watchers subcollection. */
async function recountListing({db, listingRef}) {
  const agg = await listingRef.collection("watchers").count().get();
  const want = agg.data().count || 0;
  const snap = await listingRef.get();
  const have = Math.max(0, Number((snap.data() || {}).watchlistCount || 0));
  if (snap.exists && have !== want) {
    await listingRef.set({watchlistCount: want}, {merge: true});
    return {want, have, healed: true};
  }
  return {want, have, healed: false};
}

module.exports = {setWatch, syncWatchersFromMapDiff, recountListing};
