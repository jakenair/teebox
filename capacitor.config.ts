import type { CapacitorConfig } from '@capacitor/cli';

// TeeBox — Capacitor configuration.
//
// `webDir` is the folder Capacitor copies into the native app on
// `npx cap sync`. We point at the project root because the site is
// a single static index.html with no build step. The .capacitorignore
// file controls what's excluded from the copy.
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
      providers: ['google.com'],
    },
  },
};

export default config;
