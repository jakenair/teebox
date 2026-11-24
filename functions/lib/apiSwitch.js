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
async function setApiOpen(open, {token, fetchFn = fetch}) {
  const ingress = open ? ON : OFF;
  const r = await fetchFn(`https://run.googleapis.com/v2/${SERVICE}?updateMask=ingress`, {
    method: "PATCH",
    headers: {"Authorization": `Bearer ${token}`, "Content-Type": "application/json"},
    body: JSON.stringify({ingress}),
  });
  if (!r.ok) throw new Error(`Cloud Run said ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return ingress;
}

async function readApiOpen({token, fetchFn = fetch}) {
  const r = await fetchFn(`https://run.googleapis.com/v2/${SERVICE}`, {headers: {"Authorization": `Bearer ${token}`}});
  if (!r.ok) throw new Error(`Cloud Run said ${r.status}`);
  return (await r.json()).ingress === ON;
}

module.exports = {setApiOpen, readApiOpen, SERVICE, ON, OFF};
