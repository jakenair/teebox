const React = require("react");
const {Base, H1, P} = require("../layout/Base");

function AccountDeletionConfirmed({user = {}}) {
  return (
    <Base
      preview="Your TeeBox account has been deleted."
      uid={user.uid}
      category="transactional"
    >
      <H1>Account deleted</H1>
      <P>
        Your TeeBox account has been deleted and your data scheduled for
        permanent removal within 30 days, in line with our privacy policy.
      </P>
      <P>
        Open orders (where you're a buyer or seller) will continue to settle
        through their normal lifecycle. We retained the minimum financial
        records required by law.
      </P>
      <P muted>
        Changed your mind? Email support@teeboxmarket.com within 30 days and we
        can restore the account.
      </P>
    </Base>
  );
}

module.exports = AccountDeletionConfirmed;
module.exports.subject = () => "Your account was deleted";
