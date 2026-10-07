/**
 * perf/lh-config.mjs — the one Lighthouse config every TeeBox perf run uses.
 *
 * WHY THIS FILE EXISTS
 * The first perf pass (r320-r323) measured with a hand-rolled CDP harness that
 * dismissed the auth gate programmatically. That injected layout shifts of its
 * own and moved the LCP element around, and LCP came back anywhere from 352ms
 * to 9336ms across runs of effectively identical code. Two "improvements" were
 * shipped and reverted off the back of it. Nothing gets measured ad hoc again.
 *
 * Settings are Lighthouse's own mobile preset, stated explicitly rather than
 * inherited, so a number from today is comparable to a number from next month.
 */

/** Lighthouse mobile: slow 4G, 4x CPU, 412x823 @2.625. */
export const MOBILE_THROTTLING = {
  rttMs: 150,
  throughputKbps: 1.6 * 1024,
  requestLatencyMs: 150 * 3.75,
  downloadThroughputKbps: 1.6 * 1024,
  uploadThroughputKbps: 750,
  cpuSlowdownMultiplier: 4,
};

export const baseConfig = {
  extends: 'lighthouse:default',
  settings: {
    formFactor: 'mobile',
    onlyCategories: ['performance'],
    screenEmulation: {mobile: true, width: 412, height: 823, deviceScaleFactor: 2.625, disabled: false},
    throttlingMethod: 'simulate',
    throttling: MOBILE_THROTTLING,
    emulatedUserAgent:
      'Mozilla/5.0 (Linux; Android 11; moto g power) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  },
};

/**
 * The states worth measuring. They are NOT the same page and must never be
 * averaged together — a logged-out visitor sees the auth gate, a returning
 * user does not, and the service worker makes the second visit a different
 * page load entirely.
 */
export const STATES = {
  // First-time visitor from a reel. Throwaway profile, cold cache, gate shows
  // naturally. Nothing is clicked — whatever they see IS the measurement.
  'logged-out-cold': {warm: false, auth: false},
  // Same visitor returning. A priming load in the SAME browser installs the
  // service worker and fills the cache; the measured load is the revisit.
  'logged-out-warm': {warm: true, auth: false},
  // Signed-in returning user. Requires a test account — see perf/README.md.
  'logged-in-cold': {warm: false, auth: true},
  'logged-in-warm': {warm: true, auth: true},
};

export const TARGETS = {LCP: 2000, INP: 150, CLS: 0.05, TBT: 300, FCP: 1800};

/**
 * A run set is only trustworthy if EVERY metric a change could be judged on is
 * reproducible across it — not just LCP. The first r324 baseline gated on LCP
 * alone and reported "stable" for a set whose CLS ranged 0.014 to 0.405.
 */
export const STABILITY_THRESHOLD = 0.20;  // (max-min)/median for LCP/FCP/TBT
export const CLS_ABS_THRESHOLD = 0.05;    // absolute CLS swing = the budget itself
export const MIN_RUNS = 3;                // fewer surviving runs = no median worth quoting
