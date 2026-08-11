# TeeBox project conventions

Living document. If you're adding UI chrome, prompts, or shipping a release,
read the relevant section FIRST — these rules exist because we broke each of
them once.

## The ambient overlay rule (r194)

An **ambient overlay** is any prompt the user didn't ask for: the
marketing-consent banner, the install banner, the seller tour — and the next
one you're about to add. All of them go through `window.__ambient`
(index.html, "AMBIENT OVERLAY QUEUE"). The rule:

1. **At most ONE ambient prompt per page-load.** Losers forfeit to a future
   session. Never show a second prompt after the first is dismissed.
2. **Never render over a task surface** (any open modal, backdrop, the auth
   screen, the dashboard — anything the user is actively doing). If a task
   surface opens while a prompt is visible, the prompt **yields: hide and
   forfeit** for the session. **Nothing ever interrupts the sell form. No
   exceptions.**
3. **Priority for the single slot:** contextual > passive > interruptive —
   `tour(3) > install(2) > consent(1)`. Register new prompts in the
   `PRIORITY` map with this taxonomy in mind.
4. **Deliberately OUTSIDE the queue:** the verify-email banner. It is
   functional, not marketing — error handlers must be able to surface it
   contextually, even over the sell form (that's the r188 dead-end fix).
   Don't "clean it up" into the queue.

To add a new ambient prompt: call
`window.__ambient.request(name, { show, hide, surface? })` instead of showing
it directly, add its priority, and call `window.__ambient.done(name)` in every
path that closes it. If you're not sure whether something is ambient: if the
user didn't tap something to cause it, it's ambient.

## Release checklist (web)

- One r-number per change. Bump BOTH: `sw.js` `CACHE_VERSION`
  (`teebox-v1-YYYY-MM-DD-rNNN`) **and** the auth-screen build stamp
  (`<span class="auth-build">rNNN</span>` in index.html). The stamp shipped
  stale r187–r190 because it wasn't in the habit loop.
- Any CSS or dead-code change gets a full-page visual verification before
  push (r149 hero incident).
- `ios/App/App/public/` only updates when `npm run cap:sync` runs — web revs
  do NOT reach the app bundle by themselves. Before any archive: run cap:sync
  once, then verify the bundle (see `.internal-docs/` verify-bundle pattern),
  then archive.

## iOS distribute

- Xcode Distribute: **uncheck "Manage Version and Build Number"** — the
  auto-bump silently drifts project.pbxproj after every upload (83/1.8.1 and
  90→92 incidents). pbxproj is source of truth; archives' Info.plist
  `Distributions` blocks are the upload history, not pbxproj.
