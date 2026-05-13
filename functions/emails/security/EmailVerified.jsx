const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

/**
 * Confirmation email fired AFTER the user clicks the verification link
 * and Firebase flips `emailVerified === true`. Distinct from
 * `EmailVerification.jsx` (which is the link-request email itself).
 *
 * Send is client-detected: index.html's reload-after-verify flow calls
 * `notifySecurityEvent({eventType:'email_verified'})`, which fires this
 * once per uid (idempotent via users/{uid}.emailVerifiedNotifiedAt).
 */
function EmailVerified({user = {}, appUrl}) {
  return (
    <Base
      preview="Your TeeBox email is verified. You're all set."
      uid={user.uid}
      category="transactional"
    >
      <H1>Email verified</H1>
      <P>
        Thanks for confirming <strong>{user.email || "your email"}</strong>.
        You can now receive order updates, security alerts, and (if you opt
        in) marketing email.
      </P>
      <Button href={appUrl || "https://teeboxmarket.com"}>
        Open TeeBox
      </Button>
      <P muted>
        Didn't verify? Someone else may have used your address to sign up.
        Reply to this email and we'll investigate.
      </P>
    </Base>
  );
}

module.exports = EmailVerified;
module.exports.subject = () => "Your email is verified";
