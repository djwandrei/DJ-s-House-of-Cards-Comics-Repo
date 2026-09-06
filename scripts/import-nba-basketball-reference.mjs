#!/usr/bin/env node

/**
 * Import NBA player-team-season statistics from Basketball Reference into the
 * dedicated DJHC NBA analytics Supabase project.
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
import { pathToFileURL } from 'node:url';
import {
  BASKETBALL_REFERENCE_SOURCE,
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
import {
  MediaRequestLimitReachedError,
  basketballReferenceMediaPageUrl,
  blankMediaCheckpoint,
  buildDerivedTeamLogoAssetPlan,
  buildMediaCandidateQuery,
  buildTrustedTeamLogoRevisionCatalog,
  createMediaRequestBudget,
  hasConfirmedExistingMedia,
  isExactBasketballReferenceMediaPageUrl,
  isMatchingMediaCheckpoint,
  mediaCacheRelativePath,
  normalizeMediaCandidateRows,
  normalizedMediaAltText,
  recordMediaCandidateStatus,
  shouldAttemptMediaCandidate,
  validatedBasketballReferenceMediaUrl,
} from './lib/nba-media-backfill.mjs';

const ROOT = process.cwd();
// NBA player/team/season facts deliberately live outside the commerce project.
// Keep the identifier and working directory adjacent to the importer so an
// operator cannot accidentally write a full Basketball Reference refresh into
// the storefront database merely because that is the repository's root link.
const ANALYTICS_PROJECT_REF = 'fbbmuqbdpgsmvnezowwn';
const ANALYTICS_WORKDIR = path.join(ROOT, 'supabase-analytics');
const ANALYTICS_CLI_VERSION = '2.115.0';
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
  --apply                     Write to the dedicated NBA analytics project; otherwise dry-run
  --analytics                 Confirm the dedicated NBA analytics target for --apply
  --request-delay-ms <ms>     Delay between uncached source requests (default: 4000; minimum: 3000)
  --refresh-cache             Re-fetch pages instead of using the local source cache
  --allow-missing-playoffs    Skip an unavailable/empty playoffs phase (current-season refreshes only)
  --skip-advanced             Import traditional totals only
  --skip-raw                  Skip private raw-source audit rows (not recommended for production)
  --new-run                   Do not reuse a matching incomplete local checkpoint
  --media-request-limit <n>   Maximum actual uncached media HTTP attempts (default: 0)
  --media-limit <count>       Deprecated alias for --media-request-limit
  --media-batch-size <count>  Idempotent Supabase media write batch size (default: 25; max: 100)
  --media-only                Backfill only verified media; do not touch stat rows
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
  * --apply always requires --analytics. The repository root is linked to the
    commerce project, which must never receive duplicate Lineup Lab facts.
  * Media-only checkpoints skip found/no-image candidates and retry temporary
    failures. Use --new-run with --refresh-cache to intentionally recheck
    previously confirmed no-image pages.
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
  const legacyMediaLimit = options.get('media-limit');
  const mediaRequestLimit = readInteger(
    options.get('media-request-limit') ?? legacyMediaLimit ?? 0,
    '--media-request-limit',
    { min: 0, max: 100000 }
  );
  if (options.has('media-request-limit') && legacyMediaLimit !== undefined) {
    throw new Error('Use either --media-request-limit or the deprecated --media-limit alias, not both.');
  }
  const mediaBatchSize = readInteger(options.get('media-batch-size') ?? 25, '--media-batch-size', { min: 1, max: 100 });
  const apply = flags.has('apply');
  const analytics = flags.has('analytics');
  const mediaOnly = flags.has('media-only');
  if (apply && !analytics) {
    throw new Error('--apply requires --analytics because Lineup Lab facts belong only in the dedicated NBA analytics project.');
  }
  if (mediaOnly && !apply) throw new Error('--media-only requires --apply because it writes confirmed media rows.');
  if (mediaOnly && mediaRequestLimit < 1) {
    throw new Error('--media-only requires a positive --media-request-limit (or deprecated --media-limit alias).');
  }
  return {
    apply,
    analytics,
    start,
    end,
    phases: [...new Set(phases)],
    requestDelayMs,
    refreshCache: flags.has('refresh-cache'),
    allowMissingPlayoffs: flags.has('allow-missing-playoffs'),
    skipAdvanced: flags.has('skip-advanced'),
    skipRaw: flags.has('skip-raw'),
    newRun: flags.has('new-run'),
    mediaRequestLimit,
    mediaBatchSize,
    mediaOnly,
    mediaTeamCode: readOptionalTeamCode(options.get('media-team-code')),
  };
}

/**
 * Return the one allowed database destination for Basketball Reference NBA
 * writes. The explicit linked-project check protects against a stale local
 * Supabase CLI link as well as the root commerce project's normal link.
 */
