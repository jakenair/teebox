/**
 * functions/sitemapRegenerator.js
 * ─────────────────────────────────────────────────────────────────────────
 * regenerateSitemap — scheduled hourly. Rewrites sitemap.xml from live
 * Firestore listings.
 *
 * Why this exists:
 *   The static `sitemap.xml` at the repo root is hand-curated (45 static
 *   URLs: home + privacy/policy pages + brand landing pages). It has
 *   zero coverage of /listing/<id> pages — see PATH G1 in
 *   LAUNCH_READINESS.md. Every minute a new listing is created without
 *   appearing in the sitemap is a lost crawl opportunity.
 *
 * What it does:
 *   1. Loads the canonical list of static URLs (mirrors the file at
 *      sitemap.xml so a regen never drops the 45 hand-curated entries).
 *   2. Queries up to 5000 most-recent active listings created in the
 *      last 90 days (50K-URL recommendation cap from sitemaps.org; we
 *      stay an order of magnitude below for safety).
 *   3. Emits a well-formed sitemap.xml string with <loc>, <lastmod>,
 *      <changefreq>, <priority>.
 *   4. Writes the output to Firestore at `sitemap/latest`
 *      (`{ xml, generatedAt, listingCount }`). A separate static-host
 *      sync step picks it up from there.
 *
 * Deploy plumbing — UNRESOLVED:
 *   The actual file at https://teeboxmarket.com/sitemap.xml is served
 *   from GitHub Pages today (CNAME → teeboxmarket.com, see CNAME at
 *   repo root). Three live options, none yet chosen:
 *
 *     A. GitHub Pages: a separate CI cron pulls `sitemap/latest` and
 *        commits sitemap.xml to the repo. Pro: zero infra. Con: a commit
 *        per hour.
 *     B. Cloud Storage origin: write to gs://teebox-market.appspot.com/
 *        sitemap.xml with public-read ACL, point a Cloud CDN / DNS
 *        rewrite at it. Pro: real-time, no commits. Con: requires
 *        teeboxmarket.com/sitemap.xml to be re-rooted away from GH
 *        Pages, which breaks the current setup.
 *     C. Hybrid: GH Pages serves a 302 to a Firebase Hosting alias for
 *        /sitemap.xml; the alias pulls from `sitemap/latest`. Pro:
 *        minimal disruption. Con: 302 may hurt crawlers.
 *
 *   See SITEMAP_DEPLOY.md at repo root for the decision matrix +
 *   recommended action.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const SCHEDULED_BATCH = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
};

// 5000 dynamic URLs is well under sitemaps.org's 50 000 recommendation.
// We cap explicitly so a future Firestore-index bug can't blow up the
// payload size (sitemaps.org also caps total uncompressed at 50 MB).
const MAX_LISTING_URLS = 5000;

// 90-day freshness window. Listings older than this typically have low
// crawl value (more likely to be sold-out / stale). Tunable.
const FRESHNESS_DAYS = 90;

// The 45 static URLs mirrored from sitemap.xml @ commit 2072442. Keeping
// them inline is intentional — the regenerator must be the single source
// of truth for sitemap.xml going forward, so a future repo-root edit
// would otherwise drift silently. Update this list in lockstep with any
// new brand landing page added under brand/.
const STATIC_URLS = [
  {loc: "https://teeboxmarket.com/", changefreq: "daily", priority: "1.0"},
  {loc: "https://teeboxmarket.com/bingo.html", changefreq: "daily", priority: "0.7"},
  {loc: "https://teeboxmarket.com/privacy.html", changefreq: "monthly", priority: "0.3"},
  {loc: "https://teeboxmarket.com/brand/scotty-cameron", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/titleist", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/taylormade", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/callaway", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/ping", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/mizuno", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/cobra", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/srixon", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/cleveland", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/odyssey", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/holderness-bourne", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/peter-millar", changefreq: "daily", priority: "0.9"},
  {loc: "https://teeboxmarket.com/brand/scotty-cameron-putters", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/titleist-drivers", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/titleist-irons", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/titleist-wedges", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/titleist-balls", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/taylormade-drivers", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/taylormade-irons", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/taylormade-wedges", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/callaway-drivers", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/callaway-irons", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/ping-drivers", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/ping-irons", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/ping-putters", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/mizuno-irons", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/mizuno-wedges", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/cobra-drivers", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/cobra-irons", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/cleveland-wedges", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/odyssey-putters", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/srixon-balls", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/peter-millar-polos", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/peter-millar-quarter-zips", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/holderness-bourne-polos", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/holderness-bourne-headwear", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/footjoy-shoes", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/footjoy-gloves", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/adidas-shoes", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/nike-shoes", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/used-drivers", changefreq: "daily", priority: "0.8"},
  {loc: "https://teeboxmarket.com/brand/used-putters", changefreq: "daily", priority: "0.8"},
];

/**
 * XML-escape a value for safe insertion inside a <loc> / <lastmod> tag.
 * Sitemap spec requires & < > " ' to be entity-encoded. Listing IDs are
 * Firestore auto-IDs (alphanum) so the practical risk is low — but
 * sellers can put anything in slug-ish fields, so we run the full escape
 * on any user-derived string before it reaches the XML.
 */
function xmlEscape(s) {
  return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
}

/**
 * Build the sitemap XML string. The output is roughly:
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <urlset xmlns="...">
 *     <url><loc>...</loc>...<lastmod>...</lastmod></url>
 *     ...
 *   </urlset>
 */
