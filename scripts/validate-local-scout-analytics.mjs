import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MODULE_PATH);

function parseArgs(argv) {
  const options = { input: null, validationReport: null, output: null, seasonStartYear: 2025 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inline] = token.split(/=(.*)/s, 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--input') options.input = path.resolve(value);
    else if (name === '--validation-report') options.validationReport = path.resolve(value);
    else if (name === '--output') options.output = path.resolve(value);
    else if (name === '--season') options.seasonStartYear = Number.parseInt(value, 10);
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.input) throw new Error('--input is required.');
  return options;
}

function rounded(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fileSha256AndSize(filePath) {
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: digest.digest('hex') };
}

async function gzipContentSha256AndSize(filePath) {
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  await pipeline(
    createReadStream(filePath),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        digest.update(chunk);
        bytes += chunk.length;
        callback();
      },
    }),
  );
  return { bytes, sha256: digest.digest('hex') };
}

function requestGarbageCollection() {
  if (typeof global.gc === 'function') global.gc();
}

function closeEnough(left, right, tolerance = 0.002) {
  return left === null || right === null ? left === right : Math.abs(Number(left) - Number(right)) <= tolerance;
}

const TOTAL_FIELDS = [
  'pointsFor',
  'pointsAgainst',
  'offensivePointsFor',
  'defensivePointsAllowed',
  'offensivePossessions',
  'defensivePossessions',
  'totalPossessions',
];
const TRANSITION_CONTEXTS = [
  'transition:provider_fastbreak_v1',
  'transition:non_provider_fastbreak',
  'transition:unclassified',
];
const VENUE_CONTEXTS = ['venue:home', 'venue:away'];
const PERIOD_CONTEXTS = ['q1', 'q2', 'q3', 'q4', 'overtime', 'unclassified'].map((value) => `period:${value}`);
const HALF_CONTEXTS = ['first_half', 'second_half', 'overtime', 'unclassified'].map((value) => `half:${value}`);
const SCORE_STATE_CONTEXTS = [
  'tied', 'ahead_1_5', 'ahead_6_10', 'ahead_11_15', 'ahead_16_plus',
  'trailing_1_5', 'trailing_6_10', 'trailing_11_15', 'trailing_16_plus', 'unclassified',
].map((value) => `score_state:${value}`);
const COMPETITION_CONTEXTS = [
  'competition:garbage_time_proxy_v1',
  'competition:competitive_proxy_v1',
  'competition:unclassified',
];
const LEVERAGE_CONTEXTS = ['high', 'medium', 'standard', 'low', 'unclassified']
  .map((value) => `leverage:${value}`);
const CLUTCH_CONTEXTS = ['clutch_v1', 'non_clutch_v1', 'clutch:unclassified'];
const FOUR_FACTOR_COUNT_FIELDS = [
  'fieldGoalAttempts', 'fieldGoalsMade', 'threePointAttempts', 'threePointersMade',
  'freeThrowAttempts', 'turnovers', 'offensiveRebounds', 'opponentDefensiveRebounds',
];

function zeroMetric() {
  return Object.fromEntries(TOTAL_FIELDS.map((field) => [field, 0]));
}

function sumMetrics(contexts, names) {
  const total = zeroMetric();
  for (const name of names) {
    const metric = contexts?.[name];
    if (!metric) continue;
    for (const field of TOTAL_FIELDS) total[field] += Number(metric[field] ?? 0);
  }
  return total;
}

function checkPartition(all, sum, label, errors) {
  for (const field of TOTAL_FIELDS) {
    if (Number(all?.[field] ?? 0) !== Number(sum?.[field] ?? 0)) errors.push(`${label}.${field} does not partition all.`);
  }
}

function expectedFourFactors(counts) {
  const fga = Number(counts.fieldGoalAttempts ?? 0);
  const fgm = Number(counts.fieldGoalsMade ?? 0);
  const threeMade = Number(counts.threePointersMade ?? 0);
  const fta = Number(counts.freeThrowAttempts ?? 0);
  const turnovers = Number(counts.turnovers ?? 0);
  const orb = Number(counts.offensiveRebounds ?? 0);
  const opponentDrb = Number(counts.opponentDefensiveRebounds ?? 0);
  return {
    effectiveFieldGoalPercentage: fga > 0 ? rounded((fgm + 0.5 * threeMade) / fga, 4) : null,
    turnoverRate: fga + 0.44 * fta + turnovers > 0 ? rounded(turnovers / (fga + 0.44 * fta + turnovers), 4) : null,
    offensiveReboundPercentage: orb + opponentDrb > 0 ? rounded(orb / (orb + opponentDrb), 4) : null,
    freeThrowAttemptRate: fga > 0 ? rounded(fta / fga, 4) : null,
  };
}

function checkFourFactors(value, label, errors) {
  if (!value || typeof value !== 'object' || !value.counts) {
    errors.push(`${label} four factors are missing.`);
    return;
  }
  for (const field of FOUR_FACTOR_COUNT_FIELDS) {
    if (!Number.isInteger(value.counts[field]) || value.counts[field] < 0) errors.push(`${label}.${field} is invalid.`);
  }
  if (value.counts.fieldGoalsMade > value.counts.fieldGoalAttempts) errors.push(`${label} FGM exceeds FGA.`);
  if (value.counts.threePointersMade > value.counts.threePointAttempts) errors.push(`${label} 3PM exceeds 3PA.`);
  const expected = expectedFourFactors(value.counts);
  for (const [field, result] of Object.entries(expected)) {
    if (!closeEnough(value[field], result)) errors.push(`${label}.${field} does not reconcile.`);
  }
  const coverage = value.coverage;
  if (coverage && coverage.relevantEventCount !== coverage.resolvedEventCount + coverage.unresolvedEventCount) {
    errors.push(`${label} coverage event counts do not reconcile.`);
  }
  if (coverage) {
    for (const field of [
      'missingStructuredStatisticEvents',
      'missingTeamAttributionEvents',
      'foreignTeamAttributionEvents',
      'unexpectedTeamAttributionEvents',
      'missingMadeStatusEvents',
      'missingShotValueEvents',
      'unclassifiedReboundEvents',
    ]) {
      if (!Number.isInteger(Number(coverage[field] ?? 0)) || Number(coverage[field] ?? 0) < 0) {
        errors.push(`${label}.${field} is invalid.`);
      }
    }
    if (coverage.status === 'complete' && Number(coverage.unresolvedEventCount ?? 0) !== 0) {
      errors.push(`${label} marks unresolved events as complete.`);
    }
  }
}

function checkNonNegativeInteger(value, label, errors) {
  if (!Number.isInteger(value) || value < 0) errors.push(`${label} is invalid.`);
}

