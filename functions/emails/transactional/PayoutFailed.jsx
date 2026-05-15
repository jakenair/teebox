/**
 * PayoutFailed — emailed to the seller when Stripe couldn't deposit a
 * payout into their bank (typically: wrong routing/account, closed
 * account, ACH return). Replaces a legacy `emailShell` render in
 * index.js handlePayoutFailed (Stripe webhook handler).
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function PayoutFailed({seller = {}, amountCents = 0, failureMessage = ""}) {
  const dollars = (Number(amountCents) / 100).toFixed(2);
  const stripeDashUrl = "https://dashboard.stripe.com/payouts";

  return (
    <Base
      preview={`Stripe couldn't deposit $${dollars}. Update your bank to retry.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>Payout failed — action required</H1>
      <Section
        style={{
          padding: "12px",
          backgroundColor: "#fef3c7",
          borderRadius: "6px",
          margin: "0 0 16px",
        }}
      >
        <Text style={{margin: 0, fontSize: "14px", color: "#78350f", fontWeight: "600"}}>
          Your funds are safe — Stripe will retry once you fix the issue.
        </Text>
      </Section>
      <P>
        Stripe couldn't deposit <strong>${dollars}</strong> into your bank
        account.
      </P>
      <P>
        <strong>Reason:</strong> {failureMessage || "unknown reason"}
      </P>
      <P>
        Open your Stripe Dashboard to update your bank account details and
        retry the payout.
      </P>
      <Button href={stripeDashUrl}>Open Stripe Dashboard</Button>
    </Base>
  );
}

module.exports = PayoutFailed;
module.exports.subject = () => "Payout failed — action required";
