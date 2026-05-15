const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

// `shippoEnabled` is computed server-side in onOrderCreatedEmail
// (emailTriggers.js) by checking whether the SHIPPO_API_KEY secret is
// set. When false (v1 default), the CTA points to a help page and the
// copy says "use any carrier". When true, it points to the in-app
// label-printing flow. We don't trust the secret-check from inside the
// template (templates are pure renderers) — the producer passes the
// boolean down via ctx.
function OrderPlacedSeller({order = {}, seller = {}, listing = {}, shippoEnabled = false}) {
  const orderId = order.id || "—";
  const title = listing.title || "your item";
  const payout = formatUsd(order.sellerPayoutCents);
  const dashboardUrl = `https://teeboxmarket.com/orders/${orderId}`;
  const helpUrl = "https://teeboxmarket.com/support.html#shipping";

  const ctaHref = shippoEnabled ? dashboardUrl : helpUrl;
  const ctaLabel = shippoEnabled ? "Print label & ship" : "How to ship your item";

  const nextStepText = shippoEnabled ? (
    <P>
      <strong>Next step:</strong> print the shipping label from your dashboard
      and drop the package within 3 business days. Late shipments hurt your
      seller rating and can trigger an automatic refund.
    </P>
  ) : (
    <P>
      <strong>Next step:</strong> use any carrier (USPS, UPS, FedEx) to ship
      within 3 business days, then mark the order shipped from your dashboard
      with the tracking number. Late shipments hurt your seller rating and
      can trigger an automatic refund.
    </P>
  );

  return (
    <Base
      preview={`You sold ${title}. ${shippoEnabled ? "Print the label" : "Ship via any carrier"} within 3 business days.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>You sold {title}</H1>
      <P>
        Congrats — your listing sold for {formatUsd(order.amountCents)}.
        Estimated payout after fees: <strong>{payout}</strong>.
      </P>
      {nextStepText}
      <Button href={ctaHref}>{ctaLabel}</Button>
      <Section style={{margin: "24px 0", padding: "12px", backgroundColor: "#fff7e6", borderRadius: "6px"}}>
        <Text style={{margin: 0, fontSize: "13px", color: "#92400e"}}>
          <strong>Tip:</strong> include a thank-you note. Repeat buyers come
          from sellers who treat each sale like a small business.
        </Text>
      </Section>
    </Base>
  );
}

function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = OrderPlacedSeller;
module.exports.subject = (ctx) =>
  `You sold ${(ctx.listing && ctx.listing.title) || "an item"}`.slice(0, 50);
