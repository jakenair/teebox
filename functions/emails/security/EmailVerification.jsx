const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function EmailVerification({user = {}, verificationUrl}) {
  return (
    <Base
      preview="Confirm your email to finish setting up TeeBox."
      uid={user.uid}
      category="transactional"
    >
      <H1>Welcome to TeeBox</H1>
      <P>
        Hi {user.firstName || "there"}, click the button below to confirm your
        email and unlock buying + selling. The link expires in 24 hours.
      </P>
      <Button href={verificationUrl}>Verify email</Button>
      <P muted>
        If you didn't sign up for TeeBox, you can ignore this email — no
        account will be created.
      </P>
    </Base>
  );
}

module.exports = EmailVerification;
module.exports.subject = () => "Verify your TeeBox email";
