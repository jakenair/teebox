# New-message push — manual test plan

Scope: the `notifyNewMessage` Cloud Function trigger (in
`functions/pushTriggers.js`) plus the client wiring in `index.html`.
Run with two accounts (A = sender, B = recipient) on devices that have
registered FCM tokens via `maybeRegisterPush` / `maybeRegisterPushNative`.

## Scenarios

1. **Foreground, same thread.** B has the chat open with A. A sends.
   Expected: no push banner. Message appears via snapshot. Server log
   shows `recipient … viewing … skipping push`.
2. **Foreground, different tab.** B is browsing listings (inbox closed).
   A sends. Expected: no banner toast; the `.unread-badge` increments;
   if B opens the inbox the new conv is at the top with the dot.
3. **Foreground, inbox open.** B has the inbox panel open. A sends.
   Expected: no banner; `loadInbox()` re-runs; new message preview shows.
4. **Background.** B's app is backgrounded. A sends. Expected: native
   banner (iOS) / heads-up (Android) with `senderName` + body preview.
5. **Terminated.** B's app is killed. A sends. Expected: banner; tap
   launches app and routes to the thread via `routePushNotificationTap`.
6. **Coalescing.** A sends 5 messages within 60s while B is backgrounded.
   Expected: ONE notification, body = `"5 new messages"`, single
   `pushPending/{B}_{A}_{cid}` doc with `count: 5`.
7. **HARD-flagged inbound.** A sends "venmo me $50". Expected: B gets
   `"You have a new message"` (no preview body), in-app interstitial
   still gates the bubble.
8. **Held message.** sendMessage callable holds A's message
   (`held: true`). Expected: no push at all. Log: `held; skipping push`.
9. **Recipient blocked sender.** Firestore rules reject A's create —
   trigger never fires. No push, no `pushPending` doc.
10. **Quiet hours.** B's `pushPrefs.quietHours` covers now. Expected:
    `sendPush` returns `skipped: "quiet-hours"`; no banner; in-app
    notification doc (if upstream writes one) still bumps the bell.

## Outstanding UX decisions

- Should active-negotiation threads (offer pending) bypass quiet hours?
  Current behavior: no.
- Should SOFT-flagged messages also use the sanitized preview? Current:
  no — only HARD.
