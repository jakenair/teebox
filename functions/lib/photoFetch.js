"use strict";
// Fetch a seller-supplied photo URL safely (CSV "photo_urls" column, seller
// API). Seller Integrations Phase 0, 2026-11-17.
//
// The server fetching a URL a user typed is a classic SSRF hole: the URL can
// point at the metadata server (169.254.169.254), localhost, or an internal
// address. Guards:
//   - https only, default port only, no credentials in the URL
//   - the hostname is resolved ONCE, every address must be public, and the
//     connection is pinned to the vetted address (no DNS-rebinding window)
//   - redirects are followed by hand (max 3), each hop re-vetted
//   - 15 MB cap enforced while streaming; image content types only
//   - 10 s for the whole download (DNS, every redirect, the body), by a timer
//     that closes the connection; nothing is ever drained in the background
//   - the bytes must decode as an image (lib/imageConvert checkDecodes), so a
//     file the safety scanner could not read is never stored
// Error text: only PhotoFetchError messages are for sellers. Anything else
// (DNS, sockets, TLS) can name addresses and must not be shown.
// The bytes are then stored at listings/{uid}/{listingId}/… in our bucket,
// where optimizeListingPhoto re-encodes them (EXIF strip, WebP) and runs
// Vision SafeSearch: the same pipeline as an in-app upload.

const dns = require("node:dns").promises;
const net = require("node:net");
const https = require("node:https");
const crypto = require("node:crypto");

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const GENERIC = "the link could not be downloaded";
const IMAGE_TYPES = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "image/heic": "heic", "image/heif": "heif"};

/** An error whose message is safe to show a seller. */
class PhotoFetchError extends Error {}

/** An IPv6 address as 8 numbers, or null. Any spelling, no zone. */
function groups6(ip) {
  if (ip.includes("%")) return null;
  let host;
  try { host = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch (_e) { return null; }
  const [a, b] = host.split("::");
  const left = a ? a.split(":") : [];
  const right = b ? b.split(":") : [];
  const mid = host.includes("::") ? Array(8 - left.length - right.length).fill("0") : [];
  const g = [...left, ...mid, ...right].map((x) => parseInt(x, 16));
  return g.length === 8 && g.every((x) => x >= 0 && x <= 0xffff) ? g : null;
}

/** Is this IP address publicly routable? (false for private, loopback, link-local, CGNAT, multicast, reserved, v4-mapped private) */
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false; // TEST-NET-2
    if (a === 203 && b === 0) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (net.isIPv6(ip)) {
    const g = groups6(ip);
    if (!g) return false;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) { // v4-mapped: judged as the v4 address
      return isPublicIp([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join("."));
    }
    // Only global unicast (2000::/3), minus the special ranges inside it.
    if (g[0] < 0x2000 || g[0] > 0x3fff) return false;
    if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23: Teredo, ORCHID, benchmarking
    if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
    if (g[0] === 0x2002) return false; // 6to4 can embed a private v4
    if (g[0] === 0x3fff && g[1] < 0x1000) return false; // documentation
    return true;
  }
  return false;
}

/** Parse and pre-check a URL. @return {{ok: boolean, url?: URL, reason?: string}} */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (_e) { return {ok: false, reason: "not a valid URL"}; }
  if (u.protocol !== "https:") return {ok: false, reason: "photo links must start with https://"};
  if (u.username || u.password) return {ok: false, reason: "links with a username or password are not allowed"};
  if (u.port && u.port !== "443") return {ok: false, reason: "links on a non-standard port are not allowed"};
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicIp(host)) return {ok: false, reason: "that address is not allowed"};
  if (/(^|\.)(localhost|internal|local)$/i.test(host)) return {ok: false, reason: "that address is not allowed"};
  return {ok: true, url: u};
}

async function resolvePublic(host, lookup) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return isPublicIp(bare) ? {address: bare, family: net.isIPv6(bare) ? 6 : 4} : null;
  const addrs = await (lookup || dns.lookup)(bare, {all: true});
  if (!addrs || !addrs.length) return null;
  if (!addrs.every((a) => isPublicIp(a.address))) return null; // any private answer = refuse
  return addrs[0];
}

const slow = () => new PhotoFetchError("the link took too long to respond");

/** Reject after the deadline, whatever the promise is doing. */
function before(deadline, promise) {
  let t;
  const late = new Promise((_resolve, reject) => { t = setTimeout(() => reject(slow()), Math.max(1, deadline - Date.now())); });
  return Promise.race([promise, late]).finally(() => clearTimeout(t));
}

