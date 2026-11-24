/* Shipping transparency (2026-11-23): ZIP estimate on listings, itemized
 * totals, carrier timeline, ship-by date, box pictures, packing guides and
 * no-printer labels. Display only: every price comes from the server.
 * The ship-by rule mirrors functions/lib/shipBy.js (a unit test compares). */
(function () {
  'use strict';
  const w = typeof window === 'undefined' ? {} : window;
  const TZ = 'America/Chicago';
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

  // ── Business days ──────────────────────────────────────────────────
  const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
  const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  function nth(y, m, wd, n) {
    if (n > 0) return y + '-' + pad(m) + '-' + pad(1 + (wd - dow(y + '-' + pad(m) + '-01') + 7) % 7 + (n - 1) * 7);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return y + '-' + pad(m) + '-' + pad(last - (dow(y + '-' + pad(m) + '-' + pad(last)) - wd + 7) % 7);
  }
  function holidays(y) {
    const fixed = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]].map(([m, d]) => { const x = y + '-' + pad(m) + '-' + pad(d); return dow(x) === 0 ? addDays(x, 1) : x; });
    return new Set(fixed.concat([nth(y, 1, 1, 3), nth(y, 2, 1, 3), nth(y, 5, 1, -1), nth(y, 9, 1, 1), nth(y, 10, 1, 2), nth(y, 11, 4, 4)]));
  }
  const isBusinessDay = (d) => dow(d) !== 0 && dow(d) !== 6 && !holidays(Number(d.slice(0, 4))).has(d);
  function addBusinessDays(d, n) { while (n > 0) { d = addDays(d, 1); if (isBusinessDay(d)) n--; } return d; }
  function ctDate(ms) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }
  const shipByDate = (createdMs) => addBusinessDays(ctDate(createdMs), 3);
  const niceDay = (d, long) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: long ? 'long' : undefined, month: long ? 'long' : 'short', day: 'numeric' });
  const msOf = (t) => t && t.toMillis ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : NaN);

  // ── ZIP estimate ───────────────────────────────────────────────────
  const ZIP_KEY = 'tb_ship_zip';
  const savedZip = () => { try { return localStorage.getItem(ZIP_KEY) || ''; } catch (_e) { return ''; } };
  const keepZip = (z) => { try { localStorage.setItem(ZIP_KEY, z); } catch (_e) { /* private mode */ } };
  const LINK = '<a class="ship-how" href="/shipping/">How shipping works</a>';
  const isLive = (p) => ['clubs', 'bags'].includes(String(p && p.cat || '').toLowerCase());
  let seq = 0;
  function estimateText(e) {
    const what = Number(e.protectionCents) > 0 ? 'shipping + protection' : 'shipping';
    return '≈ ' + usd(e.totalCents) + ' ' + what + ' to ' + e.zip + ' · est. delivery ' + niceDay(e.from) + (e.to && e.to !== e.from ? ' to ' + niceDay(e.to) : '');
  }
  async function fetchEstimate(listingId, zip) {
    const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js');
    const r = await httpsCallable(getFunctions(), 'getShippingEstimate')({ listingId: listingId, zip: zip });
    return r.data;
  }
  /** Fill the line under the price on a listing. */
  function mountEstimate(p, el) {
    if (!el) return;
    const my = ++seq;
    const tier = (w.FLAT_SHIPPING_DOLLARS_BY_CAT || {})[String(p.cat || '').toLowerCase()];
    if (Number.isFinite(tier)) { el.innerHTML = '+ $' + tier + ' shipping' + (Number(p.ask) > 100 ? ' + protection' : '') + ' · ' + LINK; return; }
    if (!isLive(p) || typeof p.id !== 'string') { el.innerHTML = 'Shipping calculated at checkout · ' + LINK; return; }
    el.innerHTML = '<div class="ship-est-out" role="status" aria-live="polite"></div>' +
      '<form class="ship-est"><label for="shipEstZip">Shipping estimate</label><input id="shipEstZip" type="text" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="ZIP code" /><button type="submit">Estimate</button></form>' + LINK;
    const form = el.querySelector('form'), input = el.querySelector('input'), out = el.querySelector('.ship-est-out'), btn = el.querySelector('button');
    async function go(zip) {
      btn.disabled = true; out.textContent = 'Getting an estimate…';
      try {
        const e = await fetchEstimate(p.id, zip);
        if (my !== seq) return;
        keepZip(zip);
        out.innerHTML = '<strong>' + esc(estimateText(e)) + '</strong>';
      } catch (err) {
        if (my !== seq) return;
        const m = String(err && err.message || '');
        out.textContent = (!m || /internal/i.test(m)) ? 'No estimate right now. You’ll see the exact price at checkout.' : m;
      } finally { if (my === seq) btn.disabled = false; }
    }
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const z = input.value.trim();
      if (!/^\d{5}$/.test(z)) { out.textContent = 'Enter a 5-digit ZIP code.'; input.focus(); return; }
      go(z);
    });
    const z = savedZip();
    if (/^\d{5}$/.test(z)) { input.value = z; setTimeout(() => { if (my === seq && el.isConnected) go(z); }, 900); }
  }

  // ── Orders ─────────────────────────────────────────────────────────
  function parts(o) {
    const total = has(o.amountCents) ? Number(o.amountCents) : null;
    const item = has(o.itemCents) ? Number(o.itemCents) : null;
    const ship = has(o.shippingCents) ? Number(o.shippingCents) : null;
    const prot = has(o.shippingProtectionCents) ? Number(o.shippingProtectionCents) : 0;
    const carrier = has(o.shippingCarrierCents) ? Number(o.shippingCarrierCents) : (ship === null ? null : ship - prot);
    return { total, item, carrier, prot };
  }
  /** Item / Shipping / Protection / Total. Empty for orders without the split. */
  function totalsHtml(o) {
    const p = parts(o || {});
    if (p.total === null || p.item === null || p.carrier === null) return '';
    const row = (k, v, cls) => '<div class="ship-total' + (cls || '') + '"><span>' + k + '</span><span>' + v + '</span></div>';
    return '<div class="ship-totals">' + row('Item', usd(p.item)) + row('Shipping', p.carrier > 0 ? usd(p.carrier) : 'Included') + (p.prot > 0 ? row('Protection', usd(p.prot)) : '') + row('Total', usd(p.total), ' is-total') + '</div>';
  }
  const LABELS = { PRE_TRANSIT: 'Label created', TRANSIT: 'In transit', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', RETURNED: 'Returned to sender', FAILURE: 'Delivery problem' };
  /** Carrier scans, newest first. */
  function timelineHtml(o) {
    const ev = (o && Array.isArray(o.trackingEvents) ? o.trackingEvents : []).slice().sort((a, b) => b.at - a.at).slice(0, 8);
    if (!ev.length) return '';
    const eta = /^\d{4}-\d{2}-\d{2}$/.test(o.estimatedDelivery || '') && o.fulfillmentStatus !== 'delivered' ? '<div class="ship-eta">Expected ' + niceDay(o.estimatedDelivery, true) + '</div>' : '';
    return eta + '<ol class="ship-timeline">' + ev.map((e, i) => {
      const when = new Date(e.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return '<li' + (i === 0 ? ' class="is-now"' : '') + '><span class="st">' + esc(LABELS[e.status] || 'Update') + '</span><span class="dt">' + esc([e.place, when].filter(Boolean).join(' · ')) + '</span>' + (e.text ? '<span class="tx">' + esc(e.text) + '</span>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  /** Seller's side of a sale: payout, ship-by, pickup, guide. */
  function sellerHtml(o, listing) {
    if (!o || o.refunded) return '';
    const out = [];
    if (has(o.sellerPayoutCents)) {
      const fee = has(o.platformFeeCents) ? Number(o.platformFeeCents) : null, item = has(o.itemCents) ? Number(o.itemCents) : null;
      out.push('<div class="ship-payout">You receive <strong>' + usd(o.sellerPayoutCents) + '</strong>' + (item !== null && fee !== null ? '<span>' + usd(item) + ' sale − ' + usd(fee) + ' fee</span>' : '') + '</div>');
    }
    const waiting = !o.fulfillmentStatus || o.fulfillmentStatus === 'awaiting_seller_shipment';
    const ms = msOf(o.createdAt);
    if (waiting && Number.isFinite(ms)) {
      const d = shipByDate(ms), late = ctDate(Date.now()) > d;
      out.push('<div class="ship-by' + (late ? ' is-late' : '') + '">' + (late ? 'Was due ' : 'Ship by ') + niceDay(d, true) + '</div>');
    }
    if (waiting) {
      const cat = String((listing && listing.cat) || String(o.shippingParcelKey || '').split(':')[0] || '').toLowerCase();
      if (!o.labelUrl && QR_CATS.includes(cat)) out.push('<button type="button" class="ship-btn secondary" data-ship-qr="' + esc(o.id) + '">No printer? Get a QR code</button>');
      if (o.labelQrUrl) out.push('<a class="ship-btn secondary" href="' + esc(o.labelQrUrl) + '" target="_blank" rel="noopener">Show QR code</a>');
      out.push(packingHtml(cat));
      out.push('<div class="ship-links"><a href="https://tools.usps.com/schedule-pickup-steps.htm" target="_blank" rel="noopener">Schedule a free USPS pickup</a> ' + LINK + '</div>');
    }
    const t = timelineHtml(o);
    if (t) out.push(t);
    return '<div class="ship-seller">' + out.join('') + '</div>';
  }

  // ── Packing guides and box pictures ────────────────────────────────
  const QR_CATS = ['apparel', 'accessories', 'headcovers', 'balls', 'shoes'];
  const GUIDES = {
    clubs: ['Cover each head with a headcover, bubble wrap or a sock, and tape it on.', 'Tape the shafts together and pad both ends so nothing slides.', 'Use a box that matches your pick. Fill the gaps, tape every seam, and measure the packed box.'],
    bags: ['Empty every pocket and fold or remove the stand legs and straps.', 'Wrap the bag in plastic and pad the top and base.', 'Use a box no larger than 38 × 14 × 12 in. Tape every seam and measure it.'],
    shoes: ['Put paper inside each shoe and wrap them separately.', 'Keep them in the shoe box if you have it.', 'Put that inside a 14 × 10 × 5 in shipping box and tape it. Don’t ship in the shoe box alone.'],
    apparel: ['Fold it flat with tags inside.', 'Seal it in a plastic bag to keep it dry.', 'Use a poly mailer about 12 × 10 in and press the air out.'],
    headcovers: ['Stuff it with paper so it keeps its shape.', 'Seal it in a plastic bag.', 'Use a small box or mailer up to 12 × 10 × 4 in.'],
    balls: ['Keep them in the sleeve or box, or bag loose balls together.', 'Add paper so they don’t rattle.', 'Use a box up to 12 × 8 × 4 in and 3 lb. Tape the bottom twice.'],
    accessories: ['Wrap anything that can scratch or break.', 'Fill the empty space with paper.', 'Use a box up to 12 × 10 × 4 in and 2 lb.'],
  };
  function packingHtml(cat) {
    const g = GUIDES[cat];
    return g ? '<details class="ship-pack"><summary>How to pack it</summary><ol>' + g.map((s) => '<li>' + s + '</li>').join('') + '</ol></details>' : '';
  }
  // Line drawings to scale with each other: 48 in long, different heights.
  function boxSvg(key) {
    const h = { single: 14, partial: 18, full: 28 }[key];
    const n = { single: 1, partial: 4, full: 8 }[key];
    if (!h) return '';
    let clubs = '';
    for (let i = 0; i < n; i++) { const y = 46 - h + 4 + (i + 0.5) * ((h - 8) / n); clubs += '<path d="M16 ' + y + 'H74" stroke="currentColor" stroke-width="1"/><circle cx="14" cy="' + y + '" r="1.8" fill="currentColor"/>'; }
    return '<svg class="ship-box-art" viewBox="0 0 92 50" width="92" height="50" aria-hidden="true" fill="none"><path d="M6 ' + (46 - h) + 'H80V46H6Z" stroke="currentColor" stroke-width="1.6"/><path d="M6 ' + (46 - h) + 'l6 -6H86l-6 6M86 ' + (40 - h) + 'V40l-6 6" stroke="currentColor" stroke-width="1.6"/>' + clubs + '</svg>';
  }

  async function qrLabel(btn) {
    const orderId = btn.dataset.shipQr;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Getting it…';
    const say = (m) => (w.showToast ? w.showToast(m) : w.alert(m));
    try {
      const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js');
      const d = (await httpsCallable(getFunctions(), 'createShippingLabel')({ orderId: orderId, qr: true })).data || {};
      if (!d.ok) { say(d.message || 'Could not make the label.'); return; }
      const url = d.qrUrl || d.labelUrl;
      say(d.qrUrl ? 'QR code ready. Show it at the USPS counter.' : (d.qrNote || 'Here is your label.'));
      if (url) { const t = w.open(url, '_blank', 'noopener'); if (!t) { btn.outerHTML = '<a class="ship-btn secondary" href="' + esc(url) + '" target="_blank" rel="noopener">' + (d.qrUrl ? 'Show QR code' : 'View Label') + '</a>'; return; } }
      if (typeof w.loadShopData === 'function') w.loadShopData();
    } catch (e) { say('Could not make the label. Please try again.'); } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-ship-qr]'); if (b) { e.preventDefault(); qrLabel(b); } });
  }

  const api = { mountEstimate, estimateText, totalsHtml, timelineHtml, sellerHtml, packingHtml, boxSvg, shipByDate, isBusinessDay, holidays, GUIDES };
  w.TBShip = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
