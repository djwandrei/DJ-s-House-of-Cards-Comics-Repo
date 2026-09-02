#!/usr/bin/env node

/**
 * Idempotent media manifest importer for the isolated MLB/NFL warehouse.
 *
 * Team logos use the year-specific Sports Reference CDN paths shown on the
 * source team pages, so the complete historical logo set can be staged with
 * one small SQL batch and no extra source requests. Player headshots are read
 * only from HTML captured through an authorized browser session; cache-only
 * mode is deliberately fail-closed and never bypasses a source challenge.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const EXTRA_PROJECT_REF = 'rioxosivyhczxshhmaen';
const EXTRA_PROJECT_URL = `https://${EXTRA_PROJECT_REF}.supabase.co`;
const WORKDIR = path.join(ROOT, 'supabase-sports-analytics');
const CLI_VERSION = '2.115.0';
const MEDIA_CACHE_ROOT = path.join(ROOT, 'outputs', 'sports-reference-media-cache');
const SOURCE_LICENSE_NOTE = 'Private non-competing analytics requested by the site owner on 2026-08-31; source media is retained as provider URLs with user-confirmed permission.';

const SOURCES = Object.freeze({
  mlb: Object.freeze({
    sport: 'mlb', leagueCode: 'MLB', table: 'mlb_media_assets', playerTable: 'mlb_players',
    externalTable: 'mlb_player_external_ids', statsTable: 'mlb_player_team_season_stats',
    teamTable: 'mlb_team_seasons', seasonColumn: 'season_year', sourceName: 'baseball_reference',
    baseUrl: 'https://www.baseball-reference.com',
    teamLogoUrl: (code, year) => `https://cdn.ssref.net/req/202608270/tlogo/br/${code}-${year}.png`,
    teamPageUrl: (code, year) => `https://www.baseball-reference.com/teams/${code}/${year}.shtml`,
    playerPageUrl: (id) => `https://www.baseball-reference.com/players/${id[0].toLowerCase()}/${id}.shtml`,
  }),
  nfl: Object.freeze({
    sport: 'nfl', leagueCode: 'NFL', table: 'nfl_media_assets', playerTable: 'nfl_players',
    externalTable: 'nfl_player_external_ids', statsTable: 'nfl_player_team_season_stats',
    teamTable: 'nfl_team_seasons', seasonColumn: 'season_year', sourceName: 'pro_football_reference',
    baseUrl: 'https://www.pro-football-reference.com',
    teamLogoUrl: (code, year) => `https://cdn.ssref.net/req/202608202/tlogo/pfr/${code.toLowerCase()}-${year}.png`,
    teamPageUrl: (code, year) => `https://www.pro-football-reference.com/teams/${code.toLowerCase()}/${year}.htm`,
    playerPageUrl: (id) => `https://www.pro-football-reference.com/players/${id[0].toUpperCase()}/${id}.htm`,
  }),
});

function usage() {
  return `
Usage:
  node .\\scripts\\import-sports-reference-media.mjs [options]

Options:
  --sport <mlb|nfl|both>       Sport to process (default: both)
  --kind <logos|headshots|all> Media kind (default: all)
  --season-start <year>        Existing team-season lower bound (default: 1950)
  --season-end <year>          Existing team-season upper bound (default: current year)
  --profile-start <year>       Earliest headshot-eligible season (default: 2010)
  --external-ids <id,...>      Restrict headshot work to specific source player IDs
  --cache-only                 Read browser-captured player HTML only
  --apply --analytics          Write the isolated Extra project

Headshot cache layout:
  outputs\\sports-reference-media-cache\\<mlb|nfl>\\players\\<external-id>.html

`;
}

function parseArgs(argv, now = new Date()) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values.set(name, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) values.set(name, argv[++i]);
    else flags.add(name);
  }
  const known = new Set(['sport', 'kind', 'season-start', 'season-end', 'profile-start', 'external-ids', 'cache-only', 'apply', 'analytics', 'help']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  if (flags.has('help')) return { help: true };
  const sportValue = String(values.get('sport') ?? 'both').toLowerCase();
  if (!['mlb', 'nfl', 'both'].includes(sportValue)) throw new Error('--sport must be mlb, nfl, or both.');
  const kind = String(values.get('kind') ?? 'all').toLowerCase();
  if (!['logos', 'headshots', 'all'].includes(kind)) throw new Error('--kind must be logos, headshots, or all.');
  const integer = (value, name, min, max) => {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} through ${max}.`);
    return parsed;
  };
  const start = integer(values.get('season-start') ?? 1950, '--season-start', 1920, 2200);
  const end = integer(values.get('season-end') ?? now.getUTCFullYear(), '--season-end', 1920, 2200);
  const profileStart = integer(values.get('profile-start') ?? 2010, '--profile-start', 1920, 2200);
  if (end < start) throw new Error('--season-end must be greater than or equal to --season-start.');
  const externalIds = String(values.get('external-ids') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (externalIds.length > 200) throw new Error('--external-ids may contain at most 200 IDs.');
  if (externalIds.some((value) => !/^[A-Za-z0-9.]+$/.test(value))) throw new Error('--external-ids contains an unsafe player ID.');
  return {
    help: false, sports: sportValue === 'both' ? ['mlb', 'nfl'] : [sportValue], kind, start, end, profileStart,
    externalIds: [...new Set(externalIds)], cacheOnly: flags.has('cache-only'), apply: flags.has('apply'), analytics: flags.has('analytics'),
  };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) { return `${sqlLiteral(JSON.stringify(value))}::jsonb`; }

function ensureDirectory(directory) { fs.mkdirSync(directory, { recursive: true }); return directory; }

function parseCliJson(stdout) {
  const text = String(stdout ?? '').trim();
  try {
    const direct = JSON.parse(text);
    if (Array.isArray(direct)) return { rows: direct };
    if (Array.isArray(direct?.rows)) return direct;
  } catch { /* scan for a JSON payload after CLI notices */ }
  for (const match of text.matchAll(/\{/g)) {
    try {
      const parsed = JSON.parse(text.slice(match.index));
      if (Array.isArray(parsed?.rows)) return parsed;
    } catch { /* keep looking for CLI envelope */ }
  }
  return null;
}

