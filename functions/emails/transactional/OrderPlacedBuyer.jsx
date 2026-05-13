const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Row, Column, Text, Img} = require("@react-email/components");

function OrderPlacedBuyer({order = {}, buyer = {}, listing = {}}) {
  const orderId = order.id || "—";
  const total = formatUsd(order.amountCents);
  const title = listing.title || "your item";
  const orderUrl = `https://teeboxmarket.com/orders/${orderId}`;

  return (
    <Base
      preview={`Order confirmed: ${title}. Seller has 3 business days to ship.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Order confirmed</H1>
      <P>
        Thanks, {buyer.firstName || "golfer"}. Your order for <strong>{title}</strong>{" "}
        is locked in. The seller has 3 business days to ship it with tracking.
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
              Order #{orderId.slice(0, 8)}
            </Text>
            <Text style={{margin: "4px 0 0", fontSize: "16px", fontWeight: "600"}}>
              {title} — {total}
            </Text>
          </Column>
          {listing.imageUrl ? (
            <Column style={{width: "80px"}}>
              <Img
                src={listing.imageUrl}
                alt={title}
                style={{width: "72px", height: "72px", borderRadius: "4px", objectFit: "cover"}}
              />
            </Column>
          ) : null}
        </Row>
      </Section>
      <Button href={orderUrl}>View order</Button>
      <P muted>
        Funds are held by TeeBox until you confirm the item arrived as described.
        You have 3 days after delivery to open a dispute if anything's off.
      </P>
    </Base>
  );
}

function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = OrderPlacedBuyer;
module.exports.subject = (ctx) =>
  `Order confirmed — ${(ctx.listing && ctx.listing.title) || "TeeBox"}`.slice(0, 50);
