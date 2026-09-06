import {
  classifyPlayerSeasonRolePool,
  derivePlayerRateViews,
} from "./fan-analytics.js?v=20260906a";
import {
  buildLineupRoleModel,
  scoreLineupRoleFit,
} from "./lineup-role-model.js?v=20260906a";
import { readPlayerUsage } from "./player-projection.js?v=20260906a";
import { evaluateIndividualPlayers } from "./individual-player-evaluation.js?v=20260906a";

/**
 * Shared, browser-safe analytics contracts for future basketball products.
 *
 * The module deliberately separates observed production, estimated impact,
 * and contextual fit. It uses only the existing public player envelope unless
 * a caller supplies separately validated derived evidence. Tracking-dependent
 * skills, causal chemistry, and forecast probabilities stay unavailable rather
 * than being imputed from box scores.
 */

export const PRODUCT_ANALYTICS_VERSION = "basketball-product-analytics-v1";

export const SKILL_DIMENSIONS = Object.freeze({
  scoringVolume: Object.freeze({ label: "Scoring volume", category: "scoring", weight: 0.35 }),
  scoringEfficiency: Object.freeze({ label: "Scoring efficiency", category: "scoring", weight: 0.35 }),
  perimeterAccuracy: Object.freeze({ label: "Perimeter accuracy", category: "scoring", weight: 0.15 }),
  freeThrowPressureProxy: Object.freeze({ label: "Free-throw pressure proxy", category: "scoring", weight: 0.15 }),
  playmaking: Object.freeze({ label: "Playmaking", category: "creation", weight: 0.45 }),
  usageLoad: Object.freeze({ label: "Observed usage load", category: "creation", weight: 0.25 }),
  ballSecurity: Object.freeze({ label: "Turnover avoidance", category: "creation", weight: 0.3 }),
  spacingProxy: Object.freeze({ label: "Spacing proxy", category: "offBall", weight: 1 }),
  defensiveActivity: Object.freeze({ label: "Defensive event activity", category: "defense", weight: 0.55 }),
  shotBlocking: Object.freeze({ label: "Shot blocking", category: "defense", weight: 0.45 }),
  rebounding: Object.freeze({ label: "Rebounding", category: "rebounding", weight: 1 }),
});

export const SKILL_CATEGORIES = Object.freeze({
  scoring: Object.freeze({ label: "Scoring" }),
  creation: Object.freeze({ label: "Creation" }),
  offBall: Object.freeze({ label: "Off-ball value" }),
  defense: Object.freeze({ label: "Defense" }),
  rebounding: Object.freeze({ label: "Rebounding" }),
});

const TRACKING_GAPS = Object.freeze([
  Object.freeze({
    group: "shot-and-action detail",
    skills: Object.freeze([
      "rim finishing", "contact finishing", "floaters", "post scoring", "midrange",
      "catch-and-shoot threes", "movement threes", "pull-up threes", "isolation scoring",
    ]),
    reason: "Requires shot-location, shot-type, or play-type evidence not present in the public box-score envelope.",
  }),
  Object.freeze({
    group: "creation mechanics",
    skills: Object.freeze([
      "handle", "first step", "rim pressure", "passing vision", "passing accuracy",
      "live-dribble passing", "pick-and-roll creation", "advantage creation",
    ]),
    reason: "Requires tracking, tagged video, or validated possession-event labels.",
  }),
  Object.freeze({
    group: "off-ball behavior",
    skills: Object.freeze(["cutting", "relocation", "screening", "gravity", "transition running"]),
    reason: "Three-point volume can support a spacing proxy but cannot establish movement or gravity.",
  }),
  Object.freeze({
    group: "defensive assignments",
    skills: Object.freeze([
      "point-of-attack defense", "screen navigation", "isolation defense", "help rotations",
      "switchability", "closeouts", "rim contests", "rebounding positioning",
    ]),
    reason: "Blocks, steals, positions, and BPM are outcomes or proxies, not assignment-level tracking.",
  }),
  Object.freeze({
    group: "physical and cognitive traits",
    skills: Object.freeze([
      "height", "length", "strength", "acceleration", "lateral movement", "vertical",
      "endurance", "decision-making", "anticipation", "processing speed", "awareness",
    ]),
    reason: "The current browser-safe player contract does not contain verified measurements or scouting grades.",
  }),
]);

const ARCHETYPE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "primaryCreator",
    label: "Primary creator",
    threshold: 0.62,
    signals: Object.freeze([["playmaking", 0.5], ["usageLoad", 0.3], ["scoringVolume", 0.2]]),
    required: Object.freeze(["playmaking", "usageLoad"]),
  }),
  Object.freeze({
    id: "secondaryCreator",
    label: "Secondary creator",
    threshold: 0.56,
    signals: Object.freeze([["playmaking", 0.45], ["ballSecurity", 0.35], ["scoringEfficiency", 0.2]]),
    required: Object.freeze(["playmaking", "ballSecurity"]),
  }),
  Object.freeze({
    id: "highVolumeShooter",
    label: "High-volume 3-point shooter",
    threshold: 0.58,
    signals: Object.freeze([["perimeterAccuracy", 0.45], ["spacingProxy", 0.55]]),
    required: Object.freeze(["perimeterAccuracy", "spacingProxy"]),
  }),
  Object.freeze({
    id: "connector",
    label: "Connector",
    threshold: 0.56,
    signals: Object.freeze([["playmaking", 0.45], ["ballSecurity", 0.4], ["scoringEfficiency", 0.15]]),
    required: Object.freeze(["playmaking", "ballSecurity"]),
  }),
  Object.freeze({
    id: "stretchBigProxy",
    label: "Stretch-big proxy",
    threshold: 0.58,
    signals: Object.freeze([["spacingProxy", 0.7], ["scoringEfficiency", 0.3]]),
    required: Object.freeze(["spacingProxy"]),
    position: "frontcourt",
  }),
  Object.freeze({
    id: "defensiveAnchorProxy",
    label: "Defensive-anchor proxy",
    threshold: 0.58,
    signals: Object.freeze([["shotBlocking", 0.5], ["rebounding", 0.3], ["defensiveActivity", 0.2]]),
    required: Object.freeze(["shotBlocking", "rebounding"]),
    position: "frontcourt",
  }),
  Object.freeze({
    id: "threeAndDActivityProxy",
    label: "3-and-D activity proxy",
    threshold: 0.58,
    signals: Object.freeze([["spacingProxy", 0.5], ["defensiveActivity", 0.5]]),
    required: Object.freeze(["spacingProxy", "defensiveActivity"]),
    position: "perimeter",
  }),
  Object.freeze({
    id: "rebounder",
    label: "Rebounder",
    threshold: 0.62,
    signals: Object.freeze([["rebounding", 1]]),
    required: Object.freeze(["rebounding"]),
  }),
]);

