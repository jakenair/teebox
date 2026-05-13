/**
 * functions/abandonedCartTrigger.js
 * ─────────────────────────────────────────────────────────────────────────
 * Scheduler that fires the AbandonedCart lifecycle email.
 *
 * TeeBox doesn't have a traditional shopping cart — every listing is
 * one-of-one and the closest analogue to a cart is the watchlist (stored
 * as a map at users/{uid}.watchlist, keys = listingId). We treat
 * "abandonment" as a time-based heuristic rather than a doc trigger, since
 * there is no single Firestore mutation that marks a cart as abandoned:
 *
 *   "User has >= 1 active watchlist item worth >= $100, hasn't bought
 *    anything in the last 7 days, and we haven't emailed them an
 *    abandoned-cart in the last 30 days, AND they have GDPR marketing
 *    consent + abandonedCart pref on."
 *
 * Idempotency: stamp users/{uid}.lifecycleEmailsSent.abandonedCart with
 * serverTimestamp() after a successful send, and skip if it's < 30 days old.
 *
 * Consent: sendTemplated -> sendEmail -> preflightAllowed already enforces
 * marketingConsent.granted === true for the "abandonedCart" category (see
 * lib/email.js MARKETING_CATEGORIES). We also pre-filter here so we don't
 * waste reads/writes on users who'll be rejected at the preflight stage.
 *
 * Schedule: daily at 15:00 America/New_York (mid-afternoon EDT/EST). That's
 * outside the morning saved-search digest and the 09:00-UTC abandoned-draft
 * sweep, so we don't hammer the same users with three emails in one window.
 *
 * Wired into deployment via a single `Object.assign(exports, require(...))`
 * line appended to functions/index.js.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const {
  sendEmail,
  CATEGORIES,
  RESEND_API_KEY,
  UNSUBSCRIBE_SECRET,
} = require("./lib/email");

const SCHED_FN = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 540,
};

// Tuning knobs — keep at the top so they're easy to spot during a re-tune.
const MIN_WATCHLIST_VALUE_USD = 100;
const NO_PURCHASE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESEND_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const USER_PAGE_SIZE = 500; // tune for free-tier read quota
const MAX_USERS_PER_RUN = 2000; // cap blast radius if something goes wrong

/** Lazy-loaded JSX template (compiled or raw fallback). */
function getTemplate(category, name) {
  try {
    return require(`./emails-build/${category}/${name}`);
  } catch (e1) {
    try {
      return require(`./emails/${category}/${name}`);
    } catch (e2) {
      logger.warn(`abandonedCart: template ${category}/${name} not loaded`, e2.message);
      return null;
    }
  }
}

/**
 * Render-or-fallback wrapper. Mirrors the pattern in emailTriggers.js so
 * the deploy stays green even if the JSX build step hasn't run yet.
 */
async function sendTemplated({category, templateCategory, templateName, to, uid, ctx = {}, subject: subjectOverride}) {
  const Tpl = getTemplate(templateCategory, templateName);
  let subject = subjectOverride;
  let react = null;
  let html = null;
  if (Tpl) {
    try {
      react = Tpl(ctx);
      if (!subject && typeof Tpl.subject === "function") {
        subject = Tpl.subject(ctx);
      }
    } catch (e) {
      logger.error(`abandonedCart: template instantiation failed: ${templateName}`, e.message);
    }
  }
  if (!react && !html) {
    html = `<!doctype html><html><body><p>TeeBox notification: ${subject || templateName}</p></body></html>`;
  }
  if (!subject) subject = "Still thinking it over?";
  return sendEmail({
    to,
    subject,
    react,
    html,
    category,
    uid,
    template: templateName,
  });
}

/**
 * Has this user purchased anything in the last `windowMs` milliseconds?
 * We check orders.buyerId == uid && createdAt > cutoff with limit(1).
 */
async function userPurchasedRecently(db, uid, windowMs) {
  const cutoff = new Date(Date.now() - windowMs);
  try {
    const snap = await db
        .collection("orders")
        .where("buyerId", "==", uid)
        .where("createdAt", ">", cutoff)
        .limit(1)
        .get();
    return !snap.empty;
  } catch (e) {
    // If the index isn't built or the query fails, fail SAFE (assume
    // recent purchase so we don't accidentally spam someone mid-checkout).
    logger.warn("abandonedCart: purchase-check failed; assuming recent", e.message);
    return true;
  }
}

/**
 * Resolve listing data for the eligible watchlist entries. Returns an
 * array of {id, title, ask, ...} sorted by ask DESC (highest-value first).
 * Filters out inactive/sold/missing listings.
 */
