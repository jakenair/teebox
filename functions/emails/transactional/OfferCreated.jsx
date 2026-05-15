/**
 * OfferCreated — emailed to the seller when a buyer submits an offer.
 * Replaces a legacy `emailShell` render in index.js notifyOnOfferCreated.
 *
 * Offers UI is hidden in v1 via `[data-feature="offers"]{display:none}`
 * (index.html:209) so this email rarely fires in practice — migrating
 * anyway for compliance hygiene and so the template is ready when offers
 * are unhidden.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Row, Column, Text} = require("@react-email/components");

function OfferCreated({seller = {}, buyer = {}, listing = {}, offer = {}}) {
  const sellerFirst = seller.firstName || seller.displayName || "there";
  const buyerName = buyer.displayName || "A buyer";
  const listingTitle = listing.title || "your listing";
  const amount = Number(offer.amount || 0);
  const offerId = offer.id || "";
  const offerUrl = `https://teeboxmarket.com/?offer=${offerId}`;

  return (
    <Base
      preview={`${buyerName} offered $${amount.toLocaleString()} on ${listingTitle}.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>New offer: ${amount.toLocaleString()}</H1>
      <P>
        Hi {sellerFirst} — <strong>{buyerName}</strong> just offered{" "}
        <strong>${amount.toLocaleString()}</strong> on{" "}
        <strong>{listingTitle}</strong>.
      </P>
      <Section
        style={{
          backgroundColor: "#f5f7f6",
          padding: "16px",
          borderRadius: "6px",
          margin: "16px 0",
        }}
      >
        <Row>
          <Column>
            <Text style={{margin: 0, fontSize: "13px", color: "#6b7280"}}>
              Offer on {listingTitle}
            </Text>
            <Text style={{margin: "4px 0 0", fontSize: "16px", fontWeight: "600"}}>
              ${amount.toLocaleString()} from {buyerName}
            </Text>
          </Column>
        </Row>
      </Section>
      <Button href={offerUrl}>Review offer</Button>
      <P muted>
        Open the app to accept, decline, or counter. Offers expire after the
        buyer revokes them or the listing is sold.
      </P>
    </Base>
  );
}

module.exports = OfferCreated;
module.exports.subject = (ctx) => {
  const t = (ctx.listing && ctx.listing.title) || "your listing";
  return `New offer on ${t}`.slice(0, 50);
};
