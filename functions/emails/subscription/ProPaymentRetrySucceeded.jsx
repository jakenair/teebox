/**
 * ProPaymentRetrySucceeded — fires when proSubscriptionStatus goes
 * past_due → active. Stripe Smart Retries successfully charged the card.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function ProPaymentRetrySucceeded({user = {}} = {}) {
  const firstName = user.firstName || user.displayName || "golfer";
  const dashboardUrl = "https://teeboxmarket.com/shop/dashboard";

  return (
    <Base
      preview={previewText()}
      uid={user.uid}
      category="transactional"
    >
      <H1>Your payment went through</H1>
      <P>
        Good news, {firstName} — we successfully charged your card and your
        TeeBox Pro Seller plan is renewed. Your seller fee stays at <strong>3%</strong>.
      </P>
      <Button href={dashboardUrl}>Open seller dashboard</Button>
      <P muted>
        A receipt will arrive separately from Stripe. Thanks for keeping
        Pro Seller active.
      </P>
    </Base>
  );
}

function subject() {
  return "Pro Seller renewed — payment received";
}

function previewText() {
  return "Your card was charged successfully. Pro Seller is renewed.".slice(0, 90);
}

module.exports = ProPaymentRetrySucceeded;
module.exports.subject = subject;
module.exports.previewText = previewText;
