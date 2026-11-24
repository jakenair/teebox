"use strict";
// The Seller API's platform switch (2026-11-23). "Off" makes Cloud Run refuse
// everything from outside before it reaches our code, so a flood stops costing
// anything (a check inside the function would still be billed per request).
// Nothing else is touched: the app, checkout, feeds and webhooks are other
// services.
const SERVICE = "projects/teebox-market/locations/us-central1/services/sellerapi";
const OFF = "INGRESS_TRAFFIC_INTERNAL_ONLY";
const ON = "INGRESS_TRAFFIC_ALL";

/**
 * @param {boolean} open
 * @param {{token: string, fetchFn: (function|undefined)}} o
 * @return {Promise<string>} the ingress setting asked for
 */
async function setApiOpen(open, {token, fetchFn = fetch, waitMs = 4000, tries = 10}) {
  const ingress = open ? ON : OFF;
  const url = `https://run.googleapis.com/v2/${SERVICE}`;
  const headers = {"Authorization": `Bearer ${token}`, "Content-Type": "application/json"};
  let last = "";
  for (let i = 0; i < tries; i++) {
    // Ask, then check it took: a change made while another is still rolling
    // out can be accepted and lost.
    if (i % 4 === 0) {
      const r = await fetchFn(`${url}?updateMask=ingress,template.revision`, {
        method: "PATCH", headers,
        // The service's template carries the last revision's name; clearing it
        // lets Cloud Run name the (otherwise identical) one this creates.
        body: JSON.stringify({ingress, template: {revision: ""}}),
      });
      if (!r.ok) {
        last = `${r.status}: ${(await r.text()).slice(0, 300)}`;
        if (r.status === 401 || r.status === 403) throw new Error(`Cloud Run said ${last}`);
      }
    }
    await new Promise((res) => setTimeout(res, waitMs));
    const g = await fetchFn(url, {headers});
    if (g.ok) {
      const d = await g.json();
      if (d.ingress === ingress && !d.reconciling) return ingress;
      last = `still ${d.ingress}${d.reconciling ? " (rolling out)" : ""}`;
    } else last = `${g.status}`;
  }
  throw new Error(`Cloud Run: not ${ingress} yet, ${last}`);
}

async function readApiOpen({token, fetchFn = fetch}) {
  const r = await fetchFn(`https://run.googleapis.com/v2/${SERVICE}`, {headers: {"Authorization": `Bearer ${token}`}});
  if (!r.ok) throw new Error(`Cloud Run said ${r.status}`);
  return (await r.json()).ingress === ON;
}

module.exports = {setApiOpen, readApiOpen, SERVICE, ON, OFF};
