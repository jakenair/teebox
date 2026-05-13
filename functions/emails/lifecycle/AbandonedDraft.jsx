/**
 * AbandonedDraft — SCAFFOLDED
 * Sends 24h after a draft listing was last updated without being submitted.
 *
 * TODO: pull recent draft photo URL, plug into the preview thumbnail.
 * TODO: A/B test subject between "Finish your listing" vs.
 *       "Your draft is still waiting".
 * TODO: copy review by marketing.
 */
const React = require("react");
const {Base, Button, H1, P} = require("../layout/Base");

function AbandonedDraft({user = {}, draft = {}}) {
  const title = draft.title || "your draft";
  const url = `https://teeboxmarket.com/sell?draft=${draft.id || ""}`;
  return (
    <Base
      preview="You started a listing yesterday. Finish it in 60 seconds."
      uid={user.uid}
      category="abandonedDraft"
    >
      <H1>Finish your listing</H1>
      <P>
        {/* TODO: warmer copy */}
        You started <strong>{title}</strong> yesterday but didn't hit publish.
        Most sellers wrap it up in under a minute.
      </P>
      <Button href={url}>Finish listing</Button>
    </Base>
  );
}

module.exports = AbandonedDraft;
module.exports.subject = () => "Finish your TeeBox listing";
