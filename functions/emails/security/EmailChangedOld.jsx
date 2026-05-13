const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function EmailChangedOld({user = {}, newEmail, freezeUrl}) {
  return (
    <Base
      preview="Your TeeBox email was changed. Wasn't you? Freeze the account."
      uid={user.uid}
      category="transactional"
    >
      <H1>Your email was changed</H1>
      <P>
        Your TeeBox login is now <strong>{newEmail}</strong>. Going forward,
        all account email will go to the new address.
      </P>
      <P>
        <strong>Wasn't you?</strong> Lock the account immediately. We'll
        revoke active sessions and require a password reset.
      </P>
      <Button href={freezeUrl} color="#dc2626" textColor="#ffffff">
        This wasn't me — freeze account
      </Button>
    </Base>
  );
}

module.exports = EmailChangedOld;
module.exports.subject = () => "Your email was changed";
