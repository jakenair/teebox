const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

/**
 * LIST-FIRST nudge (b): a buyer tapped "Seller is finishing setup — tap to
 * get notified" on one of this seller's listings. Sent by the
 * notifySellerInterest callable (functions/listFirst.js), deduped to one
 * per listing per 6h. The CTA mints a FRESH Stripe account link on arrival.
 */
function SellerBuyerInterest({user = {}, listing = {}, interestCount = 1, appUrl, setupUrl}) {
  const title = listing.title || "your item";
  const setup = setupUrl || `${appUrl || "https://teeboxmarket.com"}/?payouts=setup`;
  const n = Number(interestCount) || 1;
  return (
    <Base preview={`Someone wants your ${title}.`} uid={user.uid} category="transactional">
      <H1>Someone wants your {title}</H1>
      <P>
        A buyer on TeeBox just asked to be told when <strong>{title}</strong> can
        be bought{n > 1 ? ` — ${n} buyers are waiting now` : ""}. Right now they can’t
        check out, because your payout setup isn’t finished.
      </P>
      <P>
        Finish it and we’ll tell {n > 1 ? "them" : "that buyer"} the moment the
        listing is live for purchase. It takes about 3 minutes: name, address,
        bank, and a quick ID check.
      </P>
      <Button href={setup}>Finish payout setup</Button>
      <P muted>
        Buyers pay through TeeBox and Stripe sends the money straight to your
        bank. Nothing is charged to you.
      </P>
    </Base>
  );
}

module.exports = SellerBuyerInterest;
module.exports.subject = (ctx) => {
  const t = ctx && ctx.listing && ctx.listing.title;
  return t ? `Someone wants your ${String(t).slice(0, 40)}` : "Someone wants your listing";
};
