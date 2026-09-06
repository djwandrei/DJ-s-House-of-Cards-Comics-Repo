/**
 * Optional possession-level Scout layer.
 *
 * The historical model remains independent from this contract. Scout is an
 * opt-in, private-evidence layer: incomplete evidence fails closed instead of
 * treating an unknown player as average, replacement level, or zero impact.
 *
 * There are two deliberately separate kinds of Scout evidence:
 *
 * 1. Primary Scout uses validated player O/D RAPM as its whole objective.
 *    An affine rescaling preserves impact gaps and the exact optimum. Ridge-
 *    regularized coefficients are not multiplied by reliability a second time.
 *    Historical box scores remain context and hard constraints, not hidden fit.
 * 2. A five-player residual is a group-only signal. It is used only for an
 *    exact five in legacy hybrid experiments only. Primary Scout excludes it
 *    until independent incremental validation avoids double-counting RAPM.
 */

export const SCOUT_IMPACT_MODEL_VERSION = "scout-impact-v4-multiseason-evidence";
export const SCOUT_MODEL_MODES = Object.freeze(["historical", "hybrid", "scout"]);

const PLAYER_IMPACT_ALIASES = Object.freeze({
  offense: [
    "offensiveRapmPer100",
    "offensiveRapm",
    "offensive_rapm",
    "offense",
    "offensiveImpact",
  ],
  defense: [
    "defensiveRapmPer100",
    "defensiveRapm",
    "defensive_rapm",
    "defense",
    "defensiveImpact",
  ],
});

// Hybrid is retained for reproducible older API experiments; the UI exposes
// only Historical and primary Scout. Scout is not the former 12% blend.
const SCOUT_BLEND_BY_MODE = Object.freeze({ historical: 0, hybrid: 0.06, scout: 1 });

function finite(value) {
  // Number(null), Number(false), and Number("") all equal zero in JavaScript.
  // Those coercions are particularly dangerous here: an absent RAPM component
  // would look like valid neutral evidence and make Scout mode appear ready.
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mapValue(source, id) {
  if (source instanceof Map) return source.get(id) ?? source.get(String(id));
  return source?.[id] ?? source?.[String(id)];
}

function playerEvidence(source, id) {
  return mapValue(source, id) || null;
}

/**
 * Private `get_nba_scout_rapm` rows expose the RAPM components at their top
 * level, while the reliability proxy belongs in a compact `metrics` object.
 * Accept only those two bounded shapes. This does not recursively search an
 * arbitrary payload, which would make an unrelated nested number silently
 * qualify a player for Scout mode.
 */
function evidenceObjects(row) {
  const nestedMetrics = row?.metrics;
  return nestedMetrics && typeof nestedMetrics === "object" && !Array.isArray(nestedMetrics)
    ? [row, nestedMetrics]
    : [row];
}

function impactValue(row, side) {
  for (const source of evidenceObjects(row)) {
    for (const alias of PLAYER_IMPACT_ALIASES[side]) {
      const value = finite(source?.[alias]);
      if (value !== null) return value;
    }
  }
  return null;
}

function reliabilityValue(row) {
  // The current compact private RAPM response stores its stability proxy in
  // `metrics.ridgeReliabilityProxy`; test/dev callers may use `reliability`.
  // Require an explicit value rather than granting an omitted value full trust.
  for (const source of evidenceObjects(row)) {
    for (const alias of ["reliability", "ridgeReliabilityProxy", "reliabilityProxy"]) {
      const value = finite(source?.[alias]);
      // Bad evidence must not become perfect reliability through clamping.
      // A real zero is valid; an out-of-range value is a contract failure.
      if (value !== null) return value >= 0 && value <= 1 ? value : null;
    }
  }
  return null;
}

/**
 * All callers, including test fixtures, must provide compact model metadata.
 * A missing model must never bypass validation. Require a completed held-out O/D
 * calibration before those numbers can influence a user-facing exact solve.
 * This prevents a merely converged in-sample fit from being mistaken for a
 * validated offense/defense signal.
 */
function modelCalibrationGate(evidence) {
  const model = evidence?.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return {
      required: true,
      available: false,
      reason: "Scout model metadata was malformed, so its possession impact stayed disabled.",
    };
  }
  const calibration = model.calibration;
  if (
    calibration
    && typeof calibration === "object"
    && !Array.isArray(calibration)
    && calibration.status === "validated"
    && calibration.allComponentsImproved === true
  ) {
    return chronologicalModelGate(model);
  }
  return {
    required: true,
    available: false,
    reason: "Scout model metadata did not pass its held-out offense/defense calibration, so its RAPM values stayed separate from the optimizer.",
  };
}

