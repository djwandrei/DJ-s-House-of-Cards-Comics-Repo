import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  evaluateOffenseDefenseRapmCalibration,
  fitWeightedRidgeOffenseDefenseRapm,
  fitWeightedRidgeRapm,
  RAPM_MODEL_VERSION,
  RAPM_OFFENSE_DEFENSE_MODEL_VERSION,
  selectChronologicalRapmHyperparameters,
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
const REQUIRED_SOURCE_VALIDATOR_VERSION = 'sportradar-nba-local-archive-validator-v4';
const SOURCE_SUMMARY_TEAM_RECONCILIATION_FIELDS = [
  'gamesWithSummaryTeamScoreNonReconciliation',
  'gamesWithSummaryTeamOffensiveRatingAlgebraDiagnostics',
  'summaryTeamOffensiveRatingAlgebraDiagnostics',
  'gamesWithSummaryTeamDefensiveRatingAlgebraDiagnostics',
  'summaryTeamDefensiveRatingAlgebraDiagnostics',
  'gamesWithSummaryTeamPossessionSymmetryDiagnostics',
  'summaryTeamPossessionSymmetryDiagnostics',
];
const OFFICIAL_PLAYER_BOX_SCORE_FIELDS = [
  'points', 'fieldGoalAttempts', 'fieldGoalsMade', 'twoPointAttempts', 'twoPointMakes',
  'threePointAttempts', 'threePointersMade', 'freeThrowAttempts', 'freeThrowsMade',
  'offensiveRebounds', 'defensiveRebounds', 'rebounds', 'assists', 'steals', 'blocks',
  'turnovers', 'personalFouls',
];

function parseLambda(value, name) {
  if (String(value).trim().toLowerCase() === 'auto') return 'auto';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be "auto" or a number greater than zero.`);
  return parsed;
}

function parsePriorSeasonWeight(value, name) {
  if (String(value).trim().toLowerCase() === 'auto') return 'auto';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be "auto" or a number from zero through one.`);
  }
  return parsed;
}

function seasonLabel(seasonStartYears) {
  const first = seasonStartYears[0];
  const last = seasonStartYears[seasonStartYears.length - 1];
  return `${first}-${String(last + 1).slice(-2)}`;
}

export function optionsFromArgs(argv) {
  const options = {
    archiveDir: null,
    seasonStartYears: [2025],
    seasonStartYear: 2025,
    latestSeasonStartYear: 2025,
    outputDir: null,
    validationReport: null,
    calibrationOnly: false,
    calibrationReport: null,
    rapmLambda: 'auto',
    offenseDefenseRapmLambda: 'auto',
    rapmPriorSeasonWeight: 1,
    offenseDefenseRapmPriorSeasonWeight: 1,
    priorSeasonWeightCandidates: [0, 0.25, 0.5, 0.75, 1],
    chronologicalTuningGameFraction: 0.2,
    chronologicalTestGameFraction: 0.2,
    lambdaCandidates: [...DEFAULT_LAMBDA_CANDIDATES],
    lambdaFoldCount: 5,
    includedPhases: [...DEFAULT_INCLUDED_PHASES],
    replayReconstruction: true,
    synergyPriorPossessions: 400,
    // The original all-in-memory mode is kept for small, single-season
    // derivations.  The replay-cache mode is deliberately opt-in because it
    // trades temporary private disk space for a bounded heap while preserving
    // the exact same possession-level aggregation semantics.
    teamShardMode: 'in_memory',
    replayCacheDir: null,
    reuseReplayCache: false,
  };
  let sawSeason = false;
  let sawSeasons = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--no-replay-reconstruction') {
      options.replayReconstruction = false;
      continue;
    }
    const [name, inline] = token.split(/=(.*)/s, 2);
    if (name === '--calibration-only') {
      if (inline !== undefined) throw new Error('--calibration-only does not accept a value.');
      options.calibrationOnly = true;
      continue;
    }
    if (name === '--reuse-replay-cache') {
      if (inline !== undefined) throw new Error('--reuse-replay-cache does not accept a value.');
      options.reuseReplayCache = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--archive-dir') options.archiveDir = path.resolve(value);
    else if (name === '--season') {
      sawSeason = true;
      options.seasonStartYears = [Number.parseInt(value, 10)];
    } else if (name === '--seasons') {
      sawSeasons = true;
      options.seasonStartYears = value.split(',').map((item) => Number.parseInt(item.trim(), 10));
    }
    else if (name === '--output-dir') options.outputDir = path.resolve(value);
    else if (name === '--validation-report') options.validationReport = path.resolve(value);
    else if (name === '--calibration-report') options.calibrationReport = path.resolve(value);
    else if (name === '--rapm-lambda') options.rapmLambda = parseLambda(value, name);
    else if (name === '--offense-defense-rapm-lambda') options.offenseDefenseRapmLambda = parseLambda(value, name);
    else if (name === '--rapm-prior-season-weight') options.rapmPriorSeasonWeight = parsePriorSeasonWeight(value, name);
    else if (name === '--offense-defense-rapm-prior-season-weight') options.offenseDefenseRapmPriorSeasonWeight = parsePriorSeasonWeight(value, name);
    else if (name === '--prior-season-weight-candidates') {
      options.priorSeasonWeightCandidates = value.split(',').map(Number);
      if (!options.priorSeasonWeightCandidates.length
        || options.priorSeasonWeightCandidates.some((candidate) => !Number.isFinite(candidate) || candidate < 0 || candidate > 1)) {
        throw new Error('--prior-season-weight-candidates must be a comma-separated list of numbers from zero through one.');
      }
    } else if (name === '--chronological-tuning-game-fraction') {
      options.chronologicalTuningGameFraction = Number(value);
    } else if (name === '--chronological-test-game-fraction') {
      options.chronologicalTestGameFraction = Number(value);
    }
    else if (name === '--lambda-candidates') {
      options.lambdaCandidates = value.split(',').map(Number);
      if (!options.lambdaCandidates.length || options.lambdaCandidates.some((candidate) => !Number.isFinite(candidate) || candidate <= 0)) {
        throw new Error('--lambda-candidates must be a comma-separated list of positive numbers.');
      }
    } else if (name === '--lambda-folds') options.lambdaFoldCount = Number.parseInt(value, 10);
    else if (name === '--synergy-prior-possessions') options.synergyPriorPossessions = Number(value);
    else if (name === '--team-shard-mode') {
      if (!['in_memory', 'replay_cache'].includes(value)) {
        throw new Error('--team-shard-mode must be "in_memory" or "replay_cache".');
      }
      options.teamShardMode = value;
    } else if (name === '--replay-cache-dir') options.replayCacheDir = path.resolve(value);
    else if (name === '--phases') {
      const phases = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      if (!phases.length || phases.some((phase) => !VALID_PHASES.has(phase))) {
        throw new Error(`--phases must contain only: ${[...VALID_PHASES].join(', ')}.`);
      }
      options.includedPhases = [...new Set(phases)];
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.archiveDir) throw new Error('--archive-dir is required.');
  if (sawSeason && sawSeasons) throw new Error('--season and --seasons are mutually exclusive.');
  if (!options.seasonStartYears.length
    || options.seasonStartYears.some((year) => !Number.isInteger(year) || year < 1947)) {
    throw new Error('--season/--seasons must contain valid NBA season start years.');
  }
  options.seasonStartYears = [...new Set(options.seasonStartYears)].sort((left, right) => left - right);
  options.seasonStartYear = options.seasonStartYears[0];
  options.latestSeasonStartYear = options.seasonStartYears[options.seasonStartYears.length - 1];
  if (options.seasonStartYears.length === 1
    && (options.rapmPriorSeasonWeight === 'auto' || options.offenseDefenseRapmPriorSeasonWeight === 'auto')) {
    throw new Error('Automatic prior-season weights require at least two seasons.');
  }
  if (options.calibrationOnly && options.seasonStartYears.length !== 1) {
    throw new Error('--calibration-only currently accepts exactly one season; multiseason tuning is embedded in the full package derivation.');
  }
  if (!Number.isInteger(options.lambdaFoldCount) || options.lambdaFoldCount < 2) throw new Error('--lambda-folds must be an integer of at least two.');
  if (!Number.isFinite(options.synergyPriorPossessions) || options.synergyPriorPossessions <= 0) throw new Error('--synergy-prior-possessions must be greater than zero.');
  for (const [name, fraction] of [
    ['--chronological-tuning-game-fraction', options.chronologicalTuningGameFraction],
    ['--chronological-test-game-fraction', options.chronologicalTestGameFraction],
  ]) {
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 0.5) {
      throw new Error(`${name} must be greater than zero and less than 0.5.`);
    }
  }
  if (options.chronologicalTuningGameFraction + options.chronologicalTestGameFraction >= 1) {
    throw new Error('Chronological tuning and test fractions must total less than one.');
  }
  if (!options.outputDir) options.outputDir = path.join(options.archiveDir, '..', 'scout-analytics', seasonLabel(options.seasonStartYears));
  if (options.teamShardMode === 'replay_cache') {
    if (options.calibrationOnly) {
      throw new Error('--team-shard-mode replay_cache cannot be combined with --calibration-only.');
    }
    if (!options.replayCacheDir) {
      options.replayCacheDir = path.join(
        options.archiveDir,
        '..',
        'work',
        `${path.basename(options.outputDir)}-replay-cache`,
      );
    }
  }
  if (options.reuseReplayCache && options.teamShardMode !== 'replay_cache') {
    throw new Error('--reuse-replay-cache requires --team-shard-mode replay_cache.');
  }
  if (options.calibrationOnly && !options.calibrationReport) {
    options.calibrationReport = path.join(
      options.archiveDir,
      '..',
      'work',
      `nba-scout-${seasonLabel(options.seasonStartYears)}-od-rapm-calibration.json`,
    );
  }
  return options;
}

const MODULE_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MODULE_PATH);
const OPTIONS = IS_MAIN ? optionsFromArgs(process.argv.slice(2)) : null;
const SEASON_PATHS = OPTIONS
  ? OPTIONS.seasonStartYears.map((seasonStartYear) => {
    const seasonDirectory = path.join(OPTIONS.archiveDir, String(seasonStartYear));
    return {
      seasonStartYear,
      seasonDirectory,
      gamesDirectory: path.join(seasonDirectory, 'games'),
      manifestPath: path.join(seasonDirectory, 'manifest.json'),
    };
  })
  : [];
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

async function assertOutputFileAbsent(outputPath) {
  try {
    await fs.stat(outputPath);
    throw new Error(`Refusing to overwrite existing Scout calibration report: ${outputPath}`);
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

/**
 * Normalize the source-checkpoint verdict used in derivative model reports.
 * The archive validator intentionally stores one authoritative `passed` flag
 * at the report level; individual season entries describe their coverage and
 * hashes but do not repeat that boolean.  Keeping this interpretation in one
 * tested helper prevents a downstream model report from mislabeling a valid
 * source archive as failed merely because `season.passed` is absent.
 */
export function sourceArchiveValidationStatus(validation, seasonStartYear) {
  const selectedSeason = (validation?.seasons ?? []).find(
    (season) => season?.seasonStartYear === seasonStartYear,
  ) ?? null;
  const sourceArchiveValidationReportPassed = validation?.passed === true;
  const sourceArchiveValidationSeasonPresent = selectedSeason !== null;
  return {
    selectedSeason,
    sourceArchiveValidationReportPassed,
    sourceArchiveValidationSeasonPresent,
    sourceArchiveValidationPassed: sourceArchiveValidationReportPassed
      && sourceArchiveValidationSeasonPresent,
  };
}

export function sourceArchiveValidationStatuses(validation, seasonStartYears) {
  const seasons = seasonStartYears.map((seasonStartYear) => ({
    seasonStartYear,
    ...sourceArchiveValidationStatus(validation, seasonStartYear),
  }));
  const occurrencesByYear = new Map();
  for (const season of validation?.seasons ?? []) {
    const year = Number(season?.seasonStartYear);
    if (seasonStartYears.includes(year)) {
      occurrencesByYear.set(year, (occurrencesByYear.get(year) ?? 0) + 1);
    }
  }
  const sourceArchiveValidationAllSeasonsExactlyOnce = seasonStartYears.every(
    (seasonStartYear) => occurrencesByYear.get(seasonStartYear) === 1,
  );
  return {
    seasons,
    selectedSeasons: seasons.map((season) => season.selectedSeason).filter(Boolean),
    sourceArchiveValidationReportPassed: validation?.passed === true,
    sourceArchiveValidationAllSeasonsPresent: seasons.every(
      (season) => season.sourceArchiveValidationSeasonPresent,
    ),
    sourceArchiveValidationAllSeasonsExactlyOnce,
    sourceArchiveValidationPassed: validation?.passed === true
      && seasons.every((season) => season.sourceArchiveValidationSeasonPresent)
      && sourceArchiveValidationAllSeasonsExactlyOnce,
  };
}

/**
 * The Scout package is deliberately trial-only.  Check that policy from the
 * selected raw manifests before touching the large game archive, rather than
 * accepting an access-level assertion made later in a derived report.
 */
export function requireTrialSourceAccessLevels(manifestEntries, seasonStartYears) {
  if (!Array.isArray(manifestEntries)) throw new TypeError('Selected source manifests must be an array.');
  if (!Array.isArray(seasonStartYears) || !seasonStartYears.length) {
    throw new TypeError('Selected source seasons must be a non-empty array.');
  }
  const selectedYears = [...new Set(seasonStartYears.map(Number))].sort((left, right) => left - right);
  if (selectedYears.length !== seasonStartYears.length || selectedYears.some((year) => !Number.isInteger(year))) {
    throw new TypeError('Selected source seasons must be unique integer years.');
  }
  const byYear = new Map();
  for (const entry of manifestEntries) {
    const requestedYear = Number(entry?.seasonStartYear);
    if (!Number.isInteger(requestedYear) || byYear.has(requestedYear)) {
      throw new Error('Selected source manifests contain an invalid or duplicate season.');
    }
    let manifest;
    try {
      manifest = typeof entry?.raw === 'string' ? JSON.parse(entry.raw) : entry?.manifest;
    } catch (error) {
      throw new Error(`Selected source manifest for season ${requestedYear} is not valid JSON: ${String(error?.message ?? error)}`);
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`Selected source manifest for season ${requestedYear} is invalid.`);
    }
    if (Number(manifest.seasonStartYear) !== requestedYear) {
      throw new Error(`Selected source manifest season does not match its requested season: ${requestedYear}.`);
    }
    if (manifest.accessLevel !== 'trial') {
      throw new Error(`Selected source manifest for season ${requestedYear} must declare accessLevel "trial".`);
    }
    byYear.set(requestedYear, manifest.accessLevel);
  }
  if (byYear.size !== selectedYears.length || selectedYears.some((year) => !byYear.has(year))) {
    throw new Error('Selected source manifests do not cover every requested season exactly once.');
  }
  return Object.fromEntries(selectedYears.map((year) => [year, byYear.get(year)]));
}

/**
 * Bind the selected manifests to the already-approved checkpoint before the
 * costly archive read.  A passing report for a different raw snapshot is not
 * sufficient evidence for a new package.
 */
export function requireSourceValidationManifestHashes(validation, manifestEntries, seasonStartYears) {
  const sourceValidation = sourceArchiveValidationStatuses(validation, seasonStartYears);
  if (!sourceValidation.sourceArchiveValidationPassed) {
    throw new Error('Source archive validation must pass and contain every requested season before Scout derivation.');
  }
  const manifestSha256BySeason = Object.fromEntries(manifestEntries.map((entry) => [
    Number(entry.seasonStartYear), sha256(entry.raw),
  ]));
  for (const sourceSeason of sourceValidation.seasons) {
    const expected = String(sourceSeason.selectedSeason?.manifestSha256 ?? '');
    const actual = manifestSha256BySeason[sourceSeason.seasonStartYear];
    if (!/^[a-f0-9]{64}$/i.test(expected)) {
      throw new Error(`Source archive validation has no valid manifest hash for season ${sourceSeason.seasonStartYear}.`);
    }
    if (actual !== expected) {
      throw new Error(`Selected source manifest hash does not match the validated checkpoint for season ${sourceSeason.seasonStartYear}.`);
    }
  }
  return { sourceValidation, manifestSha256BySeason };
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? ''));
}

