/**
 * ListingPhotoRemoved — transactional. Sent by optimizeListingPhoto when the
 * ONLY photo(s) on a listing failed moderation and were removed, leaving the
 * listing hidden with nothing to show. The seller has to act (re-upload);
 * approval alone cannot bring the listing back. Added r346 (2026-10-16).
 */
const React = require("react");
const {Base, Button, H1, P, Kicker} = require("../layout/Base");

function ListingPhotoRemoved({listingId = "", title = "your listing"}) {
  const url = `https://teeboxmarket.com/?listing=${encodeURIComponent(listingId)}`;
  return (
    <Base preview="A photo was removed and your listing is hidden until you add one." category="transactional">
      <Kicker>Action needed</Kicker>
      <H1>Please re-upload a photo</H1>
      <P>
        A photo on <strong>{title}</strong> could not be approved by our
        automated check and was removed. That was the only photo, so the
        listing is hidden from buyers for now.
      </P>
      <P>
        Add a clear photo of the item from My Shop and the listing goes live
        again. If the removed photo was fine, reply to this email and we will
        take a look.
      </P>
      <Button href={url}>Open the listing</Button>
    </Base>
  );
}

module.exports = ListingPhotoRemoved;
module.exports.subject = ({title} = {}) =>
  `Please re-upload a photo for ${title || "your TeeBox listing"}`;
