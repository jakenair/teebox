const React = require("react");
const {
  Base, Button, H1, P, Kicker, ProductRow, InfoBlock,
} = require("../layout/Base");

function OrderShipped({order = {}, buyer = {}, listing = {}, tracking = {}}) {
  const orderId = order.id || "—";
  const title = listing.title || "your item";
  const carrier = tracking.carrier || order.carrier || "the carrier";
  const trackingNumber = tracking.number || order.trackingNumber || "—";
  const eta = tracking.eta || order.estimatedDelivery || null;
  const trackUrl = tracking.publicUrl || `https://teeboxmarket.com/orders/${orderId}`;

  return (
    <Base
      preview={`${title} is in transit via ${carrier}.${eta ? ` ETA ${eta}.` : ""}`}
      uid={buyer.uid}
      category="transactional"
    >
      <Kicker>Shipped</Kicker>
      <H1>It&apos;s on the way{eta ? `, arriving ~${eta}` : ""}.</H1>
      <P>
        Your <strong>{title}</strong> is in transit via {carrier}. Follow it the
        whole way with the tracking below.
      </P>

      <ProductRow imageUrl={listing.imageUrl} name={title} desc={`Via ${carrier}`} />

      <InfoBlock label={eta ? "Tracking · ETA " + eta : "Tracking number"}>
        {trackingNumber}
      </InfoBlock>

      <Button href={trackUrl}>Track package</Button>
      <P muted>
        Inspect it as soon as it lands. If anything&apos;s wrong, open a dispute
        from the order page within 7 days — and hang on to the packaging.
      </P>
    </Base>
  );
}

module.exports = OrderShipped;
module.exports.subject = () => "Your order has shipped";