function analyticsDatabaseTarget() {
  const configPath = path.join(ANALYTICS_WORKDIR, 'supabase', 'config.toml');
  const linkedProjectPath = path.join(ANALYTICS_WORKDIR, 'supabase', '.temp', 'project-ref');
  if (!fs.existsSync(configPath)) {
    throw new Error('Dedicated NBA analytics Supabase configuration is missing. Refusing to target another project.');
  }
  if (!fs.existsSync(linkedProjectPath)) {
    throw new Error(
      `Dedicated NBA analytics project is not linked. Run \`supabase link --workdir supabase-analytics --project-ref ${ANALYTICS_PROJECT_REF}\` before an apply run.`
    );
  }
  const linkedProjectRef = fs.readFileSync(linkedProjectPath, 'utf8').trim();
  if (linkedProjectRef !== ANALYTICS_PROJECT_REF) {
    throw new Error(
      `Dedicated NBA analytics workdir is linked to ${linkedProjectRef || 'no project'}, not ${ANALYTICS_PROJECT_REF}. Refusing to write.`
    );
  }
  return Object.freeze({
    label: 'dedicated NBA analytics project',
    projectRef: ANALYTICS_PROJECT_REF,
    workdir: ANALYTICS_WORKDIR,
    cliVersion: ANALYTICS_CLI_VERSION,
  });
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
  // A media-only run discovers its exact player/team URLs from the linked
  // database after this initial policy check. Each of those dynamic paths is
  // still checked immediately before fetch by createPageFetcher().
  if (!options.mediaOnly) {
    for (let seasonEndYear = options.start; seasonEndYear <= options.end; seasonEndYear += 1) {
      for (const pathname of sourcePathsForSeason(seasonEndYear, sourcePhase)) checkedPaths.add(pathname);
    }
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

-- The NBA base schema keeps a universal athlete identity alongside the
-- sport-specific nba_players row. Older imports predated that constraint, so
-- every newly discovered historical player must create the identity and its
-- NBA membership before the sport row is inserted.
insert into public.athletes (id, canonical_name, normalized_name)
select player_id, full_name, normalized_name
from _nba_bref_new_players
on conflict (id) do update set
  canonical_name = excluded.canonical_name,
  normalized_name = excluded.normalized_name,
  updated_at = now();

insert into public.athlete_league_memberships (
  athlete_id, league_code, membership_status, source_name, evidence
)
select player_id, 'NBA', 'verified', ${sourceSql}, jsonb_build_object('external_id', external_id)
from _nba_bref_new_players
on conflict (athlete_id, league_code) do update set
  membership_status = 'verified', source_name = excluded.source_name,
  evidence = excluded.evidence, updated_at = now();

insert into public.athlete_aliases (
  athlete_id, league_code, alias, normalized_alias, alias_type, review_state, source_name, evidence
)
select player_id, 'NBA', full_name, normalized_name, 'canonical', 'verified', ${sourceSql},
  jsonb_build_object('external_id', external_id)
from _nba_bref_new_players
on conflict (athlete_id, league_code, normalized_alias) do update set
  alias = excluded.alias, review_state = 'verified', source_name = excluded.source_name,
  evidence = excluded.evidence, updated_at = now();

insert into public.athlete_external_ids (
  athlete_id, league_code, source_name, external_id, is_primary_for_source
)
select player_id, 'NBA', ${sourceSql}, external_id, true
from _nba_bref_new_players
on conflict (league_code, source_name, external_id) do update set
  athlete_id = excluded.athlete_id, is_primary_for_source = true, updated_at = now();

insert into public.nba_players (
  id, athlete_id, full_name, normalized_name, primary_position,
  debut_season_end_year, final_season_end_year
)
select
  player_id, player_id, full_name, normalized_name, primary_position,
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
  // Supabase CLI 2.84 emits a bare JSON row array when stdout is piped, while
  // newer/interactive builds may wrap the same rows in an object containing a
  // security boundary and warning. Accept both documented shapes.
  const trimmed = stdout.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const rows = JSON.parse(trimmed);
      if (Array.isArray(rows)) return { rows };
    } catch {
      // Continue to the envelope scanner so its diagnostic identifies the
      // malformed structure instead of misreporting a legitimate empty set.
    }
  }
  // The CLI can place status text and, in some versions, more than one JSON
  // envelope on stdout. Slicing from the first opening brace to the final
  // closing brace makes two individually valid envelopes become one invalid
  // JSON document. Walk complete top-level objects instead, respecting braces
  // inside quoted strings, and return the database response containing rows.
  let objectStart = -1;
  let depth = 0;
  let insideString = false;
  let escaped = false;
  let completedObjects = 0;
  let lastParseError = '';
  for (let index = 0; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (objectStart < 0) {
      if (character !== '{') continue;
      objectStart = index;
      depth = 1;
      insideString = false;
      escaped = false;
      continue;
    }
    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }
    if (character === '"') {
      insideString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth !== 0) continue;
      completedObjects += 1;
      try {
        const payload = JSON.parse(stdout.slice(objectStart, index + 1));
        if (Array.isArray(payload?.rows)) return payload;
      } catch (error) {
        // Remember only the parser's structural diagnostic, never database
        // row contents. This makes a future CLI-format regression actionable
        // without placing player data or credentials in the runner log.
        lastParseError = String(error?.message ?? error).slice(0, 240);
      }
      objectStart = -1;
    }
  }
  if (lastParseError) {
    throw new Error(`Could not parse ${completedObjects} CLI JSON object(s): ${lastParseError}`);
  }
  if (objectStart >= 0) {
    // Include only structural state and the final character codes. The latter
    // distinguishes true output truncation from a scanner bug without logging
    // any row values from the linked database.
    const tailCodes = [...stdout.slice(-24)].map((character) => character.charCodeAt(0)).join(',');
    throw new Error(
      `CLI JSON object was incomplete (depth ${depth}, inString ${insideString}, `
      + `characters ${stdout.length}, tail codes ${tailCodes}).`
    );
  }
  return null;
}

