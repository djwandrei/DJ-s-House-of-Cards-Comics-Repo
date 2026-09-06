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

// Rotation mode intentionally has no candidate-count ceiling. Its exact search
// runs inside a background Worker, so a broad roster can take longer without
// freezing the page or being silently replaced by a heuristic answer. Keep this
// compatibility export as `null` so older callers can detect the uncapped
// contract without interpreting an arbitrarily large number as a real limit.
export const DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS = null;

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

/**
 * Fan-facing skill families translated into the solver's measurable inputs.
 *
 * The family layer is intentionally UI-only: the exact solver still sees the
 * same transparent metric weights it has always understood. Most of each
 * family remains a familiar box-score statistic. A deliberately small share
 * is reserved for Basketball Reference OBPM/DBPM when every eligible player
 * has the matching source value. Those impact checks keep one isolated event
 * stat (for example, steals) from standing in for an entire side of the ball.
 * The solver disables an incomplete impact metric for the whole pool and
 * redistributes its share; missing data can never become a hidden advantage.
 * Coefficients within a family add to one, so moving a family slider changes
 * emphasis rather than changing the total scale.
 */
export const OBJECTIVE_FAMILY_DEFINITIONS = Object.freeze({
  scoring: Object.freeze({
    label: "Scoring",
    description: "Points and efficient finishing, checked against overall offensive impact",
    metrics: Object.freeze({ points: 0.55, efgPct: 0.3, offensiveImpact: 0.15 }),
  }),
  spacing: Object.freeze({
    label: "Spacing",
    description: "Three-point accuracy and supported attempt frequency; not a measured gravity rating",
    // General eFG% rewarded non-shooting finishers for a spacing preference
    // and duplicated the Scoring family's finishing/impact terms. Spacing is
    // now solely the evidence-aware three-point component; user family shares
    // still sum/normalize exactly as before. This is a semantic correction,
    // not a fitted claim that these weights predict wins.
    metrics: Object.freeze({ threePct: 1 }),
  }),
  creation: Object.freeze({
    label: "Creation",
    description: "Playmaking, turnover control, and overall offensive impact",
    metrics: Object.freeze({ assists: 0.6, ballSecurity: 0.25, offensiveImpact: 0.15 }),
  }),
  rebounding: Object.freeze({
    label: "Rebounding",
    description: "Finish defensive possessions and create extra chances",
    metrics: Object.freeze({ rebounds: 1 }),
  }),
  perimeterDefense: Object.freeze({
    label: "Perimeter Defense",
    description: "Disrupt ballhandlers without treating steals as complete defense",
    metrics: Object.freeze({ steals: 0.75, defensiveImpact: 0.25 }),
  }),
  interiorDefense: Object.freeze({
    label: "Interior Defense",
    description: "Protect the rim, control the glass, and support team defense",
    metrics: Object.freeze({ blocks: 0.55, rebounds: 0.3, defensiveImpact: 0.15 }),
  }),
});

/**
 * Strategy presets are expressed in the six visible families. They do not
 * need to add to 100; only their proportions matter. Balanced, Offense, and
 * Defense are the three primary choices in Simple view. The specialized
 * presets remain available in Detailed view.
 */
export const DEFAULT_FAMILY_PRESETS = Object.freeze({
  balanced: Object.freeze({
    scoring: 20,
    spacing: 15,
    creation: 15,
    rebounding: 15,
    perimeterDefense: 18,
    interiorDefense: 17,
  }),
  scoring: Object.freeze({
    scoring: 30,
    spacing: 25,
    creation: 25,
    rebounding: 8,
    perimeterDefense: 6,
    interiorDefense: 6,
  }),
  defense: Object.freeze({
    scoring: 8,
    spacing: 7,
    creation: 10,
    rebounding: 22,
    perimeterDefense: 27,
    interiorDefense: 26,
  }),
  shooting: Object.freeze({
    scoring: 20,
    spacing: 40,
    creation: 18,
    rebounding: 7,
    perimeterDefense: 8,
    interiorDefense: 7,
  }),
  playmaking: Object.freeze({
    scoring: 16,
    spacing: 12,
    creation: 42,
    rebounding: 8,
    perimeterDefense: 14,
    interiorDefense: 8,
  }),
  rebounding: Object.freeze({
    scoring: 12,
    spacing: 7,
    creation: 8,
    rebounding: 43,
    perimeterDefense: 10,
    interiorDefense: 20,
  }),
});

const OBJECTIVE_METRIC_KEYS = Object.freeze([
  "points",
  "efgPct",
  "threePct",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "ballSecurity",
  "offensiveImpact",
  "defensiveImpact",
]);

/** Convert six understandable priorities into exact-solver metric weights. */
export function weightsFromSkillFamilies(familyWeights = {}) {
  const metricWeights = Object.fromEntries(OBJECTIVE_METRIC_KEYS.map((metric) => [metric, 0]));
  for (const [family, definition] of Object.entries(OBJECTIVE_FAMILY_DEFINITIONS)) {
    const familyWeight = Math.max(0, Number(familyWeights?.[family]) || 0);
    for (const [metric, coefficient] of Object.entries(definition.metrics)) {
      metricWeights[metric] += familyWeight * coefficient;
    }
  }
  // Shared scenarios historically store integer metric weights. Rounding here
  // keeps those URLs compact and deterministic while preserving the intended
  // family proportions closely enough for a 0–100 slider.
  return Object.fromEntries(
    Object.entries(metricWeights).map(([metric, value]) => [metric, Math.round(value)]),
  );
}

/**
 * Approximate family controls for legacy links that contain only raw metrics.
 * This is a display bridge, not an inverse of the many-to-one family mapping;
 * the decoded raw weights remain the actual solver input until a slider moves.
 */
export function skillFamiliesFromMetricWeights(metricWeights = {}) {
  const value = (metric) => Math.max(0, Number(metricWeights?.[metric]) || 0);
  return {
    scoring: Math.round((value("points") + value("efgPct") + value("offensiveImpact")) / 3),
    spacing: Math.round((value("threePct") + value("efgPct") + value("offensiveImpact")) / 3),
    creation: Math.round((value("assists") + value("ballSecurity") + value("offensiveImpact")) / 3),
    rebounding: Math.round(value("rebounds")),
    perimeterDefense: Math.round((value("steals") + value("defensiveImpact")) / 2),
    interiorDefense: Math.round((value("blocks") + value("rebounds") + value("defensiveImpact")) / 3),
  };
}

// Preserve the public raw-metric preset contract for the optimizer and any
// external callers. The UI now authors these values through skill families.
export const DEFAULT_PRESETS = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_FAMILY_PRESETS).map(([name, familyWeights]) => [
    name,
    Object.freeze(weightsFromSkillFamilies(familyWeights)),
  ]),
));
