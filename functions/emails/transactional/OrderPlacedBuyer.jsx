const React = require("react");
const {
  Base, Button, H1, P, Kicker, ProductRow, Receipt, ReceiptRow, InfoBlock,
} = require("../layout/Base");

function OrderPlacedBuyer({order = {}, buyer = {}, listing = {}, claimUrl = null, verifyUrl = null}) {
  const orderId = order.id || "—";
  const total = formatUsd(order.amountCents);
  // Structure 2: amountCents = item + shipping; break the receipt down.
  // Legacy orders (no itemCents) were item-only with shipping included.
  const itemVal = Number.isFinite(order.itemCents)
    ? order.itemCents : order.amountCents;
  const item = formatUsd(itemVal);
  const shipCents = Number.isFinite(order.shippingCents)
    ? order.shippingCents : 0;
  const shippingLine = shipCents > 0 ? formatUsd(shipCents) : "Included";
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
        price={item}
      />

      <Receipt>
        <ReceiptRow label="Item" value={item} />
        <ReceiptRow label="Shipping" value={shippingLine} />
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

      {claimUrl ? (
        <>
          <P>
            You checked out as a guest. Tap below to save this order to a free
            TeeBox account so you can track it, message the seller, and open a
            dispute if anything goes wrong. No password needed.
          </P>
          <Button href={claimUrl}>Track your order</Button>
          <P muted>
            This link signs you in as {order.buyerEmail || "you"}, so don&apos;t
            forward this email. Not as described, or it never ships? Open a
            dispute from the order page within 7 days of delivery and we&apos;ll
            mediate.
          </P>
        </>
      ) : (
        <>
          <Button href={orderUrl}>View your order</Button>
          {verifyUrl ? (
            <P>
              One last thing: <a href={verifyUrl}>confirm your email</a> so order
              updates and messages reach you.
            </P>
          ) : null}
          <P muted>
            Not as described, or it never ships? Open a dispute from the order page —
            you have 7 days from delivery and we&apos;ll mediate.
          </P>
        </>
      )}
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
