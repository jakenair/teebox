/**
 * AuthReviewDecision — transactional. Sent by decideAuthReview when an admin
 * approves or rejects a $300+ listing's authenticity review (2026-11-23).
 */
const React = require("react");
const {Base, Button, H1, P, Kicker} = require("../layout/Base");

function AuthReviewDecision({listingId = "", title = "your listing", decision = "approve", reason = "", live = true}) {
  const url = `https://teeboxmarket.com/?listing=${encodeURIComponent(listingId)}`;
  if (decision === "approve") {
    return (
      <Base preview="Your listing passed our authenticity review." category="transactional">
        <Kicker>Review complete</Kicker>
        <H1>Your listing was approved</H1>
        <P><strong>{title}</strong> passed our authenticity review.</P>
        {live ? <P>It is for sale on TeeBox. Nothing else is needed from you.</P> : null}
        {live ? <Button href={url}>View your listing</Button> : null}
      </Base>
    );
  }
  return (
    <Base preview="Your listing did not pass our authenticity review." category="transactional">
      <Kicker>Review complete</Kicker>
      <H1>Your listing was not approved</H1>
      <P>
        <strong>{title}</strong> did not pass our authenticity review and is
        hidden from buyers for now.
      </P>
      <P><strong>Reason:</strong> {reason}</P>
      <P>
        If you think this is a mistake, reply to this email with proof of
        purchase or clearer photos and we will look again.
      </P>
    </Base>
  );
}

module.exports = AuthReviewDecision;
module.exports.subject = ({title, decision} = {}) => decision === "approve" ?
  `Approved: ${title || "your TeeBox listing"}` :
  `Not approved: ${title || "your TeeBox listing"}`;
