/**
 * Versioned, immutable parameters for Lineup Lab's historical projection.
 *
 * The exact optimizer should not be a collection of unexplained numbers spread
 * through a 6,000-line solver.  This module keeps every tunable statistical
 * assumption in one auditable place.  The values are calibration defaults—not
 * claims that a rate becomes "true" at one exact sample size.  Future backtests
 * can replace a preset without changing the exact constraint/search layer.
 */

import { WORKLOAD_CALIBRATION } from "./workload-calibration.js?v=20260907f";

export const HISTORICAL_PROJECTION_MODEL_VERSION =
  "historical-rates-v8-paired-scout-workload";

export const DEFAULT_PROJECTION_RISK = "balanced";

const BASE_PRIOR_MINUTES = Object.freeze({
  points: 750,
  rebounds: 500,
  assists: 700,
  steals: 900,
  blocks: 900,
  ballSecurity: 700,
});

/**
 * Risk changes how much uncertain upside the optimizer is allowed to trust.
 * It never changes eligibility, hard constraints, or a player's minute bounds.
 * In particular, none of these values use games with the selected team.
 */
export const PROJECTION_RISK_PRESETS = Object.freeze({
  reliable: Object.freeze({
    key: "reliable",
    label: "Reliable evidence",
    description: "Uses a larger downside reserve for uncertain rates and shooting volume.",
    priorMultiplier: 1,
    decisionUncertaintyWeight: 1,
    uncertaintyReserveShare: 0.1,
    responsibilityExpansionStrength: 1,
    usageCoveragePenaltyPoints: 24,
    workloadSaturationMarginalFloor: 0.3,
    workloadSaturationTransitionMinutes: 10,
  }),
  balanced: Object.freeze({
    key: "balanced",
    label: "Balanced projection",
    description: "Uses a moderate downside reserve without changing the expected-rate estimate.",
    priorMultiplier: 1,
    decisionUncertaintyWeight: 0.5,
    uncertaintyReserveShare: 0.08,
    responsibilityExpansionStrength: 0.85,
    usageCoveragePenaltyPoints: 20,
    workloadSaturationMarginalFloor: 0.35,
    workloadSaturationTransitionMinutes: 8,
  }),
  upside: Object.freeze({
    key: "upside",
    label: "More upside",
    description: "Uses sample-adjusted expected rates without an extra downside reserve.",
    priorMultiplier: 1,
    decisionUncertaintyWeight: 0,
    uncertaintyReserveShare: 0.04,
    responsibilityExpansionStrength: 0.65,
    usageCoveragePenaltyPoints: 14,
    workloadSaturationMarginalFloor: 0.42,
    workloadSaturationTransitionMinutes: 6,
  }),
});

export const PROJECTION_RISK_KEYS = Object.freeze(Object.keys(PROJECTION_RISK_PRESETS));

/** Resolve a complete parameter object after config validation. */
export function projectionParametersFor(risk = DEFAULT_PROJECTION_RISK, scope = null) {
  const preset = PROJECTION_RISK_PRESETS[risk] || PROJECTION_RISK_PRESETS[DEFAULT_PROJECTION_RISK];
  // One season's holdout is not validation for every era. Only matching regular
  // season data uses the fitted model; other sources retain disclosed priors.
  const calibrated = Number(scope?.seasonEndYear) === WORKLOAD_CALIBRATION.seasonEndYear
    && scope?.seasonPhase === WORKLOAD_CALIBRATION.phase;
  const fitted = calibrated ? WORKLOAD_CALIBRATION.metrics : null;
  return Object.freeze({
    ...preset,
    calibration: calibrated ? WORKLOAD_CALIBRATION : null,
    expansionStrengthByMetric: fitted ? Object.fromEntries(Object.entries(fitted).map(([metric, row]) => [metric, row.strength])) : null,
    // Fitted posterior means already handle sampling noise. Keep risk reserves
    // separate from expected production; this calibrated path uses the mean.
    uncertaintyReserveShare: calibrated ? 0 : preset.uncertaintyReserveShare,
    // Confidence preferences must not rewrite expected player ability. The
    // same observed data and prior now produce the same posterior mean in
    // every risk preset, including historical seasons without a fitted prior.
    // Only decisionUncertaintyWeight changes the downside objective.
    priorMinutesByMetric: Object.freeze(Object.fromEntries(
      Object.entries(BASE_PRIOR_MINUTES).map(([metric, minutes]) => [
        metric,
        fitted ? fitted[metric].prior : minutes,
      ]),
    )),
    priorFieldGoalAttempts: fitted ? fitted.efgPct.prior : 500,
    priorThreePointAttempts: fitted ? fitted.threePct.prior : 180,
    priorImpactMinutes: 1200,
    leagueAverageUsage: 0.2,
    maximumProjectedUsage: 0.38,
  });
}
