#!/usr/bin/env node

/**
 * Import NBA player-team-season statistics from Basketball Reference into the
 * DJHC Supabase project.
 *
 * The importer deliberately uses the already-linked Supabase CLI for writes
 * rather than a browser key. That keeps NBA-table RLS read-only and avoids
 * requiring a service-role secret in the local shell. Every remote write is
 * performed in a database transaction, and local source/page caches plus a
 * checkpoint make a stopped run safe to resume.
 *
 * Examples:
 *   node .\scripts\import-nba-basketball-reference.mjs --season-start 1980 --season-end 1980
 *   node .\scripts\import-nba-basketball-reference.mjs --apply --season-start 1980 --season-end 1980
 *   node .\scripts\import-nba-basketball-reference.mjs --apply --season-start 1980 --season-end 2026
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  BASKETBALL_REFERENCE_SOURCE,
  basketballReferencePlayerPageUrl,
  basketballReferenceTeamPageUrl,
  extractHeadshotAsset,
  extractTeamLogoAsset,
  leaguePageUrl,
  parseAdvancedPage,
  parseLeagueTeamsPage,
  parseTotalsPage,
  seasonPageUrls
} from './lib/nba-basketball-reference.mjs';
import {
  BASKETBALL_REFERENCE_ROBOTS_URL,
  SOURCE_CONFIRMATION_ENV,
  WRITE_CONFIRMATION_ENV,
  crawlDelayForUserAgent,
  isConfirmationPresent,
  isPathAllowedByRobots,
  parseRobotsTxt,
  sourcePathsForSeason,
} from './update-nba-basketball-reference-weekly.mjs';

const ROOT = process.cwd();
// Basketball Reference currently declares Crawl-delay: 3 and Sports Reference
// documents a 20-request-per-minute ceiling for its non-FBref sites. Four
// seconds leaves margin beneath both limits while keeping a one-season refresh
// comfortably short.
const DEFAULT_DELAY_MS = 4000;
const MINIMUM_DELAY_MS = 3000;
const SOURCE_LICENSE_NOTE = 'User-confirmed permission for Basketball Reference NBA data and media import/display (2026-08-23).';
const USER_AGENT = process.env.NBA_BREF_USER_AGENT?.trim()
  || 'DJHC-Lineup-Lab-Updater/1.0 (+https://www.djshouseofcards-comics.com/contact.html)';
const VALID_PHASES = new Set(['regular', 'playoffs']);

// A franchise ID is useful for browsing relocations, but the era-specific
// `team_code` and `team_name` are still the source of truth for every stint.
const FRANCHISE_ALIASES = Object.freeze({
  ATL: ['ATL', 'Atlanta Hawks'],
  BOS: ['BOS', 'Boston Celtics'],
  BRK: ['BRK', 'Brooklyn Nets'],
  NJN: ['BRK', 'Brooklyn Nets'],
  CHA: ['CHA', 'Charlotte Hornets'],
  CHH: ['CHA', 'Charlotte Hornets'],
  CHO: ['CHA', 'Charlotte Hornets'],
  CHI: ['CHI', 'Chicago Bulls'],
  CLE: ['CLE', 'Cleveland Cavaliers'],
  DAL: ['DAL', 'Dallas Mavericks'],
  DEN: ['DEN', 'Denver Nuggets'],
  DET: ['DET', 'Detroit Pistons'],
  GSW: ['GSW', 'Golden State Warriors'],
  HOU: ['HOU', 'Houston Rockets'],
  IND: ['IND', 'Indiana Pacers'],
  LAC: ['LAC', 'Los Angeles Clippers'],
  SDC: ['LAC', 'Los Angeles Clippers'],
  LAL: ['LAL', 'Los Angeles Lakers'],
  MEM: ['MEM', 'Memphis Grizzlies'],
  VAN: ['MEM', 'Memphis Grizzlies'],
  MIA: ['MIA', 'Miami Heat'],
  MIL: ['MIL', 'Milwaukee Bucks'],
  MIN: ['MIN', 'Minnesota Timberwolves'],
  NOH: ['NOP', 'New Orleans Pelicans'],
  NOK: ['NOP', 'New Orleans Pelicans'],
  NOP: ['NOP', 'New Orleans Pelicans'],
  NYK: ['NYK', 'New York Knicks'],
  OKC: ['OKC', 'Oklahoma City Thunder'],
  SEA: ['OKC', 'Oklahoma City Thunder'],
  ORL: ['ORL', 'Orlando Magic'],
  PHI: ['PHI', 'Philadelphia 76ers'],
  PHO: ['PHO', 'Phoenix Suns'],
  POR: ['POR', 'Portland Trail Blazers'],
  SAC: ['SAC', 'Sacramento Kings'],
  KCK: ['SAC', 'Sacramento Kings'],
  SAS: ['SAS', 'San Antonio Spurs'],
  TOR: ['TOR', 'Toronto Raptors'],
  UTA: ['UTA', 'Utah Jazz'],
  WAS: ['WAS', 'Washington Wizards'],
  WSB: ['WAS', 'Washington Wizards']
});

function printUsage() {
  console.log(`
Usage:
  node .\\scripts\\import-nba-basketball-reference.mjs [options]

Options:
  --season-start <year>      Ending year of the first season (default: 1980)
  --season-end <year>        Ending year of the last season (default: current year)
  --phase <regular|playoffs|both>
                              Import one phase or both (default: both)
  --apply                     Write to the linked Supabase project; otherwise dry-run
  --request-delay-ms <ms>     Delay between uncached source requests (default: 4000; minimum: 3000)
  --refresh-cache             Re-fetch pages instead of using the local source cache
  --allow-missing-playoffs    Skip an unavailable/empty playoffs phase (current-season refreshes only)
  --skip-advanced             Import traditional totals only
  --skip-raw                  Skip private raw-source audit rows (not recommended for production)
  --new-run                   Do not reuse a matching incomplete local checkpoint
  --media-limit <count>       After stats, attempt this many verified headshots and team logos (default: 0)
  --media-only                Import only a bounded, verified media sample; do not touch stat rows
  --media-team-code <code>    Limit media collection to one historical team code
  --help                      Show this help

Required environment acknowledgement:
  ${SOURCE_CONFIRMATION_ENV}=confirmed

Additional write gate for --apply:
  ${WRITE_CONFIRMATION_ENV}=confirmed

Notes:
  * 1980 represents the 1979-80 season.
  * A full run requests about five source pages per season and is rate-limited.
  * Resume the same range with --apply after interruption; the checkpoint and
    source cache make data writes idempotent.
`);
}

function parseArgs(argv) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (inlineValue !== undefined) {
      options.set(rawName, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(rawName, next);
      index += 1;
    } else {
      flags.add(rawName);
    }
  }
  return { options, flags };
}

function readInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function readOptionalTeamCode(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const teamCode = String(value).trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(teamCode)) {
    throw new Error('--media-team-code must be a 2-8 character NBA team code.');
  }
  return teamCode;
}

function optionsFromArgs(argv) {
  const { options, flags } = parseArgs(argv);
  if (flags.has('help')) {
    printUsage();
    process.exit(0);
  }
  const start = readInteger(options.get('season-start') ?? 1980, '--season-start', { min: 1947, max: 2200 });
  const end = readInteger(options.get('season-end') ?? new Date().getUTCFullYear(), '--season-end', { min: 1947, max: 2200 });
  if (end < start) throw new Error('--season-end must be greater than or equal to --season-start.');

  const rawPhase = String(options.get('phase') ?? 'both').trim().toLowerCase();
  const phases = rawPhase === 'both'
    ? ['regular', 'playoffs']
    : rawPhase.split(',').map((phase) => phase.trim()).filter(Boolean);
  if (!phases.length || phases.some((phase) => !VALID_PHASES.has(phase))) {
    throw new Error('--phase must be regular, playoffs, both, or a comma-separated combination.');
  }

  const requestDelayMs = readInteger(options.get('request-delay-ms') ?? DEFAULT_DELAY_MS, '--request-delay-ms', {
    min: MINIMUM_DELAY_MS,
    max: 120000
  });
  const mediaLimit = readInteger(options.get('media-limit') ?? 0, '--media-limit', { min: 0, max: 100000 });
  return {
    apply: flags.has('apply'),
    start,
    end,
    phases: [...new Set(phases)],
    requestDelayMs,
    refreshCache: flags.has('refresh-cache'),
    allowMissingPlayoffs: flags.has('allow-missing-playoffs'),
    skipAdvanced: flags.has('skip-advanced'),
    skipRaw: flags.has('skip-raw'),
    newRun: flags.has('new-run'),
    mediaLimit,
    mediaOnly: flags.has('media-only'),
    mediaTeamCode: readOptionalTeamCode(options.get('media-team-code')),
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logSourceEvent(event, details = {}) {
  console.log(JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...details
  }));
}

function retryAfterMilliseconds(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return 0;
  if (/^\d+$/.test(normalized)) return Number(normalized) * 1000;
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

async function fetchRobotsPolicy(requestDelayMs) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    logSourceEvent('robots_request_started', { url: BASKETBALL_REFERENCE_ROBOTS_URL, attempt });
    try {
      const response = await fetch(BASKETBALL_REFERENCE_ROBOTS_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return response.text();
      lastError = new Error(`Basketball Reference robots.txt request failed with HTTP ${response.status}.`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        lastError.nonRetryable = true;
        throw lastError;
      }
      const retryDelayMs = Math.min(120000, Math.max(
        requestDelayMs * (2 ** (attempt - 1)),
        retryAfterMilliseconds(response.headers.get('retry-after')),
      ));
      if (attempt < 3) {
        logSourceEvent('robots_request_retry', { attempt, status: response.status, retryDelayMs });
        await sleep(retryDelayMs);
      }
    } catch (error) {
      lastError = error;
      if (error?.nonRetryable) throw error;
      if (attempt === 3) break;
      const retryDelayMs = Math.min(120000, requestDelayMs * (2 ** (attempt - 1)));
      logSourceEvent('robots_request_retry', {
        attempt,
        retryDelayMs,
        reason: String(error?.message ?? error).slice(0, 240),
      });
      await sleep(retryDelayMs);
    }
  }
  throw lastError || new Error('Basketball Reference robots.txt could not be retrieved.');
}

async function verifySourceAutomation(options) {
  // Confirmation is deliberately independent from the write flag: even a
  // dry-run retrieves a large source dataset, so it needs the same explicit
  // operator acknowledgement and robots policy check as a production import.
  if (!isConfirmationPresent(process.env[SOURCE_CONFIRMATION_ENV])) {
    throw new Error(`Set ${SOURCE_CONFIRMATION_ENV}=confirmed only after confirming source automation permission remains valid.`);
  }
  if (options.apply && !isConfirmationPresent(process.env[WRITE_CONFIRMATION_ENV])) {
    throw new Error(`--apply also requires ${WRITE_CONFIRMATION_ENV}=confirmed.`);
  }
  if (USER_AGENT.length < 20 || USER_AGENT.length > 240) {
    throw new Error('NBA_BREF_USER_AGENT must be 20-240 characters.');
  }

  const robots = parseRobotsTxt(await fetchRobotsPolicy(options.requestDelayMs));
  const crawlDelaySeconds = crawlDelayForUserAgent(robots, USER_AGENT);
  if (crawlDelaySeconds === null) {
    throw new Error('Basketball Reference robots.txt did not contain an applicable user-agent group.');
  }
  const sourcePhase = options.phases.length === 2 ? 'both' : options.phases[0];
  const checkedPaths = new Set();
  for (let seasonEndYear = options.start; seasonEndYear <= options.end; seasonEndYear += 1) {
    for (const pathname of sourcePathsForSeason(seasonEndYear, sourcePhase)) checkedPaths.add(pathname);
  }
  const blocked = [...checkedPaths].filter((pathname) => !isPathAllowedByRobots(pathname, robots, USER_AGENT));
  if (blocked.length) {
    throw new Error(`Basketball Reference robots.txt currently disallows required path(s): ${blocked.slice(0, 12).join(', ')}${blocked.length > 12 ? ', …' : ''}`);
  }

  const effectiveDelayMs = Math.max(options.requestDelayMs, Math.ceil(crawlDelaySeconds * 1000));
  logSourceEvent('robots_policy_verified', {
    url: BASKETBALL_REFERENCE_ROBOTS_URL,
    crawlDelaySeconds,
    effectiveDelayMs,
    checkedPaths: checkedPaths.size,
  });
  // The robots fetch itself is a network request. Wait before the first source
  // request so a fresh run obeys the declared cadence from its very first page.
  await sleep(effectiveDelayMs);
  return { robots, effectiveDelayMs };
}

function safeFileSegment(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sourceCacheFile(cacheDirectory, seasonEndYear, phase, resource) {
  return path.join(cacheDirectory, `${seasonEndYear}-${phase}-${resource}.html`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sqlLiteral(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function sqlUuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value))) {
    throw new Error('Internal error: expected a UUID.');
  }
  return sqlLiteral(value);
}

function franchiseForTeam(teamCode, historicalName) {
  const [franchiseCode, franchiseName] = FRANCHISE_ALIASES[teamCode] ?? [teamCode, historicalName || teamCode];
  return { franchiseCode, franchiseName };
}

function uniqueRows(rows, key) {
  const byKey = new Map();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

function totalStageRows(rows, seasonEndYear, seasonPhase) {
  return uniqueRows(rows, (row) => `${row.externalId}:${row.teamCode}`).map((row) => ({
    external_id: row.externalId,
    full_name: row.fullName,
    normalized_name: row.normalizedName,
    listed_position: row.listedPosition || '',
    player_age: row.playerAge,
    team_code: row.teamCode,
    is_multi_team_aggregate: row.isMultiTeamAggregate,
    games_played: row.gamesPlayed,
    games_started: row.gamesStarted,
    minutes_played: row.minutesPlayed,
    field_goals_made: row.fieldGoalsMade,
    field_goals_attempted: row.fieldGoalsAttempted,
    three_point_field_goals_made: row.threePointFieldGoalsMade,
    three_point_field_goals_attempted: row.threePointFieldGoalsAttempted,
    free_throws_made: row.freeThrowsMade,
    free_throws_attempted: row.freeThrowsAttempted,
    offensive_rebounds: row.offensiveRebounds,
    defensive_rebounds: row.defensiveRebounds,
    total_rebounds: row.totalRebounds,
    assists: row.assists,
    steals: row.steals,
    blocks: row.blocks,
    turnovers: row.turnovers,
    personal_fouls: row.personalFouls,
    points: row.points,
    source_record_id: row.sourceRecordId,
    source_url: row.sourceUrl,
    source_resource: `NBA_${seasonEndYear}_${seasonPhase === 'playoffs' ? 'playoffs_' : ''}totals`,
    record_hash: sha256(row.rawPayload),
    raw_payload: {
      season_end_year: seasonEndYear,
      season_phase: seasonPhase,
      basketball_reference_id: row.externalId,
      team_code: row.teamCode,
      fields: row.rawPayload
    }
  }));
}

function advancedStageRows(rows, seasonEndYear, seasonPhase) {
  return uniqueRows(rows, (row) => `${row.externalId}:${row.teamCode}`).map((row) => ({
    external_id: row.externalId,
    full_name: row.fullName,
    normalized_name: row.normalizedName,
    listed_position: row.listedPosition || '',
    player_age: row.playerAge,
    team_code: row.teamCode,
    is_multi_team_aggregate: row.isMultiTeamAggregate,
    metrics: row.metrics,
    source_record_id: row.sourceRecordId,
    source_url: row.sourceUrl,
    source_resource: `NBA_${seasonEndYear}_${seasonPhase === 'playoffs' ? 'playoffs_' : ''}advanced`,
    record_hash: sha256(row.rawPayload),
    raw_payload: {
      season_end_year: seasonEndYear,
      season_phase: seasonPhase,
      basketball_reference_id: row.externalId,
      team_code: row.teamCode,
      fields: row.rawPayload
    }
  }));
}

function playerStageRows(totals, advanced) {
  const players = new Map();
  for (const row of [...totals, ...advanced]) {
    const existing = players.get(row.externalId);
    if (!existing || (!existing.primary_position && row.listedPosition)) {
      players.set(row.externalId, {
        external_id: row.externalId,
        player_id: crypto.randomUUID(),
        full_name: row.fullName,
        normalized_name: row.normalizedName,
        primary_position: row.listedPosition || ''
      });
    }
  }
  return [...players.values()];
}

function teamStageRows(totals, teamNames) {
  const teamRows = new Map();
  for (const row of totals) {
    if (row.isMultiTeamAggregate) continue;
    const teamName = teamNames.get(row.teamCode) || row.teamCode;
    const franchise = franchiseForTeam(row.teamCode, teamName);
    teamRows.set(row.teamCode, {
      team_code: row.teamCode,
      team_name: teamName,
      city: '',
      conference: '',
      division: '',
      franchise_code: franchise.franchiseCode,
      franchise_name: franchise.franchiseName
    });
  }
  return [...teamRows.values()];
}

function buildSeasonPhaseSql({ runId, seasonEndYear, seasonPhase, totalRows, advancedRows, playerRows, teamRows, skipRaw }) {
  const runIdSql = sqlUuid(runId);
  const year = readInteger(seasonEndYear, 'seasonEndYear', { min: 1947, max: 2200 });
  const phaseSql = sqlLiteral(seasonPhase);
  const sourceSql = sqlLiteral(BASKETBALL_REFERENCE_SOURCE);
  const totalRowsSql = sqlJson(totalRows);
  const advancedRowsSql = sqlJson(advancedRows);
  const playerRowsSql = sqlJson(playerRows);
  const teamRowsSql = sqlJson(teamRows);
  const rawRowsSql = skipRaw ? '' : `
insert into public.nba_stat_source_records (
  import_run_id, source_name, source_resource, source_record_id,
  season_end_year, team_code, record_hash, payload
)
select
  ${runIdSql}::uuid,
  ${sourceSql},
  source_resource,
  source_record_id,
  ${year},
  team_code,
  record_hash,
  raw_payload
from _nba_bref_totals_stage
on conflict (import_run_id, source_resource, source_record_id) do update set
  record_hash = excluded.record_hash,
  payload = excluded.payload,
  received_at = now();

insert into public.nba_stat_source_records (
  import_run_id, source_name, source_resource, source_record_id,
  season_end_year, team_code, record_hash, payload
)
select
  ${runIdSql}::uuid,
  ${sourceSql},
  source_resource,
  source_record_id,
  ${year},
  team_code,
  record_hash,
  raw_payload
from _nba_bref_advanced_stage
on conflict (import_run_id, source_resource, source_record_id) do update set
  record_hash = excluded.record_hash,
  payload = excluded.payload,
  received_at = now();
`;

  return `
begin;

create temporary table _nba_bref_import_counts (
  players_created integer not null default 0,
  stat_rows_upserted integer not null default 0,
  metric_rows_upserted integer not null default 0
) on commit drop;

create temporary table _nba_bref_totals_stage (
  external_id text not null,
  full_name text not null,
  normalized_name text not null,
  listed_position text not null,
  player_age smallint,
  team_code text not null,
  is_multi_team_aggregate boolean not null,
  games_played integer,
  games_started integer,
  minutes_played integer,
  field_goals_made integer,
  field_goals_attempted integer,
  three_point_field_goals_made integer,
  three_point_field_goals_attempted integer,
  free_throws_made integer,
  free_throws_attempted integer,
  offensive_rebounds integer,
  defensive_rebounds integer,
  total_rebounds integer,
  assists integer,
  steals integer,
  blocks integer,
  turnovers integer,
  personal_fouls integer,
  points integer,
  source_record_id text not null,
  source_url text not null,
  source_resource text not null,
  record_hash text not null,
  raw_payload jsonb not null
) on commit drop;

insert into _nba_bref_totals_stage
select *
from jsonb_to_recordset(${totalRowsSql}) as row_data(
  external_id text,
  full_name text,
  normalized_name text,
  listed_position text,
  player_age smallint,
  team_code text,
  is_multi_team_aggregate boolean,
  games_played integer,
  games_started integer,
  minutes_played integer,
  field_goals_made integer,
  field_goals_attempted integer,
  three_point_field_goals_made integer,
  three_point_field_goals_attempted integer,
  free_throws_made integer,
  free_throws_attempted integer,
  offensive_rebounds integer,
  defensive_rebounds integer,
  total_rebounds integer,
  assists integer,
  steals integer,
  blocks integer,
  turnovers integer,
  personal_fouls integer,
  points integer,
  source_record_id text,
  source_url text,
  source_resource text,
  record_hash text,
  raw_payload jsonb
);

create temporary table _nba_bref_advanced_stage (
  external_id text not null,
  full_name text not null,
  normalized_name text not null,
  listed_position text not null,
  player_age smallint,
  team_code text not null,
  is_multi_team_aggregate boolean not null,
  metrics jsonb not null,
  source_record_id text not null,
  source_url text not null,
  source_resource text not null,
  record_hash text not null,
  raw_payload jsonb not null
) on commit drop;

insert into _nba_bref_advanced_stage
select *
from jsonb_to_recordset(${advancedRowsSql}) as row_data(
  external_id text,
  full_name text,
  normalized_name text,
  listed_position text,
  player_age smallint,
  team_code text,
  is_multi_team_aggregate boolean,
  metrics jsonb,
  source_record_id text,
  source_url text,
  source_resource text,
  record_hash text,
  raw_payload jsonb
);

create temporary table _nba_bref_player_stage (
  external_id text primary key,
  player_id uuid not null,
  full_name text not null,
  normalized_name text not null,
  primary_position text not null
) on commit drop;

insert into _nba_bref_player_stage
select *
from jsonb_to_recordset(${playerRowsSql}) as row_data(
  external_id text,
  player_id uuid,
  full_name text,
  normalized_name text,
  primary_position text
);

create temporary table _nba_bref_team_stage (
  team_code text primary key,
  team_name text not null,
  city text not null,
  conference text not null,
  division text not null,
  franchise_code text not null,
  franchise_name text not null
) on commit drop;

insert into _nba_bref_team_stage
select *
from jsonb_to_recordset(${teamRowsSql}) as row_data(
  team_code text,
  team_name text,
  city text,
  conference text,
  division text,
  franchise_code text,
  franchise_name text
);

create temporary table _nba_bref_new_players on commit drop as
select stage.*
from _nba_bref_player_stage as stage
where not exists (
  select 1
  from public.nba_player_external_ids as external_ids
  where external_ids.source_name = ${sourceSql}
    and external_ids.external_id = stage.external_id
);

insert into public.nba_players (
  id, full_name, normalized_name, primary_position,
  debut_season_end_year, final_season_end_year
)
select
  player_id, full_name, normalized_name, primary_position,
  ${year}, ${year}
from _nba_bref_new_players;

insert into public.nba_player_external_ids (
  source_name, external_id, player_id, is_primary_for_source
)
select ${sourceSql}, external_id, player_id, true
from _nba_bref_new_players
on conflict (source_name, external_id) do nothing;

update public.nba_players as players
set
  full_name = stage.full_name,
  normalized_name = stage.normalized_name,
  primary_position = case
    when stage.primary_position <> '' then stage.primary_position
    else players.primary_position
  end,
  debut_season_end_year = case
    when players.debut_season_end_year is null then ${year}
    when ${year} < players.debut_season_end_year then ${year}
    else players.debut_season_end_year
  end,
  final_season_end_year = case
    when players.final_season_end_year is null then ${year}
    when ${year} > players.final_season_end_year then ${year}
    else players.final_season_end_year
  end
from _nba_bref_player_stage as stage
join public.nba_player_external_ids as external_ids
  on external_ids.source_name = ${sourceSql}
 and external_ids.external_id = stage.external_id
where players.id = external_ids.player_id;

insert into public.nba_franchises (franchise_code, display_name, is_active)
select distinct franchise_code, franchise_name, true
from _nba_bref_team_stage
on conflict (franchise_code) do update set
  display_name = excluded.display_name,
  is_active = true;

insert into public.nba_team_seasons (
  franchise_id, season_end_year, team_code, team_name,
  city, conference, division, is_active
)
select
  franchises.id,
  ${year},
  stage.team_code,
  stage.team_name,
  stage.city,
  stage.conference,
  stage.division,
  true
from _nba_bref_team_stage as stage
join public.nba_franchises as franchises
  on franchises.franchise_code = stage.franchise_code
on conflict (season_end_year, team_code) do update set
  franchise_id = excluded.franchise_id,
  team_name = excluded.team_name,
  city = excluded.city,
  conference = excluded.conference,
  division = excluded.division,
  is_active = excluded.is_active;

with upserted_stats as (
  insert into public.nba_player_team_season_stats (
    player_id, season_end_year, team_season_id, team_code, season_phase,
    is_multi_team_aggregate, listed_position, player_age,
    games_played, games_started, minutes_played,
    field_goals_made, field_goals_attempted,
    three_point_field_goals_made, three_point_field_goals_attempted,
    free_throws_made, free_throws_attempted,
    offensive_rebounds, defensive_rebounds, total_rebounds,
    assists, steals, blocks, turnovers, personal_fouls, points,
    source_name, source_record_id, source_url, source_import_run_id
  )
  select
    external_ids.player_id,
    ${year},
    case when stage.is_multi_team_aggregate then null else team_seasons.id end,
    stage.team_code,
    ${phaseSql},
    stage.is_multi_team_aggregate,
    stage.listed_position,
    stage.player_age,
    stage.games_played,
    stage.games_started,
    stage.minutes_played,
    stage.field_goals_made,
    stage.field_goals_attempted,
    stage.three_point_field_goals_made,
    stage.three_point_field_goals_attempted,
    stage.free_throws_made,
    stage.free_throws_attempted,
    stage.offensive_rebounds,
    stage.defensive_rebounds,
    stage.total_rebounds,
    stage.assists,
    stage.steals,
    stage.blocks,
    stage.turnovers,
    stage.personal_fouls,
    stage.points,
    ${sourceSql},
    stage.source_record_id,
    stage.source_url,
    ${runIdSql}::uuid
  from _nba_bref_totals_stage as stage
  join public.nba_player_external_ids as external_ids
    on external_ids.source_name = ${sourceSql}
   and external_ids.external_id = stage.external_id
  left join public.nba_team_seasons as team_seasons
    on team_seasons.season_end_year = ${year}
   and team_seasons.team_code = stage.team_code
  on conflict (player_id, season_end_year, team_code, season_phase) do update set
    team_season_id = excluded.team_season_id,
    is_multi_team_aggregate = excluded.is_multi_team_aggregate,
    listed_position = excluded.listed_position,
    player_age = excluded.player_age,
    games_played = excluded.games_played,
    games_started = excluded.games_started,
    minutes_played = excluded.minutes_played,
    field_goals_made = excluded.field_goals_made,
    field_goals_attempted = excluded.field_goals_attempted,
    three_point_field_goals_made = excluded.three_point_field_goals_made,
    three_point_field_goals_attempted = excluded.three_point_field_goals_attempted,
    free_throws_made = excluded.free_throws_made,
    free_throws_attempted = excluded.free_throws_attempted,
    offensive_rebounds = excluded.offensive_rebounds,
    defensive_rebounds = excluded.defensive_rebounds,
    total_rebounds = excluded.total_rebounds,
    assists = excluded.assists,
    steals = excluded.steals,
    blocks = excluded.blocks,
    turnovers = excluded.turnovers,
    personal_fouls = excluded.personal_fouls,
    points = excluded.points,
    source_name = excluded.source_name,
    source_record_id = excluded.source_record_id,
    source_url = excluded.source_url,
    source_import_run_id = excluded.source_import_run_id
  returning id
)
insert into _nba_bref_import_counts (players_created, stat_rows_upserted, metric_rows_upserted)
select
  (select count(*)::integer from _nba_bref_new_players),
  (select count(*)::integer from upserted_stats),
  0;

with metric_candidates as (
  select
    stats.id as stat_id,
    metric.metric_code,
    (metric.metric_value)::numeric(18, 6) as metric_value
  from _nba_bref_advanced_stage as stage
  join public.nba_player_external_ids as external_ids
    on external_ids.source_name = ${sourceSql}
   and external_ids.external_id = stage.external_id
  join public.nba_player_team_season_stats as stats
    on stats.player_id = external_ids.player_id
   and stats.season_end_year = ${year}
   and stats.season_phase = ${phaseSql}
   and stats.team_code = stage.team_code
  cross join lateral jsonb_each_text(stage.metrics) as metric(metric_code, metric_value)
), upserted_metrics as (
  insert into public.nba_player_team_season_metric_values (
    stat_id, metric_code, metric_value, source_name, source_import_run_id
  )
  select stat_id, metric_code, metric_value, ${sourceSql}, ${runIdSql}::uuid
  from metric_candidates
  on conflict (stat_id, metric_code) do update set
    metric_value = excluded.metric_value,
    source_name = excluded.source_name,
    source_import_run_id = excluded.source_import_run_id
  returning stat_id
)
insert into _nba_bref_import_counts (players_created, stat_rows_upserted, metric_rows_upserted)
select 0, 0, count(*)::integer from upserted_metrics;
${rawRowsSql}
select jsonb_build_object(
  'players_created', coalesce(sum(players_created), 0),
  'stat_rows_upserted', coalesce(sum(stat_rows_upserted), 0),
  'metric_rows_upserted', coalesce(sum(metric_rows_upserted), 0)
) as result
from _nba_bref_import_counts;

commit;
`;
}

function buildCreateRunSql({ runId, start, end }) {
  return `
insert into public.nba_stat_import_runs (
  id, source_name, source_url, source_license_note, rights_confirmed,
  requested_season_start, requested_season_end, status, started_at
)
values (
  ${sqlUuid(runId)}::uuid,
  ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)},
  ${sqlLiteral('https://www.basketball-reference.com/')},
  ${sqlLiteral(SOURCE_LICENSE_NOTE)},
  true,
  ${start},
  ${end},
  'running',
  now()
)
on conflict (id) do update set
  status = 'running',
  error_summary = '',
  finished_at = null;
select ${sqlUuid(runId)}::uuid as import_run_id;
`;
}

function buildUpdateRunSql({ runId, status, playersCreated, errorSummary = '', skipRaw }) {
  const sourceCounts = skipRaw
    ? `records_read = records_read`
    : `records_read = (
      select count(*)::integer
      from public.nba_stat_source_records as source_records
      where source_records.import_run_id = ${sqlUuid(runId)}::uuid
    )`;
  return `
update public.nba_stat_import_runs
set
  ${sourceCounts},
  players_created = ${Math.max(0, Number(playersCreated) || 0)},
  stat_rows_upserted = (
    select count(*)::integer
    from public.nba_player_team_season_stats as stats
    where stats.source_import_run_id = ${sqlUuid(runId)}::uuid
  ),
  metric_rows_upserted = (
    select count(*)::integer
    from public.nba_player_team_season_metric_values as metrics
    where metrics.source_import_run_id = ${sqlUuid(runId)}::uuid
  ),
  status = ${sqlLiteral(status)},
  error_summary = ${sqlLiteral(String(errorSummary).slice(0, 1200))},
  finished_at = case when ${sqlLiteral(status)} in ('completed', 'failed', 'cancelled') then now() else null end
where id = ${sqlUuid(runId)}::uuid;
select id, status, records_read, players_created, stat_rows_upserted, metric_rows_upserted
from public.nba_stat_import_runs
where id = ${sqlUuid(runId)}::uuid;
`;
}

function parseCliJson(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function executeLinkedSql(sql, label) {
  const workDirectory = ensureDirectory(path.join(ROOT, 'outputs', 'nba-basketball-reference-import-work'));
  const sqlPath = path.join(workDirectory, `${safeFileSegment(label)}.sql`);
  fs.writeFileSync(sqlPath, sql, 'utf8');
  const npxArgs = [
    '--yes',
    'supabase@2.84.2',
    'db',
    'query',
    '--linked',
    '--file',
    sqlPath,
    '--output',
    'json'
  ];
  // On Windows, npx is a .cmd shim, which Node cannot launch directly without
  // a shell. Prefer its installed JavaScript entrypoint to retain an argument
  // array and avoid shell interpolation of the generated SQL path.
  const installedNpxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const useInstalledNpxCli = fs.existsSync(installedNpxCli);
  const command = useInstalledNpxCli ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const args = useInstalledNpxCli ? [installedNpxCli, ...npxArgs] : npxArgs;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      shell: !useInstalledNpxCli && process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || 'Unknown Supabase CLI error').trim().slice(0, 2000);
    throw new Error(`Linked Supabase SQL failed for ${label}: ${detail}`);
  }
  return parseCliJson(result.stdout)?.rows ?? [];
}

function checkpointPath({ start, end, phases }) {
  const checkpointDirectory = ensureDirectory(path.join(ROOT, 'outputs', 'nba-basketball-reference-import-checkpoints'));
  return path.join(checkpointDirectory, `bref-${start}-${end}-${phases.join('-')}.json`);
}

function blankCheckpoint({ runId, start, end, phases }) {
  return {
    version: 1,
    runId,
    sourceName: BASKETBALL_REFERENCE_SOURCE,
    seasonStart: start,
    seasonEnd: end,
    phases,
    status: 'running',
    completed: {},
    playersCreated: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function validateCheckpoint(checkpoint, options) {
  if (!checkpoint || checkpoint.version !== 1) return false;
  if (!/^[0-9a-f-]{36}$/i.test(String(checkpoint.runId))) return false;
  return checkpoint.sourceName === BASKETBALL_REFERENCE_SOURCE
    && checkpoint.seasonStart === options.start
    && checkpoint.seasonEnd === options.end
    && JSON.stringify(checkpoint.phases) === JSON.stringify(options.phases)
    && checkpoint.status !== 'completed';
}

function saveCheckpoint(filePath, checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  writeJson(filePath, checkpoint);
}

function createPageFetcher({ cacheDirectory, requestDelayMs, refreshCache, robots }) {
  let lastNetworkRequestAt = 0;
  return async function fetchPage({ url, cacheFile }) {
    if (!refreshCache && fs.existsSync(cacheFile)) {
      logSourceEvent('source_cache_hit', { url, cacheFile: path.relative(ROOT, cacheFile) });
      return fs.readFileSync(cacheFile, 'utf8');
    }
    const pathname = new URL(url).pathname;
    // Team and player media pages are discovered only after parsing a season,
    // so enforce the same robots policy at request time for every dynamic URL.
    if (!isPathAllowedByRobots(pathname, robots, USER_AGENT)) {
      throw new Error(`Basketball Reference robots.txt disallows ${pathname}.`);
    }
    const waitTime = requestDelayMs - (Date.now() - lastNetworkRequestAt);
    if (waitTime > 0) await sleep(waitTime);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      lastNetworkRequestAt = Date.now();
      logSourceEvent('source_request_started', { url, attempt, maximumAttempts: 3 });
      let response;
      try {
        response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
          signal: AbortSignal.timeout(45000)
        });
      } catch (error) {
        if (attempt === 3) throw error;
        const retryDelayMs = Math.min(120000, requestDelayMs * (2 ** (attempt - 1)));
        logSourceEvent('source_request_retry', {
          url,
          attempt,
          retryDelayMs,
          reason: String(error?.message ?? error).slice(0, 240)
        });
        await sleep(retryDelayMs);
        continue;
      }
      if (response.ok) {
        const body = await response.text();
        ensureDirectory(path.dirname(cacheFile));
        fs.writeFileSync(cacheFile, body, 'utf8');
        logSourceEvent('source_request_completed', { url, attempt, status: response.status, bytes: Buffer.byteLength(body) });
        return body;
      }
      const responseText = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
      if (attempt === 3 || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        const sourceError = new Error(`Source request failed (${response.status}) for ${url}: ${responseText}`);
        sourceError.status = response.status;
        throw sourceError;
      }
      const retryDelayMs = Math.min(120000, Math.max(
        requestDelayMs * (2 ** (attempt - 1)),
        retryAfterMilliseconds(response.headers.get('retry-after'))
      ));
      logSourceEvent('source_request_retry', { url, attempt, status: response.status, retryDelayMs });
      await sleep(retryDelayMs);
    }
    throw new Error(`Source request failed for ${url}.`);
  };
}

async function loadSeasonPhase({ seasonEndYear, seasonPhase, fetchPage, cacheDirectory, skipAdvanced }) {
  const urls = seasonPageUrls(seasonEndYear, seasonPhase);
  const totalsHtml = await fetchPage({
    url: urls.totals,
    cacheFile: sourceCacheFile(cacheDirectory, seasonEndYear, seasonPhase, 'totals')
  });
  const totals = parseTotalsPage(totalsHtml, { seasonEndYear, seasonPhase, sourceUrl: urls.totals });
  if (!totals.rows.length) {
    throw new Error(`No ${seasonPhase} totals rows were found for season ${seasonEndYear} (${urls.totals}).`);
  }
  let advanced = { tableId: '', rows: [] };
  if (!skipAdvanced) {
    const advancedHtml = await fetchPage({
      url: urls.advanced,
      cacheFile: sourceCacheFile(cacheDirectory, seasonEndYear, seasonPhase, 'advanced')
    });
    advanced = parseAdvancedPage(advancedHtml, { seasonEndYear, seasonPhase, sourceUrl: urls.advanced });
    if (!advanced.rows.length) {
      throw new Error(`No ${seasonPhase} advanced rows were found for season ${seasonEndYear} (${urls.advanced}).`);
    }
  }
  return { totals, advanced };
}

async function loadTeamNames({ seasonEndYear, fetchPage, cacheDirectory }) {
  const url = leaguePageUrl(seasonEndYear);
  const html = await fetchPage({
    url,
    cacheFile: sourceCacheFile(cacheDirectory, seasonEndYear, 'league', 'teams')
  });
  const teamNames = parseLeagueTeamsPage(html, { seasonEndYear });
  if (!teamNames.size) throw new Error(`No team rows were found for season ${seasonEndYear} (${url}).`);
  return teamNames;
}

async function fetchMediaAsset(url, cacheFile, fetchPage) {
  const html = await fetchPage({ url, cacheFile });
  return html;
}

function buildMediaSql({ runId, mediaRows }) {
  if (!mediaRows.length) return '';
  return `
begin;
create temporary table _nba_bref_media_stage (
  subject_type text not null,
  external_id text,
  season_end_year smallint,
  team_code text,
  asset_kind text not null,
  asset_url text not null,
  alt_text text not null,
  source_url text not null
) on commit drop;
insert into _nba_bref_media_stage
select *
from jsonb_to_recordset(${sqlJson(mediaRows)}) as row_data(
  subject_type text,
  external_id text,
  season_end_year smallint,
  team_code text,
  asset_kind text,
  asset_url text,
  alt_text text,
  source_url text
);

update public.nba_media_assets as media
set
  asset_url = stage.asset_url,
  alt_text = stage.alt_text,
  source_name = ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)},
  source_url = stage.source_url,
  source_license_note = ${sqlLiteral(SOURCE_LICENSE_NOTE)},
  rights_confirmed = true,
  is_primary = true
from _nba_bref_media_stage as stage
left join public.nba_player_external_ids as external_ids
  on stage.subject_type = 'player'
 and external_ids.source_name = ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)}
 and external_ids.external_id = stage.external_id
left join public.nba_team_seasons as team_seasons
  on stage.subject_type = 'team'
 and team_seasons.season_end_year = stage.season_end_year
 and team_seasons.team_code = stage.team_code
where media.is_primary
  and media.asset_kind = stage.asset_kind
  and (
    (stage.subject_type = 'player' and media.player_id = external_ids.player_id)
    or (stage.subject_type = 'team' and media.team_season_id = team_seasons.id)
  );

insert into public.nba_media_assets (
  player_id, team_season_id, asset_kind, asset_url, alt_text,
  source_name, source_url, source_license_note, rights_confirmed, is_primary
)
select
  case when stage.subject_type = 'player' then external_ids.player_id end,
  case when stage.subject_type = 'team' then team_seasons.id end,
  stage.asset_kind,
  stage.asset_url,
  stage.alt_text,
  ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)},
  stage.source_url,
  ${sqlLiteral(SOURCE_LICENSE_NOTE)},
  true,
  true
from _nba_bref_media_stage as stage
left join public.nba_player_external_ids as external_ids
  on stage.subject_type = 'player'
 and external_ids.source_name = ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)}
 and external_ids.external_id = stage.external_id
left join public.nba_team_seasons as team_seasons
  on stage.subject_type = 'team'
 and team_seasons.season_end_year = stage.season_end_year
 and team_seasons.team_code = stage.team_code
where (
  (stage.subject_type = 'player' and external_ids.player_id is not null)
  or (stage.subject_type = 'team' and team_seasons.id is not null)
)
and not exists (
  select 1
  from public.nba_media_assets as existing_media
  where existing_media.is_primary
    and existing_media.asset_kind = stage.asset_kind
    and (
      (stage.subject_type = 'player' and existing_media.player_id = external_ids.player_id)
      or (stage.subject_type = 'team' and existing_media.team_season_id = team_seasons.id)
    )
);
select count(*)::integer as media_candidates from _nba_bref_media_stage;
commit;
`;
}

async function collectSmallMediaSample({
  seasonEndYear,
  totals,
  teamNames,
  fetchPage,
  cacheDirectory,
  limit,
  teamCode = '',
}) {
  if (!limit) return [];
  const mediaRows = [];
  const seenPlayers = new Set();
  const seenTeams = new Set();
  for (const row of totals.rows) {
    // A focused batch makes the default live team visually rich without
    // crawling a whole league's profile pages. Stats are never filtered by
    // this option; it changes only optional media discovery.
    if (teamCode && row.teamCode !== teamCode) continue;
    if (mediaRows.length >= limit) break;
    if (!seenPlayers.has(row.externalId)) {
      seenPlayers.add(row.externalId);
      const profileUrl = basketballReferencePlayerPageUrl(row.externalId);
      try {
        const profileHtml = await fetchMediaAsset(
          profileUrl,
          sourceCacheFile(cacheDirectory, seasonEndYear, 'media', `player-${row.externalId}`),
          fetchPage
        );
        const assetUrl = extractHeadshotAsset(profileHtml, row.externalId);
        if (assetUrl) {
          mediaRows.push({
            subject_type: 'player',
            external_id: row.externalId,
            season_end_year: null,
            team_code: null,
            asset_kind: 'headshot',
            asset_url: assetUrl,
            alt_text: `${row.fullName} headshot`,
            source_url: profileUrl
          });
        }
      } catch (error) {
        console.warn(`Skipping unavailable headshot source for ${row.externalId}: ${String(error?.message ?? error).slice(0, 160)}`);
      }
    }
    if (mediaRows.length >= limit || row.isMultiTeamAggregate || seenTeams.has(row.teamCode)) continue;
    seenTeams.add(row.teamCode);
    const teamUrl = basketballReferenceTeamPageUrl(row.teamCode, seasonEndYear);
    try {
      const teamHtml = await fetchMediaAsset(
        teamUrl,
        sourceCacheFile(cacheDirectory, seasonEndYear, 'media', `team-${row.teamCode}`),
        fetchPage
      );
      const assetUrl = extractTeamLogoAsset(teamHtml, row.teamCode, seasonEndYear);
      if (assetUrl) {
        mediaRows.push({
          subject_type: 'team',
          external_id: null,
          season_end_year: seasonEndYear,
          team_code: row.teamCode,
          asset_kind: 'team_logo',
          asset_url: assetUrl,
          alt_text: `${teamNames.get(row.teamCode) || row.teamCode} logo`,
          source_url: teamUrl
        });
      }
    } catch (error) {
      console.warn(`Skipping unavailable team-logo source for ${row.teamCode} ${seasonEndYear}: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  return mediaRows;
}

async function runMediaOnly({ options, fetchPage, cacheDirectory }) {
  if (!options.apply) throw new Error('--media-only requires --apply because it writes confirmed media rows.');
  if (!options.mediaLimit) throw new Error('--media-only requires a positive --media-limit.');
  let imported = 0;
  for (let seasonEndYear = options.start; seasonEndYear <= options.end && imported < options.mediaLimit; seasonEndYear += 1) {
    const teamNames = await loadTeamNames({ seasonEndYear, fetchPage, cacheDirectory });
    const { totals } = await loadSeasonPhase({
      seasonEndYear,
      seasonPhase: 'regular',
      fetchPage,
      cacheDirectory,
      skipAdvanced: true
    });
    const mediaRows = await collectSmallMediaSample({
      seasonEndYear,
      totals,
      teamNames,
      fetchPage,
      cacheDirectory,
      limit: options.mediaLimit - imported,
      teamCode: options.mediaTeamCode,
    });
    if (!mediaRows.length) {
      if (options.mediaTeamCode) {
        throw new Error(`No verified media candidates were found for ${options.mediaTeamCode} in ${seasonEndYear}.`);
      }
      continue;
    }
    await executeLinkedSql(buildMediaSql({ mediaRows }), `media-only-${seasonEndYear}`);
    imported += mediaRows.length;
    console.log(JSON.stringify({ seasonEndYear, mediaImported: mediaRows.length, mediaImportedTotal: imported }, null, 2));
  }
  console.log(JSON.stringify({ mode: 'media-only', requested: options.mediaLimit, imported }, null, 2));
}

async function run() {
  const options = optionsFromArgs(process.argv.slice(2));
  const sourcePolicy = await verifySourceAutomation(options);
  options.requestDelayMs = sourcePolicy.effectiveDelayMs;
  const cacheDirectory = ensureDirectory(path.join(ROOT, 'outputs', 'nba-basketball-reference-cache'));
  const fetchPage = createPageFetcher({
    cacheDirectory,
    requestDelayMs: options.requestDelayMs,
    refreshCache: options.refreshCache,
    robots: sourcePolicy.robots,
  });
  if (options.mediaOnly) {
    await runMediaOnly({ options, fetchPage, cacheDirectory });
    return;
  }
  const checkpointFile = checkpointPath(options);
  const existingCheckpoint = options.newRun ? null : readJson(checkpointFile);
  const checkpoint = options.apply && validateCheckpoint(existingCheckpoint, options)
    ? existingCheckpoint
    : blankCheckpoint({ runId: crypto.randomUUID(), ...options });

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    seasonStart: options.start,
    seasonEnd: options.end,
    phases: options.phases,
    skipAdvanced: options.skipAdvanced,
    skipRaw: options.skipRaw,
    requestDelayMs: options.requestDelayMs,
    resumedRun: Boolean(options.apply && validateCheckpoint(existingCheckpoint, options)),
    importRunId: options.apply ? checkpoint.runId : null
  }, null, 2));

  if (options.apply) {
    await executeLinkedSql(buildCreateRunSql({ runId: checkpoint.runId, start: options.start, end: options.end }), 'create-run');
    saveCheckpoint(checkpointFile, checkpoint);
  }

  try {
    for (let seasonEndYear = options.start; seasonEndYear <= options.end; seasonEndYear += 1) {
      const teamNames = await loadTeamNames({ seasonEndYear, fetchPage, cacheDirectory });
      for (const seasonPhase of options.phases) {
        const completedKey = `${seasonEndYear}:${seasonPhase}`;
        if (options.apply && checkpoint.completed[completedKey]) {
          console.log(`Skipping ${completedKey}; it is already recorded in the checkpoint.`);
          continue;
        }

        console.log(`Loading ${seasonEndYear} ${seasonPhase} pages...`);
        let loadedSeasonPhase;
        try {
          loadedSeasonPhase = await loadSeasonPhase({
            seasonEndYear,
            seasonPhase,
            fetchPage,
            cacheDirectory,
            skipAdvanced: options.skipAdvanced
          });
        } catch (error) {
          const unavailablePlayoffs = seasonPhase === 'playoffs'
            && options.allowMissingPlayoffs
            && (error?.status === 404 || /^No playoffs (?:totals|advanced) rows were found\b/.test(String(error?.message ?? error)));
          if (!unavailablePlayoffs) throw error;
          logSourceEvent('season_phase_skipped', {
            seasonEndYear,
            seasonPhase,
            reason: String(error?.message ?? error).slice(0, 400)
          });
          continue;
        }
        const { totals, advanced } = loadedSeasonPhase;
        const totalRows = totalStageRows(totals.rows, seasonEndYear, seasonPhase);
        const advancedRows = advancedStageRows(advanced.rows, seasonEndYear, seasonPhase);
        const players = playerStageRows(totals.rows, advanced.rows);
        const teams = teamStageRows(totals.rows, teamNames);

        if (!options.apply) {
          console.log(JSON.stringify({
            seasonEndYear,
            seasonPhase,
            totalsTable: totals.tableId,
            advancedTable: advanced.tableId || null,
            totalRows: totalRows.length,
            advancedRows: advancedRows.length,
            playerCandidates: players.length,
            teamSeasons: teams.length,
            aggregateRows: totalRows.filter((row) => row.is_multi_team_aggregate).length,
            metricCandidates: advancedRows.reduce((sum, row) => sum + Object.keys(row.metrics).length, 0)
          }, null, 2));
          continue;
        }

        console.log(`Upserting ${seasonEndYear} ${seasonPhase}: ${totalRows.length} stat rows, ${advancedRows.length} advanced rows...`);
        const rows = await executeLinkedSql(buildSeasonPhaseSql({
          runId: checkpoint.runId,
          seasonEndYear,
          seasonPhase,
          totalRows,
          advancedRows,
          playerRows: players,
          teamRows: teams,
          skipRaw: options.skipRaw
        }), `import-${checkpoint.runId}-${seasonEndYear}-${seasonPhase}`);
        const result = rows[0]?.result ?? {};
        checkpoint.playersCreated += Number(result.players_created) || 0;
        checkpoint.completed[completedKey] = {
          completedAt: new Date().toISOString(),
          totals: totalRows.length,
          advanced: advancedRows.length,
          playersCreated: Number(result.players_created) || 0,
          statRowsUpserted: Number(result.stat_rows_upserted) || 0,
          metricRowsUpserted: Number(result.metric_rows_upserted) || 0
        };
        checkpoint.status = 'running';
        saveCheckpoint(checkpointFile, checkpoint);
        const runRows = await executeLinkedSql(buildUpdateRunSql({
          runId: checkpoint.runId,
          status: 'running',
          playersCreated: checkpoint.playersCreated,
          skipRaw: options.skipRaw
        }), `update-run-${checkpoint.runId}`);
        console.log(JSON.stringify({ seasonEndYear, seasonPhase, ...checkpoint.completed[completedKey], importRun: runRows[0] ?? null }, null, 2));

        if (options.mediaLimit > 0) {
          const remaining = Math.max(0, options.mediaLimit - (checkpoint.mediaImported ?? 0));
          if (remaining > 0) {
            const mediaRows = await collectSmallMediaSample({
              seasonEndYear,
              totals,
              teamNames,
              fetchPage,
              cacheDirectory,
              limit: remaining,
              teamCode: options.mediaTeamCode,
            });
            if (mediaRows.length) {
              await executeLinkedSql(buildMediaSql({ runId: checkpoint.runId, mediaRows }), `media-${checkpoint.runId}-${seasonEndYear}-${seasonPhase}`);
              checkpoint.mediaImported = (checkpoint.mediaImported ?? 0) + mediaRows.length;
              saveCheckpoint(checkpointFile, checkpoint);
              console.log(`Imported ${mediaRows.length} verified media record(s) for ${seasonEndYear} ${seasonPhase}.`);
            }
          }
        }
      }
    }
    if (options.apply) {
      checkpoint.status = 'completed';
      saveCheckpoint(checkpointFile, checkpoint);
      const finalRows = await executeLinkedSql(buildUpdateRunSql({
        runId: checkpoint.runId,
        status: 'completed',
        playersCreated: checkpoint.playersCreated,
        skipRaw: options.skipRaw
      }), `complete-run-${checkpoint.runId}`);
      console.log(JSON.stringify({ mode: 'apply', checkpoint: checkpointFile, importRun: finalRows[0] ?? null }, null, 2));
    } else {
      console.log('Dry-run completed; no Supabase rows were written.');
    }
  } catch (error) {
    if (options.apply) {
      checkpoint.status = 'failed';
      checkpoint.error = String(error?.message ?? error).slice(0, 1200);
      saveCheckpoint(checkpointFile, checkpoint);
      try {
        await executeLinkedSql(buildUpdateRunSql({
          runId: checkpoint.runId,
          status: 'failed',
          playersCreated: checkpoint.playersCreated,
          errorSummary: checkpoint.error,
          skipRaw: options.skipRaw
        }), `fail-run-${checkpoint.runId}`);
      } catch (updateError) {
        console.error(`Could not mark import run failed: ${String(updateError?.message ?? updateError)}`);
      }
    }
    throw error;
  }
}

run().catch((error) => {
  console.error(`NBA Basketball Reference import failed: ${String(error?.stack ?? error)}`);
  process.exitCode = 1;
});
