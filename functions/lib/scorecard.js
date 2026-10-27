// functions/lib/scorecard.js
//
// Weekly founder scorecard — the seven-ish numbers that say whether TeeBox is
// moving: new accounts, Bingo, Passport (rounds / photos / likes / comments),
// and the marketplace (inventory, sellers, views, offers, conversations,
// orders, GMV). Three windows: this week (last 7 days), prior week, last 30.
//
// Pure data collection + formatting. Used by scripts/scorecard.mjs (CLI, ADC)
// and by the weeklyScorecard scheduled function. Reads aggregates only — no
// PII leaves this module (uids are counted, never returned).

const DAY = 864e5;

function tsMs(v) {
  if (!v) return NaN;
  if (typeof v.toDate === "function") return v.toDate().getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "number") return v;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : NaN;
}

function inWindow(ms, start, end) {
  return Number.isFinite(ms) && ms >= start && ms < end;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {import("firebase-admin/auth").Auth} auth
 * @param {Date} [now]
 * @return {Promise<object>}
 */
async function collectScorecard(db, auth, now = new Date()) {
  const end = now.getTime();
  const windows = {
    week: [end - 7 * DAY, end],
    prior: [end - 14 * DAY, end - 7 * DAY],
    month: [end - 30 * DAY, end],
  };
  const count = (items, getMs) => {
    const out = {};
    for (const [k, [s, e]] of Object.entries(windows)) {
      out[k] = items.filter((x) => inWindow(getMs(x), s, e)).length;
    }
    return out;
  };
  const distinct = (items, getMs, getKey) => {
    const out = {};
    for (const [k, [s, e]] of Object.entries(windows)) {
      out[k] = new Set(items.filter((x) => inWindow(getMs(x), s, e)).map(getKey)).size;
    }
    return out;
  };
  const sum = (items, getMs, getVal) => {
    const out = {};
    for (const [k, [s, e]] of Object.entries(windows)) {
      out[k] = items.filter((x) => inWindow(getMs(x), s, e))
          .reduce((a, x) => a + (Number(getVal(x)) || 0), 0);
    }
    return out;
  };

  // ── Accounts (Auth) ───────────────────────────────────────
  const created = [];
  let pageToken;
  do {
    const r = await auth.listUsers(1000, pageToken);
    r.users.forEach((u) => created.push(Date.parse(u.metadata.creationTime)));
    pageToken = r.pageToken;
  } while (pageToken);

  // ── Bingo ─────────────────────────────────────────────────
  const scores = (await db.collection("gameScores").select("completedAt", "uid").get())
      .docs.map((d) => d.data());

  // ── Passport ──────────────────────────────────────────────
  const rounds = (await db.collectionGroup("played").select("createdAt", "hasPhotos", "photos").get())
      .docs.map((d) => ({uid: d.ref.path.split("/")[1], ...d.data()}));
  const likes = (await db.collectionGroup("likes").select("createdAt").get()).docs.map((d) => d.data());
  const comments = (await db.collectionGroup("comments").select("createdAt").get()).docs.map((d) => d.data());

  // ── Marketplace ───────────────────────────────────────────
  const listings = (await db.collection("listings").select("status", "sellerId", "createdAt").get())
      .docs.map((d) => d.data());
  const active = listings.filter((l) => l.status === "active");
  const views = (await db.collection("listingViews").select("lastViewedAt", "uid").get()).docs.map((d) => d.data());
  const offers = (await db.collection("offers").select("createdAt").get()).docs.map((d) => d.data());
  const convos = (await db.collection("conversations").select("createdAt").get()).docs.map((d) => d.data());
  const orders = (await db.collection("orders").select("createdAt", "amount", "status").get())
      .docs.map((d) => d.data());
  const paid = orders.filter((o) => o.status !== "canceled" && o.status !== "failed");

  const hasPhoto = (r) => r.hasPhotos === true || (Array.isArray(r.photos) && r.photos.length > 0);

  return {
    generatedAt: now.toISOString(),
    windows,
    accounts: {
      total: created.length,
      new: count(created, (t) => t),
    },
    bingo: {
      plays: count(scores, (s) => tsMs(s.completedAt)),
      players: distinct(scores, (s) => tsMs(s.completedAt), (s) => s.uid),
    },
    passport: {
      rounds: count(rounds, (r) => tsMs(r.createdAt)),
      roundsWithPhotos: count(rounds.filter(hasPhoto), (r) => tsMs(r.createdAt)),
      posters: distinct(rounds, (r) => tsMs(r.createdAt), (r) => r.uid),
      likes: count(likes, (l) => tsMs(l.createdAt)),
      comments: count(comments, (c) => tsMs(c.createdAt)),
      totals: {rounds: rounds.length, likes: likes.length, comments: comments.length},
    },
    marketplace: {
      activeListings: active.length,
      activeSellers: new Set(active.map((l) => l.sellerId)).size,
      newListings: count(listings, (l) => tsMs(l.createdAt)),
      listingViews: count(views, (v) => tsMs(v.lastViewedAt)),
      viewers: distinct(views, (v) => tsMs(v.lastViewedAt), (v) => v.uid),
      offers: count(offers, (o) => tsMs(o.createdAt)),
      conversations: count(convos, (c) => tsMs(c.createdAt)),
      orders: count(paid, (o) => tsMs(o.createdAt)),
      gmvDollars: sum(paid, (o) => tsMs(o.createdAt), (o) => o.amount),
      ordersAllTime: paid.length,
    },
  };
}

// orders/{id}.amount is in DOLLARS (verified against the 7 live docs 2026-10-19:
// the $35 polo sale is stored as 35), not Stripe cents.
function usd(dollars) {
  return "$" + Number(dollars || 0).toFixed(2);
}

function delta(a, b) {
  if (!b) return a ? "new" : "–";
  const pct = Math.round(((a - b) / b) * 100);
  return (pct >= 0 ? "+" : "") + pct + "%";
}

/** Rows for a table: [label, week, prior, delta, month]. */
function scorecardRows(sc) {
  const r = (label, obj, fmt = (x) => String(x)) =>
    [label, fmt(obj.week), fmt(obj.prior), delta(obj.week, obj.prior), fmt(obj.month)];
  const m = sc.marketplace; const p = sc.passport;
  return [
    r("New accounts", sc.accounts.new),
    r("Bingo players", sc.bingo.players),
    r("Bingo plays", sc.bingo.plays),
    r("Passport rounds posted", p.rounds),
    r("  …with photos", p.roundsWithPhotos),
    r("Passport posters", p.posters),
    r("Passport likes", p.likes),
    r("Passport comments", p.comments),
    r("New listings", m.newListings),
    r("Listing views", m.listingViews),
    r("Offers", m.offers),
    r("Conversations started", m.conversations),
    r("Orders", m.orders),
    r("GMV", m.gmvDollars, usd),
  ];
}

function formatScorecardMarkdown(sc) {
  const lines = [];
  lines.push(`**Right now:** ${sc.marketplace.activeListings} active listings from ` +
    `${sc.marketplace.activeSellers} sellers · ${sc.accounts.total} accounts · ` +
    `${sc.marketplace.ordersAllTime} orders all-time`);
  lines.push("");
  lines.push("| Metric | This week | Prior week | Δ | Last 30d |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const row of scorecardRows(sc)) lines.push("| " + row.join(" | ") + " |");
  return lines.join("\n");
}

function formatScorecardHtml(sc) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
  const td = (s, right) => `<td style="padding:6px 10px;border-bottom:1px solid #eee;${right ? "text-align:right;" : ""}">${esc(s)}</td>`;
  const rows = scorecardRows(sc).map((r) =>
    `<tr>${td(r[0])}${td(r[1], 1)}${td(r[2], 1)}${td(r[3], 1)}${td(r[4], 1)}</tr>`).join("");
  return `<p style="font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;">` +
    `<b>Right now:</b> ${sc.marketplace.activeListings} active listings from ` +
    `${sc.marketplace.activeSellers} sellers · ${sc.accounts.total} accounts · ` +
    `${sc.marketplace.ordersAllTime} orders all-time</p>` +
    `<table style="border-collapse:collapse;font:13px -apple-system,Helvetica,Arial,sans-serif;">` +
    `<tr><th align="left" style="padding:6px 10px;">Metric</th><th>This week</th><th>Prior</th><th>Δ</th><th>30d</th></tr>` +
    rows + `</table>`;
}

module.exports = {collectScorecard, scorecardRows, formatScorecardMarkdown, formatScorecardHtml, _tsMs: tsMs};
