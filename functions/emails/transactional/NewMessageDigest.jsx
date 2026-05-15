/**
 * NewMessageDigest — emailed to a recipient when they receive a new
 * conversation message. Throttled at 1 email per (thread × 4h) by the
 * producer; when batched messages arrive during the cooldown, the next
 * email rolls them up into a count + the latest preview.
 *
 * Replaces the legacy `emailShell` render in index.js notifyOnNewMessage.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");
const {Section, Text} = require("@react-email/components");

function NewMessageDigest({
  recipient = {},
  fromName = "A buyer",
  preview = "",
  totalNew = 1,
}) {
  const safePreview = String(preview || "").replace(/[<>]/g, "");
  const inboxUrl = "https://teeboxmarket.com/?inbox=1";
  const isBatch = Number(totalNew) > 1;
  const headline = isBatch ?
    `${totalNew} new messages from ${fromName}` :
    `Message from ${fromName}`;
  const previewLine = isBatch ?
    `${totalNew} new messages from ${fromName}.` :
    `New message from ${fromName}: ${safePreview}`.slice(0, 90);

  return (
    <Base
      preview={previewLine}
      uid={recipient.uid}
      category="transactional"
    >
      <H1>{headline}</H1>
      <P>
        <strong>{fromName}</strong>{" "}
        {isBatch ?
          `sent you ${totalNew} new messages. Latest:` :
          "sent you a message:"}
      </P>
      <Section
        style={{
          borderLeft: "3px solid #d6a900",
          backgroundColor: "#fafaf7",
          padding: "10px 14px",
          margin: "14px 0",
          borderRadius: "4px",
        }}
      >
        <Text style={{margin: 0, fontStyle: "italic", color: "#4b5563", fontSize: "14px"}}>
          {safePreview || "(no preview available)"}
        </Text>
      </Section>
      <Button href={inboxUrl}>Open inbox</Button>
      <P muted>
        Reply in the app — buyers and sellers chat directly inside TeeBox. If
        someone asks you to take the deal off-platform, report the conversation
        from the message menu.
      </P>
    </Base>
  );
}

module.exports = NewMessageDigest;
module.exports.subject = (ctx) => {
  const n = Number(ctx.totalNew || 1);
  const f = ctx.fromName || "a buyer";
  if (n > 1) return `${n} new messages from ${f}`.slice(0, 50);
  return `New message from ${f}`.slice(0, 50);
};
