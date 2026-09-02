import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
  reconstructNbaGameLineups,
  sortPbpEvents,
} from './lib/nba-lineup-reconstruction.mjs';
import { selectPossessionObservedBoundaryLineups } from './derive-local-scout-analytics.mjs';

const INCLUDED_PHASES = new Set(['regular', 'in_season_tournament', 'play_in', 'playoffs']);
const REPAIR_VERSION = 'possession_observed_boundary_role_repair_v1';
const MODULE_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MODULE_PATH);

function optionError(message) {
  throw new Error(`${message}\nUsage: node scripts/repair-scout-boundary-role-counts.mjs --source-dir <existing-package> --archive-dir <archive-root> --season 2025 [--output-dir <new-package>] [--apply]`);
}

export function optionsFromArgs(argv) {
  const options = {
    sourceDir: null,
    archiveDir: null,
    seasonStartYear: null,
    outputDir: null,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') {
      options.apply = true;
      continue;
    }
    const [name, inlineValue] = token.split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) optionError(`${name} requires a value.`);
    if (name === '--source-dir') options.sourceDir = path.resolve(value);
    else if (name === '--archive-dir') options.archiveDir = path.resolve(value);
    else if (name === '--season') options.seasonStartYear = Number.parseInt(value, 10);
    else if (name === '--output-dir') options.outputDir = path.resolve(value);
    else optionError(`Unknown option: ${name}`);
  }
  if (!options.sourceDir) optionError('--source-dir is required.');
  if (!options.archiveDir) optionError('--archive-dir is required.');
  if (!Number.isInteger(options.seasonStartYear) || options.seasonStartYear < 1947) optionError('--season must be a valid NBA season start year.');
  if (options.apply && !options.outputDir) optionError('--output-dir is required with --apply.');
  return options;
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

async function gzipFile(sourcePath, destinationPath) {
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 9 }),
    createWriteStream(destinationPath),
  );
  return fileSha256AndSize(destinationPath);
}

function requestGarbageCollection() {
  if (typeof global.gc === 'function') global.gc();
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratioOrNull(numerator, denominator, digits = 3) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? round(numerator / denominator, digits)
    : null;
}

