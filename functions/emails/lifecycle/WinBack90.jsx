/**
 * WinBack90 — SCAFFOLDED (90-day inactive, last-chance)
 * TODO: copy + best incentive (free shipping credit?).
 * After this one, drop frequency to quarterly.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function WinBack90({user = {}}) {
  return (
    <Base
      preview="One last reminder — your TeeBox watchlist is still here."
      uid={user.uid}
      category="winBack"
    >
      <H1>Still here when you're ready</H1>
      <P>
        {/* TODO: real copy + clear opt-out mention */}
        Your watchlist and saved searches are still active. We'll quiet down
        after this — but the door's open.
      </P>
      <Button href="https://teeboxmarket.com/">Take a look</Button>
    </Base>
  );
}

module.exports = WinBack90;
module.exports.subject = () => "Still here when you're ready";
