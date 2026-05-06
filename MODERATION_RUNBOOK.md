# TeeBox Moderation Runbook

Operational guide for the listing moderation pipeline: what runs, what
flags a listing, how to handle the queue, and how to escalate.

---

## TL;DR

1. Every listing photo is auto-scanned by **Cloud Vision SafeSearch**
   in `optimizeListingPhoto` (Cloud Function, Storage trigger).
2. If the photo trips the policy, the photo is deleted, the listing is
   marked `status: 'flagged'`, and a mirror document is written to
   `flaggedListings/{listingId}`.
3. The admin (`jakenair23@gmail.com`) opens the queue at
   **`https://teeboxmarket.com/?admin=moderation`** to Approve / Reject
   / Skip each entry.
4. Text-side moderation (`moderateListingOnCreate`) deletes any
   listing whose title/brand/desc/cat/condition contains a blocklisted
   slur or sexual term — that pass runs *before* SafeSearch and may
   pre-empt it.
5. Profile fields (`displayName`, `bio`, `location`) are also swept
   on every write by `moderateProfileOnWrite`.

---

## What triggers a flag

### Photo-side (Cloud Vision SafeSearch)

The Vision API returns five signals per image:

| Signal     | What it means                                    |
|------------|--------------------------------------------------|
| `adult`    | Nudity, sexual acts                              |
| `racy`     | Suggestive but not explicit (lingerie, etc.)     |
| `violence` | Blood, weapons aimed at people, gore             |
| `medical`  | Surgery, wounds — *not enforced* (false positives on legit injury photos) |
| `spoof`    | Memes / image macros — *not enforced*            |

Each is one of: `VERY_UNLIKELY` · `UNLIKELY` · `POSSIBLE` · `LIKELY` · `VERY_LIKELY`.

`isSafeForMarketplace()` in `functions/index.js` returns **false** if:

- `adult` is `LIKELY` or `VERY_LIKELY`
- `racy` is `LIKELY` or `VERY_LIKELY`
- `violence` is `VERY_LIKELY`

We deliberately do **not** block on `POSSIBLE` adult/racy because
real listings (close-ups of a putter grip, swim trunks, etc.) often
score there.

### Text-side (server blocklist)

`functions/index.js` exports `EXPLICIT_BLOCKLIST` — a hardcoded set of
slurs, profanity, and sexual terms with full word-boundary matching.
Hit on any of `title`, `brand`, `desc`, `cat`, `condition` triggers an
**immediate listing delete** (no manual review — it never enters the
queue). The same list and matcher is mirrored in `index.html` as
`window.EXPLICIT_BLOCKLIST` / `window.findExplicitContent` for
client-side pre-submit blocking, but the Cloud Function is the
authoritative gate.

### Profile-side

`moderateProfileOnWrite` runs the same blocklist on
`displayName`/`bio`/`location` after every profile update. A hit
**clears the offending field** (sets it to `""`) — we don't delete
the profile because the user still needs an account.

---

## The admin queue UI

URL: `?admin=moderation` (e.g. `https://teeboxmarket.com/?admin=moderation`).

### Access control (defense in depth)

1. **Client gate:** `isModerationAdmin()` checks
   `window.CURRENT_USER.email === 'jakenair23@gmail.com'` and
   `emailVerified === true`. Failure shows a "Not authorized" toast
   and strips the query param.
2. **Firestore rules:** `flaggedListings/{listingId}` read is gated
   by `isAdmin()` which checks the same email allowlist on the JWT.
   A non-admin can hit the URL but the read fails.
3. **Storage rules:** Listing photo `delete` accepts either the owner
   or `isAdmin()` so the "Reject + delete" button works without a
   callable.

### What the buttons do

- **Approve** — sets `status='active'`, deletes the
  `moderationFlags` map, removes the `flaggedListings/{id}` doc.
  The listing reappears on the marketplace immediately.
- **Reject + delete** — wipes the entire `listings/{sellerId}/{listingId}`
  storage folder, then deletes the listing doc, then the queue mirror.
  Permanent. The seller is **not** auto-notified of rejection (the
  Cloud Function already sent them "listing under review" at flag
  time).
- **Skip** — animates the card away, no writes. Useful for "I want to
  review this on a bigger screen" — the next page load shows it again.

---

## Cost estimate (Cloud Vision SafeSearch)

Pricing: **first 1,000 calls/month free, then $1.50 per 1,000 calls**
(SafeSearch tier as of 2026-05). Each photo upload = one call.