function getOnce(u, addr, deadline) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let req = null;
    // Every way out closes the connection.
    const finish = (fn, v) => {
      clearTimeout(timer);
      fn(v);
      if (req) req.destroy();
    };
    const fail = (e) => finish(reject, e);
    req = https.request({
      host: addr.address, family: addr.family, servername: u.hostname, port: 443,
      path: u.pathname + u.search, method: "GET", agent: false,
      headers: {"Host": u.host, "User-Agent": "TeeBox-PhotoFetch/1.0", "Accept": "image/*"},
      timeout: Math.max(1, deadline - Date.now()),
    }, (res) => {
      res.on("error", fail);
      res.on("aborted", () => fail(new PhotoFetchError(GENERIC)));
      if (res.statusCode >= 300 && res.statusCode < 400) return finish(resolve, {redirect: res.headers.location || ""});
      if (res.statusCode !== 200) return fail(new PhotoFetchError(`the link returned HTTP ${res.statusCode}`));
      const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!Object.hasOwn(IMAGE_TYPES, type)) return fail(new PhotoFetchError("the link is not a JPEG, PNG, WebP, GIF or HEIC image"));
      const big = () => fail(new PhotoFetchError("the photo is larger than 15 MB"));
      if (Number(res.headers["content-length"] || 0) > MAX_BYTES) return big();
      const chunks = []; let total = 0;
      res.on("data", (c) => {
        total += c.length;
        if (total > MAX_BYTES) return big();
        chunks.push(c);
      });
      res.on("end", () => finish(resolve, {buffer: Buffer.concat(chunks), contentType: type}));
    });
    // The socket's own timeout only notices silence; this one is the total.
    timer = setTimeout(() => fail(slow()), Math.max(1, deadline - Date.now()));
    req.on("timeout", () => fail(slow()));
    req.on("error", fail);
    req.end();
  });
}

/**
 * Download one photo URL with the SSRF guards above.
 * @return {Promise<{buffer: Buffer, contentType: string, ext: string}>} throws; only PhotoFetchError messages are for sellers
 */
async function fetchPhoto(raw, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs || TIMEOUT_MS);
  let c = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!c.ok) throw new PhotoFetchError(c.reason);
    const addr = await before(deadline, resolvePublic(c.url.hostname, opts.lookup));
    if (!addr) throw new PhotoFetchError("that address is not allowed");
    const r = await getOnce(c.url, addr, deadline);
    if (r.redirect !== undefined) {
      let next;
      try { next = new URL(r.redirect, c.url).toString(); } catch (_e) { throw new PhotoFetchError("the link redirected somewhere invalid"); }
      c = checkUrl(next);
      continue;
    }
    const bad = await (opts.checkDecodes || require("./imageConvert").checkDecodes)(r.buffer);
    if (bad) throw new PhotoFetchError(bad);
    return {buffer: r.buffer, contentType: r.contentType, ext: IMAGE_TYPES[r.contentType]};
  }
  throw new PhotoFetchError("the link redirected too many times");
}

/** The message to show a seller for a fetch failure. */
function sellerMessage(e) { return e instanceof PhotoFetchError ? e.message : GENERIC; }

/**
 * At most `max` requests hold photos in memory at once; the rest wait their
 * turn (holding nothing), and give up after `waitMs`.
 */
function photoSlots(max, waitMs) {
  let used = 0;
  const queue = [];
  const release = () => {
    const next = queue.shift();
    if (next) next(); else used--;
  };
  return async (fn) => {
    if (used < max) used++;
    else {
      await new Promise((resolve, reject) => {
        const go = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => {
          queue.splice(queue.indexOf(go), 1);
          reject(Object.assign(new Error("no photo slot"), {slotsFull: true}));
        }, waitMs);
        queue.push(go);
      });
    }
    try { return await fn(); } finally { release(); }
  };
}

/**
 * Store photo bytes the way the app's uploader does (listings/{uid}/{listingId}/…)
 * and return a Firebase download URL (same shape getDownloadURL() returns).
 */
async function storeListingPhoto({bucket, uid, listingId, index, buffer, contentType, ext}) {
  const token = crypto.randomUUID();
  const path = `listings/${uid}/${listingId}/${Date.now()}_${index}_import.${ext}`;
  await bucket.file(path).save(buffer, {resumable: false, contentType,
    metadata: {contentType, metadata: {firebaseStorageDownloadTokens: token, importedBy: "seller-integrations"}}});
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

module.exports = {fetchPhoto, storeListingPhoto, checkUrl, isPublicIp, resolvePublic, photoSlots, sellerMessage, PhotoFetchError, MAX_BYTES};
