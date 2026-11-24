"use strict";
// Slows down guessing with bad keys (2026-11-23). Every refused key costs two
// database reads and, before this, had no limit at all.
//
// Kept in memory per instance: no database cost, and nothing a caller sends
// (an IP header, say) can be forged to get around it. A pair of keys that
// worked in the last 10 minutes always gets through, so a flood of bad keys
// can't lock out a tool that is already in use.

const MINUTE = 60000;
const KNOWN_MS = 10 * MINUTE;
const MAX_KNOWN = 5000;

class KeyGuard {
  /** @param {{perKey?: number, perInstance?: number}} [o] refusals allowed per minute */
  constructor(o = {}) {
    this.perKey = o.perKey || 20;
    this.perInstance = o.perInstance || 300;
    this.known = new Map(); // pair id -> last time it worked
    this.fails = new Map(); // pair id -> refusals this minute
    this.minute = 0;
    this.total = 0;
  }
  roll(now) {
    const m = Math.floor(now / MINUTE);
    if (m !== this.minute) { this.minute = m; this.total = 0; this.fails.clear(); }
  }
  /** @return {number} 0 = go ahead, otherwise seconds to wait */
  wait(id, now) {
    this.roll(now);
    const seen = this.known.get(id);
    if (seen && now - seen < KNOWN_MS) return 0;
    if ((this.fails.get(id) || 0) < this.perKey && this.total < this.perInstance) return 0;
    return Math.max(1, Math.ceil(((this.minute + 1) * MINUTE - now) / 1000));
  }
  ok(id, now) {
    this.known.delete(id);
    this.known.set(id, now);
    if (this.known.size > MAX_KNOWN) this.known.delete(this.known.keys().next().value);
  }
  refused(id, now) {
    this.roll(now);
    this.known.delete(id);
    this.total++;
    this.fails.set(id, (this.fails.get(id) || 0) + 1);
  }
}

module.exports = {KeyGuard};
