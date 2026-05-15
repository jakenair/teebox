/**
 * OfferUpdated — emailed to the buyer when the seller accepts, declines,
 * or counters an offer. Replaces a legacy `emailShell` render in
 * index.js notifyOnOfferUpdated.
 *
 * Offers UI is hidden in v1 (see OfferCreated.jsx header) — template is
 * migrated for hygiene + readiness.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function OfferUpdated({
  buyer = {},
  seller = {},
  listing = {},
  offer = {},
  status = "countered",
}) {
  const buyerFirst = buyer.firstName || buyer.displayName || "there";
  const sellerName = seller.displayName || "The seller";
  const listingTitle = listing.title || "the listing";
  const amount = Number(offer.amount || 0);
  const counterAmount = Number(offer.counterAmount || 0);
  const offerId = offer.id || "";
  const offerUrl = `https://teeboxmarket.com/?offer=${offerId}`;

  let headline; let bodyP; let preview;
  if (status === "accepted") {
    headline = `${sellerName} accepted your offer`;
    preview = `Offer accepted on ${listingTitle}. Pay now to lock it in.`;
    bodyP = (
      <P>
        Your <strong>${amount.toLocaleString()}</strong> offer on{" "}
        <strong>{listingTitle}</strong> was accepted. Pay now to lock it in —
        listings are first-come, first-served until the order is paid.
      </P>
    );
  } else if (status === "declined") {
    headline = `${sellerName} passed on your offer`;
    preview = `Offer declined on ${listingTitle}. Try a higher offer or buy at ask.`;
    bodyP = (
      <P>
        Your <strong>${amount.toLocaleString()}</strong> offer on{" "}
        <strong>{listingTitle}</strong> wasn't accepted. The listing is still
        available — try a higher offer or buy at the asking price.
      </P>
    );
  } else {
    headline = `Counter: $${counterAmount.toLocaleString()}`;
    preview = `${sellerName} countered with $${counterAmount.toLocaleString()} on ${listingTitle}.`;
    bodyP = (
      <P>
        {sellerName} countered with{" "}
        <strong>${counterAmount.toLocaleString()}</strong> on{" "}
        <strong>{listingTitle}</strong>. Open the app to accept, decline, or
        counter back.
      </P>
    );
  }

  return (
    <Base
      preview={preview}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>{headline}</H1>
      <P>Hi {buyerFirst},</P>
      {bodyP}
      <Button href={offerUrl}>Open offer</Button>
    </Base>
  );
}

module.exports = OfferUpdated;
module.exports.subject = (ctx) => {
  const t = (ctx.listing && ctx.listing.title) || "your offer";
  const s = ctx.status || "countered";
  if (s === "accepted") return `Offer accepted: ${t}`.slice(0, 50);
  if (s === "declined") return `Offer declined: ${t}`.slice(0, 50);
  return `Counter offer on ${t}`.slice(0, 50);
};