async function executeSql(sql, label) {
  const readOnlyQuery = /^\s*select\b/i.test(sql);
  const work = ensureDirectory(path.join(ROOT, 'outputs', 'sports-reference-import-work'));
  const sqlFile = path.join(work, `media-${label.replace(/[^a-z0-9_-]+/gi, '-')}.sql`);
  fs.writeFileSync(sqlFile, sql, 'utf8');
  const compactQuery = sql.replace(/\s+/g, ' ').trim();
  // The CLI only emits SELECT result rows for an inline query; --file is for
  // statement execution and deliberately has no row-result envelope.
  const selectArgs = ['--yes', `supabase@${CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', WORKDIR,
    '--output-format', 'json', `"${compactQuery.replaceAll('"', '\\"')}"`];
  const result = await new Promise((resolve, reject) => {
    const child = readOnlyQuery
      ? spawn('npx.cmd', selectArgs, { cwd: WORKDIR, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('npx.cmd', ['--yes', `supabase@${CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', WORKDIR, '--file', sqlFile], {
      cwd: WORKDIR, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) throw new Error(`NBA/Extra media SQL failed for ${label}: ${String(result.stderr || result.stdout).trim().slice(0, 1800)}`);
  if (!readOnlyQuery) return [];
  const payload = parseCliJson(result.stdout);
  if (!payload) throw new Error(`Media SQL returned invalid JSON for ${label}.`);
  return payload.rows;
}

function extractHeadshot(html, source) {
  const sourcePattern = source.sport === 'mlb' ? /https?:\/\/www\.baseball-reference\.com\/req\/[^"'\s]+\/images\/headshots\/[^"'\s]+/gi : /https?:\/\/www\.pro-football-reference\.com\/req\/[^"'\s]+\/images\/headshots\/[^"'\s]+/gi;
  const candidates = String(html).match(sourcePattern) ?? [];
  return candidates.find((url) => /\.(?:jpg|jpeg|png)(?:[?#]|$)/i.test(url)) ?? '';
}

function playerCacheFile(source, externalId) {
  return path.join(MEDIA_CACHE_ROOT, source.sport, 'players', `${externalId}.html`);
}

function teamCacheFile(source, teamCode, seasonYear) {
  return path.join(MEDIA_CACHE_ROOT, source.sport, 'teams', String(seasonYear), `${teamCode}.html`);
}

function extractTeamPageHeadshots(html, source, sourceUrl) {
  const found = new Map();
  // Leaders and roster blocks use both table rows and divs. The provider puts
  // the player anchor immediately around each headshot, so pair that anchor
  // with the first source-hosted headshot before the next anchor begins.
  const expression = /<a\b[^>]*href=["'](?:https?:\/\/www\.baseball-reference\.com)?\/players\/[a-z0-9]\/([^/"']+)\.shtml["'][^>]*>[\s\S]*?<img\b[^>]*src=["']([^"']*\/images\/headshots\/[^"']+)["']/gi;
  for (const match of String(html).matchAll(expression)) {
    const externalId = match[1].toLowerCase();
    let assetUrl = match[2];
    if (assetUrl.startsWith('/')) assetUrl = `${source.baseUrl}${assetUrl}`;
    if (/^https?:\/\/www\.baseball-reference\.com\/req\/[^\s"']+\/images\/headshots\//i.test(assetUrl)) {
      found.set(externalId, { assetUrl, sourceUrl });
    }
  }
  return found;
}

function loadCachedTeamHeadshots(source, teamRows) {
  const found = new Map();
  if (source.sport !== 'mlb') return found;
  for (const team of teamRows) {
    const cacheFile = teamCacheFile(source, team.team_code, team.season_year);
    if (!fs.existsSync(cacheFile)) continue;
    const pageUrl = source.teamPageUrl(team.team_code, team.season_year);
    for (const [externalId, value] of extractTeamPageHeadshots(fs.readFileSync(cacheFile, 'utf8'), source, pageUrl)) {
      if (!found.has(externalId)) found.set(externalId, value);
    }
  }
  return found;
}

function buildLogoRows(source, teamRows, options) {
  return teamRows.filter((row) => row.season_year >= options.start && row.season_year <= options.end)
    .map((row) => ({
      player_id: null, team_season_id: row.id, asset_kind: 'team_logo',
      asset_url: source.teamLogoUrl(row.team_code, row.season_year),
      alt_text: `${row.season_year} ${row.team_name} Logo`,
      source_name: source.sourceName,
      source_url: source.teamPageUrl(row.team_code, row.season_year),
      capture_method: 'derived_template',
    }));
}

function buildHeadshotRows(source, playerRows, options, teamHeadshots = new Map()) {
  const rows = [];
  for (const player of playerRows) {
    if (player.first_season < options.profileStart) continue;
    const cacheFile = playerCacheFile(source, player.external_id);
    const cachedPlayer = fs.existsSync(cacheFile)
      ? { assetUrl: extractHeadshot(fs.readFileSync(cacheFile, 'utf8'), source), sourceUrl: source.playerPageUrl(player.external_id) }
      : null;
    const cachedTeam = teamHeadshots.get(String(player.external_id).toLowerCase());
    const assetUrl = cachedPlayer?.assetUrl || cachedTeam?.assetUrl || '';
    if (!assetUrl) continue;
    rows.push({
      player_id: player.player_id, team_season_id: null, asset_kind: 'headshot', asset_url: assetUrl,
      alt_text: `Photo of ${player.full_name}`, source_name: source.sourceName,
      source_url: cachedPlayer?.assetUrl ? cachedPlayer.sourceUrl : cachedTeam.sourceUrl,
      capture_method: 'browser_cache',
    });
  }
  return rows;
}

function buildUpsertSql(source, rows) {
  if (!rows.length) return '';
  return `
begin;
create temporary table _media_stage on commit drop as
select * from jsonb_to_recordset(${sqlJson(rows)}) as row_data(
  player_id uuid, team_season_id bigint, asset_kind text, asset_url text, alt_text text,
  source_name text, source_url text, capture_method text
);
insert into public.${source.table} (
  player_id, team_season_id, asset_kind, asset_url, alt_text, source_name, source_url,
  source_license_note, rights_confirmed, capture_method
)
select player_id, team_season_id, asset_kind, asset_url, alt_text, source_name, source_url,
  ${sqlLiteral(SOURCE_LICENSE_NOTE)}, true, capture_method
from _media_stage as stage
where not exists (
  select 1 from public.${source.table} as existing
  where existing.asset_kind = stage.asset_kind
    and ((stage.player_id is not null and existing.player_id = stage.player_id)
      or (stage.team_season_id is not null and existing.team_season_id = stage.team_season_id))
);
update public.${source.table} as existing
set asset_url = stage.asset_url, alt_text = stage.alt_text, source_name = stage.source_name,
  source_url = stage.source_url, source_license_note = ${sqlLiteral(SOURCE_LICENSE_NOTE)},
  rights_confirmed = true, capture_method = stage.capture_method, updated_at = now()
from _media_stage as stage
where existing.asset_kind = stage.asset_kind
  and ((stage.player_id is not null and existing.player_id = stage.player_id)
    or (stage.team_season_id is not null and existing.team_season_id = stage.team_season_id));
select count(*)::integer as media_rows from _media_stage;
commit;
`;
}

async function processSport(source, options) {
  const needTeamRows = options.kind === 'logos' || options.kind === 'all' || source.sport === 'mlb';
  const teamRows = needTeamRows
    ? (await executeSql(`select id, season_year, team_code, team_name from public.${source.teamTable} where season_year between ${options.start} and ${options.end} order by season_year, team_code;`, `${source.sport}-teams`)).map((row) => row)
    : [];
  const mediaRows = [];
  if (options.kind === 'logos' || options.kind === 'all') mediaRows.push(...buildLogoRows(source, teamRows, options));
  if (options.kind === 'headshots' || options.kind === 'all') {
    const teamHeadshots = loadCachedTeamHeadshots(source, teamRows);
    const externalIdFilter = options.externalIds.length
      ? `and e.external_id in (${options.externalIds.map(sqlLiteral).join(', ')})`
      : '';
    const playerRows = await executeSql(`
      select p.id as player_id, p.full_name, e.external_id, min(s.season_year)::int as first_season
      from public.${source.playerTable} p
      join public.${source.externalTable} e on e.player_id = p.id and e.source_name = ${sqlLiteral(source.sourceName)}
      join public.${source.statsTable} s on s.player_id = p.id
      where s.season_year >= ${options.profileStart}
        ${externalIdFilter}
      group by p.id, p.full_name, e.external_id;
    `, `${source.sport}-players`);
    if (!options.cacheOnly) {
      // The command intentionally does not fetch player pages. Browser-captured
      // HTML is the authorized handoff for sources that block unattended HTTP.
      console.warn(`${source.sourceName}: headshots require browser-captured HTML under ${path.relative(ROOT, MEDIA_CACHE_ROOT)}.`);
    }
    mediaRows.push(...buildHeadshotRows(source, playerRows, options, teamHeadshots));
  }
  if (options.apply && mediaRows.length) await executeSql(buildUpsertSql(source, mediaRows), `${source.sport}-upsert`);
  return { sport: source.sport, logos: mediaRows.filter((row) => row.asset_kind === 'team_logo').length, headshots: mediaRows.filter((row) => row.asset_kind === 'headshot').length, written: options.apply ? mediaRows.length : 0 };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage()); return; }
  if (options.apply && !options.analytics) throw new Error('--apply requires --analytics.');
  if (options.apply && !options.cacheOnly && !options.analytics) throw new Error('Media writes require the isolated analytics target.');
  if (options.apply) {
    const linked = fs.readFileSync(path.join(WORKDIR, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
    if (linked !== EXTRA_PROJECT_REF) throw new Error(`Linked analytics target ${linked || '(missing)'} is not ${EXTRA_PROJECT_REF}.`);
  }
  const report = { mode: options.apply ? 'apply' : 'dry-run', target: options.apply ? EXTRA_PROJECT_URL : null, kind: options.kind, profileStart: options.profileStart, sports: [] };
  for (const sport of options.sports) report.sports.push(await processSport(SOURCES[sport], options));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) run().catch((error) => { console.error(`Sports Reference media import failed: ${String(error?.stack ?? error)}`); process.exitCode = 1; });

export { SOURCES, extractHeadshot, extractTeamPageHeadshots, parseArgs, buildLogoRows, buildHeadshotRows, executeSql, teamCacheFile };
