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

// Counting stats and turnovers arrive in the source-neutral player shape as
// per-game values. A rotation, however, is a proposed 240-minute game plan.
// Ranking its minute allocation from raw per-game totals would reward a player
// simply for having received more historical minutes. These are the objective
// metrics that can be safely converted to a common per-36-minute opportunity
// basis. Shooting percentages are already rate statistics, so they remain
// untouched under every scoring basis.
const RATE_NORMALIZED_OBJECTIVE_METRICS = new Set([
  "points",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "ballSecurity",
]);

// Rotation mode uses this basis unless a caller deliberately requests the
// legacy per-game comparison. Keeping the value public makes the API contract
// discoverable to applications that surface a model explanation to fans.
export const DEFAULT_ROTATION_SCORING_BASIS = "per36";
const ROTATION_SCORING_BASES = Object.freeze({
  PER_36: "per36",
  PER_GAME: "perGame",
});

// A rate-based score answers which profiles best match a game plan. It does
// not, by itself, answer how a real team would distribute 240 minutes among
// those profiles. Historical-aware plans use recorded team-stint workload as
// a visible guardrail; open what-if plans preserve the unrestricted original
// experiment for users who deliberately want to ignore historical usage.
export const DEFAULT_ROTATION_MINUTE_PLAN = "historicalAware";
const ROTATION_MINUTE_PLANS = Object.freeze({
  HISTORICAL_AWARE: "historicalAware",
  OPEN_WHAT_IF: "openWhatIf",
});
export const DEFAULT_ROTATION_MINUTE_FLEXIBILITY = 8;

// Per-36 removes opportunity bias but a 150-minute rate is still much less
// certain than a 2,000-minute rate. Where the data adapter provides a same
// season/phase baseline and the appropriate raw sample, blend the observed
// rate toward that baseline. This is deliberately a stability adjustment,
// not an all-in-one player-impact estimate.
export const DEFAULT_ROTATION_RATE_STABILITY = "sampleAdjusted";
const ROTATION_RATE_STABILITY_MODES = Object.freeze({
  SAMPLE_ADJUSTED: "sampleAdjusted",
  RAW: "raw",
});
const RATE_STABILITY_PRIOR_MINUTES = 600;
const RATE_STABILITY_PRIOR_FIELD_GOAL_ATTEMPTS = 500;
const RATE_STABILITY_PRIOR_THREE_POINT_ATTEMPTS = 180;

const POSITION_KEYS = Object.freeze(["G", "F", "C"]);
// A regulation NBA game contains five simultaneous court roles for 48 minutes:
// two guard roles, two forward roles, and one center role. Rotation roster
// minimums answer "how many players of each type must I select?"; these minute
// requirements answer the separate and stricter question "can those players
// actually cover every role for the entire game within their minute limits?"
export const STANDARD_POSITION_MINUTES = Object.freeze({ G: 96, F: 96, C: 48 });
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
// Rotation candidates are substantially more expensive than five-player
// lineups because each one also solves an integer G/F/C minute-flow problem.
// A separate default keeps accepted browser work below the Worker's 30-second
// timeout on realistic mixed-position pools. Browser benchmarking put 24,310
// all-flex candidates beyond that watchdog, while 6,435 stayed comfortably
// below it; 10,000 leaves a practical margin. Callers may still choose a lower
// explicit cap for constrained devices.
export const DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS = 10000;
// A constrained minute state costs roughly 0.4 ms on the slow path observed in
// browser QA. This solve-wide ceiling leaves substantial room below the
// Worker's 30-second watchdog even when several candidate rosters are hard.
export const DEFAULT_MAX_CONSTRAINED_SOLVE_STATES = 10000;
export const MAX_CONSTRAINED_SOLVE_STATES = 15000;
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

/**
 * Normalize the scoring basis used only for the model's rotation objective.
 *
 * `per36` compares counting production after putting every player on the same
 * 36-minute opportunity scale. `perGame` is an explicit compatibility escape
 * hatch for callers that intentionally want the old raw per-game comparison.
 * It does not change projected team totals: those are always calculated from
 * the source per-minute rate and the allocated minutes.
 */
function normalizeRotationScoringBasis(value, reasons) {
  if (value === undefined || value === null) return DEFAULT_ROTATION_SCORING_BASIS;

  const compact = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "per36") return ROTATION_SCORING_BASES.PER_36;
  if (compact === "pergame") return ROTATION_SCORING_BASES.PER_GAME;

  reasons.push(
    'rotationOptions.scoringBasis must be either "per36" (the default rate-based model) or "perGame".',
  );
  return DEFAULT_ROTATION_SCORING_BASIS;
}

/** Normalize the user-visible policy that governs proposed rotation minutes. */
function normalizeRotationMinutePlan(value, reasons) {
  if (value === undefined || value === null) return DEFAULT_ROTATION_MINUTE_PLAN;
  const compact = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "historicalaware" || compact === "historical") {
    return ROTATION_MINUTE_PLANS.HISTORICAL_AWARE;
  }
  if (compact === "openwhatif" || compact === "open") {
    return ROTATION_MINUTE_PLANS.OPEN_WHAT_IF;
  }
  reasons.push(
    'rotationOptions.minutePlan must be either "historicalAware" (the default) or "openWhatIf".',
  );
  return DEFAULT_ROTATION_MINUTE_PLAN;
}

/**
 * Normalize the optional evidence correction used before per-36 percentile
 * ranking. `raw` keeps a deliberately unadjusted comparison for historical
 * experiments; `sampleAdjusted` is the safer default when source evidence is
 * available.
 */
function normalizeRotationRateStability(value, reasons) {
  if (value === undefined || value === null) return DEFAULT_ROTATION_RATE_STABILITY;
  const compact = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "sampleadjusted" || compact === "stabilized") {
    return ROTATION_RATE_STABILITY_MODES.SAMPLE_ADJUSTED;
  }
  if (compact === "raw") return ROTATION_RATE_STABILITY_MODES.RAW;
  reasons.push(
    'rotationOptions.rateStability must be either "sampleAdjusted" (the default) or "raw".',
  );
  return DEFAULT_ROTATION_RATE_STABILITY;
}

/**
 * The core already proves arbitrary integer G/F/C minute requirements. Keep
 * the validation here as well so the exact search, its diagnostics, and the
 * UI all use one normalized court-shape contract.
 */