function sortedUnique(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function exactLineup(lineupId, lineups) {
  const ids = sortedUnique(lineups.get(lineupId)?.playerIds);
  return ids.length === 5 ? ids : null;
}

function comboKey(teamId, ids) {
  return `${teamId}~${ids.length}~${ids.join('|')}`;
}

function playerKey(teamId, playerId) {
  return `${teamId}~${playerId}`;
}

function isOfficialFranchiseTeam(team) {
  return /^sr:team:\d+$/i.test(String(team?.srId ?? '').trim());
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function safeRelativeFile(root, relativePath, label) {
  const resolved = path.resolve(root, String(relativePath ?? ''));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the package directory.`);
  }
  return { resolved, relative };
}

async function readPackageManifest(sourceDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^nba-scout-analytics-\d{4}-\d{2}\.json$/i.test(entry.name))
    .map((entry) => path.join(sourceDir, entry.name));
  if (candidates.length !== 1) throw new Error(`Expected exactly one package manifest in ${sourceDir}; found ${candidates.length}.`);
  const manifestPath = candidates[0];
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (manifest?.storage?.format !== 'schema_v4_streamed_team_shards_with_manifest') {
    throw new Error('The source package is not the expected streamed Scout schema-v4 package.');
  }
  if (!Array.isArray(manifest.dataShards) || !manifest.dataShards.length) {
    throw new Error('The source package does not have a team-shard manifest.');
  }
  return { manifestPath, manifest, raw };
}

async function readCompressedJson(filePath) {
  return JSON.parse(gunzipSync(await fs.readFile(filePath)).toString('utf8'));
}

/**
 * Replays only the small source slice needed to define first/final
 * possession-observed lineups. It deliberately does not derive combinations,
 * ratings, RAPM, or direct player event statistics.
 */
export async function deriveBoundaryRoleCounts({ archiveDir, seasonStartYear }) {
  const gamesDirectory = path.join(archiveDir, String(seasonStartYear), 'games');
  const entries = (await fs.readdir(gamesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const playerStarterCounts = new Map();
  const playerCloserCounts = new Map();
  const lineupStarterCounts = new Map();
  const lineupCloserCounts = new Map();
  const eligibleGameIds = new Set();
  let phaseCandidates = 0;
  let officialCandidates = 0;

  for (const entry of entries) {
    const filename = entry.name;
    const record = await readCompressedJson(path.join(gamesDirectory, filename));
    const game = record.game ?? {};
    const phase = String(game.primaryPhase ?? '').trim().toLowerCase();
    if (!INCLUDED_PHASES.has(phase)) continue;
    phaseCandidates += 1;
    const teams = new Map((record.teams ?? []).map((team) => [team.id, team]));
    const homeTeamId = String(game.homeProviderTeamId ?? '');
    const awayTeamId = String(game.awayProviderTeamId ?? '');
    if (!isOfficialFranchiseTeam(teams.get(homeTeamId)) || !isOfficialFranchiseTeam(teams.get(awayTeamId))) continue;
    officialCandidates += 1;

    const replayEvents = sortPbpEvents(record.events ?? []);
    const replay = reconstructNbaGameLineups({
      gameId: game.providerGameId || filename,
      homeTeamId: game.homeProviderTeamId,
      awayTeamId: game.awayProviderTeamId,
      status: game.status,
      coverage: game.coverage,
      trackOnCourt: game.trackOnCourt,
      expectedFinalScore: { homePoints: game.homePoints, awayPoints: game.awayPoints },
      providerTeamPossessions: { home: teams.get(homeTeamId)?.possessions, away: teams.get(awayTeamId)?.possessions },
      providerPlayerMinutes: record.players,
      events: replayEvents,
    });
    if (replay.isEligible !== true) continue;
    const gameId = String(game.providerGameId || filename);
    if (eligibleGameIds.has(gameId)) throw new Error(`Duplicate eligible source game id: ${gameId}`);
    eligibleGameIds.add(gameId);

    const lineups = new Map((replay.lineupDefinitions ?? []).map((lineup) => [lineup.id, lineup]));
    const exactStints = (replay.stints ?? [])
      .map((stint, index) => ({
        index,
        ordinal: Number.isFinite(Number(stint?.stintOrdinal)) ? Number(stint.stintOrdinal) : index,
        homeIds: exactLineup(stint?.homeLineupId, lineups),
        awayIds: exactLineup(stint?.awayLineupId, lineups),
      }))
      .filter((stint) => stint.homeIds && stint.awayIds)
      .sort((left, right) => left.ordinal - right.ordinal || left.index - right.index);
    const observedByTeam = new Map([[homeTeamId, new Set()], [awayTeamId, new Set()]]);
    for (const possession of replay.possessions ?? []) {
      const homeIds = exactLineup(possession.homeLineupId, lineups);
      const awayIds = exactLineup(possession.awayLineupId, lineups);
      // This mirrors the production derivation: both sides must be a verified
      // exact lineup before a possession contributes to Scout aggregates.
      if (!homeIds || !awayIds) continue;
      observedByTeam.get(homeTeamId).add(comboKey(homeTeamId, homeIds));
      observedByTeam.get(awayTeamId).add(comboKey(awayTeamId, awayIds));
    }
    for (const [teamId, exactLineups] of [
      [homeTeamId, exactStints.map((stint) => stint.homeIds)],
      [awayTeamId, exactStints.map((stint) => stint.awayIds)],
    ]) {
      const { starterIds, closerIds } = selectPossessionObservedBoundaryLineups({
        teamId,
        exactLineups,
        observedLineupKeys: observedByTeam.get(teamId),
      });
      if (starterIds) {
        increment(lineupStarterCounts, comboKey(teamId, starterIds));
        for (const playerId of starterIds) increment(playerStarterCounts, playerKey(teamId, playerId));
      }
      if (closerIds) {
        increment(lineupCloserCounts, comboKey(teamId, closerIds));
        for (const playerId of closerIds) increment(playerCloserCounts, playerKey(teamId, playerId));
      }
    }
    requestGarbageCollection();
  }
  return {
    sourceFiles: entries.length,
    phaseCandidates,
    officialCandidates,
    eligibleGames: eligibleGameIds.size,
    playerStarterCounts,
    playerCloserCounts,
    lineupStarterCounts,
    lineupCloserCounts,
  };
}

function updateField(target, field, value, changes) {
  if (target[field] === value || (Number.isNaN(target[field]) && Number.isNaN(value))) return;
  changes.push({ field, before: target[field], after: value });
  target[field] = value;
}

/**
 * Mutates one parsed team shard with role-only fields. This is intentionally
 * narrow: all possession/rating/RAPM/WOWY/player-event fields remain bytewise
 * derived from the completed source package.
 */
export function applyBoundaryRoleCountsToShard(shard, counts) {
  const teamId = String(shard?.team?.teamId ?? '');
  if (!teamId) throw new Error('Team shard is missing team.teamId.');
  const changes = [];
  const seenPlayerKeys = new Set();
  const seenLineupKeys = new Set();
  const roleCaveat = 'Starting and closing counts use the first and final verified exact-lineup stint observed at a possession start in each eligible game; zero-possession dead-ball lineups are excluded.';

  for (const row of shard.lineupsAndCombinations ?? []) {
    if (row?.size !== 5) continue;
    const ids = sortedUnique(row.playerIds);
    if (ids.length !== 5) throw new Error(`Invalid exact lineup row in ${teamId}.`);
    const key = comboKey(teamId, ids);
    seenLineupKeys.add(key);
    const continuity = row.continuity;
    if (!continuity || typeof continuity !== 'object') throw new Error(`Exact lineup ${key} is missing continuity data.`);
    const games = Number(row.contexts?.all?.games);
    if (!Number.isFinite(games) || games < 0) throw new Error(`Exact lineup ${key} has invalid games-used coverage.`);
    const starters = counts.lineupStarterCounts.get(key) ?? 0;
    const closers = counts.lineupCloserCounts.get(key) ?? 0;
    if (starters > games || closers > games) throw new Error(`Boundary role count exceeds games used for ${key}.`);
    const rowChanges = [];
    updateField(continuity, 'exactLineupStartingGames', starters, rowChanges);
    updateField(continuity, 'exactLineupClosingGames', closers, rowChanges);
    updateField(continuity, 'exactLineupStartRate', ratioOrNull(starters, games, 4), rowChanges);
    updateField(continuity, 'exactLineupCloseRate', ratioOrNull(closers, games, 4), rowChanges);
    if (rowChanges.length) {
      updateField(continuity, 'caveat', roleCaveat, rowChanges);
      changes.push({ type: 'exact_lineup', key, changes: rowChanges });
    }
  }

  for (const row of shard.playerProfiles ?? []) {
    const playerId = String(row?.playerId ?? '');
    if (!playerId) throw new Error(`Player profile in ${teamId} is missing playerId.`);
    const key = playerKey(teamId, playerId);
    seenPlayerKeys.add(key);
    const games = Number(row.gamesAppeared);
    if (!Number.isInteger(games) || games < 0) throw new Error(`Player profile ${key} has invalid gamesAppeared.`);
    const starters = counts.playerStarterCounts.get(key) ?? 0;
    const closers = counts.playerCloserCounts.get(key) ?? 0;
    if (starters > games || closers > games) throw new Error(`Boundary role count exceeds games appeared for ${key}.`);
    const rowChanges = [];
    updateField(row, 'starterGames', starters, rowChanges);
    updateField(row, 'closerGames', closers, rowChanges);
    updateField(row, 'starterGameRate', ratioOrNull(starters, games, 4), rowChanges);
    updateField(row, 'closerGameRate', ratioOrNull(closers, games, 4), rowChanges);
    if (rowChanges.length) changes.push({ type: 'player_profile', key, changes: rowChanges });
  }

  for (const [key, count] of counts.playerStarterCounts) {
    if (count > 0 && key.startsWith(`${teamId}~`) && !seenPlayerKeys.has(key)) {
      throw new Error(`Expected starter profile is absent from ${teamId}: ${key}.`);
    }
  }
  for (const [key, count] of counts.playerCloserCounts) {
    if (count > 0 && key.startsWith(`${teamId}~`) && !seenPlayerKeys.has(key)) {
      throw new Error(`Expected closer profile is absent from ${teamId}: ${key}.`);
    }
  }
  for (const [key, count] of counts.lineupStarterCounts) {
    if (count > 0 && key.startsWith(`${teamId}~`) && !seenLineupKeys.has(key)) {
      throw new Error(`Expected starter lineup is absent from ${teamId}: ${key}.`);
    }
  }
  for (const [key, count] of counts.lineupCloserCounts) {
    if (count > 0 && key.startsWith(`${teamId}~`) && !seenLineupKeys.has(key)) {
      throw new Error(`Expected closer lineup is absent from ${teamId}: ${key}.`);
    }
  }
  return { changes, changed: changes.length > 0 };
}

async function inspectRepairPlan({ sourceDir, manifest, counts }) {
  const changedDescriptors = [];
  const allChanges = [];
  for (const descriptor of manifest.dataShards) {
    const { resolved: shardPath } = safeRelativeFile(sourceDir, descriptor.jsonPath, 'Team shard JSON path');
    const shard = JSON.parse(await fs.readFile(shardPath, 'utf8'));
    const result = applyBoundaryRoleCountsToShard(shard, counts);
    if (result.changed) {
      changedDescriptors.push(descriptor);
      allChanges.push({ teamId: descriptor.teamId, team: descriptor.team, changes: result.changes });
    }
    requestGarbageCollection();
  }
  return { changedDescriptors, allChanges };
}

async function assertDirectoryAbsent(directory) {
  try {
    await fs.stat(directory);
    throw new Error(`Refusing to overwrite existing output directory: ${directory}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function linkFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.link(source, destination);
  } catch (error) {
    if (error?.code === 'EXDEV') {
      throw new Error(`Cannot create a safe local hard-link package across volumes: ${source} -> ${destination}`);
    }
    throw error;
  }
}

async function linkBasePackage({ sourceDir, stagingDirectory, manifestPath, manifest }) {
  const manifestRelative = path.relative(sourceDir, manifestPath);
  const files = [
    manifestRelative,
    `${manifestRelative}.gz`,
    'README.md',
    ...manifest.dataShards.flatMap((descriptor) => [descriptor.jsonPath, descriptor.gzipPath]),
  ];
  for (const relativePath of files) {
    const source = safeRelativeFile(sourceDir, relativePath, 'Package file path').resolved;
    const destination = safeRelativeFile(stagingDirectory, relativePath, 'Staged package file path').resolved;
    await linkFile(source, destination);
  }
}

async function replaceHardLinkedFile(destination, contents) {
  const temporary = `${destination}.repair-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temporary, contents);
  await fs.unlink(destination);
  await fs.rename(temporary, destination);
}

async function rewriteChangedShard({ sourceDir, stagingDirectory, descriptor, counts }) {
  const sourcePath = safeRelativeFile(sourceDir, descriptor.jsonPath, 'Team shard JSON path').resolved;
  const targetPath = safeRelativeFile(stagingDirectory, descriptor.jsonPath, 'Staged team shard JSON path').resolved;
  const targetGzipPath = safeRelativeFile(stagingDirectory, descriptor.gzipPath, 'Staged team shard gzip path').resolved;
  const shard = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  const result = applyBoundaryRoleCountsToShard(shard, counts);
  if (!result.changed) throw new Error(`Repair plan drift: ${descriptor.team} no longer needs a change.`);
  const raw = `${JSON.stringify(shard)}\n`;
  await replaceHardLinkedFile(targetPath, raw);
  const json = { bytes: Buffer.byteLength(raw), sha256: sha256(raw) };

  const gzipTemporary = `${targetGzipPath}.repair-${process.pid}-${Date.now()}.tmp`;
  await gzipFile(targetPath, gzipTemporary);
  await fs.unlink(targetGzipPath);
  await fs.rename(gzipTemporary, targetGzipPath);
  const gzip = await fileSha256AndSize(targetGzipPath);
  return {
    ...descriptor,
    jsonBytes: json.bytes,
    jsonSha256: json.sha256,
    gzipBytes: gzip.bytes,
    gzipSha256: gzip.sha256,
    repairChanges: result.changes,
  };
}

function refreshReadme(readme, { manifestBytes, manifestHash, gzipBytes, gzipHash, shardCount, shardJsonBytes, shardGzipBytes, changedTeamCount }) {
  const replacements = [
    [/^- Manifest JSON:.*$/m, `- Manifest JSON: ${manifestBytes} bytes, SHA-256 ${manifestHash}.`],
    [/^- Manifest gzip:.*$/m, `- Manifest gzip: ${gzipBytes} bytes, SHA-256 ${gzipHash}.`],
    [/^- Team shards:.*$/m, `- Team shards: ${shardCount}; JSON bytes: ${shardJsonBytes}; gzip bytes: ${shardGzipBytes}.`],
  ];
  let result = readme;
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(result)) throw new Error(`README is missing a repairable line: ${pattern}.`);
    result = result.replace(pattern, replacement);
  }
  const repairLine = `- Boundary-role repair: ${REPAIR_VERSION}; role-only source replay corrected ${changedTeamCount} team shard(s) without recomputing possession, rating, RAPM, WOWY, or player-event fields.\n`;
  if (!result.includes(repairLine)) result = result.replace('- Packaging:', `${repairLine}- Packaging:`);
  return result;
}

async function buildRepairedPackage({ options, manifestPath, manifest, counts, plan }) {
  await assertDirectoryAbsent(options.outputDir);
  const parent = path.dirname(options.outputDir);
  await fs.mkdir(parent, { recursive: true });
  const stagingDirectory = await fs.mkdtemp(path.join(parent, `${path.basename(options.outputDir)}.partial-`));
  await linkBasePackage({
    sourceDir: options.sourceDir,
    stagingDirectory,
    manifestPath,
    manifest,
  });

  const descriptorByPath = new Map();
  for (const descriptor of plan.changedDescriptors) {
    const updated = await rewriteChangedShard({
      sourceDir: options.sourceDir,
      stagingDirectory,
      descriptor,
      counts,
    });
    descriptorByPath.set(descriptor.jsonPath, updated);
    requestGarbageCollection();
  }

  const output = structuredClone(manifest);
  output.dataShards = output.dataShards.map((descriptor) => {
    const updated = descriptorByPath.get(descriptor.jsonPath);
    if (!updated) return descriptor;
    const { repairChanges, ...cleanDescriptor } = updated;
    return cleanDescriptor;
  });
  const shardJsonBytes = output.dataShards.reduce((total, descriptor) => total + descriptor.jsonBytes, 0);
  const shardGzipBytes = output.dataShards.reduce((total, descriptor) => total + descriptor.gzipBytes, 0);
  output.storage = {
    ...output.storage,
    shardCount: output.dataShards.length,
    shardJsonBytes,
    shardGzipBytes,
  };
  output.quality = {
    ...(output.quality ?? {}),
    boundaryRoleCountRepair: {
      version: REPAIR_VERSION,
      definition: 'First and final verified exact five-player lineup observed at a possession start in each Scout-eligible game; zero-possession dead-ball lineups are excluded.',
      sourceReconstructionMethodVersion: NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
      sourceFiles: counts.sourceFiles,
      phaseCandidates: counts.phaseCandidates,
      officialCandidates: counts.officialCandidates,
      eligibleGames: counts.eligibleGames,
      changedTeams: plan.allChanges.map((change) => ({ teamId: change.teamId, team: change.team })),
    },
  };

  const manifestRelative = path.relative(options.sourceDir, manifestPath);
  const targetManifestPath = safeRelativeFile(stagingDirectory, manifestRelative, 'Staged manifest path').resolved;
  const targetManifestGzipPath = `${targetManifestPath}.gz`;
  const outputRaw = `${JSON.stringify(output)}\n`;
  await replaceHardLinkedFile(targetManifestPath, outputRaw);
  const manifestBytes = Buffer.byteLength(outputRaw);
  const manifestHash = sha256(outputRaw);
  const manifestGzipTemporary = `${targetManifestGzipPath}.repair-${process.pid}-${Date.now()}.tmp`;
  await gzipFile(targetManifestPath, manifestGzipTemporary);
  await fs.unlink(targetManifestGzipPath);
  await fs.rename(manifestGzipTemporary, targetManifestGzipPath);
  const manifestGzip = await fileSha256AndSize(targetManifestGzipPath);

  const sourceReadmePath = path.join(options.sourceDir, 'README.md');
  const targetReadmePath = path.join(stagingDirectory, 'README.md');
  const refreshedReadme = refreshReadme(await fs.readFile(sourceReadmePath, 'utf8'), {
    manifestBytes,
    manifestHash,
    gzipBytes: manifestGzip.bytes,
    gzipHash: manifestGzip.sha256,
    shardCount: output.dataShards.length,
    shardJsonBytes,
    shardGzipBytes,
    changedTeamCount: plan.changedDescriptors.length,
  });
  await replaceHardLinkedFile(targetReadmePath, refreshedReadme);

  const report = {
    repairVersion: REPAIR_VERSION,
    sourcePackageDirectory: options.sourceDir,
    outputPackageDirectory: options.outputDir,
    sourceReplay: {
      sourceFiles: counts.sourceFiles,
      phaseCandidates: counts.phaseCandidates,
      officialCandidates: counts.officialCandidates,
      eligibleGames: counts.eligibleGames,
      reconstructionMethodVersion: NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
    },
    changedTeamCount: plan.changedDescriptors.length,
    changes: plan.allChanges,
    storage: {
      shardCount: output.dataShards.length,
      shardJsonBytes,
      shardGzipBytes,
      manifestBytes,
      manifestHash,
      manifestGzipBytes: manifestGzip.bytes,
      manifestGzipHash: manifestGzip.sha256,
    },
    caveat: 'The repaired package is a hard-link clone of unchanged source files. Changed files were materialized independently, so the source package was not modified.',
  };
  await fs.writeFile(path.join(stagingDirectory, 'boundary-role-repair-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.rename(stagingDirectory, options.outputDir);
  return report;
}

export async function runBoundaryRoleRepair(options) {
  const { manifestPath, manifest } = await readPackageManifest(options.sourceDir);
  if (manifest.scope?.seasonStartYear !== options.seasonStartYear) {
    throw new Error(`Source package season ${manifest.scope?.seasonStartYear} does not match requested ${options.seasonStartYear}.`);
  }
  const counts = await deriveBoundaryRoleCounts(options);
  if (counts.eligibleGames !== manifest.coverage?.archivesEligible) {
    throw new Error(`Role-only replay found ${counts.eligibleGames} eligible games; source package declares ${manifest.coverage?.archivesEligible}.`);
  }
  const plan = await inspectRepairPlan({ sourceDir: options.sourceDir, manifest, counts });
  const dryRun = {
    repairVersion: REPAIR_VERSION,
    sourceReplay: {
      sourceFiles: counts.sourceFiles,
      phaseCandidates: counts.phaseCandidates,
      officialCandidates: counts.officialCandidates,
      eligibleGames: counts.eligibleGames,
      reconstructionMethodVersion: NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
    },
    changedTeamCount: plan.changedDescriptors.length,
    changes: plan.allChanges,
    apply: options.apply,
  };
  if (!options.apply) return dryRun;
  return buildRepairedPackage({ options, manifestPath, manifest, counts, plan });
}

if (IS_MAIN) {
  const options = optionsFromArgs(process.argv.slice(2));
  runBoundaryRoleRepair(options)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.stack ?? error)}\n`);
      process.exitCode = 1;
    });
}
