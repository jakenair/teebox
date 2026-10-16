/**
 * functions/metaFeed.js
 * ─────────────────────────────────────────────────────────────────────────
 * metaFeed — GET /meta-feed.csv  (Meta Commerce / Advantage+ catalog feed)
 *
 * Emits a CSV of marketplace listings in Meta's catalog schema so Commerce
 * Manager can poll it on a schedule and keep a catalog in sync for dynamic
 * product ads. One row per listing document.
 *
 * ROWS: active listings (in stock) PLUS pending/sold ones marked out of
 * stock. Meta's own guidance is to keep a retired item in the feed as
 * "out of stock" rather than dropping the row — a dropped id breaks any ad
 * that still references it and resets its learning. expired / removed /
 * flagged listings and listings with no photo are omitted entirely (they
 * never appeared on the public feed either, see loadListings).
 *
 * AUTH: a long random token in the query string, compared constant-time
 * against the META_FEED_TOKEN secret. The URL is a credential: it goes
 * into Commerce Manager once and nowhere else. No token → 404, not 401, so
 * the endpoint does not advertise itself.
 *
 * CACHING: Cache-Control public, max-age=600 (10 min) and a per-instance
 * memory cache for the same window, so a burst of fetches costs one
 * Firestore read of the collection, not one per hit.
 *
 * SERVING PATH: the function URL directly
 *   https://us-central1-teebox-market.cloudfunctions.net/metaFeed?token=…
 * and, on Firebase Hosting, /meta-feed.csv via the rewrite in firebase.json
 * (teebox-market.web.app). teeboxmarket.com is GitHub Pages and cannot
 * proxy to a function, so give Commerce Manager one of the two above.
 *
 * The CSV builder is pure (no admin SDK) and exported for tests and for
 * the sample-rows script. Keep it that way.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

const META_FEED_TOKEN = defineSecret("META_FEED_TOKEN");

const SITE = "https://teeboxmarket.com";
const CACHE_SECONDS = 600;
const MAX_ROWS = 5000;
const DESC_MAX = 5000;
const TITLE_MAX = 200; // Meta truncates at 200; keep the row honest

const COLUMNS = [
  "id", "title", "description", "availability", "condition", "price",
  "link", "image_link", "additional_image_link", "brand",
  "google_product_category", "product_type", "item_group_id",
];

// Google product taxonomy ids (taxonomy-with-ids.en-US.txt, checked
// 2026-10-16). NOTE: the brief said 1206 for clubs; 1206 is not a golf
// category in Google's list — Golf Clubs is 1046. Apparel uses Activewear
// (5322) because everything listed is performance golf wear; Shoes is the
// top-level Shoes node (187) since Google has no golf-shoe leaf.
const GOOGLE_CATEGORY = {
  clubs: "1046",       // Sporting Goods > Outdoor Recreation > Golf > Golf Clubs
  bags: "1044",        // … > Golf Bags
  balls: "1045",       // … > Golf Balls
  headcovers: "4043",  // … > Golf Club Parts & Accessories > Golf Club Headcovers
  accessories: "1043", // … > Golf (closest honest parent for mixed accessories)
  apparel: "5322",     // Apparel & Accessories > Clothing > Activewear
  shoes: "187",        // Apparel & Accessories > Shoes
};
const PRODUCT_TYPE = {
  clubs: "Golf > Clubs",
  bags: "Golf > Bags",
  balls: "Golf > Balls",
  headcovers: "Golf > Headcovers",
  accessories: "Golf > Accessories",
  apparel: "Golf > Apparel",
  shoes: "Golf > Shoes",
};

/**
 * Our condition labels → Meta's three values. Only "New with Tags" is
 * factory-new; everything else, including "Like New", is pre-owned and
 * Meta's policy is explicit that "used" is the honest value there.
 * @param {string} c listing.condition
 * @return {"new"|"refurbished"|"used"}
 */
function mapCondition(c) {
  const s = String(c || "").trim().toLowerCase();
  if (!s) return "used";
  if (/^new\b|brand new|with tags|nwt|sealed|unopened/.test(s)) return "new";
  if (/refurb/.test(s)) return "refurbished";
  return "used";
}

/**
 * Availability per the brief: active → in stock; pending / sold → out of
 * stock. Quantity is respected for active multi-unit listings.
 * @param {object} l listing
 * @return {"in stock"|"out of stock"}
 */
function mapAvailability(l) {
  if (l.status !== "active") return "out of stock";
  const total = Math.max(1, Number(l.quantity || 1));
  const gone = Math.max(0, Number(l.quantitySold || 0)) +
    Math.max(0, Number(l.quantityReserved || 0));
  return total - gone > 0 ? "in stock" : "out of stock";
}

