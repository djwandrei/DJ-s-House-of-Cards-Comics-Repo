#!/usr/bin/env node

/**
 * Build deterministic, resumable remote-URL batches for FreeImage albums.
 *
 * The files produced here contain no image binaries.  FreeImage's signed-in
 * "Add image URLs" flow obtains the source images server-side, allowing large
 * batches without a local browser downloader.  Each source record remains in
 * JSONL so a later verified FreeImage URL can be written back without losing
 * original provenance.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const NPX_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const SUPABASE_CLI_VERSION = '2.115.0';
const DEFAULT_SHARD_SIZE = 200;
const MAX_SHARD_SIZE = 250;

const SPORTS = Object.freeze({
  mlb: Object.freeze({
    analyticsDirectory: 'supabase-sports-analytics',
    mediaTable: 'mlb_media_assets',
    playersTable: 'mlb_players',
    statsTable: 'mlb_player_team_season_stats',
    seasonColumn: 'season_year',
    defaultProfileStart: 2010,
    albumLabel: 'MLB Player Profile Pics',
  }),
  nfl: Object.freeze({
    analyticsDirectory: 'supabase-sports-analytics',
    mediaTable: 'nfl_media_assets',
    playersTable: 'nfl_players',
    statsTable: 'nfl_player_team_season_stats',
    seasonColumn: 'season_year',
    defaultProfileStart: 2010,
    albumLabel: 'NFL Player Profile Pics',
  }),
  nba: Object.freeze({
    analyticsDirectory: 'supabase-analytics',
    mediaTable: 'nba_media_assets',
    playersTable: 'nba_players',
    statsTable: 'nba_player_team_season_stats',
    seasonColumn: 'season_end_year',
    defaultProfileStart: 2010,
    albumLabel: 'NBA Player Profile Pics',
  }),
});

function usage() {
  return `
Usage:
  node .\\scripts\\build-freeimage-player-photo-manifests.mjs --sport <mlb|nfl|nba> [options]

Options:
  --sport <sport>            Required source league
  --profile-start <year>     Eligibility season (default: 2010)
  --shard-size <1-250>       URLs in each FreeImage paste batch (default: ${DEFAULT_SHARD_SIZE})
  --include-unconfirmed      Include rows still marked rights_confirmed=false
  --output-dir <path>        Explicit destination directory
  --help                     Show this help

Writes:
  summary.json               Immutable batch metadata and counts
  manifest.jsonl             Source/player ledger, one row per remote image
  batches/*.txt              Paste-ready FreeImage remote-URL batches
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
  const known = new Set(['sport', 'profile-start', 'shard-size', 'include-unconfirmed', 'output-dir', 'help']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  const sport = String(values.get('sport') ?? '').toLowerCase();
  const definition = SPORTS[sport];
  if (!definition) throw new Error('--sport must be one of: mlb, nfl, nba.');
  const profileStart = Number.parseInt(String(values.get('profile-start') ?? definition.defaultProfileStart), 10);
  const shardSize = Number.parseInt(String(values.get('shard-size') ?? DEFAULT_SHARD_SIZE), 10);
  if (!Number.isInteger(profileStart) || profileStart < 1876 || profileStart > 2200) {
    throw new Error('--profile-start must be an integer from 1876 through 2200.');
  }
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > MAX_SHARD_SIZE) {
    throw new Error(`--shard-size must be an integer from 1 through ${MAX_SHARD_SIZE}.`);
  }
  return {
    help: false,
    sport,
    definition,
    profileStart,
    shardSize,
    includeUnconfirmed: flags.has('include-unconfirmed'),
    outputDirectory: values.has('output-dir') ? path.resolve(String(values.get('output-dir'))) : null,
  };
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

function runNpx(args, workdir, timeoutMs) {
  if (fs.existsSync(NPX_CLI)) {
    return runProcess(process.execPath, [NPX_CLI, ...args], timeoutMs, { cwd: workdir });
  }
  return runProcess('npx.cmd', args, timeoutMs, { cwd: workdir, shell: true });
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

function sqlFor(definition, profileStart, includeUnconfirmed) {
  const confirmationFilter = includeUnconfirmed ? '' : 'and media.rights_confirmed';
  return `
select
  media.player_id,
  players.full_name,
  media.asset_url,
  media.source_url,
  media.source_name,
  media.rights_confirmed,
  media.updated_at
from public.${definition.mediaTable} as media
join public.${definition.playersTable} as players on players.id = media.player_id
where media.asset_kind = 'headshot'
  and media.player_id is not null
  ${confirmationFilter}
  and exists (
    select 1
    from public.${definition.statsTable} as stats
    where stats.player_id = media.player_id
      and stats.${definition.seasonColumn} >= ${profileStart}
  )
order by media.player_id, media.updated_at desc;
`;
}

async function loadRows(options) {
  const workdir = path.join(ROOT, options.definition.analyticsDirectory);
  const scratchDirectory = path.join(ROOT, 'outputs', 'freeimage-player-photo-manifest-work');
  fs.mkdirSync(scratchDirectory, { recursive: true });
  const sqlFile = path.join(scratchDirectory, `query-${options.sport}-${options.profileStart}-${options.includeUnconfirmed ? 'all' : 'confirmed'}.sql`);
  fs.writeFileSync(sqlFile, sqlFor(options.definition, options.profileStart, options.includeUnconfirmed), 'utf8');
  const result = await runNpx([
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', workdir,
    '--output-format', 'json', '--file', sqlFile,
  ], workdir, 180_000);
  if (result.code !== 0) {
    throw new Error(`Unable to query ${options.sport.toUpperCase()} media: ${String(result.stderr || result.stdout).trim().slice(0, 1800)}`);
  }
  const payload = parseJsonEnvelope(result.stdout);
  if (!Array.isArray(payload?.rows)) throw new Error('Media query returned invalid JSON.');
  return payload.rows;
}

function validateHttpsImageUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.hash || url.href.length > 2048) return '';
    return url.href;
  } catch {
    return '';
  }
}

function prepareManifestRows(rows, sport) {
  const byPlayer = new Map();
  const invalidUrls = [];
  for (const row of rows) {
    const playerId = String(row.player_id ?? '').trim();
    const remoteUrl = validateHttpsImageUrl(row.asset_url);
    if (!playerId || !remoteUrl) {
      invalidUrls.push({ playerId, assetUrl: String(row.asset_url ?? '') });
      continue;
    }
    if (byPlayer.has(playerId)) continue;
    byPlayer.set(playerId, {
      sport,
      player_id: playerId,
      player_name: String(row.full_name ?? '').trim(),
      remote_url: remoteUrl,
      source_url: String(row.source_url ?? '').trim(),
      source_name: String(row.source_name ?? '').trim(),
      rights_confirmed: Boolean(row.rights_confirmed),
      freeimage_url: null,
      transfer_status: 'pending',
    });
  }
  const manifestRows = [...byPlayer.values()].sort((left, right) => left.player_id.localeCompare(right.player_id));
  const uniqueRemoteUrls = new Set(manifestRows.map((row) => row.remote_url));
  return { manifestRows, invalidUrls, uniqueRemoteUrls };
}

function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function partition(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function makeDefaultOutputDirectory(options, fingerprint) {
  return path.join(ROOT, 'outputs', 'freeimage-player-photo-manifests', options.sport, fingerprint.slice(0, 16));
}

function writeManifest(options, prepared) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(prepared.manifestRows)).digest('hex');
  const outputDirectory = options.outputDirectory ?? makeDefaultOutputDirectory(options, fingerprint);
  const batchesDirectory = path.join(outputDirectory, 'batches');
  fs.mkdirSync(batchesDirectory, { recursive: true });
  const rowsByUrl = [...prepared.uniqueRemoteUrls].sort();
  const batches = partition(rowsByUrl, options.shardSize);
  const manifestPath = path.join(outputDirectory, 'manifest.jsonl');
  const manifestContent = prepared.manifestRows.map((row) => JSON.stringify(row)).join('\n') + (prepared.manifestRows.length ? '\n' : '');
  writeAtomic(manifestPath, manifestContent);
  const batchFiles = [];
  for (const [index, urls] of batches.entries()) {
    const fileName = `${String(index + 1).padStart(4, '0')}-of-${String(batches.length).padStart(4, '0')}.txt`;
    const filePath = path.join(batchesDirectory, fileName);
    writeAtomic(filePath, `${urls.join('\n')}\n`);
    batchFiles.push(path.relative(outputDirectory, filePath));
  }
  const summary = {
    format: 'freeimage-remote-url-manifest/v1',
    createdAt: new Date().toISOString(),
    sport: options.sport,
    albumLabel: options.definition.albumLabel,
    profileStart: options.profileStart,
    includeUnconfirmed: options.includeUnconfirmed,
    rows: prepared.manifestRows.length,
    uniqueRemoteUrls: rowsByUrl.length,
    invalidRowsSkipped: prepared.invalidUrls.length,
    shardSize: options.shardSize,
    batchCount: batches.length,
    fingerprint,
    instructions: 'Paste one batch file at a time into FreeImage Add image URLs. Wait for completion and retain the provider response before marking those JSONL rows completed.',
    batchFiles,
  };
  writeAtomic(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { outputDirectory, summary };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const sourceRows = await loadRows(options);
  const prepared = prepareManifestRows(sourceRows, options.sport);
  const written = writeManifest(options, prepared);
  const report = {
    sourceRows: sourceRows.length,
    manifestRows: prepared.manifestRows.length,
    uniqueRemoteUrls: prepared.uniqueRemoteUrls.size,
    invalidRowsSkipped: prepared.invalidUrls.length,
    outputDirectory: path.relative(ROOT, written.outputDirectory),
    summary: written.summary,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) {
  run().catch((error) => {
    console.error(`FreeImage manifest build failed: ${String(error?.stack ?? error)}`);
    process.exitCode = 1;
  });
}

export { parseArgs, validateHttpsImageUrl, prepareManifestRows, partition, sqlFor };
