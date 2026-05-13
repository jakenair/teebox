/**
 * WinBack60 — SCAFFOLDED (60-day inactive)
 * TODO: copy + incentive offer.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function WinBack60({user = {}}) {
  return (
    <Base
      preview="It's been 2 months. Here's what you missed."
      uid={user.uid}
      category="winBack"
    >
      <H1>Two months and counting</H1>
      <P>
        {/* TODO: real copy + best-sellers + maybe credit incentive */}
        Lots has changed on TeeBox since you last visited. Take a quick look.
      </P>
      <Button href="https://teeboxmarket.com/">See what's new</Button>
    </Base>
  );
}

module.exports = WinBack60;
module.exports.subject = () => "It's been a while";