const WITHHELD_ARCHETYPES = Object.freeze([
  Object.freeze({ ids: Object.freeze(["movementShooter", "slasher", "rimRunner"]), reason: "Shot and off-ball tracking are required." }),
  Object.freeze({ ids: Object.freeze(["switchBig", "pointOfAttackStopper"]), reason: "Defensive assignment and matchup tracking are required." }),
  Object.freeze({ ids: Object.freeze(["microwaveScorer"]), reason: "Bench-role and stint-context scoring evidence are required." }),
]);

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

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
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

function positions(player) {
  const source = Array.isArray(player?.positions) ? player.positions : [player?.positions];
  return [...new Set(source.flatMap((value) => String(value ?? "")
    .toUpperCase()
    .split(/[\s/,|;+\-]+/)
    .map((position) => ({ PG: "G", SG: "G", SF: "F", PF: "F" })[position] || position)
    .filter((position) => ["G", "F", "C"].includes(position))))];
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

function readAdvanced(player, aliases, { asPercentage = false } = {}) {
  for (const source of advancedSources(player)) {
    for (const alias of aliases) {
      if (!Object.hasOwn(source, alias)) continue;
      const value = asPercentage ? percentage(source[alias]) : finite(source[alias]);
      if (value !== null) return value;
    }
  }
  return null;
}

function totalsSources(player) {
  return [player?.analytics?.seasonTotals, player?.analytics?.totals]
    .filter((source) => source && typeof source === "object" && !Array.isArray(source));
}

function readTotalPair(player, numeratorAliases, denominatorAliases) {
  for (const source of totalsSources(player)) {
    const numeratorAlias = numeratorAliases.find((alias) => Object.hasOwn(source, alias));
    const denominatorAlias = denominatorAliases.find((alias) => Object.hasOwn(source, alias));
    if (!numeratorAlias || !denominatorAlias) continue;
    const numerator = nonNegative(source[numeratorAlias]);
    const denominator = nonNegative(source[denominatorAlias]);
    if (numerator !== null && denominator > 0) return numerator / denominator;
  }
  return null;
}

function readTotal(player, aliases) {
  for (const source of totalsSources(player)) {
    for (const alias of aliases) {
      if (!Object.hasOwn(source, alias)) continue;
      const value = nonNegative(source[alias]);
      if (value !== null) return value;
    }
  }
  return null;
}

function threePointVolume(player) {
  const attempts = readTotal(player, [
    "threePointFieldGoalsAttempted", "three_point_field_goals_attempted",
    "threePointAttemptsTotal", "three_point_attempts_total",
  ]);
  if (attempts === null) return null;
  const totalMinutes = readTotal(player, ["minutes", "minutesPlayed", "minutes_played"]);
  if (totalMinutes > 0) {
    return { value: (attempts / totalMinutes) * 36, unit: "attempts per 36", basis: "reported attempts divided by total minutes" };
  }
  const games = readTotal(player, ["games", "gamesPlayed", "games_played"]) ?? nonNegative(player?.games);
  if (games > 0) {
    return { value: attempts / games, unit: "attempts per game", basis: "reported attempts divided by games" };
  }
  return null;
}

function rankValues(records, accessor, { lowerIsBetter = false } = {}) {
  const entries = records
    .map((record) => ({ id: record.id, value: finite(accessor(record)) }))
    .filter((entry) => entry.value !== null)
    .sort((left, right) => (left.value - right.value) || left.id.localeCompare(right.id));
  const byId = new Map();
  if (entries.length < 2) return { byId, observations: entries.length };
  let start = 0;
  while (start < entries.length) {
    let end = start;
    while (end + 1 < entries.length && entries[end + 1].value === entries[start].value) end += 1;
    const ascending = ((start + end) / 2) / (entries.length - 1);
    const score = lowerIsBetter ? 1 - ascending : ascending;
    for (let index = start; index <= end; index += 1) byId.set(entries[index].id, score);
    start = end + 1;
  }
  return { byId, observations: entries.length };
}

function weightedScore(entries, { requireEvery = false } = {}) {
  if (requireEvery && entries.some(([value]) => !Number.isFinite(value))) return null;
  const available = entries.filter(([value, weight]) => Number.isFinite(value) && Number.isFinite(weight) && weight > 0);
  const totalWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
  return totalWeight > 0
    ? available.reduce((sum, [value, weight]) => sum + (value * weight), 0) / totalWeight
    : null;
}

function sourceRecord(player, roleRecord, index) {
  const trueShootingPct = readAdvanced(player, [
    "true_shooting_percentage", "trueShootingPercentage", "trueShootingPct", "ts_pct", "tsPct",
  ], { asPercentage: true });
  const freeThrowPressureProxy = readTotalPair(
    player,
    ["freeThrowsAttempted", "free_throws_attempted"],
    ["fieldGoalsAttempted", "field_goals_attempted"],
  );
  const reportedThreePointVolume = threePointVolume(player);
  const assistPct = readAdvanced(player, ["assist_percentage", "assistPercentage", "assistPct", "ast_pct", "astPct"], { asPercentage: true });
  const blockPct = readAdvanced(player, ["block_percentage", "blockPercentage", "blockPct", "blk_pct", "blkPct"], { asPercentage: true });
  const totalReboundPct = readAdvanced(player, ["total_rebound_percentage", "totalReboundPercentage", "totalReboundPct", "trb_pct", "trbPct"], { asPercentage: true });
  return {
    id: playerId(player, index),
    name: playerName(player, index),
    player,
    positions: positions(player),
    roleRecord,
    reliability: roleRecord?.reliability || null,
    raw: {
      scoringVolume: finite(roleRecord?.values?.scoring),
      scoringEfficiency: trueShootingPct ?? percentage(roleRecord?.values?.efficiency),
      perimeterAccuracy: percentage(roleRecord?.values?.threePointPct),
      perimeterVolume: reportedThreePointVolume?.value ?? nonNegative(roleRecord?.values?.threePointVolume),
      freeThrowPressureProxy,
      playmaking: assistPct ?? finite(roleRecord?.values?.assistPct) ?? finite(roleRecord?.values?.playmaking),
      usageLoad: readPlayerUsage(player),
      ballSecurity: nonNegative(roleRecord?.values?.turnovers),
      defensiveActivity: nonNegative(roleRecord?.values?.stocks),
      shotBlocking: blockPct ?? finite(roleRecord?.values?.blockPct) ?? nonNegative(roleRecord?.values?.blocks),
      rebounding: totalReboundPct ?? finite(roleRecord?.values?.totalReboundPct) ?? nonNegative(roleRecord?.values?.rebounding),
    },
    bases: {
      scoringEfficiency: trueShootingPct !== null ? "reported true-shooting percentage" : "effective field-goal percentage",
      playmaking: assistPct !== null || Number.isFinite(roleRecord?.values?.assistPct) ? "reported assist percentage" : "assists per 36 minutes",
      perimeterVolume: reportedThreePointVolume?.unit || roleRecord?.values?.threePointVolumeUnit || "unavailable",
      perimeterVolumeBasis: reportedThreePointVolume?.basis || "reported three-point attempt volume",
      shotBlocking: blockPct !== null || Number.isFinite(roleRecord?.values?.blockPct) ? "reported block percentage" : "blocks per 36 minutes",
      rebounding: totalReboundPct !== null || Number.isFinite(roleRecord?.values?.totalReboundPct) ? "reported total rebound percentage" : "rebounds per 36 minutes",
    },
  };
}

function dimension(id, score, rawValue, unit, basis, evidenceMode, confidence, reason = null, comparisonObservations = 0) {
  const definition = SKILL_DIMENSIONS[id];
  const rawAvailable = Number.isFinite(rawValue);
  const available = Number.isFinite(score) && rawAvailable;
  return {
    id,
    label: definition.label,
    category: definition.category,
    available,
    rawAvailable,
    score: available ? round(score, 4) : null,
    percentile: available ? round(score * 100, 1) : null,
    rawValue: rawAvailable ? round(rawValue, 5) : null,
    unit: rawAvailable ? unit : null,
    basis: rawAvailable ? basis : null,
    evidenceMode,
    comparisonObservations,
    comparisonReliable: comparisonObservations >= 5,
    confidence: available ? comparisonObservations >= 5 ? confidence : "thin-comparison" : "unavailable",
    reason: available
      ? null
      : rawAvailable && comparisonObservations < 2
        ? "Raw evidence is available, but fewer than two comparable observations prevent a relative skill score."
        : reason || "Required source evidence is unavailable.",
  };
}

function categorySummary(categoryId, dimensions) {
  const definitions = Object.entries(SKILL_DIMENSIONS)
    .filter(([, definition]) => definition.category === categoryId);
  const inputs = definitions.map(([id, definition]) => [dimensions[id]?.score, definition.weight]);
  const score = weightedScore(inputs);
  const availableCount = inputs.filter(([value]) => Number.isFinite(value)).length;
  return {
    id: categoryId,
    label: SKILL_CATEGORIES[categoryId].label,
    available: score !== null,
    score: score === null ? null : round(score, 4),
    percentile: score === null ? null : round(score * 100, 1),
    evidenceCoverage: definitions.length > 0 ? round(availableCount / definitions.length, 3) : 0,
    evidenceStatus: availableCount === 0 ? "unavailable" : availableCount === definitions.length ? "complete" : "partial",
    dimensionIds: definitions.map(([id]) => id),
  };
}

/**
 * Decompose public player-season evidence into cohort-relative skill signals.
 * Scores are percentile-style comparison indices, not scouting grades or
 * calibrated probabilities. The comparison cohort is always returned.
 */
export function buildPlayerSkillProfiles(players, options = {}) {
  const selected = dedupePlayers(players);
  const suppliedReference = dedupePlayers(options.referencePlayers);
  // Keep the selected snapshot when the supplied cohort contains the same ID.
  const comparisonPlayers = dedupePlayers(suppliedReference.length > 0 ? [...selected, ...suppliedReference] : selected);
  const classification = classifyPlayerSeasonRolePool(comparisonPlayers, {
    ...options,
    referencePlayers: comparisonPlayers,
  });
  const sourceRecords = comparisonPlayers.map((player, index) => sourceRecord(
    player,
    classification.byId.get(playerId(player, index)),
    index,
  ));
  const ranks = {
    scoringVolume: rankValues(sourceRecords, (record) => record.raw.scoringVolume),
    scoringEfficiency: rankValues(sourceRecords, (record) => record.raw.scoringEfficiency),
    perimeterAccuracy: rankValues(sourceRecords, (record) => record.raw.perimeterAccuracy),
    perimeterVolume: rankValues(sourceRecords, (record) => record.raw.perimeterVolume),
    freeThrowPressureProxy: rankValues(sourceRecords, (record) => record.raw.freeThrowPressureProxy),
    playmaking: rankValues(sourceRecords, (record) => record.raw.playmaking),
    usageLoad: rankValues(sourceRecords, (record) => record.raw.usageLoad),
    ballSecurity: rankValues(sourceRecords, (record) => record.raw.ballSecurity, { lowerIsBetter: true }),
    defensiveActivity: rankValues(sourceRecords, (record) => record.raw.defensiveActivity),
    shotBlocking: rankValues(sourceRecords, (record) => record.raw.shotBlocking),
    rebounding: rankValues(sourceRecords, (record) => record.raw.rebounding),
  };
  const selectedIds = new Set(selected.map((player, index) => playerId(player, index)));
  const records = sourceRecords.filter((record) => selectedIds.has(record.id)).map((record) => {
    const confidence = record.reliability?.reliable ? "standard" : "small-sample";
    const getRank = (id) => ranks[id].byId.get(record.id) ?? null;
    const raw = record.raw;
    const spacingScore = weightedScore([
      [getRank("perimeterAccuracy"), 0.55],
      [getRank("perimeterVolume"), 0.45],
    ], { requireEvery: true });
    const spacingObservations = Math.min(
      ranks.perimeterAccuracy.observations,
      ranks.perimeterVolume.observations,
    );
    const dimensions = {
      scoringVolume: dimension("scoringVolume", getRank("scoringVolume"), raw.scoringVolume, "points per 36", "box-score rate", "direct-box-score", confidence, null, ranks.scoringVolume.observations),
      scoringEfficiency: dimension("scoringEfficiency", getRank("scoringEfficiency"), raw.scoringEfficiency, "share", record.bases.scoringEfficiency, "direct-box-score", confidence, null, ranks.scoringEfficiency.observations),
      perimeterAccuracy: dimension("perimeterAccuracy", getRank("perimeterAccuracy"), raw.perimeterAccuracy, "share", "reported three-point percentage", "direct-box-score", confidence, null, ranks.perimeterAccuracy.observations),
      freeThrowPressureProxy: dimension("freeThrowPressureProxy", getRank("freeThrowPressureProxy"), raw.freeThrowPressureProxy, "FTA per FGA", "reported free-throw attempts divided by field-goal attempts", "box-score-proxy", confidence, "Attempt totals are unavailable.", ranks.freeThrowPressureProxy.observations),
      playmaking: dimension("playmaking", getRank("playmaking"), raw.playmaking, record.bases.playmaking === "reported assist percentage" ? "share" : "assists per 36", record.bases.playmaking, "direct-box-score", confidence, null, ranks.playmaking.observations),
      usageLoad: dimension("usageLoad", getRank("usageLoad"), raw.usageLoad, "share", "reported usage percentage", "advanced-box-score", confidence, "Reported usage percentage is unavailable.", ranks.usageLoad.observations),
      ballSecurity: dimension("ballSecurity", getRank("ballSecurity"), raw.ballSecurity, "turnovers per 36", "lower turnover rate ranks higher", "box-score-proxy", confidence, null, ranks.ballSecurity.observations),
      spacingProxy: dimension("spacingProxy", spacingScore, raw.perimeterVolume, record.bases.perimeterVolume, record.bases.perimeterVolumeBasis, "box-score-proxy", confidence, "Both three-point accuracy and attempt volume are required.", spacingObservations),
      defensiveActivity: dimension("defensiveActivity", getRank("defensiveActivity"), raw.defensiveActivity, "steals plus blocks per 36", "box-score defensive events", "box-score-proxy", confidence, null, ranks.defensiveActivity.observations),
      shotBlocking: dimension("shotBlocking", getRank("shotBlocking"), raw.shotBlocking, record.bases.shotBlocking === "reported block percentage" ? "share" : "blocks per 36", record.bases.shotBlocking, "box-score-proxy", confidence, null, ranks.shotBlocking.observations),
      rebounding: dimension("rebounding", getRank("rebounding"), raw.rebounding, record.bases.rebounding === "reported total rebound percentage" ? "share" : "rebounds per 36", record.bases.rebounding, "direct-box-score", confidence, null, ranks.rebounding.observations),
    };
    const categories = Object.fromEntries(Object.keys(SKILL_CATEGORIES).map((categoryId) => [
      categoryId,
      categorySummary(categoryId, dimensions),
    ]));
    return {
      playerId: record.id,
      playerName: record.name,
      positions: record.positions,
      sample: record.roleRecord?.sample || null,
      reliability: record.reliability,
      comparisonLabel: String(options.comparisonLabel || "selected comparison pool"),
      referencePlayerCount: comparisonPlayers.length,
      dimensions,
      categories,
      unavailableSkillGroups: TRACKING_GAPS.map((gap) => ({
        group: gap.group,
        skills: [...gap.skills],
        reason: gap.reason,
      })),
      caveats: [
        "Scores are cohort-relative percentile signals, not calibrated scouting grades.",
        "Spacing, turnover avoidance, and defensive event activity are explicitly labeled proxies.",
        ...(comparisonPlayers.length < 5 ? ["Fewer than five comparison players makes percentile signals unstable."] : []),
        ...(record.roleRecord?.caveats || []),
      ],
    };
  });
  const byId = new Map(records.map((record) => [record.playerId, record]));
  return {
    version: PRODUCT_ANALYTICS_VERSION,
    comparisonLabel: String(options.comparisonLabel || "selected comparison pool"),
    referencePlayerCount: comparisonPlayers.length,
    records,
    byId,
  };
}

function positionEligible(profile, requirement) {
  if (!requirement) return true;
  if (requirement === "frontcourt") return profile.positions.some((position) => position === "F" || position === "C");
  if (requirement === "perimeter") return profile.positions.some((position) => position === "G" || position === "F");
  return false;
}

/**
 * Return multiple simultaneous archetype memberships. `membershipScore` is an
 * uncalibrated 0-1 fit signal; `probability` intentionally remains null until
 * labeled archetype training and out-of-sample calibration exist.
 */
export function detectPlayerArchetypes(players, options = {}) {
  const skillSet = options.skillProfileSet || buildPlayerSkillProfiles(players, options);
  const records = skillSet.records.map((profile) => {
    const assessed = ARCHETYPE_DEFINITIONS.map((definition) => {
      const missing = definition.required.filter((id) => !profile.dimensions[id]?.available);
      const eligible = positionEligible(profile, definition.position);
      const score = missing.length === 0 && eligible
        ? weightedScore(definition.signals.map(([id, weight]) => [profile.dimensions[id]?.score, weight]))
        : null;
      return {
        id: definition.id,
        label: definition.label,
        available: score !== null,
        qualifies: score !== null && score >= definition.threshold,
        membershipScore: score === null ? null : round(score, 4),
        probability: null,
        calibration: "uncalibrated-cohort-relative-membership",
        threshold: definition.threshold,
        confidence: score === null ? "unavailable" : profile.reliability?.reliable ? "standard" : "small-sample",
        evidence: definition.signals.map(([id, weight]) => ({
          dimensionId: id,
          weight,
          score: profile.dimensions[id]?.score ?? null,
          evidenceMode: profile.dimensions[id]?.evidenceMode || "unavailable",
        })),
        reason: !eligible
          ? "The player's verified broad positions do not match this archetype's position gate."
          : missing.length > 0
            ? `Missing required evidence: ${missing.join(", ")}.`
            : null,
      };
    }).sort((left, right) => (Number(right.available) - Number(left.available))
      || ((right.membershipScore ?? -1) - (left.membershipScore ?? -1))
      || left.id.localeCompare(right.id));
    return {
      playerId: profile.playerId,
      playerName: profile.playerName,
      labels: assessed.filter((item) => item.qualifies),
      assessed,
      withheld: WITHHELD_ARCHETYPES.map((item) => ({ ids: [...item.ids], reason: item.reason })),
      caveats: [
        "A player may qualify for multiple labels.",
        "Membership scores are not probabilities; probability calibration remains gated on labeled training data.",
        "Proxy labels describe available evidence and do not prove tracking-level behavior.",
      ],
    };
  });
  return {
    version: PRODUCT_ANALYTICS_VERSION,
    comparisonLabel: skillSet.comparisonLabel,
    referencePlayerCount: skillSet.referencePlayerCount,
    records,
    byId: new Map(records.map((record) => [record.playerId, record])),
  };
}

function diminishingCoverage(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => right - left);
  if (ordered.length === 0) return null;
  return clamp((ordered[0] || 0) * 0.78 + (ordered[1] || 0) * 0.22);
}

