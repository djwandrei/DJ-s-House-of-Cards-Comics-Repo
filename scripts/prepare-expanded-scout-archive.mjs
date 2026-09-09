#!/usr/bin/env node

/**
 * Assemble a no-copy, private archive view for an expanded Scout package.
 *
 * Each selected season is represented by a filtered directory containing hard
 * links to one canonical raw archive. Already-attested source manifests can be
 * preserved byte-for-byte when composing multiple validated views. This lets
 * the normal source validator and derivation accept one archive directory
 * without keeping a second physical copy of raw game files. The resulting
 * view is intentionally not source-attested by itself: callers must run the
 * full validator for new source seasons and then attest the composed view
 * before derivation.
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
const PHASES = new Set(['preseason', 'regular', 'in_season_tournament', 'play_in', 'playoffs']);
const DEFAULT_INCLUDED_PHASES = ['regular', 'in_season_tournament', 'play_in', 'playoffs'];
// Only possessions may be empty in an otherwise structurally valid source
// record: a source-ineligible game can have no reconstructable possessions.
// Identity and structural sections must still contain at least one keyed row.
const ALLOW_EMPTY_RAW_SECTIONS = new Set(['possessions']);
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

function normalizePhase(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parsePhaseList(value) {
  const phases = String(value).split(',').map((item) => normalizePhase(item)).filter(Boolean);
  if (!phases.length || phases.some((phase) => !PHASES.has(phase))) {
    throw new Error(`--phases must contain only: ${[...PHASES].join(', ')}.`);
  }
  return [...new Set(phases)];
}

function parseGameId(value) {
  const gameId = String(value ?? '').trim();
  if (!gameId) throw new Error('--exclude-game requires a non-empty game identifier.');
  return gameId;
}

export function optionsFromArgs(argv) {
  const options = {
    sourceRoots: [],
    expectedSeasons: null,
    outputDir: null,
    referencePackage: null,
    includedPhases: [...DEFAULT_INCLUDED_PHASES],
    excludedGameIds: [],
    preserveSeasons: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inlineValue] = token.split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--source-root') options.sourceRoots.push(path.resolve(value));
    else if (name === '--expect-seasons') options.expectedSeasons = parseSeasonList(value);
    else if (name === '--output-dir') options.outputDir = path.resolve(value);
    else if (name === '--reference-package') options.referencePackage = path.resolve(value);
    else if (name === '--phases') options.includedPhases = parsePhaseList(value);
    else if (name === '--exclude-game') options.excludedGameIds.push(parseGameId(value));
    else if (name === '--preserve-season') options.preserveSeasons.push(...parseSeasonList(value));
    else throw new Error(`Unknown option: ${name}`);
  }
  if (options.sourceRoots.length < 2) throw new Error('At least two --source-root values are required.');
  if (!options.expectedSeasons?.length) throw new Error('--expect-seasons is required.');
  if (!options.outputDir) throw new Error('--output-dir is required.');
  if (!options.referencePackage) throw new Error('--reference-package is required.');
  options.excludedGameIds = [...new Set(options.excludedGameIds)];
  options.preserveSeasons = [...new Set(options.preserveSeasons)].sort((left, right) => left - right);
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

async function readSourceComposition(sourceRoot) {
  const compositionPath = path.join(sourceRoot, 'archive-composition.json');
  if (!await exists(compositionPath)) return null;
  let raw;
  let plan;
  try {
    raw = await fs.readFile(compositionPath, 'utf8');
    plan = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Source root has an unreadable archive-composition.json at ${compositionPath}: ${String(error?.message ?? error)}`);
  }
  return {
    planPath: asPosix(path.relative(REPOSITORY_ROOT, compositionPath)),
    planSha256: sha256(raw),
    schemaVersion: plan?.schemaVersion ?? null,
    mode: plan?.mode ?? null,
    archiveScope: plan?.archiveScope ? {
      seasonStartYears: Array.isArray(plan.archiveScope.seasonStartYears) ? plan.archiveScope.seasonStartYears : [],
      seasonLabel: plan.archiveScope.seasonLabel ?? null,
      includedPhases: Array.isArray(plan.archiveScope.includedPhases) ? plan.archiveScope.includedPhases : [],
      excludedGameIds: Array.isArray(plan.archiveScope.excludedGameIds) ? plan.archiveScope.excludedGameIds : [],
    } : null,
    seasons: Array.isArray(plan?.seasons) ? plan.seasons.map((season) => ({
      seasonStartYear: season?.seasonStartYear ?? null,
      completedGames: season?.completedGames ?? null,
      rawCompletedGames: season?.rawCompletedGames ?? null,
      filteredManifestSha256: season?.filteredManifestSha256 ?? null,
      excludedGameIds: Array.isArray(season?.excludedGameIds) ? season.excludedGameIds : [],
      excludedGames: Array.isArray(season?.excludedGames) ? season.excludedGames : [],
    })) : [],
  };
}

function missingKeys(value, keys) {
  return keys.filter((key) => !Object.hasOwn(value ?? {}, key));
}

function anyEntryHasKeys(value, keys, { allowEmpty = false } = {}) {
  // A validated provider record may legitimately have an empty derived
  // section (for example, an ineligible game with no reconstructable
  // possessions). Require the contract when rows exist, while leaving the
  // source validator responsible for the record-level eligibility decision.
  return Array.isArray(value) && (allowEmpty && !value.length
    || value.some((entry) => entry && typeof entry === 'object' && !missingKeys(entry, keys).length));
}

function inspectRawMetricFields(record, year, gameId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Season ${year} game ${gameId} is not a normalized raw record.`);
  }
  const rootMissing = missingKeys(record, REQUIRED_RAW_FIELDS.root);
  const gameMissing = missingKeys(record.game, REQUIRED_RAW_FIELDS.game);
  const sectionFailures = Object.entries(REQUIRED_RAW_FIELDS)
    .filter(([section]) => section !== 'root' && section !== 'game')
    .filter(([section, keys]) => !anyEntryHasKeys(record[section], keys, {
      allowEmpty: ALLOW_EMPTY_RAW_SECTIONS.has(section),
    }))
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

async function inspectSeason(sourceRoot, year, {
  verifyMetricFields = false,
  includedPhases = DEFAULT_INCLUDED_PHASES,
  excludedGameIds = [],
  preserveSourceManifest = false,
  sourceComposition = null,
} = {}) {
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
  // Preservation is deliberately an all-entry mode. Rewriting a manifest that
  // is already covered by a passing source report would invalidate its hash
  // and break the composition attestation chain.
  const selectedPhaseSet = preserveSourceManifest
    ? new Set(PHASES)
    : new Set((includedPhases?.length ? includedPhases : DEFAULT_INCLUDED_PHASES).map(normalizePhase));
  const excludedIds = new Set((excludedGameIds ?? []).map((gameId) => String(gameId).trim()).filter(Boolean));
  const excludedFound = new Set();
  const excludedGameEvidence = [];
  const selectedCompletedEntries = [];
  const selectedPhaseCounts = new Map();
  const selectedFileDescriptors = [];
  const selectedFilenames = new Set();
  const compatibility = { gamesChecked: 0, structuredStatisticEvents: 0, playersWithOfficialBoxScoreField: 0, reconstructedLineupPossessions: 0 };
  for (const [gameId, entry] of gameEntries) {
    const primaryPhase = normalizePhase(entry?.primaryPhase ?? entry?.sourcePhases?.[0]);
    if (!PHASES.has(primaryPhase)) {
      throw new Error(`Season ${year} has an invalid primary phase for game ${gameId}.`);
    }
    if (!selectedPhaseSet.has(primaryPhase)) continue;
    if (!gameId || entry?.status !== 'completed') {
      throw new Error(`Season ${year} has an incomplete selected-phase game entry.`);
    }
    const relativeGameFile = String(entry?.gameFile ?? '').replaceAll('\\', '/');
    const filename = relativeGameFile.slice('games/'.length);
    if (!GAME_FILE_PATTERN.test(relativeGameFile) || selectedFilenames.has(filename)) {
      throw new Error(`Season ${year} has an incomplete or invalid selected-phase game entry.`);
    }
    selectedFilenames.add(filename);
    const gamePath = path.join(directory, relativeGameFile);
    const stats = await fs.stat(gamePath).catch(() => null);
    if (!stats?.isFile() || stats.size <= 0) throw new Error(`Season ${year} is missing a selected-phase completed game file: ${relativeGameFile}.`);
    const compressed = await fs.readFile(gamePath);
    if (preserveSourceManifest && excludedIds.has(String(gameId))) {
      throw new Error(`Season ${year} cannot preserve its source manifest while excluding game ${gameId}.`);
    }
    if (excludedIds.has(String(gameId))) {
      let record;
      try {
        record = JSON.parse(gunzipSync(compressed).toString('utf8'));
      } catch (error) {
        throw new Error(`Season ${year} excluded game ${gameId} cannot be decoded: ${String(error?.message ?? error)}`);
      }
      const manifestCoverageStatus = normalizePhase(entry?.coverageStatus);
      const recordCoverageStatus = normalizePhase(record?.analytics?.coverageStatus);
      const validationErrors = Array.isArray(record?.analytics?.validation?.errors)
        ? [...new Set(record.analytics.validation.errors.map((error) => String(error).trim()).filter(Boolean))].sort()
        : [];
      if (record?.game?.providerGameId !== String(gameId)
        || Number(record?.game?.seasonStartYear) !== year
        || normalizePhase(record?.game?.primaryPhase) !== primaryPhase
        || entry?.eligibleForPublication !== false
        || manifestCoverageStatus !== 'ineligible'
        || record?.analytics?.eligibleForPublication !== false
        || recordCoverageStatus !== 'ineligible'
        || !validationErrors.length) {
        throw new Error(`Season ${year} game ${gameId} cannot be excluded because it lacks matching ineligible source evidence.`);
      }
      const finalScore = record.analytics?.validation?.finalScore ?? {};
      excludedFound.add(String(gameId));
      excludedGameEvidence.push({
        gameId: String(gameId),
        primaryPhase,
        manifestCoverageStatus,
        recordCoverageStatus,
        validationErrors,
        finalScore: {
          expectedHomePoints: finalScore.expectedHomePoints ?? null,
          expectedAwayPoints: finalScore.expectedAwayPoints ?? null,
          observedHomePoints: finalScore.observedHomePoints ?? null,
          observedAwayPoints: finalScore.observedAwayPoints ?? null,
          verified: finalScore.verified === true,
        },
        gzipSha256: sha256(compressed),
      });
      continue;
    }
    const gzipSha256 = sha256(compressed);
    let uncompressed = null;
    if (verifyMetricFields) {
      let record;
      try {
        uncompressed = gunzipSync(compressed);
        record = JSON.parse(uncompressed.toString('utf8'));
      } catch (error) {
        throw new Error(`Season ${year} game ${gameId} cannot be decoded for metric compatibility: ${String(error?.message ?? error)}`);
      }
      const fields = inspectRawMetricFields(record, year, gameId);
      compatibility.gamesChecked += 1;
      compatibility.structuredStatisticEvents += fields.structuredStatisticEvents;
      compatibility.playersWithOfficialBoxScoreField += fields.playersWithOfficialBoxScoreField;
      compatibility.reconstructedLineupPossessions += fields.reconstructedLineupPossessions;
    }
    selectedCompletedEntries.push([gameId, entry]);
    selectedPhaseCounts.set(primaryPhase, (selectedPhaseCounts.get(primaryPhase) ?? 0) + 1);
    selectedFileDescriptors.push({
      gameId,
      filename,
      relativePath: asPosix(relativeGameFile),
      byteLength: compressed.byteLength,
      gzipSha256,
      uncompressedByteLength: uncompressed?.byteLength ?? null,
      uncompressedSha256: uncompressed ? sha256(uncompressed) : null,
    });
  }
  if (!selectedCompletedEntries.length) {
    throw new Error(`Season ${year} has no completed games in the selected phase scope.`);
  }
  const filteredManifest = preserveSourceManifest ? manifest : {
    ...manifest,
    uniqueEligibleGames: selectedCompletedEntries.length,
    phases: Object.fromEntries([...selectedPhaseCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, count]) => [phase, { gamesDiscovered: count, eligibleGames: count }])),
    games: Object.fromEntries(selectedCompletedEntries.map(([gameId, entry]) => [gameId, { ...entry }])),
    progress: {
      ...(manifest.progress ?? {}),
      total: selectedCompletedEntries.length,
      complete: selectedCompletedEntries.length,
      failed: 0,
      currentIndex: selectedCompletedEntries.length,
    },
  };
  const filteredManifestRaw = preserveSourceManifest ? raw : `${JSON.stringify(filteredManifest, null, 2)}\n`;
  return {
    seasonStartYear: year,
    seasonEndYear: year + 1,
    sourceDirectory: directory,
    sourceComposition,
    rawManifestSha256: sha256(raw),
    rawCompletedGames: expectedGames,
    completedGames: selectedCompletedEntries.length,
    selectedPhases: [...selectedPhaseSet],
    preserveSourceManifest,
    excludedGameIds: [...excludedFound].sort(),
    excludedGameEvidence: excludedGameEvidence.sort((left, right) => left.gameId.localeCompare(right.gameId)),
    filteredManifest,
    filteredManifestRaw,
    filteredManifestSha256: sha256(filteredManifestRaw),
    selectedFileDescriptors,
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
      byYear.set(year, await inspectSeason(sourceRoot, year, {
        ...options,
        // Preserved manifests are already bound to prior validator reports;
        // re-running the stricter compatibility probe here can reject a
        // valid, intentionally empty derived section (such as possessions on
        // a source-ineligible game). The composition attestation and derive
        // loader re-bind the actual compressed and uncompressed bytes.
        verifyMetricFields: options.preserveSeasons?.has(year) !== true && options.verifyMetricFields === true,
        preserveSourceManifest: options.preserveSeasons?.has(year) === true,
        sourceComposition: options.sourceCompositions?.get(sourceRoot) ?? null,
      }));
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
 * Create an atomic, hard-link-based archive view. This performs no network IO
 * and does not copy, mutate, or validate raw data beyond the completeness
 * preflight; callers must attach validation evidence afterwards.
 */