/**
 * Single-season legacy previews have only the O/D game-fold report. A model
 * advertising a training window/chronological test must also provide the new
 * evidence. Never allow a multi-year fit to reuse just the older PASS flags.
 * This compact consumer check supplements, not replaces, the offline package
 * validator (which checks shards, temporal splits, tuning, and provenance).
 */
function chronologicalModelGate(model) {
  const years = model.includedSeasonStartYears;
  const report = model.chronologicalCalibration;
  if (years == null && report == null) return { required: true, available: true, reason: null };
  const latest = model.seasonEndYear - 1;
  const full = report?.test?.fullModel;
  const baseline = report?.test?.fixedEffectsBaseline;
  const mse = finite(full?.weightedMse);
  const baselineMse = finite(baseline?.weightedMse);
  const improvement = baselineMse > 0 && mse !== null ? (baselineMse - mse) / baselineMse : null;
  const reportedImprovement = finite(report?.test?.fullModelMseImprovementVsFixedEffectsBaseline);
  const possessions = finite(full?.heldOutPossessions);
  const observations = finite(full?.directionalObservationCount);
  const lambda = finite(model.lambda);
  const priorWeight = finite(model.priorSeasonWeight);
  const passed = Array.isArray(years) && years.length > 0
    && years.every(year => Number.isInteger(year) && year >= 1947 && year <= latest)
    && new Set(years).size === years.length && years.includes(latest)
    && Number.isInteger(model.seasonEndYear)
    && report?.version === "chronological_latest_season_tune_test_v1"
    && report?.method === "prior_seasons_plus_chronological_latest_season_train_tune_test_v1"
    && report?.model === "offenseDefense" && report?.latestSeasonStartYear === latest
    && lambda !== null && lambda > 0 && finite(report.selectedLambda) === lambda
    && priorWeight !== null && priorWeight >= 0 && priorWeight <= 1
    && finite(report.selectedPriorSeasonWeight) === priorWeight
    && model.solver?.converged === true
    && mse !== null && mse >= 0 && improvement > 1e-9
    && reportedImprovement !== null && Math.abs(reportedImprovement - improvement) <= 1e-9
    && report.test.status === "validated" && report.test.fullModelImprovesBaseline === true
    && possessions > 0 && finite(baseline?.heldOutPossessions) === possessions
    && Number.isSafeInteger(observations) && observations > 0
    && finite(baseline?.directionalObservationCount) === observations;
  return {
    required: true, available: passed,
    reason: passed ? null : "Scout's multiseason model needs a matching, passed chronological prediction test before it can affect this solve.",
  };
}

function normalizedWeights(offenseWeight, defenseWeight) {
  const offense = Math.max(0, finite(offenseWeight) ?? 0);
  const defense = Math.max(0, finite(defenseWeight) ?? 0);
  const total = offense + defense;
  return total > 0
    ? { offense: offense / total, defense: defense / total }
    : { offense: 0.5, defense: 0.5 };
}

function percentileRanks(values) {
  const rows = values
    .map(({ id, value }) => ({ id, value: finite(value) }))
    .filter(({ value }) => value !== null)
    .sort((left, right) => left.value - right.value || String(left.id).localeCompare(String(right.id)));
  const ranks = new Map();
  if (rows.length === 0) return ranks;

  // Ties receive their average rank. This makes a zero-variance Scout pool
  // neutral rather than allowing arbitrary player IDs to decide minutes.
  let start = 0;
  while (start < rows.length) {
    let end = start + 1;
    while (end < rows.length && Math.abs(rows[end].value - rows[start].value) < 1e-12) end += 1;
    const percentile = rows.length === 1 ? 0.5 : ((start + end - 1) / 2) / (rows.length - 1);
    for (let index = start; index < end; index += 1) ranks.set(rows[index].id, percentile);
    start = end;
  }
  return ranks;
}

