const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function FundsReleased({order = {}, seller = {}, payout = {}}) {
  const amount = formatUsd(payout.amountCents || order.sellerPayoutCents);
  const url = `https://teeboxmarket.com/account?tab=payouts`;
  const eta = payout.arrivalDate || "1–2 business days";

  return (
    <Base
      preview={`Payout of ${amount} sent. Arrives in ${eta}.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>Payout sent</H1>
      <P>
        We just released <strong>{amount}</strong> to your payout method.
        Stripe will deposit it in your bank account in {eta}.
      </P>
      <Button href={url}>View payouts</Button>
    </Base>
  );
}

function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = FundsReleased;
module.exports.subject = () => "Your payout is on the way";
