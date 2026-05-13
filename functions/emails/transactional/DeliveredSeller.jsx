const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function DeliveredSeller({order = {}, seller = {}, listing = {}}) {
  const title = listing.title || "your item";
  const payout = formatUsd(order.sellerPayoutCents);
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;

  return (
    <Base
      preview={`Delivered. Your payout will appear on your Stripe schedule.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>Buyer received your item.</H1>
      <P>
        Your buyer received <strong>{title}</strong>. Your payout of{" "}
        <strong>{payout}</strong> will appear on your Stripe payout schedule —
        typically 1–2 business days, depending on your bank.
      </P>
      <Button href={url}>View order</Button>
      <P muted>
        Buyers have 7 days from delivery to open a dispute. If one is filed,
        we'll notify you so you can respond.
      </P>
    </Base>
  );
}

function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = DeliveredSeller;
module.exports.subject = () => "Buyer received your item";