/** Strip HTML, collapse whitespace, cap length. */
function plainText(s, max) {
  const t = String(s || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Absolute https image URL from our storage, or "" if it is anything else. */
function httpsImage(u) {
  const s = String(u || "");
  return /^https:\/\/(firebasestorage\.googleapis\.com|[a-z0-9-]+\.firebasestorage\.app|storage\.googleapis\.com)\//.test(s) ? s : "";
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

/**
 * One feed row from a listing document, or null to omit it.
 * @param {object} l listing with `.id`
 * @return {object|null} keyed by COLUMNS
 */
function feedRow(l) {
  if (!l || !l.id) return null;
  if (!["active", "pending", "sold"].includes(l.status)) return null;
  const photos = Array.isArray(l.photos) ? l.photos.map(httpsImage).filter(Boolean) : [];
  if (!photos.length) return null; // Meta rejects rows without image_link
  const ask = Number(l.ask);
  if (!Number.isFinite(ask) || ask <= 0) return null;
  const cat = String(l.cat || "accessories").toLowerCase();
  const title = plainText(l.title, TITLE_MAX) || "Golf gear";
  const brand = plainText(l.brand, 70);
  // Fallback when the seller wrote nothing: don't repeat the brand when the
  // title already leads with it ("TaylorMade TaylorMade SIM2 …").
  const lead = brand && !title.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ` : "";
  const description = plainText(l.desc, DESC_MAX) ||
    plainText(`${lead}${title} on TeeBox, the golfer-to-golfer marketplace.`, DESC_MAX);
  return {
    id: String(l.id),
    title,
    description,
    availability: mapAvailability(l),
    condition: mapCondition(l.condition),
    price: ask.toFixed(2) + " USD",
    link: `${SITE}/listing/${encodeURIComponent(String(l.id))}/`,
    image_link: photos[0],
    additional_image_link: photos.slice(1, 11).join(","),
    brand,
    google_product_category: GOOGLE_CATEGORY[cat] || GOOGLE_CATEGORY.accessories,
    product_type: PRODUCT_TYPE[cat] || PRODUCT_TYPE.accessories,
    // Every listing is a one-off; the group is the listing itself. Kept
    // because Meta's schema expects the column for variant-capable feeds.
    item_group_id: String(l.id),
  };
}

/**
 * Pure CSV builder.
 * @param {Array<object>} listings documents with `.id`
 * @return {{csv: string, rows: number, skipped: number}}
 */
function buildFeedCsv(listings) {
  const out = [COLUMNS.join(",")];
  let rows = 0;
  let skipped = 0;
  for (const l of listings || []) {
    const r = feedRow(l);
    if (!r) {
      skipped++;
      continue;
    }
    out.push(COLUMNS.map((c) => csvCell(r[c])).join(","));
    if (++rows >= MAX_ROWS) break;
  }
  return {csv: out.join("\r\n") + "\r\n", rows, skipped};
}

function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Per-instance cache. Cloud Functions instances are recycled often enough
// that this never goes stale past CACHE_SECONDS anyway.
let _cache = {at: 0, csv: "", rows: 0};

async function loadListings() {
  const db = admin.firestore();
  const snap = await db.collection("listings")
      .where("status", "in", ["active", "pending", "sold"])
      .orderBy("createdAt", "desc")
      .limit(MAX_ROWS)
      .get();
  return snap.docs.map((d) => ({id: d.id, ...d.data()}));
}

exports.metaFeed = onRequest(
    {
      region: "us-central1",
      memory: "256MiB",
      timeoutSeconds: 60,
      maxInstances: 5,
      cors: false,
      secrets: [META_FEED_TOKEN],
    },
    async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(405).send("Method not allowed");
        return;
      }
      let expected = "";
      try {
        expected = META_FEED_TOKEN.value() || "";
      } catch (_e) {
        expected = "";
      }
      if (!tokenMatches(req.query && req.query.token, expected)) {
        // Deliberately indistinguishable from a missing route.
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      try {
        const now = Date.now();
        if (!_cache.csv || now - _cache.at > CACHE_SECONDS * 1000) {
          const listings = await loadListings();
          const built = buildFeedCsv(listings);
          _cache = {at: now, csv: built.csv, rows: built.rows};
          logger.info("metaFeed: rebuilt", {rows: built.rows, skipped: built.skipped});
        }
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", "inline; filename=\"meta-feed.csv\"");
        res.set("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
        res.set("X-TeeBox-Feed-Rows", String(_cache.rows));
        res.set("X-TeeBox-Feed-Generated", new Date(_cache.at).toISOString());
        res.status(200).send(req.method === "HEAD" ? "" : _cache.csv);
      } catch (err) {
        logger.error("metaFeed: build failed", err);
        res.status(500).type("text/plain").send("Internal error");
      }
    },
);

exports._feed = {
  buildFeedCsv, feedRow, mapCondition, mapAvailability, plainText, csvCell,
  COLUMNS, GOOGLE_CATEGORY,
};
