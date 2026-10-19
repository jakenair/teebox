const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

/**
 * "Your listing is live" confirmation to the seller, fired by the
 * onListingLive Firestore trigger in ./securityEmailTriggers.js after
 * a listings/{id} document is created with status="active".
 *
 * Distinct from any moderation flow — this is the seller's receipt that
 * their item is now publicly browsable. Idempotent via
 * listings/{id}.listingLiveEmailedAt timestamp.
 */
function ListingLive({user = {}, listing = {}, appUrl, payoutsReady = true, setupUrl}) {
  const base = appUrl || "https://teeboxmarket.com";
  const title = listing.title || "your item";
  const ask = Number(listing.ask) || 0;
  const price = ask > 0 ? `$${ask.toLocaleString()}` : "";
  const listingUrl = listing.id ? `${base}/listing/${listing.id}` : base;
  const setup = setupUrl || `${base}/?payouts=setup`;
  if (!payoutsReady) {
    // LIST-FIRST nudge (a): listing is live but the seller hasn't finished
    // Stripe, so buyers see "Seller is finishing setup" instead of Buy.
    return (
      <Base
        preview={`Your listing "${title}" is live — set up payouts so buyers can purchase.`}
        uid={user.uid}
        category="transactional"
      >
        <H1>Your listing is live</H1>
        <P>
          <strong>{title}</strong>{price ? ` — ${price}` : ""} is now on TeeBox
          and buyers can see it. One step left: set up payouts so they can
          actually purchase it. About 3 minutes — name, address, bank, and a
          quick ID check.
        </P>
        <Button href={setup}>Set up payouts</Button>
        <P muted>
          Until then your listing shows “Seller is finishing setup” instead of
          Buy Now, and we’ll tell you when a buyer asks to be notified.
          Listings without payouts set up are paused after 7 days (not
          deleted) — finishing setup relists them automatically.
        </P>
        <P muted><a href={listingUrl}>View your listing</a></P>
      </Base>
    );
  }
  return (
    <Base
      preview={`Your listing "${title}" is live on TeeBox.`}
      uid={user.uid}
      category="transactional"
    >
      <H1>Your listing is live</H1>
      <P>
        <strong>{title}</strong>{price ? ` — ${price}` : ""} is now live on
        TeeBox and visible to buyers across the marketplace.
      </P>
      <Button href={listingUrl}>View your listing</Button>
      <P muted>
        We'll email you the moment someone buys it, sends an offer, or
        asks a question. Pro tip: respond within an hour to lift your
        seller rank.
      </P>
    </Base>
  );
}

module.exports = ListingLive;
module.exports.subject = (ctx) => {
  const t = ctx && ctx.listing && ctx.listing.title;
  const short = t ? `"${String(t).slice(0, 30)}"` : "";
  if (ctx && ctx.payoutsReady === false) {
    return `Your listing ${short} is live — set up payouts to sell it`.replace("  ", " ");
  }
  return t ? `Your listing ${short} is live` : "Your listing is live";
};
