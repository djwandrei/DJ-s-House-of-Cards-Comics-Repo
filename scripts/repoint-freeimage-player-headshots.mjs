#!/usr/bin/env node

/**
 * Repoint verified player-headshot rows to direct FreeImage URLs.
 *
 * The immutable reconciliation ledger supplies both the current asset URL and
 * the verified iili.io replacement.  Dry-run is the default; apply refuses
 * to change a row that no longer exactly matches its planned source URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  PRO_SPORTS_ANALYTICS_WORKDIR,
  proSportsAnalyticsTarget,
} from './lib/pro-sports-analytics-targets.mjs';

const ROOT = process.cwd();
const SUPABASE_CLI_VERSION = '2.115.0';
const NPX_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');

const SPORTS = Object.freeze({
  mlb: Object.freeze({
    table: 'mlb_media_assets',
    target: proSportsAnalyticsTarget('mlb'),
    sourceNames: new Set(['baseball_reference', 'mlbam_chadwick']),
  }),
  nfl: Object.freeze({
    table: 'nfl_media_assets',
    target: proSportsAnalyticsTarget('nfl'),
    sourceNames: new Set(['nflverse']),
  }),
});

function usage() {
  return `
Usage:
  node .\\scripts\\repoint-freeimage-player-headshots.mjs \\
    --sport <mlb|nfl> --plan <reconciled-ledger.jsonl> \\
    [--exclude-plan <canonical-default-plan.jsonl>] [--apply --analytics]

The default is a read-only, exact-match preflight.  --apply requires
--analytics and changes only player headshots that still have the original
planned source URL and source name.
`;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values.set(name, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values.set(name, argv[++index]);
    else flags.add(name);
  }
  const known = new Set(['sport', 'plan', 'exclude-plan', 'apply', 'analytics', 'help']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  if (flags.has('help')) return { help: true };
  const sport = String(values.get('sport') ?? '').trim().toLowerCase();
  const definition = SPORTS[sport];
  if (!definition) throw new Error('--sport must be mlb or nfl.');
  if (!values.has('plan')) throw new Error('--plan is required.');
  const apply = flags.has('apply');
  const analytics = flags.has('analytics');
  if (apply && !analytics) throw new Error('--apply requires --analytics.');
  return {
    help: false,
    sport,
    definition,
    plan: path.resolve(String(values.get('plan'))),
    excludePlan: values.has('exclude-plan') ? path.resolve(String(values.get('exclude-plan'))) : null,
    apply,
    analytics,
  };
}

function plainHttpsUrl(value, label, requiredHost = null) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw new Error(`${label} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.hash) {
    throw new Error(`${label} must be a plain HTTPS URL.`);
  }
  if (requiredHost && url.hostname !== requiredHost) throw new Error(`${label} must use ${requiredHost}.`);
  return url.href;
}

function loadCanonicalExclusions(filePath) {
  if (!filePath) return new Set();
  if (!fs.existsSync(filePath)) throw new Error(`Exclusion plan was not found: ${filePath}`);
  const exclusions = new Set();
  for (const [index, line] of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).entries()) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`Exclusion line ${index + 1} is not valid JSON.`); }
    const playerId = String(row?.player_id ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(playerId)) {
      throw new Error(`Exclusion line ${index + 1} has an invalid player ID.`);
    }
    if (row?.transfer_status !== 'canonical_default_icon_reference') {
      throw new Error(`Exclusion line ${index + 1} is not a canonical-default record.`);
    }
    const originalUrl = plainHttpsUrl(row?.original_remote_url, `Exclusion line ${index + 1} original_remote_url`);
    plainHttpsUrl(row?.canonical_asset_url, `Exclusion line ${index + 1} canonical_asset_url`, 'iili.io');
    const identity = `${playerId}\u0000${originalUrl}`;
    if (exclusions.has(identity)) throw new Error(`Exclusion plan repeats a player/source pair at line ${index + 1}.`);
    exclusions.add(identity);
  }
  if (!exclusions.size) throw new Error('Exclusion plan has no canonical-default records.');
  return exclusions;
}

function loadPlan(options, exclusions) {
  if (!fs.existsSync(options.plan)) throw new Error(`Plan was not found: ${options.plan}`);
  const records = [];
  const playerIds = new Set();
  const sourcePairs = new Set();
  for (const [index, line] of fs.readFileSync(options.plan, 'utf8').split(/\r?\n/).filter(Boolean).entries()) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`Plan line ${index + 1} is not valid JSON.`); }
    const playerId = String(row?.player_id ?? '').trim();
    const sourceName = String(row?.source_name ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(playerId)) {
      throw new Error(`Plan line ${index + 1} has an invalid player ID.`);
    }
    if (!options.definition.sourceNames.has(sourceName)) {
      throw new Error(`Plan line ${index + 1} has an unexpected ${options.sport.toUpperCase()} source name.`);
    }
    const expectedAssetUrl = plainHttpsUrl(row?.remote_url, `Plan line ${index + 1} remote_url`);
    const freeimageAssetUrl = plainHttpsUrl(row?.freeimage_direct_url, `Plan line ${index + 1} freeimage_direct_url`, 'iili.io');
    const sourcePair = `${playerId}\u0000${expectedAssetUrl}`;
    if (exclusions.has(sourcePair)) continue;
    if (playerIds.has(playerId) || sourcePairs.has(sourcePair)) {
      throw new Error(`Plan repeats a player or original asset at line ${index + 1}.`);
    }
    playerIds.add(playerId);
    sourcePairs.add(sourcePair);
    records.push({
      player_id: playerId,
      source_name: sourceName,
      expected_asset_url: expectedAssetUrl,
      freeimage_asset_url: freeimageAssetUrl,
    });
  }
  if (!records.length) throw new Error('Plan has no player-headshot records.');
  return records;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function stageSql(records) {
  return `
create temporary table _freeimage_headshot_plan (
  player_id uuid primary key,
  source_name text not null,
  expected_asset_url text not null,
  freeimage_asset_url text not null
) on commit drop;
insert into _freeimage_headshot_plan (
  player_id, source_name, expected_asset_url, freeimage_asset_url
)
select player_id, source_name, expected_asset_url, freeimage_asset_url
from jsonb_to_recordset(${sqlJson(records)}) as source(
  player_id uuid, source_name text, expected_asset_url text, freeimage_asset_url text
);
`;
}

function preflightSql(definition, records) {
  return `
begin;
${stageSql(records)}
with checks as (
  select
    count(*)::integer as expected_rows,
    count(media.id) filter (
      where media.asset_kind = 'headshot'
        and media.source_name = plan.source_name
        and media.asset_url = plan.expected_asset_url
    )::integer as exact_matches,
    count(media.id) filter (where media.id is null)::integer as missing_media_rows,
    count(media.id) filter (
      where media.id is not null
        and not (
          media.asset_kind = 'headshot'
          and media.source_name = plan.source_name
          and media.asset_url = plan.expected_asset_url
        )
    )::integer as changed_or_nonmatching_rows
  from _freeimage_headshot_plan as plan
  left join public.${definition.table} as media on media.player_id = plan.player_id
)
select row_to_json(checks) as report from checks;
rollback;
`;
}

function applySql(definition, records) {
  return `
begin;
${stageSql(records)}
do $guard$
declare
  expected_rows integer;
  exact_matches integer;
begin
  select
    count(*)::integer,
    count(media.id) filter (
      where media.asset_kind = 'headshot'
        and media.source_name = plan.source_name
        and media.asset_url = plan.expected_asset_url
    )::integer
  into expected_rows, exact_matches
  from _freeimage_headshot_plan as plan
  left join public.${definition.table} as media on media.player_id = plan.player_id;
  if exact_matches <> expected_rows then
    raise exception 'Fail-closed: % of % planned headshot rows still match their expected source.', exact_matches, expected_rows;
  end if;
end;
$guard$;
with updated as (
  update public.${definition.table} as media
  set asset_url = plan.freeimage_asset_url,
    source_license_note = concat(
      'User-authorized FreeImage re-host. Original asset URL: ',
      plan.expected_asset_url,
      case when nullif(media.source_license_note, '') is null then '' else concat(' ', media.source_license_note) end
    ),
    capture_method = 'bulk_manifest',
    updated_at = now()
  from _freeimage_headshot_plan as plan
  where media.player_id = plan.player_id
    and media.asset_kind = 'headshot'
    and media.source_name = plan.source_name
    and media.asset_url = plan.expected_asset_url
  returning media.player_id
)
select count(*)::integer as updated_rows from updated;
commit;
`;
}

function verificationSql(definition, records) {
  return `
begin;
${stageSql(records)}
with checks as (
  select
    count(*)::integer as expected_rows,
    count(media.id) filter (
      where media.asset_kind = 'headshot'
        and media.source_name = plan.source_name
        and media.asset_url = plan.freeimage_asset_url
        and media.asset_url like 'https://iili.io/%'
    )::integer as freeimage_matches,
    count(media.id) filter (where media.asset_url = plan.expected_asset_url)::integer as original_url_matches
  from _freeimage_headshot_plan as plan
  left join public.${definition.table} as media on media.player_id = plan.player_id
)
select row_to_json(checks) as report from checks;
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

function runProcess(command, args, timeoutMs, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell,
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
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function runQuery(definition, sport, label, sql) {
  const workDirectory = path.join(ROOT, 'outputs', 'freeimage-headshot-repoint-work', sport);
  fs.mkdirSync(workDirectory, { recursive: true });
  const filePath = path.join(workDirectory, `${label}.sql`);
  fs.writeFileSync(filePath, sql, 'utf8');
  const args = [
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked',
    '--workdir', PRO_SPORTS_ANALYTICS_WORKDIR,
    '--project-ref', definition.target.projectRef,
    '--output-format', 'json', '--file', filePath,
  ];
  const result = fs.existsSync(NPX_CLI)
    ? await runProcess(process.execPath, [NPX_CLI, ...args], 300_000, { cwd: PRO_SPORTS_ANALYTICS_WORKDIR, shell: false })
    : await runProcess('npx.cmd', args, 300_000, { cwd: PRO_SPORTS_ANALYTICS_WORKDIR, shell: true });
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${String(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1800)}`);
  }
  const payload = parseJsonEnvelope(result.stdout);
  if (!Array.isArray(payload?.rows)) throw new Error(`${label} returned invalid JSON.`);
  return payload.rows;
}

function report(rows, label) {
  if (rows.length !== 1 || !rows[0]?.report || typeof rows[0].report !== 'object') {
    throw new Error(`${label} did not return one report row.`);
  }
  return rows[0].report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const records = loadPlan(options, loadCanonicalExclusions(options.excludePlan));
  const preflight = report(
    await runQuery(options.definition, options.sport, 'preflight', preflightSql(options.definition, records)),
    'Preflight',
  );
  const expectedRows = Number(preflight.expected_rows);
  const exactMatches = Number(preflight.exact_matches);
  if (expectedRows !== records.length || exactMatches !== expectedRows || Number(preflight.missing_media_rows) !== 0 || Number(preflight.changed_or_nonmatching_rows) !== 0) {
    throw new Error(`Fail-closed preflight: ${exactMatches}/${expectedRows} rows exactly match the immutable plan.`);
  }
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', sport: options.sport, target: options.definition.target.projectUrl,
      plan: path.relative(ROOT, options.plan), exclusion_plan: options.excludePlan ? path.relative(ROOT, options.excludePlan) : null, preflight,
    })}\n`);
    return;
  }
  const applied = await runQuery(options.definition, options.sport, 'apply', applySql(options.definition, records));
  const updatedRows = Number(applied[0]?.updated_rows);
  if (updatedRows !== expectedRows) throw new Error(`Apply updated ${updatedRows} rows; expected ${expectedRows}.`);
  const verification = report(
    await runQuery(options.definition, options.sport, 'verification', verificationSql(options.definition, records)),
    'Verification',
  );
  if (Number(verification.freeimage_matches) !== expectedRows || Number(verification.original_url_matches) !== 0) {
    throw new Error(`Post-write verification found ${verification.freeimage_matches}/${expectedRows} FreeImage rows.`);
  }
  process.stdout.write(`${JSON.stringify({
    mode: 'apply', sport: options.sport, target: options.definition.target.projectUrl,
    plan: path.relative(ROOT, options.plan), exclusion_plan: options.excludePlan ? path.relative(ROOT, options.excludePlan) : null, preflight, updated_rows: updatedRows, verification,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
