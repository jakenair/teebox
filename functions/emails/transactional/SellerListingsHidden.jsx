const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

/**
 * LIST-FIRST auto-hide: this seller's listings have been live for `days`
 * without payouts set up, so the hideUnonboardedListings sweep hid them
 * from the feed (status 'hidden' — NOT deleted). Finishing Stripe relists
 * them automatically. One email per seller per sweep.
 */
function SellerListingsHidden({user = {}, listings = [], appUrl, setupUrl, days = 7}) {
  const setup = setupUrl || `${appUrl || "https://teeboxmarket.com"}/?payouts=setup`;
  const n = listings.length;
  const shown = listings.slice(0, 5);
  return (
    <Base preview={n === 1 ? "Your listing is paused until payouts are set up." : `${n} listings paused until payouts are set up.`}
      uid={user.uid} category="transactional">
      <H1>{n === 1 ? "Your listing is paused" : `${n} listings are paused`}</H1>
      <P>
        {n === 1 ? "Your listing has" : "Your listings have"} been on TeeBox for {days} days
        without payout setup, so buyers couldn’t purchase. We’ve hidden
        {n === 1 ? " it" : " them"} from the marketplace — nothing is deleted,
        your photos and details are all saved.
      </P>
      {shown.map((l) => (
        <P key={l.id}>• <strong>{l.title}</strong></P>
      ))}
      {n > shown.length ? <P muted>…and {n - shown.length} more.</P> : null}
      <P>
        Finish payout setup (about 3 minutes) and {n === 1 ? "it goes" : "they go"} live
        again automatically.
      </P>
      <Button href={setup}>Finish setup to relist</Button>
    </Base>
  );
}

module.exports = SellerListingsHidden;
module.exports.subject = (ctx) => {
  const n = (ctx && ctx.listings && ctx.listings.length) || 1;
  return n === 1 ? "Your listing is paused — finish setup to relist"
    : `${n} listings paused — finish setup to relist`;
};
