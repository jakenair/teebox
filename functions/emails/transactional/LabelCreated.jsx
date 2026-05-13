const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function LabelCreated({order = {}, buyer = {}, listing = {}}) {
  const orderId = order.id || "—";
  const title = listing.title || "your item";
  const url = `https://teeboxmarket.com/orders/${orderId}`;

  return (
    <Base
      preview={`The seller just printed a label for ${title}. Tracking on the way.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Label printed</H1>
      <P>
        Good news — the seller of <strong>{title}</strong> just generated a
        shipping label. Tracking will activate once the carrier picks it up,
        usually within 24 hours.
      </P>
      <Button href={url}>Track this order</Button>
      <P muted>
        We'll email you again when it's in transit and on the day it's out for
        delivery.
      </P>
    </Base>
  );
}

module.exports = LabelCreated;
module.exports.subject = () => "Your label is printed";