function emptyMinuteObjective(baseScoresById, reason) {
  const scoresById = new Map();
  for (const [id, value] of baseScoresById ?? []) scoresById.set(id, value);
  return {
    applied: false,
    blend: 0,
    offenseWeight: 0.5,
    defenseWeight: 0.5,
    scoresById,
    adjustmentScoresById: new Map(),
    scoutPercentilesById: new Map(),
    rawImpactsById: new Map(),
    reason,
  };
}

/**
 * Validate and shrink Scout inputs before any exact candidate is scored.
 *
 * A `displayEligible: false` row is intentionally treated as unavailable: the
 * Scout package has already identified it as below its own presentation floor.
 */
export function buildScoutImpactModel(players, evidence, { mode = "historical", expectedScope = null } = {}) {
  if (mode === "historical") {
    return {
      version: SCOUT_IMPACT_MODEL_VERSION,
      mode,
      available: false,
      applied: false,
      impactsById: new Map(),
      exactLineupResiduals: new Map(),
      missingPlayerIds: [],
      calibrationRequired: false,
      calibrationAvailable: false,
      reason: "The historical model was selected; possession-level Scout evidence stayed separate.",
    };
  }
  const calibrationGate = modelCalibrationGate(evidence);
  if (expectedScope && (evidence?.contractVersion !== 1
    || evidence?.archive?.sourceValidationPassed !== true
    || evidence?.scope?.seasonEndYear !== expectedScope.seasonEndYear
    || evidence?.scope?.team !== expectedScope.team
    || evidence?.scope?.seasonPhase !== "combined"
    || evidence?.model?.seasonEndYear !== expectedScope.seasonEndYear
    || evidence?.model?.seasonPhase !== "regular_in_season_tournament_play_in_playoffs_official_franchise_sportradar-nba-lineup-reconstruction-v3_possession_start_lineups")) {
    calibrationGate.available = false;
    calibrationGate.reason = "Scout evidence did not match this team, season, and explicitly combined-season model scope.";
  }
  if (!calibrationGate.available) {
    return {
      version: SCOUT_IMPACT_MODEL_VERSION,
      mode,
      available: false,
      applied: false,
      impactsById: new Map(),
      exactLineupResiduals: new Map(),
      missingPlayerIds: [],
      calibrationRequired: calibrationGate.required,
      calibrationAvailable: false,
      reason: calibrationGate.reason,
    };
  }
  const rows = evidence?.players;
  // Native package rows are already ridge-regularized even if a transport
  // adapter has not added the older per-row `alreadyRegularized` flag. Model
  // identity plus the gates above are authoritative; a reliability proxy is
  // not a second fitted penalty or a player-specific confidence interval.
  const ridgeModel = evidence?.model?.modelVersion === "weighted_ridge_offense_defense_rapm_v2";
  const impactsById = new Map();
  const missingPlayerIds = [];
  for (const player of players) {
    const row = playerEvidence(rows, player.id);
    const offense = impactValue(row, "offense");
    const defense = impactValue(row, "defense");
    const reliability = reliabilityValue(row);
    if (
      (ridgeModel ? row?.displayEligible !== true : row?.displayEligible === false) ||
      offense === null ||
      defense === null ||
      reliability === null
    ) {
      missingPlayerIds.push(player.id);
      continue;
    }
    impactsById.set(player.id, {
      // Preserve separate offense and defense so the user's priorities can
      // choose their mix. Only legacy unregularized values use the old proxy.
      offense: ridgeModel || row.alreadyRegularized === true ? offense : offense * reliability,
      defense: ridgeModel || row.alreadyRegularized === true ? defense : defense * reliability,
      reliability,
      rawOffense: offense,
      rawDefense: defense,
    });
  }

  const exactLineupResiduals = new Map();
  for (const row of Array.isArray(evidence?.exactLineups) ? evidence.exactLineups : []) {
    const ids = Array.isArray(row?.playerIds) ? row.playerIds.map(String).sort() : [];
    const source = row?.projection && typeof row.projection === "object"
      ? row.projection
      : row;
    const status = String(source?.status ?? "available").trim().toLowerCase();
    const directResidual = finite(source?.residual ?? source?.lineupResidual);
    const shrunkResidual = finite(source?.shrunkSynergyPer100);
    const reliability = reliabilityValue(source?.reliability) ?? reliabilityValue(source);
    let residual = null;
    let sourceKind = null;
    if (directResidual !== null && reliability !== null) {
      // Legacy/direct values are not known to be pre-shrunk, so apply the
      // supplied reliability exactly once.
      residual = directResidual * reliability;
      sourceKind = "direct-reliability-shrunk";
    } else if (
      shrunkResidual !== null &&
      status === "available" &&
      source?.reliability?.publishable === true
    ) {
      // Package projections have already applied their possession prior. Do
      // not multiply by reliability again; doing so would double-shrink the
      // same evidence. The publishable gate blocks tiny exact-five samples.
      residual = shrunkResidual;
      sourceKind = "package-already-shrunk";
    }
    if (ids.length === 5 && new Set(ids).size === 5 && residual !== null) {
      exactLineupResiduals.set(ids.join("\u0001"), { residual, sourceKind });
    }
  }
  const available = missingPlayerIds.length === 0 && impactsById.size === players.length;
  return {
    version: SCOUT_IMPACT_MODEL_VERSION,
    mode,
    available,
    applied: available,
    impactsById,
    exactLineupResiduals,
    missingPlayerIds,
    calibrationRequired: calibrationGate.required,
    calibrationAvailable: calibrationGate.available,
    calibration: evidence?.model?.calibration ?? null,
    scope: evidence?.scope ?? null,
    reason: available
      ? "Validated possession impact is available for every eligible player; ridge coefficients are not shrunk twice."
      : "Scout mode requires comparable possession evidence for every eligible player; missing rows were not imputed as zero.",
  };
}

