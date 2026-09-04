const React = require("react");
const {
  Base, Button, H1, P, Kicker, ProductRow, Receipt, ReceiptRow, InfoBlock,
} = require("../layout/Base");

function OrderPlacedBuyer({order = {}, buyer = {}, listing = {}}) {
  const orderId = order.id || "—";
  const total = formatUsd(order.amountCents);
  const title = listing.title || "your item";
  const orderUrl = `https://teeboxmarket.com/orders/${orderId}`;
  const ship = order.shipping || {};
  const addr = ship.address || null;

  return (
    <Base
      preview={`Order confirmed: ${title}. The seller ships within 3 business days.`}
      uid={buyer.uid}
      category="transactional"
    >
      <Kicker>Order confirmed</Kicker>
      <H1>You&apos;re all set.</H1>
      <P>
        Thanks, {buyer.firstName || "golfer"} — payment went through and we&apos;ve
        told the seller. They&apos;ll ship your <strong>{title}</strong> within{" "}
        <strong>3 business days</strong>, and you&apos;ll get tracking the moment
        it&apos;s on the move.
      </P>

      <ProductRow
        imageUrl={listing.imageUrl}
        name={title}
        desc={listing.condition || listing.brand || null}
        price={total}
      />

      <Receipt>
        <ReceiptRow label="Item" value={total} />
        <ReceiptRow label="Shipping" value="Included" />
        <ReceiptRow label="Total paid" value={total} strong />
      </Receipt>

      {addr ? (
        <InfoBlock label="Shipping to">
          <strong>{ship.name || "You"}</strong>
          <br />
          {[addr.line1, addr.line2].filter(Boolean).join(", ")}
          <br />
          {[addr.city, addr.state, addr.postal_code].filter(Boolean).join(", ")}
        </InfoBlock>
      ) : null}

      <Button href={orderUrl}>View your order</Button>
      <P muted>
        Not as described, or it never ships? Open a dispute from the order page —
        you have 7 days from delivery and we&apos;ll mediate.
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
