#!/usr/bin/env node

/**
 * Download deterministic, locally staged player-photo batches for the
 * signed-in FreeImage browser uploader.  It deliberately uses ordinary
 * source requests with per-host pacing; HTTP access controls are recorded as
 * failures instead of retried aggressively or worked around.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'outputs');

const SPORTS = Object.freeze({
  nfl: Object.freeze({
    manifestRoot: path.join(OUTPUT_ROOT, 'freeimage-player-photo-manifests', 'nfl', 'fd9ce6cbc8036a68'),
    batchCount: 37,
    defaultConcurrency: 12,
    defaultDelayMs: 0,
  }),
  nba: Object.freeze({
    manifestRoot: path.join(OUTPUT_ROOT, 'freeimage-player-photo-manifests', 'nba', '06d292455238035e'),
    batchCount: 12,
    defaultConcurrency: 1,
    defaultDelayMs: 1250,
  }),
});

function usage() {
  return `
Usage:
  node .\\scripts\\stage-freeimage-player-photo-batches.mjs --sport <nfl|nba> [options]

Options:
  --sport <nfl|nba>      Required source league
  --from <number>        First manifest batch (default: 1)
  --to <number>          Last manifest batch (default: final batch)
  --run <number>         Staging run number (default: 1)
  --concurrency <number> Maximum total downloads (sport default)
  --delay-ms <number>    Delay between ordinary source requests (sport default)
  --resume               Finish an existing manifest-less staging directory
  --help                 Show this help

Writes only under:
  outputs/freeimage-staging/<sport>/batch-####-####/
`;
}

function integerOption(values, name, fallback, { min, max }) {
  const raw = values.get(name) ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values.set(name, inline);
    else if (['help', 'resume'].includes(name)) flags.add(name);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values.set(name, argv[++index]);
    else throw new Error(`Missing value for --${name}.`);
  }
  const known = new Set(['sport', 'from', 'to', 'run', 'concurrency', 'delay-ms', 'resume', 'help']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  const sport = String(values.get('sport') ?? '').trim().toLowerCase();
  const definition = SPORTS[sport];
  if (!definition) throw new Error('--sport must be one of: nfl, nba.');
  const from = integerOption(values, 'from', 1, { min: 1, max: definition.batchCount });
  const to = integerOption(values, 'to', definition.batchCount, { min: from, max: definition.batchCount });
  return {
    help: false,
    sport,
    definition,
    from,
    to,
    run: integerOption(values, 'run', 1, { min: 1, max: 9999 }),
    concurrency: integerOption(values, 'concurrency', definition.defaultConcurrency, { min: 1, max: 24 }),
    delayMs: integerOption(values, 'delay-ms', definition.defaultDelayMs, { min: 0, max: 60_000 }),
    resume: flags.has('resume'),
  };
}

function batchFileName(number, total) {
  return `${String(number).padStart(4, '0')}-of-${String(total).padStart(4, '0')}.txt`;
}

function stageDirectory(options, batchNumber) {
  return path.join(
    OUTPUT_ROOT,
    'freeimage-staging',
    options.sport,
    `batch-${String(batchNumber).padStart(4, '0')}-${String(options.run).padStart(4, '0')}`,
  );
}

function extensionFor(contentType) {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('avif')) return 'avif';
  return 'jpg';
}

function fileNameFor(sport, remoteUrl, contentType = 'image/jpeg') {
  const digest = crypto.createHash('sha256').update(remoteUrl).digest('hex').slice(0, 20);
  return `${sport}-headshot-${digest}.${extensionFor(contentType)}`;
}

function parseJsonl(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async () => new Promise((resolve) => {
    const enter = () => {
      active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        waiting.shift()?.();
      });
    };
    if (active < limit) enter();
    else waiting.push(enter);
  });
}

function hostPolicy(host, options) {
  const normalized = host.toLowerCase();
  if (normalized.endsWith('pro-football-reference.com')) return { limit: 1, delayMs: 1100 };
  if (normalized.endsWith('basketball-reference.com')) return { limit: 1, delayMs: Math.max(options.delayMs, 1250) };
  return { limit: options.concurrency, delayMs: options.delayMs };
}

async function prepareDirectory(directory, resume) {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  try {
    await fs.mkdir(directory, { recursive: false });
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const manifestPath = path.join(directory, 'manifest.json');
  try {
    await fs.access(manifestPath);
    throw new Error(`Refusing to overwrite completed staging manifest: ${manifestPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!resume) throw new Error(`Refusing to reuse incomplete staging directory without --resume: ${directory}`);
}

async function fetchImage(remoteUrl, requestGate) {
  const url = new URL(remoteUrl);
  const release = await requestGate(url.hostname);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      throw new Error(`HTTP ${response.status}${retryAfter ? ` (Retry-After ${retryAfter})` : ''}`);
    }
    if (!contentType.startsWith('image/')) throw new Error(`Unexpected content type ${contentType || '(empty)'}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 512) throw new Error(`Image too small: ${body.length} bytes`);
    return { body, contentType, finalUrl: response.url };
  } finally {
    release();
  }
}

function makeRequestGate(options) {
  const byHost = new Map();
  return async (host) => {
    let state = byHost.get(host);
    if (!state) {
      const policy = hostPolicy(host, options);
      state = { ...policy, limiter: createLimiter(policy.limit), nextRequestAt: 0 };
      byHost.set(host, state);
    }
    const release = await state.limiter();
    const wait = state.nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    state.nextRequestAt = Date.now() + state.delayMs;
    return release;
  };
}

async function stageBatch(options, masterByUrl, batchNumber) {
  const sourceBatch = batchFileName(batchNumber, options.definition.batchCount);
  const urls = (await fs.readFile(path.join(options.definition.manifestRoot, 'batches', sourceBatch), 'utf8'))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const sources = urls.map((remoteUrl, index) => {
    const source = masterByUrl.get(remoteUrl);
    if (!source) throw new Error(`No manifest row found for ${sourceBatch} URL ${index + 1}.`);
    return { source, index };
  });
  const directory = stageDirectory(options, batchNumber);
  await prepareDirectory(directory, options.resume);
  const requestGate = makeRequestGate(options);
  const outcomes = new Array(sources.length);
  let next = 0;

  async function stageOne({ source, index }) {
    const preliminaryName = fileNameFor(options.sport, source.remote_url);
    const preliminaryPath = path.join(directory, preliminaryName);
    const base = {
      index,
      player_id: source.player_id,
      player_name: source.player_name,
      remote_url: source.remote_url,
      source_url: source.source_url,
      source_name: source.source_name,
      rights_confirmed: Boolean(source.rights_confirmed),
    };
    try {
      try {
        const existing = await fs.stat(preliminaryPath);
        if (existing.size >= 512) {
          outcomes[index] = { ...base, file: preliminaryName, status: 'staged_existing', bytes: existing.size };
          return;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const image = await fetchImage(source.remote_url, requestGate);
      const file = fileNameFor(options.sport, source.remote_url, image.contentType);
      const destination = path.join(directory, file);
      try {
        await fs.writeFile(destination, image.body, { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.stat(destination);
        if (existing.size < 512) throw new Error(`Existing file is too small: ${existing.size} bytes`);
      }
      outcomes[index] = {
        ...base,
        file,
        status: 'staged',
        bytes: image.body.length,
        content_type: image.contentType,
        fetched_url: image.finalUrl,
      };
    } catch (error) {
      outcomes[index] = { ...base, status: 'failed', error: String(error.message ?? error) };
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= sources.length) return;
      await stageOne(sources[index]);
    }
  }));

  const counts = outcomes.reduce((result, outcome) => {
    result[outcome.status] = (result[outcome.status] ?? 0) + 1;
    return result;
  }, {});
  const manifest = {
    sport: options.sport,
    source_batch: sourceBatch,
    staging_run: options.run,
    staged_at: new Date().toISOString(),
    source_count: outcomes.length,
    outcomes,
  };
  await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ sport: options.sport, batch: batchNumber, directory, ...counts })}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const masterRows = parseJsonl(await fs.readFile(path.join(options.definition.manifestRoot, 'manifest.jsonl'), 'utf8'));
  const masterByUrl = new Map(masterRows.map((row) => [row.remote_url, row]));
  for (let batchNumber = options.from; batchNumber <= options.to; batchNumber += 1) {
    await stageBatch(options, masterByUrl, batchNumber);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
