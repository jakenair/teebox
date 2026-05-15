/**
 * SignupWelcome — fired the first time a users/{uid} doc is created.
 * Replaces the legacy `emailShell`-rendered welcome HTML in index.js
 * (CAN-SPAM non-compliant: no physical address, no unsubscribe link).
 *
 * Naming convention: action-first verb (SignupWelcome, not Welcome).
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function SignupWelcome({user = {}}) {
  const firstName = user.firstName || user.displayName || "golfer";
  const browseUrl = "https://teeboxmarket.com";
  const sellUrl = "https://teeboxmarket.com/sell";

  return (
    <Base
      preview="Welcome to TeeBox — the peer-to-peer marketplace built for golfers."
      uid={user.uid}
      category="transactional"
    >
      <H1>Welcome to TeeBox, {firstName}.</H1>
      <P>
        You're now part of a peer-to-peer marketplace built specifically for
        golfers — gear, clubs, balls, and accessories sold directly between
        members at fair prices, with payments secured by Stripe.
      </P>
      <P>
        Two quick ways to get started:
      </P>
      <Button href={browseUrl}>Start browsing</Button>
      <Section style={{textAlign: "center", margin: "12px 0 8px"}}>
        <Text style={{margin: 0, fontSize: "14px"}}>
          Got clubs to flip?{" "}
          <a
            href={sellUrl}
            style={{color: "#0b3d2e", fontWeight: "600", textDecoration: "underline"}}
          >
            Sell your first club
          </a>{" "}
          — flat 6.5% seller fee, payouts via Stripe.
        </Text>
      </Section>
      <P muted>
        Every order is protected: if an item never ships or arrives not as
        described, open a dispute from the order page within 7 days of delivery
        and we'll mediate. No 48-hour countdowns, no hidden escrow holds.
      </P>
    </Base>
  );
}

module.exports = SignupWelcome;
module.exports.subject = () => "Welcome to TeeBox";