function checkShootingProfile(value, counts, points, label, errors) {
  if (!value || typeof value !== 'object') {
    errors.push(`${label} is missing.`);
    return;
  }
  for (const field of ['fieldGoalAttempts', 'fieldGoalsMade', 'twoPointAttempts', 'twoPointMakes', 'threePointAttempts', 'threePointersMade', 'freeThrowAttempts', 'freeThrowsMade', 'fieldGoalDistanceObserved']) {
    checkNonNegativeInteger(value[field], `${label}.${field}`, errors);
  }
  if (value.fieldGoalAttempts !== Number(counts.fieldGoalAttempts ?? 0)
    || value.fieldGoalsMade !== Number(counts.fieldGoalsMade ?? 0)
    || value.threePointAttempts !== Number(counts.threePointAttempts ?? 0)
    || value.threePointersMade !== Number(counts.threePointersMade ?? 0)
    || value.freeThrowAttempts !== Number(counts.freeThrowAttempts ?? 0)) errors.push(`${label} does not match four-factor counts.`);
  if (value.fieldGoalsMade > value.fieldGoalAttempts || value.threePointersMade > value.threePointAttempts || value.freeThrowsMade > value.freeThrowAttempts) errors.push(`${label} makes exceed attempts.`);
  const expectedTwoAttempts = Math.max(0, value.fieldGoalAttempts - value.threePointAttempts);
  const expectedTwoMakes = Math.max(0, value.fieldGoalsMade - value.threePointersMade);
  if (value.twoPointAttempts !== expectedTwoAttempts || value.twoPointMakes !== expectedTwoMakes) errors.push(`${label} two-point totals do not reconcile.`);
  const tsDenominator = 2 * (value.fieldGoalAttempts + (0.44 * value.freeThrowAttempts));
  const expected = {
    twoPointPercentage: expectedTwoAttempts > 0 ? rounded(value.twoPointMakes / expectedTwoAttempts, 4) : null,
    threePointPercentage: value.threePointAttempts > 0 ? rounded(value.threePointersMade / value.threePointAttempts, 4) : null,
    freeThrowPercentage: value.freeThrowAttempts > 0 ? rounded(value.freeThrowsMade / value.freeThrowAttempts, 4) : null,
    threePointAttemptRate: value.fieldGoalAttempts > 0 ? rounded(value.threePointAttempts / value.fieldGoalAttempts, 4) : null,
    trueShootingPercentage: tsDenominator > 0 ? rounded(Number(points) / tsDenominator, 4) : null,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (!closeEnough(value[field], expectedValue, 0.0001)) errors.push(`${label}.${field} does not reconcile.`);
  }
  if (value.fieldGoalDistanceObserved === 0 && value.averageFieldGoalDistance !== null) errors.push(`${label} average distance must be null without observed distances.`);
  if (value.fieldGoalDistanceObserved > 0 && (!Number.isFinite(value.averageFieldGoalDistance) || value.averageFieldGoalDistance < 0)) errors.push(`${label} average distance is invalid.`);
  const zones = value.shotZones;
  if (!zones || typeof zones !== 'object') errors.push(`${label}.shotZones are missing.`);
  else {
    let zoneAttempts = 0;
    let zoneMakes = 0;
    for (const name of ['atRim', 'shortMidRange', 'longMidRange']) {
      const zone = zones[name];
      if (!zone || typeof zone !== 'object') {
        errors.push(`${label}.shotZones.${name} is missing.`);
        continue;
      }
      checkNonNegativeInteger(zone.attempts, `${label}.shotZones.${name}.attempts`, errors);
      checkNonNegativeInteger(zone.makes, `${label}.shotZones.${name}.makes`, errors);
      if (zone.makes > zone.attempts) errors.push(`${label}.shotZones.${name} makes exceed attempts.`);
      const expectedRate = zone.attempts > 0 ? rounded(zone.makes / zone.attempts, 4) : null;
      if (!closeEnough(zone.percentage, expectedRate, 0.0001)) errors.push(`${label}.shotZones.${name}.percentage does not reconcile.`);
      zoneAttempts += Number(zone.attempts ?? 0);
      zoneMakes += Number(zone.makes ?? 0);
    }
    if (zoneAttempts > value.twoPointAttempts || zoneMakes > value.twoPointMakes) errors.push(`${label}.shotZones exceed two-point totals.`);
  }
}

function checkPossessionOutcomes(value, possessions, points, label, errors) {
  if (!value || typeof value !== 'object') {
    errors.push(`${label} is missing.`);
    return;
  }
  for (const field of ['empty', 'one', 'two', 'three', 'fourPlus', 'totalPossessions', 'accountedPossessions', 'scoringPossessions']) {
    checkNonNegativeInteger(value[field], `${label}.${field}`, errors);
  }
  const total = Number(possessions);
  const accounted = value.empty + value.one + value.two + value.three + value.fourPlus;
  if (value.totalPossessions !== total || value.accountedPossessions !== accounted || accounted !== total) errors.push(`${label} possession counts do not reconcile.`);
  if (value.scoringPossessions !== total - value.empty) errors.push(`${label} scoring possession count does not reconcile.`);
  const expectedRate = total > 0 ? rounded(value.scoringPossessions / total, 3) : null;
  const expectedPpp = total > 0 ? rounded(Number(points) / total, 3) : null;
  if (!closeEnough(value.scoringPossessionRate, expectedRate) || !closeEnough(value.pointsPerPossession, expectedPpp)) errors.push(`${label} rate values do not reconcile.`);
}

function checkExtendedProfiles(metric, label, errors) {
  const gameResults = metric.gameResults;
  if (!gameResults || typeof gameResults !== 'object') errors.push(`${label}.gameResults are missing.`);
  else {
    for (const field of ['wins', 'losses', 'ties', 'unclassified', 'decisions']) checkNonNegativeInteger(gameResults[field], `${label}.gameResults.${field}`, errors);
    if (gameResults.decisions !== gameResults.wins + gameResults.losses) errors.push(`${label}.gameResults decisions do not reconcile.`);
    if (gameResults.wins + gameResults.losses + gameResults.ties + gameResults.unclassified !== metric.games) errors.push(`${label}.gameResults do not reconcile to games.`);
    const expectedWinPercentage = gameResults.decisions > 0 ? rounded(gameResults.wins / gameResults.decisions, 4) : null;
    if (!closeEnough(gameResults.winPercentage, expectedWinPercentage, 0.0001)) errors.push(`${label}.gameResults win percentage does not reconcile.`);
  }
  checkShootingProfile(metric.shootingProfile?.offense, metric.fourFactors?.offense?.counts ?? {}, metric.offensivePointsFor, `${label}.shootingProfile.offense`, errors);
  checkShootingProfile(metric.shootingProfile?.defense, metric.fourFactors?.defense?.counts ?? {}, metric.defensivePointsAllowed, `${label}.shootingProfile.defense`, errors);
  checkPossessionOutcomes(metric.possessionOutcomes?.offense, metric.offensivePossessions, metric.offensivePointsFor, `${label}.possessionOutcomes.offense`, errors);
  checkPossessionOutcomes(metric.possessionOutcomes?.defense, metric.defensivePossessions, metric.defensivePointsAllowed, `${label}.possessionOutcomes.defense`, errors);
  const playmaking = metric.offensivePlaymaking;
  if (!playmaking || typeof playmaking !== 'object') errors.push(`${label}.offensivePlaymaking is missing.`);
  else {
    for (const field of ['assists', 'foulsDrawn']) checkNonNegativeInteger(playmaking[field], `${label}.offensivePlaymaking.${field}`, errors);
    const expectedAssistsPer100 = metric.offensivePossessions > 0 ? rounded(100 * playmaking.assists / metric.offensivePossessions) : null;
    const expectedFoulsPer100 = metric.offensivePossessions > 0 ? rounded(100 * playmaking.foulsDrawn / metric.offensivePossessions) : null;
    const expectedAssistedFieldGoalRate = metric.fourFactors?.offense?.counts?.fieldGoalsMade > 0
      ? rounded(playmaking.assists / metric.fourFactors.offense.counts.fieldGoalsMade, 4) : null;
    const expectedAssistTurnoverRatio = metric.fourFactors?.offense?.counts?.turnovers > 0
      ? rounded(playmaking.assists / metric.fourFactors.offense.counts.turnovers, 4) : null;
    if (!closeEnough(playmaking.assistsPer100Possessions, expectedAssistsPer100)
      || !closeEnough(playmaking.foulsDrawnPer100Possessions, expectedFoulsPer100)
      || !closeEnough(playmaking.assistedFieldGoalRate, expectedAssistedFieldGoalRate, 0.0001)
      || !closeEnough(playmaking.assistToTurnoverRatio, expectedAssistTurnoverRatio, 0.0001)) errors.push(`${label}.offensivePlaymaking does not reconcile.`);
    const extensions = playmaking.possessionExtensions;
    if (!extensions || typeof extensions !== 'object') errors.push(`${label}.offensivePlaymaking.possessionExtensions are missing.`);
    else {
      for (const field of ['secondChancePossessions', 'secondChancePoints', 'pointsOffTurnoverPossessions', 'pointsOffTurnovers']) {
        checkNonNegativeInteger(extensions[field], `${label}.offensivePlaymaking.possessionExtensions.${field}`, errors);
      }
      if (extensions.secondChancePossessions > metric.offensivePossessions || extensions.pointsOffTurnoverPossessions > metric.offensivePossessions) errors.push(`${label}.offensivePlaymaking.possessionExtensions exceed offensive possessions.`);
      const expectedExtensions = {
        secondChancePossessionRate: metric.offensivePossessions > 0 ? rounded(extensions.secondChancePossessions / metric.offensivePossessions, 4) : null,
        secondChancePointsPer100Possessions: metric.offensivePossessions > 0 ? rounded(100 * extensions.secondChancePoints / metric.offensivePossessions) : null,
        pointsPerSecondChancePossession: extensions.secondChancePossessions > 0 ? rounded(extensions.secondChancePoints / extensions.secondChancePossessions) : null,
        pointsOffTurnoverPossessionRate: metric.offensivePossessions > 0 ? rounded(extensions.pointsOffTurnoverPossessions / metric.offensivePossessions, 4) : null,
        pointsOffTurnoverPer100Possessions: metric.offensivePossessions > 0 ? rounded(100 * extensions.pointsOffTurnovers / metric.offensivePossessions) : null,
        pointsPerPossessionAfterTurnover: extensions.pointsOffTurnoverPossessions > 0 ? rounded(extensions.pointsOffTurnovers / extensions.pointsOffTurnoverPossessions) : null,
      };
      for (const [field, expected] of Object.entries(expectedExtensions)) {
        if (!closeEnough(extensions[field], expected, field.includes('Rate') ? 0.0001 : 0.002)) errors.push(`${label}.offensivePlaymaking.possessionExtensions.${field} does not reconcile.`);
      }
    }
  }
  const disruption = metric.defensiveDisruption;
  if (!disruption || typeof disruption !== 'object') errors.push(`${label}.defensiveDisruption is missing.`);
  else {
    for (const field of ['steals', 'blocks', 'personalFouls']) checkNonNegativeInteger(disruption[field], `${label}.defensiveDisruption.${field}`, errors);
    const expectedStealsPer100 = metric.defensivePossessions > 0 ? rounded(100 * disruption.steals / metric.defensivePossessions) : null;
    const expectedBlocksPer100 = metric.defensivePossessions > 0 ? rounded(100 * disruption.blocks / metric.defensivePossessions) : null;
    const expectedFoulsPer100 = metric.defensivePossessions > 0 ? rounded(100 * disruption.personalFouls / metric.defensivePossessions) : null;
    const expectedBlockRate = metric.fourFactors?.defense?.counts?.fieldGoalAttempts > 0
      ? rounded(disruption.blocks / metric.fourFactors.defense.counts.fieldGoalAttempts, 4) : null;
    const expectedStealForcedTurnoverRate = metric.fourFactors?.defense?.counts?.turnovers > 0
      ? rounded(disruption.steals / metric.fourFactors.defense.counts.turnovers, 4) : null;
    if (!closeEnough(disruption.stealsPer100DefensivePossessions, expectedStealsPer100)
      || !closeEnough(disruption.blocksPer100DefensivePossessions, expectedBlocksPer100)
      || !closeEnough(disruption.personalFoulsPer100DefensivePossessions, expectedFoulsPer100)
      || !closeEnough(disruption.blockRate, expectedBlockRate, 0.0001)
      || !closeEnough(disruption.stealForcedTurnoverRate, expectedStealForcedTurnoverRate, 0.0001)) errors.push(`${label}.defensiveDisruption does not reconcile.`);
  }
}

