/**
 * ProDowngraded — fires when tier flips from "pro" to "free" (period ended
 * after a cancel, or Stripe Smart Retries gave up). Should not also send
 * ProCanceled — these two events represent different moments in the
 * lifecycle. The trigger is gated by tier transition only.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

const GRAY_600 = "#4b5563";

function ProDowngraded({user = {}} = {}) {
  const firstName = user.firstName || user.displayName || "there";
  const upgradeUrl = "https://teeboxmarket.com/account?tab=billing";

  return (
    <Base
      preview={previewText()}
      uid={user.uid}
      category="transactional"
    >
      <H1>Pro Seller has ended</H1>
      <P>
        Hi {firstName} — your TeeBox Pro Seller plan has ended. Your seller
        fee is now <strong>6.5%</strong> on new sales. Existing active
        listings stay live; the Pro badge has been removed.
      </P>

      <Section
        style={{
          backgroundColor: "#f5f7f6",
          padding: "16px 20px",
          borderRadius: "6px",
          margin: "16px 0",
        }}
      >
        <Text style={{margin: 0, fontSize: "14px", color: GRAY_600, fontWeight: "600"}}>
          Reactivate any time
        </Text>
        <Text style={{margin: "6px 0 0", fontSize: "14px", lineHeight: "20px"}}>
          Coming back to Pro is one click — your saved listings, profile,
          and sales history don't go anywhere.
        </Text>
      </Section>

      <Button href={upgradeUrl}>Reactivate Pro Seller</Button>

      <P muted>
        Thanks for being a TeeBox seller. If something specific made you
        leave Pro, reply to this email — we read every reply.
      </P>
    </Base>
  );
}

function subject() {
  return "Pro Seller ended — fees are now 6.5%";
}

function previewText() {
  return "Reactivate any time to drop your seller fee back to 3%.".slice(0, 90);
}

module.exports = ProDowngraded;
module.exports.subject = subject;
module.exports.previewText = previewText;
