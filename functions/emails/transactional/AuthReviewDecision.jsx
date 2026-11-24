/**
 * AuthReviewDecision — transactional. Sent by decideAuthReview when an admin
 * takes a listing down or puts it back.
 */
const React = require("react");
const {Base, Button, H1, P, Kicker} = require("../layout/Base");

function AuthReviewDecision({listingId = "", title = "your listing", decision = "approve", reason = "", live = true}) {
  const url = `https://teeboxmarket.com/?listing=${encodeURIComponent(listingId)}`;
  if (decision === "approve") {
    return (
      <Base preview="Your listing is back on TeeBox." category="transactional">
        <Kicker>Listing update</Kicker>
        <H1>Your listing is back</H1>
        <P><strong>{title}</strong> is back on TeeBox.</P>
        {live ? <P>It is for sale on TeeBox. Nothing else is needed from you.</P> : null}
        {live ? <Button href={url}>View your listing</Button> : null}
      </Base>
    );
  }
  return (
    <Base preview="Your listing was taken down." category="transactional">
      <Kicker>Listing update</Kicker>
      <H1>Your listing was taken down</H1>
      <P>
        We took down <strong>{title}</strong>. Buyers can&apos;t see it for now.
      </P>
      <P><strong>Reason:</strong> {reason}</P>
      <P>
        If you think this is a mistake, reply to this email and we will look again.
      </P>
    </Base>
  );
}

module.exports = AuthReviewDecision;
module.exports.subject = ({title, decision} = {}) => {
  const t = title || "your TeeBox listing";
  return decision === "approve" ? `Back on TeeBox: ${t}` : `Taken down: ${t}`;
};
