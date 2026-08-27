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

// Basketball Reference lists a player's eligible positions, not tracked
// possession-level assignments. This helper therefore builds a transparent
// source-listed position *estimate*, not a claim about the exact historical
// guard/forward/center minutes. A fixed 96/96/48 split looks tidy, but it can
// quietly cap a guard-heavy team or force center time the roster did not have.
// The full roster is measured once before candidate groups are evaluated, so
// candidate selection cannot move the goalposts.
export function assessHistoricalPositionMinuteEvidence(
  players = [],
  historicalMinuteAnchors = {},
) {
  const positions = ["G", "F", "C"];
  const fallback = { G: 96, F: 96, C: 48 };
  const sourceValue = (id) => historicalMinuteAnchors instanceof Map
    ? historicalMinuteAnchors.get(id)
    : historicalMinuteAnchors?.[id];
  const roster = Array.isArray(players) ? players : [];
  const raw = { G: 0, F: 0, C: 0 };
  let workloadRows = 0;
  let sourceListedPositionRows = 0;
  let usableRows = 0;

  for (const player of roster) {
    const anchor = Number(sourceValue(player?.id));
    // The exact solver may use a verified career-profile alternate (for
    // example, a forward who can also cover center).  That flexibility should
    // not be treated as proof that half of the player's recorded season
    // minutes were played at each role.  When available, use the original
    // season-listed buckets to estimate the team's historical G/F/C mix; old
    // fixtures and imported CSV files retain their existing `positions` path.
    const historicalPositions = Array.isArray(player?.positionEvidence?.seasonListed)
      && player.positionEvidence.seasonListed.length > 0
      ? player.positionEvidence.seasonListed
      : player?.positions;
    const eligiblePositions = [...new Set(
      (Array.isArray(historicalPositions) ? historicalPositions : [])
        .map((position) => String(position).toUpperCase())
        .filter((position) => positions.includes(position)),
    )];
    if (anchor > 0) workloadRows += 1;
    if (eligiblePositions.length > 0) sourceListedPositionRows += 1;
    if (!(anchor > 0) || eligiblePositions.length === 0) continue;
    usableRows += 1;

    // A source-listed multi-position player contributes an equal share of his
    // historical workload to every listed role. This is intentionally neutral:
    // box-score data does not reveal the exact position played each possession.
    const share = anchor / eligiblePositions.length;
    for (const position of eligiblePositions) raw[position] += share;
  }

  const rawTotal = positions.reduce((total, position) => total + raw[position], 0);
  if (!(rawTotal > 0)) {
    return {
      requirements: { ...fallback },
      sourceRows: roster.length,
      workloadRows,
      sourceListedPositionRows,
      usableRows,
      fallbackApplied: true,
    };
  }

  // Largest-remainder rounding preserves the measured proportions while
  // guaranteeing the exact integer total required by the minute-flow solver.
  const scaled = positions.map((position, order) => {
    const exact = (raw[position] / rawTotal) * 240;
    return {
      position,
      order,
      exact,
      minutes: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let remaining = 240 - scaled.reduce((total, item) => total + item.minutes, 0);
  scaled
    .slice()
    .sort((left, right) => right.remainder - left.remainder || left.order - right.order)
    .slice(0, remaining)
    .forEach((item) => {
      scaled[item.order].minutes += 1;
      remaining -= 1;
    });

  return {
    requirements: Object.fromEntries(scaled.map(({ position, minutes }) => [position, minutes])),
    sourceRows: roster.length,
    workloadRows,
    sourceListedPositionRows,
    usableRows,
    fallbackApplied: false,
  };
}

/** Return only the exact 240-minute source-listed position estimate for the solver. */
export function deriveHistoricalPositionMinuteRequirements(
  players = [],
  historicalMinuteAnchors = {},
) {
  return assessHistoricalPositionMinuteEvidence(players, historicalMinuteAnchors).requirements;
}

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
