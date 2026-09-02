#!/usr/bin/env node

/**
 * Produce immutable, deduplicated FreeImage URL batches after reconciling one
 * or more verified upload ledgers.  This prevents retries from re-uploading
 * assets already present in the destination album.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function usage() {
  return `
Usage:
  node .\\scripts\\build-freeimage-upload-queue.mjs \\
    --sport <mlb|nfl|nba> --manifest <manifest.jsonl> \\
    --completed-ledger-dir <directory> --label <run-label> [--shard-size <1-250>]
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
  for (const required of ['sport', 'manifest', 'completed-ledger-dir', 'label']) {
    if (!values.has(required)) throw new Error(`Missing --${required}.`);
  }
  const sport = String(values.get('sport')).toLowerCase();
  if (!['mlb', 'nfl', 'nba'].includes(sport)) throw new Error('--sport must be mlb, nfl, or nba.');
  const shardSize = Number.parseInt(values.get('shard-size') ?? '200', 10);
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > 250) throw new Error('--shard-size must be an integer from 1 through 250.');
  const label = String(values.get('label'));
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/i.test(label)) throw new Error('--label must use letters, numbers, and hyphens only.');
  return {
    sport,
    manifestPath: path.resolve(values.get('manifest')),
    ledgerDirectory: path.resolve(values.get('completed-ledger-dir')),
    label,
    shardSize,
  };
}

function rowsFromJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at ${filePath}:${index + 1}.`); }
  });
}

function https(value, label) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`Invalid ${label} URL.`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.hash) throw new Error(`Invalid ${label} URL.`);
  return url.href;
}

function writeNew(filePath, value) {
  if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing output: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, { encoding: 'utf8', flag: 'wx' });
}

function partition(values, size) {
  const batches = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const manifestRows = rowsFromJsonl(options.manifestPath);
  const manifestByUrl = new Map();
  for (const row of manifestRows) {
    const remoteUrl = https(row.remote_url, 'manifest source');
    if (manifestByUrl.has(remoteUrl)) throw new Error(`Manifest has duplicate remote URL: ${remoteUrl}`);
    manifestByUrl.set(remoteUrl, row);
  }
  if (!fs.statSync(options.ledgerDirectory).isDirectory()) throw new Error('--completed-ledger-dir must be a directory.');
  const ledgerFiles = fs.readdirSync(options.ledgerDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(options.ledgerDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (!ledgerFiles.length) throw new Error('No .jsonl upload ledgers were found.');
  const completed = new Set();
  for (const ledgerPath of ledgerFiles) {
    for (const row of rowsFromJsonl(ledgerPath)) {
      if (String(row.sport ?? '').toLowerCase() !== options.sport) throw new Error(`Ledger sport mismatch in ${ledgerPath}.`);
      if (row.transfer_status !== 'uploaded') continue;
      const remoteUrl = https(row.remote_url, 'ledger source');
      if (!manifestByUrl.has(remoteUrl)) throw new Error(`Ledger source is absent from manifest: ${remoteUrl}`);
      completed.add(remoteUrl);
    }
  }
  const remaining = [...manifestByUrl.values()]
    .filter((row) => !completed.has(https(row.remote_url, 'manifest source')))
    .sort((left, right) => https(left.remote_url, 'source').localeCompare(https(right.remote_url, 'source')))
    .map((row) => ({ ...row, queue_status: 'upload_required' }));
  const batches = partition(remaining, options.shardSize);
  const outputDirectory = path.join(ROOT, 'outputs', 'freeimage-upload-runs', options.sport, 'upload-queues', options.label);
  if (fs.existsSync(outputDirectory)) throw new Error(`Refusing to overwrite existing queue directory: ${outputDirectory}`);
  const batchDirectory = path.join(outputDirectory, 'batches');
  const total = String(Math.max(batches.length, 1)).padStart(4, '0');
  for (const [index, batch] of batches.entries()) {
    const fileName = `${String(index + 1).padStart(4, '0')}-of-${total}.txt`;
    writeNew(path.join(batchDirectory, fileName), `${batch.map((row) => https(row.remote_url, 'source')).join('\n')}\n`);
  }
  writeNew(path.join(outputDirectory, 'remaining-manifest.jsonl'), `${remaining.map((row) => JSON.stringify(row)).join('\n')}${remaining.length ? '\n' : ''}`);
  writeNew(path.join(outputDirectory, 'summary.json'), `${JSON.stringify({
    format: 'freeimage-deduplicated-upload-queue/v1',
    created_at: new Date().toISOString(),
    sport: options.sport,
    manifest_rows: manifestRows.length,
    completed_rows: completed.size,
    remaining_rows: remaining.length,
    shard_size: options.shardSize,
    batch_count: batches.length,
    source_manifest: path.relative(ROOT, options.manifestPath),
    upload_ledgers: ledgerFiles.map((filePath) => path.relative(ROOT, filePath)),
  }, null, 2)}\n`);
  console.log(JSON.stringify({ outputDirectory: path.relative(ROOT, outputDirectory), completed: completed.size, remaining: remaining.length, batches: batches.length }, null, 2));
}

try { main(); } catch (error) {
  console.error(`FreeImage queue build failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
}
