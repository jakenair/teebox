/**
 * WinBack30 — SCAFFOLDED (30-day inactive)
 * TODO: copy review, maybe offer a 1-time fee-free month.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function WinBack30({user = {}}) {
  return (
    <Base
      preview="New listings, new finds. Pop back in."
      uid={user.uid}
      category="winBack"
    >
      <H1>Miss you on TeeBox</H1>
      <P>
        {/* TODO: real copy + featured listings */}
        It's been about a month. New gear hits the marketplace every day —
        come see what's surfaced since you've been away.
      </P>
      <Button href="https://teeboxmarket.com/">Browse new listings</Button>
    </Base>
  );
}

module.exports = WinBack30;
module.exports.subject = () => "We miss you on TeeBox";
