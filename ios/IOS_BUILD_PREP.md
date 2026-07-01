# iOS build prep notes

## Native launch screen pixel-match (no flash/jump before WKWebView)

Goal: the iOS native launch screen (shown before the WKWebView loads) visually
matches the web app's first-paint splash (`#authSplash` in `index.html`) so
there is no flash or content jump when the webview takes over.

### Design tokens (extracted from index.html)
- Background: `--green-950` = `#0b1a0e`
- Wordmark "TeeBox": Playfair Display, weight 900, font-size 2.6rem (= 41.6px),
  letter-spacing 0.5px, line-height 1. "Tee" = `--gold-400` `#e0b840`,
  "Box" = `--white` `#ffffff`.
- Tagline: "The Premier Golf Marketplace", DM Sans, 14px (0.875rem), weight 500,
  color `rgba(255,255,255,0.6)`, 8px below the wordmark.
- Spinner (web): 26x26 ring, 2.5px `rgba(255,255,255,0.18)`, top-color
  `--gold-400` `#e0b840`.

### What changed for the native side
- New asset catalog imageset: `App/App/Assets.xcassets/LaunchWordmark.imageset/`
  (`wordmark@1x/2x/3x.png`, transparent). The "TeeBox" wordmark was rendered via
  headless Chrome using the real Playfair Display 900 webfont (Playfair is not an
  iOS system font, so it must be a baked image — do NOT swap it for Georgia).
  Glyph box is 146.9x41.6pt with 10pt L/R + 6pt T/B transparent padding
  (PNG = 167x54pt logical at @1x).
- `App/App/Base.lproj/LaunchScreen.storyboard`: bg `#0b1a0e`; centered
  `LaunchWordmark` image view (167x54pt, scaleAspectFit). The wordmark centerY
  constraint is **-46pt** from screen center on purpose: in the web flex-column
  splash the wordmark+tagline+spinner are centered as a group, so the wordmark
  sits 46pt above true center. The tagline anchors 2pt below the image bottom
  (= 8pt below the glyph baseline once the 6pt image padding is accounted for).
- `capacitor.config.ts` SplashScreen plugin: `showSpinner: true`,
  `iosSpinnerStyle: 'large'`, `spinnerColor: '#e0b840'` (gold, matches web),
  `backgroundColor: '#0b1a0e'`, `launchAutoHide: true`, `launchShowDuration: 1500`.
  The static storyboard cannot animate; the gold spinner is supplied by the
  SplashScreen plugin over the same `#0b1a0e` bg so there is no seam.

### Overlay-diff verification
Rendered the real web `#authSplash` and a native composite (bg + wordmark image +
tagline, mirroring the storyboard constraints) at iPhone 15 Pro 393x852 @3x and
diffed per-pixel.
- Before alignment fix: 1.72% pixels differ (wordmark sat ~46pt too low).
- After the -46pt centerY correction: **0.44% pixels differ total**, and of that
  ~0.42% is sub-pixel anti-aliasing fringe along glyph/tagline edges (the fills
  overlap — no positional offset). The only structural difference is the web
  spinner (intentionally absent from the static storyboard; provided at runtime
  by the SplashScreen plugin). Result: close / near-pixel-perfect match,
  position + colors confirmed.

### Plugins / pods (from `npx cap sync ios`)
`npx cap sync ios` completed cleanly (Capacitor CLI 7.6.2; `pod install` ran).
6 Capacitor plugins detected — no new plugin added for this change:
- @capacitor-firebase/authentication@7.5.0
- @capacitor/app@7.1.2
- @capacitor/push-notifications@7.0.6
- @capacitor/share@7.0.4
- @capacitor/splash-screen@7.0.5
- @capacitor/status-bar@7.0.6

No new pods are required for this build beyond what `pod install` already resolved.
The synced `App/App/capacitor.config.json` reflects the gold-spinner SplashScreen
settings above.

### Build checklist
- [ ] Open `App.xcworkspace`, confirm LaunchScreen renders the gold/white
      "TeeBox" wordmark centered on `#0b1a0e` (clean install / first launch).
- [ ] Confirm the gold spinner appears under the wordmark during the ~1.5s
      launch window, then the WKWebView's own `#authSplash` takes over with no
      visible jump.
- [ ] Set the build number: read the next build number from App Store Connect
      (the highest build for the shipping version + 1) — do NOT hardcode a
      number here, and do NOT reuse a number already on TestFlight (ASC rejects
      duplicates). Then archive.

## Pending build-69 changes (do NOT apply until build 68 is uploaded AND accepted by Apple)

`capacitor.config.ts` is intentionally frozen until 68 clears review so nothing
leaks into 68 via `cap sync`.

- [ ] **Safe-area / top status-bar strip fix.** Set `StatusBar.overlaysWebView: true`
      (currently `false` with `backgroundColor: '#0b1a0e'`, which paints an opaque
      near-black native bar above the green-800 web header → the mismatched dark
      strip). With overlay on, the WKWebView extends under the status bar and the
      web side already covers it: `viewport-fit=cover` + `.mobile-top-bar`
      `padding-top: env(safe-area-inset-top)` + `body` bg `--green-800`
      (all shipped in web r136). Confirm that web safe-area padding still fully
      covers the inset once overlay is on.
- [ ] **Real-device safe-area check on 69**: on a notched iPhone, confirm the top
      reads as one continuous green with no seam/line, in both portrait and (if
      supported) landscape (left/right insets). Cannot be verified in headless.
