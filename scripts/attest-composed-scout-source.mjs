#!/usr/bin/env node

/**
 * Re-attest a composed private Scout archive without re-running the expensive
 * lineup reconstruction for every game.
 *
 * Why this exists:
 * - Each source season has already passed the full v4 archive validator.
 * - A composed archive is a new filesystem snapshot, so the old reports alone
 *   are not sufficient proof for a downstream derivation.
 * - This program binds the composed snapshot to the prior reports by checking
 *   every manifest and every compressed game file's byte length and SHA-256.
 *
 * The result deliberately keeps the source validator's per-season evidence
 * unchanged.  It adds a small composition-attestation chain instead of
 * pretending that this faster path independently replayed PBP a second time.
 * The normal Scout derivation still verifies compressed and uncompressed
 * hashes while loading the archive before it performs any modeling.
 *
 * This script is local-only: it reads no credentials and makes no network
 * requests.  It refuses to overwrite an existing report directory.
 */

import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const REQUIRED_VALIDATOR_VERSION = 'sportradar-nba-local-archive-validator-v4';
const ATTESTATION_VERSION = 'scout-composed-source-attestation-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function parseArgs(argv) {
  const options = {
    archiveDir: null,
    outputDir: null,
    sourceReports: [],
    expectedSeasons: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inlineValue] = token.split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--archive-dir') options.archiveDir = path.resolve(value);
    else if (name === '--output-dir') options.outputDir = path.resolve(value);
    else if (name === '--source-report') options.sourceReports.push(path.resolve(value));
    else if (name === '--expect-seasons') {
      const years = value.split(',').map((item) => Number.parseInt(item.trim(), 10));
      if (!years.length || years.some((year) => !Number.isInteger(year) || year < 1947 || year > 2200)) {
        throw new Error('--expect-seasons must be a comma-separated list of NBA season start years.');
      }
      options.expectedSeasons = [...new Set(years)].sort((left, right) => left - right);
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.archiveDir) throw new Error('--archive-dir is required.');
  if (!options.outputDir) throw new Error('--output-dir is required.');
  if (!options.sourceReports.length) throw new Error('At least one --source-report is required.');
  if (!options.expectedSeasons?.length) throw new Error('--expect-seasons is required.');
  return options;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sha256File(target) {
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(target)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: digest.digest('hex') };
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

async function writeAtomic(target, body) {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, body, 'utf8');
  await fs.rename(temporary, target);
}

function issue(errors, code, details = {}) {
  errors.push({ code, ...details });
}

function asPosix(relativePath) {
  return relativePath.replaceAll('\\', '/');
}

function safeRelativeGamePath(relativePath) {
  const normalized = asPosix(String(relativePath ?? ''));
  return /^games\/[^/]+\.json\.gz$/.test(normalized) ? normalized : null;
}