async function executeLinkedSql(sql, label, databaseTarget = null) {
  const target = databaseTarget || Object.freeze({
    label: 'repository-root linked project',
    workdir: ROOT,
    cliVersion: '2.84.2',
  });
  if (!path.isAbsolute(target.workdir) || !fs.existsSync(target.workdir)) {
    throw new Error(`Linked Supabase SQL target is not an existing absolute workdir for ${label}.`);
  }
  const workDirectory = ensureDirectory(path.join(ROOT, 'outputs', 'nba-basketball-reference-import-work'));
  const sqlPath = path.join(workDirectory, `${safeFileSegment(label)}.sql`);
  fs.writeFileSync(sqlPath, sql, 'utf8');
  const npxArgs = [
    '--yes',
    `supabase@${target.cliVersion}`,
    'db',
    'query',
    '--linked',
    '--workdir',
    target.workdir,
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
      cwd: target.workdir,
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
  // Do not silently turn malformed/truncated CLI output into an empty query
  // result. For a media run that would look exactly like "there are no NBA
  // players to process" and could incorrectly stop a resumable backfill. A
  // valid query may return an empty rows array; invalid JSON is operationally
  // different and must reach the runner as a retryable failure.
  const payload = parseCliJson(result.stdout);
  if (!payload || !Array.isArray(payload.rows)) {
    const stderrHint = String(result.stderr ?? '').trim().slice(0, 500);
    const headCodes = [...result.stdout.slice(0, 32)].map((character) => character.charCodeAt(0)).join(',');
    const tailCodes = [...result.stdout.slice(-32)].map((character) => character.charCodeAt(0)).join(',');
    throw new Error(
      `Linked Supabase SQL returned invalid JSON for ${label} `
      + `(stdout characters: ${result.stdout.length}; head codes: ${headCodes}; tail codes: ${tailCodes}`
      + `${stderrHint ? `; ${stderrHint}` : ''}).`
    );
  }
  return payload.rows;
}

function checkpointPath({ start, end, phases, analytics = false }) {
  const checkpointDirectory = ensureDirectory(path.join(ROOT, 'outputs', 'nba-basketball-reference-import-checkpoints'));
  const targetPrefix = analytics ? 'bref-analytics' : 'bref';
  return path.join(checkpointDirectory, `${targetPrefix}-${start}-${end}-${phases.join('-')}.json`);
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

function createPageFetcher({
  cacheDirectory,
  requestDelayMs,
  refreshCache,
  robots,
  mediaRequestBudget = null,
  fetchImplementation = globalThis.fetch,
  sleepImplementation = sleep,
}) {
  let lastNetworkRequestAt = 0;
  return async function fetchPage({ url, cacheFile, requestKind = 'stats' }) {
    const pathname = new URL(url).pathname;
    // Apply the current policy even to cache reads. That keeps a resumed run
    // from using a page whose path became disallowed after the cache was made.
    if (!isPathAllowedByRobots(pathname, robots, USER_AGENT)) {
      throw new Error(`Basketball Reference robots.txt disallows ${pathname}.`);
    }
    if (!refreshCache && fs.existsSync(cacheFile)) {
      logSourceEvent('source_cache_hit', { url, cacheFile: path.relative(ROOT, cacheFile) });
      return fs.readFileSync(cacheFile, 'utf8');
    }
    const waitTime = requestDelayMs - (Date.now() - lastNetworkRequestAt);
    if (waitTime > 0) await sleepImplementation(waitTime);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Count every real HTTP attempt, including retries. Cache hits return
      // above and therefore never consume the operator's media request budget.
      const mediaRequestNumber = requestKind === 'media' && mediaRequestBudget
        ? mediaRequestBudget.consume()
        : null;
      lastNetworkRequestAt = Date.now();
      logSourceEvent('source_request_started', {
        url,
        attempt,
        maximumAttempts: 3,
        requestKind,
        mediaRequestNumber,
      });
      let response;
      try {
        response = await fetchImplementation(url, {
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
        await sleepImplementation(retryDelayMs);
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
      await sleepImplementation(retryDelayMs);
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
  const html = await fetchPage({ url, cacheFile, requestKind: 'media' });
  return html;
}

function buildMediaSql({ runId, mediaRows }) {
  if (!mediaRows.length) return '';
  return `
begin;
do $$
begin
  if to_regclass('public.nba_headshot_url_overrides') is null then
    raise exception 'NBA headshot override registry is unavailable; apply the corresponding analytics migration before importing media.';
  end if;
end $$;

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
  asset_url = coalesce(headshot_overrides.asset_url, stage.asset_url),
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
left join public.nba_headshot_url_overrides as headshot_overrides
  on stage.subject_type = 'player'
 and headshot_overrides.player_id = external_ids.player_id
left join public.nba_team_seasons as team_seasons
  on stage.subject_type = 'team'
 and team_seasons.season_end_year = stage.season_end_year
 and team_seasons.team_code = stage.team_code
where media.is_primary
  and media.asset_kind = stage.asset_kind
  -- Never take ownership of a primary asset supplied by another provider.
  -- Such rows are also protected by the provider-agnostic NOT EXISTS below.
  and media.source_name = ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)}
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
  coalesce(headshot_overrides.asset_url, stage.asset_url),
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
left join public.nba_headshot_url_overrides as headshot_overrides
  on stage.subject_type = 'player'
 and headshot_overrides.player_id = external_ids.player_id
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
  -- Deliberately do not filter source_name here: any provider's primary row
  -- blocks insertion, preventing both overwrite-by-conflict and duplicates.
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

function mediaCheckpointPath(options) {
  const checkpointDirectory = ensureDirectory(path.join(ROOT, 'outputs', 'nba-basketball-reference-import-checkpoints'));
  const phaseKey = options.phases.join('-');
  const teamKey = options.mediaTeamCode || 'all-teams';
  const targetPrefix = options.analytics ? 'media-bref-analytics' : 'media-bref';
  return path.join(checkpointDirectory, `${targetPrefix}-${options.start}-${options.end}-${phaseKey}-${teamKey}.json`);
}

function saveMediaCheckpoint(filePath, checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  writeJson(filePath, checkpoint);
}

function mediaRowForCandidate(candidate, assetUrl, sourceUrl) {
  if (candidate.subjectType === 'player') {
    return {
      subject_type: 'player',
      external_id: candidate.externalId,
      season_end_year: null,
      team_code: null,
      asset_kind: 'headshot',
      asset_url: assetUrl,
      alt_text: normalizedMediaAltText('player', candidate.fullName, candidate.externalId),
      source_url: sourceUrl,
    };
  }
  return {
    subject_type: 'team',
    external_id: null,
    season_end_year: candidate.seasonEndYear,
    team_code: candidate.teamCode,
    asset_kind: 'team_logo',
    asset_url: assetUrl,
    alt_text: normalizedMediaAltText('team', candidate.teamName, candidate.teamCode),
    source_url: sourceUrl,
  };
}

function mediaCheckpointCounts(checkpoint) {
  const counts = { found: 0, 'no-image': 0, retry: 0 };
  for (const entry of Object.values(checkpoint.candidates ?? {})) {
    if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
  }
  return counts;
}

/**
 * Read only league pages that are already in the source cache and whose URL is
 * still allowed by the current Basketball Reference robots policy. This helper
 * never calls `fetch`, never probes `/req/`, and never creates cache files.
 * Missing, stale-by-operator-choice, or newly disallowed caches simply leave a
 * season out so the established per-team source-page path remains available.
 */
function cachedAllowedLeagueHtmlBySeason({
  candidates,
  cacheDirectory,
  robots,
  refreshCache,
}) {
  const htmlBySeason = new Map();
  // `--refresh-cache` is an explicit request to re-read provider pages. Reusing
  // an older league cache as a derivation shortcut would violate that intent.
  if (refreshCache) return htmlBySeason;
  const teamSeasonYears = [...new Set(candidates
    .filter((candidate) => candidate.subjectType === 'team')
    .map((candidate) => candidate.seasonEndYear))]
    .sort((left, right) => left - right);
  for (const seasonEndYear of teamSeasonYears) {
    const url = leaguePageUrl(seasonEndYear);
    if (!isPathAllowedByRobots(new URL(url).pathname, robots, USER_AGENT)) continue;
    const cacheFile = sourceCacheFile(cacheDirectory, seasonEndYear, 'league', 'teams');
    if (!fs.existsSync(cacheFile)) continue;
    try {
      htmlBySeason.set(seasonEndYear, fs.readFileSync(cacheFile, 'utf8'));
    } catch (error) {
      // A transient local read failure must not make the entire media import
      // fail. Omitting the cache preserves the existing page-fetch fallback.
      logSourceEvent('team_logo_revision_cache_unavailable', {
        seasonEndYear,
        cacheFile: path.relative(ROOT, cacheFile),
        reason: String(error?.message ?? error).slice(0, 240),
      });
    }
  }
  return htmlBySeason;
}

/**
 * Backfill media from one globally de-duplicated linked-database queue. The
 * queue query is read-only; each successful source extraction or trusted,
 * deterministic team-logo derivation is persisted in a small transaction. A
 * candidate is marked `found` only after its batch commits, so a crash between
 * discovery and database write safely retries from the checkpoint/source
 * caches without claiming an uncommitted asset.
 */
async function runMediaBackfill({ options, fetchPage, cacheDirectory, mediaRequestBudget, robots, databaseTarget }) {
  if (!options.apply) throw new Error('--media-only requires --apply because it writes confirmed media rows.');
  if (!options.mediaRequestLimit || !mediaRequestBudget) {
    throw new Error('--media-only requires a positive --media-request-limit (or deprecated --media-limit alias).');
  }

  const candidateRows = await executeLinkedSql(buildMediaCandidateQuery({
    start: options.start,
    end: options.end,
    phases: options.phases,
    teamCode: options.mediaTeamCode,
  }), `media-candidates-${options.start}-${options.end}-${options.mediaTeamCode || 'all'}`, databaseTarget);
  const candidates = normalizeMediaCandidateRows(candidateRows);
  if (!candidates.length) {
    throw new Error(`No media candidates exist for ${options.start}-${options.end}${options.mediaTeamCode ? ` and ${options.mediaTeamCode}` : ''}.`);
  }

  const checkpointFile = mediaCheckpointPath(options);
  const existingCheckpoint = options.newRun ? null : readJson(checkpointFile);
  const checkpointOptions = { ...options, teamCode: options.mediaTeamCode };
  const checkpoint = isMatchingMediaCheckpoint(existingCheckpoint, checkpointOptions)
    ? existingCheckpoint
    : blankMediaCheckpoint({
      start: options.start,
      end: options.end,
      phases: options.phases,
      teamCode: options.mediaTeamCode,
    });
  checkpoint.status = 'running';
  checkpoint.error = '';

  let existingSkipped = 0;
  let sourceFound = 0;
  let derivedTeamLogos = 0;
  let noImage = 0;
  let retry = 0;
  let requestLimitReached = false;
  const pendingBatch = [];
  // The linked candidate query is a snapshot taken before this invocation's
  // writes. Remember successful commits locally so the ordinary pass does not
  // misinterpret those fresh rows as stale `found` checkpoint entries merely
  // because they are absent from that earlier snapshot.
  const committedThisInvocation = new Set();

  async function flushBatch() {
    if (!pendingBatch.length) return;
    const batch = pendingBatch.splice(0, options.mediaBatchSize);
    try {
      await executeLinkedSql(buildMediaSql({ mediaRows: batch.map((item) => item.mediaRow) }),
        `media-batch-${options.start}-${options.end}-${Date.now()}`, databaseTarget);
    } catch (error) {
      for (const item of batch) {
        recordMediaCandidateStatus(checkpoint, item.candidate, 'retry', {
          reason: 'supabase-write-failed',
          error: String(error?.message ?? error).slice(0, 400),
        });
      }
      saveMediaCheckpoint(checkpointFile, checkpoint);
      throw error;
    }
    for (const item of batch) {
      recordMediaCandidateStatus(checkpoint, item.candidate, 'found', {
        assetUrl: item.mediaRow.asset_url,
        source: item.checkpointSource ?? 'source',
      });
      committedThisInvocation.add(item.candidate.key);
      sourceFound += 1;
      if (item.checkpointSource === 'derived-team-logo') derivedTeamLogos += 1;
    }
    saveMediaCheckpoint(checkpointFile, checkpoint);
  }

  // Commit every derivable team logo before starting the request-bounded
  // player crawl. This pass performs no network I/O, so all historical team
  // seasons can be populated even when the later player pass exhausts its HTTP
  // budget. `--refresh-cache` intentionally produces an empty derivation plan.
  let derivedTeamLogoPlan = [];
  if (!options.refreshCache) {
    const cachedLeagueHtmlBySeason = cachedAllowedLeagueHtmlBySeason({
      candidates,
      cacheDirectory,
      robots,
      refreshCache: options.refreshCache,
    });
    const teamLogoRevisionCatalog = buildTrustedTeamLogoRevisionCatalog({
      candidates,
      cachedLeagueHtmlBySeason,
    });
    derivedTeamLogoPlan = buildDerivedTeamLogoAssetPlan(candidates, teamLogoRevisionCatalog);
    logSourceEvent('team_logo_revision_catalog_ready', {
      cachedLeagueSeasons: teamLogoRevisionCatalog.leagueSeasons,
      confirmedMediaSeasons: teamLogoRevisionCatalog.confirmedSeasons,
      uniqueConfirmedGlobalRevision: teamLogoRevisionCatalog.hasUniqueGlobalRevision,
      derivableTeamLogos: derivedTeamLogoPlan.length,
    });
  }

  for (const { candidate, assetUrl } of derivedTeamLogoPlan) {
    if (hasConfirmedExistingMedia(candidate)) continue;
    const previous = checkpoint.candidates?.[candidate.key];
    // Preserve terminal no-image decisions and retry semantics. A stale
    // `found` status may be reopened only after we know this team has a safe
    // deterministic replacement ready to commit.
    if (previous?.status === 'no-image') continue;
    if (previous?.status === 'found') {
      recordMediaCandidateStatus(checkpoint, candidate, 'retry', {
        reason: 'confirmed-media-no-longer-present',
        attempted: false,
      });
    }
    if (!shouldAttemptMediaCandidate(checkpoint, candidate)) continue;
    const sourceUrl = basketballReferenceMediaPageUrl(candidate);
    if (!isExactBasketballReferenceMediaPageUrl(candidate, sourceUrl)) {
      throw new Error(`Internal safety check rejected the generated source URL for ${candidate.key}.`);
    }
    pendingBatch.push({
      candidate,
      mediaRow: mediaRowForCandidate(candidate, assetUrl, sourceUrl),
      checkpointSource: 'derived-team-logo',
    });
    if (pendingBatch.length >= options.mediaBatchSize) await flushBatch();
  }
  // Flush the final partial derived batch before any player request begins.
  await flushBatch();

  for (const candidate of candidates) {
    // The linked read-only query returns any confirmed primary media. Preserve
    // another provider's row unconditionally; Basketball Reference-owned rows
    // must also pass exact host/path validation before suppressing a request.
    if (hasConfirmedExistingMedia(candidate)) {
      recordMediaCandidateStatus(checkpoint, candidate, 'found', {
        assetUrl: candidate.existingAssetUrl,
        source: 'existing',
        attempted: false,
      });
      existingSkipped += 1;
      continue;
    }

    // A successful deterministic pre-pass commit is already represented in
    // Supabase and the checkpoint. Do not reconcile it against the stale
    // pre-write candidate snapshot or count/process it a second time.
    if (committedThisInvocation.has(candidate.key)) continue;

    const previous = checkpoint.candidates?.[candidate.key];
    // A formerly successful checkpoint is not authoritative if the current
    // linked read shows no longer-confirmed media. Convert it to retry instead
    // of silently leaving a database hole.
    if (previous?.status === 'found') {
      recordMediaCandidateStatus(checkpoint, candidate, 'retry', {
        reason: 'confirmed-media-no-longer-present',
        attempted: false,
      });
    }
    if (!shouldAttemptMediaCandidate(checkpoint, candidate)) continue;

    const sourceUrl = basketballReferenceMediaPageUrl(candidate);
    if (!isExactBasketballReferenceMediaPageUrl(candidate, sourceUrl)) {
      throw new Error(`Internal safety check rejected the generated source URL for ${candidate.key}.`);
    }

    const cacheFile = path.join(cacheDirectory, ...mediaCacheRelativePath(candidate).split('/'));
    const requestsBefore = mediaRequestBudget.snapshot().used;
    let html;
    try {
      html = await fetchMediaAsset(sourceUrl, cacheFile, fetchPage);
    } catch (error) {
      const requestsAfter = mediaRequestBudget.snapshot().used;
      const attempted = requestsAfter > requestsBefore;
      if (error instanceof MediaRequestLimitReachedError || error?.code === 'MEDIA_REQUEST_LIMIT_REACHED') {
        recordMediaCandidateStatus(checkpoint, candidate, 'retry', {
          reason: 'request-limit-reached',
          attempted,
        });
        requestLimitReached = true;
        retry += 1;
        saveMediaCheckpoint(checkpointFile, checkpoint);
        break;
      }
      const terminalMissingPage = error?.status === 404 || error?.status === 410;
      recordMediaCandidateStatus(checkpoint, candidate, terminalMissingPage ? 'no-image' : 'retry', {
        reason: terminalMissingPage ? 'source-page-unavailable' : 'source-request-failed',
        error: String(error?.message ?? error).slice(0, 400),
        attempted,
      });
      if (terminalMissingPage) noImage += 1;
      else retry += 1;
      saveMediaCheckpoint(checkpointFile, checkpoint);
      continue;
    }

    const extractedUrl = candidate.subjectType === 'player'
      ? extractHeadshotAsset(html, candidate.externalId)
      : extractTeamLogoAsset(html, candidate.teamCode, candidate.seasonEndYear);
    if (!extractedUrl) {
      recordMediaCandidateStatus(checkpoint, candidate, 'no-image', { reason: 'no-matching-image-in-source' });
      noImage += 1;
      saveMediaCheckpoint(checkpointFile, checkpoint);
      continue;
    }
    const assetUrl = validatedBasketballReferenceMediaUrl(candidate, extractedUrl);
    if (!assetUrl) {
      recordMediaCandidateStatus(checkpoint, candidate, 'retry', {
        reason: 'untrusted-or-mismatched-asset-url',
        rejectedAssetUrl: String(extractedUrl).slice(0, 300),
      });
      retry += 1;
      saveMediaCheckpoint(checkpointFile, checkpoint);
      continue;
    }

    pendingBatch.push({ candidate, mediaRow: mediaRowForCandidate(candidate, assetUrl, sourceUrl) });
    if (pendingBatch.length >= options.mediaBatchSize) await flushBatch();
  }
  await flushBatch();

  const remaining = candidates.filter((candidate) => !hasConfirmedExistingMedia(candidate)
    && shouldAttemptMediaCandidate(checkpoint, candidate)).length;
  checkpoint.status = remaining > 0 ? 'paused' : 'completed';
  checkpoint.error = '';
  saveMediaCheckpoint(checkpointFile, checkpoint);
  console.log(JSON.stringify({
    mode: 'media-only',
    checkpoint: checkpointFile,
    candidates: candidates.length,
    existingSkipped,
    sourceFound,
    derivedTeamLogos,
    noImage,
    retry,
    remaining,
    requestLimitReached,
    mediaRequests: mediaRequestBudget.snapshot(),
    checkpointCounts: mediaCheckpointCounts(checkpoint),
  }, null, 2));
}

async function run() {
  const options = optionsFromArgs(process.argv.slice(2));
  // Dry-runs do not need a linked database at all. Apply runs resolve the
  // target before touching Basketball Reference so an invalid destination
  // cannot consume source requests or create a misleading checkpoint.
  const databaseTarget = options.apply ? analyticsDatabaseTarget() : null;
  const sourcePolicy = await verifySourceAutomation(options);
  options.requestDelayMs = sourcePolicy.effectiveDelayMs;
  const cacheDirectory = ensureDirectory(path.join(ROOT, 'outputs', 'nba-basketball-reference-cache'));
  const mediaRequestBudget = options.mediaRequestLimit > 0
    ? createMediaRequestBudget(options.mediaRequestLimit)
    : null;
  const fetchPage = createPageFetcher({
    cacheDirectory,
    requestDelayMs: options.requestDelayMs,
    refreshCache: options.refreshCache,
    robots: sourcePolicy.robots,
    mediaRequestBudget,
  });
  if (options.mediaOnly) {
    await runMediaBackfill({
      options,
      fetchPage,
      cacheDirectory,
      mediaRequestBudget,
      robots: sourcePolicy.robots,
      databaseTarget,
    });
    return;
  }
  const checkpointFile = checkpointPath(options);
  const existingCheckpoint = options.newRun ? null : readJson(checkpointFile);
  const checkpoint = options.apply && validateCheckpoint(existingCheckpoint, options)
    ? existingCheckpoint
    : blankCheckpoint({ runId: crypto.randomUUID(), ...options });
  // A resumed run has already passed any prior transient failure; keep the
  // checkpoint's status/error fields truthful while it advances.
  checkpoint.error = '';
  checkpoint.status = 'running';

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    seasonStart: options.start,
    seasonEnd: options.end,
    phases: options.phases,
    skipAdvanced: options.skipAdvanced,
    skipRaw: options.skipRaw,
    requestDelayMs: options.requestDelayMs,
    destination: databaseTarget?.label || 'source-only dry-run',
    resumedRun: Boolean(options.apply && validateCheckpoint(existingCheckpoint, options)),
    importRunId: options.apply ? checkpoint.runId : null
  }, null, 2));

  if (options.apply) {
    await executeLinkedSql(buildCreateRunSql({ runId: checkpoint.runId, start: options.start, end: options.end }), 'create-run', databaseTarget);
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
        }), `import-${checkpoint.runId}-${seasonEndYear}-${seasonPhase}`, databaseTarget);
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
        }), `update-run-${checkpoint.runId}`, databaseTarget);
        console.log(JSON.stringify({ seasonEndYear, seasonPhase, ...checkpoint.completed[completedKey], importRun: runRows[0] ?? null }, null, 2));

      }
    }
    // Optional media collection runs once after every selected phase has been
    // written, allowing its linked read-only query to globally de-duplicate
    // players across the complete regular/playoff range.
    if (options.apply && options.mediaRequestLimit > 0) {
      await runMediaBackfill({
        options,
        fetchPage,
        cacheDirectory,
        mediaRequestBudget,
        robots: sourcePolicy.robots,
        databaseTarget,
      });
    }
    if (options.apply) {
      checkpoint.status = 'completed';
      saveCheckpoint(checkpointFile, checkpoint);
      const finalRows = await executeLinkedSql(buildUpdateRunSql({
        runId: checkpoint.runId,
        status: 'completed',
        playersCreated: checkpoint.playersCreated,
        skipRaw: options.skipRaw
      }), `complete-run-${checkpoint.runId}`, databaseTarget);
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
        }), `fail-run-${checkpoint.runId}`, databaseTarget);
      } catch (updateError) {
        console.error(`Could not mark import run failed: ${String(updateError?.message ?? updateError)}`);
      }
    }
    throw error;
  }
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) {
  run().catch((error) => {
    console.error(`NBA Basketball Reference import failed: ${String(error?.stack ?? error)}`);
    process.exitCode = 1;
  });
}

// Export the smallest useful seam for offline tests. Importing this module no
// longer launches a crawl because the entrypoint above is guarded explicitly.
export {
  analyticsDatabaseTarget,
  buildMediaSql,
  createPageFetcher,
  executeLinkedSql,
  optionsFromArgs,
  parseCliJson,
};