function checkInterval(value, label, errors) {
  if (value === null) return;
  if (!value || ![value.estimate, value.standardError, value.lower, value.upper].every(Number.isFinite)) {
    errors.push(`${label} confidence interval is invalid.`);
    return;
  }
  if (value.standardError < 0 || value.lower > value.estimate || value.estimate > value.upper) {
    errors.push(`${label} confidence interval ordering is invalid.`);
  }
}

function checkMetric(metric, label, errors) {
  if (!metric || typeof metric !== 'object') {
    errors.push(`${label} is not an object.`);
    return;
  }
  const offPoss = Number(metric.offensivePossessions);
  const defPoss = Number(metric.defensivePossessions);
  const pointsFor = Number(metric.pointsFor);
  const pointsAgainst = Number(metric.pointsAgainst);
  const offensivePointsFor = Number(metric.offensivePointsFor);
  const defensivePointsAllowed = Number(metric.defensivePointsAllowed);
  for (const [field, value] of Object.entries({
    games: metric.games,
    pointsFor,
    pointsAgainst,
    offensivePointsFor,
    defensivePointsAllowed,
    offensivePossessions: offPoss,
    defensivePossessions: defPoss,
  })) {
    if (!Number.isInteger(value) || value < 0) errors.push(`${label}.${field} is invalid.`);
  }
  if (metric.totalPossessions !== offPoss + defPoss) errors.push(`${label}.totalPossessions does not reconcile.`);
  const expectedOrtg = offPoss > 0 ? rounded(100 * offensivePointsFor / offPoss) : null;
  const expectedDrtg = defPoss > 0 ? rounded(100 * defensivePointsAllowed / defPoss) : null;
  const expectedNet = expectedOrtg === null || expectedDrtg === null ? null : rounded(expectedOrtg - expectedDrtg);
  const expectedPlusMinus = offPoss + defPoss > 0
    ? rounded(200 * (pointsFor - pointsAgainst) / (offPoss + defPoss))
    : null;
  if (!closeEnough(metric.offensiveRating, expectedOrtg)) errors.push(`${label}.offensiveRating does not reconcile.`);
  if (!closeEnough(metric.defensiveRating, expectedDrtg)) errors.push(`${label}.defensiveRating does not reconcile.`);
  if (!closeEnough(metric.netRating, expectedNet)) errors.push(`${label}.netRating does not reconcile.`);
  if (!closeEnough(metric.plusMinusPer100, expectedPlusMinus)) errors.push(`${label}.plusMinusPer100 does not reconcile.`);
  if (metric.reliability?.possessions !== metric.totalPossessions) errors.push(`${label}.reliability possession count does not reconcile.`);
  for (const [name, interval] of Object.entries(metric.confidence95 ?? {})) checkInterval(interval, `${label}.${name}`, errors);
  checkFourFactors(metric.fourFactors?.offense, `${label}.fourFactors.offense`, errors);
  checkFourFactors(metric.fourFactors?.defense, `${label}.fourFactors.defense`, errors);
  checkExtendedProfiles(metric, label, errors);
}

function checkContextMap(contexts, label, phases, errors) {
  if (!contexts?.all) {
    errors.push(`${label} is missing the all context.`);
    return;
  }
  for (const [context, metric] of Object.entries(contexts)) checkMetric(metric, `${label}.${context}`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, TRANSITION_CONTEXTS), `${label}.transition`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, VENUE_CONTEXTS), `${label}.venue`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, PERIOD_CONTEXTS), `${label}.period`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, HALF_CONTEXTS), `${label}.half`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, SCORE_STATE_CONTEXTS), `${label}.scoreState`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, COMPETITION_CONTEXTS), `${label}.competition`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, LEVERAGE_CONTEXTS), `${label}.leverage`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, CLUTCH_CONTEXTS), `${label}.clutch`, errors);
  checkPartition(contexts.all, sumMetrics(contexts, phases.map((phase) => `phase:${phase}`)), `${label}.phase`, errors);
  for (const window of ['window:last_5', 'window:last_10', 'window:last_20']) {
    const value = contexts[window];
    if (!value) continue;
    for (const field of TOTAL_FIELDS) {
      if (Number(value[field] ?? 0) > Number(contexts.all[field] ?? 0)) errors.push(`${label}.${window}.${field} exceeds all.`);
    }
  }
}

function checkOnOff(row, index, phases, errors) {
  checkContextMap(row.on, `onOff.${index}.on`, phases, errors);
  checkContextMap(row.off, `onOff.${index}.off`, phases, errors);
  const expected = row.on?.all?.netRating === null || row.off?.all?.netRating === null
    ? null
    : rounded(row.on.all.netRating - row.off.all.netRating);
  if (!closeEnough(row.onOffNetRating, expected)) errors.push(`onOff.${index}.onOffNetRating does not reconcile.`);
  if (!closeEnough(row.differences?.netRatingDifference, expected)) errors.push(`onOff.${index}.differences do not reconcile.`);
  if (![row.onMinutes, row.offMinutes].every((value) => Number.isFinite(value) && value >= 0)) errors.push(`onOff.${index} minutes are invalid.`);
}

