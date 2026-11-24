"use strict";
// The ship-by deadline: the end of the 3rd business day after the order, in
// Central time. Weekends and federal (USPS) holidays don't count. Pure; the
// client has the same rule (js/ship-info.js) and a test keeps them equal.
const {ctDate, ctMidnight, addDays} = require("./dailyDigestCore");

const SHIP_BY_BUSINESS_DAYS = 3;
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const pad = (n) => String(n).padStart(2, "0");
/** The nth weekday of a month (n = -1: the last). */
function nth(year, month, weekday, n) {
  if (n > 0) {
    const first = dow(`${year}-${pad(month)}-01`);
    return `${year}-${pad(month)}-${pad(1 + (weekday - first + 7) % 7 + (n - 1) * 7)}`;
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(last - (dow(`${year}-${pad(month)}-${pad(last)}`) - weekday + 7) % 7)}`;
}
/** USPS holidays of a year, Sunday ones observed on Monday. */
function holidays(year) {
  const fixed = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]].map(([m, d]) => {
    const date = `${year}-${pad(m)}-${pad(d)}`;
    return dow(date) === 0 ? addDays(date, 1) : date;
  });
  return new Set([...fixed, nth(year, 1, 1, 3), nth(year, 2, 1, 3), nth(year, 5, 1, -1), nth(year, 9, 1, 1), nth(year, 10, 1, 2), nth(year, 11, 4, 4)]);
}
function isBusinessDay(date) {
  const d = dow(date);
  return d !== 0 && d !== 6 && !holidays(Number(date.slice(0, 4))).has(date);
}
/** The calendar day `n` business days after `date`. */
function addBusinessDays(date, n) {
  let d = date;
  while (n > 0) { d = addDays(d, 1); if (isBusinessDay(d)) n--; }
  return d;
}
/** @param {number} createdMs @return {{date: string, dueMs: number}} due = last moment of that Central day */
function shipBy(createdMs) {
  const date = addBusinessDays(ctDate(createdMs), SHIP_BY_BUSINESS_DAYS);
  return {date, dueMs: ctMidnight(addDays(date, 1)) - 1};
}
/** Which business day after the order `nowMs` falls on (0 = order day or a day off before the first). */
function businessDayNumber(createdMs, nowMs) {
  const today = ctDate(nowMs);
  let d = ctDate(createdMs); let n = 0;
  while (d < today) { d = addDays(d, 1); if (isBusinessDay(d)) n++; }
  return n;
}

/**
 * The reminder due today for an order, or null. Pure.
 * @param {object} o order with createdAtMs
 * @param {number} nowMs
 * @return {2|3|null}
 */
function reminderDue(o, nowMs) {
  if (!o || o.refunded || o.refundedAt || o.livemode === false) return null;
  if (o.fulfillmentStatus !== "awaiting_seller_shipment" || o.shippedAt) return null;
  if (!Number.isFinite(o.createdAtMs)) return null;
  if (!isBusinessDay(ctDate(nowMs))) return null;
  const day = businessDayNumber(o.createdAtMs, nowMs);
  if (day === 2 && !o.shipReminder2At) return 2;
  if (day === 3 && !o.shipReminder3At) return 3;
  return null;
}

module.exports = {SHIP_BY_BUSINESS_DAYS, holidays, isBusinessDay, addBusinessDays, shipBy, businessDayNumber, reminderDue};
