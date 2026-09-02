import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  fitWeightedRidgeOffenseDefenseRapm,
  fitWeightedRidgeRapm,
  RAPM_MODEL_VERSION,
  RAPM_OFFENSE_DEFENSE_MODEL_VERSION,
} from './lib/nba-rapm.mjs';
import {
  addScoutAggregate,
  calculateOnOff,
  classifyScoutPossessionContext,
  createScoutAggregate,
  eventStatsForPossession,
  FOUR_FACTOR_FORMULAS,
  GARBAGE_TIME_PROXY_DEFINITION,
  LEVERAGE_PROXY_DEFINITION,
  lineupProjection,
  metricFromAggregate,
  possessionContexts,
  SCOUT_METRICS_VERSION,
} from './lib/nba-scout-metrics.mjs';
import {
  NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
  reconstructNbaGameLineups,
  sortPbpEvents,
} from './lib/nba-lineup-reconstruction.mjs';

const ARCHIVE_PHASES = new Set(['preseason', 'regular', 'in_season_tournament', 'play_in', 'playoffs']);
const VALID_PHASES = new Set(['regular', 'in_season_tournament', 'play_in', 'playoffs']);
const DEFAULT_INCLUDED_PHASES = ['regular', 'in_season_tournament', 'play_in', 'playoffs'];
const DEFAULT_LAMBDA_CANDIDATES = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const OUTPUT_SCHEMA_VERSION = 4;

function parseLambda(value, name) {
  if (String(value).trim().toLowerCase() === 'auto') return 'auto';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be "auto" or a number greater than zero.`);
  return parsed;
}

export function optionsFromArgs(argv) {
  const options = {
    archiveDir: null,
    seasonStartYear: 2025,
    outputDir: null,
    validationReport: null,
    rapmLambda: 'auto',
    offenseDefenseRapmLambda: 'auto',
    lambdaCandidates: [...DEFAULT_LAMBDA_CANDIDATES],
    lambdaFoldCount: 5,
    includedPhases: [...DEFAULT_INCLUDED_PHASES],
    replayReconstruction: true,
    synergyPriorPossessions: 400,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--no-replay-reconstruction') {
      options.replayReconstruction = false;
      continue;
    }
    const [name, inline] = token.split(/=(.*)/s, 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--archive-dir') options.archiveDir = path.resolve(value);
    else if (name === '--season') options.seasonStartYear = Number.parseInt(value, 10);
    else if (name === '--output-dir') options.outputDir = path.resolve(value);
    else if (name === '--validation-report') options.validationReport = path.resolve(value);
    else if (name === '--rapm-lambda') options.rapmLambda = parseLambda(value, name);
    else if (name === '--offense-defense-rapm-lambda') options.offenseDefenseRapmLambda = parseLambda(value, name);
    else if (name === '--lambda-candidates') {
      options.lambdaCandidates = value.split(',').map(Number);
      if (!options.lambdaCandidates.length || options.lambdaCandidates.some((candidate) => !Number.isFinite(candidate) || candidate <= 0)) {
        throw new Error('--lambda-candidates must be a comma-separated list of positive numbers.');
      }
    } else if (name === '--lambda-folds') options.lambdaFoldCount = Number.parseInt(value, 10);
    else if (name === '--synergy-prior-possessions') options.synergyPriorPossessions = Number(value);
    else if (name === '--phases') {
      const phases = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      if (!phases.length || phases.some((phase) => !VALID_PHASES.has(phase))) {
        throw new Error(`--phases must contain only: ${[...VALID_PHASES].join(', ')}.`);
      }
      options.includedPhases = [...new Set(phases)];
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.archiveDir) throw new Error('--archive-dir is required.');
  if (!Number.isInteger(options.seasonStartYear) || options.seasonStartYear < 1947) throw new Error('--season must be a valid NBA season start year.');
  if (!Number.isInteger(options.lambdaFoldCount) || options.lambdaFoldCount < 2) throw new Error('--lambda-folds must be an integer of at least two.');
  if (!Number.isFinite(options.synergyPriorPossessions) || options.synergyPriorPossessions <= 0) throw new Error('--synergy-prior-possessions must be greater than zero.');
  if (!options.outputDir) options.outputDir = path.join(options.archiveDir, '..', 'scout-analytics', String(options.seasonStartYear));
  return options;
}

const MODULE_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MODULE_PATH);
const OPTIONS = IS_MAIN ? optionsFromArgs(process.argv.slice(2)) : null;
const SEASON_DIR = OPTIONS ? path.join(OPTIONS.archiveDir, String(OPTIONS.seasonStartYear)) : '';
const GAMES_DIR = SEASON_DIR ? path.join(SEASON_DIR, 'games') : '';
const MANIFEST_PATH = SEASON_DIR ? path.join(SEASON_DIR, 'manifest.json') : '';
const VALIDATION_PATH = OPTIONS
  ? OPTIONS.validationReport || path.join(OPTIONS.archiveDir, '..', 'validation', 'rerun-20260831', 'checkpoint-validation-report.json')
  : '';

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

function createDigestingJsonWriter(filePath) {
  const stream = createWriteStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  let closed = false;
  return {
    async write(chunk) {
      if (closed) throw new Error(`Cannot write to closed JSON stream: ${filePath}`);
      const text = String(chunk);
      digest.update(text, 'utf8');
      bytes += Buffer.byteLength(text);
      if (!stream.write(text, 'utf8')) await once(stream, 'drain');
    },
    async close() {
      if (closed) throw new Error(`JSON stream is already closed: ${filePath}`);
      closed = true;
      stream.end();
      await once(stream, 'finish');
      return { jsonBytes: bytes, jsonSha256: digest.digest('hex') };
    },
  };
}

async function gzipFile(sourcePath, destinationPath) {
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 9 }),
    createWriteStream(destinationPath),
  );
  const result = await fileSha256AndSize(destinationPath);
  return { gzipBytes: result.bytes, gzipSha256: result.sha256 };
}

async function assertOutputDirectoryAbsent(outputDir) {
  try {
    await fs.stat(outputDir);
    throw new Error(`Refusing to overwrite existing Scout output directory: ${outputDir}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function makeAtomicOutputDirectory(outputDir) {
  await assertOutputDirectoryAbsent(outputDir);
  const parent = path.dirname(outputDir);
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, `${path.basename(outputDir)}.partial-`));
}

function requestGarbageCollection() {
  if (typeof global.gc === 'function') global.gc();
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sortedUnique(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id ?? '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function exactLineup(lineupId, lineups) {
  const ids = sortedUnique(lineups.get(lineupId)?.playerIds);
  return ids.length === 5 ? ids : null;
}

function playerName(id, players) {
  const player = players.get(id);
  return player?.fullName || player?.reference || id;
}

function teamName(team) {
  return team?.fullName || [team?.market, team?.name].filter(Boolean).join(' ') || team?.alias || team?.id || null;
}

function isOfficialFranchiseTeam(team) {
  return /^sr:team:\d+$/i.test(String(team?.srId ?? '').trim());
}

function isOfficialFranchiseGame({ game, maps }) {
  return isOfficialFranchiseTeam(maps.teams.get(String(game.homeProviderTeamId ?? '')))
    && isOfficialFranchiseTeam(maps.teams.get(String(game.awayProviderTeamId ?? '')));
}

function combinationIds(ids, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) {
    output.push(prefix);
    return output;
  }
  for (let index = start; index <= ids.length - (size - prefix.length); index += 1) {
    combinationIds(ids, size, index + 1, [...prefix, ids[index]], output);
  }
  return output;
}

function combosForLineup(ids) {
  const result = [];
  for (let size = 2; size <= 5; size += 1) combinationIds(ids, size, 0, [], result);
  return result;
}

function comboKey(teamId, ids) {
  return `${teamId}~${ids.length}~${ids.join('|')}`;
}

function wowyKey(teamId, playerA, playerB) {
  return `${teamId}~${playerA}~${playerB}`;
}

function wowyCell(ids, playerA, playerB) {
  const aOn = ids.includes(playerA);
  const bOn = ids.includes(playerB);
  if (aOn && bOn) return 'a_on_b_on';
  if (aOn) return 'a_on_b_off';
  if (bOn) return 'a_off_b_on';
  return 'a_off_b_off';
}

function gameResultForSide(game, side) {
  const homePoints = finite(game?.homePoints, NaN);
  const awayPoints = finite(game?.awayPoints, NaN);
  if (!Number.isFinite(homePoints) || !Number.isFinite(awayPoints)) return 'unclassified';
  if (homePoints === awayPoints) return 'tie';
  const homeWon = homePoints > awayPoints;
  return side === 'home' ? (homeWon ? 'win' : 'loss') : (homeWon ? 'loss' : 'win');
}

function exposureSummary(contexts, minutes, semantics) {
  const all = contexts?.all ?? {};
  const games = finite(all.games, 0);
  const possessions = finite(all.totalPossessions, 0);
  const teamPossessions = possessions / 2;
  return {
    semantics,
    games,
    possessions,
    teamPossessions,
    minutes: round(minutes),
    possessionsPerGame: games > 0 ? round(possessions / games) : null,
    teamPossessionsPerGame: games > 0 ? round(teamPossessions / games) : null,
    minutesPerGame: games > 0 ? round(minutes / games) : null,
    pacePer48Minutes: minutes > 0 ? round(48 * teamPossessions / minutes) : null,
  };
}

function normalizedEventToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function eventStatisticTeamId(statistic) {
  return String(statistic?.team?.id ?? statistic?.team_id ?? statistic?.teamId ?? '').trim();
}

function eventStatisticPlayerId(statistic) {
  return String(statistic?.player?.id ?? statistic?.player_id ?? statistic?.playerId ?? '').trim();
}

function eventStatisticMade(statistic, eventType) {
  if (typeof statistic?.made === 'boolean') return statistic.made;
  if (eventType.includes('made')) return true;
  if (eventType.includes('miss')) return false;
  return null;
}