function checkPlayerProfile(row, onOff, index, errors) {
  if (!row || typeof row !== 'object') {
    errors.push(`playerProfile.${index} is not an object.`);
    return;
  }
  if (!onOff) {
    errors.push(`playerProfile.${index} has no matching player on/off row.`);
    return;
  }
  if (row.teamId !== onOff.teamId || row.playerId !== onOff.playerId) errors.push(`playerProfile.${index} does not match its player on/off row.`);
  const box = row.boxScore;
  if (!box || typeof box !== 'object') {
    errors.push(`playerProfile.${index}.boxScore is missing.`);
    return;
  }
  const countFields = [
    'points', 'fieldGoalAttempts', 'fieldGoalsMade', 'twoPointAttempts', 'twoPointMakes',
    'threePointAttempts', 'threePointersMade', 'unclassifiedFieldGoalAttempts',
    'unclassifiedFieldGoalMakes', 'freeThrowAttempts', 'freeThrowsMade',
    'offensiveRebounds', 'defensiveRebounds', 'rebounds', 'assists', 'steals', 'blocks',
    'turnovers', 'personalFouls', 'foulsDrawn', 'shotAttemptsBlocked', 'technicalFouls',
    'nonUnsportsmanlikeTechnicalFouls', 'totalTechnicalFouls', 'flagrantFouls', 'ejections',
  ];
  for (const field of countFields) checkNonNegativeInteger(box[field], `playerProfile.${index}.boxScore.${field}`, errors);
  if (box.fieldGoalsMade > box.fieldGoalAttempts || box.twoPointMakes > box.twoPointAttempts || box.threePointersMade > box.threePointAttempts || box.freeThrowsMade > box.freeThrowAttempts) errors.push(`playerProfile.${index}.boxScore makes exceed attempts.`);
  if (box.twoPointAttempts + box.threePointAttempts + box.unclassifiedFieldGoalAttempts !== box.fieldGoalAttempts
    || box.twoPointMakes + box.threePointersMade + box.unclassifiedFieldGoalMakes !== box.fieldGoalsMade) {
    errors.push(`playerProfile.${index}.boxScore field-goal components do not reconcile.`);
  }
  if (box.rebounds !== box.offensiveRebounds + box.defensiveRebounds) errors.push(`playerProfile.${index}.boxScore rebounds do not reconcile.`);
  if (box.totalTechnicalFouls !== box.technicalFouls + box.nonUnsportsmanlikeTechnicalFouls) errors.push(`playerProfile.${index}.boxScore technical fouls do not reconcile.`);
  if (box.shotAttemptsBlocked > box.fieldGoalAttempts) errors.push(`playerProfile.${index}.boxScore blocked attempts exceed field-goal attempts.`);
  const expectedPoints = (2 * box.twoPointMakes) + (3 * box.threePointersMade) + box.freeThrowsMade;
  if (box.points !== expectedPoints) errors.push(`playerProfile.${index}.boxScore points do not reconcile.`);
  const profileCoverage = row.coverage ?? {};
  for (const field of [
    'structuredStatisticRows', 'recognizedStatisticRows', 'unknownFieldGoalMadeStatus',
    'unclassifiedFieldGoalAttempts', 'unclassifiedFieldGoalMakes',
    'unknownFreeThrowMadeStatus', 'unclassifiedRebounds',
    'missingProviderShotType', 'missingProviderShotDescription',
  ]) checkNonNegativeInteger(profileCoverage[field], `playerProfile.${index}.coverage.${field}`, errors);
  if (profileCoverage.recognizedStatisticRows > profileCoverage.structuredStatisticRows
    || profileCoverage.unknownFieldGoalMadeStatus > box.fieldGoalAttempts
    || profileCoverage.unclassifiedFieldGoalAttempts !== box.unclassifiedFieldGoalAttempts
    || profileCoverage.unclassifiedFieldGoalMakes !== box.unclassifiedFieldGoalMakes
    || profileCoverage.unclassifiedFieldGoalMakes > profileCoverage.unclassifiedFieldGoalAttempts
    || profileCoverage.unknownFreeThrowMadeStatus > box.freeThrowAttempts
    || profileCoverage.missingProviderShotType > box.fieldGoalAttempts
    || profileCoverage.missingProviderShotDescription > box.fieldGoalAttempts) {
    errors.push(`playerProfile.${index}.coverage counters do not reconcile.`);
  }
  const fieldGoalOutcomesComplete = profileCoverage.unknownFieldGoalMadeStatus === 0;
  const fieldGoalValuesComplete = profileCoverage.unclassifiedFieldGoalAttempts === 0;
  const freeThrowOutcomesComplete = profileCoverage.unknownFreeThrowMadeStatus === 0;
  const scoringComplete = fieldGoalOutcomesComplete
    && freeThrowOutcomesComplete
    && profileCoverage.unclassifiedFieldGoalMakes === 0;
  const reboundsComplete = profileCoverage.unclassifiedRebounds === 0;
  const expectedCoverageStatus = fieldGoalOutcomesComplete && fieldGoalValuesComplete && freeThrowOutcomesComplete && reboundsComplete
    ? 'complete'
    : 'partial';
  if (profileCoverage.status !== expectedCoverageStatus
    || profileCoverage.scoringComplete !== scoringComplete
    || profileCoverage.reboundsComplete !== reboundsComplete) {
    errors.push(`playerProfile.${index}.coverage status does not reconcile.`);
  }
  const expectedCoverageShares = {
    fieldGoalMadeStatusShare: box.fieldGoalAttempts > 0
      ? rounded((box.fieldGoalAttempts - profileCoverage.unknownFieldGoalMadeStatus) / box.fieldGoalAttempts, 4)
      : null,
    fieldGoalValueClassifiedShare: box.fieldGoalAttempts > 0
      ? rounded((box.fieldGoalAttempts - profileCoverage.unclassifiedFieldGoalAttempts) / box.fieldGoalAttempts, 4)
      : null,
    freeThrowMadeStatusShare: box.freeThrowAttempts > 0
      ? rounded((box.freeThrowAttempts - profileCoverage.unknownFreeThrowMadeStatus) / box.freeThrowAttempts, 4)
      : null,
    providerShotTypeShare: box.fieldGoalAttempts > 0
      ? rounded((box.fieldGoalAttempts - profileCoverage.missingProviderShotType) / box.fieldGoalAttempts, 4)
      : null,
    providerShotDescriptionShare: box.fieldGoalAttempts > 0
      ? rounded((box.fieldGoalAttempts - profileCoverage.missingProviderShotDescription) / box.fieldGoalAttempts, 4)
      : null,
  };
  for (const [field, value] of Object.entries(expectedCoverageShares)) {
    if (!closeEnough(profileCoverage[field], value, 0.0001)) errors.push(`playerProfile.${index}.coverage.${field} does not reconcile.`);
  }
  if (!Number.isFinite(row.minutes) || row.minutes < 0 || !closeEnough(row.minutes, onOff.onMinutes)) errors.push(`playerProfile.${index} minutes do not reconcile to on/off.`);
  const expectedOnPossessions = Number(onOff.on?.all?.totalPossessions ?? 0) / 2;
  if (!closeEnough(row.teamPossessionsWhileOnCourt, expectedOnPossessions)) errors.push(`playerProfile.${index} on-court team possessions do not reconcile.`);
  if (row.gamesAppeared !== onOff.on?.all?.games) errors.push(`playerProfile.${index} games appeared do not reconcile.`);
  for (const field of ['starterGames', 'closerGames']) {
    checkNonNegativeInteger(row[field], `playerProfile.${index}.${field}`, errors);
    if (row[field] > row.gamesAppeared) errors.push(`playerProfile.${index}.${field} exceeds games appeared.`);
  }
  const expectedStarterRate = row.gamesAppeared > 0 ? rounded(row.starterGames / row.gamesAppeared, 4) : null;
  const expectedCloserRate = row.gamesAppeared > 0 ? rounded(row.closerGames / row.gamesAppeared, 4) : null;
  if (!closeEnough(row.starterGameRate, expectedStarterRate, 0.0001) || !closeEnough(row.closerGameRate, expectedCloserRate, 0.0001)) errors.push(`playerProfile.${index} role rates do not reconcile.`);
  const shooting = row.shooting;
  if (!shooting || typeof shooting !== 'object') errors.push(`playerProfile.${index}.shooting is missing.`);
  else {
    const expected = {
      fieldGoalPercentage: fieldGoalOutcomesComplete && box.fieldGoalAttempts > 0 ? rounded(box.fieldGoalsMade / box.fieldGoalAttempts, 4) : null,
      twoPointPercentage: fieldGoalOutcomesComplete && fieldGoalValuesComplete && box.twoPointAttempts > 0 ? rounded(box.twoPointMakes / box.twoPointAttempts, 4) : null,
      threePointPercentage: fieldGoalOutcomesComplete && fieldGoalValuesComplete && box.threePointAttempts > 0 ? rounded(box.threePointersMade / box.threePointAttempts, 4) : null,
      freeThrowPercentage: freeThrowOutcomesComplete && box.freeThrowAttempts > 0 ? rounded(box.freeThrowsMade / box.freeThrowAttempts, 4) : null,
      effectiveFieldGoalPercentage: fieldGoalOutcomesComplete && profileCoverage.unclassifiedFieldGoalMakes === 0 && box.fieldGoalAttempts > 0
        ? rounded((box.fieldGoalsMade + (0.5 * box.threePointersMade)) / box.fieldGoalAttempts, 4)
        : null,
      trueShootingPercentage: scoringComplete && 2 * (box.fieldGoalAttempts + (0.44 * box.freeThrowAttempts)) > 0
        ? rounded(box.points / (2 * (box.fieldGoalAttempts + (0.44 * box.freeThrowAttempts))), 4)
        : null,
      threePointAttemptRate: fieldGoalValuesComplete && box.fieldGoalAttempts > 0 ? rounded(box.threePointAttempts / box.fieldGoalAttempts, 4) : null,
      blockedAttemptRate: box.fieldGoalAttempts > 0 ? rounded(box.shotAttemptsBlocked / box.fieldGoalAttempts, 4) : null,
    };
    for (const [field, value] of Object.entries(expected)) if (!closeEnough(shooting[field], value, 0.0001)) errors.push(`playerProfile.${index}.shooting.${field} does not reconcile.`);
    checkNonNegativeInteger(shooting.fieldGoalDistanceObserved, `playerProfile.${index}.shooting.fieldGoalDistanceObserved`, errors);
    if (shooting.fieldGoalDistanceObserved === 0 && shooting.averageFieldGoalDistance !== null) errors.push(`playerProfile.${index}.shooting average distance must be null without observations.`);
    const zones = shooting.shotZones;
    if (!zones || typeof zones !== 'object') errors.push(`playerProfile.${index}.shooting.shotZones are missing.`);
    else {
      let attempts = 0;
      let makes = 0;
      for (const name of ['atRim', 'shortMidRange', 'longMidRange']) {
        const zone = zones[name];
        if (!zone) {
          errors.push(`playerProfile.${index}.shooting.shotZones.${name} is missing.`);
          continue;
        }
        checkNonNegativeInteger(zone.attempts, `playerProfile.${index}.shooting.shotZones.${name}.attempts`, errors);
        checkNonNegativeInteger(zone.makes, `playerProfile.${index}.shooting.shotZones.${name}.makes`, errors);
        checkNonNegativeInteger(zone.unknownMadeStatus, `playerProfile.${index}.shooting.shotZones.${name}.unknownMadeStatus`, errors);
        if (zone.makes > zone.attempts) errors.push(`playerProfile.${index}.shooting.shotZones.${name} makes exceed attempts.`);
        if (zone.unknownMadeStatus > zone.attempts) errors.push(`playerProfile.${index}.shooting.shotZones.${name} unknown outcomes exceed attempts.`);
        const expectedRate = zone.unknownMadeStatus === 0 && zone.attempts > 0 ? rounded(zone.makes / zone.attempts, 4) : null;
        if (!closeEnough(zone.percentage, expectedRate, 0.0001)) errors.push(`playerProfile.${index}.shooting.shotZones.${name}.percentage does not reconcile.`);
        attempts += Number(zone.attempts ?? 0);
        makes += Number(zone.makes ?? 0);
      }
      if (attempts > box.twoPointAttempts || makes > box.twoPointMakes) errors.push(`playerProfile.${index}.shooting zones exceed two-point totals.`);
    }
    const checkShotCategories = (categories, missing, label) => {
      let categoryAttempts = 0;
      for (const [category, counts] of Object.entries(categories ?? {})) {
        for (const field of ['attempts', 'makes', 'unknownMadeStatus']) {
          checkNonNegativeInteger(counts[field], `playerProfile.${index}.shooting.${label}.${category}.${field}`, errors);
        }
        if (counts.makes > counts.attempts || counts.unknownMadeStatus > counts.attempts) {
          errors.push(`playerProfile.${index}.shooting.${label}.${category} counts are invalid.`);
        }
        const expectedPercentage = counts.unknownMadeStatus === 0 && counts.attempts > 0
          ? rounded(counts.makes / counts.attempts, 4)
          : null;
        const expectedShare = box.fieldGoalAttempts > 0 ? rounded(counts.attempts / box.fieldGoalAttempts, 4) : null;
        if (!closeEnough(counts.percentage, expectedPercentage, 0.0001)
          || !closeEnough(counts.shareOfAllFieldGoalAttempts, expectedShare, 0.0001)) {
          errors.push(`playerProfile.${index}.shooting.${label}.${category} rates do not reconcile.`);
        }
        categoryAttempts += counts.attempts;
      }
      if (categoryAttempts + missing !== box.fieldGoalAttempts) {
        errors.push(`playerProfile.${index}.shooting.${label} attempts do not reconcile.`);
      }
    };
    checkShotCategories(shooting.providerShotTypeProfile, profileCoverage.missingProviderShotType, 'providerShotTypeProfile');
    checkShotCategories(shooting.providerShotDescriptionProfile, profileCoverage.missingProviderShotDescription, 'providerShotDescriptionProfile');
  }
  const per36 = row.per36 ?? {};
  const per100 = row.per100Possessions ?? {};
  const reb = box.rebounds;
  for (const [field, descriptor] of Object.entries({
    points: { value: box.points, available: scoringComplete },
    rebounds: { value: reb, available: reboundsComplete },
    assists: { value: box.assists, available: true },
    steals: { value: box.steals, available: true },
    blocks: { value: box.blocks, available: true },
    turnovers: { value: box.turnovers, available: true },
    personalFouls: { value: box.personalFouls, available: true },
    foulsDrawn: { value: box.foulsDrawn, available: true },
    shotAttemptsBlocked: { value: box.shotAttemptsBlocked, available: true },
    technicalFouls: { value: box.totalTechnicalFouls, available: true },
    flagrantFouls: { value: box.flagrantFouls, available: true },
  })) {
    const expected36 = descriptor.available && row.minutes > 0 ? rounded(36 * descriptor.value / row.minutes) : null;
    const expected100 = descriptor.available && expectedOnPossessions > 0 ? rounded(100 * descriptor.value / expectedOnPossessions) : null;
    if (!closeEnough(per36[field], expected36)) errors.push(`playerProfile.${index}.per36.${field} does not reconcile.`);
    if (!closeEnough(per100[field], expected100)) errors.push(`playerProfile.${index}.per100Possessions.${field} does not reconcile.`);
  }
  const involvement = box.fieldGoalAttempts + (0.44 * box.freeThrowAttempts) + box.turnovers;
  const expectedInvolvement = expectedOnPossessions > 0 ? rounded(100 * involvement / expectedOnPossessions) : null;
  if (!closeEnough(per100.possessionEndingInvolvementProxy, expectedInvolvement)) errors.push(`playerProfile.${index}.per100Possessions involvement proxy does not reconcile.`);
}

