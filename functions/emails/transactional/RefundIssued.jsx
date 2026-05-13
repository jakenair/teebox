const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function RefundIssued({order = {}, buyer = {}, refund = {}}) {
  const amount = formatUsd(refund.amountCents || order.amountCents);
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;
  const reason = refund.reason || "your refund request";

  return (
    <Base
      preview={`We refunded ${amount} to your original payment method.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Refund issued</H1>
      <P>
        We've refunded <strong>{amount}</strong> to your original payment method
        for {reason}. Most banks post refunds in 5–10 business days.
      </P>
      <Button href={url}>View order details</Button>
      <P muted>
        If you don't see the refund after 10 business days, reply to this email
        and we'll investigate.
      </P>
    </Base>
  );
}

function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = RefundIssued;
module.exports.subject = () => "Refund issued";
