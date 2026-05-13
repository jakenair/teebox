const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function DisputeOpenedSeller({order = {}, seller = {}, listing = {}, dispute = {}}) {
  const title = listing.title || "your item";
  const reason = dispute.reason || "an issue with the order";
  const url = `https://teeboxmarket.com/disputes/${order.id || ""}`;

  return (
    <Base
      preview={`Buyer opened a dispute on ${title}. Respond within 72 hours.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>Action required: dispute opened</H1>
      <P>
        The buyer of <strong>{title}</strong> opened a dispute citing{" "}
        <em>{reason}</em>. You have <strong>72 hours</strong> to respond with
        evidence (photos, tracking, conversation history).
      </P>
      <Button href={url}>Respond to dispute</Button>
      <Section style={{margin: "24px 0", padding: "12px", backgroundColor: "#fee2e2", borderRadius: "6px"}}>
        <Text style={{margin: 0, fontSize: "13px", color: "#7f1d1d"}}>
          <strong>If you don't respond,</strong> we'll resolve in the buyer's
          favor and the funds will be refunded.
        </Text>
      </Section>
    </Base>
  );
}

module.exports = DisputeOpenedSeller;
module.exports.subject = () => "Action needed: dispute opened";
