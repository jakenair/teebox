import type { CapacitorConfig } from '@capacitor/cli';

// TeeBox — Capacitor configuration.
//
// `webDir` is the folder Capacitor copies into the native app on
// `npx cap sync`. We point at the project root because the site is
// a single static index.html with no build step. The .capacitorignore
// file controls what's excluded from the copy.
//
// LOGO BINGO NOTE (LOGO_BINGO_DIAGNOSIS.md):
// The dist/ payload still includes /assets/logos/*.png for general
// asset serving. For Logo Bingo, those bundled PNGs are now offline
// fallback only — the live daily puzzle's canonical CDN URLs come
// from /dailyPuzzles/{date} in Firestore, written by the
// generateDailyBingoPuzzle scheduled Cloud Function. Don't add native
// iOS code that performs local puzzle selection — the CI check in
// scripts/check-bingo-single-source.mjs guards against that.
const config: CapacitorConfig = {
  appId: 'com.teeboxmarket.app',
  appName: 'TeeBox',
  webDir: 'dist',
  bundledWebRuntime: false,
  ios: {
    // r171: 'never', paired with StatusBar.overlaysWebView: true below. The
    // old 'always' + overlays:false combo double-inset the page: the webview
    // was laid out below the status bar (so env(safe-area-inset-top) = 0)
    // AND WKWebView auto-added a safe-area content inset — the "extra green
    // block" above the header. In overlay mode the CSS env() rules (mobile
    // top bar / cat-bar / main offsets) carry the inset exactly once.
    contentInset: 'never',
    backgroundColor: '#0b1a0e',
    // Avoid the swipe-back gesture interfering with horizontal-swipe UI.
    allowsLinkPreview: false,
    scrollEnabled: true,
  },
  android: {
    backgroundColor: '#0b1a0e',
    allowMixedContent: false,
    captureInput: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#0b1a0e',
      androidScaleType: 'CENTER_CROP',
      // Gold spinner to match the web auth-splash spinner (--gold-400 #e0b840),
      // shown over the #0b1a0e launch screen so there's no seam before the
      // WKWebView's own #authSplash takes over.
      showSpinner: true,
      iosSpinnerStyle: 'large',
      spinnerColor: '#e0b840',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'LIGHT',          // light content on dark green nav background
      backgroundColor: '#0b1a0e',
      // r171: webview extends under the status bar; the fixed header's
      // env(safe-area-inset-top) padding owns the inset (see ios.contentInset).
      overlaysWebView: true,
    },
    FirebaseAuthentication: {
      providers: ['google.com', 'apple.com'],
      // We run our own custom-token exchange (idToken -> exchangeIdToken
      // ForCustomToken -> signInWithCustomToken on the JS SDK inside the
      // WKWebView). skipNativeAuth makes signInWithGoogle/Apple RETURN the
      // credential WITHOUT also signing into the *native* Firebase Auth layer
      // — which the webview never uses and which is an extra runtime failure
      // point (its throw surfaces as an immediate "Could not sign in"). We
      // only need the returned idToken.
      skipNativeAuth: true,
    },
  },
};

export default config;
