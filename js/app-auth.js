// app-auth.js — extracted from index.html (r349 cold-load, Stage C). ES module: Firebase boot, auth, sell flow.
// Edit here; index.html only carries the <script src> tag. Served gzipped and cached by GitHub Pages.

  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
  import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app-check.js";
  // Note: `sendPasswordResetEmail` and `sendEmailVerification` are intentionally
  // NOT imported here — we replaced both with branded Cloud Functions
  // (`sendBrandedPasswordReset` / `sendBrandedVerification`) that ship via
  // Resend from `noreply@mail.teeboxmarket.com` (DKIM/SPF-signed, on-brand HTML).
  import { getAuth, initializeAuth, onAuthStateChanged, signOut as fbSignOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithCredential, signInWithCustomToken, setPersistence, browserLocalPersistence, inMemoryPersistence, indexedDBLocalPersistence, browserPopupRedirectResolver, updateProfile as fbUpdateProfile } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
  import { getFirestore, collection, addDoc, getDocs, getDoc, setDoc, doc, deleteDoc, orderBy, query, limit, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
  import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js";
  import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js";

  const firebaseConfig = {
    apiKey: "AIzaSyAQ7vikZutCQfAaXybQnJcfgnlqpXxHTr4",
    authDomain: "teebox-market.firebaseapp.com",
    projectId: "teebox-market",
    storageBucket: "teebox-market.firebasestorage.app",
    messagingSenderId: "982122063122",
    appId: "1:982122063122:web:416617dcacf912c907bfcb"
  };

  const app = initializeApp(firebaseConfig);

  // ──────────────────────────────────────────────────────────
  // Global Privacy Control — honour the browser-level "do not sell
  // or share" signal. We don't run third-party ads/trackers today,
  // but capturing it on window lets downstream code (analytics, future
  // SDKs) gate on it without re-reading navigator on every call.
  // ──────────────────────────────────────────────────────────
  if (typeof navigator !== 'undefined' && navigator.globalPrivacyControl === true) {
    window.__gpc = true;
  }

  // ──────────────────────────────────────────────────────────
  // App Check — registers a reCAPTCHA Enterprise token with every
  // Firebase request so bots/scripts running outside the live site
  // can't spam Firestore/Storage/Functions even if they exfil the
  // public API key.
  //
  // Currently in MONITORING mode: clients send tokens, but the
  // backend doesn't reject requests without one. To go to enforcement:
  //   1. Watch the App Check dashboard for ~10 min — verify tokens
  //      are flowing on every Firestore endpoint (green graph).
  //   2. Firebase console → App Check → APIs → flip Firestore /
  //      Storage / Cloud Functions to "Enforced".
  //   3. In firestore.rules, change `function appCheckOk()` from
  //      `return true;` to `return request.app != null;` and
  //      redeploy with `firebase deploy --only firestore:rules`.
  //   0. ⚠ DO THIS FIRST (standing note, 2026-09-24, r263): this init is
  //      DEFERRED — it runs via __afterFeedPaint(), after the first product
  //      card renders, because the reCAPTCHA Enterprise bundle is 346KB and
  //      was the single heaviest script on the page (Phase 2). The deferral
  //      is only safe while App Check is monitor-only: with enforcement on,
  //      anything that calls Firestore/Storage/Functions before the feed
  //      paints would fail for want of a token. Undo or re-gate the
  //      deferral BEFORE enabling enforcement in steps 1-3.
  // ──────────────────────────────────────────────────────────
  // CRITICAL: skip App Check entirely on native (Capacitor) builds.
  // ReCaptchaEnterpriseProvider expects a real browser top-frame origin and
  // hangs forever in Capacitor's `capacitor://localhost` WebView while trying
  // to mint a token. Once initialized, the Firebase Auth SDK attaches an
  // App Check token to every Identity Toolkit request, so a hung mint =
  // hung signInWithCredential() = stuck "Signing in…" modal. Confirmed via
  // Build 40 diagnostics: both flows stop at G5/A5 ("calling
  // signInWithCredential") and never reach G6/A6.
  //
  // Server-side `appCheckOk()` returns `true` (not enforcing), so skipping
  // the client init is safe — no requests will be rejected. We only lose
  // monitoring telemetry on the iOS app, which we weren't using yet.
  // Re-introduce when Firebase ships a Capacitor-friendly attestation
  // provider (DeviceCheck / AppAttest) and we wire it conditionally.
  // (NB: don't redeclare `Cap` here — it's already declared further down
  //  in this same module at the auth-init block. Use a one-shot temp.)
  const _capForAppCheck = (typeof window !== 'undefined') ? window.Capacitor : null;
  const _isNativeForAppCheck = !!(_capForAppCheck && _capForAppCheck.isNativePlatform && _capForAppCheck.isNativePlatform());
  if (!_isNativeForAppCheck) {
    // try/catch so an App Check provider hiccup (network blip, key not yet
    // propagated, etc.) doesn't break app boot on day 1 of Phase 1 rollout.
    // Phase 2 will turn on enforcement at the dashboard once the monitor
    // metrics confirm >95% of legit traffic carries valid tokens.
    // r262 (Phase 2): defer init to idle. The reCAPTCHA Enterprise bundle
    // is 346KB — the single heaviest script on the page — and it was being
    // fetched during boot on a page that cannot use it yet. App Check is
    // MONITOR-ONLY here (appCheckOk() returns true server-side, see the
    // comment above), so nothing is rejected while it is pending; we only
    // delay telemetry by a couple of seconds.
    const __initAppCheck = () => {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider("6LdczNMsAAAAAIe7ed3zsqW0p_KzkBKSOIMdX1ac"),
        isTokenAutoRefreshEnabled: true,
      });
    } catch (e) {
      // Non-fatal: dashboard will show this client as unverified, but
      // requests still go through (Phase 1 is monitor-only).
      console.warn('App Check init failed:', e && e.message);
    }
    };
    // r325: feed-paint alone was not late enough. The feed paints at ~4.5s on
    // a throttled phone, so the reCAPTCHA Enterprise bundle's ~973ms of main
    // thread landed right as the gate became interactive. App Check here is
    // MONITOR-ONLY (appCheckOk() returns true server-side), so the token has
    // no deadline at all — hold it until the page has been quiet for a while.
    // Auth requests made before this lands simply carry no App Check token,
    // which is exactly what happens today on every native build.
    const APPCHECK_FLOOR_MS = 10000;
    const __deferAppCheck = () => {
      // r350 AUTH HOLD: App Check is monitor-only (appCheckOk() is true server-
      // side, every service UNENFORCED), so it has no deadline — but once it is
      // initialised the Auth SDK waits for an App Check token before every
      // Identity Toolkit call, and its reCAPTCHA Enterprise bundle (~700 KB,
      // 4 requests) took 40 s on Slow 3G mid-sign-up (2026-10-20 timeline).
      // So: do not initialise while window.__authBusy() (sign-in screen open or
      // auth call in flight, ≤60 s). It still initialises in EVERY session once
      // the hold clears (poll every 3 s), so the App Check metrics stay whole.
      // !!! If App Check is ever ENFORCED on identitytoolkit (Auth), revisit
      // this: an enforced Auth would need the token BEFORE sign-in, and the
      // hold would have to become an early, awaited init instead.
      const attempt = () => { if (window.__authBusy && window.__authBusy()) { setTimeout(attempt, 3000); return; } __initAppCheck(); };
      (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(attempt, {timeout: 4000});
    };
    setTimeout(() => {
      if (window.__afterFeedPaint) window.__afterFeedPaint(__deferAppCheck, 4000);
      else __deferAppCheck();
    }, APPCHECK_FLOOR_MS);
  }

  // CRITICAL: on Capacitor (iOS WKWebView), Firebase Auth's default
  // persistence chain (browserLocal → indexedDB → in-memory) HANGS at
  // boot — IndexedDB init in WKWebView never resolves, which freezes
  // the entire auth subsystem. Every signIn* call then queues behind
  // that pending init forever (email, Google, Apple — all symptoms of
  // the same root cause, confirmed by frozen "Signing in…" state on
  // Build 50). The earlier setPersistence(inMemoryPersistence) AFTER
  // getAuth() was too late — getAuth() already kicked off the IndexedDB
  // probe.
  //
  // Fix: use initializeAuth() with persistence set explicitly at
  // creation time, so the SDK never touches IndexedDB on native.
  //
  // Tradeoff on native: signed-in state doesn't persist across cold
  // launches — user signs in each launch. Capacitor's webview discards
  // memory on OS kill anyway, so this is fine for v1.
  // Native uses an array fallback: localStorage first (survives page
  // navigations like /terms.html, /brand/*.html — without this, every
  // hard nav signs the user out), in-memory as backstop if localStorage
  // is unavailable. We avoid indexedDBLocalPersistence — IndexedDB init
  // hangs in WKWebView, which was the original bug we worked around with
  // inMemoryPersistence-only. localStorage is sync + reliable.
  // r349 cold-load: on web, initializeAuth WITHOUT popupRedirectResolver.
  // getAuth() wires the redirect resolver at init, which loads the Google
  // gapi iframe bundle (~40 KB gz + 2 requests) on every cold load even
  // though nobody is signing in yet. The resolver is passed explicitly to
  // signInWithPopup instead (window.__popupResolver below). Persistence is
  // the same browserLocalPersistence as before.
  let auth;
  try {
    auth = _isNativeForAppCheck
      ? initializeAuth(app, { persistence: [browserLocalPersistence, inMemoryPersistence] })
      : initializeAuth(app, { persistence: browserLocalPersistence });
  } catch (_e) {
    // Already initialised by another script → reuse it (behaviour unchanged).
    auth = getAuth(app);
  }
  window.__popupResolver = browserPopupRedirectResolver;

  const db = getFirestore(app);
  const storage = getStorage(app);
  const fns = getFunctions(app);
  let currentUser = null;

  // Perf: kick off the public listings fetch IMMEDIATELY, in parallel with
  // Firebase auth restoration. The listings query needs no auth (rules:
  // `allow read: if true`), so there's no reason to wait for onAuthStateChanged
  // to fire before the network round-trip starts — that wait was the bulk of
  // time-to-first-listing on a cold load. loadListings() consumes this promise
  // on its FIRST call (see __listingsPrefetch there); reloads fetch fresh so
  // data never goes stale. Best-effort: resolves to null on failure and
  // loadListings falls back to a live fetch. Cap must match LISTINGS_FETCH_CAP
  // in loadListings.
  try {
    window.__listingsPrefetch = getDocs(query(
      collection(db, 'listings'),
      orderBy('createdAt', 'desc'),
      limit(200)
    )).catch(() => null);
  } catch (_e) { window.__listingsPrefetch = null; }

  // Perf (r148): paint the feed at boot instead of waiting for auth restore.
  // The listings read needs no auth and the prefetch above is already in
  // flight, so this call shows the skeleton immediately and swaps in cards
  // the moment the prefetch resolves — time-to-first-card no longer pays the
  // ~2s cold auth-restore tax. onAuthStateChanged still calls loadListings()
  // once auth resolves, for a fresh role-aware fetch (existing behavior; that
  // second call is now a quiet in-place swap, not a skeleton flash).
  // The window export also revives the post-payment refresh at its
  // `if (window.loadListings)` guard, which was silently dead — the function
  // was never exported from this module.
  window.loadListings = loadListings;
  try { loadListings(); } catch (_e) {}

  // ── Dynamic Open Graph injection for shared listing links ──
  // When the SPA is opened with ?listing=<id>, fetch the listing doc
  // and overwrite the site-wide og:title / og:description / og:image /
  // og:url meta tags with the listing's own. Twitter Card mirrors get
  // the same updates so Twitter/X previews stay in sync. The Schema.org
  // JSON-LD is still emitted separately by injectListingJsonLd when the
  // detail modal opens — this is purely about social-share previews.
  //
  // LIMITATION: web crawlers (Slack, iMessage, Twitter, Discord,
  // Facebook) read meta tags from the HTML response BEFORE any JS runs.
  // This injection works for in-app share previews where the SPA is
  // already loaded (e.g. user A taps Share on a listing, copy-pasts the
  // URL into a chat in the same WebView session) but the public-internet
  // crawler case STILL falls back to the site-wide preview. A proper fix
  // requires server-side rendering or a per-listing static HTML page —
  // tracked in LAUNCH_READINESS.md HIGH-1 Path B.
  (async () => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const listingId = sp.get('listing');
      if (!listingId || !/^[A-Za-z0-9_-]{1,128}$/.test(listingId)) return;
      const { getDoc, doc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const snap = await getDoc(doc(db, 'listings', listingId));
      if (!snap.exists()) return;
      const d = snap.data() || {};
      // Title: prefer brand + title for SEO clarity; cap at 90 chars.
      const titleParts = [];
      if (d.brand) titleParts.push(String(d.brand));
      if (d.title) titleParts.push(String(d.title));
      const fullTitle = (titleParts.join(' ').trim() || 'TeeBox listing')
        .slice(0, 90);
      // Description: prefer first ~160 chars of the listing desc; fall
      // back to a price-bearing single-line summary.
      const askDollars = Number(d.ask || 0);
      const priceStr = askDollars > 0
        ? '$' + (askDollars % 1 === 0 ? askDollars.toFixed(0) : askDollars.toFixed(2))
        : null;
      const rawDesc = String(d.desc || '').replace(/\s+/g, ' ').trim();
      let dynDesc;
      if (rawDesc) {
        dynDesc = rawDesc.length > 160 ? rawDesc.slice(0, 157) + '…' : rawDesc;
      } else {
        dynDesc = priceStr
          ? `${fullTitle} for ${priceStr} on TeeBox.`
          : `${fullTitle} on TeeBox — the peer-to-peer golf marketplace.`;
      }
      // First photo as og:image; fall back to the default site image if
      // missing (e.g. listing in draft / photo-upload race).
      const firstPhoto = (Array.isArray(d.photos) && d.photos[0]) || d.photo || null;
      const ogImage = firstPhoto && /^https?:\/\//.test(String(firstPhoto))
        ? String(firstPhoto)
        : 'https://teeboxmarket.com/assets/og/og-default.png';
      const canonicalUrl =
        'https://teeboxmarket.com/?listing=' + encodeURIComponent(listingId);

      const setMeta = (selector, attr, value) => {
        const el = document.querySelector(selector);
        if (el) el.setAttribute(attr, value);
      };
      // Open Graph (Slack, iMessage, Facebook, Discord, LinkedIn)
      setMeta('meta[property="og:title"]', 'content', fullTitle);
      setMeta('meta[property="og:description"]', 'content', dynDesc);
      setMeta('meta[property="og:url"]', 'content', canonicalUrl);
      setMeta('meta[property="og:image"]', 'content', ogImage);
      setMeta('meta[property="og:image:secure_url"]', 'content', ogImage);
      setMeta('meta[property="og:image:alt"]', 'content', fullTitle);
      // og:type — product is the canonical type for marketplace items.
      // Override the site-wide "website" type for individual listings.
      setMeta('meta[property="og:type"]', 'content', 'product');
      // Twitter Card mirrors
      setMeta('meta[name="twitter:title"]', 'content', fullTitle);
      setMeta('meta[name="twitter:description"]', 'content', dynDesc);
      setMeta('meta[name="twitter:image"]', 'content', ogImage);
      setMeta('meta[name="twitter:image:alt"]', 'content', fullTitle);
      // Canonical URL — useful for downstream Google indexing if/when
      // we add server-side rendering later.
      const linkCanonical = document.querySelector('link[rel="canonical"]');
      if (linkCanonical) linkCanonical.setAttribute('href', canonicalUrl);
      // Document title — affects the browser tab + some crawlers.
      try { document.title = fullTitle + ' | TeeBox'; } catch (_e) {}
    } catch (e) {
      // OG injection is best-effort. Silent on every failure mode so
      // a permission denial / network blip doesn't break the SPA.
      console.warn('dynamic OG injection failed', e && e.code || e);
    }
  })();

  // ── Design-preview helper (2026-06-04 top-nav rework) ───────────────
  // Append ?preview=signedin to the URL to force the signed-in nav
  // layout without going through actual auth. Used for design review
  // / responsive screenshots so the ribbon's signed-in state can be
  // rendered without Firebase Auth being available. Harmless in prod:
  // only triggers when the explicit query param is present. The auth
  // listener below will later override this once Firebase Auth resolves
  // — for the preview's intended use (file-served headless screenshots
  // with no working Firebase keys), the listener never fires.
  {
    const previewMode = new URLSearchParams(location.search).get('preview');
    if (previewMode === 'signedin' || previewMode === 'anon') {
      // Bypass the auth gate so the marketplace nav is visible for
      // screenshots. Without this, the auth screen sits on top of
      // everything and the nav can't be reviewed. The
      // __authGateDismissedInSession flag is what the auth listener
      // checks (line ~5723) before auto-opening the gate on cold load.
      try {
        window.GUEST_MODE = true;
        window.__authGateDismissedInSession = true;
        const _scr = document.getElementById('authScreen');
        if (_scr) { _scr.classList.remove('open'); _scr.classList.add('hidden'); }
      } catch (_) {}
      if (previewMode === 'signedin') {
        document.body.classList.add('is-signed-in');
        document.body.classList.remove('is-anon');
        try {
          const lbl = document.querySelector('#userBadge .user-badge-text');
          if (lbl) lbl.textContent = 'Jake';
          document.querySelectorAll('.unread-badge').forEach((b) => {
            b.textContent = '3'; b.classList.add('active');
          });
          document.querySelectorAll('.notif-dot').forEach((d) => {
            d.classList.add('active');
          });
        } catch (_) {}
      }
    }
  }

  onAuthStateChanged(auth, async user => {
    currentUser = user;
    window.CURRENT_USER = user;
    // ── Analytics identity tie. Whenever Firebase Auth flips state we
    // mirror it into PostHog so every subsequent posthog.capture()
    // attributes to the right person. On sign-out we call reset() so
    // the next anonymous events start a fresh distinct_id and don't
    // accidentally fold into the previous user's profile. Wrapped in
    // a try/catch — analytics MUST never crash auth.
    //
    // We ALSO emit the `signup` event for OAuth (Google/Apple) sign-ups
    // here, because those flows don't have a single client-side success
    // callsite we can hook (the native + popup paths converge on this
    // listener). Firebase exposes `metadata.creationTime` ===
    // `metadata.lastSignInTime` as the "this is the user's first ever
    // sign-in" signal, which we use to discriminate signup vs login.
    // Email/password signups still fire `signup` from inline in
    // submitEmail() so a tab-close before the listener resolves can't
    // lose the event.
    try {
      if (window.posthog) {
        if (user) {
          window.posthog.identify(user.uid, {
            email: user.email || null,
            displayName: user.displayName || null,
            emailVerified: !!user.emailVerified,
          });
          // Discriminate new-user vs returning-user via Firebase's own
          // metadata timestamps. Email-password signup fires its own
          // capture inline before this listener runs and uses
          // window.__teeboxSignupEmitted as a one-shot guard so we
          // don't double-emit for that path.
          try {
            const m = user.metadata || {};
            // r346: creationTime === lastSignInTime stays true for as long as
            // a persisted session never re-authenticates, so on its own it
            // re-fired "signup" (PostHog + Meta CompleteRegistration) on
            // EVERY page load for those users — 801 relay attempts from 143
            // accounts in 17 days, one account 49×. Two extra gates: the
            // account must be younger than 15 minutes, and the per-uid
            // once-key (localStorage, via fbTrack's `once`) must be unset.
            const createdMs = Date.parse(m.creationTime || '');
            const youngAccount = !Number.isFinite(createdMs) ||
              (Date.now() - createdMs) < 15 * 60 * 1000;
            const signupKey = 'signup_' + user.uid;
            const isFirstSession = m.creationTime && m.lastSignInTime &&
              m.creationTime === m.lastSignInTime && youngAccount &&
              !(window.fbAlreadyFired && window.fbAlreadyFired(signupKey));
            if (isFirstSession && !window.__teeboxSignupEmitted) {
              window.__teeboxSignupEmitted = true;
              // Method derivation from providerData[0].providerId. Apple
              // returns 'apple.com', Google 'google.com', email is
              // 'password'.
              const pid = (user.providerData && user.providerData[0] &&
                user.providerData[0].providerId) || '';
              let method = 'unknown';
              if (pid === 'google.com') method = 'google';
              else if (pid === 'apple.com') method = 'apple';
              else if (pid === 'password') method = 'email';
              window.posthog.capture('signup', {
                userId: user.uid,
                method,
              });
              // Meta Pixel: one signup event per account — this site and
              // the email path below share the __teeboxSignupEmitted guard.
              // r278 item 4: account_type is 'unknown' at signup on purpose —
              // every TeeBox account starts identical and only becomes a
              // seller later, at Stripe onboarding. Claiming 'buyer' here
              // would be a guess. (r302: the SellerRegistered event this used
              // to point at is gone — CompleteRegistration with account_type
              // IS the registration signal. The Stripe-KYC transition is
              // marked by Lead.)
              window.fbTrack('CompleteRegistration', { status: true, account_type: 'unknown' },
                { once: signupKey,
                  eventID: 'cr_' + String((window.CURRENT_USER && window.CURRENT_USER.uid) || user.uid) });
            }
          } catch (_e2) { /* swallow */ }
        } else {
          window.posthog.reset();
          // Reset the per-app-load signup guard so the next sign-in
          // (e.g. a different user on the same device) gets its own
          // signup event.
          window.__teeboxSignupEmitted = false;
        }
      }
    } catch (_e) { /* never block auth on analytics */ }
    if (user) {
      window.GUEST_MODE = false;
      // r327: boot hint for the next load — see the optimistic-gate script.
      // Written here (not at sign-in) so existing signed-in users self-heal
      // on their first load after this ships.
      try { localStorage.setItem('tb_had_session', '1'); } catch (_e) {}
      // Mark the auth gate as resolved for THIS process — if the user
      // later signs out in the same session we don't want the boot-time
      // auto-open logic to re-fire mid-session. We use an in-memory
      // flag (not sessionStorage) so a true cold launch with no signed-in
      // user re-shows the gate. iOS WKWebView discards in-memory state
      // on app termination, which is what we want.
      window.__authGateDismissedInSession = true;
      if (window.hideWelcome) window.hideWelcome('signed-in'); // r364: the opener never stays up for a member
      // Smooth fade-out before hiding so successful sign-in feels deliberate
      // (web + iOS WKWebView both honor the CSS transition). The 250ms here
      // matches the .auth-screen `transition` rule above.
      const _authScreen = document.getElementById('authScreen');
      if (_authScreen && _authScreen.classList.contains('open')) {
        _authScreen.classList.add('fading-out');
        setTimeout(() => {
          _authScreen.classList.remove('open');
          _authScreen.classList.add('hidden');
          _authScreen.classList.remove('fading-out');
        }, 260);
      } else if (_authScreen) {
        _authScreen.classList.remove('open');
        _authScreen.classList.add('hidden');
      }
      // Auth-state body class — drives the top-nav cluster visibility via
      // CSS selectors (body.is-signed-in / body.is-anon). Replaces the
      // older direct .style.display writes that were sprinkled across the
      // auth callback. See `.ribbon-signed-in` / `.ribbon-anon` rules.
      // r172: mark auth known; the splash drops when content is ready
      // (__maybeDismissSplash), no longer here directly.
      window.__splashAuthKnown = true;
      if (window.__maybeDismissSplash) window.__maybeDismissSplash();
      else console.error('[boot] __maybeDismissSplash missing (signed-in branch) — splash dismissal path lost; earlier script error is the root cause');
      document.body.classList.add('is-signed-in');
      document.body.classList.remove('is-anon');
      // Phase 2: soft email-verification prompt (never gates anything).
      try { window.maybeShowVerifyBanner && window.maybeShowVerifyBanner(user); } catch (_e) {}
      // r349: finish a half-made account (timed-out sign-up) — idempotent.
      try { window.__finishPendingSetup && window.__finishPendingSetup(user); } catch (_e) {}
      // r350: a signed-in user is a potential buyer — warm Stripe.js (300 KB gz)
      // at idle so the first Buy Now mounts the Payment Element immediately
      // instead of paying the download on a slow link. The idle warm in
      // index.html runs at parse time, when CURRENT_USER is still null for
      // anyone signing in later; the detail-open warm only helps if the buyer
      // lingers on a listing first. Guests never pay, so this is the right hook.
      try {
        const __warmStripe = () => { try { if (window.__authBusy && window.__authBusy()) { setTimeout(__warmStripe, 3000); return; } if (window.CURRENT_USER && typeof loadStripeJs === 'function') loadStripeJs().catch(() => {}); } catch (_e) {} };
        (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(__warmStripe, {timeout: 6000});
      } catch (_e) {}
      // After successful sign-in, replay the gated action (if any) so a
      // guest who clicked Buy / Sell / Like ends up where they intended.
      if (window.__pendingAuthIntent && typeof window.__pendingAuthIntent === 'function') {
        const intent = window.__pendingAuthIntent;
        window.__pendingAuthIntent = null;
        setTimeout(() => { try { intent(); } catch (e) { console.warn('[guest] intent replay failed:', e); } }, 600);
      }
      // If they arrived via ?play=bingo, fulfill the deep link now.
      if (window.__pendingDeepLink === 'bingo') {
        window.__pendingDeepLink = null;
        setTimeout(() => { try { window.openBingo && window.openBingo(); } catch {} }, 300);
      }
      // r345: ?sell=1 — the seller-invite email CTA.
      if (window.__pendingDeepLink === 'sell') {
        window.__pendingDeepLink = null;
        setTimeout(() => { try { window.handleSellClick && window.handleSellClick(); } catch {} }, 500);
      }
      // r348: ?payouts=setup from the list-first nudges (see the param handler).
      if (window.__pendingDeepLink === 'payouts') {
        window.__pendingDeepLink = null;
        setTimeout(() => { try { window.__actions && window.__actions['stripe-connect'] && window.__actions['stripe-connect'](); } catch {} }, 500);
      }
      // ?prefs=email — fired from the unsubscribe-success page CTA.
      if (window.__pendingDeepLink === 'email-prefs') {
        window.__pendingDeepLink = null;
        setTimeout(() => { try { window.openEmailPrefs && window.openEmailPrefs(); } catch {} }, 400);
      }
      // Set the visible label inside the user-badge pill in the new
      // ribbon. The button itself stays in the DOM at all times; CSS
      // body.is-signed-in toggles its display. We only write to the inner
      // text span so the icon + chevron pseudo-element survive.
      const badge = document.getElementById('userBadge');
      const fallback = user.phoneNumber || (user.email ? user.email.split('@')[0] : '') || 'Account';
      const initialAuthName = user.displayName || '';
      const initialFirst = initialAuthName ? initialAuthName.split(' ')[0] : '';
      const labelText = initialFirst || fallback;
      const labelEl = badge.querySelector('.user-badge-text');
      if (labelEl) labelEl.textContent = labelText;
      badge.setAttribute('title', 'Open account menu');
      badge.setAttribute('aria-label', `Open account menu for ${labelText}`);
      await checkSellerStatus(user.uid);
      resolveDisplayName(user); // fire-and-forget: r170 name resolution + seeding
      preloadOwnAvatar(user.uid); // fire-and-forget: cache-warm own avatar
      // checkSellerStatus also stamps window.CURRENT_PROFILE_NAME if the
      // Firestore profile has a displayName — refresh the badge from there.
      const profName = window.CURRENT_PROFILE_NAME || '';
      const profFirst = profName ? profName.split(' ')[0] : '';
      if (profFirst) {
        badge.textContent = `Welcome, ${profFirst}`;
        badge.setAttribute('aria-label', `Open account menu for ${profFirst}`);
      }
      loadListings();
      // Logo Bingo: carry guest play onto the now-known account. Order matters
      // — RECONCILE (read the server doc) FIRST so a fresh device adopts the
      // server's solved board, THEN drain the local queue. Draining first would
      // let a blank fresh session push its empty board and clobber a real solve
      // (the server-side monotonicity guard also blocks that, but reconcile-
      // first avoids even attempting the bad write). Best-effort.
      try {
        if (window.reconcileServerGame && window.bingoTodayUTC) {
          window.reconcileServerGame(window.bingoTodayUTC())
            .catch(() => {})
            .then(() => {
              if (window.drainBingoSyncQueue) return window.drainBingoSyncQueue();
            })
            .catch(() => {});
        } else if (window.drainBingoSyncQueue) {
          window.drainBingoSyncQueue().catch(() => {});
        }
      } catch (_e) {}
      // Hydrate watchlist & maybe prompt for any unreviewed orders.
      if (window.hydrateWatchlist) window.hydrateWatchlist();
      else console.error('[boot] hydrateWatchlist missing — hearts will render unhydrated; earlier script error is the root cause');
      // Hydrate blocked-users set so buildProducts can client-filter
      // their listings before the next paint.
      if (window.hydrateBlockedUsers) window.hydrateBlockedUsers().then(() => {
        if (typeof buildProducts === 'function') buildProducts();
      });
      else console.error('[boot] hydrateBlockedUsers missing — BLOCKED SELLERS’ LISTINGS MAY RENDER; earlier script error is the root cause');
      setTimeout(() => { if (window.maybePromptReview) window.maybePromptReview(); }, 2000);
      // Best-effort FCM push subscription (web only — iOS native uses APNs
      // already wired in AppDelegate). Asks for permission once we know the
      // user signed in. If they decline we never re-prompt this session.
      setTimeout(() => { try { window.maybeRegisterPush && window.maybeRegisterPush(); } catch(_e){} }, 4000);
      // Native (Capacitor) push wiring. No-op on web. Idempotent.
      setTimeout(() => { try { window.maybeRegisterPushNative && window.maybeRegisterPushNative(); } catch(_e){} }, 4200);
      // Email-verified confirmation email — fires once per user, the
      // first time onAuthStateChanged sees `emailVerified === true`
      // for an email-provider account. Idempotency is enforced
      // server-side via users/{uid}.emailVerifiedNotifiedAt in
      // ./functions/securityEmailTriggers.js, so a refresh / repeat
      // sign-in does NOT cause a second send. We delay 4500ms to let
      // checkSellerStatus + Firestore hydrate finish first.
      setTimeout(() => {
        try {
          const u = window.CURRENT_USER;
          if (!u || !u.email || !u.emailVerified) return;
          // Only fire for email/password accounts. Google/Apple sign-in
          // returns emailVerified=true at signup; we don't want a
          // "your email is verified" email on every fresh Google login.
          const isEmailProvider = (u.providerData || []).some(
              (p) => p && p.providerId === 'password');
          if (!isEmailProvider) return;
          (async () => {
            const { getFunctions, httpsCallable } =
              await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
            const fns = getFunctions();
            const notify = httpsCallable(fns, 'notifySecurityEvent');
            await notify({
              eventType: 'email_verified',
              metadata: {
                userAgent: (navigator && navigator.userAgent) || null,
              },
            }).catch((e) => console.warn(
                'notifySecurityEvent(email_verified) failed:', e));
          })();
        } catch (_e) { /* swallow */ }
      }, 4500);
    } else {
      // Guest mode: keep authScreen hidden, let people browse + play Bingo.
      // Anything that needs auth (buy, sell, watchlist, account) routes
      // through the requireAuth() gate, which shows the polished
      // sign-in prompt before opening the auth screen on confirmation.
      // We default to GUEST_MODE = true so a fresh visitor lands on the
      // marketplace, never on a sign-in wall.
      if (window.GUEST_MODE !== true && window.GUEST_MODE !== false) {
        window.GUEST_MODE = true;
      }
      // Reset blocked-users set on sign-out so a guest sees the full
      // marketplace (and a different account in the same tab gets a
      // clean slate before its own hydrate fires).
      window.MY_BLOCKED_UIDS = new Set();
      const _authScreen = document.getElementById('authScreen');
      if (_authScreen) {
        _authScreen.classList.remove('fading-out');
        // Auto-show the auth screen on every COLD launch so unsigned
        // users always land on the sign-in wall first. We track the
        // "user dismissed this session" state in an in-memory flag
        // (`window.__authGateDismissedInSession`) instead of
        // sessionStorage because Capacitor's WKWebView preserves
        // sessionStorage across iOS app cold-launches — meaning a guest
        // who tapped "Continue as guest" once would never see the gate
        // again, even after force-quitting. iOS discards in-memory JS
        // state on real app termination, so this gives us the exact
        // semantics we want: dismissed-this-run vs. fresh-launch.
        // Also auto-open if the URL explicitly asked for it (?signin=1).
        // r349 (founder ruling 2026-10-19): NO first-visit auth wall. Guests
        // land straight on the marketplace; the sign-in screen appears only
        // when they try to sell, buy, message or save (requireAuth), or when
        // the URL explicitly asks for it (?signin=1 / ?launch=auth). The
        // 2026-10-19 Slow-3G walk showed a brand-new visitor staring at a
        // sign-in gate for the first 33 s of their session.
        try {
          const _sp = new URLSearchParams(window.location.search);
          const _forced = _sp.get('signin') === '1' || _sp.get('launch') === 'auth';
          if (_forced) {
            _authScreen.classList.remove('hidden');
            _authScreen.classList.add('open');
          } else {
            _authScreen.classList.remove('open');
            _authScreen.classList.add('hidden');
            window.GUEST_MODE = true;
          }
        } catch { _authScreen.classList.remove('open'); }
      }
      // Auth-state body class — see signed-in branch above. When the
      // design-preview helper forced signed-in (?preview=signedin),
      // skip the reset so the screenshot capture actually renders the
      // signed-in ribbon. Otherwise the listener fires with user=null
      // in headless and immediately wipes the helper's class. No-op
      // in normal sessions (URL param absent → guard returns false).
      if (new URLSearchParams(location.search).get('preview') !== 'signedin') {
        document.body.classList.add('is-anon');
        document.body.classList.remove('is-signed-in');
      }
      window.__splashAuthKnown = true; // r172: content readiness drives dismissal
      if (window.__maybeDismissSplash) window.__maybeDismissSplash();
      else console.error('[boot] __maybeDismissSplash missing (anon branch) — splash dismissal path lost; earlier script error is the root cause');
      try { window.hideVerifyBanner && window.hideVerifyBanner(); } catch (_e) {}
      window.IS_VERIFIED_SELLER = false;
      window.CURRENT_PROFILE_NAME = '';
      // Reset the in-memory shop snapshot so a previous user's listings
      // can't briefly flash for the next signed-in user / guest.
      try {
        window.SHOP_DATA = { listings: [], orders: [], profile: null };
      } catch (_) {}
      // Clear the in-memory favorites set so the next user doesn't see
      // the previous user's hearted listings. Firestore is the source of
      // truth — hydrateWatchlist() rebuilds it on the next sign-in.
      try { if (typeof fav !== 'undefined' && fav && fav.clear) fav.clear(); } catch (_) {}
      window.CURRENT_DISPLAY_NAME = ''; // r170: reset the name-gate state
      // Guests get the live marketplace too. listings rules allow anonymous
      // read (allow read: if true), so loadListings() fetches real listings,
      // filters expired/photoless, appends DEFAULT_PRODUCTS as a teaser for
      // signed-out users, and renders. Previously this branch rendered only
      // the static demo catalog, so guests never saw real inventory.
      loadListings();
    }
  });

  // r170: canonical display-name resolution + one-time seeding.
  // profiles/{uid}.displayName is what every render surface reads (chat,
  // listings, orders), but before r170 no signup path ever wrote it — OAuth
  // names lived only on the Auth user, and email signups collected no name.
  // At sign-in: prefer the profile name; when the profile is nameless but
  // the Auth user has a name (Google/Apple), seed it — profile CREATE may
  // include displayName directly (rules whitelist); an EXISTING nameless doc
  // must go through the updateProfile callable (displayName is callable-only
  // on update). Stamps window.CURRENT_DISPLAY_NAME for requireDisplayName().
  // Best-effort: a failed seed still stamps the Auth name so the gate never
  // nags a user who demonstrably has one.
  async function resolveDisplayName(user) {
    try {
      let profExists = false; let profName = ''; let bio = ''; let location = '';
      try {
        const snap = await getDoc(doc(db, 'profiles', user.uid));
        if (snap.exists()) {
          profExists = true;
          const d = snap.data() || {};
          profName = (d.displayName || '').trim();
          bio = d.bio || '';
          location = d.location || '';
        }
      } catch (_e) {}
      if (profName) { window.CURRENT_DISPLAY_NAME = profName; return; }
      const authName = (user.displayName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      window.CURRENT_DISPLAY_NAME = authName;
      if (!authName) return;
      if (!profExists) {
        await setDoc(doc(db, 'profiles', user.uid), { displayName: authName }, { merge: true });
      } else {
        // The deployed updateProfile callable overwrites absent content
        // fields with '' — send current bio/location alongside the name so
        // this seed can't blank them.
        await httpsCallable(fns, 'updateProfile')({ displayName: authName, bio, location });
      }
    } catch (e) { console.warn('displayName resolve/seed failed:', e && e.code || e); }
  }

  // Perf: warm the signed-in user's OWN avatar into the browser/WKWebView image
  // cache at sign-in, so opening their profile later is instant (no lazy fetch
  // on tap). The avatar lives on profiles/{uid}.avatarUrl (not users/), so this
  // is a small separate read. Best-effort, non-blocking; never throws.
  async function preloadOwnAvatar(uid) {
    try {
      const snap = await getDoc(doc(db, 'profiles', uid));
      const prof = snap.exists() ? snap.data() : null;
      // r266: warm the w256 derivative, not the original. Every consumer of
      // CURRENT_PROFILE_AVATAR draws at 88px or smaller (profile header, nav
      // drawer identity, own-profile skeleton), and the heaviest live avatar
      // is a 1677KB original — which this preload was fetching on every
      // sign-in. avatarVariantUrl falls back to the original on its own.
      const url = prof && (window.avatarVariantUrl
        ? window.avatarVariantUrl(prof, 'w256') : prof.avatarUrl);
      if (url) {
        window.CURRENT_PROFILE_AVATAR = url;
        const im = new Image();
        im.decoding = 'async';
        im.src = url; // primes the HTTP/image cache
      }
    } catch (_e) { /* best-effort — never block sign-in on a preload */ }
  }

  // ── Creator referrals (seller-bounty pilot, 2026-10) ──────────────────
  // A creator shares teeboxmarket.com?r=THEIRCODE. We capture the code on
  // landing and keep it until the account is created, which is usually a
  // different session — someone browses, leaves, comes back and signs up
  // days later. FIRST touch wins and is never overwritten: if two creators
  // both reach the same person, the one who introduced them gets the credit,
  // which is the behaviour the contract promises.
  const REFERRAL_KEY = 'tb_referral_v1';
  function captureReferralCode() {
    try {
      const code = new URLSearchParams(window.location.search).get('r');
      if (!code) return;
      const clean = String(code).trim().toUpperCase().slice(0, 32);
      if (!/^[A-Z0-9_-]+$/.test(clean)) return;   // ignore junk, never store it
      if (localStorage.getItem(REFERRAL_KEY)) return;          // first touch wins
      localStorage.setItem(REFERRAL_KEY, JSON.stringify({ code: clean, landedAt: Date.now() }));
    } catch (_e) { /* private mode — the pilot survives without attribution */ }
  }
  captureReferralCode();

  // Written ONCE, at the moment the account is bootstrapped, into its own
  // doc. users/{uid} has an exact hasOnly() allow-list and widening it would
  // widen the rule guarding sellerVerified/tier/frozen — see firestore.rules.
  // Rules make the doc create-only, so a failure here is final and silent by
  // design: attribution is nice to have, signing up is not negotiable.
  async function claimReferralIfAny(uid) {
    try {
      const raw = localStorage.getItem(REFERRAL_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) || {};
      if (!parsed.code) return;
      await setDoc(doc(db, 'referralClaims', uid), {
        code: String(parsed.code).slice(0, 32),
        landedAt: Number(parsed.landedAt) || Date.now(),
        claimedAt: serverTimestamp(),
      });
    } catch (e) { console.warn('referral claim skipped:', e && e.code || e); }
  }

  async function checkSellerStatus(uid) {
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      const data = snap.exists() ? snap.data() : null;
      window.IS_VERIFIED_SELLER = !!(data && data.sellerVerified === true);
      window.CURRENT_PROFILE_NAME = (data && data.displayName) ? String(data.displayName) : '';
      // Bootstrap the users/{uid} doc on first sign-in (any provider —
      // email, Google, Apple). Schema is locked to the rules whitelist:
      // [phone, termsAgreed, termsAgreedAt, displayName, watchlist, blocked].
      // Anything else fails the create rule. We seed displayName='' so
      // downstream merges (block, watchlist, requestSellerVerification)
      // always have a doc to land on.
      if (!snap.exists()) {
        try {
          await setDoc(doc(db, 'users', uid), { displayName: '' }, { merge: true });
        } catch (e) { console.warn('users doc bootstrap failed:', e && e.code || e); }
        // Brand-new account — the only moment a first-touch referral is true.
        // This branch is the single bootstrap point for EVERY provider
        // (email, Google, Apple), so attribution lands once here rather than
        // being patched into each sign-up path separately.
        claimReferralIfAny(uid);
      }
      // GDPR re-opt-in banner. Show once if (a) no marketingConsent
      // doc OR consent.granted === false AND (b) the user hasn't
      // dismissed it before. We do NOT show it for users mid-signup
      // who just answered the in-form checkbox — the signup callable
      // writes marketingConsent so they fail the (a) test.
      try {
        const consent = data && data.marketingConsent;
        const dismissed = data && data.marketingBannerDismissedAt;
        const needsReopt = !consent || consent.granted !== true;
        if (needsReopt && !dismissed) {
          // r194 (audit W1): through the ambient queue — one prompt per
          // page-load, idle browse only, lowest priority (interruptive).
          const _showConsent = () => {
            const b = document.getElementById('marketingReoptBanner');
            if (b) b.classList.add('show');
          };
          const _hideConsent = () => {
            const b = document.getElementById('marketingReoptBanner');
            if (b) b.classList.remove('show');
          };
          if (window.__ambient) {
            window.__ambient.request('consent', { show: _showConsent, hide: _hideConsent });
          } else {
            setTimeout(_showConsent, 400);
          }
        }
      } catch (e) { /* banner is non-essential — never fail sign-in over it */ }
    } catch (e) {
      console.warn('checkSellerStatus failed:', e && e.code || e);
      window.IS_VERIFIED_SELLER = false;
      window.CURRENT_PROFILE_NAME = '';
    }
  }

  // GDPR consent banner action handlers. All three route through Cloud
  // Function callables so the server stamps serverTimestamp() and the
  // audit-trail history is un-spoofable. We close the banner optimistically
  // — if the callable fails the user can still use the prefs center later.
  function hideMarketingBanner() {
    const b = document.getElementById('marketingReoptBanner');
    if (b) b.classList.remove('show');
    try { window.__ambient.done('consent'); } catch (_e) {}
  }
  window.__actions = window.__actions || {};
  window.__actions['marketing-opt-in'] = async function() {
    hideMarketingBanner();
    try {
      const fn = httpsCallable(fns, 'updateMarketingConsent');
      await fn({ granted: true, source: 'banner_reopt' });
      if (window.showToast) showToast('You\'re in. We\'ll send personalized deals.', 'success');
    } catch (e) {
      console.warn('marketing-opt-in failed:', e && e.code || e);
      if (window.showToast) showToast('Couldn\'t save your choice. Try again from Account → Email Preferences.', 'error');
    }
  };
  window.__actions['marketing-opt-out'] = async function() {
    hideMarketingBanner();
    try {
      const fn = httpsCallable(fns, 'updateMarketingConsent');
      await fn({ granted: false, source: 'banner_reopt' });
    } catch (e) {
      console.warn('marketing-opt-out failed:', e && e.code || e);
    }
  };
  window.__actions['dismiss-marketing-banner'] = async function() {
    hideMarketingBanner();
    try {
      const fn = httpsCallable(fns, 'dismissMarketingBanner');
      await fn({});
    } catch (e) {
      console.warn('dismiss-marketing-banner failed:', e && e.code || e);
    }
  };

  // ──────────────────────────────────────────────────────────
  // Capacitor wiring: native plugins surface OAuth (Google / Apple) results
  // through Capacitor.Plugins.FirebaseAuthentication. Outside Capacitor
  // (web / desktop) we fall back to the Firebase Web SDK popup flow.
  // ──────────────────────────────────────────────────────────
  const Cap = (typeof window !== 'undefined') ? window.Capacitor : null;
  const IS_NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  if (IS_NATIVE && document.body) {
    document.body.classList.add('is-native');
    // r163: is-native reshapes the cat-bar (pills → search row + 2 pills),
    // so re-measure --cat-bar-h — this module runs after the bar's initial
    // height sync.
    // r186 boot-integrity rule: these guards must NEVER skip silently. If
    // either function is missing here, the big classic script (~L9000–19300)
    // died at parse/run time before defining it — a FATAL boot condition
    // that previously masqueraded as a cosmetic tab-bar glitch. Log loud,
    // don't recover: the FIRST red error above these lines is the root cause.
    if (window.__syncCatBar) window.__syncCatBar();
    else console.error('[boot] __syncCatBar missing — cat-bar script never initialized; an earlier script error is the root cause');
    // r186: app-shell upgrades (bottom-tab slots → Home/Browse/Sell/
    // Activity/Profile, ←-back on pushed pages, collapsing header).
    // Defined in the classic script below, which has already parsed.
    if (window.applyAppShell) window.applyAppShell();
    else console.error('[boot] applyAppShell missing — classic app script died before ~L15700; app shell NOT applied (old tab labels are the visible symptom); the first red error above is the root cause');
    // r172: launchAutoHide is OFF (capacitor.config) — hide the native splash
    // only once the web #authSplash has PAINTED (double-rAF = a frame has
    // rendered), so there's no dark-but-empty gap on cold starts. The web
    // splash then owns the wait-for-content. 4s fallback: never stick.
    try {
      const SplashNative = Cap.Plugins && Cap.Plugins.SplashScreen;
      if (SplashNative && SplashNative.hide) {
        const hideNative = () => { try { SplashNative.hide({ fadeOutDuration: 250 }); } catch (_e) {} };
        requestAnimationFrame(() => requestAnimationFrame(hideNative));
        setTimeout(hideNative, 4000);
      }
    } catch (_e) { /* splash hide is cosmetic — never block boot */ }
  }
  const FBAuthPlugin = (Cap && Cap.Plugins) ? Cap.Plugins.FirebaseAuthentication : null;
  // Mirror onto window so the action handlers in the sibling <script> tag
  // (this file's auth code lives in <script type="module">, which is its
  // own scope — handlers like A['sign-in-google'] / A['sign-in-apple']
  // can't see these consts otherwise and crash with ReferenceError on tap).
  //
  // Same reason for the Firebase Auth imports below: regular-script auth
  // handlers can't see module-scope imports, so OAuth credential conversion
  // (GoogleAuthProvider.credential, new OAuthProvider, signInWithCredential,
  // signInWithPopup) blew up with `Can't find variable: OAuthProvider` /
  // `GoogleAuthProvider` on TestFlight. Expose them here too.
  try {
    window.Cap = Cap;
    window.IS_NATIVE = IS_NATIVE;
    // r186: audit-requested alias — one global flag for "running inside the
    // Capacitor app". Same value as IS_NATIVE; prefer this in new code.
    window.IS_APP = IS_NATIVE;
    window.FBAuthPlugin = FBAuthPlugin;
    window.firebaseAuth = auth;
    window.GoogleAuthProvider = GoogleAuthProvider;
    window.OAuthProvider = OAuthProvider;
    window.signInWithCredential = signInWithCredential;
    window.signInWithCustomToken = signInWithCustomToken;
    window.signInWithPopup = signInWithPopup;
    // Expose the Functions instance + httpsCallable so the regular-script
    // auth handlers can call `exchangeIdTokenForCustomToken` directly
    // without dynamically re-importing firebase-functions on each tap.
    window.firebaseFns = fns;
    window.firebaseHttpsCallable = httpsCallable;
  } catch (_) {}

  if (IS_NATIVE && FBAuthPlugin) {
    // Native Google sign-in errors surface through this event. Without a
    // listener the plugin silently swallows them (cancelled, network,
    // missing CFBundleURLSchemes), leaving the user staring at a frozen
    // sign-in screen. Mirror them into the email-side error region since
    // the Google button lives there. Also re-enable the Google button in
    // every branch — otherwise users see "Signing in…" forever after a
    // network error or sheet dismissal.
    FBAuthPlugin.addListener('googleSignInError', (event) => {
      const err = document.getElementById('authErrorEmail');
      const code = (event && event.code) || '';
      let msg = (event && event.message) || 'Google sign-in failed. Try again.';
      const restoreGoogleBtn = () => {
        const gBtn = document.querySelector('.auth-google-btn');
        const lbl = gBtn ? gBtn.querySelector('span') : null;
        if (gBtn) gBtn.disabled = false;
        if (lbl) lbl.textContent = 'Continue with Google';
      };
      if (code === 'auth/cancelled' || /cancel/i.test(msg)) {
        restoreGoogleBtn();
        return; // user backed out — silent
      }
      if (code === 'auth/network-request-failed') msg = 'Network error. Check your connection and try again.';
      if (code === 'auth/account-exists-with-different-credential') {
        msg = 'An account with that email already exists. Sign in with email or your original method first.';
      }
      if (err) err.textContent = msg;
      console.warn('[auth] native google sign-in failed:', code, event && event.message);
      restoreGoogleBtn();
    });
    // Native Apple sign-in errors: same shape as the Google listener so the
    // user is never left staring at a frozen "Signing in…" button. Apple's
    // ASAuthorizationErrorCanceled surfaces as code 'auth/cancelled' or a
    // message containing "cancel" — treat as silent restore.
    FBAuthPlugin.addListener('appleSignInError', (event) => {
      const err = document.getElementById('authErrorEmail');
      const code = (event && event.code) || '';
      let msg = (event && event.message) || 'Apple sign-in failed. Try again.';
      const restoreAppleBtn = () => {
        const aBtn = document.querySelector('.auth-apple-btn');
        const lbl = aBtn ? aBtn.querySelector('span') : null;
        if (aBtn) aBtn.disabled = false;
        if (lbl) lbl.textContent = 'Continue with Apple';
      };
      if (code === 'auth/cancelled' || /cancel/i.test(msg)) {
        restoreAppleBtn();
        return; // user backed out — silent
      }
      if (code === 'auth/network-request-failed') msg = 'Network error. Check your connection and try again.';
      if (code === 'auth/account-exists-with-different-credential') {
        msg = 'An account with that email already exists. Sign in with email or your original method first.';
      }
      if (err) err.textContent = msg;
      console.warn('[auth] native apple sign-in failed:', code, event && event.message);
      restoreAppleBtn();
    });
  }

  // Email auth: works in WebView with no native plugin / APNs / silent push.
  let emailMode = 'signin';

  function applyEmailMode() {
    const isSignIn = emailMode === 'signin';
    document.getElementById('emailSubmitBtn').textContent = isSignIn ? 'Sign In' : 'Create Account';
    document.getElementById('emailTitle').textContent = isSignIn ? 'Sign in to TeeBox' : 'Create your account';
    document.getElementById('emailDesc').textContent = isSignIn ? 'Enter your email and password to continue.' : 'Pick a strong password (8+ characters).';
    document.getElementById('passwordInput').setAttribute('autocomplete', isSignIn ? 'current-password' : 'new-password');
    document.getElementById('authErrorEmail').textContent = '';
    document.querySelectorAll('.auth-emailmode-toggle .auth-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.emailmode === emailMode);
    });
    // GDPR: marketing-opt-in checkbox is sign-up only. Reset to unchecked
    // every time we enter sign-up mode so a stale "yes" from a previous
    // attempt can't be re-submitted unintentionally.
    const mkt = document.getElementById('marketingConsentRow');
    const mktInput = document.getElementById('marketingConsentInput');
    if (mkt) mkt.classList.toggle('show', !isSignIn);
    if (mktInput && isSignIn) mktInput.checked = false;
    // r170: the required name field is sign-up only.
    const nameInput = document.getElementById('nameSignupInput');
    if (nameInput) {
      nameInput.style.display = isSignIn ? 'none' : '';
      if (isSignIn) nameInput.value = '';
    }
  }
  window.setEmailMode = function(mode) {
    if (mode !== 'signin' && mode !== 'signup') return;
    emailMode = mode;
    applyEmailMode();
  };
  window.toggleEmailMode = function() {
    emailMode = emailMode === 'signin' ? 'signup' : 'signin';
    applyEmailMode();
  };

  // Soft email-typo suggester — catches obvious domain/TLD typos and offers
  // a one-tap fix. NEVER blocks submit (a real address we don't know about
  // must still go through). Intentionally a small whitelist, not fuzzy
  // matching, so it can't "correct" a valid address.
  const EMAIL_TYPO_MAP = {
    'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.om': 'gmail.com',
    'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahoo.comm': 'yahoo.com',
    'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmil.com': 'hotmail.com',
    'iclould.com': 'icloud.com', 'iclod.com': 'icloud.com', 'outlok.com': 'outlook.com',
    'comcast.com': 'comcast.net',
  };
  function suggestEmailFix(email) {
    const raw = String(email || '').trim();
    const at = raw.lastIndexOf('@');
    if (at < 1) return null;
    const local = raw.slice(0, at); // preserve local-part case
    const domain = raw.slice(at + 1).toLowerCase();
    if (!domain) return null;
    if (EMAIL_TYPO_MAP[domain]) return local + '@' + EMAIL_TYPO_MAP[domain];
    // Generic bad-TLD catch: <name>.con/.cmo/.vom/.xom/.ocm/.comm/.om → .com
    const m = domain.match(/^(.+)\.(con|cmo|vom|xom|ocm|comm|om)$/);
    if (m) return local + '@' + m[1] + '.com';
    return null;
  }
  window.suggestEmailFix = suggestEmailFix;
  window.showEmailTypoHint = function() {
    const inp = document.getElementById('emailInput');
    const hint = document.getElementById('emailTypoHint');
    if (!inp || !hint) return;
    const fix = suggestEmailFix(inp.value);
    if (!fix || fix.toLowerCase() === inp.value.trim().toLowerCase()) { hint.style.display = 'none'; hint.innerHTML = ''; return; }
    hint.style.display = 'block';
    hint.innerHTML = 'Did you mean <button type="button" data-action="accept-email-fix" data-fix="' +
      window.safeAttr(fix) + '">' + window.safeText(fix) + '</button>?';
  };
  (function wireEmailTypoHint() {
    const inp = document.getElementById('emailInput');
    if (inp && !inp.__typoWired) {
      inp.__typoWired = true;
      inp.addEventListener('blur', window.showEmailTypoHint);
      inp.addEventListener('input', () => {
        const h = document.getElementById('emailTypoHint');
        if (h && h.style.display !== 'none') { h.style.display = 'none'; h.innerHTML = ''; }
      });
    }
  })();

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  window.submitEmail = async function() {
    const email = document.getElementById('emailInput').value.trim();
    const pw = document.getElementById('passwordInput').value;
    const err = document.getElementById('authErrorEmail');
    const btn = document.getElementById('emailSubmitBtn');
    // r170: name is required to create an account (sign-in unaffected).
    const nameEl = document.getElementById('nameSignupInput');
    const signupName = nameEl ? nameEl.value.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    if (emailMode === 'signup' && signupName.length < 2) {
      err.textContent = 'Please enter your name.';
      if (nameEl) nameEl.focus();
      return;
    }
    if (!EMAIL_RE.test(email)) {
      err.textContent = 'Enter a valid email address.';
      return;
    }
    if (pw.length < 8) {
      err.textContent = 'Password must be at least 8 characters.';
      return;
    }
    err.textContent = '';
    btn.disabled = true;
    window.__authInFlight = true; // r350: holds PostHog / App Check downloads (see __phDeferLoad)
    btn.textContent = emailMode === 'signin' ? 'Signing in…' : 'Creating your account…';
    // r349: slow-network copy. The Firebase SDK does not give up for 30 s on
    // a 2 s-RTT connection; say so instead of looking frozen.
    const _slowCopy = setTimeout(() => {
      try { if (btn.disabled) btn.textContent = (emailMode === 'signin' ? 'Signing in' : 'Creating your account') + '… slow connection, hang tight'; } catch (_e) {}
    }, 12000);
    try {
      if (emailMode === 'signin') {
        try {
          await signInWithEmailAndPassword(auth, email, pw);
        } catch (e1) {
          // r349: one automatic retry on a network timeout — the first
          // attempt usually just missed the SDK's 30 s window on slow links.
          if (e1 && e1.code === 'auth/network-request-failed') {
            btn.textContent = 'Slow connection — retrying…';
            await signInWithEmailAndPassword(auth, email, pw);
          } else { throw e1; }
        }
      } else {
        // GDPR: read marketing-consent checkbox state BEFORE awaiting any
        // network call. If we read it after sign-up we race with the user
        // dismissing the form (or autofill state changes).
        const mktInput = document.getElementById('marketingConsentInput');
        const marketingConsentGranted = !!(mktInput && mktInput.checked);
        // r349: remember what this sign-up wanted BEFORE the network call, so
        // a timed-out attempt (account created server-side 30–45 s later with
        // no name / no docs) is finished by __finishPendingSetup on the next
        // sign-in instead of becoming an orphan.
        try { localStorage.setItem('tb_pending_signup', JSON.stringify({ email, name: signupName, consent: marketingConsentGranted, ts: Date.now() })); } catch (_e) {}
        let cred;
        let recovered = false;
        try {
          cred = await createUserWithEmailAndPassword(auth, email, pw);
        } catch (e0) {
          const c0 = (e0 && e0.code) || '';
          // Our own request may have landed after the SDK gave up, or an
          // earlier timed-out attempt already created the account. Either
          // way: try to SIGN IN with the same credentials for up to ~45 s
          // instead of showing "Network error" / "already in use".
          if (c0 === 'auth/network-request-failed' || c0 === 'auth/email-already-in-use' || c0 === 'auth/timeout') {
            btn.textContent = 'Finishing your account…';
            const tries = c0 === 'auth/email-already-in-use' ? 2 : 8;
            for (let i = 0; i < tries && !cred; i++) {
              try {
                cred = await signInWithEmailAndPassword(auth, email, pw);
                recovered = true;
              } catch (e1) {
                const c1 = (e1 && e1.code) || '';
                const notYet = c1 === 'auth/invalid-credential' || c1 === 'auth/user-not-found' || c1 === 'auth/wrong-password' || c1 === 'auth/invalid-login-credentials' || c1 === 'auth/network-request-failed';
                if (!notYet) throw e1;
                if (i < tries - 1) await new Promise(r => setTimeout(r, 6000));
              }
            }
            if (!cred) {
              // Genuine pre-existing account with a different password → the
              // normal "already exists, sign in" path. Anything else → retry copy.
              if (c0 === 'auth/email-already-in-use') throw e0;
              const eTimeout = new Error('timeout'); eTimeout.code = 'auth/network-request-failed'; eTimeout.recoverable = true; throw eTimeout;
            }
          } else { throw e0; }
        }
        if (recovered) console.info('[signup] recovered a timed-out account creation by signing in');
        // Analytics: priority event #1 — fires only on a SUCCESSFUL new
        // email/password account creation. Mirrors OAuth providers below
        // (sign-in-google / sign-in-apple) so all three signup paths
        // emit the same event name. We capture BEFORE onAuthStateChanged
        // resolves so PostHog's identify() (driven by the auth listener)
        // can fold this event into the new user's profile. NOT mirrored
        // server-side — the Firebase Auth user-create record has no
        // Firestore trigger today, and tab-close-before-listener is
        // unlikely given we await the credential.
        try {
          if (window.posthog) {
            window.posthog.capture('signup', {
              userId: cred.user.uid,
              method: 'email',
              marketingConsentGranted,
            });
            // Meta Pixel: email-path signup (one-shot with the OAuth site
            // via __teeboxSignupEmitted; no PII in params).
            // r278 item 4: see the note at the OAuth site — 'unknown' until
            // Stripe onboarding makes them a seller.
            // r346: `once` marks the per-uid key in localStorage so the
            // onAuthStateChanged detector cannot re-fire it on later loads.
            window.fbTrack('CompleteRegistration', { status: true, account_type: 'unknown' },
                { once: 'signup_' + cred.user.uid,
                  eventID: 'cr_' + String((window.CURRENT_USER && window.CURRENT_USER.uid) || cred.user.uid) });
            // One-shot guard so the onAuthStateChanged listener's OAuth
            // signup detector doesn't double-emit for this same user.
            window.__teeboxSignupEmitted = true;
          }
        } catch (_e) { /* never block signup on analytics */ }
        // Bootstrap the users/{uid} doc so downstream code (watchlist,
        // blocking, seller verification merges) has a doc to merge into.
        // Schema is strict — see firestore.rules `match /users/{userId}`:
        // only [phone, termsAgreed, termsAgreedAt, displayName, watchlist,
        // blocked] are accepted at create time. Anything else (including
        // `email`, `createdAt`, `isVerifiedSeller`) is rejected by rules.
        // r170: stamp the signup name everywhere it's read — Firebase Auth
        // (badge/OAuth-parity), users/{uid} (checkSellerStatus), and
        // profiles/{uid} (the public doc every render site reads). Profile
        // create-with-displayName is allowed by rules; content moderation
        // is covered by the moderateProfileOnCreate trigger.
        // r349: ONE idempotent server call finishes the account (Auth
        // displayName, users/{uid}, profiles/{uid}, verification email). It
        // is also replayed on every later sign-in while tb_pending_signup is
        // set, so a half-made account always gets completed. The legacy
        // inline writes remain as a fallback if the callable is unreachable.
        let _setupDone = false;
        // r350: the auth listener's __finishPendingSetup fires for this uid before
        // this call returns — mark it done here so the callable runs once.
        window.__pendingSetupRan = cred.user.uid;
        try {
          const _finish = httpsCallable(fns, 'completeAccountSetup');
          const _r = await _finish({ displayName: signupName });
          _setupDone = !!(_r && _r.data && _r.data.ok);
        } catch (e) { console.warn('completeAccountSetup failed, using inline fallback:', e && e.code || e); }
        if (!_setupDone) {
          try { await fbUpdateProfile(cred.user, { displayName: signupName }); } catch (_e) {}
          try {
            await setDoc(doc(db, 'users', cred.user.uid), { displayName: signupName }, { merge: true });
          } catch (e) { console.warn('users doc bootstrap failed:', e && e.code || e); }
          try {
            await setDoc(doc(db, 'profiles', cred.user.uid), { displayName: signupName }, { merge: true });
          } catch (e) { console.warn('profiles doc seed failed:', e && e.code || e); }
        } else {
          try { if (!cred.user.displayName) await cred.user.reload(); } catch (_e) {}
          try { localStorage.removeItem('tb_pending_signup'); } catch (_e) {}
        }
        window.CURRENT_DISPLAY_NAME = signupName;
        // GDPR: record the marketing-consent decision via the callable.
        // The callable (server-side) writes the audit trail to
        // users/{uid}.marketingConsent and cascades emailPrefs.* on opt-in.
        // We ALWAYS call this — even on "no" — so the audit trail records
        // an explicit refusal (important for compliance, makes the
        // re-opt-in banner skip this user).
        try {
          const setMktConsent = httpsCallable(fns, 'updateMarketingConsent');
          await setMktConsent({ granted: marketingConsentGranted, source: 'signup' });
        } catch (e) {
          // Non-fatal: user still has an account; banner will catch them
          // on next session if the consent write failed.
          console.warn('updateMarketingConsent (signup) failed:', e && e.code || e);
        }
        // Fire-and-forget: send the branded verification email via our
        // Cloud Function (Resend-powered, DKIM/SPF-signed). Failure here
        // doesn't block sign-up — the user still has an account, they
        // just won't see the verification link until they retry. The
        // unverified-banner in the app surfaces this state.
        try {
          if (!_setupDone) {
            const sendVerify = httpsCallable(fns, 'sendBrandedVerification');
            await sendVerify();
          }
          if (window.showToast) showToast('Verification link sent to ' + email + ' — check your inbox, and your spam or Promotions folder if you don\'t see it.', 'success');
        } catch (_) {}
      }
      // onAuthStateChanged fires and dismisses the auth screen.
    } catch (e) {
      const code = e && e.code;
      let msg = 'Sign-in failed. Try again.';
      if (code === 'auth/invalid-email') msg = 'That email address doesn’t look right. Double-check and try again.';
      // Note: `auth/user-not-found` collapsed into the same message as wrong-password
      // to avoid leaking account-existence (email enumeration). All three codes get
      // the identical "Email or password is incorrect." copy.
      else if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') msg = 'Email or password is incorrect.';
      else if (code === 'auth/missing-password') msg = 'Please enter your password.';
      else if (code === 'auth/user-disabled') msg = 'This account has been disabled. Contact support@teeboxmarket.com for help.';
      else if (code === 'auth/email-already-in-use') {
        // Auto-flip to sign-in mode so the user can immediately try the right action.
        if (emailMode === 'signup') toggleEmailMode();
        msg = 'An account with this email already exists. Enter your password to sign in.';
        // Focus the password field — they almost certainly want to fix
        // this without re-tapping Sign In first.
        setTimeout(() => { try { document.getElementById('passwordInput').focus(); } catch {} }, 50);
      }
      else if (code === 'auth/weak-password') msg = 'Password is too weak. Use 8+ characters with a mix of letters and numbers.';
      else if (code === 'auth/network-request-failed') msg = emailMode === 'signup'
        ? 'Your connection is very slow and we couldn’t confirm the account yet. Tap Try again — if it was created, we’ll sign you straight in.'
        : 'Your connection is very slow. Tap Try again.';
      else if (code === 'auth/too-many-requests') msg = 'Too many attempts. Wait a few minutes before trying again.';
      else if (code === 'auth/operation-not-allowed') msg = 'Email sign-in is temporarily unavailable. Try Google sign-in instead.';
      err.textContent = msg;
      btn.disabled = false;
      btn.textContent = code === 'auth/network-request-failed' ? 'Try again' : (emailMode === 'signin' ? 'Sign In' : 'Create Account');
    } finally {
      clearTimeout(_slowCopy);
      window.__authInFlight = false;
    }
  };

  // r349: finish a half-made account on ANY sign-in. Fires from the auth
  // listener. Idempotent server-side (completeAccountSetup); the pending
  // record is cleared once the server confirms. Also covers legacy
  // accounts with a blank Auth displayName but a users-doc name.
  window.__finishPendingSetup = async function(user) {
    try {
      if (!user || !user.uid) return;
      if (window.__pendingSetupRan === user.uid) return;
      let pending = null;
      try { pending = JSON.parse(localStorage.getItem('tb_pending_signup') || 'null'); } catch (_e) {}
      const mine = pending && pending.email && user.email && pending.email.toLowerCase() === user.email.toLowerCase();
      const isPassword = (user.providerData || []).some(pd => pd && pd.providerId === 'password');
      if (!mine && !(isPassword && !(user.displayName || '').trim())) return;
      window.__pendingSetupRan = user.uid;
      const _finish = httpsCallable(fns, 'completeAccountSetup');
      const r = await _finish({ displayName: mine ? pending.name : undefined });
      if (r && r.data && r.data.ok) {
        if (mine) { try { localStorage.removeItem('tb_pending_signup'); } catch (_e) {} }
        if (r.data.displayNameSet && mine) { window.CURRENT_DISPLAY_NAME = pending.name; try { await user.reload(); } catch (_e) {} }
        if (mine && typeof pending.consent === 'boolean') {
          try { await httpsCallable(fns, 'updateMarketingConsent')({ granted: pending.consent, source: 'signup' }); } catch (_e) {}
        }
      }
    } catch (e) { console.warn('[signup] pending setup replay failed:', e && e.code || e); window.__pendingSetupRan = null; }
  };

  // Enter-key submit on email/password fields. iOS keyboard "Go"/"Return"
  // calls submitEmail directly so users don't have to dismiss the keyboard
  // and tap the button. This module script runs after the elements exist
  // (deferred by default), so we can wire listeners synchronously.
  ['emailInput', 'passwordInput'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submitEmail(); }
    });
    // Clear inline error as soon as the user starts correcting it —
    // a stale "incorrect password" should not linger while they retype.
    el.addEventListener('input', () => {
      const errEl = document.getElementById('authErrorEmail');
      if (errEl && errEl.textContent) errEl.textContent = '';
    });
  });

  // Forgot-password — sends a Firebase reset email to whatever's in the
  // email input. We don't differentiate "user not found" vs success in the
  // toast (security best practice — prevents email enumeration).
  window.forgotPassword = async function() {
    const emailEl = document.getElementById('emailInput');
    const errEl   = document.getElementById('authErrorEmail');
    const email = (emailEl && emailEl.value || '').trim();
    if (!EMAIL_RE.test(email)) {
      errEl.textContent = 'Enter your email address above first, then tap "Forgot your password?" again.';
      emailEl && emailEl.focus();
      return;
    }
    const btn = document.getElementById('forgotPwBtn');
    btn.disabled = true;
    btn.textContent = 'Sending reset link…';
    try {
      // Branded Resend-powered reset email (replaces Firebase's
      // default noreply@<project>.firebaseapp.com sender for better
      // deliverability + on-brand UI).
      const sendReset = httpsCallable(fns, 'sendBrandedPasswordReset');
      await sendReset({ email });
      errEl.textContent = '';
      if (window.showToast) showToast('If an account exists for ' + email + ', a reset link is on its way. Check your inbox.', 'success');
    } catch (e) {
      // Generic toast on failure to avoid email enumeration. Surface
      // true network / rate-limit errors so the user can retry.
      const code = e && e.code;
      if (code === 'functions/resource-exhausted' || (e && /Too many/.test(String(e.message || '')))) {
        errEl.textContent = 'Too many requests. Try again in a few minutes.';
      } else if (code === 'functions/unavailable' || (e && /network/i.test(String(e.message || '')))) {
        errEl.textContent = 'Network error. Check your connection and try again.';
      } else {
        if (window.showToast) showToast('If an account exists for ' + email + ', a reset link is on its way.', 'success');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Forgot your password?';
    }
  };

  window.signOut = async function() {
    if (!confirm('Sign out?')) return;
    // Tear down any open UI before flipping auth state — otherwise an
    // open modal can briefly render with stale user data while
    // onAuthStateChanged is still propagating.
    try { window.closeShopDashboard && window.closeShopDashboard(); } catch {}
    try { window.closeInbox && window.closeInbox(); } catch {}
    try { window.closeChat && window.closeChat(); } catch {}
    // Audit 2026-09-17 (M2): drop the previous user's inbox listener + cached
    // conversation previews so the next sign-in on this device never renders
    // someone else's threads.
    try { window.detachUnreadListener && window.detachUnreadListener(); } catch {}
    try { window.closeDetailModalDirect && window.closeDetailModalDirect(); } catch {}
    try { window.closeModalDirect && window.closeModalDirect(); } catch {}
    try { window.closeSellModalDirect && window.closeSellModalDirect(); } catch {}
    try { window.closeVerifyModal && window.closeVerifyModal(); } catch {}
    try { window.closeCheckoutDirect && window.closeCheckoutDirect(); } catch {}
    try { document.getElementById('userMenu').classList.remove('open'); } catch {}
    // Drop cached profile lookups so the next sign-in re-fetches fresh.
    try { window.PROFILE_CACHE && window.PROFILE_CACHE.clear && window.PROFILE_CACHE.clear(); } catch {}
    // Reset auth-derived globals up front so any code that runs in the
    // same tick (badges, sell-gate checks) sees a clean signed-out state
    // even before onAuthStateChanged fires. We flip into GUEST_MODE so
    // the user lands back on the marketplace rather than the auth wall.
    try { localStorage.removeItem('tb_had_session'); } catch (_e) {}  // r327
    window.GUEST_MODE = true;
    window.CURRENT_USER = null;
    window.IS_VERIFIED_SELLER = false;
    window.CURRENT_PROFILE_NAME = '';
    // Wipe the user-scoped in-memory shop snapshot. If we don't, the next
    // person to sign in on this device sees a flash of the previous user's
    // listings/orders before the Firestore snapshot rehydrates.
    try {
      window.SHOP_DATA = { listings: [], orders: [], profile: null };
    } catch (_) {}
    // Same reasoning for the in-memory favorites set powering the heart
    // icons. Firestore is the source of truth — hydrateWatchlist()
    // rebuilds it on the next sign-in.
    try { if (typeof fav !== 'undefined' && fav && fav.clear) fav.clear(); } catch (_) {}
    // Drop the password / email fields so the next user on a shared
    // device doesn't inherit the previous user's typed values.
    try {
      const pwInput = document.getElementById('passwordInput');
      if (pwInput) pwInput.value = '';
      const emailInput = document.getElementById('emailInput');
      if (emailInput) emailInput.value = '';
      const errEmail = document.getElementById('authErrorEmail');
      if (errEmail) errEmail.textContent = '';
    } catch (_) {}
    // Best-effort: revoke server-side sessions / refresh tokens for THIS
    // user BEFORE we tell Firebase Auth to forget them locally. If the
    // callable fails (network, cold start, function not deployed yet),
    // swallow the error — local sign-out must still complete.
    try {
      const revokeMySession = httpsCallable(fns, 'revokeMySession');
      await revokeMySession({});
    } catch (e) {
      console.warn('[auth] revokeMySession failed (non-blocking):', e && e.message);
    }
    // Sign out from both SDKs to keep their states aligned.
    if (IS_NATIVE && FBAuthPlugin) {
      try { await FBAuthPlugin.signOut(); } catch {}
    }
    await fbSignOut(auth);
  };

  window.handleSellClick = async function() {
    // Guest? Show the friendly "Sign in to start selling" prompt and
    // remember the intent so we resume the seller-verification flow
    // immediately after a successful sign-in.
    if (!window.CURRENT_USER) {
      if (typeof window.requireAuth === 'function') {
        window.requireAuth('to start selling on TeeBox', () => window.handleSellClick());
        return;
      }
      // Fallback if requireAuth is somehow not loaded yet.
      const _a = document.getElementById('authScreen');
      if (_a) { _a.classList.remove('hidden'); _a.classList.add('open'); }
      return;
    }
    // LIST-FIRST (founder ruling 2026-10-19, r348): Stripe is NO LONGER a
    // gate on listing. Anyone with a verified email can publish; Stripe is
    // required only before an item can be BOUGHT (createPaymentIntent 409s
    // for a non-charges-ready seller). So: straight into the sell modal.
    // The payout flag is refreshed in the background purely to drive the
    // in-modal heads-up + the post-publish nudge — and it can never block,
    // which also retires the old fail-closed-on-read-error behaviour (a
    // flaky users/{uid} read used to bounce onboarded sellers to the
    // "finish setup" wall).
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
        window.STRIPE_CHARGES_ENABLED = !!(snap.exists() && snap.data().stripeChargesEnabled === true);
      } catch (_e) { /* advisory only */ }
    })();
    // ToS acceptance is INLINE in the sell modal (no separate verify screen).
    // openSellModal reveals the inline Terms row for non-verified sellers, and
    // submitListing records acceptance on first publish.
    openSellModal();
  };

  // ──────────────────────────────────────────────────────────
  // Web Push (FCM)
  //   Asks the user for notification permission, gets an FCM token,
  //   stores it under users/{uid}/fcmTokens/{token}. The
  //   pushNotificationDispatch Cloud Function picks up tokens from
  //   that subcollection when sending.
  //   VAPID_KEY: from Firebase Console → Cloud Messaging → Web Push
  //   certificates → Generate key pair. Replace the placeholder below.
  // ──────────────────────────────────────────────────────────
  const VAPID_KEY = 'BE-Drm7JfIhmbSZcdHpGzNiINqhLZHdHYj1boekMEmTNG5u-7LG4H41evWYfBz3BdQsHCKGtrGPFNBIWy38AlSM';
  window.maybeRegisterPush = async function() {
    try {
      if (!('serviceWorker' in navigator)) return;
      if (!('Notification' in window)) return;
      if (!window.CURRENT_USER) return;
      if (VAPID_KEY === 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY') return; // not configured yet
      // iOS PWA standalone supports Notification only in iOS 16.4+
      if (Notification.permission === 'denied') return;
      if (sessionStorage.getItem('teebox.push.declined') === '1') return;
      if (Notification.permission === 'default') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') {
          sessionStorage.setItem('teebox.push.declined', '1');
          return;
        }
      }
      const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {scope: '/firebase-cloud-messaging-push-scope'});
      const { getMessaging, getToken, onMessage } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging.js");
      const messaging = getMessaging(app);
      const token = await getToken(messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swReg,
      });
      if (!token) return;
      const { setDoc, doc, serverTimestamp } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      await setDoc(
        doc(db, 'users', window.CURRENT_USER.uid, 'fcmTokens', token),
        { createdAt: serverTimestamp(), platform: 'web', userAgent: navigator.userAgent.slice(0, 200) },
        { merge: true }
      );
      onMessage(messaging, (payload) => {
        // Foreground messages — the SW notification is suppressed when
        // the page has focus, so we apply per-type in-app behavior here.
        const data = (payload && payload.data) || {};
        if (data.type === 'message' || data.kind === 'message') {
          // New chat message arrived while the app is focused.
          const cid = data.conversationId || data.threadId || '';
          // 1. If the user is already in that exact thread, do nothing —
          //    the onSnapshot listener will paint the new message.
          if (cid && currentChat && currentChat.conversationId === cid) {
            return;
          }
          // 2. Bump the inbox unread badge silently. No banner toast —
          //    user is in-app already.
          try { if (typeof refreshUnreadBadge === 'function') refreshUnreadBadge(); } catch (_e) {}
          // 3. If the inbox panel is open, refresh its list so the new
          //    last-message preview shows up.
          try {
            const inbox = document.getElementById('inboxBackdrop');
            if (inbox && inbox.classList.contains('open') &&
                typeof loadInbox === 'function') {
              loadInbox();
            }
          } catch (_e) {}
          return;
        }
        // Default fallback for non-message kinds — toast the title so
        // the user gets *some* signal.
        const t = (payload.notification && payload.notification.title) || 'New notification';
        if (window.showToast) window.showToast(t, 'info');
      });
    } catch (err) {
      // Push is best-effort. Log but never throw.
      console.warn('push register failed', err && err.code || err);
    }
  };

  // ──────────────────────────────────────────────────────────
  // Push deep-link router — single entry point for any tap on a
  // notification, whether it came from the SW notificationclick
  // (web), @capacitor/push-notifications pushNotificationActionPerformed
  // (native iOS/Android), or a custom-scheme URL (teebox://...).
  //
  // Accepts a payload of:
  //   { type, conversationId?, listingId?, offerId?, orderId?, url? }
  // and dispatches to the appropriate in-app opener. Safe to call
  // before the openers are defined — falls back to setting the URL hash
  // and letting the existing router pick it up on next paint.
  // ──────────────────────────────────────────────────────────
  window.routePushNotificationTap = function(data) {
    try {
      const d = data || {};
      // Server sends the teebox:// scheme via `data.url` (lib/push.js
      // line 158: `url: String(payload.deepLink || "")`), but older client
      // builds keyed off `deepLink` directly. Accept both for safety.
      const url = String(d.url || d.deepLink || '');
      // Parse teebox:// custom-scheme URLs (set by server in payload.deepLink).
      // teebox://conversation/{cid}  → open chat
      // teebox://offer/{offerId}     → open My Offers (list view)
      // teebox://order/{orderId}     → open Orders (list view)
      // (The extended router below also handles listing/search/payouts/bingo.)
      let type = String(d.type || d.kind || '');
      let conversationId = String(d.conversationId || '');
      if (!conversationId && url) {
        const m = url.match(/^teebox:\/\/conversation\/([^/?#]+)/i);
        if (m) { conversationId = decodeURIComponent(m[1]); type = type || 'message'; }
      }
      if (type === 'message' && conversationId) {
        if (typeof openChatFromConversation === 'function') {
          // Defer one tick so any modal-close logic settles first.
          setTimeout(() => openChatFromConversation(conversationId), 0);
        } else {
          // Router fallback — the hash-based deep-link picker (if present)
          // can pick this up on next paint.
          try { window.location.hash = '#chat/' + encodeURIComponent(conversationId); } catch (_e) {}
        }
        return;
      }
      // ── order: teebox://order/{orderId} ───────────────────────────
      // No per-order detail modal in v1.5 — open the Orders list, which
      // shows the most recent order at the top. The orderId is also
      // surfaced via data.orderId for future deep-link work (post-launch).
      if (url) {
        const om = url.match(/^teebox:\/\/order\/([^/?#]+)/i);
        if (om) {
          if (typeof openOrders === 'function') {
            setTimeout(() => { try { openOrders(); } catch (_e) {} }, 0);
          } else {
            try { window.location.hash = '#orders'; } catch (_e) {}
          }
          return;
        }
        // ── offer: teebox://offer/{offerId} ─────────────────────────
        // Same pattern — no per-offer detail view in v1.5; open My Offers.
        const fm = url.match(/^teebox:\/\/offer\/([^/?#]+)/i);
        if (fm) {
          if (typeof openMyOffers === 'function') {
            setTimeout(() => { try { openMyOffers(); } catch (_e) {} }, 0);
          } else {
            try { window.location.hash = '#offers'; } catch (_e) {}
          }
          return;
        }
      }
      // Unrecognised type — surface a toast so the user gets feedback.
      if (window.showToast) window.showToast('Opening…', 'info');
    } catch (e) { console.warn('routePushNotificationTap failed', e); }
  };

  // ──────────────────────────────────────────────────────────
  // Capacitor native push wiring (@capacitor/push-notifications).
  //   • Requests permission once per session
  //   • Registers, captures FCM/APNs token
  //   • Persists token to users/{uid}/fcmTokens/{token}
  //   • Foreground pushReceived → in-app behavior (badge bump,
  //     no banner if in same thread)
  //   • pushNotificationActionPerformed (tap) → routePushNotificationTap
  //
  // No-op on the web — Capacitor.isNativePlatform() returns false there
  // and we fall through to the existing maybeRegisterPush web flow.
  // ──────────────────────────────────────────────────────────
  window.maybeRegisterPushNative = async function(opts) {
    try {
      const Cap = window.Capacitor;
      if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
      if (!window.CURRENT_USER) return;
      // Plugin id matches @capacitor/push-notifications.
      const Push = Cap.Plugins && Cap.Plugins.PushNotifications;
      if (!Push) return; // plugin not installed yet — parallel agent owns this
      // Idempotent: don't re-register if listeners are already wired.
      if (window.__pushNativeWired) return;
      window.__pushNativeWired = true;

      // r313: the iOS system sheet is NEVER raised unless the CALLER asked
      // for it. This used to fire 4.2s after sign-in on every launch, so a
      // user met the OS permission dialog before they had any idea what it
      // was for — the worst possible moment to ask, and a permanent "no"
      // from most people. Boot now only re-wires an ALREADY-GRANTED
      // permission; the ask itself only ever follows a soft prompt the user
      // has already said yes to.
      const mayRequest = !!(opts && opts.request);
      let perm = await Push.checkPermissions();
      if (perm.receive !== 'granted') {
        if (!mayRequest) { window.__pushNativeWired = false; return; }
        perm = await Push.requestPermissions();
      }
      if (perm.receive !== 'granted') {
        window.__pushNativeWired = false; // allow re-try after a settings change
        return;
      }
      await Push.register();

      Push.addListener('registration', async (t) => {
        try {
          const token = (t && t.value) || '';
          if (!token || !window.CURRENT_USER) return;
          const { setDoc, doc, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
          await setDoc(
            doc(db, 'users', window.CURRENT_USER.uid, 'fcmTokens', token),
            {
              createdAt: serverTimestamp(),
              platform: (Cap.getPlatform && Cap.getPlatform()) || 'native',
              userAgent: navigator.userAgent.slice(0, 200),
            },
            { merge: true }
          );
        } catch (e) { console.warn('native push token persist failed', e); }
      });

      Push.addListener('registrationError', (err) => {
        console.warn('native push registrationError', err);
      });

      // Foreground push — same in-app behavior as the web onMessage handler.
      Push.addListener('pushNotificationReceived', (notif) => {
        try {
          const data = (notif && notif.data) || {};
          if (data.type === 'message' || data.kind === 'message') {
            const cid = data.conversationId || data.threadId || '';
            // Already in that thread → snapshot delivers it; do nothing.
            if (cid && currentChat && currentChat.conversationId === cid) return;
            // Bump unread badge + refresh inbox if visible.
            try { if (typeof refreshUnreadBadge === 'function') refreshUnreadBadge(); } catch (_e) {}
            try {
              const inbox = document.getElementById('inboxBackdrop');
              if (inbox && inbox.classList.contains('open') &&
                  typeof loadInbox === 'function') {
                loadInbox();
              }
            } catch (_e) {}
          }
        } catch (e) { console.warn('pushNotificationReceived handler failed', e); }
      });

      // Tap routing.
      Push.addListener('pushNotificationActionPerformed', (action) => {
        try {
          const data = (action && action.notification && action.notification.data) || {};
          window.routePushNotificationTap(data);
        } catch (e) { console.warn('pushNotificationActionPerformed failed', e); }
      });
    } catch (err) {
      console.warn('maybeRegisterPushNative failed', err && err.code || err);
    }
  };

  // ──────────────────────────────────────────────────────────
  // Service-worker → page bridge for web push taps. The SW posts a
  // message to the page after notificationclick so we can route into
  // the in-app opener instead of relying on a navigation that loses
  // SPA state. SW changes (sending the message) are tracked separately
  // — this side is forward-compatible if the SW omits the message.
  // ──────────────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const d = (event && event.data) || {};
        if (d && d.type === 'push-tap') {
          window.routePushNotificationTap(d.payload || {});
        }
      });
    } catch (_e) {}
  }

  // ──────────────────────────────────────────────────────────
  // Push notifications — CONTEXTUAL pre-permission flow.
  //
  // We don't ask for push permission on first launch. Callers invoke
  //   window.maybePromptForPush('first-listing' | 'first-watchlist'
  //                              | 'first-offer')
  // after the matching action. We:
  //   1. Skip if iOS permission is already 'granted' or 'denied'.
  //   2. Skip if this context was shown in the last 30 days (cooldown).
  //   3. Otherwise open a custom modal explaining the value. ONLY if
  //      the user taps "Turn on" do we trigger the OS dialog.
  //   4. Record the answer in users/{uid}.pushPromptHistory so we don't
  //      re-prompt the same context for at least 30 days.
  // This preserves the "ask later" option iOS would otherwise burn.
  // ──────────────────────────────────────────────────────────
  const PUSH_PROMPT_COPY = {
    'first-listing': {
      title: 'Get buyer alerts',
      body: "Get notified the moment a buyer responds about your listing: offers, questions, and updates.",
    },
    'first-watchlist': {
      title: 'Track price drops',
      body: "We'll alert you when the price drops on anything you're watching.",
    },
    'first-offer': {
      title: 'Hear back fast',
      body: "Get notified the moment the seller responds to your offer.",
    },
    // r313: gated by BOARDS COMPLETED rather than elapsed time (the bingo
    // module owns that counter), so it opts out of the 30-day cooldown and
    // caps itself at two showings — the first completed board, then once
    // more three boards later. After that, never.
    'bingo-first-board': {
      title: 'Want a nudge when tomorrow\u2019s board drops?',
      body: "A single daily reminder when the new Logo Bingo board goes live. Nothing else.",
      yesLabel: 'Remind me',
      noLabel: 'Not now',
      cooldownMs: 0,
      maxShows: 2,
    },
  };
  const PUSH_PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

  window.maybePromptForPush = async function(context) {
    try {
      if (!window.CURRENT_USER) return;
      const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      if (!('Notification' in window) && !isNative) return;
      if (!isNative && typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
          if (window.maybeRegisterPush) window.maybeRegisterPush();
          return;
        }
        if (Notification.permission === 'denied') return;
      }
      if (isNative) {
        const Push = window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
        if (Push && typeof Push.checkPermissions === 'function') {
          const perm = await Push.checkPermissions();
          if (perm.receive === 'granted') {
            // Already granted on a previous launch — make sure listeners are wired.
            if (window.maybeRegisterPushNative) window.maybeRegisterPushNative();
            return;
          }
          if (perm.receive === 'denied') return;
        }
      }
      const copy = PUSH_PROMPT_COPY[context];
      if (!copy) return;

      const { getDoc, setDoc, doc, arrayUnion } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const uRef = doc(db, 'users', window.CURRENT_USER.uid);
      const uSnap = await getDoc(uRef);
      const history = (uSnap.exists() && uSnap.data().pushPromptHistory) || [];
      const forContext = history.filter(h => h.context === context);
      // A context may set its own cadence (see 'bingo-first-board').
      const maxShows = (copy.maxShows != null) ? copy.maxShows : Infinity;
      if (forContext.length >= maxShows) return;
      const cooldownMs = (copy.cooldownMs != null) ? copy.cooldownMs : PUSH_PROMPT_COOLDOWN_MS;
      const lastForContext = forContext[forContext.length - 1];
      if (lastForContext && cooldownMs > 0) {
        const lastMs = lastForContext.shownAt && lastForContext.shownAt.toMillis
          ? lastForContext.shownAt.toMillis()
          : new Date(lastForContext.shownAt || 0).getTime();
        if (Date.now() - lastMs < cooldownMs) return;
      }
      if (history.some(h => h.answered === 'yes')) return;

      document.getElementById('pushPrePromptTitle').textContent = copy.title;
      document.getElementById('pushPrePromptBody').textContent = copy.body;
      // r313: contexts may override the button wording. Selected by the
      // data-action the delegated handler already keys on — no new ids, and
      // nothing to keep in sync if the markup moves.
      const back0 = document.getElementById('pushPrePromptBackdrop');
      const yesBtn = back0 && back0.querySelector('[data-action="push-prompt-accept"]');
      const noBtn = back0 && back0.querySelector('[data-action="push-prompt-decline"]');
      if (yesBtn) yesBtn.textContent = copy.yesLabel || 'Turn on';
      if (noBtn) noBtn.textContent = copy.noLabel || 'Not now';
      const back = document.getElementById('pushPrePromptBackdrop');
      back.dataset.pushContext = context;
      back.classList.add('open');

      await setDoc(uRef, {
        pushPromptHistory: arrayUnion({
          context,
          shownAt: new Date().toISOString(),
          answered: 'pending',
        }),
      }, { merge: true });
    } catch (err) {
      console.warn('maybePromptForPush failed', err && err.code || err);
    }
  };

  /** User tapped a button in the pre-permission modal. answer is 'yes'|'no'. */
  window._handlePushPromptAnswer = async function(answer) {
    try {
      const back = document.getElementById('pushPrePromptBackdrop');
      const context = back.dataset.pushContext || '';
      back.classList.remove('open');
      if (window.CURRENT_USER) {
        const { getDoc, setDoc, doc } =
          await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
        const uRef = doc(db, 'users', window.CURRENT_USER.uid);
        const uSnap = await getDoc(uRef);
        const history = (uSnap.exists() && uSnap.data().pushPromptHistory) || [];
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].context === context && history[i].answered === 'pending') {
            history[i].answered = answer;
            break;
          }
        }
        await setDoc(uRef, { pushPromptHistory: history }, { merge: true });
      }
      if (answer !== 'yes') return;

      // r313: a yes on the bingo ask also switches the daily reminder ON at
      // the default hour, so "Remind me" actually yields a reminder instead
      // of just a permission grant. Mirrors BINGO_PUSH_PREF_DEFAULTS.
      if (context === 'bingo-first-board' && window.CURRENT_USER) {
        try {
          const { setDoc, doc } =
            await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
          await setDoc(doc(db, 'users', window.CURRENT_USER.uid),
            { bingoPushPrefs: { dailyReminder: true, reminderHour: 8, streakSaver: true } },
            { merge: true });
        } catch (e) { console.warn('bingo reminder pref write failed', e); }
      }

      const Cap = window.Capacitor;
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
        // request:true — the ONLY path allowed to raise the iOS sheet, and
        // it is reached only after the user tapped yes on the soft ask.
        if (window.maybeRegisterPushNative) window.maybeRegisterPushNative({ request: true });
        return;
      }
      if (window.maybeRegisterPush) window.maybeRegisterPush();
    } catch (err) {
      console.warn('push prompt answer failed', err);
    }
  };

  // ──────────────────────────────────────────────────────────
  // Push PREFERENCES modal (Account hub → Notifications).
  // Reads/writes users/{uid}.pushPrefs.
  // ──────────────────────────────────────────────────────────
  const PUSH_PREF_CATEGORIES = [
    { key: 'messages',     label: 'Messages',       hint: 'New messages from buyers and sellers' },
    { key: 'offers',       label: 'Offers',         hint: 'New offers, accepts, declines, counters' },
    { key: 'orders',       label: 'Orders',         hint: 'Sold, shipped, delivered, funds released' },
    { key: 'savedSearches',label: 'Saved searches', hint: 'Daily digest of new matches' },
    { key: 'priceDrops',   label: 'Price drops',    hint: 'Alerts on watchlist items' },
    { key: 'bingo',        label: 'Logo Bingo',     hint: 'Daily puzzle reminder + streak alerts' },
    { key: 'news',         label: 'News & updates', hint: 'Occasional product announcements' },
  ];
  const PUSH_PREF_DEFAULTS = {
    messages: true, offers: true, orders: true,
    savedSearches: true, priceDrops: true, news: false,
    bingo: true,
    quietHours: { start: '21:00', end: '08:00', tz: 'America/New_York' },
  };
  // Bingo sub-preferences — only meaningful when pushPrefs.bingo === true.
  // dailyReminder fires the morning "puzzle is live" push at reminderHour
  // local time. streakSaver fires the 9pm "don't lose your streak" alert
  // for users with streak >= 7 who haven't played today.
  const BINGO_PUSH_PREF_DEFAULTS = {
    dailyReminder: true,
    reminderHour: 8,
    streakSaver: true,
  };

  window.openPushPrefs = async function() {
    if (!window.CURRENT_USER) {
      if (window.requireAuth) window.requireAuth('to manage notifications', () => window.openPushPrefs());
      return;
    }
    const back = document.getElementById('pushPrefsBackdrop');
    const body = document.getElementById('pushPrefsBody');
    back.classList.add('open');
    body.innerHTML = '<div class="profile-loading" aria-busy="true"><div class="sk sk-line long"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div>';

    let prefs = { ...PUSH_PREF_DEFAULTS };
    let bingoPrefs = { ...BINGO_PUSH_PREF_DEFAULTS };
    try {
      const { getDoc, doc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      const snap = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
      if (snap.exists()) {
        const d = snap.data() || {};
        if (d.pushPrefs) {
          prefs = { ...PUSH_PREF_DEFAULTS, ...d.pushPrefs };
          prefs.quietHours = { ...PUSH_PREF_DEFAULTS.quietHours, ...(d.pushPrefs.quietHours || {}) };
        }
        if (d.bingoPushPrefs) {
          bingoPrefs = { ...BINGO_PUSH_PREF_DEFAULTS, ...d.bingoPushPrefs };
        }
      }
    } catch (_e) {}

    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || prefs.quietHours.tz;
    // Render the reminder-hour <select> options 0..23 with a friendlier
    // 12-hour label so the picker doesn't show "13" / "20" out of context.
    const hourOptions = Array.from({ length: 24 }, (_, h) => {
      const label = h === 0 ? '12 AM'
        : h < 12 ? `${h} AM`
        : h === 12 ? '12 PM'
        : `${h - 12} PM`;
      const sel = h === Number(bingoPrefs.reminderHour) ? 'selected' : '';
      return `<option value="${h}" ${sel}>${label}</option>`;
    }).join('');
    body.innerHTML = `
      <div class="push-prefs-list" style="display:flex;flex-direction:column;gap:10px;">
        ${PUSH_PREF_CATEGORIES.map(c => `
          <label class="push-pref-row" style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px;border:1px solid var(--gray-200);border-radius:var(--radius-md);background:var(--white);cursor:pointer;">
            <span style="display:flex;flex-direction:column;min-width:0;">
              <span style="font-weight:600;color:var(--gray-900)">${c.label}</span>
              <span style="font-size:12px;color:var(--gray-500)">${c.hint}</span>
            </span>
            <input type="checkbox" data-push-pref="${c.key}" ${prefs[c.key] ? 'checked' : ''}
                   style="width:22px;height:22px;accent-color:#1f4827;flex-shrink:0;">
          </label>
        `).join('')}
      </div>
      <div style="margin-top:18px;padding:14px;border:1px solid var(--gray-200);border-radius:var(--radius-md);background:var(--white);">
        <div style="font-weight:600;margin-bottom:8px;">Logo Bingo</div>
        <div style="font-size:12px;color:var(--gray-500);margin-bottom:12px;">
          Daily puzzle nudges. Disable the Logo Bingo category above to silence both.
        </div>
        <label style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;">
          <span style="display:flex;flex-direction:column;min-width:0;">
            <span style="font-weight:600;color:var(--gray-900)">Morning reminder</span>
            <span style="font-size:12px;color:var(--gray-500)">"Today's puzzle is live"</span>
          </span>
          <input type="checkbox" id="bingoDailyReminder" ${bingoPrefs.dailyReminder ? 'checked' : ''}
                 style="width:22px;height:22px;accent-color:#1f4827;flex-shrink:0;">
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;">
          <span style="display:flex;flex-direction:column;min-width:0;">
            <span style="font-weight:600;color:var(--gray-900)">Reminder time</span>
            <span style="font-size:12px;color:var(--gray-500)">When to send your morning reminder</span>
          </span>
          <select id="bingoReminderHour" style="padding:6px 10px;border:1.5px solid var(--gray-200);border-radius:6px;background:var(--white);">
            ${hourOptions}
          </select>
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;">
          <span style="display:flex;flex-direction:column;min-width:0;">
            <span style="font-weight:600;color:var(--gray-900)">Streak saver (9pm)</span>
            <span style="font-size:12px;color:var(--gray-500)">Warn me if my 7+ day streak is at risk</span>
          </span>
          <input type="checkbox" id="bingoStreakSaver" ${bingoPrefs.streakSaver ? 'checked' : ''}
                 style="width:22px;height:22px;accent-color:#1f4827;flex-shrink:0;">
        </label>
      </div>
      <div style="margin-top:18px;padding:14px;border:1px solid var(--gray-200);border-radius:var(--radius-md);background:var(--white);">
        <div style="font-weight:600;margin-bottom:8px;">Quiet hours</div>
        <div style="font-size:12px;color:var(--gray-500);margin-bottom:10px;">
          Non-urgent notifications won't disturb you in this window. Urgent items (offer expiring soon, dispute opened) still come through.
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">From
            <input type="time" id="pushQuietStart" value="${prefs.quietHours.start}"
                   style="padding:6px 10px;border:1.5px solid var(--gray-200);border-radius:6px;">
          </label>
          <label style="display:flex;align-items:center;gap:6px;">To
            <input type="time" id="pushQuietEnd" value="${prefs.quietHours.end}"
                   style="padding:6px 10px;border:1.5px solid var(--gray-200);border-radius:6px;">
          </label>
          <span style="font-size:12px;color:var(--gray-500);">${tz}</span>
        </div>
      </div>
      <div class="profile-actions" style="margin-top:18px;">
        <button class="btn-full ghost" data-action="close-info">Cancel</button>
        <button class="btn-full green" data-action="save-push-prefs">Save</button>
      </div>
    `;
    body.dataset.tz = tz;
  };

  window.savePushPrefs = async function() {
    if (!window.CURRENT_USER) return;
    const body = document.getElementById('pushPrefsBody');
    const toggles = body.querySelectorAll('input[data-push-pref]');
    const next = {};
    toggles.forEach(t => { next[t.dataset.pushPref] = !!t.checked; });
    next.quietHours = {
      start: document.getElementById('pushQuietStart').value || '21:00',
      end: document.getElementById('pushQuietEnd').value || '08:00',
      tz: body.dataset.tz || 'America/New_York',
    };
    // Bingo sub-prefs ride on a sibling field (bingoPushPrefs) so the
    // server-side scheduled function can filter on them via a single
    // equality query without paging the whole pushPrefs blob.
    const bingoNext = {
      dailyReminder: !!(document.getElementById('bingoDailyReminder') || {}).checked,
      reminderHour: Number((document.getElementById('bingoReminderHour') || {}).value || 8),
      streakSaver: !!(document.getElementById('bingoStreakSaver') || {}).checked,
    };
    try {
      const { setDoc, doc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      await setDoc(doc(db, 'users', window.CURRENT_USER.uid),
        { pushPrefs: next, bingoPushPrefs: bingoNext }, { merge: true });
      if (window.showToast) window.showToast('Notification preferences saved.');
      document.getElementById('pushPrefsBackdrop').classList.remove('open');
    } catch (err) {
      console.error('savePushPrefs failed', err);
      if (window.showToast) window.showToast('Could not save. Try again.');
    }
  };

  // ──────────────────────────────────────────────────────────
  // EMAIL PREFERENCES modal (Account hub → Email preferences).
  // Reads users/{uid}.emailPrefs + marketingConsent + marketingPausedUntil
  // and writes via the updateEmailPreferences / setMarketingPause /
  // updateMarketingConsent callables. Linked from the unsubscribe.html
  // success page via the /?prefs=email deep-link (handled below).
  //
  // Per-toggle save is debounced 200ms to absorb double-taps. Each row
  // shows an inline "Saved" pill for 1.5s after a successful write.
  // ──────────────────────────────────────────────────────────
  const EMAIL_PREF_ROWS = [
    // info-only — transactional cannot be disabled; rendered grayed out.
    { key: 'transactional', label: 'Order updates',
      hint: 'Required for transaction notifications (purchase receipt, shipped, delivered)',
      kind: 'info', marketing: false },
    // messages + offers: per-row real-time channel is managed via the
    // Notifications panel (pushPrefs.messages / pushPrefs.offers). We show
    // them here for discoverability + cross-link, but they're info-only
    // from this surface — the backend updateEmailPreferences allow-list
    // is marketing-only by design.
    { key: 'messages', label: 'New messages',
      hint: 'Managed under Account → Notifications', kind: 'xref',
      xref: 'open-push-prefs', marketing: false },
    { key: 'offers', label: 'Offers received and updated',
      hint: 'Managed under Account → Notifications', kind: 'xref',
      xref: 'open-push-prefs', marketing: false },
    // marketing toggles — keys must match PREF_KEYS in emailTriggers.js
    { key: 'savedSearchMatches', label: 'Saved search matches',
      hint: 'Daily email digest of new listings matching your saved searches',
      kind: 'toggle', marketing: true },
    { key: 'priceDrops', label: 'Price drops on watched items',
      hint: 'When a seller cuts the price on something you watchlisted',
      kind: 'toggle', marketing: true },
    { key: 'weeklyDigest', label: 'Weekly deals digest',
      hint: 'Curated weekly newsletter: top deals + new arrivals',
      kind: 'toggle', marketing: true },
    { key: 'abandonedCart', label: 'Cart reminders',
      hint: 'A nudge when you have items in your cart you haven\'t bought',
      kind: 'toggle', marketing: true },
    { key: 'productUpdates', label: 'Product updates from TeeBox',
      hint: 'Occasional announcements about new features',
      kind: 'toggle', marketing: true },
  ];
  // Match the marketing default-on cascade in gdprConsent.js.
  const EMAIL_PREF_DEFAULTS = {
    savedSearchMatches: true,
    priceDrops: true,
    abandonedDraft: true,
    abandonedCart: true,
    reviewRequests: true,
    winBack: true,
    weeklyDigest: true,
    productUpdates: true,
  };

  // Per-key debounce buckets — fires the callable 200ms after the last
  // toggle for a given category, swallowing rapid flap.
  const _emailPrefDebounce = {};

  function _formatPauseDate(ts) {
    try {
      const ms = typeof ts === 'number' ? ts
        : (ts && typeof ts.toMillis === 'function') ? ts.toMillis()
        : (ts && ts.seconds) ? ts.seconds * 1000
        : null;
      if (!ms) return '';
      return new Date(ms).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch (_) { return ''; }
  }

  window.openEmailPrefs = async function() {
    if (!window.CURRENT_USER) {
      if (window.requireAuth) window.requireAuth('to manage email preferences', () => window.openEmailPrefs());
      return;
    }
    const back = document.getElementById('emailPrefsBackdrop');
    const body = document.getElementById('emailPrefsBody');
    back.classList.add('open');
    body.innerHTML = '<div class="profile-loading" aria-busy="true"><div class="sk sk-line long"></div><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div>';

    let prefs = { ...EMAIL_PREF_DEFAULTS };
    let consentGranted = true;
    let pausedUntilMs = 0;
    try {
      const { getDoc, doc } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
      // Bypass any cached snapshot — preference state is rarely-changed
      // and we want to reflect the latest server truth (e.g. after an
      // email-footer one-click unsubscribe completed seconds ago).
      const snap = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
      if (snap.exists()) {
        const d = snap.data() || {};
        if (d.emailPrefs && typeof d.emailPrefs === 'object') {
          prefs = { ...EMAIL_PREF_DEFAULTS, ...d.emailPrefs };
        }
        // Consent state — missing/false counts as "not granted" so we
        // surface the re-enable banner. If consent was never recorded
        // (legacy users), we still treat the marketing toggles as off.
        if (d.marketingConsent && typeof d.marketingConsent === 'object') {
          consentGranted = d.marketingConsent.granted === true;
        } else {
          consentGranted = false;
        }
        if (d.marketingPausedUntil) {
          const m = (typeof d.marketingPausedUntil.toMillis === 'function')
            ? d.marketingPausedUntil.toMillis()
            : (d.marketingPausedUntil.seconds ? d.marketingPausedUntil.seconds * 1000 : 0);
          if (m > Date.now()) pausedUntilMs = m;
        }
      } else {
        consentGranted = false;
      }
    } catch (e) {
      console.warn('openEmailPrefs load failed', e);
    }

    const marketingLocked = !consentGranted || pausedUntilMs > 0;

    // Build the banner stack — at most one banner is shown at a time;
    // pause takes precedence over consent-off because resuming the pause
    // is the simpler/cheaper recovery (no GDPR round-trip).
    let bannerHtml = '';
    if (pausedUntilMs > 0) {
      bannerHtml = `
        <div class="email-prefs-banner" style="display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid #e0d09a;border-radius:var(--radius-md);background:#fff8df;color:#5b4500;margin-bottom:14px;">
          <span style="flex:1;font-size:13.5px;line-height:1.45;">
            Marketing paused until <strong>${_formatPauseDate(pausedUntilMs)}</strong>. Resume anytime.
          </span>
          <button class="btn-full ghost" data-action="email-prefs-resume" type="button" style="white-space:nowrap;padding:6px 12px;font-size:13px;">Resume</button>
        </div>`;
    } else if (!consentGranted) {
      bannerHtml = `
        <div class="email-prefs-banner" style="display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid #d1d5db;border-radius:var(--radius-md);background:#f9fafb;color:#374151;margin-bottom:14px;">
          <span style="flex:1;font-size:13.5px;line-height:1.45;">
            Marketing emails are disabled. Re-enable to manage individual categories.
          </span>
          <button class="btn-full green" data-action="email-prefs-enable-marketing" type="button" style="white-space:nowrap;padding:6px 12px;font-size:13px;">Re-enable</button>
        </div>`;
    }

    const pauseToggleHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px;border:1px solid var(--gray-200);border-radius:var(--radius-md);background:#fbfaf6;margin-bottom:14px;">
        <span style="display:flex;flex-direction:column;min-width:0;">
          <span style="font-weight:600;color:var(--gray-900)">Pause all marketing for 30 days</span>
          <span style="font-size:12px;color:var(--gray-500)">Transactional and security emails are not affected.</span>
        </span>
        <input type="checkbox" id="emailPrefsPauseToggle" ${pausedUntilMs > 0 ? 'checked' : ''}
               style="width:22px;height:22px;accent-color:#1f4827;flex-shrink:0;">
      </div>`;

    const rowsHtml = EMAIL_PREF_ROWS.map((r) => {
      const isOn = r.kind === 'info' ? true : !!prefs[r.key];
      const disabled = r.kind === 'info'
        || r.kind === 'xref'
        || (r.marketing && marketingLocked);
      const opacity = disabled ? '0.55' : '1';
      const inputAttrs = r.kind === 'info'
        ? `checked disabled aria-disabled="true"`
        : r.kind === 'xref'
          ? `disabled aria-disabled="true"`
          : `${isOn ? 'checked' : ''} data-email-pref="${r.key}" ${disabled ? 'disabled' : ''}`;
      const trailing = r.kind === 'xref'
        ? `<button class="btn-full ghost" data-action="${r.xref}" type="button" style="padding:6px 10px;font-size:12px;white-space:nowrap;">Open</button>`
        : `<span class="email-prefs-saved" data-saved-for="${r.key}" style="font-size:12px;color:#0a7a3a;min-width:48px;text-align:right;opacity:0;transition:opacity .2s;">Saved</span>
           <input type="checkbox" ${inputAttrs}
                  style="width:22px;height:22px;accent-color:#1f4827;flex-shrink:0;">`;
      return `
        <label class="email-pref-row" style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px;border:1px solid var(--gray-200);border-radius:var(--radius-md);background:var(--white);opacity:${opacity};${disabled ? '' : 'cursor:pointer;'}">
          <span style="display:flex;flex-direction:column;min-width:0;">
            <span style="font-weight:600;color:var(--gray-900)">${r.label}</span>
            <span style="font-size:12px;color:var(--gray-500)">${r.hint}</span>
          </span>
          <span style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
            ${trailing}
          </span>
        </label>`;
    }).join('');

    body.innerHTML = `
      ${bannerHtml}
      ${pauseToggleHtml}
      <div class="email-prefs-list" style="display:flex;flex-direction:column;gap:10px;">
        ${rowsHtml}
      </div>
      <p style="font-size:11.5px;color:var(--gray-500);margin-top:14px;line-height:1.5;">
        We will never email you marketing offers without your consent. Transactional emails (orders, security alerts, refunds) are required and cannot be turned off.
      </p>
    `;

    // Wire change events on the freshly-rendered toggles. We use `change`
    // instead of the global click delegator so label-vs-input double-fire
    // can't double-write — checkbox value is final by the time `change`
    // fires.
    body.querySelectorAll('input[data-email-pref]').forEach((el) => {
      el.addEventListener('change', () => window._handleEmailPrefToggle(el));
    });
    const pauseEl = body.querySelector('#emailPrefsPauseToggle');
    if (pauseEl) {
      pauseEl.addEventListener('change', () => window._handleEmailPrefPauseToggle(pauseEl));
    }
  };

  // Per-toggle save — fires the callable 200ms after the last change for
  // the given category. Shows a transient "Saved" pill on success.
  window._handleEmailPrefToggle = function(input) {
    if (!input || !input.dataset || !input.dataset.emailPref) return;
    const key = input.dataset.emailPref;
    const enabled = !!input.checked;
    clearTimeout(_emailPrefDebounce[key]);
    _emailPrefDebounce[key] = setTimeout(async () => {
      try {
        const fn = httpsCallable(fns, 'updateEmailPreferences');
        // updateEmailPreferences accepts { prefs: { [k]: boolean, ... } }
        // and silently no-ops on keys outside its allow-list.
        await fn({ prefs: { [key]: enabled } });
        const pill = document.querySelector(`[data-saved-for="${key}"]`);
        if (pill) {
          pill.style.opacity = '1';
          setTimeout(() => { pill.style.opacity = '0'; }, 1500);
        }
      } catch (e) {
        console.warn('updateEmailPreferences failed', e && e.code || e);
        if (window.showToast) showToast('Couldn\'t save. Try again.', 'error');
        // Roll the toggle back so the UI matches the un-saved server.
        try { input.checked = !enabled; } catch (_) {}
      }
    }, 200);
  };

  window._handleEmailPrefPauseToggle = async function(input) {
    if (!input) return;
    const turnOn = !!input.checked;
    try {
      const fn = httpsCallable(fns, 'setMarketingPause');
      // days:0 clears the pause; days:30 sets a fresh 30-day pause.
      await fn({ days: turnOn ? 30 : 0 });
      if (window.showToast) {
        showToast(turnOn ? 'Marketing paused for 30 days.' : 'Marketing resumed.');
      }
      // Re-render so the banner state + marketing-row disabled state stay
      // in sync without an extra round-trip to compute the new disabled
      // mask on the client.
      window.openEmailPrefs();
    } catch (e) {
      console.warn('setMarketingPause failed', e && e.code || e);
      if (window.showToast) showToast('Couldn\'t update pause. Try again.', 'error');
      try { input.checked = !turnOn; } catch (_) {}
    }
  };

  window._handleEmailPrefsEnableMarketing = async function() {
    try {
      const fn = httpsCallable(fns, 'updateMarketingConsent');
      await fn({ granted: true, source: 'prefs_toggle' });
      if (window.showToast) showToast('Marketing emails re-enabled.');
      window.openEmailPrefs();
    } catch (e) {
      console.warn('updateMarketingConsent re-enable failed', e && e.code || e);
      if (window.showToast) showToast('Couldn\'t re-enable. Try again.', 'error');
    }
  };

  // ──────────────────────────────────────────────────────────
  // Extended deep-link router. The existing routePushNotificationTap
  // (above) handles `message` types only — extend here to cover
  // offer/order/listing/search/payouts/price-drop URLs from the
  // server `data.url` payload (e.g. teebox://offer/{id}).
  // We wrap, preserving the original handler.
  // ──────────────────────────────────────────────────────────
  (function extendDeepLinkRouter() {
    const inner = window.routePushNotificationTap;
    window.routePushNotificationTap = function(data) {
      try {
        const d = data || {};
        const url = String(d.url || d.deepLink || '');
        let host = '', segs = [];
        try {
          if (url) {
            const u = new URL(url);
            host = u.host || u.hostname || '';
            segs = (u.pathname || '').split('/').filter(Boolean);
          }
        } catch (_e) {}
        const entity = host || segs[0] || '';
        const id = host ? segs[0] : segs[1];

        switch (entity) {
          case 'offer':
            if (window.openMyOffers) { window.openMyOffers(); return; }
            break;
          case 'order':
            if (window.openOrders) { window.openOrders(); return; }
            break;
          case 'listing':
            if (id && window.openDetailModal) { window.openDetailModal(id); return; }
            break;
          case 'search':
            if (window.openSavedSearches) { window.openSavedSearches(); return; }
            break;
          case 'payouts':
            if (window.openShopDashboard) { window.openShopDashboard(); return; }
            break;
          case 'bingo':
            // teebox://bingo from the daily reminder + streak-saver pushes.
            // If openBingo is wired (it is, once the bingo widget bootstraps)
            // call it directly; otherwise fall back to the hash router so
            // the page can pick it up on next paint.
            if (typeof window.openBingo === 'function') {
              setTimeout(() => { try { window.openBingo(); } catch (_e) {} }, 0);
            } else {
              try { window.location.hash = '#bingo'; } catch (_e) {}
            }
            return;
          case 'conversation':
          case 'message':
          case 'inbox':
            // fall through to inner handler — it already covers chat.
            break;
        }
        // Fall through to the message-agent's handler.
        if (typeof inner === 'function') inner(data);
      } catch (e) {
        console.warn('extended routePushNotificationTap failed', e);
        if (typeof inner === 'function') inner(data);
      }
    };
  })();

  window.onTermsCheck = function() {
    const checked = document.getElementById('termsCheckbox').checked;
    const btn = document.getElementById('becomeSellerBtn');
    btn.disabled = !checked; btn.style.opacity = checked ? '1' : '0.5';
    document.getElementById('termsStepVal').textContent = checked ? 'Agreed' : 'Pending';
  };

  window.becomeSeller = async function() {
    if (!window.CURRENT_USER) return;
    const btn = document.getElementById('becomeSellerBtn');
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const verify = httpsCallable(fns, 'requestSellerVerification');
      await verify({ termsAgreed: true });
      window.IS_VERIFIED_SELLER = true;
      document.getElementById('verifyBackdrop').classList.remove('open');
      showToast('You are now a verified TeeBox seller.');
      // Route through handleSellClick (not openSellModal directly) so the
      // GATE 1 onboarding check runs — a freshly-verified seller still needs
      // Stripe payout onboarding before they can list.
      setTimeout(() => window.handleSellClick(), 600);
    } catch (e) {
      console.error('Seller verification failed:', e);
      btn.disabled = false; btn.textContent = 'Agree & Become a Seller';
      // Section C — surface the SPECIFIC, actionable reason; never a generic
      // dead end. requestSellerVerification's common rejection is email-not-
      // verified (failed-precondition); show that + the Resend banner instead
      // of "Error. Please try again." (the gap the friend's review hit).
      const code = (e && e.code) || '';
      const msg = (e && e.message) || '';
      if (/verify your email/i.test(msg) || code.includes('failed-precondition')) {
        try { await window.CURRENT_USER.reload(); } catch (_e) {}
        try { window.maybeShowVerifyBanner && window.maybeShowVerifyBanner(window.CURRENT_USER); } catch (_e) {}
        showToast('Verify your email to become a seller — we sent a link to your inbox (tap Resend on the banner if needed).', 'error');
      } else {
        showToast(msg ? ('Could not become a seller: ' + msg.slice(0, 100)) : 'Could not become a seller. Please try again.', 'error');
      }
    }
  };

  window.closeVerifyModal = function() {
    document.getElementById('verifyBackdrop').classList.remove('open');
    document.getElementById('termsCheckbox').checked = false;
    window.onTermsCheck();
  };

  // ── IMAGE UPLOAD ──
  // ── r160: inline sell-form validation (heuristic #12) ──────────────────
  // A seller who can't tell WHY their listing won't post just leaves. Every
  // validation failure marks the exact field, writes a persistent message
  // under it, and scrolls+focuses the first problem. Messages clear the
  // moment the seller edits that field — never a vanishing toast.
  function clearSellErrors() {
    document.querySelectorAll('#sellModalBackdrop .field-invalid').forEach(el => {
      el.classList.remove('field-invalid');
      el.removeAttribute('aria-invalid');
    });
    document.querySelectorAll('#sellModalBackdrop .field-error-msg').forEach(el => el.remove());
  }
  function applySellErrors(errors) {
    // errors: [[elementId, message], ...] — first entry gets scroll+focus.
    clearSellErrors();
    errors.forEach(([id, msg]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('field-invalid');
      el.setAttribute('aria-invalid', 'true');
      const m = document.createElement('div');
      m.className = 'field-error-msg';
      m.setAttribute('role', 'alert');
      m.textContent = msg;
      // Photos target is a container — message goes INSIDE at the top so it
      // sits with the uploader; inputs get it as a sibling after themselves.
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
        el.insertAdjacentElement('afterend', m);
        const clear = () => { el.classList.remove('field-invalid'); el.removeAttribute('aria-invalid'); m.remove(); };
        el.addEventListener('input', clear, { once: true });
        el.addEventListener('change', clear, { once: true });
      } else {
        el.insertAdjacentElement('beforebegin', m);
      }
    });
    const first = errors.length && document.getElementById(errors[0][0]);
    if (first) {
      try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_e) { first.scrollIntoView(); }
      if (typeof first.focus === 'function') setTimeout(() => first.focus({ preventScroll: true }), 350);
    }
  }
  // ── Listing v2 spec engine (2026-09-24) ────────────────────────────
  // One schema drives the category pills, the dynamic spec form, submit
  // validation, and the detail-page spec table. Dropdowns everywhere a
  // finite set exists; free text only where unavoidable. brand +
  // condition ride the existing #sellBrand/#sellCondition inputs.
  const rng = (a, b, st, unit) => { const o = []; for (let v = a; v <= b + 1e-9; v += st) o.push(String(Math.round(v * 10) / 10) + (unit || '')); return o; };
  const FLEXES = ['L', 'A', 'R', 'S', 'X'];
  const DEX = ['RH', 'LH'];
  const YN = ['Yes', 'No'];
  const SH = [
    { k: 'shaftBrand', label: 'Shaft brand', type: 'text' },
    { k: 'shaftModel', label: 'Shaft model', type: 'text' },
  ];
  const FLEXDEX = [
    { k: 'flex', label: 'Flex', type: 'select', options: FLEXES, req: 1 },
    { k: 'dexterity', label: 'Dexterity', type: 'select', options: DEX, req: 1 },
  ];
  window.SPEC_SCHEMA = {
    'driver':      { label: 'Driver', browse: 'clubs', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'loft', label: 'Loft', type: 'select', options: rng(7, 13, 0.5, '°').concat('Other'), req: 1 }, ...SH, ...FLEXDEX, { k: 'headcover', label: 'Headcover included', type: 'select', options: YN } ] },
    'fairway':     { label: 'Fairway', browse: 'clubs', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'loft', label: 'Loft', type: 'select', options: rng(13, 21, 0.5, '°').concat('Other'), req: 1 }, ...SH, ...FLEXDEX, { k: 'headcover', label: 'Headcover included', type: 'select', options: YN } ] },
    'hybrid':      { label: 'Hybrid', browse: 'clubs', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'loft', label: 'Loft', type: 'select', options: rng(16, 28, 0.5, '°').concat('Other'), req: 1 }, ...SH, ...FLEXDEX, { k: 'headcover', label: 'Headcover included', type: 'select', options: YN } ] },
    'iron-set':    { label: 'Iron set', browse: 'clubs', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'setFrom', label: 'Set from', type: 'select', options: ['2', '3', '4', '5', '6', '7'], req: 1 }, { k: 'setTo', label: 'Set to', type: 'select', options: ['9', 'PW', 'AW', 'GW', 'SW', 'LW'], req: 1 }, ...SH, { k: 'shaftType', label: 'Shaft type', type: 'select', options: ['Steel', 'Graphite'] }, ...FLEXDEX, { k: 'lieLength', label: 'Lie/length', type: 'select', options: ['Standard', 'Adjusted (see description)'] }, { k: 'grip', label: 'Grip', type: 'text' } ] },
    'single-iron': { label: 'Single iron', browse: 'clubs', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'ironNumber', label: 'Iron #', type: 'select', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'PW'], req: 1 }, ...SH, { k: 'shaftType', label: 'Shaft type', type: 'select', options: ['Steel', 'Graphite'] }, ...FLEXDEX ] },
    'wedge':       { label: 'Wedge', browse: 'clubs', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'loft', label: 'Loft', type: 'select', options: rng(46, 64, 1, '°'), req: 1 }, { k: 'bounce', label: 'Bounce', type: 'select', options: rng(4, 14, 1, '°').concat('Other') }, { k: 'grind', label: 'Grind', type: 'text' }, ...SH, ...FLEXDEX ] },
    'putter':      { label: 'Putter', browse: 'clubs', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'length', label: 'Length', type: 'select', options: rng(32, 36, 0.5, '"'), req: 1 }, { k: 'headStyle', label: 'Head style', type: 'select', options: ['Blade', 'Mid-mallet', 'Mallet'], req: 1 }, { k: 'grip', label: 'Grip', type: 'text' }, { k: 'dexterity', label: 'Dexterity', type: 'select', options: DEX, req: 1 }, { k: 'headcover', label: 'Headcover included', type: 'select', options: YN } ] },
    'balls':       { label: 'Balls', browse: 'balls', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'quantity', label: 'Ball count', type: 'select', options: ['12', '24', '36', '48', 'Other'], req: 1 } ] },
    'bag':         { label: 'Bag', browse: 'bags', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'bagType', label: 'Type', type: 'select', options: ['Stand', 'Cart', 'Carry', 'Staff', 'Travel'] } ] },
    'apparel':     { label: 'Apparel', browse: 'apparel', fields: [ { k: 'apparelType', label: 'Type', type: 'select', options: ['Polo', 'Quarter-zip', 'Outerwear', 'Pants', 'Shorts', 'Hat', 'Other'], req: 1 }, { k: 'size', label: 'Size', type: 'select', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'Other'], req: 1 } ] },
    'shoes':       { label: 'Shoes', browse: 'shoes', fields: [ { k: 'model', label: 'Model', type: 'text', req: 1 }, { k: 'size', label: 'Size (US)', type: 'select', options: rng(7, 15, 0.5, ''), req: 1 } ] },
    'headcover':   { label: 'Headcover', browse: 'headcovers', fields: [ { k: 'hcType', label: 'Fits', type: 'select', options: ['Driver', 'Fairway', 'Hybrid', 'Putter', 'Iron covers'] } ] },
    'accessories': { label: 'Accessories', browse: 'accessories', fields: [ { k: 'itemType', label: 'What is it?', type: 'text', req: 1 } ] },
    'other':       { label: 'Other', browse: '', fields: [] },
  };
  window.SPEC_LABELS = (() => { const m = { brand: 'Brand', condition: 'Condition' }; Object.values(window.SPEC_SCHEMA).forEach(c => c.fields.forEach(f => { m[f.k] = f.label; })); return m; })();
  let __specCategory = '';
  let __stepOpen = {photos: false, cat: false}; // Edit-pinned steps (r259)
  window.expandSellStep = function (step) {
    if (step in __stepOpen) __stepOpen[step] = true;
    window.updateSellSteps && window.updateSellSteps();
  };
  function renderSpecCatPills() {
    const el = document.getElementById('sellSpecCatPills');
    if (!el) return;
    el.innerHTML = Object.entries(window.SPEC_SCHEMA).map(([k, c]) =>
      `<button type="button" class="spec-cat-pill${k === __specCategory ? ' active' : ''}" data-action="pick-spec-cat" data-speccat="${k}">${c.label}</button>`).join('');
  }
  function renderSpecFields() {
    const wrap = document.getElementById('sellSpecFields');
    if (!wrap) return;
    const cat = window.SPEC_SCHEMA[__specCategory];
    if (!cat || !cat.fields.length) { wrap.innerHTML = ''; return; }
    let html = '';
    for (let i = 0; i < cat.fields.length; i += 2) {
      const pair = cat.fields.slice(i, i + 2).map(f => {
        const id = 'spec_' + f.k;
        const reqStar = f.req ? ' *' : '';
        if (f.type === 'select') {
          return `<div class="form-row"><label for="${id}">${f.label}${reqStar}</label><select id="${id}"><option value="">${f.req ? 'Choose…' : '—'}</option>${f.options.map(o => `<option>${o}</option>`).join('')}</select></div>`;
        }
        return `<div class="form-row"><label for="${id}">${f.label}${reqStar}</label><input type="text" id="${id}" maxlength="120" /></div>`;
      }).join('');
      html += `<div class="spec-two-col">${pair}</div>`;
    }
    wrap.innerHTML = html;
  }
  window.setSpecCategory = function (k, opts) {
    if (!window.SPEC_SCHEMA[k]) return;
    __specCategory = k;
    renderSpecCatPills();
    renderSpecFields();
    // Auto-drive the browse category; "Other" exposes the legacy select.
    const catRow = document.getElementById('sellCatRow');
    const catSel = document.getElementById('sellCat');
    if (k === 'other') { if (catRow) catRow.style.display = ''; }
    else { if (catRow) catRow.style.display = 'none'; if (catSel) catSel.value = window.SPEC_SCHEMA[k].browse; }
    // The Caddie card is CSS-gated on .cat-picked; a category change
    // starts it fresh (its last result described a different club).
    if (window.caddieReset) window.caddieReset();
    if (window.updateSellSteps) window.updateSellSteps();
    if (!(opts && opts.silent) && typeof renderTakeHome === 'function') { try { renderTakeHome(); } catch (_e) {} }
  };
  window.getSpecCategory = () => __specCategory;
  window.collectSpecs = function () {
    const cat = window.SPEC_SCHEMA[__specCategory];
    const out = {};
    if (!cat) return out;
    const brand = (document.getElementById('sellBrand') || {}).value;
    if (brand && brand.trim()) out.brand = brand.trim().slice(0, 60);
    cat.fields.forEach(f => {
      const el = document.getElementById('spec_' + f.k);
      const v = el && String(el.value || '').trim();
      if (v) out[f.k] = v.slice(0, 120);
    });
    return out;
  };
  window.collectSpecErrors = function () {
    const errs = [];
    if (!__specCategory) { errs.push(['sellSpecCatPills', 'Pick what you\'re selling first.']); return errs; }
    const cat = window.SPEC_SCHEMA[__specCategory];
    cat.fields.forEach(f => {
      if (!f.req) return;
      const el = document.getElementById('spec_' + f.k);
      if (!el || !String(el.value || '').trim()) errs.push(['spec_' + f.k, `${f.label} is required for ${cat.label.toLowerCase()} listings.`]);
    });
    return errs;
  };
  window.resetSpecState = function () {
    __specCategory = '';
    __stepOpen = {photos: false, cat: false};
    renderSpecCatPills(); renderSpecFields();
    if (window.caddieReset) window.caddieReset();
    window.updateSellSteps && window.updateSellSteps();
  };
  // r258: the stepped flow's single source of truth. Photos gate the
  // category pills; category gates everything below (CSS classes).
  window.updateSellSteps = function () {
    const form = document.querySelector('#sellModalBackdrop .sell-form');
    if (!form) return;
    const n = (typeof selectedFiles !== 'undefined') ? selectedFiles.length : 0;
    const hasPhotos = n > 0;
    const catKey = (window.getSpecCategory && window.getSpecCategory()) || '';
    const hasCat = !!catKey;
    form.classList.toggle('has-photos', hasPhotos);
    form.classList.toggle('cat-picked', hasCat);
    const hint = document.getElementById('sellSpecCatHint');
    if (hint) hint.style.display = hasPhotos ? 'none' : '';
    // r259: completed steps collapse to a one-line summary + Edit link so
    // the seller's eye stays on the current step. Edit pins a step open
    // (__stepOpen) until the modal resets.
    const editing = !!window.__editingListingId;
    const collapseP = hasPhotos && hasCat && !__stepOpen.photos && !editing;
    const collapseC = hasCat && !__stepOpen.cat && !editing;
    const sp = document.getElementById('stepPhotos');
    const sc = document.getElementById('stepCat');
    if (sp) sp.classList.toggle('collapsed', collapseP);
    if (sc) sc.classList.toggle('collapsed', collapseC);
    const pl = document.getElementById('photosLabel');
    if (pl) {
      pl.innerHTML = collapseP
        ? `1 · ${n} photo${n === 1 ? '' : 's'}`
        : `1 · Photos${n ? ` <span class="sell-step-count">${n} of 10</span>` : ''}`;
    }
    const cl = document.getElementById('catLabel');
    if (cl) {
      cl.textContent = collapseC
        ? `2 · ${((window.SPEC_SCHEMA || {})[catKey] || {}).label || ''}`
        : '2 · What are you selling?';
    }
    // Legacy markup: the Description form-row has no static class anchor —
    // gate it (and the terms row) at runtime alongside the tagged rows.
    const descRow = document.getElementById('sellDesc');
    if (descRow && descRow.parentElement) descRow.parentElement.classList.add('sell-gated');
    const terms = document.getElementById('sellTermsRow');
    if (terms) terms.classList.add('sell-gated');
    const submitBtn = document.getElementById('submitListingBtn');
    if (submitBtn) submitBtn.disabled = !hasCat && !window.__editingListingId;
  };
  window.hydrateSpecState = function (listing) {
    const k = listing && listing.specCategory;
    if (k && window.SPEC_SCHEMA[k]) {
      window.setSpecCategory(k, { silent: true });
      const specs = listing.specs || {};
      Object.entries(specs).forEach(([key, val]) => {
        const el = document.getElementById('spec_' + key);
        if (el) el.value = String(val);
      });
    } else { window.resetSpecState(); }
  };
  renderSpecCatPills();

  // Validates the shared sell/edit field set; returns [] when clean.
  function collectSellErrors({ title, brand, cat, price, condition, files, checkDesc }) {
    const errors = [];
    if (!title) errors.push(['sellTitle', 'Add a title so buyers can find your item.']);
    if (!brand) errors.push(['sellBrand', 'Add the brand (or "Unbranded").']);
    if (!cat) errors.push(['sellCat', 'Pick the category buyers will browse.']);
    if (!price || !Number.isFinite(price) || price <= 0) errors.push(['sellPrice', 'Enter a price greater than $0.']);
    else {
      // Price floor (Structure 2): buyers fund shipping now, so the
      // Structure-1 label-affordability floors are retired — a token $5
      // floor deters junk listings. Mirrors categoryFloor() in
      // firestore.rules + updateListing.
      const floor = 5;
      if (price < floor) errors.push(['sellPrice',
        `Minimum listing price is $${floor}.`]);
    }
    if (!condition) errors.push(['sellCondition', 'Pick a condition.']);
    // Listing v2: category + required per-category specs block submit.
    if (window.collectSpecErrors) errors.push(...window.collectSpecErrors());
    if ((files || []).length < 1) errors.push(['uploadZone', 'Add at least 1 photo — listings need a main image.']);
    else if (price >= 300 && (files || []).length < 4) errors.push(['uploadZone', 'Listings over $300 need at least 4 photos, including a verification photo.']);
    const blocked = checkDesc != null && window.findExplicitContent && window.findExplicitContent(title + ' ' + checkDesc);
    if (blocked) errors.push(['sellTitle', 'Please remove inappropriate language from the title or description.']);
    return errors;
  }

  // Exposed for QA harnesses (module-scoped otherwise).
  window.__sellValidation = { collect: collectSellErrors, apply: applySellErrors, clear: clearSellErrors };

  let selectedFiles = [];

  window.onPhotoSelect = function(e) { addFiles(Array.from(e.target.files)); e.target.value = ''; };
  window.onDragOver = function(e) { e.preventDefault(); document.getElementById('uploadZone').classList.add('dragover'); };
  window.onDragLeave = function() { document.getElementById('uploadZone').classList.remove('dragover'); };
  window.onDrop = function(e) { e.preventDefault(); document.getElementById('uploadZone').classList.remove('dragover'); addFiles(Array.from(e.dataTransfer.files)); };

  function addFiles(files) {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    const remaining = 10 - selectedFiles.length;
    const toAdd = imageFiles.slice(0, remaining);
    selectedFiles = [...selectedFiles, ...toAdd];
    renderPreviews();
  }

  // Listing v2 AI assist: ≤4 photos downscaled client-side (photos are
  // not in Storage yet at draft time) → draftListingFromPhotos (Haiku
  // 4.5) → suggestions pre-filled ONLY into empty fields. One-tap undo;
  // nothing publishes. Fails soft: the form works without it.
  let __aiFilled = [];
  async function __toDraftB64(entry) {
    try {
      let bmp;
      if (entry && entry.__existingUrl) {
        const r = await fetch(entry.__existingUrl);
        bmp = await createImageBitmap(await r.blob());
      } else {
        bmp = await createImageBitmap(entry);
      }
      // r261: 1400px (was 800). The 800px cap shrank a 1206px phone photo
      // by 40% and small sole stampings stopped being legible — the
      // "Futura X5" misread on a Studio Style Newport. Never upscales.
      const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const b64 = c.toDataURL('image/jpeg', 0.9).split(',')[1];
      return (b64 && b64.length < 900 * 1024) ? b64 : null;
    } catch (_e) { return null; }
  }
  // ── Caddie: states, sequenced loading, price chips, field marks ──
  function caddieShow(state) {
    ['caddieIdle', 'caddieLoading', 'caddieResult'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = (id !== state);
    });
    // r276: the caddie's mood follows the state. One class on the card drives
    // every animation, so there is exactly one place this can go out of sync.
    const card = document.getElementById('caddieCard');
    if (!card) return;
    card.classList.toggle('cd-thinking', state === 'caddieLoading');
    if (state === 'caddieResult') {
      // Retrigger the nod each time a result lands: removing and re-adding in
      // the next frame restarts a finite animation that has already played.
      card.classList.remove('cd-done');
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('cd-done')));
    } else {
      card.classList.remove('cd-done');
    }
  }
  function caddieError(msg) {
    caddieShow('caddieIdle');
    const e = document.getElementById('caddieErrorMsg');
    if (e) { e.textContent = msg || ''; e.hidden = !msg; }
  }
  let __caddieTimers = [];
  function caddieStartLoading() {
    const e = document.getElementById('caddieErrorMsg');
    if (e) { e.hidden = true; e.textContent = ''; }
    caddieShow('caddieLoading');
    const steps = [...document.querySelectorAll('#caddieLoading .caddie-prog')];
    steps.forEach(x => x.classList.remove('done', 'active'));
    if (steps[0]) steps[0].classList.add('active');
    __caddieTimers.forEach(clearTimeout);
    __caddieTimers = [
      setTimeout(() => { if (steps[0]) { steps[0].classList.replace('active', 'done'); } if (steps[1]) steps[1].classList.add('active'); }, 1100),
      setTimeout(() => { if (steps[1]) { steps[1].classList.replace('active', 'done'); } if (steps[2]) steps[2].classList.add('active'); }, 2400),
    ];
  }
  function caddieFinishLoading() {
    __caddieTimers.forEach(clearTimeout); __caddieTimers = [];
    document.querySelectorAll('#caddieLoading .caddie-prog').forEach(x => {
      x.classList.remove('active'); x.classList.add('done');
    });
  }
  function caddieTagField(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const row = el.closest('.form-row');
    const label = document.querySelector(`label[for="${inputId}"]`) || (row && row.querySelector('label'));
    if (!label || label.querySelector('.caddie-tag')) return;
    const tag = document.createElement('span');
    tag.className = 'caddie-tag';
    tag.textContent = 'Caddie';
    label.appendChild(tag);
  }
  function caddieNote(specKey, text) {
    const el = document.getElementById('spec_' + specKey) || document.getElementById(specKey);
    const row = el && el.closest('.form-row');
    if (!row || row.querySelector('.caddie-miss')) return;
    const d = document.createElement('div');
    d.className = 'caddie-miss';
    d.textContent = text;
    row.appendChild(d);
  }
  function caddieClearMarks() {
    document.querySelectorAll('#sellModalBackdrop .caddie-tag').forEach(t => t.remove());
    document.querySelectorAll('#sellSpecFields .caddie-miss, .sell-form .form-row .caddie-miss').forEach(t => t.remove());
  }
  function caddieRenderResult(d) {
    const pr = d.price;
    const chips = document.getElementById('caddieChips');
    if (chips) {
      chips.innerHTML = (pr && pr.mid > 0)
        ? [['Low', pr.low], ['Suggested', pr.mid], ['High', pr.high]].map(([k, v]) =>
            `<button type="button" class="caddie-chip${k === 'Suggested' ? ' active' : ''}" data-action="caddie-price" data-price="${Number(v) || 0}"><span class="cc-k">${k}</span><span class="cc-v">$${(Number(v) || 0).toLocaleString()}</span></button>`).join('')
        : '';
    }
    const rat = document.getElementById('caddieRationale');
    if (rat) rat.textContent = (pr && pr.rationale) || 'Filled from your photos — every field is editable.';
    const comps = document.getElementById('caddieComps');
    if (comps) comps.textContent = (pr && pr.compsUsed > 0)
      ? `based on ${pr.compsUsed} TeeBox sale${pr.compsUsed === 1 ? '' : 's'}`
      : 'based on market data';
    caddieShow('caddieResult');
  }
  window.caddieSetPrice = function (price, el) {
    const p = document.getElementById('sellPrice');
    if (p) { p.value = String(price); try { renderTakeHome(); } catch (_e) {} }
    caddieTagField('sellPrice');
    document.querySelectorAll('#caddieChips .caddie-chip').forEach(c => c.classList.toggle('active', c === el));
  };
  const __specNorm = (x) => String(x).toLowerCase().replace(/[^a-z0-9.]/g, '');
  window.aiDraftListing = async function () {
    const cat = window.getSpecCategory && window.getSpecCategory();
    const btn = document.getElementById('caddieBtn');
    if (!cat || cat === 'other') { caddieError('Pick a specific category first — Caddie reads specs per category.'); return; }
    if (!selectedFiles.length) { caddieError('Add at least one photo first.'); return; }
    caddieClearMarks();
    caddieStartLoading();
    if (btn) btn.disabled = true;
    try {
      const images = [];
      for (const f of selectedFiles.slice(0, 4)) {
        const b64 = await __toDraftB64(f);
        if (b64) images.push({ data: b64, mediaType: 'image/jpeg' });
      }
      if (!images.length) throw new Error('no-images');
      const { getFunctions, httpsCallable } =
        await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
      const fn = httpsCallable(getFunctions(), 'draftListingFromPhotos');
      const specsNow = window.collectSpecs ? window.collectSpecs() : {};
      const schema = (window.SPEC_SCHEMA || {})[cat] || { fields: [] };
      const requiredFields = schema.fields.filter(f => f.req).map(f => f.k);
      // r261: hand Caddie the exact dropdown values so it answers in our
      // vocabulary ("RH", not "Right-handed") and the fill actually lands.
      const fieldOptions = {};
      schema.fields.forEach(f => { if (f.type === 'select' && Array.isArray(f.options)) fieldOptions[f.k] = f.options; });
      const res = await fn({ category: cat, images, specs: specsNow, brand: specsNow.brand || '', model: specsNow.model || '', requiredFields, fieldOptions });
      const d = (res && res.data) || {};
      caddieFinishLoading();
      if (!d.ok) {
        const msgs = {
          'daily-limit': "You've hit today's Caddie limit (25 drafts). Fill the form manually — everything still works.",
          'budget': 'Caddie is paused for the month. Fill the form manually — everything still works.',
          'disabled': 'Caddie is off right now. Fill the form manually — everything still works.',
        };
        caddieError(msgs[d.reason] || "Caddie couldn't read these photos — fill the form manually.");
        return;
      }
      __aiFilled = [];
      const fill = (id, val) => {
        const el = document.getElementById(id);
        if (el && val && !String(el.value || '').trim()) { el.value = val; __aiFilled.push(id); caddieTagField(id); }
      };
      fill('sellTitle', d.title);
      fill('sellDesc', d.description);
      if (d.condition) {
        const c = document.getElementById('sellCondition');
        if (c) { c.value = d.condition; __aiFilled.push('sellCondition'); caddieTagField('sellCondition'); }
      }
      Object.entries(d.specs || {}).forEach(([k, v]) => {
        if (k === 'brand') { fill('sellBrand', v); return; }
        const el = document.getElementById('spec_' + k);
        if (!el || String(el.value || '').trim()) return;
        if (el.tagName === 'SELECT') {
          const hit = [...el.options].find(o => o.value && __specNorm(o.value) === __specNorm(v));
          if (hit) { el.value = hit.value; __aiFilled.push('spec_' + k); caddieTagField('spec_' + k); }
          else caddieNote(k, `Caddie read “${String(v).slice(0, 24)}” — pick the closest option.`);
        } else { el.value = String(v); __aiFilled.push('spec_' + k); caddieTagField('spec_' + k); }
      });
      // Fields Caddie explicitly could not read → soft amber note.
      Object.entries(d.unreadable || {}).forEach(([k, hint]) => {
        const label = String((window.SPEC_LABELS || {})[k] || k).toLowerCase();
        caddieNote(k, `Caddie couldn't read the ${label}${hint ? ' — ' + hint : ''}.`);
      });
      if (d.price && d.price.mid > 0) fill('sellPrice', String(d.price.mid));
      try { renderTakeHome(); } catch (_e) {}
      caddieRenderResult(d);
    } catch (e) {
      console.warn('caddie draft failed', e);
      caddieFinishLoading();
      caddieError("Caddie couldn't read these photos — fill the form manually.");
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  window.aiDraftUndo = function () {
    __aiFilled.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    __aiFilled = [];
    caddieClearMarks();
    try { renderTakeHome(); } catch (_e) {}
    caddieShow('caddieIdle');
    const e = document.getElementById('caddieErrorMsg');
    if (e) { e.hidden = false; e.textContent = 'Cleared. Fill the form yourself, or let Caddie try again.'; }
  };
  window.caddieReset = function () {
    __aiFilled = [];
    caddieClearMarks();
    caddieShow('caddieIdle');
    const e = document.getElementById('caddieErrorMsg');
    if (e) { e.hidden = true; e.textContent = ''; }
  };
  // r259: photo grid — main tile renders 2x at the left, the rest small
  // beside it, "+ Add" closes the grid. The dashed drop zone only exists
  // while there are zero photos. Tap a tile to promote it to main; drag
  // to reorder (desktop); tiny x removes.
  function renderPreviews() {
    if (window.updateSellSteps) window.updateSellSteps();
    const container = document.getElementById('uploadPreviews');
    const zone = document.getElementById('uploadZone');
    const n = selectedFiles.length;
    // selectedFiles entries are either a File (newly picked) or a
    // {__existingUrl} marker (a photo already on the listing — edit
    // mode). Both render identically; only Files are re-uploaded.
    const tiles = selectedFiles.map((f, i) => {
      const url = (f && f.__existingUrl)
        ? (window.safeImgUrl ? window.safeImgUrl(f.__existingUrl) : f.__existingUrl)
        : URL.createObjectURL(f);
      return `<div class="photo-tile${i === 0 ? ' main' : ''}" draggable="true" data-idx="${i}"${i === 0 ? '' : ' data-action="photo-make-main"'} title="${i === 0 ? 'Main listing photo' : 'Tap to make this the main photo'}">
        <img src="${url}" alt="Listing photo ${i + 1} preview" draggable="false" />
        ${i === 0 ? '<span class="pt-main">MAIN</span>' : ''}
        <button type="button" class="pt-x" data-action="remove-photo" data-idx="${i}" aria-label="Remove photo ${i + 1}">${window.ICONS.close}</button>
      </div>`;
    }).join('');
    container.innerHTML = tiles + ((n > 0 && n < 10)
      ? '<button type="button" class="photo-add" data-action="open-photo-input" aria-label="Add more photos">+ Add</button>' : '');
    // r277: HEIC previews render as broken images. iPhone photos are HEIC by
    // default and Chrome/Firefox cannot decode that codec in an <img> (Safari
    // can), so URL.createObjectURL on the raw file gives a blob the browser
    // renders at 0x0. The UPLOAD was always fine — optimizeListingPhoto
    // converts HEIC server-side via heic-convert — so this was purely a
    // "my photos look broken" problem, which is more than enough to stop
    // someone listing.
    // Wired here rather than an inline onerror because the CSP sets
    // script-src-attr 'none'.
    container.querySelectorAll('.photo-tile img').forEach((img) => {
      const mark = () => {
        const tile = img.closest('.photo-tile');
        if (tile) tile.classList.add('no-preview');
      };
      if (img.complete && img.naturalWidth === 0) mark();
      img.addEventListener('error', mark, { once: true });
      img.addEventListener('load', () => {
        if (img.naturalWidth === 0) mark();
      }, { once: true });
    });
    if (zone) zone.style.display = n === 0 ? 'block' : 'none';
    wirePhotoDrag();
  }
  let __photoDragFrom = null;
  function wirePhotoDrag() {
    document.querySelectorAll('#uploadPreviews .photo-tile').forEach((t) => {
      t.addEventListener('dragstart', (e) => {
        __photoDragFrom = Number(t.dataset.idx);
        t.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(__photoDragFrom)); } catch (_e) {}
      });
      t.addEventListener('dragend', () => { t.classList.remove('dragging'); __photoDragFrom = null; });
      t.addEventListener('dragover', (e) => { e.preventDefault(); });
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        const to = Number(t.dataset.idx);
        let from = __photoDragFrom;
        if (!Number.isInteger(from)) { try { from = Number(e.dataTransfer.getData('text/plain')); } catch (_e) { return; } }
        if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
        const [moved] = selectedFiles.splice(from, 1);
        selectedFiles.splice(to, 0, moved);
        renderPreviews();
      });
    });
  }
  window.photoMakeMain = function (i) {
    i = Number(i);
    if (!Number.isInteger(i) || i <= 0 || i >= selectedFiles.length) return;
    const [moved] = selectedFiles.splice(i, 1);
    selectedFiles.unshift(moved);
    renderPreviews();
  };

  window.removePhoto = function(i) {
    selectedFiles.splice(i,1);
    renderPreviews();
  };

  // Exposes the first N draft photos as base64 data + mimeType so the
  // AI price-suggest call can include them as multimodal input. Each
  // image is downscaled to a max 1024-px edge and re-encoded as JPEG
  // (~75% quality) to keep the callable payload under 1MB total.
  window.getSellPhotosForAI = async function(maxCount) {
    const out = [];
    if (!selectedFiles || selectedFiles.length === 0) return out;
    const n = Math.min(selectedFiles.length, Math.max(1, maxCount || 3));
    for (let i = 0; i < n; i++) {
      try {
        const file = selectedFiles[i];
        // Existing-photo markers (edit mode) aren't File blobs — skip;
        // the AI price call works fine off the newly picked photos.
        if (file && file.__existingUrl) continue;
        const bitmap = await createImageBitmap(file).catch(() => null);
        if (!bitmap) continue;
        const maxEdge = 1024;
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.75));
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // btoa requires a binary string; build it in chunks to avoid
        // call-stack limits on larger images.
        let bin = '';
        const chunk = 0x8000;
        for (let j = 0; j < bytes.length; j += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(j, j + chunk));
        }
        out.push({ data: btoa(bin), mimeType: 'image/jpeg' });
      } catch (e) {
        // Best-effort — skip this photo and continue.
      }
    }
    return out;
  };

  // r349 (P1-9): target ≤ 500 KB per photo so a post-to-live on a phone link
  // is seconds, not 15 s. Steps: 2048px q0.85 → q0.72 → 1600px q0.8. The server
  // still re-encodes to WebP + variants, so nothing visible is lost on cards.
  const UPLOAD_TARGET_BYTES = 500 * 1024;
  async function shrinkForUpload(file) {
    // Skip if already small enough — no point recompressing.
    if (file.size < UPLOAD_TARGET_BYTES) return file;
    try {
      const bmp = await createImageBitmap(file);
      const steps = [[2048, 0.85], [2048, 0.72], [1600, 0.8], [1280, 0.75]];
      let best = null;
      for (const [max, q] of steps) {
        const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * scale);
        const h = Math.round(bmp.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
        if (blob && (!best || blob.size < best.size)) best = blob;
        if (blob && blob.size <= UPLOAD_TARGET_BYTES) break;
      }
      bmp.close && bmp.close();
      return (best && best.size < file.size) ? best : file;
    } catch (err) {
      // Browser can't decode this codec (e.g. HEIC outside Safari) — upload the
      // raw file. The server's optimizeListingPhoto converts HEIC via heic-convert
      // (WASM libheif), so the raw bytes still become a renderable WebP.
      console.warn('shrinkForUpload failed, using original:', err && err.message);
      return file;
    }
  }

  async function uploadPhotos(listingId) {
    if (selectedFiles.length === 0) return [];
    const uid = window.CURRENT_USER && window.CURRENT_USER.uid;
    if (!uid) throw new Error('not signed in');
    const progress = document.getElementById('uploadProgress');
    const bar = document.getElementById('uploadProgressBar');
    progress.style.display = 'block';
    let done = 0;
    const total = selectedFiles.length;
    // Parallel uploads with client-side compression. Files are shrunk to 1600px
    // JPEG @ 0.85 quality before upload (was ~12x oversize vs. server output).
    // Path includes sellerId so storage rules can verify ownership without
    // a cross-service firestore.get() (which was 403'ing due to consistency lag).
    // Order is preserved: existing-photo markers ({__existingUrl}) keep
    // their slot and are NOT re-uploaded — only freshly picked Files
    // hit Storage. This makes photo reorder/remove on edit cheap and
    // keeps the seller's chosen MAIN-first ordering intact.
    const urls = await Promise.all(selectedFiles.map(async (file, i) => {
      if (file && file.__existingUrl) {
        done++;
        bar.style.width = `${Math.round(done/total*100)}%`;
        return file.__existingUrl;
      }
      const shrunk = await shrinkForUpload(file);
      // Name the object by its ACTUAL type and set contentType honestly. The
      // old code force-renamed everything to .jpg, which disguised raw HEIC
      // bytes as a JPEG (misleading, and the server relies on contentType).
      // Files reaching here always passed addFiles' image/* filter, so outType
      // is always image/*.
      const outType = (shrunk && shrunk.type) || file.type || 'image/jpeg';
      const extByType = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
        'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif'
      };
      const ext = extByType[outType] || 'jpg';
      const base = (file.name.replace(/\.[^.]+$/, '') || 'photo').replace(/[^A-Za-z0-9._\-]/g, '_');
      const safeName = `${base}.${ext}`;
      const storageRef = ref(storage, `listings/${uid}/${listingId}/${Date.now()}_${i}_${safeName}`);
      await uploadBytes(storageRef, shrunk, { contentType: outType });
      const url = await getDownloadURL(storageRef);
      done++;
      bar.style.width = `${Math.round(done/total*100)}%`;
      return url;
    }));
    progress.style.display = 'none';
    bar.style.width = '0%';
    return urls;
  }

  async function loadListings() {
    // r148: show the skeleton only when the grid has nothing real on it yet.
    // Refreshes (auth restore, sign-in/out, post-payment) swap data in place
    // instead of flashing already-rendered cards back to placeholders.
    // r349: the REST first-paint feed (index.html bootPaintFeed) may already
    // have real cards on the grid — never replace those with placeholders.
    const _bootCards = !!document.querySelector('#productGrid [data-boot]');
    if (!(window.PRODUCTS || []).length && !_bootCards && typeof showProductSkeleton === 'function') showProductSkeleton(8);
    try {
      // Cap the marketplace fetch to keep first-paint snappy and bandwidth
      // bounded. We display the most-recent N — the homepage grid never
      // shows more than a few dozen cards above the fold anyway. When we
      // pass this threshold we'll graduate to cursor-paginated infinite
      // scroll. Bumping this is fine; just remember every doc here is a
      // Firestore read on every page load.
      const LISTINGS_FETCH_CAP = 200;
      const q = query(
        collection(db, 'listings'),
        orderBy('createdAt', 'desc'),
        limit(LISTINGS_FETCH_CAP)
      );
      // Perf: the very first load consumes the boot-time prefetch (started at
      // app init, in parallel with auth restoration) so the Firestore round-
      // trip is already in flight — or done — by the time we get here. We null
      // it after one use so reloads (post-listing, post-payment, sign-in/out)
      // always fetch fresh and never serve stale inventory. If the prefetch
      // failed it resolves to null, and we fall back to a live fetch.
      let snap;
      if (window.__listingsPrefetch) {
        const prefetched = window.__listingsPrefetch;
        window.__listingsPrefetch = null;
        snap = (await prefetched) || (await getDocs(q));
      } else {
        snap = await getDocs(q);
      }
      // r148: Firestore masks an unreachable backend as an EMPTY snapshot
      // served from the (empty) local cache — getDocs resolves fine and the
      // catch below never fires. An empty fromCache result on the public feed
      // therefore means "offline", not "no listings"; throw so the error
      // state (with Retry) renders instead of a false "No listings yet".
      if (snap && snap.empty && snap.metadata && snap.metadata.fromCache) {
        throw new Error('feed query served from empty local cache — offline');
      }
      const items = snap.docs
        .map(d => ({ id: d.id, name: d.data().title, ...d.data() }))
        // Hide dead listings from the public feed so they never render as live
        // clickable cards (and so seller identity never attaches to one):
        // expired, sold, removed, and flagged are all dropped. Active +
        // (transient) pending remain. Sold items still appear on the seller's
        // storefront. `flagged` = held by moderation (NSFW / unscannable /
        // undecodable image) — must never reach buyers. This is the single
        // source for window.PRODUCTS, so search, category (applyFilters),
        // "more like this", and the sidebar widgets inherit the exclusion.
        // r348: `hidden` = list-first auto-pause (seller never set up payouts
        // within 7 days). Owner still sees it on their storefront + dashboard.
        .filter(p => p.status !== 'expired' && p.status !== 'sold' && p.status !== 'removed' && p.status !== 'flagged' && p.status !== 'hidden')
        // Hide listings with no photos — orphans from before the rollback fix
        // shipped, plus any in-progress listing where photo upload failed.
        // Sellers can still see + delete these from My Shop.
        .filter(p => Array.isArray(p.photos) && p.photos.length > 0);
      // Show real Firestore listings to signed-in users; show the demo
      // catalog as a teaser only when nobody is signed in. This stops
      // logged-in shoppers from clicking into demo cards that 404.
      window.PRODUCTS = window.CURRENT_USER
        ? items
        : [...items, ...window.DEFAULT_PRODUCTS];
      window.__listingsError = false;
    } catch {
      window.PRODUCTS = window.CURRENT_USER ? [] : [...window.DEFAULT_PRODUCTS];
      window.__listingsError = true;
    }
    // r148: the first query has now RESOLVED (success or failure). Only from
    // this point does an empty PRODUCTS array mean a genuinely empty
    // marketplace rather than "still loading" — buildProducts keys off this.
    window.__listingsLoaded = true;
    // r172: first meaningful content (loaded OR error state — both render) —
    // release the splash if auth is already known.
    window.__splashContentReady = true;
    try { window.__maybeDismissSplash && window.__maybeDismissSplash(); } catch (_e) {}
    // r157: announce readiness for waiters (deep-link router). An EVENT
    // instead of polling — chained setTimeout polls get intensively
    // throttled (~1/min) in background tabs, which is exactly where a
    // shared link often opens.
    try { window.dispatchEvent(new Event('teebox-listings-loaded')); } catch (_e) {}
    // Auto-derive a "Hot" badge from viewCount. Don't override badges that
    // were set explicitly (e.g. 'new' for items <72h old). The threshold is
    // top-25% of view counts, gated at >= 5 views so a 1-view listing isn't
    // labelled hot just because it's the only one with views.
    try { deriveHotBadges(window.PRODUCTS); } catch (_e) {}
    deriveTickerFromProducts();
    buildProducts(); buildTrending(); buildTicker(); updateLiveStats();
    // r345: both derive from window.PRODUCTS, so they refresh with the feed.
    try { buildFeaturedSellers(); renderSellerInvite(); } catch (_e) {}
  }

  // r299: this read p.viewCount, a field NOTHING has ever written. Views are
  // recorded by incrementListingView into SHARDED counters (views_0..views_9,
  // sharded to avoid write contention on a hot listing), and getListingViews()
  // sums them — which is why My Shop shows real view counts while this badge
  // silently never appeared. 351 views across 24 active listings existed the
  // whole time; the badge was reading a field that is always undefined.
  // getListingViews lives in the sibling classic <script>, hence window.*.
  function viewsOf(p) {
    return window.getListingViews ? Number(window.getListingViews(p) || 0) : 0;
  }
  function deriveHotBadges(products) {
    if (!Array.isArray(products) || !products.length) return;
    const counts = products
      .map(viewsOf)
      .filter(n => n > 0)
      .sort((a, b) => b - a);
    if (!counts.length) return;
    const cutoff = Math.max(5, counts[Math.floor(counts.length * 0.25)] || 0);
    products.forEach(p => {
      // Don't downgrade an existing 'new' badge — newness is more time-sensitive.
      if (p.badge === 'new') return;
      const v = viewsOf(p);
      if (v >= cutoff && v >= 5) p.badge = 'hot';
    });
  }

  // #3: reveal the inline email-verify prompt inside the sell modal (keeps the
  // seller in the publish flow). One-tap Resend + "I've verified" recheck.
  // Hoisted declaration so submitListing's bare calls resolve under strict mode.
  function showSellVerifyPrompt() {
    try {
      const vp = document.getElementById('sellVerifyPrompt');
      const addr = document.getElementById('sellVerifyAddr');
      if (addr && window.CURRENT_USER) addr.textContent = window.CURRENT_USER.email || 'your inbox';
      if (vp) { vp.style.display = ''; try { vp.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_e) {} }
    } catch (_e) {}
  }
  window.showSellVerifyPrompt = showSellVerifyPrompt;

  window.submitListing = async function() {
    if (!window.CURRENT_USER) { showToast('Sign in to publish a listing.'); return; }
    // NO IS_VERIFIED_SELLER gate here — that check was a leftover from the
    // pre-merged flow and returned BEFORE the inline Seller-Terms step below
    // (which exists precisely to verify first-time sellers at publish),
    // making it unreachable and dead-ending every new seller with
    // "Please verify as a seller first." (2026-08-05 incident, third wall).
    // EDIT MODE: when __editingListingId is set the modal is reused as
    // an edit form. Route to the update path (updateListing callable)
    // and skip the Stripe KYC gate entirely — a seller with a live
    // listing is already past that gate, and editing must never be
    // blocked on a payout-setup re-check (matches the documented
    // "Edit path is not gated" decision below).
    if (window.__editingListingId) { return saveListingEdit(); }
    // r170: a display name is required to PUBLISH a new listing (edits above
    // are not gated, same principle as the Stripe gate). The sell form keeps
    // its state while the modal is up, so the replay just re-submits.
    if (window.requireDisplayName && !window.requireDisplayName('to publish a listing', () => window.submitListing())) return;
    // ─────────────────────────────────────────────────────────────
    // LIST-FIRST (2026-06): publishing NO LONGER requires Stripe Connect to be
    // complete. The listing goes live immediately and renders as "finalizing
    // setup" / not-buyable to buyers until charges_enabled — the real money
    // gate lives at checkout (createPaymentIntent 409s + rolls back if the
    // seller isn't charges-ready, before any PaymentIntent). We surface the
    // REMAINING create preconditions below with clear, actionable messages so a
    // Submit tap never fails silently (the bug that hit our first beta seller).
    // `stripeChargesEnabled` is read AFTER publish only, to decide the seller
    // "finish setup to get paid" nudge.
    //
    // Email verification no longer gates listing creation (founder ruling
    // 2026-09-13) — the rules gate on stripeChargesEnabled (Stripe KYC),
    // which the sell-entry Stripe-required dialog already enforces before
    // this point. No email pre-check here.
    const title = document.getElementById('sellTitle').value.trim();
    const brand = document.getElementById('sellBrand').value.trim();
    const cat = document.getElementById('sellCat').value;
    const price = parseFloat(document.getElementById('sellPrice').value);
    const condition = document.getElementById('sellCondition').value;
    const desc = document.getElementById('sellDesc').value.trim();
    let quantity = parseInt(document.getElementById('sellQuantity').value, 10) || 1;
    if (quantity < 1) quantity = 1;
    if (quantity > 99) quantity = 99;
    // r160: inline field-level errors replace the vanishing generic toast.
    const __sellErrs = collectSellErrors({ title, brand, cat, price, condition, files: selectedFiles, checkDesc: desc });
    if (__sellErrs.length) { applySellErrors(__sellErrs); return; }
    clearSellErrors();
    // High-value verification-photo rule (anti-fraud) is enforced inline by
    // collectSellErrors above; isHighValue still drives the flow below.
    const isHighValue = price >= 300;
    // #2: first-time sellers accept the Seller Terms INLINE here (the merged
    // step — no separate verify screen). Acceptance is recorded + they become a
    // verified seller via requestSellerVerification (persists termsAgreed +
    // termsAgreedAt) BEFORE the listing is created. email-verify was already
    // gated above, so the callable's email precondition won't trip here.
    // LIST-FIRST (r348): the create RULE gates on a verified email (or phone
    // sign-in), not Stripe. Check it HERE with a fresh reload + token-claim
    // refresh, so a seller who verified mid-session never eats a
    // permission-denied (the 2026-08-05 stale-claim incident), and an
    // unverified one gets the Resend prompt instead of a dead Submit.
    try {
      const _u = window.CURRENT_USER;
      const _phone = !!(_u.providerData || []).some(pd => pd && pd.providerId === 'phone');
      if (!_phone && !_u.emailVerified) { try { await _u.reload(); } catch (_e) {} }
      if (!_phone && !_u.emailVerified) { showSellVerifyPrompt(); return; }
      await window.__ensureVerifiedClaimFresh();
    } catch (_e) { /* rules remain the real gate */ }
    if (!window.IS_VERIFIED_SELLER) {
      const _tcb = document.getElementById('sellTermsCheckbox');
      if (!_tcb || !_tcb.checked) {
        showToast('Please agree to the Seller Terms to publish.', 'error');
        return;
      }
      try {
        const _verify = httpsCallable(fns, 'requestSellerVerification');
        await _verify({ termsAgreed: true });
        window.IS_VERIFIED_SELLER = true;
      } catch (e) {
        const _m = (e && e.message) || '';
        if (/verify your email/i.test(_m)) { showSellVerifyPrompt(); return; }
        showToast('Could not record your seller agreement. Please try again.', 'error');
        return;
      }
    }
    // Double-submit guard: a fast double event (touch+click, or a re-
    // dispatched delegated click) fired submitListing() twice ~77ms apart and
    // created two identical listings (Brian's L.A.B putter, 2026-09-13). The
    // btn.disabled below does NOT stop an already-dispatched delegated click,
    // so gate re-entry with an in-flight flag cleared in the finally. Set
    // here (after all validation) so a validation-fail early-return can't
    // wedge it. Everything from here to the first await (addDoc) is
    // synchronous, so a second handler always observes the flag and bails.
    if (window.__submitListingBusy) return;
    window.__submitListingBusy = true;
    const btn = document.getElementById('submitListingBtn');
    btn.disabled = true; btn.textContent = selectedFiles.length > 0 ? 'Uploading photos…' : 'Submitting…';
    // Track the just-created listing doc so we can roll it back if the
    // photo-upload step fails. Without this, a 403/network error mid-upload
    // leaves an orphaned listing doc with photos: [] in Firestore.
    let docRef = null;
    try {
      // Listings auto-expire 60 days after creation; sellers can renew
      // from the My Shop dashboard.
      const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
      docRef = await addDoc(collection(db, 'listings'), {
        title, brand, cat, ask: price,
        condition, desc, badge: 'new',
        // Listing v2: structured spec fields (not a blob) — render as a
        // spec table on the detail page; feed search/filters later.
        specCategory: window.getSpecCategory ? (window.getSpecCategory() || 'other') : 'other',
        specs: window.collectSpecs ? window.collectSpecs() : {},
        photos: [], sellerId: window.CURRENT_USER.uid,
        status: 'active', createdAt: serverTimestamp(),
        expiresAt,
        // Quantity in stock. Most listings are 1 (used unique gear);
        // sellers with bulk inventory (gloves, balls, hats) can list
        // up to 99. quantitySold is server-managed by createPaymentIntent.
        quantity,
        quantitySold: 0,
        // High-value listings (>= $300) get a flag so admin can manually
        // review the verification photo. requiresAuth=true tells the
        // marketplace UI to show a "Verification photo included" badge.
        requiresAuth: isHighValue,
        authReviewState: isHighValue ? 'pending' : 'na',
      });
      const photoUrls = await uploadPhotos(docRef.id);
      if (photoUrls.length > 0) {
        const { updateDoc } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
        await updateDoc(docRef, { photos: photoUrls });
      }
      selectedFiles = [];
      renderPreviews();
      // Clear the autosaved draft + reset form fields.
      if (typeof clearSellDraft === 'function') clearSellDraft();
      ['sellTitle','sellBrand','sellPrice','sellDesc','sellQuantity'].forEach(i => {
        const el = document.getElementById(i); if (el) el.value = '';
      });
      // Analytics: priority event #2 — `listing_created` with state:
      // 'published'. Distinct from the draft autosave fire so the
      // funnel can be measured (draft → publish). NOT mirrored
      // server-side: there's no onListingCreate trigger that runs at
      // this exact moment — `onListingLive` in securityEmailTriggers
      // is close but it's actually the welcome-email trigger, not a
      // generic event hook. If we add reliability concerns later
      // (e.g. user closes tab between addDoc and the capture call),
      // mirror inside `onListingLive` server-side.
      // r278 item 5: ListingCreated — the quality-listings north star and the
      // future optimization event for seller campaigns.
      //
      // r302: the seller external_id is now included. It was held back
      // deliberately while advanced matching was unruled; the founder ruling
      // of 2026-09-28 approved opaque/hashed identifiers for matching, and
      // privacy.html now discloses it. external_id is our own uid — an opaque
      // key, meaningless without our database, and NOT an email, name or
      // phone. It is what lets Meta join this browser event to the matching
      // server event for the same seller.
      try {
        const sellerExtId = (window.CURRENT_USER && window.CURRENT_USER.uid) ?
          String(window.CURRENT_USER.uid) : '';
        const lcParams = {
          content_ids: [String(docRef.id)],
          content_type: 'product',
          content_category: cat,
          value: Math.round(price * 100) / 100,
          currency: 'USD',
        };
        if (sellerExtId) lcParams.external_id = sellerExtId;
        window.fbTrack && window.fbTrack('ListingCreated', lcParams,
          { custom: true, once: 'listing_' + docRef.id,
            eventID: 'lc_' + String(docRef.id) });
      } catch (_e) {}
      try {
        if (window.posthog) {
          window.posthog.capture('listing_created', {
            state: 'published',
            listingId: docRef.id,
            cat,
            brand,
            condition,
            askCents: Math.round(price * 100),
            photoCount: photoUrls.length,
            isHighValue,
            quantity,
          });
          // Clear the draft-emitted guard so the next listing (same
          // tab) emits its draft event again.
          window.__teeboxDraftEmitted = false;
        }
      } catch (_e) { /* analytics never blocks publish */ }
      closeSellModalDirect();
      showToast("You're live — your listing is on the marketplace now.", 'success');
      // Seller "finish setup to get paid" nudge. The listing is visible now, but
      // buyers can't purchase until Stripe Connect charges_enabled. If the seller
      // isn't ready, prompt them to finish onboarding. Best-effort, non-blocking
      // — reads their OWN user doc (owner-readable). The actual money gate is
      // enforced server-side at checkout regardless.
      (async () => {
        try {
          const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
          const us = await getDoc(doc(db, 'users', window.CURRENT_USER.uid));
          const chargesReady = us.exists() && us.data().stripeChargesEnabled === true;
          if (!chargesReady) {
            // r348: pre-create the Connect account NOW (no link, no redirect)
            // so the "Set up payouts" tap only has to mint a link. Silent.
            try {
              const _prep = httpsCallable(fns, 'createStripeOnboardingLink');
              _prep({ prepareOnly: true }).catch(() => {});
            } catch (_e) {}
            setTimeout(() => { try { showStripeRequiredDialog(); } catch (_e) {} }, 1300);
          }
        } catch (_e) { /* non-blocking */ }
      })();
      loadListings();
      // Contextual push prompt: ask once the seller has their first listing
      // up, framed as "get notified when buyers respond". Cooldown logic
      // inside maybePromptForPush handles repeat-suppression.
      setTimeout(() => { try { window.maybePromptForPush && window.maybePromptForPush('first-listing'); } catch (_e) {} }, 1500);
    } catch(e) {
      console.error('[submitListing] failed:', e?.code, e?.message, e);
      const code = e?.code || '';
      // Roll back the just-created listing if it exists AND the failure was
      // *not* the listing-creation step itself. addDoc rejections surface as
      // codes prefixed with 'firestore/' or 'permission-denied' before docRef
      // is assigned — in that case docRef is still null so we skip rollback.
      // Storage 403/permission errors aren't going to recover on retry, so
      // we delete the orphan doc to avoid polluting the marketplace feed.
      // We only skip rollback for 'storage/canceled' / 'storage/retry-limit'
      // style transient blips where a retry could plausibly succeed.
      if (docRef) {
        const isTransientUploadBlip =
          code === 'storage/canceled' || code === 'storage/retry-limit-exceeded';
        if (!isTransientUploadBlip) {
          try {
            await deleteDoc(docRef);
            console.info('[submitListing] rolled back orphan listing', docRef.id);
          } catch (rollbackErr) {
            console.warn('[submitListing] rollback failed', rollbackErr);
          }
        }
      }
      // Content-violation path takes priority: server-side filter rejects
      // the write with HttpsError invalid-argument + details.error =
      // 'content_violation'. Surface the friendly toast (never echo the
      // matched word or category — those are audit detail only).
      if (window.isContentViolationError && window.isContentViolationError(e)) {
        showContentViolationToast();
        btn.disabled = false; btn.textContent = 'Post it';
        return;
      }
      let msg = 'Error submitting. Try again.';
      // permission-denied on listing create almost always means the seller's
      // Stripe Connect KYC isn't complete (the security rule requires
      // chargesEnabled). The pre-publish gate above SHOULD have caught this,
      // but if a race or stale-cache slips through we route the user to the
      // proper payout-setup modal instead of the misleading "sign out, sign
      // back in" copy. unauthenticated is a separate case (token expired)
      // and gets the generic retry copy.
      if (code.includes('permission-denied')) {
        // Post list-first the create rule no longer gates on charges, so a
        // denial here is a remaining precondition — almost always email-not-
        // verified (App Check is the rare other case). Surface the specific
        // reason + Resend; never the old "set up payouts" misdirection and
        // never a dead Submit. emailVerified may be stale → reload first.
        // r348: the per-seller daily cap (10 new listings / rolling 24h,
        // firestore.rules underListingRateLimit) is the other denial. The
        // counter is owner-readable, so say exactly when they can post again.
        let capHit = false;
        try {
          const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
          const rl = await getDoc(doc(db, 'users', window.CURRENT_USER.uid, 'rateLimits', 'listingCreate'));
          const r = rl.exists() ? rl.data() : null;
          const resetMs = r && r.resetAt && r.resetAt.toMillis ? r.resetAt.toMillis() : 0;
          capHit = !!(r && Number(r.count) >= 10 && resetMs > Date.now());
          if (capHit) {
            msg = 'You’ve posted 10 listings in the last 24 hours — you can post again after ' +
              new Date(resetMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
          }
        } catch (_e) { /* fall through to the email check */ }
        let emailOk = true;
        if (!capHit) { try { await window.CURRENT_USER.reload(); emailOk = !!window.CURRENT_USER.emailVerified; } catch (_e) {} }
        if (capHit) {
          // message already set
        } else if (!emailOk) {
          try { window.maybeShowVerifyBanner && window.maybeShowVerifyBanner(window.CURRENT_USER); } catch (_e) {}
          msg = 'Verify your email to publish — tap Resend on the banner above.';
        } else {
          // Account IS verified — the denial may be a stale token claim
          // (rules read the token, which lags a mid-session verify).
          // Refresh it so the retry we're about to suggest can succeed.
          await window.__ensureVerifiedClaimFresh();
          msg = "Couldn't publish — make sure all fields are valid and try again. If it persists, refresh the page.";
        }
      } else if (code.includes('unauthenticated')) {
        msg = 'Session expired. Please try again.';
      } else if (code.includes('storage/')) {
        msg = 'Photo upload failed. Try a smaller image or fewer photos.';
      } else if (code.includes('app-check')) {
        msg = 'App verification failed. Refresh the page and try again.';
      } else if (e?.message) {
        msg = 'Error: ' + e.message.slice(0, 120);
      }
      showToast(msg);
    } finally {
      // Always release the in-flight guard + re-enable the button, on
      // success, error, or the content-violation early-return above.
      window.__submitListingBusy = false;
      btn.disabled = false; btn.textContent = 'Post it';
    }
  };

  // ─────────────────────────────────────────────────────────────
  // EDIT LISTING — reuses the sell modal in "edit mode". A mode flag
  // (window.__editingListingId) routes submitListing() to the
  // updateListing callable instead of the addDoc create path.
  // NOT editable here: sellerId, createdAt, listing id, sale status —
  // none are surfaced as form controls and the callable rejects them
  // server-side regardless.
  // ─────────────────────────────────────────────────────────────
  window.__editingListingId = null;
  // Snapshot of the form state at edit-open time, used to detect
  // unsaved changes for the discard-confirm on close.
  window.__editSnapshot = null;

  function snapshotSellForm() {
    return JSON.stringify({
      title: (document.getElementById('sellTitle')||{}).value || '',
      brand: (document.getElementById('sellBrand')||{}).value || '',
      cat: (document.getElementById('sellCat')||{}).value || '',
      price: (document.getElementById('sellPrice')||{}).value || '',
      condition: (document.getElementById('sellCondition')||{}).value || '',
      quantity: (document.getElementById('sellQuantity')||{}).value || '',
      desc: (document.getElementById('sellDesc')||{}).value || '',
      photos: selectedFiles.map(f => f && f.__existingUrl ? f.__existingUrl : ('file:'+(f && f.name || ''))),
    });
  }
  window.snapshotSellForm = snapshotSellForm;

  // True when the sell modal is in edit mode AND the form differs from
  // the snapshot taken when it opened. closeSellModalDirect() consults
  // this to decide whether to confirm before discarding.
  window.sellEditHasUnsavedChanges = function() {
    if (!window.__editingListingId || window.__editSnapshot == null) return false;
    try { return snapshotSellForm() !== window.__editSnapshot; }
    catch (_e) { return false; }
  };

  // Reset edit-mode state + modal chrome back to the create-listing
  // defaults. Called on close so a subsequent "Sell Now" opens a clean
  // create form.
  window.exitSellEditMode = function() {
    window.__editingListingId = null;
    window.__editSnapshot = null;
    const titleEl = document.querySelector('#sellModalBackdrop .modal-title');
    if (titleEl) titleEl.textContent = 'List an Item for Sale';
    const submitBtn = document.getElementById('submitListingBtn');
    if (submitBtn) { submitBtn.textContent = 'Post it'; submitBtn.disabled = false; }
    const vbar = document.querySelector('#sellModalBackdrop .seller-verified-bar');
    if (vbar) vbar.style.display = '';
    // r176: collapse the quantity row back behind its toggle for the next open.
    try { if (typeof window.__setSellQtyVisible === 'function') window.__setSellQtyVisible(false); } catch (_e) {}
  };

  // r176: quantity lives behind "I have more than one" — most P2P listings
  // are single items. Expanding reveals the input; collapsing resets to 1.
  window.__setSellQtyVisible = function(show) {
    const row = document.getElementById('sellQtyRow');
    const link = document.getElementById('sellQtyToggle');
    if (!row || !link) return;
    row.style.display = show ? '' : 'none';
    link.style.display = show ? 'none' : '';
    if (!show) { const q = document.getElementById('sellQuantity'); if (q) q.value = '1'; }
  };

  // Open the sell modal pre-populated with an existing listing's
  // current values, in edit mode. `id` is the Firestore listing id.
  window.openEditListing = async function(id) {
    if (!window.CURRENT_USER) { showToast('Please sign in.'); return; }
    const listingId = String(id || '');
    if (!listingId) return;
    // Resolve the listing: prefer the in-memory copy (already loaded
    // for the grid/detail), fall back to a fresh Firestore read.
    let p = (window.PRODUCTS || []).find(x => String(x.id) === listingId);
    if (!p) {
      try {
        const snap = await getDoc(doc(db, 'listings', listingId));
        if (snap.exists()) p = { id: snap.id, ...snap.data() };
      } catch (e) { console.warn('openEditListing fetch failed', e); }
    }
    if (!p) { showToast('Could not load that listing.'); return; }
    // Ownership guard (UI-side; the callable enforces it server-side).
    if (!p.sellerId || p.sellerId !== window.CURRENT_USER.uid) {
      showToast('You can only edit your own listings.'); return;
    }
    // Locked-status guard (UI-side; callable is authoritative). Don't
    // even open the editor on a sold/reserved listing.
    const LOCKED = ['sold','pending','pending_payment','paid','shipped','delivered_pending_inspection','complete'];
    if (LOCKED.includes(p.status)) {
      showToast('This listing is locked and cannot be edited.');
      return;
    }

    window.__editingListingId = listingId;

    // If launched from the listing detail modal, close it so the edit
    // form isn't stacked behind it.
    try {
      const db_ = document.getElementById('detailBackdrop');
      if (db_ && db_.classList.contains('open')
          && typeof window.closeDetailModalDirect === 'function') {
        window.closeDetailModalDirect();
      }
    } catch (_e) {}

    // Open the modal first (this resets photo widget chrome), then
    // overwrite with the listing's values.
    openSellModal();

    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = (val == null ? '' : String(val)); };
    set('sellTitle', p.title || p.name || '');
    set('sellBrand', p.brand || '');
    set('sellCat', p.cat || '');
    set('sellPrice', (p.ask != null ? p.ask : ''));
    set('sellCondition', p.condition || 'Like New');
    set('sellQuantity', (p.quantity != null ? p.quantity : 1));
    // r176: quantity row hides behind the "more than one" toggle — auto-expand
    // when editing a listing that already has multi-stock.
    try { if (typeof window.__setSellQtyVisible === 'function') window.__setSellQtyVisible(Number(p.quantity || 1) > 1); } catch (_e) {}
    set('sellDesc', p.desc || '');
    // Listing v2: restore the spec category + fields (legacy listings
    // without specCategory reset to the picker — the "complete your
    // specs" path).
    if (window.hydrateSpecState) window.hydrateSpecState(p);

    // Load existing photos as ordered, non-uploaded markers so the
    // photo widget shows them and uploadPhotos() preserves them in
    // place. Newly added Files interleave by position.
    selectedFiles = (Array.isArray(p.photos) ? p.photos : [])
      .filter(u => typeof u === 'string' && u.length > 0)
      .slice(0, 10)
      .map(u => ({ __existingUrl: u }));
    renderPreviews();

    // Edit-mode chrome.
    const titleEl = document.querySelector('#sellModalBackdrop .modal-title');
    if (titleEl) titleEl.textContent = 'Edit your listing';
    const submitBtn = document.getElementById('submitListingBtn');
    if (submitBtn) submitBtn.textContent = 'Save changes';
    // The "Verified Seller — listings go live instantly" bar is a
    // create-flow affordance; hide it in edit mode.
    const vbar = document.querySelector('#sellModalBackdrop .seller-verified-bar');
    if (vbar) vbar.style.display = 'none';
    // Reflect $300 verification-photo notice for the loaded price.
    const priceEl = document.getElementById('sellPrice');
    if (priceEl) priceEl.dispatchEvent(new Event('input', { bubbles: true }));

    // Snapshot AFTER population so "unsaved changes" only trips on
    // edits the seller actually makes.
    window.__editSnapshot = snapshotSellForm();
  };

  // Persist an edit via the updateListing callable. Mirrors the
  // create-path validation + photo-upload-abort semantics: if any new
  // photo fails to upload we DO NOT call the callable, so the listing
  // is left unchanged.
  async function saveListingEdit() {
    const listingId = window.__editingListingId;
    if (!listingId) return;
    const title = (document.getElementById('sellTitle').value || '').trim();
    const brand = (document.getElementById('sellBrand').value || '').trim();
    const cat = document.getElementById('sellCat').value;
    const price = parseFloat(document.getElementById('sellPrice').value);
    const condition = document.getElementById('sellCondition').value;
    const desc = (document.getElementById('sellDesc').value || '').trim();
    let quantity = parseInt(document.getElementById('sellQuantity').value, 10) || 1;
    if (quantity < 1) quantity = 1;
    if (quantity > 99) quantity = 99;
    // r160: inline field-level errors replace the vanishing toasts (edit path).
    const __editErrs = collectSellErrors({ title, brand, cat, price, condition, files: selectedFiles, checkDesc: desc });
    if (__editErrs.length) { applySellErrors(__editErrs); return; }
    clearSellErrors();
    const btn = document.getElementById('submitListingBtn');
    const hasNewFiles = selectedFiles.some(f => !(f && f.__existingUrl));
    btn.disabled = true; btn.textContent = hasNewFiles ? 'Uploading photos…' : 'Saving…';
    let photoUrls;
    try {
      // Upload any newly added Files; existing-photo markers pass
      // through in place. If ANY upload throws we abort BEFORE the
      // callable — the listing stays exactly as it was (edge case E).
      photoUrls = await uploadPhotos(listingId);
    } catch (e) {
      console.error('[saveListingEdit] photo upload failed:', e?.code, e?.message, e);
      showToast('Photo upload failed — your listing was not changed. Try again.', 'error');
      btn.disabled = false; btn.textContent = 'Save changes';
      return;
    }
    if (!Array.isArray(photoUrls) || photoUrls.length < 1) {
      showToast('A listing needs at least one photo.', 'error');
      btn.disabled = false; btn.textContent = 'Save changes';
      return;
    }
    btn.textContent = 'Saving…';
    try {
      const fn = httpsCallable(fns, 'updateListing');
      await fn({
        listingId,
        title, brand, cat, ask: price, condition, desc,
        quantity, photos: photoUrls,
        specCategory: window.getSpecCategory ? (window.getSpecCategory() || 'other') : 'other',
        specs: window.collectSpecs ? window.collectSpecs() : {},
      });
      // Success — clear edit state, refresh the grid + any open
      // dashboard/detail so the new values show.
      window.__editSnapshot = snapshotSellForm(); // mark not-dirty
      window.exitSellEditMode();
      selectedFiles = [];
      renderPreviews();
      closeSellModalDirect();
      showToast('Listing updated.', 'success');
      try { await loadListings(); } catch (_e) {}
      // Refresh the My Shop dashboard only if it's actually open
      // (the common entry point for editing) — otherwise it's a
      // wasted read into hidden DOM.
      try {
        const dash = document.getElementById('shopDashboard');
        if (dash && dash.classList.contains('open')
            && typeof window.loadShopData === 'function') {
          await window.loadShopData();
        }
      } catch (_e) {}
    } catch (e) {
      console.error('[saveListingEdit] failed:', e?.code, e?.message, e);
      // Locked-status: server returns failed-precondition with
      // details.error='listing_locked' + status + reason.
      const det = (e && e.details) || {};
      if (det.error === 'listing_locked') {
        const reason = det.reason || 'it is no longer editable';
        showToast(`This listing is locked because ${reason}. Contact support if you need to make a change.`, 'error');
        btn.disabled = false; btn.textContent = 'Save changes';
        return;
      }
      if (window.isContentViolationError && window.isContentViolationError(e)) {
        showContentViolationToast();
        btn.disabled = false; btn.textContent = 'Save changes';
        return;
      }
      const code = e?.code || '';
      let msg = 'Could not save your changes. Try again.';
      if (code.includes('permission-denied')) msg = 'You can only edit your own listings.';
      else if (code.includes('unauthenticated')) msg = 'Session expired. Please sign in again.';
      else if (code.includes('not-found')) msg = 'That listing no longer exists.';
      else if (e?.message && !code.includes('internal')) msg = 'Error: ' + String(e.message).slice(0, 120);
      showToast(msg, 'error');
    }
    btn.disabled = false; btn.textContent = 'Save changes';
  }
  window.saveListingEdit = saveListingEdit;
