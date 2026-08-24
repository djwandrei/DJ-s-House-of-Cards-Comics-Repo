/**
 * Dependency-free basketball lineup and rotation optimizer.
 *
 * The optimizer is intentionally data-source agnostic. Callers can adapt a
 * Basketball Reference response (or any other source) to the documented player
 * shape before invoking this module.
 */

const OBJECTIVE_METRICS = Object.freeze([
  "points",
  "efgPct",
  "threePct",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "ballSecurity",
]);

const POSITION_KEYS = Object.freeze(["G", "F", "C"]);
const STAT_MINIMUM_KEYS = Object.freeze([
  "points",
  "rebounds",
  "assists",
  "steals",
  "blocks",
]);
const PLAYER_NUMERIC_FIELDS = Object.freeze([
  "games",
  "starts",
  "minutes",
  "fgPct",
  "threePct",
  "efgPct",
  "ftPct",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "points",
]);

// Exact search stays transparent and deterministic for ordinary NBA roster
// pools. This guard prevents an accidental broad rotation request from tying up
// the browser with millions of synchronous combinations.
export const DEFAULT_MAX_EXACT_COMBINATIONS = 200000;
// The browser only needs a handful of alternatives. Capping this protects the
// exact enumerator from retaining an unbounded number of otherwise feasible
// groups when this module is called outside the visible UI.
export const MAX_EXACT_ALTERNATIVES = 50;

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

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function comparePlayersById(left, right) {
  return compareIds(left.id, right.id);
}

function round(value, digits = 6) {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function canonicalId(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizePlayers(players) {
  const reasons = [];
  if (!Array.isArray(players) || players.length === 0) {
    return {
      players: [],
      reasons: ["Provide at least one player to optimize."],
    };
  }

  const seenIds = new Set();
  const normalized = [];

  players.forEach((player, index) => {
    const label = `Player ${index + 1}`;
    if (!isPlainObject(player)) {
      reasons.push(`${label} must be an object.`);
      return;
    }

    const id = canonicalId(player.id);
    if (!id) {
      reasons.push(`${label} is missing a non-empty id.`);
    } else if (seenIds.has(id)) {
      reasons.push(`Player id \"${id}\" is duplicated.`);
    } else {
      seenIds.add(id);
    }

    let positions = [];
    if (!Array.isArray(player.positions) || player.positions.length === 0) {
      reasons.push(`${label} (${id || "unknown id"}) needs at least one position.`);
    } else {
      positions = [...new Set(player.positions.map((position) => String(position).toUpperCase()))];
      const invalidPositions = positions.filter((position) => !POSITION_KEYS.includes(position));
      if (invalidPositions.length > 0) {
        reasons.push(
          `${label} (${id || "unknown id"}) has unsupported position${invalidPositions.length === 1 ? "" : "s"}: ${invalidPositions.join(", ")}.`,
        );
      }
      positions = positions.filter((position) => POSITION_KEYS.includes(position));
    }

    const numericValues = {};
    for (const field of PLAYER_NUMERIC_FIELDS) {
      const original = player[field];
      const value = original === null || original === "" ? Number.NaN : Number(original);
      if (!Number.isFinite(value) || value < 0) {
        reasons.push(
          `${label} (${id || "unknown id"}) has an invalid non-negative number for ${field}.`,
        );
        numericValues[field] = 0;
      } else {
        numericValues[field] = value;
      }
    }

    normalized.push({
      ...player,
      ...numericValues,
      id,
      name: String(player.name ?? id).trim() || id,
      team: String(player.team ?? "").trim(),
      positions,
    });
  });

  const teams = [...new Set(normalized.map((player) => player.team).filter(Boolean))];
  if (teams.length > 1) {
    reasons.push(
      `The player pool must contain one team, but found ${teams.length}: ${teams.sort(compareIds).join(", ")}.`,
    );
  }

  return { players: normalized, reasons };
}

function normalizeIdList(value, label, reasons) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    reasons.push(`${label} must be an array of player ids.`);
    return [];
  }

  const ids = [];
  const seen = new Set();
  for (const rawId of value) {
    const id = canonicalId(rawId);
    if (!id) {
      reasons.push(`${label} contains an empty player id.`);
    } else if (!seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }
  return ids.sort(compareIds);
}

function normalizeNonNegativeNumber(value, fallback, label, reasons, integer = false) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    reasons.push(`${label} must be a non-negative${integer ? " integer" : " number"}.`);
    return fallback;
  }
  return number;
}

function copyMetricWeights(source, destination, label, reasons) {
  if (!isPlainObject(source)) {
    reasons.push(`${label} must be an object of objective weights.`);
    return;
  }

  for (const key of Object.keys(source)) {
    if (!OBJECTIVE_METRICS.includes(key)) {
      reasons.push(`${label} contains an unsupported objective metric: ${key}.`);
      continue;
    }
    const value = Number(source[key]);
    if (!Number.isFinite(value) || value < 0) {
      reasons.push(`${label}.${key} must be a non-negative number.`);
      continue;
    }
    destination[key] = value;
  }
}

