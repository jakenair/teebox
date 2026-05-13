const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function DeliveredBuyer({order = {}, buyer = {}, listing = {}}) {
  const title = listing.title || "your item";
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;

  return (
    <Base
      preview={`${title} was delivered. Open a dispute within 7 days if anything's off.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Delivered. Take a look.</H1>
      <P>
        <strong>{title}</strong> just hit your doorstep. Take a moment to inspect
        it. If anything's wrong, open a dispute from the order page within 7 days
        of delivery and we'll mediate.
      </P>
      <Button href={url}>View order</Button>
      <Section style={{margin: "24px 0", padding: "12px", backgroundColor: "#fef3c7", borderRadius: "6px"}}>
        <Text style={{margin: 0, fontSize: "13px", color: "#78350f"}}>
          <strong>Tip:</strong> keep all packaging until you're satisfied. After
          7 days, the dispute window closes.
        </Text>
      </Section>
    </Base>
  );
}

module.exports = DeliveredBuyer;
module.exports.subject = () => "Your order was delivered";
