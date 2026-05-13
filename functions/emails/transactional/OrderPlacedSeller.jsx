const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function OrderPlacedSeller({order = {}, seller = {}, listing = {}}) {
  const orderId = order.id || "—";
  const title = listing.title || "your item";
  const payout = formatUsd(order.sellerPayoutCents);
  const url = `https://teeboxmarket.com/orders/${orderId}`;

  return (
    <Base
      preview={`You sold ${title}. Print the label and ship within 3 business days.`}
      uid={seller.uid}
      category="transactional"
    >
      <H1>You sold {title}</H1>
      <P>
        Congrats — your listing sold for {formatUsd(order.amountCents)}.
        Estimated payout after fees: <strong>{payout}</strong>.
      </P>
      <P>
        <strong>Next step:</strong> print the shipping label from your dashboard
        and drop the package within 3 business days. Late shipments hurt your
        seller rating and can trigger an automatic refund.
      </P>
      <Button href={url}>Print label & ship</Button>
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
