// r182: static per-listing SEO pages + sitemap regeneration (build:web step).
//
// GitHub Pages serves the REPO ROOT, so pages are written to /listing/<id>/
// index.html in the repo (committed like brand/ and reads/). Every ?listing=
// deep link serves the identical SPA shell — query-param URLs can never be
// indexed as distinct pages — so each active listing gets a real static URL
// with unique <title>/meta/OG/Product JSON-LD and a crawlable path from the
// feed cards' <a href> (see .product-name-link in index.html).
//
// Also regenerates sitemap.xml: static base + brand/*.html + reads/*.html +
// generated listing URLs. Reads Firestore via REST using the local gcloud
// ADC token (build runs on the deploy machine). FAIL-SOFT: any error leaves
// the existing pages/sitemap untouched so a network blip can't break builds.
//
// Staleness is accepted (Jake, 2026-07-30): pages regenerate on each
// build/push, not on each listing change — infrastructure so listings are
// born indexable, not a live mirror.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";

const SITE = "https://teeboxmarket.com";
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function fetchActiveListings() {
  const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: "listings" }],
      where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } } },
      limit: 500,
    },
  });
  const out = execSync(
    `curl -s -X POST "https://firestore.googleapis.com/v1/projects/teebox-market/databases/(default)/documents:runQuery" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const rows = JSON.parse(out);
  const listings = [];
  for (const r of rows) {
    const d = r.document;
    if (!d) continue;
    const f = d.fields || {};
    const v = (k) => { const x = f[k] || {}; return x.stringValue ?? x.integerValue ?? x.doubleValue ?? null; };
    const photos = ((f.photos || {}).arrayValue || {}).values || [];
    listings.push({
      id: d.name.split("/").pop(),
      title: v("title") || "Golf gear",
      brand: v("brand") || "",
      cat: v("cat") || "accessories",
      ask: Number(v("ask") || 0),
      condition: v("condition") || "",
      desc: v("desc") || "",
      photo: photos.length ? photos[0].stringValue : null,
    });
  }
  return listings;
}

function listingPage(l) {
  const name = esc(l.title);
  const brand = esc(l.brand);
  const desc = esc((l.desc || `${l.brand} ${l.title} — used golf gear on TeeBox.`).slice(0, 155));
  const url = `${SITE}/listing/${l.id}/`;
  const img = l.photo && /^https:\/\/(firebasestorage\.googleapis\.com|[a-z0-9-]+\.firebasestorage\.app)\//.test(l.photo) ? esc(l.photo) : `${SITE}/icon-512.png`;
  const jsonld = JSON.stringify({
    "@context": "https://schema.org", "@type": "Product",
    name: l.title, ...(l.brand ? { brand: { "@type": "Brand", name: l.brand } } : {}),
    image: l.photo || undefined, description: (l.desc || "").slice(0, 500) || undefined,
    offers: { "@type": "Offer", price: String(l.ask), priceCurrency: "USD",
      availability: "https://schema.org/InStock", url },
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${name}${brand ? ` — ${brand}` : ""} | TeeBox Market</title>
<meta name="description" content="${desc}" />
<link rel="canonical" href="${url}" />
<meta name="theme-color" content="#0b1a0e" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta property="og:type" content="product" />
<meta property="og:site_name" content="TeeBox" />
<meta property="og:title" content="${name}${brand ? ` — ${brand}` : ""}" />
<meta property="og:description" content="${desc}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${img}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${name}" />
<meta name="twitter:image" content="${img}" />
<script type="application/ld+json">${jsonld}</script>
<style>
  :root { --green-950:#0b1a0e; --green-900:#122016; --green-600:#2d5438; --green-700:#22402b;
    --gold-400:#e0b840; --cream:#faf8f3; --gray-500:#7a7a72; --gray-900:#1c1c18; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'DM Sans',system-ui,sans-serif; background:var(--cream); color:var(--gray-900); line-height:1.6; }
  header { background:var(--green-950); padding:1rem 1.4rem; }
  header a { color:#fff; font-family:Georgia,serif; font-weight:900; font-size:1.4rem; text-decoration:none; }
  header a span { color:var(--gold-400); }
  main { max-width:640px; margin:0 auto; padding:1.5rem 1.2rem 3rem; }
  img.photo { width:100%; border-radius:14px; background:#eee; }
  .brand { text-transform:uppercase; letter-spacing:1px; font-size:12px; color:var(--gray-500); font-weight:700; margin-top:1.2rem; }
  h1 { font-family:Georgia,serif; font-size:1.6rem; line-height:1.25; margin:4px 0 8px; }
  .price { font-family:Georgia,serif; font-size:2rem; font-weight:800; }
  .cond { display:inline-block; background:#eaf5ee; color:var(--green-700); border-radius:50px; padding:3px 12px; font-size:12px; font-weight:600; margin-left:10px; vertical-align:middle; }
  p.desc { margin:1rem 0 1.5rem; color:#3c3c38; }
  .cta { display:block; text-align:center; background:var(--green-600); color:#fff; border-radius:10px; padding:14px; font-weight:800; font-size:16px; text-decoration:none; }
  .fine { font-size:12px; color:var(--gray-500); text-align:center; margin-top:10px; }
</style>
</head>
<body>
<header><a href="/"><span>Tee</span>Box</a></header>
<main>
  ${l.photo ? `<img class="photo" src="${img}" alt="${name}" width="600" height="600" />` : ""}
  ${brand ? `<div class="brand">${brand}</div>` : ""}
  <h1>${name}</h1>
  <div class="price">$${Number(l.ask).toLocaleString()}${l.condition ? `<span class="cond">${esc(l.condition)}</span>` : ""}</div>
  ${l.desc ? `<p class="desc">${esc(l.desc.slice(0, 600))}</p>` : ""}
  <a class="cta" href="/?listing=${l.id}">View &amp; buy on TeeBox &rarr;</a>
  <div class="fine">Stripe-secured checkout &middot; buyer protection &middot; 6.5% seller fee</div>
</main>
</body>
</html>
`;
}

