const React = require("react");
const {Base, Button, H1, P, Kicker, ProductRow, NextStep} = require("../layout/Base");

function ShipReminder({order = {}, seller = {}, listing = {}, day = 2, shipByDate = ""}) {
  const title = listing.title || "your item";
  const url = `https://teeboxmarket.com/orders/${order.id || ""}`;
  const when = niceDate(shipByDate);
  const last = day === 3;

  return (
    <Base
      preview={last ? `${title} needs to ship today.` : `${title} needs to ship by ${when}.`}
      uid={seller.uid}
      category="transactional"
    >
      <Kicker>{last ? "Ship today" : "Ship by tomorrow"}</Kicker>
      <H1>{last ? "Today is the ship-by date." : `Please ship by ${when}.`}</H1>
      <P>
        <strong>{title}</strong> hasn&apos;t shipped yet. Orders ship within 3
        business days, so this one is due {last ? "today" : when}.
      </P>
      <ProductRow imageUrl={listing.imageUrl} name={title} desc={`Ship by ${when}`} />
      <NextStep>
        <strong>Your buyer already paid for shipping.</strong> Print the prepaid
        label from your Sold tab, pack the item, and hand it to the carrier.
        USPS labels can be picked up from your door:{" "}
        <a href="https://tools.usps.com/schedule-pickup-steps.htm">schedule a free USPS pickup</a>.
      </NextStep>
      <Button href={url}>Ship this order</Button>
      <P muted>
        Already handed it over? Tracking updates on its own once the carrier
        scans it. <a href="https://teeboxmarket.com/shipping/">How shipping works</a>
      </P>
    </Base>
  );
}

function niceDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return "the ship-by date";
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {timeZone: "UTC", weekday: "long", month: "long", day: "numeric"});
}

module.exports = ShipReminder;
module.exports.subject = (ctx) => (ctx.day === 3 ? "Ship today: " : "Ship by tomorrow: ")
  .concat((ctx.listing && ctx.listing.title) || "your sold item").slice(0, 50);
