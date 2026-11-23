/**
 * ToolConnected — transactional. Sent to the seller each time a listing tool
 * is connected to their account, so one they didn't connect is noticed.
 */
const React = require("react");
const {Base, Button, H1, P, Kicker} = require("../layout/Base");

function ToolConnected({partnerName = "A listing tool", keyLast4 = ""}) {
  return (
    <Base preview={`${partnerName} can now manage your TeeBox listings.`} category="transactional">
      <Kicker>Account security</Kicker>
      <H1>{partnerName} was connected</H1>
      <P>
        <strong>{partnerName}</strong> can now create, edit and end listings on
        your TeeBox account. Its key ends in {keyLast4}. It can't see your
        orders, buyers or payouts.
      </P>
      <P>
        If this wasn't you, disconnect it now and change your password.
      </P>
      <Button href="https://teeboxmarket.com/settings/tools/">See connected tools</Button>
    </Base>
  );
}

module.exports = ToolConnected;
module.exports.subject = ({partnerName} = {}) => `${partnerName || "A listing tool"} was connected to your TeeBox account`;
