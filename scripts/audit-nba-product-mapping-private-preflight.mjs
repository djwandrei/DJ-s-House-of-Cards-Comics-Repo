import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseApiHeaders } from './build-nba-product-player-mappings.mjs';
import { normalizeCatalogPlayerName } from './lib/nba-product-player-mapping.mjs';

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
    proposalPath: 'outputs/nba-product-mapping-review-proposal.json',
    reportPath: 'outputs/nba-product-mapping-private-preflight.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--proposal=')) options.proposalPath = argument.slice('--proposal='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function idsFilter(values) {
  return `in.(${[...new Set(values.map(String).filter(Boolean))].join(',')})`;
}

async function requestRows(projectUrl, apiKey, table, select, filters = {}) {
  const query = new URLSearchParams({ select, ...filters });
  const response = await fetch(`${projectUrl}/rest/v1/${table}?${query}`, {
    headers: supabaseApiHeaders(apiKey),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${table} private preflight failed: ${response.status} ${responseText.slice(0, 500)}`);
  }
  const rows = responseText ? JSON.parse(responseText) : [];
  if (!Array.isArray(rows)) throw new Error(`${table} did not return a row array.`);
  return rows;
}

async function requestAllRows(projectUrl, apiKey, table, select, filters = {}, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await requestRows(projectUrl, apiKey, table, select, {
      ...filters,
      limit: String(pageSize),
      offset: String(offset),
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function groupBy(rows, field) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.[field] ?? '');
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

export function evaluateNbaMappingPrivatePreflight(proposal = {}, remote = {}) {
  if (proposal?.mode !== 'proposal_only') {
    throw new Error('Input is not a mapping review proposal.');
  }
  const productsById = new Map((remote.products || []).map((row) => [Number(row.id), row]));
  const athletesById = new Map((remote.athletes || []).map((row) => [String(row.id), row]));
  const membershipsByAthlete = new Map((remote.memberships || []).map((row) => [String(row.athlete_id), row]));
  const aliasesByName = groupBy(remote.aliases, 'normalized_alias');
  const mappingsByProduct = groupBy(remote.mappings, 'product_id');
  const results = [];

  for (const candidate of Array.isArray(proposal?.highConfidenceProducts)
    ? proposal.highConfidenceProducts : []) {
    const productId = Number(candidate.productId);
    const remoteProduct = productsById.get(productId);
    const expectedPlayer = String(candidate?.currentValues?.playerAthlete || '').trim();
    const expectedTeam = String(candidate?.currentValues?.team || '').trim();
    const productEligible = Boolean(remoteProduct)
      && String(remoteProduct.category || '').trim().toLowerCase() === 'basketball'
      && String(remoteProduct.league || '').trim().toUpperCase() === 'NBA'
      && remoteProduct.is_deleted !== true
      && !['hidden', 'archived', 'sold'].includes(String(remoteProduct.sale_status || '').toLowerCase());
    const catalogValuesMatch = Boolean(remoteProduct)
      && String(remoteProduct.player_athlete || '').trim() === expectedPlayer
      && String(remoteProduct.team || '').trim() === expectedTeam;
    const existingMappings = mappingsByProduct.get(String(productId)) || [];
    const subjectChecks = (candidate.proposedSubjects || []).map((subject) => {
      const athleteId = String(subject.proposedAthleteId || '');
      const athlete = athletesById.get(athleteId);
      const membership = membershipsByAthlete.get(athleteId);
      const normalizedAlias = normalizeCatalogPlayerName(subject.sourcePlayerText);
      const aliasRows = aliasesByName.get(normalizedAlias) || [];
      const matchingAliases = aliasRows.filter((row) => String(row.athlete_id || '') === athleteId);
      const conflictingAliases = aliasRows.filter((row) => String(row.athlete_id || '') !== athleteId);
      const verifiedAlias = matchingAliases.some((row) => String(row.review_state || '') === 'verified');
      return {
        subjectOrder: Number(subject.subjectOrder),
        sourcePlayerText: String(subject.sourcePlayerText || ''),
        athleteId,
        athleteActive: String(athlete?.identity_status || '') === 'active',
        nbaMembershipVerified: String(membership?.membership_status || '') === 'verified'
          && String(membership?.league_code || '').toUpperCase() === 'NBA',
        normalizedAlias,
        verifiedAlias,
        matchingAliasReviewStates: matchingAliases.map((row) => String(row.review_state || '')).sort(),
        conflictingAliasAthleteIds: [...new Set(conflictingAliases.map((row) => String(row.athlete_id || '')))].sort(),
      };
    });
    const identityChecksPass = subjectChecks.every((subject) => (
      subject.athleteActive
        && subject.nbaMembershipVerified
        && subject.conflictingAliasAthleteIds.length === 0
    ));
    const allAliasesVerified = subjectChecks.every((subject) => subject.verifiedAlias);
    let disposition = 'blocked';
    if (productEligible && catalogValuesMatch && !existingMappings.length && identityChecksPass) {
      disposition = allAliasesVerified ? 'ready_for_mapping_review' : 'ready_for_alias_review';
    }
    results.push({
      productId,
      productName: String(candidate.productName || ''),
      disposition,
      currentValues: candidate.currentValues,
      checks: {
        productExists: Boolean(remoteProduct),
        productEligible,
        catalogValuesMatch,
        existingMappingRowCount: existingMappings.length,
        identityChecksPass,
        allAliasesVerified,
      },
      subjects: subjectChecks,
    });
  }
  const dispositionCounts = results.reduce((counts, result) => {
    counts[result.disposition] = (counts[result.disposition] || 0) + 1;
    return counts;
  }, {});
  return { dispositionCounts, results };
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const proposalPath = workspacePath(options.proposalPath, 'Proposal path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const [configText, proposal] = await Promise.all([
    fs.readFile(path.join(ROOT, 'backend-config.js'), 'utf8'),
    fs.readFile(proposalPath, 'utf8').then(JSON.parse),
  ]);
  const projectUrl = String(process.env.SUPABASE_URL || configValue(configText, 'supabaseUrl'))
    .trim().replace(/\/+$/, '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!projectUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL/backend-config.js and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  const products = Array.isArray(proposal?.highConfidenceProducts)
    ? proposal.highConfidenceProducts : [];
  const productIds = products.map((product) => Number(product.productId));
  const athleteIds = products.flatMap((product) => (
    (product.proposedSubjects || []).map((subject) => String(subject.proposedAthleteId || ''))
  ));
  const [remoteProducts, athletes, memberships, aliases, mappings] = await Promise.all([
    requestRows(projectUrl, serviceRoleKey, 'products',
      'id,category,league,is_deleted,sale_status,player_athlete,team', { id: idsFilter(productIds) }),
    requestRows(projectUrl, serviceRoleKey, 'athletes', 'id,identity_status', { id: idsFilter(athleteIds) }),
    requestRows(projectUrl, serviceRoleKey, 'athlete_league_memberships',
      'athlete_id,league_code,membership_status', { athlete_id: idsFilter(athleteIds), league_code: 'eq.NBA' }),
    // Fetch the full NBA alias namespace so a proposed spelling cannot miss a
    // collision merely because a string filter omitted the conflicting row.
    requestAllRows(projectUrl, serviceRoleKey, 'athlete_aliases',
      'athlete_id,normalized_alias,review_state', {
        league_code: 'eq.NBA',
        order: 'normalized_alias.asc,athlete_id.asc',
      }),
    requestRows(projectUrl, serviceRoleKey, 'product_athlete_mappings',
      'product_id,athlete_id,review_state,subject_order', { product_id: idsFilter(productIds), league_code: 'eq.NBA' }),
  ]);
  const evaluation = evaluateNbaMappingPrivatePreflight(proposal, {
    products: remoteProducts,
    athletes,
    memberships,
    aliases,
    mappings,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'private_read_only_preflight',
    proposalPath: path.relative(ROOT, proposalPath).replace(/\\/g, '/'),
    ...evaluation,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    productCount: report.results.length,
    dispositionCounts: report.dispositionCounts,
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
