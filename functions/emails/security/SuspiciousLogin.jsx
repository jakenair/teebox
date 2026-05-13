const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Row, Column, Text} = require("@react-email/components");

function SuspiciousLogin({user = {}, ip, location, device, when, freezeUrl}) {
  return (
    <Base
      preview={`New sign-in from ${location || ip || "an unknown device"}.`}
      uid={user.uid}
      category="transactional"
    >
      <H1>New sign-in detected</H1>
      <P>
        Someone just signed in to your TeeBox account from a device we haven't
        seen before.
      </P>
      <Section
        style={{
          backgroundColor: "#f5f7f6",
          padding: "16px",
          borderRadius: "6px",
          margin: "16px 0",
          fontSize: "14px",
        }}
      >
        <Row>
          <Column style={{width: "100px", color: "#6b7280"}}>When</Column>
          <Column>
            <Text style={{margin: 0}}>{when || new Date().toLocaleString()}</Text>
          </Column>
        </Row>
        <Row>
          <Column style={{width: "100px", color: "#6b7280"}}>Where</Column>
          <Column>
            <Text style={{margin: 0}}>{location || "—"}</Text>
          </Column>
        </Row>
        <Row>
          <Column style={{width: "100px", color: "#6b7280"}}>IP</Column>
          <Column>
            <Text style={{margin: 0}}>{ip || "—"}</Text>
          </Column>
        </Row>
        <Row>
          <Column style={{width: "100px", color: "#6b7280"}}>Device</Column>
          <Column>
            <Text style={{margin: 0}}>{device || "—"}</Text>
          </Column>
        </Row>
      </Section>
      <P>
        <strong>Wasn't you?</strong> Freeze your account immediately — we'll
        revoke all sessions and require a password reset.
      </P>
      <Button href={freezeUrl} color="#dc2626" textColor="#ffffff">
        This wasn't me — freeze account
      </Button>
      <P muted>If this was you, no action needed.</P>
    </Base>
  );
}

module.exports = SuspiciousLogin;
module.exports.subject = () => "New sign-in to your account";
