const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function DisputeOpenedBuyer({order = {}, buyer = {}, listing = {}}) {
  const title = listing.title || "your item";
  const url = `https://teeboxmarket.com/disputes/${order.id || ""}`;

  return (
    <Base
      preview={`Dispute opened for ${title}. We've notified the seller.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Dispute opened</H1>
      <P>
        We received your dispute for <strong>{title}</strong>. The seller has
        72 hours to respond. Our team is monitoring the case and will step in
        if you and the seller can't resolve it.
      </P>
      <Button href={url}>Manage dispute</Button>
      <P muted>
        Keep all packaging and photo evidence. Funds remain on hold until the
        case is resolved.
      </P>
    </Base>
  );
}

module.exports = DisputeOpenedBuyer;
module.exports.subject = () => "Dispute opened";