/**
 * Build the bounded player-minute objective that the exact allocator uses.
 *
 * `baseScoresById` is the normal 0–1 user-game-plan score. Scout does not add
 * arbitrary RAPM units to it. Instead, it blends a reliability-shrunk Scout
 * percentile toward that score, preserving a transparent 0–1 minute utility
 * for both the linear and diminishing-return allocation paths.
 */
export function buildScoutMinuteObjective(
  players,
  model,
  baseScoresById,
  { offenseWeight = 0.5, defenseWeight = 0.5 } = {},
) {
  const bases = new Map();
  for (const player of players) {
    const base = finite(mapValue(baseScoresById, player.id));
    if (base === null || base < 0 || base > 1) {
      return emptyMinuteObjective(bases, "The base minute objective was incomplete, so Scout did not alter allocation.");
    }
    bases.set(player.id, base);
  }
  if (!model?.applied) return emptyMinuteObjective(bases, model?.reason || "Scout evidence unavailable.");

  const weights = normalizedWeights(offenseWeight, defenseWeight);
  const rawImpactsById = new Map();
  for (const player of players) {
    const impact = model.impactsById.get(player.id);
    if (!impact) return emptyMinuteObjective(bases, "One or more eligible players lacked Scout evidence.");
    rawImpactsById.set(
      player.id,
      (impact.offense * weights.offense) + (impact.defense * weights.defense),
    );
  }
  const scoutPercentilesById = percentileRanks(
    players.map((player) => ({ id: player.id, value: rawImpactsById.get(player.id) })),
  );
  // Scout is now an O/D objective in its own right. An affine transformation
  // preserves coefficient magnitudes and exact ordering when total minutes are
  // fixed. Percentile ranks would discard the distance between players. The
  // legacy hybrid mode remains experimental, never presented as calibrated.
  const minimumImpact = Math.min(...rawImpactsById.values());
  const impactRange = Math.max(...rawImpactsById.values()) - minimumImpact;
  const blend = model.mode === "scout" ? 1 : (SCOUT_BLEND_BY_MODE[model.mode] ?? 0);
  const scoresById = new Map();
  const adjustmentScoresById = new Map();
  for (const player of players) {
    const base = bases.get(player.id);
    const scoutPercentile = scoutPercentilesById.get(player.id);
    const impactScore = impactRange > 1e-12 ? (rawImpactsById.get(player.id) - minimumImpact) / impactRange : 0.5;
    const adjusted = model.mode === "scout" ? impactScore : clamp(base + (blend * (scoutPercentile - base)), 0, 1);
    scoresById.set(player.id, adjusted);
    adjustmentScoresById.set(player.id, adjusted - base);
  }
  return {
    applied: blend > 0,
    blend,
    offenseWeight: weights.offense,
    defenseWeight: weights.defense,
    scoresById,
    adjustmentScoresById,
    scoutPercentilesById,
    rawImpactsById,
    reason: model.mode === "scout"
      ? "Scout O/D RAPM is the primary objective. Affine scaling preserves impact gaps; Basketball Reference provides separate context and hard constraints."
      : blend > 0
      ? "Reliability-shrunk Scout offense/defense percentiles were blended into the exact player-minute objective."
      : "The selected model mode does not apply Scout evidence to minutes.",
  };
}