| Photos/month | Calls    | Free tier  | Billable | Cost       |
|--------------|----------|------------|----------|------------|
| 100          | ~300     | 300 free   | 0        | **$0.00**  |
| 1,000        | ~3,000   | 1,000 free | 2,000    | **$3.00**  |
| 10,000       | ~30,000  | 1,000 free | 29,000   | **$43.50** |

(Assuming an average of 3 photos/listing, which matches the enforced
3-photo minimum from `enforceListingPhotosMinimum`.)

If billing goes haywire, the Cloud Function is set up to **fail open**
— if the Vision call throws (quota, billing disabled, network), it
logs an error and lets the photo through. Backstops are: text
blocklist, the report-listing button, and this manual queue.

---

## False-positive whitelisting

If a legitimate listing keeps tripping SafeSearch, options in order
of preference:

1. **Adjust thresholds** in `isSafeForMarketplace()` (e.g. require
   `racy === 'VERY_LIKELY'` instead of `LIKELY`). One-line change in
   `functions/index.js`.
2. **Per-seller whitelist** — add a `bypassPhotoModeration: true`
   field to the seller's profile doc and short-circuit the Vision
   call when set. *Not implemented yet — add only after a reputable
   seller hits a repeat false positive.*
3. **Per-image override** — admin clicks Approve in the queue. The
   listing returns to active. SafeSearch is per-upload so the user
   would have to re-upload the same image to trip again.

For text false positives (e.g. "Dick's Sporting Goods" in a brand
field — `\bdick\b` matches the apostrophe boundary), edit
`EXPLICIT_BLOCKLIST` in both `functions/index.js` and `index.html`.
The current list intentionally excludes ambiguous golf brand terms
(`cobra`, `sub 70`, `titleist`, `taylormade`).

---

## Escalation flow

1. **Repeat offender** — same `sellerId` shows up 3+ times in the
   queue: revoke their `verifiedSeller` flag in their profile doc,
   then delete their account via the Firebase Console (`Authentication
   → Users → ...`). Listings cascade-delete via the existing
   `onUserDelete` cleanup.
2. **CSAM (child sexual abuse material)** — if you see this, do
   **not** download, do **not** screenshot. Press **Reject + delete**,
   then file a NCMEC CyberTipline report at
   <https://report.cybertip.org>. Cloud Storage retains deleted
   objects for 30d in soft-delete; preserve evidence by noting the
   listing ID + flagged-at timestamp before deleting.
3. **Vision API outage** — if SafeSearch starts failing across the
   board (check Cloud Logging for repeated `SafeSearch detection
   failed` errors), the function continues to allow uploads. Watch
   the queue and the report-listing inbox more closely until it
   recovers.

---

## Files involved

| File                              | Role                                       |
|-----------------------------------|--------------------------------------------|
| `functions/index.js`              | `optimizeListingPhoto`, `moderateListingOnCreate`, `moderateProfileOnWrite`, `EXPLICIT_BLOCKLIST`, `isSafeForMarketplace` |
| `functions/package.json`          | `@google-cloud/vision` dep                 |
| `index.html`                      | Admin queue UI, `window.EXPLICIT_BLOCKLIST`, `?admin=moderation` route, modal markup + CSS |
| `firestore.rules`                 | `isAdmin()`, listing admin update rule, `flaggedListings/{id}` read rule |
| `storage.rules`                   | `isAdmin()`, listing photo admin delete    |
| `MODERATION_RUNBOOK.md`           | This file                                  |

---

## Manual setup (one-time)

Before deploying the function:

1. **Enable Cloud Vision API** in the
   [Google Cloud Console](https://console.cloud.google.com/apis/library/vision.googleapis.com)
   for the `teebox-market` project.
2. **Install the dep** in `functions/`:
   ```sh
   cd functions && npm install @google-cloud/vision
   ```
3. **Deploy** functions, firestore rules, storage rules, hosting:
   ```sh
   firebase deploy --only functions:optimizeListingPhoto,functions:moderateProfileOnWrite,firestore:rules,storage,hosting
   ```
4. **Verify** by uploading a deliberately racy test image to a
   throwaway listing — the photo should be deleted within ~30s and
   the listing should appear in `?admin=moderation`.

The Cloud Function uses Application Default Credentials, which work
out-of-the-box on the Functions runtime — no service-account keys
needed.
