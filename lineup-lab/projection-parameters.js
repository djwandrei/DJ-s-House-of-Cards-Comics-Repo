/**
 * Versioned, immutable parameters for Lineup Lab's historical projection.
 *
 * The exact optimizer should not be a collection of unexplained numbers spread
 * through a 6,000-line solver.  This module keeps every tunable statistical
 * assumption in one auditable place.  The values are calibration defaults—not
 * claims that a rate becomes "true" at one exact sample size.  Future backtests
 * can replace a preset without changing the exact constraint/search layer.
 */

export const HISTORICAL_PROJECTION_MODEL_VERSION =
  "historical-rates-v4-usage-responsibility";

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
    description: "Favors rates supported by larger roles and stronger samples.",
    priorMultiplier: 1.2,
    uncertaintyReserveShare: 0.1,
    responsibilityExpansionStrength: 1,
    usageCoveragePenaltyPoints: 24,
    workloadSaturationMarginalFloor: 0.3,
    workloadSaturationTransitionMinutes: 10,
  }),
  balanced: Object.freeze({
    key: "balanced",
    label: "Balanced projection",
    description: "Uses a moderate evidence reserve and realistic responsibility scaling.",
    priorMultiplier: 1,
    uncertaintyReserveShare: 0.08,
    responsibilityExpansionStrength: 0.85,
    usageCoveragePenaltyPoints: 20,
    workloadSaturationMarginalFloor: 0.35,
    workloadSaturationTransitionMinutes: 8,
  }),
  upside: Object.freeze({
    key: "upside",
    label: "More upside",
    description: "Trusts emerging rates sooner while still correcting missing team usage.",
    priorMultiplier: 0.75,
    uncertaintyReserveShare: 0.04,
    responsibilityExpansionStrength: 0.65,
    usageCoveragePenaltyPoints: 14,
    workloadSaturationMarginalFloor: 0.42,
    workloadSaturationTransitionMinutes: 6,
  }),
});

export const PROJECTION_RISK_KEYS = Object.freeze(Object.keys(PROJECTION_RISK_PRESETS));

/** Resolve a complete parameter object after config validation. */
export function projectionParametersFor(risk = DEFAULT_PROJECTION_RISK) {
  const preset = PROJECTION_RISK_PRESETS[risk] || PROJECTION_RISK_PRESETS[DEFAULT_PROJECTION_RISK];
  return Object.freeze({
    ...preset,
    priorMinutesByMetric: Object.freeze(Object.fromEntries(
      Object.entries(BASE_PRIOR_MINUTES).map(([metric, minutes]) => [
        metric,
        Math.round(minutes * preset.priorMultiplier),
      ]),
    )),
    priorFieldGoalAttempts: Math.round(500 * preset.priorMultiplier),
    priorThreePointAttempts: Math.round(180 * preset.priorMultiplier),
    priorImpactMinutes: Math.round(1200 * preset.priorMultiplier),
    evidenceReferenceGames: 50,
    leagueAverageUsage: 0.2,
    maximumProjectedUsage: 0.38,
  });
}
