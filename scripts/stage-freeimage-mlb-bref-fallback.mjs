/**
 * Stage Baseball-Reference headshots only for MLBAM URLs that returned 404.
 *
 * The primary staging run remains immutable.  This creates a numbered retry
 * directory for each requested batch so completed primary files and recovered
 * fallback files can be combined without losing provenance.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const MANIFEST_ROOT = path.join(
  ROOT,
  'outputs',
  'freeimage-player-photo-manifests',
  'mlb',
  '6e5d4baeeaa301e4',
);
const STAGING_ROOT = path.join(ROOT, 'outputs', 'freeimage-staging', 'mlb');
const CHADWICK_DATA = path.join(
  ROOT,
  'outputs',
  'sports-reference-media-cache',
  'mlb',
  'chadwick',
  'register-7640314a83d788c63fa7d26fa5ce9a9871053e27',
  'data',
);
const BREF_HOST = 'www.baseball-reference.com';

function usage() {
  return `
Usage:
  node .\\scripts\\stage-freeimage-mlb-bref-fallback.mjs [options]

Options:
  --from <number>       First manifest batch number (default: 1)
  --to <number>         Last manifest batch number (default: 19)
  --concurrency <n>     Total concurrent profile/image workers (default: 6)
  --resume              Recover an interrupted, manifest-less retry staging run
  --help                Show this help
`;
}

function parseArgs(argv) {
  const values = new Map();
  let resume = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (name === 'help') return { help: true };
    if (name === 'resume') {
      if (inline !== undefined) throw new Error('--resume does not take a value.');
      resume = true;
      continue;
    }
    if (!['from', 'to', 'concurrency'].includes(name)) throw new Error(`Unknown option: --${name}`);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    values.set(name, value);
  }
  const from = Number.parseInt(values.get('from') ?? '1', 10);
  const to = Number.parseInt(values.get('to') ?? '19', 10);
  const concurrency = Number.parseInt(values.get('concurrency') ?? '6', 10);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 27) {
    throw new Error('--from and --to must be valid ascending batch numbers.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error('--concurrency must be between 1 and 12.');
  }
  return { help: false, from, to, concurrency, resume };
}

function batchLabel(batchNumber) {
  return `${String(batchNumber).padStart(4, '0')}-of-0027.txt`;
}

function stageName(batchNumber, retryNumber) {
  return `batch-${String(batchNumber).padStart(4, '0')}-${String(retryNumber).padStart(4, '0')}`;
}

function extensionFor(contentType) {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}

function profileUrl(bbrefId) {
  const id = String(bbrefId ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{7,}$/i.test(id)) return '';
  return `https://${BREF_HOST}/players/${id[0]}/${id}.shtml`;
}

function headshotUrls(html) {
  const matches = html.matchAll(/https:\/\/www\.baseball-reference\.com\/req\/[^"'\s<>]+\/images\/headshots\/[^"'\s<>]+?\.jpg/gi);
  return [...new Set([...matches].map((match) => match[0]))];
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      if (response.ok) return response;
      const body = Buffer.from(await response.arrayBuffer());
      throw new Error(`HTTP ${response.status}; ${(response.headers.get('content-type') ?? '').toLowerCase()}; ${body.length} bytes`);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

async function buildMlbamToBbrefMap(mlbamIds) {
  const files = (await fs.readdir(CHADWICK_DATA))
    .filter((name) => /^people-[0-9a-f]\.csv$/i.test(name))
    .sort();
  if (files.length !== 16) throw new Error(`Expected 16 Chadwick player shards, found ${files.length}.`);
  const result = new Map();
  for (const file of files) {
    const lines = (await fs.readFile(path.join(CHADWICK_DATA, file), 'utf8')).split(/\r?\n/);
    for (let index = 1; index < lines.length; index += 1) {
      const columns = lines[index].split(',');
      if (mlbamIds.has(columns[2])) result.set(columns[2], columns[4]);
    }
  }
  return result;
}

function mlbamIdFromUrl(url) {
  return /\/people\/(\d+)\//.exec(String(url ?? ''))?.[1] ?? '';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const masterRows = (await fs.readFile(path.join(MANIFEST_ROOT, 'manifest.jsonl'), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const masterByRemoteUrl = new Map(masterRows.map((row) => [row.remote_url, row]));
  const batches = [];
  const candidates = [];

  for (let batchNumber = options.from; batchNumber <= options.to; batchNumber += 1) {
    const primaryDirectory = path.join(STAGING_ROOT, stageName(batchNumber, 1));
    const primaryManifest = JSON.parse(await fs.readFile(path.join(primaryDirectory, 'manifest.json'), 'utf8'));
    const failures = primaryManifest.outcomes.filter((row) => row.status === 'failed');
    if (!failures.length) continue;
    const retryDirectory = path.join(STAGING_ROOT, stageName(batchNumber, 2));
    const retryManifestPath = path.join(retryDirectory, 'manifest.json');
    try {
      await fs.access(retryManifestPath);
      throw new Error(`Refusing to overwrite completed retry manifest: ${retryManifestPath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!options.resume) {
      try {
        await fs.access(retryDirectory);
        throw new Error(`Refusing to reuse retry directory without --resume: ${retryDirectory}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(retryDirectory, { recursive: true });
    const outcomes = new Array(failures.length);
    batches.push({ batchNumber, batch: batchLabel(batchNumber), retryDirectory, failures, outcomes });
    failures.forEach((failure, index) => candidates.push({ batchNumber, failure, index, outcomes }));
  }

  const mlbamIds = new Set(candidates.map((candidate) => mlbamIdFromUrl(candidate.failure.remote_url)).filter(Boolean));
  const bbrefByMlbam = await buildMlbamToBbrefMap(mlbamIds);
  let next = 0;

  async function stageOne(candidate) {
    const source = masterByRemoteUrl.get(candidate.failure.remote_url);
    const mlbamId = mlbamIdFromUrl(candidate.failure.remote_url);
    const bbrefId = bbrefByMlbam.get(mlbamId) ?? '';
    const batch = batches.find((item) => item.batchNumber === candidate.batchNumber);
    const base = {
      index: candidate.failure.index,
      player_id: source?.player_id ?? candidate.failure.player_id ?? null,
      player_name: source?.player_name ?? candidate.failure.player_name ?? null,
      original_remote_url: candidate.failure.remote_url,
      original_error: candidate.failure.error ?? null,
      mlbam_id: mlbamId || null,
      bbref_id: bbrefId || null,
      source_name: 'baseball_reference_profile_fallback',
    };
    try {
      const pageUrl = profileUrl(bbrefId);
      if (!pageUrl) throw new Error('No valid Baseball-Reference player ID found in Chadwick register.');
      const page = await fetchWithRetry(pageUrl);
      const urls = headshotUrls(await page.text());
      if (!urls.length) throw new Error('No Baseball-Reference headshot URL found on player profile.');
      let lastError;
      for (const imageUrl of urls) {
        try {
          const image = await fetchWithRetry(imageUrl);
          const contentType = (image.headers.get('content-type') ?? '').toLowerCase();
          const body = Buffer.from(await image.arrayBuffer());
          if (!contentType.startsWith('image/')) throw new Error(`Unexpected content type ${contentType || '(empty)'}`);
          if (body.length < 512) throw new Error(`Image too small: ${body.length} bytes`);
          const filename = `mlb-bref-${bbrefId}-${crypto.createHash('sha256').update(imageUrl).digest('hex').slice(0, 12)}.${extensionFor(contentType)}`;
          try {
            await fs.writeFile(path.join(batch.retryDirectory, filename), body, { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existing = await fs.stat(path.join(batch.retryDirectory, filename));
            if (existing.size < 512) throw new Error(`Existing fallback image is too small: ${existing.size} bytes`);
          }
          candidate.outcomes[candidate.index] = {
            ...base,
            profile_url: pageUrl,
            fallback_remote_url: imageUrl,
            file: filename,
            status: 'staged',
            bytes: body.length,
            content_type: contentType,
          };
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error('No candidate headshot could be downloaded.');
    } catch (error) {
      candidate.outcomes[candidate.index] = { ...base, status: 'failed', error: String(error.message ?? error) };
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= candidates.length) return;
      await stageOne(candidates[index]);
      if ((index + 1) % 50 === 0 || index + 1 === candidates.length) {
        process.stdout.write(`staged ${index + 1}/${candidates.length}\n`);
      }
    }
  }));

  const summary = [];
  for (const batch of batches) {
    const counts = batch.outcomes.reduce((result, row) => {
      result[row.status] = (result[row.status] ?? 0) + 1;
      return result;
    }, {});
    const manifest = {
      sport: 'mlb',
      batch: batch.batch,
      retry_for: stageName(batch.batchNumber, 1),
      staged_at: new Date().toISOString(),
      source_count: batch.outcomes.length,
      outcomes: batch.outcomes,
    };
    await fs.writeFile(path.join(batch.retryDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    summary.push({ batch: batch.batch, retry_directory: batch.retryDirectory, ...counts });
  }
  process.stdout.write(`${JSON.stringify({ fallback_candidates: candidates.length, batches: summary }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
