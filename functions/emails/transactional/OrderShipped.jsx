const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function OrderShipped({order = {}, buyer = {}, listing = {}, tracking = {}}) {
  const orderId = order.id || "—";
  const title = listing.title || "your item";
  const carrier = tracking.carrier || order.carrier || "the carrier";
  const trackingNumber = tracking.number || order.trackingNumber || "—";
  const eta = tracking.eta || order.estimatedDelivery || null;
  const trackUrl =
    tracking.publicUrl ||
    `https://teeboxmarket.com/orders/${orderId}`;

  return (
    <Base
      preview={`${title} is in transit via ${carrier}. ${eta ? `ETA ${eta}.` : ""}`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Your order is on the way</H1>
      <P>
        <strong>{title}</strong> shipped via {carrier}. Tracking number:{" "}
        <strong>{trackingNumber}</strong>.
      </P>
      {eta ? <P>Estimated delivery: <strong>{eta}</strong>.</P> : null}
      <Button href={trackUrl}>Track package</Button>
      <P muted>
        Once it arrives, inspect it right away. If anything's wrong, open a
        dispute from the order page within 7 days — don't toss the packaging.
      </P>
    </Base>
  );
}

module.exports = OrderShipped;
module.exports.subject = () => "Your order has shipped";