export async function prepareExpandedScoutArchive({
  sourceRoots,
  expectedSeasons,
  outputDir,
  referencePackage,
  privateRoot = DEFAULT_PRIVATE_ROOT,
  includedPhases = [...DEFAULT_INCLUDED_PHASES],
  excludedGameIds = [],
  preserveSeasons = [],
}) {
  const resolvedPrivateRoot = path.resolve(privateRoot);
  const resolvedOutput = path.resolve(outputDir);
  const resolvedSources = sourceRoots.map((sourceRoot) => path.resolve(sourceRoot));
  if (!Array.isArray(expectedSeasons) || !expectedSeasons.length) throw new Error('At least one expected season is required.');
  const normalizedSeasons = [...expectedSeasons].map(Number).sort((left, right) => left - right);
  if (new Set(normalizedSeasons).size !== normalizedSeasons.length || normalizedSeasons.some((year) => !Number.isInteger(year))) {
    throw new Error('Expected seasons must be unique integers.');
  }
  const normalizedPreserveSeasons = [...new Set((preserveSeasons ?? []).map(Number))].sort((left, right) => left - right);
  if (normalizedPreserveSeasons.some((year) => !Number.isInteger(year))) {
    throw new Error('Preserved seasons must be integer NBA season start years.');
  }
  const seasonsNotExpected = normalizedPreserveSeasons.filter((year) => !normalizedSeasons.includes(year));
  if (seasonsNotExpected.length) {
    throw new Error(`Preserved seasons must be included in the expected season list: ${seasonsNotExpected.join(', ')}.`);
  }
  requirePrivateDescendant(resolvedOutput, resolvedPrivateRoot, 'Output directory');
  for (const sourceRoot of resolvedSources) requirePrivateDescendant(sourceRoot, resolvedPrivateRoot, 'Source root');
  if (await exists(resolvedOutput)) throw new Error(`Refusing to overwrite an existing expanded archive: ${resolvedOutput}`);

  const metricContract = await readReferenceMetricContract(referencePackage, resolvedPrivateRoot);
  const sourceCompositions = new Map();
  for (const sourceRoot of resolvedSources) sourceCompositions.set(sourceRoot, await readSourceComposition(sourceRoot));
  const seasons = await discoverSeasonSources(resolvedSources, normalizedSeasons, {
    verifyMetricFields: true,
    includedPhases: [...includedPhases],
    excludedGameIds: [...new Set(excludedGameIds.map((gameId) => String(gameId).trim()).filter(Boolean))],
    preserveSeasons: new Set(normalizedPreserveSeasons),
    sourceCompositions,
  });
  const normalizedExcludedGameIds = [...new Set(excludedGameIds.map((gameId) => String(gameId).trim()).filter(Boolean))].sort();
  const foundExcludedGameIds = [...new Set(seasons.flatMap((season) => season.excludedGameIds))].sort();
  const missingExcludedGameIds = normalizedExcludedGameIds.filter((gameId) => !foundExcludedGameIds.includes(gameId));
  if (missingExcludedGameIds.length) {
    throw new Error(`Requested excluded game IDs were not found in the selected phase scope: ${missingExcludedGameIds.join(', ')}.`);
  }
  const inheritedExclusionSources = seasons.flatMap((season) => {
    const sourceSeason = season.sourceComposition?.seasons?.find(
      (candidate) => Number(candidate?.seasonStartYear) === season.seasonStartYear,
    );
    // A season-level list is authoritative, including an explicit empty list.
    // Fall back to a global list only for a single-season source plan that has
    // no season record; never attribute a multi-season global list to every
    // season in the source root.
    const sourceScopeYears = season.sourceComposition?.archiveScope?.seasonStartYears ?? [];
    const inheritedIds = sourceSeason
      ? sourceSeason.excludedGameIds
      : sourceScopeYears.length === 1
        ? season.sourceComposition?.archiveScope?.excludedGameIds
        : [];
    const gameIds = [...new Set((inheritedIds ?? []).map((gameId) => String(gameId).trim()).filter(Boolean))].sort();
    if (!gameIds.length || !season.sourceComposition) return [];
    return gameIds.map((gameId) => ({
      seasonStartYear: season.seasonStartYear,
      gameId,
      sourcePlanPath: season.sourceComposition.planPath,
      sourcePlanSha256: season.sourceComposition.planSha256,
    }));
  });
  const inheritedExcludedGameIds = [...new Set(inheritedExclusionSources.map((entry) => entry.gameId))].sort();
  const temporary = `${resolvedOutput}.building-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(temporary, { recursive: false });
    for (const season of seasons) {
      const seasonDirectory = path.join(temporary, String(season.seasonStartYear));
      const gamesDirectory = path.join(seasonDirectory, 'games');
      await fs.mkdir(gamesDirectory, { recursive: true });
      for (const descriptor of season.selectedFileDescriptors) {
        const sourceGamePath = path.join(season.sourceDirectory, descriptor.relativePath);
        const targetGamePath = path.join(gamesDirectory, descriptor.filename);
        await fs.link(sourceGamePath, targetGamePath);
        const linkedBytes = await fs.readFile(targetGamePath);
        if (linkedBytes.byteLength !== descriptor.byteLength || sha256(linkedBytes) !== descriptor.gzipSha256) {
          throw new Error(`Link verification failed for season ${season.seasonStartYear} game ${descriptor.gameId}.`);
        }
      }
      await fs.writeFile(path.join(seasonDirectory, 'manifest.json'), season.filteredManifestRaw, 'utf8');
      if (sha256(season.filteredManifestRaw) !== season.filteredManifestSha256) {
        throw new Error(`Manifest verification failed for season ${season.seasonStartYear}.`);
      }
    }
    const plan = {
      schemaVersion: PLAN_VERSION,
      mode: 'phase_filtered_hardlinks_no_raw_copy',
      createdAt: new Date().toISOString(),
      archiveScope: {
        seasonStartYears: normalizedSeasons,
        seasonLabel: `${normalizedSeasons[0]}-${normalizedSeasons.at(-1) + 1}`,
        includedPhases: [...includedPhases],
        excludedGameIds: normalizedExcludedGameIds,
        preservedSeasons: normalizedPreserveSeasons,
        inheritedExcludedGameIds,
        inheritedExclusionSources,
      },
      metricContract,
      seasons: seasons.map((season) => ({
        seasonStartYear: season.seasonStartYear,
        seasonEndYear: season.seasonEndYear,
        completedGames: season.completedGames,
        rawCompletedGames: season.rawCompletedGames,
        rawManifestSha256: season.rawManifestSha256,
        filteredManifestSha256: season.filteredManifestSha256,
        preserveSourceManifest: season.preserveSourceManifest,
        sourceDirectory: asPosix(path.relative(REPOSITORY_ROOT, season.sourceDirectory)),
        sourceComposition: season.sourceComposition,
        selectedPhases: season.selectedPhases,
        excludedGameIds: season.excludedGameIds,
        excludedGames: season.excludedGameEvidence,
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
