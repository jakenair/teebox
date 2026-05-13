/**
 * ProRenewalReminder — sent ~3 days before proCurrentPeriodEnd by the
 * scheduled function. One-shot per period (idempotency keyed on
 * proCurrentPeriodEnd timestamp + lifecycleEmailsSent.renewalReminderSentForPeriodEnd).
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

const GRAY_600 = "#4b5563";

function ProRenewalReminder({user = {}, renewal = {}} = {}) {
  const firstName = user.firstName || user.displayName || "there";
  const renewsOn = renewal.renewsOnLabel || "soon";
  const cardBrand = renewal.cardBrand || "card";
  const cardLast4 = renewal.cardLast4 ? `ending in ${renewal.cardLast4}` : "on file";
  const amount = renewal.amountLabel || "$14.99";
  const manageUrl = "https://teeboxmarket.com/account?tab=billing";

  return (
    <Base
      preview={previewText({renewal})}
      uid={user.uid}
      category="transactional"
    >
      <H1>Your Pro Seller subscription renews soon</H1>
      <P>
        Heads up, {firstName}. Your TeeBox Pro Seller plan renews on{" "}
        <strong>{renewsOn}</strong>. We'll charge <strong>{amount}</strong> to your{" "}
        {cardBrand} {cardLast4}.
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
          Next charge
        </Text>
        <Text style={{margin: "4px 0 0", fontSize: "16px", fontWeight: "600"}}>
          {amount} on {renewsOn}
        </Text>
        <Text style={{margin: "4px 0 0", fontSize: "14px", color: GRAY_600}}>
          {cardBrand} {cardLast4}
        </Text>
      </Section>

      <Button href={manageUrl}>Manage subscription</Button>

      <P muted>
        Nothing to do if you want to stay on Pro. To cancel before the renewal
        date, hit Manage subscription and choose Cancel — you'll keep Pro
        through {renewsOn}.
      </P>
    </Base>
  );
}

function subject({renewal} = {}) {
  const when = (renewal && renewal.renewsOnLabel) || "soon";
  return `Pro Seller renews ${when}`.slice(0, 50);
}

function previewText({renewal} = {}) {
  const when = (renewal && renewal.renewsOnLabel) || "soon";
  const amount = (renewal && renewal.amountLabel) || "$14.99";
  return `${amount} will be charged on ${when}.`.slice(0, 90);
}

module.exports = ProRenewalReminder;
module.exports.subject = subject;
module.exports.previewText = previewText;
