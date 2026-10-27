const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

// r357 (2026-10-23): removed the 72-hour deadline, the "Respond to dispute"
// button (that page never existed) and the "we'll resolve in the buyer's
// favor" automatic-refund claim. Replies land in the support inbox
// (transactional reply-to), which is where disputes are actually worked.
function DisputeOpenedSeller({order = {}, seller = {}, listing = {}, dispute = {}}) {
  const title = listing.title || "your item";
  const reason = dispute.reason || "an issue with the order";
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;

  return (
    <Base
      preview={`The buyer opened a dispute on ${title}. TeeBox has been notified.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>Dispute opened on your sale</H1>
      <P>
        The buyer of <strong>{title}</strong> opened a dispute citing{" "}
        <em>{reason}</em>. Our team has been notified and will work it out with
        you and the buyer by email. Reply to this email with your side and any
        evidence (photos, tracking, conversation history) so we can sort it out
        quickly.
      </P>
      <Button href={url}>View order</Button>
      <P muted>
        If the dispute ends in a refund, it is returned to the buyer&apos;s
        original payment method and may reverse the payout for this order.
      </P>
    </Base>
  );
}

module.exports = DisputeOpenedSeller;
module.exports.subject = () => "Dispute opened on your sale";
