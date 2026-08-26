/**
 * Small, browser-safe Lineup Lab configuration shared by the UI and solver.
 *
 * Keeping these values outside the full exact-search engine lets the initial
 * page render without parsing optimizer-core.js. The solver is then loaded in
 * its Worker only when a visitor asks it to evaluate a scenario.
 */

// Exact search stays transparent and deterministic for ordinary NBA roster
// pools. These guards prevent broad requests from tying up a browser.
export const DEFAULT_MAX_EXACT_COMBINATIONS = 200000;

// Rotation candidates also solve an integer G/F/C minute-flow problem. Browser
// benchmarking put 24,310 all-flex candidates beyond the 30-second watchdog,
// while 6,435 stayed comfortably below it; 10,000 leaves a practical margin.
export const DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS = 10000;

export const DEFAULT_PRESETS = Object.freeze({
  balanced: Object.freeze({
    points: 1.4,
    efgPct: 1.2,
    threePct: 0.7,
    rebounds: 1,
    assists: 1,
    steals: 0.8,
    blocks: 0.8,
    ballSecurity: 1,
  }),
  scoring: Object.freeze({
    points: 2.4,
    efgPct: 1.5,
    threePct: 1.2,
    rebounds: 0.5,
    assists: 0.7,
    steals: 0.3,
    blocks: 0.3,
    ballSecurity: 0.6,
  }),
  shooting: Object.freeze({
    points: 1,
    efgPct: 2.3,
    threePct: 2,
    rebounds: 0.3,
    assists: 0.6,
    steals: 0.3,
    blocks: 0.2,
    ballSecurity: 0.8,
  }),
  playmaking: Object.freeze({
    points: 0.9,
    efgPct: 0.7,
    threePct: 0.4,
    rebounds: 0.5,
    assists: 2.5,
    steals: 0.8,
    blocks: 0.2,
    ballSecurity: 1.6,
  }),
  defense: Object.freeze({
    points: 0.5,
    efgPct: 0.5,
    threePct: 0.3,
    rebounds: 1.4,
    assists: 0.4,
    steals: 2.2,
    blocks: 2.2,
    ballSecurity: 0.5,
  }),
  rebounding: Object.freeze({
    points: 0.6,
    efgPct: 0.6,
    threePct: 0.2,
    rebounds: 3,
    assists: 0.3,
    steals: 0.5,
    blocks: 1,
    ballSecurity: 0.5,
  }),
});
