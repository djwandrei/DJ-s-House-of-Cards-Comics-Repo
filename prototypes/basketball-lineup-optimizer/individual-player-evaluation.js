import { derivePlayerRateViews } from "./fan-analytics.js?v=__LINEUP_LAB_ASSET_VERSION__";

/**
 * Individual advanced-stat evaluation for player-season products.
 *
 * Every comparison is scoped to a caller-supplied cohort. Metrics whose high
 * values are not inherently better (usage and shot-frequency rates) receive a
 * descriptive percentile but never increase a quality index. Cumulative
 * metrics remain labeled as cumulative, and possession-adjusted inputs must
 * pass provenance and independent box-score reconciliation gates.
 */

export const INDIVIDUAL_EVALUATION_VERSION = "individual-player-evaluation-v1";

export const ADVANCED_METRIC_DEFINITIONS = Object.freeze({
  playerEfficiencyRating: Object.freeze({
    label: "Player efficiency rating", aliases: Object.freeze(["player_efficiency_rating", "playerEfficiencyRating", "per"]),
    category: "boxImpact", direction: "higher", unit: "index", evidenceMode: "advanced-box-model",
  }),
  trueShootingPercentage: Object.freeze({
    label: "True shooting percentage", aliases: Object.freeze(["true_shooting_percentage", "trueShootingPercentage", "trueShootingPct", "ts_pct", "tsPct"]),
    category: "scoringEfficiency", direction: "higher", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  threePointAttemptRate: Object.freeze({
    label: "Three-point attempt rate", aliases: Object.freeze(["three_point_attempt_rate", "threePointAttemptRate", "fg3a_per_fga_pct"]),
    category: "shotProfile", direction: "descriptive", unit: "3PA per FGA", evidenceMode: "advanced-box-score", percentage: true,
  }),
  freeThrowAttemptRate: Object.freeze({
    label: "Free-throw attempt rate", aliases: Object.freeze(["free_throw_attempt_rate", "freeThrowAttemptRate", "fta_per_fga_pct"]),
    category: "shotProfile", direction: "descriptive", unit: "FTA per FGA", evidenceMode: "advanced-box-score", percentage: true,
  }),
  offensiveReboundPercentage: Object.freeze({
    label: "Offensive rebound percentage", aliases: Object.freeze(["offensive_rebound_percentage", "offensiveReboundPercentage", "orb_pct", "orbPct"]),
    category: "rebounding", direction: "higher", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  defensiveReboundPercentage: Object.freeze({
    label: "Defensive rebound percentage", aliases: Object.freeze(["defensive_rebound_percentage", "defensiveReboundPercentage", "drb_pct", "drbPct"]),
    category: "rebounding", direction: "higher", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  totalReboundPercentage: Object.freeze({
    label: "Total rebound percentage", aliases: Object.freeze(["total_rebound_percentage", "totalReboundPercentage", "trb_pct", "trbPct"]),
    category: "rebounding", direction: "higher", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  assistPercentage: Object.freeze({
    label: "Assist percentage", aliases: Object.freeze(["assist_percentage", "assistPercentage", "ast_pct", "astPct"]),
    category: "creation", direction: "higher", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  stealPercentage: Object.freeze({
    label: "Steal percentage", aliases: Object.freeze(["steal_percentage", "stealPercentage", "stl_pct", "stlPct"]),
    category: "defense", direction: "higher", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  blockPercentage: Object.freeze({
    label: "Block percentage", aliases: Object.freeze(["block_percentage", "blockPercentage", "blk_pct", "blkPct"]),
    category: "defense", direction: "higher", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  turnoverPercentage: Object.freeze({
    label: "Turnover percentage", aliases: Object.freeze(["turnover_percentage", "turnoverPercentage", "tov_pct", "tovPct"]),
    category: "creation", direction: "lower", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  usagePercentage: Object.freeze({
    label: "Usage percentage", aliases: Object.freeze(["usage_percentage", "usagePercentage", "usage_pct", "usagePct", "usg_pct", "usgPct", "usg"]),
    category: "roleContext", direction: "descriptive", unit: "share", evidenceMode: "advanced-box-score", percentage: true,
  }),
  offensiveWinShares: Object.freeze({
    label: "Offensive win shares", aliases: Object.freeze(["offensive_win_shares", "offensiveWinShares", "ows"]),
    category: "boxImpact", direction: "higher", unit: "wins estimate", evidenceMode: "advanced-box-model", cumulative: true,
  }),
  defensiveWinShares: Object.freeze({
    label: "Defensive win shares", aliases: Object.freeze(["defensive_win_shares", "defensiveWinShares", "dws"]),
    category: "boxImpact", direction: "higher", unit: "wins estimate", evidenceMode: "advanced-box-model", cumulative: true,
  }),
  winShares: Object.freeze({
    label: "Win shares", aliases: Object.freeze(["win_shares", "winShares", "ws"]),
    category: "boxImpact", direction: "higher", unit: "wins estimate", evidenceMode: "advanced-box-model", cumulative: true,
  }),
  winSharesPer48: Object.freeze({
    label: "Win shares per 48", aliases: Object.freeze(["win_shares_per_48", "winSharesPer48", "ws_per_48", "wsPer48"]),
    category: "boxImpact", direction: "higher", unit: "wins estimate per 48", evidenceMode: "advanced-box-model",
  }),
  offensiveBoxPlusMinus: Object.freeze({
    label: "Offensive box plus-minus", aliases: Object.freeze(["offensive_box_plus_minus", "offensiveBoxPlusMinus", "obpm"]),
    category: "boxImpact", direction: "higher", unit: "points per 100 estimate", evidenceMode: "advanced-box-model",
  }),
  defensiveBoxPlusMinus: Object.freeze({
    label: "Defensive box plus-minus", aliases: Object.freeze(["defensive_box_plus_minus", "defensiveBoxPlusMinus", "dbpm"]),
    category: "boxImpact", direction: "higher", unit: "points per 100 estimate", evidenceMode: "advanced-box-model",
  }),
  boxPlusMinus: Object.freeze({
    label: "Box plus-minus", aliases: Object.freeze(["box_plus_minus", "boxPlusMinus", "bpm"]),
    category: "boxImpact", direction: "higher", unit: "points per 100 estimate", evidenceMode: "advanced-box-model",
  }),
  valueOverReplacement: Object.freeze({
    label: "Value over replacement player", aliases: Object.freeze(["value_over_replacement_player", "valueOverReplacementPlayer", "vorp"]),
    category: "boxImpact", direction: "higher", unit: "wins estimate", evidenceMode: "advanced-box-model", cumulative: true,
  }),
  offensiveRapm: Object.freeze({
    label: "Offensive RAPM", aliases: Object.freeze([]), category: "possessionImpact", direction: "higher",
    unit: "points per 100 estimate", evidenceMode: "validated-possession-model", derived: true,
  }),
  defensiveRapm: Object.freeze({
    label: "Defensive RAPM", aliases: Object.freeze([]), category: "possessionImpact", direction: "higher",
    unit: "points per 100 estimate", evidenceMode: "validated-possession-model", derived: true,
  }),
  totalRapm: Object.freeze({
    label: "Total RAPM", aliases: Object.freeze([]), category: "possessionImpact", direction: "higher",
    unit: "points per 100 estimate", evidenceMode: "validated-possession-model", derived: true,
  }),
});

export const ADVANCED_EVALUATION_CATEGORIES = Object.freeze({
  scoringEfficiency: Object.freeze({ label: "Scoring efficiency" }),
  shotProfile: Object.freeze({ label: "Shot profile" }),
  creation: Object.freeze({ label: "Creation and ball security" }),
  rebounding: Object.freeze({ label: "Rebounding" }),
  defense: Object.freeze({ label: "Defensive box events" }),
  roleContext: Object.freeze({ label: "Role context" }),
  boxImpact: Object.freeze({ label: "Box-score impact models" }),
  possessionImpact: Object.freeze({ label: "Possession-adjusted impact" }),
});

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value) {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function percentage(value) {
  const parsed = nonNegative(value);
  if (parsed === null) return null;
  if (parsed <= 1) return parsed;
  return parsed <= 100 ? parsed / 100 : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function playerId(player, index = 0) {
  return String(player?.id ?? player?.playerId ?? `player-${index + 1}`);
}

function playerName(player, index = 0) {
  return String(player?.name ?? player?.playerName ?? `Player ${index + 1}`);
}

function dedupePlayers(players) {
  const result = [];
  const seen = new Set();
  for (const [index, player] of (Array.isArray(players) ? players : []).entries()) {
    const id = playerId(player, index);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(player);
  }
  return result;
}

function advancedSources(player) {
  return [player?.analytics?.seasonAdvanced, player?.analytics?.advanced]
    .filter((source) => source && typeof source === "object" && !Array.isArray(source));
}

function readAdvancedMetric(player, definition) {
  for (const source of advancedSources(player)) {
    for (const alias of definition.aliases) {
      if (!Object.hasOwn(source, alias)) continue;
      const value = definition.percentage ? percentage(source[alias]) : finite(source[alias]);
      if (value !== null) return value;
    }
  }
  return null;
}

function evidenceById(source, id) {
  if (source instanceof Map) return source.get(id) || null;
  if (source && typeof source === "object" && !Array.isArray(source)) return source[id] || null;
  return null;
}

function normalizedPossessionImpact(evidence) {
  if (!evidence) return { available: false, reason: "No possession-adjusted impact evidence was supplied." };
  if (
    evidence?.validation?.sourceProvenancePassed !== true
    || evidence?.validation?.boxScoreReconciled !== true
    || evidence.displayEligible === false
  ) {
    return {
      available: false,
      reason: "Possession impact requires validated provenance, independent box-score reconciliation, and display eligibility.",
    };
  }
  const offense = finite(evidence.offensiveRapm ?? evidence.offensive_rapm ?? evidence.offense);
  const defense = finite(evidence.defensiveRapm ?? evidence.defensive_rapm ?? evidence.defense);
  const reliability = finite(evidence.reliability);
  if (offense === null || defense === null || reliability === null || reliability < 0 || reliability > 1) {
    return { available: false, reason: "Offensive RAPM, defensive RAPM, and a 0-1 reliability value are required." };
  }
  const modelVersion = String(evidence.modelVersion || "").trim();
  if (!modelVersion) return { available: false, reason: "A possession-impact model version is required." };
  return {
    available: true,
    offensiveRapm: offense,
    defensiveRapm: defense,
    totalRapm: offense + defense,
    reliability,
    alreadyRegularized: evidence.alreadyRegularized === true,
    modelVersion,
    source: String(evidence.source || "validated derived possession evidence"),
    uncertainty: evidence.uncertainty && typeof evidence.uncertainty === "object"
      ? { ...evidence.uncertainty }
      : null,
  };
}

function rawRecord(player, index, impactEvidenceById) {
  const id = playerId(player, index);
  const metrics = {};
  for (const [metricId, definition] of Object.entries(ADVANCED_METRIC_DEFINITIONS)) {
    if (!definition.derived) metrics[metricId] = readAdvancedMetric(player, definition);
  }
  const possessionImpact = normalizedPossessionImpact(evidenceById(impactEvidenceById, id));
  metrics.offensiveRapm = possessionImpact.available ? possessionImpact.offensiveRapm : null;
  metrics.defensiveRapm = possessionImpact.available ? possessionImpact.defensiveRapm : null;
  metrics.totalRapm = possessionImpact.available ? possessionImpact.totalRapm : null;
  return { id, name: playerName(player, index), player, metrics, possessionImpact };
}

function ranksForMetric(records, metricId, direction) {
  const entries = records
    .map((record) => ({ id: record.id, value: record.metrics[metricId] }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) => (left.value - right.value) || left.id.localeCompare(right.id));
  const result = new Map();
  if (entries.length === 0) return result;
  if (entries.length === 1) return new Map([[entries[0].id, 1]]);
  let start = 0;
  while (start < entries.length) {
    let end = start;
    while (end + 1 < entries.length && entries[end + 1].value === entries[start].value) end += 1;
    const ascending = ((start + end) / 2) / (entries.length - 1);
    const percentile = direction === "lower" ? 1 - ascending : ascending;
    for (let index = start; index <= end; index += 1) result.set(entries[index].id, percentile);
    start = end + 1;
  }
  return result;
}

function sampleForPlayer(player) {
  const seasonTotals = player?.analytics?.seasonTotals;
  const games = nonNegative(seasonTotals?.games) ?? nonNegative(player?.games);
  const totalMinutes = nonNegative(seasonTotals?.minutes)
    ?? (games !== null && nonNegative(player?.minutes) !== null ? games * nonNegative(player.minutes) : null);
  const minimumGames = 10;
  const minimumMinutes = 200;
  const reliable = games !== null && totalMinutes !== null && games >= minimumGames && totalMinutes >= minimumMinutes;
  return {
    games,
    totalMinutes: totalMinutes === null ? null : round(totalMinutes, 1),
    reliable,
    thresholds: { minimumGames, minimumMinutes },
    reason: reliable
      ? "Meets the advanced-profile sample guardrail."
      : "Limited evidence below 10 games or 200 total minutes.",
  };
}

function metricResult(metricId, raw, percentileRank, sample) {
  const definition = ADVANCED_METRIC_DEFINITIONS[metricId];
  const available = Number.isFinite(raw);
  const qualityEligible = available && definition.direction !== "descriptive";
  return {
    id: metricId,
    label: definition.label,
    category: definition.category,
    available,
    value: available ? round(raw, 5) : null,
    unit: definition.unit,
    direction: definition.direction,
    percentile: available && Number.isFinite(percentileRank) ? round(percentileRank * 100, 1) : null,
    qualityScore: qualityEligible && Number.isFinite(percentileRank) ? round(percentileRank, 4) : null,
    qualityEligible,
    evidenceMode: definition.evidenceMode,
    cumulative: definition.cumulative === true,
    confidence: available ? sample.reliable ? "standard" : "small-sample" : "unavailable",
    interpretation: !available
      ? "Unavailable in the supplied player evidence."
      : definition.direction === "descriptive"
        ? "Percentile describes role or frequency; higher is not automatically better."
        : definition.cumulative
          ? "Higher ranks better in this cohort, but the value accumulates with opportunity."
          : definition.direction === "lower"
            ? "Lower raw values rank better in this cohort."
            : "Higher raw values rank better in this cohort.",
  };
}

function categoryResult(categoryId, metrics) {
  const categoryMetrics = Object.values(metrics).filter((metric) => metric.category === categoryId);
  const qualityScores = categoryMetrics.map((metric) => metric.qualityScore).filter(Number.isFinite);
  const score = qualityScores.length > 0
    ? qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length
    : null;
  return {
    id: categoryId,
    label: ADVANCED_EVALUATION_CATEGORIES[categoryId].label,
    available: categoryMetrics.some((metric) => metric.available),
    qualityIndex: score === null ? null : round(score * 100, 1),
    qualityMetricCount: qualityScores.length,
    availableMetricCount: categoryMetrics.filter((metric) => metric.available).length,
    totalMetricCount: categoryMetrics.length,
    coverage: categoryMetrics.length > 0
      ? round(categoryMetrics.filter((metric) => metric.available).length / categoryMetrics.length, 3)
      : 0,
    aggregation: score === null ? "none" : "equal-weight directional metric percentiles",
    metricIds: categoryMetrics.map((metric) => metric.id),
  };
}

function normalizeCategoryWeights(weights) {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) return null;
  const entries = Object.keys(ADVANCED_EVALUATION_CATEGORIES)
    .map((id) => [id, nonNegative(weights[id]) ?? 0]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return total > 0 ? Object.fromEntries(entries.map(([id, value]) => [id, value / total])) : null;
}

function customComposite(categories, weights) {
  if (!weights) {
    return {
      available: false,
      index: null,
      weights: null,
      reason: "No default all-in-one player grade is imposed; supply explicit categoryWeights to create one.",
    };
  }
  const included = Object.entries(weights)
    .map(([id, weight]) => ({ id, weight, score: categories[id]?.qualityIndex }))
    .filter((entry) => entry.weight > 0 && Number.isFinite(entry.score));
  const availableWeight = included.reduce((sum, entry) => sum + entry.weight, 0);
  if (availableWeight <= 0) {
    return { available: false, index: null, weights, reason: "None of the weighted categories has a quality index." };
  }
  const index = included.reduce((sum, entry) => sum + entry.score * (entry.weight / availableWeight), 0);
  return {
    available: true,
    index: round(index, 1),
    weights,
    effectiveWeights: Object.fromEntries(included.map((entry) => [entry.id, round(entry.weight / availableWeight, 4)])),
    reason: "Caller-defined blend of available category indices; missing categories are disclosed and remaining weights are renormalized.",
  };
}

function highlights(metrics) {
  const ranked = Object.values(metrics).filter((metric) => metric.qualityEligible && Number.isFinite(metric.percentile));
  return {
    strengths: ranked.filter((metric) => metric.percentile >= 75)
      .sort((left, right) => right.percentile - left.percentile)
      .slice(0, 6)
      .map((metric) => ({ metricId: metric.id, label: metric.label, percentile: metric.percentile, value: metric.value, unit: metric.unit })),
    concerns: ranked.filter((metric) => metric.percentile <= 25)
      .sort((left, right) => left.percentile - right.percentile)
      .slice(0, 6)
      .map((metric) => ({ metricId: metric.id, label: metric.label, percentile: metric.percentile, value: metric.value, unit: metric.unit })),
    roleContext: Object.values(metrics).filter((metric) => metric.available && metric.direction === "descriptive")
      .map((metric) => ({ metricId: metric.id, label: metric.label, percentile: metric.percentile, value: metric.value, unit: metric.unit })),
  };
}

/**
 * Evaluate one or more player seasons against an explicit reference cohort.
 * The output retains every supported raw metric, directional percentile,
 * category coverage, sample reliability, and optional caller-weighted grade.
 */
export function evaluateIndividualPlayers(players, options = {}) {
  const selected = dedupePlayers(players);
  const suppliedReference = dedupePlayers(options.referencePlayers);
  const comparisonPlayers = dedupePlayers(suppliedReference.length > 0 ? [...suppliedReference, ...selected] : selected);
  const rawRecords = comparisonPlayers.map((player, index) => rawRecord(player, index, options.impactEvidenceById));
  const ranks = Object.fromEntries(Object.entries(ADVANCED_METRIC_DEFINITIONS).map(([metricId, definition]) => [
    metricId,
    ranksForMetric(rawRecords, metricId, definition.direction),
  ]));
  const selectedIds = new Set(selected.map((player, index) => playerId(player, index)));
  const categoryWeights = normalizeCategoryWeights(options.categoryWeights);
  const records = rawRecords.filter((record) => selectedIds.has(record.id)).map((record) => {
    const sample = sampleForPlayer(record.player);
    const metrics = Object.fromEntries(Object.keys(ADVANCED_METRIC_DEFINITIONS).map((metricId) => [
      metricId,
      metricResult(metricId, record.metrics[metricId], ranks[metricId].get(record.id), sample),
    ]));
    const categories = Object.fromEntries(Object.keys(ADVANCED_EVALUATION_CATEGORIES).map((categoryId) => [
      categoryId,
      categoryResult(categoryId, metrics),
    ]));
    const availableMetricCount = Object.values(metrics).filter((metric) => metric.available).length;
    const advancedBoxMetricCount = Object.values(metrics)
      .filter((metric) => metric.available && metric.evidenceMode !== "validated-possession-model").length;
    return {
      playerId: record.id,
      playerName: record.name,
      comparisonLabel: String(options.comparisonLabel || "selected comparison pool"),
      referencePlayerCount: comparisonPlayers.length,
      sample,
      coverage: {
        availableMetricCount,
        totalMetricCount: Object.keys(ADVANCED_METRIC_DEFINITIONS).length,
        advancedBoxMetricCount,
        possessionImpactAvailable: record.possessionImpact.available,
        ratio: round(availableMetricCount / Object.keys(ADVANCED_METRIC_DEFINITIONS).length, 3),
      },
      rateViews: derivePlayerRateViews(record.player, options),
      metrics,
      categories,
      customComposite: customComposite(categories, categoryWeights),
      highlights: highlights(metrics),
      possessionImpactEvidence: record.possessionImpact,
      caveats: [
        "Percentiles compare only with the explicitly labeled supplied cohort.",
        "Usage and shot-frequency percentiles describe style and role; they are not quality points.",
        "PER, BPM, win shares, and VORP are box-derived models and are not interchangeable with RAPM.",
        "Cumulative win shares and VORP reflect opportunity as well as rate performance.",
        "No default overall grade is created because player value depends on role, objective, sample, and model choice.",
        ...(sample.reliable ? [] : [sample.reason]),
        ...(comparisonPlayers.length < 5 ? ["Fewer than five comparison players makes percentile rankings unstable."] : []),
      ],
    };
  });
  return {
    version: INDIVIDUAL_EVALUATION_VERSION,
    comparisonLabel: String(options.comparisonLabel || "selected comparison pool"),
    referencePlayerCount: comparisonPlayers.length,
    categoryWeights,
    records,
    byId: new Map(records.map((record) => [record.playerId, record])),
  };
}

