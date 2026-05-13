const React = require("react");
const {Base, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function TwoFactorCode({user = {}, code}) {
  return (
    <Base
      preview={`Your TeeBox login code: ${code}. Expires in 10 minutes.`}
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
module.exports.subject = (ctx) => `Your code: ${ctx.code || ""}`.slice(0, 50);