function numericStatistic(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumericStatistic(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createDirectPlayerEventLine() {
  return {
    points: 0,
    fieldGoalAttempts: 0,
    fieldGoalsMade: 0,
    twoPointAttempts: 0,
    twoPointMakes: 0,
    threePointAttempts: 0,
    threePointersMade: 0,
    freeThrowAttempts: 0,
    freeThrowsMade: 0,
    offensiveRebounds: 0,
    defensiveRebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
    personalFouls: 0,
    foulsDrawn: 0,
    shotAttemptsBlocked: 0,
    technicalFouls: 0,
    nonUnsportsmanlikeTechnicalFouls: 0,
    flagrantFouls: 0,
    ejections: 0,
    providerShotTypes: Object.create(null),
    providerShotDescriptions: Object.create(null),
    missingProviderShotType: 0,
    missingProviderShotDescription: 0,
    fieldGoalDistanceTotal: 0,
    fieldGoalDistanceObserved: 0,
    atRimAttempts: 0,
    atRimMakes: 0,
    shortMidRangeAttempts: 0,
    shortMidRangeMakes: 0,
    longMidRangeAttempts: 0,
    longMidRangeMakes: 0,
    atRimUnknownMadeStatus: 0,
    shortMidRangeUnknownMadeStatus: 0,
    longMidRangeUnknownMadeStatus: 0,
    structuredStatisticRows: 0,
    recognizedStatisticRows: 0,
    unknownFieldGoalMadeStatus: 0,
    unclassifiedFieldGoalAttempts: 0,
    unclassifiedFieldGoalMakes: 0,
    unknownFreeThrowMadeStatus: 0,
    unclassifiedRebounds: 0,
  };
}

function addShotCategory(target, key, made) {
  if (!key) return;
  if (!target[key]) target[key] = { attempts: 0, makes: 0, unknownMadeStatus: 0 };
  target[key].attempts += 1;
  if (made === true) target[key].makes += 1;
  else if (made === null) target[key].unknownMadeStatus += 1;
}

export function addDirectPlayerStatistic(line, statistic, eventType = '') {
  if (!line || typeof line !== 'object') throw new TypeError('line must be a direct player event accumulator.');
  line.structuredStatisticRows += 1;
  const type = normalizedEventToken(statistic?.type);
  if (type === 'fieldgoal') {
    line.recognizedStatisticRows += 1;
    const made = eventStatisticMade(statistic, eventType);
    const statedPoints = optionalNumericStatistic(statistic?.points);
    const providerShotType = normalizedEventToken(statistic?.shot_type ?? statistic?.shotType);
    const providerShotDescription = normalizedEventToken(statistic?.shot_type_desc ?? statistic?.shotTypeDesc);
    if (providerShotType) addShotCategory(line.providerShotTypes, providerShotType, made);
    else line.missingProviderShotType += 1;
    if (providerShotDescription) addShotCategory(line.providerShotDescriptions, providerShotDescription, made);
    else line.missingProviderShotDescription += 1;
    const isThree = statistic?.three_point_shot === true
      || statistic?.threePointShot === true
      || eventType.includes('threepoint')
      || statedPoints === 3;
    const isTwo = !isThree && (eventType.includes('twopoint') || statedPoints === 2);
    line.fieldGoalAttempts += 1;
    if (isThree) line.threePointAttempts += 1;
    else if (isTwo) line.twoPointAttempts += 1;
    else line.unclassifiedFieldGoalAttempts += 1;
    if (made === null) line.unknownFieldGoalMadeStatus += 1;
    else if (made === true) {
      line.fieldGoalsMade += 1;
      if (isThree) line.threePointersMade += 1;
      else if (isTwo) line.twoPointMakes += 1;
      else line.unclassifiedFieldGoalMakes += 1;
      if (statedPoints === 2 || statedPoints === 3) line.points += statedPoints;
      else if (isThree) line.points += 3;
      else if (isTwo) line.points += 2;
    }
    const distance = optionalNumericStatistic(statistic?.shot_distance ?? statistic?.shotDistance);
    if (distance !== null && distance >= 0) {
      line.fieldGoalDistanceTotal += distance;
      line.fieldGoalDistanceObserved += 1;
      if (isTwo) {
        const zone = distance <= 4 ? 'atRim' : distance <= 14 ? 'shortMidRange' : 'longMidRange';
        line[`${zone}Attempts`] += 1;
        if (made === true) line[`${zone}Makes`] += 1;
        else if (made === null) line[`${zone}UnknownMadeStatus`] += 1;
      }
    }
  } else if (type === 'freethrow') {
    line.recognizedStatisticRows += 1;
    const made = eventStatisticMade(statistic, eventType);
    line.freeThrowAttempts += 1;
    if (made === null) line.unknownFreeThrowMadeStatus += 1;
    else if (made === true) {
      line.freeThrowsMade += 1;
      line.points += 1;
    }
  } else if (type === 'rebound') {
    line.recognizedStatisticRows += 1;
    const reboundType = normalizedEventToken(statistic?.rebound_type ?? statistic?.reboundType);
    if (reboundType === 'offensive') line.offensiveRebounds += 1;
    else if (reboundType === 'defensive') line.defensiveRebounds += 1;
    else line.unclassifiedRebounds += 1;
  } else if (type === 'assist') {
    line.recognizedStatisticRows += 1;
    line.assists += 1;
  } else if (type === 'steal') {
    line.recognizedStatisticRows += 1;
    line.steals += 1;
  } else if (type === 'block') {
    line.recognizedStatisticRows += 1;
    line.blocks += 1;
  } else if (type === 'turnover' || type === 'offensivefoul') {
    line.recognizedStatisticRows += 1;
    line.turnovers += 1;
  } else if (type === 'personalfoul') {
    line.recognizedStatisticRows += 1;
    line.personalFouls += 1;
  } else if (type === 'fouldrawn') {
    line.recognizedStatisticRows += 1;
    line.foulsDrawn += 1;
  } else if (type === 'attemptblocked') {
    line.recognizedStatisticRows += 1;
    line.shotAttemptsBlocked += 1;
  } else if (type === 'technicalfoul') {
    line.recognizedStatisticRows += 1;
    line.technicalFouls += 1;
  } else if (type === 'technicalfoulnonunsportsmanlike') {
    line.recognizedStatisticRows += 1;
    line.nonUnsportsmanlikeTechnicalFouls += 1;
  } else if (type === 'flagrantfoul') {
    line.recognizedStatisticRows += 1;
    line.flagrantFouls += 1;
  } else if (type === 'ejection') {
    line.recognizedStatisticRows += 1;
    line.ejections += 1;
  }
  return line;
}

function ratioOrNull(numerator, denominator, digits = 3) {
  return denominator > 0 ? round(numerator / denominator, digits) : null;
}

/**
 * Converts a net-RAPM home-court estimate into the contextual adjustment for
 * one lineup's observed home/away exposure. `homeCourtExposureBalance` is the
 * signed possession count for the lineup (+1 home, -1 away).
 */
export function homeCourtExposureAdjustmentPer100({
  homeCourtNetRatingEffectPer100,
  homeCourtExposureBalance,
  totalProjectionPossessions,
} = {}) {
  const homeCourtNetEffect = Number(homeCourtNetRatingEffectPer100);
  const exposureBalance = Number(homeCourtExposureBalance);
  const totalPossessions = Number(totalProjectionPossessions);
  if (!Number.isFinite(homeCourtNetEffect)
    || !Number.isFinite(exposureBalance)
    || !Number.isFinite(totalPossessions)
    || totalPossessions <= 0) {
    return null;
  }
  return homeCourtNetEffect * exposureBalance / totalPossessions;
}

export function playerProfileFromEvents({ teamId, team, playerId, player, events, onOff, starterGames, closerGames }) {
  const minutes = finite(onOff?.onMinutes, 0);
  const onPossessions = finite(onOff?.on?.all?.totalPossessions, 0);
  const teamPossessionsWhileOnCourt = onPossessions / 2;
  const fga = events.fieldGoalAttempts;
  const fgm = events.fieldGoalsMade;
  const threePa = events.threePointAttempts;
  const threePm = events.threePointersMade;
  const twoPa = events.twoPointAttempts;
  const twoPm = events.twoPointMakes;
  const fta = events.freeThrowAttempts;
  const ftm = events.freeThrowsMade;
  const reb = events.offensiveRebounds + events.defensiveRebounds;
  const trueShootingDenominator = 2 * (fga + (0.44 * fta));
  const per36 = (value) => minutes > 0 ? round(36 * value / minutes) : null;
  const per100 = (value) => teamPossessionsWhileOnCourt > 0 ? round(100 * value / teamPossessionsWhileOnCourt) : null;
  const fieldGoalOutcomesComplete = events.unknownFieldGoalMadeStatus === 0;
  const fieldGoalValuesComplete = events.unclassifiedFieldGoalAttempts === 0;
  const freeThrowOutcomesComplete = events.unknownFreeThrowMadeStatus === 0;
  const scoringComplete = fieldGoalOutcomesComplete
    && freeThrowOutcomesComplete
    && events.unclassifiedFieldGoalMakes === 0;
  const reboundsComplete = events.unclassifiedRebounds === 0;
  const zone = (attempts, makes, unknownMadeStatus) => ({
    attempts,
    makes,
    unknownMadeStatus,
    percentage: unknownMadeStatus === 0 ? ratioOrNull(makes, attempts, 4) : null,
  });
  const gamesAppeared = finite(onOff?.on?.all?.games, 0);
  const totalTechnicalFouls = events.technicalFouls + events.nonUnsportsmanlikeTechnicalFouls;
  const categoryProfile = (categories, totalAttempts) => Object.fromEntries(
    Object.entries(categories ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, counts]) => [category, {
        attempts: counts.attempts,
        makes: counts.makes,
        unknownMadeStatus: counts.unknownMadeStatus,
        percentage: counts.unknownMadeStatus === 0 ? ratioOrNull(counts.makes, counts.attempts, 4) : null,
        shareOfAllFieldGoalAttempts: ratioOrNull(counts.attempts, totalAttempts, 4),
      }])
  );
  const describedFieldGoalAttempts = fga - events.missingProviderShotDescription;
  return {
    teamId,
    team,
    playerId,
    player,
    scope: 'non_rescinded_direct_structured_event_statistics_in_scout_eligible_games',
    gamesAppeared,
    starterGames,
    closerGames,
    starterGameRate: ratioOrNull(starterGames, gamesAppeared, 4),
    closerGameRate: ratioOrNull(closerGames, gamesAppeared, 4),
    minutes: round(minutes),
    teamPossessionsWhileOnCourt,
    coverage: {
      status: fieldGoalOutcomesComplete && fieldGoalValuesComplete && freeThrowOutcomesComplete && reboundsComplete
        ? 'complete'
        : 'partial',
      structuredStatisticRows: events.structuredStatisticRows,
      recognizedStatisticRows: events.recognizedStatisticRows,
      unknownFieldGoalMadeStatus: events.unknownFieldGoalMadeStatus,
      unclassifiedFieldGoalAttempts: events.unclassifiedFieldGoalAttempts,
      unclassifiedFieldGoalMakes: events.unclassifiedFieldGoalMakes,
      unknownFreeThrowMadeStatus: events.unknownFreeThrowMadeStatus,
      unclassifiedRebounds: events.unclassifiedRebounds,
      fieldGoalMadeStatusShare: fga > 0 ? round((fga - events.unknownFieldGoalMadeStatus) / fga, 4) : null,
      fieldGoalValueClassifiedShare: fga > 0 ? round((fga - events.unclassifiedFieldGoalAttempts) / fga, 4) : null,
      freeThrowMadeStatusShare: fta > 0 ? round((fta - events.unknownFreeThrowMadeStatus) / fta, 4) : null,
      missingProviderShotType: events.missingProviderShotType,
      missingProviderShotDescription: events.missingProviderShotDescription,
      providerShotTypeShare: fga > 0 ? round((fga - events.missingProviderShotType) / fga, 4) : null,
      providerShotDescriptionShare: fga > 0 ? round(describedFieldGoalAttempts / fga, 4) : null,
      scoringComplete,
      reboundsComplete,
      caveat: 'Percentages and rates that require unresolved provider fields are null rather than treating unknown outcomes as misses or unknown shot values as two-pointers.',
    },
    boxScore: {
      points: events.points,
      fieldGoalAttempts: fga,
      fieldGoalsMade: fgm,
      twoPointAttempts: twoPa,
      twoPointMakes: twoPm,
      threePointAttempts: threePa,
      threePointersMade: threePm,
      unclassifiedFieldGoalAttempts: events.unclassifiedFieldGoalAttempts,
      unclassifiedFieldGoalMakes: events.unclassifiedFieldGoalMakes,
      freeThrowAttempts: fta,
      freeThrowsMade: ftm,
      offensiveRebounds: events.offensiveRebounds,
      defensiveRebounds: events.defensiveRebounds,
      rebounds: reb,
      assists: events.assists,
      steals: events.steals,
      blocks: events.blocks,
      turnovers: events.turnovers,
      personalFouls: events.personalFouls,
      foulsDrawn: events.foulsDrawn,
      shotAttemptsBlocked: events.shotAttemptsBlocked,
      technicalFouls: events.technicalFouls,
      nonUnsportsmanlikeTechnicalFouls: events.nonUnsportsmanlikeTechnicalFouls,
      totalTechnicalFouls,
      flagrantFouls: events.flagrantFouls,
      ejections: events.ejections,
    },
    shooting: {
      fieldGoalPercentage: fieldGoalOutcomesComplete ? ratioOrNull(fgm, fga, 4) : null,
      twoPointPercentage: fieldGoalOutcomesComplete && fieldGoalValuesComplete ? ratioOrNull(twoPm, twoPa, 4) : null,
      threePointPercentage: fieldGoalOutcomesComplete && fieldGoalValuesComplete ? ratioOrNull(threePm, threePa, 4) : null,
      freeThrowPercentage: freeThrowOutcomesComplete ? ratioOrNull(ftm, fta, 4) : null,
      effectiveFieldGoalPercentage: fieldGoalOutcomesComplete && events.unclassifiedFieldGoalMakes === 0
        ? ratioOrNull(fgm + (0.5 * threePm), fga, 4)
        : null,
      trueShootingPercentage: scoringComplete ? ratioOrNull(events.points, trueShootingDenominator, 4) : null,
      threePointAttemptRate: fieldGoalValuesComplete ? ratioOrNull(threePa, fga, 4) : null,
      blockedAttemptRate: ratioOrNull(events.shotAttemptsBlocked, fga, 4),
      averageFieldGoalDistance: events.fieldGoalDistanceObserved > 0
        ? round(events.fieldGoalDistanceTotal / events.fieldGoalDistanceObserved)
        : null,
      fieldGoalDistanceObserved: events.fieldGoalDistanceObserved,
      shotZones: {
        atRim: zone(events.atRimAttempts, events.atRimMakes, events.atRimUnknownMadeStatus),
        shortMidRange: zone(events.shortMidRangeAttempts, events.shortMidRangeMakes, events.shortMidRangeUnknownMadeStatus),
        longMidRange: zone(events.longMidRangeAttempts, events.longMidRangeMakes, events.longMidRangeUnknownMadeStatus),
      },
      providerShotTypeProfile: categoryProfile(events.providerShotTypes, fga),
      providerShotDescriptionProfile: categoryProfile(events.providerShotDescriptions, fga),
      providerShotDetailCaveat: 'Shot descriptions are optional provider labels. Missing descriptions remain explicit and are not inferred from event text or distance.',
    },
    per36: {
      points: scoringComplete ? per36(events.points) : null,
      rebounds: reboundsComplete ? per36(reb) : null,
      assists: per36(events.assists),
      steals: per36(events.steals),
      blocks: per36(events.blocks),
      turnovers: per36(events.turnovers),
      personalFouls: per36(events.personalFouls),
      foulsDrawn: per36(events.foulsDrawn),
      shotAttemptsBlocked: per36(events.shotAttemptsBlocked),
      technicalFouls: per36(totalTechnicalFouls),
      flagrantFouls: per36(events.flagrantFouls),
    },
    per100Possessions: {
      points: scoringComplete ? per100(events.points) : null,
      rebounds: reboundsComplete ? per100(reb) : null,
      assists: per100(events.assists),
      steals: per100(events.steals),
      blocks: per100(events.blocks),
      turnovers: per100(events.turnovers),
      personalFouls: per100(events.personalFouls),
      foulsDrawn: per100(events.foulsDrawn),
      shotAttemptsBlocked: per100(events.shotAttemptsBlocked),
      technicalFouls: per100(totalTechnicalFouls),
      flagrantFouls: per100(events.flagrantFouls),
      possessionEndingInvolvementProxy: per100(fga + (0.44 * fta) + events.turnovers),
    },
  };
}

