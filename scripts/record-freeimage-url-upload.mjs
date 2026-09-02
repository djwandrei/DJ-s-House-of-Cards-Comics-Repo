#!/usr/bin/env node

/**
 * Create an immutable player-to-FreeImage ledger from a verified URL-upload
 * completion screen.  The provider URLs are supplied as base64-encoded JSON
 * arrays so the command line remains unambiguous and no browser-source data
 * is altered while recording the result.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function usage() {
  return `
Usage:
  node .\\scripts\\record-freeimage-url-upload.mjs \\
    --sport <mlb|nfl|nba> --manifest <manifest.jsonl> --source-batch <urls.txt> \\
    --take <count> --viewer-base64 <base64-json-array> \\
    --direct-base64 <base64-json-array> --album <album label> --label <run label>
`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    if (token === '--help') return { help: true };
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}.`);
    values.set(name, value);
    index += 1;
  }
  if (values.has('help')) return { help: true };
  const required = ['sport', 'manifest', 'source-batch', 'take', 'viewer-base64', 'direct-base64', 'album', 'label'];
  for (const key of required) if (!values.has(key)) throw new Error(`Missing --${key}.`);
  const sport = String(values.get('sport')).toLowerCase();
  if (!['mlb', 'nfl', 'nba'].includes(sport)) throw new Error('--sport must be mlb, nfl, or nba.');
  const take = Number.parseInt(values.get('take'), 10);
  if (!Number.isInteger(take) || take < 1 || take > 250) throw new Error('--take must be an integer from 1 through 250.');
  const label = String(values.get('label'));
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/i.test(label)) throw new Error('--label must use letters, numbers, and hyphens only.');
  return {
    sport,
    manifest: path.resolve(values.get('manifest')),
    sourceBatch: path.resolve(values.get('source-batch')),
    take,
    viewers: decodeUrlArray(values.get('viewer-base64'), 'viewer'),
    directs: decodeUrlArray(values.get('direct-base64'), 'direct'),
    album: String(values.get('album')).trim(),
    label,
  };
}

function decodeUrlArray(encoded, kind) {
  let values;
  try {
    values = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'));
  } catch {
    throw new Error(`--${kind}-base64 must decode to a JSON array.`);
  }
  if (!Array.isArray(values)) throw new Error(`--${kind}-base64 must decode to a JSON array.`);
  return values.map((value) => validateHttpsUrl(value, kind));
}

function validateHttpsUrl(value, kind) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`Invalid ${kind} URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error(`Invalid ${kind} URL.`);
  if (kind === 'viewer' && url.hostname !== 'freeimage.host') throw new Error('Viewer URL is not a FreeImage URL.');
  if (kind === 'direct' && url.hostname !== 'iili.io') throw new Error('Direct URL is not an iili.io URL.');
  return url.href;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at ${filePath}:${index + 1}.`); }
  });
}

function sourceUrls(filePath, take) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < take) throw new Error(`Source batch has ${lines.length} URLs but --take is ${take}.`);
  const urls = lines.slice(0, take);
  if (new Set(urls).size !== urls.length) throw new Error('Source batch contains duplicate URLs in the selected range.');
  for (const url of urls) validateHttpsUrl(url, 'source');
  return urls;
}

function validatePair(viewer, direct) {
  const code = new URL(viewer).pathname.split('/').filter(Boolean).at(-1);
  if (!code || !new URL(direct).pathname.includes(`/${code}.`)) {
    throw new Error(`FreeImage viewer/direct pair does not share image code: ${viewer}`);
  }
}

function writeNewFile(filePath, content) {
  if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing ledger: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.viewers.length !== options.take || options.directs.length !== options.take) {
    throw new Error(`Provider response count must equal --take (${options.take}); received ${options.viewers.length} viewer and ${options.directs.length} direct URLs.`);
  }
  const manifestRows = readJsonl(options.manifest);
  const byRemoteUrl = new Map();
  for (const row of manifestRows) {
    const remoteUrl = validateHttpsUrl(row.remote_url, 'source');
    if (byRemoteUrl.has(remoteUrl)) throw new Error(`Manifest has duplicate remote URL: ${remoteUrl}`);
    byRemoteUrl.set(remoteUrl, row);
  }
  const urls = sourceUrls(options.sourceBatch, options.take);
  const uploadedAt = new Date().toISOString();
  const ledgerRows = urls.map((remoteUrl, index) => {
    const source = byRemoteUrl.get(remoteUrl);
    if (!source) throw new Error(`Source URL is not present in the manifest: ${remoteUrl}`);
    const viewer = options.viewers[index];
    const direct = options.directs[index];
    validatePair(viewer, direct);
    return {
      format: 'freeimage-url-upload-ledger/v1',
      recorded_at: uploadedAt,
      sport: options.sport,
      album_label: options.album,
      upload_index: index,
      player_id: String(source.player_id ?? ''),
      player_name: String(source.player_name ?? ''),
      remote_url: remoteUrl,
      source_url: String(source.source_url ?? ''),
      source_name: String(source.source_name ?? ''),
      rights_confirmed: Boolean(source.rights_confirmed),
      freeimage_viewer_url: viewer,
      freeimage_direct_url: direct,
      transfer_status: 'uploaded',
    };
  });
  const outputDirectory = path.join(ROOT, 'outputs', 'freeimage-upload-runs', options.sport, 'url-upload-ledgers');
  const ledgerPath = path.join(outputDirectory, `${options.label}.jsonl`);
  const summaryPath = path.join(outputDirectory, `${options.label}.summary.json`);
  writeNewFile(ledgerPath, `${ledgerRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeNewFile(summaryPath, `${JSON.stringify({
    format: 'freeimage-url-upload-ledger-summary/v1',
    recorded_at: uploadedAt,
    sport: options.sport,
    album_label: options.album,
    rows: ledgerRows.length,
    source_batch: path.relative(ROOT, options.sourceBatch),
    source_range: { start_index: 0, end_index: options.take - 1 },
    ledger: path.relative(ROOT, ledgerPath),
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ledger: path.relative(ROOT, ledgerPath), summary: path.relative(ROOT, summaryPath), rows: ledgerRows.length }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`FreeImage URL ledger recording failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
}