function validatedSourceFileDescriptor(record) {
  const relativePath = String(record?.relativePath ?? '').replaceAll('\\', '/');
  if (!/^games\/[^/]+\.json\.gz$/.test(relativePath)) {
    throw new Error(`Source archive validation contains an invalid game-file path: ${relativePath || '(missing)'}.`);
  }
  const byteLength = Number(record?.byteLength);
  const uncompressedByteLength = Number(record?.uncompressedByteLength);
  const gzipSha256 = String(record?.gzipSha256 ?? '');
  const uncompressedSha256 = String(record?.uncompressedSha256 ?? '');
  const normalizedJsonSha256 = String(record?.normalizedJsonSha256 ?? '');
  const gameId = String(record?.gameId ?? '').trim();
  if (!gameId) {
    throw new Error(`Source archive validation has no game identifier for ${relativePath}.`);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0
    || !Number.isSafeInteger(uncompressedByteLength) || uncompressedByteLength < 0
    || !isSha256(gzipSha256) || !isSha256(uncompressedSha256) || !isSha256(normalizedJsonSha256)) {
    throw new Error(`Source archive validation has invalid file integrity metadata for ${relativePath}.`);
  }
  return {
    relativePath,
    filename: relativePath.slice('games/'.length),
    gameId,
    byteLength,
    gzipSha256,
    uncompressedByteLength,
    uncompressedSha256,
    normalizedJsonSha256,
  };
}

/**
 * Bind the actual compressed game inventory to the archive checkpoint.  The
 * manifest is an important selection contract, but it only identifies game
 * paths and statuses.  This inventory makes a post-validation source edit,
 * substitution, omission, or orphaned game file a hard derivation failure.
 */
export function requireSourceValidationFileHashes(validation, seasonStartYears) {
  const sourceValidation = sourceArchiveValidationStatuses(validation, seasonStartYears);
  if (!sourceValidation.sourceArchiveValidationPassed) {
    throw new Error('Source archive validation must pass and contain every requested season before binding game-file hashes.');
  }
  const bySeason = {};
  for (const sourceSeason of sourceValidation.seasons) {
    const year = sourceSeason.seasonStartYear;
    const files = sourceSeason.selectedSeason?.files;
    const records = files?.records;
    const expectedCompletedFiles = Number(files?.expectedCompletedFiles);
    const discoveredGameFiles = Number(files?.discoveredGameFiles);
    const aggregateFileHash = String(files?.aggregateFileHash ?? '');
    if (!Array.isArray(records)
      || !Number.isSafeInteger(expectedCompletedFiles)
      || !Number.isSafeInteger(discoveredGameFiles)
      || expectedCompletedFiles < 0
      || discoveredGameFiles < 0
      || records.length !== expectedCompletedFiles
      || records.length !== discoveredGameFiles
      || !isSha256(aggregateFileHash)) {
      throw new Error(`Source archive validation has incomplete game-file integrity metadata for season ${year}.`);
    }
    const expectedFiles = new Map();
    const descriptors = [];
    for (const record of records) {
      const descriptor = validatedSourceFileDescriptor(record);
      if (expectedFiles.has(descriptor.filename)) {
        throw new Error(`Source archive validation contains a duplicate game-file path for season ${year}: ${descriptor.relativePath}.`);
      }
      expectedFiles.set(descriptor.filename, descriptor);
      descriptors.push({
        relativePath: descriptor.relativePath,
        byteLength: descriptor.byteLength,
        gzipSha256: descriptor.gzipSha256,
        uncompressedByteLength: descriptor.uncompressedByteLength,
        uncompressedSha256: descriptor.uncompressedSha256,
      });
    }
    descriptors.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    bySeason[year] = {
      aggregateFileHash,
      expectedFiles,
      expectedFileCount: descriptors.length,
      fileIntegritySha256: sha256(JSON.stringify(descriptors)),
    };
  }
  return bySeason;
}

function sourceFileIntegrityProvenance(bySeason) {
  return Object.fromEntries(Object.entries(bySeason).map(([year, integrity]) => [year, {
    validatedAggregateFileHash: integrity.aggregateFileHash,
    expectedFileCount: integrity.expectedFileCount,
    fileIntegritySha256: integrity.fileIntegritySha256,
  }]));
}

export function verifiedSourceFileDescriptor({ expected, filename, compressed, uncompressed, gameId }) {
  if (!expected || expected.filename !== filename) {
    throw new Error('Source archive file is absent from the validated file inventory.');
  }
  const gzipSha256 = sha256(compressed);
  if (compressed.byteLength !== expected.byteLength || gzipSha256 !== expected.gzipSha256) {
    throw new Error(`Source archive file does not match its validated gzip digest: ${expected.relativePath}.`);
  }
  const uncompressedSha256 = sha256(uncompressed);
  if (uncompressed.byteLength !== expected.uncompressedByteLength || uncompressedSha256 !== expected.uncompressedSha256) {
    throw new Error(`Source archive file does not match its validated uncompressed digest: ${expected.relativePath}.`);
  }
  if (gameId !== expected.gameId) {
    throw new Error(`Source archive file does not match its validated game identifier: ${expected.relativePath}.`);
  }
  return {
    relativePath: expected.relativePath,
    byteLength: compressed.byteLength,
    gzipSha256,
    uncompressedByteLength: uncompressed.byteLength,
    uncompressedSha256,
  };
}

/**
 * Summary-team reconciliation is source quality evidence, not a default-zero
 * cosmetic counter.  Require the validator revision that computes it and all
 * of its explicit counters before any package can describe the diagnostics.
 */