function normalizeConfig(config = {}) {
  const reasons = [];
  if (!isPlainObject(config)) {
    return {
      config: null,
      reasons: ["Optimizer configuration must be an object."],
    };
  }

  const mode = config.mode ?? "lineup";
  if (mode !== "lineup" && mode !== "rotation") {
    reasons.push('mode must be either "lineup" or "rotation".');
  }

  const defaultSize = mode === "rotation" ? 10 : 5;
  const size = normalizeNonNegativeNumber(config.size, defaultSize, "size", reasons, true);
  if (size < 1) reasons.push("size must be at least 1.");
  if (mode === "rotation" && (size < 8 || size > 12)) {
    reasons.push("Rotation mode requires a size from 8 through 12 players.");
  }

  const alternatives = normalizeNonNegativeNumber(
    config.alternatives,
    3,
    "alternatives",
    reasons,
    true,
  );
  if (alternatives < 1) reasons.push("alternatives must be at least 1.");
  if (alternatives > MAX_EXACT_ALTERNATIVES) {
    reasons.push(`alternatives cannot exceed ${MAX_EXACT_ALTERNATIVES}.`);
  }

  const maxCombinations = normalizeNonNegativeNumber(
    config.maxCombinations,
    DEFAULT_MAX_EXACT_COMBINATIONS,
    "maxCombinations",
    reasons,
    true,
  );
  if (maxCombinations < 1) reasons.push("maxCombinations must be at least 1.");

  const minGames = normalizeNonNegativeNumber(config.minGames, 0, "minGames", reasons);
  const minMinutes = normalizeNonNegativeNumber(config.minMinutes, 0, "minMinutes", reasons);
  const lockedIds = normalizeIdList(config.lockedIds, "lockedIds", reasons);
  const excludedIds = normalizeIdList(config.excludedIds, "excludedIds", reasons);

  const positionMinimums = { G: 0, F: 0, C: 0 };
  if (config.positionMinimums !== undefined) {
    if (!isPlainObject(config.positionMinimums)) {
      reasons.push("positionMinimums must be an object with G, F, and C values.");
    } else {
      for (const key of Object.keys(config.positionMinimums)) {
        if (!POSITION_KEYS.includes(key)) {
          reasons.push(`positionMinimums contains an unsupported position: ${key}.`);
        }
      }
      for (const position of POSITION_KEYS) {
        positionMinimums[position] = normalizeNonNegativeNumber(
          config.positionMinimums[position],
          0,
          `positionMinimums.${position}`,
          reasons,
          true,
        );
      }
    }
  }
  const requiredPositionSlots = POSITION_KEYS.reduce(
    (total, position) => total + positionMinimums[position],
    0,
  );
  if (requiredPositionSlots > size) {
    reasons.push(
      `Position minimums require ${requiredPositionSlots} distinct players, more than the selected size of ${size}.`,
    );
  }

  const statMinimums = {};
  if (config.statMinimums !== undefined) {
    if (!isPlainObject(config.statMinimums)) {
      reasons.push("statMinimums must be an object of lineup total minimums.");
    } else {
      for (const key of Object.keys(config.statMinimums)) {
        if (!STAT_MINIMUM_KEYS.includes(key)) {
          reasons.push(`statMinimums contains an unsupported statistic: ${key}.`);
          continue;
        }
        statMinimums[key] = normalizeNonNegativeNumber(
          config.statMinimums[key],
          0,
          `statMinimums.${key}`,
          reasons,
        );
      }
    }
  }

  let maxTurnovers = Number.POSITIVE_INFINITY;
  if (config.maxTurnovers !== undefined && config.maxTurnovers !== null) {
    maxTurnovers = normalizeNonNegativeNumber(
      config.maxTurnovers,
      Number.POSITIVE_INFINITY,
      "maxTurnovers",
      reasons,
    );
  }

  const weights = Object.fromEntries(OBJECTIVE_METRICS.map((metric) => [metric, 0]));
  let presetName = "custom";
  const hasExplicitWeights = config.weights !== undefined;

  if (config.preset === undefined && !hasExplicitWeights) {
    Object.assign(weights, DEFAULT_PRESETS.balanced);
    presetName = "balanced";
  } else if (typeof config.preset === "string") {
    if (!hasOwn(DEFAULT_PRESETS, config.preset)) {
      reasons.push(
        `Unknown preset \"${config.preset}\". Choose one of: ${Object.keys(DEFAULT_PRESETS).join(", ")}.`,
      );
    } else {
      Object.assign(weights, DEFAULT_PRESETS[config.preset]);
      presetName = config.preset;
    }
  } else if (config.preset !== undefined && config.preset !== null) {
    copyMetricWeights(config.preset, weights, "preset", reasons);
  }

  if (hasExplicitWeights) {
    copyMetricWeights(config.weights, weights, "weights", reasons);
  }

  const weightTotal = OBJECTIVE_METRICS.reduce((total, metric) => total + weights[metric], 0);
  if (!(weightTotal > 0)) {
    reasons.push("At least one objective weight must be greater than zero.");
  }
  const normalizedWeights = Object.fromEntries(
    OBJECTIVE_METRICS.map((metric) => [metric, weightTotal > 0 ? weights[metric] / weightTotal : 0]),
  );

  let rotationOptions = config.rotationOptions ?? config.rotationMinutes ?? {};
  if (!isPlainObject(rotationOptions)) {
    reasons.push("rotationOptions must be an object when provided.");
    rotationOptions = {};
  }

  return {
    config: {
      mode,
      size,
      alternatives,
      maxCombinations,
      minGames,
      minMinutes,
      lockedIds,
      excludedIds,
      positionMinimums,
      statMinimums,
      maxTurnovers,
      weights,
      normalizedWeights,
      presetName,
      rotationOptions,
    },
    reasons,
  };
}

/**
 * Return percentile values in [0, 1], preserving average ranks for ties.
 * The worst value is 0 and the best is 1 (or every value is 1 for n=1).
 */