function usageCompatibility(players) {
  const usages = players.map((player) => readPlayerUsage(player));
  if (usages.some((value) => !Number.isFinite(value))) {
    return { available: false, score: null, overlapRisk: null, totalUsage: null, reason: "Reported usage is required for every selected player." };
  }
  const pairRisks = [];
  for (let left = 0; left < usages.length; left += 1) {
    for (let right = left + 1; right < usages.length; right += 1) {
      pairRisks.push(clamp((Math.min(usages[left], usages[right]) - 0.24) / 0.12));
    }
  }
  const overlapRisk = pairRisks.length > 0
    ? pairRisks.reduce((sum, value) => sum + value, 0) / pairRisks.length
    : 0;
  const totalUsage = usages.reduce((sum, value) => sum + value, 0);
  const completeLineupBalance = players.length === 5 ? 1 - clamp(Math.abs(totalUsage - 1) / 0.35) : null;
  const score = completeLineupBalance === null
    ? 1 - overlapRisk
    : (1 - overlapRisk) * 0.65 + completeLineupBalance * 0.35;
  return {
    available: true,
    score: round(score, 4),
    overlapRisk: round(overlapRisk, 4),
    totalUsage: round(totalUsage, 4),
    completeLineupBalance: completeLineupBalance === null ? null : round(completeLineupBalance, 4),
    reason: "This is a season-role overlap diagnostic, not a fitted usage interaction effect.",
  };
}

