/* r421 — guest checkout (web only) + in-app-browser handling.
 *
 * Classic script, loaded with defer after index.html's inline checkout code,
 * so it shares those top-level bindings (stripeInstance, stripeElements,
 * paymentElement, addressElement, checkoutProduct, ensureStripeLoaded,
 * CLOUD_FUNCTION_URL, setCheckoutError, friendlyStripeError, ...).
 *
 * GUEST CHECKOUT: a signed-out buyer on the website taps Buy Now and the
 * checkout sheet opens straight away: email, address, card/wallets, 18+.
 * Nothing is reserved while the sheet is open; the server creates the
 * PaymentIntent (and holds the listing) only when Pay is tapped — Stripe's
 * deferred-intent Payment Element. Never on the iOS app (body.is-native) —
 * the app keeps today's signed-in flow. Kill switch: GUEST_CHECKOUT_ON.
 *
 * IN-APP BROWSERS (Facebook / Instagram / Messenger / TikTok): Google blocks
 * its sign-in inside embedded browsers, so the Google button is hidden there,
 * and the sign-up sheet offers "Open in Safari/browser" with the exact
 * listing link + UTMs.
 */
(function () {
  'use strict';
  const GUEST_CHECKOUT_ON = true;

  // ── In-app browser detection ──────────────────────────────────────────
  // Real UA markers: Facebook "FBAN/FBIOS" (iOS) or "FBAV"/"FB_IAB" (Android),
  // Messenger "FBAN/MessengerForiOS" / "Orca-Android", Instagram "Instagram
  // 3xx", TikTok "musical_ly" / "BytedanceWebview" / "TikTok".
  function iabName(ua) {
    const u = String(ua || '');
    if (/MessengerForiOS|Orca-Android|\bMessenger\b/i.test(u)) return 'Messenger';
    if (/Instagram/i.test(u)) return 'Instagram';
    if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i.test(u)) return 'Facebook';
    if (/musical_ly|BytedanceWebview|TikTok|trill_/i.test(u)) return 'TikTok';
    return null;
  }
  const isIOS = (ua) => /iPhone|iPad|iPod/i.test(String(ua || ''));
  window.tbIabName = iabName;
  window.tbInAppBrowser = () => iabName(navigator.userAgent);

  // Keep the landing UTMs for the "open in browser" link.
  const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'ttclid'];
  try {
    const sp = new URLSearchParams(location.search);
    const got = {};
    UTM_KEYS.forEach((k) => { const v = sp.get(k); if (v) got[k] = v.slice(0, 200); });
    if (Object.keys(got).length) sessionStorage.setItem('tb_landing_utm', JSON.stringify(got));
  } catch (_e) {}

  function currentDeepLink() {
    const u = new URL('https://teeboxmarket.com/');
    let id = null;
    try { if (typeof currentDetailId !== 'undefined' && currentDetailId) id = String(currentDetailId); } catch (_e) {}
    if (!id && window.checkoutProduct && window.checkoutProduct.id) id = String(window.checkoutProduct.id);
    if (!id) { try { id = new URLSearchParams(location.search).get('listing'); } catch (_e) {} }
    if (id) u.searchParams.set('listing', id);
    let utm = {};
    try { utm = JSON.parse(sessionStorage.getItem('tb_landing_utm') || '{}') || {}; } catch (_e) {}
    try { new URLSearchParams(location.search).forEach((v, k) => { if (UTM_KEYS.includes(k)) utm[k] = v; }); } catch (_e) {}
    Object.keys(utm).forEach((k) => u.searchParams.set(k, utm[k]));
    return u.toString();
  }
  window.tbCurrentDeepLink = currentDeepLink;

  // iOS: the x-safari- scheme hands the URL to Safari (iOS 17+). Android: an
  // intent:// URL opens the default browser. Either way we also copy the link
  // so the "••• → Open in browser" fallback is one paste away.
  function openInBrowser(url) {
    const target = url || currentDeepLink();
    try { navigator.clipboard && navigator.clipboard.writeText(target).catch(() => {}); } catch (_e) {}
    const ua = navigator.userAgent;
    if (isIOS(ua)) {
      location.href = 'x-safari-' + target;
    } else {
      const noScheme = target.replace(/^https?:\/\//, '');
      location.href = 'intent://' + noScheme + '#Intent;scheme=https;S.browser_fallback_url=' + encodeURIComponent(target) + ';end';
    }
    setTimeout(() => {
      const hint = document.getElementById('authSheetIabHint');
      if (hint) hint.hidden = false;
      const ghint = document.getElementById('guestIabHint2');
      if (ghint) ghint.hidden = false;
    }, 1200);
  }
  window.tbOpenInBrowser = openInBrowser;

  function applyIabToAuthSheet() {
    const name = window.tbInAppBrowser();
    const box = document.getElementById('authSheetIab');
    const google = document.getElementById('authSheetGoogle');
    if (!name) { if (box) box.hidden = true; return; }
    if (google) google.hidden = true; // Google refuses sign-in in embedded browsers
    if (box) {
      box.hidden = false;
      const lbl = document.getElementById('authSheetIabBtnLabel');
      if (lbl) lbl.textContent = isIOS(navigator.userAgent) ? 'Open in Safari' : 'Open in browser';
      const msg = document.getElementById('authSheetIabMsg');
      if (msg) msg.textContent = `You're in the ${name} browser. For Apple Pay and the fastest checkout, open this listing in ${isIOS(navigator.userAgent) ? 'Safari' : 'your browser'}.`;
    }
  }
  // Wrap openAuthSheet once app-main has defined it (defer order: app-main first).
  function wrapAuthSheet() {
    const orig = window.openAuthSheet;
    if (typeof orig !== 'function' || orig.__iabWrapped) return false;
    const wrapped = function (mode, reason) {
      const r = orig.apply(this, arguments);
      try { applyIabToAuthSheet(); } catch (_e) {}
      // flags reload inside the original re-applies Google visibility; re-hide after it.
      setTimeout(() => { try { applyIabToAuthSheet(); } catch (_e) {} }, 600);
      return r;
    };
    wrapped.__iabWrapped = true;
    window.openAuthSheet = wrapped;
    return true;
  }
  if (!wrapAuthSheet()) document.addEventListener('DOMContentLoaded', wrapAuthSheet);

  // ── Guest checkout ────────────────────────────────────────────────────
  const isNative = () => document.body.classList.contains('is-native') ||
    !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  window.tbGuestCheckoutEligible = () => GUEST_CHECKOUT_ON && !window.CURRENT_USER && !isNative();

  let G = null; // per-open guest state

  const $ = (id) => document.getElementById(id);
  const fmtC = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function postCPI(body) {
    const res = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ guest: true }, body)),
    });
    let data = {};
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok || data.error) {
      const e = new Error(data.error || `Payment server error (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  function addrPayload(v) {
    if (!v) return null;
    return { name: v.name || '', address: v.address || null };
  }

  function renderGuestTotals() {
    if (!G) return;
    const q = G.quote || {};
    const shipEl = $('checkoutShipPrice');
    if (shipEl) shipEl.textContent = q.shippingPending ? (G.addrComplete ? 'Calculating…' : 'Enter address') : fmtC(q.shippingCents || 0);
    const totalEl = $('checkoutTotal');
    if (totalEl && Number.isFinite(q.itemCents)) totalEl.textContent = fmtC(q.itemCents + (q.shippingPending ? 0 : (q.shippingCents || 0)));
    updatePayButton();
  }

  function updatePayButton() {
    const btn = $('payBtn');
    if (!btn || !G) return;
    btn.dataset.action = 'guest-pay';
    const q = G.quote || {};
    const age = $('checkoutAge18Checkbox');
    if (G.busy) { btn.disabled = true; return; }
    if (!G.mounted) { btn.disabled = true; btn.textContent = 'Loading…'; return; }
    if (!G.emailOk) { btn.disabled = true; btn.textContent = 'Enter your email'; return; }
    if (!G.addrComplete) { btn.disabled = true; btn.textContent = 'Enter shipping address'; return; }
    if (q.shippingPending || G.quoting) { btn.disabled = true; btn.textContent = 'Getting shipping rate…'; return; }
    if (!(age && age.checked)) { btn.disabled = true; btn.textContent = 'Confirm you’re 18+'; return; }
    btn.disabled = false;
    btn.textContent = 'Pay ' + fmtC(q.itemCents + (q.shippingCents || 0));
  }

  async function requote(addr) {
    if (!G) return;
    const mine = G; const seq = ++G.quoteSeq;
    G.quoting = true; renderGuestTotals();
    try {
      const d = await postCPI({ quoteOnly: true, listingId: String(G.product.id), quantity: Number(G.product.__qty || 1),
        shippingAware: true, shipTo: addr || undefined, email: G.email || undefined });
      if (G !== mine || seq !== G.quoteSeq) return;
      G.quote = d;
      if (!d.shippingPending && G.elements) {
        try { G.elements.update({ amount: d.amountCents }); } catch (_e) {}
      }
      setCheckoutError('');
    } catch (e) {
      if (G !== mine || seq !== G.quoteSeq) return;
      setCheckoutError(e.message || 'Could not price this order. Please try again.');
    } finally {
      if (G === mine && seq === G.quoteSeq) { G.quoting = false; renderGuestTotals(); }
    }
  }

  // Called by openCheckout (index.html) in place of mountPaymentElement.
  window.mountGuestCheckout = async function mountGuestCheckout(product) {
    const mine = G = { product, quote: null, quoteSeq: 0, emailOk: false, email: '', addrComplete: false, mounted: false };
    document.body.classList.add('guest-checkout');
    const rows = $('guestCoRows'); if (rows) rows.hidden = false;
    const ageRow = $('checkoutAgeRow'); if (ageRow) ageRow.style.display = '';
    const ageCb = $('checkoutAge18Checkbox'); if (ageCb) ageCb.checked = false;
    const iab = window.tbInAppBrowser();
    const ih = $('guestIabHint'); if (ih) ih.hidden = !iab;
    const ihl = $('guestIabBtnLabel'); if (ihl) ihl.textContent = isIOS(navigator.userAgent) ? 'Open in Safari' : 'Open in browser';
    const sr = $('checkoutShipRow'); if (sr) sr.style.display = '';
    const ce = $('card-errors'); if (ce) ce.style.display = '';
    updatePayButton();

    await ensureStripeLoaded();
    if (G !== mine) return null;
    if (!stripeInstance) throw new Error('Stripe failed to load.');
    // Price check first (no hold): flat shipping is known now; clubs/bags
    // wait for the address.
    const q = await postCPI({ quoteOnly: true, listingId: String(product.id), quantity: Number(product.__qty || 1), shippingAware: true });
    if (G !== mine) return null;
    G.quote = q;

    const appearance = {
      theme: 'stripe',
      variables: { colorPrimary: '#15803d', colorBackground: '#ffffff', colorText: '#1c1c18', colorDanger: '#c0392b',
        fontFamily: 'DM Sans, system-ui, sans-serif', borderRadius: '10px' },
    };
    // Deferred intent: no PaymentIntent exists until Pay. card+link match the
    // server's guest PI types; Apple Pay / Google Pay ride on card.
    G.elements = stripeInstance.elements({
      mode: 'payment', currency: 'usd',
      amount: Math.max(50, q.amountCents || q.itemCents || 50),
      paymentMethodTypes: ['card', 'link'],
      appearance,
    });
    stripeElements = G.elements;
    const emailEl = G.elements.create('linkAuthentication', {});
    emailEl.mount('#guest-email-element');
    emailEl.on('change', (ev) => {
      if (G !== mine) return;
      G.email = (ev.value && ev.value.email) || '';
      G.emailOk = !!ev.complete;
      updatePayButton();
    });
    G.emailEl = emailEl;

    addressElement = G.elements.create('address', { mode: 'shipping', allowedCountries: ['US'] });
    addressElement.mount('#address-element');
    addressElement.on('change', (ev) => {
      if (G !== mine) return;
      G.addrComplete = !!ev.complete;
      G.addr = ev.complete ? addrPayload(ev.value) : null;
      if (G.quote && G.quote.shippingMethod !== 'flat' && G.addrComplete) {
        clearTimeout(G.qT); G.qT = setTimeout(() => requote(G.addr), 350);
      } else if (G.quote && G.quote.shippingMethod !== 'flat' && !G.addrComplete) {
        G.quote = Object.assign({}, G.quote, { shippingPending: true });
      }
      renderGuestTotals();
    });

    paymentElement = G.elements.create('payment', {
      layout: { type: 'tabs', defaultCollapsed: false },
      wallets: { applePay: 'auto', googlePay: 'auto' },
    });
    paymentElement.mount('#payment-element');
    paymentElement.on('change', (ev) => setCheckoutError(ev.error ? ev.error.message : ''));
    G.mounted = true;
    renderGuestTotals();
    return { amountCents: q.amountCents, itemCents: q.itemCents, shippingCents: q.shippingCents, shippingPending: q.shippingPending, guest: true };
  };

  async function guestPay() {
    if (!G || G.busy) return;
    const mine = G;
    const btn = $('payBtn');
    const label = btn ? btn.textContent : 'Pay';
    G.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Processing payment…'; }
    setCheckoutError('');
    const fail = (msg) => {
      if (G !== mine) return;
      setCheckoutError(msg);
      G.busy = false;
      if (btn) btn.textContent = label;
      updatePayButton();
    };
    try {
      const sub = await G.elements.submit();
      if (sub && sub.error) return fail(friendlyStripeError(sub.error));
      const av = await addressElement.getValue();
      if (!av || !av.complete) return fail('Please enter a complete shipping address.');
      const shipTo = addrPayload(av.value);
      // The PaymentIntent — and the listing hold — start here, not at sheet open.
      const d = await postCPI({
        listingId: String(G.product.id), quantity: Number(G.product.__qty || 1), shippingAware: true,
        email: G.email, age18: true, shipTo,
        ...(window.metaMatchIds ? window.metaMatchIds() : {}),
        ...((window.tbMetaOptedOut && window.tbMetaOptedOut()) ? { metaOptOut: true } : {}),
      });
      if (G !== mine) return;
      const expected = (G.quote && Number.isFinite(G.quote.itemCents)) ? G.quote.itemCents + (G.quote.shippingCents || 0) : null;
      if (expected != null && d.amountCents !== expected) {
        // Price moved between quote and Pay (e.g. carrier rate). Show it; buyer taps again.
        G.quote = Object.assign({}, G.quote, { itemCents: d.itemCents, shippingCents: d.shippingCents, shippingPending: false, amountCents: d.amountCents });
        try { G.elements.update({ amount: d.amountCents }); } catch (_e) {}
        renderGuestTotals();
        return fail('The total changed to ' + fmtC(d.amountCents) + '. Tap Pay to confirm.');
      }
      const piId = String(d.clientSecret).split('_secret_')[0];
      try {
        const meta = { listingId: String(G.product.id), itemCents: d.itemCents, qty: Number(G.product.__qty || 1) };
        window.__tbCheckoutMeta = Object.assign({ piId }, meta);
        sessionStorage.setItem('tb_co_' + piId, JSON.stringify(meta));
        sessionStorage.setItem('tb_guest_email', G.email);
      } catch (_e) {}
      const { error, paymentIntent } = await stripeInstance.confirmPayment({
        elements: G.elements, clientSecret: d.clientSecret, redirect: 'if_required',
        confirmParams: { return_url: 'https://teeboxmarket.com/?checkout=complete', shipping: shipTo && shipTo.address ? shipTo : undefined },
      });
      if (error) return fail(friendlyStripeError(error));
      if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
        if (paymentIntent.status === 'succeeded') {
          window.fbTrack && window.fbTrack('Purchase', { content_ids: [String(G.product.id)], content_type: 'product', value: (d.itemCents || paymentIntent.amount) / 100, currency: 'USD', order_id: paymentIntent.id, num_items: Number(G.product.__qty || 1) },
            { eventID: 'purchase_' + paymentIntent.id, once: 'purchase_' + paymentIntent.id });
        }
        const product = G.product; const email = G.email; const amt = d.amountCents;
        try {
          const idx = (window.PRODUCTS || []).findIndex((x) => String(x.id) === String(product.id));
          if (idx !== -1 && paymentIntent.status === 'succeeded') {
            const t = window.PRODUCTS[idx];
            const sold = Math.max(0, Number(t.quantitySold || 0)) + Number(product.__qty || 1);
            t.quantitySold = sold; if (sold >= Math.max(1, Number(t.quantity || 1))) t.status = 'sold';
          }
        } catch (_e) {}
        closeCheckoutDirect();
        const dbd = $('detailBackdrop'); if (dbd) dbd.classList.remove('open');
        showGuestSuccess({ product, email, amountCents: amt, processing: paymentIntent.status === 'processing' });
        if (window.loadListings) setTimeout(() => { try { window.loadListings(); } catch (_e) {} }, 1500);
        return;
      }
      fail('Payment was not completed. Please try again.');
    } catch (e) {
      if (e && e.status === 412 && /age-required/.test(e.message)) return fail('Please confirm you’re 18 or older.');
      fail((e && e.message) || 'Could not start payment. Try again.');
    }
  }

  function showGuestSuccess({ product, email, amountCents, processing }) {
    if (window.showOrderOutcomeSheet) {
      window.showOrderOutcomeSheet({ ok: true, product, qty: Number(product.__qty || 1), amountCents });
    }
    const body = $('orderConfirmBody');
    if (!body) { window.showToast && window.showToast('Payment successful. Check your email for your receipt.', 'success'); return; }
    const sub = body.querySelector('.order-confirm-sub');
    if (sub) sub.textContent = processing ? 'Your payment is processing. We’ll email you when it confirms.' : 'Your payment went through and the seller has been notified.';
    const note = body.querySelector('.order-confirm-note');
    if (note) {
      note.textContent = '';
      const a = document.createElement('span');
      a.textContent = 'We sent your receipt to ';
      const b = document.createElement('strong'); b.textContent = email;
      const c = document.createElement('span');
      c.textContent = '. Tap the link in that email to track your order. It saves the order to a free TeeBox account, no password needed.';
      note.append(a, b, c);
    }
    const view = body.querySelector('[data-action="view-my-orders"]');
    if (view) view.remove();
  }

  // Close: tear down guest-only rows; index.html's closeCheckoutDirect does the rest.
  function wrapClose() {
    const orig = window.closeCheckoutDirect;
    if (typeof orig !== 'function' || orig.__guestWrapped) return;
    const w = function () {
      const was = G; G = null;
      document.body.classList.remove('guest-checkout');
      const rows = $('guestCoRows'); if (rows) rows.hidden = true;
      const ih = $('guestIabHint'); if (ih) ih.hidden = true;
      if (was && was.emailEl) { try { was.emailEl.unmount(); } catch (_e) {} }
      if (was) { const ar = $('checkoutAgeRow'); if (ar) ar.style.display = 'none'; }
      return orig.apply(this, arguments);
    };
    w.__guestWrapped = true;
    window.closeCheckoutDirect = w;
    try { closeCheckoutDirect = w; } catch (_e) {} // the inline binding used by in-page callers
  }
  wrapClose();

  document.addEventListener('change', (e) => {
    if (G && e.target && e.target.id === 'checkoutAge18Checkbox') updatePayButton();
  });

  function bind() {
    const A = window.__actions;
    if (!A) return false;
    A['guest-pay'] = () => { guestPay(); };
    A['iab-open-browser'] = () => openInBrowser();
    A['iab-copy-link'] = () => {
      const url = currentDeepLink();
      try { navigator.clipboard.writeText(url); window.showToast && window.showToast('Link copied. Paste it into Safari or Chrome.', 'success'); } catch (_e) {}
    };
    return true;
  }
  if (!bind()) document.addEventListener('DOMContentLoaded', bind);

  // Test hook (no behaviour): lets the local e2e read state.
  window.__guestCheckoutState = () => (G ? { mounted: G.mounted, emailOk: G.emailOk, addrComplete: G.addrComplete, quote: G.quote } : null);
})();