function buildSitemap(listings) {
  const urls = [
    { loc: `${SITE}/`, cf: "daily", pr: "1.0" },
    { loc: `${SITE}/bingo.html`, cf: "daily", pr: "0.7" },
    { loc: `${SITE}/privacy.html`, cf: "monthly", pr: "0.3" },
  ];
  for (const f of readdirSync("brand").filter((x) => x.endsWith(".html")).sort()) {
    urls.push({ loc: `${SITE}/brand/${f.replace(/\.html$/, "")}`, cf: "daily", pr: "0.8" });
  }
  for (const f of readdirSync("reads").filter((x) => x.endsWith(".html") && x !== "index.html").sort()) {
    urls.push({ loc: `${SITE}/reads/${f}`, cf: "weekly", pr: "0.7" });
  }
  urls.push({ loc: `${SITE}/reads/`, cf: "weekly", pr: "0.6" });
  for (const l of listings) {
    urls.push({ loc: `${SITE}/listing/${l.id}/`, cf: "daily", pr: "0.9" });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.cf}</changefreq>\n    <priority>${u.pr}</priority>\n  </url>`).join("\n") +
    `\n</urlset>\n`;
}

try {
  const listings = fetchActiveListings();
  if (!listings.length) throw new Error("zero active listings returned — refusing to wipe pages");
  if (existsSync("listing")) rmSync("listing", { recursive: true });
  for (const l of listings) {
    mkdirSync(`listing/${l.id}`, { recursive: true });
    writeFileSync(`listing/${l.id}/index.html`, listingPage(l));
  }
  writeFileSync("sitemap.xml", buildSitemap(listings));
  console.log(`✓ ${listings.length} listing pages + sitemap.xml (${listings.length} listing URLs + brand + reads)`);
} catch (e) {
  console.warn(`⚠ listing-page generation skipped (${e.message}) — existing pages/sitemap left untouched`);
}
