/**
 * WeeklyDigest — SCAFFOLDED
 * Sends Sunday 9am LOCAL time (need user timezone in profile).
 * TODO: aggregate trending listings + price drops + saved-search recap.
 * TODO: skip if user opened a digest in last 3 days (avoid fatigue).
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function WeeklyDigest({user = {}, items = []}) {
  return (
    <Base
      preview="Your weekly TeeBox highlights."
      uid={user.uid}
      category="weeklyDigest"
    >
      <H1>This week on TeeBox</H1>
      <P>
        {/* TODO: real digest body */}
        {items.length
          ? `${items.length} listings caught our eye this week. Take a look.`
          : "Quiet week, but new listings are coming in daily."}
      </P>
      <Button href="https://teeboxmarket.com/">Browse the marketplace</Button>
    </Base>
  );
}

module.exports = WeeklyDigest;
module.exports.subject = () => "Your TeeBox week";
