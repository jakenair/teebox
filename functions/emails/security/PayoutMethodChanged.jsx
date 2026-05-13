const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function PayoutMethodChanged({user = {}, last4, ip, freezeUrl}) {
  return (
    <Base
      preview="Payout destination changed. If this wasn't you, freeze now."
      uid={user.uid}
      category="transactional"
    >
      <H1>Payout method changed</H1>
      <Section style={{padding: "12px", backgroundColor: "#fee2e2", borderRadius: "6px", margin: "0 0 16px"}}>
        <Text style={{margin: 0, fontSize: "14px", color: "#7f1d1d", fontWeight: "600"}}>
          High-priority security alert
        </Text>
      </Section>
      <P>
        Your TeeBox payouts will now go to an account ending in{" "}
        <strong>•••• {last4 || "—"}</strong> (changed from IP{" "}
        <strong>{ip || "—"}</strong>).
      </P>
      <P>
        <strong>Wasn't you?</strong> Freeze your account now. We'll halt all
        pending payouts and force a password reset.
      </P>
      <Button href={freezeUrl} color="#dc2626" textColor="#ffffff">
        This wasn't me — freeze account
      </Button>
      <P muted>
        If this was you, no action needed. We sent this because payout changes
        are a top vector for account takeover.
      </P>
    </Base>
  );
}

module.exports = PayoutMethodChanged;
module.exports.subject = () => "Payout method changed";
