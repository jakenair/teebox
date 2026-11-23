/**
 * functions/tiktokCatalog.js
 * ─────────────────────────────────────────────────────────────────────────
 * tiktokCatalog — the public TikTok catalog feed and its images (2026-11-23).
 *
 *   GET /feeds/tiktok.csv
 *   GET /feeds/tiktok/img/<listingId>/<hash>.jpg
 *
 * Both are Firebase Hosting rewrites on teebox-market.web.app (teeboxmarket.com
 * is GitHub Pages and cannot proxy). The same paths work on the function URL.
 *
 * WHY NO TOKEN: the first TikTok feed took ?token= and the schedule was saved
 * with the literal placeholder, so TikTok got a 404 every day from 11-17 to
 * 11-22. Every field here is already public on the listing page, so there is
 * nothing for a token to protect. metaFeed and tiktokFeed keep their tokens.
 *
 * WHY THE IMAGE ROUTE: listing photos are stored as WebP behind a
 * ?alt=media&token= URL even when the object is named .jpg. TikTok takes JPG
 * or PNG only. This route serves a real JPEG, at least 500px on each side, at
 * a URL that ends in .jpg. <hash> comes from the photo's URL, so a replaced
 * photo gets a new address and each address can be cached hard.
 *
 * Built from the live listings on each fetch (10 minute cache), so it never
 * needs a schedule of its own. Row rules are metaFeed's feedRow, unchanged.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const {_feed: F} = require("./metaFeed");

const IMG_BASE = "https://teebox-market.web.app/feeds/tiktok/img";
// Named: a gcloud-created function has no storageBucket in FIREBASE_CONFIG.
const BUCKET = "teebox-market.firebasestorage.app";
const CACHE_SECONDS = 600;
const MAX_ROWS = 5000;
const TITLE_MAX = 150;
const MIN_SIDE = 500;
const MAX_SIDE = 1200;
const MAX_EXTRA_IMAGES = 10;

// No ios_url: TikTok wants a custom scheme and the app registers none of its
// own (Info.plist has only the Google and Facebook sign-in schemes).
const COLUMNS = [
  "sku_id", "title", "description", "availability", "condition", "price",
  "link", "image_link", "brand", "additional_image_link",
  "google_product_category", "product_type", "item_group_id",
];
const REQUIRED = COLUMNS.slice(0, 9);

/**
 * Valid Unicode, no emoji, no control or zero-width characters. Keeps the
 * plain trademark signs, which Unicode also counts as pictographs.
 * @param {string} s
 * @return {string}
 */
function cleanText(s) {
  return String(s || "").toWellFormed().normalize("NFC")
      .replace(/(?![©®™])\p{Extended_Pictographic}/gu, "")
      .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0000}-\u{E007F}]/gu, "")
      .replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u20E3\uFE00-\uFE0F\uFEFF\uFFFD]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
}

/** Every cell quoted, quotes doubled. */
function quoted(v) {
  return "\"" + String(v == null ? "" : v).replace(/"/g, "\"\"") + "\"";
}

/** Short, stable id for one photo URL. */
function photoHash(url) {
  return crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 16);
}

/**
 * Object path in our own bucket for a listing photo URL, or "" for anything
 * else. Only listings/ objects: this route must never read other storage.
 * @param {string} url
 * @param {string} bucketName
 * @return {string}
 */
function listingObjectPath(url, bucketName) {
  let u;
  try {
    u = new URL(String(url || ""));
    if (u.protocol !== "https:") return "";
    let p = "";
    if (u.hostname === "firebasestorage.googleapis.com") {
      const m = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (!m || m[1] !== bucketName) return "";
      p = decodeURIComponent(m[2]);
    } else if (u.hostname === "storage.googleapis.com") {
      const pre = `/${bucketName}/`;
      if (!u.pathname.startsWith(pre)) return "";
      p = decodeURIComponent(u.pathname.slice(pre.length));
    } else {
      return "";
    }
    return p.startsWith("listings/") && !p.includes("..") ? p : "";
  } catch (_e) {
    return "";
  }
}

