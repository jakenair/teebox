// TeeBox — Meta Pixel loader. WEB ONLY.
//
// Served from the site root and referenced by every HTML page's <head>.
// Deliberately NOT copied into dist/ by build:web, so the iOS Capacitor
// bundle ships without any pixel code (the <script src> 404s harmlessly
// in-app). Native tracking = ATT prompt + Meta SDK, a separate decision.
//
// Belt-and-braces: even if this file ever lands in a native bundle, the
// guards below no-op it (Capacitor runtime present, or a non-http(s)
// scheme like capacitor://).
//
// PageView fires exactly ONCE per page load — the app is a SPA and no
// route-change PageView calls exist anywhere. Standard events are fired
// from index.html app code via fbTrack(), which guards on window.fbq
// (undefined natively, so every call no-ops there too). No PII is ever
// sent in event params.
(function () {
  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform &&
        window.Capacitor.isNativePlatform()) return;
    if (!/^https?:$/.test(window.location.protocol)) return;
  } catch (_e) { /* guard errors → fail closed (no pixel) */ return; }

  /* eslint-disable */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  window.fbq('init', '4535316483381655');
  window.fbq('track', 'PageView');
})();