/**
 * Score a selected group only after its exact minute plan is known.
 *
 * `minuteScoreUnitsById` carries the same Scout adjustment used by the minute
 * allocator. It may be linear minutes or the role-conditioned marginal minute
 * utility. That keeps the reported score aligned with the actual optimizer
 * instead of adding a candidate-wide RAPM bonus after allocation.
 */
export function scoreScoutCandidate(
  players,
  model,
  { minutesById = null, minuteScoreUnitsById = null } = {},
) {
  const empty = (reason) => ({
    applied: false,
    adjustmentPoints: 0,
    minuteAdjustmentPoints: 0,
    exactLineupAdjustmentPoints: 0,
    playerMinuteAdjustmentPointsById: {},
    impact: null,
    exactLineupResidual: null,
    reason,
  });
  if (!model?.applied) return empty(model?.reason || "Scout evidence unavailable.");
  const rows = players.map((player) => model.impactsById.get(player.id)).filter(Boolean);
  if (rows.length !== players.length) return empty("One or more selected players lacked Scout evidence.");

  const normalizedMinutes = new Map();
  for (const player of players) {
    const minutes = finite(mapValue(minutesById, player.id));
    normalizedMinutes.set(player.id, Math.max(0, minutes ?? 48));
  }
  const totalMinutes = [...normalizedMinutes.values()].reduce((sum, minutes) => sum + minutes, 0);
  if (!(totalMinutes > 0)) return empty("Scout scoring requires a positive minute plan.");

  const playerMinuteAdjustmentPointsById = {};
  let minuteAdjustmentPoints = 0;
  for (const player of players) {
    const units = finite(mapValue(minuteScoreUnitsById, player.id));
    // A direct caller that has not built the minute objective gets no Scout
    // player bonus. This safe default avoids the old post-selection average.
    const contribution = units === null ? 0 : (units / totalMinutes) * 100;
    playerMinuteAdjustmentPointsById[player.id] = contribution;
    minuteAdjustmentPoints += contribution;
  }

  let exactLineupResidual = null;
  let exactLineupAdjustmentPoints = 0;
  let exactLineupSource = null;
  if (players.length === 5) {
    const key = players.map((player) => String(player.id)).sort().join("\u0001");
    const evidence = model.exactLineupResiduals.get(key);
    if (evidence && model.mode !== "scout") {
      exactLineupResidual = evidence.residual;
      // The residual is already on a per-100-possession scale. Keep its
      // contribution intentionally smaller than the full player-minute blend
      // and cap it separately so one historical five cannot overwhelm a fan's
      // stated objective.
      const scale = model.mode === "scout" ? 1.25 : 0.625;
      const limit = model.mode === "scout" ? 3 : 1.5;
      exactLineupAdjustmentPoints = clamp(exactLineupResidual * scale, -limit, limit);
      exactLineupSource = evidence.sourceKind;
    }
  }
  const adjustmentPoints = minuteAdjustmentPoints + exactLineupAdjustmentPoints;
  const additiveImpact = side => players.reduce((sum, player) => sum + model.impactsById.get(player.id)[side] * normalizedMinutes.get(player.id) / 48, 0);
  return {
    applied: true,
    adjustmentPoints,
    minuteAdjustmentPoints,
    exactLineupAdjustmentPoints,
    playerMinuteAdjustmentPointsById,
    // `impact` remains a compact compatibility/readout field. It represents
    // the completed minute objective in score points, not an unscaled RAPM.
    impact: minuteAdjustmentPoints,
    exactLineupResidual,
    exactLineupSource,
    // These are sums of player coefficients at approximate possession shares,
    // not validated forecasts for an unseen rotation or an opponent matchup.
    additiveImpactPer100: {
      offense: additiveImpact("offense"), defense: additiveImpact("defense"),
      net: additiveImpact("offense") + additiveImpact("defense"),
      label: "Additive player-impact estimate; not a game forecast",
      validatedLineupForecast: false,
    },
    reason: exactLineupResidual === null
      ? "Scout player impact was applied through the exact minute objective."
      : "Scout player impact was applied through exact minutes; a verified publishable exact-five residual was added separately.",
  };
}
