const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function PasswordChanged({user = {}, ip, freezeUrl}) {
  return (
    <Base
      preview="Your TeeBox password was just changed."
      uid={user.uid}
      category="transactional"
    >
      <H1>Password changed</H1>
      <P>
        Your TeeBox password was updated from IP{" "}
        <strong>{ip || "—"}</strong> on {new Date().toLocaleString()}.
      </P>
      <P>
        <strong>Wasn't you?</strong> Lock your account now and we'll force a
        password reset.
      </P>
      <Button href={freezeUrl} color="#dc2626" textColor="#ffffff">
        This wasn't me — freeze account
      </Button>
    </Base>
  );
}

module.exports = PasswordChanged;
module.exports.subject = () => "Your password was changed";
