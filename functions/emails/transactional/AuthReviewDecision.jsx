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
  if (decision === "reopen") {
    return (
      <Base preview="Your edit sent this listing back for a quick review." category="transactional">
        <Kicker>Back in review</Kicker>
        <H1>We are checking your listing again</H1>
        <P>
          You changed the {reason} on <strong>{title}</strong>. Listings at $300
          and up are reviewed again when the photos, title or brand change.
        </P>
        <P>
          It is still for sale. We just leave it out of our ads until the review
          is done, and we will email you when it is. Nothing is needed from you.
        </P>
        <Button href={url}>View your listing</Button>
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
module.exports.subject = ({title, decision} = {}) => {
  const t = title || "your TeeBox listing";
  if (decision === "approve") return `Approved: ${t}`;
  return decision === "reopen" ? `Back in review: ${t}` : `Not approved: ${t}`;
};
