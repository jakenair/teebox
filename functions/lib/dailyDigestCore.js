"use strict";
// What the daily activity digest counts, and how it reads (2026-11-23).
// Every query is a one-day range on one field, or a count() (one read per
// 1,000 documents). No collection is read whole. The email and the
// metrics_daily snapshot hold totals and listing titles, never a person's
// name, email or address.
const {isTestListingDoc, isTestUserDoc} = require("./testAccounts");

const TZ = "America/Chicago";
const TEST_UID = /^(mg_|qa_|pwbuyer_)/;

/** Wall-clock parts of an instant in Central time. */
function ctParts(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", {timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"}).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
/** "YYYY-MM-DD" of an instant in Central time. */
function ctDate(ms) { const p = ctParts(ms); return `${p.year}-${p.month}-${p.day}`; }
/** Midnight Central at the start of a "YYYY-MM-DD", as epoch ms (DST-safe). */
function ctMidnight(date) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  const guess = Date.parse(`${date}T00:00:00Z`);
  for (const h of [5, 6]) { const ms = guess + h * 36e5; const p = ctParts(ms); if (ctDate(ms) === date && p.hour === "00") return ms; }
  throw new Error("no Central midnight for " + new Date(noon).toISOString());
}
/** The calendar day `n` days from a "YYYY-MM-DD". */
function addDays(date, n) { return new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10); }
function dayWindow(date) { return {start: new Date(ctMidnight(date)), end: new Date(ctMidnight(addDays(date, 1)))}; }
function isMonday(date) { return new Date(`${date}T12:00:00Z`).getUTCDay() === 1; }

const n = (v) => Number(v) || 0;
/** Real, live-mode orders only; pure. */
function moneyFrom(orders) {
  const real = orders.filter((o) => o.livemode !== false && !TEST_UID.test(String(o.buyerId || "")) &&
    !TEST_UID.test(String(o.sellerId || "")) && !TEST_UID.test(String(o.listingId || "")));
  const sum = (f) => real.reduce((a, o) => a + n(f(o)), 0);
  const paid = sum((o) => o.amountCents != null ? o.amountCents : o.amount);
  const gmv = sum((o) => o.itemCents != null ? o.itemCents : (o.amountCents != null ? o.amountCents : o.amount));
  return {orders: real.length, gmvCents: gmv, paidCents: paid, shippingCents: sum((o) => o.shippingCents),
    feeCents: sum((o) => o.platformFeeCents), sellerPayoutCents: sum((o) => o.sellerPayoutCents),
    avgOrderCents: real.length ? Math.round(gmv / real.length) : 0};
}

/**
 * @param {object} db Firestore
 * @param {string} date Central day, YYYY-MM-DD
 * @return {Promise<object>} the metrics_daily document (without timestamps)
 */
