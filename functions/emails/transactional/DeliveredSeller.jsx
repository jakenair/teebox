const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function DeliveredSeller({order = {}, seller = {}, listing = {}}) {
  const title = listing.title || "your item";
  const payout = formatUsd(order.sellerPayoutCents);
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;

  return (
    <Base
      preview={`Delivered. Funds release in 3 days unless the buyer disputes.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>Delivered. Funds release in 3 days.</H1>
      <P>
        Your buyer received <strong>{title}</strong>. TeeBox holds the funds for
        72 hours so the buyer can confirm or dispute. Assuming no issues, we'll
        release <strong>{payout}</strong> to your payout method automatically.
      </P>
      <Button href={url}>View order</Button>
      <P muted>
        Payouts arrive in 1–2 business days after release, depending on your
        bank.
      </P>
    </Base>
  );
}

function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = DeliveredSeller;
module.exports.subject = () => "Delivered — payout pending";
