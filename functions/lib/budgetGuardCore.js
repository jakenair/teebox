"use strict";
// When does a billing message shut the Seller API off? Pure.
// Budget messages arrive several times a day with the month's cost so far.
// The API goes off each time spend reaches a new multiple of the limit ($100,
// $200, ...): so it can be turned back on by hand without going straight off
// again on the next message, and a new $100 still stops it.

/**
 * @param {object} msg the decoded budget notification
 * @param {{attrs: object, budgetId: string, limit: number, last: object}} o
 * @return {{fire: boolean, why: string, month: string, step: number, cost: number}}
 */
function decide(msg, {attrs, budgetId, limit, last}) {
  const cost = Number(msg && msg.costAmount);
  const month = String((msg && msg.costIntervalStart) || "").slice(0, 7);
  const step = Number.isFinite(cost) && cost > 0 ? Math.floor(cost / limit) : 0;
  const out = (fire, why) => ({fire, why, month, step, cost: Number.isFinite(cost) ? cost : 0});
  if (budgetId && (!attrs || attrs.budgetId !== budgetId)) return out(false, "another budget");
  if (!Number.isFinite(cost) || !/^\d{4}-\d{2}$/.test(month)) return out(false, "unreadable message");
  if (msg.currencyCode && msg.currencyCode !== "USD") return out(false, "not USD");
  if (step < 1) return out(false, "under the limit");
  if (last && last.month === month && Number(last.step) >= step) return out(false, "already fired at this level");
  return out(true, "limit reached");
}

module.exports = {decide};
