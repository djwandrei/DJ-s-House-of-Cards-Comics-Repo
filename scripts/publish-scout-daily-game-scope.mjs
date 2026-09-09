#!/usr/bin/env node

// Build and publish the buyer-safe input catalog for Scout Daily Games.  The
// source package is read locally, while only the deliberately bounded public
// stats and private O/D values required by the service-only RPC cross the
// network.  The database RPC keeps the O/D values behind the Edge Function.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SEASON_START_YEARS = Object.freeze([2020, 2021, 2022, 2023, 2024, 2025]);
const SEASON_END_YEARS = Object.freeze(SEASON_START_YEARS.map(year => year + 1));
const ALLOWED_POSITIONS = new Set(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']);
const TEAM_CODES = Object.freeze({
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
  'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
  'Detroit Pistons': 'DET', 'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'LA Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA',
  'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK',
  'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR',
  'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
});
const PUBLIC_STAT_KEYS = Object.freeze([
  ['games', row => row.games], ['minutes', row => row.officialMinutes],
  ['points', row => row.perGame?.points], ['rebounds', row => row.perGame?.rebounds],
  ['assists', row => row.perGame?.assists], ['steals', row => row.perGame?.steals],
  ['blocks', row => row.perGame?.blocks], ['turnovers', row => row.perGame?.turnovers],
  ['efgPct', row => row.officialRates?.effectiveFieldGoalPercentage],
  ['threePct', row => row.officialRates?.threePointPercentage],
]);
const SEASON_PHASE = 'regular_in_season_tournament_play_in_playoffs_official_franchise_sportradar-nba-lineup-reconstruction-v3_possession_start_lineups';
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function usage() {
  return `Usage:
  node .\\scripts\\publish-scout-daily-game-scope.mjs --manifest <path> --source-validation <path> [options]

Options:
  --manifest <path>            Validated 2020-26 Scout manifest (required)
  --source-validation <path>   Matching source-validation report (required)
  --env-file <path>            Credential env file (default: codex_account_keys.env)
  --scope-key <key>            Scope key (default: scout-2020-26-v2)
  --apply                      Register, ingest, and publish the scope remotely
  --help                       Show this help

Dry-run is the default. --apply requires SCOUT_DAILY_GAME_IMPORT_ALLOW_WRITE=confirmed.
`;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? '');
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values.set(name, inline);
    else if (argv[index + 1] && !String(argv[index + 1]).startsWith('--')) values.set(name, argv[++index]);
    else flags.add(name);
  }
  if (flags.has('help')) return { help: true };
  const known = new Set(['manifest', 'source-validation', 'env-file', 'scope-key', 'apply', 'help']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  const manifest = workspacePath(values.get('manifest'), '--manifest');
  const sourceValidation = workspacePath(values.get('source-validation'), '--source-validation');
  const envFile = workspacePath(values.get('env-file') || 'codex_account_keys.env', '--env-file');
  const scopeKey = String(values.get('scope-key') || 'scout-2020-26-v2').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,95}$/.test(scopeKey)) throw new Error('--scope-key is invalid.');
  return { help: false, manifest, sourceValidation, envFile, scopeKey, apply: flags.has('apply') };
}

function workspacePath(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${label} is required.`);
  const resolved = path.resolve(raw);
  const relative = path.relative(path.resolve(ROOT), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside this workspace.`);
  }
  return resolved;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function rounded(value, places = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** places;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function requiredEnv(env, names) {
  for (const name of names) {
    const value = String(env[name] || '').trim();
    if (value) return value;
  }
  throw new Error(`${names.join(' or ')} is required in the credential environment.`);
}

function teamCode(teamName) {
  const code = TEAM_CODES[teamName];
  if (!code) throw new Error(`The validated package has an unmapped NBA team: ${teamName}.`);
  return code;
}

function normalizePositions(value) {
  const positions = [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || '').trim().toUpperCase()).filter(Boolean))];
  if (!positions.length || positions.length > 3 || positions.some(position => !ALLOWED_POSITIONS.has(position))) return null;
  return positions;
}

function chooseProfile(current, candidate) {
  if (!current) return candidate;
  const currentRegular = current.phase === 'regular';
  const candidateRegular = candidate.phase === 'regular';
  if (candidateRegular !== currentRegular) return candidateRegular ? candidate : current;
  const currentGames = Number(current.games) || 0;
  const candidateGames = Number(candidate.games) || 0;
  if (candidateGames !== currentGames) return candidateGames > currentGames ? candidate : current;
  const currentMinutes = Number(current.officialMinutes) || 0;
  const candidateMinutes = Number(candidate.officialMinutes) || 0;
  return candidateMinutes > currentMinutes ? candidate : current;
}

