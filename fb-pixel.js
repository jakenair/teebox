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
    // Opt-outs FIRST (CCPA/CPRA "Do Not Sell or Share", privacy.html
    // §do-not-share): the toggle sets BOTH localStorage and a first-party
    // cookie (tb_dnsps=1) so the choice survives either store being
    // cleared. Honored before anything else, alongside the Global
    // Privacy Control browser signal.
    if (navigator.globalPrivacyControl === true) return;
    try { if (window.localStorage && localStorage.getItem('tb_dnsps') === '1') return; } catch (_e) {}
    if (/(^|;\s*)tb_dnsps=1(;|$)/.test(document.cookie || '')) return;
    if (window.Capacitor && window.Capacitor.isNativePlatform &&
        window.Capacitor.isNativePlatform()) return;
    if (!/^https?:$/.test(window.location.protocol)) return;
  } catch (_e) { /* guard errors → fail closed (no pixel) */ return; }

  // r262 (Phase 2): the loader body runs at idle. fbevents.js + the signals
  // config are ~244KB and were competing with the feed for bandwidth and
  // main thread during boot; on a throttled phone products did not paint
  // until 10.5s. PageView still fires exactly once, a beat later — which is
  // how Meta's async snippet is designed to behave anyway.
  const boot = function () {
  /* eslint-disable */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  window.fbq('init', '4535316483381655');
  window.fbq('track', 'PageView');
  };
  try {
    (window.requestIdleCallback || function (f) { setTimeout(f, 1800); })(
        boot, {timeout: 4000});
  } catch (_e) { setTimeout(boot, 1800); }
})();