function validatedObservedSynergy(evidence, selectedIds) {
  if (!evidence) {
    return { status: "unavailable", available: false, adjustedPointsPer100: null, reason: "No observed lineup evidence was supplied." };
  }
  const evidenceIds = Array.isArray(evidence.playerIds) ? evidence.playerIds.map(String).sort() : [];
  if (evidenceIds.length !== selectedIds.length || evidenceIds.some((id, index) => id !== selectedIds[index])) {
    return { status: "withheld", available: false, adjustedPointsPer100: null, reason: "Observed evidence player IDs do not match the selected group." };
  }
  if (
    evidence?.validation?.sourceProvenancePassed !== true
    || evidence?.validation?.boxScoreReconciled !== true
    || evidence?.displayEligible !== true
    || evidence?.publishable === false
    || !String(evidence?.modelVersion || "").trim()
  ) {
    return {
      status: "withheld",
      available: false,
      adjustedPointsPer100: null,
      reason: "Observed synergy requires validated provenance, independent box-score reconciliation, display eligibility, and a model version.",
    };
  }
  const alreadyShrunk = finite(evidence.shrunkSynergyPer100);
  if (evidence.alreadyShrunk === true && evidence.publishable === true && alreadyShrunk !== null) {
    const certifiedReliability = finite(evidence.reliability);
    if (certifiedReliability === null || certifiedReliability < 0 || certifiedReliability > 1) {
      return { status: "withheld", available: false, adjustedPointsPer100: null, reason: "Certified observed synergy requires reliability from 0 through 1." };
    }
    return {
      status: "available",
      available: true,
      adjustedPointsPer100: round(alreadyShrunk, 4),
      rawPointsPer100: finite(evidence.rawSynergyPer100),
      possessions: nonNegative(evidence.possessions),
      reliability: certifiedReliability,
      shrinkageMethod: "caller-certified-already-shrunk",
      modelVersion: String(evidence.modelVersion),
      source: String(evidence.source || "validated derived lineup evidence"),
      includedInFitIndex: false,
      reason: "Observed residual stays separate from the heuristic fit index to avoid double counting.",
    };
  }
  const raw = finite(evidence.rawSynergyPer100 ?? evidence.synergyPer100 ?? evidence.residualPer100);
  const possessions = nonNegative(evidence.possessions);
  if (raw === null || !(possessions > 0)) {
    return { status: "withheld", available: false, adjustedPointsPer100: null, reason: "Raw synergy and a positive possession sample are required." };
  }
  const priorPossessions = nonNegative(evidence.priorPossessions) ?? 1000;
  const reliability = possessions / (possessions + priorPossessions);
  return {
    status: "available",
    available: true,
    adjustedPointsPer100: round(raw * reliability, 4),
    rawPointsPer100: round(raw, 4),
    possessions,
    reliability: round(reliability, 4),
    shrinkageMethod: "possession-prior",
    priorPossessions,
    modelVersion: String(evidence.modelVersion),
    source: String(evidence.source || "validated derived lineup evidence"),
    includedInFitIndex: false,
    reason: "Observed residual stays separate from the heuristic fit index to avoid double counting.",
  };
}

