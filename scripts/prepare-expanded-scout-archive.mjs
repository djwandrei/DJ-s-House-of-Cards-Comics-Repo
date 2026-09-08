#!/usr/bin/env node

/**
 * Assemble a no-copy, private archive view for an expanded Scout package.
 *
 * Each selected season is represented by a directory junction (or directory
 * symlink outside Windows) to one canonical raw archive. This lets the normal
 * source validator and derivation accept one archive directory without keeping
 * a second physical copy of any raw season. The resulting view is intentionally
 * not source-attested by itself: callers must run the full validator for new
 * source seasons and then attest the composed view before derivation.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_PRIVATE_ROOT = path.join(REPOSITORY_ROOT, 'outputs');
const PLAN_VERSION = 'scout-expanded-archive-link-plan-v1';
const GAME_FILE_PATTERN = /^games\/[^/]+\.json\.gz$/;
const REQUIRED_PACKAGE_SCHEMA_VERSION = 4;
const REQUIRED_METRICS_VERSION = 'nba-scout-metrics-v4';
const REQUIRED_RAW_FIELDS = {
  root: ['analytics', 'events', 'game', 'lineups', 'players', 'possessions', 'stints', 'teams'],
  game: ['providerGameId', 'seasonStartYear', 'seasonEndYear', 'primaryPhase', 'coverage', 'trackOnCourt', 'homeProviderTeamId', 'awayProviderTeamId'],
  teams: ['id', 'srId', 'points', 'possessions', 'offensiveRating', 'defensiveRating'],
  players: ['id', 'providerTeamId', 'minutesPlayed', 'plusMinus', 'officialBoxScore'],
  events: ['id', 'eventType', 'statistics', 'onCourt', 'periodSequence', 'clockRemainingMs', 'possessionTeamId', 'attributionTeamId', 'isRescinded'],
  stints: ['homeLineupId', 'awayLineupId', 'homePoints', 'awayPoints', 'homeOffensivePossessions', 'awayOffensivePossessions', 'startElapsedMs', 'endElapsedMs'],
  possessions: ['id', 'offenseProviderTeamId', 'defenseProviderTeamId', 'offensePoints', 'defensePoints', 'homeLineupId', 'awayLineupId', 'periodSequence', 'isClutchV1', 'transitionContext'],
  lineups: ['id', 'playerIds', 'providerTeamId'],
};

function parseSeasonList(value) {
  const years = String(value).split(',').map((item) => Number.parseInt(item.trim(), 10));
  if (!years.length || years.some((year) => !Number.isInteger(year) || year < 1947 || year > 2200)) {
    throw new Error('--expect-seasons must be a comma-separated list of NBA season start years.');
  }
  const normalized = [...new Set(years)].sort((left, right) => left - right);
  if (normalized.length !== years.length) throw new Error('--expect-seasons must not repeat a season.');
  return normalized;
}

export function optionsFromArgs(argv) {
  const options = { sourceRoots: [], expectedSeasons: null, outputDir: null, referencePackage: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inlineValue] = token.split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--source-root') options.sourceRoots.push(path.resolve(value));
    else if (name === '--expect-seasons') options.expectedSeasons = parseSeasonList(value);
    else if (name === '--output-dir') options.outputDir = path.resolve(value);
    else if (name === '--reference-package') options.referencePackage = path.resolve(value);
    else throw new Error(`Unknown option: ${name}`);
  }
  if (options.sourceRoots.length < 2) throw new Error('At least two --source-root values are required.');
  if (!options.expectedSeasons?.length) throw new Error('--expect-seasons is required.');
  if (!options.outputDir) throw new Error('--output-dir is required.');
  if (!options.referencePackage) throw new Error('--reference-package is required.');
  return options;
}

function isDescendant(target, root) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function requirePrivateDescendant(target, privateRoot, label) {
  if (!isDescendant(target, privateRoot)) {
    throw new Error(`${label} must stay under the private outputs root.`);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function asPosix(relativePath) {
  return relativePath.replaceAll('\\', '/');
}

function requiredAnalytics(reference) {
  return Object.entries(reference.analyticsAvailability)
    .filter(([, value]) => value && typeof value === 'object' && String(value.status ?? '').startsWith('available'))
    .map(([name]) => name)
    .sort();
}

async function readReferenceMetricContract(referencePackage, privateRoot) {
  const resolved = path.resolve(referencePackage);
  requirePrivateDescendant(resolved, privateRoot, 'Reference package');
  let raw;
  let reference;
  try {
    raw = await fs.readFile(resolved, 'utf8');
    reference = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot read the reference Scout package: ${String(error?.message ?? error)}`);
  }
  if (Number(reference?.schemaVersion) !== REQUIRED_PACKAGE_SCHEMA_VERSION
    || reference?.metricsVersion !== REQUIRED_METRICS_VERSION
    || !String(reference?.provider ?? '').includes('Sportradar NBA v8')) {
    throw new Error('Reference package is not the required nba-scout-metrics-v4 Sportradar NBA v8 package.');
  }
  const definitions = Object.keys(reference?.definitions ?? {}).sort();
  const tables = Object.keys(reference?.tables ?? {}).sort();
  const analytics = requiredAnalytics(reference);
  if (!definitions.length || !tables.length || !analytics.length || reference?.provenance?.sourceArchiveValidationPassed !== true) {
    throw new Error('Reference package lacks a validated metric surface or source-validation provenance.');
  }
  return {
    referencePackage: asPosix(path.relative(REPOSITORY_ROOT, resolved)),
    referencePackageSha256: sha256(raw),
    schemaVersion: reference.schemaVersion,
    metricsVersion: reference.metricsVersion,
    provider: reference.provider,
    definitionFamilies: definitions,
    tables,
    availableAnalytics: analytics,
  };
}

function missingKeys(value, keys) {
  return keys.filter((key) => !Object.hasOwn(value ?? {}, key));
}

function anyEntryHasKeys(value, keys) {
  return Array.isArray(value) && value.some((entry) => entry && typeof entry === 'object' && !missingKeys(entry, keys).length);
}

function inspectRawMetricFields(record, year, gameId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Season ${year} game ${gameId} is not a normalized raw record.`);
  }
  const rootMissing = missingKeys(record, REQUIRED_RAW_FIELDS.root);
  const gameMissing = missingKeys(record.game, REQUIRED_RAW_FIELDS.game);
  const sectionFailures = Object.entries(REQUIRED_RAW_FIELDS)
    .filter(([section]) => section !== 'root' && section !== 'game')
    .filter(([section, keys]) => !anyEntryHasKeys(record[section], keys))
    .map(([section]) => section);
  if (rootMissing.length || gameMissing.length || sectionFailures.length) {
    throw new Error(`Season ${year} game ${gameId} does not satisfy the nba-scout-metrics-v4 raw-field contract: ${JSON.stringify({ rootMissing, gameMissing, sectionFailures })}`);
  }
  return {
    structuredStatisticEvents: record.events.filter((event) => Array.isArray(event?.statistics) && event.statistics.length > 0).length,
    playersWithOfficialBoxScoreField: record.players.filter((player) => Object.hasOwn(player ?? {}, 'officialBoxScore')).length,
    reconstructedLineupPossessions: record.possessions.filter((possession) => possession.homeLineupId && possession.awayLineupId).length,
  };
}

async function inspectSeason(sourceRoot, year, { verifyMetricFields = false } = {}) {
  const directory = path.join(sourceRoot, String(year));
  const manifestPath = path.join(directory, 'manifest.json');
  let raw;
  let manifest;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Season ${year} has no readable manifest at ${manifestPath}: ${String(error?.message ?? error)}`);
  }
  if (Number(manifest?.seasonStartYear) !== year || manifest?.accessLevel !== 'trial') {
    throw new Error(`Season ${year} must have a trial manifest with the matching seasonStartYear.`);
  }
  const expectedGames = Number(manifest?.uniqueEligibleGames);
  const gameEntries = manifest?.games && typeof manifest.games === 'object' && !Array.isArray(manifest.games)
    ? Object.entries(manifest.games)
    : [];
  if (!Number.isSafeInteger(expectedGames) || expectedGames <= 0 || gameEntries.length !== expectedGames) {
    throw new Error(`Season ${year} does not have a complete eligible-game manifest.`);
  }
  const expectedNames = new Set();
  const compatibility = { gamesChecked: 0, structuredStatisticEvents: 0, playersWithOfficialBoxScoreField: 0, reconstructedLineupPossessions: 0 };
  for (const [gameId, entry] of gameEntries) {
    const relativeGameFile = String(entry?.gameFile ?? '').replaceAll('\\', '/');
    const filename = relativeGameFile.slice('games/'.length);
    if (!gameId || entry?.status !== 'completed' || !GAME_FILE_PATTERN.test(relativeGameFile) || expectedNames.has(filename)) {
      throw new Error(`Season ${year} has an incomplete or invalid game entry.`);
    }
    expectedNames.add(filename);
    const gamePath = path.join(directory, relativeGameFile);
    const stats = await fs.stat(gamePath).catch(() => null);
    if (!stats?.isFile() || stats.size <= 0) throw new Error(`Season ${year} is missing a completed game file: ${relativeGameFile}.`);
    if (verifyMetricFields) {
      let record;
      try {
        record = JSON.parse(gunzipSync(await fs.readFile(gamePath)).toString('utf8'));
      } catch (error) {
        throw new Error(`Season ${year} game ${gameId} cannot be decoded for metric compatibility: ${String(error?.message ?? error)}`);
      }
      const fields = inspectRawMetricFields(record, year, gameId);
      compatibility.gamesChecked += 1;
      compatibility.structuredStatisticEvents += fields.structuredStatisticEvents;
      compatibility.playersWithOfficialBoxScoreField += fields.playersWithOfficialBoxScoreField;
      compatibility.reconstructedLineupPossessions += fields.reconstructedLineupPossessions;
    }
  }
  const gamesDirectory = path.join(directory, 'games');
  const actualNames = (await fs.readdir(gamesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
    .map((entry) => entry.name)
    .sort();
  const expectedSorted = [...expectedNames].sort();
  if (actualNames.length !== expectedSorted.length || actualNames.some((name, index) => name !== expectedSorted[index])) {
    throw new Error(`Season ${year} has an incomplete or unexpected game-file inventory.`);
  }
  return {
    seasonStartYear: year,
    seasonEndYear: year + 1,
    sourceDirectory: directory,
    manifestSha256: sha256(raw),
    completedGames: expectedGames,
    rawMetricCompatibility: verifyMetricFields ? compatibility : null,
  };
}

async function discoverSeasonSources(sourceRoots, expectedSeasons, options) {
  const byYear = new Map();
  for (const sourceRoot of sourceRoots) {
    const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch((error) => {
      throw new Error(`Cannot read source root ${sourceRoot}: ${String(error?.message ?? error)}`);
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}$/.test(entry.name)) continue;
      const year = Number(entry.name);
      if (!expectedSeasons.includes(year)) continue;
      if (byYear.has(year)) throw new Error(`Season ${year} appears in more than one source root.`);
      byYear.set(year, await inspectSeason(sourceRoot, year, options));
    }
  }
  const missing = expectedSeasons.filter((year) => !byYear.has(year));
  if (missing.length) throw new Error(`Missing complete source seasons: ${missing.join(', ')}.`);
  return expectedSeasons.map((year) => byYear.get(year));
}

async function removeIfPresent(target) {
  if (await exists(target)) await fs.rm(target, { recursive: true, force: true });
}

/**
 * Create an atomic, junction-based archive view. This performs no network IO
 * and does not copy, mutate, or validate raw data beyond the completeness
 * preflight; callers must attach validation evidence afterwards.
 */