export function percentileNormalize(entries, { lowerIsBetter = false } = {}) {
  if (!Array.isArray(entries)) return new Map();
  const sorted = entries
    .map((entry) => ({ id: canonicalId(entry.id), value: Number(entry.value) }))
    .sort((left, right) => {
      if (left.value !== right.value) return left.value - right.value;
      return compareIds(left.id, right.id);
    });

  const percentiles = new Map();
  if (sorted.length === 0) return percentiles;
  if (sorted.length === 1) {
    percentiles.set(sorted[0].id, 1);
    return percentiles;
  }

  let index = 0;
  while (index < sorted.length) {
    let tieEnd = index;
    while (tieEnd + 1 < sorted.length && sorted[tieEnd + 1].value === sorted[index].value) {
      tieEnd += 1;
    }
    const averageRank = (index + tieEnd) / 2;
    const ascendingPercentile = averageRank / (sorted.length - 1);
    const percentile = lowerIsBetter ? 1 - ascendingPercentile : ascendingPercentile;
    for (let tieIndex = index; tieIndex <= tieEnd; tieIndex += 1) {
      percentiles.set(sorted[tieIndex].id, percentile);
    }
    index = tieEnd + 1;
  }

  return percentiles;
}

function buildNormalizedMetrics(players) {
  const byPlayerId = new Map(players.map((player) => [player.id, {}]));
  for (const metric of OBJECTIVE_METRICS) {
    const sourceField = metric === "ballSecurity" ? "turnovers" : metric;
    const percentiles = percentileNormalize(
      players.map((player) => ({ id: player.id, value: player[sourceField] })),
      { lowerIsBetter: metric === "ballSecurity" },
    );
    for (const player of players) {
      byPlayerId.get(player.id)[metric] = percentiles.get(player.id);
    }
  }
  return byPlayerId;
}

/**
 * Match required positional slots to distinct players. This prevents a flex
 * player (for example, G/F) from satisfying both minimums at the same time.
 */
export function findPositionAssignment(players, positionMinimums = {}) {
  const requirements = Object.fromEntries(
    POSITION_KEYS.map((position) => [position, Number(positionMinimums[position] ?? 0)]),
  );
  const slots = [];
  for (const position of POSITION_KEYS) {
    for (let count = 0; count < requirements[position]; count += 1) {
      slots.push({ position, ordinal: count });
    }
  }

  if (slots.length === 0) {
    return { feasible: true, assignment: { G: [], F: [], C: [] } };
  }
  if (slots.length > players.length) {
    return { feasible: false, assignment: null };
  }

  const candidatesByPosition = Object.fromEntries(
    POSITION_KEYS.map((position) => [
      position,
      players
        .filter((player) => player.positions.includes(position))
        .slice()
        .sort(comparePlayersById),
    ]),
  );
  slots.sort((left, right) => {
    const candidateDifference =
      candidatesByPosition[left.position].length - candidatesByPosition[right.position].length;
    if (candidateDifference !== 0) return candidateDifference;
    const positionDifference = compareIds(left.position, right.position);
    if (positionDifference !== 0) return positionDifference;
    return left.ordinal - right.ordinal;
  });

  const usedIds = new Set();
  const assigned = { G: [], F: [], C: [] };

  function match(slotIndex) {
    if (slotIndex === slots.length) return true;
    const { position } = slots[slotIndex];
    for (const player of candidatesByPosition[position]) {
      if (usedIds.has(player.id)) continue;
      usedIds.add(player.id);
      assigned[position].push(player.id);
      if (match(slotIndex + 1)) return true;
      assigned[position].pop();
      usedIds.delete(player.id);
    }
    return false;
  }

  if (!match(0)) return { feasible: false, assignment: null };
  for (const position of POSITION_KEYS) assigned[position].sort(compareIds);
  return { feasible: true, assignment: assigned };
}

function calculateLineupTotals(players) {
  const totals = {
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
  };
  for (const player of players) {
    totals.points += player.points;
    totals.rebounds += player.rebounds;
    totals.assists += player.assists;
    totals.steals += player.steals;
    totals.blocks += player.blocks;
    totals.turnovers += player.turnovers;
  }
  for (const field of Object.keys(totals)) totals[field] = round(totals[field]);
  return totals;
}

function calculateObjective(players, normalizedMetrics, rawWeights, normalizedWeights) {
  const contributionBreakdown = {};
  let rawScore = 0;

  for (const metric of OBJECTIVE_METRICS) {
    const averagePercentile =
      players.reduce((total, player) => total + normalizedMetrics.get(player.id)[metric], 0) /
      players.length;
    const scoreContribution = averagePercentile * normalizedWeights[metric] * 100;
    rawScore += scoreContribution;
    contributionBreakdown[metric] = {
      weight: rawWeights[metric],
      normalizedWeight: round(normalizedWeights[metric]),
      averagePercentile: round(averagePercentile),
      scoreContribution: round(scoreContribution),
    };
  }

  return {
    rawScore,
    score: round(rawScore),
    contributionBreakdown,
  };
}

function calculateObjectiveScore(players, playerObjectiveScores) {
  // Each player's weighted percentile contribution is independent of the rest
  // of the candidate. Summing the precomputed values preserves the exact score
  // ordering while removing repeated metric-by-metric reductions in the hot
  // combination loop.
  let scoreTotal = 0;
  for (const player of players) scoreTotal += playerObjectiveScores.get(player.id);
  return (scoreTotal / players.length) * 100;
}

