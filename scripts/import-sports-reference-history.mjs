#!/usr/bin/env node

/**
 * Resumable, season-at-a-time MLB/NFL historical statistics importer for the
 * isolated DJHC Extra Supabase project. Source pages are cached locally and
 * each completed season/stat-group is checkpointed after one transactional
 * upsert, so the long-running worker can resume without Codex involvement.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  BASEBALL_REFERENCE_BASE_URL,
  BASEBALL_REFERENCE_SOURCE,
  BASEBALL_STAT_GROUPS,
  FOOTBALL_STAT_GROUPS,
  PRO_FOOTBALL_REFERENCE_BASE_URL,
  PRO_FOOTBALL_REFERENCE_SOURCE,
  baseballReferenceSeasonPageUrl,
  parseBaseballReferenceSeasonPage,
  parseProFootballReferenceSeasonPage,
  proFootballReferenceSeasonPageUrl,
} from './lib/sports-reference-season-stats.mjs';
import {
  crawlDelayForUserAgent,
  isPathAllowedByRobots,
  parseRobotsTxt,
} from './update-nba-basketball-reference-weekly.mjs';

const ROOT = process.cwd();
const EXTRA_PROJECT_REF = 'rioxosivyhczxshhmaen';
const EXTRA_PROJECT_URL = `https://${EXTRA_PROJECT_REF}.supabase.co`;
const ANALYTICS_WORKDIR = path.join(ROOT, 'supabase-sports-analytics');
const CLI_VERSION = '2.115.0';
const SOURCE_CONFIRMATION_ENV = 'SPORTS_REFERENCE_AUTOMATION_CONFIRMED';
const SOURCE_PERMISSION_ENV = 'SPORTS_REFERENCE_SOURCE_PERMISSION_CONFIRMED';
const WRITE_CONFIRMATION_ENV = 'SPORTS_ANALYTICS_ALLOW_WRITE';
const TARGET_CONFIRMATION_ENV = 'SPORTS_ANALYTICS_SUPABASE_URL';
const DEFAULT_REQUEST_DELAY_MS = 4000;
const MINIMUM_REQUEST_DELAY_MS = 3000;
const USER_AGENT = process.env.SPORTS_REFERENCE_USER_AGENT?.trim()
  || 'DJHC-Sports-Analytics/1.0 (+https://www.djshouseofcards-comics.com/contact.html)';
const SOURCE_LICENSE_NOTE = 'Private non-competing analytics requested by the site owner on 2026-08-31; automated access is constrained by current Sports Reference robots and rate policies; no provider license is asserted.';

const SOURCE_CONFIGS = Object.freeze({
  mlb: Object.freeze({
    label: 'Baseball Reference',
    leagueCode: 'MLB',
    baseUrl: BASEBALL_REFERENCE_BASE_URL,
    robotsUrl: `${BASEBALL_REFERENCE_BASE_URL}/robots.txt`,
    sourceName: BASEBALL_REFERENCE_SOURCE,
    groups: BASEBALL_STAT_GROUPS,
    pageUrl: baseballReferenceSeasonPageUrl,
    parse: parseBaseballReferenceSeasonPage,
  }),
  nfl: Object.freeze({
    label: 'Pro Football Reference',
    leagueCode: 'NFL',
    baseUrl: PRO_FOOTBALL_REFERENCE_BASE_URL,
    robotsUrl: `${PRO_FOOTBALL_REFERENCE_BASE_URL}/robots.txt`,
    sourceName: PRO_FOOTBALL_REFERENCE_SOURCE,
    groups: FOOTBALL_STAT_GROUPS,
    pageUrl: proFootballReferenceSeasonPageUrl,
    parse: parseProFootballReferenceSeasonPage,
  }),
});

class SourceAccessBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SourceAccessBlockedError';
    this.details = details;
  }
}

function usage() {
  return `
Usage:
  node .\\scripts\\import-sports-reference-history.mjs [options]

Options:
  --sport <mlb|nfl|both>    Source to process (default: both)
  --season-start <year>     First season year (default: 1980)
  --season-end <year>       Last season year (default: current UTC year)
  --apply                   Upsert validated pages into the Extra project
  --analytics               Confirm the isolated analytics target for --apply
  --request-delay-ms <ms>   Uncached request delay (default: 4000; minimum: 3000)
  --refresh-cache           Re-fetch pages already present in the local cache
  --cache-only              Read existing local page caches; make no network requests
  --help                    Show this help

Required acknowledgement:
  ${SOURCE_CONFIRMATION_ENV}=confirmed

Additional --apply gates:
  ${WRITE_CONFIRMATION_ENV}=confirmed
  ${TARGET_CONFIRMATION_ENV}=${EXTRA_PROJECT_URL}

The worker checks each source's live robots policy before reading either cache
or network data. With --cache-only and an explicit permission acknowledgement,
it can process pages already obtained through an authorized interactive session
without making any robots or source requests. It never bypasses a security
challenge or fabricates a robots response.
`;
}

function optionTokens(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (inlineValue !== undefined) values.set(name, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values.set(name, argv[++index]);
    else flags.add(name);
  }
  return { values, flags };
}

function integerOption(value, name, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${name} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

export function optionsFromArgs(argv = [], now = new Date()) {
  const { values, flags } = optionTokens(argv);
  const known = new Set(['sport', 'season-start', 'season-end', 'apply', 'analytics', 'request-delay-ms', 'refresh-cache', 'cache-only', 'help']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  const sport = String(values.get('sport') ?? 'both').trim().toLowerCase();
  if (!['mlb', 'nfl', 'both'].includes(sport)) throw new Error('--sport must be mlb, nfl, or both.');
  const seasonStart = integerOption(values.get('season-start') ?? 1980, '--season-start', 1920, 2200);
  const seasonEnd = integerOption(values.get('season-end') ?? now.getUTCFullYear(), '--season-end', 1920, 2200);
  if (seasonEnd < seasonStart) throw new Error('--season-end must be greater than or equal to --season-start.');
  const requestDelayMs = integerOption(
    values.get('request-delay-ms') ?? DEFAULT_REQUEST_DELAY_MS,
    '--request-delay-ms',
    MINIMUM_REQUEST_DELAY_MS,
    600000,
  );
  return {
    help: false,
    sports: sport === 'both' ? ['mlb', 'nfl'] : [sport],
    seasonStart,
    seasonEnd,
    apply: flags.has('apply'),
    analytics: flags.has('analytics'),
    requestDelayMs,
    refreshCache: flags.has('refresh-cache'),
    cacheOnly: flags.has('cache-only'),
  };
}

function confirmed(value) {
  return String(value ?? '').trim().toLowerCase() === 'confirmed';
}

export function assertWriteTarget(options, env = process.env) {
  if (!options.apply) return null;
  if (!options.analytics) throw new Error('--apply requires --analytics.');
  if (!confirmed(env[WRITE_CONFIRMATION_ENV])) {
    throw new Error(`--apply requires ${WRITE_CONFIRMATION_ENV}=confirmed.`);
  }
  let expected;
  try {
    expected = new URL(String(env[TARGET_CONFIRMATION_ENV] ?? '').trim()).origin;
  } catch {
    throw new Error(`${TARGET_CONFIRMATION_ENV} must be the Extra project URL.`);
  }
  if (expected !== EXTRA_PROJECT_URL) {
    throw new Error(`${TARGET_CONFIRMATION_ENV} must exactly match ${EXTRA_PROJECT_URL}.`);
  }
  return { projectRef: EXTRA_PROJECT_REF, projectUrl: EXTRA_PROJECT_URL, workdir: ANALYTICS_WORKDIR };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function writeJsonAtomic(file, value) {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function appendEvent(file, event, details = {}) {
  ensureDirectory(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, 'utf8');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(value) {
  const seconds = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
}

function sourceCacheFile(cacheRoot, sport, seasonYear, statGroup) {
  return path.join(cacheRoot, sport, String(seasonYear), `${statGroup}.html`);
}

async function sourceResponse(url, fetchImpl = globalThis.fetch) {
  return fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain,text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(45000),
  });
}

export async function preflightSource(source, { fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await sourceResponse(source.robotsUrl, fetchImpl);
  } catch (error) {
    throw new SourceAccessBlockedError(`${source.label} robots policy could not be retrieved.`, {
      reason: 'robots_network_error',
      diagnostic: String(error?.message ?? error).slice(0, 240),
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new SourceAccessBlockedError(`${source.label} robots policy returned HTTP ${response.status}.`, {
      reason: 'robots_http_error', status: response.status,
    });
  }
  if (/performing security verification|verify you are not a bot|cf-chl/i.test(text)) {
    throw new SourceAccessBlockedError(`${source.label} returned a browser security challenge.`, {
      reason: 'security_challenge', status: response.status,
    });
  }
  const robots = parseRobotsTxt(text);
  const crawlDelaySeconds = crawlDelayForUserAgent(robots, USER_AGENT);
  if (crawlDelaySeconds === null) {
    throw new SourceAccessBlockedError(`${source.label} robots policy has no applicable user-agent group.`, {
      reason: 'robots_no_applicable_group', status: response.status,
    });
  }
  return { robots, crawlDelayMs: Math.ceil(crawlDelaySeconds * 1000), checkedAt: new Date().toISOString() };
}

export function createPageFetcher({
  source,
  robots,
  requestDelayMs,
  refreshCache,
  eventFile,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  cacheOnly = false,
  initialNetworkRequestAt = Date.now(),
}) {
  let lastNetworkRequestAt = initialNetworkRequestAt;
  return async ({ url, cacheFile }) => {
    const pathname = new URL(url).pathname;
    if (!cacheOnly && !isPathAllowedByRobots(pathname, robots, USER_AGENT)) {
      throw new SourceAccessBlockedError(`${source.label} robots policy disallows ${pathname}.`, {
        reason: 'robots_path_disallowed', pathname,
      });
    }
    if (!refreshCache && fs.existsSync(cacheFile)) {
      appendEvent(eventFile, 'source_cache_hit', { sport: source.leagueCode, url, cacheFile: path.relative(ROOT, cacheFile) });
      return fs.readFileSync(cacheFile, 'utf8');
    }
    if (cacheOnly) {
      throw new SourceAccessBlockedError(`${source.label} cache-only mode has no local page for ${pathname}.`, {
        reason: 'cache_missing', pathname, cacheFile: path.relative(ROOT, cacheFile),
      });
    }
    const waitMs = requestDelayMs - (Date.now() - lastNetworkRequestAt);
    if (waitMs > 0) await sleepImpl(waitMs);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      lastNetworkRequestAt = Date.now();
      appendEvent(eventFile, 'source_request_started', { sport: source.leagueCode, url, attempt });
      let response;
      try {
        response = await sourceResponse(url, fetchImpl);
      } catch (error) {
        if (attempt === 3) throw error;
        await sleepImpl(Math.min(120000, requestDelayMs * (2 ** attempt)));
        continue;
      }
      const body = await response.text();
      if (response.ok && !/performing security verification|verify you are not a bot|cf-chl/i.test(body)) {
        ensureDirectory(path.dirname(cacheFile));
        const temporary = `${cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, body, 'utf8');
        fs.renameSync(temporary, cacheFile);
        appendEvent(eventFile, 'source_request_completed', {
          sport: source.leagueCode, url, status: response.status, bytes: Buffer.byteLength(body),
        });
        return body;
      }
      if (response.status === 403 || /performing security verification|verify you are not a bot|cf-chl/i.test(body)) {
        throw new SourceAccessBlockedError(`${source.label} blocked unattended access for ${pathname}.`, {
          reason: 'security_challenge', status: response.status, pathname,
        });
      }
      if (attempt === 3 || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        const error = new Error(`${source.label} request returned HTTP ${response.status} for ${pathname}.`);
        error.status = response.status;
        throw error;
      }
      const retryMs = Math.min(120000, Math.max(
        requestDelayMs * (2 ** attempt),
        retryAfterMilliseconds(response.headers.get('retry-after')),
      ));
      appendEvent(eventFile, 'source_request_retry', { sport: source.leagueCode, url, attempt, status: response.status, retryMs });
      await sleepImpl(retryMs);
    }
    throw new Error(`${source.label} request did not complete for ${pathname}.`);
  };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonSql(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function dedupeParsedRows(parsed) {
  const bySourceRecordId = new Map();
  for (const row of parsed.rows) {
    const existing = bySourceRecordId.get(row.sourceRecordId);
    if (!existing) {
      bySourceRecordId.set(row.sourceRecordId, row);
      continue;
    }
    if (JSON.stringify(existing.rawPayload) !== JSON.stringify(row.rawPayload)) {
      throw new Error(`Conflicting duplicate source record ${row.sourceRecordId}.`);
    }
  }
  return { ...parsed, rows: [...bySourceRecordId.values()] };
}

export function buildImportSql({ sport, source, seasonYear, statGroup, sourceUrl, rows, runId }) {
  const prefix = sport;
  const playerAgeField = sport === 'mlb' ? '' : ', games_started integer';
  const stageRows = rows.map((row) => ({
    external_id: row.externalId,
    full_name: row.fullName,
    normalized_name: row.normalizedName,
    team_code: row.teamCode,
    team_name: row.teamName,
    season_phase: row.seasonPhase,
    is_multi_team_aggregate: row.isMultiTeamAggregate,
    listed_position: row.listedPosition,
    player_age: row.playerAge,
    games_played: row.gamesPlayed,
    ...(sport === 'nfl' ? { games_started: row.gamesStarted } : {}),
    metric_values: row.metrics,
    source_record_id: row.sourceRecordId,
    record_hash: hashPayload(row.rawPayload),
    raw_payload: row.rawPayload,
  }));
  const gamesStartedSelect = sport === 'nfl' ? ', s.games_started' : '';
  const gamesStartedColumn = sport === 'nfl' ? ', games_started' : '';
  const gamesStartedUpdate = sport === 'nfl' ? ', games_started = excluded.games_started' : '';
  return `
begin;
create temporary table _sports_reference_stage on commit drop as
select * from jsonb_to_recordset(${jsonSql(stageRows)}) as s(
  external_id text, full_name text, normalized_name text, team_code text,
  team_name text, season_phase text, is_multi_team_aggregate boolean,
  listed_position text, player_age integer, games_played integer${playerAgeField},
  metric_values jsonb, source_record_id text, record_hash text, raw_payload jsonb
);

insert into public.${prefix}_seasons (season_year) values (${Number(seasonYear)})
on conflict (season_year) do nothing;

insert into public.${prefix}_stat_import_runs (
  id, source_name, source_url, source_license_note, season_year, stat_group, status, records_read
) values (
  ${sqlLiteral(runId)}::uuid, ${sqlLiteral(source.sourceName)}, ${sqlLiteral(sourceUrl)},
  ${sqlLiteral(SOURCE_LICENSE_NOTE)}, ${Number(seasonYear)}, ${sqlLiteral(statGroup)}, 'running', ${rows.length}
) on conflict (id) do update set status = 'running', records_read = excluded.records_read,
  error_summary = '', updated_at = now();

create temporary table _new_athletes on commit drop as
select missing.external_id, missing.full_name, missing.normalized_name, gen_random_uuid() as athlete_id
from (
  select distinct s.external_id, s.full_name, s.normalized_name
  from _sports_reference_stage as s
  where not exists (
    select 1 from public.athlete_external_ids as ids
    where ids.league_code = ${sqlLiteral(source.leagueCode)}
      and ids.source_name = ${sqlLiteral(source.sourceName)}
      and ids.external_id = s.external_id
  )
) as missing;

insert into public.athletes (id, canonical_name, normalized_name)
select athlete_id, full_name, normalized_name from _new_athletes;

insert into public.athlete_league_memberships (
  athlete_id, league_code, membership_status, source_name, evidence
)
select athlete_id, ${sqlLiteral(source.leagueCode)}, 'verified', ${sqlLiteral(source.sourceName)},
  jsonb_build_object('external_id', external_id)
from _new_athletes
on conflict (athlete_id, league_code) do update set
  membership_status = 'verified', source_name = excluded.source_name,
  evidence = excluded.evidence, updated_at = now();

insert into public.athlete_aliases (
  athlete_id, league_code, alias, normalized_alias, alias_type, review_state, source_name, evidence
)
select athlete_id, ${sqlLiteral(source.leagueCode)}, full_name, normalized_name,
  'canonical', 'verified', ${sqlLiteral(source.sourceName)}, jsonb_build_object('external_id', external_id)
from _new_athletes
on conflict (athlete_id, league_code, normalized_alias) do update set
  alias = excluded.alias, review_state = 'verified', source_name = excluded.source_name,
  evidence = excluded.evidence, updated_at = now();

insert into public.athlete_external_ids (
  athlete_id, league_code, source_name, external_id, is_primary_for_source
)
select athlete_id, ${sqlLiteral(source.leagueCode)}, ${sqlLiteral(source.sourceName)}, external_id, true
from _new_athletes
on conflict (league_code, source_name, external_id) do update set
  is_primary_for_source = true, updated_at = now();

insert into public.${prefix}_players (athlete_id, full_name, normalized_name, primary_position)
select distinct on (ids.athlete_id)
  ids.athlete_id, s.full_name, s.normalized_name, coalesce(s.listed_position, '')
from _sports_reference_stage as s
join public.athlete_external_ids as ids
  on ids.league_code = ${sqlLiteral(source.leagueCode)}
 and ids.source_name = ${sqlLiteral(source.sourceName)}
 and ids.external_id = s.external_id
order by ids.athlete_id, (coalesce(s.listed_position, '') <> '') desc, s.source_record_id
on conflict (athlete_id) do update set
  full_name = excluded.full_name, normalized_name = excluded.normalized_name,
  primary_position = case when excluded.primary_position <> '' then excluded.primary_position else public.${prefix}_players.primary_position end,
  updated_at = now();

insert into public.${prefix}_player_external_ids (source_name, external_id, player_id, is_primary_for_source)
select distinct ${sqlLiteral(source.sourceName)}, s.external_id, p.id, true
from _sports_reference_stage as s
join public.athlete_external_ids as ids
  on ids.league_code = ${sqlLiteral(source.leagueCode)}
 and ids.source_name = ${sqlLiteral(source.sourceName)}
 and ids.external_id = s.external_id
join public.${prefix}_players as p on p.athlete_id = ids.athlete_id
on conflict (source_name, external_id) do update set
  player_id = excluded.player_id, is_primary_for_source = true, updated_at = now();

insert into public.${prefix}_team_seasons (season_year, team_code, team_name)
select distinct ${Number(seasonYear)}, team_code, coalesce(nullif(team_name, ''), team_code)
from _sports_reference_stage where not is_multi_team_aggregate
on conflict (season_year, team_code) do update set
  team_name = excluded.team_name, updated_at = now();

insert into public.${prefix}_player_team_season_stats (
  player_id, season_year, team_season_id, team_code, season_phase, stat_group,
  is_multi_team_aggregate, listed_position, player_age, games_played${gamesStartedColumn},
  metric_values, source_name, source_record_id, source_url, source_import_run_id, source_updated_at
)
select p.id, ${Number(seasonYear)}, case when s.is_multi_team_aggregate then null else teams.id end,
  s.team_code, s.season_phase, ${sqlLiteral(statGroup)}, s.is_multi_team_aggregate,
  coalesce(s.listed_position, ''), s.player_age, s.games_played${gamesStartedSelect},
  s.metric_values, ${sqlLiteral(source.sourceName)}, s.source_record_id,
  ${sqlLiteral(sourceUrl)}, ${sqlLiteral(runId)}::uuid, now()
from _sports_reference_stage as s
join public.${prefix}_player_external_ids as ids
  on ids.source_name = ${sqlLiteral(source.sourceName)} and ids.external_id = s.external_id
join public.${prefix}_players as p on p.id = ids.player_id
left join public.${prefix}_team_seasons as teams
  on teams.season_year = ${Number(seasonYear)} and teams.team_code = s.team_code
on conflict (player_id, season_year, team_code, season_phase, stat_group) do update set
  team_season_id = excluded.team_season_id, is_multi_team_aggregate = excluded.is_multi_team_aggregate,
  listed_position = excluded.listed_position, player_age = excluded.player_age,
  games_played = excluded.games_played${gamesStartedUpdate}, metric_values = excluded.metric_values,
  source_name = excluded.source_name, source_record_id = excluded.source_record_id,
  source_url = excluded.source_url, source_import_run_id = excluded.source_import_run_id,
  source_updated_at = excluded.source_updated_at, updated_at = now();

insert into public.${prefix}_stat_source_records (
  import_run_id, source_record_id, team_code, season_phase, record_hash, payload
)
select ${sqlLiteral(runId)}::uuid, source_record_id, team_code, season_phase, record_hash, raw_payload
from _sports_reference_stage
on conflict (import_run_id, source_record_id) do update set
  team_code = excluded.team_code, season_phase = excluded.season_phase,
  record_hash = excluded.record_hash, payload = excluded.payload, received_at = now();

update public.${prefix}_stat_import_runs set
  status = 'completed', players_created = (select count(*) from _new_athletes),
  stat_rows_upserted = ${rows.length}, finished_at = now(), updated_at = now()
where id = ${sqlLiteral(runId)}::uuid;

select json_build_object(
  'run_id', ${sqlLiteral(runId)}, 'players_created', (select count(*) from _new_athletes),
  'stat_rows_upserted', ${rows.length}
) as result;
commit;
`;
}

function parseCliJson(stdout) {
  const text = String(stdout ?? '').trim();
  const starts = [...text.matchAll(/\{/g)].map((match) => match.index).filter(Number.isInteger);
  for (const start of starts) {
    try {
      const parsed = JSON.parse(text.slice(start));
      if (Array.isArray(parsed?.rows)) return parsed;
    } catch { /* keep looking for the CLI JSON envelope */ }
  }
  return null;
}

