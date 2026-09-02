#!/usr/bin/env node

/**
 * Build resumable NFL URL-import batches from the non-default-headshot plan.
 *
 * Default NFL silhouettes and pre-existing hosted headshots are deliberately
 * absent from the source plan.  Completed URL-upload ledgers are then removed
 * before a new queue is written, which makes reruns safe and resumable.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function usage() {
  return `\nUsage:\n  node .\\scripts\\build-freeimage-nfl-url-queue.mjs \\\n+    --plan-dir <upload-batches directory> --manifest <manifest.jsonl> \\\n+    --completed-ledger-dir <directory> --label <run-label> [--shard-size <1-250>]\n`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true };
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    values.set(token.slice(2), value);
    index += 1;
  }
  const required = ['plan-dir', 'manifest', 'completed-ledger-dir', 'label'];
  for (const key of required) if (!values.has(key)) throw new Error(`Missing --${key}.`);
  const shardSize = Number.parseInt(values.get('shard-size') ?? '200', 10);
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > 250) {
    throw new Error('--shard-size must be an integer from 1 through 250.');
  }
  const label = String(values.get('label'));
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/i.test(label)) throw new Error('--label must use letters, numbers, and hyphens only.');
  return {
    planDirectory: path.resolve(values.get('plan-dir')),
    manifest: path.resolve(values.get('manifest')),
    completedLedgerDirectory: path.resolve(values.get('completed-ledger-dir')),
    additionalCompletedLedgerDirectory: values.has('additional-completed-ledger-dir')
      ? path.resolve(values.get('additional-completed-ledger-dir'))
      : null,
    label,
    shardSize,
  };
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at ${filePath}:${index + 1}.`); }
  });
}

function ensureHttps(value, description) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`Invalid ${description} URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new Error(`Invalid ${description} URL.`);
  }
  return url.href;
}

function writeNew(filePath, content) {
  if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing output: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  const manifestUrls = new Set(readJsonl(options.manifest).map((row) => ensureHttps(row.remote_url, 'manifest')));
  const planFiles = fs.readdirSync(options.planDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(options.planDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!planFiles.length) throw new Error(`No JSONL plan files found in ${options.planDirectory}.`);

  const planned = [];
  const seenPlanUrls = new Set();
  for (const filePath of planFiles) {
    for (const row of readJsonl(filePath)) {
      if (row.transfer_status !== 'upload_required') throw new Error(`Unexpected transfer status in ${filePath}: ${row.transfer_status}`);
      const remoteUrl = ensureHttps(row.original_remote_url, 'plan');
      if (!manifestUrls.has(remoteUrl)) throw new Error(`Plan URL is absent from the staged NFL manifest: ${remoteUrl}`);
      if (seenPlanUrls.has(remoteUrl)) throw new Error(`Duplicate planned NFL URL: ${remoteUrl}`);
      seenPlanUrls.add(remoteUrl);
      planned.push(remoteUrl);
    }
  }

  const completed = new Set();
  const ledgerDirectories = [options.completedLedgerDirectory, options.additionalCompletedLedgerDirectory].filter(Boolean);
  for (const ledgerDirectory of ledgerDirectories) {
    if (!fs.existsSync(ledgerDirectory)) continue;
    for (const entry of fs.readdirSync(ledgerDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      for (const row of readJsonl(path.join(ledgerDirectory, entry.name))) {
        if (row.sport !== 'nfl' || !['uploaded', 'uploaded_verified'].includes(row.transfer_status)) continue;
        completed.add(ensureHttps(row.remote_url ?? row.original_remote_url, 'completed ledger'));
      }
    }
  }
  for (const url of completed) if (!seenPlanUrls.has(url)) throw new Error(`Completed NFL ledger URL is not in the non-default plan: ${url}`);
  const remaining = planned.filter((url) => !completed.has(url));
  const outputDirectory = path.join(ROOT, 'outputs', 'freeimage-upload-runs', 'nfl', 'url-upload-queues', options.label);
  const batches = [];
  for (let start = 0; start < remaining.length; start += options.shardSize) {
    batches.push(remaining.slice(start, start + options.shardSize));
  }
  const width = Math.max(4, String(Math.max(batches.length, 1)).length);
  for (let index = 0; index < batches.length; index += 1) {
    const batchName = `${String(index + 1).padStart(width, '0')}-of-${String(batches.length).padStart(width, '0')}.txt`;
    writeNew(path.join(outputDirectory, 'batches', batchName), `${batches[index].join('\n')}\n`);
  }
  const summary = {
    format: 'freeimage-nfl-url-queue/v1',
    created_at: new Date().toISOString(),
    plan_urls: planned.length,
    completed_urls: completed.size,
    remaining_urls: remaining.length,
    batches: batches.length,
    shard_size: options.shardSize,
  };
  writeNew(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ outputDirectory: path.relative(ROOT, outputDirectory), ...summary }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`NFL URL queue build failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
}
