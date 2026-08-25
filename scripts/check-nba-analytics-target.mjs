#!/usr/bin/env node

/**
 * Read-only readiness check for the isolated NBA analytics Supabase project.
 * It never writes data, invokes an ingest RPC, or prints credentials.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertAnalyticsProjectTarget } from './lib/nba-analytics-project-target.mjs';

const BASE_CHECKS = [
  ['nba_seasons', '/rest/v1/nba_seasons?select=season_end_year&limit=1'],
  ['nba_franchises', '/rest/v1/nba_franchises?select=id&limit=1'],
  ['nba_team_seasons', '/rest/v1/nba_team_seasons?select=id&limit=1'],
  ['nba_players', '/rest/v1/nba_players?select=id&limit=1'],
  ['nba_player_external_ids', '/rest/v1/nba_player_external_ids?select=player_id&limit=1'],
  ['nba_stat_import_runs', '/rest/v1/nba_stat_import_runs?select=id&limit=1'],
  ['nba_player_team_season_stats', '/rest/v1/nba_player_team_season_stats?select=player_id&limit=1'],
  ['nba_stat_metric_definitions', '/rest/v1/nba_stat_metric_definitions?select=metric_code&limit=1'],
  ['nba_player_team_season_metric_values', '/rest/v1/nba_player_team_season_metric_values?select=stat_id&limit=1'],
  ['nba_stat_source_records', '/rest/v1/nba_stat_source_records?select=id&limit=1'],
];

const PBP_TABLE_CHECKS = [
  ['nba_pbp_import_runs', '/rest/v1/nba_pbp_import_runs?select=id&limit=1'],
  ['nba_provider_teams', '/rest/v1/nba_provider_teams?select=id&limit=1'],
  ['nba_provider_players', '/rest/v1/nba_provider_players?select=id&limit=1'],
  ['nba_games', '/rest/v1/nba_games?select=id&limit=1'],
  ['nba_pbp_events', '/rest/v1/nba_pbp_events?select=id&limit=1'],
  ['nba_game_lineup_stints', '/rest/v1/nba_game_lineup_stints?select=id&limit=1'],
  ['nba_game_possessions', '/rest/v1/nba_game_possessions?select=id&limit=1'],
  ['nba_adjusted_model_runs', '/rest/v1/nba_adjusted_model_runs?select=id&limit=1'],
];

function tokens(argv) {
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

function seasonEnd(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1947 || parsed > 2200) {
    throw new RangeError('--season-end must be an NBA season ending year from 1947 through 2200.');
  }
  return parsed;
}

export function optionsFromArgs(argv = []) {
  const { values, flags } = tokens(argv);
  const known = new Set(['help', 'scope', 'season-end']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  const scope = String(values.get('scope') ?? 'pbp').trim().toLowerCase();
  if (!['base', 'pbp'].includes(scope)) throw new Error('--scope must be base or pbp.');
  return {
    help: false,
    scope,
    seasonEndYear: seasonEnd(values.get('season-end') ?? 2025),
  };
}

function usage() {
  return `
Usage:
  node .\\scripts\\check-nba-analytics-target.mjs [options]

Options:
  --scope <base|pbp>     Check only copied NBA base tables, or the PBP/RAPM layer too (default: pbp)
  --season-end <year>    Season-ending year for the read-only RAPM RPC check (default: 2025)
  --help                 Show this help

Required environment:
  SUPABASE_URL=https://your-analytics-project.supabase.co
  NBA_ANALYTICS_SUPABASE_URL=https://your-analytics-project.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

This command is read-only. It does not create buckets, import games, or write
any database rows.
`;
}

function configuration() {
  const projectUrl = assertAnalyticsProjectTarget({
    projectUrl: process.env.SUPABASE_URL,
    expectedProjectUrl: process.env.NBA_ANALYTICS_SUPABASE_URL,
  });
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this read-only readiness check.');
  return { projectUrl, serviceRoleKey };
}

async function requestCheck({ projectUrl, serviceRoleKey, name, method = 'GET', route, body = null }, fetchImpl) {
  const response = await fetchImpl(`${projectUrl}${route}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    name,
    method,
    route,
    ok: response.ok,
    status: response.status,
    // The text may contain provider- or database-derived information, so only
    // retain a compact status hint in the report rather than response content.
    responseKind: text.trimStart().startsWith('[') ? 'array' : text.trimStart().startsWith('{') ? 'object' : text ? 'text' : 'empty',
  };
}

export async function checkAnalyticsTarget({ projectUrl, expectedProjectUrl, serviceRoleKey, scope, seasonEndYear, fetchImpl = globalThis.fetch } = {}) {
  const targetUrl = assertAnalyticsProjectTarget({ projectUrl, expectedProjectUrl });
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this read-only readiness check.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const checks = [];
  for (const [name, route] of BASE_CHECKS) {
    checks.push(await requestCheck({ projectUrl: targetUrl, serviceRoleKey, name, route }, fetchImpl));
  }
  if (scope === 'pbp') {
    for (const [name, route] of PBP_TABLE_CHECKS) {
      checks.push(await requestCheck({ projectUrl: targetUrl, serviceRoleKey, name, route }, fetchImpl));
    }
    checks.push(await requestCheck({
      projectUrl: targetUrl,
      serviceRoleKey,
      name: 'nba-sportradar-raw bucket',
      route: '/storage/v1/bucket/nba-sportradar-raw',
    }, fetchImpl));
    checks.push(await requestCheck({
      projectUrl: targetUrl,
      serviceRoleKey,
      name: 'get_nba_rapm_stints RPC',
      method: 'POST',
      route: '/rest/v1/rpc/get_nba_rapm_stints',
      body: { p_season_end_year: seasonEndYear, p_season_phase: 'regular' },
    }, fetchImpl));
  }
  return {
    mode: 'read-only',
    scope,
    targetOrigin: targetUrl,
    seasonEndYear,
    ready: checks.every((check) => check.ok),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = optionsFromArgs(argv);
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  const config = configuration();
  const report = await checkAnalyticsTarget({
    ...config,
    expectedProjectUrl: process.env.NBA_ANALYTICS_SUPABASE_URL,
    scope: options.scope,
    seasonEndYear: options.seasonEndYear,
    fetchImpl: dependencies.fetchImpl,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
  return report;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) {
  main().catch((error) => {
    console.error(`NBA analytics target readiness check failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
