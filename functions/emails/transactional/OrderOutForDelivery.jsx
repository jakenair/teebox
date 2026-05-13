const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function OrderOutForDelivery({order = {}, buyer = {}, listing = {}}) {
  const title = listing.title || "your item";
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;

  return (
    <Base
      preview={`${title} is out for delivery today.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Out for delivery today</H1>
      <P>
        <strong>{title}</strong> is on a truck and headed your way. Keep an eye
        out — most carriers deliver between 9am and 7pm local time.
      </P>
      <Button href={url}>View tracking</Button>
    </Base>
  );
}

module.exports = OrderOutForDelivery;
module.exports.subject = () => "Out for delivery today";
