const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

// r357 (2026-10-23): copy matches the dispute flow that actually exists —
// seller + TeeBox notified, worked out over email, refunds to the original
// payment method. No response deadlines, no "funds on hold", no automatic
// refund, and the CTA goes to /orders/<id> (404.html bounces /disputes/*).
function DisputeOpenedBuyer({order = {}, buyer = {}, listing = {}}) {
  const title = listing.title || "your item";
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;

  return (
    <Base
      preview={`Dispute opened for ${title}. The seller and TeeBox have been notified.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Dispute opened</H1>
      <P>
        We received your dispute for <strong>{title}</strong>. The seller has
        been notified, and so has our team. We&apos;ll work it out with you and
        the seller by email, so keep an eye on your inbox. Reply to this email
        with any photos, tracking details, or messages that help explain what
        happened.
      </P>
      <Button href={url}>View order</Button>
      <P muted>
        If a refund is the outcome, it goes back to your original payment
        method. Opening a dispute doesn&apos;t affect any rights you have with
        your card issuer.
      </P>
    </Base>
  );
}

module.exports = DisputeOpenedBuyer;
module.exports.subject = () => "Dispute opened";
