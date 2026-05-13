const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function DeliveredBuyer({order = {}, buyer = {}, listing = {}}) {
  const title = listing.title || "your item";
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;

  return (
    <Base
      preview={`${title} was delivered. You have 3 days to confirm or dispute.`}
      uid={buyer.uid}
      category="transactional"
    >
      <H1>Delivered. Take a look.</H1>
      <P>
        <strong>{title}</strong> just hit your doorstep. Take a moment to inspect
        it. If everything checks out, confirm receipt so the seller gets paid —
        otherwise, you have 3 days to open a dispute.
      </P>
      <Button href={url}>Confirm or dispute</Button>
      <Section style={{margin: "24px 0", padding: "12px", backgroundColor: "#fee2e2", borderRadius: "6px"}}>
        <Text style={{margin: 0, fontSize: "13px", color: "#7f1d1d"}}>
          <strong>Note:</strong> if you do nothing, funds release automatically
          to the seller after 3 days. Keep all packaging until you're satisfied.
        </Text>
      </Section>
    </Base>
  );
}

module.exports = DeliveredBuyer;
module.exports.subject = () => "Your order was delivered";
