#!/usr/bin/env node

/**
 * Repoint exact NFL placeholder rows to one verified, canonical FreeImage
 * asset.  Dry-run is the default.  --apply requires the isolated Extra
 * analytics project and rejects any row whose player, source, or asset URL
 * changed after the local plan was produced.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const ANALYTICS_WORKDIR = path.join(ROOT, 'supabase-sports-analytics');
const EXTRA_PROJECT_REF = 'rioxosivyhczxshhmaen';
const EXTRA_PROJECT_URL = `https://${EXTRA_PROJECT_REF}.supabase.co`;
const SUPABASE_CLI_VERSION = '2.115.0';
const SOURCE_NAME = 'freeimage_canonical_nfl_default_icon';
const DEFAULT_PLAN = path.join(
  ROOT,
  'outputs',
  'freeimage-upload-runs',
  'nfl',
  'default-icon-33be6a8e3c2e353f-reconciled',
  'default-icon-player-references.jsonl',
);
const MAX_ROWS_PER_STATEMENT = 500;

function usage() {
  return `
Usage:
  node .\\scripts\\repoint-nfl-default-icon-to-freeimage.mjs [options]

Options:
  --plan <path>           Default-icon JSONL plan (default: generated NFL plan)
  --apply --analytics      Write only the linked Extra analytics project
  --help                   Show this help

Default mode is a read-only preflight.  Apply refuses to overwrite a row
unless it still has the exact planned NFLverse placeholder URL.
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
  const known = new Set(['plan', 'apply', 'analytics', 'help']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  if (flags.has('help')) return { help: true };
  const apply = flags.has('apply');
  const analytics = flags.has('analytics');
  if (apply && !analytics) throw new Error('--apply requires --analytics.');
  return {
    help: false,
    apply,
    analytics,
    plan: path.resolve(String(values.get('plan') ?? DEFAULT_PLAN)),
  };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
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

function runProcess(command, args, timeoutMs, { cwd = ROOT, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
      } else {
        child.kill();
      }
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function runQueryFromFile(sql, label) {
  const workDirectory = path.join(ROOT, 'outputs', 'nfl-default-icon-repoint-work');
  fs.mkdirSync(workDirectory, { recursive: true });
  const filePath = path.join(workDirectory, `${label}.sql`);
  fs.writeFileSync(filePath, sql, 'utf8');
  const result = await runProcess('npx.cmd', [
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', ANALYTICS_WORKDIR,
    '--output-format', 'json', '--file', filePath,
  ], 180_000, { cwd: ANALYTICS_WORKDIR, shell: true });
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${String(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1800)}`);
  }
  const payload = parseJsonEnvelope(result.stdout);
  if (!Array.isArray(payload?.rows)) {
    throw new Error(`${label} returned invalid JSON: ${String(result.stdout).slice(0, 1800)}`);
  }
  return payload.rows;
}

function validateHttps(value, label) {
  const url = new URL(String(value ?? ''));
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a plain HTTPS URL.`);
  }
  return url.href;
}

function loadPlan(planPath) {
  if (!fs.existsSync(planPath)) throw new Error(`Plan file was not found: ${planPath}`);
  const records = [];
  const playerIds = new Set();
  const sourceUrls = new Set();
  let canonicalAssetUrl = '';
  let canonicalViewerUrl = '';
  let sourceSha256 = '';
  for (const [index, line] of fs.readFileSync(planPath, 'utf8').split(/\r?\n/).filter(Boolean).entries()) {
    let row;
    try { row = JSON.parse(line); } catch (error) { throw new Error(`Plan line ${index + 1} is invalid JSON: ${String(error.message ?? error)}`); }
    const playerId = String(row.player_id ?? '').trim();
    const playerName = String(row.player_name ?? '').trim();
    const expectedAssetUrl = validateHttps(row.original_remote_url, `Plan line ${index + 1} original_remote_url`);
    const sourceDatasetUrl = validateHttps(row.source_url, `Plan line ${index + 1} source_url`);
    const assetUrl = validateHttps(row.canonical_asset_url, `Plan line ${index + 1} canonical_asset_url`);
    const viewerUrl = validateHttps(row.canonical_freeimage_viewer_url, `Plan line ${index + 1} canonical_freeimage_viewer_url`);
    const sha = String(row.source_sha256 ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`Plan line ${index + 1} has an invalid source SHA-256.`);
    if (!playerId || !playerName || row.transfer_status !== 'canonical_default_icon_reference') {
      throw new Error(`Plan line ${index + 1} is not a complete canonical-default record.`);
    }
    if (playerIds.has(playerId) || sourceUrls.has(expectedAssetUrl)) throw new Error(`Plan repeats a player or original asset URL at line ${index + 1}.`);
    if (canonicalAssetUrl && canonicalAssetUrl !== assetUrl) throw new Error('Plan contains more than one canonical asset URL.');
    if (canonicalViewerUrl && canonicalViewerUrl !== viewerUrl) throw new Error('Plan contains more than one canonical viewer URL.');
    if (sourceSha256 && sourceSha256 !== sha) throw new Error('Plan contains more than one source SHA-256.');
    playerIds.add(playerId);
    sourceUrls.add(expectedAssetUrl);
    canonicalAssetUrl = assetUrl;
    canonicalViewerUrl = viewerUrl;
    sourceSha256 = sha;
    records.push({
      player_id: playerId,
      player_name: playerName,
      expected_asset_url: expectedAssetUrl,
      source_dataset_url: sourceDatasetUrl,
      canonical_asset_url: assetUrl,
      canonical_viewer_url: viewerUrl,
      source_sha256: sha,
    });
  }
  if (!records.length) throw new Error('Plan has no canonical-default player rows.');
  return { records, canonicalAssetUrl, canonicalViewerUrl, sourceSha256 };
}

function stageSql(records) {
  return `
create temporary table _nfl_default_icon_plan (
  player_id uuid primary key,
  player_name text not null,
  expected_asset_url text not null,
  source_dataset_url text not null,
  canonical_asset_url text not null,
  canonical_viewer_url text not null,
  source_sha256 text not null
) on commit drop;
insert into _nfl_default_icon_plan (
  player_id, player_name, expected_asset_url, source_dataset_url, canonical_asset_url, canonical_viewer_url, source_sha256
)
select player_id, player_name, expected_asset_url, source_dataset_url, canonical_asset_url, canonical_viewer_url, source_sha256
from jsonb_to_recordset(${sqlJson(records)}) as source(
  player_id uuid, player_name text, expected_asset_url text, source_dataset_url text, canonical_asset_url text,
  canonical_viewer_url text, source_sha256 text
);
`;
}

function preflightSql(records) {
  return `
begin;
${stageSql(records)}
with checks as (
  select
    count(*)::integer as expected_rows,
    count(media.id) filter (
      where media.asset_kind = 'headshot'
        and media.source_name = 'nflverse'
        and media.asset_url = plan.expected_asset_url
    )::integer as exact_matches,
    count(media.id) filter (where media.id is null)::integer as missing_media_rows,
    count(media.id) filter (
      where media.id is not null
        and not (media.asset_kind = 'headshot'
          and media.source_name = 'nflverse'
          and media.asset_url = plan.expected_asset_url)
    )::integer as changed_or_non_nflverse_rows
  from _nfl_default_icon_plan plan
  left join public.nfl_media_assets media on media.player_id = plan.player_id
)
select row_to_json(checks) as report from checks;
commit;
`;
}

function applySql(records) {
  return `
begin;
${stageSql(records)}
do $guard$
declare
  expected_rows integer;
  exact_matches integer;
begin
  select count(*)::integer,
    count(media.id) filter (
      where media.asset_kind = 'headshot'
        and media.source_name = 'nflverse'
        and media.asset_url = plan.expected_asset_url
    )::integer
  into expected_rows, exact_matches
  from _nfl_default_icon_plan plan
  left join public.nfl_media_assets media on media.player_id = plan.player_id;
  if exact_matches <> expected_rows then
    raise exception 'Fail-closed: % of % planned rows still match the expected NFLverse placeholder source.', exact_matches, expected_rows;
  end if;
end;
$guard$;
with updated as (
  update public.nfl_media_assets as media
  set asset_url = plan.canonical_asset_url,
    alt_text = concat('NFL player placeholder image for ', plan.player_name),
    source_name = ${sqlLiteral(SOURCE_NAME)},
    source_url = plan.source_dataset_url,
    source_license_note = concat(
      'User-authorized FreeImage re-host of the exact NFL default player placeholder. Canonical SHA-256: ',
      plan.source_sha256,
      '. Original NFLverse asset URL: ', plan.expected_asset_url, '.'
    ),
    rights_confirmed = true,
    capture_method = 'browser_cache',
    updated_at = now()
  from _nfl_default_icon_plan as plan
  where media.player_id = plan.player_id
    and media.asset_kind = 'headshot'
    and media.source_name = 'nflverse'
    and media.asset_url = plan.expected_asset_url
  returning media.player_id
)
select count(*)::integer as updated_rows from updated;
commit;
`;
}

function verificationSql(records, canonicalAssetUrl) {
  return `
begin;
${stageSql(records)}
with checks as (
  select
    count(*)::integer as expected_rows,
    count(media.id) filter (
      where media.asset_kind = 'headshot'
        and media.source_name = ${sqlLiteral(SOURCE_NAME)}
        and media.asset_url = ${sqlLiteral(canonicalAssetUrl)}
        and media.rights_confirmed
    )::integer as canonical_matches
  from _nfl_default_icon_plan plan
  left join public.nfl_media_assets media on media.player_id = plan.player_id
)
select row_to_json(checks) as report from checks;
commit;
`;
}

function extractReport(rows, label) {
  if (rows.length !== 1 || !rows[0]?.report || typeof rows[0].report !== 'object') {
    throw new Error(`${label} did not return one JSON report row.`);
  }
  return rows[0].report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const projectRef = fs.readFileSync(path.join(ANALYTICS_WORKDIR, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
  if (projectRef !== EXTRA_PROJECT_REF) throw new Error(`Linked analytics target ${projectRef || '(missing)'} is not ${EXTRA_PROJECT_REF}.`);
  const plan = loadPlan(options.plan);
  const preflight = extractReport(await runQueryFromFile(preflightSql(plan.records), 'preflight'), 'Preflight');
  const expectedRows = Number(preflight.expected_rows);
  const exactMatches = Number(preflight.exact_matches);
  if (expectedRows !== plan.records.length || exactMatches !== expectedRows) {
    throw new Error(`Fail-closed preflight: ${exactMatches}/${expectedRows} rows still match the exact expected NFLverse placeholder source.`);
  }
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      target: null,
      plan: path.relative(ROOT, options.plan),
      canonical_asset_url: plan.canonicalAssetUrl,
      canonical_viewer_url: plan.canonicalViewerUrl,
      source_sha256: plan.sourceSha256,
      preflight,
    })}\n`);
    return;
  }
  const applyRows = await runQueryFromFile(applySql(plan.records), 'apply');
  const updatedRows = Number(applyRows[0]?.updated_rows);
  if (updatedRows !== expectedRows) throw new Error(`Apply returned ${updatedRows} rows; expected ${expectedRows}.`);
  const verification = extractReport(await runQueryFromFile(verificationSql(plan.records, plan.canonicalAssetUrl), 'verify'), 'Verification');
  if (Number(verification.canonical_matches) !== expectedRows) {
    throw new Error(`Post-write verification found ${verification.canonical_matches}/${expectedRows} canonical rows.`);
  }
  process.stdout.write(`${JSON.stringify({
    mode: 'apply',
    target: EXTRA_PROJECT_URL,
    plan: path.relative(ROOT, options.plan),
    canonical_asset_url: plan.canonicalAssetUrl,
    canonical_viewer_url: plan.canonicalViewerUrl,
    source_sha256: plan.sourceSha256,
    preflight,
    updated_rows: updatedRows,
    verification,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
