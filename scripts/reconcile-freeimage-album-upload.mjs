#!/usr/bin/env node

/**
 * Rebuild a player-to-FreeImage ledger from a completed album when the upload
 * form has already reset.  It matches the provider-preserved filename to the
 * immutable manifest's remote-image basename and fails closed on ambiguity.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function usage() {
  return `
Usage:
  node .\\scripts\\reconcile-freeimage-album-upload.mjs \\
    --sport <mlb|nfl|nba> --manifest <manifest.jsonl> --album <label> \\
    --label <run-label> (--album-entries-base64 <base64-json-array> | --album-entries-file <entries.json> | --album-entries-stdin 1)
`;
}

function argumentValues(argv) {
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
  for (const required of ['sport', 'manifest', 'album', 'label']) {
    if (!values.has(required)) throw new Error(`Missing --${required}.`);
  }
  const hasBase64Entries = values.has('album-entries-base64');
  const hasFileEntries = values.has('album-entries-file');
  const hasStdinEntries = values.has('album-entries-stdin');
  if ([hasBase64Entries, hasFileEntries, hasStdinEntries].filter(Boolean).length !== 1) {
    throw new Error('Provide exactly one album-entry input: base64, file, or stdin.');
  }
  const sport = String(values.get('sport')).toLowerCase();
  if (!['mlb', 'nfl', 'nba'].includes(sport)) throw new Error('--sport must be mlb, nfl, or nba.');
  const label = String(values.get('label'));
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/i.test(label)) throw new Error('--label must use letters, numbers, and hyphens only.');
  return {
    sport,
    manifestPath: path.resolve(values.get('manifest')),
    album: String(values.get('album')).trim(),
    label,
    entries: hasBase64Entries
      ? decodeEntries(values.get('album-entries-base64'))
      : hasFileEntries
        ? decodeEntriesFile(path.resolve(values.get('album-entries-file')))
        : decodeEntriesStdin(),
  };
}

function httpsUrl(value, host, kind) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`Invalid ${kind} URL.`); }
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || url.hash) {
    throw new Error(`Invalid ${kind} URL.`);
  }
  return url.href;
}

function decodeEntries(encoded) {
  let raw;
  try { raw = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8')); } catch { throw new Error('Album entries are not valid base64 JSON.'); }
  return validateEntries(raw);
}

function decodeEntriesFile(filePath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { throw new Error(`Album entries file is not valid JSON: ${filePath}`); }
  return validateEntries(raw);
}

function decodeEntriesStdin() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { throw new Error('Album entries from stdin are not valid JSON.'); }
  return validateEntries(raw);
}

function validateEntries(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 250) throw new Error('Album entries must contain 1 through 250 images.');
  const names = new Set();
  const viewers = new Set();
  return raw.map((entry, index) => {
    const filename = String(entry?.filename ?? '').trim();
    if (!/^[a-z0-9_-]+\.(?:jpe?g|png|webp|gif)$/i.test(filename)) throw new Error(`Invalid provider filename at index ${index}.`);
    if (names.has(filename)) throw new Error(`Duplicate provider filename: ${filename}`);
    names.add(filename);
    const viewer = httpsUrl(entry?.viewer, 'freeimage.host', 'viewer');
    if (viewers.has(viewer)) throw new Error(`Duplicate provider viewer URL: ${viewer}`);
    viewers.add(viewer);
    const direct = httpsUrl(entry?.direct, 'iili.io', 'direct');
    const imageCode = new URL(viewer).pathname.split('/').filter(Boolean).at(-1)?.split('.').at(-1);
    if (!imageCode || !new URL(direct).pathname.includes(`/${imageCode}.`)) throw new Error(`Viewer/direct mismatch for ${filename}.`);
    return { filename, viewer, direct };
  });
}

function jsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid manifest JSONL at line ${index + 1}.`); }
  });
}

function writeNew(filePath, contents) {
  if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing output: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
}

function main() {
  const options = argumentValues(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const byFilename = new Map();
  for (const source of jsonl(options.manifestPath)) {
    const remoteUrl = new URL(String(source.remote_url));
    const filename = remoteUrl.pathname.split('/').filter(Boolean).at(-1);
    if (!filename) throw new Error(`Manifest has an invalid remote URL for ${source.player_id}.`);
    if (byFilename.has(filename)) throw new Error(`Manifest basename is ambiguous: ${filename}`);
    byFilename.set(filename, source);
  }
  const now = new Date().toISOString();
  const rows = options.entries.map((entry, uploadIndex) => {
    const exactSource = byFilename.get(entry.filename);
    const extensionlessFilename = entry.filename.replace(/\.(?:jpe?g|png|webp|gif)$/i, '');
    const extensionlessSource = byFilename.get(extensionlessFilename);
    if (exactSource && extensionlessSource && exactSource !== extensionlessSource) {
      throw new Error(`Ambiguous provider filename: ${entry.filename}`);
    }
    const source = exactSource ?? extensionlessSource;
    if (!source) throw new Error(`No manifest source matches uploaded filename: ${entry.filename}`);
    return {
      format: 'freeimage-url-upload-ledger/v1',
      recorded_at: now,
      reconciliation_method: 'provider_album_filename',
      sport: options.sport,
      album_label: options.album,
      upload_index: uploadIndex,
      player_id: String(source.player_id ?? ''),
      player_name: String(source.player_name ?? ''),
      remote_url: String(source.remote_url ?? ''),
      source_url: String(source.source_url ?? ''),
      source_name: String(source.source_name ?? ''),
      rights_confirmed: Boolean(source.rights_confirmed),
      freeimage_viewer_url: entry.viewer,
      freeimage_direct_url: entry.direct,
      transfer_status: 'uploaded',
    };
  });
  const outputDirectory = path.join(ROOT, 'outputs', 'freeimage-upload-runs', options.sport, 'url-upload-ledgers');
  const ledgerPath = path.join(outputDirectory, `${options.label}.jsonl`);
  const summaryPath = path.join(outputDirectory, `${options.label}.summary.json`);
  writeNew(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeNew(summaryPath, `${JSON.stringify({
    format: 'freeimage-album-reconciliation-summary/v1',
    recorded_at: now,
    sport: options.sport,
    album_label: options.album,
    rows: rows.length,
    reconciliation_method: 'provider_album_filename',
    ledger: path.relative(ROOT, ledgerPath),
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ledger: path.relative(ROOT, ledgerPath), summary: path.relative(ROOT, summaryPath), rows: rows.length }, null, 2));
}

try { main(); } catch (error) {
  console.error(`FreeImage album reconciliation failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
}