/**
 * Explain duo, trio, or five-player fit with positive and negative component
 * contributions. The result is a transparent compatibility proxy, not causal
 * chemistry. Optional observed lineup residuals are independently gated.
 */
export function analyzeLineupChemistry(players, options = {}) {
  const selected = dedupePlayers(players);
  if (selected.length < 2 || selected.length > 5) {
    throw new RangeError("Lineup chemistry requires two through five unique players.");
  }
  const comparisonPlayers = dedupePlayers([
    ...selected,
    ...(Array.isArray(options.referencePlayers) ? options.referencePlayers : []),
  ]);
  const roleModel = buildLineupRoleModel(comparisonPlayers);
  const roleFit = scoreLineupRoleFit(selected, roleModel, {
    objectiveWeights: options.objectiveWeights || {},
    balance: "off",
  });
  const skillSet = buildPlayerSkillProfiles(selected, {
    ...options,
    referencePlayers: comparisonPlayers,
  });
  const skillCoverage = (categoryId) => diminishingCoverage(skillSet.records.map((profile) => profile.categories[categoryId]?.score));
  const usage = usageCompatibility(selected);
  const primaryCreatorSignals = selected
    .map((player) => roleModel.signalsById.get(playerId(player))?.primaryCreator)
    .filter(Number.isFinite)
    .sort((left, right) => right - left);
  const creatorRedundancy = primaryCreatorSignals.length >= 2
    ? clamp((Math.min(primaryCreatorSignals[0], primaryCreatorSignals[1]) - 0.65) / 0.35)
    : 0;
  const components = [
    { id: "roleCoverage", label: "Role coverage", score: clamp(roleFit.fitIndex / 100), weight: 0.3, evidenceMode: "cohort-relative-role-model" },
    { id: "spacing", label: "Spacing coverage", score: skillCoverage("offBall"), weight: 0.18, evidenceMode: "box-score-proxy" },
    { id: "creation", label: "Creation coverage", score: skillCoverage("creation"), weight: 0.16, evidenceMode: "box-score-and-advanced" },
    { id: "defense", label: "Defensive activity coverage", score: skillCoverage("defense"), weight: 0.16, evidenceMode: "box-score-proxy" },
    { id: "rebounding", label: "Rebounding coverage", score: skillCoverage("rebounding"), weight: 0.1, evidenceMode: "box-score" },
    { id: "usageCompatibility", label: "Usage compatibility", score: usage.score, weight: 0.1, evidenceMode: "season-role-proxy" },
  ].map((component) => ({ ...component, available: Number.isFinite(component.score) }));
  const availableWeight = components.reduce((sum, component) => sum + (component.available ? component.weight : 0), 0);
  const explained = components.map((component) => {
    const normalizedWeight = component.available && availableWeight > 0 ? component.weight / availableWeight : 0;
    const contributionPoints = component.available ? (component.score - 0.5) * normalizedWeight * 100 : null;
    return {
      ...component,
      score: component.available ? round(component.score, 4) : null,
      normalizedWeight: round(normalizedWeight, 4),
      contributionPoints: contributionPoints === null ? null : round(contributionPoints, 2),
    };
  });
  const creatorRedundancyPenalty = creatorRedundancy * 8;
  const fitIndex = clamp(
    50 + explained.reduce((sum, component) => sum + (component.contributionPoints || 0), 0) - creatorRedundancyPenalty,
    0,
    100,
  );
  const fitBand = fitIndex >= 70 ? "complementary" : fitIndex >= 55 ? "additive" : fitIndex >= 40 ? "mixed" : "tension";
  const selectedIds = selected.map((player, index) => playerId(player, index)).sort();
  const observedSynergy = validatedObservedSynergy(options.observedLineupEvidence, selectedIds);
  return {
    version: PRODUCT_ANALYTICS_VERSION,
    playerIds: selectedIds,
    playerCount: selected.length,
    comparisonLabel: String(options.comparisonLabel || "selected comparison pool"),
    referencePlayerCount: comparisonPlayers.length,
    fitIndex: round(fitIndex, 2),
    fitBand,
    interpretation: "Cohort-relative compatibility proxy; it is not expected net rating or causal chemistry.",
    components: explained,
    positiveContributions: explained.filter((component) => component.contributionPoints > 0)
      .sort((left, right) => right.contributionPoints - left.contributionPoints),
    negativeContributions: explained.filter((component) => component.contributionPoints < 0)
      .sort((left, right) => left.contributionPoints - right.contributionPoints),
    redundancy: {
      primaryCreatorOverlap: round(creatorRedundancy, 4),
      penaltyPoints: round(creatorRedundancyPenalty, 2),
      reason: "Only simultaneous high primary-creator signals receive a bounded redundancy penalty; duplicate shooting and defense are not presumed harmful.",
    },
    usageCompatibility: usage,
    roleFit,
    observedSynergy,
    caveats: [
      "Fit and observed performance are reported separately.",
      "Together-vs-apart, teammate/opponent adjustment, and learned interaction effects require validated possession evidence.",
      "Passing relationships, screen actions, shot quality, and defensive assignments require tracking or tagged event data.",
    ],
  };
}

