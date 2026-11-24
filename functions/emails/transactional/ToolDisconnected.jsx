/**
 * ToolDisconnected — transactional. Sent when a connection key stopped working
 * because the seller's sign-ins were reset (password reset or change, or
 * signed out everywhere) after the tool was connected.
 */
const React = require("react");
const {Base, Button, H1, P, Kicker} = require("../layout/Base");

function ToolDisconnected({partnerName = "A listing tool", keyLast4 = ""}) {
  return (
    <Base preview={`${partnerName} no longer has access to your TeeBox listings.`} category="transactional">
      <Kicker>Account security</Kicker>
      <H1>{partnerName} was disconnected</H1>
      <P>
        Your password or sign-ins were reset, so we turned off the key{" "}
        <strong>{partnerName}</strong> was using (it ended in {keyLast4}). It
        can no longer see or change your listings. Your listings are unchanged.
      </P>
      <P>
        If you still use it, connect it again. If you didn't reset anything,
        change your password now.
      </P>
      <Button href="https://teeboxmarket.com/settings/tools/">See connected tools</Button>
    </Base>
  );
}

module.exports = ToolDisconnected;
module.exports.subject = ({partnerName} = {}) => `${partnerName || "A listing tool"} was disconnected from your TeeBox account`;