async function collect(db, date) {
  const {start, end} = dayWindow(date);
  const range = (c, f) => db.collection(c).where(f, ">=", start).where(f, "<", end);
  const count = async (q) => (await q.count().get()).data().count;
  const data = (s) => s.docs.map((d) => ({id: d.id, ...d.data()}));
  const errors = [];
  const safe = async (name, fn, dflt) => { try { return await fn(); } catch (e) { errors.push(`${name}: ${String(e && e.message || e).slice(0, 120)}`); return dflt; } };
  const [orders, refunds, newListings, newUsers, views, conversations, offers, saved, reports, reviews, flagged, holdsNew,
    active, holdsPending, highValueNew, recent, email] = await Promise.all([
    safe("orders", async () => data(await range("orders", "createdAt").get()), []),
    safe("refunds", async () => data(await range("orders", "refundedAt").get()), []),
    safe("listings", async () => data(await range("listings", "createdAt").select("cat", "ask", "sellerId", "isTest", "isTestListing", "title", "status").limit(1000).get()), []),
    safe("users", async () => data(await range("users", "createdAt").select("isTestAccount").limit(2000).get()), []),
    safe("views", async () => data(await range("listingViews", "lastViewedAt").select("listingId", "uid").limit(3000).get()), []),
    safe("conversations", () => count(range("conversations", "createdAt")), null),
    safe("offers", () => count(range("offers", "createdAt")), null),
    safe("savedSearches", () => count(range("savedSearches", "createdAt")), null),
    safe("reports", () => count(range("reports", "createdAt")), null),
    safe("reviews", () => count(range("reviews", "createdAt")), null),
    safe("flagged", () => count(range("flaggedListings", "flaggedAt")), null),
    safe("holds", () => count(range("listingHolds", "createdAt")), null),
    safe("active", () => count(db.collection("listings").where("status", "==", "active")), null),
    safe("holdsPending", () => count(db.collection("listingHolds").where("status", "==", "pending")), null),
    safe("highValueNew", () => count(db.collection("listings").where("authReviewState", "==", "pending").where("status", "==", "active")), null),
    safe("unshipped", async () => data(await db.collection("orders").where("createdAt", ">=", new Date(end.getTime() - 30 * 864e5)).where("createdAt", "<", end)
        .select("status", "createdAt", "shippedAt", "trackingNumber", "livemode", "refundedAt", "buyerId", "sellerId", "listingId", "fulfillmentStatus").get()), []),
    safe("email", async () => { const s = await db.doc(`emailMetrics/${date}`).get(); return s.exists ? s.data() : {}; }, {}),
  ]);
  const listings = newListings.filter((l) => !isTestListingDoc(l, l.id));
  const byCat = {};
  for (const l of listings) byCat[l.cat || "other"] = (byCat[l.cat || "other"] || 0) + 1;
  const realViews = views.filter((v) => !TEST_UID.test(String(v.uid || "")) && !TEST_UID.test(String(v.listingId || "")));
  const per = {};
  for (const v of realViews) if (v.listingId) per[v.listingId] = (per[v.listingId] || 0) + 1;
  const topIds = Object.entries(per).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
  const topDocs = topIds.length ? await safe("top", () => db.getAll(...topIds.map(([id]) => db.doc(`listings/${id}`))), []) : [];
  const top = topDocs.map((d, i) => d.exists ? {id: d.id, title: String(d.data().title || "").slice(0, 80), askCents: Math.round(n(d.data().ask) * 100),
    status: d.data().status || "", views: topIds[i][1]} : null).filter((x) => x && !TEST_UID.test(x.id)).slice(0, 5);
  const now = end.getTime();
  const late = recent.filter((o) => o.livemode !== false && !TEST_UID.test(String(o.sellerId || "")) && !o.shippedAt && !o.trackingNumber &&
    !o.refundedAt && o.status === "paid" && o.createdAt && now - o.createdAt.toMillis() > 3 * 864e5).length;
  return {
    date, tz: TZ,
    money: {...moneyFrom(orders), refunds: refunds.filter((o) => o.livemode !== false).length},
    supply: {newListings: listings.length, byCategory: byCat, askCents: listings.reduce((a, l) => a + Math.round(n(l.ask) * 100), 0),
      sellersListing: new Set(listings.map((l) => l.sellerId)).size, highValue: listings.filter((l) => n(l.ask) >= 300).length, activeListings: active},
    demand: {newUsers: newUsers.filter((u) => !isTestUserDoc(u) && !TEST_UID.test(u.id)).length, listingViews: realViews.length,
      listingsViewed: Object.keys(per).length, conversations, offers, savedSearches: saved},
    health: {ordersUnshippedOver3Days: late, holdsPending, holdsNew, flagged, reports, reviews, highValueToSee: highValueNew,
      emailsSent: n(email.sent), emailsDelivered: n(email.delivered), emailsBounced: n(email.bounced), emailsComplained: n(email.complained)},
    top, errors,
  };
}

/** Seven snapshots → totals; pure. */
function weekly(days) {
  const s = (f) => days.reduce((a, d) => a + n(f(d)), 0);
  return {days: days.length, orders: s((d) => d.money.orders), gmvCents: s((d) => d.money.gmvCents), feeCents: s((d) => d.money.feeCents),
    newListings: s((d) => d.supply.newListings), newUsers: s((d) => d.demand.newUsers), listingViews: s((d) => d.demand.listingViews),
    conversations: s((d) => d.demand.conversations)};
}

const usd = (c) => "$" + (n(c) / 100).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c]));
const num = (v) => v == null ? "not available" : n(v).toLocaleString("en-US");
function niceDate(date) { return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {timeZone: "UTC", weekday: "long", month: "long", day: "numeric"}); }

/**
 * @param {object} m today's snapshot
 * @param {{prev: (object|null), week: (object|null), lastWeek: (object|null), test: (boolean|undefined), partial: (boolean|undefined)}} x
 * @return {{subject: string, html: string, text: string}}
 */