function sortBy(...selectors) {
  return (left, right) => {
    for (const selector of selectors) {
      const comparison = String(selector(left)).localeCompare(String(selector(right)));
      if (comparison !== 0) return comparison;
    }
    return 0;
  };
}

function compactRecord(record, filename) {
  const game = record.game ?? {};
  return {
    filename,
    record,
    game,
    maps: {
      teams: new Map((record.teams ?? []).map((team) => [team.id, team])),
      players: new Map((record.players ?? []).map((player) => [player.id, player])),
      lineups: new Map((record.lineups ?? []).map((lineup) => [lineup.id, lineup])),
    },
  };
}

async function loadRecords() {
  const entries = (await fs.readdir(GAMES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records = [];
  for (const entry of entries) {
    const filePath = path.join(GAMES_DIR, entry.name);
    records.push(compactRecord(JSON.parse(gunzipSync(await fs.readFile(filePath)).toString('utf8')), entry.name));
  }
  records.sort((left, right) => String(left.game.scheduledAt ?? '').localeCompare(String(right.game.scheduledAt ?? '')));
  return records;
}

function transientReplay(compact) {
  if (!OPTIONS.replayReconstruction) return compact;
  const { record, game, maps, filename } = compact;
  const homeTeam = maps.teams.get(game.homeProviderTeamId);
  const awayTeam = maps.teams.get(game.awayProviderTeamId);
  const replayEvents = sortPbpEvents(record.events ?? []);
  const replay = reconstructNbaGameLineups({
    gameId: game.providerGameId || filename,
    homeTeamId: game.homeProviderTeamId,
    awayTeamId: game.awayProviderTeamId,
    status: game.status,
    coverage: game.coverage,
    trackOnCourt: game.trackOnCourt,
    expectedFinalScore: { homePoints: game.homePoints, awayPoints: game.awayPoints },
    providerTeamPossessions: { home: homeTeam?.possessions, away: awayTeam?.possessions },
    providerPlayerMinutes: record.players,
    events: replayEvents,
  });
  return compactRecord({
    ...record,
    events: replayEvents,
    lineups: replay.lineupDefinitions ?? [],
    stints: replay.stints ?? [],
    possessions: replay.possessions ?? [],
    analytics: {
      methodVersion: replay.methodVersion,
      coverageStatus: replay.coverageStatus,
      eligibleForPublication: replay.isEligible === true,
      counts: replay.counts ?? {},
      validation: replay.validation ?? {},
    },
  }, filename);
}

function rollingGameMemberships(records) {
  const gameIdsByTeam = new Map();
  for (const { game, filename } of records) {
    const gameId = String(game.providerGameId || filename);
    for (const teamId of [game.homeProviderTeamId, game.awayProviderTeamId]) {
      if (!gameIdsByTeam.has(teamId)) gameIdsByTeam.set(teamId, []);
      gameIdsByTeam.get(teamId).push(gameId);
    }
  }
  return new Map([...gameIdsByTeam.entries()].map(([teamId, gameIds]) => [teamId, {
    last5: new Set(gameIds.slice(-5)),
    last10: new Set(gameIds.slice(-10)),
    last20: new Set(gameIds.slice(-20)),
  }]));
}

function membershipsFor(teamId, gameId, rollingByTeam) {
  const windows = rollingByTeam.get(teamId);
  return {
    last5: windows?.last5.has(gameId) === true,
    last10: windows?.last10.has(gameId) === true,
    last20: windows?.last20.has(gameId) === true,
  };
}

function aggregateInto(contextMap, contexts, row) {
  for (const context of contexts) {
    // Archive replay visits every possession for one game before moving to the
    // next.  Retaining a Set of every game id for every combination/context
    // would dominate memory without changing the resulting game totals.
    if (!contextMap.has(context)) {
      contextMap.set(context, createScoutAggregate({ gameCountTracking: 'contiguous_game_blocks' }));
    }
    addScoutAggregate(contextMap.get(context), row);
  }
}

function compactFourFactorCoverage(coverage) {
  if (!coverage) return null;
  return {
    status: coverage.status,
    relevantEventCount: coverage.relevantEventCount ?? 0,
    resolvedEventCount: coverage.resolvedEventCount ?? 0,
    unresolvedEventCount: coverage.unresolvedEventCount ?? 0,
    resolvedRelevantEventShare: coverage.resolvedRelevantEventShare ?? null,
  };
}

function compactMetric(aggregate) {
  const metric = metricFromAggregate(aggregate);
  delete metric.offensivePointsForSquared;
  delete metric.defensivePointsAllowedSquared;
  delete metric.pointDifferentialSquared;
  delete metric.confidence95.method;
  delete metric.confidence95.caveat;
  delete metric.extendedMetricFormulas;
  for (const side of ['offense', 'defense']) {
    delete metric.fourFactors[side].formulas;
    metric.fourFactors[side].coverage = compactFourFactorCoverage(metric.fourFactors[side].coverage);
  }
  return metric;
}

function outputContexts(contextMap) {
  return Object.fromEntries([...contextMap.entries()].map(([context, aggregate]) => [context, compactMetric(aggregate)]));
}

function createComboEntry(teamId, team, playerIds) {
  return {
    teamId,
    team,
    playerIds,
    size: playerIds.length,
    contexts: new Map(),
    opponentPlayerExposure: playerIds.length === 5 ? new Map() : null,
    projectionPossessions: 0,
    homeCourtExposureBalance: 0,
  };
}

function addOpponentExposure(entry, opponentPlayerIds, side) {
  if (entry.size !== 5 || !entry.opponentPlayerExposure) return;
  for (const playerId of opponentPlayerIds) {
    entry.opponentPlayerExposure.set(playerId, (entry.opponentPlayerExposure.get(playerId) ?? 0) + 1);
  }
  entry.projectionPossessions += 1;
  entry.homeCourtExposureBalance += side === 'home' ? 1 : -1;
}

function rapmModelOutput(model, players) {
  return {
    modelVersion: model.modelVersion,
    seasonEndYear: model.seasonEndYear,
    seasonPhase: model.seasonPhase,
    lambda: model.lambda,
    lambdaSelection: model.lambdaSelection,
    observationCount: model.observationCount,
    directionalObservationCount: model.directionalObservationCount,
    pairedStintObservationCount: model.pairedStintObservationCount,
    gameCount: model.gameCount,
    totalPairedPossessions: model.totalPairedPossessions,
    totalOffensivePossessions: model.totalOffensivePossessions,
    excludedStintCount: model.excludedStintCount,
    skippedDirectionalObservationCount: model.skippedDirectionalObservationCount,
    inputSha256: model.inputSha256,
    interceptPer100: round(model.interceptPer100),
    baselineOffensiveRatingPer100: round(model.baselineOffensiveRatingPer100),
    homeCourtEffectPer100: round(model.homeCourtEffectPer100),
    homeCourtSignConvention: model.homeCourtSignConvention ?? null,
    homeCourtNetRatingEffectPer100: round(model.homeCourtNetRatingEffectPer100),
    formulation: model.formulation,
    defensiveSignConvention: model.defensiveSignConvention,
    identification: model.identification,
    venueExposureDiagnostics: model.venueExposureDiagnostics,
    reliability: model.reliability,
    contextSemantics: model.contextSemantics,
    solver: model.solver,
    players,
  };
}

async function derive() {
  await assertOutputDirectoryAbsent(OPTIONS.outputDir);
  const [manifestRaw, validationRaw, loadedRecords] = await Promise.all([
    fs.readFile(MANIFEST_PATH, 'utf8'),
    fs.readFile(VALIDATION_PATH, 'utf8'),
    loadRecords(),
  ]);
  const validation = JSON.parse(validationRaw);
  const validationSeason = validation.seasons?.find((season) => season.seasonStartYear === OPTIONS.seasonStartYear);
  const sourceEligibleCount = loadedRecords.filter(({ record }) => record.analytics?.eligibleForPublication === true).length;
  const phaseRecords = loadedRecords.filter(({ game }) => OPTIONS.includedPhases.includes(String(game.primaryPhase ?? '').trim().toLowerCase()));
  const officialRecords = phaseRecords.filter(isOfficialFranchiseGame);
  const replayedRecords = officialRecords.map(transientReplay);
  const eligibleRecords = replayedRecords.filter(({ record }) => record.analytics?.eligibleForPublication === true);
  const rollingByTeam = rollingGameMemberships(eligibleRecords);

  const comboMap = new Map();
  const comboMinutes = new Map();
  const playerOnOffMap = new Map();
  const playerOnMinutes = new Map();
  const playerScopeMinutes = new Map();
  const teamScopeMinutes = new Map();
  const wowyMap = new Map();
  const teamMap = new Map();
  const playerNames = new Map();
  const teamNames = new Map();
  const playerEventMap = new Map();
  const lineupStartCounts = new Map();
  const lineupCloseCounts = new Map();
  const playerStartCounts = new Map();
  const playerCloseCounts = new Map();
  const rapmGroups = new Map();
  const counters = {
    archivesDiscovered: loadedRecords.length,
    archivesSourceEligibleV2: sourceEligibleCount,
    archivesPhaseCandidates: phaseRecords.length,
    archivesOfficialCandidates: officialRecords.length,
    archivesEligible: eligibleRecords.length,
    archivesExcludedByPhase: loadedRecords.length - phaseRecords.length,
    archivesExcludedNonFranchise: phaseRecords.length - officialRecords.length,
    archivesReplayPartial: replayedRecords.filter(({ record }) => record.analytics?.coverageStatus === 'partial').length,
    archivesReplayIneligible: replayedRecords.filter(({ record }) => record.analytics?.coverageStatus === 'ineligible').length,
    includedPhases: [...OPTIONS.includedPhases],
    eligibleArchivesByPhase: Object.fromEntries(OPTIONS.includedPhases.map((phase) => [phase, 0])),
    pseudoPlayerRowsExcludedAllArchives: loadedRecords.reduce((total, { record }) => total + finite(record.source?.skippedSummaryPlayerRows), 0),
    pseudoPlayerRowsExcluded: 0,
    eventsInEligibleArchives: 0,
    stintsInEligibleArchives: 0,
    possessionsInEligibleArchives: 0,
    exactLineupPossessions: 0,
    possessionStartLineupAttributedMidChange: 0,
    excludedPossessions: 0,
    excludedPossessionsMissingLineup: 0,
    excludedPossessionsInvalidTeam: 0,
    rapmGroupedObservations: 0,
    contextPossessions: {
      all: 0,
      clutch_v1: 0,
      non_clutch_v1: 0,
      clutchUnclassified: 0,
      provider_fastbreak_v1: 0,
      non_provider_fastbreak: 0,
      transitionUnclassified: 0,
      garbageTimeProxy: 0,
      competitiveProxy: 0,
      competitionUnclassified: 0,
      leverageHigh: 0,
      leverageMedium: 0,
      leverageStandard: 0,
      leverageLow: 0,
      leverageUnclassified: 0,
      scoreStateUnclassified: 0,
    },
    fourFactorCoverage: { complete: 0, partial: 0, unavailable: 0 },
    nominalDefensePoints: 0,
  };

  function rememberNames(record) {
    for (const team of record.teams ?? []) teamNames.set(team.id, teamName(team) || team.id);
    const players = new Map((record.players ?? []).map((player) => [player.id, player]));
    for (const player of record.players ?? []) playerNames.set(player.id, playerName(player.id, players));
  }

  function ensureCombo(teamId, ids) {
    const key = comboKey(teamId, ids);
    if (!comboMap.has(key)) comboMap.set(key, createComboEntry(teamId, teamNames.get(teamId) || teamId, ids));
    return comboMap.get(key);
  }

  function incrementCount(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  function playerEventLine(teamId, playerId) {
    const key = `${teamId}~${playerId}`;
    if (!playerEventMap.has(key)) playerEventMap.set(key, createDirectPlayerEventLine());
    return playerEventMap.get(key);
  }

  function accumulateDirectPlayerEvents(record, validTeamIds) {
    const seenEventIds = new Set();
    for (const [index, event] of (record.events ?? []).entries()) {
      if (event?.isRescinded === true) continue;
      const eventId = String(event?.id ?? '').trim() || `index:${index}`;
      if (seenEventIds.has(eventId)) continue;
      seenEventIds.add(eventId);
      const eventType = normalizedEventToken(event?.eventType ?? event?.event_type ?? event?.type);
      for (const statistic of event?.statistics ?? []) {
        const teamId = eventStatisticTeamId(statistic);
        const playerId = eventStatisticPlayerId(statistic);
        if (!validTeamIds.has(teamId) || !playerId) continue;
        addDirectPlayerStatistic(playerEventLine(teamId, playerId), statistic, eventType);
      }
    }
  }

  for (const { record, game, maps, filename } of eligibleRecords) {
    rememberNames(record);
    const primaryPhase = String(game.primaryPhase ?? '').trim().toLowerCase();
    counters.eligibleArchivesByPhase[primaryPhase] = (counters.eligibleArchivesByPhase[primaryPhase] ?? 0) + 1;
    counters.eventsInEligibleArchives += record.events?.length ?? 0;
    counters.stintsInEligibleArchives += record.stints?.length ?? 0;
    counters.possessionsInEligibleArchives += record.possessions?.length ?? 0;
    counters.pseudoPlayerRowsExcluded += finite(record.source?.skippedSummaryPlayerRows);

    const gameId = String(game.providerGameId || filename);
    const homeTeamId = String(game.homeProviderTeamId ?? '');
    const awayTeamId = String(game.awayProviderTeamId ?? '');
    const validTeamIds = new Set([homeTeamId, awayTeamId]);
    accumulateDirectPlayerEvents(record, validTeamIds);
    const appearedPlayersByTeam = new Map([[homeTeamId, new Set()], [awayTeamId, new Set()]]);
    for (const lineup of record.lineups ?? []) {
      const ids = exactLineup(lineup.id, maps.lineups);
      if (!ids || !appearedPlayersByTeam.has(lineup.providerTeamId)) continue;
      ids.forEach((id) => appearedPlayersByTeam.get(lineup.providerTeamId).add(id));
    }

    const teamStintMinutes = new Map([[homeTeamId, 0], [awayTeamId, 0]]);
    for (const stint of record.stints ?? []) {
      const durationMinutes = Math.max(0, finite(stint.durationMs)) / 60_000;
      const homeIds = exactLineup(stint.homeLineupId, maps.lineups);
      const awayIds = exactLineup(stint.awayLineupId, maps.lineups);
      if (!homeIds || !awayIds || durationMinutes <= 0) continue;
      for (const [teamId, ids] of [[homeTeamId, homeIds], [awayTeamId, awayIds]]) {
        teamStintMinutes.set(teamId, teamStintMinutes.get(teamId) + durationMinutes);
        for (const combination of combosForLineup(ids)) {
          const key = comboKey(teamId, combination);
          comboMinutes.set(key, (comboMinutes.get(key) ?? 0) + durationMinutes);
        }
        for (const playerId of ids) {
          const key = `${teamId}~${playerId}`;
          playerOnMinutes.set(key, (playerOnMinutes.get(key) ?? 0) + durationMinutes);
        }
      }
    }
    for (const [teamId, minutes] of teamStintMinutes.entries()) {
      teamScopeMinutes.set(teamId, (teamScopeMinutes.get(teamId) ?? 0) + minutes);
    }
    const exactStints = (record.stints ?? [])
      .map((stint, index) => ({
        index,
        ordinal: finite(stint?.stintOrdinal, index),
        homeIds: exactLineup(stint?.homeLineupId, maps.lineups),
        awayIds: exactLineup(stint?.awayLineupId, maps.lineups),
      }))
      .filter((stint) => stint.homeIds && stint.awayIds)
      .sort((left, right) => left.ordinal - right.ordinal || left.index - right.index);
    if (exactStints.length) {
      const starting = exactStints[0];
      const closing = exactStints[exactStints.length - 1];
      for (const [teamId, starterIds, closerIds] of [
        [homeTeamId, starting.homeIds, closing.homeIds],
        [awayTeamId, starting.awayIds, closing.awayIds],
      ]) {
        incrementCount(lineupStartCounts, comboKey(teamId, starterIds));
        incrementCount(lineupCloseCounts, comboKey(teamId, closerIds));
        for (const playerId of starterIds) incrementCount(playerStartCounts, `${teamId}~${playerId}`);
        for (const playerId of closerIds) incrementCount(playerCloseCounts, `${teamId}~${playerId}`);
      }
    }
    for (const [teamId, appeared] of appearedPlayersByTeam.entries()) {
      for (const playerId of appeared) {
        const key = `${teamId}~${playerId}`;
        playerScopeMinutes.set(key, (playerScopeMinutes.get(key) ?? 0) + (teamStintMinutes.get(teamId) ?? 0));
      }
    }

    for (const possession of record.possessions ?? []) {
      const homePlayerIds = exactLineup(possession.homeLineupId, maps.lineups);
      const awayPlayerIds = exactLineup(possession.awayLineupId, maps.lineups);
      if (!homePlayerIds || !awayPlayerIds) {
        counters.excludedPossessions += 1;
        counters.excludedPossessionsMissingLineup += 1;
        continue;
      }
      const offenseTeamId = String(possession.offenseProviderTeamId ?? '');
      const defenseTeamId = String(possession.defenseProviderTeamId ?? '');
      if (![homeTeamId, awayTeamId].includes(offenseTeamId) || ![homeTeamId, awayTeamId].includes(defenseTeamId) || offenseTeamId === defenseTeamId) {
        counters.excludedPossessions += 1;
        counters.excludedPossessionsInvalidTeam += 1;
        continue;
      }
      counters.exactLineupPossessions += 1;
      if (possession.hasLineupChangeMidPossession === true) counters.possessionStartLineupAttributedMidChange += 1;
      const offensePoints = finite(possession.offensePoints);
      const defensePoints = finite(possession.defensePoints);
      counters.nominalDefensePoints += defensePoints;
      const eventStats = eventStatsForPossession(record, possession);
      const possessionTacticalExtras = {
        secondChancePossessions: eventStats.tactics?.hasStructuredOffensiveRebound ? 1 : 0,
        secondChancePoints: eventStats.tactics?.hasStructuredOffensiveRebound ? offensePoints : 0,
        pointsOffTurnoverPossessions: eventStats.tactics?.startsAfterStructuredOpponentTurnover ? 1 : 0,
        pointsOffTurnovers: eventStats.tactics?.startsAfterStructuredOpponentTurnover ? offensePoints : 0,
      };
      const coverageStatus = eventStats.coverage?.status ?? 'unavailable';
      counters.fourFactorCoverage[coverageStatus] = (counters.fourFactorCoverage[coverageStatus] ?? 0) + 1;

      const homeContext = classifyScoutPossessionContext({ possession, side: 'home', phase: primaryPhase });
      counters.contextPossessions.all += 1;
      if (homeContext.clutch === true) counters.contextPossessions.clutch_v1 += 1;
      else if (homeContext.clutch === false) counters.contextPossessions.non_clutch_v1 += 1;
      else counters.contextPossessions.clutchUnclassified += 1;
      if (homeContext.transition === 'provider_fastbreak_v1') counters.contextPossessions.provider_fastbreak_v1 += 1;
      else if (homeContext.transition === 'non_provider_fastbreak') counters.contextPossessions.non_provider_fastbreak += 1;
      else counters.contextPossessions.transitionUnclassified += 1;
      if (homeContext.scoreState === 'unclassified') counters.contextPossessions.scoreStateUnclassified += 1;
      if (homeContext.competitive.isGarbageTimeProxy) counters.contextPossessions.garbageTimeProxy += 1;
      else if (homeContext.competitive.isGarbageTimeProxy === false) counters.contextPossessions.competitiveProxy += 1;
      else counters.contextPossessions.competitionUnclassified += 1;
      const leverageKey = `leverage${homeContext.leverage.bucket[0].toUpperCase()}${homeContext.leverage.bucket.slice(1)}`;
      if (Object.hasOwn(counters.contextPossessions, leverageKey)) counters.contextPossessions[leverageKey] += 1;

      const rapmKey = `${gameId}~${homePlayerIds.join('|')}~${awayPlayerIds.join('|')}`;
      if (!rapmGroups.has(rapmKey)) {
        rapmGroups.set(rapmKey, {
          gameId,
          stintOrdinal: rapmGroups.size + 1,
          homePlayerIds,
          awayPlayerIds,
          homePoints: 0,
          awayPoints: 0,
          homeOffensePoints: 0,
          awayOffensePoints: 0,
          homeOffensivePossessions: 0,
          awayOffensivePossessions: 0,
          eligible: true,
        });
      }
      const rapmGroup = rapmGroups.get(rapmKey);
      if (offenseTeamId === homeTeamId) {
        rapmGroup.homePoints += offensePoints;
        rapmGroup.awayPoints += defensePoints;
        rapmGroup.homeOffensePoints += offensePoints;
        rapmGroup.homeOffensivePossessions += 1;
      } else {
        rapmGroup.awayPoints += offensePoints;
        rapmGroup.homePoints += defensePoints;
        rapmGroup.awayOffensePoints += offensePoints;
        rapmGroup.awayOffensivePossessions += 1;
      }

      const sides = [
        { teamId: homeTeamId, side: 'home', ids: homePlayerIds, opponentIds: awayPlayerIds },
        { teamId: awayTeamId, side: 'away', ids: awayPlayerIds, opponentIds: homePlayerIds },
      ];
      for (const side of sides) {
        const isOffense = side.teamId === offenseTeamId;
        const row = {
          gameId,
          gameResult: gameResultForSide(game, side.side),
          isOffense,
          pointsFor: isOffense ? offensePoints : defensePoints,
          pointsAgainst: isOffense ? defensePoints : offensePoints,
          fourFactorCounts: isOffense ? eventStats.counts : null,
          fourFactorCoverage: isOffense ? eventStats.coverage : null,
          offensiveEventExtras: isOffense ? { ...eventStats.offensiveEventExtras, ...possessionTacticalExtras } : null,
          opponentFourFactorCounts: isOffense ? null : eventStats.counts,
          opponentFourFactorCoverage: isOffense ? null : eventStats.coverage,
          defensiveEventExtras: isOffense ? null : { ...eventStats.defensiveEventExtras, ...possessionTacticalExtras },
        };
        const contexts = possessionContexts(possession, side.side, {
          phase: primaryPhase,
          rollingWindowMemberships: membershipsFor(side.teamId, gameId, rollingByTeam),
        });

        if (!teamMap.has(side.teamId)) {
          teamMap.set(side.teamId, { teamId: side.teamId, team: teamNames.get(side.teamId) || side.teamId, contexts: new Map() });
        }
        aggregateInto(teamMap.get(side.teamId).contexts, contexts, row);

        for (const ids of combosForLineup(side.ids)) {
          const entry = ensureCombo(side.teamId, ids);
          aggregateInto(entry.contexts, contexts, row);
          if (ids.length === 5) addOpponentExposure(entry, side.opponentIds, side.side);
        }

        const appeared = [...(appearedPlayersByTeam.get(side.teamId) ?? [])].sort((left, right) => left.localeCompare(right));
        for (const playerId of appeared) {
          const key = `${side.teamId}~${playerId}`;
          if (!playerOnOffMap.has(key)) {
            playerOnOffMap.set(key, {
              teamId: side.teamId,
              team: teamNames.get(side.teamId) || side.teamId,
              playerId,
              contexts: { on: new Map(), off: new Map() },
            });
          }
          aggregateInto(playerOnOffMap.get(key).contexts[side.ids.includes(playerId) ? 'on' : 'off'], contexts, row);
        }

        for (let left = 0; left < appeared.length; left += 1) {
          for (let right = left + 1; right < appeared.length; right += 1) {
            const playerA = appeared[left];
            const playerB = appeared[right];
            const key = wowyKey(side.teamId, playerA, playerB);
            if (!wowyMap.has(key)) {
              wowyMap.set(key, {
                teamId: side.teamId,
                team: teamNames.get(side.teamId) || side.teamId,
                playerA,
                playerB,
                cells: new Map(),
              });
            }
            const entry = wowyMap.get(key);
            const cell = wowyCell(side.ids, playerA, playerB);
            if (!entry.cells.has(cell)) entry.cells.set(cell, new Map());
            aggregateInto(entry.cells.get(cell), contexts, row);
          }
        }
      }
    }
  }

  // The raw checkpoint is intentionally preserved on disk.  Drop its decoded
  // records before serializing aggregates so output construction does not hold
  // both the source archive and its expanded Scout package in the heap.
  loadedRecords.length = 0;
  phaseRecords.length = 0;
  officialRecords.length = 0;
  replayedRecords.length = 0;
  eligibleRecords.length = 0;
  requestGarbageCollection();

  let rapmInput = [...rapmGroups.values()];
  counters.rapmGroupedObservations = rapmInput.length;
  const seasonPhase = `${OPTIONS.includedPhases.join('_')}_official_franchise_${NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION}_possession_start_lineups`;
  const rapmOptions = {
    lambdaCandidates: OPTIONS.lambdaCandidates,
    lambdaFoldCount: OPTIONS.lambdaFoldCount,
    seasonEndYear: OPTIONS.seasonStartYear + 1,
    seasonPhase,
  };
  const netRapm = fitWeightedRidgeRapm(rapmInput, { ...rapmOptions, lambda: OPTIONS.rapmLambda });
  const offenseDefenseRapm = fitWeightedRidgeOffenseDefenseRapm(rapmInput, {
    ...rapmOptions,
    lambda: OPTIONS.offenseDefenseRapmLambda,
  });
  rapmGroups.clear();
  rapmInput.length = 0;
  rapmInput = null;
  requestGarbageCollection();

  const odByPlayer = new Map(offenseDefenseRapm.players.map((row) => [row.providerPlayerId, row]));
  const netByPlayer = new Map(netRapm.players.map((row) => [row.providerPlayerId, row]));
  const rapmPlayers = netRapm.players.map((row) => ({
    ...row,
    playerName: playerNames.get(row.providerPlayerId) || row.providerPlayerId,
    offensiveRapmPer100: odByPlayer.get(row.providerPlayerId)?.offensiveRapmPer100 ?? null,
    defensiveRapmPer100: odByPlayer.get(row.providerPlayerId)?.defensiveRapmPer100 ?? null,
    combinedOffenseDefenseRapmPer100: odByPlayer.get(row.providerPlayerId)?.combinedRapmPer100 ?? null,
    offensivePossessions: odByPlayer.get(row.providerPlayerId)?.offensivePossessions ?? 0,
    defensivePossessions: odByPlayer.get(row.providerPlayerId)?.defensivePossessions ?? 0,
  })).sort(sortBy((row) => row.playerName, (row) => row.providerPlayerId));

  function comboRow(entry) {
    const contexts = outputContexts(entry.contexts);
    const key = comboKey(entry.teamId, entry.playerIds);
    const minutes = comboMinutes.get(key) ?? 0;
    const teamAggregate = teamMap.get(entry.teamId)?.contexts?.get('all');
    const teamTotalPossessions = finite(teamAggregate?.offensivePossessions) + finite(teamAggregate?.defensivePossessions);
    const teamMinutes = teamScopeMinutes.get(entry.teamId) ?? 0;
    let projection = null;
    if (entry.size === 5) {
      const totalProjectionPossessions = entry.projectionPossessions;
      const averageOpponentLineupRapmPer100 = totalProjectionPossessions > 0
        ? [...entry.opponentPlayerExposure.entries()].reduce((total, [playerId, exposure]) => (
          total + exposure * finite(netByPlayer.get(playerId)?.rapmPer100)
        ), 0) / totalProjectionPossessions
        : null;
      const homeCourtExposureAdjustment = homeCourtExposureAdjustmentPer100({
        homeCourtNetRatingEffectPer100: netRapm.homeCourtNetRatingEffectPer100,
        homeCourtExposureBalance: entry.homeCourtExposureBalance,
        totalProjectionPossessions,
      });
      if (homeCourtExposureAdjustment === null) {
        throw new Error(`Exact lineup ${key} has no valid home-court projection adjustment.`);
      }
      projection = {
        ...lineupProjection({
          players: entry.playerIds.map((playerId) => netByPlayer.get(playerId)),
          observedNetRating: contexts.all?.netRating,
          observedPossessions: (contexts.all?.totalPossessions ?? 0) / 2,
          averageOpponentLineupRapmPer100,
          homeCourtExposureAdjustmentPer100: homeCourtExposureAdjustment,
          synergyPriorPossessions: OPTIONS.synergyPriorPossessions,
        }),
        homeCourtAdjustmentSource: {
          modelVersion: netRapm.modelVersion,
          signConvention: netRapm.homeCourtSignConvention,
          homeCourtNetRatingEffectPer100: round(netRapm.homeCourtNetRatingEffectPer100),
          signedExposureBalance: totalProjectionPossessions > 0
            ? round(entry.homeCourtExposureBalance / totalProjectionPossessions, 6)
            : null,
        },
      };
    }
    return {
      teamId: entry.teamId,
      team: entry.team,
      size: entry.size,
      semantics: entry.size === 5 ? 'exact_five_player_possession_start_lineup' : 'shared_floor_co_presence_combination',
      playerIds: entry.playerIds,
      players: entry.playerIds.map((id) => playerNames.get(id) || id),
      minutes: round(minutes),
      exposure: exposureSummary(
        contexts,
        minutes,
        entry.size === 5 ? 'exact_five_player_possession_start_lineup' : 'shared_floor_co_presence_combination'
      ),
      continuity: {
        gamesUsed: finite(contexts.all?.games),
        teamPossessionShare: ratioOrNull(finite(contexts.all?.totalPossessions), teamTotalPossessions, 4),
        teamMinuteShare: ratioOrNull(minutes, teamMinutes, 4),
        exactLineupStartingGames: entry.size === 5 ? (lineupStartCounts.get(key) ?? 0) : null,
        exactLineupClosingGames: entry.size === 5 ? (lineupCloseCounts.get(key) ?? 0) : null,
        exactLineupStartRate: entry.size === 5 ? ratioOrNull(lineupStartCounts.get(key) ?? 0, finite(contexts.all?.games), 4) : null,
        exactLineupCloseRate: entry.size === 5 ? ratioOrNull(lineupCloseCounts.get(key) ?? 0, finite(contexts.all?.games), 4) : null,
        caveat: entry.size === 5
          ? 'Starting and closing counts use the first and final verified exact-lineup stint in each eligible game; they are unavailable where a game lacks any verified exact stint.'
          : 'Starting and closing counts are meaningful only for exact five-player lineups; this row is a co-presence combination.',
      },
      contexts,
      ...(projection ? { projection } : {}),
    };
  }

  function playerOnOffRow(entry) {
    const on = outputContexts(entry.contexts.on);
    const off = outputContexts(entry.contexts.off);
    const key = `${entry.teamId}~${entry.playerId}`;
    const onMinutes = playerOnMinutes.get(key) ?? 0;
    const offMinutes = Math.max(0, (playerScopeMinutes.get(key) ?? 0) - onMinutes);
    const onOff = calculateOnOff(on.all, off.all);
    return {
      teamId: entry.teamId,
      team: entry.team,
      playerId: entry.playerId,
      player: playerNames.get(entry.playerId) || entry.playerId,
      scope: 'same-game-player-appearance',
      onMinutes: round(onMinutes),
      offMinutes: round(offMinutes),
      exposure: {
        on: exposureSummary(on, onMinutes, 'player on-court sample'),
        off: exposureSummary(off, offMinutes, 'same-game player-appearance off-court sample'),
      },
      on,
      off,
      differences: onOff,
      onOffNetRating: onOff.onOffNetRating,
    };
  }

  function wowyRow(entry) {
    return {
      teamId: entry.teamId,
      team: entry.team,
      playerAId: entry.playerA,
      playerA: playerNames.get(entry.playerA) || entry.playerA,
      playerBId: entry.playerB,
      playerB: playerNames.get(entry.playerB) || entry.playerB,
      semantics: 'descriptive_same_game_shared_floor_wowy',
      cells: Object.fromEntries([...entry.cells.entries()].map(([cell, contexts]) => [cell, outputContexts(contexts)])),
    };
  }

  const teamRows = [...teamMap.values()].map((entry) => {
    const contexts = outputContexts(entry.contexts);
    const minutes = teamScopeMinutes.get(entry.teamId) ?? 0;
    return {
      teamId: entry.teamId,
      team: entry.team,
      minutes: round(minutes),
      exposure: exposureSummary(contexts, minutes, 'verified exact-lineup stint minutes and possession contexts'),
      contexts,
    };
  }).sort(sortBy((row) => row.team));

  const rowCounts = {
    teams: teamRows.length,
    lineupsAndCombinations: comboMap.size,
    playerOnOff: playerOnOffMap.size,
    playerProfiles: playerOnOffMap.size,
    wowy: wowyMap.size,
  };

  const output = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    metricsVersion: SCOUT_METRICS_VERSION,
    provider: 'Sportradar NBA v8 licensed local archive',
    scope: {
      seasonStartYear: OPTIONS.seasonStartYear,
      seasonEndYear: OPTIONS.seasonStartYear + 1,
      archiveDirectory: path.relative(process.cwd(), OPTIONS.archiveDir),
      eligibility: 'selected official competition phases, two official franchise teams, and transient current-version reconstruction eligibleForPublication=true',
      includedPhases: [...OPTIONS.includedPhases],
      excludedPhases: [...ARCHIVE_PHASES].filter((phase) => !OPTIONS.includedPhases.includes(phase)),
      officialFranchiseTeamRule: 'both normalized teams require a non-empty Sportradar sr:team identifier',
      possessionLineupAttribution: 'verified five-player lineup at possession start; safe untouched dead-ball substitutions are rebased by reconstruction v3',
      rollingWindows: 'last 5, 10, and 20 eligible games for each team as of the archive snapshot',
      rawArchivePreserved: true,
      transientReconstructionReplay: OPTIONS.replayReconstruction,
      networkAccess: 'not used',
      supabaseWrites: 'none',
    },
    provenance: {
      manifestSha256: sha256(manifestRaw),
      sourceValidationReportSha256: sha256(validationRaw),
      sourceValidatorVersion: validation.validatorVersion,
      sourceArchiveValidationPassed: validation.passed === true,
      sourceReconstructionMethodVersions: validationSeason?.totals?.reconstructionMethodVersionCounts ?? {},
      derivedReconstructionMethodVersion: NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
      sourceReconstructionReplayMatchedGames: validationSeason?.totals?.reconstructionReplayMatchedGames ?? null,
    },
    coverage: counters,
    quality: {
      sourceValidationErrors: validationSeason?.dataQuality?.analyticsValidationErrorsByCategory ?? {},
      sourceValidationWarnings: validationSeason?.dataQuality?.analyticsValidationWarningsByCategory ?? {},
      exclusionPolicy: 'non-target phases, non-franchise teams, and current reconstruction partial/ineligible games are retained in the raw checkpoint but excluded from Scout aggregates',
      confidenceIntervalMethod: 'normal approximation from per-possession scoring sample variance; descriptive, not causal',
      lineupChangePolicy: 'remaining mid-possession lineup changes use the verified possession-start lineup and are counted explicitly',
    },
    definitions: {
      fourFactors: FOUR_FACTOR_FORMULAS,
      garbageTimeProxy: GARBAGE_TIME_PROXY_DEFINITION,
      leverageProxy: LEVERAGE_PROXY_DEFINITION,
      plusMinusPer100: '200 * total point differential / (offensive possessions + defensive possessions)',
      netRating: 'offensive rating minus defensive rating',
      halfCourt: 'non_provider_fastbreak is only a qualifier-absence proxy and is not verified half-court offense',
      extendedScoutMetrics: {
        trueShootingPercentage: 'points / (2 * (FGA + 0.44 * FTA))',
        possessionOutcomes: '0, 1, 2, 3, and 4+ points on the nominal possession side',
        venue: 'home or away game context for the team perspective',
        periodsAndHalves: 'Quarter, overtime, first-half, and second-half contexts from the possession period sequence.',
        shotZones: 'Structured two-point shot distance bands: at rim 0-4 ft, short mid-range 5-14 ft, long mid-range 15+ ft; unavailable distances are excluded from zone counts.',
        rotationContinuity: 'Starting/closing lineups are first/final verified exact five-player stints in an eligible game.',
        directPlayerProfiles: 'Box-score-style player totals come only from non-rescinded, structured provider event statistics in Scout-eligible games.',
        possessionExtensions: 'Second-chance and points-off-turnover counts require the documented structured event evidence and are not inferred where it is absent.',
        gameResults: 'team result in games contributing to the descriptive sample; not a causal lineup record',
      },
    },
    analyticsAvailability: {
      exactTwoToFivePlayerLineups: { status: 'available', rows: rowCounts.lineupsAndCombinations, exactFiveSemantics: 'exact five-player possession-start lineup', twoToFourSemantics: 'shared-floor co-presence combination' },
      onOff: { status: 'available', rows: rowCounts.playerOnOff, scope: 'same-game player appearance', nullSafe: true },
      wowy: { status: 'available', rows: rowCounts.wowy, caveat: 'descriptive four-cell shared-floor partitions, not causal teammate effects' },
      offensiveDefensiveRatingsPer100: { status: 'available', source: 'current-version reconstructed PBP possessions' },
      fourFactors: { status: 'available_with_coverage', source: 'structured normalized event statistics' },
      shootingAndPlaymakingProfiles: { status: 'available_with_coverage', includes: ['2P%, 3P%, FT%, 3PA rate, true shooting, structured shot-distance zones, assists, fouls drawn, second chance, points off turnovers'] },
      defensiveDisruption: { status: 'available_with_coverage', includes: ['steals, blocks, personal fouls, per-100 rates'] },
      directPlayerProfiles: { status: 'available_with_coverage', rows: rowCounts.playerProfiles, caveat: 'Direct event statistics are descriptive and are joined to reconstructed on-court exposure; only rostered players with a same-game on/off row are emitted.' },
      rotationContinuity: { status: 'available_with_coverage', exactLineupSemantics: 'first/final verified exact five-player stint in each eligible game', caveat: 'Games without verified exact stints do not contribute a starting or closing assignment.' },
      periodAndHalfSplits: { status: 'available', contexts: ['period:q1', 'period:q2', 'period:q3', 'period:q4', 'period:overtime', 'half:first_half', 'half:second_half', 'half:overtime'] },
      possessionOutcomes: { status: 'available', buckets: ['0', '1', '2', '3', '4+'] },
      venueSplits: { status: 'available', contexts: ['home', 'away'] },
      teammateOpponentAdjustment: { status: 'available_via_rapm', caveat: 'average teammate/opponent RAPM fields are exposure context, not extra adjustment terms' },
      regularizedAdjustedPlusMinus: { status: 'available', netModel: RAPM_MODEL_VERSION, offenseDefenseModel: RAPM_OFFENSE_DEFENSE_MODEL_VERSION, lambdaSelection: 'deterministic held-out game-fold weighted MSE when auto' },
      clutch: { status: 'available_with_unclassified', definition: 'final five minutes of fourth quarter/overtime, margin five or fewer at possession start; missing period, clock, or score is retained as clutch:unclassified' },
      transition: { status: 'available', contexts: ['provider_fastbreak_v1', 'non_provider_fastbreak', 'unclassified'] },
      halfCourt: { status: 'proxy_only', proxy: 'non_provider_fastbreak' },
      scoreState: { status: 'available' },
      phaseSplits: { status: 'available', phases: OPTIONS.includedPhases },
      rollingWindows: { status: 'available', windows: [5, 10, 20] },
      garbageTimeAndLeverage: { status: 'proxy_only', garbageTime: GARBAGE_TIME_PROXY_DEFINITION.version, leverage: LEVERAGE_PROXY_DEFINITION.version },
      confidenceIntervals: { status: 'available_approximate', caveat: 'descriptive normal approximations do not model possession dependence' },
      unseenCombinationPrediction: { status: 'available', formula: 'sum five net RAPM values; observed exact lineups add possession-shrunk residual synergy' },
      videoPlayTypesShotsDefenderTrackingInjuriesContracts: { status: 'not_in_archive', caveat: 'requires separately licensed/enriched sources' },
    },
    tables: {
      teams: rowCounts.teams,
      lineupsAndCombinations: rowCounts.lineupsAndCombinations,
      playerOnOff: rowCounts.playerOnOff,
      playerProfiles: rowCounts.playerProfiles,
      wowy: rowCounts.wowy,
    },
    rapm: {
      sourceMode: 'grouped current-reconstruction possession-start exact-lineup possessions',
      sourceExactLineupPossessions: counters.exactLineupPossessions,
      net: rapmModelOutput(netRapm, rapmPlayers),
      offenseDefense: rapmModelOutput(offenseDefenseRapm, offenseDefenseRapm.players.map((row) => ({
        ...row,
        playerName: playerNames.get(row.providerPlayerId) || row.providerPlayerId,
      })).sort(sortBy((row) => row.playerName, (row) => row.providerPlayerId))),
    },
    projectionModel: {
      model: 'rapm_sum_plus_possession_shrunk_observed_synergy_v1',
      unseenLineupFormula: 'sum the five player net RAPM values; no synergy is assumed for an unseen combination',
      observedLineupFormula: 'neutral net RAPM sum plus a possession-shrunk residual after opponent and home-court exposure adjustment',
      synergyPriorPossessions: OPTIONS.synergyPriorPossessions,
      playerNetRapmPrecisionDigits: 6,
      playerNetRapm: Object.fromEntries(rapmPlayers.map((row) => [row.providerPlayerId, round(row.rapmPer100, 6)])),
    },
    dataShards: [],
  };

  function sortedKeysForTeam(map, teamId, compareEntries) {
    const keys = [];
    for (const [key, entry] of map.entries()) {
      if (entry.teamId === teamId) keys.push(key);
    }
    keys.sort((left, right) => compareEntries(map.get(left), map.get(right)));
    return keys;
  }

  async function appendArrayItem(writer, state, row) {
    if (state.count > 0) await writer.write(',');
    await writer.write(JSON.stringify(row));
    state.count += 1;
  }

  async function writeTeamShard(team, stagingDirectory) {
    const teamSlug = String(team.teamId).replace(/[^a-zA-Z0-9_-]+/g, '_');
    const shardPath = path.join(stagingDirectory, 'teams', `${teamSlug}.json`);
    const shardGzipPath = `${shardPath}.gz`;
    const writer = createDigestingJsonWriter(shardPath);
    const combinationState = { count: 0 };
    const onOffState = { count: 0 };
    const profileState = { count: 0 };
    const wowyState = { count: 0 };
    const comparePlayer = (left, right) => (
      String(playerNames.get(left) || left).localeCompare(String(playerNames.get(right) || right))
      || String(left).localeCompare(String(right))
    );

    await writer.write(`{"schemaVersion":${OUTPUT_SCHEMA_VERSION},"metricsVersion":${JSON.stringify(SCOUT_METRICS_VERSION)},"seasonStartYear":${OPTIONS.seasonStartYear},"seasonEndYear":${OPTIONS.seasonStartYear + 1},"team":${JSON.stringify(team)},"lineupsAndCombinations":[`);
    const combinationKeys = sortedKeysForTeam(comboMap, team.teamId, (left, right) => (
      left.size - right.size || left.playerIds.join('|').localeCompare(right.playerIds.join('|'))
    ));
    for (const key of combinationKeys) {
      const entry = comboMap.get(key);
      await appendArrayItem(writer, combinationState, comboRow(entry));
      comboMap.delete(key);
      comboMinutes.delete(key);
      lineupStartCounts.delete(key);
      lineupCloseCounts.delete(key);
    }

    await writer.write('],"playerOnOff":[');
    const onOffRowsForTeam = [];
    const onOffKeys = sortedKeysForTeam(playerOnOffMap, team.teamId, (left, right) => comparePlayer(left.playerId, right.playerId));
    for (const key of onOffKeys) {
      const entry = playerOnOffMap.get(key);
      const row = playerOnOffRow(entry);
      onOffRowsForTeam.push({ key, row });
      await appendArrayItem(writer, onOffState, row);
      playerOnOffMap.delete(key);
      playerOnMinutes.delete(key);
      playerScopeMinutes.delete(key);
    }

    await writer.write('],"playerProfiles":[');
    for (const { key, row } of onOffRowsForTeam) {
      const profile = playerProfileFromEvents({
        teamId: row.teamId,
        team: row.team,
        playerId: row.playerId,
        player: row.player,
        events: playerEventMap.get(key) ?? createDirectPlayerEventLine(),
        onOff: row,
        starterGames: playerStartCounts.get(key) ?? 0,
        closerGames: playerCloseCounts.get(key) ?? 0,
      });
      await appendArrayItem(writer, profileState, profile);
      playerEventMap.delete(key);
      playerStartCounts.delete(key);
      playerCloseCounts.delete(key);
    }
    for (const key of [...playerEventMap.keys()]) {
      if (key.startsWith(`${team.teamId}~`)) playerEventMap.delete(key);
    }

    await writer.write('],"wowy":[');
    const wowyKeys = sortedKeysForTeam(wowyMap, team.teamId, (left, right) => (
      comparePlayer(left.playerA, right.playerA) || comparePlayer(left.playerB, right.playerB)
    ));
    for (const key of wowyKeys) {
      const entry = wowyMap.get(key);
      await appendArrayItem(writer, wowyState, wowyRow(entry));
      wowyMap.delete(key);
    }
    await writer.write(']}\n');
    const json = await writer.close();
    const gzip = await gzipFile(shardPath, shardGzipPath);

    teamMap.delete(team.teamId);
    teamScopeMinutes.delete(team.teamId);
    return {
      teamId: team.teamId,
      team: team.team,
      jsonPath: `teams/${teamSlug}.json`,
      gzipPath: `teams/${teamSlug}.json.gz`,
      ...json,
      ...gzip,
      rows: {
        team: 1,
        lineupsAndCombinations: combinationState.count,
        playerOnOff: onOffState.count,
        playerProfiles: profileState.count,
        wowy: wowyState.count,
      },
    };
  }

  const stagingOutputDirectory = await makeAtomicOutputDirectory(OPTIONS.outputDir);
  await fs.mkdir(path.join(stagingOutputDirectory, 'teams'), { recursive: true });
  const shardDescriptors = [];
  const writtenRows = {
    teams: 0,
    lineupsAndCombinations: 0,
    playerOnOff: 0,
    playerProfiles: 0,
    wowy: 0,
  };
  let shardJsonBytes = 0;
  let shardGzipBytes = 0;
  for (const team of teamRows) {
    const descriptor = await writeTeamShard(team, stagingOutputDirectory);
    shardDescriptors.push(descriptor);
    writtenRows.teams += 1;
    writtenRows.lineupsAndCombinations += descriptor.rows.lineupsAndCombinations;
    writtenRows.playerOnOff += descriptor.rows.playerOnOff;
    writtenRows.playerProfiles += descriptor.rows.playerProfiles;
    writtenRows.wowy += descriptor.rows.wowy;
    shardJsonBytes += descriptor.jsonBytes;
    shardGzipBytes += descriptor.gzipBytes;
    requestGarbageCollection();
  }
  for (const [field, expected] of Object.entries(rowCounts)) {
    if (writtenRows[field] !== expected) {
      throw new Error(`Streamed ${field} count ${writtenRows[field]} does not match expected ${expected}.`);
    }
  }
  if (comboMap.size || playerOnOffMap.size || wowyMap.size || teamMap.size) {
    throw new Error('Not every in-memory aggregate was assigned to exactly one team shard.');
  }
  comboMinutes.clear();
  playerEventMap.clear();
  playerOnMinutes.clear();
  playerScopeMinutes.clear();
  teamScopeMinutes.clear();
  lineupStartCounts.clear();
  lineupCloseCounts.clear();
  playerStartCounts.clear();
  playerCloseCounts.clear();
  requestGarbageCollection();

  output.dataShards = shardDescriptors;
  output.storage = {
    format: 'schema_v4_streamed_team_shards_with_manifest',
    writeMode: 'bounded_memory_atomic_team_stream_v1',
    shardCount: shardDescriptors.length,
    shardJsonBytes,
    shardGzipBytes,
    caveat: 'Uncompressed shards are retained for inspection; gzip shards are the preferred transport/archive representation. Team shards are streamed into a staging directory and the completed directory is renamed into place only after the manifest is complete.',
  };
  const filename = `nba-scout-analytics-${OPTIONS.seasonStartYear}-${String(OPTIONS.seasonStartYear + 1).slice(-2)}.json`;
  const stagedOutputPath = path.join(stagingOutputDirectory, filename);
  const stagedGzipPath = `${stagedOutputPath}.gz`;
  const stagedSummaryPath = path.join(stagingOutputDirectory, 'README.md');
  const outputRaw = `${JSON.stringify(output)}\n`;
  await fs.writeFile(stagedOutputPath, outputRaw, 'utf8');
  const outputHash = sha256(outputRaw);
  const outputBytes = Buffer.byteLength(outputRaw);
  const gzip = await gzipFile(stagedOutputPath, stagedGzipPath);
  const summary = `# NBA Scout analytics — ${OPTIONS.seasonStartYear}-${String(OPTIONS.seasonStartYear + 1).slice(-2)}\n\n`
    + `Generated offline from the preserved local Sportradar archive with transient ${NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION} replay. No API request and no Supabase write was made.\n\n`
    + `- Source archives: ${counters.archivesDiscovered}; selected official candidates: ${counters.archivesOfficialCandidates}; Scout-eligible after replay: ${counters.archivesEligible}.\n`
    + `- Included phases: ${OPTIONS.includedPhases.join(', ')}; excluded by phase: ${counters.archivesExcludedByPhase}; non-franchise exclusions: ${counters.archivesExcludedNonFranchise}.\n`
    + `- Eligible events/stints/possessions: ${counters.eventsInEligibleArchives}/${counters.stintsInEligibleArchives}/${counters.possessionsInEligibleArchives}.\n`
    + `- Possessions with valid start lineups used: ${counters.exactLineupPossessions}; start-lineup-attributed mid-change possessions: ${counters.possessionStartLineupAttributedMidChange}; excluded: ${counters.excludedPossessions}.\n`
    + `- Rows: ${rowCounts.lineupsAndCombinations} combinations; ${rowCounts.playerOnOff} player on/off; ${rowCounts.playerProfiles} direct player profiles; ${rowCounts.wowy} WOWY pairs; ${rapmPlayers.length} net RAPM players.\n`
    + `- Net RAPM lambda: ${netRapm.lambda}; offense/defense RAPM lambda: ${offenseDefenseRapm.lambda}; both use deterministic game-fold selection when configured as auto.\n`
    + `- Added phase, venue, quarter/half, last-5/10/20, clutch, transition, score-state, garbage-time proxy, leverage, four-factor, shot-zone, possession-extension, rotation-continuity, player-profile, reliability, interval, O/D RAPM, and lineup-projection fields.\n`
    + `- Manifest JSON: ${outputBytes} bytes, SHA-256 ${outputHash}.\n`
    + `- Manifest gzip: ${gzip.gzipBytes} bytes, SHA-256 ${gzip.gzipSha256}.\n`
    + `- Team shards: ${shardDescriptors.length}; JSON bytes: ${shardJsonBytes}; gzip bytes: ${shardGzipBytes}.\n`
    + `- Packaging: bounded-memory streamed shards written to a staging directory and atomically renamed only after completion.\n`;
  await fs.writeFile(stagedSummaryPath, summary, 'utf8');
  await fs.rename(stagingOutputDirectory, OPTIONS.outputDir);

  const outputPath = path.join(OPTIONS.outputDir, filename);
  const gzipPath = `${outputPath}.gz`;
  const summaryPath = path.join(OPTIONS.outputDir, 'README.md');
  process.stdout.write(`${JSON.stringify({
    outputPath,
    gzipPath,
    summaryPath,
    outputHash,
    gzipHash: gzip.gzipSha256,
    storage: output.storage,
    coverage: counters,
    rapm: {
      netLambda: netRapm.lambda,
      offenseDefenseLambda: offenseDefenseRapm.lambda,
      observationCount: netRapm.observationCount,
      gameCount: netRapm.gameCount,
      playerRows: rapmPlayers.length,
    },
    rows: {
      teams: rowCounts.teams,
      combinations: rowCounts.lineupsAndCombinations,
      onOff: rowCounts.playerOnOff,
      playerProfiles: rowCounts.playerProfiles,
      wowy: rowCounts.wowy,
    },
  }, null, 2)}\n`);
}

if (IS_MAIN) {
  derive().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
