const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

/**
 * Payout-setup reminder (r422). EMAIL FALLBACK only: lib/payoutReminders.js
 * sends this when the seller has no push token that took the push (or push
 * for that category is off). Category payoutReminders, so the footer carries
 * an unsubscribe link and an opt-out is honored by lib/email preflight.
 * Copy comes from payoutReminders.copyFor so push and email always match.
 */
function PayoutSetupReminder({user = {}, copy = {}, setupUrl, stage = 1}) {
  const setup = setupUrl || "https://teeboxmarket.com/?payouts=setup";
  return (
    <Base preview={copy.title || "Finish payout setup to publish your listing."}
      uid={user.uid} category="payoutReminders">
      <H1>{copy.title || "Your listing is almost live"}</H1>
      <P>{copy.emailIntro || "Buyers will see your listing as soon as your payout setup is done."}</P>
      <P>
        Payout setup takes about 3 minutes: name, address, bank, and a quick ID
        check with Stripe. Your listing publishes automatically when you finish.
      </P>
      <Button href={setup}>Finish payout setup</Button>
      <P muted>
        {stage >= 4
          ? "This is the last reminder we'll send about it."
          : "Buyers pay through TeeBox and Stripe sends the money to your bank. Nothing is charged to you."}
      </P>
    </Base>
  );
}

module.exports = PayoutSetupReminder;
module.exports.subject = (ctx) => (ctx && ctx.copy && ctx.copy.title) || "Your listing is almost live";
