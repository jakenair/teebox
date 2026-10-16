/**
 * SellerInvite — one-shot seller-acquisition push (r345, 2026-10-16).
 *
 * Sent by runSellerInviteCampaign (functions/sellerInviteCampaign.js) to
 * recently-active accounts that have never listed. Category productUpdates:
 * marketing, so it is consent-gated and carries the unsubscribe footer.
 *
 * The promise in this email is a RULE in the product, not a favour: the home
 * page renders a Featured Sellers card for anyone with five or more live
 * listings (index.html buildFeaturedSellers, FEATURED_MIN_LISTINGS). Change
 * that constant and change this copy in the same commit.
 */
const React = require("react");
const {Base, Button, H1, P, Kicker} = require("../layout/Base");

const CTA_URL =
  "https://teeboxmarket.com/?sell=1&utm_source=email&utm_medium=lifecycle&utm_campaign=seller_invite";

function SellerInvite({user = {}}) {
  return (
    <Base
      preview="Five listings puts you on the TeeBox home page."
      uid={user.uid}
      category="productUpdates"
    >
      <Kicker>Sellers wanted</Kicker>
      <H1>List 5 items. Get featured.</H1>
      <P>
        Straight status report: TeeBox has more golfers browsing right now
        than gear for them to buy. So we are putting sellers front and
        center. Anyone with five or more items for sale gets a Featured
        Sellers card on the home page, the first thing people see when they
        open the site or the app.
      </P>
      <P>
        Clubs, a bag, shoes, polos, headcovers. A listing is photos and a
        price and takes a couple of minutes. Shipping labels are built in,
        payouts land through Stripe, and the only fee is 8.5% when something
        sells.
      </P>
      <Button href={CTA_URL}>Start selling</Button>
      <P muted>
        You are getting this because you have been on TeeBox recently and
        have not listed anything yet. If something is in the way of listing,
        reply and tell us. That is exactly what we want to hear.
      </P>
    </Base>
  );
}

module.exports = SellerInvite;
module.exports.subject = () => "List 5 items on TeeBox and we'll feature you";
module.exports.CTA_URL = CTA_URL;
