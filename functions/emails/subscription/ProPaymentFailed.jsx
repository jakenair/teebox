/**
 * ProPaymentFailed — fires when proSubscriptionStatus flips to "past_due".
 * Stripe Smart Retries will attempt up to 3 more times over ~7 days; we
 * tell the user to update their payment method before then.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

const GRAY_600 = "#4b5563";
const RED_700 = "#b91c1c";

function ProPaymentFailed({user = {}} = {}) {
  const firstName = user.firstName || user.displayName || "there";
  const billingUrl = "https://teeboxmarket.com/account?tab=billing";

  return (
    <Base
      preview={previewText()}
      uid={user.uid}
      category="transactional"
    >
      <H1>We couldn't charge your card</H1>
      <P>
        Hi {firstName} — your TeeBox Pro Seller renewal payment didn't go
        through. This usually means an expired card, insufficient funds, or a
        bank-side block on the charge.
      </P>

      <Section
        style={{
          backgroundColor: "#fef2f2",
          padding: "16px 20px",
          borderRadius: "6px",
          margin: "16px 0",
          border: `1px solid ${RED_700}`,
        }}
      >
        <Text style={{margin: 0, fontSize: "14px", fontWeight: "600", color: RED_700}}>
          Action needed
        </Text>
        <Text style={{margin: "6px 0 0", fontSize: "14px", lineHeight: "20px", color: GRAY_600}}>
          We'll retry the charge automatically in 3 days. To avoid losing Pro
          status, update your payment method now.
        </Text>
      </Section>

      <Button href={billingUrl}>Update payment method</Button>

      <P muted>
        If we can't charge a working card within ~7 days, your Pro Seller plan
        will end and your seller fee will revert to 6.5%. Questions? Reply to
        this email and we'll help.
      </P>
    </Base>
  );
}

function subject() {
  return "Action needed: Pro Seller payment failed";
}

function previewText() {
  return "Update your payment method to keep Pro Seller fees at 3%.".slice(0, 90);
}

module.exports = ProPaymentFailed;
module.exports.subject = subject;
module.exports.previewText = previewText;
