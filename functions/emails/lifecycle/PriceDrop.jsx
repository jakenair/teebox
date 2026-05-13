/**
 * PriceDrop — FULLY BUILT
 * Fires when a watched listing drops by >= 10%.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Row, Column, Img, Text} = require("@react-email/components");

function PriceDrop({user = {}, listing = {}}) {
  const oldPrice = (Number(listing.previousPriceCents || 0) / 100).toFixed(2);
  const newPrice = (Number(listing.priceCents || 0) / 100).toFixed(2);
  const pctDrop =
    listing.previousPriceCents && listing.priceCents
      ? Math.round(
          ((listing.previousPriceCents - listing.priceCents) /
            listing.previousPriceCents) *
            100,
      )
      : null;
  const url = `https://teeboxmarket.com/listing/${listing.id || ""}`;

  return (
    <Base
      preview={`${listing.title} just dropped to $${newPrice}.`}
      uid={user.uid}
      category="priceDrops"
    >
      <H1>Price drop on your watchlist</H1>
      <Section style={{margin: "0 0 16px"}}>
        <Row>
          {listing.imageUrl ? (
            <Column style={{width: "120px"}}>
              <Img
                src={listing.imageUrl}
                alt={listing.title}
                style={{
                  width: "104px",
                  height: "104px",
                  borderRadius: "6px",
                  objectFit: "cover",
                }}
              />
            </Column>
          ) : null}
          <Column>
            <Text style={{margin: 0, fontSize: "16px", fontWeight: "600"}}>
              {listing.title}
            </Text>
            <Text style={{margin: "8px 0 0", fontSize: "15px"}}>
              <span
                style={{
                  textDecoration: "line-through",
                  color: "#9ca3af",
                  marginRight: "8px",
                }}
              >
                ${oldPrice}
              </span>
              <strong style={{color: "#15803d"}}>${newPrice}</strong>
              {pctDrop ? (
                <span style={{color: "#15803d", marginLeft: "8px"}}>
                  ({pctDrop}% off)
                </span>
              ) : null}
            </Text>
          </Column>
        </Row>
      </Section>
      <Button href={url}>View listing</Button>
      <P muted>
        TeeBox listings are one-of-a-kind. If you want it, don't sit on it.
      </P>
    </Base>
  );
}

module.exports = PriceDrop;
module.exports.subject = (ctx) => {
  const title = (ctx.listing && ctx.listing.title) || "Item";
  return `Price drop: ${title}`.slice(0, 50);
};