function buildConstraintAudit(
  players,
  config,
  positionResult,
  totals,
  rotationAllocation = null,
) {
  const ids = players.map((player) => player.id);
  const idSet = new Set(ids);
  const statChecks = Object.fromEntries(
    Object.entries(config.statMinimums).map(([stat, required]) => [
      stat,
      { required, actual: totals[stat], passed: totals[stat] >= required },
    ]),
  );
  const statMinimumsPassed = Object.values(statChecks).every((check) => check.passed);

  return {
    exactSize: { required: config.size, actual: players.length, passed: players.length === config.size },
    lockedPlayers: {
      requiredIds: config.lockedIds.slice(),
      includedIds: config.lockedIds.filter((id) => idSet.has(id)),
      passed: config.lockedIds.every((id) => idSet.has(id)),
    },
    excludedPlayers: {
      excludedIds: config.excludedIds.slice(),
      includedIds: config.excludedIds.filter((id) => idSet.has(id)),
      passed: config.excludedIds.every((id) => !idSet.has(id)),
    },
    positionMinimums: {
      required: { ...config.positionMinimums },
      assignment: positionResult.assignment,
      passed: positionResult.feasible,
    },
    statMinimums: { checks: statChecks, passed: statMinimumsPassed },
    maxTurnovers: {
      maximum: Number.isFinite(config.maxTurnovers) ? config.maxTurnovers : null,
      actual: totals.turnovers,
      passed: totals.turnovers <= config.maxTurnovers,
    },
    ...(rotationAllocation
      ? {
          rotationMinutes: {
            required: 240,
            actual: rotationAllocation.totalMinutes,
            passed: rotationAllocation.ok && rotationAllocation.totalMinutes === 240,
          },
        }
      : {}),
  };
}

function getMapLikeValue(source, id) {
  if (source instanceof Map) return source.get(id);
  if (isPlainObject(source) && hasOwn(source, id)) return source[id];
  return undefined;
}

function getBoundValue(setting, id, fallback) {
  if (setting === undefined || setting === null) return fallback;
  if (typeof setting === "number" || typeof setting === "string") return Number(setting);
  const value = getMapLikeValue(setting, id);
  return value === undefined ? fallback : Number(value);
}

