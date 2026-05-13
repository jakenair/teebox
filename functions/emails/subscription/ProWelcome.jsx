/**
 * ProWelcome — sent the first time a user transitions free → pro.
 *
 * Category: transactional (per CAN-SPAM, subscription notices are
 * transactional and cannot be unsubscribed). Marked as such in Base so
 * the footer shows the "cannot be unsubscribed" copy.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Row, Column, Text} = require("@react-email/components");

const GREEN_900 = "#0b3d2e";
const GOLD_500 = "#d6a900";
const GRAY_600 = "#4b5563";

function ProWelcome({user = {}} = {}) {
  const firstName = user.firstName || user.displayName || "golfer";
  const dashboardUrl = "https://teeboxmarket.com/shop/dashboard";
  const manageUrl = "https://teeboxmarket.com/account?tab=billing";

  return (
    <Base
      preview={previewText({user})}
      uid={user.uid}
      category="transactional"
    >
      <H1>Welcome to Pro Seller</H1>
      <P>
        Thanks for upgrading, {firstName}. Your TeeBox seller fees just dropped
        from 6.5% to <strong>3%</strong> on every sale — effective immediately.
      </P>

      <Section
        style={{
          backgroundColor: "#f5f7f6",
          padding: "16px 20px",
          borderRadius: "6px",
          margin: "16px 0",
          border: `1px solid ${GREEN_900}`,
        }}
      >
        <Text style={{margin: 0, fontSize: "14px", color: GRAY_600, fontWeight: "600"}}>
          Pro Seller benefits
        </Text>
        <Text style={{margin: "8px 0 0", fontSize: "15px", lineHeight: "22px"}}>
          - 3% seller fee (vs. 6.5% on the free plan)<br />
          - Pro badge on your listings + profile<br />
          - Priority placement in search results<br />
          - Up to 50 active listings (vs. 10)<br />
          - Saved-search alerts up to every 15 minutes
        </Text>
      </Section>

      <Button href={dashboardUrl}>Go to your seller dashboard</Button>

      <P muted>
        Your subscription renews monthly at $14.99. You can pause or cancel
        any time from{" "}
        <a href={manageUrl} style={{color: GRAY_600, textDecoration: "underline"}}>
          Manage subscription
        </a>
        . Stripe will send a separate receipt for each charge.
      </P>
    </Base>
  );
}

function subject() {
  return "Welcome to Pro Seller — fees are now 3%";
}

function previewText({user} = {}) {
  const first = (user && (user.firstName || user.displayName)) || "Welcome";
  return `${first}, your seller fee dropped from 6.5% to 3%.`.slice(0, 90);
}

module.exports = ProWelcome;
module.exports.subject = subject;
module.exports.previewText = previewText;