export function checkCombinationContinuity(row, index, errors) {
  const continuity = row?.continuity;
  if (!continuity || typeof continuity !== 'object') {
    errors.push(`combination.${index}.continuity is missing.`);
    return;
  }
  const isExactLineup = row.size === 5;
  const games = Number(row.contexts?.all?.games);
  if (!Number.isInteger(games) || games < 0) {
    errors.push(`combination.${index}.continuity games-used coverage is invalid.`);
    return;
  }
  const countFields = [
    ['exactLineupStartingGames', 'exactLineupStartRate'],
    ['exactLineupClosingGames', 'exactLineupCloseRate'],
  ];
  for (const [countField, rateField] of countFields) {
    if (!isExactLineup) {
      if (continuity[countField] !== null || continuity[rateField] !== null) {
        errors.push(`combination.${index}.continuity exact-lineup role fields must be null for a non-five-player combination.`);
      }
      continue;
    }
    checkNonNegativeInteger(continuity[countField], `combination.${index}.continuity.${countField}`, errors);
    if (Number.isInteger(continuity[countField]) && continuity[countField] > games) {
      errors.push(`combination.${index}.continuity.${countField} exceeds games used.`);
    }
    const expectedRate = games > 0 ? rounded(continuity[countField] / games, 4) : null;
    if (!closeEnough(continuity[rateField], expectedRate, 0.0001)) {
      errors.push(`combination.${index}.continuity.${rateField} does not reconcile.`);
    }
  }
}