export async function prepareExpandedScoutArchive({ sourceRoots, expectedSeasons, outputDir, referencePackage, privateRoot = DEFAULT_PRIVATE_ROOT }) {
  const resolvedPrivateRoot = path.resolve(privateRoot);
  const resolvedOutput = path.resolve(outputDir);
  const resolvedSources = sourceRoots.map((sourceRoot) => path.resolve(sourceRoot));
  if (!Array.isArray(expectedSeasons) || !expectedSeasons.length) throw new Error('At least one expected season is required.');
  const normalizedSeasons = [...expectedSeasons].map(Number).sort((left, right) => left - right);
  if (new Set(normalizedSeasons).size !== normalizedSeasons.length || normalizedSeasons.some((year) => !Number.isInteger(year))) {
    throw new Error('Expected seasons must be unique integers.');
  }
  requirePrivateDescendant(resolvedOutput, resolvedPrivateRoot, 'Output directory');
  for (const sourceRoot of resolvedSources) requirePrivateDescendant(sourceRoot, resolvedPrivateRoot, 'Source root');
  if (await exists(resolvedOutput)) throw new Error(`Refusing to overwrite an existing expanded archive: ${resolvedOutput}`);

  const metricContract = await readReferenceMetricContract(referencePackage, resolvedPrivateRoot);
  const seasons = await discoverSeasonSources(resolvedSources, normalizedSeasons, { verifyMetricFields: true });
  const temporary = `${resolvedOutput}.building-${process.pid}-${Date.now()}`;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.mkdir(temporary, { recursive: false });
    for (const season of seasons) {
      const link = path.join(temporary, String(season.seasonStartYear));
      await fs.symlink(season.sourceDirectory, link, linkType);
      const linkedManifest = await fs.readFile(path.join(link, 'manifest.json'), 'utf8');
      if (sha256(linkedManifest) !== season.manifestSha256) throw new Error(`Link verification failed for season ${season.seasonStartYear}.`);
    }
    const plan = {
      schemaVersion: PLAN_VERSION,
      mode: process.platform === 'win32' ? 'directory_junctions_no_raw_copy' : 'directory_symlinks_no_raw_copy',
      createdAt: new Date().toISOString(),
      archiveScope: { seasonStartYears: normalizedSeasons, seasonLabel: `${normalizedSeasons[0]}-${normalizedSeasons.at(-1) + 1}` },
      metricContract,
      seasons: seasons.map((season) => ({
        seasonStartYear: season.seasonStartYear,
        seasonEndYear: season.seasonEndYear,
        completedGames: season.completedGames,
        manifestSha256: season.manifestSha256,
        sourceDirectory: asPosix(path.relative(REPOSITORY_ROOT, season.sourceDirectory)),
        rawMetricCompatibility: season.rawMetricCompatibility,
      })),
      requiredPromotionGates: [
        'Run the full raw archive validator for every newly downloaded source season.',
        'Run attest-composed-scout-source.mjs against the linked archive and all source reports.',
        'Derive a new expanded package with the complete season list; do not append fitted metrics to an existing package.',
        'Run check-scout-package-metric-contract.mjs, package validation, and independent Summary/box-score reconciliation before promotion.',
      ],
    };
    await fs.writeFile(path.join(temporary, 'archive-composition.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, resolvedOutput);
    return { outputDir: resolvedOutput, plan };
  } catch (error) {
    await removeIfPresent(temporary);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  prepareExpandedScoutArchive(optionsFromArgs(process.argv.slice(2))).then(({ outputDir, plan }) => {
    process.stdout.write(`${JSON.stringify({ outputDir, mode: plan.mode, metricsVersion: plan.metricContract.metricsVersion, seasons: plan.archiveScope.seasonStartYears, completedGames: plan.seasons.reduce((sum, season) => sum + season.completedGames, 0) })}\n`);
  }).catch((error) => {
    process.stderr.write(`Expanded Scout archive preparation failed: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
