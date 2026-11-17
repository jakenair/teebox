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
const TIKTOK_FEED_TOKEN = defineSecret("TIKTOK_FEED_TOKEN");

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
  shafts: "499780",    // … > Golf Club Parts & Accessories > Golf Club Shafts (r417)
};
const PRODUCT_TYPE = {
  clubs: "Golf > Clubs",
  bags: "Golf > Bags",
  balls: "Golf > Balls",
  headcovers: "Golf > Headcovers",
  accessories: "Golf > Accessories",
  apparel: "Golf > Apparel",
  shoes: "Golf > Shoes",
  shafts: "Golf > Shafts",
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

/**
 * Sellers sometimes edit a status into the title ("… (sold)", "SOLD -",
 * "PENDING"). `availability` already carries that, and Meta rejects titles
 * that contradict it, so strip the marker wherever it sits.
 * @param {string} t title
 * @return {string}
 */
function stripStatusMarkers(t) {
  return String(t || "")
      // bracketed anywhere, any case: "(sold)", "[SOLD]", "(sale pending)"
      .replace(/\s*[\(\[\{]\s*(?:sale\s+)?(?:sold|pending|reserved)\s*[\)\]\}]/gi, "")
      // bare word at the start/end: only when SHOUTED or set off by a dash
      // or colon, so brand-ish titles like "Sold Out Golf Co. polo" survive.
      .replace(/^\s*(?:SOLD|PENDING|RESERVED)\b\s*[-–—:]?\s*/, "")
      .replace(/^\s*(?:sold|pending|reserved)\s*[-–—:]\s*/i, "")
      .replace(/\s*[-–—:]?\s*\b(?:SOLD|PENDING|RESERVED)\s*$/, "")
      .replace(/\s*[-–—:]\s*(?:sold|pending|reserved)\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
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
const SOLD_KEEP_DAYS = 30;
function millis(v) {
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return typeof v === "number" ? v : 0;
}
/**
 * @param {object} l listing
 * @param {number} [now] epoch ms (tests)
 * @return {boolean}
 */
function feedEligibleStatus(l, now) {
  if (l.status === "active" || l.status === "pending") return true;
  if (l.status === "sold") {
    const at = millis(l.soldAt);
    return at > 0 && (now || Date.now()) - at <= SOLD_KEEP_DAYS * 864e5;
  }
  return false;
}

function feedRow(l, testSellers, now, opts) {
  if (!l || !l.id) return null;
  // 2026-11-15 (Jake, replaces the 2026-10-26 active-only rule): every
  // listing a buyer can view stays in the catalog so its ViewContent /
  // AddToCart / InitiateCheckout / Purchase content_id matches. Active =
  // "in stock"; pending (reserved at checkout) and sold within the last
  // SOLD_KEEP_DAYS = "out of stock" (Meta never advertises out-of-stock rows).
  // Removed (seller/moderation) and deleted listings never appear.
  if (!feedEligibleStatus(l, now)) return null;
  // 2026-11-09 (Jake): QA/test listings never reach the catalog — neither a
  // listing flagged isTest nor anything from a test seller (flags can lag
  // the listing by seconds; the seller check covers that window).
  if (require("./lib/testAccounts").isTestListingDoc(l, l.id)) return null;
  if (testSellers && l.sellerId && testSellers.has(l.sellerId)) return null;
  let photos = Array.isArray(l.photos) ? l.photos.map(httpsImage).filter(Boolean) : [];
  // 2026-11-15 (TikTok): image_link must be a JPG or PNG. Lead with the first
  // jpg/png photo; a listing with none keeps its order (TikTok may reject it).
  if (opts && opts.jpgFirst) {
    const isJpgPng = (u) => /\.(jpe?g|png)$/i.test(decodeURIComponent(String(u).split("?")[0]));
    const i = photos.findIndex(isJpgPng);
    if (i > 0) photos = [photos[i]].concat(photos.filter((_, k) => k !== i));
  }
  if (!photos.length) return null; // Meta rejects rows without image_link
  const ask = Number(l.ask);
  if (!Number.isFinite(ask) || ask <= 0) return null;
  const cat = String(l.cat || "accessories").toLowerCase();
  const title = stripStatusMarkers(plainText(l.title, TITLE_MAX)) || "Golf gear";
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
    // /?listing=<id> is index.html, so it is always HTTP 200 and opens the
    // listing (web router). The static /listing/<id>/ pages only exist for
    // listings present at the last build, so newer ones 404'd for Meta's
    // crawler (2026-11-12: 29 of 55).
    link: `${SITE}/?listing=${encodeURIComponent(String(l.id))}`,
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
function buildFeedCsv(listings, testSellers, now, opts) {
  const out = [COLUMNS.join(",")];
  let rows = 0;
  let skipped = 0;
  for (const l of listings || []) {
    const r = feedRow(l, testSellers, now, opts);
    if (!r) {
      skipped++;
      continue;
    }
    out.push(COLUMNS.map((c) => csvCell(r[c])).join(","));
    if (++rows >= MAX_ROWS) break;
  }
  return {csv: out.join("\r\n") + "\r\n", rows, skipped};
}

/**
 * Meta CSV -> TikTok CSV: only the key column's header differs (id -> sku_id).
 * @param {string} csv from buildFeedCsv
 * @return {string}
 */
function toTikTokCsv(csv) {
  return String(csv).replace(/^id,/, "sku_id,");
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
const _caches = {}; // per feed name: {at, csv, rows}

async function loadListings() {
  const db = admin.firestore();
  const snap = await db.collection("listings")
      .where("status", "==", "active")
      .orderBy("createdAt", "desc")
      .limit(MAX_ROWS)
      .get();
  // 2026-11-15: plus reserved and recently sold rows (out of stock). Small
  // sets; the 30-day sold window is applied in feedEligibleStatus.
  const [pending, sold] = await Promise.all([
    db.collection("listings").where("status", "==", "pending").limit(500).get(),
    db.collection("listings").where("status", "==", "sold").limit(2000).get(),
  ]);
  const out = [];
  for (const s of [snap, pending, sold]) s.docs.forEach((d) => out.push({id: d.id, ...d.data()}));
  return out;
}

// Sellers whose listings must never reach the catalog — the shared QA check
// (lib/testAccounts.js, 2026-11-16): flagged users, QA Auth emails
// (incl. jakenair+qa…), fixed QA uids.
async function loadTestSellers() {
  const tl = require("./lib/testAccounts");
  return tl.loadTestUids({db: admin.firestore(), auth: admin.auth()});
}

/**
 * One feed HTTP handler per destination. Each has its own token (Secret
 * Manager), checked in constant time; a wrong or missing token is a 404.
 * @param {object} p
 * @param {object} p.secret     defineSecret(...)
 * @param {string} p.name       log prefix
 * @param {string} p.filename
 * @param {function(string): string} [p.transform] csv -> csv
 * @return {function}
 */
function feedHandler({secret, name, filename, transform, rowOpts}) {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).send("Method not allowed");
      return;
    }
    let expected = "";
    try {
      expected = secret.value() || "";
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
      const _cache = _caches[name] || {at: 0, csv: "", rows: 0};
      if (!_cache.csv || now - _cache.at > CACHE_SECONDS * 1000) {
        const listings = await loadListings();
        const testSellers = await loadTestSellers();
        const built = buildFeedCsv(listings, testSellers, now, rowOpts);
        Object.assign(_cache, {at: now, csv: built.csv, rows: built.rows});
        _caches[name] = _cache;
        logger.info(`${name}: rebuilt`, {rows: built.rows, skipped: built.skipped});
      }
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `inline; filename="${filename}"`);
      res.set("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
      res.set("X-TeeBox-Feed-Rows", String(_cache.rows));
      res.set("X-TeeBox-Feed-Generated", new Date(_cache.at).toISOString());
      const body = transform ? transform(_cache.csv) : _cache.csv;
      res.status(200).send(req.method === "HEAD" ? "" : body);
    } catch (err) {
      logger.error(`${name}: build failed`, err);
      res.status(500).type("text/plain").send("Internal error");
    }
  };
}

const FEED_OPTS = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60,
  maxInstances: 5,
  cors: false,
};

exports.metaFeed = onRequest(
    {...FEED_OPTS, secrets: [META_FEED_TOKEN]},
    feedHandler({secret: META_FEED_TOKEN, name: "metaFeed", filename: "meta-feed.csv"}),
);

// 2026-11-15: TikTok Catalog Manager. Same rows and the same out-of-stock
// rule as metaFeed; only the key column header differs (sku_id), so TikTok
// event content_id = sku_id = Meta id = listing doc id. Own token.
exports.tiktokFeed = onRequest(
    {...FEED_OPTS, secrets: [TIKTOK_FEED_TOKEN]},
    feedHandler({secret: TIKTOK_FEED_TOKEN, name: "tiktokFeed", filename: "tiktok-feed.csv", transform: toTikTokCsv, rowOpts: {jpgFirst: true}}),
);

exports._feed = {
  buildFeedCsv, feedRow, mapCondition,
  TEST_EMAIL_RE: require("./lib/testAccounts").TEST_EMAIL_RE, mapAvailability, plainText, csvCell,
  stripStatusMarkers, COLUMNS, GOOGLE_CATEGORY, feedEligibleStatus, SOLD_KEEP_DAYS, toTikTokCsv,
};