function impactEvidenceForPlayer(source, id) {
  if (source instanceof Map) return source.get(id) || null;
  if (source && typeof source === "object" && !Array.isArray(source) && Object.hasOwn(source, id)) {
    return source[id] || null;
  }
  return null;
}

function adjustedImpact(evidence) {
  if (!evidence) return { available: false, reason: "No possession-adjusted impact evidence was supplied." };
  const validation = evidence.validation || {};
  if (
    validation.sourceProvenancePassed !== true
    || validation.boxScoreReconciled !== true
    || evidence.displayEligible !== true
  ) {
    return { available: false, reason: "Possession impact failed provenance, box-score reconciliation, or display-eligibility gates." };
  }
  const offense = finite(evidence.offensiveRapm ?? evidence.offensive_rapm ?? evidence.offense);
  const defense = finite(evidence.defensiveRapm ?? evidence.defensive_rapm ?? evidence.defense);
  const reliability = finite(evidence.reliability);
  if (offense === null || defense === null || reliability === null || reliability < 0 || reliability > 1) {
    return { available: false, reason: "Comparable offensive RAPM, defensive RAPM, and 0-1 reliability are required." };
  }
  const modelVersion = String(evidence.modelVersion || "").trim();
  if (!modelVersion) return { available: false, reason: "A possession-impact model version is required." };
  return {
    available: true,
    offense: round(offense, 4),
    defense: round(defense, 4),
    total: round(offense + defense, 4),
    reliability: round(reliability, 4),
    alreadyRegularized: evidence.alreadyRegularized === true,
    modelVersion,
    uncertainty: evidence.uncertainty || null,
    source: String(evidence.source || "validated derived possession evidence"),
  };
}

