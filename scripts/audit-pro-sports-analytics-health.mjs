#!/usr/bin/env node

/**
 * Read-only MLB/NFL analytics health report.
 *
 * The report uses the explicit per-sport private-project target, never calls a
 * source provider, and wraps its query in BEGIN/ROLLBACK. It distinguishes a
 * genuine historical coverage gap from a current-season group that is simply
 * not available yet, so a monitor cannot accidentally turn an in-season lag
 * into an uncontrolled backfill.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  BASEBALL_STAT_GROUPS,
  FOOTBALL_STAT_GROUPS,
} from './lib/sports-reference-season-stats.mjs';
import {
  PRO_SPORTS_ANALYTICS_WORKDIR,
  proSportsAnalyticsTarget,
} from './lib/pro-sports-analytics-targets.mjs';

const ROOT = process.cwd();
const SUPABASE_CLI_VERSION = '2.115.0';
const NPX_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');

const SPORT_CONFIGS = Object.freeze({
  mlb: Object.freeze({
    leagueCode: 'MLB',
    prefix: 'mlb',
    otherPrefix: 'nfl',
    statGroups: BASEBALL_STAT_GROUPS,
    target: proSportsAnalyticsTarget('mlb'),
  }),
  nfl: Object.freeze({
    leagueCode: 'NFL',
    prefix: 'nfl',
    otherPrefix: 'mlb',
    statGroups: FOOTBALL_STAT_GROUPS,
    target: proSportsAnalyticsTarget('nfl'),
  }),
});

function usage() {
  return `
Usage:
  node .\\scripts\\audit-pro-sports-analytics-health.mjs [options]

Options:
  --sport <mlb|nfl|both>    Sport to audit (default: both)
  --season-start <year>     First historical season to require (default: 1980)
  --season-end <year>       Last season to inspect (default: current UTC year)
  --help                     Show this help

This command is read-only. It does not fetch Sports Reference pages, write
local checkpoints, import data, or modify either analytics project.
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
  const known = new Set(['sport', 'season-start', 'season-end', 'help']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  const sport = String(values.get('sport') ?? 'both').trim().toLowerCase();
  if (!['mlb', 'nfl', 'both'].includes(sport)) throw new Error('--sport must be mlb, nfl, or both.');
  const seasonStart = integerOption(values.get('season-start') ?? 1980, '--season-start', 1876, 2200);
  const seasonEnd = integerOption(values.get('season-end') ?? now.getUTCFullYear(), '--season-end', 1876, 2200);
  if (seasonEnd < seasonStart) throw new Error('--season-end must be greater than or equal to --season-start.');
  return {
    help: false,
    sports: sport === 'both' ? ['mlb', 'nfl'] : [sport],
    seasonStart,
    seasonEnd,
  };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function numericLiteral(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return String(parsed);
}

export function buildHealthSql({ sport, seasonStart, seasonEnd }) {
  const config = SPORT_CONFIGS[sport];
  if (!config) throw new Error(`Unknown pro-sports analytics sport: ${sport}`);
  const start = numericLiteral(seasonStart, 'seasonStart');
  const end = numericLiteral(seasonEnd, 'seasonEnd');
  const groups = config.statGroups.map((group) => sqlLiteral(group)).join(', ');
  const { prefix, otherPrefix, leagueCode, target } = config;
  return `
begin;
with expected as (
  select seasons.season_year::smallint as season_year, groups.stat_group
  from generate_series(${start}, ${end}) as seasons(season_year)
  cross join unnest(array[${groups}]::text[]) as groups(stat_group)
),
run_counts as (
  select
    season_year,
    stat_group,
    count(*) filter (where status = 'completed')::integer as completed_runs,
    count(*)::integer as total_runs,
    max(finished_at) filter (where status = 'completed') as latest_completed_at
  from public.${prefix}_stat_import_runs
  where season_year between ${start} and ${end}
  group by season_year, stat_group
),
stat_counts as (
  select season_year, stat_group, count(*)::integer as stat_rows
  from public.${prefix}_player_team_season_stats
  where season_year between ${start} and ${end}
  group by season_year, stat_group
),
source_counts as (
  select runs.season_year, runs.stat_group, count(records.id)::integer as source_records
  from public.${prefix}_stat_import_runs runs
  left join public.${prefix}_stat_source_records records on records.import_run_id = runs.id
  where runs.season_year between ${start} and ${end}
    and runs.status = 'completed'
  group by runs.season_year, runs.stat_group
),
coverage as (
  select
    expected.season_year,
    expected.stat_group,
    coalesce(run_counts.completed_runs, 0) as completed_runs,
    coalesce(run_counts.total_runs, 0) as total_runs,
    coalesce(stat_counts.stat_rows, 0) as stat_rows,
    coalesce(source_counts.source_records, 0) as source_records,
    run_counts.latest_completed_at
  from expected
  left join run_counts using (season_year, stat_group)
  left join stat_counts using (season_year, stat_group)
  left join source_counts using (season_year, stat_group)
),
run_statuses as (
  select status, count(*)::integer as run_count
  from public.${prefix}_stat_import_runs
  group by status
),
duplicate_stat_keys as (
  select 1
  from public.${prefix}_player_team_season_stats
  group by player_id, season_year, team_code, season_phase, stat_group
  having count(*) > 1
)
select jsonb_build_object(
  'sport', ${sqlLiteral(sport)},
  'league_code', ${sqlLiteral(leagueCode)},
  'target_project_ref', ${sqlLiteral(target.projectRef)},
  'required_season_start', ${start},
  'required_season_end', ${end},
  'coverage', coalesce((
    select jsonb_agg(jsonb_build_object(
      'season_year', season_year,
      'stat_group', stat_group,
      'completed_runs', completed_runs,
      'total_runs', total_runs,
      'stat_rows', stat_rows,
      'source_records', source_records,
      'latest_completed_at', latest_completed_at
    ) order by season_year, stat_group)
    from coverage
  ), '[]'::jsonb),
  'gaps', coalesce((
    select jsonb_agg(jsonb_build_object(
      'season_year', season_year,
      'stat_group', stat_group,
      'completed_runs', completed_runs,
      'stat_rows', stat_rows,
      'source_records', source_records
    ) order by season_year, stat_group)
    from coverage
    where completed_runs = 0 or stat_rows = 0 or source_records = 0
  ), '[]'::jsonb),
  'coverage_summary', jsonb_build_object(
    'expected_season_groups', (select count(*)::integer from coverage),
    'completed_season_groups', (select count(*)::integer from coverage where completed_runs > 0),
    'populated_stat_groups', (select count(*)::integer from coverage where stat_rows > 0),
    'provenanced_stat_groups', (select count(*)::integer from coverage where source_records > 0),
    'first_populated_season', (select min(season_year) from coverage where stat_rows > 0),
    'last_populated_season', (select max(season_year) from coverage where stat_rows > 0)
  ),
  'import_run_statuses', coalesce((select jsonb_object_agg(status, run_count) from run_statuses), '{}'::jsonb),
  'integrity', jsonb_build_object(
    'players', (select count(*)::integer from public.${prefix}_players),
    'stat_rows', (select count(*)::integer from public.${prefix}_player_team_season_stats),
    'source_records', (select count(*)::integer from public.${prefix}_stat_source_records),
    'memberless_players', (
      select count(*)::integer
      from public.${prefix}_players players
      left join public.athlete_league_memberships memberships
        on memberships.athlete_id = players.athlete_id
       and memberships.league_code = ${sqlLiteral(leagueCode)}
      where memberships.athlete_id is null
    ),
    'stat_rows_without_import_run', (
      select count(*)::integer
      from public.${prefix}_player_team_season_stats stats
      left join public.${prefix}_stat_import_runs runs on runs.id = stats.source_import_run_id
      where stats.source_import_run_id is null or runs.id is null
    ),
    'stat_rows_without_source_record', (
      select count(*)::integer
      from public.${prefix}_player_team_season_stats stats
      left join public.${prefix}_stat_source_records records
        on records.import_run_id = stats.source_import_run_id
       and records.source_record_id = stats.source_record_id
      where records.id is null
    ),
    'nonaggregate_stat_rows_without_team_season', (
      select count(*)::integer
      from public.${prefix}_player_team_season_stats stats
      left join public.${prefix}_team_seasons teams on teams.id = stats.team_season_id
      where not stats.is_multi_team_aggregate
        and (stats.team_season_id is null or teams.id is null)
    ),
    'duplicate_stat_key_groups', (select count(*)::integer from duplicate_stat_keys),
    'unexpected_other_league_memberships', (
      select count(*)::integer
      from public.athlete_league_memberships
      where league_code <> ${sqlLiteral(leagueCode)}
    ),
    'unexpected_other_sport_players', (select count(*)::integer from public.${otherPrefix}_players)
  )
) as report;
rollback;
`;
}

function parseJsonEnvelope(text) {
  const source = String(text);
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function runProcess(command, args, timeoutMs, { cwd, shell }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
      } else child.kill();
      reject(new Error(`Health query timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function removeTemporaryDirectory(directory) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  const prefix = `${tempRoot}${path.sep}`.toLowerCase();
  if (!resolved.toLowerCase().startsWith(prefix) || !path.basename(resolved).startsWith('djhc-pro-sports-health-')) {
    throw new Error('Refusing to remove an unexpected temporary health-check directory.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function queryHealthReport(sport, options) {
  const config = SPORT_CONFIGS[sport];
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'djhc-pro-sports-health-'));
  const queryPath = path.join(temporaryDirectory, `${sport}-health.sql`);
  try {
    fs.writeFileSync(queryPath, buildHealthSql({ sport, ...options }), 'utf8');
    const args = [
      '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked',
      '--workdir', PRO_SPORTS_ANALYTICS_WORKDIR,
      '--project-ref', config.target.projectRef,
      '--output-format', 'json', '--file', queryPath,
    ];
    const result = fs.existsSync(NPX_CLI)
      ? await runProcess(process.execPath, [NPX_CLI, ...args], 180_000, { cwd: PRO_SPORTS_ANALYTICS_WORKDIR, shell: false })
      : await runProcess('npx.cmd', args, 180_000, { cwd: PRO_SPORTS_ANALYTICS_WORKDIR, shell: true });
    if (result.code !== 0) {
      throw new Error(`${sport} health query failed: ${String(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1000)}`);
    }
    const envelope = parseJsonEnvelope(result.stdout);
    const report = envelope?.rows?.[0]?.report;
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error(`${sport} health query returned an invalid report.`);
    }
    return report;
  } finally {
    removeTemporaryDirectory(temporaryDirectory);
  }
}

function positiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

export function analyzeHealthReport(report, { currentYear = new Date().getUTCFullYear() } = {}) {
  const gaps = Array.isArray(report?.gaps) ? report.gaps : [];
  const historicalGaps = gaps.filter((gap) => Number(gap?.season_year) < currentYear);
  const currentSeasonGaps = gaps.filter((gap) => Number(gap?.season_year) === currentYear);
  const integrity = report?.integrity && typeof report.integrity === 'object' ? report.integrity : {};
  const integrityFailures = Object.entries(integrity)
    .filter(([key, value]) => key !== 'players' && key !== 'stat_rows' && key !== 'source_records' && positiveInteger(value))
    .map(([key, value]) => ({ key, count: Number(value) }));
  const status = integrityFailures.length || historicalGaps.length
    ? 'attention'
    : currentSeasonGaps.length
      ? 'current-season-pending'
      : 'healthy';
  const nextAction = historicalGaps.length
    ? {
      kind: 'authorized-historical-backfill-required',
      seasonGroups: historicalGaps.map((gap) => ({ seasonYear: Number(gap.season_year), statGroup: gap.stat_group })),
    }
    : currentSeasonGaps.length
      ? {
        kind: 'current-season-source-or-cache-needed',
        seasonGroups: currentSeasonGaps.map((gap) => ({ seasonYear: Number(gap.season_year), statGroup: gap.stat_group })),
      }
      : null;
  return {
    status,
    historicalGapCount: historicalGaps.length,
    currentSeasonGapCount: currentSeasonGaps.length,
    integrityFailures,
    nextAction,
  };
}

export async function auditProSportsAnalytics(options, { query = queryHealthReport, now = new Date() } = {}) {
  const sports = {};
  for (const sport of options.sports) {
    const report = await query(sport, options);
    sports[sport] = {
      ...report,
      assessment: analyzeHealthReport(report, { currentYear: now.getUTCFullYear() }),
    };
  }
  const statuses = Object.values(sports).map((report) => report.assessment.status);
  return {
    mode: 'read-only',
    checkedAt: now.toISOString(),
    seasonStart: options.seasonStart,
    seasonEnd: options.seasonEnd,
    status: statuses.includes('attention') ? 'attention' : statuses.includes('current-season-pending') ? 'current-season-pending' : 'healthy',
    sports,
  };
}

export function compactAuditReport(report) {
  return {
    mode: report.mode,
    checkedAt: report.checkedAt,
    seasonStart: report.seasonStart,
    seasonEnd: report.seasonEnd,
    status: report.status,
    sports: Object.fromEntries(Object.entries(report.sports).map(([sport, result]) => [sport, {
      sport: result.sport,
      leagueCode: result.league_code,
      targetProjectRef: result.target_project_ref,
      coverageSummary: result.coverage_summary,
      gaps: result.gaps,
      importRunStatuses: result.import_run_statuses,
      integrity: result.integrity,
      assessment: result.assessment,
    }])),
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = optionsFromArgs(argv, dependencies.now ?? new Date());
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  const report = await auditProSportsAnalytics(options, {
    query: dependencies.query,
    now: dependencies.now ?? new Date(),
  });
  // Full season-group coverage remains available to callers, but the CLI is
  // intentionally compact so daily monitors do not emit thousands of lines.
  console.log(JSON.stringify(compactAuditReport(report), null, 2));
  return report;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) {
  main().catch((error) => {
    console.error(`Pro-sports analytics health check failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
