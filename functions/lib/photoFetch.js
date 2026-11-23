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
//   - 10 s total timeout
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
const IMAGE_TYPES = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "image/heic": "heic", "image/heif": "heif"};

/** Is this IP address publicly routable? (false for private, loopback, link-local, CGNAT, multicast, reserved, v4-mapped private) */
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false; // TEST-NET-2
    if (a === 203 && b === 0) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (/^::ffff:/.test(x)) return false;
    if (/^f[cd]/.test(x)) return false; // unique local fc00::/7
    if (/^fe[89ab]/.test(x)) return false; // link-local fe80::/10
    if (/^ff/.test(x)) return false; // multicast
    if (/^2001:db8:/.test(x)) return false; // documentation
    if (/^(64:ff9b|2002):/.test(x)) return false; // NAT64 / 6to4 can embed private v4
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

function getOnce(u, addr, deadline) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: addr.address, family: addr.family, servername: u.hostname, port: 443,
      path: u.pathname + u.search, method: "GET",
      headers: {"Host": u.host, "User-Agent": "TeeBox-PhotoFetch/1.0", "Accept": "image/*"},
      timeout: Math.max(1, deadline - Date.now()),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({redirect: res.headers.location || ""});
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`the link returned HTTP ${res.statusCode}`)); }
      const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES[type]) { res.resume(); return reject(new Error("the link is not a JPEG, PNG, WebP, GIF or HEIC image")); }
      const len = Number(res.headers["content-length"] || 0);
      if (len > MAX_BYTES) { res.destroy(); return reject(new Error("the photo is larger than 15 MB")); }
      const chunks = []; let total = 0;
      res.on("data", (c) => {
        total += c.length;
        if (total > MAX_BYTES) { res.destroy(new Error("the photo is larger than 15 MB")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({buffer: Buffer.concat(chunks), contentType: type}));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the link took too long to respond")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Download one photo URL with the SSRF guards above.
 * @return {Promise<{buffer: Buffer, contentType: string, ext: string}>} throws Error with a seller-readable message
 */
async function fetchPhoto(raw, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs || TIMEOUT_MS);
  let c = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!c.ok) throw new Error(c.reason);
    const addr = await resolvePublic(c.url.hostname, opts.lookup);
    if (!addr) throw new Error("that address is not allowed");
    const r = await getOnce(c.url, addr, deadline);
    if (r.redirect !== undefined) {
      let next;
      try { next = new URL(r.redirect, c.url).toString(); } catch (_e) { throw new Error("the link redirected somewhere invalid"); }
      c = checkUrl(next);
      continue;
    }
    return {buffer: r.buffer, contentType: r.contentType, ext: IMAGE_TYPES[r.contentType]};
  }
  throw new Error("the link redirected too many times");
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

module.exports = {fetchPhoto, storeListingPhoto, checkUrl, isPublicIp, resolvePublic, MAX_BYTES};
