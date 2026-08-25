/**
 * Fan-grade, browser-safe analytics helpers for Lineup Lab.
 *
 * This module deliberately has no DOM, network, storage, or optimizer imports.
 * It accepts the canonical Lineup Lab player shape (per-game counting stats)
 * and returns serializable plain objects. Keeping it pure means the existing
 * exact optimizer stays the single source of truth for selection feasibility,
 * while the UI can add explanations, charts, reports, and share links without
 * changing an exact result.
 *
 * Important data boundary:
 * - The standard player shape contains *per-game* counting statistics.
 * - Per-36 rates are therefore exact whenever source minutes are present.
 * - Per-100 rates are shown only when the caller supplies a player-possession
 *   denominator or explicitly opts into a clearly labelled team-pace estimate.
 * - Era-relative results require a caller-provided comparison cohort. A team
 *   roster by itself is never presented as a league-wide historical baseline.
 * - Several fan-friendly labels (especially movement shooting and switching)
 *   require inputs that basic box-score data may not contain. The returned
 *   evidence and caveats make those limitations visible instead of guessing.
 */

/** Counting metrics expressed as player totals per game in the canonical data. */
export const FAN_COUNTING_METRICS = Object.freeze([
  "points",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
]);

/** Source shooting rates that retain the same meaning in every rate view. */
export const FAN_EFFICIENCY_METRICS = Object.freeze([
  "fgPct",
  "threePct",
  "efgPct",
  "ftPct",
]);

/** The model-facing metrics that can explain the existing exact objective. */
export const FAN_OBJECTIVE_METRICS = Object.freeze([
  "points",
  "efgPct",
  "threePct",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "ballSecurity",
]);

export const FAN_METRIC_LABELS = Object.freeze({
  points: "Scoring",
  rebounds: "Rebounding",
  assists: "Playmaking",
  steals: "Steals",
  blocks: "Blocks",
  turnovers: "Turnovers",
  ballSecurity: "Ball security",
  fgPct: "Field-goal %",
  threePct: "Three-point %",
  efgPct: "Effective FG%",
  ftPct: "Free-throw %",
  threePointAttemptRate: "Three-point attempt rate",
  trueShootingPct: "True shooting %",
  usagePct: "Usage %",
  assistPct: "Assist %",
  totalReboundPct: "Total rebound %",
  stealPct: "Steal %",
  blockPct: "Block %",
  defensiveBoxPlusMinus: "Defensive BPM",
});

const LOWER_IS_BETTER_METRICS = new Set(["turnovers", "ballSecurity"]);
const PER_36_OBJECTIVE_METRICS = new Set([
  "points",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "ballSecurity",
]);
const POSITION_KEYS = new Set(["G", "F", "C"]);

/**
 * Role definitions are intentionally readable rather than scouting jargon.
 * `evidence` tells a renderer whether a role comes from direct box-score
 * signals, an optional advanced metric, or a transparent proxy.
 */
export const FAN_ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "primaryCreator",
    label: "Primary creator",
    shortLabel: "Creator",
    target: 1,
    evidence: "box-score",
    description: "Creates a large share of the group's passing and offensive burden.",
  }),
  Object.freeze({
    id: "secondaryCreator",
    label: "Secondary creator",
    shortLabel: "Secondary creator",
    target: 1,
    evidence: "box-score",
    description: "Provides a second credible source of playmaking.",
  }),
  Object.freeze({
    id: "leadScorer",
    label: "Lead scorer",
    shortLabel: "Scorer",
    target: 1,
    evidence: "box-score",
    description: "Supplies high scoring volume relative to the chosen comparison pool.",
  }),
  Object.freeze({
    id: "movementShooter",
    // Three-point accuracy and volume are useful, but they cannot identify
    // cuts, relocations, screens, or other off-ball movement without tracking
    // data. Keep the fan-facing label honest about that evidence boundary.
    label: "Movement-shooting proxy",
    shortLabel: "Movement proxy",
    target: 1,
    evidence: "requires-three-point-volume",
    description: "Combines strong three-point accuracy with verified volume; this is a box-score proxy, not tracking-data proof of off-ball movement.",
  }),
  Object.freeze({
    id: "perimeterShooter",
    label: "Perimeter shooter",
    shortLabel: "Shooter",
    target: 1,
    evidence: "box-score",
    description: "Shows strong three-point accuracy; volume is not required for this lighter label.",
  }),
  Object.freeze({
    id: "connector",
    label: "Connector",
    shortLabel: "Connector",
    target: 1,
    evidence: "box-score",
    description: "Adds secondary passing and ball security without needing to be the primary scorer.",
  }),
  Object.freeze({
    id: "rimProtector",
    label: "Rim protector",
    shortLabel: "Rim protector",
    target: 1,
    evidence: "box-score",
    description: "Produces blocks at a strong rate from a frontcourt-eligible role.",
  }),
  Object.freeze({
    id: "switchDefender",
    // Multi-position eligibility and stocks are not proof of matchup
    // assignments. The label therefore describes the signal, not a verified
    // defensive scheme responsibility.
    label: "Switch-defense proxy",
    shortLabel: "Switch proxy",
    target: 1,
    evidence: "box-score-proxy",
    description: "A multi-position player with strong stocks; matchup tracking would be needed to verify actual switching ability.",
  }),
  Object.freeze({
    id: "rebounder",
    label: "Rebounder",
    shortLabel: "Rebounder",
    target: 1,
    evidence: "box-score",
    description: "Provides strong total-rebounding volume relative to the comparison pool.",
  }),
  Object.freeze({
    id: "disruptor",
    label: "Disruptive defender",
    shortLabel: "Disruptor",
    target: 1,
    evidence: "box-score",
    description: "Creates defensive events through steals and blocks.",
  }),
]);

const ROLE_BY_ID = new Map(FAN_ROLE_DEFINITIONS.map((role) => [role.id, role]));

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function playerId(player, fallbackIndex = 0) {
  const id = String(player?.id ?? "").trim();
  return id || `player-${fallbackIndex + 1}`;
}

function playerName(player, fallbackIndex = 0) {
  const name = String(player?.name ?? "").trim();
  return name || playerId(player, fallbackIndex);
}

function stableCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function valuesObject(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== null && value !== undefined));
}

function normalizePositions(value) {
  const raw = Array.isArray(value) ? value : [value];
  const map = { G: "G", PG: "G", SG: "G", F: "F", SF: "F", PF: "F", C: "C" };
  const positions = [];
  for (const item of raw) {
    for (const token of String(item ?? "").toUpperCase().split(/[\s/,|;+\-]+/)) {
      const position = map[token];
      if (position && !positions.includes(position)) positions.push(position);
    }
  }
  return positions.filter((position) => POSITION_KEYS.has(position));
}

function contextForPlayer(player, options = {}) {
  const contexts = options.playerContexts ?? options.contextByPlayerId;
  if (contexts instanceof Map) return contexts.get(playerId(player)) || {};
  if (contexts && typeof contexts === "object") return contexts[playerId(player)] || {};
  return {};
}

function readFromCandidates(candidates, { nonNegative = false, percentage = false } = {}) {
  for (const candidate of candidates) {
    let value = nonNegative ? nonNegativeNumber(candidate) : finiteNumber(candidate);
    if (value === null) continue;
    // Public Lineup Lab data uses decimal percentages. Supporting 55.4 as a
    // caller convenience is safe only for a percentage field, never a count.
    if (percentage && value > 1 && value <= 100) value /= 100;
    if (percentage && (value < 0 || value > 1)) continue;
    return value;
  }
  return null;
}

