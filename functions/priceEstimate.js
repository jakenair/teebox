"use strict";
// stampListingPriceEstimate (founder GO, 2026-11-17): save the AI price
// estimate on a listing when it is created, so the For You feed's "way
// overpriced" rule (js/feed-rank.js) can compare against it instead of the
// brand+category peer median.
//
// The estimate already exists server-side: draftListingFromPhotos logs every
// draft (incl. price {low, mid, high}) to aiDraftLogs/{id} with the seller's
// uid. Listing create is a client write whose fields are whitelisted by
// firestore.rules (priceEstimate is NOT on the list, so a seller can't set or
// edit it). This trigger links the new listing to that seller's most recent
// UNUSED draft from the last 6 hours with the same category and a matching
// title, copies the price, and marks the draft used.
//
// No AI calls here, and no backfill: listings created without the photo
// assist, or before this shipped, simply have no estimate (the feed falls
// back to the peer median).
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const WINDOW_MS = 6 * 60 * 60 * 1000;
const MIN_TITLE_OVERLAP = 0.5;

const tokens = (s) => String(s || "").toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ").split(" ").filter((t) => t.length >= 2);

/** Share of the draft title's words that appear in the listing title. */
function titleOverlap(draftTitle, listingTitle) {
  const d = [...new Set(tokens(draftTitle))];
  if (!d.length) return 0;
  const l = new Set(tokens(listingTitle));
  return d.filter((t) => l.has(t)).length / d.length;
}

/**
 * Pick the draft log that produced this listing, or null.
 * @param {object} listing listings/{id} data
 * @param {Array<{id: string, data: object}>} logs aiDraftLogs for the seller
 * @param {number} nowMs
 * @return {{id: string, price: {low: number, mid: number, high: number}}|null}
 */
function pickDraft(listing, logs, nowMs) {
  const cat = String(listing.specCategory || "").toLowerCase();
  let best = null;
  for (const {id, data} of logs || []) {
    if (!data || data.consumedBy) continue;
    const at = data.at && typeof data.at.toMillis === "function" ? data.at.toMillis() : Number(data.at) || 0;
    if (!at || nowMs - at > WINDOW_MS || at > nowMs + 60000) continue;
    if (cat && String(data.category || "").toLowerCase() !== cat) continue;
    const d = data.draft || {};
    const p = d.price || {};
    const mid = Math.round(Number(p.mid) || 0);
    if (!(mid > 0)) continue;
    const overlap = titleOverlap(d.title, listing.title);
    if (overlap < MIN_TITLE_OVERLAP) continue;
    if (!best || at > best.at) {
      best = {id, at, price: {
        low: Math.max(0, Math.round(Number(p.low) || 0)),
        mid,
        high: Math.max(0, Math.round(Number(p.high) || 0)),
      }};
    }
  }
  return best ? {id: best.id, price: best.price} : null;
}

exports.stampListingPriceEstimate = onDocumentCreated(
    {document: "listings/{listingId}", region: "us-central1", memory: "256MiB",
      timeoutSeconds: 60, concurrency: 40, maxInstances: 20},
    async (event) => {
      const snap = event.data;
      if (!snap) return;
      const listing = snap.data() || {};
      if (!listing.sellerId || listing.priceEstimate) return;
      const db = admin.firestore();
      const listingId = event.params.listingId;
      try {
        // Equality-only query (no composite index); newest picked in code.
        const q = await db.collection("aiDraftLogs")
            .where("uid", "==", String(listing.sellerId)).limit(50).get();
        const pick = pickDraft(listing, q.docs.map((d) => ({id: d.id, data: d.data()})), Date.now());
        if (!pick) return;
        const logRef = db.collection("aiDraftLogs").doc(pick.id);
        await db.runTransaction(async (tx) => {
          const [l, g] = await Promise.all([tx.get(snap.ref), tx.get(logRef)]);
          // Listing may already be gone (moderation hold deletes it).
          if (!l.exists || !g.exists || (g.data() || {}).consumedBy) return;
          tx.update(snap.ref, {priceEstimate: {...pick.price, source: "photo-assist",
            at: admin.firestore.FieldValue.serverTimestamp()}});
          tx.update(logRef, {consumedBy: listingId});
        });
        logger.info("stampListingPriceEstimate: stamped", {listingId, mid: pick.price.mid});
      } catch (e) {
        logger.warn("stampListingPriceEstimate failed (feed falls back to peer median)",
            {listingId, error: String(e && e.message || e)});
      }
    },
);

exports._priceEstimateTesting = {pickDraft, titleOverlap};