function buildSitemapXml({staticEntries, listingEntries}) {
  const lines = [];
  lines.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
  lines.push("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");
  for (const e of staticEntries) {
    lines.push("  <url>");
    lines.push(`    <loc>${xmlEscape(e.loc)}</loc>`);
    if (e.changefreq) lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
    if (e.priority) lines.push(`    <priority>${e.priority}</priority>`);
    lines.push("  </url>");
  }
  for (const e of listingEntries) {
    lines.push("  <url>");
    lines.push(`    <loc>${xmlEscape(e.loc)}</loc>`);
    if (e.lastmod) lines.push(`    <lastmod>${xmlEscape(e.lastmod)}</lastmod>`);
    lines.push("    <changefreq>daily</changefreq>");
    lines.push("    <priority>0.6</priority>");
    lines.push("  </url>");
  }
  lines.push("</urlset>");
  return lines.join("\n");
}

/**
 * Convert a Firestore Timestamp / Date / number-millis into a W3C date
 * string the sitemap spec accepts (date-only form preferred for crawler
 * friendliness — full ISO is also valid).
 */
function toLastmod(value) {
  if (!value) return null;
  let d;
  if (typeof value.toDate === "function") d = value.toDate();
  else if (value instanceof Date) d = value;
  else if (typeof value === "number") d = new Date(value);
  else if (typeof value === "string") d = new Date(value);
  else return null;
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

exports.regenerateSitemap = onSchedule(
    {schedule: "every 60 minutes", ...SCHEDULED_BATCH},
    async () => {
      const db = admin.firestore();
      const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 24 * 60 * 60 * 1000);

      let listingEntries = [];
      try {
        // Firestore composite index needed: listings(status ASC, createdAt DESC).
        // The existing firestore.indexes.json already covers status+createdAt
        // queries; if a deploy reports a missing-index error, add a single
        // composite there.
        const snap = await db.collection("listings")
            .where("status", "==", "active")
            .where("createdAt", ">", cutoff)
            .orderBy("createdAt", "desc")
            .limit(MAX_LISTING_URLS)
            .get();
        listingEntries = snap.docs.map((d) => {
          const data = d.data() || {};
          const lastmod = toLastmod(data.updatedAt) || toLastmod(data.createdAt);
          return {
            loc: `https://teeboxmarket.com/?listing=${d.id}`,
            lastmod,
          };
        });
      } catch (err) {
        logger.error("regenerateSitemap: listing query failed", err);
        // Fall through with an empty dynamic set — we still want to
        // refresh the timestamp on the static-only sitemap so monitoring
        // can detect a regen failure (generatedAt would otherwise be
        // stale, but we'd never know if it was a partial vs. full miss).
      }

      const xml = buildSitemapXml({
        staticEntries: STATIC_URLS,
        listingEntries,
      });

      try {
        await db.collection("sitemap").doc("latest").set({
          xml,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
          listingCount: listingEntries.length,
          staticCount: STATIC_URLS.length,
          freshnessDays: FRESHNESS_DAYS,
        });
        logger.info("regenerateSitemap: wrote sitemap/latest", {
          listingCount: listingEntries.length,
          xmlBytes: Buffer.byteLength(xml, "utf8"),
        });
      } catch (err) {
        logger.error("regenerateSitemap: sitemap/latest write failed", err);
      }
    },
);

// ─────────────────────────────────────────────────────────────────
// serveSitemap — HTTPS endpoint that returns the cached XML from
// Firestore. Wired to /sitemap.xml via Firebase Hosting rewrite in
// firebase.json. This is the single-source-of-truth serving path
// the founder picked (no GitHub Pages CI sync, no Cloud Storage).
//
// URL: https://teebox-market.web.app/sitemap.xml (Firebase Hosting)
// Headers: Content-Type application/xml; Cache-Control public, max-age=3600
//
// Note on cross-domain: teeboxmarket.com is currently on GitHub Pages.
// Until the apex domain is moved to Firebase Hosting, search engines
// reach this sitemap via the absolute URL in robots.txt
// (`Sitemap: https://teebox-market.web.app/sitemap.xml`). The <loc>
// entries inside the XML still point at teeboxmarket.com/?listing=<id>
// — crawlers honor that just fine.
// ─────────────────────────────────────────────────────────────────
const {onRequest} = require("firebase-functions/v2/https");

exports.serveSitemap = onRequest(
    {
      region: "us-central1",
      memory: "256MiB",
      timeoutSeconds: 30,
      maxInstances: 10,
      cors: false,
    },
    async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(405).send("Method not allowed");
        return;
      }
      try {
        const db = admin.firestore();
        const snap = await db.collection("sitemap").doc("latest").get();
        if (!snap.exists) {
          res.status(503).type("text/plain")
              .send("Sitemap not yet generated. The regenerateSitemap " +
                "scheduled function (hourly) seeds this. " +
                "Try again in <=60 minutes.");
          return;
        }
        const data = snap.data() || {};
        const xml = data.xml;
        if (!xml) {
          res.status(503).type("text/plain").send("Sitemap doc exists but xml field is empty");
          return;
        }
        res.set("Content-Type", "application/xml; charset=utf-8");
        res.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
        res.set("X-TeeBox-Sitemap-Generated", String(data.generatedAt?.toMillis?.() || ""));
        res.status(200).send(xml);
      } catch (err) {
        logger.error("serveSitemap: read failed", err);
        res.status(500).type("text/plain").send("Internal error");
      }
    },
);

// Exported for unit testing — both pure builders are safe to call without
// admin SDK in scope.
exports._test = {buildSitemapXml, xmlEscape, toLastmod, STATIC_URLS};