function imageUrl(listingId, photoUrl) {
  return `${IMG_BASE}/${encodeURIComponent(String(listingId))}/${photoHash(photoUrl)}.jpg`;
}

/**
 * One TikTok row, or {skip: reason}.
 * @param {object} l listing with `.id`
 * @param {object} ctx {testSellers, unbuyableSellers, now, bucketName}
 * @return {object}
 */
function tiktokRow(l, ctx) {
  const r = F.feedRow(l, ctx.testSellers, ctx.now, {unbuyableSellers: ctx.unbuyableSellers});
  if (!r) {
    if (!F.feedEligibleStatus(l, ctx.now)) return {skip: `status ${l.status}`};
    if (!(Number(l.ask) > 0)) return {skip: "no price"};
    if (!require("./lib/authReview").authReviewPassed(l)) return {skip: "authenticity review not passed"};
    if (!Array.isArray(l.photos) || !l.photos.length) return {skip: "no photo"};
    return {skip: "test listing or unusable photo"};
  }
  const photos = l.photos.filter((u) => listingObjectPath(u, ctx.bucketName))
      .slice(0, 1 + MAX_EXTRA_IMAGES).map((u) => imageUrl(l.id, u));
  if (!photos.length) return {skip: "no usable photo"};
  const brand = cleanText(r.brand) || "Unbranded";
  const title = cleanText(r.title).slice(0, TITLE_MAX).toWellFormed().trim() || "Golf gear";
  return {row: {
    sku_id: r.id,
    title,
    description: cleanText(r.description) || `${title} on TeeBox, the golfer-to-golfer marketplace.`,
    availability: r.availability,
    condition: r.condition,
    price: r.price,
    link: r.link,
    image_link: photos[0],
    brand,
    additional_image_link: photos.slice(1).join(","),
    google_product_category: r.google_product_category,
    product_type: r.product_type,
    item_group_id: r.item_group_id,
  }};
}

/**
 * Pure CSV builder.
 * @param {Array<object>} listings
 * @param {object} ctx see tiktokRow
 * @return {{csv: string, rows: number, skipped: Object<string, number>}}
 */
function buildTikTokCsv(listings, ctx) {
  const out = [COLUMNS.map(quoted).join(",")];
  const skipped = {};
  const seen = new Set();
  for (const l of listings || []) {
    const t = tiktokRow(l, ctx);
    if (t.skip) {
      skipped[t.skip] = (skipped[t.skip] || 0) + 1;
      continue;
    }
    if (seen.has(t.row.sku_id)) continue;
    seen.add(t.row.sku_id);
    out.push(COLUMNS.map((c) => quoted(t.row[c])).join(","));
    if (seen.size >= MAX_ROWS) break;
  }
  return {csv: out.join("\r\n") + "\r\n", rows: seen.size, skipped};
}

/**
 * Any stored photo → JPEG, no side under 500px, longest side at most 1200px
 * (padded with white when the photo is too narrow, never cropped).
 * @param {Buffer} buf
 * @return {Promise<Buffer>}
 */
async function toFeedJpeg(buf) {
  const sharp = require("sharp");
  const {data, info} = await sharp(buf, {limitInputPixels: 60e6}).rotate()
      .resize({width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true})
      .flatten({background: "#ffffff"})
      .toBuffer({resolveWithObject: true});
  const padX = Math.max(0, MIN_SIDE - info.width);
  const padY = Math.max(0, MIN_SIDE - info.height);
  return sharp(data).extend({
    left: Math.floor(padX / 2), right: Math.ceil(padX / 2),
    top: Math.floor(padY / 2), bottom: Math.ceil(padY / 2),
    background: "#ffffff",
  }).toColourspace("srgb").jpeg({quality: 84}).toBuffer();
}

/** @return {{kind: string, listingId: (string|undefined), hash: (string|undefined)}|null} */
function parsePath(p) {
  const s = String(p || "").replace(/^\/tiktokCatalog(?=\/)/, "");
  if (s === "/feeds/tiktok.csv") return {kind: "csv"};
  const m = s.match(/^\/feeds\/tiktok\/img\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{16})\.jpg$/);
  return m ? {kind: "img", listingId: m[1], hash: m[2]} : null;
}