function render(m, x = {}) {
  const p = x.prev || null;
  const delta = (cur, old) => p == null || cur == null || old == null ? "" : `day before: ${typeof old === "string" ? old : num(old)}`;
  const $d = (cur, old) => p == null ? "" : `day before: ${usd(old)}`;
  const cats = Object.entries(m.supply.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  const sections = [
    ["Money", [["GMV (items sold)", usd(m.money.gmvCents), $d(0, p && p.money.gmvCents)], ["Orders", num(m.money.orders), delta(1, p && p.money.orders)],
      ["Paid by buyers, with shipping", usd(m.money.paidCents), ""], ["TeeBox fees", usd(m.money.feeCents), $d(0, p && p.money.feeCents)],
      ["Average order", usd(m.money.avgOrderCents), ""], ["Refunds", num(m.money.refunds), ""]]],
    ["Supply", [["New listings", num(m.supply.newListings), delta(1, p && p.supply.newListings)], ["By category", cats || "none", ""], ["Asking total", usd(m.supply.askCents), ""],
      ["Sellers who listed", num(m.supply.sellersListing), ""], ["New at $300 and up", num(m.supply.highValue), ""], ["Active listings", num(m.supply.activeListings), delta(1, p && p.supply.activeListings)]]],
    ["Demand", [["New members", num(m.demand.newUsers), delta(1, p && p.demand.newUsers)], ["Listing views", num(m.demand.listingViews), delta(1, p && p.demand.listingViews)],
      ["Listings viewed", num(m.demand.listingsViewed), ""], ["Conversations started", num(m.demand.conversations), delta(1, p && p.demand.conversations)], ["Saved searches", num(m.demand.savedSearches), ""]]],
    ["Health", [["Orders not shipped after 3 days", num(m.health.ordersUnshippedOver3Days), ""], ["Listings waiting for review", num(m.health.holdsPending), ""], ["Photo flags", num(m.health.flagged), ""],
      ["Reports", num(m.health.reports), ""], ["New $300 and up to look at", num(m.health.highValueToSee), ""],
      ["Emails sent (UTC day)", num(m.health.emailsSent), ""], ["Bounced / complaints", `${num(m.health.emailsBounced)} / ${num(m.health.emailsComplained)}`, ""]]],
  ];
  if (x.week) {
    const w = x.week, l = x.lastWeek || null;
    const vs = (v, f) => l && l.days === 7 ? `week before: ${f(v)}` : "";
    sections.unshift([`Last week (${w.days} of 7 days on record)`, [["GMV", usd(w.gmvCents), vs(l && l.gmvCents, usd)], ["Orders", num(w.orders), vs(l && l.orders, num)], ["TeeBox fees", usd(w.feeCents), vs(l && l.feeCents, usd)],
      ["New listings", num(w.newListings), vs(l && l.newListings, num)], ["New members", num(w.newUsers), vs(l && l.newUsers, num)], ["Listing views", num(w.listingViews), vs(l && l.listingViews, num)]]]);
  }
  const title = niceDate(m.date);
  const subject = `${x.test ? "[TEST] " : ""}TeeBox daily: ${title}`;
  const row = ([k, v, note]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee9dc;color:#5d665f">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #eee9dc;text-align:right;font-weight:600">${esc(v)}${note ? `<div style="font-weight:400;font-size:12px;color:#5d665f">${esc(note)}</div>` : ""}</td></tr>`;
  const h = (t) => `<h2 style="font:700 18px Georgia,serif;margin:24px 0 4px;color:#1f4827">${esc(t)}</h2>`;
  const table = (rows) => `<table role="presentation" width="100%" style="border-collapse:collapse;font-size:15px">${rows.map(row).join("")}</table>`;
  const top = m.top.length ? m.top.map((t) => [t.title, `${num(t.views)} view${t.views === 1 ? "" : "s"}`, `${usd(t.askCents)}, ${t.status}`]) : [["No listing views", "", ""]];
  const lede = x.partial ? "Today so far, Central time." : "Midnight to midnight, Central time.";
  const problems = m.errors.length ? `${h("Not collected")}<p style="font-size:14px;color:#a3321f">${m.errors.map(esc).join("<br>")}</p>` : "";
  const html = `<div style="background:#faf8f3;padding:24px 16px;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1d2420"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e0d6;border-radius:14px;padding:24px"><h1 style="font:900 24px Georgia,serif;margin:0">${esc(title)}</h1><p style="margin:4px 0 0;color:#5d665f;font-size:14px">${lede}</p>${sections.map(([t, r]) => h(t) + table(r)).join("")}${h("Top listings by views")}${table(top)}${problems}<p style="margin:24px 0 0;font-size:13px;color:#5d665f"><a href="https://teeboxmarket.com/admin/metrics/" style="color:#1f4827">Past days</a></p></div></div>`;
  const text = [title, lede, ...sections.map(([t, r]) => `\n${t}\n` + r.map(([k, v, note]) => `${k}: ${v}${note ? ` (${note})` : ""}`).join("\n")),
    "\nTop listings by views\n" + top.map((r) => r.filter(Boolean).join(", ")).join("\n"), m.errors.length ? "\nNot collected\n" + m.errors.join("\n") : ""].join("\n");
  return {subject, html, text};
}

module.exports = {TZ, ctDate, ctMidnight, addDays, dayWindow, isMonday, moneyFrom, collect, weekly, render};
