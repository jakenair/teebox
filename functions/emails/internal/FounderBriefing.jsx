/**
 * functions/emails/internal/FounderBriefing.jsx
 * ─────────────────────────────────────────────────────────────────────────
 * Daily founder briefing template — rendered by the dailyFounderBriefing
 * scheduled function (../../founderBriefing.js) and delivered to the
 * founder inbox each morning at 07:00 America/New_York.
 *
 * Renders three sections, in order:
 *   1. Headline numbers (GMV, orders, new users, new listings)
 *   2. The Claude-generated briefing text (preserves newlines as line
 *      breaks; the model is told to write plain prose, not Markdown)
 *   3. Notable events list — anything findNotableEvents() surfaced
 *
 * Category is `transactional` (it's internal, not marketing). Base.jsx
 * suppresses the unsubscribe link for that category — appropriate here.
 */

const React = require("react");
const {Base, H1, P} = require("../layout/Base");
const {Section, Row, Column, Text, Heading, Hr} = require("@react-email/components");

function FounderBriefing({
  date = "",
  briefingText = "",
  metrics = {},
  notableEvents = [],
  aiSkipped = false,
}) {
  const gmv = formatUsd(metrics.gmvCents || 0);
  const orders = formatInt(metrics.ordersCount || 0);
  const newUsers = formatInt(metrics.newUsersCount || 0);
  const newListings = formatInt(metrics.newListingsCount || 0);
  const aov = formatUsd(metrics.aovCents || 0);
  const refunds = formatInt(metrics.refundsCount || 0);
  const refundedAmt = formatUsd(metrics.refundedAmountCents || 0);
  const platformFee = formatUsd(metrics.platformFeeCents || 0);
  const disputes = formatInt(metrics.disputesCount || 0);
  const flagged = formatInt(metrics.flaggedListingsCount || 0);

  // Split the Claude briefing on blank lines so React Email can render
  // paragraph breaks. If the AI step was skipped (no key / API error),
  // we still send a usable email — `briefingText` will be the fallback
  // built by buildFallbackBriefing() in ../../founderBriefing.js.
  const paragraphs = String(briefingText || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <Base
      preview={`TeeBox ${date}: ${orders} orders, ${gmv} GMV, ${newUsers} new users.`}
      uid={null}
      category="transactional"
    >
      <H1>Daily briefing — {date}</H1>

      {aiSkipped ? (
        <P muted>
          AI summary unavailable (ANTHROPIC_API_KEY not set or API error).
          Raw metrics below.
        </P>
      ) : null}

      {/* ── Headline metrics grid ───────────────────────── */}
      <Section
        style={{
          backgroundColor: "#f5f7f6",
          padding: "16px",
          borderRadius: "6px",
          margin: "0 0 20px",
        }}
      >
        <Row>
          <Column style={{width: "50%", paddingRight: "8px"}}>
            <Metric label="GMV (24h)" value={gmv} />
            <Metric label="Orders" value={orders} />
            <Metric label="New users" value={newUsers} />
            <Metric label="New listings" value={newListings} />
            <Metric label="Platform fee revenue" value={platformFee} />
          </Column>
          <Column style={{width: "50%", paddingLeft: "8px"}}>
            <Metric label="AOV" value={aov} />
            <Metric
              label="Refunds"
              value={`${refunds} (${refundedAmt})`}
            />
            <Metric label="Disputes opened" value={disputes} />
            <Metric label="Flagged listings" value={flagged} />
          </Column>
        </Row>
      </Section>

      {/* ── Claude briefing text ────────────────────────── */}
      <Heading
        as="h2"
        style={{fontSize: "16px", margin: "0 0 12px", color: "#111827"}}
      >
        Summary
      </Heading>
      {paragraphs.length === 0 ? (
        <P muted>(No briefing generated.)</P>
      ) : (
        paragraphs.map((p, i) => <P key={i}>{p}</P>)
      )}

      {/* ── Notable events ──────────────────────────────── */}
      {Array.isArray(notableEvents) && notableEvents.length > 0 ? (
        <>
          <Hr style={{borderColor: "#e5e7eb", margin: "24px 0 16px"}} />
          <Heading
            as="h2"
            style={{fontSize: "16px", margin: "0 0 12px", color: "#111827"}}
          >
            Notable events ({notableEvents.length})
          </Heading>
          {notableEvents.map((ev, i) => (
            <Text
              key={i}
              style={{
                fontSize: "14px",
                lineHeight: "20px",
                margin: "0 0 8px",
                color: "#111827",
              }}
            >
              <strong>{prettyEventType(ev.type)}:</strong>{" "}
              {ev.summary || JSON.stringify(ev)}
            </Text>
          ))}
        </>
      ) : null}

      <Hr style={{borderColor: "#e5e7eb", margin: "24px 0 16px"}} />
      <P muted>
        Generated automatically at 07:00 ET. To trigger a fresh briefing
        on demand, see dailyFounderBriefingManual in functions/founderBriefing.js.
      </P>
    </Base>
  );
}

function Metric({label, value}) {
  return (
    <Section style={{margin: "0 0 10px"}}>
      <Text style={{margin: 0, fontSize: "12px", color: "#6b7280"}}>
        {label}
      </Text>
      <Text style={{margin: "2px 0 0", fontSize: "16px", fontWeight: "600"}}>
        {value}
      </Text>
    </Section>
  );
}

function formatUsd(cents) {
  if (!Number.isFinite(cents)) return "$—";
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

function formatInt(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

function prettyEventType(t) {
  return (
    {
      first_sale: "First sale",
      large_order: "Big-ticket order",
      dispute_on_flagged: "Dispute on flagged listing",
      high_fraud_signup: "Suspicious signup",
    }[t] || t || "Event"
  );
}

module.exports = FounderBriefing;
module.exports.subject = (ctx) =>
  `TeeBox daily briefing — ${(ctx && ctx.date) || ""}`.slice(0, 60);