function checkProjection(row, playerRapm, netRapm, index, errors) {
  if (row.size !== 5) {
    if (row.projection) errors.push(`combination.${index} non-five-player row has a projection.`);
    return;
  }
  const projection = row.projection;
  if (!projection || projection.status !== 'available') {
    errors.push(`combination.${index} exact lineup projection is unavailable.`);
    return;
  }
  const expectedSum = rounded(row.playerIds.reduce((total, id) => total + Number(playerRapm[id]), 0));
  if (!closeEnough(projection.rapmSumPer100, expectedSum)) errors.push(`combination.${index} RAPM projection sum does not reconcile.`);
  const expectedObserved = rounded(projection.rapmSumPer100 - projection.averageOpponentLineupRapmPer100 + projection.homeCourtExposureAdjustmentPer100);
  if (!closeEnough(projection.expectedObservedNetRatingPer100, expectedObserved)) errors.push(`combination.${index} contextual projection does not reconcile.`);
  const homeCourtSource = projection.homeCourtAdjustmentSource ?? {};
  if (homeCourtSource.modelVersion !== netRapm.modelVersion
    || homeCourtSource.signConvention !== netRapm.homeCourtSignConvention
    || !closeEnough(homeCourtSource.homeCourtNetRatingEffectPer100, netRapm.homeCourtNetRatingEffectPer100)) {
    errors.push(`combination.${index} home-court adjustment source does not match net RAPM.`);
  }
  const exposureBalance = Number(homeCourtSource.signedExposureBalance);
  if (!Number.isFinite(exposureBalance) || Math.abs(exposureBalance) > 1.000001) {
    errors.push(`combination.${index} home-court exposure balance is invalid.`);
  } else {
    const expectedHomeCourtAdjustment = rounded(netRapm.homeCourtNetRatingEffectPer100 * exposureBalance);
    if (!closeEnough(projection.homeCourtExposureAdjustmentPer100, expectedHomeCourtAdjustment, 0.002)) {
      errors.push(`combination.${index} home-court projection adjustment does not reconcile.`);
    }
  }
  const expectedNeutral = rounded(projection.rapmSumPer100 + projection.shrunkSynergyPer100);
  if (!closeEnough(projection.projectedNetRatingPer100, expectedNeutral)) errors.push(`combination.${index} neutral projection does not reconcile.`);
}

