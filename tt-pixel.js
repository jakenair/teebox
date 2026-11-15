// TeeBox — TikTok Pixel loader. WEB ONLY (2026-11-15, Dylan).
//
// Same rules as /fb-pixel.js:
//   - Do Not Sell or Share (tb_dnsps, localStorage + cookie) and Global
//     Privacy Control are honoured FIRST: opted-out visitors never load it.
//   - No-ops in the native shell; build:web strips the tag and deletes this
//     file from dist/ (scripts/strip-pixel-for-ios.mjs).
//   - Boots at idle after the product grid paints.
//   - Events come from index.html window.fbTrack(), which mirrors ViewContent,
//     AddToCart, InitiateCheckout and Purchase here with the SAME event id it
//     gives Meta, so TikTok dedupes the pixel against the Events API copy.
//   - Advanced matching: hashed email only (ttq.identify with a SHA-256
//     value computed in the browser). Never phone.
//
// ── CONFIG ──────────────────────────────────────────────────────────────
// The TikTok pixel code (TikTok Ads Manager → Tools → Events → Web Events).
// Public by nature. EMPTY = pixel off. Keep the same value in
// functions/tiktokEvents.js (TIKTOK_PIXEL_ID).
var TEEBOX_TIKTOK_PIXEL_ID = 'DBSAT0BC77UDGS03KQN0'; // dataset "TeeBox Web"
(function () {
  try {
    if (!TEEBOX_TIKTOK_PIXEL_ID) return;
    if (navigator.globalPrivacyControl === true) return;
    try { if (window.localStorage && localStorage.getItem('tb_dnsps') === '1') return; } catch (_e) {}
    if (/(^|;\s*)tb_dnsps=1(;|$)/.test(document.cookie || '')) return;
    if (window.Capacitor && window.Capacitor.isNativePlatform &&
        window.Capacitor.isNativePlatform()) return;
    if (!/^https?:$/.test(window.location.protocol)) return;
    // Production host only (same rule as fb-pixel.js, 2026-11-15).
    if (!/^(www\.)?teeboxmarket\.com$/.test(window.location.hostname)) return;
  } catch (_e) { return; }

  var boot = function () {
    /* eslint-disable */
    !function (w, d, t) {
      w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || [];
      ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
      ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
      ttq.load = function (e, n) {
        var r = "https://analytics.tiktok.com/i18n/pixel/events.js";
        ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r; ttq._t = ttq._t || {}; ttq._t[e] = +new Date; ttq._o = ttq._o || {}; ttq._o[e] = n || {};
        n = document.createElement("script"); n.type = "text/javascript"; n.async = !0; n.src = r + "?sdkid=" + e + "&lib=" + t;
        e = document.getElementsByTagName("script")[0]; e.parentNode.insertBefore(n, e);
      };
      ttq.load(TEEBOX_TIKTOK_PIXEL_ID);
      ttq.page();
    }(window, document, 'ttq');
    /* eslint-enable */
    window.__ttReady = true;
    try { if (typeof window.ttIdentify === 'function') window.ttIdentify(); } catch (_e) {}
    // Replay events fired before boot (queued by ttMirror in index.html),
    // same event ids as their server copies.
    try {
      var pend = window.__ttPending || []; window.__ttPending = [];
      for (var i = 0; i < pend.length; i++) window.ttq.track(pend[i][0], pend[i][1], pend[i][2]);
    } catch (_e) {}
  };
  try {
    var idle = function (f, t) {
      try { (window.requestIdleCallback || function (g) { setTimeout(g, t); })(f, {timeout: t + 2000}); }
      catch (_e) { setTimeout(f, t); }
    };
    if (!document.getElementById('productGrid')) { idle(boot, 1200); }
    else {
      var t0 = Date.now();
      var tick = function () {
        var grid = document.getElementById('productGrid');
        if ((grid && grid.querySelector('.product-card')) || Date.now() - t0 > 7000) return idle(boot, 400);
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    }
  } catch (_e) { setTimeout(boot, 2500); }
})();
