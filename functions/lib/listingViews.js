"use strict";
// recordListingView (r421): real, deduped listing views for the eye /
// Trending badges. Guests count too (the old incrementListingView was
// signed-in only), so abuse controls live here instead of App Check:
//   - one count per viewer per listing per 24h (marker doc)
//   - the seller's own views never count
//   - per-IP cap of IP_HOURLY_MAX counted views per hour across all listings
//   - per-IP-per-listing cap of IP_LISTING_DAILY_MAX per UTC day, so one
//     household / NAT / script can't pump a single listing
// Storage: the same listing-doc write the sharded all-time counter already
// does (views_0..views_9), plus a rolling day-bucket map
//   viewDays: {"20261119": 5, ...}   (last KEEP_DAYS UTC days only)
//   views7d:  number                  (sum at write time, convenience only)
// The client sums the last 7 days of viewDays itself, so counts decay on
// their own with no scheduler. Both listings onUpdate triggers
// (onListingPriceUpdate, moderateListingOnUpdate) already early-exit on
// counter-only writes; this adds no new trigger work.
const crypto = require("crypto");

const DEDUPE_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 8;
const WINDOW_DAYS = 7;
const IP_HOURLY_MAX = 120;
const IP_LISTING_DAILY_MAX = 3;
const SHARDS = 10;
const ANON_RE = /^[A-Za-z0-9_-]{16,64}$/;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** UTC day key YYYYMMDD. */
function dayKey(ms) {
  const d = new Date(ms);
  return String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0");
}

/** Day keys for the last n UTC days, newest first (today included). */
function lastDays(ms, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dayKey(ms - i * 864e5));
  return out;
}

/** Sum of the last WINDOW_DAYS buckets of a viewDays map. */
function sumWindow(viewDays, ms, n = WINDOW_DAYS) {
  if (!viewDays || typeof viewDays !== "object") return 0;
  return lastDays(ms, n).reduce((s, k) => s + (Math.max(0, Number(viewDays[k]) || 0)), 0);
}

/** Bucket keys older than KEEP_DAYS — deleted on the next counted view. */
function staleKeys(viewDays, ms) {
  if (!viewDays || typeof viewDays !== "object") return [];
  const keep = new Set(lastDays(ms, KEEP_DAYS));
  return Object.keys(viewDays).filter((k) => !keep.has(k));
}

function validAnonId(a) {
  return typeof a === "string" && ANON_RE.test(a);
}

/**
 * Marker doc id. Signed-in viewers keep the pre-r421 id
 * (`${listingId}_${uid}`) so someone counted by incrementListingView in the
 * last 24h isn't counted again after the switch.
 */
function markerId(listingId, uid, anonId) {
  if (uid) return `${listingId}_${uid}`;
  return `${listingId}_a_${sha(anonId).slice(0, 24)}`;
}

/**
 * Core. Injected deps keep it unit-testable:
 *   db          Firestore (Admin) — needs collection().doc() + runTransaction
 *   FieldValue  admin.firestore.FieldValue
 * Returns {counted:boolean, reason?:string, views7d?:number}.
 */
async function recordView({db, FieldValue, listingId, uid, anonId, ip, now}) {
  const t = now || Date.now();
  if (!listingId || typeof listingId !== "string" || listingId.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(listingId)) {
    return {counted: false, reason: "bad-listing"};
  }
  if (!uid && !validAnonId(anonId)) return {counted: false, reason: "no-viewer"};
  const ipKey = sha(ip || "unknown").slice(0, 32);
  const hour = Math.floor(t / 36e5);
  const day = dayKey(t);

  const listingRef = db.collection("listings").doc(listingId);
  const markerRef = db.collection("listingViews").doc(markerId(listingId, uid, anonId));
  const ipRef = db.collection("viewIpLimits").doc(ipKey);
  const ipListRef = db.collection("viewIpLimits").doc(`${ipKey}_${sha(listingId).slice(0, 16)}`);

  return db.runTransaction(async (tx) => {
    const [ls, ms, is, ils] = await Promise.all(
        [tx.get(listingRef), tx.get(markerRef), tx.get(ipRef), tx.get(ipListRef)]);
    if (!ls.exists) return {counted: false, reason: "no-listing"};
    const l = ls.data() || {};
    if (uid && l.sellerId === uid) return {counted: false, reason: "self"};
    const lastMs = ms.exists && ms.data().lastViewedAt && ms.data().lastViewedAt.toMillis ?
      ms.data().lastViewedAt.toMillis() : (ms.exists ? Number(ms.data().lastViewedMs) || 0 : 0);
    if (lastMs && t - lastMs < DEDUPE_MS) return {counted: false, reason: "dedupe"};
    const ipd = is.exists ? is.data() : {};
    const ipHourN = ipd.hour === hour ? Number(ipd.n) || 0 : 0;
    if (ipHourN >= IP_HOURLY_MAX) return {counted: false, reason: "ip-hourly"};
    const ild = ils.exists ? ils.data() : {};
    const ipListN = ild.day === day ? Number(ild.n) || 0 : 0;
    if (ipListN >= IP_LISTING_DAILY_MAX) return {counted: false, reason: "ip-listing"};

    const vd = Object.assign({}, l.viewDays || {});
    vd[day] = (Number(vd[day]) || 0) + 1;
    const views7d = sumWindow(vd, t);
    const shard = Math.floor(Math.random() * SHARDS);
    const upd = {
      [`views_${shard}`]: FieldValue.increment(1),
      [`viewDays.${day}`]: FieldValue.increment(1),
      views7d,
      lastViewedAt: FieldValue.serverTimestamp(),
    };
    for (const k of staleKeys(l.viewDays, t)) upd[`viewDays.${k}`] = FieldValue.delete();
    tx.update(listingRef, upd);
    tx.set(markerRef, {listingId, ...(uid ? {uid} : {anon: true}),
      lastViewedAt: FieldValue.serverTimestamp(), lastViewedMs: t}, {merge: true});
    // expireAt: for a Firestore TTL policy on viewIpLimits (not yet enabled;
    // the docs are tiny and overwritten in place, so growth is one per IP).
    const expireAt = new Date(t + 2 * 864e5);
    tx.set(ipRef, {hour, n: ipHourN + 1, expireAt}, {merge: false});
    tx.set(ipListRef, {day, n: ipListN + 1, expireAt}, {merge: false});
    return {counted: true, views7d};
  });
}

module.exports = {
  recordView, dayKey, lastDays, sumWindow, staleKeys, validAnonId, markerId,
  DEDUPE_MS, KEEP_DAYS, WINDOW_DAYS, IP_HOURLY_MAX, IP_LISTING_DAILY_MAX,
};
