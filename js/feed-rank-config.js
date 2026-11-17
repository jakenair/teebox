// feed-rank-config.js — the ONE file to tune the "For You" home feed.
//
// Every listing gets a score = sum of (weight × component). Each component is
// roughly 0..1, so a weight reads as "how much this matters". Bump `version`
// whenever you change a number: it is logged with every impression/click
// (PostHog feed_impressions / feed_click) so you can compare before/after.
//
// No ML. The math lives in js/feed-rank.js; nothing in there needs editing to
// change how the feed behaves.
window.TB_FEED_CONFIG = {
  version: 'fy1-2026-11-17',

  weights: {
    fresh: 2.0,       // new listings start high and decay (see freshHalfLifeDays)
    affinity: 2.5,    // signed-in only: matches the buyer's categories/brands/price/flex
    popularity: 0.6,  // likes (watchlistCount), log-scaled
    quality: 1.0,     // penalties only: overpriced, stale, no brand (see quality)
    explore: 1.6,     // seeded random: rotates the whole catalog between visits
    seen: 1.0,        // penalty for listings this device already scrolled past a lot
  },

  // Freshness: 1.0 when just listed, 0.5 after this many days, 0.25 after 2x.
  freshHalfLifeDays: 4,

  popularity: { likesForFull: 8 }, // 8+ likes = full popularity credit

  quality: {
    noBrandPenalty: 0.15,
    // Overpriced: ask vs the AI estimate (listing.priceEstimate.mid when we
    // have one) or, failing that, the median ask of >= minPeers active
    // listings with the same brand AND category. Penalty starts above
    // `ratio` and caps at `maxPenalty`.
    overpriced: { ratio: 1.6, maxPenalty: 1.2, minPeers: 3 },
    // Stale: older than staleDays with zero likes.
    staleDays: 45,
    stalePenalty: 0.4,
  },

  // How much each kind of match counts inside `affinity` (normalized 0..1).
  affinity: { category: 1.0, brand: 1.2, price: 0.7, flex: 0.5 },

  // Signals we log on this device (localStorage, per signed-in user). Weight =
  // how strongly one event says "I want this kind of thing". Older events fade
  // with signalHalfLifeDays.
  signals: {
    view: 1, favorite: 3, message: 3, savedSearch: 2, search: 1.5, cartAdd: 3,
    signalHalfLifeDays: 21,
    maxEvents: 300,
  },

  // Diversity: in any `window` consecutive cards, at most maxPerSeller from one
  // seller and maxPerCategory from one category (relaxed only if nothing else fits).
  diversity: { window: 6, maxPerSeller: 2, maxPerCategory: 3 },

  // Discovery: these card positions (0 = first card) go to listings that
  // would otherwise rank below `fromRank`, least-seen first, rotating every
  // visit. Guarantees older listings get seen. [] turns it off.
  discovery: { slots: [4, 10, 16, 22], fromRank: 24 },

  // Exposure: each time a card is actually seen (>= 50% on screen for 0.6s)
  // without a click, it drops a little on this device, so the rest of the
  // catalog gets a turn. Forgotten after forgetDays.
  exposure: { perImpression: 0.12, maxPenalty: 0.8, forgetDays: 4 },

  // A visit = until 30 min of inactivity; the explore seed changes per visit,
  // never while scrolling.
  visitIdleMinutes: 30,
};