async function validate() {
  const options = parseArgs(process.argv.slice(2));
  const [inputRaw, validationRaw] = await Promise.all([
    fs.readFile(options.input, 'utf8'),
    options.validationReport ? fs.readFile(options.validationReport, 'utf8') : Promise.resolve(null),
  ]);
  const input = JSON.parse(inputRaw);
  const sourceValidation = validationRaw ? JSON.parse(validationRaw) : null;
  const errors = [];
  const warnings = [];
  const coverage = input.coverage ?? {};
  const phases = input.scope?.includedPhases ?? [];

  if (input.schemaVersion !== 4) errors.push('Unsupported Scout analytics schemaVersion.');
  if (input.metricsVersion !== 'nba-scout-metrics-v4') errors.push('Unexpected Scout metrics version.');
  if (input.scope?.seasonStartYear !== options.seasonStartYear) errors.push('Season scope does not match the requested season.');
  if (input.scope?.networkAccess !== 'not used' || input.scope?.supabaseWrites !== 'none') errors.push('Output is not explicitly offline/no-write.');
  if (input.scope?.transientReconstructionReplay !== true) warnings.push('Current reconstruction replay was disabled.');
  if (!Array.isArray(phases) || !phases.length || phases.includes('preseason')) errors.push('Primary phase scope is invalid.');
  if (input.provenance?.derivedReconstructionMethodVersion !== 'sportradar-nba-lineup-reconstruction-v3') errors.push('Scout package was not derived with reconstruction v3.');
  if (sourceValidation && input.provenance?.sourceArchiveValidationPassed !== true) errors.push('Source archive validation did not pass.');
  if (sourceValidation && input.provenance?.sourceValidationReportSha256 !== sha256(validationRaw)) {
    errors.push('Source validation report hash does not match output provenance.');
  }
  if (sourceValidation) {
    const season = sourceValidation.seasons?.find((item) => item.seasonStartYear === options.seasonStartYear);
    if (!season) errors.push('Source validation does not contain the requested season.');
    else {
      if (coverage.archivesDiscovered !== season.files?.discoveredGameFiles) errors.push('Discovered archive count differs from source validation.');
      if (season.manifestSha256 && input.provenance?.manifestSha256 !== season.manifestSha256) {
        errors.push('Source manifest hash does not match output provenance.');
      }
    }
  }

  if (coverage.archivesExcludedByPhase + coverage.archivesPhaseCandidates !== coverage.archivesDiscovered) errors.push('Phase archive counts do not reconcile.');
  if (coverage.archivesExcludedNonFranchise + coverage.archivesOfficialCandidates !== coverage.archivesPhaseCandidates) errors.push('Official-team archive counts do not reconcile.');
  if (coverage.archivesEligible + coverage.archivesReplayPartial + coverage.archivesReplayIneligible !== coverage.archivesOfficialCandidates) errors.push('Replay archive counts do not reconcile.');
  if (coverage.exactLineupPossessions + coverage.excludedPossessions !== coverage.possessionsInEligibleArchives) errors.push('Possession inclusion counts do not reconcile.');
  if (Object.values(coverage.eligibleArchivesByPhase ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0) !== coverage.archivesEligible) errors.push('Eligible phase counts do not reconcile.');
  if ((coverage.contextPossessions?.provider_fastbreak_v1 ?? 0) + (coverage.contextPossessions?.non_provider_fastbreak ?? 0) + (coverage.contextPossessions?.transitionUnclassified ?? 0) !== coverage.exactLineupPossessions) errors.push('Transition coverage does not reconcile.');
  if ((coverage.contextPossessions?.garbageTimeProxy ?? 0) + (coverage.contextPossessions?.competitiveProxy ?? 0) + (coverage.contextPossessions?.competitionUnclassified ?? 0) !== coverage.exactLineupPossessions) errors.push('Competition coverage does not reconcile.');
  if ((coverage.contextPossessions?.clutch_v1 ?? 0) + (coverage.contextPossessions?.non_clutch_v1 ?? 0) + (coverage.contextPossessions?.clutchUnclassified ?? 0) !== coverage.exactLineupPossessions) errors.push('Clutch coverage does not reconcile.');
  if (Object.values(coverage.fourFactorCoverage ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0) !== coverage.exactLineupPossessions) errors.push('Four-factor possession coverage does not reconcile.');
  if (!Number.isInteger(coverage.nominalDefensePoints) || coverage.nominalDefensePoints < 0) errors.push('Nominal-defense point coverage is invalid.');

  const netRapm = input.rapm?.net ?? {};
  const odRapm = input.rapm?.offenseDefense ?? {};
  const comboKeys = new Set();
  const comboTotalsBySize = new Map();
  const playerRapm = Object.fromEntries((netRapm.players ?? []).map((row) => [row.providerPlayerId, row.rapmPer100]));
  const playerKeys = new Set();
  const playerOnTotals = zeroMetric();
  const wowyKeys = new Set();
  const wowyTogetherTotals = zeroMetric();
  let teamCount = 0;
  let combinationCount = 0;
  let playerOnOffCount = 0;
  let playerProfileCount = 0;
  let wowyCount = 0;
  let shardJsonBytes = 0;
  let shardGzipBytes = 0;
  const shardTeamIds = new Set();
  if (!Array.isArray(input.dataShards) || !input.dataShards.length) errors.push('Team shard manifest is missing.');
  for (const [shardIndex, descriptor] of (input.dataShards ?? []).entries()) {
    const shardPath = path.resolve(path.dirname(options.input), descriptor.jsonPath ?? '');
    let shardRaw;
    let shard;
    try {
      shardRaw = await fs.readFile(shardPath, 'utf8');
      shard = JSON.parse(shardRaw);
    } catch (error) {
      errors.push(`Unable to read team shard ${shardIndex}: ${String(error?.message ?? error)}`);
      continue;
    }
    const rawBytes = Buffer.byteLength(shardRaw);
    if (sha256(shardRaw) !== descriptor.jsonSha256) errors.push(`Team shard ${shardIndex} SHA-256 does not match.`);
    if (rawBytes !== descriptor.jsonBytes) errors.push(`Team shard ${shardIndex} byte count does not match.`);
    shardJsonBytes += rawBytes;
    const shardGzipPath = path.resolve(path.dirname(options.input), descriptor.gzipPath ?? '');
    try {
      const compressed = await fileSha256AndSize(shardGzipPath);
      shardGzipBytes += compressed.bytes;
      if (compressed.sha256 !== descriptor.gzipSha256) errors.push(`Team shard ${shardIndex} gzip SHA-256 does not match.`);
      if (compressed.bytes !== descriptor.gzipBytes) errors.push(`Team shard ${shardIndex} gzip byte count does not match.`);
      const decompressed = await gzipContentSha256AndSize(shardGzipPath);
      if (decompressed.sha256 !== descriptor.jsonSha256 || decompressed.bytes !== descriptor.jsonBytes) {
        errors.push(`Team shard ${shardIndex} gzip content differs from JSON.`);
      }
    } catch (error) {
      errors.push(`Unable to verify team shard ${shardIndex} gzip: ${String(error?.message ?? error)}`);
    }
    if (shard.schemaVersion !== input.schemaVersion || shard.metricsVersion !== input.metricsVersion) errors.push(`Team shard ${shardIndex} schema does not match the manifest.`);
    if (shard.team?.teamId !== descriptor.teamId) errors.push(`Team shard ${shardIndex} team does not match its descriptor.`);
    if (shardTeamIds.has(descriptor.teamId)) errors.push(`Duplicate team shard for ${descriptor.teamId}.`);
    shardTeamIds.add(descriptor.teamId);
    teamCount += 1;
    checkContextMap(shard.team?.contexts, `team.${shardIndex}`, phases, errors);

    const combinations = shard.lineupsAndCombinations ?? [];
    const onOffRows = shard.playerOnOff ?? [];
    const playerProfiles = shard.playerProfiles ?? [];
    const wowyRows = shard.wowy ?? [];
    combinationCount += combinations.length;
    playerOnOffCount += onOffRows.length;
    playerProfileCount += playerProfiles.length;
    wowyCount += wowyRows.length;
    if (descriptor.rows?.lineupsAndCombinations !== combinations.length
      || descriptor.rows?.playerOnOff !== onOffRows.length
      || descriptor.rows?.playerProfiles !== playerProfiles.length
      || descriptor.rows?.wowy !== wowyRows.length) errors.push(`Team shard ${shardIndex} row counts do not match.`);

    for (const [rowIndex, row] of combinations.entries()) {
      const index = `${shardIndex}.${rowIndex}`;
      const key = `${row.teamId}~${row.size}~${(row.playerIds ?? []).join('|')}`;
      if (comboKeys.has(key)) errors.push(`Duplicate combination key at row ${index}.`);
      comboKeys.add(key);
      if (row.teamId !== descriptor.teamId) errors.push(`Combination ${index} belongs to the wrong shard.`);
      if (![2, 3, 4, 5].includes(row.size)) errors.push(`Invalid combination size at row ${index}.`);
      if (!Array.isArray(row.playerIds) || row.playerIds.length !== row.size || new Set(row.playerIds).size !== row.size) errors.push(`Invalid player IDs at combination row ${index}.`);
      if ([...(row.playerIds ?? [])].sort((a, b) => String(a).localeCompare(String(b))).join('|') !== (row.playerIds ?? []).join('|')) errors.push(`Combination player IDs are not canonical at row ${index}.`);
      if (!Number.isFinite(row.minutes) || row.minutes < 0) errors.push(`Combination minutes are invalid at row ${index}.`);
      checkContextMap(row.contexts, `combination.${index}`, phases, errors);
      checkCombinationContinuity(row, index, errors);
      checkProjection(row, playerRapm, netRapm, index, errors);
      const total = comboTotalsBySize.get(row.size) ?? zeroMetric();
      for (const field of TOTAL_FIELDS) total[field] += Number(row.contexts?.all?.[field] ?? 0);
      comboTotalsBySize.set(row.size, total);
    }

    for (const [rowIndex, row] of onOffRows.entries()) {
      const index = `${shardIndex}.${rowIndex}`;
      const key = `${row.teamId}~${row.playerId}`;
      if (playerKeys.has(key)) errors.push(`Duplicate on/off key at row ${index}.`);
      playerKeys.add(key);
      if (row.teamId !== descriptor.teamId) errors.push(`On/off row ${index} belongs to the wrong shard.`);
      checkOnOff(row, index, phases, errors);
      for (const field of TOTAL_FIELDS) playerOnTotals[field] += Number(row.on?.all?.[field] ?? 0);
    }

    const onOffByPlayer = new Map(onOffRows.map((row) => [`${row.teamId}~${row.playerId}`, row]));
    const profileKeys = new Set();
    for (const [rowIndex, row] of playerProfiles.entries()) {
      const index = `${shardIndex}.${rowIndex}`;
      const key = `${row.teamId}~${row.playerId}`;
      if (profileKeys.has(key)) errors.push(`Duplicate player profile key at row ${index}.`);
      profileKeys.add(key);
      if (row.teamId !== descriptor.teamId) errors.push(`Player profile ${index} belongs to the wrong shard.`);
      checkPlayerProfile(row, onOffByPlayer.get(key), index, errors);
    }
    if (profileKeys.size !== onOffByPlayer.size || [...onOffByPlayer.keys()].some((key) => !profileKeys.has(key))) errors.push(`Team shard ${shardIndex} player profile coverage differs from player on/off coverage.`);

    for (const [rowIndex, row] of wowyRows.entries()) {
      const index = `${shardIndex}.${rowIndex}`;
      const key = `${row.teamId}~${row.playerAId}~${row.playerBId}`;
      if (wowyKeys.has(key)) errors.push(`Duplicate WOWY key at row ${index}.`);
      wowyKeys.add(key);
      if (row.teamId !== descriptor.teamId) errors.push(`WOWY row ${index} belongs to the wrong shard.`);
      if (String(row.playerAId).localeCompare(String(row.playerBId)) >= 0) errors.push(`WOWY player IDs are not canonical at row ${index}.`);
      for (const [cell, contexts] of Object.entries(row.cells ?? {})) {
        if (!['a_on_b_on', 'a_on_b_off', 'a_off_b_on', 'a_off_b_off'].includes(cell)) errors.push(`Invalid WOWY cell at row ${index}.`);
        checkContextMap(contexts, `wowy.${index}.${cell}`, phases, errors);
      }
      for (const field of TOTAL_FIELDS) wowyTogetherTotals[field] += Number(row.cells?.a_on_b_on?.all?.[field] ?? 0);
    }
    shard = null;
    shardRaw = null;
    requestGarbageCollection();
  }
  if (teamCount !== 30) errors.push('Scout package must contain exactly 30 NBA franchise shards.');
  if (input.tables?.teams !== teamCount
    || input.tables?.lineupsAndCombinations !== combinationCount
    || input.tables?.playerOnOff !== playerOnOffCount
    || input.tables?.playerProfiles !== playerProfileCount
    || input.tables?.wowy !== wowyCount) errors.push('Manifest table counts do not reconcile to team shards.');
  if (input.storage?.format !== 'schema_v4_streamed_team_shards_with_manifest') errors.push('Unexpected Scout package storage format.');
  if (input.storage?.writeMode !== 'bounded_memory_atomic_team_stream_v1') errors.push('Scout package write mode is missing or unsupported.');
  if (input.storage?.shardCount !== teamCount) errors.push('Manifest shard count does not reconcile.');
  if (input.storage?.shardJsonBytes !== shardJsonBytes) errors.push('Manifest shard JSON bytes do not reconcile.');
  if (input.storage?.shardGzipBytes !== shardGzipBytes) errors.push('Manifest shard gzip bytes do not reconcile.');

  const fiveTotals = comboTotalsBySize.get(5) ?? zeroMetric();
  for (const [size, multiplier] of [[2, 10], [3, 10], [4, 5], [5, 1]]) {
    const total = comboTotalsBySize.get(size) ?? zeroMetric();
    for (const field of TOTAL_FIELDS) {
      if (total[field] !== fiveTotals[field] * multiplier) errors.push(`Combination size ${size} ${field} does not match its combinatorial multiplier.`);
    }
  }
  if (fiveTotals.offensivePossessions !== coverage.exactLineupPossessions || fiveTotals.defensivePossessions !== coverage.exactLineupPossessions) errors.push('Five-player lineup totals do not reconcile to exact possessions.');
  if (playerOnTotals.offensivePossessions !== coverage.exactLineupPossessions * 5 || playerOnTotals.defensivePossessions !== coverage.exactLineupPossessions * 5) errors.push('Player-on totals do not reconcile to five players per side.');
  if (wowyTogetherTotals.offensivePossessions !== coverage.exactLineupPossessions * 10 || wowyTogetherTotals.defensivePossessions !== coverage.exactLineupPossessions * 10) errors.push('WOWY together totals do not reconcile to ten pairs per side.');

  if (netRapm.modelVersion !== 'weighted_ridge_rapm_v1') errors.push('Unexpected net RAPM version.');
  if (odRapm.modelVersion !== 'weighted_ridge_offense_defense_rapm_v2') errors.push('Unexpected offense/defense RAPM version.');
  if (!Number.isFinite(odRapm.baselineOffensiveRatingPer100)) errors.push('Offense/defense RAPM baseline is invalid.');
  if (!Number.isFinite(odRapm.homeCourtEffectPer100)) errors.push('Offense/defense RAPM home-court effect is invalid.');
  if (!Number.isFinite(odRapm.homeCourtNetRatingEffectPer100)) errors.push('Offense/defense RAPM home-court net effect is invalid.');
  if (!Number.isFinite(netRapm.homeCourtNetRatingEffectPer100)) errors.push('Net RAPM home-court net effect is invalid.');
  if (netRapm.homeCourtSignConvention !== 'positive_increases_home_net_rating_relative_to_away') errors.push('Net RAPM home-court sign convention is invalid.');
  if (!closeEnough(netRapm.homeCourtNetRatingEffectPer100, netRapm.interceptPer100, 0.003)) errors.push('Net RAPM home-court effect does not reconcile to its legacy intercept alias.');
  if (odRapm.homeCourtSignConvention !== 'positive_increases_home_offensive_rate_and_decreases_away_offensive_rate') errors.push('Offense/defense RAPM home-court sign convention is invalid.');
  if (!closeEnough(odRapm.homeCourtNetRatingEffectPer100, Number(odRapm.homeCourtEffectPer100) * 2, 0.003)) errors.push('Offense/defense RAPM home-court effects do not reconcile.');
  if (netRapm.lambdaSelection && netRapm.lambdaSelection.selectedLambda !== netRapm.lambda) errors.push('Net RAPM selected lambda does not reconcile.');
  if (odRapm.lambdaSelection && odRapm.lambdaSelection.selectedLambda !== odRapm.lambda) errors.push('Offense/defense RAPM selected lambda does not reconcile.');
  if (netRapm.lambdaSelection?.selectedAtBoundary) warnings.push(`Net RAPM selected the ${netRapm.lambdaSelection.selectedBoundary} lambda-grid boundary.`);
  if (odRapm.lambdaSelection?.selectedAtBoundary) warnings.push(`Offense/defense RAPM selected the ${odRapm.lambdaSelection.selectedBoundary} lambda-grid boundary.`);
  if (netRapm.observationCount !== coverage.rapmGroupedObservations) errors.push('Net RAPM observation count does not reconcile.');
  if (netRapm.gameCount !== coverage.archivesEligible || odRapm.gameCount !== coverage.archivesEligible) errors.push('RAPM game counts do not reconcile.');
  if (!Array.isArray(netRapm.players) || !netRapm.players.length) errors.push('Net RAPM players are missing.');
  if (!Array.isArray(odRapm.players) || odRapm.players.length !== netRapm.players?.length) errors.push('Offense/defense RAPM player coverage differs from net RAPM.');
  const venueDiagnostics = odRapm.venueExposureDiagnostics ?? {};
  if (venueDiagnostics.method !== 'player_home_vs_away_possession_side_balance_v1'
    || venueDiagnostics.playerCount !== odRapm.players?.length) {
    errors.push('Offense/defense RAPM venue exposure diagnostics are invalid.');
  }
  let oneSidedVenuePlayers = 0;
  let venuePlayersAbove025 = 0;
  const absoluteVenueBalances = [];
  for (const [index, row] of (odRapm.players ?? []).entries()) {
    const venue = row.venueExposure ?? {};
    const home = Number(venue.homePossessionSides);
    const away = Number(venue.awayPossessionSides);
    const balance = Number(venue.signedVenueExposureBalance);
    if (![home, away, balance].every(Number.isFinite) || home < 0 || away < 0 || home + away <= 0) {
      errors.push(`Offense/defense RAPM player ${index} venue exposure is invalid.`);
      continue;
    }
    const expectedBalance = (home - away) / (home + away);
    if (!closeEnough(balance, expectedBalance, 1e-9)) errors.push(`Offense/defense RAPM player ${index} venue balance does not reconcile.`);
    const absoluteBalance = Math.abs(balance);
    absoluteVenueBalances.push(absoluteBalance);
    if (absoluteBalance === 1) oneSidedVenuePlayers += 1;
    if (absoluteBalance > 0.25) venuePlayersAbove025 += 1;
  }
  const maximumVenueBalance = absoluteVenueBalances.length ? Math.max(...absoluteVenueBalances) : null;
  const meanVenueBalance = absoluteVenueBalances.length
    ? absoluteVenueBalances.reduce((total, value) => total + value, 0) / absoluteVenueBalances.length
    : null;
  if (venueDiagnostics.oneSidedPlayerCount !== oneSidedVenuePlayers
    || venueDiagnostics.playersAboveAbsoluteBalance025 !== venuePlayersAbove025
    || !closeEnough(venueDiagnostics.maximumAbsoluteBalance, maximumVenueBalance, 1e-9)
    || !closeEnough(venueDiagnostics.meanAbsoluteBalance, meanVenueBalance, 1e-9)) {
    errors.push('Offense/defense RAPM venue exposure diagnostics do not reconcile.');
  }
  const rapmIds = new Set();
  const lookupRapm = input.projectionModel?.playerNetRapm ?? {};
  const lookupPrecision = Number.isInteger(input.projectionModel?.playerNetRapmPrecisionDigits)
    ? input.projectionModel.playerNetRapmPrecisionDigits
    : 3;
  for (const [index, row] of (netRapm.players ?? []).entries()) {
    if (rapmIds.has(row.providerPlayerId)) errors.push(`Duplicate net RAPM player at row ${index}.`);
    rapmIds.add(row.providerPlayerId);
    for (const field of ['rapmPer100', 'pairedPossessions', 'averageTeammateNetRapmPer100', 'averageOpponentNetRapmPer100']) {
      if (!Number.isFinite(Number(row[field]))) errors.push(`Invalid net RAPM ${field} at row ${index}.`);
    }
    if (!closeEnough(Number(lookupRapm[row.providerPlayerId]), rounded(row.rapmPer100, lookupPrecision), 10 ** (-lookupPrecision))) {
      errors.push(`Projection RAPM lookup differs from the net RAPM model at row ${index}.`);
    }
  }
  if (input.analyticsAvailability?.halfCourt?.status !== 'proxy_only') errors.push('Half-court availability is overstated.');
  if (input.analyticsAvailability?.confidenceIntervals?.status !== 'available_approximate') errors.push('Confidence interval availability is misstated.');

  const report = {
    schemaVersion: 3,
    validatedAt: new Date().toISOString(),
    inputPath: options.input,
    inputSha256: sha256(inputRaw),
    passed: errors.length === 0,
    errors,
    warnings,
    checks: {
      teams: teamCount,
      combinations: combinationCount,
      onOff: playerOnOffCount,
      playerProfiles: playerProfileCount,
      wowy: wowyCount,
      netRapmPlayers: netRapm.players?.length ?? 0,
      offenseDefenseRapmPlayers: odRapm.players?.length ?? 0,
      eligibleArchives: coverage.archivesEligible ?? null,
      exactLineupPossessions: coverage.exactLineupPossessions ?? null,
    },
  };
  const outputPath = options.output || `${options.input}.validation.json`;
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output: outputPath, passed: report.passed, errors: errors.length, warnings: warnings.length, checks: report.checks }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (IS_MAIN) {
  validate().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