/** Keep production, impact, and contextual fit in separate result branches. */
export function buildPlayerValueProfiles(players, options = {}) {
  const selected = dedupePlayers(players);
  const skillSet = options.skillProfileSet || buildPlayerSkillProfiles(selected, options);
  const archetypeSet = options.archetypeSet || detectPlayerArchetypes(selected, {
    ...options,
    skillProfileSet: skillSet,
  });
  const fitAnalysis = options.fitAnalysis && typeof options.fitAnalysis === "object" ? options.fitAnalysis : null;
  const individualEvaluationSet = options.individualEvaluationSet || evaluateIndividualPlayers(selected, options);
  const records = selected.map((player, index) => {
    const id = playerId(player, index);
    const rateViews = derivePlayerRateViews(player, options);
    const skillProfile = skillSet.byId.get(id) || null;
    const individualEvaluation = individualEvaluationSet.byId.get(id) || null;
    const fitIncludesPlayer = fitAnalysis && Array.isArray(fitAnalysis.playerIds) && fitAnalysis.playerIds.includes(id);
    return {
      playerId: id,
      playerName: playerName(player, index),
      production: {
        available: rateViews.perGame.available,
        perGame: rateViews.perGame,
        per36: rateViews.per36,
        per100: rateViews.per100,
        skillCategories: skillProfile?.categories || null,
        compositeValue: null,
        reason: "Production is descriptive; no universal all-in-one value weighting is imposed.",
      },
      impact: {
        boxScoreModel: {
          available: Boolean(individualEvaluation?.coverage?.boxModelMetricCount),
          metrics: individualEvaluation?.metrics || null,
          uncertainty: null,
          reason: individualEvaluation?.coverage?.boxModelMetricCount
            ? "The complete available advanced-stat scorecard is retained; box-derived impact metrics are not causal possession impact."
            : "Advanced box impact metrics are unavailable.",
        },
        possessionAdjusted: individualEvaluation?.possessionImpactEvidence
          || adjustedImpact(impactEvidenceForPlayer(options.impactEvidenceById, id)),
      },
      fit: fitIncludesPlayer
        ? {
            available: true,
            lineupFitIndex: fitAnalysis.fitIndex,
            lineupFitBand: fitAnalysis.fitBand,
            lineupPlayerIds: [...fitAnalysis.playerIds],
            individualAttribution: null,
            reason: "This player is part of the supplied lineup context; the lineup score is not assigned to one player causally.",
          }
        : {
            available: false,
            lineupFitIndex: null,
            individualAttribution: null,
            reason: "Fit requires an explicit lineup context and remains separate from production and impact.",
          },
      archetypes: archetypeSet.byId.get(id) || null,
      individualAdvancedEvaluation: individualEvaluation,
      caveats: [
        "Production, impact, and fit are not collapsed into one number.",
        "Wins added, replacement value, floor/ceiling impact, playoff translation, and scalability require separately calibrated models.",
      ],
    };
  });
  return {
    version: PRODUCT_ANALYTICS_VERSION,
    records,
    byId: new Map(records.map((record) => [record.playerId, record])),
  };
}