function publicStats(row) {
  const stats = {};
  for (const [key, read] of PUBLIC_STAT_KEYS) {
    const value = read(row);
    if (finite(value) && value >= 0) stats[key] = rounded(value, 3);
  }
  return stats;
}

async function buildRows(options, manifest) {
  const shards = Array.isArray(manifest.dataShards) ? manifest.dataShards : [];
  const teams = new Map(shards.map(shard => [shard.teamId, { name: String(shard.team || '').trim(), code: teamCode(String(shard.team || '').trim()) }]));
  if (teams.size !== 30) throw new Error('The validated package must contain exactly 30 mapped team shards.');
  const odPlayers = manifest.rapm?.offenseDefense?.players;
  if (!Array.isArray(odPlayers) || !odPlayers.length) throw new Error('The validated package has no O/D player table.');
  const od = new Map();
  for (const player of odPlayers) {
    const id = String(player.providerPlayerId || '').trim();
    if (!id || od.has(id) || !finite(player.offensiveRapmPer100) || !finite(player.defensiveRapmPer100)
      || !finite(player.pairedPossessions) || player.pairedPossessions < 0) throw new Error('The validated O/D player table is malformed.');
    od.set(id, player);
  }
  const evidenceFile = path.resolve(path.dirname(options.manifest), manifest.modelEvidence?.files?.playerSeasonSkillProfiles?.path || 'model-evidence/playerSeasonSkillProfiles.jsonl.gz');
  const selected = new Map();
  const input = fs.createReadStream(evidenceFile).pipe(createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const seasonStartYear = Number(row.seasonStartYear);
    if (row.teamId === 'ALL_TEAMS' || !SEASON_START_YEARS.includes(seasonStartYear) || !teams.has(row.teamId)) continue;
    if (!od.has(row.playerId)) continue;
    const key = `${row.playerId}|${seasonStartYear}|${row.teamId}`;
    selected.set(key, chooseProfile(selected.get(key), row));
  }
  const rows = [];
  const identity = new Set();
  for (const row of selected.values()) {
    const model = od.get(row.playerId);
    const team = teams.get(row.teamId);
    const positions = normalizePositions(row.listedPositions);
    const name = String(row.names?.[0] || '').trim();
    const endYear = Number(row.seasonStartYear) + 1;
    if (!positions || name.length < 2 || name.length > 160 || !SEASON_END_YEARS.includes(endYear)) continue;
    if (!model.displayEligible || Number(model.pairedPossessions) < Number(model.displayMinimumPairedPossessions || 200)) continue;
    const lowerIdentity = `${endYear}|${team.code}|${name.toLocaleLowerCase()}`;
    if (identity.has(lowerIdentity)) throw new Error('The selected evidence contains duplicate player identities within a team season.');
    identity.add(lowerIdentity);
    const scout = {
      source_season_end_year: endYear,
      team_code: team.code,
      team_name: team.name,
      franchise_key: team.code.toLowerCase(),
      player_name: name,
      positions,
      public_stats: publicStats(row),
      offensive_rapm_per_100: rounded(model.offensiveRapmPer100),
      defensive_rapm_per_100: rounded(model.defensiveRapmPer100),
      paired_possessions: rounded(model.pairedPossessions, 3),
      display_eligible: true,
    };
    if (!finite(scout.offensive_rapm_per_100) || !finite(scout.defensive_rapm_per_100)
      || scout.offensive_rapm_per_100 < -100 || scout.offensive_rapm_per_100 > 100
      || scout.defensive_rapm_per_100 < -100 || scout.defensive_rapm_per_100 > 100) {
      throw new Error('The validated O/D values are outside the database safety bounds.');
    }
    rows.push(scout);
  }
  rows.sort((left, right) => left.source_season_end_year - right.source_season_end_year
    || left.team_code.localeCompare(right.team_code) || left.player_name.localeCompare(right.player_name));
  if (rows.length < 15) throw new Error('The validated package produced too few display-eligible players.');
  const bySeason = Object.fromEntries(SEASON_END_YEARS.map(year => [year, rows.filter(row => row.source_season_end_year === year).length]));
  return { rows, bySeason, selectedProfiles: selected.size, evidenceFile };
}

