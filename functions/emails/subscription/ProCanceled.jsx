/**
 * ProCanceled — fires when proCancelAtPeriodEnd flips to true (user
 * canceled via the billing portal but still has access through period end).
 * Surfaces a "reactivate" CTA to recover the cancel.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

const GRAY_600 = "#4b5563";

function ProCanceled({user = {}, subscription = {}} = {}) {
  const firstName = user.firstName || user.displayName || "there";
  const endsOn = subscription.endsOnLabel || "your renewal date";
  const billingUrl = "https://teeboxmarket.com/account?tab=billing";

  return (
    <Base
      preview={previewText({subscription})}
      uid={user.uid}
      category="transactional"
    >
      <H1>Your Pro Seller subscription is canceled</H1>
      <P>
        Got it, {firstName}. Your TeeBox Pro Seller plan will end on{" "}
        <strong>{endsOn}</strong>. Until then nothing changes — you keep the
        3% fee, the Pro badge, and every other benefit.
      </P>

      <Section
        style={{
          backgroundColor: "#f5f7f6",
          padding: "16px 20px",
          borderRadius: "6px",
          margin: "16px 0",
        }}
      >
        <Text style={{margin: 0, fontSize: "14px", color: GRAY_600}}>
          What happens after {endsOn}
        </Text>
        <Text style={{margin: "6px 0 0", fontSize: "14px", lineHeight: "20px"}}>
          - Seller fee returns to 6.5% on new sales<br />
          - Pro badge is removed from your listings + profile<br />
          - Active listings stay live but new listings cap at 10
        </Text>
      </Section>

      <Button href={billingUrl}>Reactivate Pro Seller</Button>

      <P muted>
        Changed your mind? Hit Reactivate any time before {endsOn} and your
        plan continues without interruption.
      </P>
    </Base>
  );
}

function subject({subscription} = {}) {
  const endsOn = (subscription && subscription.endsOnLabel) || "soon";
  return `Pro Seller ends ${endsOn}`.slice(0, 50);
}

function previewText({subscription} = {}) {
  const endsOn = (subscription && subscription.endsOnLabel) || "soon";
  return `You keep Pro Seller until ${endsOn}. Reactivate any time.`.slice(0, 90);
}

module.exports = ProCanceled;
module.exports.subject = subject;
module.exports.previewText = previewText;
