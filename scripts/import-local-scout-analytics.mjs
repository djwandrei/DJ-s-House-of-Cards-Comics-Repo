#!/usr/bin/env node

/**
 * Materialize a compact, private query index from a validated local NBA Scout
 * archive. The complete derived archive stays immutable in private Storage;
 * this command never uploads raw PBP, uncompressed team JSON, or a browser API.
 *
 * The default is an offline integrity and query-plan dry run. Remote work
 * requires the dedicated analytics target, a service-role key, and an explicit
 * write confirmation for --apply.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { assertAnalyticsProjectTarget } from './lib/nba-analytics-project-target.mjs';
import {
  buildArchiveUploadPlan,
  ensurePrivateBucket,
  remoteArtifactMap,
  validateLocalArchivePlan,
  verifyRemoteArtifacts,
} from './upload-local-scout-analytics-archive.mjs';

const ROOT = process.cwd();
const GUNZIP = promisify(gunzip);
const DEFAULT_BUCKET = 'nba-scout-analytics-archive';
const WRITE_CONFIRMATION_ENV = 'NBA_SCOUT_QUERY_IMPORT_ALLOW_WRITE';
const SUPPORTED_SCHEMA_VERSION = 4;
const SUPPORTED_METRICS_VERSION = 'nba-scout-metrics-v4';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VALIDATION_NAME_PATTERN = /^nba-scout-analytics-\d{4}-\d{2}\.validation(?:-[a-z0-9]+)?\.json$/i;
const SOURCE_SHARD_FIELDS = new Set([
  'schemaVersion',
  'metricsVersion',
  'seasonStartYear',
  'seasonEndYear',
  'team',
  'lineupsAndCombinations',
  'playerOnOff',
  'playerProfiles',
  'wowy',
]);
const DISALLOWED_COMPACT_KEYS = new Set([
  'raw', 'rawPbp', 'raw_pbp', 'event', 'events', 'playByPlay', 'play_by_play',
  'providerPayload', 'provider_payload', 'archivePath', 'archive_path', 'gzipPath',
  'gzip_path', 'jsonPath', 'json_path', 'sourcePath', 'source_path', 'dataShards',
  'data_shards', 'contexts',
]);
// Keep this in lockstep with nba_scout_compact_jsonb_is_safe() in the
// dedicated analytics migration. The importer fails locally if it would emit a
// key that the private database backstop rejects.
export const COMPACT_QUERY_KEYS = new Set([
  'games', 'gameResults', 'pointsFor', 'pointsAgainst', 'offensivePointsFor', 'defensivePointsAllowed',
  'offensivePossessions', 'defensivePossessions', 'totalPossessions', 'offensiveRating', 'defensiveRating',
  'netRating', 'plusMinusPer100', 'wins', 'losses', 'ties', 'unclassified', 'decisions', 'winPercentage',
  'reliability', 'possessions', 'grade', 'publishable', 'reliabilityScore', 'method', 'confidence95',
  'estimate', 'standardError', 'lower', 'upper', 'fourFactors', 'offense', 'defense',
  'effectiveFieldGoalPercentage', 'turnoverRate', 'offensiveReboundPercentage', 'freeThrowAttemptRate',
  'coverage', 'status', 'relevantEventCount', 'resolvedEventCount', 'unresolvedEventCount',
  'resolvedRelevantEventShare', 'shootingProfile', 'fieldGoalAttempts', 'fieldGoalsMade', 'twoPointAttempts',
  'twoPointMakes', 'threePointAttempts', 'threePointersMade', 'freeThrowAttempts', 'freeThrowsMade',
  'twoPointPercentage', 'threePointPercentage', 'freeThrowPercentage', 'threePointAttemptRate',
  'trueShootingPercentage', 'averageFieldGoalDistance', 'fieldGoalDistanceObserved', 'offensivePlaymaking',
  'assists', 'foulsDrawn', 'assistsPer100Possessions', 'foulsDrawnPer100Possessions',
  'assistedFieldGoalRate', 'assistToTurnoverRatio', 'possessionExtensions', 'secondChancePossessions',
  'secondChancePoints', 'secondChancePossessionRate', 'secondChancePointsPer100Possessions',
  'pointsPerSecondChancePossession', 'pointsOffTurnoverPossessions', 'pointsOffTurnovers',
  'pointsOffTurnoverPossessionRate', 'pointsOffTurnoverPer100Possessions', 'pointsPerPossessionAfterTurnover',
  'defensiveDisruption', 'steals', 'blocks', 'personalFouls', 'stealsPer100DefensivePossessions',
  'blocksPer100DefensivePossessions', 'personalFoulsPer100DefensivePossessions', 'blockRate',
  'stealForcedTurnoverRate', 'possessionOutcomes', 'empty', 'one', 'two', 'three', 'fourPlus',
  'accountedPossessions', 'scoringPossessions', 'scoringPossessionRate', 'pointsPerPossession', 'definition',
  'semantics', 'teamPossessions', 'minutes', 'possessionsPerGame', 'teamPossessionsPerGame',
  'minutesPerGame', 'pacePer48Minutes', 'on', 'off', 'gamesUsed', 'teamPossessionShare',
  'teamMinuteShare', 'exactLineupStartingGames', 'exactLineupClosingGames', 'exactLineupStartRate',
  'exactLineupCloseRate', 'offensiveRatingDifference', 'defensiveRatingDifference',
  'netRatingDifference', 'onOffNetRating', 'plusMinusPer100Difference', 'convention', 'starterGames',
  'closerGames', 'starterGameRate', 'closerGameRate', 'teamPossessionsWhileOnCourt',
  'structuredStatisticRows', 'recognizedStatisticRows', 'unknownFieldGoalMadeStatus',
  'unclassifiedFieldGoalAttempts', 'unclassifiedFieldGoalMakes', 'unknownFreeThrowMadeStatus',
  'unclassifiedRebounds', 'fieldGoalMadeStatusShare', 'fieldGoalValueClassifiedShare',
  'freeThrowMadeStatusShare', 'missingProviderShotType', 'missingProviderShotDescription',
  'providerShotTypeShare', 'providerShotDescriptionShare', 'scoringComplete', 'reboundsComplete',
  'boxScore', 'shooting', 'per36', 'per100Possessions', 'points', 'rebounds', 'shotAttemptsBlocked',
  'turnovers', 'technicalFouls', 'nonUnsportsmanlikeTechnicalFouls', 'totalTechnicalFouls', 'flagrantFouls', 'ejections',
  'offensiveRebounds', 'defensiveRebounds', 'fieldGoalPercentage', 'blockedAttemptRate', 'possessionEndingInvolvementProxy',
  'expectedMinutes', 'expectedNetRating', 'aOffBOn', 'aOffBOff', 'aOnBOff', 'aOnBOn', 'modelVersion',
  'seasonEndYear', 'seasonPhase', 'lambda', 'observationCount', 'directionalObservationCount',
  'pairedStintObservationCount', 'gameCount', 'totalPairedPossessions', 'totalOffensivePossessions',
  'excludedStintCount', 'skippedDirectionalObservationCount', 'inputSha256', 'interceptPer100',
  'baselineOffensiveRatingPer100', 'homeCourtEffectPer100', 'homeCourtSignConvention',
  'homeCourtNetRatingEffectPer100', 'formulation', 'defensiveSignConvention', 'contextSemantics',
  'sourceMode', 'sourceExactLineupPossessions', 'converged', 'iterationCount', 'residualNorm',
  'targetResidualNorm', 'solver', 'averageTeammateNetRapmPer100', 'averageOpponentNetRapmPer100',
  'teammateRapmContextPer100', 'opponentRapmContextPer100', 'displayMinimumPairedPossessions',
  'sampleSizeTier', 'ridgeReliabilityProxy', 'exposureShareOfAvailablePossessions',
  'offensiveObservationCount', 'defensiveObservationCount', 'offensiveRidgeReliabilityProxy',
  'defensiveRidgeReliabilityProxy',
]);

function usage() {
  return `
Usage:
  node .\\scripts\\import-local-scout-analytics.mjs --archive <directory> [options]

Options:
  --archive <directory>  Validated local Scout package under outputs/ (required)
  --report <path>        Optional non-secret local report under outputs/
  --verify-remote        Verify immutable private Storage artifacts before import
  --apply                Invoke private analytics import RPCs after verification
  --help                 Show this help

Default behavior is an offline, no-network dry run. --verify-remote and --apply
require SUPABASE_URL, NBA_ANALYTICS_SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY
for the dedicated analytics project. --apply also requires --verify-remote and
${WRITE_CONFIRMATION_ENV}=confirmed.
`;
}

function parseTokens(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? '');
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (!name) throw new Error('An option name is required.');
    if (inlineValue !== undefined) values.set(name, inlineValue);
    else if (argv[index + 1] && !String(argv[index + 1]).startsWith('--')) values.set(name, argv[++index]);
    else flags.add(name);
  }
  return { values, flags };
}

function workspacePath(value, label, { requireOutputs = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${label} is required.`);
  const resolved = path.resolve(raw);
  const relative = path.relative(path.resolve(ROOT), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside this workspace.`);
  }
  if (requireOutputs && relative.split(path.sep).filter(Boolean)[0]?.toLowerCase() !== 'outputs') {
    throw new Error(`${label} must be under this workspace's outputs/ directory.`);
  }
  return resolved;
}

export function optionsFromArgs(argv = []) {
  const { values, flags } = parseTokens(argv);
  const known = new Set(['help', 'archive', 'report', 'verify-remote', 'apply']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  if (flags.has('apply') && !flags.has('verify-remote')) {
    throw new Error('--apply requires --verify-remote so the immutable private archive is checked first.');
  }
  return {
    help: false,
    archiveDir: workspacePath(values.get('archive'), '--archive', { requireOutputs: true }),
    reportPath: values.has('report') ? workspacePath(values.get('report'), '--report', { requireOutputs: true }) : null,
    verifyRemote: flags.has('verify-remote'),
    apply: flags.has('apply'),
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function asArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
  return value;
}

function requiredText(value, label, { maxLength = 500 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} exceeds the compact query-index limit.`);
  return text;
}

function optionalScalar(value, { maxLength = 500 } = {}) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    return text && text.length <= maxLength ? text : undefined;
  }
  return undefined;
}

function pickScalars(source, keys) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const result = {};
  for (const key of keys) {
    const value = optionalScalar(input[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function compactNested(source, keys) {
  const result = pickScalars(source, keys);
  return result;
}

function compactConfidence(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of ['offensiveRating', 'defensiveRating', 'netRating', 'plusMinusPer100']) {
    const compact = compactNested(source[key], ['estimate', 'standardError', 'lower', 'upper']);
    if (Object.keys(compact).length) result[key] = compact;
  }
  return result;
}

function compactFourFactors(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const side of ['offense', 'defense']) {
    const component = pickScalars(source[side], [
      'effectiveFieldGoalPercentage',
      'turnoverRate',
      'offensiveReboundPercentage',
      'freeThrowAttemptRate',
    ]);
    const coverage = compactNested(source[side]?.coverage, [
      'status',
      'relevantEventCount',
      'resolvedEventCount',
      'unresolvedEventCount',
      'resolvedRelevantEventShare',
    ]);
    if (Object.keys(coverage).length) component.coverage = coverage;
    if (Object.keys(component).length) result[side] = component;
  }
  return result;
}

function compactShootingProfile(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const side of ['offense', 'defense']) {
    const compact = pickScalars(source[side], [
      'fieldGoalAttempts',
      'fieldGoalsMade',
      'twoPointAttempts',
      'twoPointMakes',
      'threePointAttempts',
      'threePointersMade',
      'freeThrowAttempts',
      'freeThrowsMade',
      'twoPointPercentage',
      'threePointPercentage',
      'freeThrowPercentage',
      'threePointAttemptRate',
      'trueShootingPercentage',
      'averageFieldGoalDistance',
      'fieldGoalDistanceObserved',
    ]);
    if (Object.keys(compact).length) result[side] = compact;
  }
  return result;
}

function compactMetric(value, label) {
  const source = asObject(value, label);
  const result = pickScalars(source, [
    'games',
    'pointsFor',
    'pointsAgainst',
    'offensivePointsFor',
    'defensivePointsAllowed',
    'offensivePossessions',
    'defensivePossessions',
    'totalPossessions',
    'offensiveRating',
    'defensiveRating',
    'netRating',
    'plusMinusPer100',
  ]);
  const gameResults = compactNested(source.gameResults, ['wins', 'losses', 'ties', 'unclassified', 'decisions', 'winPercentage']);
  if (Object.keys(gameResults).length) result.gameResults = gameResults;
  const reliability = compactNested(source.reliability, ['possessions', 'grade', 'publishable', 'reliabilityScore', 'method']);
  if (Object.keys(reliability).length) result.reliability = reliability;
  const confidence95 = compactConfidence(source.confidence95);
  if (Object.keys(confidence95).length) result.confidence95 = confidence95;
  const fourFactors = compactFourFactors(source.fourFactors);
  if (Object.keys(fourFactors).length) result.fourFactors = fourFactors;
  const shootingProfile = compactShootingProfile(source.shootingProfile);
  if (Object.keys(shootingProfile).length) result.shootingProfile = shootingProfile;
  const offensivePlaymaking = pickScalars(source.offensivePlaymaking, [
    'assists',
    'foulsDrawn',
    'assistsPer100Possessions',
    'foulsDrawnPer100Possessions',
    'assistedFieldGoalRate',
    'assistToTurnoverRatio',
  ]);
  const possessionExtensions = compactNested(source.offensivePlaymaking?.possessionExtensions, [
    'secondChancePossessions',
    'secondChancePoints',
    'secondChancePossessionRate',
    'secondChancePointsPer100Possessions',
    'pointsPerSecondChancePossession',
    'pointsOffTurnoverPossessions',
    'pointsOffTurnovers',
    'pointsOffTurnoverPossessionRate',
    'pointsOffTurnoverPer100Possessions',
    'pointsPerPossessionAfterTurnover',
  ]);
  if (Object.keys(possessionExtensions).length) offensivePlaymaking.possessionExtensions = possessionExtensions;
  if (Object.keys(offensivePlaymaking).length) result.offensivePlaymaking = offensivePlaymaking;
  const defensiveDisruption = pickScalars(source.defensiveDisruption, [
    'steals',
    'blocks',
    'personalFouls',
    'stealsPer100DefensivePossessions',
    'blocksPer100DefensivePossessions',
    'personalFoulsPer100DefensivePossessions',
    'blockRate',
    'stealForcedTurnoverRate',
  ]);
  if (Object.keys(defensiveDisruption).length) result.defensiveDisruption = defensiveDisruption;
  const possessionOutcomes = {};
  for (const side of ['offense', 'defense']) {
    const compact = pickScalars(source.possessionOutcomes?.[side], [
      'empty',
      'one',
      'two',
      'three',
      'fourPlus',
      'totalPossessions',
      'accountedPossessions',
      'scoringPossessions',
      'scoringPossessionRate',
      'pointsPerPossession',
    ]);
    if (Object.keys(compact).length) possessionOutcomes[side] = compact;
  }
  if (Object.keys(possessionOutcomes).length) result.possessionOutcomes = possessionOutcomes;
  return result;
}

function metricColumns(source) {
  const value = asObject(source, 'Metric source');
  return {
    total_possessions: optionalScalar(value.totalPossessions),
    net_rating: optionalScalar(value.netRating),
    offensive_rating: optionalScalar(value.offensiveRating),
    defensive_rating: optionalScalar(value.defensiveRating),
  };
}

function requiredUuid(value, label) {
  const text = requiredText(value, label, { maxLength: 36 }).toLowerCase();
  if (!UUID_PATTERN.test(text)) throw new Error(`${label} must be a provider UUID.`);
  return text;
}

function canonicalContextKey(value, label) {
  const text = requiredText(value, label, { maxLength: 120 });
  if (text !== text.toLowerCase() || !/^[a-z0-9:_-]+$/.test(text)) {
    throw new Error(`${label} must be a lower-case canonical context key.`);
  }
  return text;
}

function compactExposure(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = pickScalars(source, [
    'semantics',
    'games',
    'possessions',
    'teamPossessions',
    'minutes',
    'possessionsPerGame',
    'teamPossessionsPerGame',
    'minutesPerGame',
    'pacePer48Minutes',
  ]);
  for (const partition of ['on', 'off']) {
    const compact = pickScalars(source[partition], [
      'games',
      'possessions',
      'teamPossessions',
      'minutes',
      'possessionsPerGame',
      'teamPossessionsPerGame',
      'minutesPerGame',
      'pacePer48Minutes',
    ]);
    if (Object.keys(compact).length) result[partition] = compact;
  }
  return result;
}

function compactContinuity(value) {
  return pickScalars(value, [
    'gamesUsed',
    'teamPossessionShare',
    'teamMinuteShare',
    'exactLineupStartingGames',
    'exactLineupClosingGames',
    'exactLineupStartRate',
    'exactLineupCloseRate',
  ]);
}

function compactProjection(value) {
  return pickScalars(value, [
    'modelVersion',
    'expectedMinutes',
    'expectedNetRating',
    'offensiveRating',
    'defensiveRating',
    'netRating',
    'reliabilityScore',
  ]);
}

function compactProfile(row) {
  const result = {
    ...pickScalars(row, [
      'starterGames',
      'closerGames',
      'starterGameRate',
      'closerGameRate',
      'teamPossessionsWhileOnCourt',
    ]),
  };
  const scope = optionalScalar(row.scope);
  if (scope !== undefined) result.definition = scope;
  const coverage = pickScalars(row.coverage, [
    'status',
    'structuredStatisticRows',
    'recognizedStatisticRows',
    'unknownFieldGoalMadeStatus',
    'unclassifiedFieldGoalAttempts',
    'unclassifiedFieldGoalMakes',
    'unknownFreeThrowMadeStatus',
    'unclassifiedRebounds',
    'fieldGoalMadeStatusShare',
    'fieldGoalValueClassifiedShare',
    'freeThrowMadeStatusShare',
    'missingProviderShotType',
    'missingProviderShotDescription',
    'providerShotTypeShare',
    'providerShotDescriptionShare',
    'scoringComplete',
    'reboundsComplete',
  ]);
  if (Object.keys(coverage).length) result.coverage = coverage;
  const boxScore = pickScalars(row.boxScore, [
    'points',
    'fieldGoalAttempts',
    'fieldGoalsMade',
    'twoPointAttempts',
    'twoPointMakes',
    'threePointAttempts',
    'threePointersMade',
    'freeThrowAttempts',
    'freeThrowsMade',
    'offensiveRebounds',
    'defensiveRebounds',
    'rebounds',
    'assists',
    'steals',
    'blocks',
    'turnovers',
    'personalFouls',
    'foulsDrawn',
    'shotAttemptsBlocked',
    'technicalFouls',
    'nonUnsportsmanlikeTechnicalFouls',
    'totalTechnicalFouls',
    'flagrantFouls',
    'ejections',
  ]);
  if (Object.keys(boxScore).length) result.boxScore = boxScore;
  const shooting = pickScalars(row.shooting, [
    'fieldGoalPercentage',
    'twoPointPercentage',
    'threePointPercentage',
    'freeThrowPercentage',
    'effectiveFieldGoalPercentage',
    'trueShootingPercentage',
    'threePointAttemptRate',
    'blockedAttemptRate',
    'averageFieldGoalDistance',
    'fieldGoalDistanceObserved',
  ]);
  if (Object.keys(shooting).length) result.shooting = shooting;
  const per36 = pickScalars(row.per36, [
    'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'personalFouls', 'foulsDrawn',
    'shotAttemptsBlocked', 'technicalFouls', 'flagrantFouls',
  ]);
  if (Object.keys(per36).length) result.per36 = per36;
  const per100 = pickScalars(row.per100Possessions, [
    'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'personalFouls', 'foulsDrawn',
    'shotAttemptsBlocked', 'technicalFouls', 'flagrantFouls', 'possessionEndingInvolvementProxy',
  ]);
  if (Object.keys(per100).length) result.per100Possessions = per100;
  return result;
}

function compactDifferences(value) {
  return pickScalars(value, [
    'offensiveRatingDifference',
    'defensiveRatingDifference',
    'netRatingDifference',
    'onOffNetRating',
    'plusMinusPer100Difference',
    'status',
    'convention',
  ]);
}

function assertCompactValue(value, label, depth = 0) {
  if (depth > 5) throw new Error(`${label} exceeds the compact query-index nesting limit.`);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 500) throw new Error(`${label} contains an overlong text value.`);
    return;
  }
  if (Array.isArray(value) || !value || typeof value !== 'object') {
    throw new Error(`${label} must contain only compact scalar/object values.`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (!key || DISALLOWED_COMPACT_KEYS.has(key)) {
      throw new Error(`${label} contains a disallowed raw/archive-shaped field: ${key}.`);
    }
    if (!COMPACT_QUERY_KEYS.has(key)) {
      throw new Error(`${label} contains a key outside the private query-index allowlist: ${key}.`);
    }
    assertCompactValue(child, `${label}.${key}`, depth + 1);
  }
}

function assertMetricPayload(payload, label) {
  assertCompactValue(payload, label);
  return payload;
}

function canonicalLineupMembers(row, label) {
  const ids = asArray(row.playerIds, `${label}.playerIds`);
  const names = asArray(row.players, `${label}.players`);
  if (ids.length < 1 || ids.length > 5 || ids.length !== names.length) {
    throw new Error(`${label} must have matching one-to-five player IDs and names.`);
  }
  const members = ids.map((id, index) => ({
    id: requiredUuid(id, `${label}.playerIds[${index}]`),
    name: requiredText(names[index], `${label}.players[${index}]`),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(members.map((member) => member.id)).size !== members.length) {
    throw new Error(`${label} repeats a player ID.`);
  }
  return members;
}

function compactMetricRow(contextKey, source, label) {
  const metrics = assertMetricPayload(compactMetric(source, label), `${label}.metrics`);
  return {
    context_key: canonicalContextKey(contextKey, `${label}.contextKey`),
    metrics,
    ...metricColumns(source),
  };
}

async function readShard(descriptor, plan) {
  const artifact = plan.artifacts.find((candidate) => candidate.relativePath === descriptor.gzipPath);
  if (!artifact || artifact.kind !== 'team-gzip-shard') {
    throw new Error(`Validated private artifact is missing for ${descriptor.gzipPath}.`);
  }
  const gzipBuffer = await fs.readFile(artifact.localPath);
  if (gzipBuffer.length !== Number(descriptor.gzipBytes) || sha256(gzipBuffer) !== String(descriptor.gzipSha256).toLowerCase()) {
    throw new Error(`Scout gzip shard changed after validation: ${descriptor.gzipPath}.`);
  }
  let jsonBuffer;
  try {
    jsonBuffer = await GUNZIP(gzipBuffer);
  } catch (error) {
    throw new Error(`Scout gzip shard is unreadable: ${descriptor.gzipPath} (${String(error?.message ?? error)}).`);
  }
  if (jsonBuffer.length !== Number(descriptor.jsonBytes) || sha256(jsonBuffer) !== String(descriptor.jsonSha256).toLowerCase()) {
    throw new Error(`Scout uncompressed shard hash/size mismatch: ${descriptor.gzipPath}.`);
  }
  let source;
  try {
    source = JSON.parse(jsonBuffer.toString('utf8'));
  } catch (error) {
    throw new Error(`Scout shard JSON is unreadable: ${descriptor.gzipPath} (${String(error?.message ?? error)}).`);
  }
  const sourceObject = asObject(source, `${descriptor.gzipPath} JSON`);
  for (const key of Object.keys(sourceObject)) {
    if (!SOURCE_SHARD_FIELDS.has(key)) {
      throw new Error(`Scout shard includes an unsupported/raw-shaped top-level field: ${key}.`);
    }
  }
  return sourceObject;
}

function sourceShardMetadata(source, descriptor, manifest) {
  if (Number(source.schemaVersion) !== Number(manifest.schemaVersion)
      || String(source.metricsVersion ?? '') !== String(manifest.metricsVersion ?? '')
      || Number(source.seasonStartYear) !== Number(manifest.scope?.seasonStartYear)
      || Number(source.seasonEndYear) !== Number(manifest.scope?.seasonEndYear)) {
    throw new Error(`Scout shard metadata does not match its validated manifest: ${descriptor.gzipPath}.`);
  }
  const team = asObject(source.team, `${descriptor.gzipPath}.team`);
  const teamId = requiredUuid(team.teamId, `${descriptor.gzipPath}.team.teamId`);
  const descriptorTeamId = requiredUuid(descriptor.teamId, `${descriptor.gzipPath}.manifest.teamId`);
  if (teamId !== descriptorTeamId) throw new Error(`Scout shard team ID differs from its manifest descriptor: ${descriptor.gzipPath}.`);
  return { team, teamId, teamName: requiredText(team.team, `${descriptor.gzipPath}.team.team`) };
}

function buildShardPayload(source, descriptor, manifest) {
  const { team, teamId, teamName } = sourceShardMetadata(source, descriptor, manifest);
  const lineups = asArray(source.lineupsAndCombinations, `${descriptor.gzipPath}.lineupsAndCombinations`);
  const onOff = asArray(source.playerOnOff, `${descriptor.gzipPath}.playerOnOff`);
  const profiles = asArray(source.playerProfiles, `${descriptor.gzipPath}.playerProfiles`);
  const wowy = asArray(source.wowy, `${descriptor.gzipPath}.wowy`);
  const expectedRows = asObject(descriptor.rows, `${descriptor.gzipPath}.rows`);
  if (Number(expectedRows.team) !== 1
      || Number(expectedRows.lineupsAndCombinations) !== lineups.length
      || Number(expectedRows.playerOnOff) !== onOff.length
      || Number(expectedRows.playerProfiles) !== profiles.length
      || Number(expectedRows.wowy) !== wowy.length) {
    throw new Error(`Scout shard source row counts differ from its manifest: ${descriptor.gzipPath}.`);
  }

  const teamContexts = Object.entries(asObject(team.contexts, `${descriptor.gzipPath}.team.contexts`))
    .map(([key, value]) => compactMetricRow(key, value, `${descriptor.gzipPath}.team.contexts.${key}`))
    .sort((left, right) => left.context_key.localeCompare(right.context_key));
  if (!teamContexts.some((row) => row.context_key === 'all')) {
    throw new Error(`Scout shard lacks its all-team context: ${descriptor.gzipPath}.`);
  }

  const lineupPayload = [];
  const lineupKeys = new Set();
  for (let index = 0; index < lineups.length; index += 1) {
    const row = asObject(lineups[index], `${descriptor.gzipPath}.lineupsAndCombinations[${index}]`);
    if (requiredUuid(row.teamId, `${descriptor.gzipPath}.lineup.teamId`) !== teamId || requiredText(row.team, `${descriptor.gzipPath}.lineup.team`) !== teamName) {
      throw new Error(`Scout lineup has a mismatched team identity: ${descriptor.gzipPath}.`);
    }
    const members = canonicalLineupMembers(row, `${descriptor.gzipPath}.lineupsAndCombinations[${index}]`);
    const playerCount = Number(row.size);
    if (!Number.isInteger(playerCount) || playerCount !== members.length) {
      throw new Error(`Scout lineup player count is invalid: ${descriptor.gzipPath}.`);
    }
    const key = members.map((member) => member.id).join(',');
    if (lineupKeys.has(key)) throw new Error(`Scout shard repeats a lineup/co-presence identity: ${descriptor.gzipPath}.`);
    lineupKeys.add(key);
    const metricSource = asObject(row.contexts, `${descriptor.gzipPath}.lineup.contexts`).all;
    const metrics = assertMetricPayload(compactMetric(metricSource, `${descriptor.gzipPath}.lineup.all`), `${descriptor.gzipPath}.lineup.metrics`);
    const exposure = assertMetricPayload(compactExposure(row.exposure), `${descriptor.gzipPath}.lineup.exposure`);
    const continuity = assertMetricPayload(compactContinuity(row.continuity), `${descriptor.gzipPath}.lineup.continuity`);
    const projection = assertMetricPayload(compactProjection(row.projection), `${descriptor.gzipPath}.lineup.projection`);
    lineupPayload.push({
      player_ids: members.map((member) => member.id),
      player_names: members.map((member) => member.name),
      player_count: playerCount,
      semantics: requiredText(row.semantics, `${descriptor.gzipPath}.lineup.semantics`),
      minutes: optionalScalar(row.minutes),
      exposure,
      continuity,
      projection,
      metrics,
      ...metricColumns(metricSource),
    });
  }

  const onOffPayload = [];
  const onOffContextPayload = [];
  const onOffIds = new Set();
  for (let index = 0; index < onOff.length; index += 1) {
    const row = asObject(onOff[index], `${descriptor.gzipPath}.playerOnOff[${index}]`);
    if (requiredUuid(row.teamId, `${descriptor.gzipPath}.playerOnOff.teamId`) !== teamId || requiredText(row.team, `${descriptor.gzipPath}.playerOnOff.team`) !== teamName) {
      throw new Error(`Scout player on/off row has a mismatched team identity: ${descriptor.gzipPath}.`);
    }
    const playerId = requiredUuid(row.playerId, `${descriptor.gzipPath}.playerOnOff.playerId`);
    if (onOffIds.has(playerId)) throw new Error(`Scout shard repeats a player on/off identity: ${descriptor.gzipPath}.`);
    onOffIds.add(playerId);
    const scope = optionalScalar(row.scope);
    onOffPayload.push({
      player_id: playerId,
      player_name: requiredText(row.player, `${descriptor.gzipPath}.playerOnOff.player`),
      on_minutes: optionalScalar(row.onMinutes),
      off_minutes: optionalScalar(row.offMinutes),
      on_off_net_rating: optionalScalar(row.onOffNetRating),
      exposure: assertMetricPayload(compactExposure(row.exposure), `${descriptor.gzipPath}.playerOnOff.exposure`),
      scope: assertMetricPayload(scope === undefined ? {} : { definition: scope }, `${descriptor.gzipPath}.playerOnOff.scope`),
      differences: assertMetricPayload(compactDifferences(row.differences), `${descriptor.gzipPath}.playerOnOff.differences`),
    });
    for (const partition of ['on', 'off']) {
      const contexts = asObject(row[partition], `${descriptor.gzipPath}.playerOnOff.${partition}`);
      for (const [contextKey, metricSource] of Object.entries(contexts)) {
        const compact = compactMetricRow(contextKey, metricSource, `${descriptor.gzipPath}.playerOnOff.${partition}.${contextKey}`);
        onOffContextPayload.push({ player_id: playerId, partition, ...compact });
      }
    }
  }
  const onOffContextKeys = new Set();
  for (const row of onOffContextPayload) {
    const key = `${row.player_id}/${row.partition}/${row.context_key}`;
    if (onOffContextKeys.has(key)) throw new Error(`Scout shard repeats a player on/off context: ${descriptor.gzipPath}.`);
    onOffContextKeys.add(key);
  }

  const profilePayload = [];
  const profileIds = new Set();
  for (let index = 0; index < profiles.length; index += 1) {
    const row = asObject(profiles[index], `${descriptor.gzipPath}.playerProfiles[${index}]`);
    if (requiredUuid(row.teamId, `${descriptor.gzipPath}.playerProfiles.teamId`) !== teamId || requiredText(row.team, `${descriptor.gzipPath}.playerProfiles.team`) !== teamName) {
      throw new Error(`Scout player profile has a mismatched team identity: ${descriptor.gzipPath}.`);
    }
    const playerId = requiredUuid(row.playerId, `${descriptor.gzipPath}.playerProfiles.playerId`);
    if (!onOffIds.has(playerId) || profileIds.has(playerId)) {
      throw new Error(`Scout player profile does not have one matching on/off identity: ${descriptor.gzipPath}.`);
    }
    profileIds.add(playerId);
    profilePayload.push({
      player_id: playerId,
      player_name: requiredText(row.player, `${descriptor.gzipPath}.playerProfiles.player`),
      games_appeared: optionalScalar(row.gamesAppeared),
      minutes: optionalScalar(row.minutes),
      profile: assertMetricPayload(compactProfile(row), `${descriptor.gzipPath}.playerProfiles.profile`),
    });
  }
  if (profileIds.size !== onOffIds.size) {
    throw new Error(`Scout player profile/on-off coverage is not one-to-one: ${descriptor.gzipPath}.`);
  }

  const wowyPayload = [];
  const wowyKeys = new Set();
  for (let index = 0; index < wowy.length; index += 1) {
    const row = asObject(wowy[index], `${descriptor.gzipPath}.wowy[${index}]`);
    if (requiredUuid(row.teamId, `${descriptor.gzipPath}.wowy.teamId`) !== teamId || requiredText(row.team, `${descriptor.gzipPath}.wowy.team`) !== teamName) {
      throw new Error(`Scout WOWY row has a mismatched team identity: ${descriptor.gzipPath}.`);
    }
    const first = { id: requiredUuid(row.playerAId, `${descriptor.gzipPath}.wowy.playerAId`), name: requiredText(row.playerA, `${descriptor.gzipPath}.wowy.playerA`) };
    const second = { id: requiredUuid(row.playerBId, `${descriptor.gzipPath}.wowy.playerBId`), name: requiredText(row.playerB, `${descriptor.gzipPath}.wowy.playerB`) };
    if (first.id === second.id) throw new Error(`Scout WOWY row repeats its player identity: ${descriptor.gzipPath}.`);
    const [playerA, playerB] = [first, second].sort((left, right) => left.id.localeCompare(right.id));
    const pairKey = `${playerA.id}/${playerB.id}`;
    if (wowyKeys.has(pairKey)) throw new Error(`Scout shard repeats a WOWY pair: ${descriptor.gzipPath}.`);
    wowyKeys.add(pairKey);
    const cells = asObject(row.cells, `${descriptor.gzipPath}.wowy.cells`);
    const cellMetrics = {};
    for (const [key, compactKey] of [
      ['a_off_b_on', 'aOffBOn'],
      ['a_off_b_off', 'aOffBOff'],
      ['a_on_b_off', 'aOnBOff'],
      ['a_on_b_on', 'aOnBOn'],
    ]) {
      const sourceCell = cells[key];
      if (!sourceCell || typeof sourceCell !== 'object' || Array.isArray(sourceCell)
          || !sourceCell.all || typeof sourceCell.all !== 'object' || Array.isArray(sourceCell.all)) {
        // A missing cell means the descriptive shared-floor partition was not
        // observed. Preserve that as null rather than inventing a zero rate.
        cellMetrics[compactKey] = null;
      } else {
        cellMetrics[compactKey] = assertMetricPayload(
          compactMetric(sourceCell.all, `${descriptor.gzipPath}.wowy.cells.${key}.all`),
          `${descriptor.gzipPath}.wowy.cells.${key}`,
        );
      }
    }
    wowyPayload.push({
      player_a_id: playerA.id,
      player_a_name: playerA.name,
      player_b_id: playerB.id,
      player_b_name: playerB.name,
      semantics: requiredText(row.semantics, `${descriptor.gzipPath}.wowy.semantics`),
      cell_metrics: assertMetricPayload(cellMetrics, `${descriptor.gzipPath}.wowy.cellMetrics`),
    });
  }

  const payload = {
    shard: {
      team_id: teamId,
      team_name: teamName,
      gzip_relative_path: requiredText(descriptor.gzipPath, `${descriptor.gzipPath}.gzipPath`),
      gzip_sha256: requiredText(descriptor.gzipSha256, `${descriptor.gzipPath}.gzipSha256`).toLowerCase(),
      gzip_bytes: Number(descriptor.gzipBytes),
      json_sha256: requiredText(descriptor.jsonSha256, `${descriptor.gzipPath}.jsonSha256`).toLowerCase(),
      json_bytes: Number(descriptor.jsonBytes),
      team_row_count: 1,
      lineup_row_count: lineupPayload.length,
      player_on_off_row_count: onOffPayload.length,
      player_profile_row_count: profilePayload.length,
      wowy_row_count: wowyPayload.length,
    },
    team_contexts: teamContexts,
    lineups: lineupPayload,
    player_on_off: onOffPayload,
    player_on_off_contexts: onOffContextPayload,
    player_profiles: profilePayload,
    wowy: wowyPayload,
  };
  return payload;
}

function compactRapmModel(model, source) {
  const metadata = pickScalars(source, [
    'modelVersion',
    'seasonEndYear',
    'seasonPhase',
    'lambda',
    'observationCount',
    'directionalObservationCount',
    'pairedStintObservationCount',
    'gameCount',
    'totalPairedPossessions',
    'totalOffensivePossessions',
    'excludedStintCount',
    'skippedDirectionalObservationCount',
    'inputSha256',
    'interceptPer100',
    'baselineOffensiveRatingPer100',
    'homeCourtEffectPer100',
    'homeCourtSignConvention',
    'homeCourtNetRatingEffectPer100',
    'formulation',
    'defensiveSignConvention',
    'contextSemantics',
  ]);
  if (optionalScalar(model.sourceMode) !== undefined) metadata.sourceMode = optionalScalar(model.sourceMode);
  if (optionalScalar(model.sourceExactLineupPossessions) !== undefined) metadata.sourceExactLineupPossessions = optionalScalar(model.sourceExactLineupPossessions);
  const reliability = pickScalars(source.reliability, ['method']);
  if (Object.keys(reliability).length) metadata.reliability = reliability;
  const solver = pickScalars(source.solver, ['method', 'converged', 'iterationCount', 'residualNorm', 'targetResidualNorm']);
  if (Object.keys(solver).length) metadata.solver = solver;
  return assertMetricPayload(metadata, `RAPM ${model} metadata`);
}

function buildRapmPayload(manifest) {
  const rapm = asObject(manifest.rapm, 'Scout manifest.rapm');
  const configurations = [
    { model_kind: 'net', source: asObject(rapm.net, 'Scout manifest.rapm.net'), ratingField: 'rapmPer100' },
    { model_kind: 'offense_defense', source: asObject(rapm.offenseDefense, 'Scout manifest.rapm.offenseDefense'), ratingField: 'combinedRapmPer100' },
  ];
  const players = [];
  const models = [];
  for (const configuration of configurations) {
    models.push({
      model_kind: configuration.model_kind,
      model_metadata: compactRapmModel(rapm, configuration.source),
    });
    const seen = new Set();
    for (const [index, source] of asArray(configuration.source.players, `Scout ${configuration.model_kind} RAPM players`).entries()) {
      const row = asObject(source, `Scout ${configuration.model_kind} RAPM player ${index}`);
      const playerId = requiredUuid(row.providerPlayerId, `Scout ${configuration.model_kind} RAPM providerPlayerId`);
      if (seen.has(playerId)) throw new Error(`Scout ${configuration.model_kind} RAPM repeats a player identity.`);
      seen.add(playerId);
      const metrics = pickScalars(row, [
        'observationCount',
        'averageTeammateNetRapmPer100',
        'averageOpponentNetRapmPer100',
        'teammateRapmContextPer100',
        'opponentRapmContextPer100',
        'displayMinimumPairedPossessions',
        'sampleSizeTier',
        'ridgeReliabilityProxy',
        'exposureShareOfAvailablePossessions',
        'offensivePossessions',
        'defensivePossessions',
        'offensiveObservationCount',
        'defensiveObservationCount',
        'offensiveRidgeReliabilityProxy',
        'defensiveRidgeReliabilityProxy',
      ]);
      players.push({
        model_kind: configuration.model_kind,
        player_id: playerId,
        player_name: requiredText(row.playerName, `Scout ${configuration.model_kind} RAPM playerName`),
        rapm_per_100: optionalScalar(row[configuration.ratingField]),
        offensive_rapm_per_100: optionalScalar(row.offensiveRapmPer100),
        defensive_rapm_per_100: optionalScalar(row.defensiveRapmPer100),
        paired_possessions: optionalScalar(row.pairedPossessions),
        display_eligible: Boolean(row.displayEligible),
        metrics: assertMetricPayload(metrics, `Scout ${configuration.model_kind} RAPM metrics`),
      });
    }
  }
  return { models, players };
}

async function sourceValidation(plan) {
  const candidates = plan.artifacts
    .filter((artifact) => artifact.kind === 'metadata' && VALIDATION_NAME_PATTERN.test(artifact.relativePath))
    .sort((left, right) => {
      const leftPriority = /validation-v2\.json$/i.test(left.relativePath) ? 0 : 1;
      const rightPriority = /validation-v2\.json$/i.test(right.relativePath) ? 0 : 1;
      return leftPriority - rightPriority || left.relativePath.localeCompare(right.relativePath);
    });
  if (!candidates.length) throw new Error('Scout archive has no source-validation report.');
  for (const artifact of candidates) {
    let value;
    try {
      value = JSON.parse(await fs.readFile(artifact.localPath, 'utf8'));
    } catch (error) {
      throw new Error(`Scout source-validation report is unreadable: ${artifact.relativePath} (${String(error?.message ?? error)}).`);
    }
    const report = asObject(value, `Scout source-validation report ${artifact.relativePath}`);
    if (report.passed !== true || !Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.warnings) || report.warnings.length) {
      continue;
    }
    if (String(report.inputSha256 ?? '').toLowerCase() !== plan.manifestSha256) continue;
    return { relativePath: artifact.relativePath, sha256: artifact.sha256, report };
  }
  throw new Error('Scout archive has no clean passed source-validation report for this manifest hash.');
}

function expectedRowsFromManifest({ manifest, validation, scanCounts, rapm }) {
  const tables = asObject(manifest.tables, 'Scout manifest.tables');
  const expected = {
    teams: scanCounts.teams,
    lineups: scanCounts.lineups,
    playerOnOff: scanCounts.playerOnOff,
    playerProfiles: scanCounts.playerProfiles,
    wowy: scanCounts.wowy,
    rapmModels: rapm.models.length,
    rapmPlayers: rapm.players.length,
    teamContexts: scanCounts.teamContexts,
    playerOnOffContexts: scanCounts.playerOnOffContexts,
  };
  const manifestExpected = {
    teams: tables.teams,
    lineups: tables.lineupsAndCombinations,
    playerOnOff: tables.playerOnOff,
    playerProfiles: tables.playerProfiles,
    wowy: tables.wowy,
  };
  for (const [key, value] of Object.entries(manifestExpected)) {
    if (!Number.isInteger(value) || value < 0 || value !== expected[key]) {
      throw new Error(`Scout manifest table count is inconsistent for ${key}.`);
    }
  }
  const checks = asObject(validation.report.checks, 'Scout source-validation checks');
  const validationExpected = {
    teams: checks.teams,
    lineups: checks.combinations,
    playerOnOff: checks.onOff,
    playerProfiles: checks.playerProfiles,
    wowy: checks.wowy,
    rapmPlayers: Number(checks.netRapmPlayers) + Number(checks.offenseDefenseRapmPlayers),
  };
  for (const [key, value] of Object.entries(validationExpected)) {
    if (!Number.isInteger(value) || value < 0 || value !== expected[key]) {
      throw new Error(`Scout source-validation count is inconsistent for ${key}.`);
    }
  }
  if (expected.rapmModels !== 2) throw new Error('Scout archive must contain exactly two RAPM models.');
  return expected;
}

async function scanShardPayloads(plan, onShard = null) {
  const manifest = plan.manifest;
  const descriptors = asArray(manifest.dataShards, 'Scout manifest.dataShards')
    .slice()
    .sort((left, right) => requiredUuid(left.teamId, 'Scout manifest teamId').localeCompare(requiredUuid(right.teamId, 'Scout manifest teamId')));
  const seen = new Set();
  const counts = {
    teams: 0,
    lineups: 0,
    playerOnOff: 0,
    playerProfiles: 0,
    wowy: 0,
    teamContexts: 0,
    playerOnOffContexts: 0,
  };
  for (const descriptor of descriptors) {
    const teamId = requiredUuid(descriptor.teamId, 'Scout manifest shard teamId');
    if (seen.has(teamId)) throw new Error(`Scout manifest repeats a team shard identity: ${teamId}.`);
    seen.add(teamId);
    if (String(descriptor.jsonPath ?? '') !== String(descriptor.gzipPath ?? '').replace(/\.gz$/i, '')) {
      throw new Error(`Scout manifest has an unsafe/unsupported uncompressed shard path for ${teamId}.`);
    }
    const source = await readShard(descriptor, plan);
    const payload = buildShardPayload(source, descriptor, manifest);
    counts.teams += 1;
    counts.teamContexts += payload.team_contexts.length;
    counts.lineups += payload.lineups.length;
    counts.playerOnOff += payload.player_on_off.length;
    counts.playerOnOffContexts += payload.player_on_off_contexts.length;
    counts.playerProfiles += payload.player_profiles.length;
    counts.wowy += payload.wowy.length;
    await onShard?.(payload, { teamId, relativePath: descriptor.gzipPath });
    if (globalThis.gc) globalThis.gc();
  }
  return counts;
}

export async function buildScoutArchiveQueryPlan({ archiveDir, onProgress = null } = {}) {
  const plan = await validateLocalArchivePlan(await buildArchiveUploadPlan({ archiveDir }));
  const manifest = asObject(plan.manifest, 'Scout manifest');
  if (Number(manifest.schemaVersion) !== SUPPORTED_SCHEMA_VERSION || String(manifest.metricsVersion ?? '') !== SUPPORTED_METRICS_VERSION) {
    throw new Error(`Only Scout schema v${SUPPORTED_SCHEMA_VERSION} / ${SUPPORTED_METRICS_VERSION} is supported.`);
  }
  if (manifest.provenance?.sourceArchiveValidationPassed !== true) {
    throw new Error('Scout manifest does not certify its source archive validation.');
  }
  const seasonStartYear = Number(manifest.scope?.seasonStartYear);
  const seasonEndYear = Number(manifest.scope?.seasonEndYear);
  if (!Number.isInteger(seasonStartYear) || seasonEndYear !== seasonStartYear + 1) {
    throw new Error('Scout manifest must identify a single valid NBA season.');
  }
  const validation = await sourceValidation(plan);
  let scanned = 0;
  const total = asArray(manifest.dataShards, 'Scout manifest.dataShards').length;
  const scanCounts = await scanShardPayloads(plan, async (_payload, progress) => {
    scanned += 1;
    onProgress?.({ event: 'local-validation', completedTeams: scanned, totalTeams: total, ...progress });
  });
  const rapm = buildRapmPayload(manifest);
  const expectedRows = expectedRowsFromManifest({ manifest, validation, scanCounts, rapm });
  return {
    plan,
    manifest,
    validation,
    seasonStartYear,
    seasonEndYear,
    expectedRows,
    rapm,
  };
}

function confirmationPresent(value) {
  return String(value ?? '').trim().toLowerCase() === 'confirmed';
}

function remoteConfiguration({ requireWrite }) {
  const projectUrl = assertAnalyticsProjectTarget({
    projectUrl: process.env.SUPABASE_URL,
    expectedProjectUrl: process.env.NBA_ANALYTICS_SUPABASE_URL,
  });
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for private Scout archive access.');
  if (requireWrite && !confirmationPresent(process.env[WRITE_CONFIRMATION_ENV])) {
    throw new Error(`--apply requires ${WRITE_CONFIRMATION_ENV}=confirmed.`);
  }
  return { projectUrl, serviceRoleKey };
}

function compactResponseText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').slice(0, 700);
}

async function requestRpc({ projectUrl, serviceRoleKey, functionName, body, fetchImpl }) {
  const response = await fetchImpl(`${projectUrl}/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${functionName} failed with HTTP ${response.status}: ${compactResponseText(raw)}`);
  try {
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`${functionName} returned malformed JSON.`);
  }
}

async function verifyPrivateStorage(queryPlan, config, fetchImpl) {
  const maxArtifactBytes = Math.max(...queryPlan.plan.artifacts.map((artifact) => artifact.bytes));
  const bucket = await ensurePrivateBucket({
    ...config,
    bucket: DEFAULT_BUCKET,
    apply: false,
    maxArtifactBytes,
    fetchImpl,
  });
  if (bucket.status !== 'ready') {
    return { bucketStatus: bucket.status, complete: false, missing: queryPlan.plan.artifacts.map((artifact) => artifact.remotePath), sizeMismatch: [] };
  }
  const artifacts = await remoteArtifactMap({
    ...config,
    bucket: DEFAULT_BUCKET,
    prefix: queryPlan.plan.prefix,
    fetchImpl,
  });
  return { bucketStatus: bucket.status, ...verifyRemoteArtifacts({ plan: queryPlan.plan, remoteArtifacts: artifacts }) };
}

function reportForQueryPlan(queryPlan) {
  return {
    mode: 'dry-run',
    privateOnly: true,
    publicBrowserApi: false,
    storageBucket: queryPlan.plan.bucket,
    storagePrefix: queryPlan.plan.prefix,
    manifestSha256: queryPlan.plan.manifestSha256,
    sourceValidation: {
      report: queryPlan.validation.relativePath,
      sha256: queryPlan.validation.sha256,
      passed: true,
    },
    season: { startYear: queryPlan.seasonStartYear, endYear: queryPlan.seasonEndYear },
    expectedRows: queryPlan.expectedRows,
    archiveArtifactCount: queryPlan.plan.artifacts.length,
    archiveTotalBytes: queryPlan.plan.totalBytes,
    importsRawProviderPayloads: false,
    importsUncompressedTeamJson: false,
    queryContextCoverage: {
      lineups: 'all only',
      wowy: 'all only',
      teamAndPlayerOnOff: 'all validated source contexts',
    },
  };
}

async function writeReport(reportPath, report) {
  if (!reportPath) return null;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, reportPath);
  return reportPath;
}

export async function runScoutArchiveImport(options, { fetchImpl = globalThis.fetch, onProgress = null } = {}) {
  const queryPlan = await buildScoutArchiveQueryPlan({ archiveDir: options.archiveDir, onProgress });
  let report = reportForQueryPlan(queryPlan);
  if (!options.verifyRemote && !options.apply) {
    const reportPath = await writeReport(options.reportPath, report);
    return reportPath ? { ...report, reportPath } : report;
  }

  const config = remoteConfiguration({ requireWrite: options.apply });
  const remoteVerification = await verifyPrivateStorage(queryPlan, config, fetchImpl);
  report = { ...report, mode: options.apply ? 'apply' : 'verify-remote', remoteVerification };
  if (!remoteVerification.complete) {
    const reportPath = await writeReport(options.reportPath, report);
    if (options.apply) throw new Error('Private archive Storage verification did not complete; refusing database import.');
    return reportPath ? { ...report, reportPath } : report;
  }
  if (!options.apply) {
    const reportPath = await writeReport(options.reportPath, report);
    return reportPath ? { ...report, reportPath } : report;
  }

  const begin = await requestRpc({
    ...config,
    functionName: 'begin_nba_scout_archive_import',
    body: {
      p_payload: {
        manifestSha256: queryPlan.plan.manifestSha256,
        archiveBucket: queryPlan.plan.bucket,
        archivePrefix: queryPlan.plan.prefix,
        schemaVersion: queryPlan.manifest.schemaVersion,
        metricsVersion: queryPlan.manifest.metricsVersion,
        provider: requiredText(queryPlan.manifest.provider, 'Scout manifest.provider'),
        seasonStartYear: queryPlan.seasonStartYear,
        seasonEndYear: queryPlan.seasonEndYear,
        sourceValidationPassed: true,
        sourceValidationReportSha256: queryPlan.validation.sha256,
        archiveArtifactCount: queryPlan.plan.artifacts.length,
        archiveTotalBytes: queryPlan.plan.totalBytes,
        expectedRows: queryPlan.expectedRows,
      },
    },
    fetchImpl,
  });
  const archiveImportId = requiredUuid(begin?.archiveImportId, 'Private Scout import response archiveImportId');
  if (begin?.mode === 'already-ready') {
    const complete = { ...report, import: { archiveImportId, mode: 'already-ready', ingestedTeams: 0 } };
    const reportPath = await writeReport(options.reportPath, complete);
    return reportPath ? { ...complete, reportPath } : complete;
  }

  let ingestedTeams = 0;
  await scanShardPayloads(queryPlan.plan, async (payload, progress) => {
    const response = await requestRpc({
      ...config,
      functionName: 'ingest_nba_scout_archive_shard',
      body: { p_archive_import_id: archiveImportId, p_payload: payload },
      fetchImpl,
    });
    if (!['ingested', 'already-ingested'].includes(response?.mode)) {
      throw new Error(`Private Scout shard ingest returned an unexpected mode for ${progress.relativePath}.`);
    }
    ingestedTeams += 1;
    onProgress?.({ event: 'database-ingest', completedTeams: ingestedTeams, totalTeams: queryPlan.expectedRows.teams, ...progress });
  });
  const rapmResponse = await requestRpc({
    ...config,
    functionName: 'ingest_nba_scout_rapm',
    body: { p_archive_import_id: archiveImportId, p_payload: queryPlan.rapm },
    fetchImpl,
  });
  if (!['ingested', 'already-ingested'].includes(rapmResponse?.mode)) {
    throw new Error('Private Scout RAPM ingest returned an unexpected mode.');
  }
  const finalized = await requestRpc({
    ...config,
    functionName: 'finalize_nba_scout_archive_import',
    body: { p_archive_import_id: archiveImportId },
    fetchImpl,
  });
  if (finalized?.status !== 'ready') throw new Error('Private Scout archive did not finalize as ready.');
  const complete = {
    ...report,
    import: {
      archiveImportId,
      mode: begin?.mode,
      ingestedTeams,
      rapmMode: rapmResponse.mode,
      finalized: finalized.mode ?? 'ready',
      counts: finalized.counts ?? null,
    },
  };
  const reportPath = await writeReport(options.reportPath, complete);
  return reportPath ? { ...complete, reportPath } : complete;
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  const report = await runScoutArchiveImport(options, {
    onProgress: (progress) => console.log(JSON.stringify(progress)),
  });
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => {
    console.error(`Scout query-index import failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