async function resolveWatchlistListings(db, watchlistIds) {
  if (!watchlistIds.length) return [];
  // Cap at 10 lookups per user — paying $100+ for 10 items is more than
  // enough signal, and 10 doc reads/user keeps quota predictable.
  const ids = watchlistIds.slice(0, 10);
  const snaps = await Promise.allSettled(
      ids.map((id) => db.collection("listings").doc(id).get()),
  );
  const listings = [];
  for (const r of snaps) {
    if (r.status !== "fulfilled" || !r.value.exists) continue;
    const data = r.value.data() || {};
    if (data.status && data.status !== "active") continue;
    const ask = Number(data.ask || data.price || 0);
    if (!ask) continue;
    listings.push({id: r.value.id, title: data.title || "Listing", ask, ...data});
  }
  listings.sort((a, b) => b.ask - a.ask);
  return listings;
}

/**
 * Main scheduler. Iterates eligible users in pages, picks the highest-value
 * watchlist item as the email's hero, and stamps lifecycleEmailsSent for
 * idempotency.
 */
exports.abandonedCartScheduler = onSchedule(
    {
      schedule: "0 15 * * *",
      timeZone: "America/New_York",
      secrets: [RESEND_API_KEY, UNSUBSCRIBE_SECRET],
      ...SCHED_FN,
    },
    async () => {
      const db = admin.firestore();
      const cooldownCutoff = Date.now() - RESEND_COOLDOWN_MS;
      let scanned = 0;
      let sent = 0;
      let skippedCooldown = 0;
      let skippedNoEmail = 0;
      let skippedNoConsent = 0;
      let skippedLowValue = 0;
      let skippedRecentPurchase = 0;
      let lastDoc = null;

      while (scanned < MAX_USERS_PER_RUN) {
        let q = db
            .collection("users")
            .where("marketingConsent.granted", "==", true)
            .orderBy("__name__")
            .limit(USER_PAGE_SIZE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get().catch((e) => {
          logger.error("abandonedCart: user page query failed", e.message);
          return null;
        });
        if (!snap || snap.empty) break;
        lastDoc = snap.docs[snap.docs.length - 1];

        for (const u of snap.docs) {
          scanned += 1;
          const user = {uid: u.id, ...u.data()};
          if (!user.email) {
            skippedNoEmail += 1;
            continue;
          }
          // Defense in depth — preflight in lib/email.js will catch this,
          // but checking here saves a read+render+log churn.
          if (!user.marketingConsent || user.marketingConsent.granted !== true) {
            skippedNoConsent += 1;
            continue;
          }
          const prefs = user.emailPrefs || {};
          if (prefs.abandonedCart === false) {
            skippedNoConsent += 1;
            continue;
          }
          // Cooldown check.
          const lastStampRaw =
            user.lifecycleEmailsSent && user.lifecycleEmailsSent.abandonedCart;
          const lastStampMs = lastStampRaw && lastStampRaw.toMillis ?
            lastStampRaw.toMillis() : 0;
          if (lastStampMs > cooldownCutoff) {
            skippedCooldown += 1;
            continue;
          }
          // Watchlist gate: at least one item.
          const watchlistMap = user.watchlist || {};
          const watchlistIds = Object.keys(watchlistMap);
          if (!watchlistIds.length) continue;

          const listings = await resolveWatchlistListings(db, watchlistIds);
          const totalValue = listings.reduce((s, l) => s + (l.ask || 0), 0);
          if (totalValue < MIN_WATCHLIST_VALUE_USD || !listings.length) {
            skippedLowValue += 1;
            continue;
          }

          // Recent-purchase gate.
          const purchased = await userPurchasedRecently(
              db, user.uid, NO_PURCHASE_WINDOW_MS,
          );
          if (purchased) {
            skippedRecentPurchase += 1;
            continue;
          }

          // Hero = highest-value listing. Pass full listings array too so
          // future template revisions can render a grid of all watchlist
          // items if desired.
          const hero = listings[0];
          const ctx = {
            user,
            listing: hero,
            listings,
            totalValue,
            watchlistUrl: "https://teeboxmarket.com/?view=watchlist",
          };

          const result = await sendTemplated({
            category: CATEGORIES.ABANDONED_CART,
            templateCategory: "lifecycle",
            templateName: "AbandonedCart",
            to: user.email,
            uid: user.uid,
            ctx,
          });

          // Only stamp on a real send (not on skip/render-fail). This keeps
          // a user re-eligible next run if e.g. their consent was missing
          // at preflight — we'll catch them after they fix it.
          if (result && result.sent) {
            sent += 1;
            try {
              await db.collection("users").doc(user.uid).set(
                  {
                    lifecycleEmailsSent: {
                      abandonedCart: admin.firestore.FieldValue.serverTimestamp(),
                    },
                  },
                  {merge: true},
              );
            } catch (e) {
              logger.error("abandonedCart: stamp write failed", e.message);
            }
          }

          if (scanned >= MAX_USERS_PER_RUN) break;
        }

        if (snap.size < USER_PAGE_SIZE) break;
      }

      logger.info("abandonedCartScheduler done", {
        scanned,
        sent,
        skippedCooldown,
        skippedNoEmail,
        skippedNoConsent,
        skippedLowValue,
        skippedRecentPurchase,
      });
    },
);

module.exports.__abandonedCartLoaded = true;
