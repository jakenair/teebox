/**
 * ReviewRequest — FULLY BUILT
 * Sends 7 days after delivery if no review has been left.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function ReviewRequest({user = {}, order = {}, listing = {}, seller = {}}) {
  const title = listing.title || "your purchase";
  const sellerName = seller.displayName || "the seller";
  const url = `https://teeboxmarket.com/orders/${order.id || ""}?review=1`;

  return (
    <Base
      preview={`Rate ${sellerName} for your ${title} order.`}
      uid={user.uid}
      category="reviewRequests"
    >
      <H1>How was your purchase?</H1>
      <P>
        It's been a week since {title} landed at your door. Reviews keep the
        TeeBox community honest — 60 seconds, no novel required.
      </P>
      <Button href={url}>Leave a review</Button>
      <P muted>
        Only verified buyers can review. Your review will show up on{" "}
        {sellerName}'s profile and help future buyers know what to expect.
      </P>
    </Base>
  );
}

module.exports = ReviewRequest;
module.exports.subject = () => "How was your TeeBox order?";
