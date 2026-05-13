const React = require("react");
const {Base, H1, P} = require("../layout/Base");

function EmailChangedNew({user = {}, newEmail}) {
  return (
    <Base
      preview="This is now your TeeBox login email."
      uid={user.uid}
      category="transactional"
    >
      <H1>You're all set</H1>
      <P>
        <strong>{newEmail}</strong> is now your TeeBox login. Use it next time
        you sign in. Future receipts and security notices come here.
      </P>
    </Base>
  );
}

module.exports = EmailChangedNew;
module.exports.subject = () => "Email confirmed";
