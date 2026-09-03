/**
 * Optional possession-level Scout layer.
 *
 * The historical model remains independent from this contract. Scout is an
 * opt-in, private-evidence layer: incomplete evidence fails closed instead of
 * treating an unknown player as average, replacement level, or zero impact.
 *
 * There are two deliberately separate kinds of Scout evidence:
 *
 * 1. Player RAPM affects the *minute objective*. We convert the complete
 *    eligible pool's reliability-shrunk offense/defense signal into a modest
 *    percentile blend, so it can change both roster choice and minutes without
 *    silently replacing the visitor's game-plan weights.
 * 2. A five-player residual is a group-only signal. It is used only for an
 *    exact five with publishable, already-shrunk lineup evidence. A rotation
 *    roster is not a five-man unit, so it never receives a made-up residual.
 */

export const SCOUT_IMPACT_MODEL_VERSION = "scout-impact-v2";
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

// Scout deliberately remains a supporting signal. At the most extreme, a
// Scout-only player estimate can move a player profile by 12 score points;
// hybrid mode uses half of that. Blending within [0, 1] preserves the exact
// allocator's non-negative, bounded minute-score contract.
const SCOUT_BLEND_BY_MODE = Object.freeze({ historical: 0, hybrid: 0.06, scout: 0.12 });

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

function impactValue(row, side) {
  for (const alias of PLAYER_IMPACT_ALIASES[side]) {
    const value = finite(row?.[alias]);
    if (value !== null) return value;
  }
  return null;
}

function reliabilityValue(row) {
  // The current compact private RAPM response stores its stability proxy in
  // `metrics.ridgeReliabilityProxy`; test/dev callers may use `reliability`.
  // Require an explicit value rather than granting an omitted value full trust.
  for (const alias of ["reliability", "ridgeReliabilityProxy", "reliabilityProxy"]) {
    const value = finite(row?.[alias]);
    if (value !== null) return clamp(value, 0, 1);
  }
  return null;
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
export function buildScoutImpactModel(players, evidence, { mode = "historical" } = {}) {
  if (mode === "historical") {
    return {
      version: SCOUT_IMPACT_MODEL_VERSION,
      mode,
      available: false,
      applied: false,
      impactsById: new Map(),
      exactLineupResiduals: new Map(),
      missingPlayerIds: [],
      reason: "The historical model was selected; possession-level Scout evidence stayed separate.",
    };
  }
  const rows = evidence?.players;
  const impactsById = new Map();
  const missingPlayerIds = [];
  for (const player of players) {
    const row = playerEvidence(rows, player.id);
    const offense = impactValue(row, "offense");
    const defense = impactValue(row, "defense");
    const reliability = reliabilityValue(row);
    if (
      row?.displayEligible === false ||
      offense === null ||
      defense === null ||
      reliability === null
    ) {
      missingPlayerIds.push(player.id);
      continue;
    }
    impactsById.set(player.id, {
      // Store both values so the user's offense/defense priorities can choose
      // their mix later. Reliability is applied once, here, before percentile
      // ranking; neither a null component nor a low-sample component is ever
      // promoted by a later numeric coercion.
      offense: offense * reliability,
      defense: defense * reliability,
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
    reason: available
      ? "Reliability-shrunk possession impact is available for every eligible player."
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
  const blend = SCOUT_BLEND_BY_MODE[model.mode] ?? 0;
  const scoresById = new Map();
  const adjustmentScoresById = new Map();
  for (const player of players) {
    const base = bases.get(player.id);
    const scoutPercentile = scoutPercentilesById.get(player.id);
    const adjusted = clamp(base + (blend * (scoutPercentile - base)), 0, 1);
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
    reason: blend > 0
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
    if (evidence) {
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
    reason: exactLineupResidual === null
      ? "Scout player impact was applied through the exact minute objective."
      : "Scout player impact was applied through exact minutes; a verified publishable exact-five residual was added separately.",
  };
}