function nestedMetricCandidates(player, context, keys) {
  const playerAnalytics = player?.analytics && typeof player.analytics === "object" ? player.analytics : {};
  const contextAnalytics = context?.analytics && typeof context.analytics === "object" ? context.analytics : {};
  const maps = [
    context?.advancedMetrics,
    context?.metrics,
    context?.rawTotals,
    context?.totals,
    contextAnalytics.advanced,
    contextAnalytics.totals,
    player?.advancedMetrics,
    player?.metrics,
    player?.rawTotals,
    player?.totals,
    playerAnalytics.advanced,
    playerAnalytics.totals,
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  const candidates = [];
  for (const key of keys) {
    candidates.push(context?.[key], player?.[key], contextAnalytics?.[key], playerAnalytics?.[key]);
    for (const map of maps) candidates.push(map[key]);
  }
  return candidates;
}

function canonicalCountingStats(player) {
  return valuesObject(FAN_COUNTING_METRICS.map((metric) => [
    metric,
    nonNegativeNumber(player?.[metric]),
  ]));
}

function canonicalEfficiencyStats(player) {
  return valuesObject(FAN_EFFICIENCY_METRICS.map((metric) => [
    metric,
    readFromCandidates([player?.[metric]], { percentage: true }),
  ]));
}

function sampleForPlayer(player, context = {}) {
  const playerAnalytics = player?.analytics && typeof player.analytics === "object" ? player.analytics : {};
  const contextAnalytics = context?.analytics && typeof context.analytics === "object" ? context.analytics : {};
  const games = nonNegativeNumber(player?.games);
  const starts = nonNegativeNumber(player?.starts);
  const minutesPerGame = nonNegativeNumber(player?.minutes);
  const totalMinutes = readFromCandidates([
    context?.totalMinutes,
    context?.minutesPlayed,
    context?.minutes_played,
    context?.rawTotals?.minutes_played,
    context?.rawTotals?.minutesPlayed,
    context?.totals?.minutes_played,
    context?.totals?.minutesPlayed,
    contextAnalytics?.totalMinutes,
    contextAnalytics?.totals?.minutes,
    contextAnalytics?.totals?.minutes_played,
    contextAnalytics?.totals?.minutesPlayed,
    playerAnalytics?.totalMinutes,
    playerAnalytics?.totals?.minutes,
    playerAnalytics?.totals?.minutes_played,
    playerAnalytics?.totals?.minutesPlayed,
  ], { nonNegative: true }) ?? (games !== null && minutesPerGame !== null ? games * minutesPerGame : null);

  return {
    games,
    starts,
    minutesPerGame,
    totalMinutes: totalMinutes === null ? null : round(totalMinutes, 2),
  };
}

function positionPossessionDenominator(player, sample, context, options) {
  const globalContext = options.possessionContext && typeof options.possessionContext === "object"
    ? options.possessionContext
    : {};
  const localContext = context?.possessionContext && typeof context.possessionContext === "object"
    ? context.possessionContext
    : {};
  const playerAnalytics = player?.analytics && typeof player.analytics === "object" ? player.analytics : {};
  const contextAnalytics = context?.analytics && typeof context.analytics === "object" ? context.analytics : {};
  const merged = { ...globalContext, ...localContext };
  const perGame = readFromCandidates([
    merged.playerPossessionsPerGame,
    merged.possessionsPerGame,
    context?.playerPossessionsPerGame,
    player?.playerPossessionsPerGame,
    player?.possessionsPerGame,
  ], { nonNegative: true });
  if (perGame !== null && perGame > 0) {
    return { value: perGame, method: "reported-player-possessions-per-game", estimated: false };
  }

  const totalPossessions = readFromCandidates([
    merged.playerPossessions,
    merged.possessions,
    context?.playerPossessions,
    context?.possessions,
    player?.playerPossessions,
    player?.possessions,
  ], { nonNegative: true });
  if (totalPossessions !== null && totalPossessions > 0 && sample.games && sample.games > 0) {
    return {
      value: totalPossessions / sample.games,
      method: "reported-player-season-possessions",
      estimated: false,
    };
  }

  // The planned read-only analytics payload can expose estimated team-season
  // possessions plus total team player-minutes. This creates a more grounded
  // on-court exposure estimate than a generic pace number, but remains marked
  // as an estimate because it is not play-by-play possession participation.
  const estimatedTeamPossessions = readFromCandidates([
    merged.estimatedTeamPossessions,
    context?.estimatedTeamPossessions,
    contextAnalytics?.estimatedTeamPossessions,
    playerAnalytics?.estimatedTeamPossessions,
  ], { nonNegative: true });
  const teamTotalMinutes = readFromCandidates([
    merged.teamTotalMinutes,
    context?.teamTotalMinutes,
    contextAnalytics?.teamTotalMinutes,
    playerAnalytics?.teamTotalMinutes,
  ], { nonNegative: true });
  if (
    estimatedTeamPossessions !== null
    && estimatedTeamPossessions > 0
    && teamTotalMinutes !== null
    && teamTotalMinutes > 0
    && sample.totalMinutes !== null
    && sample.totalMinutes > 0
    && sample.games
    && sample.games > 0
  ) {
    // `teamTotalMinutes` is the sum of all five on-court player slots. A
    // player's on-court share is therefore player minutes divided by one
    // team's game minutes (`teamTotalMinutes / 5`), not merely the player's
    // fraction of aggregate player-minutes. Without the factor of five a
    // 24-MPG player would incorrectly be treated as present for only 10 of a
    // 100-possession game instead of roughly 50.
    return {
      value: (estimatedTeamPossessions * (sample.totalMinutes / (teamTotalMinutes / 5))) / sample.games,
      method: "estimated-minute-share-of-team-season-possessions",
      estimated: true,
    };
  }

  // An optional minute-share estimate is deliberately opt-in. Team pace is a
  // game-level possession measure, so `MPG / 48 * pace` approximates the
  // possessions while the player was on court. It is useful for fan context,
  // but it is not a replacement for play-by-play on-court possession data.
  const allowEstimate = options.allowTeamPaceEstimate === true || merged.allowTeamPaceEstimate === true;
  const teamPace = readFromCandidates([
    merged.teamPace,
    merged.pace,
    context?.teamPace,
    player?.teamPace,
  ], { nonNegative: true });
  if (allowEstimate && teamPace !== null && teamPace > 0 && sample.minutesPerGame && sample.minutesPerGame > 0) {
    return {
      value: teamPace * (sample.minutesPerGame / 48),
      method: "estimated-minute-share-of-team-pace",
      estimated: true,
    };
  }
  return null;
}

function analyticsLeaguePer36Baseline(player, context = {}) {
  const candidates = [
    context?.analytics?.leaguePer36,
    context?.leaguePer36,
    player?.analytics?.leaguePer36,
    player?.leaguePer36,
  ];
  const leaguePer36 = candidates.find((value) => value && typeof value === "object" && !Array.isArray(value));
  if (!leaguePer36) return null;
  const metrics = {};
  for (const metric of [...FAN_COUNTING_METRICS, ...FAN_EFFICIENCY_METRICS]) {
    const mean = metric === "ballSecurity"
      ? nonNegativeNumber(leaguePer36.turnovers)
      : metric.endsWith("Pct")
        ? readFromCandidates([leaguePer36[metric]], { percentage: true })
        : nonNegativeNumber(leaguePer36[metric]);
    if (mean !== null) {
      metrics[metric] = {
        mean,
        standardDeviation: null,
        observations: null,
        lowerIsBetter: LOWER_IS_BETTER_METRICS.has(metric),
      };
    }
  }
  if (Object.keys(metrics).length === 0) return null;
  const source = player?.analytics?.source || context?.analytics?.source || {};
  return {
    label: String(source?.leagueLabel || "Imported league per-36 benchmark"),
    scope: String(source?.leagueScope || "read-only analytics payload"),
    season: String(source?.season || ""),
    phase: String(source?.phase || ""),
    // The data adapter, not this pure module, is responsible for only setting
    // this to a genuine league baseline. The field makes that provenance
    // visible to a future renderer instead of silently assuming it.
    isLeagueWide: source?.isLeagueWide === true,
    view: "per36",
    metrics,
    caveats: ["League benchmark values came from the read-only analytics payload; no distribution was supplied for z-scores."],
  };
}

function resolveAdvancedMetric(player, context, metric) {
  const aliases = {
    threePointAttemptRate: [
      "threePointAttemptRate",
      "three_point_attempt_rate",
      "3par",
    ],
    trueShootingPct: ["trueShootingPct", "true_shooting_percentage", "tsPct", "ts_pct"],
    usagePct: ["usagePct", "usage_percentage", "usgPct", "usg_pct"],
    assistPct: ["assistPct", "assist_percentage", "astPct", "ast_pct"],
    totalReboundPct: ["totalReboundPct", "total_rebound_percentage", "trbPct", "trb_pct"],
    stealPct: ["stealPct", "steal_percentage", "stlPct", "stl_pct"],
    blockPct: ["blockPct", "block_percentage", "blkPct", "blk_pct"],
    defensiveBoxPlusMinus: [
      "defensiveBoxPlusMinus",
      "defensive_box_plus_minus",
      "dbpm",
    ],
  };
  const keys = aliases[metric] || [metric];
  const percentage = metric !== "defensiveBoxPlusMinus";
  return readFromCandidates(nestedMetricCandidates(player, context, keys), { percentage });
}

function resolveThreePointVolume(player, sample, context) {
  const explicitPerGame = readFromCandidates(nestedMetricCandidates(player, context, [
    "threePointAttemptsPerGame",
    "three_point_attempts_per_game",
    "threePointFieldGoalsAttemptedPerGame",
    "three_point_field_goals_attempted_per_game",
  ]), { nonNegative: true });
  if (explicitPerGame !== null) {
    return { value: explicitPerGame, unit: "attempts-per-game", method: "reported-per-game-attempts" };
  }

  const totalAttempts = readFromCandidates(nestedMetricCandidates(player, context, [
    "three_point_field_goals_attempted",
    "threePointFieldGoalsAttempted",
    "threePointAttemptsTotal",
    "three_point_attempts_total",
  ]), { nonNegative: true });
  if (totalAttempts !== null && sample.games && sample.games > 0) {
    return {
      value: totalAttempts / sample.games,
      unit: "attempts-per-game",
      method: "season-total-attempts-divided-by-games",
    };
  }

  const attemptRate = resolveAdvancedMetric(player, context, "threePointAttemptRate");
  if (attemptRate !== null) {
    return { value: attemptRate, unit: "attempt-rate", method: "reported-three-point-attempt-rate" };
  }
  return null;
}

function metricValueForView(rateViews, metric, viewName) {
  if (metric === "ballSecurity") return rateViews?.[viewName]?.values?.turnovers ?? null;
  return rateViews?.[viewName]?.values?.[metric] ?? null;
}

/**
 * Build transparent per-game, per-36, per-100, and optional era-relative
 * views for one canonical Lineup Lab player.
 *
 * `options.possessionContext` may contain a reported `playerPossessions`, a
 * reported `playerPossessionsPerGame`, or (only with `allowTeamPaceEstimate`)
 * a `teamPace`. `options.eraBaseline` should be produced by
 * `buildEraBaseline` or follow its documented shape.
 */
export function derivePlayerRateViews(player, options = {}) {
  const context = contextForPlayer(player, options);
  const sample = sampleForPlayer(player, context);
  const counting = canonicalCountingStats(player);
  const efficiency = canonicalEfficiencyStats(player);
  const caveats = [];
  const perGame = {
    available: Object.keys(counting).length > 0,
    basis: "source per-game player profile",
    values: { ...counting, ...efficiency },
  };

  const per36Values = {};
  if (sample.minutesPerGame && sample.minutesPerGame > 0) {
    for (const [metric, value] of Object.entries(counting)) {
      per36Values[metric] = round((value / sample.minutesPerGame) * 36);
    }
    // Percentages are efficiencies rather than accumulation rates. Preserve
    // them unchanged so a chart never implies that 55 eFG% becomes 66 eFG%.
    Object.assign(per36Values, efficiency);
  } else if (Object.keys(counting).length > 0) {
    caveats.push("Per-36 rates are unavailable because source minutes per game are missing or zero.");
  }
  const per36 = {
    available: Object.keys(per36Values).length > 0,
    basis: "per-game counting stats normalized to 36 source minutes",
    values: per36Values,
  };

  const possessionDenominator = positionPossessionDenominator(player, sample, context, options);
  const per100Values = {};
  if (possessionDenominator?.value > 0) {
    for (const [metric, value] of Object.entries(counting)) {
      per100Values[metric] = round((value / possessionDenominator.value) * 100);
    }
    Object.assign(per100Values, efficiency);
    if (possessionDenominator.estimated) {
      caveats.push("Per-100 rates use an opted-in minute-share team-pace estimate, not reported on-court possessions.");
    }
  } else {
    caveats.push("Per-100 rates are hidden until reported player possessions or an opted-in team-pace estimate is supplied.");
  }
  const per100 = {
    available: Object.keys(per100Values).length > 0,
    basis: possessionDenominator?.method || "unavailable-no-possession-denominator",
    estimated: Boolean(possessionDenominator?.estimated),
    possessionsPerGame: possessionDenominator?.value ? round(possessionDenominator.value) : null,
    values: per100Values,
  };

  const rateViews = { perGame, per36, per100 };
  const suppliedBaseline = options.eraBaseline || analyticsLeaguePer36Baseline(player, context);
  const eraRelative = suppliedBaseline
    ? calculateEraRelativeView(rateViews, suppliedBaseline, { view: options.eraView || suppliedBaseline.view || "per100" })
    : {
        available: false,
        basis: "unavailable-no-comparison-cohort",
        values: {},
        caveats: ["Era-relative values require a supplied, labeled comparison cohort."],
      };

  return {
    playerId: playerId(player),
    playerName: playerName(player),
    sample,
    perGame,
    per36,
    per100,
    eraRelative,
    dataContext: {
      postseasonAvailable: typeof player?.analytics?.postseasonAvailable === "boolean"
        ? player.analytics.postseasonAvailable
        : null,
      source: player?.analytics?.source && typeof player.analytics.source === "object"
        ? { ...player.analytics.source }
        : null,
    },
    caveats,
  };
}

function median(sortedValues) {
  if (sortedValues.length === 0) return null;
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? sortedValues[middle]
    : (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

/**
 * Build a labeled baseline from a caller-supplied cohort of player seasons.
 *
 * This helper never fetches data and never assumes the cohort is NBA-wide.
 * Set `isLeagueWide: true` only when the caller actually supplied every
 * appropriate player-season for that league/season/phase. The result can then
 * be passed to `derivePlayerRateViews` for honest era-relative comparisons.
 */
export function buildEraBaseline(players, options = {}) {
  const sourcePlayers = Array.isArray(players) ? players : [];
  const view = ["perGame", "per36", "per100"].includes(options.view) ? options.view : "per100";
  const metrics = Array.isArray(options.metrics) && options.metrics.length > 0
    ? options.metrics
    : [...FAN_COUNTING_METRICS, ...FAN_EFFICIENCY_METRICS];
  const minGames = nonNegativeNumber(options.minGames) ?? 0;
  const minMinutes = nonNegativeNumber(options.minMinutes) ?? 0;
  const minObservations = Math.max(1, Math.floor(nonNegativeNumber(options.minObservations) ?? 5));
  const qualified = sourcePlayers.filter((player) => {
    const context = contextForPlayer(player, options);
    const sample = sampleForPlayer(player, context);
    return (sample.games ?? 0) >= minGames && (sample.totalMinutes ?? 0) >= minMinutes;
  });
  const baselineMetrics = {};

  for (const metric of metrics) {
    const values = qualified
      .map((player) => {
        const rateViews = derivePlayerRateViews(player, {
          ...options,
          eraBaseline: undefined,
        });
        return metricValueForView(rateViews, metric, view);
      })
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    if (values.length < minObservations) continue;
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance = values.reduce((total, value) => total + ((value - mean) ** 2), 0) / values.length;
    baselineMetrics[metric] = {
      mean: round(mean, 6),
      median: round(median(values), 6),
      standardDeviation: round(Math.sqrt(variance), 6),
      observations: values.length,
      lowerIsBetter: LOWER_IS_BETTER_METRICS.has(metric),
    };
  }

  const caveats = [];
  if (view === "per100" && Object.keys(baselineMetrics).length === 0) {
    caveats.push("No qualifying per-100 values were available; provide possession context for the cohort.");
  }
  if (!options.isLeagueWide) {
    caveats.push("This is a supplied comparison cohort, not automatically a league-wide era baseline.");
  }

  return {
    label: String(options.label || "Provided comparison cohort"),
    scope: String(options.scope || "caller-supplied player seasons"),
    season: String(options.season || ""),
    phase: String(options.phase || ""),
    isLeagueWide: options.isLeagueWide === true,
    view,
    qualifiedPlayers: qualified.length,
    minimumSample: { minGames, minMinutes, minObservations },
    metrics: baselineMetrics,
    caveats,
  };
}

/**
 * Compare one already-derived rate-view object to a caller-provided baseline.
 * `directionAdjustedZScore` flips turnover-style metrics so a positive value
 * always means better relative to the supplied cohort.
 */
export function calculateEraRelativeView(rateViews, baseline, options = {}) {
  const view = ["perGame", "per36", "per100"].includes(options.view)
    ? options.view
    : baseline?.view || "per100";
  const values = rateViews?.[view]?.values || {};
  const baselineMetrics = baseline?.metrics && typeof baseline.metrics === "object"
    ? baseline.metrics
    : {};
  const comparisons = {};
  for (const [metric, reference] of Object.entries(baselineMetrics)) {
    const value = metric === "ballSecurity" ? values.turnovers : values[metric];
    const mean = finiteNumber(reference?.mean);
    const standardDeviation = nonNegativeNumber(reference?.standardDeviation);
    if (!Number.isFinite(value) || mean === null) continue;
    const zScore = standardDeviation && standardDeviation > 0 ? (value - mean) / standardDeviation : null;
    const lowerIsBetter = reference?.lowerIsBetter === true || LOWER_IS_BETTER_METRICS.has(metric);
    comparisons[metric] = {
      value: round(value),
      baseline: round(mean),
      difference: round(value - mean),
      percentOfBaseline: mean !== 0 ? round((value / mean) * 100, 2) : null,
      zScore: zScore === null ? null : round(zScore, 3),
      directionAdjustedZScore: zScore === null ? null : round(lowerIsBetter ? -zScore : zScore, 3),
      lowerIsBetter,
      observations: Number(reference?.observations) || null,
    };
  }
  const caveats = [...(baseline?.caveats || [])];
  if (!rateViews?.[view]?.available) {
    caveats.push(`${view} values are unavailable for this player.`);
  }
  return {
    available: Object.keys(comparisons).length > 0,
    basis: baseline?.isLeagueWide
      ? "supplied-league-wide-era-baseline"
      : "supplied-comparison-cohort",
    label: baseline?.label || "Provided comparison cohort",
    scope: baseline?.scope || "caller-supplied player seasons",
    season: baseline?.season || "",
    phase: baseline?.phase || "",
    view,
    isLeagueWide: baseline?.isLeagueWide === true,
    values: comparisons,
    caveats: [...new Set(caveats)],
  };
}

/**
 * Return optimizer-compatible percentiles for a metric set. Ties receive the
 * average rank; a one-player cohort receives 1 rather than a made-up 50th
 * percentile. Values are keyed by canonical player id and are deterministic.
 */
export function percentileRanks(players, metricValues, options = {}) {
  const sourcePlayers = Array.isArray(players) ? players : [];
  const lowerIsBetter = options.lowerIsBetter === true;
  const entries = sourcePlayers
    .map((player, index) => ({
      id: playerId(player, index),
      value: typeof metricValues === "function"
        ? finiteNumber(metricValues(player, index))
        : finiteNumber(player?.[metricValues]),
    }))
    .filter((entry) => entry.value !== null)
    .sort((left, right) => (left.value - right.value) || stableCompare(left.id, right.id));
  const ranks = new Map();
  if (entries.length === 0) return ranks;
  if (entries.length === 1) {
    ranks.set(entries[0].id, 1);
    return ranks;
  }
  let start = 0;
  while (start < entries.length) {
    let end = start;
    while (end + 1 < entries.length && entries[end + 1].value === entries[start].value) end += 1;
    const ascending = ((start + end) / 2) / (entries.length - 1);
    const percentile = lowerIsBetter ? 1 - ascending : ascending;
    for (let index = start; index <= end; index += 1) ranks.set(entries[index].id, percentile);
    start = end + 1;
  }
  return ranks;
}

function sampleReliability(sample, options) {
  const minGames = nonNegativeNumber(options.minGames) ?? 10;
  const minMinutes = nonNegativeNumber(options.minMinutes) ?? 200;
  const gamesReliable = sample.games !== null && sample.games >= minGames;
  const minutesReliable = sample.totalMinutes !== null && sample.totalMinutes >= minMinutes;
  const reliable = gamesReliable && minutesReliable;
  return {
    reliable,
    minGames,
    minMinutes,
    message: reliable
      ? "Meets the selected sample-size guardrail."
      : `Small-sample flag: compare carefully below ${minGames} games and ${minMinutes} total minutes.`,
  };
}

function buildRoleProfile(player, options, index) {
  const context = contextForPlayer(player, options);
  const rateViews = derivePlayerRateViews(player, {
    ...options,
    eraBaseline: undefined,
  });
  const sample = rateViews.sample;
  const threePointVolume = resolveThreePointVolume(player, sample, context);
  const per36 = rateViews.per36.values;
  const perGame = rateViews.perGame.values;
  const advanced = valuesObject([
    ["threePointAttemptRate", resolveAdvancedMetric(player, context, "threePointAttemptRate")],
    ["trueShootingPct", resolveAdvancedMetric(player, context, "trueShootingPct")],
    ["usagePct", resolveAdvancedMetric(player, context, "usagePct")],
    ["assistPct", resolveAdvancedMetric(player, context, "assistPct")],
    ["totalReboundPct", resolveAdvancedMetric(player, context, "totalReboundPct")],
    ["stealPct", resolveAdvancedMetric(player, context, "stealPct")],
    ["blockPct", resolveAdvancedMetric(player, context, "blockPct")],
    ["defensiveBoxPlusMinus", resolveAdvancedMetric(player, context, "defensiveBoxPlusMinus")],
  ]);
  const stocks = Number.isFinite(per36.steals) && Number.isFinite(per36.blocks)
    ? per36.steals + per36.blocks
    : null;
  const volumePer36 = threePointVolume?.unit === "attempts-per-game" && sample.minutesPerGame && sample.minutesPerGame > 0
    ? (threePointVolume.value / sample.minutesPerGame) * 36
    : null;

  return {
    id: playerId(player, index),
    name: playerName(player, index),
    player,
    positions: normalizePositions(player?.positions),
    rateViews,
    sample,
    reliability: sampleReliability(sample, options),
    values: {
      scoring: per36.points ?? null,
      playmaking: per36.assists ?? null,
      rebounding: per36.rebounds ?? null,
      steals: per36.steals ?? null,
      blocks: per36.blocks ?? null,
      stocks,
      turnovers: per36.turnovers ?? null,
      efficiency: perGame.efgPct ?? null,
      threePointPct: perGame.threePct ?? null,
      threePointVolume: volumePer36 ?? threePointVolume?.value ?? null,
      threePointVolumeUnit: volumePer36 !== null ? "attempts-per-36" : threePointVolume?.unit || null,
      ...advanced,
    },
    evidence: {
      hasThreePointVolume: threePointVolume !== null,
      threePointVolumeMethod: threePointVolume?.method || "unavailable",
      hasAdvancedPlaymaking: advanced.assistPct !== undefined,
      hasAdvancedRebounding: advanced.totalReboundPct !== undefined,
      hasAdvancedDefense: advanced.stealPct !== undefined || advanced.blockPct !== undefined,
    },
  };
}

function dedupePlayers(players) {
  const seen = new Set();
  const unique = [];
  for (const player of players) {
    const id = playerId(player, unique.length);
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(player);
    }
  }
  return unique;
}

function rolePercentiles(profiles) {
  const metricAccessors = {
    scoring: (profile) => profile.values.scoring,
    playmaking: (profile) => profile.values.playmaking,
    rebounding: (profile) => profile.values.rebounding,
    steals: (profile) => profile.values.steals,
    blocks: (profile) => profile.values.blocks,
    stocks: (profile) => profile.values.stocks,
    turnovers: (profile) => profile.values.turnovers,
    efficiency: (profile) => profile.values.efficiency,
    threePointPct: (profile) => profile.values.threePointPct,
    threePointVolume: (profile) => profile.values.threePointVolume,
    usagePct: (profile) => profile.values.usagePct,
    assistPct: (profile) => profile.values.assistPct,
    totalReboundPct: (profile) => profile.values.totalReboundPct,
    stealPct: (profile) => profile.values.stealPct,
    blockPct: (profile) => profile.values.blockPct,
    defensiveBoxPlusMinus: (profile) => profile.values.defensiveBoxPlusMinus,
  };
  const result = new Map(profiles.map((profile) => [profile.id, {}]));
  for (const [metric, accessor] of Object.entries(metricAccessors)) {
    const ranks = percentileRanks(profiles, (profile) => accessor(profile), {
      lowerIsBetter: metric === "turnovers",
    });
    for (const profile of profiles) result.get(profile.id)[metric] = ranks.get(profile.id) ?? null;
  }
  return result;
}

function weightedSignal(percentiles, metricWeights) {
  let totalWeight = 0;
  let total = 0;
  for (const [metric, weight] of metricWeights) {
    const value = percentiles[metric];
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    total += value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? total / totalWeight : null;
}

function percentileOrThreshold(percentile, value, percentileThreshold, absoluteThreshold, profileCount) {
  if (profileCount >= 5 && Number.isFinite(percentile)) return percentile >= percentileThreshold;
  return Number.isFinite(value) && value >= absoluteThreshold;
}

/** Format rounded percentile ranks with natural ordinal wording (for example, 93rd). */
function formatPercentile(value) {
  if (!Number.isFinite(value)) return "not ranked";
  const percentile = Math.round(value * 100);
  const lastTwoDigits = Math.abs(percentile) % 100;
  const lastDigit = Math.abs(percentile) % 10;
  const suffix = lastTwoDigits >= 11 && lastTwoDigits <= 13
    ? "th"
    : lastDigit === 1 ? "st" : lastDigit === 2 ? "nd" : lastDigit === 3 ? "rd" : "th";
  return `${percentile}${suffix} percentile`;
}

function createRole(id, score, evidence, profile) {
  const definition = ROLE_BY_ID.get(id);
  const reliability = profile.reliability.reliable ? "standard" : "small-sample";
  return {
    id,
    label: definition.label,
    shortLabel: definition.shortLabel,
    score: round(score, 3),
    confidence: reliability,
    evidenceMode: definition.evidence,
    description: definition.description,
    evidence,
  };
}

function classifyProfile(profile, percentiles, profileCount) {
  const roles = [];
  const values = profile.values;
  const p = percentiles;
  // Prefer the advanced assist share when it exists. Otherwise use assists per
  // 36, which is available in the standard browser payload. Do not count both
  // as independent evidence: they describe closely related playmaking.
  const primaryPlaymakingMetric = Number.isFinite(p.assistPct) ? "assistPct" : "playmaking";
  const primaryPlaymakingValue = Number.isFinite(values.assistPct) ? values.assistPct : values.playmaking;
  const primaryCreatorScore = weightedSignal(p, [
    [primaryPlaymakingMetric, 0.65],
    ["scoring", 0.2],
    ["turnovers", 0.15],
  ]);
  const hasPrimaryCreator = percentileOrThreshold(
    p[primaryPlaymakingMetric],
    primaryPlaymakingValue,
    0.72,
    primaryPlaymakingMetric === "assistPct" ? 0.3 : 7,
    profileCount,
  ) && (
    primaryPlaymakingMetric === "assistPct"
      ? primaryPlaymakingValue >= 0.3
      : primaryPlaymakingValue >= 7
  );
  if (hasPrimaryCreator && primaryCreatorScore !== null) {
    roles.push(createRole("primaryCreator", primaryCreatorScore, [
      `Playmaking: ${formatPercentile(p.assistPct ?? p.playmaking)} in this comparison pool.`,
      values.assistPct !== undefined
        ? `Reported assist rate: ${round(values.assistPct * 100, 1)}%.`
        : `Assists per 36: ${round(values.playmaking, 1)}.`,
    ], profile));
  }

  const secondaryCreatorScore = weightedSignal(p, [["playmaking", 0.7], ["turnovers", 0.3]]);
  if (
    !hasPrimaryCreator
    && percentileOrThreshold(p.playmaking, values.playmaking, 0.58, 3.5, profileCount)
    && secondaryCreatorScore !== null
  ) {
    roles.push(createRole("secondaryCreator", secondaryCreatorScore, [
      `Playmaking: ${formatPercentile(p.playmaking)} in this comparison pool.`,
      `Ball security: ${formatPercentile(p.turnovers)} (lower turnovers rank better).`,
    ], profile));
  }

  const scorerScore = weightedSignal(p, [["scoring", 0.75], ["efficiency", 0.25]]);
  if (percentileOrThreshold(p.scoring, values.scoring, 0.78, 20, profileCount) && scorerScore !== null) {
    roles.push(createRole("leadScorer", scorerScore, [
      `Scoring: ${formatPercentile(p.scoring)} in this comparison pool.`,
      `Points per 36: ${round(values.scoring, 1)}.`,
    ], profile));
  }

  const shootingScore = weightedSignal(p, [["threePointPct", 0.55], ["efficiency", 0.2], ["threePointVolume", 0.25]]);
  const hasShooting = percentileOrThreshold(p.threePointPct, values.threePointPct, 0.7, 0.37, profileCount);
  if (hasShooting && shootingScore !== null) {
    roles.push(createRole("perimeterShooter", shootingScore, [
      `Three-point accuracy: ${formatPercentile(p.threePointPct)} in this comparison pool.`,
      `Three-point percentage: ${round((values.threePointPct ?? 0) * 100, 1)}%.`,
    ], profile));
  }
  const hasMovementShooter = profile.evidence.hasThreePointVolume
    && hasShooting
    && percentileOrThreshold(p.threePointVolume, values.threePointVolume, 0.6, 4, profileCount);
  if (hasMovementShooter && shootingScore !== null) {
    roles.push(createRole("movementShooter", shootingScore, [
      `Three-point accuracy: ${formatPercentile(p.threePointPct)}.`,
      `${profile.values.threePointVolumeUnit === "attempt-rate" ? "Three-point attempt rate" : "Three-point volume"}: ${round(values.threePointVolume, 2)} (${profile.evidence.threePointVolumeMethod}).`,
      "This is a shooting-volume signal, not tracking-data proof of off-ball movement.",
    ], profile));
  }

  const connectorScore = weightedSignal(p, [["playmaking", 0.5], ["turnovers", 0.35], ["efficiency", 0.15]]);
  if (
    !hasPrimaryCreator
    && percentileOrThreshold(p.playmaking, values.playmaking, 0.45, 2.5, profileCount)
    && percentileOrThreshold(p.turnovers, values.turnovers === null ? null : -values.turnovers, 0.45, -3, profileCount)
    && connectorScore !== null
  ) {
    roles.push(createRole("connector", connectorScore, [
      `Playmaking: ${formatPercentile(p.playmaking)}.`,
      `Ball security: ${formatPercentile(p.turnovers)} (lower turnovers rank better).`,
    ], profile));
  }

  const rimScore = weightedSignal(p, [["blocks", 0.75], ["rebounding", 0.25]]);
  if (
    profile.positions.some((position) => position === "F" || position === "C")
    && percentileOrThreshold(p.blocks, values.blocks, 0.72, 1.5, profileCount)
    && rimScore !== null
  ) {
    roles.push(createRole("rimProtector", rimScore, [
      `Blocks: ${formatPercentile(p.blocks)} in this comparison pool.`,
      `Blocks per 36: ${round(values.blocks, 1)}.`,
    ], profile));
  }

  const switchScore = weightedSignal(p, [["stocks", 0.65], ["steals", 0.2], ["blocks", 0.15]]);
  if (
    profile.positions.length >= 2
    && percentileOrThreshold(p.stocks, values.stocks, 0.68, 2.2, profileCount)
    && switchScore !== null
  ) {
    roles.push(createRole("switchDefender", switchScore, [
      `Eligible positions: ${profile.positions.join("/") || "not supplied"}.`,
      `Stocks per 36: ${round(values.stocks, 1)} (${formatPercentile(p.stocks)}).`,
      "This is a box-score proxy; matchup tracking is needed to verify switch assignments.",
    ], profile));
  }

  const reboundScore = weightedSignal(p, [["totalReboundPct", 0.6], ["rebounding", 0.4]]);
  if (
    percentileOrThreshold(
      p.totalReboundPct ?? p.rebounding,
      values.totalReboundPct ?? values.rebounding,
      0.72,
      8,
      profileCount,
    )
    && reboundScore !== null
  ) {
    roles.push(createRole("rebounder", reboundScore, [
      `Rebounding: ${formatPercentile(p.totalReboundPct ?? p.rebounding)} in this comparison pool.`,
      values.totalReboundPct !== undefined
        ? `Reported total rebound rate: ${round(values.totalReboundPct * 100, 1)}%.`
        : `Rebounds per 36: ${round(values.rebounding, 1)}.`,
    ], profile));
  }

  const disruptorScore = weightedSignal(p, [["stocks", 0.7], ["steals", 0.15], ["blocks", 0.15]]);
  if (percentileOrThreshold(p.stocks, values.stocks, 0.72, 2.2, profileCount) && disruptorScore !== null) {
    roles.push(createRole("disruptor", disruptorScore, [
      `Stocks per 36: ${round(values.stocks, 1)}.`,
      `Stocks: ${formatPercentile(p.stocks)} in this comparison pool.`,
    ], profile));
  }

  return roles.sort((left, right) => (right.score - left.score) || stableCompare(left.id, right.id));
}

/**
 * Classify every player in a coherent comparison pool at once. All relative
 * labels use the passed `referencePlayers` (or the player list itself), so a
 * UI can state exactly what "top" means. It returns a Map for convenient UI
 * lookup and an ordered array for JSON/report rendering.
 */
export function classifyPlayerSeasonRolePool(players, options = {}) {
  const selected = Array.isArray(players) ? players : [];
  const reference = Array.isArray(options.referencePlayers) && options.referencePlayers.length > 0
    ? options.referencePlayers
    : selected;
  const referenceProfiles = dedupePlayers(reference).map((player, index) => buildRoleProfile(player, options, index));
  const selectedProfiles = dedupePlayers(selected).map((player, index) => buildRoleProfile(player, options, index));
  const allProfiles = [...referenceProfiles];
  const knownIds = new Set(allProfiles.map((profile) => profile.id));
  for (const profile of selectedProfiles) {
    if (!knownIds.has(profile.id)) {
      allProfiles.push(profile);
      knownIds.add(profile.id);
    }
  }
  const ranks = rolePercentiles(allProfiles);
  const byId = new Map();
  const records = selectedProfiles.map((profile) => {
    const percentiles = ranks.get(profile.id) || {};
    const roles = classifyProfile(profile, percentiles, allProfiles.length);
    const caveats = [];
    if (!profile.evidence.hasThreePointVolume) {
      caveats.push("Three-point volume is unavailable, so the movement-shooting proxy is withheld.");
    }
    if (!profile.reliability.reliable) caveats.push(profile.reliability.message);
    const record = {
      playerId: profile.id,
      playerName: profile.name,
      positions: [...profile.positions],
      sample: { ...profile.sample },
      reliability: profile.reliability,
      values: { ...profile.values },
      percentiles,
      roles,
      caveats,
    };
    byId.set(profile.id, record);
    return record;
  });
  return {
    referencePlayerCount: allProfiles.length,
    comparisonLabel: String(options.comparisonLabel || "selected comparison pool"),
    byId,
    records,
  };
}

/** Classify one player while retaining the same documented comparison logic. */
export function classifyPlayerSeasonRoles(player, options = {}) {
  const reference = Array.isArray(options.referencePlayers) ? options.referencePlayers : [];
  const pool = classifyPlayerSeasonRolePool([player], { ...options, referencePlayers: [...reference, player] });
  return pool.records[0] || null;
}

function roleCoverageStatus(matches, target, evidenceAvailable) {
  if (!evidenceAvailable) return "unassessed";
  if (matches.length >= target) return "covered";
  if (matches.length > 0) return "thin";
  return "gap";
}

/**
 * Produce a role matrix plus plain-language group strengths and gaps. A gap is
 * a planning signal, not a claim that a real NBA lineup cannot function. The
 * caller can set `roleTargets` to represent a particular game plan.
 */
export function analyzeRoleCoverage(players, options = {}) {
  const selected = Array.isArray(players) ? players : [];
  const classification = classifyPlayerSeasonRolePool(selected, options);
  const roleTargets = options.roleTargets && typeof options.roleTargets === "object" ? options.roleTargets : {};
  // A role inferred from a very short stint can still be useful context on a
  // player card, but it should not let a lineup claim a fully covered role.
  // Advanced users can deliberately opt in when comparing a small tournament
  // or postseason sample; the default remains conservative for fan reports.
  const includeProvisionalRoleCoverage = options.includeProvisionalRoleCoverage === true;
  const rows = classification.records.map((record) => ({
    playerId: record.playerId,
    playerName: record.playerName,
    positions: record.positions,
    roles: Object.fromEntries(FAN_ROLE_DEFINITIONS.map((definition) => {
      const match = record.roles.find((role) => role.id === definition.id);
      return [definition.id, match || null];
    })),
  }));
  const coverage = FAN_ROLE_DEFINITIONS.map((definition) => {
    const target = Math.max(0, Math.floor(nonNegativeNumber(roleTargets[definition.id]) ?? definition.target));
    const allMatches = classification.records
      .map((record) => ({ record, role: record.roles.find((role) => role.id === definition.id) }))
      .filter((entry) => entry.role)
      .sort((left, right) => (right.role.score - left.role.score) || stableCompare(left.record.playerId, right.record.playerId));
    const provisionalMatches = allMatches.filter((entry) => entry.role.confidence === "small-sample");
    const matches = includeProvisionalRoleCoverage
      ? allMatches
      : allMatches.filter((entry) => entry.role.confidence !== "small-sample");
    const evidenceAvailable = definition.id !== "movementShooter"
      || classification.records.some((record) => record.values.threePointVolume !== null);
    const status = roleCoverageStatus(matches, target, evidenceAvailable);
    const baseMessage = status === "covered"
      ? `${matches.length} selected player${matches.length === 1 ? "" : "s"} cover ${definition.label.toLowerCase()}.`
      : status === "thin"
        ? `Only ${matches.length} selected player covers ${definition.label.toLowerCase()}; this is thin for a target of ${target}.`
        : status === "gap"
          ? `No selected player reaches the current ${definition.label.toLowerCase()} signal.`
          : `${definition.label} is not assessed because required source evidence is unavailable.`;
    const message = provisionalMatches.length > 0 && !includeProvisionalRoleCoverage
      ? `${baseMessage} ${provisionalMatches.length} provisional small-sample signal${provisionalMatches.length === 1 ? " is" : "s are"} shown in the matrix but not counted toward coverage.`
      : baseMessage;
    return {
      roleId: definition.id,
      label: definition.label,
      target,
      status,
      evidenceMode: definition.evidence,
      coverageUsesProvisional: includeProvisionalRoleCoverage,
      players: matches.map(({ record, role }) => ({
        playerId: record.playerId,
        playerName: record.playerName,
        score: role.score,
        confidence: role.confidence,
      })),
      provisionalPlayers: provisionalMatches.map(({ record, role }) => ({
        playerId: record.playerId,
        playerName: record.playerName,
        score: role.score,
        confidence: role.confidence,
      })),
      message,
    };
  });
  const strengths = coverage.filter((item) => item.status === "covered");
  const deficiencies = coverage.filter((item) => item.status === "thin" || item.status === "gap");
  const provisionalSignalCount = coverage.reduce((total, item) => total + item.provisionalPlayers.length, 0);
  const caveats = [...new Set([
    ...classification.records.flatMap((record) => record.caveats),
    ...(provisionalSignalCount > 0 && !includeProvisionalRoleCoverage
      ? [`${provisionalSignalCount} provisional small-sample role signal${provisionalSignalCount === 1 ? " is" : "s are"} visible but excluded from role-coverage strengths by default.`]
      : []),
  ])];
  return {
    comparisonLabel: classification.comparisonLabel,
    referencePlayerCount: classification.referencePlayerCount,
    matrix: rows,
    coverage,
    strengths,
    deficiencies,
    provisionalSignalCount,
    coverageUsesProvisional: includeProvisionalRoleCoverage,
    caveats,
  };
}

function normalizedWeights(weights = {}) {
  const valid = FAN_OBJECTIVE_METRICS.map((metric) => [metric, nonNegativeNumber(weights?.[metric]) ?? 0]);
  const total = valid.reduce((sum, [, value]) => sum + value, 0);
  if (total > 0) return Object.fromEntries(valid.map(([metric, value]) => [metric, value / total]));
  // A caller may request an explanation without an optimizer config. Equal
  // weights provide a neutral *profile* explanation but are labelled as such.
  return Object.fromEntries(valid.map(([metric]) => [metric, 1 / valid.length]));
}

function objectiveValue(player, metric, scoringBasis = "perGame") {
  const value = metric === "ballSecurity"
    ? nonNegativeNumber(player?.turnovers)
    : FAN_EFFICIENCY_METRICS.includes(metric)
      ? readFromCandidates([player?.[metric]], { percentage: true })
      : nonNegativeNumber(player?.[metric]);
  if (value === null || scoringBasis !== "per36" || !PER_36_OBJECTIVE_METRICS.has(metric)) {
    return value;
  }
  const minutes = nonNegativeNumber(player?.minutes);
  // Match optimizer-core exactly: a validated zero-minute source row has no
  // meaningful rate and receives a conservative zero rather than an invented
  // infinite value or an unexplained "unavailable" display.
  return minutes === null ? null : minutes > 0 ? (value / minutes) * 36 : 0;
}

function objectivePercentiles(players, { scoringBasis = "perGame" } = {}) {
  const maps = {};
  for (const metric of FAN_OBJECTIVE_METRICS) {
    maps[metric] = percentileRanks(players, (player) => objectiveValue(player, metric, scoringBasis), {
      lowerIsBetter: metric === "ballSecurity",
    });
  }
  return maps;
}

function optimizerPercentile(playerContribution, metric) {
  const raw = playerContribution?.metrics?.[metric]?.percentile;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function weightedProfile(
  player,
  percentileMaps,
  weights,
  { scoringBasis = "perGame", playerContribution = null } = {},
) {
  const id = playerId(player);
  const normalized = normalizedWeights(weights);
  const contributions = FAN_OBJECTIVE_METRICS.map((metric) => {
    const optimizerEvidence = optimizerPercentile(playerContribution, metric);
    const percentile = optimizerEvidence ?? percentileMaps[metric]?.get(id);
    const raw = objectiveValue(player, metric, scoringBasis);
    const weight = normalized[metric];
    return {
      metric,
      label: FAN_METRIC_LABELS[metric],
      value: raw,
      valueBasis: scoringBasis === "per36" && PER_36_OBJECTIVE_METRICS.has(metric)
        ? "per36"
        : FAN_EFFICIENCY_METRICS.includes(metric) ? "rate" : "perGame",
      percentile: Number.isFinite(percentile) ? percentile : null,
      percentileSource: optimizerEvidence === null ? "recomputed" : "optimizer",
      weight: round(weight, 4),
      weightedContribution: Number.isFinite(percentile) ? round(percentile * weight, 4) : 0,
      lowerIsBetter: metric === "ballSecurity",
    };
  });
  const score = contributions.reduce((total, item) => total + item.weightedContribution, 0);
  const strongest = contributions
    .filter((item) => item.weight > 0 && item.percentile !== null)
    .sort((left, right) => (right.weightedContribution - left.weightedContribution) || stableCompare(left.metric, right.metric));
  const tradeoffs = contributions
    .filter((item) => item.weight > 0 && item.percentile !== null)
    .sort((left, right) => (left.percentile - right.percentile) || stableCompare(left.metric, right.metric));
  return {
    poolRelativeProfileScore: round(score * 100, 1),
    contributions,
    strongest: strongest.slice(0, 3),
    tradeoffs: tradeoffs.slice(0, 2),
  };
}

function formatObjectiveReason(item) {
  const percentile = formatPercentile(item.percentile);
  const value = item.value === null ? "unavailable" : item.metric.endsWith("Pct")
    ? `${round(item.value * 100, 1)}%`
    : round(item.value, 1);
  const unit = item.value !== null && item.valueBasis === "per36" ? " per 36" : "";
  return `${item.label}: ${value}${unit} (${percentile}; ${Math.round(item.weight * 100)}% of this objective).`;
}

function lineupPlayers(lineup) {
  return Array.isArray(lineup?.players) ? lineup.players : [];
}

function totalDeltas(best, alternative) {
  const metrics = ["points", "rebounds", "assists", "steals", "blocks", "turnovers"];
  const deltas = metrics.map((metric) => {
    const bestValue = finiteNumber(best?.totals?.[metric]);
    const alternativeValue = finiteNumber(alternative?.totals?.[metric]);
    if (bestValue === null || alternativeValue === null) return null;
    const delta = alternativeValue - bestValue;
    return {
      metric,
      label: FAN_METRIC_LABELS[metric],
      delta: round(delta, 2),
      benefit: metric === "turnovers" ? -delta : delta,
      lowerIsBetter: metric === "turnovers",
    };
  }).filter(Boolean);
  return deltas.sort((left, right) => Math.abs(right.benefit) - Math.abs(left.benefit));
}

function replacementSummary(removed, added, scoreGap, deltas) {
  const people = `Out: ${removed.map((player) => player.name || player.id).join(", ") || "none"}; in: ${added.map((player) => player.name || player.id).join(", ") || "none"}`;
  const significant = deltas.filter((delta) => Math.abs(delta.delta) >= 0.05).slice(0, 2);
  const production = significant.length === 0
    ? "near-identical reported production"
    : significant.map((delta) => `${delta.delta >= 0 ? "+" : ""}${delta.delta} ${delta.label}`).join(", ");
  return `${people}. Fit change: ${scoreGap === null ? "unavailable" : `-${round(scoreGap, 2)}`}. Main production change: ${production}.`;
}

/**
 * Summarize exact alternatives returned by the optimizer. It does not invent
 * a replacement from a similar-looking player: every returned replacement is
 * a solver-ranked feasible alternative supplied by the caller.
 */
export function summarizeReplacementAlternatives(best, alternatives, options = {}) {
  if (!best || !Array.isArray(best.players)) {
    return { available: false, alternatives: [], byRemovedPlayerId: {}, caveats: ["A selected optimizer result is required."] };
  }
  const bestIds = new Set(lineupPlayers(best).map((player) => playerId(player)));
  const source = Array.isArray(alternatives) ? alternatives : [];
  const summaries = source
    .filter((alternative) => alternative && alternative !== best && Array.isArray(alternative.players))
    .map((alternative) => {
      const alternativeIds = new Set(lineupPlayers(alternative).map((player) => playerId(player)));
      const removed = lineupPlayers(best).filter((player) => !alternativeIds.has(playerId(player)));
      const added = lineupPlayers(alternative).filter((player) => !bestIds.has(playerId(player)));
      if (removed.length === 0 && added.length === 0) return null;
      const bestScore = finiteNumber(best.score);
      const alternativeScore = finiteNumber(alternative.score);
      const scoreGap = bestScore !== null && alternativeScore !== null ? Math.max(0, bestScore - alternativeScore) : null;
      const deltas = totalDeltas(best, alternative);
      return {
        rank: Number(alternative.rank) || null,
        score: alternativeScore,
        scoreGap: scoreGap === null ? null : round(scoreGap, 3),
        changedPlayerCount: removed.length + added.length,
        removed: removed.map((player) => ({ id: playerId(player), name: playerName(player) })),
        added: added.map((player) => ({ id: playerId(player), name: playerName(player) })),
        productionDeltas: deltas,
        summary: replacementSummary(removed, added, scoreGap, deltas),
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      (left.changedPlayerCount - right.changedPlayerCount)
      || ((left.scoreGap ?? Number.POSITIVE_INFINITY) - (right.scoreGap ?? Number.POSITIVE_INFINITY))
      || ((left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY))
    ));
  const limit = Math.max(1, Math.floor(nonNegativeNumber(options.limit) ?? 5));
  const limited = summaries.slice(0, limit);
  const byRemovedPlayerId = {};
  for (const player of lineupPlayers(best)) {
    const id = playerId(player);
    byRemovedPlayerId[id] = summaries.find((summary) => summary.removed.some((item) => item.id === id)) || null;
  }
  return {
    available: limited.length > 0,
    alternatives: limited,
    byRemovedPlayerId,
    caveats: limited.length > 0
      ? ["Replacement rows describe solver-ranked alternatives returned in this result set; they are not independent player projections."]
      : ["No alternative lineup was supplied, so no exact replacement change can be shown."],
  };
}

/**
 * Explain the selected exact lineup or rotation without re-solving it.
 *
 * The selection layer remains the optimizer: this function only translates
 * pool-relative objective contributions, roles, sample context, and supplied
 * exact alternatives into fan-readable evidence.
 */
export function explainOptimizationSelection(resultOrBest, options = {}) {
  const result = resultOrBest && resultOrBest.best ? resultOrBest : { best: resultOrBest };
  const best = result?.best;
  if (!best || !Array.isArray(best.players)) {
    return {
      available: false,
      selectedPlayers: [],
      roleCoverage: null,
      replacements: { available: false, alternatives: [], byRemovedPlayerId: {}, caveats: ["No selected optimizer result is available."] },
      caveats: ["Run a feasible exact optimization before requesting an explanation."],
    };
  }
  const candidatePool = Array.isArray(options.candidatePool) && options.candidatePool.length > 0
    ? options.candidatePool
    : best.players;
  const poolWithSelected = dedupePlayers([...candidatePool, ...best.players]);
  const scoringBasis = best.rotation && result?.diagnostics?.rotationScoringBasis === "per36"
    ? "per36"
    : "perGame";
  const percentileMaps = objectivePercentiles(poolWithSelected, { scoringBasis });
  const weights = options.weights || result?.config?.weights || {};
  const roleCoverage = analyzeRoleCoverage(best.players, {
    ...options,
    referencePlayers: options.referencePlayers || poolWithSelected,
    comparisonLabel: options.comparisonLabel || "eligible, non-excluded player pool",
  });
  const selectedPlayers = best.players.map((player, index) => {
    const id = playerId(player, index);
    const profile = weightedProfile(player, percentileMaps, weights, {
      scoringBasis,
      playerContribution: best.playerContributions?.[id] ?? null,
    });
    const roles = roleCoverage.matrix.find((row) => row.playerId === id)?.roles || {};
    const activeRoles = Object.values(roles).filter(Boolean);
    return {
      playerId: id,
      playerName: playerName(player, index),
      positions: normalizePositions(player.positions),
      sample: sampleForPlayer(player, contextForPlayer(player, options)),
      profile,
      roles: activeRoles,
      whySelected: profile.strongest.map(formatObjectiveReason),
      watchOutFor: profile.tradeoffs.map(formatObjectiveReason),
    };
  });
  const alternatives = Array.isArray(result?.alternatives)
    ? result.alternatives
    : Array.isArray(options.alternatives) ? options.alternatives : [];
  const replacements = summarizeReplacementAlternatives(best, alternatives, options);
  const caveats = [
    "Objective contribution is pool-relative and explains the configured strategy; it is not a win probability or player projection.",
    ...(best.rotation && scoringBasis === "per36"
      ? ["Rotation counting-stat explanations use per-36 values and the optimizer's exact percentile evidence when it is available."]
      : []),
    ...(result?.diagnostics?.rotationRateStabilityEvidence?.applied
      ? ["Optimizer percentiles include the configured sample adjustment; displayed per-36 values remain the observed raw rates."]
      : []),
    ...(roleCoverage.caveats || []),
    ...(replacements.caveats || []),
  ];
  return {
    available: true,
    mode: best.rotation ? "rotation" : "lineup",
    objectiveScoringBasis: scoringBasis,
    selectedPlayers,
    roleCoverage,
    replacements,
    constraintAudit: best.constraintAudit ? { ...best.constraintAudit } : null,
    caveats: [...new Set(caveats)],
  };
}