function isEmptyMapLike(value) {
  if (value === undefined || value === null) return true;
  if (value instanceof Map) return value.size === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function isUniformBoundSetting(value) {
  return value === undefined || value === null || typeof value === "number" || typeof value === "string" || isEmptyMapLike(value);
}

function hasValidSuppliedScores(value) {
  if (value === undefined || value === null) return true;
  const entries = value instanceof Map
    ? [...value.values()]
    : isPlainObject(value)
      ? Object.values(value)
      : [];
  return entries.every((entry) => Number.isFinite(Number(entry)) && Number(entry) >= 0);
}

function canDeferRotationAllocation(options) {
  // Uniform minute bounds have the same 240-minute feasibility for every
  // candidate with the same roster size. Validate that once, rank all groups,
  // then allocate only the finalists. Per-player bounds remain candidate
  // specific and deliberately stay on the slower but exact path.
  const scoreSource = options.scores ?? options.playerScores ?? options.weights;
  return (
    isEmptyMapLike(options.playerBounds) &&
    isUniformBoundSetting(options.minMinutes) &&
    isUniformBoundSetting(options.maxMinutes) &&
    hasValidSuppliedScores(scoreSource)
  );
}

function rotationFailure(reasons, diagnostics = {}) {
  return {
    ok: false,
    status: "infeasible",
    reason: reasons[0],
    reasons,
    totalMinutes: 0,
    allocations: [],
    byId: {},
    diagnostics,
  };
}

/**
 * Allocate exactly 240 integer minutes among 8-12 selected players.
 *
 * Options:
 * - minMinutes / maxMinutes: a scalar or an object/Map keyed by player id
 * - playerBounds: { [id]: { min, max } }, overriding the general bounds
 * - scores (alias playerScores/weights): object/Map used for proportional extras
 */
export function allocateRotationMinutes(players, options = {}) {
  const reasons = [];
  if (!Array.isArray(players)) {
    return rotationFailure(["Rotation players must be an array."]);
  }
  if (players.length < 8 || players.length > 12) {
    reasons.push("A rotation must contain from 8 through 12 selected players.");
  }
  if (!isPlainObject(options)) {
    reasons.push("Rotation options must be an object.");
    options = {};
  }

  const ids = [];
  const seen = new Set();
  for (const [index, player] of players.entries()) {
    const id = canonicalId(player?.id);
    if (!id) {
      reasons.push(`Rotation player ${index + 1} is missing a non-empty id.`);
    } else if (seen.has(id)) {
      reasons.push(`Rotation player id \"${id}\" is duplicated.`);
    } else {
      seen.add(id);
      ids.push(id);
    }
  }

  const defaultMin = options.minMinutes === undefined ? 8 : options.minMinutes;
  const defaultMax = options.maxMinutes === undefined ? 36 : options.maxMinutes;
  const boundsSource = isPlainObject(options.playerBounds) ? options.playerBounds : {};
  const scoreSource = options.scores ?? options.playerScores ?? options.weights;
  const bounds = new Map();
  const scores = new Map();

  for (const player of players) {
    const id = canonicalId(player?.id);
    if (!id) continue;
    const playerBounds = isPlainObject(boundsSource[id]) ? boundsSource[id] : {};
    const minimum = Number(
      playerBounds.min ?? playerBounds.minimum ?? getBoundValue(defaultMin, id, 8),
    );
    const maximum = Number(
      playerBounds.max ?? playerBounds.maximum ?? getBoundValue(defaultMax, id, 36),
    );
    if (!Number.isInteger(minimum) || minimum < 0) {
      reasons.push(`Minimum minutes for ${id} must be a non-negative integer.`);
    }
    if (!Number.isInteger(maximum) || maximum < 0) {
      reasons.push(`Maximum minutes for ${id} must be a non-negative integer.`);
    }
    if (Number.isInteger(minimum) && Number.isInteger(maximum) && minimum > maximum) {
      reasons.push(`Minimum minutes for ${id} cannot exceed its maximum minutes.`);
    }
    bounds.set(id, { min: minimum, max: maximum });

    const suppliedScore = getMapLikeValue(scoreSource, id);
    const fallbackScore = Number(player?.minutes) > 0 ? Number(player.minutes) : 1;
    const score = suppliedScore === undefined ? fallbackScore : Number(suppliedScore);
    if (!Number.isFinite(score) || score < 0) {
      reasons.push(`Rotation score for ${id} must be a non-negative number.`);
    }
    scores.set(id, score);
  }

  if (reasons.length > 0) {
    return rotationFailure(reasons, { selectedPlayers: players.length });
  }

  const sortedIds = ids.slice().sort(compareIds);
  const minimumTotal = sortedIds.reduce((total, id) => total + bounds.get(id).min, 0);
  const maximumTotal = sortedIds.reduce((total, id) => total + bounds.get(id).max, 0);
  if (minimumTotal > 240 || maximumTotal < 240) {
    const feasibilityReasons = [];
    if (minimumTotal > 240) {
      feasibilityReasons.push(
        `Player minimums total ${minimumTotal} minutes, which exceeds the required 240.`,
      );
    }
    if (maximumTotal < 240) {
      feasibilityReasons.push(
        `Player maximums total ${maximumTotal} minutes, which is below the required 240.`,
      );
    }
    return rotationFailure(feasibilityReasons, {
      selectedPlayers: players.length,
      minimumTotal,
      maximumTotal,
    });
  }

  const minutes = new Map(sortedIds.map((id) => [id, bounds.get(id).min]));
  const remainingCapacity = new Map(
    sortedIds.map((id) => [id, bounds.get(id).max - bounds.get(id).min]),
  );
  let remaining = 240 - minimumTotal;

  while (remaining > 0) {
    const active = sortedIds.filter((id) => remainingCapacity.get(id) > 0);
    if (active.length === 0) {
      return rotationFailure(["The available minute capacity cannot reach 240 minutes."], {
        selectedPlayers: players.length,
        minimumTotal,
        maximumTotal,
      });
    }

    const positiveScoreTotal = active.reduce(
      (total, id) => total + (scores.get(id) > 0 ? scores.get(id) : 0),
      0,
    );
    const effectiveScore = (id) => (positiveScoreTotal > 0 ? Math.max(0, scores.get(id)) : 1);
    const effectiveTotal = positiveScoreTotal > 0 ? positiveScoreTotal : active.length;
    const capped = active.filter(
      (id) => (remaining * effectiveScore(id)) / effectiveTotal >= remainingCapacity.get(id),
    );

    if (capped.length > 0) {
      for (const id of capped) {
        const addition = remainingCapacity.get(id);
        minutes.set(id, minutes.get(id) + addition);
        remainingCapacity.set(id, 0);
        remaining -= addition;
      }
      continue;
    }

    const shares = active.map((id) => {
      const raw = (remaining * effectiveScore(id)) / effectiveTotal;
      const whole = Math.floor(raw);
      return { id, raw, whole, fraction: raw - whole };
    });
    let distributed = 0;
    for (const share of shares) {
      if (share.whole <= 0) continue;
      minutes.set(share.id, minutes.get(share.id) + share.whole);
      remainingCapacity.set(share.id, remainingCapacity.get(share.id) - share.whole);
      distributed += share.whole;
    }
    remaining -= distributed;

    shares.sort((left, right) => {
      if (left.fraction !== right.fraction) return right.fraction - left.fraction;
      const scoreDifference = effectiveScore(right.id) - effectiveScore(left.id);
      if (scoreDifference !== 0) return scoreDifference;
      return compareIds(left.id, right.id);
    });
    for (const share of shares) {
      if (remaining === 0) break;
      if (remainingCapacity.get(share.id) <= 0) continue;
      minutes.set(share.id, minutes.get(share.id) + 1);
      remainingCapacity.set(share.id, remainingCapacity.get(share.id) - 1);
      remaining -= 1;
    }
  }

  const playerById = new Map(players.map((player) => [canonicalId(player.id), player]));
  const allocations = sortedIds.map((id) => ({
    id,
    name: String(playerById.get(id)?.name ?? id),
    minutes: minutes.get(id),
    minimum: bounds.get(id).min,
    maximum: bounds.get(id).max,
  }));
  const totalMinutes = allocations.reduce((total, allocation) => total + allocation.minutes, 0);

  return {
    ok: true,
    status: "success",
    totalMinutes,
    allocations,
    byId: Object.fromEntries(allocations.map((allocation) => [allocation.id, allocation.minutes])),
    diagnostics: {
      selectedPlayers: players.length,
      minimumTotal,
      maximumTotal,
    },
  };
}

function chooseCount(total, selected) {
  if (selected < 0 || selected > total) return 0;
  const smaller = Math.min(selected, total - selected);
  let result = 1;
  for (let index = 1; index <= smaller; index += 1) {
    result = (result * (total - smaller + index)) / index;
  }
  return Math.round(result);
}

function bestPossibleTotal(lockedPlayers, availablePlayers, slots, field, descending) {
  const lockedTotal = lockedPlayers.reduce((total, player) => total + player[field], 0);
  const values = availablePlayers
    .map((player) => player[field])
    .sort((left, right) => (descending ? right - left : left - right));
  return round(lockedTotal + values.slice(0, slots).reduce((total, value) => total + value, 0));
}

function alternativeSort(left, right) {
  if (Math.abs(left._rawScore - right._rawScore) > 1e-12) {
    return right._rawScore - left._rawScore;
  }
  return compareIds(left._tieKey, right._tieKey);
}

function insertTopAlternative(topAlternatives, candidate, limit) {
  // The candidate list is already score-sorted. Insert directly instead of
  // resorting the entire shortlist after every feasible combination; this is
  // especially important near the 200k browser-safe search ceiling.
  if (topAlternatives.length === limit && alternativeSort(candidate, topAlternatives.at(-1)) >= 0) return;
  const insertionIndex = topAlternatives.findIndex(
    (alternative) => alternativeSort(candidate, alternative) < 0,
  );
  if (insertionIndex === -1) topAlternatives.push(candidate);
  else topAlternatives.splice(insertionIndex, 0, candidate);
  if (topAlternatives.length > limit) topAlternatives.pop();
}

function mergePlayersById(left, right) {
  // Both inputs are already sorted by id. Merging keeps the deterministic
  // player order used for tie-breaking without allocating and sorting a fresh
  // combined array for every exact-search candidate.
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (comparePlayersById(left[leftIndex], right[rightIndex]) <= 0) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
    } else {
      merged.push(right[rightIndex]);
      rightIndex += 1;
    }
  }
  return merged.concat(left.slice(leftIndex), right.slice(rightIndex));
}

