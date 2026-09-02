import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNbaProductPlayerMappingPlan,
} from './lib/nba-product-player-mapping.mjs';

const ROOT = process.cwd();
const APPLY_CONFIRMATION = 'insert-only-reviewed-nba-mappings';
const PUBLISHED_REVIEW_STATES = new Set(['auto_verified', 'human_verified']);

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

export function supabaseApiHeaders(apiKey) {
  const headers = { apikey: apiKey };
  // New Supabase secret/publishable keys are opaque values, not JWTs. Sending
  // them as a Bearer token makes the API gateway reject an otherwise valid key.
  if (!/^sb_(?:secret|publishable)_/.test(apiKey)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function requestJson(url, apiKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...supabaseApiHeaders(apiKey),
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

function mappingIdentityKey(mapping) {
  return [
    Number(mapping.product_id),
    String(mapping.athlete_id || ''),
    String(mapping.league_code || '').toUpperCase(),
    Number(mapping.subject_order),
  ].join(':');
}

function groupMappingRowsByProduct(rows = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const productId = Number(row?.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) continue;
    const group = groups.get(productId) || [];
    group.push(row);
    groups.set(productId, group);
  }
  return groups;
}

function comparableMappingRows(rows = []) {
  return rows
    .map((row) => ({
      product_id: Number(row.product_id),
      athlete_id: String(row.athlete_id || ''),
      league_code: String(row.league_code || '').toUpperCase(),
      subject_order: Number(row.subject_order),
      review_state: String(row.review_state || ''),
    }))
    .sort((left, right) => (
      left.subject_order - right.subject_order
      || left.athlete_id.localeCompare(right.athlete_id)
    ));
}

function isRemoteNbaProduct(row) {
  return String(row?.category || '').trim().toLowerCase() === 'basketball'
    && String(row?.league || '').trim().toUpperCase() === 'NBA';
}

/**
 * Compare a fresh deterministic plan with the current remote rows without
 * mutating either side. Existing products remain write-protected, but exact,
 * partial, and conflicting states are reported separately for review.
 */
export function reconcilePlannedMappingsWithExisting(proposedMappings = [], existingRows = []) {
  const proposedByProduct = groupMappingRowsByProduct(proposedMappings);
  const existingByProduct = groupMappingRowsByProduct(existingRows);
  const insertableMappings = [];
  const exactExistingProductIds = [];
  const conflictingExisting = [];

  for (const [productId, proposedRows] of [...proposedByProduct.entries()]
    .sort(([left], [right]) => left - right)) {
    const currentRows = existingByProduct.get(productId) || [];
    if (!currentRows.length) {
      insertableMappings.push(...proposedRows);
      continue;
    }

    const proposedKeys = new Set(proposedRows.map(mappingIdentityKey));
    // Rejected rows are historical review evidence, not published mappings.
    // Ignore them when checking an active mapping set, but keep them in the
    // report so a reviewer can see why the product remains write-protected.
    const activeRows = currentRows.filter((row) => (
      String(row?.review_state || '').toLowerCase() !== 'rejected'
    ));
    const unpublishedRows = activeRows.filter((row) => (
      !PUBLISHED_REVIEW_STATES.has(String(row?.review_state || '').toLowerCase())
    ));
    const existingKeys = new Set(activeRows.map(mappingIdentityKey));
    const missingFromExisting = [...proposedKeys].filter((key) => !existingKeys.has(key));
    const unexpectedExisting = [...existingKeys].filter((key) => !proposedKeys.has(key));
    const duplicateExistingRows = activeRows.length - existingKeys.size;
    if (!missingFromExisting.length && !unexpectedExisting.length && !duplicateExistingRows
      && activeRows.length && !unpublishedRows.length) {
      exactExistingProductIds.push(productId);
      continue;
    }

    const allHistoricalRejected = currentRows.length > 0 && activeRows.length === 0
      && currentRows.every((row) => String(row?.review_state || '').toLowerCase() === 'rejected');
    const keysMatch = !missingFromExisting.length && !unexpectedExisting.length && !duplicateExistingRows;
    conflictingExisting.push({
      productId,
      classification: allHistoricalRejected
        ? 'rejected_existing_mapping'
        : (keysMatch && unpublishedRows.length
          ? 'needs_review_existing_mapping'
          : (duplicateExistingRows
            ? 'duplicate_existing_mapping'
            : (!unexpectedExisting.length && missingFromExisting.length
              ? 'partial_existing_mapping'
              : 'conflicting_existing_mapping'))),
      missingPlannedRowCount: missingFromExisting.length,
      unexpectedExistingRowCount: unexpectedExisting.length,
      duplicateExistingRowCount: duplicateExistingRows,
      unpublishedExistingRowCount: unpublishedRows.length,
      proposed: comparableMappingRows(proposedRows),
      existing: comparableMappingRows(currentRows),
    });
  }

  const existingWithoutPlan = [...existingByProduct.entries()]
    .filter(([productId]) => !proposedByProduct.has(productId))
    .sort(([left], [right]) => left - right)
    .map(([productId, rows]) => ({
      productId,
      existing: comparableMappingRows(rows),
    }));

  return {
    insertableMappings,
    exactExistingProductIds,
    conflictingExisting,
    existingWithoutPlan,
  };
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

  // Keep the elevated Data API reads serial so the audit and the guarded write
  // use one deterministic, freshly checked remote state.
  const aliasRows = await fetchAllRows(projectUrl, serviceRoleKey, 'athlete_aliases',
    'athlete_id,league_code,alias,normalized_alias,alias_type,review_state', {
      league_code: 'eq.NBA',
      review_state: 'eq.verified',
      order: 'normalized_alias.asc',
    });
  const athleteRows = await fetchAllRows(projectUrl, serviceRoleKey, 'athletes', 'id,identity_status', {
    order: 'id.asc',
  });
  const membershipRows = await fetchAllRows(projectUrl, serviceRoleKey, 'athlete_league_memberships',
    'athlete_id,league_code,membership_status', {
      league_code: 'eq.NBA',
      order: 'athlete_id.asc',
    });
  const existingRows = await fetchAllRows(projectUrl, serviceRoleKey, 'product_athlete_mappings',
    'product_id,athlete_id,league_code,review_state,subject_order', {
      league_code: 'eq.NBA',
      order: 'product_id.asc,subject_order.asc',
    });
  // Read the full remote identity scope so a category/league casing change is
  // reported as scope drift instead of being mislabeled as a missing product.
  const remoteProductRows = await fetchAllRows(projectUrl, serviceRoleKey, 'products',
    'id,category,league,is_deleted,sale_status', { order: 'id.asc' });

  const identityStatusById = new Map(
    athleteRows.map((athlete) => [String(athlete.id), String(athlete.identity_status || '')])
  );
  const membershipStatusByAthleteId = new Map(
    membershipRows.map((membership) => [
      String(membership.athlete_id),
      String(membership.membership_status || ''),
    ])
  );
  const aliases = aliasRows.map((alias) => ({
    ...alias,
    identity_status: identityStatusById.get(String(alias.athlete_id)) || 'disputed',
    // A verified alias without a currently verified NBA membership is not
    // enough evidence to create an NBA catalog mapping.
    membership_status: membershipStatusByAthleteId.get(String(alias.athlete_id)) || 'inactive',
  }));
  const plan = buildNbaProductPlayerMappingPlan({ products: catalog, aliases });
  const remoteProductIds = new Set(remoteProductRows.map((row) => Number(row.id)));
  const remoteEligibleProductIds = new Set(
    remoteProductRows.filter(isRemoteNbaProduct).map((row) => Number(row.id))
  );
  const missingRemoteProductIds = [...new Set(plan.mappings
    .map((mapping) => mapping.product_id)
    .filter((productId) => !remoteProductIds.has(productId)))]
    .sort((left, right) => left - right);
  const remoteScopeDriftProductIds = [...new Set(plan.mappings
    .map((mapping) => mapping.product_id)
    .filter((productId) => remoteProductIds.has(productId) && !remoteEligibleProductIds.has(productId)))]
    .sort((left, right) => left - right);
  const remoteEligibleMappings = plan.mappings.filter((mapping) => remoteEligibleProductIds.has(mapping.product_id));
  const reconciliation = reconcilePlannedMappingsWithExisting(remoteEligibleMappings, existingRows);
  const insertableMappings = reconciliation.insertableMappings;
  const existingWithoutCurrentPlan = reconciliation.existingWithoutPlan
    .filter((entry) => remoteEligibleProductIds.has(entry.productId));
  const scopeDriftExistingMappings = reconciliation.existingWithoutPlan
    .filter((entry) => remoteProductIds.has(entry.productId) && !remoteEligibleProductIds.has(entry.productId));
  const staleExistingMappings = reconciliation.existingWithoutPlan
    .filter((entry) => !remoteProductIds.has(entry.productId));
  const blockedByExistingProductIds = [
    ...reconciliation.exactExistingProductIds,
    ...reconciliation.conflictingExisting.map((entry) => entry.productId),
  ].sort((left, right) => left - right);

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
    exactExistingProductCount: reconciliation.exactExistingProductIds.length,
    exactExistingProductIds: reconciliation.exactExistingProductIds,
    conflictingExistingProductCount: reconciliation.conflictingExisting.length,
    conflictingExisting: reconciliation.conflictingExisting,
    existingWithoutCurrentPlanProductCount: existingWithoutCurrentPlan.length,
    existingWithoutCurrentPlan,
    staleExistingMappingProductCount: staleExistingMappings.length,
    staleExistingMappings,
    remoteScopeDriftProductCount: remoteScopeDriftProductIds.length,
    remoteScopeDriftProductIds,
    scopeDriftExistingMappingProductCount: scopeDriftExistingMappings.length,
    scopeDriftExistingMappings,
    missingRemoteProductCount: missingRemoteProductIds.length,
    missingRemoteProductIds,
    insertableProductCount: new Set(insertableMappings.map((mapping) => mapping.product_id)).size,
    insertableMappingRows: insertableMappings.length,
    appliedMappingRows: 0,
  };
  const reportPath = options.reportPath
    ? workspacePath(options.reportPath, 'Report path')
    : '';
  const writeReport = async () => {
    if (!reportPath) return;
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify({
      ...report,
      insertableMappings,
      unresolved: plan.unresolved,
    }, null, 2)}\n`, 'utf8');
  };

  // Preserve an audit artifact even if a later guarded apply fails, then
  // rewrite it after a successful apply with appliedMappingRows/backupPath.
  await writeReport();

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
    const verifiedKeys = new Set(verifiedRows
      .filter((row) => String(row.review_state || '') === 'auto_verified')
      .map(mappingIdentityKey));
    const missingApplied = insertableMappings.filter((mapping) => (
      !verifiedKeys.has(mappingIdentityKey(mapping))
    ));
    if (missingApplied.length) {
      throw new Error(`${missingApplied.length} proposed mapping rows were not present after apply.`);
    }
    report.appliedMappingRows = insertableMappings.length;
    report.backupPath = path.relative(ROOT, backupPath).replace(/\\/g, '/');
    await writeReport();
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
