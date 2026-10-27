const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

/**
 * LIST-FIRST buyer follow-through: this buyer tapped "tap to get notified"
 * on a listing whose seller hadn't finished payouts. The seller is now
 * charges-ready and the listing is buyable. Sent once per buyer+listing by
 * onSellerChargesReady (functions/lib/listFirstCore.js).
 */
function BuyerListingAvailable({user = {}, listing = {}, sellerName, appUrl}) {
  const base = appUrl || "https://teeboxmarket.com";
  const title = listing.title || "The item you asked about";
  const url = listing.id ? `${base}/listing/${listing.id}` : base;
  const ask = Number(listing.ask) || 0;
  return (
    <Base preview={`${title} is ready to buy on TeeBox.`} uid={user.uid} category="transactional">
      <H1>{title} is ready to buy</H1>
      <P>
        You asked us to let you know — {sellerName || "the seller"} just finished
        setup, so <strong>{title}</strong>{ask ? ` ($${ask.toLocaleString()})` : ""} can
        be purchased now. Grab it before someone else does.
      </P>
      <Button href={url}>View listing</Button>
      <P muted>Every purchase is protected: your payment is held until the item is delivered.</P>
    </Base>
  );
}

module.exports = BuyerListingAvailable;
module.exports.subject = (ctx) => {
  const t = ctx && ctx.listing && ctx.listing.title;
  return t ? `${String(t).slice(0, 40)} is ready to buy` : "The item you asked about is ready to buy";
};
