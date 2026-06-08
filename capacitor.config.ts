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
    contentInset: 'always',
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
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'LIGHT',          // light content on dark green nav background
      backgroundColor: '#0b1a0e',
      overlaysWebView: false,
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
