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
function ListingLive({user = {}, listing = {}, appUrl}) {
  const title = listing.title || "your item";
  const priceCents = Number(listing.priceCents) || 0;
  const price = priceCents > 0 ?
    `$${(priceCents / 100).toFixed(2)}` :
    "";
  const listingUrl = listing.id ?
    `${appUrl || "https://teeboxmarket.com"}/listing/${listing.id}` :
    (appUrl || "https://teeboxmarket.com");
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
  return t ? `Your listing "${String(t).slice(0, 30)}" is live` : "Your listing is live";
};
