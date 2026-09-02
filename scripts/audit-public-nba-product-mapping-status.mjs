import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseApiHeaders } from './build-nba-product-player-mappings.mjs';

const ROOT = process.cwd();

function workspacePath(relativePath, label) {
  const resolved = path.resolve(ROOT, String(relativePath || ''));
  const root = path.resolve(ROOT);
  const prefix = `${root}${path.sep}`.toLowerCase();
  if (resolved.toLowerCase() !== root.toLowerCase()
    && !resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  return resolved;
}

function configValue(configText, name) {
  return configText.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1] || '';
}

export function optionsFromArgs(argv = []) {
  const options = {
    coveragePath: 'outputs/nba-product-mapping-coverage.json',
    reportPath: 'outputs/nba-product-mapping-live-status.json',
    all: false,
    concurrency: 6,
  };
  for (const argument of argv) {
    if (argument === '--all') options.all = true;
    else if (argument.startsWith('--coverage=')) options.coveragePath = argument.slice('--coverage='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else if (argument.startsWith('--concurrency=')) {
      const value = Number(argument.slice('--concurrency='.length));
      if (!Number.isSafeInteger(value) || value < 1 || value > 12) {
        throw new Error('--concurrency must be an integer from 1 through 12.');
      }
      options.concurrency = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

export function selectCoverageProducts(coverage, includeAll = false) {
  const queue = Array.isArray(coverage?.queue) ? coverage.queue : [];
  const selected = includeAll
    ? queue
    : queue.filter((item) => item?.disposition === 'source_consistent_exact_candidate');
  return selected
    .filter((item) => Number.isSafeInteger(Number(item?.productId)) && Number(item.productId) > 0)
    .map((item) => ({
      productId: Number(item.productId),
      productName: String(item?.current?.productName || '').trim(),
      sourcePlayerText: String(item?.current?.playerAthlete || '').trim(),
      team: String(item?.current?.team || '').trim(),
      priorDisposition: String(item?.disposition || ''),
    }))
    .sort((left, right) => left.productId - right.productId);
}

/**
 * Keep only public mapping identity from the fixed-shape RPC response. Season
 * stats and private evidence are deliberately excluded from the audit file.
 */
export function extractPublicMappingStatus(product, payload, httpStatus = 200) {
  const publicProductId = Number(payload?.productId) || null;
  const requestedProductId = Number(product?.productId);
  const players = Array.isArray(payload?.players) ? payload.players : [];
  const mappings = players.map((entry) => ({
    subjectOrder: Number(entry?.mapping?.subjectOrder),
    athleteId: String(entry?.player?.athleteId || '').trim(),
    nbaPlayerId: String(entry?.player?.nbaPlayerId || '').trim(),
    name: String(entry?.player?.name || '').trim(),
    reviewState: String(entry?.mapping?.reviewState || '').trim(),
  }));
  const validMappings = mappings.filter((mapping) => (
    Number.isSafeInteger(mapping.subjectOrder)
      && mapping.subjectOrder > 0
      && mapping.athleteId
      && mapping.reviewState
  ));
  const hasContiguousSubjectOrder = validMappings.length > 0
    && new Set(validMappings.map((mapping) => mapping.subjectOrder)).size === validMappings.length
    && validMappings.every((mapping, index) => mapping.subjectOrder === index + 1);
  const hasPublishedReviewStates = validMappings.every((mapping) => (
    mapping.reviewState === 'auto_verified' || mapping.reviewState === 'human_verified'
  ));
  if (payload && publicProductId !== requestedProductId) {
    return {
      ...product,
      httpStatus,
      status: 'invalid_payload',
      error: 'RPC productId did not match the requested product.',
      publicProductId,
      mappings: [],
    };
  }
  if (players.length && (!validMappings.length || !hasContiguousSubjectOrder || !hasPublishedReviewStates)) {
    return {
      ...product,
      httpStatus,
      status: 'invalid_payload',
      error: 'RPC returned malformed or non-published mapping identity.',
      publicProductId,
      mappings: [],
    };
  }
  return {
    ...product,
    httpStatus,
    status: validMappings.length ? 'mapped' : 'empty',
    publicProductId,
    mappings: validMappings.sort((left, right) => left.subjectOrder - right.subjectOrder),
  };
}

async function fetchPublicMapping(projectUrl, publishableKey, product) {
  const response = await fetch(`${projectUrl}/rest/v1/rpc/get_nba_product_slab_stats`, {
    method: 'POST',
    headers: {
      ...supabaseApiHeaders(publishableKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_product_id: product.productId }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    return {
      ...product,
      httpStatus: response.status,
      status: 'error',
      error: responseText.slice(0, 500),
      publicProductId: null,
      mappings: [],
    };
  }
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    return {
      ...product,
      httpStatus: response.status,
      status: 'invalid_payload',
      error: 'RPC returned non-JSON content.',
      publicProductId: null,
      mappings: [],
    };
  }
  return extractPublicMappingStatus(product, payload, response.status);
}

async function mapWithConcurrency(products, worker, concurrency) {
  const results = [];
  let nextIndex = 0;
  async function run() {
    while (nextIndex < products.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(products[index]);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(products.length, 1)) },
    () => run()
  ));
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const coveragePath = workspacePath(options.coveragePath, 'Coverage path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const [configText, coverage] = await Promise.all([
    fs.readFile(path.join(ROOT, 'backend-config.js'), 'utf8'),
    fs.readFile(coveragePath, 'utf8').then(JSON.parse),
  ]);
  const projectUrl = configValue(configText, 'supabaseUrl').replace(/\/+$/, '');
  const publishableKey = configValue(configText, 'supabasePublishableKey');
  if (!projectUrl || !publishableKey) {
    throw new Error('backend-config.js must contain the browser-safe Supabase URL and publishable key.');
  }

  const products = selectCoverageProducts(coverage, options.all);
  const statuses = await mapWithConcurrency(
    products,
    (product) => fetchPublicMapping(projectUrl, publishableKey, product),
    options.concurrency
  );
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'public_read_only',
    rpc: 'get_nba_product_slab_stats',
    coveragePath: path.relative(ROOT, coveragePath).replace(/\\/g, '/'),
    selection: options.all ? 'all_coverage_queue' : 'exact_expansion_candidates',
    requestedProductCount: products.length,
    mappedProductCount: statuses.filter((item) => item.status === 'mapped').length,
    emptyProductCount: statuses.filter((item) => item.status === 'empty').length,
    errorProductCount: statuses.filter((item) => !['mapped', 'empty'].includes(item.status)).length,
    statuses,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    requestedProductCount: report.requestedProductCount,
    mappedProductCount: report.mappedProductCount,
    emptyProductCount: report.emptyProductCount,
    errorProductCount: report.errorProductCount,
    reportPath: path.relative(ROOT, reportPath).replace(/\\/g, '/'),
  }, null, 2));
  return report;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