function modelPayload(options, manifest, sourceValidationSha256, expectedPlayerCount) {
  const artifact = String(manifest.rapm?.offenseDefense?.inputSha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(artifact)) throw new Error('The validated manifest has no usable O/D artifact digest.');
  return {
    scopeKey: options.scopeKey,
    publicLabel: 'Validated Scout O/D model · 2020–26',
    modelVersion: `${manifest.rapm.offenseDefense.modelVersion} · 2020–26`,
    modelArtifactSha256: artifact,
    modelScopeKind: 'combined-window',
    sourceSeasonEndYears: [...SEASON_END_YEARS],
    sourceValidationPassed: true,
    sourceValidationReportSha256: sourceValidationSha256,
    calibrationStatus: 'validated',
    calibrationAllComponentsImproved: true,
    seasonPhase: SEASON_PHASE,
    expectedPlayerCount,
  };
}

async function rpc(url, key, functionName, payload, { attempts = 3 } = {}) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
        method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      const body = await response.text();
      lastStatus = response.status;
      if (response.ok) return body ? JSON.parse(body) : null;
      if (!TRANSIENT_STATUSES.has(response.status) || attempt === attempts) {
        throw new Error(`Analytics RPC ${functionName} failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      if (attempt === attempts && error?.name === 'AbortError') throw new Error(`Analytics RPC ${functionName} timed out.`);
      if (attempt === attempts && error?.message?.startsWith('Analytics RPC')) throw error;
      if (attempt === attempts) throw new Error(`Analytics RPC ${functionName} failed${lastStatus ? ` with HTTP ${lastStatus}` : ''}.`);
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }
  throw new Error(`Analytics RPC ${functionName} failed.`);
}

async function publish(options, manifest, sourceValidationSha256, rows) {
  const env = { ...parseEnvFile(options.envFile), ...process.env };
  const url = requiredEnv(env, ['SUPABASE_URL_2', 'NBA_ANALYTICS_SUPABASE_URL']).replace(/\/+$/, '');
  const key = requiredEnv(env, ['SUPABASE_SERVICE_ROLE_KEY_2', 'SUPABASE_SERVICE_ROLE_KEY']);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('The analytics Supabase URL is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'fbbmuqbdpgsmvnezowwn.supabase.co') {
    throw new Error('The daily-game publisher is restricted to the dedicated analytics Supabase project.');
  }
  const payload = modelPayload(options, manifest, sourceValidationSha256, rows.length);
  const scopeId = await rpc(url, key, 'register_nba_scout_daily_game_scope', { p_payload: payload });
  if (typeof scopeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(scopeId)) throw new Error('Analytics scope registration returned no scope id.');
  const chunkSize = 500;
  let ingested = 0;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const count = await rpc(url, key, 'ingest_nba_scout_daily_game_players', {
      p_scope_id: scopeId, p_rows: rows.slice(offset, offset + chunkSize),
    });
    if (Number(count) !== Math.min(chunkSize, rows.length - offset)) throw new Error('Analytics ingestion count did not reconcile.');
    ingested += Number(count);
    process.stdout.write(`Ingested ${ingested}/${rows.length} validated player-season rows.\n`);
  }
  const result = await rpc(url, key, 'finalize_nba_scout_daily_game_scope', { p_scope_id: scopeId });
  return { scopeId, result, ingested };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage()); return; }
  if (options.apply && process.env.SCOUT_DAILY_GAME_IMPORT_ALLOW_WRITE !== 'confirmed') {
    throw new Error('Set SCOUT_DAILY_GAME_IMPORT_ALLOW_WRITE=confirmed for --apply after reviewing the dry run.');
  }
  const [manifestText, sourceValidationSha256] = await Promise.all([
    fsPromises.readFile(options.manifest, 'utf8'), sha256File(options.sourceValidation),
  ]);
  const manifest = JSON.parse(manifestText);
  const built = await buildRows(options, manifest);
  const payload = modelPayload(options, manifest, sourceValidationSha256, built.rows.length);
  process.stdout.write(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run', scopeKey: options.scopeKey,
    sourceSeasonEndYears: payload.sourceSeasonEndYears, selectedProfiles: built.selectedProfiles,
    playerSeasonRows: built.rows.length, rowsBySeasonEndYear: built.bySeason,
    sourceValidationSha256: sourceValidationSha256.slice(0, 12),
    modelArtifactSha256: payload.modelArtifactSha256.slice(0, 12),
  }, null, 2) + '\n');
  if (!options.apply) return;
  const result = await publish(options, manifest, sourceValidationSha256, built.rows);
  process.stdout.write(JSON.stringify({ published: true, status: result.result?.status || 'ready', ingested: result.ingested }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

export { buildRows, modelPayload, parseArgs };