/**
 * Machine-readable product readiness so interfaces can distinguish supported,
 * proxy-only, and evidence-gated features without burying caveats in copy.
 */
export function assessBasketballProductReadiness(options = {}) {
  const players = dedupePlayers(options.players);
  const seasons = Array.isArray(options.longitudinalSeasons) ? options.longitudinalSeasons : [];
  const validatedTracking = options?.trackingEvidence?.validated === true;
  const validatedMatchups = options?.matchupEvidence?.validated === true;
  const validatedCareerModel = options?.careerModel?.validated === true;
  const simulationReady = ["validated", "exploratory"].includes(options?.simulationModelContext?.mode)
    && Boolean(String(options?.simulationModelContext?.modelVersion || "").trim());
  const chemistry = options.fitAnalysis || null;
  const chemistryReady = Number.isFinite(chemistry?.fitIndex)
    && Array.isArray(chemistry?.playerIds)
    && chemistry.playerIds.length >= 2;
  const possessionImpactReady = players.some((player, index) => adjustedImpact(
    impactEvidenceForPlayer(options.impactEvidenceById, playerId(player, index)),
  ).available);
  const individualEvaluationSet = players.length > 0 ? evaluateIndividualPlayers(players, options) : null;
  const boxModelReady = individualEvaluationSet?.records.some(
    (record) => record.coverage.boxModelMetricCount > 0,
  ) === true;
  const records = [
    {
      id: "optimalLineup",
      status: players.length >= 5 ? "supported" : "needs-input",
      available: players.length >= 5,
      reason: players.length >= 5
        ? "The existing exact solver, role complementarity, rotations, alternatives, and evidence-aware projections can use this pool."
        : "At least five eligible players are required.",
    },
    {
      id: "simulation",
      status: simulationReady ? "input-ready" : "evidence-gated",
      available: simulationReady,
      reason: simulationReady
        ? "The Monte Carlo engine can run with the explicitly labeled model context and assumptions."
        : "Calibrated or explicitly exploratory matchup scoring inputs and a model version are required.",
    },
    {
      id: "compositePlayer",
      status: validatedTracking ? "partial" : "evidence-gated",
      available: false,
      reason: "Skill mixing is representable, but prediction requires physical, cognitive, tendency, and interaction models that are not inferred from box scores.",
    },
    {
      id: "chemistry",
      status: chemistryReady && chemistry?.observedSynergy?.available ? "observed-and-proxy" : chemistryReady ? "proxy-only" : "needs-input",
      available: chemistryReady,
      reason: chemistryReady && chemistry?.observedSynergy?.available
        ? "Explainable fit and separately validated observed residual are available."
        : "Cohort-relative fit can be computed; causal chemistry still requires adjusted possession evidence.",
    },
    {
      id: "tendencies",
      status: validatedTracking ? "partial" : "evidence-gated",
      available: validatedTracking,
      reason: validatedTracking
        ? "Validated tracking can populate supported tendency branches; context coverage must still be reported."
        : "Shot types, play types, passing decisions, and defensive behavior require tracking or tagged events.",
    },
    {
      id: "careerArc",
      status: validatedCareerModel ? "model-ready" : seasons.length >= 2 ? "observed-trend-only" : "evidence-gated",
      available: validatedCareerModel,
      reason: validatedCareerModel
        ? "A validated longitudinal model was supplied."
        : "Multiple seasons can describe change, but probabilistic development and aging forecasts require a validated longitudinal cohort model.",
    },
    {
      id: "playerImpact",
      status: possessionImpactReady ? "partial" : boxModelReady ? "box-model-only" : "evidence-gated",
      available: possessionImpactReady || boxModelReady,
      reason: possessionImpactReady
        ? "Validated possession-adjusted impact is available alongside any box-score model evidence."
        : boxModelReady
          ? "Advanced box-score impact is available; possession-adjusted impact remains independently gated."
          : "No advanced box-score impact or validated possession-adjusted impact is available.",
    },
    {
      id: "skillDecomposition",
      status: validatedTracking ? "expanded" : "box-score-foundation",
      available: players.length > 0,
      reason: validatedTracking
        ? "Public skill signals can be supplemented by validated tracking dimensions."
        : "Scoring, creation, spacing, defense, and rebounding foundations are available; fine-grained skills are withheld.",
    },
    {
      id: "archetypes",
      status: "heuristic-membership",
      available: players.length > 0,
      reason: "Multi-label cohort-relative memberships are available; calibrated probabilities and tracking-only labels are withheld.",
    },
    {
      id: "matchups",
      status: validatedMatchups ? "partial" : "evidence-gated",
      available: validatedMatchups,
      reason: validatedMatchups
        ? "Validated matchup evidence can be used within its documented scope."
        : "Defender assignment, scheme, screen coverage, and opponent-conditioned efficiency evidence are required.",
    },
  ];
  return {
    version: PRODUCT_ANALYTICS_VERSION,
    generatedFrom: {
      playerCount: players.length,
      longitudinalSeasonCount: seasons.length,
      hasValidatedTracking: validatedTracking,
      hasValidatedMatchups: validatedMatchups,
      hasValidatedCareerModel: validatedCareerModel,
      hasBoxModelImpact: boxModelReady,
      hasValidatedPossessionImpact: possessionImpactReady,
    },
    records,
    byId: Object.fromEntries(records.map((record) => [record.id, record])),
  };
}