export function requireSourceSummaryTeamReconciliation(validation, seasonStartYears) {
  if (validation?.validatorVersion !== REQUIRED_SOURCE_VALIDATOR_VERSION) {
    throw new Error(`Scout derivation requires source validator ${REQUIRED_SOURCE_VALIDATOR_VERSION}.`);
  }
  const sourceValidation = sourceArchiveValidationStatuses(validation, seasonStartYears);
  if (!sourceValidation.sourceArchiveValidationPassed) {
    throw new Error('Source archive validation must pass before binding summary-team reconciliation diagnostics.');
  }
  return Object.fromEntries(sourceValidation.seasons.map((sourceSeason) => {
    const dataQuality = sourceSeason.selectedSeason?.dataQuality;
    const counters = {};
    for (const field of SOURCE_SUMMARY_TEAM_RECONCILIATION_FIELDS) {
      const value = Number(dataQuality?.[field]);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Source archive validation has no valid ${field} counter for season ${sourceSeason.seasonStartYear}.`);
      }
      counters[field] = value;
    }
    return [sourceSeason.seasonStartYear, counters];
  }));
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

/**
 * Selects the first and final exact lineup stints that are actually observed
 * at a possession start. A reconstructed dead-ball substitution can create a
 * valid zero-duration/end-of-game stint; crediting it as a starter or closer
 * would make role counts disagree with the possession-defined on/off sample.
 */
export function selectPossessionObservedBoundaryLineups({
  teamId,
  exactLineups = [],
  observedLineupKeys = new Set(),
} = {}) {
  const normalizedTeamId = String(teamId ?? '').trim();
  if (!normalizedTeamId) return { starterIds: null, closerIds: null };
  const observed = observedLineupKeys instanceof Set
    ? observedLineupKeys
    : new Set(Array.isArray(observedLineupKeys) ? observedLineupKeys : []);
  const candidates = (Array.isArray(exactLineups) ? exactLineups : [])
    .filter((ids) => Array.isArray(ids) && ids.length === 5);
  const wasObservedAtPossessionStart = (ids) => observed.has(comboKey(normalizedTeamId, ids));
  return {
    starterIds: candidates.find(wasObservedAtPossessionStart) ?? null,
    closerIds: [...candidates].reverse().find(wasObservedAtPossessionStart) ?? null,
  };
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
    offensiveFouls: 0,
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
  } else if (type === 'turnover') {
    line.recognizedStatisticRows += 1;
    line.turnovers += 1;
  } else if (type === 'offensivefoul') {
    line.recognizedStatisticRows += 1;
    // The provider supplies a separate turnover row for the same offensive
    // foul. Treating both row types as turnovers double-counts that play and
    // biases possession-ending involvement. These are DIRECT box-score totals:
    // count explicit turnover rows only, and retain the foul as its own signal.
    // If a turnover row is absent, independent Summary reconciliation exposes
    // the gap; it must not be silently inferred or patched from the foul.
    line.offensiveFouls = (line.offensiveFouls ?? 0) + 1;
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

function directBoxScoreForOfficialComparison(events) {
  if (!events || events.unknownFieldGoalMadeStatus !== 0
    || events.unclassifiedFieldGoalAttempts !== 0
    || events.unclassifiedFieldGoalMakes !== 0
    || events.unknownFreeThrowMadeStatus !== 0
    || events.unclassifiedRebounds !== 0) return null;
  const values = {
    points: events.points,
    fieldGoalAttempts: events.fieldGoalAttempts,
    fieldGoalsMade: events.fieldGoalsMade,
    twoPointAttempts: events.twoPointAttempts,
    twoPointMakes: events.twoPointMakes,
    threePointAttempts: events.threePointAttempts,
    threePointersMade: events.threePointersMade,
    freeThrowAttempts: events.freeThrowAttempts,
    freeThrowsMade: events.freeThrowsMade,
    offensiveRebounds: events.offensiveRebounds,
    defensiveRebounds: events.defensiveRebounds,
    rebounds: events.offensiveRebounds + events.defensiveRebounds,
    assists: events.assists,
    steals: events.steals,
    blocks: events.blocks,
    turnovers: events.turnovers,
    personalFouls: events.personalFouls,
  };
  if (!OFFICIAL_PLAYER_BOX_SCORE_FIELDS.every((field) => Number.isInteger(values[field]) && values[field] >= 0)) return null;
  const expectedPoints = (2 * values.twoPointMakes) + (3 * values.threePointersMade) + values.freeThrowsMade;
  return values.points === expectedPoints ? values : null;
}

function officialSummaryBoxScoreForComparison(player) {
  const official = player?.officialBoxScore;
  const fields = official?.fields;
  if (official?.source !== 'summary_endpoint' || !fields || typeof fields !== 'object') return null;
  if (!OFFICIAL_PLAYER_BOX_SCORE_FIELDS.every((field) => (
    official.availableFields?.includes(field)
    && Number.isInteger(fields[field])
    && fields[field] >= 0
  ))) return null;
  if (fields.rebounds !== fields.offensiveRebounds + fields.defensiveRebounds) return null;
  const expectedPoints = (2 * fields.twoPointMakes) + (3 * fields.threePointersMade) + fields.freeThrowsMade;
  if (fields.points !== expectedPoints) return null;
  return Object.fromEntries(OFFICIAL_PLAYER_BOX_SCORE_FIELDS.map((field) => [field, fields[field]]));
}

function sameOfficialPlayerBoxScore(left, right) {
  return OFFICIAL_PLAYER_BOX_SCORE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function addOfficialPlayerBoxScore(target, values) {
  for (const field of OFFICIAL_PLAYER_BOX_SCORE_FIELDS) target[field] += values[field];
}

function createOfficialSummaryReconciliationState() {
  return {
    gamesExpected: 0,
    gamesWithAnySummaryTotals: 0,
    gamesWithCompleteSummaryTotals: 0,
    gamesReconciledWithStructuredPbp: 0,
    reconciledTotals: Object.fromEntries(OFFICIAL_PLAYER_BOX_SCORE_FIELDS.map((field) => [field, 0])),
  };
}

export function officialSummaryReconciliationFromState(state) {
  const source = state ?? createOfficialSummaryReconciliationState();
  const gamesExpected = Number(source.gamesExpected ?? 0);
  const gamesWithAnySummaryTotals = Number(source.gamesWithAnySummaryTotals ?? 0);
  const gamesWithCompleteSummaryTotals = Number(source.gamesWithCompleteSummaryTotals ?? 0);
  const gamesReconciledWithStructuredPbp = Number(source.gamesReconciledWithStructuredPbp ?? 0);
  const certified = gamesExpected > 0
    && gamesWithCompleteSummaryTotals === gamesExpected
    && gamesReconciledWithStructuredPbp === gamesExpected;
  const unavailable = gamesWithAnySummaryTotals === 0;
  return {
    status: certified
      ? 'complete_and_reconciled'
      : unavailable
        ? 'not_available_in_current_legacy_source_revision'
        : 'partial_or_unreconciled',
    source: 'summary_endpoint',
    gamesExpected,
    gamesWithAnySummaryTotals,
    gamesWithCompleteSummaryTotals,
    gamesReconciledWithStructuredPbp,
    totals: certified ? { ...source.reconciledTotals } : null,
    caveat: certified
      ? 'Every Scout-eligible player appearance had complete Summary-endpoint totals that exactly matched the independently parsed structured PBP totals for the same game and team.'
      : unavailable
        ? 'The selected historical records do not retain complete Summary-endpoint player box scores. These PBP totals are not labeled as independently reconciled official totals.'
        : 'At least one player appearance lacked complete Summary totals or did not reconcile with independently parsed structured PBP, so no aggregate official total is emitted.',
  };
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

export function playerProfileFromEvents({
  teamId,
  team,
  playerId,
  player,
  events,
  onOff,
  starterGames,
  closerGames,
  officialSummaryReconciliationState,
}) {
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
  const boxScore = {
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
  };
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
    // `boxScore` remains the compact legacy location.  The explicit totals
    // contract below makes its aggregation grain and source unambiguous to
    // consumers without pretending these legacy PBP totals are Summary data.
    boxScore,
    boxScoreTotals: {
      source: 'sportradar_play_by_play_structured_statistics',
      aggregation: 'scope_sum_of_non_rescinded_structured_statistics',
      gameScope: 'scout_eligible_games',
      gamesAppeared,
      minutes: round(minutes),
      coverageStatus: fieldGoalOutcomesComplete && fieldGoalValuesComplete && freeThrowOutcomesComplete && reboundsComplete
        ? 'complete'
        : 'partial',
      totals: { ...boxScore },
      officialSummaryReconciliation: officialSummaryReconciliationFromState(
        officialSummaryReconciliationState,
      ),
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

const REPLAY_CACHE_SCHEMA_VERSION = 1;

/**
 * Create a small, private on-disk replay cache for a large package build.
 *
 * A six-season package cannot safely hold every team-level combination and
 * WOWY aggregate in one V8 heap.  This cache sits strictly between the
 * validated raw archive and the final private Scout package: it contains the
 * transient reconstruction result for each eligible game, is hash-bound to
 * its own manifest, and is never a public/cPanel/Supabase artifact.  A later
 * shard pass can therefore read only the games for one franchise at a time.
 */
async function createReplayCacheWriter({ cacheDir, validationReportSha256, manifestSetSha256 }) {
  const stagingDirectory = await makeAtomicOutputDirectory(cacheDir);
  await fs.mkdir(path.join(stagingDirectory, 'records'), { recursive: true });
  const descriptors = [];

  return {
    async write(compact) {
      const gameId = String(compact.game?.providerGameId || compact.filename);
      const seasonStartYear = Number(compact.game?.seasonStartYear);
      const teamIds = [
        String(compact.game?.homeProviderTeamId ?? ''),
        String(compact.game?.awayProviderTeamId ?? ''),
      ];
      if (!Number.isInteger(seasonStartYear) || teamIds.some((teamId) => !teamId) || teamIds[0] === teamIds[1]) {
        throw new Error(`Cannot cache replay for invalid eligible game ${gameId}.`);
      }
      // The canonical source filename may contain characters unsuitable for a
      // portable path.  The descriptor retains that filename; the cache path
      // is an opaque, deterministic digest instead.
      const stem = sha256(`${compact.filename}~${gameId}`).slice(0, 24);
      const relativePath = `records/${seasonStartYear}-${stem}.json.gz`;
      const cachePath = path.join(stagingDirectory, ...relativePath.split('/'));
      const payload = Buffer.from(JSON.stringify({
        schemaVersion: REPLAY_CACHE_SCHEMA_VERSION,
        filename: compact.filename,
        record: compact.record,
      }), 'utf8');
      const compressed = gzipSync(payload, { level: 9 });
      await fs.writeFile(cachePath, compressed);
      const descriptor = {
        relativePath,
        filename: compact.filename,
        gameId,
        seasonStartYear,
        scheduledAt: compact.game?.scheduledAt ?? null,
        teamIds,
        gzipBytes: compressed.length,
        gzipSha256: sha256(compressed),
      };
      descriptors.push(descriptor);
      return descriptor;
    },
    async complete() {
      descriptors.sort((left, right) => (
        String(left.scheduledAt ?? '').localeCompare(String(right.scheduledAt ?? ''))
        || left.gameId.localeCompare(right.gameId)
      ));
      const manifest = {
        schemaVersion: REPLAY_CACHE_SCHEMA_VERSION,
        purpose: 'private_transient_replay_cache_for_bounded_memory_scout_shards',
        validationReportSha256,
        manifestSetSha256,
        replayReconstruction: OPTIONS.replayReconstruction,
        seasonStartYears: [...OPTIONS.seasonStartYears],
        records: descriptors,
      };
      await fs.writeFile(
        path.join(stagingDirectory, 'cache-manifest.json'),
        `${JSON.stringify(manifest)}\n`,
        'utf8',
      );
      await fs.rename(stagingDirectory, cacheDir);
      return manifest;
    },
  };
}

/**
 * A completed cache may be reused only when it binds exactly the same
 * validated archive scope and replay setting.  We do not treat a directory's
 * mere existence as proof of provenance, and every individual record is
 * re-hashed again when a team shard consumes it.
 */
async function readReusableReplayCacheManifest({ cacheDir, validationReportSha256, manifestSetSha256 }) {
  const raw = await fs.readFile(path.join(cacheDir, 'cache-manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  const expectedSeasons = JSON.stringify(OPTIONS.seasonStartYears);
  if (manifest?.schemaVersion !== REPLAY_CACHE_SCHEMA_VERSION
    || manifest?.purpose !== 'private_transient_replay_cache_for_bounded_memory_scout_shards'
    || manifest?.validationReportSha256 !== validationReportSha256
    || manifest?.manifestSetSha256 !== manifestSetSha256
    || manifest?.replayReconstruction !== OPTIONS.replayReconstruction
    || JSON.stringify(manifest?.seasonStartYears) !== expectedSeasons
    || !Array.isArray(manifest?.records)
    || !manifest.records.length) {
    throw new Error('Replay cache does not match the current validated archive scope and cannot be reused.');
  }
  const seenPaths = new Set();
  for (const entry of manifest.records) {
    if (!entry?.relativePath || seenPaths.has(entry.relativePath)
      || !entry?.gameId || !Number.isInteger(Number(entry.seasonStartYear))
      || !Array.isArray(entry?.teamIds) || entry.teamIds.length !== 2
      || !Number.isFinite(Number(entry.gzipBytes)) || !/^[a-f0-9]{64}$/i.test(String(entry.gzipSha256 ?? ''))) {
      throw new Error('Replay cache manifest contains an invalid record descriptor.');
    }
    seenPaths.add(entry.relativePath);
  }
  return manifest;
}

/**
 * Read and verify one replay-cache record immediately before a team shard
 * consumes it.  Hashing at this boundary ensures a partial/tampered cache is
 * never silently treated as equivalent to a verified reconstruction pass.
 */
async function readReplayCacheRecord(cacheDir, descriptor) {
  const cachePath = path.join(cacheDir, ...String(descriptor.relativePath).split('/'));
  const compressed = await fs.readFile(cachePath);
  if (compressed.length !== Number(descriptor.gzipBytes) || sha256(compressed) !== descriptor.gzipSha256) {
    throw new Error(`Replay-cache integrity check failed for ${descriptor.relativePath}.`);
  }
  const payload = JSON.parse(gunzipSync(compressed).toString('utf8'));
  if (payload?.schemaVersion !== REPLAY_CACHE_SCHEMA_VERSION || payload?.filename !== descriptor.filename) {
    throw new Error(`Replay-cache descriptor mismatch for ${descriptor.relativePath}.`);
  }
  const compact = compactRecord(payload.record, payload.filename);
  const gameId = String(compact.game?.providerGameId || compact.filename);
  if (gameId !== descriptor.gameId
    || Number(compact.game?.seasonStartYear) !== Number(descriptor.seasonStartYear)) {
    throw new Error(`Replay-cache game identity mismatch for ${descriptor.relativePath}.`);
  }
  return compact;
}

async function loadRecords(sourceFileIntegrityBySeason, sourceAccessLevelsBySeason) {
  const records = [];
  const seenGameIds = new Set();
  for (const seasonPath of SEASON_PATHS) {
    const expectedIntegrity = sourceFileIntegrityBySeason?.[seasonPath.seasonStartYear];
    const expectedAccessLevel = sourceAccessLevelsBySeason?.[seasonPath.seasonStartYear];
    if (!expectedIntegrity?.expectedFiles) {
      throw new Error(`No validated source game-file inventory is available for season ${seasonPath.seasonStartYear}.`);
    }
    if (expectedAccessLevel !== 'trial') {
      throw new Error(`No valid trial source access level is available for season ${seasonPath.seasonStartYear}.`);
    }
    const entries = (await fs.readdir(seasonPath.gamesDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length !== expectedIntegrity.expectedFileCount) {
      throw new Error(`Source game-file count does not match the validated checkpoint for season ${seasonPath.seasonStartYear}.`);
    }
    const verifiedDescriptors = [];
    for (const entry of entries) {
      const filePath = path.join(seasonPath.gamesDirectory, entry.name);
      const expected = expectedIntegrity.expectedFiles.get(entry.name);
      if (!expected) {
        throw new Error(`Source archive contains an unvalidated game file for season ${seasonPath.seasonStartYear}: games/${entry.name}.`);
      }
      const compressed = await fs.readFile(filePath);
      const uncompressed = gunzipSync(compressed);
      const record = JSON.parse(uncompressed.toString('utf8'));
      if (record?.source?.accessLevel !== expectedAccessLevel) {
        throw new Error(`Source game-file access level does not match the validated manifest for season ${seasonPath.seasonStartYear}: ${expected.relativePath}.`);
      }
      const recordSeasonStartYear = Number(record.game?.seasonStartYear ?? seasonPath.seasonStartYear);
      if (recordSeasonStartYear !== seasonPath.seasonStartYear) {
        throw new Error(`Archive ${seasonPath.seasonStartYear}/${entry.name} declares season ${recordSeasonStartYear}.`);
      }
      const gameId = String(record.game?.providerGameId ?? '').trim();
      if (gameId !== expected.gameId) {
        throw new Error(`Source game file identifier does not match the validated checkpoint for season ${seasonPath.seasonStartYear}: ${expected.relativePath}.`);
      }
      if (gameId && seenGameIds.has(gameId)) {
        throw new Error(`Duplicate provider game ${gameId} appears across selected season archives.`);
      }
      if (gameId) seenGameIds.add(gameId);
      try {
        verifiedDescriptors.push(verifiedSourceFileDescriptor({
          expected,
          filename: entry.name,
          compressed,
          uncompressed,
          gameId,
        }));
      } catch (error) {
        throw new Error(`Source game file does not match the validated checkpoint for season ${seasonPath.seasonStartYear}: ${String(error?.message ?? error)}`);
      }
      records.push(compactRecord({
        ...record,
        game: {
          ...record.game,
          seasonStartYear: recordSeasonStartYear,
          seasonEndYear: Number(record.game?.seasonEndYear ?? recordSeasonStartYear + 1),
        },
      }, `${seasonPath.seasonStartYear}/${entry.name}`));
    }
    for (const filename of expectedIntegrity.expectedFiles.keys()) {
      if (!entries.some((entry) => entry.name === filename)) {
        throw new Error(`Source archive is missing a validated game file for season ${seasonPath.seasonStartYear}: games/${filename}.`);
      }
    }
    verifiedDescriptors.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (sha256(JSON.stringify(verifiedDescriptors)) !== expectedIntegrity.fileIntegritySha256) {
      throw new Error(`Source game-file inventory does not match the validated checkpoint for season ${seasonPath.seasonStartYear}.`);
    }
  }
  records.sort((left, right) => (
    String(left.game.scheduledAt ?? '').localeCompare(String(right.game.scheduledAt ?? ''))
      || String(left.game.providerGameId ?? left.filename).localeCompare(String(right.game.providerGameId ?? right.filename))
  ));
  return records;
}

/**
 * Verify and visit raw archive files without retaining their decoded payloads.
 *
 * The historical in-memory reader remains useful for the small calibration
 * path. Large replay-cache packages use this visitor instead: every source
 * file still receives the same manifest, compressed-byte, uncompressed-byte,
 * normalized-record, season, access-level, and duplicate-game checks, but
 * its decoded JSON is released immediately after the callback finishes.
 */
async function streamVerifiedRecords(sourceFileIntegrityBySeason, sourceAccessLevelsBySeason, onRecord) {
  const seenGameIds = new Set();
  const discoveredBySeason = Object.fromEntries(OPTIONS.seasonStartYears.map((year) => [year, 0]));
  let discovered = 0;
  for (const seasonPath of SEASON_PATHS) {
    const expectedIntegrity = sourceFileIntegrityBySeason?.[seasonPath.seasonStartYear];
    const expectedAccessLevel = sourceAccessLevelsBySeason?.[seasonPath.seasonStartYear];
    if (!expectedIntegrity?.expectedFiles) {
      throw new Error(`No validated source game-file inventory is available for season ${seasonPath.seasonStartYear}.`);
    }
    if (expectedAccessLevel !== 'trial') {
      throw new Error(`No valid trial source access level is available for season ${seasonPath.seasonStartYear}.`);
    }
    const entries = (await fs.readdir(seasonPath.gamesDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length !== expectedIntegrity.expectedFileCount) {
      throw new Error(`Source game-file count does not match the validated checkpoint for season ${seasonPath.seasonStartYear}.`);
    }
    const verifiedDescriptors = [];
    for (const entry of entries) {
      const filePath = path.join(seasonPath.gamesDirectory, entry.name);
      const expected = expectedIntegrity.expectedFiles.get(entry.name);
      if (!expected) {
        throw new Error(`Source archive contains an unvalidated game file for season ${seasonPath.seasonStartYear}: games/${entry.name}.`);
      }
      const compressed = await fs.readFile(filePath);
      const uncompressed = gunzipSync(compressed);
      const record = JSON.parse(uncompressed.toString('utf8'));
      if (record?.source?.accessLevel !== expectedAccessLevel) {
        throw new Error(`Source game-file access level does not match the validated manifest for season ${seasonPath.seasonStartYear}: ${expected.relativePath}.`);
      }
      const recordSeasonStartYear = Number(record.game?.seasonStartYear ?? seasonPath.seasonStartYear);
      if (recordSeasonStartYear !== seasonPath.seasonStartYear) {
        throw new Error(`Archive ${seasonPath.seasonStartYear}/${entry.name} declares season ${recordSeasonStartYear}.`);
      }
      const gameId = String(record.game?.providerGameId ?? '').trim();
      if (gameId !== expected.gameId) {
        throw new Error(`Source game file identifier does not match the validated checkpoint for season ${seasonPath.seasonStartYear}: ${expected.relativePath}.`);
      }
      if (gameId && seenGameIds.has(gameId)) {
        throw new Error(`Duplicate provider game ${gameId} appears across selected season archives.`);
      }
      if (gameId) seenGameIds.add(gameId);
      try {
        verifiedDescriptors.push(verifiedSourceFileDescriptor({
          expected,
          filename: entry.name,
          compressed,
          uncompressed,
          gameId,
        }));
      } catch (error) {
        throw new Error(`Source game file does not match the validated checkpoint for season ${seasonPath.seasonStartYear}: ${String(error?.message ?? error)}`);
      }
      await onRecord(compactRecord({
        ...record,
        game: {
          ...record.game,
          seasonStartYear: recordSeasonStartYear,
          seasonEndYear: Number(record.game?.seasonEndYear ?? recordSeasonStartYear + 1),
        },
      }, `${seasonPath.seasonStartYear}/${entry.name}`));
      discovered += 1;
      discoveredBySeason[seasonPath.seasonStartYear] += 1;
      if (discovered % 50 === 0) requestGarbageCollection();
    }
    for (const filename of expectedIntegrity.expectedFiles.keys()) {
      if (!entries.some((entry) => entry.name === filename)) {
        throw new Error(`Source archive is missing a validated game file for season ${seasonPath.seasonStartYear}: games/${filename}.`);
      }
    }
    verifiedDescriptors.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (sha256(JSON.stringify(verifiedDescriptors)) !== expectedIntegrity.fileIntegritySha256) {
      throw new Error(`Source game-file inventory does not match the validated checkpoint for season ${seasonPath.seasonStartYear}.`);
    }
  }
  return { discovered, discoveredBySeason };
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

function rollingGameMembershipsFromCacheEntries(entries) {
  const chronological = [...entries]
    .sort((left, right) => (
      String(left.scheduledAt ?? '').localeCompare(String(right.scheduledAt ?? ''))
      || String(left.gameId).localeCompare(String(right.gameId))
    ))
    .map((entry) => ({
      filename: entry.filename,
      game: {
        providerGameId: entry.gameId,
        homeProviderTeamId: entry.teamIds?.[0],
        awayProviderTeamId: entry.teamIds?.[1],
      },
    }));
  return rollingGameMemberships(chronological);
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

/**
 * Keep every mutable, team-shard-specific aggregate together. The established
 * in-memory derivation remains untouched as a regression baseline; the new
 * bounded-memory path creates and releases one state per franchise. Its
 * aggregation function mirrors the established possession rules rather than
 * introducing a reduced metric set for large packages.
 */
function createAggregateState() {
  return {
    comboMap: new Map(),
    comboMinutes: new Map(),
    playerOnOffMap: new Map(),
    playerOnMinutes: new Map(),
    playerScopeMinutes: new Map(),
    teamScopeMinutes: new Map(),
    wowyMap: new Map(),
    teamMap: new Map(),
    playerEventMap: new Map(),
    playerOfficialSummaryMap: new Map(),
    lineupStartCounts: new Map(),
    lineupCloseCounts: new Map(),
    playerStartCounts: new Map(),
    playerCloseCounts: new Map(),
  };
}

function rememberAggregateNames(record, names) {
  for (const team of record.teams ?? []) names.teamNames.set(team.id, teamName(team) || team.id);
  const players = new Map((record.players ?? []).map((player) => [player.id, player]));
  for (const player of record.players ?? []) names.playerNames.set(player.id, playerName(player.id, players));
}

function incrementAggregateCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function ensureAggregateCombo(state, names, teamId, ids) {
  const key = comboKey(teamId, ids);
  if (!state.comboMap.has(key)) {
    state.comboMap.set(key, createComboEntry(teamId, names.teamNames.get(teamId) || teamId, ids));
  }
  return state.comboMap.get(key);
}

function aggregatePlayerEventLine(state, teamId, playerId) {
  const key = `${teamId}~${playerId}`;
  if (!state.playerEventMap.has(key)) state.playerEventMap.set(key, createDirectPlayerEventLine());
  return state.playerEventMap.get(key);
}

function aggregatePlayerOfficialSummaryState(state, teamId, playerId) {
  const key = `${teamId}~${playerId}`;
  if (!state.playerOfficialSummaryMap.has(key)) {
    state.playerOfficialSummaryMap.set(key, createOfficialSummaryReconciliationState());
  }
  return state.playerOfficialSummaryMap.get(key);
}

function accumulateDirectPlayerEventsIntoState(record, validTeamIds, state) {
  const seenEventIds = new Set();
  const gameLines = new Map();
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
      const key = `${teamId}~${playerId}`;
      if (!gameLines.has(key)) gameLines.set(key, createDirectPlayerEventLine());
      addDirectPlayerStatistic(gameLines.get(key), statistic, eventType);
      addDirectPlayerStatistic(aggregatePlayerEventLine(state, teamId, playerId), statistic, eventType);
    }
  }
  return gameLines;
}

/**
 * Aggregate one already-eligible replayed game into a state.  `targetTeamId`
 * narrows only the destination shard; it deliberately still requires both
 * verified five-player lineups on a possession, exactly as the original
 * all-team derivation does.  This guards against a one-team build quietly
 * gaining evidence that an all-team build would exclude.
 */
function aggregateEligibleRecordIntoState({ compact, state, names, rollingByTeam, targetTeamId = null }) {
  const { record, game, maps, filename } = compact;
  const gameId = String(game.providerGameId || filename);
  const recordSeasonStartYear = Number(game.seasonStartYear);
  const homeTeamId = String(game.homeProviderTeamId ?? '');
  const awayTeamId = String(game.awayProviderTeamId ?? '');
  const allTeamIds = [homeTeamId, awayTeamId];
  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) return false;
  if (targetTeamId !== null && !allTeamIds.includes(targetTeamId)) return false;
  const selectedTeamIds = targetTeamId === null ? allTeamIds : [targetTeamId];
  const validTeamIds = new Set(selectedTeamIds);

  const directPlayerEventsForGame = accumulateDirectPlayerEventsIntoState(record, validTeamIds, state);
  const appearedPlayersByTeam = new Map(selectedTeamIds.map((teamId) => [teamId, new Set()]));
  for (const lineup of record.lineups ?? []) {
    const ids = exactLineup(lineup.id, maps.lineups);
    if (!ids || !appearedPlayersByTeam.has(lineup.providerTeamId)) continue;
    ids.forEach((id) => appearedPlayersByTeam.get(lineup.providerTeamId).add(id));
  }
  const summaryPlayersByKey = new Map((record.players ?? []).map((player) => [
    `${player.providerTeamId}~${player.id}`,
    player,
  ]));
  for (const [teamId, appeared] of appearedPlayersByTeam.entries()) {
    for (const playerId of appeared) {
      const reconciliation = aggregatePlayerOfficialSummaryState(state, teamId, playerId);
      reconciliation.gamesExpected += 1;
      const summaryPlayer = summaryPlayersByKey.get(`${teamId}~${playerId}`);
      if (summaryPlayer?.officialBoxScore?.availableFields?.length > 0) {
        reconciliation.gamesWithAnySummaryTotals += 1;
      }
      const officialTotals = officialSummaryBoxScoreForComparison(summaryPlayer);
      if (!officialTotals) continue;
      reconciliation.gamesWithCompleteSummaryTotals += 1;
      const directTotals = directBoxScoreForOfficialComparison(
        directPlayerEventsForGame.get(`${teamId}~${playerId}`) ?? createDirectPlayerEventLine(),
      );
      if (!sameOfficialPlayerBoxScore(directTotals, officialTotals)) continue;
      reconciliation.gamesReconciledWithStructuredPbp += 1;
      addOfficialPlayerBoxScore(reconciliation.reconciledTotals, officialTotals);
    }
  }

  const teamStintMinutes = new Map(selectedTeamIds.map((teamId) => [teamId, 0]));
  for (const stint of record.stints ?? []) {
    const durationMinutes = Math.max(0, finite(stint.durationMs)) / 60_000;
    const homeIds = exactLineup(stint.homeLineupId, maps.lineups);
    const awayIds = exactLineup(stint.awayLineupId, maps.lineups);
    if (!homeIds || !awayIds || durationMinutes <= 0) continue;
    const lineupsByTeam = new Map([[homeTeamId, homeIds], [awayTeamId, awayIds]]);
    for (const teamId of selectedTeamIds) {
      const ids = lineupsByTeam.get(teamId);
      teamStintMinutes.set(teamId, teamStintMinutes.get(teamId) + durationMinutes);
      for (const combination of combosForLineup(ids)) {
        const key = comboKey(teamId, combination);
        state.comboMinutes.set(key, (state.comboMinutes.get(key) ?? 0) + durationMinutes);
      }
      for (const playerId of ids) {
        const key = `${teamId}~${playerId}`;
        state.playerOnMinutes.set(key, (state.playerOnMinutes.get(key) ?? 0) + durationMinutes);
      }
    }
  }
  for (const [teamId, minutes] of teamStintMinutes.entries()) {
    state.teamScopeMinutes.set(teamId, (state.teamScopeMinutes.get(teamId) ?? 0) + minutes);
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
  for (const [teamId, appeared] of appearedPlayersByTeam.entries()) {
    for (const playerId of appeared) {
      const key = `${teamId}~${playerId}`;
      state.playerScopeMinutes.set(key, (state.playerScopeMinutes.get(key) ?? 0) + (teamStintMinutes.get(teamId) ?? 0));
    }
  }

  const possessionObservedLineupKeysByTeam = new Map(selectedTeamIds.map((teamId) => [teamId, new Set()]));
  const primaryPhase = String(game.primaryPhase ?? '').trim().toLowerCase();
  for (const possession of record.possessions ?? []) {
    const homePlayerIds = exactLineup(possession.homeLineupId, maps.lineups);
    const awayPlayerIds = exactLineup(possession.awayLineupId, maps.lineups);
    if (!homePlayerIds || !awayPlayerIds) continue;
    const offenseTeamId = String(possession.offenseProviderTeamId ?? '');
    const defenseTeamId = String(possession.defenseProviderTeamId ?? '');
    if (!allTeamIds.includes(offenseTeamId) || !allTeamIds.includes(defenseTeamId) || offenseTeamId === defenseTeamId) continue;
    const offensePoints = finite(possession.offensePoints);
    const defensePoints = finite(possession.defensePoints);
    const eventStats = eventStatsForPossession(record, possession);
    const possessionTacticalExtras = {
      secondChancePossessions: eventStats.tactics?.hasStructuredOffensiveRebound ? 1 : 0,
      secondChancePoints: eventStats.tactics?.hasStructuredOffensiveRebound ? offensePoints : 0,
      pointsOffTurnoverPossessions: eventStats.tactics?.startsAfterStructuredOpponentTurnover ? 1 : 0,
      pointsOffTurnovers: eventStats.tactics?.startsAfterStructuredOpponentTurnover ? offensePoints : 0,
    };
    const sides = [
      { teamId: homeTeamId, side: 'home', ids: homePlayerIds, opponentIds: awayPlayerIds },
      { teamId: awayTeamId, side: 'away', ids: awayPlayerIds, opponentIds: homePlayerIds },
    ];
    for (const side of sides) {
      if (!validTeamIds.has(side.teamId)) continue;
      possessionObservedLineupKeysByTeam.get(side.teamId).add(comboKey(side.teamId, side.ids));
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
      const contexts = [...possessionContexts(possession, side.side, {
        phase: primaryPhase,
        rollingWindowMemberships: membershipsFor(side.teamId, gameId, rollingByTeam),
      }), `season:${recordSeasonStartYear}`];
      if (!state.teamMap.has(side.teamId)) {
        state.teamMap.set(side.teamId, {
          teamId: side.teamId,
          team: names.teamNames.get(side.teamId) || side.teamId,
          contexts: new Map(),
        });
      }
      aggregateInto(state.teamMap.get(side.teamId).contexts, contexts, row);
      for (const ids of combosForLineup(side.ids)) {
        const entry = ensureAggregateCombo(state, names, side.teamId, ids);
        aggregateInto(entry.contexts, contexts, row);
        if (ids.length === 5) addOpponentExposure(entry, side.opponentIds, side.side);
      }
      const appeared = [...(appearedPlayersByTeam.get(side.teamId) ?? [])].sort((left, right) => left.localeCompare(right));
      for (const playerId of appeared) {
        const key = `${side.teamId}~${playerId}`;
        if (!state.playerOnOffMap.has(key)) {
          state.playerOnOffMap.set(key, {
            teamId: side.teamId,
            team: names.teamNames.get(side.teamId) || side.teamId,
            playerId,
            contexts: { on: new Map(), off: new Map() },
          });
        }
        aggregateInto(state.playerOnOffMap.get(key).contexts[side.ids.includes(playerId) ? 'on' : 'off'], contexts, row);
      }
      for (let left = 0; left < appeared.length; left += 1) {
        for (let right = left + 1; right < appeared.length; right += 1) {
          const playerA = appeared[left];
          const playerB = appeared[right];
          const key = wowyKey(side.teamId, playerA, playerB);
          if (!state.wowyMap.has(key)) {
            state.wowyMap.set(key, {
              teamId: side.teamId,
              team: names.teamNames.get(side.teamId) || side.teamId,
              playerA,
              playerB,
              cells: new Map(),
            });
          }
          const entry = state.wowyMap.get(key);
          const cell = wowyCell(side.ids, playerA, playerB);
          if (!entry.cells.has(cell)) entry.cells.set(cell, new Map());
          aggregateInto(entry.cells.get(cell), contexts, row);
        }
      }
    }
  }
  if (exactStints.length) {
    const lineupsByTeam = new Map([
      [homeTeamId, exactStints.map((stint) => stint.homeIds)],
      [awayTeamId, exactStints.map((stint) => stint.awayIds)],
    ]);
    for (const teamId of selectedTeamIds) {
      const { starterIds, closerIds } = selectPossessionObservedBoundaryLineups({
        teamId,
        exactLineups: lineupsByTeam.get(teamId),
        observedLineupKeys: possessionObservedLineupKeysByTeam.get(teamId),
      });
      if (starterIds) {
        incrementAggregateCount(state.lineupStartCounts, comboKey(teamId, starterIds));
        for (const playerId of starterIds) incrementAggregateCount(state.playerStartCounts, `${teamId}~${playerId}`);
      }
      if (closerIds) {
        incrementAggregateCount(state.lineupCloseCounts, comboKey(teamId, closerIds));
        for (const playerId of closerIds) incrementAggregateCount(state.playerCloseCounts, `${teamId}~${playerId}`);
      }
    }
  }
  return true;
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

/**
 * Build state-aware row serializers once the global RAPM fit is available.
 * They receive the aggregate state explicitly so an identical serializer can
 * write either the legacy all-team state or one bounded-memory team state.
 */
function createScoutRowBuilders({ netByPlayer, netRapm, playerNames }) {
  function comboRow(entry, state) {
    const contexts = outputContexts(entry.contexts);
    const key = comboKey(entry.teamId, entry.playerIds);
    const minutes = state.comboMinutes.get(key) ?? 0;
    const teamAggregate = state.teamMap.get(entry.teamId)?.contexts?.get('all');
    const teamTotalPossessions = finite(teamAggregate?.offensivePossessions) + finite(teamAggregate?.defensivePossessions);
    const teamMinutes = state.teamScopeMinutes.get(entry.teamId) ?? 0;
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
        entry.size === 5 ? 'exact_five_player_possession_start_lineup' : 'shared_floor_co_presence_combination',
      ),
      continuity: {
        gamesUsed: finite(contexts.all?.games),
        teamPossessionShare: ratioOrNull(finite(contexts.all?.totalPossessions), teamTotalPossessions, 4),
        teamMinuteShare: ratioOrNull(minutes, teamMinutes, 4),
        exactLineupStartingGames: entry.size === 5 ? (state.lineupStartCounts.get(key) ?? 0) : null,
        exactLineupClosingGames: entry.size === 5 ? (state.lineupCloseCounts.get(key) ?? 0) : null,
        exactLineupStartRate: entry.size === 5 ? ratioOrNull(state.lineupStartCounts.get(key) ?? 0, finite(contexts.all?.games), 4) : null,
        exactLineupCloseRate: entry.size === 5 ? ratioOrNull(state.lineupCloseCounts.get(key) ?? 0, finite(contexts.all?.games), 4) : null,
        caveat: entry.size === 5
          ? 'Starting and closing counts use the first and final verified exact-lineup stint observed at a possession start in each eligible game; zero-possession dead-ball lineups are excluded.'
          : 'Starting and closing counts are meaningful only for exact five-player lineups; this row is a co-presence combination.',
      },
      contexts,
      ...(projection ? { projection } : {}),
    };
  }

  function playerOnOffRow(entry, state) {
    const on = outputContexts(entry.contexts.on);
    const off = outputContexts(entry.contexts.off);
    const key = `${entry.teamId}~${entry.playerId}`;
    const onMinutes = state.playerOnMinutes.get(key) ?? 0;
    const offMinutes = Math.max(0, (state.playerScopeMinutes.get(key) ?? 0) - onMinutes);
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

  return { comboRow, playerOnOffRow, wowyRow };
}

function teamRowFromAggregateState(teamId, state) {
  const entry = state.teamMap.get(teamId);
  if (!entry) return null;
  const contexts = outputContexts(entry.contexts);
  const minutes = state.teamScopeMinutes.get(entry.teamId) ?? 0;
  return {
    teamId: entry.teamId,
    team: entry.team,
    minutes: round(minutes),
    exposure: exposureSummary(contexts, minutes, 'verified exact-lineup stint minutes and possession contexts'),
    contexts,
  };
}

function sortedAggregateKeysForTeam(map, teamId, compareEntries) {
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

/**
 * Stream one fully aggregated team state to its inspectable JSON shard and
 * transport gzip.  Deleting entries only after they are serialized keeps the
 * write bounded even for franchises with unusually many historic rotations.
 */
async function writeTeamShardFromState({ team, stagingDirectory, state, playerNames, rowBuilders }) {
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

  await writer.write(`{"schemaVersion":${OUTPUT_SCHEMA_VERSION},"metricsVersion":${JSON.stringify(SCOUT_METRICS_VERSION)},"seasonStartYear":${OPTIONS.seasonStartYear},"seasonEndYear":${OPTIONS.latestSeasonStartYear + 1},"seasonStartYears":${JSON.stringify(OPTIONS.seasonStartYears)},"latestSeasonStartYear":${OPTIONS.latestSeasonStartYear},"team":${JSON.stringify(team)},"lineupsAndCombinations":[`);
  const combinationKeys = sortedAggregateKeysForTeam(state.comboMap, team.teamId, (left, right) => (
    left.size - right.size || left.playerIds.join('|').localeCompare(right.playerIds.join('|'))
  ));
  for (const key of combinationKeys) {
    const entry = state.comboMap.get(key);
    await appendArrayItem(writer, combinationState, rowBuilders.comboRow(entry, state));
    state.comboMap.delete(key);
    state.comboMinutes.delete(key);
    state.lineupStartCounts.delete(key);
    state.lineupCloseCounts.delete(key);
  }

  await writer.write('],"playerOnOff":[');
  const onOffRowsForTeam = [];
  const onOffKeys = sortedAggregateKeysForTeam(state.playerOnOffMap, team.teamId, (left, right) => comparePlayer(left.playerId, right.playerId));
  for (const key of onOffKeys) {
    const entry = state.playerOnOffMap.get(key);
    const row = rowBuilders.playerOnOffRow(entry, state);
    onOffRowsForTeam.push({ key, row });
    await appendArrayItem(writer, onOffState, row);
    state.playerOnOffMap.delete(key);
    state.playerOnMinutes.delete(key);
    state.playerScopeMinutes.delete(key);
  }

  await writer.write('],"playerProfiles":[');
  for (const { key, row } of onOffRowsForTeam) {
    const profile = playerProfileFromEvents({
      teamId: row.teamId,
      team: row.team,
      playerId: row.playerId,
      player: row.player,
      events: state.playerEventMap.get(key) ?? createDirectPlayerEventLine(),
      onOff: row,
      starterGames: state.playerStartCounts.get(key) ?? 0,
      closerGames: state.playerCloseCounts.get(key) ?? 0,
      officialSummaryReconciliationState: state.playerOfficialSummaryMap.get(key),
    });
    await appendArrayItem(writer, profileState, profile);
    state.playerEventMap.delete(key);
    state.playerStartCounts.delete(key);
    state.playerCloseCounts.delete(key);
    state.playerOfficialSummaryMap.delete(key);
  }
  for (const key of [...state.playerEventMap.keys()]) {
    if (key.startsWith(`${team.teamId}~`)) state.playerEventMap.delete(key);
  }
  for (const key of [...state.playerOfficialSummaryMap.keys()]) {
    if (key.startsWith(`${team.teamId}~`)) state.playerOfficialSummaryMap.delete(key);
  }

  await writer.write('],"wowy":[');
  const wowyKeys = sortedAggregateKeysForTeam(state.wowyMap, team.teamId, (left, right) => (
    comparePlayer(left.playerA, right.playerA) || comparePlayer(left.playerB, right.playerB)
  ));
  for (const key of wowyKeys) {
    const entry = state.wowyMap.get(key);
    await appendArrayItem(writer, wowyState, rowBuilders.wowyRow(entry));
    state.wowyMap.delete(key);
  }
  await writer.write(']}\n');
  const json = await writer.close();
  const gzip = await gzipFile(shardPath, shardGzipPath);

  state.teamMap.delete(team.teamId);
  state.teamScopeMinutes.delete(team.teamId);
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
    totalEffectivePairedPossessions: model.totalEffectivePairedPossessions,
    totalOffensivePossessions: model.totalOffensivePossessions,
    totalEffectiveOffensivePossessions: model.totalEffectiveOffensivePossessions,
    priorSeasonWeight: model.priorSeasonWeight ?? 1,
    seasonWeights: model.seasonWeights ?? null,
    includedSeasonStartYears: model.includedSeasonStartYears ?? null,
    chronologicalCalibration: model.chronologicalCalibration ?? null,
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
    // Net RAPM intentionally has no separate offense/defense ablation test.
    // The O/D model receives this only after its fixed-lambda held-out game
    // calibration completes below. Keep it at the model level so every player
    // row shares one auditable validation result rather than duplicating it.
    calibration: model.calibration ?? null,
    players,
  };
}

/**
 * Produce the small empirical RAPM-quality report without building the much
 * larger Scout package.  This intentionally does *not* call the normal
 * package derivation below: on/off, WOWY, role, tactical, and combination
 * aggregates are all irrelevant to a held-out offense/defense calibration.
 *
 * Keeping this path narrow has two important benefits:
 *
 * 1. It makes repeatable model checks practical on the full source archive.
 * 2. It prevents a quality gate from accidentally consuming the storage and
 *    memory budget reserved for the immutable production Scout package.
 *
 * It still applies the exact same phase, official-game, replay, lineup, and
 * possession-validity rules as the full derivation, so its input remains
 * directly comparable to the package it is meant to certify.
 */
async function deriveOffenseDefenseCalibrationOnly({
  manifestRaw,
  validationRaw,
  loadedRecords,
  sourceAccessLevelsBySeason,
  sourceFileIntegrityBySeason,
}) {
  const validation = JSON.parse(validationRaw);
  // Check the report at the level where the checkpoint validator actually
  // publishes pass/fail.  A season entry is descriptive coverage/provenance,
  // not an independently scored pass/fail object, so treating
  // `validationSeason.passed` as authoritative would produce a false negative.
  const {
    sourceArchiveValidationPassed,
    sourceArchiveValidationReportPassed,
    sourceArchiveValidationSeasonPresent,
  } = sourceArchiveValidationStatus(validation, OPTIONS.seasonStartYear);
  const sourceEligibleCount = loadedRecords.filter(({ record }) => record.analytics?.eligibleForPublication === true).length;
  let phaseRecords = loadedRecords
    .filter(({ game }) => OPTIONS.includedPhases.includes(String(game.primaryPhase ?? '').trim().toLowerCase()));
  let officialRecords = phaseRecords.filter(isOfficialFranchiseGame);
  let replayedRecords = officialRecords.map(transientReplay);
  let eligibleRecords = replayedRecords.filter(({ record }) => record.analytics?.eligibleForPublication === true);
  const rapmGroups = new Map();
  let exactLineupPossessions = 0;

  for (const { record, game, maps, filename } of eligibleRecords) {
    const gameId = String(game.providerGameId || filename);
    const homeTeamId = String(game.homeProviderTeamId ?? '');
    const awayTeamId = String(game.awayProviderTeamId ?? '');
    if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) continue;
    for (const possession of record.possessions ?? []) {
      const homePlayerIds = exactLineup(possession.homeLineupId, maps.lineups);
      const awayPlayerIds = exactLineup(possession.awayLineupId, maps.lineups);
      if (!homePlayerIds || !awayPlayerIds) continue;
      const offenseTeamId = String(possession.offenseProviderTeamId ?? '');
      const defenseTeamId = String(possession.defenseProviderTeamId ?? '');
      if (![homeTeamId, awayTeamId].includes(offenseTeamId)
        || ![homeTeamId, awayTeamId].includes(defenseTeamId)
        || offenseTeamId === defenseTeamId) continue;

      exactLineupPossessions += 1;
      // Match the full package's game + exact-ten-player grouping so each
      // regression row aggregates identical source possessions in both paths.
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
      const offensePoints = finite(possession.offensePoints);
      const defensePoints = finite(possession.defensePoints);
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
    }
  }

  // The solver only needs the compact grouped rows.  Release decoded archive
  // records before the six (one full + five held-out) ridge fits begin.
  loadedRecords.length = 0;
  phaseRecords.length = 0;
  officialRecords.length = 0;
  replayedRecords.length = 0;
  eligibleRecords.length = 0;
  phaseRecords = null;
  officialRecords = null;
  replayedRecords = null;
  eligibleRecords = null;
  requestGarbageCollection();

  const rapmInput = [...rapmGroups.values()];
  const seasonPhase = `${OPTIONS.includedPhases.join('_')}_official_franchise_${NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION}_possession_start_lineups`;
  const offenseDefenseRapm = fitWeightedRidgeOffenseDefenseRapm(rapmInput, {
    lambdaCandidates: OPTIONS.lambdaCandidates,
    lambdaFoldCount: OPTIONS.lambdaFoldCount,
    seasonEndYear: OPTIONS.seasonStartYear + 1,
    seasonPhase,
    lambda: OPTIONS.offenseDefenseRapmLambda,
  });
  const calibration = evaluateOffenseDefenseRapmCalibration(rapmInput, {
    lambda: offenseDefenseRapm.lambda,
    foldCount: OPTIONS.lambdaFoldCount,
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'offline_calibration_only',
    seasonStartYear: OPTIONS.seasonStartYear,
    seasonEndYear: OPTIONS.seasonStartYear + 1,
    source: {
      manifestSha256: sha256(manifestRaw),
      sourceValidationReportSha256: sha256(validationRaw),
      sourceAccessLevelsBySeason,
      sourceGameFileIntegrityBySeason: sourceFileIntegrityProvenance(sourceFileIntegrityBySeason),
      sourceArchiveValidationPassed,
      sourceArchiveValidationReportPassed,
      sourceArchiveValidationSeasonPresent,
      sourceEligibleArchives: sourceEligibleCount,
      eligibleArchives: calibration.gameCount,
      exactLineupPossessions,
      rapmGroupedObservations: rapmInput.length,
    },
    offenseDefenseRapm: {
      modelVersion: offenseDefenseRapm.modelVersion,
      lambda: offenseDefenseRapm.lambda,
      lambdaSelection: offenseDefenseRapm.lambdaSelection,
      observationCount: offenseDefenseRapm.observationCount,
      directionalObservationCount: offenseDefenseRapm.directionalObservationCount,
      gameCount: offenseDefenseRapm.gameCount,
      totalOffensivePossessions: offenseDefenseRapm.totalOffensivePossessions,
      baselineOffensiveRatingPer100: offenseDefenseRapm.baselineOffensiveRatingPer100,
      homeCourtEffectPer100: offenseDefenseRapm.homeCourtEffectPer100,
      homeCourtNetRatingEffectPer100: offenseDefenseRapm.homeCourtNetRatingEffectPer100,
      calibration,
    },
  };
  await fs.mkdir(path.dirname(OPTIONS.calibrationReport), { recursive: true });
  await fs.writeFile(OPTIONS.calibrationReport, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    output: OPTIONS.calibrationReport,
    mode: report.mode,
    status: calibration.status,
    gameCount: calibration.gameCount,
    heldOutPossessions: calibration.heldOutPossessions,
    fullModelMseImprovementVsVenueBaseline: calibration.fullModelMseImprovementVsVenueBaseline,
  }, null, 2)}\n`);
}

async function derive() {
  // Calibration-only mode reads the same validated raw archive but emits one
  // small report instead of materializing another multi-gigabyte Scout package.
  // It is useful for a fast model-quality rerun and refuses to overwrite an
  // existing report just like the normal atomic package writer.
  if (OPTIONS.calibrationOnly) await assertOutputFileAbsent(OPTIONS.calibrationReport);
  else await assertOutputDirectoryAbsent(OPTIONS.outputDir);
  const [manifestEntries, validationRaw] = await Promise.all([
    Promise.all(SEASON_PATHS.map(async (seasonPath) => ({
      seasonStartYear: seasonPath.seasonStartYear,
      raw: await fs.readFile(seasonPath.manifestPath, 'utf8'),
    }))),
    fs.readFile(VALIDATION_PATH, 'utf8'),
  ]);
  const sourceAccessLevelsBySeason = requireTrialSourceAccessLevels(
    manifestEntries,
    OPTIONS.seasonStartYears,
  );
  const validation = JSON.parse(validationRaw);
  const { sourceValidation, manifestSha256BySeason } = requireSourceValidationManifestHashes(
    validation,
    manifestEntries,
    OPTIONS.seasonStartYears,
  );
  const sourceFileIntegrityBySeason = requireSourceValidationFileHashes(
    validation,
    OPTIONS.seasonStartYears,
  );
  const sourceSummaryTeamReconciliationBySeason = requireSourceSummaryTeamReconciliation(
    validation,
    OPTIONS.seasonStartYears,
  );
  const manifestSetSha256 = sha256(JSON.stringify(manifestSha256BySeason));
  const validationSeasons = new Map(OPTIONS.seasonStartYears.map((seasonStartYear) => [
    seasonStartYear,
    validation.seasons?.find((season) => season.seasonStartYear === seasonStartYear) ?? null,
  ]));
  const partitionedTeamShards = OPTIONS.teamShardMode === 'replay_cache';
  // The legacy/calibration paths intentionally preserve their existing
  // in-memory reader. The replay-cache path below streams the same verified
  // source records instead, so a large archive never needs raw and replayed
  // versions of every game resident at once.
  let loadedRecords = null;
  if (OPTIONS.calibrationOnly || !partitionedTeamShards) {
    loadedRecords = await loadRecords(sourceFileIntegrityBySeason, sourceAccessLevelsBySeason);
  }
  if (OPTIONS.calibrationOnly) {
    await deriveOffenseDefenseCalibrationOnly({
      manifestRaw: manifestEntries[0].raw,
      validationRaw,
      loadedRecords,
      sourceAccessLevelsBySeason,
      sourceFileIntegrityBySeason,
    });
    return;
  }
  let sourceEligibleCount = 0;
  let phaseRecords = null;
  let officialRecords = null;
  let replayedRecords = null;
  let eligibleRecords = null;
  let rollingByTeam = new Map();
  const countRecordsBySeason = (records) => Object.fromEntries(OPTIONS.seasonStartYears.map(
    (seasonStartYear) => [
      seasonStartYear,
      records.filter(({ game }) => Number(game.seasonStartYear) === seasonStartYear).length,
    ],
  ));
  if (!partitionedTeamShards) {
    sourceEligibleCount = loadedRecords.filter(({ record }) => record.analytics?.eligibleForPublication === true).length;
    phaseRecords = loadedRecords.filter(({ game }) => OPTIONS.includedPhases.includes(String(game.primaryPhase ?? '').trim().toLowerCase()));
    officialRecords = phaseRecords.filter(isOfficialFranchiseGame);
    replayedRecords = officialRecords.map(transientReplay);
    eligibleRecords = replayedRecords.filter(({ record }) => record.analytics?.eligibleForPublication === true);
    rollingByTeam = rollingGameMemberships(eligibleRecords);
  }

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
  const playerOfficialSummaryMap = new Map();
  const lineupStartCounts = new Map();
  const lineupCloseCounts = new Map();
  const playerStartCounts = new Map();
  const playerCloseCounts = new Map();
  const rapmGroups = new Map();
  const counters = {
    archivesDiscovered: loadedRecords?.length ?? 0,
    archivesDiscoveredBySeason: loadedRecords ? countRecordsBySeason(loadedRecords) : Object.fromEntries(
      OPTIONS.seasonStartYears.map((year) => [year, 0]),
    ),
    archivesSourceEligibleV2: sourceEligibleCount,
    archivesPhaseCandidates: phaseRecords?.length ?? 0,
    archivesOfficialCandidates: officialRecords?.length ?? 0,
    archivesEligible: eligibleRecords?.length ?? 0,
    archivesEligibleBySeason: eligibleRecords ? countRecordsBySeason(eligibleRecords) : Object.fromEntries(
      OPTIONS.seasonStartYears.map((year) => [year, 0]),
    ),
    archivesExcludedByPhase: loadedRecords ? loadedRecords.length - phaseRecords.length : 0,
    archivesExcludedNonFranchise: loadedRecords ? phaseRecords.length - officialRecords.length : 0,
    archivesReplayPartial: replayedRecords?.filter(({ record }) => record.analytics?.coverageStatus === 'partial').length ?? 0,
    archivesReplayIneligible: replayedRecords?.filter(({ record }) => record.analytics?.coverageStatus === 'ineligible').length ?? 0,
    includedPhases: [...OPTIONS.includedPhases],
    eligibleArchivesByPhase: Object.fromEntries(OPTIONS.includedPhases.map((phase) => [phase, 0])),
    pseudoPlayerRowsExcludedAllArchives: loadedRecords?.reduce(
      (total, { record }) => total + finite(record.source?.skippedSummaryPlayerRows),
      0,
    ) ?? 0,
    pseudoPlayerRowsExcluded: 0,
    eventsInEligibleArchives: 0,
    stintsInEligibleArchives: 0,
    possessionsInEligibleArchives: 0,
    exactLineupPossessions: 0,
    exactLineupPossessionsBySeason: Object.fromEntries(OPTIONS.seasonStartYears.map((year) => [year, 0])),
    possessionStartLineupAttributedMidChange: 0,
    excludedPossessions: 0,
    excludedPossessionsMissingLineup: 0,
    excludedPossessionsInvalidTeam: 0,
    rapmGroupedObservations: 0,
    // These preserve the unweighted source exposure before recency weighting
    // removes a zero-weight prior season from a fitted RAPM input. Keeping
    // that distinction makes the final model scope auditable.
    rapmGroupedGamesBySeason: Object.fromEntries(OPTIONS.seasonStartYears.map((year) => [year, 0])),
    rapmGroupedObservationsBySeason: Object.fromEntries(OPTIONS.seasonStartYears.map((year) => [year, 0])),
    rapmGroupedPairedPossessionsBySeason: Object.fromEntries(OPTIONS.seasonStartYears.map((year) => [year, 0])),
    rapmGroupedOffensivePossessionsBySeason: Object.fromEntries(OPTIONS.seasonStartYears.map((year) => [year, 0])),
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

  // The cache is created only after raw source provenance passed and before
  // any shard aggregation begins.  Its directory is atomically promoted only
  // after every eligible replay has been serialized and indexed. A prior,
  // hash-bound completed cache can be reused after a failed final packaging
  // attempt; the raw archive is still replayed here for the global model fit.
  let replayCacheManifest = partitionedTeamShards && OPTIONS.reuseReplayCache
    ? await readReusableReplayCacheManifest({
      cacheDir: OPTIONS.replayCacheDir,
      validationReportSha256: sha256(validationRaw),
      manifestSetSha256,
    })
    : null;
  const replayCacheWriter = partitionedTeamShards && !replayCacheManifest
    ? await createReplayCacheWriter({
      cacheDir: OPTIONS.replayCacheDir,
      validationReportSha256: sha256(validationRaw),
      manifestSetSha256,
    })
    : null;

  // The legacy path has already selected its eligible replay records. Release
  // the raw/non-eligible arrays before its large aggregate maps grow. The
  // streaming cache path never allocated these arrays in the first place.
  if (!partitionedTeamShards) {
    loadedRecords.length = 0;
    phaseRecords.length = 0;
    officialRecords.length = 0;
    replayedRecords.length = 0;
    requestGarbageCollection();
  }

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

  function playerOfficialSummaryState(teamId, playerId) {
    const key = `${teamId}~${playerId}`;
    if (!playerOfficialSummaryMap.has(key)) {
      playerOfficialSummaryMap.set(key, createOfficialSummaryReconciliationState());
    }
    return playerOfficialSummaryMap.get(key);
  }

  function accumulateDirectPlayerEvents(record, validTeamIds) {
    const seenEventIds = new Set();
    const gameLines = new Map();
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
        const key = `${teamId}~${playerId}`;
        if (!gameLines.has(key)) gameLines.set(key, createDirectPlayerEventLine());
        addDirectPlayerStatistic(gameLines.get(key), statistic, eventType);
        addDirectPlayerStatistic(playerEventLine(teamId, playerId), statistic, eventType);
      }
    }
    return gameLines;
  }

  /**
   * The replay-cache first pass needs global coverage and RAPM inputs but must
   * not retain any team-level aggregate maps.  Keep that accounting isolated
   * from team serialization so its semantics remain byte-for-byte aligned
   * with the all-in-memory possession loop below.
   */
  function accumulateModelCoverageFromReplay({ record, game, maps, gameId, recordSeasonStartYear, primaryPhase, homeTeamId, awayTeamId }) {
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
      if (![homeTeamId, awayTeamId].includes(offenseTeamId)
        || ![homeTeamId, awayTeamId].includes(defenseTeamId)
        || offenseTeamId === defenseTeamId) {
        counters.excludedPossessions += 1;
        counters.excludedPossessionsInvalidTeam += 1;
        continue;
      }
      counters.exactLineupPossessions += 1;
      counters.exactLineupPossessionsBySeason[recordSeasonStartYear] += 1;
      if (possession.hasLineupChangeMidPossession === true) counters.possessionStartLineupAttributedMidChange += 1;
      const offensePoints = finite(possession.offensePoints);
      const defensePoints = finite(possession.defensePoints);
      counters.nominalDefensePoints += defensePoints;
      const eventStats = eventStatsForPossession(record, possession);
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
          seasonStartYear: recordSeasonStartYear,
          scheduledAt: game.scheduledAt,
          sampleWeight: 1,
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
    }
  }

  if (partitionedTeamShards) {
    // This is the critical memory boundary for six-season packages: source
    // integrity is still checked for every file, but each raw record is
    // replayed, modeled, optionally cached, and released before the next file
    // is opened. Only compact RAPM rows plus cache descriptors survive.
    const streamed = await streamVerifiedRecords(
      sourceFileIntegrityBySeason,
      sourceAccessLevelsBySeason,
      async (compact) => {
        const rawEligible = compact.record?.analytics?.eligibleForPublication === true;
        if (rawEligible) counters.archivesSourceEligibleV2 += 1;
        counters.pseudoPlayerRowsExcludedAllArchives += finite(compact.record?.source?.skippedSummaryPlayerRows);
        const primaryPhase = String(compact.game?.primaryPhase ?? '').trim().toLowerCase();
        if (!OPTIONS.includedPhases.includes(primaryPhase)) return;
        counters.archivesPhaseCandidates += 1;
        if (!isOfficialFranchiseGame(compact)) return;
        counters.archivesOfficialCandidates += 1;
        const replayed = transientReplay(compact);
        if (replayed.record?.analytics?.coverageStatus === 'partial') counters.archivesReplayPartial += 1;
        if (replayed.record?.analytics?.coverageStatus === 'ineligible') counters.archivesReplayIneligible += 1;
        if (replayed.record?.analytics?.eligibleForPublication !== true) return;

        const { record, game, maps, filename } = replayed;
        const gameId = String(game.providerGameId || filename);
        const recordSeasonStartYear = Number(game.seasonStartYear);
        if (!OPTIONS.seasonStartYears.includes(recordSeasonStartYear)) {
          throw new Error(`Eligible game ${gameId} is outside the requested season scope.`);
        }
        counters.archivesEligible += 1;
        counters.archivesEligibleBySeason[recordSeasonStartYear] += 1;
        counters.eligibleArchivesByPhase[primaryPhase] = (counters.eligibleArchivesByPhase[primaryPhase] ?? 0) + 1;
        counters.eventsInEligibleArchives += record.events?.length ?? 0;
        counters.stintsInEligibleArchives += record.stints?.length ?? 0;
        counters.possessionsInEligibleArchives += record.possessions?.length ?? 0;
        counters.pseudoPlayerRowsExcluded += finite(record.source?.skippedSummaryPlayerRows);
        rememberNames(record);
        accumulateModelCoverageFromReplay({
          record,
          game,
          maps,
          gameId,
          recordSeasonStartYear,
          primaryPhase,
          homeTeamId: String(game.homeProviderTeamId ?? ''),
          awayTeamId: String(game.awayProviderTeamId ?? ''),
        });
        if (replayCacheWriter) await replayCacheWriter.write(replayed);
      },
    );
    counters.archivesDiscovered = streamed.discovered;
    counters.archivesDiscoveredBySeason = streamed.discoveredBySeason;
    counters.archivesExcludedByPhase = counters.archivesDiscovered - counters.archivesPhaseCandidates;
    counters.archivesExcludedNonFranchise = counters.archivesPhaseCandidates - counters.archivesOfficialCandidates;
    sourceEligibleCount = counters.archivesSourceEligibleV2;
    if (replayCacheWriter) replayCacheManifest = await replayCacheWriter.complete();
    if (!replayCacheManifest || replayCacheManifest.records.length !== counters.archivesEligible) {
      throw new Error(`Replay cache recorded ${replayCacheManifest?.records?.length ?? 0} eligible games, expected ${counters.archivesEligible}.`);
    }
    rollingByTeam = rollingGameMembershipsFromCacheEntries(replayCacheManifest.records);
    requestGarbageCollection();
  }

  if (!partitionedTeamShards) for (let eligibleIndex = 0; eligibleIndex < eligibleRecords.length; eligibleIndex += 1) {
    const { record, game, maps, filename } = eligibleRecords[eligibleIndex];
    rememberNames(record);
    const primaryPhase = String(game.primaryPhase ?? '').trim().toLowerCase();
    counters.eligibleArchivesByPhase[primaryPhase] = (counters.eligibleArchivesByPhase[primaryPhase] ?? 0) + 1;
    counters.eventsInEligibleArchives += record.events?.length ?? 0;
    counters.stintsInEligibleArchives += record.stints?.length ?? 0;
    counters.possessionsInEligibleArchives += record.possessions?.length ?? 0;
    counters.pseudoPlayerRowsExcluded += finite(record.source?.skippedSummaryPlayerRows);

    const gameId = String(game.providerGameId || filename);
    const recordSeasonStartYear = Number(game.seasonStartYear);
    if (!OPTIONS.seasonStartYears.includes(recordSeasonStartYear)) {
      throw new Error(`Eligible game ${gameId} is outside the requested season scope.`);
    }
    const homeTeamId = String(game.homeProviderTeamId ?? '');
    const awayTeamId = String(game.awayProviderTeamId ?? '');
    if (partitionedTeamShards) {
      accumulateModelCoverageFromReplay({
        record,
        game,
        maps,
        gameId,
        recordSeasonStartYear,
        primaryPhase,
        homeTeamId,
        awayTeamId,
      });
      if (replayCacheWriter) await replayCacheWriter.write(eligibleRecords[eligibleIndex]);
      // The replay cache is now the only retained copy needed for team-level
      // aggregation.  Free this decoded game before the next reconstruction.
      eligibleRecords[eligibleIndex] = null;
      if ((eligibleIndex + 1) % 50 === 0) requestGarbageCollection();
      continue;
    }
    const validTeamIds = new Set([homeTeamId, awayTeamId]);
    const directPlayerEventsForGame = accumulateDirectPlayerEvents(record, validTeamIds);
    const appearedPlayersByTeam = new Map([[homeTeamId, new Set()], [awayTeamId, new Set()]]);
    for (const lineup of record.lineups ?? []) {
      const ids = exactLineup(lineup.id, maps.lineups);
      if (!ids || !appearedPlayersByTeam.has(lineup.providerTeamId)) continue;
      ids.forEach((id) => appearedPlayersByTeam.get(lineup.providerTeamId).add(id));
    }
    const summaryPlayersByKey = new Map((record.players ?? []).map((player) => [
      `${player.providerTeamId}~${player.id}`,
      player,
    ]));
    for (const [teamId, appeared] of appearedPlayersByTeam.entries()) {
      for (const playerId of appeared) {
        const state = playerOfficialSummaryState(teamId, playerId);
        state.gamesExpected += 1;
        const summaryPlayer = summaryPlayersByKey.get(`${teamId}~${playerId}`);
        if (summaryPlayer?.officialBoxScore?.availableFields?.length > 0) {
          state.gamesWithAnySummaryTotals += 1;
        }
        const officialTotals = officialSummaryBoxScoreForComparison(summaryPlayer);
        if (!officialTotals) continue;
        state.gamesWithCompleteSummaryTotals += 1;
        const directTotals = directBoxScoreForOfficialComparison(
          directPlayerEventsForGame.get(`${teamId}~${playerId}`) ?? createDirectPlayerEventLine(),
        );
        if (!sameOfficialPlayerBoxScore(directTotals, officialTotals)) continue;
        state.gamesReconciledWithStructuredPbp += 1;
        addOfficialPlayerBoxScore(state.reconciledTotals, officialTotals);
      }
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
    for (const [teamId, appeared] of appearedPlayersByTeam.entries()) {
      for (const playerId of appeared) {
        const key = `${teamId}~${playerId}`;
        playerScopeMinutes.set(key, (playerScopeMinutes.get(key) ?? 0) + (teamStintMinutes.get(teamId) ?? 0));
      }
    }

    const possessionObservedLineupKeysByTeam = new Map([[homeTeamId, new Set()], [awayTeamId, new Set()]]);

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
      counters.exactLineupPossessionsBySeason[recordSeasonStartYear] += 1;
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
          seasonStartYear: recordSeasonStartYear,
          scheduledAt: game.scheduledAt,
          sampleWeight: 1,
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
        possessionObservedLineupKeysByTeam.get(side.teamId).add(comboKey(side.teamId, side.ids));
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
        const contexts = [...possessionContexts(possession, side.side, {
          phase: primaryPhase,
          rollingWindowMemberships: membershipsFor(side.teamId, gameId, rollingByTeam),
        }), `season:${recordSeasonStartYear}`];

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

    if (exactStints.length) {
      for (const [teamId, exactLineups] of [
        [homeTeamId, exactStints.map((stint) => stint.homeIds)],
        [awayTeamId, exactStints.map((stint) => stint.awayIds)],
      ]) {
        const { starterIds, closerIds } = selectPossessionObservedBoundaryLineups({
          teamId,
          exactLineups,
          observedLineupKeys: possessionObservedLineupKeysByTeam.get(teamId),
        });
        if (starterIds) {
          incrementCount(lineupStartCounts, comboKey(teamId, starterIds));
          for (const playerId of starterIds) incrementCount(playerStartCounts, `${teamId}~${playerId}`);
        }
        if (closerIds) {
          incrementCount(lineupCloseCounts, comboKey(teamId, closerIds));
          for (const playerId of closerIds) incrementCount(playerCloseCounts, `${teamId}~${playerId}`);
        }
      }
    }

    // No later game needs this replay payload: rolling membership was computed
    // before aggregation, and every aggregate update for this game is done.
    // Clearing the slot allows V8 to reclaim its events/lineups/possessions as
    // aggregate maps grow rather than retaining every eligible game until the
    // output-writing phase.
    eligibleRecords[eligibleIndex] = null;
    if ((eligibleIndex + 1) % 50 === 0) requestGarbageCollection();
  }

  // The raw checkpoint remains preserved on disk. Eligible payloads were
  // released progressively above; drop the now-empty index before serializing.
  if (!partitionedTeamShards) {
    eligibleRecords.length = 0;
    requestGarbageCollection();
  }

  let rapmInput = [...rapmGroups.values()];
  counters.rapmGroupedObservations = rapmInput.length;
  const rapmGameIdsBySeason = new Map(
    OPTIONS.seasonStartYears.map((seasonStartYear) => [seasonStartYear, new Set()]),
  );
  for (const row of rapmInput) {
    const seasonStartYear = Number(row.seasonStartYear);
    if (!Object.hasOwn(counters.rapmGroupedObservationsBySeason, seasonStartYear)) {
      throw new Error(`RAPM observation has a season outside the selected scope: ${seasonStartYear}.`);
    }
    const offensivePossessions = finite(row.homeOffensivePossessions) + finite(row.awayOffensivePossessions);
    counters.rapmGroupedObservationsBySeason[seasonStartYear] += 1;
    counters.rapmGroupedOffensivePossessionsBySeason[seasonStartYear] += offensivePossessions;
    counters.rapmGroupedPairedPossessionsBySeason[seasonStartYear] += offensivePossessions / 2;
    rapmGameIdsBySeason.get(seasonStartYear).add(String(row.gameId));
  }
  for (const seasonStartYear of OPTIONS.seasonStartYears) {
    counters.rapmGroupedGamesBySeason[seasonStartYear] = rapmGameIdsBySeason.get(seasonStartYear).size;
  }
  rapmGameIdsBySeason.clear();
  const seasonPhase = `${OPTIONS.includedPhases.join('_')}_official_franchise_${NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION}_possession_start_lineups`;
  const rapmOptions = {
    lambdaCandidates: OPTIONS.lambdaCandidates,
    lambdaFoldCount: OPTIONS.lambdaFoldCount,
    seasonEndYear: OPTIONS.latestSeasonStartYear + 1,
    seasonPhase,
  };
  const multiseason = OPTIONS.seasonStartYears.length > 1;
  const chronologicalOptions = {
    latestSeasonStartYear: OPTIONS.latestSeasonStartYear,
    tuningGameFraction: OPTIONS.chronologicalTuningGameFraction,
    testGameFraction: OPTIONS.chronologicalTestGameFraction,
  };
  const tuneChronologically = (model, priorWeight, lambda) => {
    // Fixed choices still need a latest-season holdout evaluation.  Passing
    // singleton candidate grids preserves the requested values while making
    // the untouched test block auditable for every multiseason package.
    if (!multiseason) return null;
    return selectChronologicalRapmHyperparameters(rapmInput, {
      ...chronologicalOptions,
      model,
      priorSeasonWeightCandidates: priorWeight === 'auto'
        ? OPTIONS.priorSeasonWeightCandidates
        : [priorWeight],
      lambdaCandidates: lambda === 'auto' ? OPTIONS.lambdaCandidates : [lambda],
    });
  };
  const netChronologicalCalibration = tuneChronologically(
    'net',
    OPTIONS.rapmPriorSeasonWeight,
    OPTIONS.rapmLambda,
  );
  const offenseDefenseChronologicalCalibration = tuneChronologically(
    'offenseDefense',
    OPTIONS.offenseDefenseRapmPriorSeasonWeight,
    OPTIONS.offenseDefenseRapmLambda,
  );
  const netPriorSeasonWeight = netChronologicalCalibration?.selectedPriorSeasonWeight
    ?? OPTIONS.rapmPriorSeasonWeight;
  const offenseDefensePriorSeasonWeight = offenseDefenseChronologicalCalibration?.selectedPriorSeasonWeight
    ?? OPTIONS.offenseDefenseRapmPriorSeasonWeight;
  const netLambda = netChronologicalCalibration?.selectedLambda ?? OPTIONS.rapmLambda;
  const offenseDefenseLambda = offenseDefenseChronologicalCalibration?.selectedLambda
    ?? OPTIONS.offenseDefenseRapmLambda;
  const weightedRapmInput = (priorSeasonWeight) => rapmInput.flatMap((row) => {
    const age = OPTIONS.latestSeasonStartYear - Number(row.seasonStartYear);
    const sampleWeight = age === 0 ? 1 : Number(priorSeasonWeight) ** age;
    return sampleWeight > 0 ? [{ ...row, sampleWeight }] : [];
  });
  const netRapmInput = weightedRapmInput(netPriorSeasonWeight);
  const offenseDefenseRapmInput = weightedRapmInput(offenseDefensePriorSeasonWeight);
  const seasonWeightsFor = (priorSeasonWeight) => Object.fromEntries(
    OPTIONS.seasonStartYears.map((seasonStartYear) => [
      seasonStartYear,
      seasonStartYear === OPTIONS.latestSeasonStartYear
        ? 1
        : Number(priorSeasonWeight) ** (OPTIONS.latestSeasonStartYear - seasonStartYear),
    ]),
  );
  const netRapm = fitWeightedRidgeRapm(netRapmInput, { ...rapmOptions, lambda: netLambda });
  netRapm.priorSeasonWeight = netPriorSeasonWeight;
  netRapm.seasonWeights = seasonWeightsFor(netPriorSeasonWeight);
  netRapm.includedSeasonStartYears = Object.entries(netRapm.seasonWeights)
    .filter(([, weight]) => weight > 0)
    .map(([seasonStartYear]) => Number(seasonStartYear));
  netRapm.chronologicalCalibration = netChronologicalCalibration;
  const offenseDefenseRapm = fitWeightedRidgeOffenseDefenseRapm(offenseDefenseRapmInput, {
    ...rapmOptions,
    lambda: offenseDefenseLambda,
  });
  offenseDefenseRapm.priorSeasonWeight = offenseDefensePriorSeasonWeight;
  offenseDefenseRapm.seasonWeights = seasonWeightsFor(offenseDefensePriorSeasonWeight);
  offenseDefenseRapm.includedSeasonStartYears = Object.entries(offenseDefenseRapm.seasonWeights)
    .filter(([, weight]) => weight > 0)
    .map(([seasonStartYear]) => Number(seasonStartYear));
  offenseDefenseRapm.chronologicalCalibration = offenseDefenseChronologicalCalibration;
  // Evaluate the selected numeric lambda on complete held-out games. If the
  // derive command chose lambda automatically, its selected value is frozen
  // here; calibration never quietly reuses the same held-out fold to retune it.
  // This adds a model-quality report without changing the fitted coefficients.
  offenseDefenseRapm.calibration = evaluateOffenseDefenseRapmCalibration(offenseDefenseRapmInput, {
    lambda: offenseDefenseRapm.lambda,
    foldCount: OPTIONS.lambdaFoldCount,
  });
  rapmGroups.clear();
  rapmInput.length = 0;
  rapmInput = null;
  netRapmInput.length = 0;
  offenseDefenseRapmInput.length = 0;
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
    effectiveOffensivePossessions: odByPlayer.get(row.providerPlayerId)?.effectiveOffensivePossessions ?? 0,
    effectiveDefensivePossessions: odByPlayer.get(row.providerPlayerId)?.effectiveDefensivePossessions ?? 0,
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
          ? 'Starting and closing counts use the first and final verified exact-lineup stint observed at a possession start in each eligible game; zero-possession dead-ball lineups are excluded.'
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

  let teamRows = [];
  let rowCounts = null;
  if (!partitionedTeamShards) {
    teamRows = [...teamMap.values()].map((entry) => {
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

    rowCounts = {
      teams: teamRows.length,
      lineupsAndCombinations: comboMap.size,
      playerOnOff: playerOnOffMap.size,
      playerProfiles: playerOnOffMap.size,
      wowy: wowyMap.size,
    };
  }
  const sourceReconstructionMethodVersionsBySeason = Object.fromEntries(
    OPTIONS.seasonStartYears.map((seasonStartYear) => [
      seasonStartYear,
      validationSeasons.get(seasonStartYear)?.totals?.reconstructionMethodVersionCounts ?? {},
    ]),
  );
  const sourceReconstructionReplayMatchedGamesBySeason = Object.fromEntries(
    OPTIONS.seasonStartYears.map((seasonStartYear) => [
      seasonStartYear,
      validationSeasons.get(seasonStartYear)?.totals?.reconstructionReplayMatchedGames ?? null,
    ]),
  );
  const dataQualityBySeason = Object.fromEntries(OPTIONS.seasonStartYears.map((seasonStartYear) => {
    const season = validationSeasons.get(seasonStartYear);
    return [seasonStartYear, {
      errors: season?.dataQuality?.analyticsValidationErrorsByCategory ?? {},
      warnings: season?.dataQuality?.analyticsValidationWarningsByCategory ?? {},
    }];
  }));
  const sumQualityCategories = (field) => {
    const totals = {};
    for (const season of Object.values(dataQualityBySeason)) {
      for (const [category, count] of Object.entries(season[field] ?? {})) {
        totals[category] = (totals[category] ?? 0) + Number(count ?? 0);
      }
    }
    return totals;
  };
  const sourceSummaryTeamReconciliation = Object.fromEntries(SOURCE_SUMMARY_TEAM_RECONCILIATION_FIELDS.map((field) => [
    field,
    Object.values(sourceSummaryTeamReconciliationBySeason).reduce(
      (total, season) => total + finite(season[field]),
      0,
    ),
  ]));
  const lineupAttributionSensitivity = {
    method: 'possession_start_lineup_with_mid_possession_change_count_v1',
    exactLineupPossessions: counters.exactLineupPossessions,
    possessionStartLineupAttributedMidChange: counters.possessionStartLineupAttributedMidChange,
    possessionStartLineupAttributedMidChangeShare: ratioOrNull(
      counters.possessionStartLineupAttributedMidChange,
      counters.exactLineupPossessions,
      6,
    ),
    caveat: 'A verified possession-start lineup remains the attribution rule when a later lineup change occurs. This is a sensitivity diagnostic, not a reassignment of scoring to an unobserved split lineup.',
  };

  // Build the final package only after the global model is frozen.  Each
  // cache-backed iteration holds one franchise's combinations, on/off rows,
  // direct-profile evidence, and WOWY pairs in memory, streams that shard,
  // then releases it before opening the next franchise.  There is no cap on
  // candidate rotations or on the source rows represented in a team shard.
  let partitionedOutputState = null;
  if (partitionedTeamShards) {
    if (!replayCacheManifest || replayCacheManifest.records.length !== counters.archivesEligible) {
      throw new Error('A complete replay-cache manifest is required before partitioned team output can begin.');
    }
    const entriesByTeam = new Map();
    for (const entry of replayCacheManifest.records) {
      for (const teamId of entry.teamIds ?? []) {
        if (!entriesByTeam.has(teamId)) entriesByTeam.set(teamId, []);
        entriesByTeam.get(teamId).push(entry);
      }
    }
    for (const entries of entriesByTeam.values()) {
      entries.sort((left, right) => (
        String(left.scheduledAt ?? '').localeCompare(String(right.scheduledAt ?? ''))
        || left.gameId.localeCompare(right.gameId)
      ));
    }
    const orderedTeamIds = [...entriesByTeam.keys()].sort((left, right) => (
      String(teamNames.get(left) || left).localeCompare(String(teamNames.get(right) || right))
      || String(left).localeCompare(String(right))
    ));
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
    let noPossessionOnlyAggregateEntries = 0;
    const rowBuilders = createScoutRowBuilders({ netByPlayer, netRapm, playerNames });
    const names = { playerNames, teamNames };
    for (const teamId of orderedTeamIds) {
      const state = createAggregateState();
      for (const cacheEntry of entriesByTeam.get(teamId)) {
        const compact = await readReplayCacheRecord(OPTIONS.replayCacheDir, cacheEntry);
        if (compact.record?.analytics?.eligibleForPublication !== true) {
          throw new Error(`Replay cache contains a non-eligible game: ${cacheEntry.gameId}.`);
        }
        rememberAggregateNames(compact.record, names);
        aggregateEligibleRecordIntoState({
          compact,
          state,
          names,
          rollingByTeam,
          targetTeamId: teamId,
        });
      }
      const team = teamRowFromAggregateState(teamId, state);
      if (!team) {
        const retainedRows = state.comboMap.size + state.playerOnOffMap.size + state.wowyMap.size
          + state.playerEventMap.size + state.playerOfficialSummaryMap.size;
        if (retainedRows) {
          throw new Error(`Team ${teamId} retained aggregates without a verified possession-context row.`);
        }
        continue;
      }
      const descriptor = await writeTeamShardFromState({
        team,
        stagingDirectory: stagingOutputDirectory,
        state,
        playerNames,
        rowBuilders,
      });
      // The stream writer must consume every actual output row.  Some players
      // and lineups can appear only in a zero-possession dead-ball stint; the
      // legacy all-team writer intentionally does not emit them because they
      // have no valid possession context. Retain that policy explicitly, then
      // release the auxiliary minute/count maps just as the legacy finalizer
      // does after all teams are written.
      const unstreamedPrimaryEntries = state.comboMap.size + state.playerOnOffMap.size
        + state.wowyMap.size + state.teamMap.size + state.playerEventMap.size
        + state.playerOfficialSummaryMap.size;
      if (unstreamedPrimaryEntries) {
        throw new Error(`Team ${teamId} retained ${unstreamedPrimaryEntries} output-bearing aggregates after streaming its Scout shard.`);
      }
      noPossessionOnlyAggregateEntries += state.comboMinutes.size + state.playerOnMinutes.size
        + state.playerScopeMinutes.size + state.teamScopeMinutes.size
        + state.lineupStartCounts.size + state.lineupCloseCounts.size
        + state.playerStartCounts.size + state.playerCloseCounts.size;
      state.comboMinutes.clear();
      state.playerOnMinutes.clear();
      state.playerScopeMinutes.clear();
      state.teamScopeMinutes.clear();
      state.lineupStartCounts.clear();
      state.lineupCloseCounts.clear();
      state.playerStartCounts.clear();
      state.playerCloseCounts.clear();
      teamRows.push(team);
      shardDescriptors.push(descriptor);
      writtenRows.teams += descriptor.rows.team;
      writtenRows.lineupsAndCombinations += descriptor.rows.lineupsAndCombinations;
      writtenRows.playerOnOff += descriptor.rows.playerOnOff;
      writtenRows.playerProfiles += descriptor.rows.playerProfiles;
      writtenRows.wowy += descriptor.rows.wowy;
      shardJsonBytes += descriptor.jsonBytes;
      shardGzipBytes += descriptor.gzipBytes;
      requestGarbageCollection();
    }
    rowCounts = { ...writtenRows };
    partitionedOutputState = {
      stagingOutputDirectory,
      shardDescriptors,
      shardJsonBytes,
      shardGzipBytes,
      replayCacheManifestSha256: sha256(JSON.stringify(replayCacheManifest)),
      noPossessionOnlyAggregateEntries,
    };
  }

  const output = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    metricsVersion: SCOUT_METRICS_VERSION,
    provider: 'Sportradar NBA v8 licensed local archive',
    scope: {
      seasonStartYear: OPTIONS.seasonStartYear,
      seasonEndYear: OPTIONS.latestSeasonStartYear + 1,
      seasonStartYears: [...OPTIONS.seasonStartYears],
      latestSeasonStartYear: OPTIONS.latestSeasonStartYear,
      seasonLabel: seasonLabel(OPTIONS.seasonStartYears),
      archiveDirectory: path.relative(process.cwd(), OPTIONS.archiveDir),
      eligibility: 'selected official competition phases, two official franchise teams, and transient current-version reconstruction eligibleForPublication=true',
      includedPhases: [...OPTIONS.includedPhases],
      excludedPhases: [...ARCHIVE_PHASES].filter((phase) => !OPTIONS.includedPhases.includes(phase)),
      officialFranchiseTeamRule: 'both normalized teams require a non-empty Sportradar sr:team identifier',
      possessionLineupAttribution: 'verified five-player lineup at possession start; safe untouched dead-ball substitutions are rebased by reconstruction v3',
      rollingWindows: 'last 5, 10, and 20 eligible games for each team across the selected chronological archive as of the snapshot',
      seasonContexts: OPTIONS.seasonStartYears.map((year) => `season:${year}`),
      rawArchivePreserved: true,
      transientReconstructionReplay: OPTIONS.replayReconstruction,
      networkAccess: 'not used',
      supabaseWrites: 'none',
    },
    provenance: {
      manifestSha256: manifestEntries.length === 1 ? manifestSha256BySeason[OPTIONS.seasonStartYear] : manifestSetSha256,
      manifestSetSha256,
      manifestSha256BySeason,
      sourceAccessLevelsBySeason,
      sourceGameFileIntegrityBySeason: sourceFileIntegrityProvenance(sourceFileIntegrityBySeason),
      sourceValidationReportSha256: sha256(validationRaw),
      sourceValidatorVersion: validation.validatorVersion,
      sourceArchiveValidationPassed: validation.passed === true,
      sourceArchiveValidationSeasonsPresent: sourceValidation.seasons.map((season) => ({
        seasonStartYear: season.seasonStartYear,
        present: season.sourceArchiveValidationSeasonPresent,
      })),
      sourceReconstructionMethodVersions: OPTIONS.seasonStartYears.length === 1
        ? sourceReconstructionMethodVersionsBySeason[OPTIONS.seasonStartYear]
        : sourceReconstructionMethodVersionsBySeason,
      sourceReconstructionMethodVersionsBySeason,
      derivedReconstructionMethodVersion: NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
      sourceReconstructionReplayMatchedGames: OPTIONS.seasonStartYears.length === 1
        ? sourceReconstructionReplayMatchedGamesBySeason[OPTIONS.seasonStartYear]
        : Object.values(sourceReconstructionReplayMatchedGamesBySeason).reduce(
          (total, count) => total + Number(count ?? 0),
          0,
        ),
      sourceReconstructionReplayMatchedGamesBySeason,
    },
    coverage: counters,
    quality: {
      sourceValidationErrors: sumQualityCategories('errors'),
      sourceValidationWarnings: sumQualityCategories('warnings'),
      sourceValidationBySeason: dataQualityBySeason,
      sourceSummaryTeamReconciliation,
      sourceSummaryTeamReconciliationBySeason,
      lineupAttributionSensitivity,
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
      directPlayerBoxScoreTotals: {
        status: 'available_with_coverage',
        rows: rowCounts.playerProfiles,
        path: 'team shards -> playerProfiles[].boxScoreTotals',
        source: 'sportradar_play_by_play_structured_statistics',
        aggregation: 'scope_sum_of_non_rescinded_structured_statistics',
        scope: 'scout_eligible_games',
        officialSummaryReconciliation: {
          status: 'per_player_status',
          path: 'team shards -> playerProfiles[].boxScoreTotals.officialSummaryReconciliation',
          statuses: [
            'not_available_in_current_legacy_source_revision',
            'partial_or_unreconciled',
            'complete_and_reconciled',
          ],
        },
        caveat: 'Each player profile carries explicit aggregate totals plus coverage. Summary-endpoint totals are emitted only when every Scout-eligible player appearance has complete independently retained totals that exactly reconcile to parsed structured PBP; otherwise the per-player official total remains null.',
      },
      rotationContinuity: { status: 'available_with_coverage', exactLineupSemantics: 'first/final verified exact five-player stint in each eligible game', caveat: 'Games without verified exact stints do not contribute a starting or closing assignment.' },
      periodAndHalfSplits: { status: 'available', contexts: ['period:q1', 'period:q2', 'period:q3', 'period:q4', 'period:overtime', 'half:first_half', 'half:second_half', 'half:overtime'] },
      possessionOutcomes: { status: 'available', buckets: ['0', '1', '2', '3', '4+'] },
      venueSplits: { status: 'available', contexts: ['home', 'away'] },
      teammateOpponentAdjustment: { status: 'available_via_rapm', caveat: 'average teammate/opponent RAPM fields are exposure context, not extra adjustment terms' },
      regularizedAdjustedPlusMinus: {
        status: 'available',
        netModel: RAPM_MODEL_VERSION,
        offenseDefenseModel: RAPM_OFFENSE_DEFENSE_MODEL_VERSION,
        lambdaSelection: 'deterministic held-out game-fold weighted MSE when auto',
        offenseDefenseCalibration: 'fixed-lambda held-out game-fold venue-baseline and component-ablation report',
      },
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

  if (partitionedOutputState) {
    output.dataShards = partitionedOutputState.shardDescriptors;
    output.storage = {
      // Keep the established schema-v4 contract.  The extra cache fields make
      // the bounded-memory implementation inspectable without exposing the
      // private cache itself to a browser or deployment target.
      format: 'schema_v4_streamed_team_shards_with_manifest',
      writeMode: 'bounded_memory_atomic_team_stream_v1',
      shardCount: partitionedOutputState.shardDescriptors.length,
      shardJsonBytes: partitionedOutputState.shardJsonBytes,
      shardGzipBytes: partitionedOutputState.shardGzipBytes,
      replayCache: {
        status: 'private_completed',
        schemaVersion: REPLAY_CACHE_SCHEMA_VERSION,
        manifestSha256: partitionedOutputState.replayCacheManifestSha256,
        records: replayCacheManifest.records.length,
        semantics: 'eligible transient replay records read and hash-verified one team shard at a time',
      },
      noPossessionOnlyAggregateEntries: partitionedOutputState.noPossessionOnlyAggregateEntries,
      caveat: 'Uncompressed shards are retained for inspection; gzip shards are the preferred transport/archive representation. Team shards are streamed into a staging directory and the completed directory is renamed into place only after the manifest is complete.',
    };
    const filename = `nba-scout-analytics-${seasonLabel(OPTIONS.seasonStartYears)}.json`;
    const stagedOutputPath = path.join(partitionedOutputState.stagingOutputDirectory, filename);
    const stagedGzipPath = `${stagedOutputPath}.gz`;
    const stagedSummaryPath = path.join(partitionedOutputState.stagingOutputDirectory, 'README.md');
    const outputRaw = `${JSON.stringify(output)}\n`;
    await fs.writeFile(stagedOutputPath, outputRaw, 'utf8');
    const outputHash = sha256(outputRaw);
    const outputBytes = Buffer.byteLength(outputRaw);
    const gzip = await gzipFile(stagedOutputPath, stagedGzipPath);
    const summary = `# NBA Scout analytics — ${seasonLabel(OPTIONS.seasonStartYears)}\n\n`
      + `Generated offline from the preserved local Sportradar archive with transient ${NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION} replay. No API request and no Supabase write was made.\n\n`
      + `- Source archives: ${counters.archivesDiscovered}; selected official candidates: ${counters.archivesOfficialCandidates}; Scout-eligible after replay: ${counters.archivesEligible}.\n`
      + `- Included phases: ${OPTIONS.includedPhases.join(', ')}; excluded by phase: ${counters.archivesExcludedByPhase}; non-franchise exclusions: ${counters.archivesExcludedNonFranchise}.\n`
      + `- Eligible events/stints/possessions: ${counters.eventsInEligibleArchives}/${counters.stintsInEligibleArchives}/${counters.possessionsInEligibleArchives}.\n`
      + `- Possessions with valid start lineups used: ${counters.exactLineupPossessions}; start-lineup-attributed mid-change possessions: ${counters.possessionStartLineupAttributedMidChange}; excluded: ${counters.excludedPossessions}.\n`
      + `- Rows: ${rowCounts.lineupsAndCombinations} combinations; ${rowCounts.playerOnOff} player on/off; ${rowCounts.playerProfiles} direct player profiles; ${rowCounts.wowy} WOWY pairs; ${rapmPlayers.length} net RAPM players.\n`
      + `- Net RAPM lambda: ${netRapm.lambda}; prior-season weight: ${netRapm.priorSeasonWeight}; offense/defense RAPM lambda: ${offenseDefenseRapm.lambda}; prior-season weight: ${offenseDefenseRapm.priorSeasonWeight}.\n`
      + (multiseason
        ? `- Chronological tuning/test: net ${netChronologicalCalibration ? 'completed' : 'fixed settings'}; offense/defense ${offenseDefenseChronologicalCalibration ? 'completed' : 'fixed settings'}. Latest season is ${OPTIONS.latestSeasonStartYear}-${String(OPTIONS.latestSeasonStartYear + 1).slice(-2)}.\n`
        : '')
      + `- Offense/defense held-out calibration: ${offenseDefenseRapm.calibration.status}; full-model MSE improvement vs venue baseline: ${round((offenseDefenseRapm.calibration.fullModelMseImprovementVsVenueBaseline ?? 0) * 100, 3)}%.\n`
      + `- Private replay cache: ${replayCacheManifest.records.length} eligible games, hash-bound to the source validation report, consumed one franchise at a time.\n`
      + `- Manifest JSON: ${outputBytes} bytes, SHA-256 ${outputHash}.\n`
      + `- Manifest gzip: ${gzip.gzipBytes} bytes, SHA-256 ${gzip.gzipSha256}.\n`
      + `- Team shards: ${partitionedOutputState.shardDescriptors.length}; JSON bytes: ${partitionedOutputState.shardJsonBytes}; gzip bytes: ${partitionedOutputState.shardGzipBytes}.\n`
      + `- Packaging: bounded-memory streamed shards written to a staging directory and atomically renamed only after completion.\n`;
    await fs.writeFile(stagedSummaryPath, summary, 'utf8');
    await fs.rename(partitionedOutputState.stagingOutputDirectory, OPTIONS.outputDir);
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
    return;
  }

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

    await writer.write(`{"schemaVersion":${OUTPUT_SCHEMA_VERSION},"metricsVersion":${JSON.stringify(SCOUT_METRICS_VERSION)},"seasonStartYear":${OPTIONS.seasonStartYear},"seasonEndYear":${OPTIONS.latestSeasonStartYear + 1},"seasonStartYears":${JSON.stringify(OPTIONS.seasonStartYears)},"latestSeasonStartYear":${OPTIONS.latestSeasonStartYear},"team":${JSON.stringify(team)},"lineupsAndCombinations":[`);
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
        officialSummaryReconciliationState: playerOfficialSummaryMap.get(key),
      });
      await appendArrayItem(writer, profileState, profile);
      playerEventMap.delete(key);
      playerStartCounts.delete(key);
      playerCloseCounts.delete(key);
      playerOfficialSummaryMap.delete(key);
    }
    for (const key of [...playerEventMap.keys()]) {
      if (key.startsWith(`${team.teamId}~`)) playerEventMap.delete(key);
    }
    for (const key of [...playerOfficialSummaryMap.keys()]) {
      if (key.startsWith(`${team.teamId}~`)) playerOfficialSummaryMap.delete(key);
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
  if (comboMap.size || playerOnOffMap.size || wowyMap.size || teamMap.size || playerOfficialSummaryMap.size) {
    throw new Error('Not every in-memory aggregate was assigned to exactly one team shard.');
  }
  comboMinutes.clear();
  playerEventMap.clear();
  playerOfficialSummaryMap.clear();
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
  const filename = `nba-scout-analytics-${seasonLabel(OPTIONS.seasonStartYears)}.json`;
  const stagedOutputPath = path.join(stagingOutputDirectory, filename);
  const stagedGzipPath = `${stagedOutputPath}.gz`;
  const stagedSummaryPath = path.join(stagingOutputDirectory, 'README.md');
  const outputRaw = `${JSON.stringify(output)}\n`;
  await fs.writeFile(stagedOutputPath, outputRaw, 'utf8');
  const outputHash = sha256(outputRaw);
  const outputBytes = Buffer.byteLength(outputRaw);
  const gzip = await gzipFile(stagedOutputPath, stagedGzipPath);
  const summary = `# NBA Scout analytics — ${seasonLabel(OPTIONS.seasonStartYears)}\n\n`
    + `Generated offline from the preserved local Sportradar archive with transient ${NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION} replay. No API request and no Supabase write was made.\n\n`
    + `- Source archives: ${counters.archivesDiscovered}; selected official candidates: ${counters.archivesOfficialCandidates}; Scout-eligible after replay: ${counters.archivesEligible}.\n`
    + `- Included phases: ${OPTIONS.includedPhases.join(', ')}; excluded by phase: ${counters.archivesExcludedByPhase}; non-franchise exclusions: ${counters.archivesExcludedNonFranchise}.\n`
    + `- Eligible events/stints/possessions: ${counters.eventsInEligibleArchives}/${counters.stintsInEligibleArchives}/${counters.possessionsInEligibleArchives}.\n`
    + `- Possessions with valid start lineups used: ${counters.exactLineupPossessions}; start-lineup-attributed mid-change possessions: ${counters.possessionStartLineupAttributedMidChange}; excluded: ${counters.excludedPossessions}.\n`
    + `- Rows: ${rowCounts.lineupsAndCombinations} combinations; ${rowCounts.playerOnOff} player on/off; ${rowCounts.playerProfiles} direct player profiles; ${rowCounts.wowy} WOWY pairs; ${rapmPlayers.length} net RAPM players.\n`
    + `- Net RAPM lambda: ${netRapm.lambda}; prior-season weight: ${netRapm.priorSeasonWeight}; offense/defense RAPM lambda: ${offenseDefenseRapm.lambda}; prior-season weight: ${offenseDefenseRapm.priorSeasonWeight}.\n`
    + (multiseason
      ? `- Chronological tuning/test: net ${netChronologicalCalibration ? 'completed' : 'fixed settings'}; offense/defense ${offenseDefenseChronologicalCalibration ? 'completed' : 'fixed settings'}. Latest season is ${OPTIONS.latestSeasonStartYear}-${String(OPTIONS.latestSeasonStartYear + 1).slice(-2)}.\n`
      : '')
    + `- Offense/defense held-out calibration: ${offenseDefenseRapm.calibration.status}; full-model MSE improvement vs venue baseline: ${round((offenseDefenseRapm.calibration.fullModelMseImprovementVsVenueBaseline ?? 0) * 100, 3)}%.\n`
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
