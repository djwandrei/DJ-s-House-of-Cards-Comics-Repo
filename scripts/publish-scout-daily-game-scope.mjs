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
import { streamTeamShardJson } from './validate-local-scout-analytics.mjs';

const ROOT = process.cwd();
const ALLOWED_POSITIONS = new Set(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']);
const TEAM_CODES = Object.freeze({
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
  'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
  'Detroit Pistons': 'DET', 'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA',
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
const POSITION_VIEW = 'nba_lineup_player_pool';
const POSITION_VIEW_SELECT = [
  'player_id', 'player_name', 'player_primary_position', 'season_end_year', 'team_code',
  'team_name', 'listed_position', 'career_profile_positions', 'career_profile_position_text',
].join(',');

function seasonWindow(manifest) {
  const starts = manifest?.scope?.seasonStartYears;
  if (!Array.isArray(starts) || starts.length < 2
    || starts.some(year => !Number.isSafeInteger(year) || year < 1947)
    || new Set(starts).size !== starts.length) {
    throw new Error('The validated package must declare at least two distinct season start years.');
  }
  const sorted = [...starts].sort((left, right) => left - right);
  if (sorted.some((year, index) => index > 0 && year !== sorted[index - 1] + 1)) {
    throw new Error('The validated package season window must be chronological and contiguous.');
  }
  if (manifest.scope.seasonStartYear !== sorted[0]
    || manifest.scope.latestSeasonStartYear !== sorted.at(-1)
    || manifest.scope.seasonEndYear !== sorted.at(-1) + 1) {
    throw new Error('The validated package season scope metadata is inconsistent.');
  }
  return { starts: sorted, ends: sorted.map(year => year + 1) };
}

function seasonLabel(starts) {
  return `${starts[0]}–${String(starts.at(-1) + 1).slice(-2)}`;
}

function usage() {
  return `Usage:
  node .\\scripts\\publish-scout-daily-game-scope.mjs --manifest <path> --source-validation <path> [options]

Options:
  --manifest <path>            Validated multi-season Scout manifest (required)
  --source-validation <path>   Matching source-validation report (required)
  --env-file <path>            Credential env file (default: codex_account_keys.env)
  --scope-key <key>            Scope key (default: scout-2017-26-v3)
  --positions-file <path>      Optional source-backed position crosswalk JSON
  --fetch-positions            Read the position crosswalk from the analytics view
  --apply                      Register, ingest, and publish the scope remotely
  --help                       Show this help

Dry-run is the default. A package without embedded model-evidence positions needs
--positions-file or --fetch-positions. --apply requires
SCOUT_DAILY_GAME_IMPORT_ALLOW_WRITE=confirmed.
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
  const known = new Set(['manifest', 'source-validation', 'env-file', 'scope-key', 'positions-file', 'fetch-positions', 'apply', 'help']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  const manifest = workspacePath(values.get('manifest'), '--manifest');
  const sourceValidation = workspacePath(values.get('source-validation'), '--source-validation');
  const envFile = workspacePath(values.get('env-file') || 'codex_account_keys.env', '--env-file');
  const scopeKey = String(values.get('scope-key') || 'scout-2017-26-v3').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,95}$/.test(scopeKey)) throw new Error('--scope-key is invalid.');
  const positionsFile = values.has('positions-file')
    ? workspacePath(values.get('positions-file'), '--positions-file') : null;
  if (positionsFile && flags.has('fetch-positions')) throw new Error('Choose --positions-file or --fetch-positions, not both.');
  return { help: false, manifest, sourceValidation, envFile, scopeKey, positionsFile,
    fetchPositions: flags.has('fetch-positions'), apply: flags.has('apply') };
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
  const aliases = {
    'POINT GUARD': 'PG', 'SHOOTING GUARD': 'SG', 'SMALL FORWARD': 'SF',
    'POWER FORWARD': 'PF', 'CENTER': 'C', 'CENTRE': 'C', 'GUARD': 'G', 'FORWARD': 'F',
  };
  const values = Array.isArray(value) ? value.flat(Infinity) : [value];
  const positions = [];
  for (const item of values) {
    const raw = String(item || '').trim().toUpperCase();
    if (!raw) continue;
    const alias = aliases[raw];
    const pieces = alias ? [alias] : raw.split(/[\s,\/|+;&-]+/).filter(Boolean);
    for (const piece of pieces) {
      const token = aliases[piece] || piece;
      if (ALLOWED_POSITIONS.has(token) && !positions.includes(token)) positions.push(token);
    }
  }
  if (!positions.length) return null;
  if (positions.length <= 3) return positions;
  // The source profile can list every position a player has held. The Daily
  // Games contract allows three tokens, so collapse a longer verified list to
  // its broad guard/forward/center eligibility without inventing a role.
  const broad = [];
  if (positions.some(position => ['PG', 'SG', 'G'].includes(position))) broad.push('G');
  if (positions.some(position => ['SF', 'PF', 'F'].includes(position))) broad.push('F');
  if (positions.includes('C')) broad.push('C');
  return broad.length >= 1 && broad.length <= 3 ? broad : null;
}

function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeTeamCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (Object.values(TEAM_CODES).includes(upper)) return upper;
  return TEAM_CODES[raw] || '';
}

function positionValues(record) {
  const preferred = [record?.listedPositions, record?.positions]
    .find(value => Array.isArray(value) && value.length);
  const values = preferred || [record?.listedPosition, record?.listed_position,
    record?.playerPrimaryPosition, record?.player_primary_position,
    record?.careerProfilePositions, record?.career_profile_positions,
    record?.careerProfilePositionText, record?.career_profile_position_text];
  return normalizePositions(values);
}

function addPositionCandidate(map, key, positions) {
  if (!key || !positions) return;
  const signature = positions.join('|');
  const current = map.get(key) || [];
  if (!current.some(item => item.join('|') === signature)) current.push(positions);
  map.set(key, current);
}

function createPositionIndex(records) {
  const index = { byId: new Map(), byNameTeamSeason: new Map(), byNameTeam: new Map(), byNameSeason: new Map(), byName: new Map(), records: 0 };
  for (const record of records || []) {
    const positions = positionValues(record);
    if (!positions) continue;
    const id = String(record?.playerId ?? record?.player_id ?? '').trim();
    const name = normalizeName(record?.playerName ?? record?.player_name ?? record?.name);
    const code = normalizeTeamCode(record?.teamCode ?? record?.team_code ?? record?.teamName ?? record?.team_name);
    const rawEnd = Number(record?.seasonEndYear ?? record?.season_end_year);
    const endYear = Number.isSafeInteger(rawEnd) ? rawEnd
      : Number.isSafeInteger(Number(record?.seasonStartYear ?? record?.season_start_year))
        ? Number(record.seasonStartYear ?? record.season_start_year) + 1 : null;
    if (!id && !name) continue;
    index.records += 1;
    if (id && code && endYear) addPositionCandidate(index.byId, `${id}|${code}|${endYear}`, positions);
    if (id && endYear) addPositionCandidate(index.byId, `${id}|${endYear}`, positions);
    if (id) addPositionCandidate(index.byId, id, positions);
    if (name && code && endYear) addPositionCandidate(index.byNameTeamSeason, `${name}|${code}|${endYear}`, positions);
    if (name && code) addPositionCandidate(index.byNameTeam, `${name}|${code}`, positions);
    if (name && endYear) addPositionCandidate(index.byNameSeason, `${name}|${endYear}`, positions);
    if (name) addPositionCandidate(index.byName, name, positions);
  }
  return index;
}

function uniquePositionCandidate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const signatures = new Set(candidates.map(item => item.join('|')));
  return signatures.size === 1 ? candidates[0] : null;
}

function lookupPositions(profile, team, endYear, index) {
  const id = String(profile?.playerId ?? profile?.player_id ?? '').trim();
  const name = normalizeName(profile?.player ?? profile?.playerName ?? profile?.name);
  const code = team?.code || '';
  const lookups = [
    [index?.byId, id && code && `${id}|${code}|${endYear}`],
    [index?.byId, id && `${id}|${endYear}`],
    [index?.byId, id],
    [index?.byNameTeamSeason, name && code && `${name}|${code}|${endYear}`],
    [index?.byNameTeam, name && code && `${name}|${code}`],
    [index?.byNameSeason, name && `${name}|${endYear}`],
    [index?.byName, name],
  ];
  for (const [map, key] of lookups) {
    if (!key) continue;
    const found = uniquePositionCandidate(map?.get(key));
    if (found) return found;
  }
  return null;
}

async function readPositionFile(file) {
  const stat = await fsPromises.stat(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('The position crosswalk must be a JSON file no larger than 32 MiB.');
  const parsed = JSON.parse(await fsPromises.readFile(file, 'utf8'));
  let records;
  if (Array.isArray(parsed)) records = parsed;
  else if (Array.isArray(parsed?.players)) records = parsed.players;
  else if (parsed && typeof parsed === 'object') records = Object.entries(parsed).map(([playerId, value]) => ({
    ...(value && typeof value === 'object' ? value : {}), playerId,
  }));
  else throw new Error('The position crosswalk must be an array or an object containing players.');
  if (records.length > 100000) throw new Error('The position crosswalk exceeds the 100,000-row safety limit.');
  return records;
}

async function fetchPositionRecords(options) {
  const env = { ...parseEnvFile(options.envFile), ...process.env };
  const url = requiredEnv(env, ['SUPABASE_URL_2', 'NBA_ANALYTICS_SUPABASE_URL']).replace(/\/+$/, '');
  const key = requiredEnv(env, ['SUPABASE_SERVICE_ROLE_KEY_2', 'SUPABASE_SERVICE_ROLE_KEY']);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('The analytics Supabase URL is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'fbbmuqbdpgsmvnezowwn.supabase.co') {
    throw new Error('Position fetching is restricted to the dedicated analytics Supabase project.');
  }
  const records = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    if (offset >= 100000) throw new Error('The analytics position view exceeds the 100,000-row safety limit.');
    const endpoint = new URL(`${url}/rest/v1/${POSITION_VIEW}`);
    endpoint.searchParams.set('select', POSITION_VIEW_SELECT);
    endpoint.searchParams.set('limit', String(pageSize));
    endpoint.searchParams.set('offset', String(offset));
    endpoint.searchParams.set('order', 'season_end_year.asc,player_name.asc');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let response;
    try {
      response = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Analytics position view request timed out.');
      throw new Error('Analytics position view request failed.');
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new Error(`Analytics position view failed with HTTP ${response.status}.`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Analytics position view returned an invalid response.');
    records.push(...page);
    process.stdout.write(`Read ${records.length} position rows from the analytics view.\n`);
    if (page.length < pageSize) break;
  }
  return records;
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

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function embeddedSeasonRow(profile, team, seasonStartYear, positionIndex) {
  const direct = profile?.seasonDirectStats?.[String(seasonStartYear)];
  if (!direct || typeof direct !== 'object' || direct.observed !== true) return null;
  const scope = direct.scope || {};
  const split = profile?.seasonSplits?.[String(seasonStartYear)]?.onCourt || {};
  const games = safeCount(scope.verifiedGames ?? split.games);
  const minutes = safeNonNegative(scope.matchingMinutes ?? split.minutes);
  if (!games || minutes === null || minutes <= 0) return null;
  const box = direct.boxScoreTotals && typeof direct.boxScoreTotals === 'object' ? direct.boxScoreTotals : {};
  const total = key => safeNonNegative(box[key]);
  const rebounds = total('rebounds') ?? ((total('offensiveRebounds') !== null && total('defensiveRebounds') !== null)
    ? total('offensiveRebounds') + total('defensiveRebounds') : null);
  const perGame = key => total(key) !== null ? total(key) / games : null;
  const fga = total('fieldGoalAttempts');
  const fgm = total('fieldGoalsMade');
  const threes = total('threePointersMade');
  const threeAttempts = total('threePointAttempts');
  const shooting = direct.shooting && typeof direct.shooting === 'object' ? direct.shooting : {};
  const rate = (value, numerator, denominator) => Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value) : (numerator !== null && denominator > 0 ? numerator / denominator : null);
  const positions = normalizePositions(profile?.listedPositions || profile?.positions)
    || lookupPositions(profile, team, seasonStartYear + 1, positionIndex);
  if (!positions) return { missingPosition: true };
  const name = String(profile?.player || profile?.playerName || '').trim();
  if (name.length < 2 || name.length > 160) return null;
  return {
    playerId: String(profile.playerId || '').trim(), teamId: team.id, seasonStartYear,
    names: [name], listedPositions: positions, games, officialMinutes: minutes,
    perGame: {
      points: perGame('points'), rebounds: rebounds === null ? null : rebounds / games,
      assists: perGame('assists'), steals: perGame('steals'), blocks: perGame('blocks'),
      turnovers: perGame('turnovers'),
    },
    officialRates: {
      effectiveFieldGoalPercentage: rate(shooting.effectiveFieldGoalPercentage, fgm !== null && threes !== null ? fgm + threes * 0.5 : null, fga),
      threePointPercentage: rate(shooting.threePointPercentage, threes, threeAttempts),
    },
  };
}

async function buildRows(options, manifest) {
  const seasons = seasonWindow(manifest);
  const shards = Array.isArray(manifest.dataShards) ? manifest.dataShards : [];
  const teams = new Map(shards.map(shard => {
    const name = String(shard.team || '').trim();
    return [shard.teamId, { id: shard.teamId, name, code: teamCode(name) }];
  }));
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

  let positionRecords = [];
  let positionSource = 'embedded model-evidence positions';
  if (options.positionsFile) {
    positionRecords = await readPositionFile(options.positionsFile);
    positionSource = `crosswalk file: ${path.relative(ROOT, options.positionsFile)}`;
  } else if (options.fetchPositions) {
    positionRecords = await fetchPositionRecords(options);
    positionSource = `analytics view: ${POSITION_VIEW}`;
  }
  const positionIndex = createPositionIndex(positionRecords);
  const selected = new Map();
  let missingPositions = 0;
  let evidenceFile = null;
  const evidenceDescriptor = manifest.modelEvidence?.files?.playerSeasonSkillProfiles;
  if (evidenceDescriptor) {
    evidenceFile = path.resolve(path.dirname(options.manifest), evidenceDescriptor.path || '');
    if (!fs.existsSync(evidenceFile)) throw new Error('The validated model-evidence file is missing.');
  } else if (!options.positionsFile && !options.fetchPositions) {
    // The completed 2017–26 package intentionally embeds direct season rows,
    // but those profiles do not carry listed positions. Fail before scanning
    // 69 GB of shards when the source-backed eligibility crosswalk is absent.
    const candidate = path.resolve(path.dirname(options.manifest), 'model-evidence/playerSeasonSkillProfiles.jsonl.gz');
    if (fs.existsSync(candidate)) evidenceFile = candidate;
    else throw new Error('Embedded Scout season rows have no listed positions; supply --positions-file or --fetch-positions.');
  }

  if (evidenceFile) {
    const input = fs.createReadStream(evidenceFile).pipe(createGunzip());
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const sourceRow = JSON.parse(line);
      const seasonStartYear = Number(sourceRow.seasonStartYear);
      if (sourceRow.teamId === 'ALL_TEAMS' || !seasons.starts.includes(seasonStartYear) || !teams.has(sourceRow.teamId)) continue;
      const playerId = String(sourceRow.playerId || '').trim();
      if (!od.has(playerId)) continue;
      const team = teams.get(sourceRow.teamId);
      const positions = normalizePositions(sourceRow.listedPositions)
        || lookupPositions({ ...sourceRow, playerId, player: sourceRow.names?.[0] }, team, seasonStartYear + 1, positionIndex);
      if (!positions) { missingPositions += 1; continue; }
      const row = { ...sourceRow, playerId, listedPositions: positions };
      const key = `${playerId}|${seasonStartYear}|${sourceRow.teamId}`;
      selected.set(key, chooseProfile(selected.get(key), row));
    }
  } else {
    for (const descriptor of shards) {
      const shardPath = path.resolve(path.dirname(options.manifest), descriptor.jsonPath || '');
      if (!fs.existsSync(shardPath)) throw new Error(`The validated team shard is missing: ${descriptor.team}.`);
      const team = teams.get(descriptor.teamId);
      await streamTeamShardJson(shardPath, {
        maxBufferedValueBytes: 64 * 1024 * 1024,
        onArrayItem(field, _index, profile) {
          if (field !== 'playerProfiles' || !profile?.playerId || !od.has(profile.playerId)) return;
          for (const seasonStartYear of seasons.starts) {
            const row = embeddedSeasonRow(profile, team, seasonStartYear, positionIndex);
            if (!row) continue;
            if (row.missingPosition) { missingPositions += 1; continue; }
            const key = `${row.playerId}|${seasonStartYear}|${descriptor.teamId}`;
            selected.set(key, chooseProfile(selected.get(key), row));
          }
        },
      });
    }
    positionSource = positionSource === 'embedded model-evidence positions'
      ? 'source-backed position crosswalk required for embedded profiles' : positionSource;
  }

  const rows = [];
  const identity = new Set();
  for (const row of selected.values()) {
    const model = od.get(String(row.playerId || '').trim());
    const team = teams.get(row.teamId);
    const positions = normalizePositions(row.listedPositions)
      || lookupPositions(row, team, Number(row.seasonStartYear) + 1, positionIndex);
    const name = String(row.names?.[0] || row.playerName || row.player || '').trim();
    const endYear = Number(row.seasonStartYear) + 1;
    if (!positions || name.length < 2 || name.length > 160 || !seasons.ends.includes(endYear)) continue;
    if (!model.displayEligible || Number(model.pairedPossessions) < Number(model.displayMinimumPairedPossessions || 200)) continue;
    const lowerIdentity = `${endYear}|${team.code}|${name.toLocaleLowerCase()}`;
    if (identity.has(lowerIdentity)) throw new Error('The selected evidence contains duplicate player identities within a team season.');
    identity.add(lowerIdentity);
    const scout = {
      source_season_end_year: endYear, team_code: team.code, team_name: team.name,
      franchise_key: team.code.toLowerCase(), player_name: name, positions,
      public_stats: publicStats(row),
      offensive_rapm_per_100: rounded(model.offensiveRapmPer100),
      defensive_rapm_per_100: rounded(model.defensiveRapmPer100),
      paired_possessions: rounded(model.pairedPossessions, 3), display_eligible: true,
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
  if (rows.length < 15) throw new Error(`The validated package produced too few display-eligible players (${rows.length}); missing positions: ${missingPositions}.`);
  const bySeason = Object.fromEntries(seasons.ends.map(year => [year, rows.filter(row => row.source_season_end_year === year).length]));
  return { rows, bySeason, selectedProfiles: selected.size, evidenceFile, sourceSeasonStartYears: seasons.starts,
    sourceSeasonEndYears: seasons.ends, positionSource, positionRecords: positionIndex.records, missingPositions };
}

function modelPayload(options, manifest, sourceValidationSha256, expectedPlayerCount) {
  const artifact = String(manifest.rapm?.offenseDefense?.inputSha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(artifact)) throw new Error('The validated manifest has no usable O/D artifact digest.');
  const seasons = seasonWindow(manifest);
  return {
    scopeKey: options.scopeKey,
    publicLabel: `Validated Scout O/D model · ${seasonLabel(seasons.starts)}`,
    modelVersion: `${manifest.rapm.offenseDefense.modelVersion} · ${seasonLabel(seasons.starts)}`,
    modelArtifactSha256: artifact, modelScopeKind: 'combined-window',
    sourceSeasonEndYears: [...seasons.ends], sourceValidationPassed: true,
    sourceValidationReportSha256: sourceValidationSha256, calibrationStatus: 'validated',
    calibrationAllComponentsImproved: manifest.rapm.offenseDefense.calibration?.allComponentsImproved === true,
    seasonPhase: SEASON_PHASE, expectedPlayerCount,
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
    positionSource: built.positionSource, positionRecords: built.positionRecords,
    missingPositions: built.missingPositions,
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

export { buildRows, modelPayload, parseArgs, normalizePositions, createPositionIndex, lookupPositions, embeddedSeasonRow };
