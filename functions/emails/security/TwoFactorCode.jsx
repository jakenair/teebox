const React = require("react");
const {Base, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function TwoFactorCode({user = {}, code}) {
  // SECURITY: preview text MUST NOT include `code` — iOS/Android lock-screen
  // banners render preview text without unlocking the device, so anyone in
  // possession of the phone would see the code. Keep the code in the body
  // (rendered below) only.
  return (
    <Base
      preview="A verification code for your TeeBox sign-in. Open to view."
      uid={user.uid}
      category="transactional"
    >
      <H1>Your login code</H1>
      <P>Enter this code to finish signing in. It expires in 10 minutes.</P>
      <Section style={{textAlign: "center", margin: "24px 0"}}>
        <Text
          style={{
            fontSize: "32px",
            fontWeight: "700",
            letterSpacing: "8px",
            margin: 0,
            color: "#0b3d2e",
            fontFamily: "monospace",
          }}
        >
          {code}
        </Text>
      </Section>
      <P muted>
        If you didn't try to sign in, change your password right away.
      </P>
    </Base>
  );
}

module.exports = TwoFactorCode;
// SECURITY: subject must NOT contain the code — many notification surfaces
// (lock screen, Apple Watch, smart speakers reading email) expose the
// subject line. Keep it generic; the code is in the body.
module.exports.subject = () => "Your TeeBox sign-in code";
