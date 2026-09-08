/**
 * Dependency-free basketball lineup and rotation optimizer.
 *
 * The optimizer is intentionally data-source agnostic. Callers can adapt a
 * Basketball Reference response (or any other source) to the documented player
 * shape before invoking this module.
 */

import {
  DEFAULT_MAX_EXACT_COMBINATIONS,
  DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS,
  DEFAULT_PRESETS,
} from "./optimizer-config.js?v=20260907f";
import {
  DEFAULT_PROJECTION_RISK,
  HISTORICAL_PROJECTION_MODEL_VERSION,
  PROJECTION_RISK_KEYS,
  projectionParametersFor,
} from "./projection-parameters.js?v=20260907f";
import {
  projectMetricForResponsibility,
  projectRotationUsageDemand,
  readPlayerUsage,
  readResponsibilityEvidence,
  readSeasonRoleMinutes,
  responsibilityExpansionFor,
} from "./player-projection.js?v=20260907f";
import { workloadUtilityCurve, workloadRate } from "./workload-model.js?v=20260907f";
import { SCOUT_GAME_EVIDENCE_VERSION, pairedMetricEvidence, posteriorRate, cardinalMetricScore, demonstratedShootingValue, shootingOpportunity,
  decisionRateAtWorkload, concaveDecisionCurve } from "./projection-evidence.js?v=20260907f";
import {
  buildLineupRoleModel,
  DEFAULT_ROLE_BALANCE,
  ROLE_BALANCE_KEYS,
  scoreLineupRoleFit,
} from "./lineup-role-model.js?v=20260907f";
import {
  buildScoutImpactModel,
  buildScoutMinuteObjective,
  SCOUT_MODEL_MODES,
  scoreScoutCandidate,
  resolveScoutObjectiveWeights,
} from "./scout-impact.js?v=20260907f";
import { planRotationUnits } from "./rotation-unit-planner.js?v=20260907f";

export {
  DEFAULT_MAX_EXACT_COMBINATIONS,
  DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS,
  DEFAULT_PRESETS,
};

const OBJECTIVE_METRICS = Object.freeze([
  "points",
  "efgPct",
  "threePct",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "ballSecurity",
  // Basketball Reference's OBPM/DBPM are used only as modest validation
  // signals inside the fan-facing skill families. They remain explicit here
  // so the exact objective and its explanation never hide an all-in-one score.
  "offensiveImpact",
  "defensiveImpact",
]);

const ADVANCED_IMPACT_OBJECTIVE_METRICS = new Set([
  "offensiveImpact",
  "defensiveImpact",
]);

// Scout RAPM has separate offense/defense components. These familiar game-plan
// families determine the blend when Scout mode is selected; they do not create
// a hidden composite priority. If a visitor leaves every family at zero, the
// Scout adapter uses an even offense/defense read rather than guessing intent.
const SCOUT_OFFENSE_OBJECTIVE_METRICS = Object.freeze([
  "points",
  "efgPct",
  "threePct",
  "assists",
  "ballSecurity",
  "offensiveImpact",
]);
const SCOUT_DEFENSE_OBJECTIVE_METRICS = Object.freeze([
  "rebounds",
  "steals",
  "blocks",
  "defensiveImpact",
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

// A rate-based score answers which profiles best match the visitor's game
// plan. That—not reproducing the source team's real rotation—is the default
// product goal. Recorded team-stint workload remains an optional, advanced
// comparison/capacity mode for someone who explicitly wants a historical
// reality check.
export const DEFAULT_ROTATION_MINUTE_PLAN = "openWhatIf";
const ROTATION_MINUTE_PLANS = Object.freeze({
  HISTORICAL_AWARE: "historicalAware",
  OPEN_WHAT_IF: "openWhatIf",
});
export const DEFAULT_ROTATION_MINUTE_FLEXIBILITY = 8;

// This setting applies only after a visitor explicitly opts into the advanced
// historical-workload mode. Strategy-first remains the safer default there:
// the visitor's stated game plan still determines how the selected group is
// used, while recorded workload is an optional capacity/continuity lens.
export const DEFAULT_HISTORICAL_ALLOCATION_STYLE = "strategyFirst";
const HISTORICAL_ALLOCATION_STYLES = Object.freeze({
  PRESERVE_WORKLOAD: "preserveWorkload",
  STRATEGY_FIRST: "strategyFirst",
});

// Per-36 removes opportunity bias but a 150-minute rate is still much less
// certain than a 2,000-minute rate. Where the data adapter provides a same
// season/phase baseline and the appropriate raw sample, blend the observed
// rate toward that baseline. This is deliberately a stability adjustment,
// not an all-in-one player-impact estimate.
export const DEFAULT_ROTATION_RATE_STABILITY = "sampleAdjusted";
// Version the fan-facing statistical model independently from the solver
// implementation. The exact enumerator/min-cost flow can remain unchanged
// while its evidence model evolves, and a future possession-level Scout model
// can identify itself separately instead of silently changing the public
// Fit-vs.-NBA-Baseline benchmark.
export const HISTORICAL_RATE_MODEL_VERSION = HISTORICAL_PROJECTION_MODEL_VERSION;
const ROTATION_RATE_STABILITY_MODES = Object.freeze({
  SAMPLE_ADJUSTED: "sampleAdjusted",
  RAW: "raw",
});

// Kept as exported compatibility constants for existing integrations. They
// deliberately make the rotation score 100% user-game-plan fit: source
// workload is evidence for the rate projection, not a second objective that
// can overrule a user's requirements.
export const ROTATION_STRATEGY_SHARE = 1;
export const ROTATION_HISTORICAL_READINESS_SHARE = 0;
// Team membership is provenance, not a minute target. Prefer matched all-team
// season evidence; if only team evidence exists, keep its real sample size.
// Confidence may differ, but no synthetic appearance count or prescribed
// rotation recreates how long a player stayed with the selected club.
const DEFAULT_PROJECTION_PARAMETERS = projectionParametersFor(DEFAULT_PROJECTION_RISK);

// A prior-only mean is not measured league-average ability. Posterior working
// uncertainty supplies a separate downside reserve; there is no fixed 8%
// discount or imaginary appearance sample. Shooting opportunity has its own
// count/exposure reserve. These are disclosed decision sensitivities, not
// calibrated player intervals, hard minute bounds, or coaching targets.
// BPM is centered at league average (zero) and is expressed as estimated
// points per 100 possessions. Fit vs. NBA Baseline is an explanatory index rather than a
// literal point differential, so a moderate five index points per BPM point
// keeps this secondary signal bounded and subordinate to the user's box-score
// priorities.
const PLAN_FIT_INDEX_POINTS_PER_BPM = 5;

// Integer-flow edge costs encode each assigned-minute utility difference.
// The posterior is formed once from matching observed evidence; conditional
// workload sensitivity is then applied at the actual proposed minutes, never
// at 240 / roster size. Keep costs below Number's exact integer ceiling.
const ROLE_CONDITIONED_UTILITY_COST_SCALE = 1_000_000_000;
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

// A constrained minute state costs roughly 0.4 ms on the slow path observed in
// browser QA. This is a per-candidate proof guard for an unusually difficult
// set of production thresholds; it is not a ceiling on how many candidate
// rotations the outer exact search may inspect.
export const DEFAULT_MAX_CONSTRAINED_SOLVE_STATES = 10000;
export const MAX_CONSTRAINED_SOLVE_STATES = 15000;
// The browser only needs a handful of alternatives. Capping this protects the
// exact enumerator from retaining an unbounded number of otherwise feasible
// groups when this module is called outside the visible UI.
export const MAX_EXACT_ALTERNATIVES = 50;

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

    // `positionMinuteCaps` is optional metadata supplied by the UI's position
    // flexibility policy. It limits minutes *at a role*, not the player's
    // total minutes. For example, a season-listed PF with a verified career C
    // role may play 36 total minutes while covering at most 24 of them at C.
    const positionMinuteCaps = {};
    if (player.positionMinuteCaps !== undefined) {
      if (!isPlainObject(player.positionMinuteCaps)) {
        reasons.push(`${label} (${id || "unknown id"}) positionMinuteCaps must be an object.`);
      } else {
        for (const [position, rawCap] of Object.entries(player.positionMinuteCaps)) {
          const normalizedPosition = String(position).toUpperCase();
          const cap = Number(rawCap);
          if (!positions.includes(normalizedPosition)) {
            reasons.push(`${label} (${id || "unknown id"}) has a minute cap for an ineligible position: ${normalizedPosition}.`);
          } else if (!Number.isFinite(cap) || cap < 0 || cap > 48) {
            reasons.push(`${label} (${id || "unknown id"}) has an invalid 0–48 minute cap for ${normalizedPosition}.`);
          } else {
            positionMinuteCaps[normalizedPosition] = cap;
          }
        }
      }
    }

    normalized.push({
      ...player,
      ...numericValues,
      id,
      name: String(player.name ?? id).trim() || id,
      team: String(player.team ?? "").trim(),
      positions,
      positionMinuteCaps,
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
    'rotationOptions.minutePlan must be either "openWhatIf" (the default game-plan mode) or "historicalAware" (the optional workload guardrail).',
  );
  return DEFAULT_ROTATION_MINUTE_PLAN;
}

/**
 * Normalize how an otherwise realistic historical plan distributes minutes.
 * This is intentionally separate from the roster objective: the exact search
 * always uses the visitor's strategy to choose a group, then this policy says
 * whether its final minute plan should retain source workload or lean into the
 * strategy inside the declared historical band.
 */
function normalizeHistoricalAllocationStyle(value, reasons) {
  if (value === undefined || value === null) return DEFAULT_HISTORICAL_ALLOCATION_STYLE;
  const compact = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "preserveworkload" || compact === "continuity" || compact === "historical") {
    return HISTORICAL_ALLOCATION_STYLES.PRESERVE_WORKLOAD;
  }
  if (compact === "strategyfirst" || compact === "strategy") {
    return HISTORICAL_ALLOCATION_STYLES.STRATEGY_FIRST;
  }
  reasons.push(
    'rotationOptions.historicalAllocationStyle must be either "preserveWorkload" or "strategyFirst" (the default).',
  );
  return DEFAULT_HISTORICAL_ALLOCATION_STYLE;
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

  // Rotation enumeration is deliberately uncapped by candidate count. Ignore
  // the legacy maxCombinations option in that mode so an older shared config
  // cannot accidentally reintroduce the retired cutoff. Five-player lineup
  // mode keeps its separate browser safeguard because it does not use the
  // rotation Worker's long-running-search contract.
  const maxCombinations = mode === "rotation"
    ? null
    : normalizeNonNegativeNumber(
      config.maxCombinations,
      DEFAULT_MAX_EXACT_COMBINATIONS,
      "maxCombinations",
      reasons,
      true,
    );
  if (mode !== "rotation" && maxCombinations < 1) {
    reasons.push("maxCombinations must be at least 1.");
  }
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
  // Counterfactual swaps restrict selection without redefining the population
  // used to estimate rates, metric availability, ranks, or Scout score units.
  // Ordinary exclusions retain their existing meaning; only the replacement
  // workflow supplies this separate, nonpersistent selection restriction.
  const selectionOnlyExcludedIds = normalizeIdList(config.selectionOnlyExcludedIds, "selectionOnlyExcludedIds", reasons);

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
  if (!Number.isFinite(weightTotal)) reasons.push("The combined objective weights must be finite; reduce their scale while keeping the same proportions.");
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
  const rotationHistoricalAllocationStyle = normalizeHistoricalAllocationStyle(
    rotationOptions.historicalAllocationStyle,
    reasons,
  );
  const rotationRateStability = normalizeRotationRateStability(
    rotationOptions.rateStability,
    reasons,
  );
  const projectionRisk = rotationOptions.projectionRisk ?? config.projectionRisk ?? DEFAULT_PROJECTION_RISK;
  const offensiveResponsibilities = rotationOptions.offensiveResponsibilities ?? config.offensiveResponsibilities ?? {};
  // Support the same scenario field for five-player and rotation callers. An
  // explicitly supplied top-level usage map must not be silently ignored.
  if (rotationOptions.offensiveResponsibilities != null && config.offensiveResponsibilities != null
    && isPlainObject(rotationOptions.offensiveResponsibilities) && isPlainObject(config.offensiveResponsibilities)) {
    const allIds = new Set([...Object.keys(rotationOptions.offensiveResponsibilities), ...Object.keys(config.offensiveResponsibilities)]);
    if ([...allIds].some(id => rotationOptions.offensiveResponsibilities[id] !== config.offensiveResponsibilities[id])) {
      reasons.push("Top-level and rotation offensiveResponsibilities disagree. Supply one map or identical maps.");
    }
  }
  if (!isPlainObject(offensiveResponsibilities)) reasons.push("offensiveResponsibilities must map player ids to an on-court possession share from 0 to 1.");
  else for (const [id, share] of Object.entries(offensiveResponsibilities)) {
    if (!id || typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) {
      reasons.push(`Offensive responsibility for ${id} must be a finite share from 0 to 1.`);
    }
  }
  if (!PROJECTION_RISK_KEYS.includes(projectionRisk)) {
    reasons.push(`projectionRisk must be one of: ${PROJECTION_RISK_KEYS.join(", ")}.`);
  }
  const roleBalance = rotationOptions.roleBalance ?? config.roleBalance ?? DEFAULT_ROLE_BALANCE;
  if (!ROLE_BALANCE_KEYS.includes(roleBalance)) {
    reasons.push(`roleBalance must be one of: ${ROLE_BALANCE_KEYS.join(", ")}.`);
  }
  const modelMode = rotationOptions.modelMode ?? config.modelMode ?? "historical";
  if (!SCOUT_MODEL_MODES.includes(modelMode)) {
    reasons.push(`modelMode must be one of: ${SCOUT_MODEL_MODES.join(", ")}.`);
  }
  const scoutEvidence = rotationOptions.scoutEvidence ?? config.scoutEvidence ?? null;
  const scoutObjective = config.scoutObjective ?? "balanced";
  let scoutObjectiveWeights;
  try { scoutObjectiveWeights = resolveScoutObjectiveWeights(config.scoutObjectiveWeights, scoutObjective); }
  catch (error) { reasons.push(error.message); }
  const sourceScope = isPlainObject(config.sourceScope) ? config.sourceScope : null;
  if (scoutEvidence !== null && !isPlainObject(scoutEvidence)) {
    reasons.push("scoutEvidence must be an object when provided.");
  }
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
      selectionOnlyExcludedIds,
      positionMinimums,
      statMinimums,
      maxTurnovers,
      weights,
      normalizedWeights,
      presetName,
      rotationOptions,
      rotationScoringBasis,
      rotationMinutePlan,
      rotationHistoricalAllocationStyle,
      rotationRateStability,
      offensiveResponsibilities,
      projectionRisk: PROJECTION_RISK_KEYS.includes(projectionRisk)
        ? projectionRisk
        : DEFAULT_PROJECTION_RISK,
      roleBalance: ROLE_BALANCE_KEYS.includes(roleBalance)
        ? roleBalance
        : DEFAULT_ROLE_BALANCE,
      modelMode: SCOUT_MODEL_MODES.includes(modelMode) ? modelMode : "historical",
      scoutEvidence,
      scoutObjective,
      scoutObjectiveWeights,
      sourceScope,
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
  if (ADVANCED_IMPACT_OBJECTIVE_METRICS.has(metric)) {
    // A matching all-team BPM value must accompany all-team minutes. Never
    // shrink the selected-team coefficient using another scope's exposure.
    const seasonValue = seasonWideAdvancedImpactMetricValue(player, metric);
    if (scoringBasis === ROTATION_SCORING_BASES.PER_36 && Number.isFinite(seasonValue)) return seasonValue;
    return advancedImpactMetricValue(player, metric);
  }
  if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) {
    const paired = pairedMetricEvidence(player, metric);
    // New Scout observations must not borrow a displayed legacy box-score
    // rate when their component is unavailable. Sample-adjusted scoring can
    // use a disclosed prior-only estimate; raw mode retains missingness.
    if (!paired) return Number.NaN;
    return scoringBasis === ROTATION_SCORING_BASES.PER_36 || !RATE_NORMALIZED_OBJECTIVE_METRICS.has(metric)
      ? paired.value : paired.numerator / paired.verifiedGames;
  }
  const sourceField = metric === "ballSecurity" ? "turnovers" : metric;
  const sourceValue = Number(player[sourceField]);
  // A team row establishes roster membership, but a traded player's complete
  // season is the sounder rate estimate. When the adapter supplies an audited
  // all-team aggregate, use both its numerator and denominator together. This
  // avoids the invalid hybrid of ranking a four-game team-stint spike with the
  // confidence earned by a full-season sample.
  if (scoringBasis === ROTATION_SCORING_BASES.PER_36) {
    const paired = pairedMetricEvidence(player, metric);
    if (paired) return paired.value;
  }
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
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function seasonWideTotalsForPlayer(player) {
  return isPlainObject(player?.analytics?.seasonTotals)
    ? player.analytics.seasonTotals
    : null;
}

/**
 * Resolve the complete-season rate used by rotation mode.
 *
 * Counting totals are converted to per 36 with the season's own minutes.
 * Shooting percentages are recomputed from makes and attempts instead of
 * averaging team-stint percentages. Missing pieces return `null`, allowing a
 * metric-by-metric fallback to the selected-team per-appearance profile.
 */
function seasonWideObjectiveMetricValue(player, metric) {
  const totals = seasonWideTotalsForPlayer(player);
  if (!totals) return null;
  if (metric === "efgPct") {
    const made = finiteNonNegative(totals.fieldGoalsMade);
    const threesMade = finiteNonNegative(totals.threePointFieldGoalsMade);
    const attempts = finiteNonNegative(totals.fieldGoalsAttempted);
    return made !== null && threesMade !== null && attempts > 0
      ? (made + (0.5 * threesMade)) / attempts
      : null;
  }
  if (metric === "threePct") {
    const made = finiteNonNegative(totals.threePointFieldGoalsMade);
    const attempts = finiteNonNegative(totals.threePointFieldGoalsAttempted);
    return made !== null && attempts > 0 ? made / attempts : null;
  }
  if (!RATE_NORMALIZED_OBJECTIVE_METRICS.has(metric)) return null;
  const field = metric === "ballSecurity"
    ? "turnovers"
    : metric === "rebounds"
      ? "totalRebounds"
      : metric;
  const total = finiteNonNegative(totals[field]);
  const minutes = finiteNonNegative(totals.minutes);
  return total !== null && minutes > 0 ? (total / minutes) * 36 : null;
}

/**
 * Use all-team season MPG (or a verified Scout game subset) as role-size
 * evidence when it is available. This is not a historical minute target or
 * limit: it only answers how large a role has supported the observed rate
 * before the optimizer projects it to a different responsibility. If that
 * season-wide/verified evidence is absent, return `null` instead of falling
 * back to the selected-team stint's MPG. A team stint can still provide a
 * descriptive player row and a confidence sample, but it must not silently
 * set the workload at which a rate is treated as established.
 */
function seasonWideRoleMinutesPerGame(player, metric = null) {
  if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) return readSeasonRoleMinutes(player, metric);
  const totals = seasonWideTotalsForPlayer(player);
  const games = finiteNonNegative(totals?.games);
  const minutes = finiteNonNegative(totals?.minutes);
  if (games > 0 && minutes !== null) return minutes / games;
  // A strict adapter may carry the season-wide responsibility contract without
  // duplicating the full seasonTotals envelope. Keep that evidence eligible as
  // a role-size anchor while still refusing a selected-team fallback here.
  const responsibility = readResponsibilityEvidence(player);
  if (responsibility?.scope === "season-wide" && responsibility.games > 0) {
    return Math.min(48, responsibility.minutes / responsibility.games);
  }
  return null;
}

/**
 * Resolve signed Basketball Reference impact estimates without converting a
 * missing value into zero. Zero is a real, league-average BPM result; `NaN`
 * means the source cannot support this objective metric for the current row.
 */
