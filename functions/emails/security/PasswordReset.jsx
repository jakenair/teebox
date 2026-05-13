const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function PasswordReset({user = {}, resetUrl, ip}) {
  return (
    <Base
      preview="Reset your TeeBox password. Link expires in 1 hour."
      uid={user.uid}
      category="transactional"
    >
      <H1>Reset your password</H1>
      <P>
        We got a request to reset your TeeBox password from IP{" "}
        <strong>{ip || "—"}</strong>. Click below to set a new one. The link
        expires in 1 hour.
      </P>
      <Button href={resetUrl}>Reset password</Button>
      <P muted>
        Didn't request this? Ignore the email — your password won't change.
        If you're seeing repeated reset emails, contact support@teeboxmarket.com.
      </P>
    </Base>
  );
}

module.exports = PasswordReset;
module.exports.subject = () => "Reset your TeeBox password";