function sortIssues(issues) {
  return [...issues].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function reportFileDescriptors(season) {
  const records = season?.files?.records;
  if (!Array.isArray(records)) return null;
  const descriptors = [];
  const names = new Set();
  for (const record of records) {
    const relativePath = safeRelativeGamePath(record?.relativePath);
    const filename = relativePath?.slice('games/'.length);
    const byteLength = Number(record?.byteLength);
    const gzipSha256 = String(record?.gzipSha256 ?? '');
    const uncompressedByteLength = Number(record?.uncompressedByteLength);
    const uncompressedSha256 = String(record?.uncompressedSha256 ?? '');
    const normalizedJsonSha256 = String(record?.normalizedJsonSha256 ?? '');
    const gameId = String(record?.gameId ?? '').trim();
    if (!relativePath || !filename || names.has(filename)
      || !Number.isSafeInteger(byteLength) || byteLength < 0
      || !Number.isSafeInteger(uncompressedByteLength) || uncompressedByteLength < 0
      || !SHA256_PATTERN.test(gzipSha256)
      || !SHA256_PATTERN.test(uncompressedSha256)
      || !SHA256_PATTERN.test(normalizedJsonSha256)
      || !gameId) {
      return null;
    }
    names.add(filename);
    descriptors.push({
      filename,
      relativePath,
      gameId,
      byteLength,
      gzipSha256,
      uncompressedByteLength,
      uncompressedSha256,
      normalizedJsonSha256,
    });
  }
  descriptors.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return descriptors;
}

function aggregateHashForDescriptors(descriptors) {
  return sha256(stableJson(descriptors.map((descriptor) => ({
    relativePath: descriptor.relativePath,
    byteLength: descriptor.byteLength,
    gzipSha256: descriptor.gzipSha256,
    uncompressedByteLength: descriptor.uncompressedByteLength,
    uncompressedSha256: descriptor.uncompressedSha256,
    normalizedJsonSha256: descriptor.normalizedJsonSha256,
  }))));
}

async function loadSourceReports(sourcePaths, errors) {
  const bySeason = new Map();
  const provenance = [];
  for (const sourcePath of sourcePaths) {
    let raw;
    let report;
    try {
      raw = await fs.readFile(sourcePath, 'utf8');
      report = JSON.parse(raw);
    } catch (error) {
      issue(errors, 'source_report_unreadable', { sourceReport: asPosix(path.relative(REPOSITORY_ROOT, sourcePath)), message: String(error?.message ?? error) });
      continue;
    }
    const sourceReport = asPosix(path.relative(REPOSITORY_ROOT, sourcePath));
    const reportSha256 = sha256(raw);
    const sourceSeasons = Array.isArray(report?.seasons) ? report.seasons : [];
    provenance.push({
      sourceReport,
      sourceReportSha256: reportSha256,
      validatorVersion: report?.validatorVersion ?? null,
      passed: report?.passed === true,
      seasons: sourceSeasons.map((season) => Number(season?.seasonStartYear)).filter(Number.isInteger).sort((left, right) => left - right),
    });
    if (report?.passed !== true) issue(errors, 'source_report_not_passing', { sourceReport });
    if (report?.validatorVersion !== REQUIRED_VALIDATOR_VERSION) {
      issue(errors, 'source_report_validator_version_mismatch', { sourceReport, actual: report?.validatorVersion ?? null, expected: REQUIRED_VALIDATOR_VERSION });
    }
    for (const season of sourceSeasons) {
      const year = Number(season?.seasonStartYear);
      if (!Number.isInteger(year)) {
        issue(errors, 'source_report_invalid_season', { sourceReport });
        continue;
      }
      if (bySeason.has(year)) {
        issue(errors, 'source_reports_duplicate_season', { seasonStartYear: year });
        continue;
      }
      bySeason.set(year, { season, report, sourceReport, sourceReportSha256: reportSha256 });
    }
  }
  return { bySeason, provenance };
}

async function attestSeason({ archiveDir, expectedSeason, source, errors }) {
  const year = expectedSeason;
  const seasonDirectory = path.join(archiveDir, String(year));
  const manifestPath = path.join(seasonDirectory, 'manifest.json');
  const sourceSeason = source?.season;
  const sourceReport = source?.sourceReport;
  const descriptors = reportFileDescriptors(sourceSeason);
  if (!sourceSeason || !descriptors) {
    issue(errors, 'source_report_invalid_file_inventory', { seasonStartYear: year, sourceReport: sourceReport ?? null });
    return null;
  }
  const expectedAggregateHash = String(sourceSeason?.files?.aggregateFileHash ?? '');
  if (!SHA256_PATTERN.test(expectedAggregateHash)
    || expectedAggregateHash !== aggregateHashForDescriptors(descriptors)) {
    issue(errors, 'source_report_file_inventory_hash_mismatch', { seasonStartYear: year, sourceReport });
    return null;
  }

  let manifestRaw;
  let manifest;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    issue(errors, 'composed_manifest_unreadable', { seasonStartYear: year, message: String(error?.message ?? error) });
    return null;
  }
  if (sha256(manifestRaw) !== sourceSeason.manifestSha256) {
    issue(errors, 'composed_manifest_hash_mismatch', { seasonStartYear: year });
  }
  if (Number(manifest?.seasonStartYear) !== year || manifest?.accessLevel !== 'trial') {
    issue(errors, 'composed_manifest_scope_mismatch', { seasonStartYear: year, accessLevel: manifest?.accessLevel ?? null });
  }
  const manifestGames = manifest?.games && typeof manifest.games === 'object' && !Array.isArray(manifest.games)
    ? Object.entries(manifest.games)
    : [];
  const expectedByFilename = new Map(descriptors.map((descriptor) => [descriptor.filename, descriptor]));
  const manifestByFilename = new Map();
  for (const [gameId, entry] of manifestGames) {
    const relativePath = safeRelativeGamePath(entry?.gameFile);
    const filename = relativePath?.slice('games/'.length);
    if (entry?.status !== 'completed' || !filename || manifestByFilename.has(filename)) {
      issue(errors, 'composed_manifest_game_invalid', { seasonStartYear: year, gameId: String(gameId) });
      continue;
    }
    manifestByFilename.set(filename, String(gameId));
    const descriptor = expectedByFilename.get(filename);
    if (!descriptor || descriptor.gameId !== String(gameId)) {
      issue(errors, 'composed_manifest_game_mapping_mismatch', { seasonStartYear: year, gameId: String(gameId), relativePath });
    }
  }
  if (Number(manifest?.uniqueEligibleGames) !== descriptors.length || manifestByFilename.size !== descriptors.length) {
    issue(errors, 'composed_manifest_completed_game_count_mismatch', { seasonStartYear: year, expected: descriptors.length, actual: Number(manifest?.uniqueEligibleGames) });
  }

  const gamesDirectory = path.join(seasonDirectory, 'games');
  let actualNames;
  try {
    actualNames = (await fs.readdir(gamesDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    issue(errors, 'composed_games_directory_unreadable', { seasonStartYear: year, message: String(error?.message ?? error) });
    return null;
  }
  const expectedNames = descriptors.map((descriptor) => descriptor.filename);
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    issue(errors, 'composed_games_inventory_mismatch', { seasonStartYear: year, expected: expectedNames.length, actual: actualNames.length });
  }

  // The original source report contains both compressed and uncompressed
  // digests.  Here we verify the compressed bytes after composition; the
  // derivation loader subsequently verifies both representations while reading.
  for (const descriptor of descriptors) {
    const gamePath = path.join(gamesDirectory, descriptor.filename);
    try {
      const actual = await sha256File(gamePath);
      if (actual.bytes !== descriptor.byteLength || actual.sha256 !== descriptor.gzipSha256) {
        issue(errors, 'composed_game_gzip_hash_mismatch', { seasonStartYear: year, relativePath: descriptor.relativePath });
      }
    } catch (error) {
      issue(errors, 'composed_game_unreadable', { seasonStartYear: year, relativePath: descriptor.relativePath, message: String(error?.message ?? error) });
    }
  }
  return {
    seasonStartYear: year,
    manifestSha256: sha256(manifestRaw),
    aggregateFileHash: expectedAggregateHash,
    expectedCompletedFiles: descriptors.length,
    sourceReport,
    sourceReportSha256: source.sourceReportSha256,
  };
}

function sumSeasonTotals(seasons, field) {
  return seasons.reduce((total, season) => total + Math.max(0, Number(season?.totals?.[field] ?? 0)), 0);
}

function mergedReconstructionModules(reports) {
  const modules = {};
  for (const report of reports) {
    for (const [version, metadata] of Object.entries(report?.reconstructionModules ?? {})) {
      if (!modules[version]) modules[version] = metadata;
      else if (stableJson(modules[version]) !== stableJson(metadata)) {
        // A conflicting historical module is explicitly surfaced in the report
        // warnings rather than silently choosing one revision.
        modules[`${version}#conflict`] = metadata;
      }
    }
  }
  return modules;
}

export async function attestComposedScoutSource(options) {
  if (await exists(options.outputDir)) {
    throw new Error(`Refusing to overwrite existing attestation output: ${options.outputDir}`);
  }
  const errors = [];
  const warnings = [];
  const { bySeason, provenance } = await loadSourceReports(options.sourceReports, errors);
  const expected = [...options.expectedSeasons].sort((left, right) => left - right);
  const sourceYears = [...bySeason.keys()].sort((left, right) => left - right);
  if (stableJson(sourceYears) !== stableJson(expected)) {
    issue(errors, 'source_report_season_coverage_mismatch', { expected, actual: sourceYears });
  }
  let discoveredYears = [];
  try {
    discoveredYears = (await fs.readdir(options.archiveDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => Number.parseInt(entry.name, 10))
      .sort((left, right) => left - right);
  } catch (error) {
    issue(errors, 'composed_archive_unreadable', { archiveDir: asPosix(path.relative(REPOSITORY_ROOT, options.archiveDir)), message: String(error?.message ?? error) });
  }
  if (stableJson(discoveredYears) !== stableJson(expected)) {
    issue(errors, 'composed_archive_season_coverage_mismatch', { expected, actual: discoveredYears });
  }
  const attestedSeasons = [];
  for (const year of expected) {
    const result = await attestSeason({ archiveDir: options.archiveDir, expectedSeason: year, source: bySeason.get(year), errors });
    if (result) attestedSeasons.push(result);
  }
  for (const source of provenance) {
    if (!source.passed) warnings.push({ code: 'source_report_not_passing', sourceReport: source.sourceReport });
  }
  const selectedSourceSeasons = expected.map((year) => bySeason.get(year)?.season).filter(Boolean)
    .sort((left, right) => left.seasonStartYear - right.seasonStartYear);
  const sourceReports = options.sourceReports.map((sourcePath) => {
    const rawSource = provenance.find((entry) => entry.sourceReport === asPosix(path.relative(REPOSITORY_ROOT, sourcePath)));
    return rawSource ?? { sourceReport: asPosix(path.relative(REPOSITORY_ROOT, sourcePath)), sourceReportSha256: null };
  });
  const sourceReportPayloads = [];
  for (const sourcePath of options.sourceReports) {
    try { sourceReportPayloads.push(JSON.parse(await fs.readFile(sourcePath, 'utf8'))); } catch { /* captured above */ }
  }
  const summary = {
    seasonsValidated: selectedSourceSeasons.length,
    completedGames: selectedSourceSeasons.reduce((total, season) => total + Number(season?.files?.expectedCompletedFiles ?? 0), 0),
    compressedBytes: selectedSourceSeasons.reduce((total, season) => total + (reportFileDescriptors(season) ?? []).reduce((bytes, record) => bytes + record.byteLength, 0), 0),
    uncompressedBytes: selectedSourceSeasons.reduce((total, season) => total + (reportFileDescriptors(season) ?? []).reduce((bytes, record) => bytes + record.uncompressedByteLength, 0), 0),
    events: sumSeasonTotals(selectedSourceSeasons, 'events'),
    stints: sumSeasonTotals(selectedSourceSeasons, 'stints'),
    possessions: sumSeasonTotals(selectedSourceSeasons, 'possessions'),
    players: sumSeasonTotals(selectedSourceSeasons, 'players'),
    lineups: sumSeasonTotals(selectedSourceSeasons, 'lineups'),
    compositionAttestation: {
      verifiedCompressedGameFiles: attestedSeasons.reduce((total, season) => total + season.expectedCompletedFiles, 0),
      sourceReports: sourceReports.length,
    },
  };
  const report = {
    validatorVersion: REQUIRED_VALIDATOR_VERSION,
    attestationVersion: ATTESTATION_VERSION,
    generatedAt: new Date().toISOString(),
    passed: errors.length === 0,
    networkAccess: { requested: false, performed: false },
    archiveScope: {
      archiveDataDirectory: asPosix(path.relative(path.dirname(options.archiveDir), options.archiveDir)) || path.basename(options.archiveDir),
      seasons: discoveredYears,
    },
    compositionAttestation: {
      mode: 'prior_full_source_validations_plus_composed_gzip_hash_binding',
      sourceReports,
      seasons: attestedSeasons,
      limits: [
        'This report does not claim a second independent PBP replay after composition.',
        'Each input source report must already be a passing full v4 validation.',
        'The Scout derivation re-verifies compressed and uncompressed source hashes before model calculation.',
      ],
    },
    reconstructionModules: mergedReconstructionModules(sourceReportPayloads),
    seasons: selectedSourceSeasons,
    summary,
    errors: sortIssues(errors),
    warnings: sortIssues(warnings),
  };
  const reportPath = path.join(options.outputDir, 'checkpoint-validation-report.json');
  const summaryPath = path.join(options.outputDir, 'checkpoint-validation-summary.md');
  await fs.mkdir(options.outputDir, { recursive: false });
  await writeAtomic(reportPath, `${JSON.stringify(JSON.parse(stableJson(report)), null, 2)}\n`);
  const markdown = [
    '# Composed Scout source attestation',
    '',
    `- Passed: ${report.passed ? 'yes' : 'no'}`,
    `- Seasons: ${report.archiveScope.seasons.join(', ') || '(none)'}`,
    `- Completed game files bound: ${summary.compositionAttestation.verifiedCompressedGameFiles}`,
    `- Input full source reports: ${sourceReports.length}`,
    `- Errors: ${report.errors.length}; warnings: ${report.warnings.length}.`,
    '',
    'This is a composition binding report, not a substitute for the prior full source validations.',
  ].join('\n');
  await writeAtomic(summaryPath, `${markdown}\n`);
  return { report, reportPath, summaryPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const options = parseArgs(process.argv.slice(2));
  attestComposedScoutSource(options).then(({ report, reportPath }) => {
    process.stdout.write(`${JSON.stringify({
      passed: report.passed,
      seasons: report.archiveScope.seasons,
      completedGames: report.summary.completedGames,
      errors: report.errors.length,
      warnings: report.warnings.length,
      report: asPosix(path.relative(REPOSITORY_ROOT, reportPath)),
    })}\n`);
    if (!report.passed) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`Composed Scout source attestation failed: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