function normalizeRotationPositionMinuteRequirements(value, reasons) {
  if (value === undefined || value === null) return { ...STANDARD_POSITION_MINUTES };
  if (!isPlainObject(value)) {
    reasons.push("rotationOptions.positionMinuteRequirements must be an object with G, F, and C values.");
    return { ...STANDARD_POSITION_MINUTES };
  }
  const requirements = { G: 0, F: 0, C: 0 };
  for (const key of Object.keys(value)) {
    if (!POSITION_KEYS.includes(key)) {
      reasons.push(`rotationOptions.positionMinuteRequirements contains an unsupported position: ${key}.`);
    }
  }
  for (const position of POSITION_KEYS) {
    requirements[position] = normalizeNonNegativeNumber(
      value[position],
      0,
      `rotationOptions.positionMinuteRequirements.${position}`,
      reasons,
      true,
    );
  }
  const total = POSITION_KEYS.reduce((sum, position) => sum + requirements[position], 0);
  if (total !== 240) {
    reasons.push(
      `rotationOptions.positionMinuteRequirements must total 240, but total ${total}.`,
    );
  }
  return requirements;
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
    mode === "rotation"
      ? DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS
      : DEFAULT_MAX_EXACT_COMBINATIONS,
    "maxCombinations",
    reasons,
    true,
  );
  if (maxCombinations < 1) reasons.push("maxCombinations must be at least 1.");
  const maxConstraintSearchStates = normalizeNonNegativeNumber(
    config.maxConstraintSearchStates,
    DEFAULT_MAX_CONSTRAINED_SOLVE_STATES,
    "maxConstraintSearchStates",
    reasons,
    true,
  );
  if (maxConstraintSearchStates < 1) {
    reasons.push("maxConstraintSearchStates must be at least 1.");
  }
  if (maxConstraintSearchStates > MAX_CONSTRAINED_SOLVE_STATES) {
    reasons.push(
      `maxConstraintSearchStates cannot exceed the browser-safe limit of ${MAX_CONSTRAINED_SOLVE_STATES}.`,
    );
  }

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
        const minimum = normalizeNonNegativeNumber(
          config.statMinimums[key],
          0,
          `statMinimums.${key}`,
          reasons,
        );
        // Player box-score values are validated non-negative, so a zero lower
        // bound is mathematically vacuous. Dropping it avoids activating the
        // expensive constrained-minute path for a no-op UI field.
        if (minimum > 0) statMinimums[key] = minimum;
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
  const rotationScoringBasis = normalizeRotationScoringBasis(
    rotationOptions.scoringBasis,
    reasons,
  );
  const rotationMinutePlan = normalizeRotationMinutePlan(rotationOptions.minutePlan, reasons);
  const rotationRateStability = normalizeRotationRateStability(
    rotationOptions.rateStability,
    reasons,
  );
  const rotationMinuteFlexibility = normalizeNonNegativeNumber(
    rotationOptions.minuteFlexibility,
    DEFAULT_ROTATION_MINUTE_FLEXIBILITY,
    "rotationOptions.minuteFlexibility",
    reasons,
    true,
  );
  if (rotationMinuteFlexibility > 48) {
    reasons.push("rotationOptions.minuteFlexibility cannot exceed 48 minutes.");
  }
  const rotationPositionMinuteRequirements = normalizeRotationPositionMinuteRequirements(
    rotationOptions.positionMinuteRequirements,
    reasons,
  );

  return {
    config: {
      mode,
      size,
      alternatives,
      maxCombinations,
      maxConstraintSearchStates,
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
      rotationScoringBasis,
      rotationMinutePlan,
      rotationRateStability,
      rotationMinuteFlexibility,
      rotationPositionMinuteRequirements,
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

/**
 * Return the value used to rank one objective metric before percentile
 * normalization. The source player shape deliberately retains per-game box
 * score values because those are the natural unit for a historical stat line
 * and for projected team totals. Rotation selection needs a different view:
 * a player who scored 12 points in 16 minutes was not a worse scorer than one
 * who scored 15 in 32 minutes merely because the latter received more court
 * time. Per-36 keeps counting metrics comparable while leaving efficiency
 * percentages as the source rate.
 *
 * A zero-minute row cannot yield a meaningful rate. Assigning it a zero value
 * is conservative and, importantly, avoids turning a data-quality issue into
 * an infinite score or an artificial minute-allocation priority.
 */
function objectiveMetricValue(player, metric, scoringBasis) {
  const sourceField = metric === "ballSecurity" ? "turnovers" : metric;
  const sourceValue = Number(player[sourceField]);
  if (
    scoringBasis !== ROTATION_SCORING_BASES.PER_36 ||
    !RATE_NORMALIZED_OBJECTIVE_METRICS.has(metric)
  ) {
    return sourceValue;
  }

  const sourceMinutes = Number(player.minutes);
  if (!(sourceMinutes > 0)) return 0;
  return (sourceValue / sourceMinutes) * 36;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Locate the evidence needed to shrink a per-36 rate toward a published
 * same-season baseline. The adapter deliberately keeps this metadata outside
 * the optimizer's canonical player schema, so CSV/demo callers remain fully
 * supported and simply retain raw rate ranking when the evidence is absent.
 */
function rateStabilityEvidence(player, metric) {
  const analytics = isPlainObject(player?.analytics) ? player.analytics : null;
  const totals = isPlainObject(analytics?.totals) ? analytics.totals : null;
  const baseline = isPlainObject(analytics?.leaguePer36) ? analytics.leaguePer36 : null;
  if (!totals || !baseline) return null;

  if (metric === "efgPct") {
    const sample = finiteNonNegative(totals.fieldGoalsAttempted);
    const reference = finiteNonNegative(baseline.efgPct);
    if (sample === null || reference === null) return null;
    return {
      sample,
      prior: RATE_STABILITY_PRIOR_FIELD_GOAL_ATTEMPTS,
      baseline: reference,
      denominator: "field-goal attempts",
    };
  }
  if (metric === "threePct") {
    const sample = finiteNonNegative(totals.threePointFieldGoalsAttempted);
    const reference = finiteNonNegative(baseline.threePct);
    if (sample === null || reference === null) return null;
    return {
      sample,
      prior: RATE_STABILITY_PRIOR_THREE_POINT_ATTEMPTS,
      baseline: reference,
      denominator: "three-point attempts",
    };
  }

  const baselineMetric = metric === "ballSecurity" ? "turnovers" : metric;
  const sample = finiteNonNegative(totals.minutes);
  const reference = finiteNonNegative(baseline[baselineMetric]);
  if (sample === null || reference === null) return null;
  return {
    sample,
    prior: RATE_STABILITY_PRIOR_MINUTES,
    baseline: reference,
    denominator: "total minutes",
  };
}

/**
 * Apply a conservative empirical-Bayes-style blend only when all of its
 * inputs are actually supplied by the current source. It intentionally does
 * not fabricate a baseline for imported CSVs or older incomplete rows.
 */
function stabilizedObjectiveMetricValue(player, metric, scoringBasis, rateStability) {
  const raw = objectiveMetricValue(player, metric, scoringBasis);
  if (
    scoringBasis !== ROTATION_SCORING_BASES.PER_36 ||
    rateStability !== ROTATION_RATE_STABILITY_MODES.SAMPLE_ADJUSTED
  ) {
    return { value: raw, adjusted: false };
  }
  const evidence = rateStabilityEvidence(player, metric);
  if (!evidence || !(evidence.sample > 0) || !(evidence.prior > 0)) {
    return { value: raw, adjusted: false };
  }
  const reliability = evidence.sample / (evidence.sample + evidence.prior);
  return {
    value: evidence.baseline + (reliability * (raw - evidence.baseline)),
    adjusted: true,
    reliability,
    denominator: evidence.denominator,
  };
}

function buildNormalizedMetrics(
  players,
  {
    scoringBasis = ROTATION_SCORING_BASES.PER_GAME,
    rateStability = ROTATION_RATE_STABILITY_MODES.RAW,
  } = {},
) {
  const byPlayerId = new Map(players.map((player) => [player.id, {}]));
  const adjustedPlayerIds = new Set();
  let adjustedPlayerMetricCount = 0;
  for (const metric of OBJECTIVE_METRICS) {
    const measured = players.map((player) => {
      const value = stabilizedObjectiveMetricValue(
        player,
        metric,
        scoringBasis,
        rateStability,
      );
      if (value.adjusted) {
        adjustedPlayerIds.add(player.id);
        adjustedPlayerMetricCount += 1;
      }
      return { id: player.id, value: value.value };
    });
    const percentiles = percentileNormalize(
      measured,
      { lowerIsBetter: metric === "ballSecurity" },
    );
    for (const player of players) {
      byPlayerId.get(player.id)[metric] = percentiles.get(player.id);
    }
  }
  return {
    metrics: byPlayerId,
    rateStability: {
      requested: rateStability,
      applied: adjustedPlayerMetricCount > 0,
      adjustedPlayers: adjustedPlayerIds.size,
      adjustedPlayerMetricCount,
      eligiblePlayers: players.length,
      // Per-game is intentionally a compatibility mode. Presenting raw values
      // as sample-adjusted in that branch would mix unlike units.
      reason:
        scoringBasis !== ROTATION_SCORING_BASES.PER_36
          ? "Rate stabilization applies only to the per-36 rotation basis."
          : rateStability === ROTATION_RATE_STABILITY_MODES.RAW
            ? "Rate stabilization was disabled for this result, so the model used raw per-36 rates."
            : adjustedPlayerMetricCount > 0
              ? null
              : "The current player source does not include enough same-season rate evidence to stabilize the selected metrics.",
    },
  };
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

/**
 * Project full-team box-score totals from a 240-minute rotation plan.
 *
 * Basketball Reference supplies per-game production and minutes per game. A
 * player's historical per-minute rate is therefore `stat / minutes`; applying
 * that rate to the proposed allocation makes rotation thresholds describe the
 * minutes that will actually be played. This calculation deliberately stays
 * in source-rate units even when rotation scoring uses per-36 values: per-36
 * is a ranking basis, not a second multiplier for a projected box score. A
 * zero-minute source row contributes zero rather than manufacturing an
 * undefined rate.
 */
function calculateRotationTotals(players, rotationAllocation) {
  const totals = {
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
  };

  for (const player of players) {
    const sourceMinutes = Number(player.minutes);
    const allocatedMinutes = Number(rotationAllocation.byId[player.id] ?? 0);
    const scale = sourceMinutes > 0 ? allocatedMinutes / sourceMinutes : 0;
    for (const field of Object.keys(totals)) totals[field] += player[field] * scale;
  }
  for (const field of Object.keys(totals)) totals[field] = round(totals[field]);
  return totals;
}

function objectiveShare(playerId, players, rotationAllocation) {
  if (!rotationAllocation) return 1 / players.length;
  // All successful rotation plans contain exactly 240 minutes. Dividing by the
  // returned total keeps this helper defensive if it is used with a diagnostic
  // allocation in the future.
  return Number(rotationAllocation.byId[playerId] ?? 0) / rotationAllocation.totalMinutes;
}

function calculateObjective(
  players,
  normalizedMetrics,
  rawWeights,
  normalizedWeights,
  rotationAllocation = null,
) {
  const contributionBreakdown = {};
  // Keep the group-level breakdown for the existing UI, while also retaining
  // the additive player-level evidence a fan report needs to explain why a
  // specific player belongs in this exact result. Every player contribution is
  // measured on the same objective scale and the player totals reconcile to
  // the displayed fit score (subject only to display rounding).
  const playerContributions = Object.fromEntries(players.map((player) => [
    player.id,
    { scoreContribution: 0, metrics: {} },
  ]));
  let rawScore = 0;

  for (const metric of OBJECTIVE_METRICS) {
    const averagePercentile = rotationAllocation
      ? players.reduce(
          (total, player) =>
            total +
            normalizedMetrics.get(player.id)[metric] *
              objectiveShare(player.id, players, rotationAllocation),
          0,
        )
      : players.reduce(
          (total, player) => total + normalizedMetrics.get(player.id)[metric],
          0,
        ) / players.length;
    const scoreContribution = averagePercentile * normalizedWeights[metric] * 100;
    rawScore += scoreContribution;
    for (const player of players) {
      const percentile = normalizedMetrics.get(player.id)[metric];
      const share = rotationAllocation
        ? objectiveShare(player.id, players, rotationAllocation)
        : 1 / players.length;
      const playerScoreContribution = percentile * normalizedWeights[metric] * 100 * share;
      const playerEntry = playerContributions[player.id];
      playerEntry.metrics[metric] = {
        percentile: round(percentile),
        scoreContribution: round(playerScoreContribution),
      };
      playerEntry.scoreContribution += playerScoreContribution;
    }
    contributionBreakdown[metric] = {
      weight: rawWeights[metric],
      normalizedWeight: round(normalizedWeights[metric]),
      // Keep the established key for browser compatibility. In rotation mode
      // it is now a minute-weighted percentile, while lineup mode remains the
      // original equal-player average.
      averagePercentile: round(averagePercentile),
      ...(rotationAllocation
        ? { minuteWeightedPercentile: round(averagePercentile) }
        : {}),
      scoreContribution: round(scoreContribution),
    };
  }

  return {
    rawScore,
    score: round(rawScore),
    contributionBreakdown,
    playerContributions: Object.fromEntries(
      Object.entries(playerContributions).map(([id, detail]) => [
        id,
        { ...detail, scoreContribution: round(detail.scoreContribution) },
      ]),
    ),
  };
}

function calculateObjectiveScore(players, playerObjectiveScores, rotationAllocation = null) {
  // Each player's weighted percentile contribution is independent of the rest
  // of the candidate. Lineup mode keeps the original equal-player average;
  // rotation mode weights that same pool-relative fit by the minutes the player
  // will actually be on the court.
  if (!rotationAllocation) {
    let scoreTotal = 0;
    for (const player of players) scoreTotal += playerObjectiveScores.get(player.id);
    return (scoreTotal / players.length) * 100;
  }
  let scoreTotal = 0;
  for (const player of players) {
    scoreTotal +=
      playerObjectiveScores.get(player.id) *
      objectiveShare(player.id, players, rotationAllocation);
  }
  return scoreTotal * 100;
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
          ...(rotationAllocation.positionMinutes?.enforced
            ? {
                rotationPositionMinutes: {
                  required: { ...rotationAllocation.positionMinutes.required },
                  actual: { ...rotationAllocation.positionMinutes.actual },
                  byPlayer: rotationAllocation.positionMinutes.byPlayer,
                  passed: rotationAllocation.positionMinutes.passed,
                },
              }
            : {}),
        }
      : {}),
  };
}

function getMapLikeValue(source, id, label = "Map option", reasons = null) {
  if (source instanceof Map) {
    const canonical = canonicalId(id);
    let found = false;
    let value;

    // Public callers are allowed to use the same numeric ids present in their
    // player objects as Map keys. Internal player ids are canonical strings,
    // however, so first honor an exact canonical-string key and then look for
    // one equivalent raw key (for example, numeric 8 matching string "8").
    // Two equivalent keys would make precedence data-dependent, so reject that
    // input instead of silently choosing one and optimizing the wrong bounds.
    if (source.has(canonical)) {
      found = true;
      value = source.get(canonical);
    }
    for (const [rawKey, candidate] of source.entries()) {
      if (rawKey === canonical || canonicalId(rawKey) !== canonical) continue;
      if (found) {
        if (Array.isArray(reasons)) {
          reasons.push(
            `${label} contains multiple Map keys that normalize to player id "${canonical}".`,
          );
        }
        return undefined;
      }
      found = true;
      value = candidate;
    }
    return found ? value : undefined;
  }
  if (isPlainObject(source) && hasOwn(source, id)) return source[id];
  return undefined;
}

function getBoundValue(setting, id, fallback, label, reasons) {
  if (setting === undefined || setting === null) return fallback;
  if (typeof setting === "number" || typeof setting === "string") return Number(setting);
  const value = getMapLikeValue(setting, id, label, reasons);
  return value === undefined ? fallback : Number(value);
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
 * A compact Dinic max-flow implementation used only for rotation role minutes.
 * Capacities are tiny integers (at most 240), so this gives us a transparent,
 * dependency-free feasibility proof instead of position heuristics that can
 * double-count flex players.
 */
function createFlowNetwork(nodeCount) {
  const graph = Array.from({ length: nodeCount }, () => []);

  function addEdge(from, to, capacity) {
    const forward = {
      to,
      reverseIndex: graph[to].length,
      capacity,
      initialCapacity: capacity,
    };
    const reverse = {
      to: from,
      reverseIndex: graph[from].length,
      capacity: 0,
      initialCapacity: 0,
    };
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
  }

  function maxFlow(source, sink) {
    let total = 0;
    while (true) {
      const level = Array(nodeCount).fill(-1);
      const queue = [source];
      level[source] = 0;
      for (let index = 0; index < queue.length; index += 1) {
        const node = queue[index];
        for (const edge of graph[node]) {
          if (edge.capacity <= 0 || level[edge.to] !== -1) continue;
          level[edge.to] = level[node] + 1;
          queue.push(edge.to);
        }
      }
      if (level[sink] === -1) break;

      const nextEdge = Array(nodeCount).fill(0);
      function send(node, available) {
        if (node === sink) return available;
        for (; nextEdge[node] < graph[node].length; nextEdge[node] += 1) {
          const edge = graph[node][nextEdge[node]];
          if (edge.capacity <= 0 || level[edge.to] !== level[node] + 1) continue;
          const delivered = send(edge.to, Math.min(available, edge.capacity));
          if (delivered <= 0) continue;
          edge.capacity -= delivered;
          graph[edge.to][edge.reverseIndex].capacity += delivered;
          return delivered;
        }
        return 0;
      }

      while (true) {
        const delivered = send(source, Number.POSITIVE_INFINITY);
        if (delivered <= 0) break;
        total += delivered;
      }
    }
    return total;
  }

  return { addEdge, maxFlow };
}

/**
 * Solve the integer b-matching between players and G/F/C role minutes.
 *
 * The source-to-player lower and upper bounds enforce each player's total
 * minute range. Player-to-role edges allow only source-listed positions, and
 * each role has an exact demand. Lower bounds are converted to an ordinary
 * circulation with a super-source/super-sink; integral capacities guarantee an
 * integral result, so no rounding can create a fake feasible plan.
 */
function everyPlayerCoversRequiredPositions(players, requirements) {
  const requiredPositions = POSITION_KEYS.filter((position) => requirements[position] > 0);
  return players.every(
    (player) =>
      Array.isArray(player.positions) &&
      requiredPositions.every((position) => player.positions.includes(position)),
  );
}

function buildUniversalPositionFlow(players, bounds, requirements) {
  const sortedPlayers = players.slice().sort(comparePlayersById);
  const totalRequired = POSITION_KEYS.reduce(
    (total, position) => total + requirements[position],
    0,
  );
  const minimumTotal = sortedPlayers.reduce(
    (total, player) => total + bounds.get(player.id).min,
    0,
  );
  const maximumTotal = sortedPlayers.reduce(
    (total, player) => total + bounds.get(player.id).max,
    0,
  );
  if (minimumTotal > totalRequired || maximumTotal < totalRequired) {
    return { feasible: false, required: { ...requirements }, delivered: 0, balanceDemand: totalRequired };
  }

  const totalsByPlayer = Object.fromEntries(
    sortedPlayers.map((player) => [player.id, bounds.get(player.id).min]),
  );
  let remaining = totalRequired - minimumTotal;
  for (const player of sortedPlayers) {
    const capacity = bounds.get(player.id).max - totalsByPlayer[player.id];
    const addition = Math.min(capacity, remaining);
    totalsByPlayer[player.id] += addition;
    remaining -= addition;
    if (remaining === 0) break;
  }

  const remainingByPosition = { ...requirements };
  const byPlayer = {};
  for (const player of sortedPlayers) {
    let playerMinutes = totalsByPlayer[player.id];
    const roleMinutes = { G: 0, F: 0, C: 0 };
    for (const position of POSITION_KEYS) {
      const assigned = Math.min(playerMinutes, remainingByPosition[position]);
      roleMinutes[position] = assigned;
      remainingByPosition[position] -= assigned;
      playerMinutes -= assigned;
    }
    byPlayer[player.id] = roleMinutes;
  }
  const actual = Object.fromEntries(
    POSITION_KEYS.map((position) => [position, requirements[position] - remainingByPosition[position]]),
  );
  return {
    feasible:
      remaining === 0 &&
      POSITION_KEYS.every((position) => remainingByPosition[position] === 0),
    required: { ...requirements },
    actual,
    byPlayer,
    totalsByPlayer,
    delivered: totalRequired,
    balanceDemand: totalRequired,
  };
}

function findPositionMinuteFlow(players, bounds, requirements) {
  // All-flex test pools and real multi-position groups need no augmenting-path
  // work: every feasible total-minute vector can be split across every role.
  // This exact shortcut is important because the combination solver may invoke
  // this oracle thousands of times.
  if (everyPlayerCoversRequiredPositions(players, requirements)) {
    return buildUniversalPositionFlow(players, bounds, requirements);
  }
  const sortedPlayers = players.slice().sort(comparePlayersById);
  const playerStart = 1;
  const positionStart = playerStart + sortedPlayers.length;
  const source = 0;
  const sink = positionStart + POSITION_KEYS.length;
  const superSource = sink + 1;
  const superSink = sink + 2;
  const nodeCount = superSink + 1;
  const network = createFlowNetwork(nodeCount);
  const balances = Array(nodeCount).fill(0);
  const roleEdges = new Map();
  const totalRequired = POSITION_KEYS.reduce(
    (total, position) => total + requirements[position],
    0,
  );

  function addBoundedEdge(from, to, lower, upper) {
    const edge = network.addEdge(from, to, upper - lower);
    balances[from] -= lower;
    balances[to] += lower;
    return { edge, lower };
  }

  sortedPlayers.forEach((player, index) => {
    const playerNode = playerStart + index;
    const playerBounds = bounds.get(player.id);
    addBoundedEdge(source, playerNode, playerBounds.min, playerBounds.max);
    const edges = new Map();
    // optimizeLineups supplies normalized position arrays, while the exported
    // minute allocator can also be called directly. Treat a missing/malformed
    // standalone position list as no eligible roles so the allocator returns a
    // structured infeasibility result instead of throwing inside the flow.
    const eligiblePositions = Array.isArray(player.positions) ? player.positions : [];
    for (const position of POSITION_KEYS) {
      if (!eligiblePositions.includes(position)) continue;
      const positionNode = positionStart + POSITION_KEYS.indexOf(position);
      edges.set(position, addBoundedEdge(playerNode, positionNode, 0, playerBounds.max));
    }
    roleEdges.set(player.id, edges);
  });

  for (const position of POSITION_KEYS) {
    const positionNode = positionStart + POSITION_KEYS.indexOf(position);
    addBoundedEdge(positionNode, sink, requirements[position], requirements[position]);
  }
  // Closing sink back to source turns the bounded source/sink problem into a
  // circulation. Exact role demands force this edge to carry all 240 minutes.
  addBoundedEdge(sink, source, 0, totalRequired);

  let balanceDemand = 0;
  for (let node = 0; node <= sink; node += 1) {
    if (balances[node] > 0) {
      network.addEdge(superSource, node, balances[node]);
      balanceDemand += balances[node];
    } else if (balances[node] < 0) {
      network.addEdge(node, superSink, -balances[node]);
    }
  }

  const delivered = network.maxFlow(superSource, superSink);
  if (delivered !== balanceDemand) {
    return {
      feasible: false,
      required: { ...requirements },
      delivered,
      balanceDemand,
    };
  }

  const byPlayer = {};
  const totalsByPlayer = {};
  const actual = { G: 0, F: 0, C: 0 };
  for (const player of sortedPlayers) {
    const roleMinutes = { G: 0, F: 0, C: 0 };
    for (const [position, boundedEdge] of roleEdges.get(player.id)) {
      const residualFlow =
        boundedEdge.edge.initialCapacity - boundedEdge.edge.capacity;
      roleMinutes[position] = boundedEdge.lower + residualFlow;
      actual[position] += roleMinutes[position];
    }
    byPlayer[player.id] = roleMinutes;
    totalsByPlayer[player.id] = POSITION_KEYS.reduce(
      (total, position) => total + roleMinutes[position],
      0,
    );
  }

  return {
    feasible: POSITION_KEYS.every((position) => actual[position] === requirements[position]),
    required: { ...requirements },
    actual,
    byPlayer,
    totalsByPlayer,
    delivered,
    balanceDemand,
  };
}

function proportionalMinuteTargets(sortedIds, bounds, scores) {
  const minutes = new Map(sortedIds.map((id) => [id, bounds.get(id).min]));
  const remainingCapacity = new Map(
    sortedIds.map((id) => [id, bounds.get(id).max - bounds.get(id).min]),
  );
  let remaining = 240 - [...minutes.values()].reduce((total, value) => total + value, 0);

  // This is a balanced, proportional allocator—not an objective optimizer. It
  // intentionally spreads remaining minutes by the supplied workload scores,
  // caps players at their limits, and resolves integer remainders
  // deterministically.
  while (remaining > 0) {
    const active = sortedIds.filter((id) => remainingCapacity.get(id) > 0);
    if (active.length === 0) return null;
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
      return { id, whole, fraction: raw - whole };
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
  return minutes;
}

function fixedBoundsFrom(minutes) {
  return new Map([...minutes].map(([id, value]) => [id, { min: value, max: value }]));
}

function objectivePositionAllocation(players, bounds, scores, requirements) {
  if (everyPlayerCoversRequiredPositions(players, requirements)) {
    const minutes = new Map(
      players.map((player) => [player.id, bounds.get(player.id).min]),
    );
    let remaining =
      POSITION_KEYS.reduce((total, position) => total + requirements[position], 0) -
      [...minutes.values()].reduce((total, value) => total + value, 0);
    const priority = players.slice().sort((left, right) => {
      const scoreDifference = scores.get(right.id) - scores.get(left.id);
      return scoreDifference !== 0 ? scoreDifference : compareIds(left.id, right.id);
    });
    for (const player of priority) {
      const capacity = bounds.get(player.id).max - minutes.get(player.id);
      const addition = Math.min(capacity, remaining);
      minutes.set(player.id, minutes.get(player.id) + addition);
      remaining -= addition;
      if (remaining === 0) break;
    }
    return buildUniversalPositionFlow(players, fixedBoundsFrom(minutes), requirements);
  }
  let workingBounds = new Map(
    [...bounds].map(([id, bound]) => [id, { ...bound }]),
  );
  let feasibleFlow = findPositionMinuteFlow(players, workingBounds, requirements);
  if (!feasibleFlow.feasible) return feasibleFlow;

  // With a fixed 240-minute total and player-only score coefficients, giving
  // one more minute to a higher-scored player necessarily removes one minute
  // from an equal/lower-scored player. Maximizing each player in descending
  // score order is therefore an exact linear-objective solution. The flow
  // oracle protects all role requirements after every choice.
  const priority = players.slice().sort((left, right) => {
    const scoreDifference = scores.get(right.id) - scores.get(left.id);
    return scoreDifference !== 0 ? scoreDifference : compareIds(left.id, right.id);
  });
  for (const player of priority) {
    const id = player.id;
    let feasibleMinutes = feasibleFlow.totalsByPlayer[id];
    let low = feasibleMinutes;
    let high = workingBounds.get(id).max;
    let bestFlow = feasibleFlow;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      const trialBounds = new Map(
        [...workingBounds].map(([playerId, bound]) => [playerId, { ...bound }]),
      );
      trialBounds.set(id, { min: candidate, max: candidate });
      const trialFlow = findPositionMinuteFlow(players, trialBounds, requirements);
      if (trialFlow.feasible) {
        feasibleMinutes = candidate;
        bestFlow = trialFlow;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }
    workingBounds.set(id, { min: feasibleMinutes, max: feasibleMinutes });
    feasibleFlow = bestFlow;
  }
  return feasibleFlow;
}

function balancedPositionAllocation(players, bounds, targetMinutes, requirements) {
  const exactTarget = findPositionMinuteFlow(players, fixedBoundsFrom(targetMinutes), requirements);
  if (exactTarget.feasible) return { ...exactTarget, adjusted: false };

  let workingBounds = new Map(
    [...bounds].map(([id, bound]) => [id, { ...bound }]),
  );
  let feasibleFlow = findPositionMinuteFlow(players, workingBounds, requirements);
  if (!feasibleFlow.feasible) return feasibleFlow;

  // If the pure proportional totals cannot cover the roles, pin each player to
  // the closest still-feasible integer total. This preserves the balanced
  // target as closely as the positional model permits without claiming that it
  // optimizes the user's basketball objective.
  for (const player of players.slice().sort(comparePlayersById)) {
    const id = player.id;
    const target = targetMinutes.get(id);
    const bound = workingBounds.get(id);
    const candidates = [];
    for (let delta = 0; delta <= Math.max(target - bound.min, bound.max - target); delta += 1) {
      if (target - delta >= bound.min) candidates.push(target - delta);
      if (delta > 0 && target + delta <= bound.max) candidates.push(target + delta);
    }
    for (const candidate of candidates) {
      const trialBounds = new Map(
        [...workingBounds].map(([playerId, item]) => [playerId, { ...item }]),
      );
      trialBounds.set(id, { min: candidate, max: candidate });
      const trialFlow = findPositionMinuteFlow(players, trialBounds, requirements);
      if (!trialFlow.feasible) continue;
      workingBounds = trialBounds;
      feasibleFlow = trialFlow;
      break;
    }
  }
  return { ...feasibleFlow, adjusted: true };
}

/**
 * Convert a recorded team-stint workload into regulation-game minutes. The
 * denominator is the team's aggregate player-minutes, not a player's MPG per
 * appearance, so missed games and partial-season stints do not masquerade as
 * full-season workloads. A data adapter may also provide the precomputed
 * value directly for callers that do not retain raw totals in the browser.
 */
function historicalMinuteAnchorFromPlayer(player) {
  const analytics = isPlainObject(player?.analytics) ? player.analytics : null;
  if (!analytics) return null;
  const direct = finiteNonNegative(analytics.historicalMinutesPerTeamGame);
  if (direct !== null && direct > 0) return direct;
  const totalMinutes = finiteNonNegative(analytics?.totals?.minutes);
  const teamTotalMinutes = finiteNonNegative(analytics.teamTotalMinutes);
  if (!(totalMinutes > 0) || !(teamTotalMinutes > 0)) return null;
  return (240 * totalMinutes) / teamTotalMinutes;
}

function mapLikeHistoricalAnchor(source, playerId, reasons) {
  if (source === undefined || source === null) return undefined;
  if (!(source instanceof Map) && !isPlainObject(source)) {
    reasons.push("historicalMinuteAnchors must be an object or Map keyed by player id.");
    return undefined;
  }
  const value = getMapLikeValue(source, playerId, "historicalMinuteAnchors", reasons);
  if (value === undefined) return undefined;
  const parsed = finiteNonNegative(value);
  if (parsed === null || !(parsed > 0)) {
    reasons.push(`Historical minute anchor for ${playerId} must be a positive finite number.`);
    return undefined;
  }
  return parsed;
}

function boundsAroundHistoricalTargets(bounds, targets, flexibility) {
  return new Map(
    [...bounds].map(([id, bound]) => {
      const target = targets.get(id);
      return [id, {
        min: Math.max(bound.min, target - flexibility),
        max: Math.min(bound.max, target + flexibility),
      }];
    }),
  );
}

function boundsToObject(bounds) {
  return Object.fromEntries(
    [...bounds].map(([id, bound]) => [id, { min: bound.min, max: bound.max }]),
  );
}

/**
 * Build transparent historical workload guardrails for one already-selected
 * roster. The targets are rescaled to the required 240 minutes while honoring
 * the user's global limits, then each player can move by the selected amount.
 * If a narrow band cannot satisfy the exact G/F/C minute shape, widen only as
 * much as needed from a short, deterministic sequence. If no legal guidance
 * band exists, fall back to the user's declared bounds and report that fact;
 * the caller never receives a silently relaxed historical plan.
 */
function deriveHistoricalGuidanceBounds(
  players,
  baseBounds,
  {
    historicalMinuteAnchors = undefined,
    minuteFlexibility = DEFAULT_ROTATION_MINUTE_FLEXIBILITY,
    positionRequirements = null,
  } = {},
  reasons,
) {
  const sortedIds = players.map((player) => player.id).sort(compareIds);
  const anchors = new Map();
  const unavailablePlayerIds = [];
  for (const player of players) {
    const supplied = mapLikeHistoricalAnchor(historicalMinuteAnchors, player.id, reasons);
    const anchor = supplied === undefined ? historicalMinuteAnchorFromPlayer(player) : supplied;
    if (!(anchor > 0)) unavailablePlayerIds.push(player.id);
    else anchors.set(player.id, anchor);
  }

  const base = {
    requested: true,
    applied: false,
    status: "unavailable",
    minuteFlexibility,
    flexibilityUsed: null,
    anchorsById: Object.fromEntries(anchors),
    targetsById: {},
    boundsById: boundsToObject(baseBounds),
    unavailablePlayerIds,
    reason: null,
  };
  if (unavailablePlayerIds.length > 0) {
    return {
      bounds: baseBounds,
      guidance: {
        ...base,
        reason: "Recorded team-stint minutes are unavailable for one or more selected players, so this plan uses the user-set minute bounds.",
      },
    };
  }

  const targets = proportionalMinuteTargets(sortedIds, baseBounds, anchors);
  if (!targets) {
    return {
      bounds: baseBounds,
      guidance: {
        ...base,
        reason: "Recorded workload targets could not be reconciled with the user-set minute bounds, so this plan uses those bounds directly.",
      },
    };
  }

  // Preserve the requested band first. The two modest expansions cover rare
  // flex/position conflicts without paying a large flow-search cost for every
  // candidate. The final user-bound pass remains explicit in the result.
  const requestedFlexibility = Math.min(48, Math.max(0, minuteFlexibility));
  const flexibilityCandidates = [...new Set([
    requestedFlexibility,
    Math.min(48, requestedFlexibility + 4),
    Math.min(48, requestedFlexibility + 8),
  ])];
  for (const flexibility of flexibilityCandidates) {
    const candidateBounds = boundsAroundHistoricalTargets(baseBounds, targets, flexibility);
    const flow = positionRequirements
      ? findPositionMinuteFlow(players, candidateBounds, positionRequirements)
      : { feasible: true };
    if (!flow.feasible) continue;
    return {
      bounds: candidateBounds,
      guidance: {
        ...base,
        applied: true,
        status: flexibility === requestedFlexibility ? "applied" : "expanded-for-role-coverage",
        flexibilityUsed: flexibility,
        targetsById: Object.fromEntries(targets),
        boundsById: boundsToObject(candidateBounds),
        reason: flexibility === requestedFlexibility
          ? null
          : "The recorded-workload band was widened slightly so the selected players can cover the requested on-court roles.",
      },
    };
  }

  return {
    bounds: baseBounds,
    guidance: {
      ...base,
      status: "role-coverage-fallback",
      targetsById: Object.fromEntries(targets),
      reason: "The recorded-workload guardrails could not cover the requested on-court roles, so this candidate uses the user-set minute bounds.",
    },
  };
}

const ROTATION_CONSTRAINT_TOLERANCE = 1e-9;
// Side constraints are normally resolved in the first few exchanges (often a
// single minute). Mixed-role states are much more expensive than all-flex
// states because every neighbor requires another role-flow proof. Browser/Node
// QA observed one 10,000-state mixed-role roster take more than 21 seconds, so
// the per-roster ceiling is deliberately lower than the solve-wide allowance.
// Reaching either limit remains a truthful exact-search abort, never a heuristic
// answer mislabeled as optimal.
const MAX_CONSTRAINED_ALLOCATION_STATES = 5000;

function playerPerMinuteRate(player, field) {
  const sourceMinutes = Number(player.minutes);
  return sourceMinutes > 0 ? Number(player[field]) / sourceMinutes : 0;
}

function projectedTotalsForMinutes(players, minutes) {
  const totals = {
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
  };
  for (const player of players) {
    const allocatedMinutes = Number(minutes.get(player.id) ?? 0);
    for (const field of Object.keys(totals)) {
      totals[field] += playerPerMinuteRate(player, field) * allocatedMinutes;
    }
  }
  return totals;
}

function projectedConstraintStatus(totals, constraints) {
  const failedStatMinimums = [];
  let normalizedViolation = 0;
  for (const [stat, required] of Object.entries(constraints.statMinimums)) {
    const deficit = required - totals[stat];
    if (deficit > ROTATION_CONSTRAINT_TOLERANCE) {
      failedStatMinimums.push(stat);
      normalizedViolation += deficit / Math.max(1, Math.abs(required));
    }
  }
  const turnoverExcess = Number.isFinite(constraints.maxTurnovers)
    ? totals.turnovers - constraints.maxTurnovers
    : 0;
  const failedMaxTurnovers = turnoverExcess > ROTATION_CONSTRAINT_TOLERANCE;
  if (failedMaxTurnovers) {
    normalizedViolation +=
      turnoverExcess / Math.max(1, Math.abs(constraints.maxTurnovers));
  }
  return {
    passed: failedStatMinimums.length === 0 && !failedMaxTurnovers,
    failedStatMinimums,
    failedMaxTurnovers,
    normalizedViolation,
  };
}

/**
 * Prove the easy forms of projected-constraint infeasibility without entering
 * the combinatorial minute-exchange search. Each bound is itself an exact
 * role-feasible linear optimization: maximize each requested production rate
 * independently, and minimize turnovers by maximizing its inverted rate.
 *
 * These single-constraint proofs cannot certify joint feasibility. A roster
 * that passes every bound must therefore remain unresolved until the exact
 * constrained search (or a ranking upper-bound prune) handles it.
 */
function proveProjectedConstraintInfeasibility(
  players,
  bounds,
  requirements,
  constraints,
  failedStatus = null,
) {
  const sortedIds = players.map((player) => player.id).sort(compareIds);
  const impossibleStats = [];
  for (const [stat, required] of Object.entries(constraints.statMinimums)) {
    if (failedStatus && !failedStatus.failedStatMinimums.includes(stat)) continue;
    const rateScores = new Map(
      players.map((player) => [player.id, playerPerMinuteRate(player, stat)]),
    );
    const maximumFlow = objectivePositionAllocation(players, bounds, rateScores, requirements);
    const maximumMinutes = new Map(
      sortedIds.map((id) => [id, maximumFlow.totalsByPlayer[id]]),
    );
    const maximum = projectedTotalsForMinutes(players, maximumMinutes)[stat];
    if (maximum + ROTATION_CONSTRAINT_TOLERANCE < required) impossibleStats.push(stat);
  }

  let impossibleTurnovers = false;
  if (
    Number.isFinite(constraints.maxTurnovers) &&
    (!failedStatus || failedStatus.failedMaxTurnovers)
  ) {
    const turnoverRates = new Map(
      players.map((player) => [player.id, playerPerMinuteRate(player, "turnovers")]),
    );
    const highestRate = Math.max(...turnoverRates.values(), 0);
    const inverseScores = new Map(
      sortedIds.map((id) => [id, highestRate - turnoverRates.get(id)]),
    );
    const minimumFlow = objectivePositionAllocation(players, bounds, inverseScores, requirements);
    const minimumMinutes = new Map(
      sortedIds.map((id) => [id, minimumFlow.totalsByPlayer[id]]),
    );
    const minimum = projectedTotalsForMinutes(players, minimumMinutes).turnovers;
    impossibleTurnovers =
      minimum - ROTATION_CONSTRAINT_TOLERANCE > constraints.maxTurnovers;
  }

  return { impossibleStats, impossibleTurnovers };
}

function allocationObjective(minutes, scores) {
  let value = 0;
  for (const [id, minuteTotal] of minutes) value += scores.get(id) * minuteTotal;
  return value;
}

function minuteStateKey(sortedIds, minutes) {
  return sortedIds.map((id) => minutes.get(id)).join(",");
}

function createAllocationMaxHeap() {
  const entries = [];
  const comesFirst = (left, right) => {
    if (Math.abs(left.objective - right.objective) > 1e-12) {
      return left.objective > right.objective;
    }
    return compareIds(left.key, right.key) < 0;
  };
  return {
    get size() {
      return entries.length;
    },
    push(value) {
      entries.push(value);
      let index = entries.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (comesFirst(entries[parent], entries[index])) break;
        [entries[parent], entries[index]] = [entries[index], entries[parent]];
        index = parent;
      }
    },
    pop() {
      if (entries.length === 0) return null;
      const first = entries[0];
      const last = entries.pop();
      if (entries.length > 0) {
        entries[0] = last;
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let best = index;
          if (left < entries.length && comesFirst(entries[left], entries[best])) best = left;
          if (right < entries.length && comesFirst(entries[right], entries[best])) best = right;
          if (best === index) break;
          [entries[index], entries[best]] = [entries[best], entries[index]];
          index = best;
        }
      }
      return first;
    },
  };
}

/**
 * Find the highest-objective role-feasible minute vector that also satisfies
 * the requested projected box-score constraints.
 *
 * `objectivePositionAllocation` supplies the unconstrained optimum. Feasible
 * integer b-matching totals have the exchange property: another feasible total
 * vector can be reached by moving one minute at a time between players while
 * preserving a role assignment. Starting from the optimum, we enumerate only
 * non-increasing-objective exchanges and pop states in objective order. The
 * first constraint-feasible state is therefore the constrained optimum, not an
 * arbitrary repair added after ranking. Equal-score exchanges remain available,
 * which is crucial when a lexicographic tie initially gives all minutes to the
 * wrong statistical profile.
 */
function constrainedPositionAllocation(
  players,
  bounds,
  scores,
  requirements,
  initialFlow,
  constraints,
  sharedBudget = null,
) {
  const sortedIds = players.map((player) => player.id).sort(compareIds);
  const initialMinutes = new Map(
    sortedIds.map((id) => [id, initialFlow.totalsByPlayer[id]]),
  );
  const initialTotals = projectedTotalsForMinutes(players, initialMinutes);
  const initialStatus = projectedConstraintStatus(initialTotals, constraints);
  let statesExamined = 0;
  const sharedLimitReached = () =>
    sharedBudget && sharedBudget.used >= sharedBudget.limit;
  const consumeState = () => {
    if (statesExamined >= MAX_CONSTRAINED_ALLOCATION_STATES || sharedLimitReached()) {
      return false;
    }
    statesExamined += 1;
    if (sharedBudget) sharedBudget.used += 1;
    return true;
  };
  const searchLimitFailure = (closestStatus = initialStatus, closestTotals = initialTotals) => ({
    feasible: false,
    constraintInfeasible: false,
    constraintSearchLimitReached: true,
    solveWideConstraintSearchLimitReached: Boolean(sharedLimitReached()),
    failedStatMinimums: closestStatus.failedStatMinimums,
    failedMaxTurnovers: closestStatus.failedMaxTurnovers,
    projectedTotals: closestTotals,
    constraintSearchStates: statesExamined,
    solveConstraintSearchStatesUsed: sharedBudget?.used ?? statesExamined,
    solveConstraintSearchStateLimit: sharedBudget?.limit ?? MAX_CONSTRAINED_ALLOCATION_STATES,
  });

  // The unconstrained allocation and its first constraint check are required
  // for every rotation candidate anyway. They consume no constrained-search
  // budget. This distinction prevents a vacuous threshold (for example,
  // points >= 0) from spending one state for every otherwise-easy roster.
  if (initialStatus.passed) {
    return {
      ...initialFlow,
      projectedTotals: initialTotals,
      constraintSearchStates: 0,
      solveConstraintSearchStatesUsed: sharedBudget?.used ?? statesExamined,
      constraintsAdjusted: false,
    };
  }

  // Cheap exact single-constraint bounds avoid searching obviously impossible
  // requests. The same proof is reused by the solve-wide first pass so a
  // provably impossible roster never enters the expensive contender queue.
  const { impossibleStats, impossibleTurnovers } =
    proveProjectedConstraintInfeasibility(
      players,
      bounds,
      requirements,
      constraints,
      initialStatus,
    );
  if (impossibleStats.length > 0 || impossibleTurnovers) {
    return {
      feasible: false,
      constraintInfeasible: true,
      failedStatMinimums: impossibleStats,
      failedMaxTurnovers: impossibleTurnovers,
      projectedTotals: initialTotals,
      constraintSearchStates: 0,
      solveConstraintSearchStatesUsed: sharedBudget?.used ?? statesExamined,
    };
  }

  const heap = createAllocationMaxHeap();
  const initialKey = minuteStateKey(sortedIds, initialMinutes);
  heap.push({
    key: initialKey,
    minutes: initialMinutes,
    flow: initialFlow,
    objective: allocationObjective(initialMinutes, scores),
  });
  const visited = new Set([initialKey]);
  let closest = {
    status: initialStatus,
    totals: initialTotals,
  };

  while (heap.size > 0) {
    const state = heap.pop();
    if (
      (state.key === initialKey && sharedLimitReached()) ||
      (state.key !== initialKey && !consumeState())
    ) {
      return searchLimitFailure(closest.status, closest.totals);
    }
    const totals = projectedTotalsForMinutes(players, state.minutes);
    const status = projectedConstraintStatus(totals, constraints);
    if (status.passed) {
      return {
        ...state.flow,
        projectedTotals: totals,
        constraintSearchStates: statesExamined,
        solveConstraintSearchStatesUsed: sharedBudget?.used ?? statesExamined,
        constraintsAdjusted: state.key !== initialKey,
      };
    }
    if (status.normalizedViolation < closest.status.normalizedViolation) {
      closest = { status, totals };
    }

    for (const donorId of sortedIds) {
      if (state.minutes.get(donorId) <= bounds.get(donorId).min) continue;
      for (const receiverId of sortedIds) {
        if (donorId === receiverId) continue;
        if (state.minutes.get(receiverId) >= bounds.get(receiverId).max) continue;
        // Moving a minute uphill cannot be part of a path away from a proven
        // unconstrained maximum; skipping it prevents cycles and preserves the
        // objective-ordered search invariant.
        if (scores.get(donorId) + 1e-12 < scores.get(receiverId)) continue;
        const minutes = new Map(state.minutes);
        minutes.set(donorId, minutes.get(donorId) - 1);
        minutes.set(receiverId, minutes.get(receiverId) + 1);
        const key = minuteStateKey(sortedIds, minutes);
        if (visited.has(key)) continue;
        visited.add(key);
        const flow = findPositionMinuteFlow(players, fixedBoundsFrom(minutes), requirements);
        if (!flow.feasible) continue;
        heap.push({
          key,
          minutes,
          flow,
          objective: allocationObjective(minutes, scores),
        });
      }
    }
  }

  return {
    feasible: false,
    constraintInfeasible: true,
    constraintSearchLimitReached: false,
    solveWideConstraintSearchLimitReached: false,
    failedStatMinimums: closest.status.failedStatMinimums,
    failedMaxTurnovers: closest.status.failedMaxTurnovers,
    projectedTotals: closest.totals,
    constraintSearchStates: statesExamined,
    solveConstraintSearchStatesUsed: sharedBudget?.used ?? statesExamined,
  };
}

/**
 * Allocate exactly 240 integer minutes among 8-12 selected players.
 *
 * Options:
 * - minMinutes / maxMinutes: a scalar or an object/Map keyed by player id
 * - playerBounds: { [id]: { min, max } }, overriding the general bounds
 * - scores (alias playerScores/weights): object/Map used for allocation priority
 * - strategy: "balanced" (proportional workload) or "objective" (maximum score)
 * - positionMinuteRequirements: optional exact G/F/C role-minute requirements
 * - minutePlan: "historicalAware" (default when evidence exists) or "openWhatIf"
 * - historicalMinuteAnchors: optional regulation-game workload map by player id
 * - minuteFlexibility: integer minutes a historical-aware plan may move per player
 * - projectedStatMinimums / projectedMaxTurnovers: optional constraints applied
 *   while choosing minutes, using each player's source per-minute rates; these
 *   require positionMinuteRequirements so a complete role-feasible plan exists
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
  // Direct callers may use numeric ids. Canonicalize the working copies once
  // so bounds, scores, flow nodes, result maps, and tie-breaks all address the
  // same string key. optimizeLineups already performs this normalization, but
  // the exported allocator must be safe independently.
  const rotationPlayers = players.map((player) => ({
    ...player,
    id: canonicalId(player?.id),
  }));

  const defaultMin = options.minMinutes === undefined ? 8 : options.minMinutes;
  const defaultMax = options.maxMinutes === undefined ? 36 : options.maxMinutes;
  const boundsSource = isPlainObject(options.playerBounds) ? options.playerBounds : {};
  const scoreSource = options.scores ?? options.playerScores ?? options.weights;
  const rawStrategy = options.strategy ?? options.allocationStrategy ?? "balanced";
  const strategy = rawStrategy === "maximize-score" ? "objective" : rawStrategy;
  if (strategy !== "balanced" && strategy !== "objective") {
    reasons.push('Rotation strategy must be either "balanced" or "objective".');
  }
  const minutePlan = normalizeRotationMinutePlan(options.minutePlan, reasons);
  const minuteFlexibility = normalizeNonNegativeNumber(
    options.minuteFlexibility,
    DEFAULT_ROTATION_MINUTE_FLEXIBILITY,
    "minuteFlexibility",
    reasons,
    true,
  );
  if (minuteFlexibility > 48) {
    reasons.push("minuteFlexibility cannot exceed 48 minutes.");
  }
  const historicalMinuteAnchors = options.historicalMinuteAnchors;
  const rawPositionRequirements =
    options.positionMinuteRequirements ?? options.positionMinutes ?? null;
  let positionRequirements = null;
  if (rawPositionRequirements !== null && rawPositionRequirements !== undefined) {
    if (!isPlainObject(rawPositionRequirements)) {
      reasons.push("positionMinuteRequirements must be an object with G, F, and C values.");
    } else {
      positionRequirements = { G: 0, F: 0, C: 0 };
      for (const position of POSITION_KEYS) {
        const value = Number(rawPositionRequirements[position] ?? 0);
        if (!Number.isInteger(value) || value < 0) {
          reasons.push(`Position-minute requirement ${position} must be a non-negative integer.`);
        }
        positionRequirements[position] = value;
      }
      const requirementTotal = POSITION_KEYS.reduce(
        (total, position) => total + positionRequirements[position],
        0,
      );
      if (requirementTotal !== 240) {
        reasons.push(`Position-minute requirements must total 240, but total ${requirementTotal}.`);
      }
    }
  }
  const projectedConstraints = { statMinimums: {}, maxTurnovers: Number.POSITIVE_INFINITY };
  const rawProjectedMinimums = options.projectedStatMinimums ?? {};
  if (!isPlainObject(rawProjectedMinimums)) {
    reasons.push("projectedStatMinimums must be an object of projected rotation totals.");
  } else {
    for (const [stat, rawRequired] of Object.entries(rawProjectedMinimums)) {
      if (!STAT_MINIMUM_KEYS.includes(stat)) {
        reasons.push(`projectedStatMinimums contains an unsupported statistic: ${stat}.`);
        continue;
      }
      const required = Number(rawRequired);
      if (!Number.isFinite(required) || required < 0) {
        reasons.push(`projectedStatMinimums.${stat} must be a non-negative number.`);
        continue;
      }
      if (required > 0) projectedConstraints.statMinimums[stat] = required;
    }
  }
  if (
    options.projectedMaxTurnovers !== undefined &&
    options.projectedMaxTurnovers !== null &&
    options.projectedMaxTurnovers !== Number.POSITIVE_INFINITY
  ) {
    const maximum = Number(options.projectedMaxTurnovers);
    if (!Number.isFinite(maximum) || maximum < 0) {
      reasons.push("projectedMaxTurnovers must be a non-negative number.");
    } else {
      projectedConstraints.maxTurnovers = maximum;
    }
  }
  const hasProjectedConstraints =
    Object.keys(projectedConstraints.statMinimums).length > 0 ||
    Number.isFinite(projectedConstraints.maxTurnovers);
  let sharedConstraintSearchBudget = options.sharedConstraintSearchBudget ?? null;
  if (sharedConstraintSearchBudget !== null) {
    if (
      !isPlainObject(sharedConstraintSearchBudget) ||
      !Number.isInteger(sharedConstraintSearchBudget.limit) ||
      sharedConstraintSearchBudget.limit < 1 ||
      !Number.isInteger(sharedConstraintSearchBudget.used) ||
      sharedConstraintSearchBudget.used < 0
    ) {
      reasons.push(
        "sharedConstraintSearchBudget must contain positive integer limit and non-negative integer used values.",
      );
      sharedConstraintSearchBudget = null;
    }
  }
  if (hasProjectedConstraints && !positionRequirements) {
    reasons.push(
      "Projected rotation constraints require positionMinuteRequirements so feasibility can be proven against a complete 240-minute court-role plan.",
    );
  }
  const bounds = new Map();
  const scores = new Map();

  for (const player of rotationPlayers) {
    const id = canonicalId(player?.id);
    if (!id) continue;
    const playerBounds = isPlainObject(boundsSource[id]) ? boundsSource[id] : {};
    const minimum = Number(
      playerBounds.min ??
        playerBounds.minimum ??
        getBoundValue(defaultMin, id, 8, "minMinutes", reasons),
    );
    const maximum = Number(
      playerBounds.max ??
        playerBounds.maximum ??
        getBoundValue(defaultMax, id, 36, "maxMinutes", reasons),
    );
    if (!Number.isInteger(minimum) || minimum < 0) {
      reasons.push(`Minimum minutes for ${id} must be a non-negative integer.`);
    } else if (minimum > 48) {
      reasons.push(`Minimum minutes for ${id} cannot exceed 48 in a regulation game.`);
    }
    if (!Number.isInteger(maximum) || maximum < 0) {
      reasons.push(`Maximum minutes for ${id} must be a non-negative integer.`);
    } else if (maximum > 48) {
      reasons.push(`Maximum minutes for ${id} cannot exceed 48 in a regulation game.`);
    }
    if (Number.isInteger(minimum) && Number.isInteger(maximum) && minimum > maximum) {
      reasons.push(`Minimum minutes for ${id} cannot exceed its maximum minutes.`);
    }
    bounds.set(id, { min: minimum, max: maximum });

    const suppliedScore = getMapLikeValue(scoreSource, id, "Rotation scores", reasons);
    const fallbackScore = Number(player?.minutes) > 0 ? Number(player.minutes) : 1;
    const score = suppliedScore === undefined ? fallbackScore : Number(suppliedScore);
    if (!Number.isFinite(score) || score < 0) {
      reasons.push(`Rotation score for ${id} must be a non-negative number.`);
    }
    scores.set(id, score);

    if (hasProjectedConstraints) {
      const sourceMinutes = Number(player?.minutes);
      if (!Number.isFinite(sourceMinutes) || sourceMinutes <= 0) {
        reasons.push(
          `Source minutes for ${id} must be a finite number greater than zero when projected constraints are used.`,
        );
      }
      const referencedStats = new Set(Object.keys(projectedConstraints.statMinimums));
      if (Number.isFinite(projectedConstraints.maxTurnovers)) referencedStats.add("turnovers");
      for (const stat of referencedStats) {
        const value = Number(player?.[stat]);
        if (!Number.isFinite(value) || value < 0) {
          reasons.push(
            `Projected source statistic ${stat} for ${id} must be a finite non-negative number.`,
          );
        }
      }
    }
  }

  if (reasons.length > 0) {
    return rotationFailure(reasons, { category: "validation", selectedPlayers: players.length });
  }

  const sortedIds = ids.slice().sort(compareIds);
  const userMinimumTotal = sortedIds.reduce((total, id) => total + bounds.get(id).min, 0);
  const userMaximumTotal = sortedIds.reduce((total, id) => total + bounds.get(id).max, 0);
  if (userMinimumTotal > 240 || userMaximumTotal < 240) {
    const feasibilityReasons = [];
    if (userMinimumTotal > 240) {
      feasibilityReasons.push(
        `Player minimums total ${userMinimumTotal} minutes, which exceeds the required 240.`,
      );
    }
    if (userMaximumTotal < 240) {
      feasibilityReasons.push(
        `Player maximums total ${userMaximumTotal} minutes, which is below the required 240.`,
      );
    }
    return rotationFailure(feasibilityReasons, {
      category: "total-minutes",
      selectedPlayers: players.length,
      minimumTotal: userMinimumTotal,
      maximumTotal: userMaximumTotal,
    });
  }

  let effectiveBounds = bounds;
  let historicalGuidance = {
    requested: minutePlan === ROTATION_MINUTE_PLANS.HISTORICAL_AWARE,
    applied: false,
    status: minutePlan === ROTATION_MINUTE_PLANS.OPEN_WHAT_IF ? "open-what-if" : "unavailable",
    minuteFlexibility,
    flexibilityUsed: null,
    anchorsById: {},
    targetsById: {},
    boundsById: boundsToObject(bounds),
    unavailablePlayerIds: [],
    reason: minutePlan === ROTATION_MINUTE_PLANS.OPEN_WHAT_IF
      ? "Open what-if mode uses only the minute bounds you set."
      : null,
  };
  if (minutePlan === ROTATION_MINUTE_PLANS.HISTORICAL_AWARE) {
    const derived = deriveHistoricalGuidanceBounds(
      rotationPlayers,
      bounds,
      {
        historicalMinuteAnchors,
        minuteFlexibility,
        positionRequirements,
      },
      reasons,
    );
    if (reasons.length > 0) {
      return rotationFailure(reasons, { category: "validation", selectedPlayers: players.length });
    }
    effectiveBounds = derived.bounds;
    historicalGuidance = derived.guidance;
  }

  const minimumTotal = sortedIds.reduce((total, id) => total + effectiveBounds.get(id).min, 0);
  const maximumTotal = sortedIds.reduce((total, id) => total + effectiveBounds.get(id).max, 0);
  if (minimumTotal > 240 || maximumTotal < 240) {
    // Targets are constructed to include a 240-minute vector. Keep this
    // defensive diagnostic in case a future custom-bound policy changes that
    // invariant, rather than returning an unexplained allocation failure.
    return rotationFailure(["The active minute-plan guardrails cannot reach exactly 240 minutes."], {
      category: "minute-plan-bounds",
      selectedPlayers: players.length,
      minimumTotal,
      maximumTotal,
      historicalGuidance,
    });
  }

  const balancedTargets = proportionalMinuteTargets(sortedIds, effectiveBounds, scores);
  if (!balancedTargets) {
    return rotationFailure(["The available minute capacity cannot reach 240 minutes."], {
      category: "total-minutes",
      selectedPlayers: players.length,
      minimumTotal,
      maximumTotal,
      historicalGuidance,
    });
  }

  let minutes = balancedTargets;
  let positionFlow = null;
  let balancedAdjusted = false;
  if (positionRequirements) {
    // A constrained request necessarily uses the objective baseline even when
    // a direct caller requested balanced workload minutes: the contract is to
    // optimize the stated objective subject to those constraints, not merely
    // repair a proportional schedule after it fails.
    positionFlow = strategy === "objective" || hasProjectedConstraints
      ? objectivePositionAllocation(rotationPlayers, effectiveBounds, scores, positionRequirements)
      : balancedPositionAllocation(rotationPlayers, effectiveBounds, balancedTargets, positionRequirements);
    if (!positionFlow.feasible) {
      return rotationFailure([
        `The selected players cannot cover ${positionRequirements.G} guard, ${positionRequirements.F} forward, and ${positionRequirements.C} center minutes within their minute limits. Add another eligible flex/center or raise an eligible player's maximum.`,
      ], {
        category: "position-minutes",
        selectedPlayers: players.length,
        minimumTotal,
        maximumTotal,
        requiredPositionMinutes: { ...positionRequirements },
        deliveredPositionFlow: positionFlow.delivered,
        requiredPositionFlow: positionFlow.balanceDemand,
        historicalGuidance,
      });
    }
    if (hasProjectedConstraints) {
      const constrainedFlow = constrainedPositionAllocation(
        rotationPlayers,
        effectiveBounds,
        scores,
        positionRequirements,
        positionFlow,
        projectedConstraints,
        sharedConstraintSearchBudget,
      );
      if (!constrainedFlow.feasible) {
        const reason = constrainedFlow.constraintSearchLimitReached
          ? `The constrained minute search reached its ${MAX_CONSTRAINED_ALLOCATION_STATES.toLocaleString()}-state safety limit before proving a plan.`
          : "No role-feasible 240-minute plan can satisfy the requested projected production constraints.";
        return rotationFailure([reason], {
          category: constrainedFlow.constraintSearchLimitReached
            ? "constraint-search-limit"
            : "projected-constraints",
          selectedPlayers: players.length,
          failedStatMinimums: constrainedFlow.failedStatMinimums,
          failedMaxTurnovers: constrainedFlow.failedMaxTurnovers,
          closestProjectedTotals: constrainedFlow.projectedTotals,
          constraintSearchStates: constrainedFlow.constraintSearchStates,
          solveConstraintSearchStatesUsed: constrainedFlow.solveConstraintSearchStatesUsed,
          solveConstraintSearchStateLimit: constrainedFlow.solveConstraintSearchStateLimit,
          solveWideConstraintSearchLimitReached:
            constrainedFlow.solveWideConstraintSearchLimitReached,
          historicalGuidance,
        });
      }
      positionFlow = constrainedFlow;
    }
    balancedAdjusted = Boolean(positionFlow.adjusted);
    minutes = new Map(
      sortedIds.map((id) => [id, positionFlow.totalsByPlayer[id]]),
    );
  } else if (strategy === "objective") {
    // Without role constraints the exact linear allocation is a simple greedy
    // fill: start every player at the minimum, then give remaining minutes to
    // the highest score until each reaches the maximum.
    minutes = new Map(sortedIds.map((id) => [id, effectiveBounds.get(id).min]));
    let remaining = 240 - minimumTotal;
    const priority = sortedIds.slice().sort((left, right) => {
      const scoreDifference = scores.get(right) - scores.get(left);
      return scoreDifference !== 0 ? scoreDifference : compareIds(left, right);
    });
    for (const id of priority) {
      const addition = Math.min(
        remaining,
        effectiveBounds.get(id).max - effectiveBounds.get(id).min,
      );
      minutes.set(id, minutes.get(id) + addition);
      remaining -= addition;
      if (remaining === 0) break;
    }
  }

  const playerById = new Map(rotationPlayers.map((player) => [player.id, player]));
  const allocations = sortedIds.map((id) => ({
    id,
    name: String(playerById.get(id)?.name ?? id),
    minutes: minutes.get(id),
    minimum: effectiveBounds.get(id).min,
    maximum: effectiveBounds.get(id).max,
    userMinimum: bounds.get(id).min,
    userMaximum: bounds.get(id).max,
    ...(historicalGuidance.targetsById[id] !== undefined
      ? {
          historicalTarget: historicalGuidance.targetsById[id],
          historicalAnchor: historicalGuidance.anchorsById[id],
        }
      : {}),
    ...(positionFlow ? { roleMinutes: { ...positionFlow.byPlayer[id] } } : {}),
  }));
  const totalMinutes = allocations.reduce((total, allocation) => total + allocation.minutes, 0);

  return {
    ok: true,
    status: "success",
    strategy: hasProjectedConstraints
      ? "objective-constrained"
      : strategy === "objective"
        ? "objective-maximizing"
        : balancedAdjusted
          ? "balanced-proportional-adjusted-for-positions"
          : "balanced-proportional",
    totalMinutes,
    allocations,
    byId: Object.fromEntries(allocations.map((allocation) => [allocation.id, allocation.minutes])),
    minutePlan,
    historicalGuidance,
    positionMinutes: positionFlow
      ? {
          enforced: true,
          required: { ...positionFlow.required },
          actual: { ...positionFlow.actual },
          byPlayer: positionFlow.byPlayer,
          passed: positionFlow.feasible,
        }
      : { enforced: false, required: null, actual: null, byPlayer: {}, passed: true },
    diagnostics: {
      selectedPlayers: players.length,
      minimumTotal,
      maximumTotal,
      allocationStrategy: strategy,
      balancedAdjustedForPositions: balancedAdjusted,
      minutePlan,
      historicalGuidance,
      projectedConstraints: {
        statMinimums: { ...projectedConstraints.statMinimums },
        maxTurnovers: Number.isFinite(projectedConstraints.maxTurnovers)
          ? projectedConstraints.maxTurnovers
          : null,
        adjustedAllocation: Boolean(positionFlow?.constraintsAdjusted),
        searchStates: positionFlow?.constraintSearchStates ?? 0,
        solveSearchStatesUsed: positionFlow?.solveConstraintSearchStatesUsed ?? 0,
        solveSearchStateLimit:
          sharedConstraintSearchBudget?.limit ?? MAX_CONSTRAINED_ALLOCATION_STATES,
      },
      ...(positionFlow
        ? {
            requiredPositionMinutes: { ...positionFlow.required },
            actualPositionMinutes: { ...positionFlow.actual },
          }
        : {}),
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

const OBJECTIVE_SCORE_TOLERANCE = 1e-12;

function alternativeSort(left, right) {
  if (Math.abs(left._rawScore - right._rawScore) > OBJECTIVE_SCORE_TOLERANCE) {
    return right._rawScore - left._rawScore;
  }
  return compareIds(left._tieKey, right._tieKey);
}

function upperBoundSort(left, right) {
  // Upper bounds need a true numeric total order. `alternativeSort` deliberately
  // treats near-equal scores as ties, which is ideal for final display ranking
  // but can be non-transitive across a chain of sub-tolerance differences.
  if (left._rawScore !== right._rawScore) return right._rawScore - left._rawScore;
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
 * Every combination is evaluated; no greedy selection is used. Rotation mode
 * defaults `rotationOptions.scoringBasis` to `per36` for counting stats and
 * turnovers; use `perGame` only when an API caller deliberately needs the
 * legacy raw-per-game ranking. That scoring choice never alters production
 * projections, which remain source per-minute rates times allocated minutes.
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
  const rotationPositionMinuteRequirements = normalizedConfig.mode === "rotation"
    ? normalizedConfig.rotationPositionMinuteRequirements
    : STANDARD_POSITION_MINUTES;
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

  // Equal-player lineup totals have a cheap exact preflight bound. Rotation
  // totals depend on each candidate's feasible minute and role allocation, so
  // applying the lineup bound there would incorrectly reject valid plans.
  if (normalizedConfig.mode === "lineup") {
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
    // This is intentionally absent from lineup mode: its equal-player profile
    // keeps the historical per-game comparison users already expect.
    ...(normalizedConfig.mode === "rotation"
      ? {
          rotationScoringBasis: normalizedConfig.rotationScoringBasis,
          rotationMinutePlan: normalizedConfig.rotationMinutePlan,
          rotationMinuteFlexibility: normalizedConfig.rotationMinuteFlexibility,
          rotationRateStability: normalizedConfig.rotationRateStability,
          requiredPositionMinutes: { ...rotationPositionMinuteRequirements },
        }
      : {}),
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

  // A five-player profile remains an equal-player, per-game comparison. For a
  // rotation, the exact allocator gives players proposed game minutes, so use
  // per-36 counting rates by default before those players compete for minutes.
  // The explicit perGame option remains available to API callers who need the
  // legacy comparison for a historical experiment.
  const normalizedMetricResult = buildNormalizedMetrics(eligiblePlayers, {
    scoringBasis:
      normalizedConfig.mode === "rotation"
        ? normalizedConfig.rotationScoringBasis
        : ROTATION_SCORING_BASES.PER_GAME,
    rateStability:
      normalizedConfig.mode === "rotation"
        ? normalizedConfig.rotationRateStability
        : ROTATION_RATE_STABILITY_MODES.RAW,
  });
  const normalizedMetrics = normalizedMetricResult.metrics;
  if (normalizedConfig.mode === "rotation") {
    // This small summary makes a result auditable without exposing every raw
    // row value in the solver payload. Individual player rates remain visible
    // in the UI; this only tells the fan whether the evidence guardrail was
    // actually available for the current source.
    baseDiagnostics.rotationRateStabilityEvidence = normalizedMetricResult.rateStability;
  }
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
  const hasRotationProjectedConstraints =
    normalizedConfig.mode === "rotation" &&
    (Object.keys(normalizedConfig.statMinimums).length > 0 ||
      Number.isFinite(normalizedConfig.maxTurnovers));
  // One mutable allowance is deliberately shared by every candidate roster.
  // A per-candidate cap still permits N hard candidates to exceed the Worker's
  // timeout. The exact solver aborts globally when this allowance is spent.
  const solveConstraintSearchBudget = hasRotationProjectedConstraints
    ? { limit: normalizedConfig.maxConstraintSearchStates, used: 0 }
    : null;
  let rotationAllocationsComputed = 0;
  let rotationBaselineAllocationsComputed = 0;
  let rotationRankingBoundAllocationsComputed = 0;
  let rotationConstrainedAllocationsComputed = 0;
  const projectedRotationConstraints = {
    statMinimums: normalizedConfig.statMinimums,
    maxTurnovers: normalizedConfig.maxTurnovers,
  };

  function rotationScoresFor(selectedPlayers) {
    return Object.fromEntries(
      selectedPlayers.map((player) => [player.id, playerObjectiveScores.get(player.id)]),
    );
  }

  function allocateSelectedRotation(
    selectedPlayers,
    {
      includeProjectedConstraints = hasRotationProjectedConstraints,
      rankingUpperBound = false,
    } = {},
  ) {
    rotationAllocationsComputed += 1;
    if (includeProjectedConstraints) rotationConstrainedAllocationsComputed += 1;
    else if (rankingUpperBound) rotationRankingBoundAllocationsComputed += 1;
    else rotationBaselineAllocationsComputed += 1;
    return allocateRotationMinutes(selectedPlayers, {
      ...normalizedConfig.rotationOptions,
      // The normal allocation honors an explicit caller workload objective.
      // When that differs from the model's ranking objective, pass 1 requests
      // one additional exact allocation with `rankingUpperBound` so pruning is
      // still bounded by the same raw score used to order final alternatives.
      scores:
        rankingUpperBound
          ? rotationScoresFor(selectedPlayers)
          : callerRotationScores ?? rotationScoresFor(selectedPlayers),
      // The optimizer's default is the exact objective allocation. The public
      // allocator retains an explicitly named balanced strategy for callers
      // that prefer workload proportionality over objective maximization.
      strategy: hasRotationProjectedConstraints
        ? "objective"
        : normalizedConfig.rotationOptions.strategy ?? "objective",
      // Roster-slot minimums above remain composition constraints. Every
      // rotation candidate separately proves the selected G/F/C court shape,
      // with flex players allowed to split their minutes.
      positionMinuteRequirements: rotationPositionMinuteRequirements,
      // Normalize the public model settings once at the solve boundary so a
      // caller cannot accidentally have the UI describe one policy while the
      // allocator applies another. Historical anchors themselves come from
      // the selected players' source metadata unless explicitly supplied.
      minutePlan: normalizedConfig.rotationMinutePlan,
      minuteFlexibility: normalizedConfig.rotationMinuteFlexibility,
      // These constraints belong inside the allocation problem. Passing them
      // here prevents a feasible roster from being discarded merely because
      // its unconstrained minute optimum missed a threshold by one minute.
      projectedStatMinimums: includeProjectedConstraints
        ? normalizedConfig.statMinimums
        : {},
      projectedMaxTurnovers: includeProjectedConstraints
        ? normalizedConfig.maxTurnovers
        : Number.POSITIVE_INFINITY,
      sharedConstraintSearchBudget: includeProjectedConstraints
        ? solveConstraintSearchBudget
        : null,
    });
  }

  const topAlternatives = [];
  let combinationsEvaluated = 0;
  let feasibleCombinations = 0;
  let exactSearchAbort = null;
  const unresolvedRotationCandidates = [];
  let baselineConstraintFeasible = 0;
  let constrainedCandidatesSearched = 0;
  let constraintBoundPruned = 0;
  let constraintUnclassified = 0;
  const rejectedByConstraint = {
    positionMinimums: 0,
    statMinimums: Object.fromEntries(Object.keys(normalizedConfig.statMinimums).map((stat) => [stat, 0])),
    maxTurnovers: 0,
    rotationMinutes: 0,
    rotationPositionMinutes: 0,
    constraintSearchLimit: 0,
  };
  const chosen = [];

  function recordProjectedConstraintRejection(failedStatMinimums, failedMaxTurnovers) {
    for (const stat of failedStatMinimums ?? []) {
      if (hasOwn(rejectedByConstraint.statMinimums, stat)) {
        rejectedByConstraint.statMinimums[stat] += 1;
      }
    }
    if (failedMaxTurnovers) rejectedByConstraint.maxTurnovers += 1;
  }

  function retainFeasibleCombination(selectedPlayers, positionResult, rotation, totals, rawScore) {
    if (rotation) rotation.projectedTotals = { ...totals };
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

  function boundsFromRotation(rotation) {
    return new Map(
      rotation.allocations.map((allocation) => [
        allocation.id,
        { min: allocation.minimum, max: allocation.maximum },
      ]),
    );
  }

  function baselineRotationWithConstraintAudit(rotation, totals) {
    // The unconstrained optimum itself already satisfies every projected
    // constraint, so it is also the constrained optimum. Reusing it avoids a
    // duplicate allocation call while still returning the same truthful
    // constraint metadata as the ordinary constrained allocator.
    return {
      ...rotation,
      strategy: "objective-constrained",
      projectedTotals: { ...totals },
      diagnostics: {
        ...rotation.diagnostics,
        projectedConstraints: {
          statMinimums: { ...normalizedConfig.statMinimums },
          maxTurnovers: Number.isFinite(normalizedConfig.maxTurnovers)
            ? normalizedConfig.maxTurnovers
            : null,
          adjustedAllocation: false,
          searchStates: 0,
          solveSearchStatesUsed: solveConstraintSearchBudget.used,
          solveSearchStateLimit: solveConstraintSearchBudget.limit,
        },
      },
    };
  }

  function upperBoundCanEnterTopK(candidate) {
    if (topAlternatives.length < normalizedConfig.alternatives) return true;
    // `alternativeSort` is the single ranking contract for both insertion and
    // pruning. Comparing the candidate's unattainable-best upper bound (rather
    // than an estimated constrained score) makes this conservative and exact;
    // equality is pruned only when the fixed roster tie key also cannot win.
    return alternativeSort(candidate, topAlternatives.at(-1)) < 0;
  }

  function evaluateCombination() {
    if (exactSearchAbort) return;
    combinationsEvaluated += 1;
    const selectedPlayers = mergePlayersById(lockedPlayers, chosen);
    const positionResult = findPositionAssignment(
      selectedPlayers,
      normalizedConfig.positionMinimums,
    );
    let passed = true;

    if (!positionResult.feasible) {
      rejectedByConstraint.positionMinimums += 1;
      passed = false;
    }
    if (!passed) return;

    if (hasRotationProjectedConstraints) {
      // Pass 1 never enters the minute-exchange search. It gives every
      // composition-feasible roster its exact unconstrained, role-feasible
      // objective allocation. That score is a mathematical upper bound on any
      // allocation that also obeys the projected side constraints.
      const baselineRotation = allocateSelectedRotation(selectedPlayers, {
        includeProjectedConstraints: false,
      });
      if (!baselineRotation.ok) {
        if (baselineRotation.diagnostics.category === "position-minutes") {
          rejectedByConstraint.rotationPositionMinutes += 1;
        } else {
          rejectedByConstraint.rotationMinutes += 1;
        }
        return;
      }

      // A custom rotation workload score remains authoritative for the actual
      // minute plan. It is not necessarily an upper bound on the model score
      // used to rank rosters, so compute a second relaxed allocation only in
      // that advanced API case. With ordinary model scores, the baseline itself
      // is already the exact ranking bound and no duplicate solve is needed.
      const rankingBoundRotation = callerRotationScores
        ? allocateSelectedRotation(selectedPlayers, {
            includeProjectedConstraints: false,
            rankingUpperBound: true,
          })
        : baselineRotation;
      if (!rankingBoundRotation.ok) {
        if (rankingBoundRotation.diagnostics.category === "position-minutes") {
          rejectedByConstraint.rotationPositionMinutes += 1;
        } else {
          rejectedByConstraint.rotationMinutes += 1;
        }
        return;
      }

      const totals = calculateRotationTotals(selectedPlayers, baselineRotation);
      const rawUpperBound = calculateObjectiveScore(
        selectedPlayers,
        playerObjectiveScores,
        rankingBoundRotation,
      );
      const baselineRawScore = calculateObjectiveScore(
        selectedPlayers,
        playerObjectiveScores,
        baselineRotation,
      );
      const tieKey = selectedPlayers.map((player) => player.id).join("\u0001");
      const status = projectedConstraintStatus(totals, projectedRotationConstraints);
      if (status.passed) {
        baselineConstraintFeasible += 1;
        retainFeasibleCombination(
          selectedPlayers,
          positionResult,
          baselineRotationWithConstraintAudit(baselineRotation, totals),
          totals,
          baselineRawScore,
        );
        return;
      }

      const proof = proveProjectedConstraintInfeasibility(
        selectedPlayers,
        boundsFromRotation(baselineRotation),
        rotationPositionMinuteRequirements,
        projectedRotationConstraints,
        status,
      );
      if (proof.impossibleStats.length > 0 || proof.impossibleTurnovers) {
        recordProjectedConstraintRejection(
          proof.impossibleStats,
          proof.impossibleTurnovers,
        );
        return;
      }

      // Passing the independent production bounds does not prove joint
      // feasibility. Preserve the full roster for pass 2, ordered by the exact
      // objective upper bound; do not count it as rejected or feasible yet.
      unresolvedRotationCandidates.push({
        _rawScore: rawUpperBound,
        _tieKey: tieKey,
        players: selectedPlayers,
        positionResult,
      });
      return;
    }

    // Rotation allocation comes before scoring and production constraints. The
    // resulting minute plan is part of the candidate—not a decorative schedule
    // added after an equal-player roster has already won.
    let rotation = null;
    if (normalizedConfig.mode === "rotation") {
      rotation = allocateSelectedRotation(selectedPlayers);
      if (!rotation.ok) {
        if (rotation.diagnostics.category === "position-minutes") {
          rejectedByConstraint.rotationPositionMinutes += 1;
        } else if (
          rotation.diagnostics.category === "projected-constraints" ||
          rotation.diagnostics.category === "constraint-search-limit"
        ) {
          recordProjectedConstraintRejection(
            rotation.diagnostics.failedStatMinimums,
            rotation.diagnostics.failedMaxTurnovers,
          );
          if (rotation.diagnostics.category === "constraint-search-limit") {
            rejectedByConstraint.constraintSearchLimit += 1;
            exactSearchAbort = {
              category: "constraint-search-limit",
              diagnostics: rotation.diagnostics,
            };
          }
        } else {
          rejectedByConstraint.rotationMinutes += 1;
        }
        return;
      }
    }
    const totals = rotation
      ? calculateRotationTotals(selectedPlayers, rotation)
      : calculateLineupTotals(selectedPlayers);

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

    retainFeasibleCombination(
      selectedPlayers,
      positionResult,
      rotation,
      totals,
      calculateObjectiveScore(selectedPlayers, playerObjectiveScores, rotation),
    );
  }

  function enumerate(startIndex, remainingSlots) {
    if (exactSearchAbort) return;
    if (remainingSlots === 0) {
      evaluateCombination();
      return;
    }
    const lastStart = availablePlayers.length - remainingSlots;
    for (let index = startIndex; index <= lastStart; index += 1) {
      chosen.push(availablePlayers[index]);
      enumerate(index + 1, remainingSlots - 1);
      chosen.pop();
      if (exactSearchAbort) break;
    }
  }

  enumerate(0, slotsToChoose);

  if (hasRotationProjectedConstraints) {
    // Pass 2 processes only unresolved rosters, highest attainable score first.
    // Because `alternativeSort` orders both the upper-bound queue and the
    // retained shortlist, the first candidate that cannot enter a full top-K
    // proves that every remaining candidate is also irrelevant to that top-K.
    unresolvedRotationCandidates.sort(upperBoundSort);
    for (let index = 0; index < unresolvedRotationCandidates.length; index += 1) {
      const candidate = unresolvedRotationCandidates[index];
      if (!upperBoundCanEnterTopK(candidate)) {
        constraintBoundPruned += 1;
        constraintUnclassified += 1;

        // A strictly lower numeric upper bound proves the rest of this
        // descending queue cannot enter either, so bulk-prune and stop. When a
        // candidate loses only on the lexicographic tie rule inside the score
        // tolerance, keep scanning: a later, microscopically lower bound can
        // still have an earlier tie key and win under `alternativeSort`.
        const cutoff = topAlternatives.at(-1);
        if (
          candidate._rawScore <
          cutoff._rawScore - OBJECTIVE_SCORE_TOLERANCE
        ) {
          const remainingAfterCandidate = unresolvedRotationCandidates.length - index - 1;
          constraintBoundPruned += remainingAfterCandidate;
          constraintUnclassified += remainingAfterCandidate;
          break;
        }
        continue;
      }

      constrainedCandidatesSearched += 1;
      const rotation = allocateSelectedRotation(candidate.players, {
        includeProjectedConstraints: true,
      });
      if (!rotation.ok) {
        if (rotation.diagnostics.category === "position-minutes") {
          rejectedByConstraint.rotationPositionMinutes += 1;
        } else if (
          rotation.diagnostics.category === "projected-constraints" ||
          rotation.diagnostics.category === "constraint-search-limit"
        ) {
          recordProjectedConstraintRejection(
            rotation.diagnostics.failedStatMinimums,
            rotation.diagnostics.failedMaxTurnovers,
          );
          if (rotation.diagnostics.category === "constraint-search-limit") {
            rejectedByConstraint.constraintSearchLimit += 1;
            constraintUnclassified += unresolvedRotationCandidates.length - index;
            exactSearchAbort = {
              category: "constraint-search-limit",
              diagnostics: rotation.diagnostics,
            };
            // This contender's unconstrained upper bound could still enter the
            // retained shortlist. Returning any partial answer would therefore
            // falsely claim exactness, so preserve the established safe abort.
            break;
          }
        } else {
          rejectedByConstraint.rotationMinutes += 1;
        }
        continue;
      }

      const totals = calculateRotationTotals(candidate.players, rotation);
      const status = projectedConstraintStatus(totals, projectedRotationConstraints);
      if (!status.passed) {
        // Defensive parity check: the allocator normally makes this branch
        // unreachable, but rounded public totals must never slip into results
        // that fail the visible constraint audit.
        recordProjectedConstraintRejection(
          status.failedStatMinimums,
          status.failedMaxTurnovers,
        );
        continue;
      }
      retainFeasibleCombination(
        candidate.players,
        candidate.positionResult,
        rotation,
        totals,
        calculateObjectiveScore(candidate.players, playerObjectiveScores, rotation),
      );
    }
  }

  function buildDiagnostics() {
    return {
      ...baseDiagnostics,
      combinationsEvaluated,
      feasibleCombinations,
      rejectedByConstraint,
      ...(normalizedConfig.mode === "rotation"
        ? {
            rotationAllocationStrategy: "per-candidate-minute-weighted",
            rotationAllocationsComputed,
            requiredPositionMinutes: { ...rotationPositionMinuteRequirements },
            constraintSearchStatesUsed: solveConstraintSearchBudget?.used ?? 0,
            constraintSearchStateLimit: solveConstraintSearchBudget?.limit ?? null,
            ...(hasRotationProjectedConstraints
              ? {
                  constrainedRotationSearchStrategy: "two-pass-exact-upper-bound",
                  baselineConstraintFeasible,
                  baselineFeasibleCombinations: baselineConstraintFeasible,
                  unresolvedConstraintCandidates: unresolvedRotationCandidates.length,
                  constrainedCandidatesQueued: unresolvedRotationCandidates.length,
                  constrainedCandidatesSearched,
                  constrainedCandidatesAttempted: constrainedCandidatesSearched,
                  constraintBoundPruned,
                  upperBoundPrunedCandidates: constraintBoundPruned,
                  constraintUnclassified,
                  feasibleCombinationCountComplete: constraintUnclassified === 0,
                  exactTopKProven: !exactSearchAbort,
                  exactAlternativeRankingCompleted: !exactSearchAbort,
                  rotationBaselineAllocationsComputed,
                  rotationRankingBoundAllocationsComputed,
                  rotationConstrainedAllocationsComputed,
                }
              : {}),
          }
        : {}),
    };
  }

  let diagnostics = buildDiagnostics();
  if (exactSearchAbort) {
    const hitSolveWideLimit = Boolean(
      exactSearchAbort.diagnostics.solveWideConstraintSearchLimitReached,
    );
    const triggeredLimit = hitSolveWideLimit
      ? solveConstraintSearchBudget.limit
      : MAX_CONSTRAINED_ALLOCATION_STATES;
    const safeLimitDescription = hitSolveWideLimit
      ? `the solve-wide browser-safe limit of ${triggeredLimit.toLocaleString()}`
      : `the per-roster browser-safe limit of ${triggeredLimit.toLocaleString()}`;
    return failureResult(mode, size, [
      `Exact constrained rotation search stopped after ${solveConstraintSearchBudget.used.toLocaleString()} solve-wide states when a candidate reached ${safeLimitDescription}. No lineup was returned because an unproven remaining candidate could be better than the feasible candidates already found.`,
    ], {
      ...diagnostics,
      category: "performance",
      subcategory: "constraint-search-limit",
      exactSearchCompleted: false,
      feasibleCombinationsBeforeAbort: feasibleCombinations,
      constraintSearchStatesUsed: solveConstraintSearchBudget.used,
      constraintSearchStateLimit: triggeredLimit,
      solveConstraintSearchStateLimit: solveConstraintSearchBudget.limit,
      solveWideConstraintSearchLimitReached: hitSolveWideLimit,
      allocationDiagnostics: exactSearchAbort.diagnostics,
    });
  }
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
    if (rejectedByConstraint.rotationPositionMinutes > 0) {
      reasons.push(
        `${rejectedByConstraint.rotationPositionMinutes} candidate rotation${rejectedByConstraint.rotationPositionMinutes === 1 ? "" : "s"} could not cover ${rotationPositionMinuteRequirements.G} guard, ${rotationPositionMinuteRequirements.F} forward, and ${rotationPositionMinuteRequirements.C} center minutes within the configured player limits.`,
      );
    }
    if (rejectedByConstraint.constraintSearchLimit > 0) {
      reasons.push(
        `${rejectedByConstraint.constraintSearchLimit} candidate rotation${rejectedByConstraint.constraintSearchLimit === 1 ? "" : "s"} reached the constrained minute-search safety limit before feasibility could be proven. Tighten the roster pool or minute bounds and try again.`,
      );
    }
    return failureResult(mode, size, reasons, diagnostics);
  }

  const alternatives = [];
  for (const [index, alternative] of topAlternatives.entries()) {
    const rotation = alternative.rotation;
    const objective = calculateObjective(
      alternative.players,
      normalizedMetrics,
      normalizedConfig.weights,
      normalizedConfig.normalizedWeights,
      rotation,
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
      playerContributions: objective.playerContributions,
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
