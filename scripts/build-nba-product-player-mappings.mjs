import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNbaProductPlayerMappingPlan,
} from './lib/nba-product-player-mapping.mjs';

const ROOT = process.cwd();
const APPLY_CONFIRMATION = 'insert-only-reviewed-nba-mappings';

export function optionsFromArgs(argv = []) {
  const options = {
    apply: false,
    catalogPath: 'products.json',
    reportPath: '',
    confirmation: '',
  };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument.startsWith('--catalog=')) options.catalogPath = argument.slice('--catalog='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else if (argument.startsWith('--confirm=')) options.confirmation = argument.slice('--confirm='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function workspacePath(relativePath, label) {
  const resolved = path.resolve(ROOT, String(relativePath || ''));
  const rootPrefix = `${path.resolve(ROOT)}${path.sep}`.toLowerCase();
  if (resolved.toLowerCase() !== path.resolve(ROOT).toLowerCase()
    && !resolved.toLowerCase().startsWith(rootPrefix)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  return resolved;
}

function configValue(configText, name) {
  return configText.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1] || '';
}

async function requestJson(url, apiKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${new URL(url).pathname} failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : null;
}

async function fetchAllRows(projectUrl, apiKey, table, select, filters = {}) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({
      select,
      limit: '1000',
      offset: String(offset),
      ...filters,
    });
    const page = await requestJson(`${projectUrl}/rest/v1/${table}?${query}`, apiKey);
    if (!Array.isArray(page)) throw new Error(`${table} did not return a row array.`);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function reasonCounts(unresolved = []) {
  return unresolved.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
}

function groupMappingsByProduct(mappings) {
  const groups = new Map();
  for (const mapping of mappings) {
    const group = groups.get(mapping.product_id) || [];
    group.push(mapping);
    groups.set(mapping.product_id, group);
  }
  return [...groups.values()].map((group) => (
    group.sort((left, right) => left.subject_order - right.subject_order)
  ));
}

function productSafeBatches(mappingGroups, maximumRows = 250) {
  const batches = [];
  let batch = [];
  for (const group of mappingGroups) {
    if (group.length > maximumRows) {
      throw new Error(`Product ${group[0]?.product_id} exceeds the safe mapping batch size.`);
    }
    if (batch.length && batch.length + group.length > maximumRows) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function insertMappingBatches(projectUrl, apiKey, batches) {
  for (const rows of batches) {
    await requestJson(`${projectUrl}/rest/v1/product_athlete_mappings`, apiKey, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
  }
}

function mappingKey(mapping) {
  return `${Number(mapping.product_id)}:${String(mapping.athlete_id)}:${String(mapping.league_code)}`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const configText = await fs.readFile(path.join(ROOT, 'backend-config.js'), 'utf8');
  const catalog = JSON.parse(await fs.readFile(workspacePath(options.catalogPath, 'Catalog path'), 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('The catalog must be a JSON array.');

  const projectUrl = String(
    process.env.SUPABASE_URL || configValue(configText, 'supabaseUrl')
  ).trim().replace(/\/+$/, '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!projectUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL/backend-config.js and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  const [aliasRows, athleteRows, existingRows, remoteProductRows] = await Promise.all([
    fetchAllRows(projectUrl, serviceRoleKey, 'athlete_aliases',
      'athlete_id,league_code,alias,normalized_alias,alias_type,review_state', {
        league_code: 'eq.NBA',
        review_state: 'eq.verified',
        order: 'normalized_alias.asc',
      }),
    fetchAllRows(projectUrl, serviceRoleKey, 'athletes', 'id,identity_status', {
      order: 'id.asc',
    }),
    fetchAllRows(projectUrl, serviceRoleKey, 'product_athlete_mappings',
      'product_id,athlete_id,league_code,review_state,subject_order', {
        league_code: 'eq.NBA',
        order: 'product_id.asc,subject_order.asc',
      }),
    fetchAllRows(projectUrl, serviceRoleKey, 'products', 'id', {
      category: 'eq.Basketball',
      league: 'eq.NBA',
      order: 'id.asc',
    }),
  ]);

  const identityStatusById = new Map(
    athleteRows.map((athlete) => [String(athlete.id), String(athlete.identity_status || '')])
  );
  const aliases = aliasRows.map((alias) => ({
    ...alias,
    identity_status: identityStatusById.get(String(alias.athlete_id)) || 'disputed',
  }));
  const plan = buildNbaProductPlayerMappingPlan({ products: catalog, aliases });
  const remoteProductIds = new Set(remoteProductRows.map((row) => Number(row.id)));
  const existingProductIds = new Set(existingRows.map((row) => Number(row.product_id)));
  const missingRemoteProductIds = [...new Set(plan.mappings
    .map((mapping) => mapping.product_id)
    .filter((productId) => !remoteProductIds.has(productId)))]
    .sort((left, right) => left - right);
  const insertableMappings = plan.mappings.filter((mapping) => (
    remoteProductIds.has(mapping.product_id)
    && !existingProductIds.has(mapping.product_id)
  ));
  const blockedByExistingProductIds = [...new Set(plan.mappings
    .map((mapping) => mapping.product_id)
    .filter((productId) => existingProductIds.has(productId)))]
    .sort((left, right) => left - right);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? 'apply' : 'audit',
    policy: 'exact-verified-aliases-all-subjects-or-none',
    catalogPath: path.relative(ROOT, workspacePath(options.catalogPath, 'Catalog path')).replace(/\\/g, '/'),
    ...plan.summary,
    unresolvedByReason: reasonCounts(plan.unresolved),
    existingMappingRows: existingRows.length,
    blockedByExistingProductCount: blockedByExistingProductIds.length,
    blockedByExistingProductIds,
    missingRemoteProductCount: missingRemoteProductIds.length,
    missingRemoteProductIds,
    insertableProductCount: new Set(insertableMappings.map((mapping) => mapping.product_id)).size,
    insertableMappingRows: insertableMappings.length,
    appliedMappingRows: 0,
  };

  if (options.reportPath) {
    const reportPath = workspacePath(options.reportPath, 'Report path');
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify({ ...report, unresolved: plan.unresolved }, null, 2)}\n`, 'utf8');
  }

  if (options.apply) {
    if (options.confirmation !== APPLY_CONFIRMATION
      || process.env.NBA_PRODUCT_MAPPING_ALLOW_WRITE !== 'confirmed') {
      throw new Error(
        `Apply requires --confirm=${APPLY_CONFIRMATION} and NBA_PRODUCT_MAPPING_ALLOW_WRITE=confirmed.`
      );
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(ROOT, 'outputs', `nba-product-athlete-mappings-backup-${timestamp}.json`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, `${JSON.stringify(existingRows, null, 2)}\n`, 'utf8');

    const batches = productSafeBatches(groupMappingsByProduct(insertableMappings));
    await insertMappingBatches(projectUrl, serviceRoleKey, batches);
    const verifiedRows = await fetchAllRows(projectUrl, serviceRoleKey, 'product_athlete_mappings',
      'product_id,athlete_id,league_code,review_state,subject_order', {
        league_code: 'eq.NBA',
        order: 'product_id.asc,subject_order.asc',
      });
    const verifiedKeys = new Set(verifiedRows.map(mappingKey));
    const missingApplied = insertableMappings.filter((mapping) => !verifiedKeys.has(mappingKey(mapping)));
    if (missingApplied.length) {
      throw new Error(`${missingApplied.length} proposed mapping rows were not present after apply.`);
    }
    report.appliedMappingRows = insertableMappings.length;
    report.backupPath = path.relative(ROOT, backupPath).replace(/\\/g, '/');
  }

  console.log(JSON.stringify(report, null, 2));
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
