const React = require("react");
const {
  Base, Button, H1, P, Kicker, ProductRow, InfoBlock,
} = require("../layout/Base");

// Build the carrier's public tracking URL from a carrier name + number.
// Mirrors the client trackingUrlFor() so the email's "Track package" button
// deep-links to the real carrier (USPS/UPS/FedEx/DHL) instead of a TeeBox
// page. Falls back to a plain search when the carrier isn't recognized.
function carrierTrackUrl(carrier, number) {
  if (!number) return null;
  const c = String(carrier || "").toLowerCase();
  const tn = encodeURIComponent(number);
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${tn}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking/tracking-parcel.html?tracking-id=${tn}`;
  return `https://www.google.com/search?q=${encodeURIComponent((carrier || "") + " tracking " + number)}`;
}

function OrderShipped({order = {}, buyer = {}, listing = {}, tracking = {}}) {
  const orderId = order.id || "—";
  const title = listing.title || "your item";
  // Prefer the number-detected carrier (trackingCarrier) over the seller
  // dropdown (order.carrier), which defaults to USPS and can be wrong.
  const carrier = tracking.carrier || order.trackingCarrier || order.carrier || "the carrier";
  const trackingNumber = tracking.number || order.trackingNumber || "—";
  const eta = tracking.eta || order.estimatedDelivery || null;
  // A Shippo label sets tracking.publicUrl; otherwise deep-link to the
  // carrier from the number. Only fall back to the TeeBox order page when
  // there's no usable tracking number at all.
  const hasNumber = trackingNumber && trackingNumber !== "—";
  const trackUrl = tracking.publicUrl ||
    (hasNumber ? carrierTrackUrl(carrier, trackingNumber) : null) ||
    `https://teeboxmarket.com/orders/${orderId}`;

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
