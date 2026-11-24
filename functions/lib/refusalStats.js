"use strict";
// What is being refused, without logging each refusal (2026-11-23). Refused
// request logs are dropped except for a 1% sample (logging exclusion
// "sellerapi-refused"); this keeps one summary line per instance per minute:
// counts by status, the busiest keys and the busiest addresses. Keys are
// reduced to their kind plus 8 characters of their hash; addresses to a hash.
// Pure and bounded.
const crypto = require("node:crypto");
const MAX_TRACKED = 2000;
const h8 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 8);

function keyLabel(partnerKey) {
  const k = String(partnerKey || "");
  if (!k) return "none";
  const m = k.match(/^pk_(live|test)_[0-9A-Za-z]{43}$/);
  return m ? `pk_${m[1]}_#${h8(k)}` : "malformed";
}

class RefusalStats {
  constructor() { this.reset(-1); }
  reset(minute) { this.minute = minute; this.total = 0; this.status = {}; this.keys = new Map(); this.ips = new Map(); }
  bump(map, k) { if (map.has(k) || map.size < MAX_TRACKED) map.set(k, (map.get(k) || 0) + 1); }
  top(map) { return [...map].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({id, n})); }
  /** @return {object|null} the finished minute's summary, once */
  note({status, partnerKey, ip, nowMs}) {
    const minute = Math.floor(nowMs / 60000);
    let done = null;
    if (minute !== this.minute) {
      if (this.total) {
        done = {minute: new Date(this.minute * 60000).toISOString(), total: this.total, byStatus: this.status,
          topKeys: this.top(this.keys), topIps: this.top(this.ips)};
      }
      this.reset(minute);
    }
    this.total++;
    this.status[status] = (this.status[status] || 0) + 1;
    this.bump(this.keys, keyLabel(partnerKey));
    this.bump(this.ips, ip ? h8(ip) : "none");
    return done;
  }
}

module.exports = {RefusalStats, keyLabel};
