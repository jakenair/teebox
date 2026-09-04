const React = require("react");
const {
  Base, Button, H1, P, Kicker, ProductRow, Receipt, ReceiptRow, Amount, NextStep,
} = require("../layout/Base");

// `shippoEnabled` is computed server-side in onOrderCreatedEmail
// (emailTriggers.js). When false (v1 default) the CTA points to a help page
// and the copy says "use any carrier"; when true it points at the in-app
// label flow. Templates are pure renderers — the boolean is passed via ctx.
function OrderPlacedSeller({order = {}, seller = {}, listing = {}, shippoEnabled = false}) {
  const orderId = order.id || "—";
  const title = listing.title || "your item";
  const sale = formatUsd(order.amountCents);
  const payout = formatUsd(order.sellerPayoutCents);
  const feeCents = numOr(order.amountCents) - numOr(order.sellerPayoutCents);
  const fee = feeCents > 0 ? `−${formatUsd(feeCents)}` : "—";
  const dashboardUrl = `https://teeboxmarket.com/orders/${orderId}`;
  const helpUrl = "https://teeboxmarket.com/support.html#shipping";

  const ctaHref = shippoEnabled ? dashboardUrl : helpUrl;
  const ctaLabel = shippoEnabled ? "Print shipping label" : "How to ship your item";
  const buyerCity = (order.shipping && order.shipping.address && order.shipping.address.city) || null;

  return (
    <Base
      preview={`You sold ${title} — your payout is ${payout}. Ship within 3 business days.`}
      uid={seller.uid}
      category="transactional"
    >
      <Kicker>You made a sale</Kicker>
      <H1>{title} sold.</H1>
      <P>
        Nice one{seller.firstName ? `, ${seller.firstName}` : ""}. The money&apos;s
        cleared and your payout is on the way to your bank — here&apos;s the breakdown.
      </P>

      <Amount label="You'll receive" value={payout} sub="Deposited to your bank on Stripe's schedule" />

      <Receipt>
        <ReceiptRow label="Sale price" value={sale} />
        <ReceiptRow label="TeeBox fee · 8.5%" value={fee} negative />
        <ReceiptRow label="Your payout" value={payout} strong />
      </Receipt>

      <ProductRow
        imageUrl={listing.imageUrl}
        name={title}
        desc={buyerCity ? `Sold · ${buyerCity}` : "Sold"}
      />

      <NextStep>
        {shippoEnabled ? (
          <>
            <strong>Ship within 3 business days.</strong> Print the label here and
            the buyer&apos;s address fills in automatically — tracking is sent to
            them for you. Late shipments hurt your rating and can trigger a refund.
          </>
        ) : (
          <>
            <strong>Ship within 3 business days</strong> with any carrier (USPS,
            UPS, FedEx), then mark it shipped with the tracking number from your
            Sold tab. Late shipments hurt your rating and can trigger a refund.
          </>
        )}
      </NextStep>

      <Button href={ctaHref}>{ctaLabel}</Button>
      <P muted>
        A handwritten thank-you in the box is how repeat buyers happen — the
        sellers who treat each sale like a small business win the long game.
      </P>
    </Base>
  );
}

function numOr(n) { return Number.isFinite(n) ? n : 0; }
function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = OrderPlacedSeller;
module.exports.subject = (ctx) =>
  `You sold ${(ctx.listing && ctx.listing.title) || "an item"}`.slice(0, 50);
