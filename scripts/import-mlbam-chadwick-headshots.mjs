#!/usr/bin/env node

/**
 * Bulk, URL-only MLB headshot importer.
 *
 * The Chadwick Register supplies an auditable exact bridge from the Baseball
 * Reference player IDs already stored in the Baseball analytics warehouse to
 * MLBAM IDs.  This worker never name-matches, requests Baseball Reference, or
 * downloads image binaries.  It preserves any existing non-Chadwick media
 * record for a player.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  PRO_SPORTS_ANALYTICS_WORKDIR,
  proSportsAnalyticsTarget,
} from './lib/pro-sports-analytics-targets.mjs';

const ROOT = process.cwd();
const BASEBALL_TARGET = proSportsAnalyticsTarget('mlb');
const CHADWICK_COMMIT = '7640314a83d788c63fa7d26fa5ce9a9871053e27';
const CHADWICK_ARCHIVE_SHA256 = '6b18444f5ee2f7137294cad1b71c7676fb41162b872759f0ce0be746eb98f2ef';
const CHADWICK_ARCHIVE_URL = `https://github.com/chadwickbureau/register/archive/${CHADWICK_COMMIT}.zip`;
const DEFAULT_ARCHIVE = path.join(
  ROOT,
  'outputs',
  'sports-reference-media-cache',
  'mlb',
  'chadwick',
  `register-${CHADWICK_COMMIT}.zip`,
);
const SOURCE_NAME = 'mlbam_chadwick';
const SOURCE_LICENSE_NOTE = 'Chadwick Register ODC-BY 1.0 exact Baseball-Reference-to-MLBAM ID manifest; user-confirmed private image rehosting permission on 2026-09-01. MLB image URL retained as a provider reference.';
const SUPABASE_CLI_VERSION = '2.115.0';
const NPX_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const MAX_UPSERT_RECORDS_PER_STATEMENT = 500;
const MAX_TRANSIENT_WRITE_ATTEMPTS = 3;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MLBAM_ID_PATTERN = /^\d{1,12}$/;
const MLB_IMAGE_HOST = 'img.mlbstatic.com';

function usage() {
  return `
Usage:
  node .\\scripts\\import-mlbam-chadwick-headshots.mjs [options]

Options:
  --archive <path>           Pinned Chadwick Register archive cache
                              (default: ${path.relative(ROOT, DEFAULT_ARCHIVE)})
  --profile-start <year>     Earliest eligible MLB season (default: 2010)
  --apply --analytics        Transactionally write the Baseball analytics project
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
  const known = new Set(['archive', 'profile-start', 'apply', 'analytics', 'help']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  const profileStart = Number.parseInt(String(values.get('profile-start') ?? 2010), 10);
  if (!Number.isInteger(profileStart) || profileStart < 1876 || profileStart > 2200) {
    throw new Error('--profile-start must be an integer from 1876 through 2200.');
  }
  return {
    help: false,
    archive: path.resolve(String(values.get('archive') ?? DEFAULT_ARCHIVE)),
    profileStart,
    apply: flags.has('apply'),
    analytics: flags.has('analytics'),
  };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeExternalId(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parseCsv(text, sourceLabel) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error(`${sourceLabel} has an unterminated quoted field.`);
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (!rows.length) throw new Error(`${sourceLabel} is empty.`);
  const headers = rows.shift().map((value) => value.trim());
  for (const required of ['key_bbref', 'key_mlbam']) {
    if (!headers.includes(required)) throw new Error(`${sourceLabel} is missing required column: ${required}`);
  }
  return rows
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function buildHeadshotUrl(mlbamId) {
  const url = new URL(`https://${MLB_IMAGE_HOST}/mlb-photos/image/upload/w_213,q_auto:best/v1/people/${mlbamId}/headshot/67/current`);
  if (url.protocol !== 'https:' || url.hostname !== MLB_IMAGE_HOST || !MLBAM_ID_PATTERN.test(String(mlbamId))) {
    return '';
  }
  return url.href;
}

async function downloadArchive(archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const response = await fetch(CHADWICK_ARCHIVE_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Chadwick archive download failed with HTTP ${response.status}.`);
  const tempPath = `${archivePath}.download`;
  fs.writeFileSync(tempPath, Buffer.from(await response.arrayBuffer()));
  const downloadedHash = hashFile(tempPath);
  if (downloadedHash !== CHADWICK_ARCHIVE_SHA256) {
    fs.unlinkSync(tempPath);
    throw new Error(`Chadwick archive SHA-256 mismatch: expected ${CHADWICK_ARCHIVE_SHA256}, received ${downloadedHash}.`);
  }
  fs.renameSync(tempPath, archivePath);
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
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function ensureArchiveAndData(archivePath) {
  if (!fs.existsSync(archivePath)) await downloadArchive(archivePath);
  const archiveHash = hashFile(archivePath);
  if (archiveHash !== CHADWICK_ARCHIVE_SHA256) {
    throw new Error(`Fail-closed: Chadwick archive SHA-256 must be ${CHADWICK_ARCHIVE_SHA256}; received ${archiveHash}.`);
  }
  const extractRoot = path.join(path.dirname(archivePath), `register-${CHADWICK_COMMIT}`);
  const dataDirectory = path.join(extractRoot, 'data');
  if (!fs.existsSync(dataDirectory)) {
    const result = await runProcess('tar.exe', ['-xf', archivePath, '-C', path.dirname(archivePath)], 120_000);
    if (result.code !== 0) {
      throw new Error(`Unable to extract verified Chadwick archive: ${String(result.stderr || result.stdout).trim().slice(0, 1800)}`);
    }
  }
  const personFiles = fs.readdirSync(dataDirectory)
    .filter((name) => /^people-[0-9a-f]\.csv$/i.test(name))
    .sort()
    .map((name) => path.join(dataDirectory, name));
  if (personFiles.length !== 16) {
    throw new Error(`Fail-closed: expected 16 Chadwick people shards, found ${personFiles.length}.`);
  }
  return { archiveHash, personFiles };
}

async function loadExactMappings(archivePath) {
  const { archiveHash, personFiles } = await ensureArchiveAndData(archivePath);
  const records = new Map();
  const invalidExternalIds = [];
  const invalidMlbamIds = [];
  const conflicts = [];
  let manifestRows = 0;
  for (const personFile of personFiles) {
    const rows = parseCsv(fs.readFileSync(personFile, 'utf8'), path.basename(personFile));
    manifestRows += rows.length;
    for (const row of rows) {
      const rawExternalId = String(row.key_bbref ?? '').trim();
      const rawMlbamId = String(row.key_mlbam ?? '').trim();
      if (!rawExternalId && !rawMlbamId) continue;
      if (!EXTERNAL_ID_PATTERN.test(rawExternalId)) {
        if (rawExternalId) invalidExternalIds.push(rawExternalId);
        continue;
      }
      if (!MLBAM_ID_PATTERN.test(rawMlbamId)) {
        invalidMlbamIds.push(rawExternalId);
        continue;
      }
      const key = normalizeExternalId(rawExternalId);
      const assetUrl = buildHeadshotUrl(rawMlbamId);
      if (!assetUrl) {
        invalidMlbamIds.push(rawExternalId);
        continue;
      }
      const candidate = { externalId: rawExternalId, key, mlbamId: rawMlbamId, assetUrl, archiveHash };
      const existing = records.get(key);
      if (!existing) records.set(key, candidate);
      else if (existing.mlbamId !== candidate.mlbamId) conflicts.push(rawExternalId);
    }
  }
  return {
    archiveHash,
    personFiles,
    manifestRows,
    records,
    invalidExternalIds,
    invalidMlbamIds,
    conflicts,
  };
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

async function querySql(sql) {
  const workDirectory = path.join(ROOT, 'outputs', 'mlbam-chadwick-headshot-import-work');
  fs.mkdirSync(workDirectory, { recursive: true });
  const sqlFile = path.join(workDirectory, 'query-mlbam-chadwick-headshots.sql');
  fs.writeFileSync(sqlFile, sql, 'utf8');
  const result = await runNpx([
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked',
    '--workdir', PRO_SPORTS_ANALYTICS_WORKDIR, '--project-ref', BASEBALL_TARGET.projectRef,
    '--output-format', 'json', '--file', sqlFile,
  ], 120_000);
  if (result.code !== 0) {
    throw new Error(`Baseball analytics read failed: ${String(result.stderr || result.stdout).trim().slice(0, 1800)}`);
  }
  const payload = parseJsonEnvelope(result.stdout);
  if (!Array.isArray(payload?.rows)) {
    throw new Error(`Analytics read returned invalid JSON: ${String(result.stdout).slice(0, 1200)}`);
  }
  return payload.rows;
}

async function applySql(sql) {
  const workDirectory = path.join(ROOT, 'outputs', 'mlbam-chadwick-headshot-import-work');
  fs.mkdirSync(workDirectory, { recursive: true });
  const sqlFile = path.join(workDirectory, 'apply-mlbam-chadwick-headshots.sql');
  fs.writeFileSync(sqlFile, sql, 'utf8');
  const result = await runNpx([
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked',
    '--workdir', PRO_SPORTS_ANALYTICS_WORKDIR, '--project-ref', BASEBALL_TARGET.projectRef,
    '--file', sqlFile,
  ], 180_000);
  if (result.code !== 0) {
    throw new Error(`Baseball analytics write failed: ${String(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1800)}`);
  }
}

function runNpx(args, timeoutMs) {
  if (fs.existsSync(NPX_CLI)) {
    return runProcess(process.execPath, [NPX_CLI, ...args], timeoutMs, { cwd: PRO_SPORTS_ANALYTICS_WORKDIR });
  }
  // Windows cannot spawn a .cmd file without a shell.  The fallback accepts
  // only fixed local paths and generated SQL-file arguments, never SQL text.
  return runProcess('npx.cmd', args, timeoutMs, { cwd: PRO_SPORTS_ANALYTICS_WORKDIR, shell: true });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildUpsertSql(records) {
  if (!records.length) return 'select 0;';
  return `
begin;
create temporary table _mlbam_chadwick_headshot_stage on commit drop as
select * from jsonb_to_recordset(${sqlJson(records)}) as row_data(
  player_id uuid, asset_url text, alt_text text, source_url text,
  source_license_note text, capture_method text
);
insert into public.mlb_media_assets (
  player_id, team_season_id, asset_kind, asset_url, alt_text, source_name,
  source_url, source_license_note, rights_confirmed, capture_method
)
select player_id, null, 'headshot', asset_url, alt_text, ${sqlLiteral(SOURCE_NAME)},
  source_url, source_license_note, true, capture_method
from _mlbam_chadwick_headshot_stage
on conflict (player_id, asset_kind) where player_id is not null do update
set asset_url = excluded.asset_url,
  alt_text = excluded.alt_text,
  source_url = excluded.source_url,
  source_license_note = excluded.source_license_note,
  rights_confirmed = true,
  capture_method = excluded.capture_method,
  updated_at = now()
where public.mlb_media_assets.source_name = ${sqlLiteral(SOURCE_NAME)};
commit;
`;
}

async function applyBatches(records) {
  let appliedRecords = 0;
  let statements = 0;
  for (let start = 0; start < records.length; start += MAX_UPSERT_RECORDS_PER_STATEMENT) {
    const batch = records.slice(start, start + MAX_UPSERT_RECORDS_PER_STATEMENT);
    for (let attempt = 1; attempt <= MAX_TRANSIENT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await applySql(buildUpsertSql(batch));
        break;
      } catch (error) {
        const transientRoleFailure = /LegacyDbConfigConnectTempRoleError|password authentication failed for user "cli_login_postgres"/i.test(String(error?.message ?? error));
        if (!transientRoleFailure || attempt === MAX_TRANSIENT_WRITE_ATTEMPTS) throw error;
        console.warn(`Retrying batch ${statements + 1} after transient Supabase CLI authentication failure (${attempt}/${MAX_TRANSIENT_WRITE_ATTEMPTS}).`);
        await delay(attempt * 1_500);
      }
    }
    appliedRecords += batch.length;
    statements += 1;
  }
  return { appliedRecords, statements };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.apply && !options.analytics) throw new Error('--apply requires --analytics.');

  const manifest = await loadExactMappings(options.archive);
  if (manifest.conflicts.length) {
    throw new Error(`Fail-closed: ${manifest.conflicts.length} Baseball-Reference IDs have conflicting MLBAM mappings.`);
  }
  const eligible = await querySql(`
    select external_ids.player_id, external_ids.external_id, players.full_name,
      media.id as existing_media_id, media.source_name as existing_source_name
    from public.mlb_player_external_ids as external_ids
    join public.mlb_players as players on players.id = external_ids.player_id
    left join public.mlb_media_assets as media
      on media.player_id = external_ids.player_id and media.asset_kind = 'headshot'
    where external_ids.source_name = 'baseball_reference'
      and exists (
        select 1
        from public.mlb_player_team_season_stats as stats
        where stats.player_id = external_ids.player_id and stats.season_year >= ${options.profileStart}
      )
    order by external_ids.external_id;
  `);
  const sourceRecords = [];
  const unmatched = [];
  let preservedExisting = 0;
  let replaceableBulkRows = 0;
  for (const player of eligible) {
    const item = manifest.records.get(normalizeExternalId(player.external_id));
    if (!item) {
      unmatched.push(player.external_id);
      continue;
    }
    if (player.existing_media_id && player.existing_source_name !== SOURCE_NAME) {
      preservedExisting += 1;
      continue;
    }
    if (player.existing_media_id) replaceableBulkRows += 1;
    sourceRecords.push({
      player_id: player.player_id,
      asset_url: item.assetUrl,
      alt_text: `Photo of ${player.full_name}`,
      source_url: CHADWICK_ARCHIVE_URL,
      source_license_note: `${SOURCE_LICENSE_NOTE} Archive SHA-256: ${item.archiveHash}.`,
      capture_method: 'bulk_manifest',
    });
  }
  const writeResult = options.apply
    ? await applyBatches(sourceRecords)
    : { appliedRecords: 0, statements: 0 };
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    target: options.apply ? BASEBALL_TARGET.projectUrl : null,
    profileStart: options.profileStart,
    archive: {
      path: path.relative(ROOT, options.archive),
      sha256: manifest.archiveHash,
      sourceUrl: CHADWICK_ARCHIVE_URL,
      peopleShards: manifest.personFiles.length,
      rows: manifest.manifestRows,
      validExactMappings: manifest.records.size,
      invalidExternalIds: manifest.invalidExternalIds.length,
      invalidMlbamIds: manifest.invalidMlbamIds.length,
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
if (import.meta.url === invokedModuleUrl) {
  run().catch((error) => {
    console.error(`MLBAM/Chadwick headshot import failed: ${String(error?.stack ?? error)}`);
    process.exitCode = 1;
  });
}

export { parseArgs, parseCsv, buildHeadshotUrl, loadExactMappings, buildUpsertSql };
