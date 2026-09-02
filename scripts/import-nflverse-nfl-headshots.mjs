#!/usr/bin/env node

/**
 * Bulk, URL-only NFL headshot importer.
 *
 * NFLverse publishes one player manifest with the PFR ID crosswalk and an
 * NFL-hosted headshot URL. This worker joins only exact, case-insensitive PFR
 * IDs already present in the isolated analytics project; it never name-matches
 * players, downloads image binaries, or requests Pro Football Reference.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const ANALYTICS_WORKDIR = path.join(ROOT, 'supabase-sports-analytics');
const EXTRA_PROJECT_REF = 'rioxosivyhczxshhmaen';
const EXTRA_PROJECT_URL = `https://${EXTRA_PROJECT_REF}.supabase.co`;
const DEFAULT_MANIFEST = path.join(ROOT, 'outputs', 'sports-reference-media-cache', 'nfl', 'nflverse-players.csv');
const PLAYER_RELEASE_URL = 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv';
const SOURCE_NAME = 'nflverse';
const SOURCE_LICENSE_NOTE = 'NFLverse CC BY 4.0 player-ID/URL manifest; NFL image display rights are not inferred. URL-only private analytics import.';
const SUPABASE_CLI_VERSION = '2.115.0';
const MAX_UPSERT_RECORDS_PER_STATEMENT = 500;
const MAX_TRANSIENT_WRITE_ATTEMPTS = 3;
const PFR_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const ALLOWED_IMAGE_HOSTS = new Set(['static.www.nfl.com']);

function usage() {
  return `
Usage:
  node .\\scripts\\import-nflverse-nfl-headshots.mjs [options]

Options:
  --manifest <path>          NFLverse players.csv cache (default: ${path.relative(ROOT, DEFAULT_MANIFEST)})
  --profile-start <year>     Earliest eligible NFL season (default: 2010)
  --apply --analytics        Transactionally write the Extra analytics project
  --help                     Show this help
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
  const known = new Set(['manifest', 'profile-start', 'apply', 'analytics', 'help']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  if (flags.has('help')) return { help: true };
  const profileStart = Number.parseInt(String(values.get('profile-start') ?? 2010), 10);
  if (!Number.isInteger(profileStart) || profileStart < 1920 || profileStart > 2200) throw new Error('--profile-start must be an integer from 1920 through 2200.');
  return {
    help: false,
    manifest: path.resolve(String(values.get('manifest') ?? DEFAULT_MANIFEST)),
    profileStart,
    apply: flags.has('apply'),
    analytics: flags.has('analytics'),
  };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) { return `${sqlLiteral(JSON.stringify(value))}::jsonb`; }

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (quoted) throw new Error('NFLverse CSV has an unterminated quoted field.');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) throw new Error('NFLverse CSV is empty.');
  const headers = rows.shift().map((value) => value.trim());
  for (const required of ['pfr_id', 'headshot']) if (!headers.includes(required)) throw new Error(`NFLverse CSV is missing required column: ${required}`);
  return rows.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function normalizePfrId(value) { return String(value ?? '').trim().toLowerCase(); }

function validateHeadshotUrl(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    return parsed.protocol === 'https:'
      && ALLOWED_IMAGE_HOSTS.has(parsed.hostname)
      && !parsed.username && !parsed.password && !parsed.port && !parsed.hash
      && parsed.href.length <= 2048
      ? parsed.href : '';
  } catch { return ''; }
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) throw new Error(`NFLverse manifest was not found: ${manifestPath}`);
  const rows = parseCsv(fs.readFileSync(manifestPath, 'utf8'));
  const manifestHash = hashFile(manifestPath);
  const records = new Map();
  const invalidIds = [];
  const invalidUrls = [];
  const conflicts = [];
  for (const row of rows) {
    const pfrId = String(row.pfr_id ?? '').trim();
    const key = normalizePfrId(pfrId);
    if (!PFR_ID_PATTERN.test(pfrId)) {
      if (pfrId) invalidIds.push(pfrId);
      continue;
    }
    const assetUrl = validateHeadshotUrl(row.headshot);
    if (!assetUrl) {
      invalidUrls.push(pfrId);
      continue;
    }
    const candidate = { pfrId, key, assetUrl, manifestHash };
    const existing = records.get(key);
    if (!existing) records.set(key, candidate);
    else if (existing.assetUrl !== candidate.assetUrl) conflicts.push(pfrId);
  }
  return { rows, records, manifestHash, invalidIds, invalidUrls, conflicts };
}

function parseJsonEnvelope(text) {
  const start = String(text).indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
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
        try { return JSON.parse(text.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function runProcess(command, args, timeoutMs, { cwd = ROOT, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
      else child.kill();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function querySql(sql) {
  const compact = sql.replace(/\s+/g, ' ').trim();
  const result = await runProcess('npx.cmd', [
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', ANALYTICS_WORKDIR,
    '--output-format', 'json', `"${compact.replaceAll('"', '\\"')}"`,
  ], 120_000, { cwd: ANALYTICS_WORKDIR, shell: true });
  if (result.code !== 0) throw new Error(`Analytics read failed: ${String(result.stderr || result.stdout).trim().slice(0, 1800)}`);
  const payload = parseJsonEnvelope(result.stdout);
  if (!Array.isArray(payload?.rows)) throw new Error(`Analytics read returned invalid JSON: ${String(result.stdout).slice(0, 1200)}`);
  return payload.rows;
}

async function applySql(sql) {
  const workDirectory = path.join(ROOT, 'outputs', 'nflverse-headshot-import-work');
  fs.mkdirSync(workDirectory, { recursive: true });
  const sqlFile = path.join(workDirectory, 'apply-nflverse-headshots.sql');
  fs.writeFileSync(sqlFile, sql, 'utf8');
  const result = await runProcess('npx.cmd', [
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', ANALYTICS_WORKDIR, '--file', sqlFile,
  ], 180_000, { cwd: ANALYTICS_WORKDIR, shell: true });
  if (result.code !== 0) throw new Error(`Analytics write failed: ${String(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1800)}`);
}

async function applyBatches(records) {
  let appliedRecords = 0;
  let statements = 0;
  for (let start = 0; start < records.length; start += MAX_UPSERT_RECORDS_PER_STATEMENT) {
    const batch = records.slice(start, start + MAX_UPSERT_RECORDS_PER_STATEMENT);
    let completed = false;
    for (let attempt = 1; attempt <= MAX_TRANSIENT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await applySql(buildUpsertSql(batch));
        completed = true;
        break;
      } catch (error) {
        const transientRoleFailure = /LegacyDbConfigConnectTempRoleError|password authentication failed for user "cli_login_postgres"/i.test(String(error?.message ?? error));
        if (!transientRoleFailure || attempt === MAX_TRANSIENT_WRITE_ATTEMPTS) throw error;
        console.warn(`Retrying batch ${statements + 1} after transient Supabase CLI authentication failure (${attempt}/${MAX_TRANSIENT_WRITE_ATTEMPTS}).`);
        await delay(attempt * 1_500);
      }
    }
    if (!completed) throw new Error(`NFLverse batch ${statements + 1} did not complete.`);
    appliedRecords += batch.length;
    statements += 1;
  }
  return { appliedRecords, statements };
}

function buildUpsertSql(records) {
  if (!records.length) return 'select 0;';
  return `
begin;
create temporary table _nflverse_headshot_stage on commit drop as
select * from jsonb_to_recordset(${sqlJson(records)}) as row_data(
  player_id uuid, asset_url text, alt_text text, source_url text,
  source_license_note text, capture_method text
);
insert into public.nfl_media_assets (
  player_id, team_season_id, asset_kind, asset_url, alt_text, source_name,
  source_url, source_license_note, rights_confirmed, capture_method
)
select player_id, null, 'headshot', asset_url, alt_text, ${sqlLiteral(SOURCE_NAME)},
  source_url, source_license_note, false, capture_method
from _nflverse_headshot_stage
on conflict (player_id, asset_kind) where player_id is not null do update
set asset_url = excluded.asset_url,
  alt_text = excluded.alt_text,
  source_url = excluded.source_url,
  source_license_note = excluded.source_license_note,
  rights_confirmed = false,
  capture_method = excluded.capture_method,
  updated_at = now()
where public.nfl_media_assets.source_name = ${sqlLiteral(SOURCE_NAME)};
commit;
`;
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage()); return; }
  if (options.apply && !options.analytics) throw new Error('--apply requires --analytics.');
  if (options.apply) {
    const linkedRef = fs.readFileSync(path.join(ANALYTICS_WORKDIR, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
    if (linkedRef !== EXTRA_PROJECT_REF) throw new Error(`Linked analytics target ${linkedRef || '(missing)'} is not ${EXTRA_PROJECT_REF}.`);
  }

  const manifest = loadManifest(options.manifest);
  if (manifest.conflicts.length) throw new Error(`Fail-closed: ${manifest.conflicts.length} PFR IDs have conflicting approved bulk URLs.`);
  const eligible = await querySql(`
    select e.player_id, e.external_id, p.full_name,
      media.id as existing_media_id, media.source_name as existing_source_name
    from public.nfl_player_external_ids e
    join public.nfl_players p on p.id = e.player_id
    left join public.nfl_media_assets media on media.player_id = e.player_id and media.asset_kind = 'headshot'
    where e.source_name = 'pro_football_reference'
      and exists (
        select 1 from public.nfl_player_team_season_stats stats
        where stats.player_id = e.player_id and stats.season_year >= ${options.profileStart}
      )
    order by e.external_id;
  `);
  const sourceRecords = [];
  const unmatched = [];
  let preservedExisting = 0;
  let replaceableBulkRows = 0;
  for (const player of eligible) {
    const item = manifest.records.get(normalizePfrId(player.external_id));
    if (!item) { unmatched.push(player.external_id); continue; }
    if (player.existing_media_id && player.existing_source_name !== SOURCE_NAME) { preservedExisting += 1; continue; }
    if (player.existing_media_id) replaceableBulkRows += 1;
    sourceRecords.push({
      player_id: player.player_id,
      asset_url: item.assetUrl,
      alt_text: `Photo of ${player.full_name}`,
      source_url: PLAYER_RELEASE_URL,
      source_license_note: `${SOURCE_LICENSE_NOTE} SHA-256: ${item.manifestHash}.`,
      capture_method: 'bulk_manifest',
    });
  }
  const writeResult = options.apply ? await applyBatches(sourceRecords) : { appliedRecords: 0, statements: 0 };
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    target: options.apply ? EXTRA_PROJECT_URL : null,
    profileStart: options.profileStart,
    manifest: {
      path: path.relative(ROOT, options.manifest),
      rows: manifest.rows.length,
      sha256: manifest.manifestHash,
      validPfrHeadshots: manifest.records.size,
      invalidIds: manifest.invalidIds.length,
      invalidUrls: manifest.invalidUrls.length,
    },
    eligiblePlayers: eligible.length,
    exactMatches: eligible.length - unmatched.length,
    preservedExisting,
    insertOrUpdateCandidates: sourceRecords.length,
    replaceableBulkRows,
    appliedRecords: writeResult.appliedRecords,
    writeStatements: writeResult.statements,
    unmatched: { count: unmatched.length, externalIds: unmatched },
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) run().catch((error) => { console.error(`NFLverse headshot import failed: ${String(error?.stack ?? error)}`); process.exitCode = 1; });

export { parseArgs, parseCsv, validateHeadshotUrl, loadManifest, buildUpsertSql };