function advancedImpactMetricValue(player, metric) {
  const advanced = isPlainObject(player?.analytics?.advanced)
    ? player.analytics.advanced
    : null;
  if (!advanced) return Number.NaN;
  const aliases = metric === "offensiveImpact"
    ? ["offensive_box_plus_minus", "offensiveBoxPlusMinus", "obpm"]
    : ["defensive_box_plus_minus", "defensiveBoxPlusMinus", "dbpm"];
  for (const key of aliases) {
    // Null, blank, and boolean provider fields are missing evidence, not a
    // measured league-average impact. Preserve a real numeric zero.
    if (advanced[key] == null || advanced[key] === "" || typeof advanced[key] === "boolean") continue;
    const value = Number(advanced[key]);
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

function seasonWideAdvancedImpactMetricValue(player, metric) {
  const advanced = isPlainObject(player?.analytics?.seasonAdvanced)
    ? player.analytics.seasonAdvanced
    : null;
  if (!advanced) return Number.NaN;
  const aliases = metric === "offensiveImpact"
    ? ["offensive_box_plus_minus", "offensiveBoxPlusMinus", "obpm"]
    : ["defensive_box_plus_minus", "defensiveBoxPlusMinus", "dbpm"];
  for (const key of aliases) {
    if (advanced[key] == null || advanced[key] === "" || typeof advanced[key] === "boolean") continue;
    const value = Number(advanced[key]);
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

/**
 * Return actual exposure for the matching scope, never an invented number of
 * appearances. Prefer all-team counts only when the caller has a matching
 * all-team value. Otherwise retain actual team exposure and label its scope.
 * A short team record can mean less evidence when no all-team value exists;
 * that changes statistical confidence, not a hard minute target or cap.
 */
function standardizedOpportunitySample(
  player,
  teamStintTotals,
  field,
  { allowSeasonWide = true } = {},
) {
  if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) {
    const scout = player.analytics.scoutPlayerGameEvidence;
    const sample = field === "minutes" && scout?.version === SCOUT_GAME_EVIDENCE_VERSION
      && scout.scope?.playerId === player.id && scout.workload?.verifiedGames > 0
      ? finiteNonNegative(scout.workload.minutes) : null;
    return sample === null ? null : { sample, sampleScope: "scout-verified-player-game-subset" };
  }
  const seasonTotals = isPlainObject(player?.analytics?.seasonTotals)
    ? player.analytics.seasonTotals
    : null;
  const seasonSample = allowSeasonWide
    ? finiteNonNegative(seasonTotals?.[field])
    : null;
  if (seasonSample !== null) {
    return { sample: seasonSample, sampleScope: "season-wide" };
  }

  const stintTotal = finiteNonNegative(teamStintTotals?.[field]);
  return stintTotal === null ? null : { sample: stintTotal, sampleScope: "selected-team-observed" };
}

/**
 * Locate the evidence needed to shrink a per-36 rate toward a published
 * same-season baseline. The adapter deliberately keeps this metadata outside
 * the optimizer's canonical player schema, so CSV/demo callers remain fully
 * supported and simply retain raw rate ranking when the evidence is absent.
 */
function rateStabilityEvidence(player, metric, parameters = DEFAULT_PROJECTION_PARAMETERS) {
  const analytics = isPlainObject(player?.analytics) ? player.analytics : null;
  const totals = isPlainObject(analytics?.totals) ? analytics.totals : null;
  const baseline = isPlainObject(analytics?.leaguePer36) ? analytics.leaguePer36 : null;

  if (ADVANCED_IMPACT_OBJECTIVE_METRICS.has(metric)) {
    if (!Number.isFinite(objectiveMetricValue(player, metric, ROTATION_SCORING_BASES.PER_36))) return null;
    // A season-wide BPM coefficient may use season-wide minutes. A team-stint
    // BPM must retain actual matching team minutes; otherwise an
    // unrelated all-team box-score sample would grant confidence to the wrong
    // numerator.
    const hasSeasonWideImpact = Number.isFinite(
      seasonWideAdvancedImpactMetricValue(player, metric),
    );
    const opportunity = standardizedOpportunitySample(
      player,
      totals,
      "minutes",
      { allowSeasonWide: hasSeasonWideImpact },
    );
    return {
      ...(opportunity || { sample: 0, sampleScope: "unavailable" }),
      signed: true,
      metric,
      prior: parameters.priorImpactMinutes,
      // Basketball Reference BPM is explicitly centered on league average.
      baseline: 0,
      denominator: opportunity?.sampleScope === "season-wide"
        ? "season-wide total minutes"
        : opportunity ? "observed selected-team minutes" : "no observed sample",
    };
  }

  if (!baseline) return null;

  // Select a matched count/exposure pair first. If the all-team sum contains a
  // gap, a complete selected-team pair may still be used, explicitly labelled.
  // If both are missing, zero evidence means a prior-only estimate, never a
  // synthetic 50-game sample. This also avoids making every other player raw
  // just because one row lacks a count.
  const paired = pairedMetricEvidence(player, metric);
  const reference = finiteNonNegative(baseline[metric === "ballSecurity" ? "turnovers" : metric]);
  if (reference === null) return null;
  return {
    ...(paired || { sample: 0, sampleScope: "unavailable" }),
    metric,
    baseline: reference,
    prior: metric === "efgPct" ? parameters.priorFieldGoalAttempts
      : metric === "threePct" ? parameters.priorThreePointAttempts
        : parameters.priorMinutesByMetric[metric] ?? 700,
    denominator: paired ? `${paired.sampleScope} ${metric === "efgPct" ? "field-goal attempts" : metric === "threePct" ? "three-point attempts" : "minutes"}` : "no paired observed sample",
  };
}

/**
 * Apply a conservative empirical-Bayes-style blend only when all of its
 * inputs are actually supplied by the current source. A zero-attempt or
 * zero-minute row is still legitimate evidence of *no* player sample, so it
 * blends fully to the shared baseline instead of receiving a free raw-rate
 * advantage over a comparable player with complete metadata.
 */
function stabilizedObjectiveMetricValue(
  player,
  metric,
  scoringBasis,
  rateStability,
  suppliedEvidence = undefined,
  roleMinutesTarget = null,
  applyUncertaintyReserve = true,
  projectionParameters = DEFAULT_PROJECTION_PARAMETERS,
) {
  const raw = objectiveMetricValue(player, metric, scoringBasis);
  if (
    scoringBasis !== ROTATION_SCORING_BASES.PER_36 ||
    rateStability !== ROTATION_RATE_STABILITY_MODES.SAMPLE_ADJUSTED
  ) {
    return {
      value: raw,
      adjusted: false,
      sampleAdjusted: false,
      uncertaintyAdjusted: false,
      uncertaintyReserve: 0,
      roleAdjusted: false,
    };
  }
  const evidence = suppliedEvidence === undefined
    ? rateStabilityEvidence(player, metric, projectionParameters)
    : suppliedEvidence;
  if (!evidence || evidence.sample === null || !(evidence.prior >= 0)) {
    return {
      value: raw,
      adjusted: false,
      sampleAdjusted: false,
      uncertaintyAdjusted: false,
      uncertaintyReserve: 0,
      roleAdjusted: false,
    };
  }

  // Use actual matched exposure, never a standardized/imagined appearance
  // count. Team sample size affects confidence only when no complete all-team
  // pair exists; it never specifies an assigned-minute target.
  const sampleReliability = evidence.sample + evidence.prior > 0 ? evidence.sample / (evidence.sample + evidence.prior) : 0;
  const posterior = posteriorRate(raw, evidence);
  const sampleAdjustedValue = posterior.mean;

  // Responsibility is modeled separately from minutes. A high-usage player is
  // not penalized simply for receiving a larger workload. A low-usage player
  // projected into an unobserved rotation role is tested against the additional
  // possessions that role may need to absorb; only an above-baseline advantage
  // is reduced. The helper falls back transparently when older fixtures do not
  // include usage, and never reads team-stint games or total minutes.
  const responsibilityProjection = projectMetricForResponsibility({
    player,
    metric,
    observedValue: sampleAdjustedValue,
    baselineValue: evidence.baseline,
    // Establish the posterior at the observed role once. The minute allocator
    // applies expansion to the actual assigned role; projecting to 240/N here
    // and decaying again later would count the same uncertainty twice.
    targetMinutes: seasonWideRoleMinutesPerGame(player, metric),
    parameters: projectionParameters,
  });
  const roleAdjustedMean = responsibilityProjection.value;
  const roleReliability = responsibilityProjection.rateRetention;
  const roleAdjusted = responsibilityProjection.adjusted;

  // Apply the evidence-confidence reserve *after* the expected larger-role
  // projection. These safeguards answer different questions: role expansion
  // estimates the mean rate at the requested responsibility, while the reserve
  // asks how cautiously the exact decision should treat that estimate. Applying
  // the reserve before role expansion caused the role blend to pull part of the
  // reserve back toward the baseline, unintentionally erasing the caution for
  // precisely the low-opportunity profiles that needed it most.
  //
  // The reserve is expressed in the metric's own units, so it works consistently
  // for points per 36, rebounding, shooting percentages, and ball security.
  // Signed BPM estimates use a zero baseline and already have a substantially
  // larger 1,200-minute prior; without a source variance estimate, inventing a
  // fixed BPM reserve would be less defensible than retaining their ordinary
  // shrinkage toward zero.
  const uncertaintyReserve = applyUncertaintyReserve
    ? (posterior.standardError ?? 0) * projectionParameters.decisionUncertaintyWeight : 0;
  const confidenceAdjustedValue = metric === "ballSecurity"
    ? roleAdjustedMean + uncertaintyReserve
    : ADVANCED_IMPACT_OBJECTIVE_METRICS.has(metric)
      ? roleAdjustedMean - uncertaintyReserve : Math.max(0, roleAdjustedMean - uncertaintyReserve);
  const uncertaintyAdjusted = uncertaintyReserve > 1e-12;
  const opportunity = metric === "threePct" || metric === "efgPct"
    ? shootingOpportunity(evidence, applyUncertaintyReserve ? projectionParameters.decisionUncertaintyWeight : 0)
    : null;
  return {
    value: confidenceAdjustedValue,
    adjusted: true,
    sampleAdjusted: true,
    uncertaintyAdjusted,
    uncertaintyReserve,
    roleAdjusted,
    sampleScope: evidence.sampleScope,
    reliability: sampleReliability,
    roleReliability,
    responsibilitySource: responsibilityProjection.source,
    sourceMinutes: responsibilityProjection.sourceMinutes,
    sourceUsage: responsibilityProjection.sourceUsage,
    targetUsage: responsibilityProjection.targetUsage,
    usageRatio: responsibilityProjection.usageRatio,
    evidenceGrade: responsibilityProjection.evidenceGrade,
    denominator: evidence.denominator,
    posteriorMean: roleAdjustedMean,
    standardError: posterior.standardError,
    uncertaintySource: posterior.uncertaintySource,
    clusterEvidenceGames: posterior.clusterEvidenceGames ?? 0,
    baseline: evidence.baseline,
    participationPer36: opportunity?.decisionPer36 ?? evidence.participationPer36,
    shootingOpportunity: opportunity,
  };
}

function buildNormalizedMetrics(
  players,
  {
    scoringBasis = ROTATION_SCORING_BASES.PER_GAME,
    rateStability = ROTATION_RATE_STABILITY_MODES.RAW,
    roleMinutesTarget = null,
    projectionParameters = DEFAULT_PROJECTION_PARAMETERS,
  } = {},
) {
  const byPlayerId = new Map(players.map((player) => [player.id, {}]));
  const projectionInputsById = new Map(players.map(player => [player.id, {}]));
  // Keep the projected per-minute counting rates beside the percentile data so
  // roster ranking, projected threshold feasibility, and displayed team totals
  // all use the same conservative role-expansion assumption. Without this,
  // the score could discount a tiny-role outlier while the output still
  // promised his raw per-minute production at starter minutes.
  const projectedRatesByPlayerId = new Map(players.map((player) => [player.id, {}]));
  // The static projected rates evaluate the player's observed workload once.
  // These companion maps retain the same-season baseline behind each
  // supported metric, so the exact minute allocator can value only the *extra*
  // minutes beyond a player's established role at that baseline. Keeping these
  // separate avoids mutating the canonical player rows or inventing a rate when
  // the source did not supply the required evidence.
  const baselineProjectedRatesByPlayerId = new Map(players.map((player) => [player.id, {}]));
  const baselinePercentilesByPlayerId = new Map(players.map((player) => [player.id, {}]));
  // Pool percentiles are ideal for exact ranking, but they move when the user
  // changes the eligible roster. Keep a second, source-anchored index for the
  // result screen: 100 means the same-season NBA baseline for that metric.
  // This benchmark never affects selection, so unavailable source evidence is
  // reported instead of imputed.
  const benchmarkIndexesByPlayerId = new Map(players.map((player) => [player.id, {}]));
  const benchmarkMetrics = new Set();
  const adjustedPlayerIds = new Set();
  const uncertaintyAdjustedPlayerIds = new Set();
  const roleAdjustedPlayerIds = new Set();
  const seasonWideEvidencePlayerIds = new Set();
  const perAppearanceEvidencePlayerIds = new Set();
  const baselineOnlyPlayerIds = new Set();
  const seasonWideRatePlayerIds = new Set();
  let adjustedPlayerMetricCount = 0;
  let uncertaintyAdjustedPlayerMetricCount = 0;
  let roleAdjustedPlayerMetricCount = 0;
  let seasonWideEvidencePlayerMetricCount = 0;
  let perAppearanceEvidencePlayerMetricCount = 0;
  let baselineOnlyPlayerMetricCount = 0;
  let seasonWideRatePlayerMetricCount = 0;
  const stabilizedMetrics = [];
  // A metric can have a finite legacy value for every row while its paired
  // numerator/denominator evidence is present for only part of the pool.
  // Keep this state separate from fully stabilized metrics so the report can
  // say exactly when unsupported rows received a disclosed baseline prior.
  const partiallyStabilizedMetrics = [];
  const rawMetricsDueToIncompleteEvidence = [];
  const incompleteBaselineMetrics = [];
  const availableMetrics = [];
  const unavailableMetrics = [];
  const evidenceByMetric = {};
  for (const metric of OBJECTIVE_METRICS) {
    const rawValues = players.map((player) => objectiveMetricValue(player, metric, scoringBasis));
    // Canonical box-score fields are validated before this point. Optional
    // impact fields are different: require a finite source value for every
    // eligible row. The solver later removes an unavailable metric's requested
    // weight and renormalizes the remaining priorities, rather than assigning
    // a made-up zero to only the players whose data is missing.
    const evidenceByPlayer = players.map((player) =>
      rateStabilityEvidence(player, metric, projectionParameters));
    const hasUsableEvidence = (evidence) => Boolean(
      evidence
      && Number.isFinite(evidence.sample) && evidence.sample >= 0
      && typeof evidence.sampleScope === "string"
      && evidence.sampleScope !== "unavailable"
      && Number.isFinite(evidence.prior) && evidence.prior >= 0
      && Number.isFinite(evidence.baseline),
    );
    const hasBaselineEvidence = (evidence) => Boolean(
      evidence
      && Number.isFinite(evidence.prior) && evidence.prior > 0
      && Number.isFinite(evidence.baseline),
    );
    const evidenceBackedCount = evidenceByPlayer.filter(hasUsableEvidence).length;
    const requiresRateEvidence = scoringBasis === ROTATION_SCORING_BASES.PER_36
      && rateStability === ROTATION_RATE_STABILITY_MODES.SAMPLE_ADJUSTED;
    // Each unsupported row must have its OWN season-bound baseline. Borrowing
    // another player's reference can silently mix eras and carry over that
    // player's sample moments. Construct a fresh prior-only record instead.
    const scoringEvidenceByPlayer = evidenceByPlayer.map(evidence => hasUsableEvidence(evidence)
      ? evidence : hasBaselineEvidence(evidence) ? {
        metric, baseline: evidence.baseline, prior: evidence.prior,
        signed: evidence.signed === true, sample: 0, numerator: 0,
        sampleScope: "baseline-only-prior", denominator: "no paired observed sample",
      } : null);
    // Partial evidence must not disable shrinkage for everyone and thereby
    // restore a noisy raw-rate advantage. Exclude the unsupported metric from
    // this objective; keep wholly legacy/no-metadata demos in explicit raw mode.
    const missingOwnBaseline = requiresRateEvidence && evidenceByPlayer.some(Boolean)
      && scoringEvidenceByPlayer.some(evidence => !evidence);
    const metricAvailable = rawValues.every(Number.isFinite) && !missingOwnBaseline;
    if (metricAvailable) availableMetrics.push(metric);
    else unavailableMetrics.push(metric);
    if (missingOwnBaseline) incompleteBaselineMetrics.push(metric);
    const partiallyStabilizeMetric = requiresRateEvidence
      && metricAvailable
      && evidenceBackedCount < players.length
      && scoringEvidenceByPlayer.every(Boolean);
    const canStabilizeMetric = requiresRateEvidence
      && metricAvailable
      && evidenceByPlayer.every(hasUsableEvidence);
    const canUseBaselineOnlyRows = canStabilizeMetric || partiallyStabilizeMetric;
    if (partiallyStabilizeMetric) partiallyStabilizedMetrics.push(metric);
    // Expose the evidence actually supporting each metric, not a single
    // misleading "season data available" badge for a partly populated row.
    // These are coverage counts, NOT confidence probabilities or intervals.
    evidenceByMetric[metric] = {
      eligiblePlayers: players.length,
      evidenceBackedPlayers: evidenceBackedCount,
      evidenceComplete: evidenceBackedCount === players.length,
      baselineOnlyRowsUsed: partiallyStabilizeMetric ? players.length - evidenceBackedCount : 0,
      matchingSeasonSamples: evidenceByPlayer.filter(evidence => evidence?.sampleScope === "season-wide").length,
      observedTeamSamples: evidenceByPlayer.filter(evidence => evidence?.sampleScope === "selected-team-observed").length,
      verifiedScoutSamples: evidenceByPlayer.filter(evidence => evidence?.sampleScope === "scout-verified-player-game-subset").length,
      approximateSamples: 0,
      missingSamples: evidenceByPlayer.filter(evidence => !hasUsableEvidence(evidence)).length,
      metricAvailable,
    };
    // Stabilize actual samples and disclose baseline-only rows. An incomplete
    // mixed-source metric is unavailable, not a reason to remove safeguards.
    if (canStabilizeMetric) stabilizedMetrics.push(metric);
    else if (partiallyStabilizeMetric) {
      // Keep this out of the raw-incomplete list: unsupported rows are being
      // handled consistently, but the result still reports them as prior-only.
    } else if (requiresRateEvidence && metricAvailable && evidenceByPlayer.some(Boolean)) {
      rawMetricsDueToIncompleteEvidence.push(metric);
    }
    const measured = players.map((player, index) => {
      if (!metricAvailable) return { id: player.id, value: 0 };
      const evidence = scoringEvidenceByPlayer[index];
      const value = stabilizedObjectiveMetricValue(
        player,
        metric,
        scoringBasis,
        rateStability,
        canUseBaselineOnlyRows ? evidence : null,
        roleMinutesTarget,
        true,
        projectionParameters,
      );
      if (value.sampleAdjusted) projectionInputsById.get(player.id)[metric] = value;
      if (value.adjusted) {
        adjustedPlayerIds.add(player.id);
        adjustedPlayerMetricCount += 1;
      }
      if (value.uncertaintyAdjusted) {
        uncertaintyAdjustedPlayerIds.add(player.id);
        uncertaintyAdjustedPlayerMetricCount += 1;
      }
      if (value.roleAdjusted) {
        roleAdjustedPlayerIds.add(player.id);
        roleAdjustedPlayerMetricCount += 1;
      }
      if (value.sampleAdjusted && value.sampleScope === "baseline-only-prior") {
        baselineOnlyPlayerIds.add(player.id);
        baselineOnlyPlayerMetricCount += 1;
      } else if (value.sampleAdjusted && value.sampleScope === "season-wide") {
        seasonWideEvidencePlayerIds.add(player.id);
        seasonWideEvidencePlayerMetricCount += 1;
      } else if (value.sampleAdjusted) {
        perAppearanceEvidencePlayerIds.add(player.id);
        perAppearanceEvidencePlayerMetricCount += 1;
      }
      const metricEvidence = hasUsableEvidence(evidenceByPlayer[index])
        ? evidenceByPlayer[index]
        : null;
      if (
        scoringBasis === ROTATION_SCORING_BASES.PER_36
        && metricEvidence?.sampleScope === "season-wide"
        && (
          seasonWideObjectiveMetricValue(player, metric) !== null
          || Number.isFinite(seasonWideAdvancedImpactMetricValue(player, metric))
        )
      ) {
        seasonWideRatePlayerIds.add(player.id);
        seasonWideRatePlayerMetricCount += 1;
      }
      if (RATE_NORMALIZED_OBJECTIVE_METRICS.has(metric)) {
        const field = metric === "ballSecurity" ? "turnovers" : metric;
        const sourceMinutes = Number(player.minutes);
        const rawPerMinute = Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")
          ? objectiveMetricValue(player, metric, ROTATION_SCORING_BASES.PER_36) / 36
          : sourceMinutes > 0 ? Number(player[field]) / sourceMinutes : 0;
        // Stabilization is defined in a per-36 unit, so translate it back to
        // per minute for all 240-minute feasibility and reporting math. The
        // legacy per-game comparison intentionally retains raw source rates.
        projectedRatesByPlayerId.get(player.id)[field] =
          scoringBasis === ROTATION_SCORING_BASES.PER_36
            ? value.value / 36
            : rawPerMinute;
        if (canUseBaselineOnlyRows && evidence) {
          // `evidence.baseline` is in the same per-36 unit as `value`. Preserve
          // the baseline per-minute rate separately; it is used only for an
          // assigned minute above the player's established role, never as a
          // fabricated source stat or a restriction on playing time.
          baselineProjectedRatesByPlayerId.get(player.id)[field] =
            evidence.baseline / 36;
        }
      }
      return { id: player.id, value: canUseBaselineOnlyRows
        ? demonstratedShootingValue(value.value, value.participationPer36, metric, value.baseline,
          value.shootingOpportunity?.observedPer36) : value.value };
    });
    players.forEach((player, index) => {
      if (!metricAvailable) return;
      const evidence = evidenceByPlayer[index];
      // A prior-only estimate is a decision assumption, not evidence that a
      // player is NBA-average. Preserve unavailable benchmark cells for it.
      // Real paired evidence can still support this descriptive benchmark when
      // the user intentionally chose the raw/per-game objective mode.
      if (!hasUsableEvidence(evidence)) return;
      // Both builds use the same per-36 comparison unit, not an assumed role
      // of 240 / roster size. Rotation curves evaluate actual assigned minutes.
      //
      // Keep the explanatory Fit-vs.-NBA-Baseline benchmark on the posterior-mean
      // projection, without the one-sided decision reserve. The exact search
      // and projected production remain deliberately conservative, but this
      // separation preserves the intuitive meaning of 100: a player projected
      // exactly at the same-season NBA baseline still displays as 100. It also
      // prevents a risk preference from being mistaken for a claim that the
      // player's expected rate is below average.
      const benchmarkProjection = stabilizedObjectiveMetricValue(
        player,
        metric,
        ROTATION_SCORING_BASES.PER_36,
        ROTATION_RATE_STABILITY_MODES.SAMPLE_ADJUSTED,
        evidence,
        Number(roleMinutesTarget) > 0 ? roleMinutesTarget : 36,
        false,
        projectionParameters,
      );
      const projected = Number(benchmarkProjection.value);
      if (!Number.isFinite(projected)) return;
      let benchmarkIndex;
      if (ADVANCED_IMPACT_OBJECTIVE_METRICS.has(metric)) {
        // BPM already has an interpretable zero baseline and can be negative.
        // Converting it additively avoids a divide-by-zero special case and
        // keeps this modest validation signal on the same 0–200 display range.
        benchmarkIndex = 100 + (projected * PLAN_FIT_INDEX_POINTS_PER_BPM);
      } else {
        if (!(evidence.baseline > 0) || projected < 0) return;
        const ratio = metric === "ballSecurity"
          ? projected > 0
            ? evidence.baseline / projected
            : 2
          : projected / evidence.baseline;
        benchmarkIndex = ratio * 100;
      }
      // A bounded display avoids one near-zero denominator dominating a group
      // index. It remains distinct from evidence-adjusted objective utility.
      benchmarkIndexesByPlayerId.get(player.id)[metric] = round(
        Math.max(0, Math.min(200, benchmarkIndex)),
      );
      benchmarkMetrics.add(metric);
    });
    // Compatibility/raw mode retains pool ranks. Recommended evidence mode
    // uses fixed cardinal gaps, so a noisy .2 BPM gap cannot turn into a
    // 40-percentile advantage merely because a roster has many near ties.
    const percentiles = canUseBaselineOnlyRows
      ? new Map(measured.map((entry, index) => {
        const evidence = scoringEvidenceByPlayer[index];
        return [entry.id, evidence
          ? cardinalMetricScore(entry.value, evidence.baseline, metric)
          : 0];
      }))
      : percentileNormalize(measured, { lowerIsBetter: metric === "ballSecurity" });
    if (canUseBaselineOnlyRows) {
      // Keep the baseline on the SAME cardinal scale. eFG objective utility
      // is surplus shooting value, so league-average efficiency is zero before
      // normalization, not a raw .54/.55 percentage on the surplus-points axis.
      players.forEach((player, index) => {
        const evidence = scoringEvidenceByPlayer[index];
        if (!evidence) return;
        baselinePercentilesByPlayerId.get(player.id)[metric] = cardinalMetricScore(
          metric === "efgPct" ? 0 : evidence.baseline, evidence.baseline, metric);
      });
    }
    for (const player of players) {
      byPlayerId.get(player.id)[metric] = percentiles.get(player.id);
    }
  }
  const partialStabilizationReason = partiallyStabilizedMetrics.length
    ? `For ${partiallyStabilizedMetrics.join(", ")}, rows without paired counts use the published same-season baseline as a prior only; they receive no invented volume or observed sample.`
    : "";
  const incompleteEvidenceReason = rawMetricsDueToIncompleteEvidence.length
    ? `${rawMetricsDueToIncompleteEvidence.join(", ")} remained raw because no common baseline/evidence policy was available.`
    : "";
  const incompleteBaselineReason = incompleteBaselineMetrics.length
    ? `${incompleteBaselineMetrics.join(", ")} were removed from the objective because some rows lack their own matching baseline; no other player's reference was borrowed.`
    : "";
  const roleExpansionReason = roleAdjustedPlayerMetricCount > 0
    ? `Role expansion is evaluated at ${round(Number(roleMinutesTarget))} minutes where a target was supplied.`
    : "";
  const stabilizationReason = [
    "Applied equal-treatment rate stabilization and a separate evidence-confidence reserve.",
    roleExpansionReason,
    partialStabilizationReason,
    incompleteEvidenceReason,
    incompleteBaselineReason,
    "Team-stint length did not affect the projection.",
  ].filter(Boolean).join(" ");
  return {
    metrics: byPlayerId,
    projectionInputsById,
    projectedRatesByPlayerId,
    baselineProjectedRatesByPlayerId,
    baselinePercentilesByPlayerId,
    benchmarkIndexesByPlayerId,
    availableMetrics,
    unavailableMetrics,
    rateStability: {
      modelVersion: HISTORICAL_RATE_MODEL_VERSION,
      requested: rateStability,
      applied: adjustedPlayerMetricCount > 0,
      adjustedPlayers: adjustedPlayerIds.size,
      adjustedPlayerMetricCount,
      uncertaintyAdjustedPlayers: uncertaintyAdjustedPlayerIds.size,
      uncertaintyAdjustedPlayerMetricCount,
      projectionRisk: projectionParameters.key,
      workloadCalibration: projectionParameters.calibration ? {
        version: projectionParameters.calibration.version,
        seasonEndYear: projectionParameters.calibration.seasonEndYear,
        phase: projectionParameters.calibration.phase,
        testGames: projectionParameters.calibration.split.testGames,
        validatedLineupForecast: false,
      } : null,
      uncertaintyReserveShare: projectionParameters.uncertaintyReserveShare,
      roleMinutesTarget:
        Number.isFinite(Number(roleMinutesTarget)) && Number(roleMinutesTarget) > 0
          ? round(Number(roleMinutesTarget))
          : null,
      roleAdjustedPlayers: roleAdjustedPlayerIds.size,
      roleAdjustedPlayerMetricCount,
      seasonWideEvidencePlayers: seasonWideEvidencePlayerIds.size,
      seasonWideEvidencePlayerMetricCount,
      perAppearanceEvidencePlayers: perAppearanceEvidencePlayerIds.size,
      perAppearanceEvidencePlayerMetricCount,
      baselineOnlyPlayers: baselineOnlyPlayerIds.size,
      baselineOnlyPlayerMetricCount,
      seasonWideRatePlayers: seasonWideRatePlayerIds.size,
      seasonWideRatePlayerMetricCount,
      eligiblePlayers: players.length,
      stabilizedMetrics,
      partiallyStabilizedMetrics,
      rawMetricsDueToIncompleteEvidence,
      incompleteBaselineMetrics,
      benchmarkMetrics: [...benchmarkMetrics],
      availableMetrics,
      unavailableMetrics,
      teamStintLengthAffectsProjection: false,
      selectedTeamFallback: "Actual selected-team evidence is used only where a paired all-team rate is unavailable; its sample affects confidence, never hard minute limits.",
      evidenceReferenceGames: null,
      objectiveScale: "league-anchored-cardinal-with-raw-compatibility-fallback",
      evidenceByMetric,
      shootingObjective: {
        accuracyEvidence: "Actual matching makes and attempts; posterior mean plus a separate downside reserve.",
        frequencyEvidence: "Matching total attempts and minutes; observed rate with a Poisson-score downside sensitivity, not a fitted role forecast.",
        threePct: "Supported three-point accuracy times a saturating supported attempt-frequency factor.",
        efgPct: "Two times efficiency above/below the same-season baseline times supported FGA per 36; deficits retain observed volume.",
        calibratedVolumeResponse: false,
      },
      uncertainty: {
        calibratedPlayerIntervalsAvailable: false,
        decisionWeight: projectionParameters.decisionUncertaintyWeight,
        interpretation: "The decision reserve uses model-based sampling uncertainty and widens outside observed workload support. It is a sensitivity assumption, not a calibrated player interval or causal fatigue forecast. The posterior mean and decision reserve are separate.",
        approximateSampleCaveat: "No synthetic sample sizes are used. Missing paired evidence uses only the row's own baseline prior. Mixed-source metrics without matching baselines are unavailable; wholly legacy sources retain an explicit raw comparison.",
      },
      // Per-game is intentionally a compatibility mode. Presenting raw values
      // as sample-adjusted in that branch would mix unlike units.
      reason:
        scoringBasis !== ROTATION_SCORING_BASES.PER_36
          ? "Rate stabilization applies only to the per-36 comparison basis."
          : rateStability === ROTATION_RATE_STABILITY_MODES.RAW
            ? "Rate stabilization was disabled for this result, so the model used raw per-36 rates."
            : adjustedPlayerMetricCount > 0
              ? stabilizationReason
              : incompleteBaselineMetrics.length ? incompleteBaselineReason
                : "No rate stabilization was applied. Consult per-metric evidence coverage; a legacy source with no paired metadata uses raw per-36 comparisons.",
    },
  };
}

/**
 * Convert requested weights into the evidence-supported objective used by the
 * exact search. This is primarily an advanced-metric guard: if one eligible
 * player lacks OBPM or DBPM, that metric is disabled for everybody and its
 * share is proportionally redistributed among the remaining requested inputs.
 * A missing value therefore cannot be silently treated as league-average.
 */
function buildEffectiveObjectiveWeights(requestedWeights, availableMetrics) {
  const available = new Set(Array.isArray(availableMetrics) ? availableMetrics : []);
  const weights = Object.fromEntries(OBJECTIVE_METRICS.map((metric) => [
    metric,
    available.has(metric) ? Math.max(0, Number(requestedWeights?.[metric]) || 0) : 0,
  ]));
  const disabledRequestedMetrics = OBJECTIVE_METRICS.filter(
    (metric) => !available.has(metric) && Number(requestedWeights?.[metric]) > 0,
  );
  const total = OBJECTIVE_METRICS.reduce((sum, metric) => sum + weights[metric], 0);
  return {
    weights,
    normalizedWeights: Object.fromEntries(OBJECTIVE_METRICS.map((metric) => [
      metric,
      total > 0 ? weights[metric] / total : 0,
    ])),
    total,
    disabledRequestedMetrics,
    renormalized: disabledRequestedMetrics.length > 0 && total > 0,
  };
}

/**
 * Translate the visible game-plan priorities into the offense/defense mix for
 * the optional Scout RAPM layer. This is deliberately a family split, not a
 * new opaque "Scout score": the visitor can still see and control every
 * underlying basketball priority. An empty custom objective stays neutral.
 */
function scoutFamilyWeightsFrom(normalizedWeights) {
  const sum = (metrics) => metrics.reduce(
    (total, metric) => total + Math.max(0, Number(normalizedWeights?.[metric]) || 0),
    0,
  );
  const offense = sum(SCOUT_OFFENSE_OBJECTIVE_METRICS);
  const defense = sum(SCOUT_DEFENSE_OBJECTIVE_METRICS);
  const total = offense + defense;
  return total > 0
    ? { offense: offense / total, defense: defense / total }
    : { offense: 0.5, defense: 0.5 };
}

/**
 * Build the minute-aware companion to the ordinary per-36 score. The static
 * score starts from the sample-adjusted observed profile. The matching-season
 * path uses fitted conditional rates and an explicitly disclosed concavity
 * guard. Other seasons retain the conditional mean and separate decision
 * reserve rather than inventing a cross-season response coefficient. Neither
 * path applies an artificial curve at 240 / roster size. A
 * low-minute player can still earn a large role, and a dominant player can
 * still reach the user's maximum.
 *
 * The plan is calculated once over the full eligible pool, not separately for
 * each candidate lineup. That keeps the evidence/normalization fixed and lets the
 * exact combination search compare every roster under the same assumptions.
 */
function buildRoleConditionedProjectionPlan(
  players,
  normalizedMetrics,
  normalizedWeights,
  metricResult,
  projectionParameters = DEFAULT_PROJECTION_PARAMETERS,
  scoutMinuteObjective = null,
) {
  const referenceMinutes = finiteNonNegative(metricResult?.rateStability?.roleMinutesTarget);
  const stabilizedMetrics = Array.isArray(metricResult?.rateStability?.stabilizedMetrics)
    ? metricResult.rateStability.stabilizedMetrics
    : [];
  const partiallyStabilizedMetrics = Array.isArray(metricResult?.rateStability?.partiallyStabilizedMetrics)
    ? metricResult.rateStability.partiallyStabilizedMetrics
    : [];
  const objectiveMetrics = OBJECTIVE_METRICS.filter(
    (metric) => Number(normalizedWeights?.[metric]) > 1e-12,
  );
  // Partial coverage still has one common baseline-only policy, so it belongs
  // in the same minute-aware plan. Prior-only rates remain explicitly labelled;
  // a missing own-season baseline does not authorize another player's prior.
  const activeMetrics = [...new Set([...stabilizedMetrics, ...partiallyStabilizedMetrics])].filter(
    (metric) => Number(normalizedWeights?.[metric]) > 1e-12,
  );
  // Raw-rate mode leaves activeMetrics empty, so no evidence response changes
  // its rates. It must not acquire a hidden roster-average utility penalty.
  if (!(referenceMinutes > 0)) return null;

  const evidenceMinutesById = new Map();
  const establishedScoresById = new Map();
  const expandedScoresById = new Map();
  const expandedMetricPercentilesById = new Map();
  const expandedProjectedRatesByPlayerId = new Map();
  const establishedBenchmarkIndexesById = new Map();
  const expandedBenchmarkIndexesById = new Map();
  const transitionMinutesById = new Map();
  const calibratedUtilityCurvesById = new Map();
  const calibratedMetricCurvesById = new Map();
  const calibratedProductionCurvesById = new Map();
  const calibratedBenchmarkCurvesById = new Map();
  // Keep the responsibility decision beside the curves. Two players can
  // share a per-36 line while having very different amounts of verified
  // offensive work behind it. The exact allocator uses these player-specific
  // profiles; the returned map lets the explanation layer show which prior was
  // applied. None of this changes eligibility or user minute bounds.
  const responsibilityExpansionById = new Map();
  const responsibilityExpansionSourceCounts = new Map();
  const responsibilityPriorPlayerIds = new Set();
  const calibratedResponsibilityPlayerIds = new Set();
  let responsibilityPriorPlayerMetricCount = 0;
  let calibratedResponsibilityPlayerMetricCount = 0;
  let concavityGuardedPlayerMinutes = 0;
  let changesAnyScore = false;

  for (const player of players) {
    const id = player.id;
    const metrics = normalizedMetrics.get(id) ?? {};
    const baselineMetrics = metricResult.baselinePercentilesByPlayerId?.get(id) ?? {};
    const sourceRoleMinutes = seasonWideRoleMinutesPerGame(player);
    // Use all-team season MPG when available, never games with this team or
    // 240 / roster size. This is evidence for projection, not a minute cap.
    const establishedRoleMinutes = Math.max(0, Math.min(48, sourceRoleMinutes ?? referenceMinutes));
    // `projectionInputsById` may use a selected-team sample as the denominator
    // for confidence when no complete all-team pair exists. That sample is
    // valid uncertainty evidence, but it must not become the role origin for
    // the conditional mean. Keep the workload curve anchored to the
    // season-wide/verified role above, or to the neutral reference only when
    // no such role evidence exists.
    const roleSourceMinutes = establishedRoleMinutes > 0
      ? establishedRoleMinutes
      : referenceMinutes;
    evidenceMinutesById.set(id, establishedRoleMinutes);

    // Retain transition metadata for legacy consumers. Actual exposure is
    // labelled by scope; the compiled paired-evidence curves below supersede
    // this legacy transition whenever supported inputs are available.
    const roleEvidence = standardizedOpportunitySample(
      player,
      player?.analytics?.totals,
      "minutes",
    );
    const evidenceMinutes = roleEvidence?.sample ?? 0;
    const evidenceReliability = evidenceMinutes / (evidenceMinutes + 700);
    transitionMinutesById.set(id, 4 + (12 * evidenceReliability));

    // Resolve expansion once per player/metric so the static score, projected
    // production, and the exact minute curve cannot disagree about whether a
    // rate has a validated workload fit or only the evidence-gated
    // responsibility prior. The prior is intentionally player-specific and
    // only applies to offensive responsibility-sensitive metrics.
    const responsibilityProfiles = {};
    for (const metric of OBJECTIVE_METRICS) {
      const profile = responsibilityExpansionFor(player, metric, projectionParameters);
      responsibilityProfiles[metric] = profile;
      if (profile.strength > 0 && activeMetrics.includes(metric)) {
        responsibilityExpansionSourceCounts.set(
          profile.source,
          (responsibilityExpansionSourceCounts.get(profile.source) || 0) + 1,
        );
        if (profile.source === "responsibility-evidence-prior") {
          responsibilityPriorPlayerIds.add(id);
          responsibilityPriorPlayerMetricCount += 1;
        } else if (profile.source === "chronological-workload-fit") {
          calibratedResponsibilityPlayerIds.add(id);
          calibratedResponsibilityPlayerMetricCount += 1;
        }
      }
    }
    responsibilityExpansionById.set(id, responsibilityProfiles);

    const expandedMetrics = {};
    let establishedScore = 0;
    let expandedScore = 0;
    for (const metric of OBJECTIVE_METRICS) {
      const weight = Number(normalizedWeights?.[metric]) || 0;
      const establishedPercentile = Number(metrics[metric]) || 0;
      const baselinePercentile = activeMetrics.includes(metric)
        ? finiteNonNegative(baselineMetrics[metric])
        : null;
      // Expanding an unproven role may remove an advantage, but it must never
      // manufacture one. This clamp fixes the former edge case where a player
      // below league baseline improved merely because the old model replaced
      // his extra minutes with the (better) baseline.
      const expansionProfile = responsibilityProfiles[metric];
      const fittedExpansion = expansionProfile?.strength ?? 0;
      const expandedPercentile = baselinePercentile === null || fittedExpansion <= 0
        ? establishedPercentile
        : Math.min(establishedPercentile, baselinePercentile);
      expandedMetrics[metric] = expandedPercentile;
      establishedScore += establishedPercentile * weight;
      expandedScore += expandedPercentile * weight;
    }
    // Scout's player signal must obey the same diminishing-return objective as
    // every other minute value. Blend the bounded Scout percentile into both
    // the established and expanded score instead of adding a roster bonus once
    // minutes have already been chosen. The same blend is used below when the
    // reported score is reconciled to this exact allocation.
    const scoutPercentile = Number(
      scoutMinuteObjective?.scoutPercentilesById?.get(id),
    );
    const scoutBlend = Number(scoutMinuteObjective?.blend);
    if (
      scoutMinuteObjective?.applied &&
      Number.isFinite(scoutPercentile) &&
      Number.isFinite(scoutBlend) &&
      scoutBlend > 0 &&
      scoutBlend < 1
    ) {
      establishedScore = ((1 - scoutBlend) * establishedScore) + (scoutBlend * scoutPercentile);
      expandedScore = ((1 - scoutBlend) * expandedScore) + (scoutBlend * scoutPercentile);
    }
    establishedScoresById.set(id, establishedScore);
    expandedScoresById.set(id, expandedScore);
    expandedMetricPercentilesById.set(id, expandedMetrics);

    // Mirror the same one-way expansion assumption on the stable, league-
    // anchored display index. Evidence-backed scoring uses cardinal differences;
    // legacy raw scoring still uses percentiles. These display maps are separate:
    // these maps only make the displayed NBA-baseline index match the minutes that
    // the selected rotation was actually assigned.
    const establishedBenchmarkIndexes = metricResult.benchmarkIndexesByPlayerId?.get(id) ?? {};
    const expandedBenchmarkIndexes = {};
    for (const metric of OBJECTIVE_METRICS) {
      const establishedIndex = Number(establishedBenchmarkIndexes[metric]);
      if (!Number.isFinite(establishedIndex)) continue;
      const expansionProfile = responsibilityProfiles[metric];
      expandedBenchmarkIndexes[metric] = activeMetrics.includes(metric)
        && (expansionProfile?.strength ?? 0) > 0
        ? Math.min(establishedIndex, 100)
        : establishedIndex;
    }
    establishedBenchmarkIndexesById.set(id, establishedBenchmarkIndexes);
    expandedBenchmarkIndexesById.set(id, expandedBenchmarkIndexes);

    const establishedRates = metricResult.projectedRatesByPlayerId?.get(id) ?? {};
    const baselineRates = metricResult.baselineProjectedRatesByPlayerId?.get(id) ?? {};
    const expandedRates = {};
    for (const field of ["points", "rebounds", "assists", "steals", "blocks", "turnovers"]) {
      const establishedRate = finiteNonNegative(establishedRates[field]);
      const baselineRate = finiteNonNegative(baselineRates[field]);
      if (establishedRate === null || baselineRate === null) continue;
      // Lower turnover rates are better; every other projected total is a
      // higher-is-better quantity. Apply the conservative direction explicitly.
      const expansionProfile = responsibilityProfiles[field === "turnovers" ? "ballSecurity" : field];
      const fittedExpansion = expansionProfile?.strength ?? 0;
      expandedRates[field] = fittedExpansion <= 0 ? establishedRate : field === "turnovers"
        ? Math.max(establishedRate, baselineRate)
        : Math.min(establishedRate, baselineRate);
    }
    expandedProjectedRatesByPlayerId.set(id, expandedRates);
    if (metricResult.projectionInputsById) {
      const curves = {};
      const total = Array(49).fill(0);
      const production = {};
      for (const metric of OBJECTIVE_METRICS) {
        const input = metricResult.projectionInputsById.get(id)?.[metric];
        const field = metric === "ballSecurity" ? "turnovers" : metric;
        const quantities = [0];
        const predictions = [0];
        for (let minute = 1; minute <= 48; minute++) {
          if (!input) {
            predictions.push(minute * (Number(metrics[metric]) || 0));
            // Missing context is not zero production. Retain an actually
            // supported linear rate when available, and omit an unsupported
            // quantity curve below so the reader preserves its missing value.
            quantities.push(minute * playerPerMinuteRate(player, field, metricResult.projectedRatesByPlayerId));
            continue;
          }
          // One conditional-rate function supplies both the objective and
          // production constraints. The mean's fitted minute response is kept
          // separate from the explicitly chosen downside sensitivity reserve.
          const expansionProfile = responsibilityProfiles[metric];
          const mean = workloadRate({ value: input.posteriorMean, baseline: input.baseline,
            sample: 1, prior: 0, sourceMinutes: roleSourceMinutes, targetMinutes: minute,
            strength: expansionProfile?.strength ?? 0,
            lowerIsBetter: metric === "ballSecurity" });
          const projected = decisionRateAtWorkload({ mean, standardError: input.standardError,
          sourceMinutes: input.sourceMinutes ?? establishedRoleMinutes, targetMinutes: minute,
            sourceUsage: input.sourceUsage,
            // Extra offensive responsibility is not extra defensive workload.
            targetUsage: SCOUT_OFFENSE_OBJECTIVE_METRICS.includes(metric) ? input.targetUsage : input.sourceUsage,
            risk: projectionParameters.decisionUncertaintyWeight,
            lowerIsBetter: metric === "ballSecurity", signed: ADVANCED_IMPACT_OBJECTIVE_METRICS.has(metric) });
          const scoringValue = demonstratedShootingValue(projected.decision, input.participationPer36, metric, input.baseline,
            input.shootingOpportunity?.observedPer36);
          predictions.push(minute * cardinalMetricScore(scoringValue, input.baseline, metric));
          quantities.push(minute * projected.decision / 36);
        }
        const curve = concaveDecisionCurve(predictions);
        curves[metric] = curve.totals;
        concavityGuardedPlayerMinutes += curve.guardedMinutes;
        for (let minute = 0; minute <= 48; minute++) total[minute] += curve.totals[minute] * (Number(normalizedWeights[metric]) || 0);
        if (RATE_NORMALIZED_OBJECTIVE_METRICS.has(metric) && quantities.every(Number.isFinite)) production[field] = quantities;
      }
      if (scoutMinuteObjective?.applied) {
        for (let minute = 0; minute <= 48; minute++) total[minute] = total[minute] * (1 - scoutBlend) + minute * scoutBlend * scoutPercentile;
      }
      calibratedUtilityCurvesById.set(id, total);
      calibratedMetricCurvesById.set(id, curves);
      // A raw m * rate table must not disable stronger linear certificates.
      if (Object.keys(metricResult.projectionInputsById.get(id) ?? {}).length > 0) {
        calibratedProductionCurvesById.set(id, production);
      }
      // A display index is descriptive, not allocation utility. Use the fitted
      // conditional mean here, without the solver's concavity approximation.
      const benchmarks = {};
      for (const [metric, value] of Object.entries(establishedBenchmarkIndexes)) {
        if (!Number.isFinite(value)) continue;
        const expansionProfile = responsibilityProfiles[metric];
        benchmarks[metric] = Array.from({ length: 49 }, (_, minute) => minute * workloadRate({
          value, baseline: Math.min(value, 100), sample: 1, prior: 0,
          sourceMinutes: roleSourceMinutes, targetMinutes: minute,
          strength: expansionProfile?.strength ?? 0,
        }));
      }
      calibratedBenchmarkCurvesById.set(id, benchmarks);
    }
    if (Math.abs(establishedScore - expandedScore) > 1e-12) changesAnyScore = true;
  }

  return {
    referenceMinutes,
    objectiveMetrics,
    activeMetrics,
    evidenceMinutesById,
    establishedScoresById,
    expandedScoresById,
    expandedMetricPercentilesById,
    expandedProjectedRatesByPlayerId,
    establishedBenchmarkIndexesById,
    expandedBenchmarkIndexesById,
    transitionMinutesById,
    calibratedUtilityCurvesById,
    calibratedMetricCurvesById,
    calibratedProductionCurvesById,
    calibratedBenchmarkCurvesById,
    responsibilityExpansionById,
    responsibilityExpansionSources: Object.fromEntries(
      [...responsibilityExpansionSourceCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    responsibilityPriorPlayers: responsibilityPriorPlayerIds.size,
    responsibilityPriorPlayerMetricCount,
    calibratedResponsibilityPlayers: calibratedResponsibilityPlayerIds.size,
    calibratedResponsibilityPlayerMetricCount,
    concavityGuardedPlayerMinutes,
    // Disable the legacy roster-average saturation. Only the evidence-based
    // response above changes utility; min/max outcomes can be genuine optima.
    workloadSaturationMarginalFloor: 1,
    workloadSaturationTransitionMinutes:
      projectionParameters.workloadSaturationTransitionMinutes,
    roleExpansionChangesAnyScore: changesAnyScore,
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
        .sort((left, right) => {
          // Prefer the position listed for this exact team-season when either
          // player can fill the slot. Verified career flexibility remains
          // available, but it is used only when it actually helps feasibility.
          const leftSeasonListed = Array.isArray(left?.positionEvidence?.seasonListed)
            && left.positionEvidence.seasonListed.includes(position);
          const rightSeasonListed = Array.isArray(right?.positionEvidence?.seasonListed)
            && right.positionEvidence.seasonListed.includes(position);
          if (leftSeasonListed !== rightSeasonListed) return leftSeasonListed ? -1 : 1;
          return comparePlayersById(left, right);
        }),
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
  for (const field of Object.keys(totals)) {
    const values = players.map(player => observedLineupStat(player, field));
    // Keep calculation precision through feasibility and replacement checks.
    // Rounding a total to six decimals can create or erase a tight hard-rule
    // violation. The UI already rounds for display; missing totals stay null.
    totals[field] = values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return totals;
}

/** One evidence scope for lineup bounds, feasibility, and displayed totals. */
function observedLineupStat(player, field) {
  if (!Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) return Number(player[field]);
  const metric = field === "turnovers" ? "ballSecurity" : field;
  const paired = pairedMetricEvidence(player, metric);
  return paired ? paired.numerator / paired.verifiedGames : Number.NaN;
}

/**
 * Project full-team box-score totals from a 240-minute rotation plan.
 *
 * Basketball Reference supplies per-game production and minutes per game. A
 * player's historical per-minute rate is therefore `stat / minutes`; applying
 * that rate to the proposed allocation makes rotation thresholds describe the
 * minutes that will actually be played. When the rotation model supplies a
 * conservative projected-rate map, use it here too: the same small-sample and
 * role-expansion correction that ranks a player must also temper what the
 * output promises at a larger proposed role. When the exact allocator applies
 * the minute-aware role curve, only assigned minutes beyond that player's
 * established role use the smooth conservative expansion rate. A zero-minute source row
 * contributes zero rather than manufacturing an undefined rate.
 */
function roleConditionedMinuteSplit(playerId, assignedMinutes, roleProjectionPlan) {
  const allocated = Math.max(0, Number(assignedMinutes) || 0);
  const establishedRoleMinutes = finiteNonNegative(
    roleProjectionPlan?.evidenceMinutesById?.get(playerId),
  );
  if (!(establishedRoleMinutes >= 0)) return { established: allocated, expanded: 0 };
  const established = Math.min(allocated, establishedRoleMinutes);
  return { established, expanded: Math.max(0, allocated - established) };
}

/**
 * Integrate only the evidence-based role-expansion curve.
 *
 * Projected box-score totals and the same-season NBA-baseline index use this
 * helper because the new workload-saturation term is an allocation utility,
 * not a claim that a 36th minute literally erases a fixed share of a player's
 * points or rebounds. Keeping those concepts separate preserves both honest
 * production estimates and the meaning of 100 as the league baseline.
 */
function roleExpansionValueUnits(
  playerId,
  assignedMinutes,
  establishedValue,
  expandedValue,
  roleProjectionPlan,
) {
  const split = roleConditionedMinuteSplit(playerId, assignedMinutes, roleProjectionPlan);
  if (split.expanded <= 0) return split.established * establishedValue;
  const transition = Math.max(
    0.000001,
    Number(roleProjectionPlan?.transitionMinutesById?.get(playerId)) || 8,
  );
  const decayingAdvantageUnits =
    (establishedValue - expandedValue) *
    transition *
    (1 - Math.exp(-split.expanded / transition));
  return (
    split.established * establishedValue +
    split.expanded * expandedValue +
    decayingAdvantageUnits
  );
}

/**
 * Return the non-historical workload multiplier for one discrete player-minute.
 *
 * The curve begins after `referenceMinutes`, which is exactly 240 divided by
 * the requested rotation size. It therefore adapts to an eight-player or
 * twelve-player rotation without importing the source team's minute choices.
 * Evaluating at the minute midpoint keeps the function smooth when the average
 * workload is fractional (for example, 26.67 minutes in a nine-player group).
 */
function workloadSaturationMultiplier(assignedMinute, roleProjectionPlan) {
  // No roster-size-based fatigue penalty. Changing the requested roster size
  // must not move an identical player's decay threshold to 240/N minutes.
  if (roleProjectionPlan?.workloadSaturationMarginalFloor === 1) return 1;
  const referenceMinutes = finiteNonNegative(roleProjectionPlan?.referenceMinutes);
  if (!(referenceMinutes > 0)) return 1;
  const minuteMidpoint = Math.max(0, Number(assignedMinute) - 0.5);
  const excess = Math.max(0, minuteMidpoint - referenceMinutes);
  if (excess <= 0) return 1;
  const transition = Math.max(
    0.000001,
    Number(roleProjectionPlan?.workloadSaturationTransitionMinutes) ||
      DEFAULT_PROJECTION_PARAMETERS.workloadSaturationTransitionMinutes,
  );
  const floor = Math.max(
    0,
    Math.min(
      1,
      Number(roleProjectionPlan?.workloadSaturationMarginalFloor) ||
        DEFAULT_PROJECTION_PARAMETERS.workloadSaturationMarginalFloor,
    ),
  );
  return floor + ((1 - floor) * Math.exp(-excess / transition));
}

/**
 * Compute the value of one additional integer minute under both corrections.
 *
 * Calibrated plans provide their own concave discrete curve. Legacy external
 * callers may still supply the old saturation multiplier for reproducibility;
 * newly built plans disable it. Separable concave marginal values let min-cost
 * flow return an
 * exact global optimum for the stated model rather than a post-solve rebalance.
 */
function roleConditionedMarginalValueUnits(
  playerId,
  assignedMinute,
  establishedValue,
  expandedValue,
  roleProjectionPlan,
) {
  const minute = Math.max(1, Math.floor(Number(assignedMinute) || 1));
  const curve = roleProjectionPlan?.calibratedUtilityCurvesById?.get(playerId);
  if (curve && minute <= 48) return curve[minute] - curve[minute - 1];
  const establishedRoleMinutes = finiteNonNegative(
    roleProjectionPlan?.evidenceMinutesById?.get(playerId),
  );
  let marginalValue = establishedValue;
  if (establishedRoleMinutes !== null && minute > establishedRoleMinutes) {
    const transition = Math.max(
      0.000001,
      Number(roleProjectionPlan?.transitionMinutesById?.get(playerId)) || 8,
    );
    const expandedStart = Math.max(0, (minute - 1) - establishedRoleMinutes);
    const expandedEnd = Math.max(0, minute - establishedRoleMinutes);
    // This is the exact integral of the existing exponential role-expansion
    // curve over one minute. Summing these units reproduces the prior closed
    // form before the workload multiplier is applied.
    const decayingAdvantage =
      (establishedValue - expandedValue) *
      transition *
      (Math.exp(-expandedStart / transition) - Math.exp(-expandedEnd / transition));
    marginalValue = expandedValue + decayingAdvantage;
  }
  return marginalValue * workloadSaturationMultiplier(minute, roleProjectionPlan);
}

/**
 * Sum the exact discrete marginal-value curve over assigned minutes.
 *
 * Rotation allocations are integers, but the fractional tail keeps this helper
 * safe for reporting callers. No player is capped by this calculation: hard
 * minimums and maximums remain the only availability limits.
 */
function roleConditionedValueUnits(
  playerId,
  assignedMinutes,
  establishedValue,
  expandedValue,
  roleProjectionPlan,
) {
  const allocated = Math.max(0, Number(assignedMinutes) || 0);
  const wholeMinutes = Math.floor(allocated);
  let total = 0;
  for (let minute = 1; minute <= wholeMinutes; minute += 1) {
    total += roleConditionedMarginalValueUnits(
      playerId,
      minute,
      establishedValue,
      expandedValue,
      roleProjectionPlan,
    );
  }
  const fractionalMinute = allocated - wholeMinutes;
  if (fractionalMinute > 1e-12) {
    total += fractionalMinute * roleConditionedMarginalValueUnits(
      playerId,
      wholeMinutes + 1,
      establishedValue,
      expandedValue,
      roleProjectionPlan,
    );
  }
  return total;
}

function roleConditionedScoreUnits(playerId, assignedMinutes, roleProjectionPlan) {
  const establishedScore = finiteNonNegative(
    roleProjectionPlan?.establishedScoresById?.get(playerId),
  );
  const expandedScore = finiteNonNegative(
    roleProjectionPlan?.expandedScoresById?.get(playerId),
  );
  if (establishedScore === null || expandedScore === null) return null;
  return roleConditionedValueUnits(
    playerId,
    assignedMinutes,
    establishedScore,
    expandedScore,
    roleProjectionPlan,
  );
}

function roleConditionedMetricScoreUnits(
  player,
  metric,
  assignedMinutes,
  normalizedMetrics,
  roleProjectionPlan,
) {
  const curve = roleProjectionPlan?.calibratedMetricCurvesById?.get(player.id)?.[metric];
  if (curve) return curve[Math.min(48, Math.max(0, Math.round(assignedMinutes)))];
  const establishedPercentile = Number(normalizedMetrics.get(player.id)?.[metric]) || 0;
  const expandedPercentile = finiteNonNegative(
    roleProjectionPlan?.expandedMetricPercentilesById?.get(player.id)?.[metric],
  );
  if (expandedPercentile === null) return establishedPercentile * assignedMinutes;
  return roleConditionedValueUnits(
    player.id,
    assignedMinutes,
    establishedPercentile,
    expandedPercentile,
    roleProjectionPlan,
  );
}

function projectedStatTotalForAssignedMinutes(
  player,
  field,
  assignedMinutes,
  projectedRates = null,
  roleProjectionPlan = null,
) {
  const calibrated = roleProjectionPlan?.calibratedProductionCurvesById?.get(player.id)?.[field];
  const constraintCurve = projectedRates?.productionCurvesById?.get(player.id)?.[field];
  if (constraintCurve) return constraintCurve[Math.max(0, Math.min(48, Math.round(assignedMinutes)))];
  if (calibrated) return calibrated[Math.min(48, Math.max(0, Math.round(assignedMinutes)))];
  const staticRate = playerPerMinuteRate(player, field, projectedRates);
  const split = roleConditionedMinuteSplit(player.id, assignedMinutes, roleProjectionPlan);
  const expandedRate = finiteNonNegative(
    roleProjectionPlan?.expandedProjectedRatesByPlayerId?.get(player.id)?.[field],
  );
  // A metric without complete source evidence remains on the same static rate
  // for every assigned minute. This mirrors the all-or-nothing evidence policy
  // used by the percentile layer, so a missing baseline cannot silently become
  // an advantage or a made-up projection.
  if (expandedRate === null || split.expanded <= 0) return staticRate * assignedMinutes;
  return roleExpansionValueUnits(
    player.id,
    assignedMinutes,
    staticRate,
    expandedRate,
    roleProjectionPlan,
  );
}

function calculateRotationTotals(
  players,
  rotationAllocation,
  projectedRates = null,
  roleProjectionPlan = null,
) {
  const totals = {
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
  };

  const usesAssignedRoleProjection = Boolean(
    rotationAllocation?.diagnostics?.roleConditionedScoring?.applied &&
      roleProjectionPlan,
  );
  for (const player of players) {
    const allocatedMinutes = Number(rotationAllocation.byId[player.id] ?? 0);
    for (const field of Object.keys(totals)) {
      totals[field] += projectedStatTotalForAssignedMinutes(
        player,
        field,
        allocatedMinutes,
        projectedRates,
        usesAssignedRoleProjection ? roleProjectionPlan : null,
      );
    }
  }
  for (const field of Object.keys(totals)) if (!Number.isFinite(totals[field])) totals[field] = null;
  return totals;
}

function objectiveShare(playerId, players, rotationAllocation) {
  if (!rotationAllocation) return 1 / players.length;
  // All successful rotation plans contain exactly 240 minutes. Dividing by the
  // returned total keeps this helper defensive if it is used with a diagnostic
  // allocation in the future.
  return Number(rotationAllocation.byId[playerId] ?? 0) / rotationAllocation.totalMinutes;
}

const OFFENSE_BENCHMARK_METRICS = Object.freeze([
  "points",
  "efgPct",
  "threePct",
  "assists",
  "ballSecurity",
  "offensiveImpact",
]);
const DEFENSE_BENCHMARK_METRICS = Object.freeze([
  "rebounds",
  "steals",
  "blocks",
  "defensiveImpact",
]);

/**
 * Build the stable result index shown to fans.
 *
 * Exact ranking continues to use pool-relative percentiles because they answer
 * "which eligible group best matches this request?" Fit vs. NBA Baseline answers
 * a different, more stable question: "how does this group compare with the
 * same-season NBA baseline for the priorities I chose?" Changing an unrelated
 * eligible player can move the ranking percentiles but cannot move this index.
 */
function calculateBenchmarkFit(
  players,
  benchmarkIndexesByPlayerId,
  normalizedWeights,
  rotationAllocation = null,
  roleProjectionPlan = null,
) {
  if (!(benchmarkIndexesByPlayerId instanceof Map)) {
    return {
      planFitIndex: null,
      offenseIndex: null,
      defenseIndex: null,
      availableMetricCount: 0,
    };
  }

  const groupMetricIndexes = {};
  for (const metric of OBJECTIVE_METRICS) {
    let weightedTotal = 0;
    let availableShare = 0;
    for (const player of players) {
      const index = Number(benchmarkIndexesByPlayerId.get(player.id)?.[metric]);
      if (!Number.isFinite(index)) continue;
      const share = objectiveShare(player.id, players, rotationAllocation);
      const assignedMinutes = Number(rotationAllocation?.byId?.[player.id] ?? 0);
      const expandedIndex = Number(
        roleProjectionPlan?.expandedBenchmarkIndexesById?.get(player.id)?.[metric],
      );
      const usesAssignedRoleProjection = Boolean(
        rotationAllocation?.diagnostics?.roleConditionedScoring?.applied
          && roleProjectionPlan
          && assignedMinutes > 0
          && Number.isFinite(expandedIndex),
      );
      const calibratedBenchmark = roleProjectionPlan?.calibratedBenchmarkCurvesById?.get(player.id)?.[metric];
      const appliedIndex = usesAssignedRoleProjection
        ? calibratedBenchmark
          ? calibratedBenchmark[Math.min(48, Math.round(assignedMinutes))] / assignedMinutes
          : roleExpansionValueUnits(
          player.id,
          assignedMinutes,
          index,
          expandedIndex,
          roleProjectionPlan,
        ) / assignedMinutes
        : index;
      weightedTotal += appliedIndex * share;
      availableShare += share;
    }
    if (availableShare > 0) groupMetricIndexes[metric] = weightedTotal / availableShare;
  }

  const combine = (metrics) => {
    const available = metrics.filter((metric) => Number.isFinite(groupMetricIndexes[metric]));
    if (available.length === 0) return null;
    let weightTotal = available.reduce(
      (total, metric) => total + Math.max(0, Number(normalizedWeights?.[metric]) || 0),
      0,
    );
    // A deliberately zeroed offense or defense family still deserves a useful
    // descriptive sub-index. Equal weighting is used only for that readout; it
    // does not add a hidden priority to the NBA-baseline index or exact solver.
    const equalWeight = !(weightTotal > 0);
    if (equalWeight) weightTotal = available.length;
    return round(available.reduce((total, metric) => {
      const weight = equalWeight ? 1 : Math.max(0, Number(normalizedWeights[metric]) || 0);
      return total + (groupMetricIndexes[metric] * weight);
    }, 0) / weightTotal, 1);
  };

  const activeMetrics = OBJECTIVE_METRICS.filter(
    (metric) => Number(normalizedWeights?.[metric]) > 0 && Number.isFinite(groupMetricIndexes[metric]),
  );
  return {
    planFitIndex: combine(activeMetrics),
    offenseIndex: combine(OFFENSE_BENCHMARK_METRICS),
    defenseIndex: combine(DEFENSE_BENCHMARK_METRICS),
    availableMetricCount: Object.keys(groupMetricIndexes).length,
    metricIndexes: Object.fromEntries(
      Object.entries(groupMetricIndexes).map(([metric, index]) => [metric, round(index, 1)]),
    ),
    baseline: 100,
    sourceAnchored: true,
  };
}

function calculateObjective(
  players,
  normalizedMetrics,
  rawWeights,
  normalizedWeights,
  rotationAllocation = null,
  rotationRankingModel = null,
  roleProjectionPlan = null,
  benchmarkIndexesByPlayerId = null,
  modelAdjustments = null,
) {
  const contributionBreakdown = {};
  // Keep the group-level breakdown for the existing UI, while also retaining
  // the additive player-level evidence a fan report needs to explain why a
  // specific player belongs in this exact result. The player totals reconcile
  // to the direct, user-weighted game-plan score (subject only to display
  // rounding). A Scout player-minute delta is additive and belongs to the
  // player that earned it. Only a role-complementarity or exact-five residual
  // stays separate below, because those describe the group rather than one
  // player.
  const playerContributions = Object.fromEntries(players.map((player) => [
    player.id,
    { scoreContribution: 0, metrics: {} },
  ]));
  let rawScore = 0;
  // The displayed match score is always the user's weighted game-plan fit.
  // Historical workload can be displayed as context or used by an explicit
  // advanced capacity mode, but it never receives hidden objective weight.
  const strategyShare = ROTATION_STRATEGY_SHARE;
  const usesAssignedRoleProjection = Boolean(
    rotationAllocation?.diagnostics?.roleConditionedScoring?.applied &&
      roleProjectionPlan,
  );
  const totalAssignedMinutes = rotationAllocation?.totalMinutes ?? 0;

  for (const metric of OBJECTIVE_METRICS) {
    const averagePercentile = rotationAllocation
      ? players.reduce(
          (total, player) =>
            total +
            (usesAssignedRoleProjection
              ? roleConditionedMetricScoreUnits(
                player,
                metric,
                Number(rotationAllocation.byId[player.id] ?? 0),
                normalizedMetrics,
                roleProjectionPlan,
              )
              : normalizedMetrics.get(player.id)[metric] *
                Number(rotationAllocation.byId[player.id] ?? 0)),
          0,
        ) / totalAssignedMinutes
      : players.reduce(
          (total, player) => total + normalizedMetrics.get(player.id)[metric],
          0,
        ) / players.length;
    const scoreContribution =
      averagePercentile * normalizedWeights[metric] * strategyShare * 100;
    rawScore += scoreContribution;
    for (const player of players) {
      const percentile = normalizedMetrics.get(player.id)[metric];
      const playerMetricUnits = rotationAllocation
        ? usesAssignedRoleProjection
          ? roleConditionedMetricScoreUnits(
            player,
            metric,
            Number(rotationAllocation.byId[player.id] ?? 0),
            normalizedMetrics,
            roleProjectionPlan,
          )
          : percentile * Number(rotationAllocation.byId[player.id] ?? 0)
        : percentile;
      const assignedMinutes = rotationAllocation
        ? Number(rotationAllocation.byId[player.id] ?? 0)
        : 0;
      // In a minute-aware result, expose the actual average percentile that
      // contributed across this player's assigned minutes. Leaving the original
      // static percentile here would make the explanation say an extra baseline
      // minute was still valued at the player's initial outlier rate.
      const appliedPercentile = rotationAllocation && assignedMinutes > 0
        ? playerMetricUnits / assignedMinutes
        : percentile;
      const playerScoreContribution =
        (playerMetricUnits / (rotationAllocation ? totalAssignedMinutes : players.length)) *
        normalizedWeights[metric] *
        strategyShare *
        100;
      const playerEntry = playerContributions[player.id];
      playerEntry.metrics[metric] = {
        percentile: round(appliedPercentile),
        ...(usesAssignedRoleProjection && Math.abs(appliedPercentile - percentile) > 1e-12
          ? { assignedRoleAdjusted: true, establishedRolePercentile: round(percentile) }
          : {}),
        scoreContribution: round(playerScoreContribution),
      };
      playerEntry.scoreContribution += playerScoreContribution;
    }
    contributionBreakdown[metric] = {
      weight: rawWeights[metric],
      normalizedWeight: round(normalizedWeights[metric] * strategyShare),
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

  // The allocator ranks on the Scout-blended minute utility when a complete,
  // reliable Scout dataset is deliberately selected. Reconstruct that exact
  // player-level delta here so the reported score, player explanation, and
  // exact allocation all reconcile. This is intentionally not a new visible
  // objective weight: the visitor's box-score priorities chose the Scout
  // offense/defense split before this calculation.
  const scoutMinuteAdjustmentPoints =
    Number(modelAdjustments?.scoutImpact?.minuteAdjustmentPoints) || 0;
  const scoutPlayerMinuteAdjustments =
    modelAdjustments?.scoutImpact?.playerMinuteAdjustmentPointsById;
  if (scoutPlayerMinuteAdjustments && typeof scoutPlayerMinuteAdjustments === "object") {
    for (const player of players) {
      const adjustment = Number(scoutPlayerMinuteAdjustments[player.id]) || 0;
      if (adjustment === 0) continue;
      const playerEntry = playerContributions[player.id];
      playerEntry.scoreContribution += adjustment;
      playerEntry.scoutMinuteAdjustmentPoints = round(adjustment);
    }
  }
  rawScore += scoutMinuteAdjustmentPoints;

  const benchmarkFit = calculateBenchmarkFit(
    players,
    benchmarkIndexesByPlayerId,
    normalizedWeights,
    rotationAllocation,
    usesAssignedRoleProjection ? roleProjectionPlan : null,
  );
  const adjustmentPoints = Number(modelAdjustments?.totalAdjustmentPoints) || 0;
  rawScore += adjustmentPoints;

  return {
    rawScore,
    score: round(rawScore),
    // Expose the two pieces separately for API consumers and future reports.
  // `score` is the ranking result; `directGamePlanScore` is the sum of the
  // per-player metric and any selected Scout-minute contributions;
  // `rosterAdjustmentPoints` is the small, explicitly opt-in group-level
  // context that is not attributed to a player.
    directGamePlanScore: round(rawScore - adjustmentPoints),
    rosterAdjustmentPoints: round(adjustmentPoints),
    scoutMinuteAdjustmentPoints: round(scoutMinuteAdjustmentPoints),
    // 0–100 values are retained for renderer/API compatibility. The former
    // readiness fields deliberately contain no hidden score contribution.
    strategyFitScore: round(rawScore / strategyShare),
    historicalReadinessIndex: null,
    strategyScore: round(rawScore),
    historicalReadinessScore: 0,
    ...benchmarkFit,
    modelAdjustments: modelAdjustments || {
      totalAdjustmentPoints: 0,
      roleFit: null,
      usageDemand: null,
      scoutImpact: null,
    },
    contributionBreakdown,
    playerContributions: Object.fromEntries(
      Object.entries(playerContributions).map(([id, detail]) => [
        id,
        { ...detail, scoreContribution: round(detail.scoreContribution) },
      ]),
    ),
  };
}

function calculateObjectiveScore(
  players,
  playerStrategyScores,
  rotationAllocation = null,
  rotationRankingModel = null,
  roleProjectionPlan = null,
  adjustmentPoints = 0,
) {
  // Each player's weighted percentile contribution is independent of the rest
  // of the candidate. Lineup mode keeps the original equal-player average;
  // rotation mode weights that same pool-relative fit by the minutes the player
  // will actually be on the court.
  if (!rotationAllocation) {
    let scoreTotal = 0;
    for (const player of players) scoreTotal += playerStrategyScores.get(player.id);
    return (scoreTotal / players.length) * 100 + (Number(adjustmentPoints) || 0);
  }
  const usesAssignedRoleProjection = Boolean(
    rotationAllocation.diagnostics?.roleConditionedScoring?.applied &&
      roleProjectionPlan,
  );
  let strategyScore = 0;
  for (const player of players) {
    const assignedMinutes = Number(rotationAllocation.byId[player.id] ?? 0);
    const scoreUnits = usesAssignedRoleProjection
      ? roleConditionedScoreUnits(player.id, assignedMinutes, roleProjectionPlan)
      : playerStrategyScores.get(player.id) * assignedMinutes;
    strategyScore += scoreUnits ?? 0;
  }
  return (strategyScore / rotationAllocation.totalMinutes) * 100 +
    (Number(adjustmentPoints) || 0);
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
  // Use the same finite-value and numerical-tolerance contract as the exact
  // allocator and final candidate gate. null <= a turnover ceiling is true in
  // JavaScript; it is NOT evidence that an unknown total passed the user's rule.
  const productionStatus = projectedConstraintStatus(totals, config);
  const statChecks = Object.fromEntries(
    Object.entries(config.statMinimums).map(([stat, required]) => [
      stat,
      { required, actual: totals[stat], passed: !productionStatus.failedStatMinimums.includes(stat) },
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
      excludedIds: [...new Set([...config.excludedIds, ...(config.selectionOnlyExcludedIds || [])])],
      includedIds: [...config.excludedIds, ...(config.selectionOnlyExcludedIds || [])].filter((id) => idSet.has(id)),
      passed: [...config.excludedIds, ...(config.selectionOnlyExcludedIds || [])].every((id) => !idSet.has(id)),
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
      passed: !productionStatus.failedMaxTurnovers,
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

/**
 * One interpretation of user minute limits for both the exact allocator and
 * its production envelope. This deliberately excludes historical guidance:
 * any later position/availability restriction can only narrow these limits,
 * so an envelope over the user range remains conservative for every plan.
 * Per-player min/max aliases override scalar or Map defaults identically in
 * both callers. Zero minutes is legal and contributes exactly zero production.
 */
function rotationPlayerMinuteBounds(player, options, reasons) {
  const id = canonicalId(player?.id);
  const source = isPlainObject(options.playerBounds) ? options.playerBounds : {};
  const overrides = isPlainObject(source[id]) ? source[id] : {};
  const min = Number(overrides.min ?? overrides.minimum ??
    getBoundValue(options.minMinutes, id, 8, "minMinutes", reasons));
  const max = Number(overrides.max ?? overrides.maximum ??
    getBoundValue(options.maxMinutes, id, 36, "maxMinutes", reasons));
  for (const [label, value] of [["Minimum", min], ["Maximum", max]]) {
    if (!Number.isInteger(value) || value < 0) {
      reasons.push(`${label} minutes for ${id} must be a non-negative integer.`);
    } else if (value > 48) {
      reasons.push(`${label} minutes for ${id} cannot exceed 48 in a regulation game.`);
    }
  }
  if (Number.isInteger(min) && Number.isInteger(max) && min > max) {
    reasons.push(`Minimum minutes for ${id} cannot exceed its maximum minutes.`);
  }
  return { min, max };
}

// These fields are the only rate-based values used for projected 240-minute
// production rules. Keep the map deliberately narrow: efficiency rates affect
// the objective, while the visible rule inputs currently cover box-score
// counting totals and turnovers.
const PROJECTED_RATE_FIELDS = Object.freeze([...STAT_MINIMUM_KEYS, "turnovers"]);

/**
 * Normalize optional per-minute projection overrides for the public allocator.
 * `optimizeLineups` supplies this map internally after applying its
 * small-sample and role-expansion correction. Direct callers may omit it and
 * receive the historic raw-rate allocator behavior unchanged.
 */
function normalizeProjectedRateMap(players, source, reasons, curvesSource = null) {
  if ((source === undefined || source === null) && !curvesSource) return null;
  source ??= new Map();
  if (!(source instanceof Map) && !isPlainObject(source)) {
    reasons.push("projectedRates must be an object or Map keyed by player id when provided.");
    return null;
  }
  const normalized = new Map();
  for (const player of players) {
    const id = canonicalId(player?.id);
    const row = getMapLikeValue(source, id, "projectedRates", reasons);
    if (row === undefined) continue;
    if (!isPlainObject(row)) {
      reasons.push(`projectedRates for ${id} must be an object of per-minute rates.`);
      continue;
    }
    const rates = {};
    for (const field of Object.keys(row)) {
      if (!PROJECTED_RATE_FIELDS.includes(field)) {
        reasons.push(`projectedRates for ${id} contains an unsupported statistic: ${field}.`);
      }
    }
    for (const field of PROJECTED_RATE_FIELDS) {
      if (!hasOwn(row, field)) continue;
      const rate = Number(row[field]);
      if (!Number.isFinite(rate) || rate < 0) {
        reasons.push(`Projected per-minute rate ${field} for ${id} must be a finite non-negative number.`);
      } else {
        rates[field] = rate;
      }
    }
    normalized.set(id, rates);
  }
  if (curvesSource !== null) {
    const curves = new Map();
    if (!(curvesSource instanceof Map) && !isPlainObject(curvesSource)) {
      reasons.push("projectedProductionCurves must be an object or Map keyed by player id.");
    } else for (const player of players) {
      const row = getMapLikeValue(curvesSource, player.id, "projectedProductionCurves", reasons);
      if (row === undefined) continue;
      if (!isPlainObject(row)) { reasons.push(`Production curves for ${player.id} must be an object.`); continue; }
      const validated = {};
      for (const [field, values] of Object.entries(row)) {
        if (!PROJECTED_RATE_FIELDS.includes(field) || !Array.isArray(values) || values.length !== 49
          || values[0] !== 0 || values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          reasons.push(`Production curve ${field} for ${player.id} must contain 49 nonnegative totals starting at zero.`);
        } else validated[field] = values.slice();
      }
      curves.set(player.id, validated);
    }
    // This private companion travels through existing allocation helpers. The
    // scalar map remains available for backward-compatible direct callers.
    normalized.productionCurvesById = curves;
  }
  return normalized;
}

/**
 * Validate the private minute-aware score payload that `optimizeLineups`
 * supplies to the public allocator. Keeping this normalization at the public
 * boundary prevents a malformed future caller from silently changing an exact
 * minute allocation into an unexplained heuristic.
 */
function normalizeRoleConditionedScorePlan(players, source, reasons) {
  if (source === undefined || source === null) return null;
  if (!isPlainObject(source)) {
    reasons.push("roleConditionedScorePlan must be an object when provided.");
    return null;
  }
  const referenceMinutes = Number(source.referenceMinutes);
  if (!Number.isFinite(referenceMinutes) || referenceMinutes <= 0 || referenceMinutes > 48) {
    reasons.push("roleConditionedScorePlan.referenceMinutes must be between 0 and 48.");
    return null;
  }
  const fields = [
    ["evidenceMinutesById", 0, 48],
    ["establishedScoresById", 0, 1],
    ["expandedScoresById", 0, 1],
  ];
  const normalized = {};
  for (const [field, minimum, maximum] of fields) {
    const raw = source[field];
    if (!(raw instanceof Map) && !isPlainObject(raw)) {
      reasons.push(`roleConditionedScorePlan.${field} must be an object or Map keyed by player id.`);
      continue;
    }
    const values = new Map();
    for (const player of players) {
      const id = canonicalId(player?.id);
      const value = Number(getMapLikeValue(raw, id, `roleConditionedScorePlan.${field}`, reasons));
      if (!Number.isFinite(value) || value < minimum || value > maximum) {
        reasons.push(`roleConditionedScorePlan.${field} for ${id} must be between ${minimum} and ${maximum}.`);
      } else {
        values.set(id, value);
      }
    }
    normalized[field] = values;
  }
  // The transition scale is optional for backward-compatible callers. The
  // previous piecewise model receives an eight-minute smooth transition by
  // default; internal plans provide a sample-sensitive value for each player.
  const rawTransitions = source.transitionMinutesById;
  const transitionMinutesById = new Map();
  for (const player of players) {
    const id = canonicalId(player?.id);
    const rawValue = rawTransitions === undefined
      ? 8
      : Number(getMapLikeValue(
        rawTransitions,
        id,
        "roleConditionedScorePlan.transitionMinutesById",
        reasons,
      ));
    if (!Number.isFinite(rawValue) || rawValue <= 0 || rawValue > 48) {
      reasons.push(`roleConditionedScorePlan.transitionMinutesById for ${id} must be above 0 and at most 48.`);
    } else {
      transitionMinutesById.set(id, rawValue);
    }
  }
  const workloadSaturationMarginalFloor = Number(
    source.workloadSaturationMarginalFloor ??
      DEFAULT_PROJECTION_PARAMETERS.workloadSaturationMarginalFloor,
  );
  if (
    !Number.isFinite(workloadSaturationMarginalFloor) ||
    workloadSaturationMarginalFloor < 0 ||
    workloadSaturationMarginalFloor > 1
  ) {
    reasons.push("roleConditionedScorePlan.workloadSaturationMarginalFloor must be between 0 and 1.");
  }
  const workloadSaturationTransitionMinutes = Number(
    source.workloadSaturationTransitionMinutes ??
      DEFAULT_PROJECTION_PARAMETERS.workloadSaturationTransitionMinutes,
  );
  if (
    !Number.isFinite(workloadSaturationTransitionMinutes) ||
    workloadSaturationTransitionMinutes <= 0 ||
    workloadSaturationTransitionMinutes > 48
  ) {
    reasons.push("roleConditionedScorePlan.workloadSaturationTransitionMinutes must be above 0 and at most 48.");
  }
  if (reasons.length > 0) return null;
  return {
    ...source,
    referenceMinutes,
    ...normalized,
    transitionMinutesById,
    workloadSaturationMarginalFloor,
    workloadSaturationTransitionMinutes,
    objectiveMetrics: Array.isArray(source.objectiveMetrics)
      ? source.objectiveMetrics.filter((metric) => OBJECTIVE_METRICS.includes(metric))
      : [],
    activeMetrics: Array.isArray(source.activeMetrics)
      ? source.activeMetrics.filter((metric) => OBJECTIVE_METRICS.includes(metric))
      : [],
  };
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
function positionMinuteCapacity(player, position, playerMaximum = 48) {
  if (!Array.isArray(player?.positions) || !player.positions.includes(position)) return 0;
  const policyCap = Number(player?.positionMinuteCaps?.[position]);
  return Number.isFinite(policyCap)
    ? Math.max(0, Math.min(playerMaximum, policyCap))
    : playerMaximum;
}

function everyPlayerCoversRequiredPositions(players, requirements, bounds = null) {
  const requiredPositions = POSITION_KEYS.filter((position) => requirements[position] > 0);
  return players.every(
    (player) => {
      const playerMaximum = bounds?.get(player.id)?.max ?? 48;
      return requiredPositions.every(
        (position) => positionMinuteCapacity(player, position, playerMaximum) >= playerMaximum,
      );
    },
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
  if (everyPlayerCoversRequiredPositions(players, requirements, bounds)) {
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
      edges.set(position, addBoundedEdge(
        playerNode,
        positionNode,
        0,
        positionMinuteCapacity(player, position, playerBounds.max),
      ));
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
  if (everyPlayerCoversRequiredPositions(players, requirements, bounds)) {
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
 * A compact successive-shortest-path network for the one place the standard
 * max-flow oracle cannot express a preference: choosing the role-feasible
 * minute plan closest to recorded workload. Capacities are integral, so every
 * returned player and role minute remains an integer without a rounding pass.
 */
function createMinCostFlowNetwork(nodeCount) {
  const graph = Array.from({ length: nodeCount }, () => []);

  function addEdge(from, to, capacity, cost) {
    const forward = {
      to,
      reverseIndex: graph[to].length,
      capacity,
      initialCapacity: capacity,
      cost,
    };
    const reverse = {
      to: from,
      reverseIndex: graph[from].length,
      capacity: 0,
      initialCapacity: 0,
      cost: -cost,
    };
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
  }

  function minCostFlow(source, sink, requiredFlow) {
    let delivered = 0;
    let cost = 0;
    while (delivered < requiredFlow) {
      // Some marginal workload costs are negative while a player is moving
      // toward his source target, so use a queue-based Bellman-Ford variant
      // rather than assuming Dijkstra's non-negative-cost precondition.
      const distance = Array(nodeCount).fill(Number.POSITIVE_INFINITY);
      const previousNode = Array(nodeCount).fill(-1);
      const previousEdge = Array(nodeCount).fill(-1);
      const queued = Array(nodeCount).fill(false);
      const queue = [source];
      let queueIndex = 0;
      distance[source] = 0;
      queued[source] = true;

      while (queueIndex < queue.length) {
        const node = queue[queueIndex];
        queueIndex += 1;
        queued[node] = false;
        graph[node].forEach((edge, edgeIndex) => {
          if (edge.capacity <= 0) return;
          const nextDistance = distance[node] + edge.cost;
          if (nextDistance >= distance[edge.to]) return;
          distance[edge.to] = nextDistance;
          previousNode[edge.to] = node;
          previousEdge[edge.to] = edgeIndex;
          if (!queued[edge.to]) {
            queued[edge.to] = true;
            queue.push(edge.to);
          }
        });
      }

      if (!Number.isFinite(distance[sink])) break;
      let addition = requiredFlow - delivered;
      for (let node = sink; node !== source; node = previousNode[node]) {
        const edge = graph[previousNode[node]][previousEdge[node]];
        addition = Math.min(addition, edge.capacity);
      }
      for (let node = sink; node !== source; node = previousNode[node]) {
        const edge = graph[previousNode[node]][previousEdge[node]];
        edge.capacity -= addition;
        graph[node][edge.reverseIndex].capacity += addition;
      }
      delivered += addition;
      cost += addition * distance[sink];
    }
    return { delivered, cost };
  }

  return { addEdge, minCostFlow };
}

/**
 * Minimize total absolute departure from the selected group's rescaled
 * historical workload target while still proving every G/F/C minute. This is
 * a true secondary objective, not an ID-ordered repair: if the exact targets
 * are role-feasible they are returned unchanged; otherwise the smallest
 * possible total departure is chosen before any deterministic display order.
 */
function historicalContinuityPositionAllocation(
  players,
  bounds,
  targetMinutes,
  requirements,
  scores = new Map(),
) {
  // This is the common case for a source-grounded roster. Avoid constructing a
  // 240-unit cost network when the historical target vector already covers the
  // requested roles exactly; the ordinary role-flow proof is both faster and
  // sufficient to establish zero workload deviation.
  const exactTarget = findPositionMinuteFlow(
    players,
    fixedBoundsFrom(targetMinutes),
    requirements,
  );
  if (exactTarget.feasible) {
    return {
      ...exactTarget,
      adjusted: false,
      continuityApplied: true,
      continuityDeviation: 0,
    };
  }
  const feasibility = findPositionMinuteFlow(players, bounds, requirements);
  if (!feasibility.feasible) return feasibility;

  const sortedPlayers = players.slice().sort(comparePlayersById);
  const source = 0;
  const playerStart = 1;
  const positionStart = playerStart + sortedPlayers.length;
  const sink = positionStart + POSITION_KEYS.length;
  const superSource = sink + 1;
  const superSink = sink + 2;
  const network = createMinCostFlowNetwork(superSink + 1);
  const totalRequired = POSITION_KEYS.reduce(
    (total, position) => total + requirements[position],
    0,
  );
  const minimumTotal = sortedPlayers.reduce(
    (total, player) => total + bounds.get(player.id).min,
    0,
  );
  const roleEdges = new Map();
  const finiteScores = sortedPlayers.map((player) => Number(scores.get(player.id)))
    .filter(Number.isFinite);
  const minimumScore = finiteScores.length > 0 ? Math.min(...finiteScores) : 0;
  const maximumScore = finiteScores.length > 0 ? Math.max(...finiteScores) : 0;
  const normalizedScore = (id) => {
    const score = Number(scores.get(id));
    if (!Number.isFinite(score)) return 0;
    if (maximumScore === minimumScore) return 0.5;
    return (score - minimumScore) / (maximumScore - minimumScore);
  };
  // A one-minute improvement in L1 historical continuity must dominate every
  // possible readiness/strategy tie-break across the complete 240-minute
  // flow. The smaller utility term only chooses among equally realistic plans.
  const CONTINUITY_COST_SCALE = 1_000_000;
  const UTILITY_TIE_BREAK_SCALE = 1_000;

  sortedPlayers.forEach((player, index) => {
    const playerNode = playerStart + index;
    const playerBounds = bounds.get(player.id);
    const target = Number(targetMinutes.get(player.id));
    const normalizedTarget = Number.isInteger(target) ? target : playerBounds.min;

    // The lower bound is introduced as a direct supply at the player node.
    // Each remaining source-to-player unit carries the exact marginal change
    // in absolute workload distance, making the full network solve an L1
    // continuity objective subject to the existing role constraints.
    network.addEdge(superSource, playerNode, playerBounds.min, 0);
    for (let minute = playerBounds.min + 1; minute <= playerBounds.max; minute += 1) {
      const workloadMarginalCost =
        Math.abs(minute - normalizedTarget) - Math.abs((minute - 1) - normalizedTarget);
      const utilityTieBreak = Math.round(
        normalizedScore(player.id) * UTILITY_TIE_BREAK_SCALE,
      );
      const marginalCost =
        workloadMarginalCost * CONTINUITY_COST_SCALE - utilityTieBreak;
      network.addEdge(source, playerNode, 1, marginalCost);
    }

    const playerRoleEdges = new Map();
    const eligiblePositions = Array.isArray(player.positions) ? player.positions : [];
    for (const position of POSITION_KEYS) {
      if (!eligiblePositions.includes(position)) continue;
      const positionNode = positionStart + POSITION_KEYS.indexOf(position);
      playerRoleEdges.set(
        position,
        network.addEdge(
          playerNode,
          positionNode,
          positionMinuteCapacity(player, position, playerBounds.max),
          0,
        ),
      );
    }
    roleEdges.set(player.id, playerRoleEdges);
  });

  // Remaining court minutes originate at the usual source node. Together with
  // each player's lower-bound supply this always totals exactly 240 minutes.
  network.addEdge(superSource, source, totalRequired - minimumTotal, 0);
  for (const position of POSITION_KEYS) {
    const positionNode = positionStart + POSITION_KEYS.indexOf(position);
    network.addEdge(positionNode, sink, requirements[position], 0);
  }
  network.addEdge(sink, superSink, totalRequired, 0);

  const solved = network.minCostFlow(superSource, superSink, totalRequired);
  if (solved.delivered !== totalRequired) {
    // The ordinary bounded-flow oracle already proved feasibility above. Keep
    // that exact result as a defensive fallback if a future network change ever
    // breaks the secondary objective implementation; never fabricate minutes.
    return { ...feasibility, continuityApplied: false, adjusted: true };
  }

  const byPlayer = {};
  const totalsByPlayer = {};
  const actual = { G: 0, F: 0, C: 0 };
  for (const player of sortedPlayers) {
    const roleMinutes = { G: 0, F: 0, C: 0 };
    for (const [position, edge] of roleEdges.get(player.id)) {
      const minutes = edge.initialCapacity - edge.capacity;
      roleMinutes[position] = minutes;
      actual[position] += minutes;
    }
    byPlayer[player.id] = roleMinutes;
    totalsByPlayer[player.id] = POSITION_KEYS.reduce(
      (total, position) => total + roleMinutes[position],
      0,
    );
  }
  const totalDeviation = sortedPlayers.reduce(
    (total, player) => total + Math.abs(
      totalsByPlayer[player.id] - Number(targetMinutes.get(player.id)),
    ),
    0,
  );
  return {
    feasible: POSITION_KEYS.every((position) => actual[position] === requirements[position]),
    required: { ...requirements },
    actual,
    byPlayer,
    totalsByPlayer,
    delivered: solved.delivered,
    balanceDemand: totalRequired,
    adjusted: totalDeviation > 0,
    continuityApplied: true,
    continuityDeviation: totalDeviation,
    continuityUtilityTieBreakApplied: true,
  };
}

/**
 * Maximize the minute-aware game-plan score while proving the full G/F/C role
 * shape. Each source-to-player edge represents one additional minute and uses
 * that minute's marginal value: established-rate minutes first, a smooth decay
 * toward the conservative bound for unestablished expansion (or the calibrated
 * curve where available). No new plan tapers at the roster average. Because the
 * network has integral capacities and solves every path to minimum cost, this
 * remains an exact allocation for the stated diminishing-return model—not an
 * after-the-fact reduction in a player's minutes.
 */
function roleConditionedPositionAllocation(
  players,
  bounds,
  requirements,
  scorePlan,
  marginalAdjustmentById = null,
) {
  const sortedPlayers = players.slice().sort(comparePlayersById);
  // Production-constraint certification occasionally adds a constant linear
  // value to every minute assigned to a player (for example, lambda times that
  // player's rebound rate). A player-specific constant preserves the decreasing
  // marginal curve, so both the relaxed greedy path and the role-flow network
  // remain exact for the adjusted objective. Ordinary allocation passes no map
  // and therefore retains its established behavior and integer-scaled tie rules.
  const usesExactMarginalAdjustment = marginalAdjustmentById instanceof Map;
  const marginalAdjustment = (playerId) => {
    const value = Number(marginalAdjustmentById?.get(playerId));
    return Number.isFinite(value) ? value : 0;
  };
  // First solve the relaxed problem that ignores G/F/C labels. Because each
  // player's marginal curve is non-increasing, repeatedly selecting the best
  // available next minute is the exact optimum for the separable concave
  // workload objective. If those player totals can also be split across the
  // required roles, they are automatically the exact constrained optimum—no
  // role-feasible plan could beat the relaxed upper bound. This common fast
  // path avoids building a 240-edge cost network for thousands of ordinary
  // roster combinations while preserving the same mathematical answer.
  const relaxedMinutes = new Map(
    sortedPlayers.map((player) => [player.id, bounds.get(player.id).min]),
  );
  let relaxedRemaining = POSITION_KEYS.reduce(
    (total, position) => total + requirements[position],
    0,
  ) - [...relaxedMinutes.values()].reduce((total, minutes) => total + minutes, 0);
  while (relaxedRemaining > 0) {
    let bestPlayer = null;
    let bestMarginal = Number.NEGATIVE_INFINITY;
    for (const player of sortedPlayers) {
      const nextMinute = relaxedMinutes.get(player.id) + 1;
      if (nextMinute > bounds.get(player.id).max) continue;
      const establishedScore = finiteNonNegative(
        scorePlan?.establishedScoresById?.get(player.id),
      ) ?? 0;
      const expandedScore = finiteNonNegative(
        scorePlan?.expandedScoresById?.get(player.id),
      ) ?? establishedScore;
      const marginal =
        roleConditionedMarginalValueUnits(
          player.id,
          nextMinute,
          establishedScore,
          expandedScore,
          scorePlan,
        ) + marginalAdjustment(player.id);
      if (
        marginal > bestMarginal + 1e-15 ||
        (Math.abs(marginal - bestMarginal) <= 1e-15 &&
          (!bestPlayer || compareIds(player.id, bestPlayer.id) < 0))
      ) {
        bestPlayer = player;
        bestMarginal = marginal;
      }
    }
    if (!bestPlayer) break;
    relaxedMinutes.set(bestPlayer.id, relaxedMinutes.get(bestPlayer.id) + 1);
    relaxedRemaining -= 1;
  }
  if (relaxedRemaining === 0) {
    const relaxedRoleFlow = findPositionMinuteFlow(
      sortedPlayers,
      fixedBoundsFrom(relaxedMinutes),
      requirements,
    );
    if (relaxedRoleFlow.feasible) {
      return {
        ...relaxedRoleFlow,
        roleConditionedScoringApplied: true,
        roleConditionedFastPathApplied: true,
      };
    }
  }

  const source = 0;
  const playerStart = 1;
  const positionStart = playerStart + sortedPlayers.length;
  const sink = positionStart + POSITION_KEYS.length;
  const superSource = sink + 1;
  const superSink = sink + 2;
  const network = createMinCostFlowNetwork(superSink + 1);
  const totalRequired = POSITION_KEYS.reduce(
    (total, position) => total + requirements[position],
    0,
  );
  const minimumTotal = sortedPlayers.reduce(
    (total, player) => total + bounds.get(player.id).min,
    0,
  );
  const roleEdges = new Map();

  sortedPlayers.forEach((player, index) => {
    const playerNode = playerStart + index;
    const playerBounds = bounds.get(player.id);
    network.addEdge(superSource, playerNode, playerBounds.min, 0);
    for (let minute = playerBounds.min + 1; minute <= playerBounds.max; minute += 1) {
      // Read the one-minute marginal directly. This is equivalent to
      // subtracting adjacent cumulative scores, but avoids repeatedly summing
      // the first N minutes for every edge in every candidate rotation.
      const establishedScore = finiteNonNegative(
        scorePlan?.establishedScoresById?.get(player.id),
      ) ?? 0;
      const expandedScore = finiteNonNegative(
        scorePlan?.expandedScoresById?.get(player.id),
      ) ?? establishedScore;
      const baseMarginalScore = Math.max(
        0,
        roleConditionedMarginalValueUnits(
          player.id,
          minute,
          establishedScore,
          expandedScore,
          scorePlan,
        ),
      );
      const marginalScore = baseMarginalScore + marginalAdjustment(player.id);
      network.addEdge(
        source,
        playerNode,
        1,
        // The ordinary model keeps its established scaled-integer cost for
        // deterministic browser parity. A Lagrangian proof uses the raw double
        // so rounding cannot understate its upper bound by a fraction of a
        // model point. The min-cost implementation accepts finite real costs.
        usesExactMarginalAdjustment
          ? -marginalScore
          : -Math.round(marginalScore * ROLE_CONDITIONED_UTILITY_COST_SCALE),
      );
    }

    const playerRoleEdges = new Map();
    const eligiblePositions = Array.isArray(player.positions) ? player.positions : [];
    for (const position of POSITION_KEYS) {
      if (!eligiblePositions.includes(position)) continue;
      const positionNode = positionStart + POSITION_KEYS.indexOf(position);
      playerRoleEdges.set(
        position,
        network.addEdge(
          playerNode,
          positionNode,
          positionMinuteCapacity(player, position, playerBounds.max),
          0,
        ),
      );
    }
    roleEdges.set(player.id, playerRoleEdges);
  });

  network.addEdge(superSource, source, totalRequired - minimumTotal, 0);
  for (const position of POSITION_KEYS) {
    const positionNode = positionStart + POSITION_KEYS.indexOf(position);
    network.addEdge(positionNode, sink, requirements[position], 0);
  }
  network.addEdge(sink, superSink, totalRequired, 0);

  const solved = network.minCostFlow(superSource, superSink, totalRequired);
  if (solved.delivered !== totalRequired) {
    // The min-cost network encodes the same hard bounds and role capacities as
    // the ordinary flow oracle, so an incomplete flow normally proves the
    // request infeasible. Run the cheaper oracle only on this exceptional path:
    // it preserves a defensive fallback without paying for two full flow solves
    // for every feasible candidate in a broad exact roster search.
    const feasibility = findPositionMinuteFlow(players, bounds, requirements);
    if (!feasibility.feasible) return feasibility;
    return {
      ...feasibility,
      roleConditionedScoringApplied: false,
      roleConditionedFastPathApplied: false,
      roleConditionedScoringReason: "The assigned-role projection could not be solved exactly, so the static rate projection was retained.",
    };
  }

  const byPlayer = {};
  const totalsByPlayer = {};
  const actual = { G: 0, F: 0, C: 0 };
  for (const player of sortedPlayers) {
    const roleMinutes = { G: 0, F: 0, C: 0 };
    for (const [position, edge] of roleEdges.get(player.id)) {
      const minutes = edge.initialCapacity - edge.capacity;
      roleMinutes[position] = minutes;
      actual[position] += minutes;
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
    delivered: solved.delivered,
    balanceDemand: totalRequired,
    roleConditionedScoringApplied: true,
    roleConditionedFastPathApplied: false,
  };
}

/**
 * Convert a recorded team-stint workload into regulation-game minutes. The
 * denominator is the team's aggregate player-minutes, not a player's MPG per
 * appearance, so missed games and partial-season stints do not masquerade as
 * full-season workloads. A data adapter may also provide the precomputed
 * value directly for callers that do not retain raw totals in the browser.
 */
function historicalMinuteAnchorFromPlayer(player, historicalTeamGames = null) {
  const analytics = isPlainObject(player?.analytics) ? player.analytics : null;
  const direct = finiteNonNegative(analytics?.historicalMinutesPerTeamGame);
  if (direct !== null && direct > 0) return direct;
  const totalMinutes = finiteNonNegative(analytics?.totals?.minutes);
  const teamTotalMinutes = finiteNonNegative(analytics?.teamTotalMinutes);
  if (totalMinutes > 0 && teamTotalMinutes > 0) {
    return (240 * totalMinutes) / teamTotalMinutes;
  }

  // Standalone callers and legacy course data may retain only GP and MPG.
  // Reconstruct a regulation-game share only when the selected team has a
  // plausible team-game denominator; do not mistake a 30 MPG partial stint for
  // a 30-minute full-season role. Live adapters still take the richer totals
  // branch above, so this fallback cannot overwrite verified team-stint data.
  const games = finiteNonNegative(player?.games);
  const minutesPerGame = finiteNonNegative(player?.minutes);
  if (games > 0 && minutesPerGame > 0 && historicalTeamGames > 0) {
    return (games * minutesPerGame) / historicalTeamGames;
  }
  return null;
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

/**
 * Gather recorded workload strictly as source context. Older builds treated a
 * high historical workload as a second scoring objective; that silently
 * changed the answer from "best fit for the user's requirements" to "most
 * like the source rotation." The optimizer no longer does that. This shape is
 * retained so callers can explain optional historical-capacity mode and keep
 * backwards-compatible diagnostics without letting history alter the score.
 */
function buildRotationHistoricalReadiness(players, rotationOptions = {}) {
  const reasons = [];
  const anchors = new Map();
  const historicalMinuteAnchors = rotationOptions.historicalMinuteAnchors;
  const parsedTeamGames = Number(rotationOptions.historicalTeamGames);
  const historicalTeamGames = Number.isFinite(parsedTeamGames) && parsedTeamGames > 0
    ? parsedTeamGames
    : null;

  for (const player of players) {
    const supplied = mapLikeHistoricalAnchor(
      historicalMinuteAnchors,
      player.id,
      reasons,
    );
    const anchor = supplied === undefined
      ? historicalMinuteAnchorFromPlayer(player, historicalTeamGames)
      : supplied;
    if (anchor > 0) anchors.set(player.id, anchor);
  }

  const unavailablePlayerIds = players
    .map((player) => player.id)
    .filter((id) => !anchors.has(id));
  // Keep an all-zero compatibility map rather than a workload rank. That
  // makes misuse conspicuous in diagnostics and guarantees source minutes
  // cannot influence selection, alternative ranking, or minute allocation.
  const readinessById = new Map(players.map((player) => [
    player.id,
    0,
  ]));

  return {
    applied: false,
    readinessById,
    anchorsById: Object.fromEntries(anchors),
    knownPlayerCount: anchors.size,
    eligiblePlayerCount: players.length,
    unavailablePlayerIds,
    strategyShare: ROTATION_STRATEGY_SHARE,
    historicalReadinessShare: ROTATION_HISTORICAL_READINESS_SHARE,
    reason: rotationOptions.minutePlan === "historicalAware"
      ? "Recorded workload is available only for the optional historical-capacity check; it never changes the game-plan score or selection ranking."
      : "Recorded workload is shown for context only; game-plan fit and rate projection determine the result.",
    reasons: [...new Set(reasons)],
  };
}

/**
 * Keep a historical rotation from turning a low-workload reserve into a
 * starter merely because the selected group must collectively cover 240
 * minutes. Targets below are still rescaled so they form a complete plan, but
 * this observed-workload window is a separate capacity guardrail: a player
 * cannot absorb unlimited missing minutes from teammates who were not chosen.
 *
 * Rounding outward is intentional. The exact solver works in integer minutes,
 * while Basketball Reference team-stint workload is fractional once missed
 * games and trades are expressed per team game. A 14.3-minute player with an
 * eight-minute window can therefore receive at most 23, never an accidental
 * 22 because of rounding down.
 */
function boundsAroundObservedWorkload(bounds, anchors, flexibility) {
  return new Map(
    [...bounds].map(([id, bound]) => {
      const anchor = Number(anchors.get(id));
      return [id, {
        min: Math.max(bound.min, Math.floor(Math.max(0, anchor - flexibility))),
        max: Math.min(bound.max, Math.ceil(anchor + flexibility)),
      }];
    }),
  );
}

function boundsCanReachRegulationMinutes(bounds) {
  const totals = [...bounds.values()].reduce(
    (summary, bound) => ({
      minimum: summary.minimum + bound.min,
      maximum: summary.maximum + bound.max,
    }),
    { minimum: 0, maximum: 0 },
  );
  return {
    ...totals,
    feasible: totals.minimum <= 240 && totals.maximum >= 240,
  };
}

function boundsToObject(bounds) {
  return Object.fromEntries(
    [...bounds].map(([id, bound]) => [id, { min: bound.min, max: bound.max }]),
  );
}

/**
 * Build transparent historical workload guardrails for one already-selected
 * roster. Rescaled targets ensure the selected group can be compared on a
 * full 240-minute basis, while observed-workload windows stop those targets
 * from promoting a low-minute reserve just to make the arithmetic add up.
 * If the requested window cannot cover the exact G/F/C shape, it may widen by
 * a small, disclosed amount. If the group still lacks credible capacity, it is
 * rejected so the outer exact search can choose a better-supported rotation.
 */
function deriveHistoricalGuidanceBounds(
  players,
  baseBounds,
  {
    historicalMinuteAnchors = undefined,
    historicalTeamGames = null,
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
    const anchor = supplied === undefined
      ? historicalMinuteAnchorFromPlayer(player, historicalTeamGames)
      : supplied;
    if (!(anchor > 0)) unavailablePlayerIds.push(player.id);
    else anchors.set(player.id, anchor);
  }

  const rawAnchorTotal = [...anchors.values()].reduce((total, anchor) => total + anchor, 0);

  const base = {
    requested: true,
    applied: false,
    status: "unavailable",
    minuteFlexibility,
    flexibilityUsed: null,
    anchorsById: Object.fromEntries(anchors),
    targetsById: {},
    workloadCapacityById: {},
    boundsById: boundsToObject(baseBounds),
    unavailablePlayerIds,
    knownAnchorCount: anchors.size,
    selectedPlayerCount: players.length,
    rawAnchorTotal,
    coverageOf240: rawAnchorTotal / 240,
    sourceWorkloadScale: rawAnchorTotal > 0 ? 240 / rawAnchorTotal : null,
    reason: null,
  };
  if (unavailablePlayerIds.length > 0) {
    const hasPartialEvidence = anchors.size > 0;
    const missingLabel = unavailablePlayerIds.length === 1
      ? `player ${unavailablePlayerIds[0]}`
      : `${unavailablePlayerIds.length} players (${unavailablePlayerIds.join(", ")})`;
    return {
      bounds: baseBounds,
      guidance: {
        ...base,
        status: hasPartialEvidence ? "missing-workload-evidence" : "unavailable",
        reason: hasPartialEvidence
          ? `Recorded workload is unavailable for ${missingLabel}. The optional observed-workload guardrail will not apply unevenly; choose players with complete evidence or use game-plan optimization.`
          : "Recorded workload is unavailable for every selected player, so this legacy pool uses the user-set minute bounds.",
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

  // First prove the roster can cover a regulation game's minutes without any
  // player exceeding the requested observed-workload window. This check is
  // deliberately not softened by rescaling: doing so is how a 14-minute
  // reserve can otherwise inherit a 30-plus-minute assignment.
  const requestedFlexibility = Math.min(48, Math.max(0, minuteFlexibility));
  const requestedBounds = boundsAroundObservedWorkload(
    baseBounds,
    anchors,
    requestedFlexibility,
  );
  const requestedCapacity = boundsCanReachRegulationMinutes(requestedBounds);
  if (!requestedCapacity.feasible) {
    return {
      bounds: requestedBounds,
      guidance: {
        ...base,
        status: "workload-capacity-infeasible",
        targetsById: Object.fromEntries(targets),
        workloadCapacityById: Object.fromEntries(
          [...requestedBounds].map(([id, bound]) => [id, bound.max]),
        ),
        boundsById: boundsToObject(requestedBounds),
        reason: `Recorded workload can supply at most ${requestedCapacity.maximum} of 240 minutes inside the selected ±${requestedFlexibility}-minute window. Choose players with more observed court time, increase workload flexibility, or use game-plan optimization.`,
      },
    };
  }

  // Preserve the requested window first. The two modest expansions cover rare
  // role conflicts without turning a capacity shortfall into an automatic
  // exception. Every expansion is visible in the final result.
  const flexibilityCandidates = [...new Set([
    requestedFlexibility,
    Math.min(48, requestedFlexibility + 4),
    Math.min(48, requestedFlexibility + 8),
  ])];
  for (const flexibility of flexibilityCandidates) {
    const candidateBounds = boundsAroundObservedWorkload(baseBounds, anchors, flexibility);
    const candidateCapacity = boundsCanReachRegulationMinutes(candidateBounds);
    if (!candidateCapacity.feasible) continue;
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
        workloadCapacityById: Object.fromEntries(
          [...candidateBounds].map(([id, bound]) => [id, bound.max]),
        ),
        boundsById: boundsToObject(candidateBounds),
        reason: flexibility === requestedFlexibility
          ? null
          : "The observed-workload window was widened slightly so the selected players can cover the requested on-court roles.",
      },
    };
  }

  return {
    bounds: requestedBounds,
    guidance: {
      ...base,
      status: "workload-role-coverage-infeasible",
      targetsById: Object.fromEntries(targets),
      workloadCapacityById: Object.fromEntries(
        [...requestedBounds].map(([id, bound]) => [id, bound.max]),
      ),
      boundsById: boundsToObject(requestedBounds),
      reason: "This selected group has enough observed workload for 240 minutes, but its source-listed roles cannot cover the requested on-court shape inside the workload guardrail. Choose a different role mix, increase workload flexibility, or use game-plan optimization.",
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
// A constraint-targeted seed is a performance aid, not a fallback answer. It
// walks at most this many strictly improving violation steps, then inserts any
// feasible plan into the ordinary best-first proof queue. The queue must still
// prove that no higher-objective state exists before the seed can be returned.
const MAX_CONSTRAINT_FEASIBLE_SEED_STEPS = 64;
// A single hard floor can often be certified without enumerating thousands of
// nearly tied minute vectors. The Lagrangian dual below is convex in its one
// multiplier, so a short doubling phase brackets the sign change and bisection
// approaches its best upper bound. These are performance limits only: failure
// to close the bound falls back to the existing exact state search.
const MAX_LAGRANGIAN_BRACKET_STEPS = 24;
const MAX_LAGRANGIAN_BISECTION_STEPS = 32;
const LAGRANGIAN_CERTIFICATE_TOLERANCE = 1e-7;
// A common NBA roster candidate has no ambiguous role minutes: every selected
// player covers exactly one of G/F/C for that scenario. In that structure the
// role totals split into three small independent integer-allocation problems.
// Enumerating at most four players in any one role is fast enough to build an
// exact Pareto frontier in the browser. Larger or genuinely flexible groups
// simply skip this strengthening path and retain the general exact search.
const MAX_PARTITIONED_EXACT_PLAYERS_PER_ROLE = 4;

/**
 * Read a conservative, model-owned rate when the solve supplied one; otherwise
 * retain the public allocator's historic raw-rate behavior. Keeping this
 * lookup at the point of projection avoids using a player's past minutes as a
 * minute cap while still preventing a low-usage spike from being extrapolated
 * unchanged into a much larger role.
 */
function playerPerMinuteRate(player, field, projectedRates = null) {
  const supplied = projectedRates instanceof Map
    ? projectedRates.get(player.id)?.[field]
    : isPlainObject(projectedRates)
      ? projectedRates[player.id]?.[field]
      : undefined;
  const adjusted = finiteNonNegative(supplied);
  if (adjusted !== null) return adjusted;
  const sourceMinutes = Number(player.minutes);
  const paired = pairedMetricEvidence(player, field === "turnovers" ? "ballSecurity" : field);
  if (paired) return paired.value / 36;
  if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) return Number.NaN;
  return sourceMinutes > 0 ? Number(player[field]) / sourceMinutes : 0;
}

function projectedTotalsForMinutes(players, minutes, projectedRates = null) {
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
      totals[field] += productionAtMinutes(player, field, allocatedMinutes, projectedRates);
    }
  }
  return totals;
}

function productionAtMinutes(player, field, minutes, projectedRates) {
  const curve = projectedRates?.productionCurvesById?.get(player.id)?.[field];
  return curve ? curve[minutes] : playerPerMinuteRate(player, field, projectedRates) * minutes;
}

function projectedConstraintStatus(totals, constraints) {
  const failedStatMinimums = [];
  let normalizedViolation = 0;
  for (const [stat, required] of Object.entries(constraints.statMinimums)) {
    // NaN comparisons are false in JavaScript. Without an explicit finite
    // check, absent production would accidentally pass a requested minimum.
    const deficit = Number.isFinite(totals[stat]) ? required - totals[stat] : Infinity;
    if (deficit > ROTATION_CONSTRAINT_TOLERANCE) {
      failedStatMinimums.push(stat);
      normalizedViolation += deficit / Math.max(1, Math.abs(required));
    }
  }
  const turnoverExcess = Number.isFinite(constraints.maxTurnovers)
    ? Number.isFinite(totals.turnovers) ? totals.turnovers - constraints.maxTurnovers : Infinity
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
  projectedRates = null,
) {
  if (projectedRates?.productionCurvesById?.size) {
    // Independent bounds relax the 240-minute/role requirements. They may be
    // loose, but can NEVER rule out a feasible nonlinear plan. A linear-rate
    // certificate evaluated at a different workload is not valid here.
    const bound = (field, minimum) => players.reduce((sum, player) => {
      const allowed = bounds.get(player.id);
      const values = Array.from({ length: allowed.max - allowed.min + 1 }, (_, i) =>
        productionAtMinutes(player, field, allowed.min + i, projectedRates));
      return sum + (minimum ? Math.min(...values) : Math.max(...values));
    }, 0);
    return {
      impossibleStats: Object.entries(constraints.statMinimums).filter(([field, required]) =>
        bound(field, false) + ROTATION_CONSTRAINT_TOLERANCE < required).map(([field]) => field),
      impossibleTurnovers: Number.isFinite(constraints.maxTurnovers)
        && bound("turnovers", true) - ROTATION_CONSTRAINT_TOLERANCE > constraints.maxTurnovers,
    };
  }
  const sortedIds = players.map((player) => player.id).sort(compareIds);
  const impossibleStats = [];
  for (const [stat, required] of Object.entries(constraints.statMinimums)) {
    if (failedStatus && !failedStatus.failedStatMinimums.includes(stat)) continue;
    const rateScores = new Map(
      players.map((player) => [player.id, playerPerMinuteRate(player, stat, projectedRates)]),
    );
    const maximumFlow = objectivePositionAllocation(players, bounds, rateScores, requirements);
    const maximumMinutes = new Map(
      sortedIds.map((id) => [id, maximumFlow.totalsByPlayer[id]]),
    );
    const maximum = projectedTotalsForMinutes(players, maximumMinutes, projectedRates)[stat];
    if (maximum + ROTATION_CONSTRAINT_TOLERANCE < required) impossibleStats.push(stat);
  }

  let impossibleTurnovers = false;
  if (
    Number.isFinite(constraints.maxTurnovers) &&
    (!failedStatus || failedStatus.failedMaxTurnovers)
  ) {
    const turnoverRates = new Map(
      players.map((player) => [player.id, playerPerMinuteRate(player, "turnovers", projectedRates)]),
    );
    const highestRate = Math.max(...turnoverRates.values(), 0);
    const inverseScores = new Map(
      sortedIds.map((id) => [id, highestRate - turnoverRates.get(id)]),
    );
    const minimumFlow = objectivePositionAllocation(players, bounds, inverseScores, requirements);
    const minimumMinutes = new Map(
      sortedIds.map((id) => [id, minimumFlow.totalsByPlayer[id]]),
    );
    const minimum = projectedTotalsForMinutes(players, minimumMinutes, projectedRates).turnovers;
    impossibleTurnovers =
      minimum - ROTATION_CONSTRAINT_TOLERANCE > constraints.maxTurnovers;
  }

  return { impossibleStats, impossibleTurnovers };
}

function allocationObjective(minutes, scores, roleConditionedScorePlan = null) {
  let value = 0;
  for (const [id, minuteTotal] of minutes) {
    const roleConditionedUnits = roleConditionedScorePlan
      ? roleConditionedScoreUnits(id, minuteTotal, roleConditionedScorePlan)
      : null;
    value += roleConditionedUnits ?? (scores.get(id) * minuteTotal);
  }
  return value;
}

/**
 * Read one discrete minute's objective value for the constrained-state graph.
 *
 * The linear model has a constant marginal score. The improved rotation model
 * instead reads the same role-expansion and workload-saturation marginal used
 * by the unconstrained min-cost flow. Keeping this in one helper prevents the
 * optional production rules from quietly optimizing a different equation.
 */
function allocationMarginalValue(
  playerId,
  assignedMinute,
  scores,
  roleConditionedScorePlan = null,
) {
  if (!roleConditionedScorePlan) return scores.get(playerId);
  const establishedScore = finiteNonNegative(
    roleConditionedScorePlan.establishedScoresById?.get(playerId),
  );
  const expandedScore = finiteNonNegative(
    roleConditionedScorePlan.expandedScoresById?.get(playerId),
  );
  if (establishedScore === null || expandedScore === null) {
    return scores.get(playerId);
  }
  return roleConditionedMarginalValueUnits(
    playerId,
    assignedMinute,
    establishedScore,
    expandedScore,
    roleConditionedScorePlan,
  );
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
 * Construct a good feasible lower bound for the exact constrained search.
 *
 * Best-first enumeration is mathematically clean, but a modest production
 * floor can have thousands of almost-tied minute vectors above the first
 * feasible one. This bounded repair walk starts at the unconstrained optimum
 * and chooses the role-feasible one-minute exchange with the smallest objective
 * loss per unit of normalized constraint improvement. It only accepts steps
 * that strictly reduce the visible violation and never increase the model
 * objective.
 *
 * Crucially, this helper does not certify optimality. A feasible result is
 * inserted into the same max-heap as every other state. Because exchange paths
 * are non-increasing in objective value, the seed can be popped only after all
 * reachable higher-valued states have been examined. It therefore accelerates
 * the proof without changing which allocation is exact.
 */
function buildConstraintFeasibleSeed(
  players,
  bounds,
  scores,
  requirements,
  initialFlow,
  constraints,
  projectedRates = null,
  roleConditionedScorePlan = null,
) {
  const sortedIds = players.map((player) => player.id).sort(compareIds);
  const statFields = ["points", "rebounds", "assists", "steals", "blocks", "turnovers"];
  const rateVectors = new Map(players.map((player) => [
    player.id,
    Object.fromEntries(
      statFields.map((field) => [field, playerPerMinuteRate(player, field, projectedRates)]),
    ),
  ]));
  let current = {
    key: minuteStateKey(
      sortedIds,
      new Map(sortedIds.map((id) => [id, initialFlow.totalsByPlayer[id]])),
    ),
    minutes: new Map(sortedIds.map((id) => [id, initialFlow.totalsByPlayer[id]])),
    flow: initialFlow,
    totals: null,
    status: null,
    objective: 0,
    repairSteps: 0,
  };
  current.totals = projectedTotalsForMinutes(players, current.minutes, projectedRates);
  current.status = projectedConstraintStatus(current.totals, constraints);
  current.objective = allocationObjective(current.minutes, scores, roleConditionedScorePlan);
  if (current.status.passed) return current;

  const visited = new Set([current.key]);
  for (let repairStep = 1; repairStep <= MAX_CONSTRAINT_FEASIBLE_SEED_STEPS; repairStep += 1) {
    let best = null;
    for (const donorId of sortedIds) {
      if (current.minutes.get(donorId) <= bounds.get(donorId).min) continue;
      for (const receiverId of sortedIds) {
        if (donorId === receiverId) continue;
        if (current.minutes.get(receiverId) >= bounds.get(receiverId).max) continue;

        const donorMarginal = allocationMarginalValue(
          donorId,
          current.minutes.get(donorId),
          scores,
          roleConditionedScorePlan,
        );
        const receiverMarginal = allocationMarginalValue(
          receiverId,
          current.minutes.get(receiverId) + 1,
          scores,
          roleConditionedScorePlan,
        );
        const objective = current.objective - donorMarginal + receiverMarginal;
        if (objective > current.objective + 1e-12) continue;

        // Update the six projected totals arithmetically before paying for a
        // role-flow proof. Most exchanges do not improve the active rule and
        // can be rejected here without building another network.
        const totals = { ...current.totals };
        for (const field of statFields) {
          const donor = players.find(player => player.id === donorId);
          const receiver = players.find(player => player.id === receiverId);
          totals[field] += productionAtMinutes(receiver, field, current.minutes.get(receiverId) + 1, projectedRates)
            - productionAtMinutes(receiver, field, current.minutes.get(receiverId), projectedRates)
            + productionAtMinutes(donor, field, current.minutes.get(donorId) - 1, projectedRates)
            - productionAtMinutes(donor, field, current.minutes.get(donorId), projectedRates);
        }
        const status = projectedConstraintStatus(totals, constraints);
        const violationImprovement =
          current.status.normalizedViolation - status.normalizedViolation;
        if (violationImprovement <= ROTATION_CONSTRAINT_TOLERANCE) continue;

        const minutes = new Map(current.minutes);
        minutes.set(donorId, minutes.get(donorId) - 1);
        minutes.set(receiverId, minutes.get(receiverId) + 1);
        const key = minuteStateKey(sortedIds, minutes);
        if (visited.has(key)) continue;
        const flow = findPositionMinuteFlow(players, fixedBoundsFrom(minutes), requirements);
        if (!flow.feasible) continue;

        const objectiveLoss = Math.max(0, current.objective - objective);
        const lossPerImprovement = objectiveLoss / violationImprovement;
        const candidate = {
          key,
          minutes,
          flow,
          totals,
          status,
          objective,
          repairSteps: repairStep,
          lossPerImprovement,
        };
        const candidateIsBetter = !best ||
          candidate.lossPerImprovement < best.lossPerImprovement - 1e-12 ||
          (Math.abs(candidate.lossPerImprovement - best.lossPerImprovement) <= 1e-12 &&
            candidate.status.normalizedViolation < best.status.normalizedViolation - 1e-12) ||
          (Math.abs(candidate.lossPerImprovement - best.lossPerImprovement) <= 1e-12 &&
            Math.abs(candidate.status.normalizedViolation - best.status.normalizedViolation) <= 1e-12 &&
            candidate.objective > best.objective + 1e-12) ||
          (Math.abs(candidate.lossPerImprovement - best.lossPerImprovement) <= 1e-12 &&
            Math.abs(candidate.status.normalizedViolation - best.status.normalizedViolation) <= 1e-12 &&
            Math.abs(candidate.objective - best.objective) <= 1e-12 &&
            compareIds(candidate.key, best.key) < 0);
        if (candidateIsBetter) best = candidate;
      }
    }

    if (!best) return null;
    current = best;
    visited.add(current.key);
    if (current.status.passed) return current;
  }
  return null;
}

/**
 * Try to certify a feasible seed with a one-rule Lagrangian upper bound.
 *
 * For a minimum such as rebounds >= 44 and any lambda >= 0:
 *
 *   original objective <= max_x(objective(x) + lambda * (rebounds(x) - 44))
 *
 * for every feasible x. The same transformation uses -turnovers for a maximum
 * turnover rule. The inner maximum is still a separable concave minute model:
 * lambda merely adds a constant player-specific amount to each marginal minute,
 * so the existing role-feasible network solves it exactly.
 *
 * When the smallest upper bound reaches the feasible seed's objective, the seed
 * is proven optimal without walking every higher-scoring-but-infeasible minute
 * vector. If the integer side constraint has a duality gap, this helper returns
 * an unsuccessful audit and the exhaustive best-first proof remains authoritative.
 */
function certifyConstraintFeasibleSeedWithLagrangian(
  players,
  bounds,
  scores,
  requirements,
  constraints,
  initialTotals,
  feasibleSeed,
  projectedRates = null,
  roleConditionedScorePlan = null,
) {
  if (projectedRates?.productionCurvesById?.size) return {
    attempted: false, certified: false, evaluations: 0, feasibleSeed,
    reason: "Nonlinear production uses exact workload evaluations, not a linear-rate certificate.",
  };
  const rules = [];
  for (const [stat, required] of Object.entries(constraints.statMinimums)) {
    if (initialTotals[stat] + ROTATION_CONSTRAINT_TOLERANCE >= required) continue;
    rules.push({
      key: `minimum-${stat}`,
      field: stat,
      sign: 1,
      threshold: required,
    });
  }
  if (
    Number.isFinite(constraints.maxTurnovers) &&
    initialTotals.turnovers - ROTATION_CONSTRAINT_TOLERANCE > constraints.maxTurnovers
  ) {
    // Rewriting turnovers <= maximum as -turnovers >= -maximum lets the same
    // mathematically transparent lower-bound certificate handle both senses.
    rules.push({
      key: "maximum-turnovers",
      field: "turnovers",
      sign: -1,
      threshold: -constraints.maxTurnovers,
    });
  }
  if (rules.length === 0) {
    return {
      attempted: false,
      certified: false,
      evaluations: 0,
      feasibleSeed: feasibleSeed?.status?.passed ? feasibleSeed : null,
    };
  }

  const sortedIds = players.map((player) => player.id).sort(compareIds);
  let bestFeasibleSeed = feasibleSeed?.status?.passed ? feasibleSeed : null;
  let totalEvaluations = 0;
  let bestAudit = null;
  for (const rule of rules) {
    const rateById = new Map(players.map((player) => [
      player.id,
      rule.sign * playerPerMinuteRate(player, rule.field, projectedRates),
    ]));
    const quantityForMinutes = (minutes) => [...minutes].reduce(
      (total, [id, minuteTotal]) => total + rateById.get(id) * minuteTotal,
      0,
    );

    let evaluations = 0;
    let best = null;
    const evaluateMultiplier = (multiplier) => {
      evaluations += 1;
      totalEvaluations += 1;
      const marginalAdjustmentById = new Map(
        players.map((player) => [player.id, multiplier * rateById.get(player.id)]),
      );
      let flow;
      if (roleConditionedScorePlan) {
        flow = roleConditionedPositionAllocation(
          players,
          bounds,
          requirements,
          roleConditionedScorePlan,
          marginalAdjustmentById,
        );
      } else {
        const adjustedScores = new Map(players.map((player) => [
          player.id,
          (Number(scores.get(player.id)) || 0) + marginalAdjustmentById.get(player.id),
        ]));
        flow = objectivePositionAllocation(players, bounds, adjustedScores, requirements);
      }
      if (!flow.feasible) return null;

      const minutes = new Map(
        players.map((player) => [player.id, flow.totalsByPlayer[player.id]]),
      );
      const objective = allocationObjective(minutes, scores, roleConditionedScorePlan);
      const quantity = quantityForMinutes(minutes);
      const upperBound = objective + multiplier * (quantity - rule.threshold);

      // Unlike the small repair walk, this relaxed solve may cross a role-flow
      // bottleneck in one exact network optimization. Retain any plan that also
      // satisfies *all* active production rules, not just the one currently
      // priced by lambda. This gives the proof a robust seed even when no
      // monotonically violation-improving one-minute path was available.
      const totals = projectedTotalsForMinutes(players, minutes, projectedRates);
      const status = projectedConstraintStatus(totals, constraints);
      if (status.passed) {
        const key = minuteStateKey(sortedIds, minutes);
        const candidateSeed = {
          key,
          minutes,
          flow,
          totals,
          status,
          objective,
          repairSteps: 0,
          source: "lagrangian-relaxation",
        };
        if (
          !bestFeasibleSeed ||
          candidateSeed.objective > bestFeasibleSeed.objective + 1e-12 ||
          (Math.abs(candidateSeed.objective - bestFeasibleSeed.objective) <= 1e-12 &&
            compareIds(candidateSeed.key, bestFeasibleSeed.key) < 0)
        ) {
          bestFeasibleSeed = candidateSeed;
        }
      }

      // The seed itself is a legal point in every relaxed inner problem. This
      // defensive inequality detects a future regression in the adjusted flow
      // before an underestimated value could ever be accepted as a certificate.
      if (bestFeasibleSeed) {
        const seedQuantity = quantityForMinutes(bestFeasibleSeed.minutes);
        const seedAdjustedObjective =
          bestFeasibleSeed.objective + multiplier * (seedQuantity - rule.threshold);
        if (upperBound + LAGRANGIAN_CERTIFICATE_TOLERANCE < seedAdjustedObjective) {
          return null;
        }
      }

      const evaluation = {
        flow,
        minutes,
        multiplier,
        objective,
        quantity,
        slack: quantity - rule.threshold,
        upperBound,
      };
      if (!best || evaluation.upperBound < best.upperBound) best = evaluation;
      return evaluation;
    };

    // Lambda zero is the already-computed unconstrained optimum and has a
    // negative rule slack. Start at one, then double until an adjusted optimum
    // reaches the requested side of the floor (or the generous numeric bracket
    // is exhausted). This avoids guessing a sport-specific penalty scale.
    let lowMultiplier = 0;
    let highMultiplier = 1;
    let high = null;
    for (let step = 0; step < MAX_LAGRANGIAN_BRACKET_STEPS; step += 1) {
      high = evaluateMultiplier(highMultiplier);
      if (!high) break;
      if (high.slack >= -ROTATION_CONSTRAINT_TOLERANCE) break;
      lowMultiplier = highMultiplier;
      highMultiplier *= 2;
    }

    if (high && high.slack >= -ROTATION_CONSTRAINT_TOLERANCE) {
      for (let step = 0; step < MAX_LAGRANGIAN_BISECTION_STEPS; step += 1) {
        const midpoint = (lowMultiplier + highMultiplier) / 2;
        const evaluation = evaluateMultiplier(midpoint);
        if (!evaluation) break;
        if (evaluation.slack >= -ROTATION_CONSTRAINT_TOLERANCE) {
          highMultiplier = midpoint;
        } else {
          lowMultiplier = midpoint;
        }
      }
    }

    if (best && bestFeasibleSeed) {
      const audit = {
        attempted: true,
        certified:
          best.upperBound <= bestFeasibleSeed.objective + LAGRANGIAN_CERTIFICATE_TOLERANCE,
        rule: rule.key,
        multiplier: best.multiplier,
        upperBound: best.upperBound,
        seedObjective: bestFeasibleSeed.objective,
        upperBoundGap: Math.max(0, best.upperBound - bestFeasibleSeed.objective),
        evaluations,
        feasibleSeed: bestFeasibleSeed,
      };
      if (
        !bestAudit ||
        audit.upperBoundGap < bestAudit.upperBoundGap - LAGRANGIAN_CERTIFICATE_TOLERANCE
      ) {
        bestAudit = audit;
      }
      if (audit.certified) {
        return { ...audit, evaluations: totalEvaluations };
      }
    }
  }

  return bestAudit
    ? { ...bestAudit, evaluations: totalEvaluations, feasibleSeed: bestFeasibleSeed }
    : {
        attempted: true,
        certified: false,
        evaluations: totalEvaluations,
        feasibleSeed: bestFeasibleSeed,
      };
}

/**
 * Translate exactly one active production rule to a common >= form.
 *
 * A single extra linear inequality is the structure where the partitioned
 * Pareto proof below is both compact and easy to audit. Multiple simultaneous
 * floors/ceilings retain the general exact exchange search; silently dropping
 * one of them here would make a fast answer mathematically wrong.
 */
function singleProjectedConstraintRule(constraints) {
  const rules = Object.entries(constraints.statMinimums).map(([field, threshold]) => ({
    key: `minimum-${field}`,
    field,
    sign: 1,
    threshold,
  }));
  if (Number.isFinite(constraints.maxTurnovers)) {
    rules.push({
      key: "maximum-turnovers",
      field: "turnovers",
      sign: -1,
      threshold: -constraints.maxTurnovers,
    });
  }
  return rules.length === 1 ? rules[0] : null;
}

/**
 * Remove dominated production/objective pairs without changing the optimum.
 *
 * Quantity is already signed so larger is always better (a turnover ceiling
 * uses negative turnovers). If one partial plan has at least as much signed
 * production and at least as much game-plan value as another, adding any of
 * the remaining role plans preserves that dominance. Keeping only this Pareto
 * frontier is therefore an exact reduction, not a heuristic shortlist.
 */
function pruneProductionObjectiveFrontier(options) {
  const ordered = options.slice().sort((left, right) => {
    if (left.quantity !== right.quantity) return right.quantity - left.quantity;
    if (Math.abs(left.objective - right.objective) > 1e-12) {
      return right.objective - left.objective;
    }
    return compareIds(left.key, right.key);
  });
  const frontier = [];
  let bestObjective = Number.NEGATIVE_INFINITY;
  for (const option of ordered) {
    if (option.objective <= bestObjective + 1e-12) continue;
    frontier.push(option);
    bestObjective = option.objective;
  }
  return frontier;
}

/**
 * Enumerate the exact integer-minute frontier for one fixed G/F/C bucket.
 *
 * This routine is deliberately narrow. Every player must be assignable to one
 * and only one required role for the current candidate, and that role must be
 * able to accept the player's full configured maximum. Under those conditions
 * role feasibility reduces to a simple exact minute sum. Recursive lower/upper
 * bounds discard impossible partial sums before they create a leaf.
 */
function enumerateFixedRoleFrontier(
  players,
  requiredMinutes,
  bounds,
  scores,
  rateById,
  roleConditionedScorePlan,
) {
  const sortedPlayers = players.slice().sort(comparePlayersById);
  if (sortedPlayers.length > MAX_PARTITIONED_EXACT_PLAYERS_PER_ROLE) return null;
  const suffixMinimum = Array(sortedPlayers.length + 1).fill(0);
  const suffixMaximum = Array(sortedPlayers.length + 1).fill(0);
  for (let index = sortedPlayers.length - 1; index >= 0; index -= 1) {
    const playerBounds = bounds.get(sortedPlayers[index].id);
    suffixMinimum[index] = suffixMinimum[index + 1] + playerBounds.min;
    suffixMaximum[index] = suffixMaximum[index + 1] + playerBounds.max;
  }
  if (
    requiredMinutes < suffixMinimum[0] ||
    requiredMinutes > suffixMaximum[0]
  ) {
    return { frontier: [], plansEnumerated: 0 };
  }

  // Precompute each player's cumulative value at every legal minute total.
  // The minute-aware curve can include both role-expansion regression and
  // workload saturation, so using allocationObjective here preserves the same
  // exact objective as the network and exchange solvers.
  const objectiveByIdAndMinutes = new Map();
  for (const player of sortedPlayers) {
    const values = new Map();
    const playerBounds = bounds.get(player.id);
    for (let minutes = playerBounds.min; minutes <= playerBounds.max; minutes += 1) {
      values.set(
        minutes,
        allocationObjective(
          new Map([[player.id, minutes]]),
          scores,
          roleConditionedScorePlan,
        ),
      );
    }
    objectiveByIdAndMinutes.set(player.id, values);
  }

  const options = [];
  const minutes = new Map();
  let plansEnumerated = 0;
  function enumerate(index, remaining, objective, quantity) {
    if (index === sortedPlayers.length) {
      if (remaining !== 0) return;
      plansEnumerated += 1;
      const frozenMinutes = new Map(minutes);
      const ids = sortedPlayers.map((player) => player.id);
      options.push({
        key: minuteStateKey(ids, frozenMinutes),
        minutes: frozenMinutes,
        objective,
        quantity,
      });
      return;
    }
    const player = sortedPlayers[index];
    const playerBounds = bounds.get(player.id);
    const minimumAfter = suffixMinimum[index + 1];
    const maximumAfter = suffixMaximum[index + 1];
    const first = Math.max(playerBounds.min, remaining - maximumAfter);
    const last = Math.min(playerBounds.max, remaining - minimumAfter);
    for (let assigned = first; assigned <= last; assigned += 1) {
      minutes.set(player.id, assigned);
      enumerate(
        index + 1,
        remaining - assigned,
        objective + objectiveByIdAndMinutes.get(player.id).get(assigned),
        quantity + (Array.isArray(rateById.get(player.id))
          ? rateById.get(player.id)[assigned] : rateById.get(player.id) * assigned),
      );
    }
    minutes.delete(player.id);
  }
  enumerate(0, requiredMinutes, 0, 0);
  return {
    frontier: pruneProductionObjectiveFrontier(options),
    plansEnumerated,
  };
}

/**
 * Prove a one-rule constrained allocation by composing exact role frontiers.
 *
 * This is a formulation-strengthening path inspired by the research paper's
 * advice to exploit model structure before increasing generic search limits.
 * It is applicable only when every selected player belongs to one fixed role
 * and each role contains at most four players. All other candidates continue
 * through the fully general role-flow/exchange proof.
 */
function partitionedSingleConstraintAllocation(
  players,
  bounds,
  scores,
  requirements,
  constraints,
  projectedRates = null,
  roleConditionedScorePlan = null,
) {
  const rule = singleProjectedConstraintRule(constraints);
  if (!rule) return null;
  const groups = Object.fromEntries(POSITION_KEYS.map((position) => [position, []]));
  const effectiveBounds = new Map();

  for (const player of players) {
    const playerBounds = bounds.get(player.id);
    const activeRoles = POSITION_KEYS.filter(
      (position) =>
        requirements[position] > 0 &&
        positionMinuteCapacity(player, position, playerBounds.max) > 0,
    );
    if (activeRoles.length !== 1) return null;
    const role = activeRoles[0];
    const roleMaximum = Math.min(
      playerBounds.max,
      positionMinuteCapacity(player, role, playerBounds.max),
    );
    if (playerBounds.min > roleMaximum) {
      return { complete: true, feasible: false, plansEnumerated: 0, frontierStates: 0 };
    }
    effectiveBounds.set(player.id, { min: playerBounds.min, max: roleMaximum });
    groups[role].push(player);
  }
  if (
    POSITION_KEYS.some(
      (position) => groups[position].length > MAX_PARTITIONED_EXACT_PLAYERS_PER_ROLE,
    )
  ) {
    return null;
  }

  const rateById = new Map(players.map((player) => [
    player.id,
    projectedRates?.productionCurvesById?.size
      ? Array.from({ length: 49 }, (_, minute) => rule.sign * productionAtMinutes(player, rule.field, minute, projectedRates))
      : rule.sign * playerPerMinuteRate(player, rule.field, projectedRates),
  ]));
  let combined = [{
    key: "",
    minutes: new Map(),
    objective: 0,
    quantity: 0,
  }];
  let plansEnumerated = 0;
  let combinationsMerged = 0;
  for (const position of POSITION_KEYS) {
    const roleResult = enumerateFixedRoleFrontier(
      groups[position],
      requirements[position],
      effectiveBounds,
      scores,
      rateById,
      roleConditionedScorePlan,
    );
    if (!roleResult) return null;
    plansEnumerated += roleResult.plansEnumerated;
    if (roleResult.frontier.length === 0) {
      return { complete: true, feasible: false, plansEnumerated, frontierStates: 0 };
    }
    const merged = [];
    for (const left of combined) {
      for (const right of roleResult.frontier) {
        combinationsMerged += 1;
        merged.push({
          key: `${left.key}|${right.key}`,
          minutes: new Map([...left.minutes, ...right.minutes]),
          objective: left.objective + right.objective,
          quantity: left.quantity + right.quantity,
        });
      }
    }
    combined = pruneProductionObjectiveFrontier(merged);
  }

  const sortedIds = players.map((player) => player.id).sort(compareIds);
  const feasiblePlans = combined
    .filter((option) => option.quantity + ROTATION_CONSTRAINT_TOLERANCE >= rule.threshold)
    .map((option) => ({
      ...option,
      key: minuteStateKey(sortedIds, option.minutes),
    }))
    .sort((left, right) => {
      if (Math.abs(left.objective - right.objective) > 1e-12) {
        return right.objective - left.objective;
      }
      return compareIds(left.key, right.key);
    });
  if (feasiblePlans.length === 0) {
    return {
      complete: true,
      feasible: false,
      plansEnumerated,
      combinationsMerged,
      frontierStates: combined.length,
      rule: rule.key,
    };
  }

  const best = feasiblePlans[0];
  const flow = findPositionMinuteFlow(
    players,
    fixedBoundsFrom(best.minutes),
    requirements,
  );
  if (!flow.feasible) return null;
  const totals = projectedTotalsForMinutes(players, best.minutes, projectedRates);
  const status = projectedConstraintStatus(totals, constraints);
  if (!status.passed) return null;
  return {
    complete: true,
    feasible: true,
    key: best.key,
    minutes: best.minutes,
    flow,
    totals,
    status,
    objective: best.objective,
    plansEnumerated,
    combinationsMerged,
    frontierStates: combined.length,
    rule: rule.key,
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
  projectedRates = null,
  roleConditionedScorePlan = null,
) {
  const sortedIds = players.map((player) => player.id).sort(compareIds);
  const initialMinutes = new Map(
    sortedIds.map((id) => [id, initialFlow.totalsByPlayer[id]]),
  );
  const initialTotals = projectedTotalsForMinutes(players, initialMinutes, projectedRates);
  const initialStatus = projectedConstraintStatus(initialTotals, constraints);
  let statesExamined = 0;
  let feasibleSeed = null;
  let lagrangianCertificate = {
    attempted: false,
    certified: false,
    evaluations: 0,
  };
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
    constraintFeasibleSeedFound: Boolean(feasibleSeed),
    constraintFeasibleSeedRepairSteps: feasibleSeed?.repairSteps ?? 0,
    constraintFeasibleSeedSource: feasibleSeed?.source ?? null,
    constraintLagrangianCertificateAttempted: lagrangianCertificate.attempted,
    constraintLagrangianCertificateApplied: lagrangianCertificate.certified,
    constraintLagrangianCertificateRule: lagrangianCertificate.rule ?? null,
    constraintLagrangianCertificateEvaluations: lagrangianCertificate.evaluations ?? 0,
    constraintLagrangianUpperBoundGap: lagrangianCertificate.upperBoundGap ?? null,
    constraintPartitionedExactApplied: false,
    constraintPartitionedExactPlansEnumerated: 0,
    constraintPartitionedExactFrontierStates: 0,
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
      constraintFeasibleSeedFound: false,
      constraintFeasibleSeedRepairSteps: 0,
      constraintFeasibleSeedSource: null,
      constraintFeasibleSeedUsed: false,
      constraintLagrangianCertificateAttempted: false,
      constraintLagrangianCertificateApplied: false,
      constraintLagrangianCertificateRule: null,
      constraintLagrangianCertificateEvaluations: 0,
      constraintLagrangianUpperBoundGap: null,
      constraintPartitionedExactApplied: false,
      constraintPartitionedExactPlansEnumerated: 0,
      constraintPartitionedExactFrontierStates: 0,
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
      projectedRates,
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
      constraintFeasibleSeedFound: false,
      constraintFeasibleSeedRepairSteps: 0,
      constraintFeasibleSeedSource: null,
      constraintLagrangianCertificateAttempted: false,
      constraintLagrangianCertificateApplied: false,
      constraintLagrangianCertificateRule: null,
      constraintLagrangianCertificateEvaluations: 0,
      constraintLagrangianUpperBoundGap: null,
      constraintPartitionedExactApplied: false,
      constraintPartitionedExactPlansEnumerated: 0,
      constraintPartitionedExactFrontierStates: 0,
    };
  }

  const heap = createAllocationMaxHeap();
  const initialKey = minuteStateKey(sortedIds, initialMinutes);
  heap.push({
    key: initialKey,
    minutes: initialMinutes,
    flow: initialFlow,
    objective: allocationObjective(initialMinutes, scores, roleConditionedScorePlan),
    isFeasibleSeed: false,
  });
  const visited = new Set([initialKey]);
  feasibleSeed = buildConstraintFeasibleSeed(
    players,
    bounds,
    scores,
    requirements,
    initialFlow,
    constraints,
    projectedRates,
    roleConditionedScorePlan,
  );
  if (feasibleSeed) feasibleSeed.source = "greedy-repair";
  if (feasibleSeed && feasibleSeed.key !== initialKey) {
    // Inserting the seed directly is safe because the heap still ranks it by
    // the exact same objective. It cannot jump ahead of any better state.
    heap.push({
      key: feasibleSeed.key,
      minutes: feasibleSeed.minutes,
      flow: feasibleSeed.flow,
      objective: feasibleSeed.objective,
      isFeasibleSeed: true,
    });
    visited.add(feasibleSeed.key);
  }
  lagrangianCertificate = certifyConstraintFeasibleSeedWithLagrangian(
    players,
    bounds,
    scores,
    requirements,
    constraints,
    initialTotals,
    feasibleSeed,
    projectedRates,
    roleConditionedScorePlan,
  );
  const certificateSeed = lagrangianCertificate.feasibleSeed;
  if (
    certificateSeed &&
    (!feasibleSeed ||
      certificateSeed.objective > feasibleSeed.objective + 1e-12 ||
      (Math.abs(certificateSeed.objective - feasibleSeed.objective) <= 1e-12 &&
        compareIds(certificateSeed.key, feasibleSeed.key) < 0))
  ) {
    feasibleSeed = certificateSeed;
    if (feasibleSeed.key !== initialKey && !visited.has(feasibleSeed.key)) {
      // Even when the dual bound has an integer gap, the stronger relaxed seed
      // is useful to the ordinary proof queue. It remains ordered by the exact
      // original objective and therefore cannot bypass a better unseen state.
      heap.push({
        key: feasibleSeed.key,
        minutes: feasibleSeed.minutes,
        flow: feasibleSeed.flow,
        objective: feasibleSeed.objective,
        isFeasibleSeed: true,
      });
      visited.add(feasibleSeed.key);
    }
  }
  if (lagrangianCertificate.certified && feasibleSeed) {
      // The dual upper bound and the feasible seed now meet at the same model
      // value, so no unseen allocation can score higher. Returning the seed is
      // exact; the certificate replaces only the enumeration proof, not the
      // objective, production projection, role flow, or hard minute bounds.
      return {
        ...feasibleSeed.flow,
        ...(roleConditionedScorePlan
          ? {
              roleConditionedScoringApplied: true,
              roleConditionedFastPathApplied: false,
              roleConditionedScoringReason: "The exact constrained solve preserved the diminishing-return minute objective and used a production-floor upper-bound certificate.",
            }
          : {}),
        projectedTotals: feasibleSeed.totals,
        constraintSearchStates: 0,
        solveConstraintSearchStatesUsed: sharedBudget?.used ?? 0,
        constraintsAdjusted: true,
        constraintFeasibleSeedFound: true,
        constraintFeasibleSeedRepairSteps: feasibleSeed.repairSteps,
        constraintFeasibleSeedSource: feasibleSeed.source ?? null,
        constraintFeasibleSeedUsed: true,
        constraintLagrangianCertificateAttempted: true,
        constraintLagrangianCertificateApplied: true,
        constraintLagrangianCertificateRule: lagrangianCertificate.rule,
        constraintLagrangianCertificateEvaluations: lagrangianCertificate.evaluations,
        constraintLagrangianUpperBoundGap: lagrangianCertificate.upperBoundGap,
        constraintPartitionedExactApplied: false,
        constraintPartitionedExactPlansEnumerated: 0,
        constraintPartitionedExactFrontierStates: 0,
      };
  }

  const partitionedExact = partitionedSingleConstraintAllocation(
    players,
    bounds,
    scores,
    requirements,
    constraints,
    projectedRates,
    roleConditionedScorePlan,
  );
  if (partitionedExact?.complete) {
    if (!partitionedExact.feasible) {
      return {
        feasible: false,
        constraintInfeasible: true,
        constraintSearchLimitReached: false,
        solveWideConstraintSearchLimitReached: false,
        failedStatMinimums: initialStatus.failedStatMinimums,
        failedMaxTurnovers: initialStatus.failedMaxTurnovers,
        projectedTotals: initialTotals,
        constraintSearchStates: 0,
        solveConstraintSearchStatesUsed: sharedBudget?.used ?? 0,
        solveConstraintSearchStateLimit:
          sharedBudget?.limit ?? MAX_CONSTRAINED_ALLOCATION_STATES,
        constraintFeasibleSeedFound: Boolean(feasibleSeed),
        constraintFeasibleSeedRepairSteps: feasibleSeed?.repairSteps ?? 0,
        constraintFeasibleSeedSource: feasibleSeed?.source ?? null,
        constraintLagrangianCertificateAttempted: lagrangianCertificate.attempted,
        constraintLagrangianCertificateApplied: false,
        constraintLagrangianCertificateRule: lagrangianCertificate.rule ?? null,
        constraintLagrangianCertificateEvaluations:
          lagrangianCertificate.evaluations ?? 0,
        constraintLagrangianUpperBoundGap:
          lagrangianCertificate.upperBoundGap ?? null,
        constraintPartitionedExactApplied: true,
        constraintPartitionedExactPlansEnumerated:
          partitionedExact.plansEnumerated ?? 0,
        constraintPartitionedExactFrontierStates:
          partitionedExact.frontierStates ?? 0,
      };
    }
    return {
      ...partitionedExact.flow,
      ...(roleConditionedScorePlan
        ? {
            roleConditionedScoringApplied: true,
            roleConditionedFastPathApplied: false,
            roleConditionedScoringReason: "The exact constrained solve preserved the diminishing-return minute objective and composed complete fixed-role production frontiers.",
          }
        : {}),
      projectedTotals: partitionedExact.totals,
      constraintSearchStates: 0,
      solveConstraintSearchStatesUsed: sharedBudget?.used ?? 0,
      constraintsAdjusted: partitionedExact.key !== initialKey,
      constraintFeasibleSeedFound: true,
      constraintFeasibleSeedRepairSteps: feasibleSeed?.repairSteps ?? 0,
      constraintFeasibleSeedSource: "fixed-role-pareto-proof",
      constraintFeasibleSeedUsed: true,
      constraintLagrangianCertificateAttempted: lagrangianCertificate.attempted,
      constraintLagrangianCertificateApplied: false,
      constraintLagrangianCertificateRule: lagrangianCertificate.rule ?? null,
      constraintLagrangianCertificateEvaluations:
        lagrangianCertificate.evaluations ?? 0,
      constraintLagrangianUpperBoundGap:
        lagrangianCertificate.upperBoundGap ?? null,
      constraintPartitionedExactApplied: true,
      constraintPartitionedExactPlansEnumerated:
        partitionedExact.plansEnumerated ?? 0,
      constraintPartitionedExactFrontierStates:
        partitionedExact.frontierStates ?? 0,
    };
  }
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
    const totals = projectedTotalsForMinutes(players, state.minutes, projectedRates);
    const status = projectedConstraintStatus(totals, constraints);
    if (status.passed) {
      return {
        ...state.flow,
        ...(roleConditionedScorePlan
          ? {
              roleConditionedScoringApplied: true,
              roleConditionedFastPathApplied: false,
              roleConditionedScoringReason: state.key === initialKey
                ? "The unconstrained diminishing-return optimum already satisfied every production rule."
                : "The exact constrained search preserved the diminishing-return minute objective while satisfying the requested production rules.",
            }
          : {}),
        projectedTotals: totals,
        constraintSearchStates: statesExamined,
        solveConstraintSearchStatesUsed: sharedBudget?.used ?? statesExamined,
        constraintsAdjusted: state.key !== initialKey,
        constraintFeasibleSeedFound: Boolean(feasibleSeed),
        constraintFeasibleSeedRepairSteps: feasibleSeed?.repairSteps ?? 0,
        constraintFeasibleSeedSource: feasibleSeed?.source ?? null,
        constraintFeasibleSeedUsed: Boolean(state.isFeasibleSeed),
        constraintLagrangianCertificateAttempted: lagrangianCertificate.attempted,
        constraintLagrangianCertificateApplied: false,
        constraintLagrangianCertificateRule: lagrangianCertificate.rule ?? null,
        constraintLagrangianCertificateEvaluations: lagrangianCertificate.evaluations ?? 0,
        constraintLagrangianUpperBoundGap: lagrangianCertificate.upperBoundGap ?? null,
        constraintPartitionedExactApplied: false,
        constraintPartitionedExactPlansEnumerated: 0,
        constraintPartitionedExactFrontierStates: 0,
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
        // Feasible player-minute totals form an integer exchange family. With
        // a separable concave objective, every lower-valued feasible total can
        // be reached from the global maximum through non-increasing one-minute
        // exchanges. Compare the *current marginal minutes* here—not the two
        // players' static scores—so the proof remains valid after workload
        // saturation changes marginal value at different minute counts.
        const donorMarginal = allocationMarginalValue(
          donorId,
          state.minutes.get(donorId),
          scores,
          roleConditionedScorePlan,
        );
        const receiverMarginal = allocationMarginalValue(
          receiverId,
          state.minutes.get(receiverId) + 1,
          scores,
          roleConditionedScorePlan,
        );
        const nextObjective = state.objective - donorMarginal + receiverMarginal;
        if (nextObjective > state.objective + 1e-12) continue;
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
          objective: nextObjective,
          isFeasibleSeed: false,
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
    constraintFeasibleSeedFound: Boolean(feasibleSeed),
    constraintFeasibleSeedRepairSteps: feasibleSeed?.repairSteps ?? 0,
    constraintFeasibleSeedSource: feasibleSeed?.source ?? null,
    constraintLagrangianCertificateAttempted: lagrangianCertificate.attempted,
    constraintLagrangianCertificateApplied: false,
    constraintLagrangianCertificateRule: lagrangianCertificate.rule ?? null,
    constraintLagrangianCertificateEvaluations: lagrangianCertificate.evaluations ?? 0,
    constraintLagrangianUpperBoundGap: lagrangianCertificate.upperBoundGap ?? null,
    constraintPartitionedExactApplied: false,
    constraintPartitionedExactPlansEnumerated: 0,
    constraintPartitionedExactFrontierStates: 0,
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
 * - minutePlan: "historicalAware" (advanced capacity mode) or "openWhatIf" (default)
 * - historicalMinuteAnchors: optional regulation-game workload map by player id
 * - historicalTeamGames: optional team-game denominator for GP × MPG fallback
 * - minuteFlexibility: integer minutes a historical-aware plan may move per player
 * - historicalAllocationStyle: "preserveWorkload" or "strategyFirst" (default)
 * - projectedStatMinimums / projectedMaxTurnovers: optional constraints applied
 *   while choosing minutes. They use `projectedRates` when supplied, otherwise
 *   each player's raw source per-minute rate; these require
 *   positionMinuteRequirements so a complete role-feasible plan exists
 * - projectedRates: optional object/Map of conservative per-minute counting
 *   projections keyed by player id; this is how the full optimizer carries its
 *   small-sample and larger-role correction into threshold feasibility
 * - roleConditionedScorePlan: internal exact minute-value curve supplied by
 *   `optimizeLineups`; direct callers can omit it and retain linear scoring
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

  const scoreSource = options.scores ?? options.playerScores ?? options.weights;
  const projectedRates = normalizeProjectedRateMap(
    rotationPlayers,
    options.projectedRates,
    reasons,
    options.projectedProductionCurves,
  );
  const roleConditionedScorePlan = normalizeRoleConditionedScorePlan(
    rotationPlayers,
    options.roleConditionedScorePlan,
    reasons,
  );
  const rawStrategy = options.strategy ?? options.allocationStrategy ?? "balanced";
  const strategy = rawStrategy === "maximize-score" ? "objective" : rawStrategy;
  if (strategy !== "balanced" && strategy !== "objective") {
    reasons.push('Rotation strategy must be either "balanced" or "objective".');
  }
  const minutePlan = normalizeRotationMinutePlan(options.minutePlan, reasons);
  const historicalAllocationStyle = normalizeHistoricalAllocationStyle(
    options.historicalAllocationStyle,
    reasons,
  );
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
  let historicalTeamGames = null;
  if (options.historicalTeamGames !== undefined && options.historicalTeamGames !== null) {
    const parsedTeamGames = Number(options.historicalTeamGames);
    if (!Number.isFinite(parsedTeamGames) || parsedTeamGames <= 0) {
      reasons.push("historicalTeamGames must be a positive finite number when provided.");
    } else {
      historicalTeamGames = parsedTeamGames;
    }
  }
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
    bounds.set(id, rotationPlayerMinuteBounds(player, options, reasons));

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
    knownAnchorCount: 0,
    selectedPlayerCount: players.length,
    rawAnchorTotal: 0,
    coverageOf240: 0,
    sourceWorkloadScale: null,
    allocationStyleRequested: historicalAllocationStyle,
    allocationStyleApplied: minutePlan === ROTATION_MINUTE_PLANS.OPEN_WHAT_IF
      ? "hard-limits-only"
      : "unavailable",
    allocationStyleReason: minutePlan === ROTATION_MINUTE_PLANS.OPEN_WHAT_IF
      ? "Game-plan optimization uses the strategy-first objective inside the hard player limits."
      : null,
    reason: minutePlan === ROTATION_MINUTE_PLANS.OPEN_WHAT_IF
      ? "Game-plan optimization uses only the minute bounds you set."
      : null,
  };
  if (minutePlan === ROTATION_MINUTE_PLANS.HISTORICAL_AWARE) {
    const derived = deriveHistoricalGuidanceBounds(
      rotationPlayers,
      bounds,
      {
        historicalMinuteAnchors,
        historicalTeamGames,
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
    if (historicalGuidance.status === "missing-workload-evidence") {
      return rotationFailure([historicalGuidance.reason], {
        category: "historical-workload",
        subcategory: "missing-workload-evidence",
        selectedPlayers: players.length,
        historicalGuidance,
      });
    }
  }

  // A hard projected production rule changes the minute problem itself. The
  // constraint solver must start from the objective-maximizing plan in order to
  // prove feasibility, so surface that override instead of pretending it kept
  // an observed-workload allocation. Without such a rule, default historical
  // mode protects workload while the exact roster search still ranks groups by
  // the visitor's strategy score.
  if (minutePlan === ROTATION_MINUTE_PLANS.HISTORICAL_AWARE) {
    if (!historicalGuidance.applied) {
      historicalGuidance = {
        ...historicalGuidance,
        allocationStyleRequested: historicalAllocationStyle,
        allocationStyleApplied: "unavailable",
        allocationStyleReason: "Historical workload protection could not be applied because the selected group lacks complete source workload evidence.",
      };
    } else if (hasProjectedConstraints) {
      historicalGuidance = {
        ...historicalGuidance,
        allocationStyleRequested: historicalAllocationStyle,
        allocationStyleApplied: HISTORICAL_ALLOCATION_STYLES.STRATEGY_FIRST,
        allocationStyleReason: "A hard projected production rule requires a strategy-first minute search so the exact solver can prove a feasible 240-minute plan.",
      };
    } else {
      historicalGuidance = {
        ...historicalGuidance,
        allocationStyleRequested: historicalAllocationStyle,
        allocationStyleApplied: historicalAllocationStyle,
        allocationStyleReason: historicalAllocationStyle === HISTORICAL_ALLOCATION_STYLES.PRESERVE_WORKLOAD
          ? "The roster is ranked by your strategy, then its minutes stay as close as possible to the selected group's rescaled workload targets inside the observed-workload capacity caps."
          : "The roster is ranked by your strategy and its minutes shift toward the highest-fitting player profiles inside the observed-workload capacity caps.",
      };
    }
  }

  const minimumTotal = sortedIds.reduce((total, id) => total + effectiveBounds.get(id).min, 0);
  const maximumTotal = sortedIds.reduce((total, id) => total + effectiveBounds.get(id).max, 0);
  if (minimumTotal > 240 || maximumTotal < 240) {
    const failedHistoricalWorkload =
      minutePlan === ROTATION_MINUTE_PLANS.HISTORICAL_AWARE &&
      ["workload-capacity-infeasible", "workload-role-coverage-infeasible"].includes(
        historicalGuidance.status,
      );
    // Targets are constructed to include a 240-minute vector. Keep this
    // defensive diagnostic in case a future custom-bound policy changes that
    // invariant. For an observed-workload capacity failure, preserve the
    // concrete source-backed explanation instead of collapsing it into a
    // generic total-minutes error.
    return rotationFailure([
      failedHistoricalWorkload
        ? historicalGuidance.reason
        : "The active minute-plan guardrails cannot reach exactly 240 minutes.",
    ], {
      category: failedHistoricalWorkload ? "historical-workload" : "minute-plan-bounds",
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
  const historicalTargets = new Map(
    sortedIds
      .filter((id) => Number.isInteger(Number(historicalGuidance.targetsById[id])))
      .map((id) => [id, Number(historicalGuidance.targetsById[id])]),
  );
  const usesHistoricalContinuity =
    minutePlan === ROTATION_MINUTE_PLANS.HISTORICAL_AWARE &&
    historicalGuidance.applied &&
    historicalGuidance.allocationStyleApplied === HISTORICAL_ALLOCATION_STYLES.PRESERVE_WORKLOAD &&
    !hasProjectedConstraints &&
    historicalTargets.size === sortedIds.length;
  const usesStrategyFirstAllocation =
    hasProjectedConstraints ||
    (minutePlan === ROTATION_MINUTE_PLANS.HISTORICAL_AWARE &&
      historicalGuidance.applied &&
      historicalGuidance.allocationStyleApplied === HISTORICAL_ALLOCATION_STYLES.STRATEGY_FIRST);
  // The curve is a separable minute-value objective, so min-cost flow can solve
  // it exactly alongside the G/F/C role requirements. Optional production
  // rules now start from that same optimum and search the integer exchange
  // graph with its actual marginal values. The production *rates* remain the
  // conservative common-role estimates so those hard inequalities stay linear
  // and independently auditable.
  const usesRoleConditionedScoring = Boolean(
    roleConditionedScorePlan &&
      positionRequirements &&
      !usesHistoricalContinuity &&
      (strategy === "objective" || usesStrategyFirstAllocation),
  );
  if (positionRequirements) {
    // Historical continuity is an exact secondary objective: it minimizes the
    // total deviation from recorded workload after the roster itself has been
    // chosen. Every game-plan path—including hard production rules—starts from
    // the same exact diminishing-return objective when its plan is available.
    positionFlow = usesHistoricalContinuity
      ? historicalContinuityPositionAllocation(
        rotationPlayers,
        effectiveBounds,
        historicalTargets,
        positionRequirements,
        scores,
      )
      : usesRoleConditionedScoring
        ? roleConditionedPositionAllocation(
          rotationPlayers,
          effectiveBounds,
          positionRequirements,
          roleConditionedScorePlan,
        )
      : strategy === "objective" || usesStrategyFirstAllocation
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
        projectedRates,
        usesRoleConditionedScoring ? roleConditionedScorePlan : null,
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
          constraintFeasibleSeedFound: constrainedFlow.constraintFeasibleSeedFound,
          constraintFeasibleSeedRepairSteps:
            constrainedFlow.constraintFeasibleSeedRepairSteps,
          constraintFeasibleSeedSource:
            constrainedFlow.constraintFeasibleSeedSource ?? null,
          constraintLagrangianCertificateAttempted:
            constrainedFlow.constraintLagrangianCertificateAttempted,
          constraintLagrangianCertificateApplied:
            constrainedFlow.constraintLagrangianCertificateApplied,
          constraintLagrangianCertificateRule:
            constrainedFlow.constraintLagrangianCertificateRule,
          constraintLagrangianCertificateEvaluations:
            constrainedFlow.constraintLagrangianCertificateEvaluations,
          constraintLagrangianUpperBoundGap:
            constrainedFlow.constraintLagrangianUpperBoundGap,
          constraintPartitionedExactApplied:
            constrainedFlow.constraintPartitionedExactApplied,
          constraintPartitionedExactPlansEnumerated:
            constrainedFlow.constraintPartitionedExactPlansEnumerated,
          constraintPartitionedExactFrontierStates:
            constrainedFlow.constraintPartitionedExactFrontierStates,
          historicalGuidance,
        });
      }
      positionFlow = constrainedFlow;
    }
    balancedAdjusted = Boolean(positionFlow.adjusted);
    minutes = new Map(
      sortedIds.map((id) => [id, positionFlow.totalsByPlayer[id]]),
    );
  } else if (usesHistoricalContinuity) {
    // Without role requirements the rescaled targets already total exactly
    // 240. Copying them directly avoids an unnecessary score-based minute shift.
    minutes = new Map(sortedIds.map((id) => [id, historicalTargets.get(id)]));
  } else if (strategy === "objective" || usesStrategyFirstAllocation) {
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
  const roleConditionedScoring = {
    requested: Boolean(roleConditionedScorePlan),
    applied: Boolean(positionFlow?.roleConditionedScoringApplied),
    relaxedFastPathApplied: Boolean(positionFlow?.roleConditionedFastPathApplied),
    referenceMinutes: roleConditionedScorePlan?.referenceMinutes ?? null,
    objectiveMetrics: roleConditionedScorePlan?.objectiveMetrics ?? [],
    activeMetrics: roleConditionedScorePlan?.activeMetrics ?? [],
    roleExpansionApplied: Boolean(roleConditionedScorePlan?.roleExpansionChangesAnyScore),
    responsibilityPriorPlayers: roleConditionedScorePlan?.responsibilityPriorPlayers ?? 0,
    responsibilityPriorPlayerMetricCount: roleConditionedScorePlan?.responsibilityPriorPlayerMetricCount ?? 0,
    calibratedResponsibilityPlayers: roleConditionedScorePlan?.calibratedResponsibilityPlayers ?? 0,
    calibratedResponsibilityPlayerMetricCount: roleConditionedScorePlan?.calibratedResponsibilityPlayerMetricCount ?? 0,
    responsibilityExpansionSources: roleConditionedScorePlan?.responsibilityExpansionSources ?? {},
    concavityGuardedPlayerMinutes: roleConditionedScorePlan?.concavityGuardedPlayerMinutes ?? 0,
    workloadSaturation: roleConditionedScorePlan
      ? {
          applied: Boolean(positionFlow?.roleConditionedScoringApplied) && roleConditionedScorePlan.workloadSaturationMarginalFloor !== 1,
          startsAfterMinutes: roleConditionedScorePlan.workloadSaturationMarginalFloor === 1 ? null : roleConditionedScorePlan.referenceMinutes,
          transitionMinutes: roleConditionedScorePlan.workloadSaturationTransitionMinutes,
          marginalFloor: roleConditionedScorePlan.workloadSaturationMarginalFloor,
          minutesBeyondReference: round(allocations.reduce(
            (total, allocation) => total + Math.max(
              0,
              allocation.minutes - roleConditionedScorePlan.referenceMinutes,
            ),
            0,
          )),
          playersBeyondReference: allocations.filter(
            (allocation) => allocation.minutes > roleConditionedScorePlan.referenceMinutes,
          ).length,
          sourceMinutesAffectCurve: false,
        }
      : {
          applied: false,
          startsAfterMinutes: null,
          transitionMinutes: null,
          marginalFloor: null,
          minutesBeyondReference: 0,
          playersBeyondReference: 0,
          sourceMinutesAffectCurve: false,
        },
    expandedMinutes: roleConditionedScorePlan?.roleExpansionChangesAnyScore
      ? round(allocations.reduce(
        (total, allocation) =>
          total + roleConditionedMinuteSplit(
            allocation.id,
            allocation.minutes,
            roleConditionedScorePlan,
          ).expanded,
        0,
      ))
      : 0,
    selectedPlayersWithExpandedMinutes: roleConditionedScorePlan?.roleExpansionChangesAnyScore
      ? allocations.filter((allocation) => (
        roleConditionedMinuteSplit(
          allocation.id,
          allocation.minutes,
          roleConditionedScorePlan,
        ).expanded > 1e-12
      )).length
      : 0,
    reason: !roleConditionedScorePlan
      ? "No assigned-role score projection was supplied."
      : hasProjectedConstraints
        ? positionFlow?.roleConditionedScoringReason ??
          "Hard production rules use conservative workload-bound stat rates for feasibility while the minute allocation retains its exact objective."
        : usesHistoricalContinuity
          ? "Recorded-minutes continuity was selected as the allocation objective."
          : !positionRequirements
            ? "Assigned-role scoring requires an exact G/F/C minute profile."
            : positionFlow?.roleConditionedScoringReason ??
              "Additional minutes use the selected workload response, not a roster-average minute target. This projection is neither a minute cap nor a reconstruction of the coach's rotation.",
  };

  return {
    ok: true,
    status: "success",
    strategy: hasProjectedConstraints
      ? "objective-constrained"
      : usesHistoricalContinuity
        ? balancedAdjusted
          ? "historical-workload-continuity-adjusted-for-positions"
          : "historical-workload-continuity"
        : usesRoleConditionedScoring && roleConditionedScoring.applied
          ? "objective-role-conditioned"
          : strategy === "objective" || usesStrategyFirstAllocation
            ? "objective-maximizing"
          : balancedAdjusted
            ? "balanced-proportional-adjusted-for-positions"
            : "balanced-proportional",
    totalMinutes,
    allocations,
    byId: Object.fromEntries(allocations.map((allocation) => [allocation.id, allocation.minutes])),
    minutePlan,
      historicalGuidance,
      roleConditionedScoring,
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
      historicalAllocationStyle: historicalGuidance.allocationStyleApplied,
      balancedAdjustedForPositions: balancedAdjusted,
        minutePlan,
        historicalGuidance,
        roleConditionedScoring,
      projectedConstraints: {
        statMinimums: { ...projectedConstraints.statMinimums },
        maxTurnovers: Number.isFinite(projectedConstraints.maxTurnovers)
          ? projectedConstraints.maxTurnovers
          : null,
        projectedRatesApplied: Boolean(projectedRates && projectedRates.size > 0),
        adjustedAllocation: Boolean(positionFlow?.constraintsAdjusted),
        searchStates: positionFlow?.constraintSearchStates ?? 0,
        feasibleSeedFound: Boolean(positionFlow?.constraintFeasibleSeedFound),
        feasibleSeedRepairSteps: positionFlow?.constraintFeasibleSeedRepairSteps ?? 0,
        feasibleSeedSource: positionFlow?.constraintFeasibleSeedSource ?? null,
        feasibleSeedUsed: Boolean(positionFlow?.constraintFeasibleSeedUsed),
        lagrangianCertificateAttempted: Boolean(
          positionFlow?.constraintLagrangianCertificateAttempted,
        ),
        lagrangianCertificateApplied: Boolean(
          positionFlow?.constraintLagrangianCertificateApplied,
        ),
        lagrangianCertificateRule:
          positionFlow?.constraintLagrangianCertificateRule ?? null,
        lagrangianCertificateEvaluations:
          positionFlow?.constraintLagrangianCertificateEvaluations ?? 0,
        lagrangianUpperBoundGap:
          positionFlow?.constraintLagrangianUpperBoundGap ?? null,
        partitionedExactApplied: Boolean(
          positionFlow?.constraintPartitionedExactApplied,
        ),
        partitionedExactPlansEnumerated:
          positionFlow?.constraintPartitionedExactPlansEnumerated ?? 0,
        partitionedExactFrontierStates:
          positionFlow?.constraintPartitionedExactFrontierStates ?? 0,
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
  const lockedTotal = lockedPlayers.reduce((total, player) => total + observedLineupStat(player, field), 0);
  const values = availablePlayers
    .map((player) => observedLineupStat(player, field))
    .sort((left, right) => (descending ? right - left : left - right));
  return lockedTotal + values.slice(0, slots).reduce((total, value) => total + value, 0);
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
 *
 * `runtime.onProgress`, when supplied, is presentation-only telemetry for a
 * long-running rotation search. It receives checked-candidate counts but can
 * never alter selection, allocation, ranking, or the returned result.
 */
export function optimizeLineups(players, config = {}, runtime = {}) {
  const onProgress = typeof runtime?.onProgress === "function"
    ? runtime.onProgress
    : null;
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
  const selectionOnlyExcludedSet = new Set(normalizedConfig.selectionOnlyExcludedIds);
  const setupReasons = [];

  for (const id of normalizedConfig.lockedIds) {
    if (!playerById.has(id)) setupReasons.push(`Locked player \"${id}\" is not in the player pool.`);
    if (excludedSet.has(id)) setupReasons.push(`Player \"${id}\" cannot be both locked and excluded.`);
    if (selectionOnlyExcludedSet.has(id)) setupReasons.push(`Player "${id}" cannot be locked and removed by a replacement request.`);
  }
  for (const id of selectionOnlyExcludedSet) {
    if (!playerById.has(id)) setupReasons.push(`Replacement exclusion names unknown player "${id}".`);
  }
  for (const id of Object.keys(normalizedConfig.offensiveResponsibilities)) {
    if (!playerById.has(id)) setupReasons.push(`Offensive responsibility names unknown player "${id}". Load that player or remove this scenario input.`);
  }
  if (normalizedConfig.lockedIds.length > normalizedConfig.size) {
    setupReasons.push(
      `${normalizedConfig.lockedIds.length} locked players cannot fit in a lineup of ${normalizedConfig.size}.`,
    );
  }

  const eligibilityRejected = [];
  let eligiblePlayers = normalizedPlayers.filter((player) => {
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
  // Data eligibility is established BEFORE ranking, position feasibility, and
  // combination counting. An unsupported optional player must not veto an
  // otherwise valid search or change its metric normalization. This is a
  // per-run filter, not a persisted user exclusion or an invented neutral RAPM.
  // A failed package/scope/calibration gate is fundamentally different from a
  // missing player row: removing players cannot repair an unvalidated model.
  const impactEligibility = buildScoutImpactModel(eligiblePlayers, normalizedConfig.scoutEvidence,
    { mode: normalizedConfig.modelMode, expectedScope: normalizedConfig.sourceScope });
  if (normalizedConfig.modelMode !== "historical" && !impactEligibility.calibrationAvailable) {
    return failureResult(mode, size, [...setupReasons, impactEligibility.reason], {
      category: "data", subcategory: "scout-evidence", inputPlayers: normalizedPlayers.length,
      eligiblePlayers: eligiblePlayers.length, eligibilityRejected,
    });
  }
  const missingImpactIds = new Set(impactEligibility.missingPlayerIds);
  const dataEligibility = { candidateCount: eligiblePlayers.length, eligibleCount: 0,
    excludedPlayers: [], lockedPlayerIds: [], policy: "exclude-unsupported-preserve-hard-rules" };
  eligiblePlayers = eligiblePlayers.filter(player => {
    const reasons = [];
    if (missingImpactIds.has(player.id)) reasons.push("Required advanced offense/defense impact data is unavailable or does not meet the package's evidence checks.");
    if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) {
      const evidence = player.analytics.scoutPlayerGameEvidence;
      if (evidence?.version !== SCOUT_GAME_EVIDENCE_VERSION || evidence.scope?.playerId !== player.id
        || (normalizedConfig.sourceScope?.seasonEndYear != null
          && evidence.scope?.seasonStartYear + 1 !== normalizedConfig.sourceScope.seasonEndYear)
        || ((normalizedConfig.sourceScope?.seasonPhase ?? normalizedConfig.sourceScope?.phase) != null
          && evidence.scope?.phase !== (normalizedConfig.sourceScope.seasonPhase ?? normalizedConfig.sourceScope.phase))) {
        reasons.push("Scout player-game evidence does not match the requested player, season, or phase.");
      } else {
        // Do not accept a hard floor/ceiling through NaN comparisons or stale
        // display rates. Only players with evidence for THAT requested rule
        // are candidates. An optional missing context field is not a rejection.
        const requiredFields = [...Object.keys(normalizedConfig.statMinimums),
          ...(Number.isFinite(normalizedConfig.maxTurnovers) ? ["turnovers"] : [])];
        for (const field of requiredFields) if (!pairedMetricEvidence(player, field === "turnovers" ? "ballSecurity" : field)) {
          reasons.push(`verified Scout ${field} evidence is unavailable for the requested production constraint.`);
        }
      }
    }
    if (!reasons.length) return true;
    dataEligibility.excludedPlayers.push({ id: player.id, name: player.name, reasons });
    eligibilityRejected.push({ id: player.id, name: player.name, reasons, category: "data" });
    if (lockedSet.has(player.id)) {
      // An explicit lock is a hard user requirement. Never quietly unlock a
      // player to make a successful result; explain the conflicting request.
      dataEligibility.lockedPlayerIds.push(player.id);
      setupReasons.push(`Locked player "${player.name}" lacks required data. Unlock this player or use a model/rules with available evidence. ${reasons.join(" ")}`);
    }
    return false;
  });
  dataEligibility.eligibleCount = eligiblePlayers.length;
  // Snapshot the evidence universe BEFORE the one-change selection filter.
  // The replacement must solve a subset of the original feasible choices,
  // using the original objective, including its missing-metric policy.
  const objectivePlayers = eligiblePlayers.slice();
  eligiblePlayers = eligiblePlayers.filter(player => !selectionOnlyExcludedSet.has(player.id));
  const eligibleById = new Map(eligiblePlayers.map((player) => [player.id, player]));

  for (const id of normalizedConfig.lockedIds) {
    if (playerById.has(id) && !eligibleById.has(id) && !excludedSet.has(id)
      && !dataEligibility.lockedPlayerIds.includes(id)) {
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
      `Only ${eligiblePlayers.length} eligible players remain for ${normalizedConfig.size} roster spots.${dataEligibility.excludedPlayers.length ? ` ${dataEligibility.excludedPlayers.length} player(s) were automatically left out because required data was unavailable. Reduce the roster size or change the model/rules; no roster or position requirement was relaxed.` : ""}`,
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
      dataEligibility,
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
      if (maximum + ROTATION_CONSTRAINT_TOLERANCE < required) {
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
      if (minimum - ROTATION_CONSTRAINT_TOLERANCE > normalizedConfig.maxTurnovers) {
        preflightReasons.push(
          `The lowest possible turnover total is ${minimum}, above the maximum ${normalizedConfig.maxTurnovers}.`,
        );
      }
    }
  }

  const estimatedCombinations = chooseCount(availablePlayers.length, slotsToChoose);
  const hasScoutGameEvidence = objectivePlayers.some(player => Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence"));
  const projectionParameters = Object.freeze({
    // Matching the calendar year alone does not validate an older fitted
    // workload response for newly reconciled, potentially partial Scout game
    // subsets. Until a source-bound refit exists, retain disclosed priors and
    // decision sensitivity, without advertising the old holdout as new proof.
    ...projectionParametersFor(normalizedConfig.projectionRisk, hasScoutGameEvidence ? null : normalizedConfig.sourceScope),
    offensiveResponsibilities: normalizedConfig.offensiveResponsibilities,
  });
  const baseDiagnostics = {
    modelIdentity: {
      constraintLayer: "exact-constraint-optimizer-v1",
      evidenceLayer: HISTORICAL_RATE_MODEL_VERSION,
      scoutImpactLayer: normalizedConfig.modelMode === "historical"
        ? "separate-not-active"
        : "scout-impact-v4-multiseason-evidence",
      // Possession-level RAPM and lineup synergy have different units,
      // uncertainty, and interaction terms from the box-score benchmark. Explicitly
      // reserve a separate layer so a later Scout model cannot silently alter
      // this result while still being labelled as the historical-rate model.
      scoutSeparationReason:
        "Scout RAPM is a separately versioned, reliability-shrunk input to player-minute selection. Fit vs. NBA Baseline remains a box-score comparison index and is never relabeled as Scout impact.",
    },
    inputPlayers: normalizedPlayers.length,
    workloadCalibrationReason: hasScoutGameEvidence
      ? "New Scout player-game subsets use disclosed working priors and uncertainty. An older same-year workload fit is not validated for this evidence revision."
      : null,
    workloadCalibration: projectionParameters.calibration ? {
      version: projectionParameters.calibration.version,
      scope: "2025–26 regular season only",
      testGames: projectionParameters.calibration.split.testGames,
      limitation: "Conditional rate backtest, not validation of an unseen lineup or a causal workload effect.",
    } : null,
    eligiblePlayers: eligiblePlayers.length,
    lockedPlayers: lockedPlayers.length,
    availablePlayers: availablePlayers.length,
    eligibilityRejected,
    dataEligibility,
    selectionOnlyExcludedIds: [...selectionOnlyExcludedSet],
    objectiveReferencePlayerCount: objectivePlayers.length,
    estimatedCombinations,
    maxCombinations: normalizedConfig.maxCombinations,
    candidateCombinationLimitApplied: normalizedConfig.mode !== "rotation",
    requestedAlternatives: normalizedConfig.alternatives,
    // Allocation-only settings remain absent from the equal-player build.
    // Its shared rate evidence is reported separately below.
    ...(normalizedConfig.mode === "rotation"
      ? {
          rotationScoringBasis: normalizedConfig.rotationScoringBasis,
          rotationMinutePlan: normalizedConfig.rotationMinutePlan,
          rotationHistoricalAllocationStyle: normalizedConfig.rotationHistoricalAllocationStyle,
          rotationMinuteFlexibility: normalizedConfig.rotationMinuteFlexibility,
          rotationRateStability: normalizedConfig.rotationRateStability,
          projectionRisk: normalizedConfig.projectionRisk,
          roleBalance: normalizedConfig.roleBalance,
          modelMode: normalizedConfig.modelMode,
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

  if (
    normalizedConfig.mode !== "rotation" &&
    estimatedCombinations > normalizedConfig.maxCombinations
  ) {
    return failureResult(mode, size, [
      `The exact solver would evaluate ${estimatedCombinations.toLocaleString()} combinations, above this page's ${normalizedConfig.maxCombinations.toLocaleString()} safe limit. Increase the minimum games or minutes filter, lock players, exclude players, or choose a smaller group.`,
    ], {
      ...baseDiagnostics,
      category: "performance",
    });
  }

  // Both recommended builds compare the same evidence-adjusted per-36 skill
  // profiles. Starting five gives each player equal objective exposure; it
  // does not silently revert to raw percentages. An explicitly requested raw
  // or perGame basis remains available for compatibility experiments.
  const normalizedMetricResult = buildNormalizedMetrics(objectivePlayers, {
    scoringBasis: normalizedConfig.rotationScoringBasis,
    rateStability: normalizedConfig.rotationRateStability,
    // Per-36 is a comparison unit, not a prescribed role. Stabilize at observed
    // season-wide MPG once; the allocation plan evaluates expanded workloads
    // at the actual assigned minutes. Never project twice at 240 / roster size.
    roleMinutesTarget:
      normalizedConfig.mode === "rotation"
        ? 36
        : null,
    projectionParameters,
  });
  const normalizedMetrics = normalizedMetricResult.metrics;
  const effectiveObjective = buildEffectiveObjectiveWeights(
    normalizedConfig.weights,
    normalizedMetricResult.availableMetrics,
  );
  baseDiagnostics.objectiveMetricEvidence = {
    availableMetrics: [...normalizedMetricResult.availableMetrics],
    unavailableMetrics: [...normalizedMetricResult.unavailableMetrics],
    disabledRequestedMetrics: [...effectiveObjective.disabledRequestedMetrics],
    renormalized: effectiveObjective.renormalized,
    // This explicit flag supports both the result explanation and regression
    // tests for the product rule requested by the user.
    teamStintLengthAffectsProjection: false,
    reason: effectiveObjective.disabledRequestedMetrics.length > 0
      ? `Disabled incomplete source metric${effectiveObjective.disabledRequestedMetrics.length === 1 ? "" : "s"} for every eligible player and redistributed the remaining priorities proportionally.`
      : "Every requested objective metric had complete source evidence for the eligible pool.",
  };
  // Historical priority availability must not veto an independently complete
  // Scout objective. Missing box-score context stays unavailable, not guessed.
  if (!(effectiveObjective.total > 0) && normalizedConfig.modelMode !== "scout") {
    const incompletePriorities = effectiveObjective.disabledRequestedMetrics.join(", ");
    return failureResult(mode, size, [
      `The selected priorities lack complete same-scope evidence for every eligible player (${incompletePriorities}). Choose another available priority or load a source with matching evidence for the full pool.`,
    ], {
      ...baseDiagnostics,
      category: "data",
      subcategory: "objective-evidence",
    });
  }
  let rotationProjectedRates = normalizedConfig.mode === "rotation"
    ? normalizedMetricResult.projectedRatesByPlayerId
    : null;
  baseDiagnostics.objectiveScoringBasis = normalizedConfig.rotationScoringBasis;
  baseDiagnostics.objectiveRateEvidence = normalizedMetricResult.rateStability;
  if (normalizedConfig.mode === "rotation") {
    // This small summary makes a result auditable without exposing every raw
    // row value in the solver payload. Individual player rates remain visible
    // in the UI; this only tells the fan whether the evidence guardrail was
    // actually available for the current source.
    baseDiagnostics.rotationRateStabilityEvidence = normalizedMetricResult.rateStability;
  }
  // Keep the historical game-plan score separate so the Scout layer can report
  // its exact minute-level delta instead of hiding it inside a composite value.
  const basePlayerStrategyScores = new Map(
    objectivePlayers.map((player) => [
      player.id,
      OBJECTIVE_METRICS.reduce(
        (total, metric) =>
          total + normalizedMetrics.get(player.id)[metric] * effectiveObjective.normalizedWeights[metric],
        0,
      ),
    ]),
  );
  const lineupRoleModel = buildLineupRoleModel(objectivePlayers, { normalizedMetrics });
  const scoutImpactModel = buildScoutImpactModel(
    objectivePlayers,
    normalizedConfig.scoutEvidence,
    { mode: normalizedConfig.modelMode, expectedScope: normalizedConfig.sourceScope },
  );
  const scoutFamilyWeights = scoutFamilyWeightsFrom(
    effectiveObjective.normalizedWeights,
  );
  const scoutMinuteObjective = buildScoutMinuteObjective(
    objectivePlayers,
    scoutImpactModel,
    basePlayerStrategyScores,
    {
      offenseWeight: normalizedConfig.modelMode === "scout" ? normalizedConfig.scoutObjectiveWeights.offense : scoutFamilyWeights.offense,
      defenseWeight: normalizedConfig.modelMode === "scout" ? normalizedConfig.scoutObjectiveWeights.defense : scoutFamilyWeights.defense,
    },
  );
  // This is the actual player-minute objective passed to the exact allocator.
  // In historical mode it is an unchanged copy of the user-game-plan score.
  const playerStrategyScores = scoutMinuteObjective.scoresById;
  // The report uses the exact same weights as allocation. Raw net impact stays
  // available as context, but must not masquerade as a custom weighted goal.
  scoutImpactModel.objectiveWeights = { offense: scoutMinuteObjective.offenseWeight, defense: scoutMinuteObjective.defenseWeight };
  baseDiagnostics.compositionModel = {
    version: lineupRoleModel.version,
    requestedBalance: normalizedConfig.roleBalance,
    balance: normalizedConfig.modelMode === "scout" || normalizedConfig.mode === "rotation"
      ? "off" : normalizedConfig.roleBalance,
    evidenceBasis: lineupRoleModel.evidenceBasis,
    eligiblePlayerCount: lineupRoleModel.eligiblePlayerCount,
    hardConstraint: false,
  };
  baseDiagnostics.scoutImpactModel = {
    version: scoutImpactModel.version,
    mode: scoutImpactModel.mode,
    available: scoutImpactModel.available,
    applied: scoutImpactModel.applied,
    missingPlayerIds: [...scoutImpactModel.missingPlayerIds],
    minuteObjective: {
      applied: scoutMinuteObjective.applied,
      blend: scoutMinuteObjective.blend,
      offenseWeight: scoutMinuteObjective.offenseWeight,
      defenseWeight: scoutMinuteObjective.defenseWeight,
      reason: scoutMinuteObjective.reason,
    },
    reason: scoutImpactModel.reason,
    calibration: scoutImpactModel.calibration,
    scope: scoutImpactModel.scope,
    objective: normalizedConfig.scoutObjectiveWeights.custom ? "custom" : normalizedConfig.scoutObjective,
    objectiveWeights: { ...scoutImpactModel.objectiveWeights },
  };
  if (normalizedConfig.modelMode !== "historical" && !scoutImpactModel.available) {
    const missingNames = eligiblePlayers
      .filter((player) => scoutImpactModel.missingPlayerIds.includes(player.id))
      .map((player) => player.name);
    return failureResult(mode, size, [
      `Scout could not validate the remaining player pool.${missingNames.length ? ` Missing: ${missingNames.join(", ")}.` : " Check the package season, phase, and validation status."} Missing evidence is never treated as average.`,
    ], {
      ...baseDiagnostics,
      category: "data",
      subcategory: "scout-evidence",
    });
  }

  const rotationRankingModel = normalizedConfig.mode === "rotation"
    ? buildRotationHistoricalReadiness(
      eligiblePlayers,
      {
        ...normalizedConfig.rotationOptions,
        minutePlan: normalizedConfig.rotationMinutePlan,
      },
    )
    : {
        applied: false,
        readinessById: new Map(),
        strategyShare: 1,
        historicalReadinessShare: 0,
        knownPlayerCount: 0,
        eligiblePlayerCount: eligiblePlayers.length,
        unavailablePlayerIds: [],
        reason: "Historical readiness does not alter five-player lineup mode.",
        reasons: [],
      };
  if (rotationRankingModel.reasons.length > 0) {
    return failureResult(mode, size, rotationRankingModel.reasons, {
      ...baseDiagnostics,
      category: "validation",
      subcategory: "historical-readiness",
    });
  }
  if (normalizedConfig.mode === "rotation") {
    baseDiagnostics.rotationHistoricalReadiness = {
      applied: rotationRankingModel.applied,
      strategyShare: rotationRankingModel.strategyShare,
      historicalReadinessShare: rotationRankingModel.historicalReadinessShare,
      knownPlayerCount: rotationRankingModel.knownPlayerCount,
      eligiblePlayerCount: rotationRankingModel.eligiblePlayerCount,
      unavailablePlayerIds: [...rotationRankingModel.unavailablePlayerIds],
      anchorsById: { ...rotationRankingModel.anchorsById },
      reason: rotationRankingModel.reason,
    };
  }
  // The displayed rotation score is minute-weighted game-plan fit only.
  // Recorded workload remains visible context and, in explicitly selected
  // historical-aware mode, an observed-workload capacity guardrail. It never
  // receives hidden objective weight that could overrule the visitor's plan.
  const callerRotationScores =
    normalizedConfig.rotationOptions.scores ??
    normalizedConfig.rotationOptions.playerScores ??
    normalizedConfig.rotationOptions.weights;
  const hasRotationProjectedConstraints =
    normalizedConfig.mode === "rotation" &&
    (Object.keys(normalizedConfig.statMinimums).length > 0 ||
      Number.isFinite(normalizedConfig.maxTurnovers));
  const roleConditionedProjectionPlan =
    normalizedConfig.mode === "rotation" && normalizedConfig.modelMode !== "scout" && !callerRotationScores
      ? buildRoleConditionedProjectionPlan(
        objectivePlayers,
        normalizedMetrics,
        effectiveObjective.normalizedWeights,
        normalizedMetricResult,
        projectionParameters,
        scoutMinuteObjective,
      )
      : null;
  // Carry a complete table of production at 0..48 minutes into the exact
  // frontier. Evaluating the same curve at the assigned minute avoids both
  // optimistic raw-rate feasibility and pessimistic worst-allowed-rate rejects.
  const constraintProjectionPlan = roleConditionedProjectionPlan ?? (
    hasRotationProjectedConstraints && normalizedConfig.modelMode === "scout"
      ? buildRoleConditionedProjectionPlan(objectivePlayers, normalizedMetrics,
        effectiveObjective.normalizedWeights, normalizedMetricResult, projectionParameters)
      : null
  );
  // Keep the objective reference in the result for replacement comparisons.
  // Selection-only exclusions preserve this reference across both solves.
  // The UI checks equality before reporting a total objective difference. The
  // optional minute curves are cumulative utility units (0..48), not predicted
  // points; they are included only when the exact role-conditioned plan built
  // them. No raw private Scout row is copied into this diagnostic contract.
  const objectiveReference = {
    version: "counterfactual-objective-v2",
    mode: normalizedConfig.modelMode,
    modelVersion: HISTORICAL_RATE_MODEL_VERSION,
    scoutModelVersion: scoutImpactModel.version,
    sourceScope: normalizedConfig.sourceScope,
    projectionRisk: normalizedConfig.projectionRisk,
    scoringBasis: normalizedConfig.rotationScoringBasis,
    roleBalance: normalizedConfig.roleBalance,
    scoutWeights: { ...scoutImpactModel.objectiveWeights },
    basis: normalizedConfig.modelMode === "scout"
      ? "scout-objective-fixed-original-pool"
      : "game-plan-objective-fixed-original-pool",
    poolSize: objectivePlayers.length,
    lineupSize: normalizedConfig.size,
    totalRotationMinutes: normalizedConfig.mode === "rotation" ? 240 : null,
    effectiveWeights: { ...effectiveObjective.normalizedWeights },
    scoresById: Object.fromEntries(objectivePlayers.slice().sort(comparePlayersById).map((player) => [
      player.id,
      playerStrategyScores.get(player.id),
    ])),
    roleConditionedCurvesById: roleConditionedProjectionPlan?.calibratedUtilityCurvesById
      ? Object.fromEntries([...roleConditionedProjectionPlan.calibratedUtilityCurvesById.entries()].sort(([a], [b]) => compareIds(a, b)).map(([id, curve]) => [
        id,
        curve.slice(),
      ]))
      : null,
  };
  baseDiagnostics.objectiveReference = objectiveReference;
  if (constraintProjectionPlan && hasRotationProjectedConstraints) {
    const boundReasons = [];
    const allowedBounds = new Map(eligiblePlayers.map(player => [player.id,
      rotationPlayerMinuteBounds(player, normalizedConfig.rotationOptions, boundReasons)]));
    if (boundReasons.length) return failureResult(mode, size, boundReasons, {
      ...baseDiagnostics, category: "validation", subcategory: "minute-bounds",
    });
    rotationProjectedRates = new Map(rotationProjectedRates);
    if (constraintProjectionPlan.calibratedProductionCurvesById.size) {
      rotationProjectedRates.productionCurvesById = constraintProjectionPlan.calibratedProductionCurvesById;
    }
    baseDiagnostics.productionConstraintProjection = {
      kind: "exact-assigned-workload-curve",
      minimumMinutes: Math.min(...[...allowedBounds.values()].map(bound => bound.min)),
      maximumMinutes: Math.max(...[...allowedBounds.values()].map(bound => bound.max)),
      minuteBoundsById: Object.fromEntries(allowedBounds),
      boundScope: "per-player-user-allowed-minutes",
      expectedProduction: false,
      reason: "Production limits and reported planning totals evaluate the same evidence-adjusted curve at each player's actual assigned minutes. Risk reserves are planning assumptions, not calibrated forecasts. Nonlinear feasibility is checked exactly; no fixed worst-case rate replaces the curve.",
    };
  }
  const usesRoleConditionedObjective = Boolean(roleConditionedProjectionPlan);
  const usesRoleConditionedProductionProjection = Boolean(
    constraintProjectionPlan?.calibratedProductionCurvesById?.size,
  );
  const assignedRoleProjectionReason = callerRotationScores
    ? "A custom minute-score map was supplied, so the optimizer retained that caller-defined allocation objective."
    : !roleConditionedProjectionPlan
      ? "The loaded evidence did not support a minute-aware same-season baseline for an active game-plan priority."
      : hasRotationProjectedConstraints
        ? "The exact objective and hard production rules use the same assigned-workload projection. A concave objective minorant keeps the allocation proof valid; stat totals are evaluated directly, without that numerical approximation."
      : "The exact minute allocation accounts for uncertain role expansion. A chronological fit is used where available; otherwise the selected risk setting supplies a disclosed prior sensitivity. No penalty begins at 240 divided by roster size, and observed minutes are not an availability cap.";
  if (normalizedConfig.mode === "rotation") {
    baseDiagnostics.rotationRateStabilityEvidence = {
      ...normalizedMetricResult.rateStability,
      assignedRoleProjection: {
        requested: Boolean(roleConditionedProjectionPlan),
        enabledForExactSearch: usesRoleConditionedObjective,
        productionProjectionEnabled: usesRoleConditionedProductionProjection,
        referenceMinutes: roleConditionedProjectionPlan?.referenceMinutes ?? null,
        activeMetrics: roleConditionedProjectionPlan?.activeMetrics ?? [],
        maximumExactCombinations: null,
        candidateCombinationLimitApplied: false,
        reason: assignedRoleProjectionReason,
      },
    };
  }

  /**
   * Return the exact Scout delta represented by a completed minute plan.
   *
   * The regular score is the visitor's historical/box-score objective. The
   * Scout player signal is a bounded blend of that score and a complete,
   * reliability-shrunk RAPM percentile. When the role-conditioned allocator is
   * active, calculate the difference from the same marginal curve rather than
   * multiplying a static value by minutes. That makes the reported delta
   * reconcile to the objective that actually assigned the minutes.
   */
  function scoutMinuteScoreUnitsFor(selectedPlayers, rotation = null) {
    if (!scoutMinuteObjective.applied) return null;
    const minutesById = rotation?.byId || Object.fromEntries(
      selectedPlayers.map((player) => [player.id, 48]),
    );
    const usesRoleConditionedScout = Boolean(
      rotation?.diagnostics?.roleConditionedScoring?.applied &&
      roleConditionedProjectionPlan,
    );
    const unitsById = {};
    for (const player of selectedPlayers) {
      const assignedMinutes = Math.max(0, Number(minutesById[player.id]) || 0);
      if (!(assignedMinutes > 0)) {
        unitsById[player.id] = 0;
        continue;
      }
      if (usesRoleConditionedScout) {
        const blendedUnits = roleConditionedScoreUnits(
          player.id,
          assignedMinutes,
          roleConditionedProjectionPlan,
        );
        const historicalUnits = OBJECTIVE_METRICS.reduce(
          (total, metric) => total + (
            roleConditionedMetricScoreUnits(
              player,
              metric,
              assignedMinutes,
              normalizedMetrics,
              roleConditionedProjectionPlan,
            ) * effectiveObjective.normalizedWeights[metric]
          ),
          0,
        );
        unitsById[player.id] = Number.isFinite(blendedUnits)
          ? blendedUnits - historicalUnits
          : 0;
      } else {
        const blendedScore = Number(playerStrategyScores.get(player.id));
        const historicalScore = Number(basePlayerStrategyScores.get(player.id));
        unitsById[player.id] = Number.isFinite(blendedScore) && Number.isFinite(historicalScore)
          ? (blendedScore - historicalScore) * assignedMinutes
          : 0;
      }
    }
    return unitsById;
  }

  /**
   * Only non-separable combination context stays here. Player Scout RAPM is
   * already inside `playerStrategyScores` and the role-conditioned minute
   * curve above. A verified exact-five residual remains separate because it
   * cannot be honestly assigned to one player or to an eight-to-twelve-player
   * rotation roster.
   */
  function candidateModelAdjustments(selectedPlayers, rotation = null, { upperBound = false } = {}) {
    const roleFit = scoreLineupRoleFit(selectedPlayers, lineupRoleModel, {
      objectiveWeights: effectiveObjective.normalizedWeights,
      // A heuristic role bonus in fit-index units cannot be added to an O/D
      // impact objective. Keep role coverage explanatory in primary Scout mode.
      // A roster-only bonus is constant while minutes are solved, yet can
      // reward players assigned zero court time when candidates are compared.
      // It is not a jointly optimized court-coverage objective. Keep rotation
      // coverage explanatory until that nonseparable objective is implemented.
      balance: normalizedConfig.modelMode === "scout" || normalizedConfig.mode === "rotation"
        ? "off" : normalizedConfig.roleBalance,
    });
    if (normalizedConfig.mode === "rotation") {
      roleFit.requestedBalance = normalizedConfig.roleBalance;
      roleFit.reason = "Rotation role coverage is descriptive: roster membership alone earns no bonus without a jointly optimized court-time coverage objective.";
    }
    const minutesById = rotation?.byId || Object.fromEntries(
      selectedPlayers.map((player) => [player.id, 48]),
    );
    const scoutImpact = scoreScoutCandidate(selectedPlayers, scoutImpactModel, {
      minutesById,
      minuteScoreUnitsById: scoutMinuteScoreUnitsFor(selectedPlayers, rotation),
    });
    const usageDemand = projectRotationUsageDemand(
      selectedPlayers,
      minutesById,
      projectionParameters,
    );
    return {
      totalAdjustmentPoints:
        (Number(roleFit.adjustmentPoints) || 0) +
        // Minute-level Scout value is already inside the exact allocation and
        // score. Only an eligible exact-five interaction residual belongs here.
        (Number(scoutImpact.exactLineupAdjustmentPoints) || 0),
      roleFit,
      usageDemand: {
        ...usageDemand,
        scoringAdjustmentPoints: 0,
        explanationOnly: true,
      },
      scoutImpact,
      projectionRisk: normalizedConfig.projectionRisk,
      upperBound,
    };
  }
  // Production-threshold proofs retain a bounded state search *inside each
  // individual candidate*. The allowance is intentionally recreated per
  // roster: the number of candidate rotations can never exhaust a shared
  // solve-wide budget or become a hidden candidate-count cap.
  const perCandidateConstraintSearchLimit = Math.min(
    normalizedConfig.maxConstraintSearchStates,
    MAX_CONSTRAINED_ALLOCATION_STATES,
  );
  let constraintSearchStatesUsed = 0;
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
      selectedPlayers.map((player) => [player.id, playerStrategyScores.get(player.id)]),
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
    const candidateConstraintSearchBudget = includeProjectedConstraints
      ? { limit: perCandidateConstraintSearchLimit, used: 0 }
      : null;
    const rotation = allocateRotationMinutes(selectedPlayers, {
      ...normalizedConfig.rotationOptions,
      // The normal allocation honors an explicit caller workload objective.
      // When that differs from the model's ranking objective, pass 1 requests
      // one additional exact allocation with `rankingUpperBound` so pruning is
      // still bounded by the same raw score used to order final alternatives.
      scores:
        rankingUpperBound
          ? rotationScoresFor(selectedPlayers)
          : callerRotationScores ?? rotationScoresFor(selectedPlayers),
      // Carry the same conservative rate projection into the minute-constraint
      // solver. This does not cap a low-minute player; it simply avoids
      // extrapolating an unproven raw rate unchanged into a starter-sized role.
      projectedRates: rotationProjectedRates,
      projectedProductionCurves: rotationProjectedRates?.productionCurvesById,
      // Optional production requirements evaluate the exact same assigned-
      // minute tables as reporting, not a separate fixed-role approximation.
      // Concave decision utility and production totals are distinct tables;
      // the latter may require the nonlinear constrained-search proof.
      roleConditionedScorePlan: usesRoleConditionedObjective
        ? roleConditionedProjectionPlan
        : null,
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
      historicalAllocationStyle: normalizedConfig.rotationHistoricalAllocationStyle,
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
        ? candidateConstraintSearchBudget
        : null,
    });
    if (candidateConstraintSearchBudget) {
      constraintSearchStatesUsed += candidateConstraintSearchBudget.used;
      // `allocateRotationMinutes` keeps the older public diagnostic name for
      // API compatibility. At this solve boundary the budget is per candidate,
      // never solve-wide, so expose the accurate meaning alongside it.
      if (!rotation.ok && rotation.diagnostics?.category === "constraint-search-limit") {
        rotation.diagnostics.solveWideConstraintSearchLimitReached = false;
        rotation.diagnostics.candidateConstraintSearchLimitReached = true;
      }
    }
    return rotation;
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
  let lastRotationProgressAt = 0;
  const rejectedByConstraint = {
    positionMinimums: 0,
    statMinimums: Object.fromEntries(Object.keys(normalizedConfig.statMinimums).map((stat) => [stat, 0])),
    maxTurnovers: 0,
    rotationMinutes: 0,
    rotationPositionMinutes: 0,
    historicalWorkload: 0,
    constraintSearchLimit: 0,
  };
  const chosen = [];

  function reportRotationProgress({ phase = "enumerating", force = false } = {}) {
    // Progress must stay strictly observational: the exact solver may be used
    // outside the browser, and a display callback must never be able to abort
    // or otherwise perturb the mathematical result.
    if (!onProgress || normalizedConfig.mode !== "rotation") return;
    const now = Date.now();
    if (!force && now - lastRotationProgressAt < 250) return;
    lastRotationProgressAt = now;
    try {
      onProgress({
        phase,
        combinationsEvaluated,
        estimatedCombinations,
        feasibleCombinations,
        constrainedCandidatesSearched,
        unresolvedCandidates: unresolvedRotationCandidates.length,
      });
    } catch {
      // A consumer's display error must not change the exact answer.
    }
  }

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
          projectedRatesApplied: Boolean(
            rotationProjectedRates && rotationProjectedRates.size > 0,
          ),
          adjustedAllocation: false,
          searchStates: 0,
          // This candidate's unconstrained optimum already satisfies the
          // production rules, so it spent no per-roster proof states. The
          // solve-wide diagnostic separately reports states spent by other
          // candidates and must not leak into this rotation's audit.
          solveSearchStatesUsed: 0,
          solveSearchStateLimit: perCandidateConstraintSearchLimit,
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
    reportRotationProgress();
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
        } else if (baselineRotation.diagnostics.category === "historical-workload") {
          rejectedByConstraint.historicalWorkload += 1;
        } else {
          rejectedByConstraint.rotationMinutes += 1;
        }
        return;
      }

      // A custom rotation workload score remains authoritative for the actual
      // minute plan. It is not necessarily an upper bound on the model score
      // used to rank rosters, so compute a second relaxed allocation only for
      // that advanced API case. The ordinary allocator uses strategy-only
      // scores, matching the minute-sensitive portion of the reported result,
      // so its baseline is already the exact ranking bound.
      const rankingBoundRotation = callerRotationScores
        ? allocateSelectedRotation(selectedPlayers, {
            includeProjectedConstraints: false,
            rankingUpperBound: true,
          })
        : baselineRotation;
      if (!rankingBoundRotation.ok) {
        if (rankingBoundRotation.diagnostics.category === "position-minutes") {
          rejectedByConstraint.rotationPositionMinutes += 1;
        } else if (rankingBoundRotation.diagnostics.category === "historical-workload") {
          rejectedByConstraint.historicalWorkload += 1;
        } else {
          rejectedByConstraint.rotationMinutes += 1;
        }
        return;
      }

      const totals = calculateRotationTotals(
        selectedPlayers,
        baselineRotation,
        rotationProjectedRates,
        usesRoleConditionedProductionProjection ? roleConditionedProjectionPlan : null,
      );
      const upperModelAdjustments = candidateModelAdjustments(
        selectedPlayers,
        rankingBoundRotation,
        { upperBound: true },
      );
      const baselineModelAdjustments = candidateModelAdjustments(
        selectedPlayers,
        baselineRotation,
      );
      const rawUpperBound = calculateObjectiveScore(
        selectedPlayers,
        playerStrategyScores,
        rankingBoundRotation,
        rotationRankingModel,
        usesRoleConditionedObjective ? roleConditionedProjectionPlan : null,
        upperModelAdjustments.totalAdjustmentPoints,
      );
      const baselineRawScore = calculateObjectiveScore(
        selectedPlayers,
        playerStrategyScores,
        baselineRotation,
        rotationRankingModel,
        usesRoleConditionedObjective ? roleConditionedProjectionPlan : null,
        baselineModelAdjustments.totalAdjustmentPoints,
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
        rotationProjectedRates,
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
        } else if (rotation.diagnostics.category === "historical-workload") {
          rejectedByConstraint.historicalWorkload += 1;
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
      ? calculateRotationTotals(
        selectedPlayers,
        rotation,
        rotationProjectedRates,
        usesRoleConditionedProductionProjection ? roleConditionedProjectionPlan : null,
      )
      : calculateLineupTotals(selectedPlayers);

    const productionStatus = projectedConstraintStatus(totals, normalizedConfig);
    for (const stat of productionStatus.failedStatMinimums) {
      rejectedByConstraint.statMinimums[stat] += 1;
      passed = false;
    }
    if (productionStatus.failedMaxTurnovers) {
      rejectedByConstraint.maxTurnovers += 1;
      passed = false;
    }
    if (!passed) return;

    const modelAdjustments = candidateModelAdjustments(selectedPlayers, rotation);
    retainFeasibleCombination(
      selectedPlayers,
      positionResult,
      rotation,
      totals,
      calculateObjectiveScore(
        selectedPlayers,
        playerStrategyScores,
        rotation,
        rotation ? rotationRankingModel : null,
        usesRoleConditionedObjective ? roleConditionedProjectionPlan : null,
        modelAdjustments.totalAdjustmentPoints,
      ),
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

  reportRotationProgress({ force: true });
  enumerate(0, slotsToChoose);
  reportRotationProgress({
    phase: hasRotationProjectedConstraints ? "proving-constraints" : "complete",
    force: true,
  });

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
      reportRotationProgress({ phase: "proving-constraints" });
      const rotation = allocateSelectedRotation(candidate.players, {
        includeProjectedConstraints: true,
      });
      if (!rotation.ok) {
        if (rotation.diagnostics.category === "position-minutes") {
          rejectedByConstraint.rotationPositionMinutes += 1;
        } else if (rotation.diagnostics.category === "historical-workload") {
          rejectedByConstraint.historicalWorkload += 1;
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

      const totals = calculateRotationTotals(
        candidate.players,
        rotation,
        rotationProjectedRates,
        usesRoleConditionedProductionProjection ? roleConditionedProjectionPlan : null,
      );
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
        calculateObjectiveScore(
          candidate.players,
          playerStrategyScores,
          rotation,
          rotationRankingModel,
          usesRoleConditionedObjective ? roleConditionedProjectionPlan : null,
          candidateModelAdjustments(candidate.players, rotation).totalAdjustmentPoints,
        ),
      );
    }
  }

  reportRotationProgress({ phase: "complete", force: true });

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
            constraintSearchStatesUsed,
            constraintSearchStateLimit: hasRotationProjectedConstraints
              ? perCandidateConstraintSearchLimit
              : null,
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
    const triggeredLimit = perCandidateConstraintSearchLimit;
    return failureResult(mode, size, [
      `One candidate reached the per-roster ${triggeredLimit.toLocaleString()}-state production-constraint proof limit. No lineup was returned because that unresolved candidate could still be better than the feasible candidates already found. The outer rotation search has no candidate-count cap.`,
    ], {
      ...diagnostics,
      category: "performance",
      subcategory: "constraint-search-limit",
      exactSearchCompleted: false,
      feasibleCombinationsBeforeAbort: feasibleCombinations,
      constraintSearchStatesUsed,
      constraintSearchStateLimit: triggeredLimit,
      solveConstraintSearchStateLimit: triggeredLimit,
      solveWideConstraintSearchLimitReached: false,
      candidateConstraintSearchLimitReached: true,
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
    if (rejectedByConstraint.historicalWorkload > 0) {
      reasons.push(
        `${rejectedByConstraint.historicalWorkload} candidate rotation${rejectedByConstraint.historicalWorkload === 1 ? "" : "s"} lacked enough source-backed workload to form a credible 240-minute game inside the selected guardrail. Choose more established minutes, increase workload flexibility, or use game-plan optimization.`,
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
    const modelAdjustments = candidateModelAdjustments(alternative.players, rotation);
    const objective = calculateObjective(
      alternative.players,
      normalizedMetrics,
      effectiveObjective.weights,
      effectiveObjective.normalizedWeights,
      rotation,
      rotation ? rotationRankingModel : null,
      usesRoleConditionedObjective ? roleConditionedProjectionPlan : null,
      normalizedMetricResult.benchmarkIndexesByPlayerId,
      modelAdjustments,
    );
    const constraintAudit = buildConstraintAudit(
      alternative.players,
      normalizedConfig,
      alternative.positionResult,
      alternative.totals,
      rotation,
    );
    // Every returned rotation receives the same final simultaneity proof. This
    // keeps next-best groups fully auditable too: an alternative is not called
    // feasible merely because its 240 aggregate minutes add up on paper.
    const unitPlan = rotation
      ? planRotationUnits(alternative.players, rotation, { usageById: Object.fromEntries(alternative.players.map(player =>
        [player.id, normalizedConfig.offensiveResponsibilities[player.id] ?? readPlayerUsage(player)])) })
      : null;
    alternatives.push({
      rank: index + 1,
      playerIds: alternative.players.map((player) => player.id),
      players: alternative.players,
      score: objective.score,
      // Preserve the enumerator's unrounded objective for consistency checks.
      // Public presentation still uses `score`; rounding cannot hide an
      // improving feasible replacement or turn a small difference into a tie.
      objectiveValue: alternative._rawScore,
      // Keep the exact score decomposition on every ranked alternative. This
      // lets a Detailed report explain the player-minute Scout effect without
      // pretending a group-only exact-five residual belongs to one player.
      directGamePlanScore: objective.directGamePlanScore,
      rosterAdjustmentPoints: objective.rosterAdjustmentPoints,
      scoutMinuteAdjustmentPoints: objective.scoutMinuteAdjustmentPoints,
      strategyFitScore: objective.strategyFitScore,
      historicalReadinessIndex: objective.historicalReadinessIndex,
      strategyScore: objective.strategyScore,
      historicalReadinessScore: objective.historicalReadinessScore,
      planFitIndex: objective.planFitIndex,
      offenseIndex: objective.offenseIndex,
      defenseIndex: objective.defenseIndex,
      benchmarkMetricCount: objective.availableMetricCount,
      benchmarkMetricIndexes: objective.metricIndexes,
      contributionBreakdown: objective.contributionBreakdown,
      playerContributions: objective.playerContributions,
      modelAdjustments: objective.modelAdjustments,
      totals: alternative.totals,
      positionAssignment: alternative.positionResult.assignment,
      constraintAudit,
      ...(unitPlan ? { unitPlan } : {}),
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
    // `weights` preserves the user's requested strategy for share links.
    // `effectiveWeights` records the exact evidence-supported objective used
    // after any all-player advanced-metric guard was applied.
    effectiveWeights: { ...effectiveObjective.weights },
    score: best.score,
    planFitIndex: best.planFitIndex,
    offenseIndex: best.offenseIndex,
    defenseIndex: best.defenseIndex,
    contributionBreakdown: best.contributionBreakdown,
    constraintAudit: best.constraintAudit,
    best,
    alternatives,
    combinationsEvaluated,
    diagnostics,
  };
}