function failureResult(mode, size, reasons, diagnostics = {}) {
  return {
    ok: false,
    status: "infeasible",
    mode,
    size,
    reason: reasons[0],
    reasons,
    score: null,
    contributionBreakdown: null,
    constraintAudit: null,
    best: null,
    alternatives: [],
    combinationsEvaluated: diagnostics.combinationsEvaluated ?? 0,
    diagnostics: {
      combinationsEvaluated: 0,
      feasibleCombinations: 0,
      ...diagnostics,
    },
  };
}

function formatPositionMinimums(minimums) {
  return POSITION_KEYS.map((position) => `${position}: ${minimums[position]}`).join(", ");
}

/**
 * Exhaustively optimize a lineup or rotation from a single-team player pool.
 * Every combination is evaluated; no greedy selection is used.
 */
export function optimizeLineups(players, config = {}) {
  const normalizedPlayerResult = normalizePlayers(players);
  const normalizedConfigResult = normalizeConfig(config);
  const normalizedConfig = normalizedConfigResult.config;
  const initialReasons = [
    ...normalizedPlayerResult.reasons,
    ...normalizedConfigResult.reasons,
  ];
  const mode = normalizedConfig?.mode ?? (config?.mode ?? "lineup");
  const size = normalizedConfig?.size ?? (config?.size ?? (mode === "rotation" ? 10 : 5));

  if (initialReasons.length > 0 || !normalizedConfig) {
    return failureResult(mode, size, initialReasons, { category: "validation" });
  }

  const normalizedPlayers = normalizedPlayerResult.players;
  const playerById = new Map(normalizedPlayers.map((player) => [player.id, player]));
  const lockedSet = new Set(normalizedConfig.lockedIds);
  const excludedSet = new Set(normalizedConfig.excludedIds);
  const setupReasons = [];

  for (const id of normalizedConfig.lockedIds) {
    if (!playerById.has(id)) setupReasons.push(`Locked player \"${id}\" is not in the player pool.`);
    if (excludedSet.has(id)) setupReasons.push(`Player \"${id}\" cannot be both locked and excluded.`);
  }
  if (normalizedConfig.lockedIds.length > normalizedConfig.size) {
    setupReasons.push(
      `${normalizedConfig.lockedIds.length} locked players cannot fit in a lineup of ${normalizedConfig.size}.`,
    );
  }

  const eligibilityRejected = [];
  const eligiblePlayers = normalizedPlayers.filter((player) => {
    const rejectionReasons = [];
    if (excludedSet.has(player.id)) rejectionReasons.push("excluded");
    if (player.games < normalizedConfig.minGames) rejectionReasons.push("below minGames");
    if (player.minutes < normalizedConfig.minMinutes) rejectionReasons.push("below minMinutes");
    if (rejectionReasons.length > 0) {
      eligibilityRejected.push({ id: player.id, reasons: rejectionReasons });
      return false;
    }
    return true;
  });
  const eligibleById = new Map(eligiblePlayers.map((player) => [player.id, player]));

  for (const id of normalizedConfig.lockedIds) {
    if (playerById.has(id) && !eligibleById.has(id) && !excludedSet.has(id)) {
      const player = playerById.get(id);
      const details = [];
      if (player.games < normalizedConfig.minGames) details.push(`games ${player.games} < ${normalizedConfig.minGames}`);
      if (player.minutes < normalizedConfig.minMinutes) {
        details.push(`minutes ${player.minutes} < ${normalizedConfig.minMinutes}`);
      }
      setupReasons.push(`Locked player \"${id}\" is ineligible (${details.join(", ")}).`);
    }
  }

  if (eligiblePlayers.length < normalizedConfig.size) {
    setupReasons.push(
      `Only ${eligiblePlayers.length} eligible players remain for ${normalizedConfig.size} roster spots.`,
    );
  }

  const lockedPlayers = normalizedConfig.lockedIds
    .map((id) => eligibleById.get(id))
    .filter(Boolean)
    .sort(comparePlayersById);
  const availablePlayers = eligiblePlayers
    .filter((player) => !lockedSet.has(player.id))
    .sort(comparePlayersById);
  const slotsToChoose = normalizedConfig.size - lockedPlayers.length;

  if (slotsToChoose < 0 || slotsToChoose > availablePlayers.length) {
    if (!setupReasons.some((reason) => reason.includes("roster spots"))) {
      setupReasons.push("The locked and eligible player counts cannot fill the requested size.");
    }
  }

  if (setupReasons.length > 0) {
    return failureResult(mode, size, setupReasons, {
      category: "constraints",
      inputPlayers: normalizedPlayers.length,
      eligiblePlayers: eligiblePlayers.length,
      eligibilityRejected,
    });
  }

  const preflightReasons = [];
  const positionPoolCheck = findPositionAssignment(
    eligiblePlayers,
    normalizedConfig.positionMinimums,
  );
  if (!positionPoolCheck.feasible) {
    preflightReasons.push(
      `The eligible pool cannot fill the positional minimums with distinct players (${formatPositionMinimums(normalizedConfig.positionMinimums)}).`,
    );
  }

  for (const [stat, required] of Object.entries(normalizedConfig.statMinimums)) {
    const maximum = bestPossibleTotal(
      lockedPlayers,
      availablePlayers,
      slotsToChoose,
      stat,
      true,
    );
    if (maximum < required) {
      preflightReasons.push(
        `The highest possible ${stat} total is ${maximum}, below the required ${required}.`,
      );
    }
  }
  if (Number.isFinite(normalizedConfig.maxTurnovers)) {
    const minimum = bestPossibleTotal(
      lockedPlayers,
      availablePlayers,
      slotsToChoose,
      "turnovers",
      false,
    );
    if (minimum > normalizedConfig.maxTurnovers) {
      preflightReasons.push(
        `The lowest possible turnover total is ${minimum}, above the maximum ${normalizedConfig.maxTurnovers}.`,
      );
    }
  }

  const estimatedCombinations = chooseCount(availablePlayers.length, slotsToChoose);
  const baseDiagnostics = {
    inputPlayers: normalizedPlayers.length,
    eligiblePlayers: eligiblePlayers.length,
    lockedPlayers: lockedPlayers.length,
    availablePlayers: availablePlayers.length,
    eligibilityRejected,
    estimatedCombinations,
    maxCombinations: normalizedConfig.maxCombinations,
    requestedAlternatives: normalizedConfig.alternatives,
  };
  if (preflightReasons.length > 0) {
    return failureResult(mode, size, preflightReasons, {
      ...baseDiagnostics,
      category: "constraints",
    });
  }

  if (estimatedCombinations > normalizedConfig.maxCombinations) {
    return failureResult(mode, size, [
      `The exact solver would evaluate ${estimatedCombinations.toLocaleString()} combinations, above this page's ${normalizedConfig.maxCombinations.toLocaleString()} safe limit. Increase the minimum games or minutes filter, lock players, exclude players, or choose a smaller group.`,
    ], {
      ...baseDiagnostics,
      category: "performance",
    });
  }

  const normalizedMetrics = buildNormalizedMetrics(eligiblePlayers);
  const playerObjectiveScores = new Map(
    eligiblePlayers.map((player) => [
      player.id,
      OBJECTIVE_METRICS.reduce(
        (total, metric) =>
          total + normalizedMetrics.get(player.id)[metric] * normalizedConfig.normalizedWeights[metric],
        0,
      ),
    ]),
  );
  const callerRotationScores =
    normalizedConfig.rotationOptions.scores ??
    normalizedConfig.rotationOptions.playerScores ??
    normalizedConfig.rotationOptions.weights;
  const deferRotationAllocation =
    normalizedConfig.mode === "rotation" &&
    canDeferRotationAllocation(normalizedConfig.rotationOptions);
  let rotationAllocationsComputed = 0;
  let uniformRotationCheck = null;

  function rotationScoresFor(selectedPlayers) {
    return Object.fromEntries(
      selectedPlayers.map((player) => [player.id, playerObjectiveScores.get(player.id)]),
    );
  }

  function allocateSelectedRotation(selectedPlayers) {
    rotationAllocationsComputed += 1;
    return allocateRotationMinutes(selectedPlayers, {
      ...normalizedConfig.rotationOptions,
      scores: callerRotationScores ?? rotationScoresFor(selectedPlayers),
    });
  }

  if (deferRotationAllocation) {
    const samplePlayers = mergePlayersById(lockedPlayers, availablePlayers.slice(0, slotsToChoose));
    rotationAllocationsComputed += 1;
    uniformRotationCheck = allocateRotationMinutes(samplePlayers, {
      ...normalizedConfig.rotationOptions,
      scores: Object.fromEntries(samplePlayers.map((player) => [player.id, 1])),
    });
  }

  const topAlternatives = [];
  let combinationsEvaluated = 0;
  let feasibleCombinations = 0;
  const rejectedByConstraint = {
    positionMinimums: 0,
    statMinimums: Object.fromEntries(Object.keys(normalizedConfig.statMinimums).map((stat) => [stat, 0])),
    maxTurnovers: 0,
    rotationMinutes: 0,
  };
  const chosen = [];

  function evaluateCombination() {
    combinationsEvaluated += 1;
    const selectedPlayers = mergePlayersById(lockedPlayers, chosen);
    const positionResult = findPositionAssignment(
      selectedPlayers,
      normalizedConfig.positionMinimums,
    );
    const totals = calculateLineupTotals(selectedPlayers);
    let passed = true;

    if (!positionResult.feasible) {
      rejectedByConstraint.positionMinimums += 1;
      passed = false;
    }
    for (const [stat, required] of Object.entries(normalizedConfig.statMinimums)) {
      if (totals[stat] < required) {
        rejectedByConstraint.statMinimums[stat] += 1;
        passed = false;
      }
    }
    if (totals.turnovers > normalizedConfig.maxTurnovers) {
      rejectedByConstraint.maxTurnovers += 1;
      passed = false;
    }
    if (!passed) return;

    const rawScore = calculateObjectiveScore(selectedPlayers, playerObjectiveScores);
    let rotation = null;
    if (normalizedConfig.mode === "rotation") {
      if (deferRotationAllocation) {
        if (!uniformRotationCheck.ok) {
          rejectedByConstraint.rotationMinutes += 1;
          return;
        }
      } else {
        rotation = allocateSelectedRotation(selectedPlayers);
      }
      if (rotation && !rotation.ok) {
        rejectedByConstraint.rotationMinutes += 1;
        return;
      }
    }

    feasibleCombinations += 1;
    insertTopAlternative(
      topAlternatives,
      {
        _rawScore: rawScore,
        _tieKey: selectedPlayers.map((player) => player.id).join("\u0001"),
        players: selectedPlayers,
        totals,
        positionResult,
        rotation,
      },
      normalizedConfig.alternatives,
    );
  }

  function enumerate(startIndex, remainingSlots) {
    if (remainingSlots === 0) {
      evaluateCombination();
      return;
    }
    const lastStart = availablePlayers.length - remainingSlots;
    for (let index = startIndex; index <= lastStart; index += 1) {
      chosen.push(availablePlayers[index]);
      enumerate(index + 1, remainingSlots - 1);
      chosen.pop();
    }
  }

  enumerate(0, slotsToChoose);

  function buildDiagnostics() {
    return {
      ...baseDiagnostics,
      combinationsEvaluated,
      feasibleCombinations,
      rejectedByConstraint,
      ...(normalizedConfig.mode === "rotation"
        ? {
            rotationAllocationStrategy: deferRotationAllocation
              ? "deferred-uniform-bounds"
              : "per-candidate",
            rotationAllocationsComputed,
          }
        : {}),
    };
  }

  let diagnostics = buildDiagnostics();
  if (feasibleCombinations === 0) {
    const reasons = [
      `No feasible ${mode} was found after evaluating ${combinationsEvaluated} candidate combination${combinationsEvaluated === 1 ? "" : "s"}.`,
    ];
    if (rejectedByConstraint.positionMinimums > 0) {
      reasons.push(
        `${rejectedByConstraint.positionMinimums} candidate combination${rejectedByConstraint.positionMinimums === 1 ? "" : "s"} failed the positional minimums (${formatPositionMinimums(normalizedConfig.positionMinimums)}).`,
      );
    }
    for (const [stat, count] of Object.entries(rejectedByConstraint.statMinimums)) {
      if (count > 0) {
        reasons.push(`${count} candidate combination${count === 1 ? "" : "s"} fell below the ${stat} minimum.`);
      }
    }
    if (rejectedByConstraint.maxTurnovers > 0) {
      reasons.push(
        `${rejectedByConstraint.maxTurnovers} candidate combination${rejectedByConstraint.maxTurnovers === 1 ? "" : "s"} exceeded the turnover maximum.`,
      );
    }
    if (rejectedByConstraint.rotationMinutes > 0) {
      reasons.push(
        `${rejectedByConstraint.rotationMinutes} candidate rotation${rejectedByConstraint.rotationMinutes === 1 ? "" : "s"} could not be allocated exactly 240 minutes within the configured bounds.`,
      );
    }
    return failureResult(mode, size, reasons, diagnostics);
  }

  const alternatives = [];
  for (const [index, alternative] of topAlternatives.entries()) {
    let rotation = alternative.rotation;
    if (normalizedConfig.mode === "rotation" && !rotation) {
      rotation = allocateSelectedRotation(alternative.players);
      if (!rotation.ok) {
        diagnostics = buildDiagnostics();
        return failureResult(mode, size, [
          "A finalist rotation could not be allocated after passing the uniform-bound feasibility check.",
        ], {
          ...diagnostics,
          category: "rotation-allocation",
        });
      }
    }
    const objective = calculateObjective(
      alternative.players,
      normalizedMetrics,
      normalizedConfig.weights,
      normalizedConfig.normalizedWeights,
    );
    const constraintAudit = buildConstraintAudit(
      alternative.players,
      normalizedConfig,
      alternative.positionResult,
      alternative.totals,
      rotation,
    );
    alternatives.push({
      rank: index + 1,
      playerIds: alternative.players.map((player) => player.id),
      players: alternative.players,
      score: objective.score,
      contributionBreakdown: objective.contributionBreakdown,
      totals: alternative.totals,
      positionAssignment: alternative.positionResult.assignment,
      constraintAudit,
      ...(rotation ? { rotation } : {}),
    });
  }
  diagnostics = buildDiagnostics();
  const best = alternatives[0];

  return {
    ok: true,
    status: "success",
    mode: normalizedConfig.mode,
    size: normalizedConfig.size,
    preset: normalizedConfig.presetName,
    weights: { ...normalizedConfig.weights },
    score: best.score,
    contributionBreakdown: best.contributionBreakdown,
    constraintAudit: best.constraintAudit,
    best,
    alternatives,
    combinationsEvaluated,
    diagnostics,
  };
}