export async function executeProjectSql(sql, label, dependencies = {}) {
  const work = ensureDirectory(path.join(ROOT, 'outputs', 'sports-reference-import-work'));
  const sqlFile = path.join(work, `${label.replace(/[^a-z0-9_-]+/gi, '-')}.sql`);
  fs.writeFileSync(sqlFile, sql, 'utf8');
  const installedNpx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const command = fs.existsSync(installedNpx) ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const npxArgs = [
    '--yes', `supabase@${CLI_VERSION}`, 'db', 'query', '--linked',
    '--workdir', ANALYTICS_WORKDIR, '--file', sqlFile, '--output', 'json',
  ];
  const args = fs.existsSync(installedNpx) ? [installedNpx, ...npxArgs] : npxArgs;
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: ANALYTICS_WORKDIR, windowsHide: true,
      shell: !fs.existsSync(installedNpx) && process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    throw new Error(`Extra-project SQL failed for ${label}: ${String(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  const payload = parseCliJson(result.stdout);
  if (!payload || !Array.isArray(payload.rows)) throw new Error(`Extra-project SQL returned invalid JSON for ${label}.`);
  return payload.rows;
}

function blankCheckpoint(options) {
  return {
    version: 1,
    targetProjectRef: EXTRA_PROJECT_REF,
    seasonStart: options.seasonStart,
    seasonEnd: options.seasonEnd,
    sports: options.sports,
    status: 'running',
    completed: {},
    blockedSources: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function matchingCheckpoint(checkpoint, options) {
  return checkpoint?.version === 1
    && checkpoint.targetProjectRef === EXTRA_PROJECT_REF
    && checkpoint.seasonStart === options.seasonStart
    && checkpoint.seasonEnd === options.seasonEnd
    && JSON.stringify(checkpoint.sports) === JSON.stringify(options.sports);
}

export async function runImport(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = optionsFromArgs(argv, dependencies.now ?? new Date());
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  if (!confirmed(env[SOURCE_CONFIRMATION_ENV])) {
    throw new Error(`Set ${SOURCE_CONFIRMATION_ENV}=confirmed after reviewing the current source policies.`);
  }
  if (options.cacheOnly && !confirmed(env[SOURCE_PERMISSION_ENV])) {
    throw new Error(`--cache-only requires ${SOURCE_PERMISSION_ENV}=confirmed after reviewing the authorized source access.`);
  }
  const target = assertWriteTarget(options, env);
  const runRoot = ensureDirectory(path.join(ROOT, 'outputs', 'sports-reference-history'));
  const cacheRoot = ensureDirectory(path.join(runRoot, 'cache'));
  const checkpointFile = path.join(runRoot, `checkpoint-${options.sports.join('-')}-${options.seasonStart}-${options.seasonEnd}.json`);
  const eventFile = path.join(runRoot, `events-${options.sports.join('-')}-${options.seasonStart}-${options.seasonEnd}.jsonl`);
  const prior = readJson(checkpointFile);
  const checkpoint = matchingCheckpoint(prior, options) ? prior : blankCheckpoint(options);
  checkpoint.status = 'running';
  checkpoint.updatedAt = new Date().toISOString();
  writeJsonAtomic(checkpointFile, checkpoint);

  for (const sport of options.sports) {
    const source = SOURCE_CONFIGS[sport];
    let policy;
    if (options.cacheOnly) {
      policy = { robots: null, crawlDelayMs: 0, checkedAt: null };
      appendEvent(eventFile, 'source_cache_only_authorized', { sport, source: source.sourceName });
    } else {
      try {
        policy = await preflightSource(source, { fetchImpl: dependencies.fetchImpl });
      } catch (error) {
        if (!(error instanceof SourceAccessBlockedError)) throw error;
        checkpoint.blockedSources[sport] = {
          at: new Date().toISOString(), message: error.message, ...error.details,
        };
        checkpoint.updatedAt = new Date().toISOString();
        writeJsonAtomic(checkpointFile, checkpoint);
        appendEvent(eventFile, 'source_blocked', { sport, ...checkpoint.blockedSources[sport] });
        continue;
      }
    }
    delete checkpoint.blockedSources[sport];
    const effectiveDelayMs = Math.max(options.requestDelayMs, policy.crawlDelayMs);
    appendEvent(eventFile, 'robots_policy_verified', {
      sport, robotsUrl: source.robotsUrl, effectiveDelayMs, checkedAt: policy.checkedAt,
    });
    const fetchPage = createPageFetcher({
      source, robots: policy.robots, requestDelayMs: effectiveDelayMs,
      refreshCache: options.refreshCache, eventFile,
      fetchImpl: dependencies.fetchImpl, sleepImpl: dependencies.sleepImpl,
      cacheOnly: options.cacheOnly,
    });
    for (let seasonYear = options.seasonStart; seasonYear <= options.seasonEnd; seasonYear += 1) {
      for (const statGroup of source.groups) {
        const key = `${sport}:${seasonYear}:${statGroup}`;
        if (options.apply && checkpoint.completed[key]) continue;
        const sourceUrl = source.pageUrl(seasonYear, statGroup);
        let html;
        try {
          html = await fetchPage({
            url: sourceUrl,
            cacheFile: sourceCacheFile(cacheRoot, sport, seasonYear, statGroup),
          });
        } catch (error) {
          if (error instanceof SourceAccessBlockedError) {
            checkpoint.blockedSources[sport] = { at: new Date().toISOString(), message: error.message, ...error.details };
            appendEvent(eventFile, 'source_blocked', { sport, ...checkpoint.blockedSources[sport] });
            seasonYear = options.seasonEnd;
            break;
          }
          if (error?.status === 404 && seasonYear === options.seasonEnd) {
            appendEvent(eventFile, 'current_season_page_unavailable', { sport, seasonYear, statGroup, sourceUrl });
            continue;
          }
          throw error;
        }
        const parsed = dedupeParsedRows(source.parse(html, { seasonYear, statGroup, sourceUrl }));
        if (!parsed.rows.length) {
          const challenge = /performing security verification|verify you are not a bot|cf-chl/i.test(html);
          if (challenge) throw new SourceAccessBlockedError(`${source.label} returned a security challenge.`, { reason: 'security_challenge' });
          throw new Error(`No ${source.leagueCode} ${statGroup} rows were found for ${seasonYear}.`);
        }
        const phaseCounts = Object.fromEntries(Object.entries(
          parsed.rows.reduce((counts, row) => {
            counts[row.seasonPhase] = (counts[row.seasonPhase] ?? 0) + 1;
            return counts;
          }, {}),
        ));
        let databaseResult = null;
        if (options.apply) {
          const runId = crypto.randomUUID();
          const sql = buildImportSql({ sport, source, seasonYear, statGroup, sourceUrl, rows: parsed.rows, runId });
          const resultRows = await (dependencies.executeSql ?? executeProjectSql)(sql, `${sport}-${seasonYear}-${statGroup}`);
          databaseResult = resultRows[0]?.result ?? null;
          checkpoint.completed[key] = {
            completedAt: new Date().toISOString(), rows: parsed.rows.length,
            phaseCounts, runId, databaseResult,
          };
          checkpoint.updatedAt = new Date().toISOString();
          writeJsonAtomic(checkpointFile, checkpoint);
        }
        appendEvent(eventFile, options.apply ? 'season_group_imported' : 'season_group_validated', {
          sport, seasonYear, statGroup, rows: parsed.rows.length, phaseCounts,
          tableCounts: parsed.tableCounts, databaseResult,
        });
      }
    }
  }
  checkpoint.status = Object.keys(checkpoint.blockedSources).length
    ? 'completed_with_blocked_sources'
    : 'completed';
  checkpoint.updatedAt = new Date().toISOString();
  writeJsonAtomic(checkpointFile, checkpoint);
  const report = {
    mode: options.apply ? 'apply' : 'dry-run', target: target?.projectUrl ?? null,
    status: checkpoint.status, completedSeasonGroups: Object.keys(checkpoint.completed).length,
    blockedSources: checkpoint.blockedSources, checkpoint: checkpointFile, events: eventFile,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) {
  runImport().catch((error) => {
    console.error(`Sports Reference history import failed: ${String(error?.stack ?? error)}`);
    process.exitCode = 1;
  });
}

export { SOURCE_CONFIGS, SourceAccessBlockedError };