let _cache = {at: 0, csv: "", rows: 0};

async function serveCsv(req, res) {
  const now = Date.now();
  if (!_cache.csv || now - _cache.at > CACHE_SECONDS * 1000) {
    const listings = await F.loadListings();
    const [testSellers, unbuyableSellers] = await Promise.all([
      F.loadTestSellers(), F.loadUnbuyableSellers(listings)]);
    const built = buildTikTokCsv(listings, {
      testSellers, unbuyableSellers, now, bucketName: BUCKET});
    _cache = {at: now, csv: built.csv, rows: built.rows};
    logger.info("tiktokCatalog: rebuilt", {rows: built.rows, skipped: built.skipped,
      unbuyableSellers: unbuyableSellers.size});
  }
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", "inline; filename=\"tiktok.csv\"");
  // Not cached at the edge: every fetch reaches us, so every fetch is logged.
  // The built CSV is still kept in memory for CACHE_SECONDS.
  res.set("Cache-Control", "no-cache, max-age=0, s-maxage=0");
  res.set("X-TeeBox-Feed-Rows", String(_cache.rows));
  res.set("X-TeeBox-Feed-Generated", new Date(_cache.at).toISOString());
  logger.info("tiktokCatalog: feed served", {status: 200, bytes: Buffer.byteLength(_cache.csv), rows: _cache.rows,
    host: String(req.get("x-forwarded-host") || req.get("host") || ""), path: req.path, method: req.method,
    ua: String(req.get("user-agent") || "").slice(0, 120)});
  res.status(200).send(_cache.csv);
}

function notFound(res) {
  res.set("Cache-Control", "no-store");
  res.status(404).type("text/plain").send("Not found");
}

async function serveImage(route, res) {
  const snap = await admin.firestore().doc(`listings/${route.listingId}`).get();
  const l = snap.exists ? {id: snap.id, ...snap.data()} : null;
  // Same rows as the CSV: nothing removed, expired, hidden or test.
  if (!l || !F.feedEligibleStatus(l) ||
      !require("./lib/authReview").authReviewPassed(l) ||
      require("./lib/testAccounts").isTestListingDoc(l, l.id)) return notFound(res);
  const bucket = admin.storage().bucket(BUCKET);
  const url = (Array.isArray(l.photos) ? l.photos : []).find((u) => photoHash(u) === route.hash);
  const objectPath = url && listingObjectPath(url, bucket.name);
  if (!objectPath) return notFound(res);
  let buf;
  try {
    [buf] = await bucket.file(objectPath).download();
  } catch (e) {
    if (e && e.code === 404) return notFound(res);
    throw e;
  }
  const jpg = await toFeedJpeg(buf);
  res.set("Content-Type", "image/jpeg");
  // One day at the edge, so a listing that is removed stops being served.
  res.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.status(200).send(jpg);
}

// TikTok asks for every image at once (~470 on 2026-11-23): 5 instances x 8
// requests refused 146 of them. 30 x 16 takes the whole catalog in one burst.
exports.tiktokCatalog = onRequest(
    {region: "us-central1", memory: "2GiB", cpu: 2, concurrency: 16,
      timeoutSeconds: 60, maxInstances: 30, cors: false},
    async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(405).send("Method not allowed");
        return;
      }
      const route = parsePath(req.path);
      if (!route) return notFound(res);
      try {
        if (route.kind === "csv") await serveCsv(req, res);
        else await serveImage(route, res);
      } catch (err) {
        logger.error("tiktokCatalog failed", {path: req.path, error: String(err && err.message || err)});
        res.set("Cache-Control", "no-store");
        res.status(500).type("text/plain").send("Internal error");
      }
    });

exports._tiktok = {
  COLUMNS, REQUIRED, IMG_BASE, buildTikTokCsv, tiktokRow, cleanText, quoted, photoHash,
  listingObjectPath, imageUrl, toFeedJpeg, parsePath,
};
