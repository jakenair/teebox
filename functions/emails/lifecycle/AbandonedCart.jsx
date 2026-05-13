/**
 * AbandonedCart — SCAFFOLDED
 * Sends 48h after an item is added to watchlist if it hasn't been
 * purchased and the price is >= $100.
 *
 * TODO: pull thumbnail + price + seller name.
 * TODO: maybe add "X people viewing" social proof.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function AbandonedCart({user = {}, listing = {}}) {
  const title = listing.title || "the item you've been watching";
  const url = `https://teeboxmarket.com/listing/${listing.id || ""}`;
  return (
    <Base
      preview="Still thinking it over? Here's that listing."
      uid={user.uid}
      category="abandonedCart"
    >
      <H1>Still thinking?</H1>
      <P>
        {/* TODO: real copy */}
        You added <strong>{title}</strong> to your watchlist a couple of days
        ago. Inventory on TeeBox is one-of-a-kind — if you want it, grab it
        before someone else does.
      </P>
      <Button href={url}>View listing</Button>
    </Base>
  );
}

module.exports = AbandonedCart;
module.exports.subject = () => "Still thinking it over?";
