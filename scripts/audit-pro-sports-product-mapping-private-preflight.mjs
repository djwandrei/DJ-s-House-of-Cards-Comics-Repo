import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeProviderIdentityName } from './lib/pro-sports-product-mapping-coverage.mjs';
import {
  PRO_SPORTS_ANALYTICS_WORKDIR,
  proSportsAnalyticsTarget,
} from './lib/pro-sports-analytics-targets.mjs';

const ROOT = process.cwd();
const CLI_VERSION = '2.115.0';
const COMMERCE_WORKDIR = ROOT;
const LEAGUE_CATEGORIES = Object.freeze({ MLB: 'Baseball', NFL: 'Football' });
const SPORT_BY_LEAGUE_CODE = Object.freeze({ MLB: 'mlb', NFL: 'nfl' });

function workspacePath(relativePath, label) {
  const resolved = path.resolve(ROOT, String(relativePath || ''));
  const root = path.resolve(ROOT);
  const prefix = `${root}${path.sep}`.toLowerCase();
  if (resolved.toLowerCase() !== root.toLowerCase() && !resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  return resolved;
}

export function optionsFromArgs(argv = []) {
  const options = {
    proposalPath: 'outputs/pro-sports-product-mapping-review-proposal.json',
    reportPath: 'outputs/pro-sports-product-mapping-private-preflight.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--proposal=')) options.proposalPath = argument.slice('--proposal='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function requestedIdentities(proposal) {
  const identities = new Map();
  for (const product of proposal.highConfidenceProducts || []) {
    for (const subject of product.proposedSubjects || []) {
      const identity = {
        leagueCode: String(product.leagueCode || '').toUpperCase(),
        sourceName: String(product.sourceName || ''),
        externalId: String(subject.providerExternalId || ''),
        providerCanonicalName: String(subject.providerCanonicalName || ''),
        providerNormalizedName: normalizeProviderIdentityName(subject.providerCanonicalName || ''),
      };
      const key = `${identity.leagueCode}\u0000${identity.sourceName}\u0000${identity.externalId}`;
      const current = identities.get(key);
      if (current && current.providerCanonicalName !== identity.providerCanonicalName) {
        throw new Error(`Conflicting provider names for ${identity.leagueCode}/${identity.externalId}.`);
      }
      identities.set(key, identity);
    }
  }
  return [...identities.values()].sort((left, right) => left.leagueCode.localeCompare(right.leagueCode)
    || left.sourceName.localeCompare(right.sourceName) || left.externalId.localeCompare(right.externalId));
}

export function planPrivateAnalyticsReads(identities) {
  if (!identities.length) throw new Error('No provider identities were proposed.');
  const plansBySport = new Map();
  for (const identity of identities) {
    const sport = SPORT_BY_LEAGUE_CODE[identity.leagueCode];
    if (!sport) {
      throw new Error(`No private analytics target is configured for ${identity.leagueCode}.`);
    }
    const current = plansBySport.get(sport) || {
      target: proSportsAnalyticsTarget(sport),
      identities: [],
    };
    current.identities.push(identity);
    plansBySport.set(sport, current);
  }
  return [...plansBySport.values()].sort((left, right) => (
    left.target.leagueCode.localeCompare(right.target.leagueCode)
  ));
}

export function buildAnalyticsPreflightSql(identities) {
  if (!identities.length) throw new Error('No provider identities were proposed.');
  const values = identities.map((identity) => `(${[
    sqlLiteral(identity.leagueCode), sqlLiteral(identity.sourceName), sqlLiteral(identity.externalId),
    sqlLiteral(identity.providerCanonicalName),
    sqlLiteral(identity.providerNormalizedName || normalizeProviderIdentityName(identity.providerCanonicalName)),
  ].join(', ')})`).join(',\n');
  return `
with requested(league_code, source_name, external_id, provider_name, provider_normalized_name) as (
  values ${values}
), resolved as (
  select
    requested.*,
    external_ids.athlete_id,
    athletes.canonical_name,
    athletes.normalized_name,
    athletes.identity_status,
    memberships.membership_status,
    (select count(*)::int from public.athlete_aliases aliases
      where aliases.athlete_id = external_ids.athlete_id
        and aliases.league_code = requested.league_code
        and aliases.alias = requested.provider_name
        and aliases.normalized_alias = requested.provider_normalized_name
        and aliases.review_state = 'verified') as provider_verified_alias_count,
    (select count(*)::int from public.athlete_aliases aliases
      where aliases.athlete_id = external_ids.athlete_id
        and aliases.league_code = requested.league_code
        and aliases.alias = athletes.canonical_name
        and aliases.normalized_alias = athletes.normalized_name
        and aliases.review_state = 'verified') as canonical_verified_alias_count
  from requested
  left join public.athlete_external_ids external_ids
    on external_ids.league_code = requested.league_code
   and external_ids.source_name = requested.source_name
   and external_ids.external_id = requested.external_id
  left join public.athletes athletes on athletes.id = external_ids.athlete_id
  left join public.athlete_league_memberships memberships
    on memberships.athlete_id = external_ids.athlete_id
   and memberships.league_code = requested.league_code
)
select json_build_object(
  'identities', coalesce(json_agg(row_to_json(resolved) order by league_code, source_name, external_id), '[]'::json)
) as payload
from resolved;
`;
}

export function buildCommercePreflightSql(proposal, analyticsRows) {
  const products = [...(proposal.highConfidenceProducts || [])]
    .sort((left, right) => Number(left.productId) - Number(right.productId));
  const productValues = products.map((product) => `(${[
    Number(product.productId), sqlLiteral(product.leagueCode),
    sqlLiteral(product.currentValues?.playerAthlete || ''), sqlLiteral(product.currentValues?.team || ''),
    product.currentValues?.year === null || product.currentValues?.year === undefined
      ? 'null' : Number(product.currentValues.year),
  ].join(', ')})`).join(',\n');
  const resolvedIdentities = analyticsRows.filter((row) => row.athlete_id);
  const identityValues = resolvedIdentities.map((row) => `(${[
    sqlLiteral(row.league_code), `${sqlLiteral(row.athlete_id)}::uuid`, sqlLiteral(row.provider_name),
    sqlLiteral(row.provider_normalized_name),
  ].join(', ')})`).join(',\n') || "('MLB', null::uuid, '', '')";
  return `
with requested_products(product_id, league_code, expected_player, expected_team, expected_year) as (
  values ${productValues}
), requested_identities(league_code, athlete_id, provider_name, provider_normalized_name) as (
  values ${identityValues}
), product_checks as (
  select
    requested_products.*,
    products.id as remote_product_id,
    products.category,
    products.league,
    products.player_athlete,
    products.team,
    products.year,
    products.is_deleted,
    products.sale_status,
    (select count(*)::int from public.product_athlete_mappings mappings
      where mappings.product_id = requested_products.product_id
        and mappings.league_code = requested_products.league_code
        and mappings.review_state <> 'rejected') as active_mapping_count
  from requested_products
  left join public.products products on products.id = requested_products.product_id
), identity_checks as (
  select
    requested_identities.*,
    athletes.identity_status,
    memberships.membership_status,
    (select count(*)::int from public.athlete_aliases aliases
      where aliases.league_code = requested_identities.league_code
        and aliases.normalized_alias = requested_identities.provider_normalized_name
        and aliases.athlete_id <> requested_identities.athlete_id
        and aliases.review_state <> 'rejected') as conflicting_alias_count,
    (select count(*)::int from public.athlete_aliases aliases
      where aliases.league_code = requested_identities.league_code
        and aliases.athlete_id = requested_identities.athlete_id
        and aliases.alias = requested_identities.provider_name
        and aliases.normalized_alias = requested_identities.provider_normalized_name
        and aliases.review_state = 'verified') as provider_verified_alias_count
  from requested_identities
  left join public.athletes athletes on athletes.id = requested_identities.athlete_id
  left join public.athlete_league_memberships memberships
    on memberships.athlete_id = requested_identities.athlete_id
   and memberships.league_code = requested_identities.league_code
), league_checks as (
  select requested.league_code, leagues.sport_code, leagues.is_active
  from (values ('MLB'), ('NFL')) requested(league_code)
  left join public.sports_leagues leagues on leagues.league_code = requested.league_code
)
select json_build_object(
  'products', (select coalesce(json_agg(row_to_json(product_checks) order by product_id), '[]'::json) from product_checks),
  'identities', (select coalesce(json_agg(row_to_json(identity_checks) order by league_code, athlete_id), '[]'::json) from identity_checks),
  'leagues', (select coalesce(json_agg(row_to_json(league_checks) order by league_code), '[]'::json) from league_checks)
) as payload;
`;
}

export function parseSupabaseCliJson(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Supabase CLI did not return JSON.');
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* find the preceding JSON end */ }
  }
  throw new Error('Supabase CLI returned malformed JSON.');
}

export function buildSupabaseReadArgs({ workdir, sqlFile, projectRef = null }) {
  const targetArgs = projectRef ? ['--project-ref', projectRef] : [];
  return ['--yes', `supabase@${CLI_VERSION}`, 'db', 'query', '--linked', ...targetArgs,
    '--workdir', workdir, '--file', sqlFile, '--output-format', 'json', '--agent', 'yes'];
}

async function executeLinkedRead(sql, workdir, label, dependencies = {}) {
  return executeSupabaseRead(sql, { workdir }, label, dependencies);
}

async function executePrivateAnalyticsRead(sql, target, label, dependencies = {}) {
  if (!target?.projectRef) throw new Error(`${label} requires an explicit analytics project ref.`);
  return executeSupabaseRead(sql, {
    workdir: PRO_SPORTS_ANALYTICS_WORKDIR,
    projectRef: target.projectRef,
  }, label, dependencies);
}

async function executeSupabaseRead(sql, destination, label, dependencies = {}) {
  const outputDirectory = path.join(ROOT, 'outputs', 'pro-sports-mapping-private-preflight-work');
  await fs.mkdir(outputDirectory, { recursive: true });
  const sqlFile = path.join(outputDirectory, `${label}.sql`);
  await fs.writeFile(sqlFile, sql, 'utf8');
  const installedNpx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const npxArgs = buildSupabaseReadArgs({
    workdir: destination.workdir,
    sqlFile,
    projectRef: destination.projectRef,
  });
  const command = await fs.access(installedNpx).then(() => process.execPath).catch(() => (
    process.platform === 'win32' ? 'npx.cmd' : 'npx'
  ));
  const args = command === process.execPath ? [installedNpx, ...npxArgs] : npxArgs;
  const spawnImpl = dependencies.spawnImpl || spawn;
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: ROOT, windowsHide: true,
      shell: command !== process.execPath && process.platform === 'win32',
      env: { ...process.env, SUPABASE_DISABLE_UPDATE_CHECK: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    throw new Error(`${label} read failed: ${String(result.stderr || result.stdout).trim().slice(0, 1200)}`);
  }
  const parsed = parseSupabaseCliJson(result.stdout);
  return parsed?.rows?.[0]?.payload || {};
}

function identityKey(leagueCode, sourceName, externalId) {
  return `${leagueCode}\u0000${sourceName}\u0000${externalId}`;
}

export function stripProviderDisplayMarkers(value) {
  return String(value || '').replace(/\s*[\*#†‡+]+\s*$/u, '').trim();
}

export function evaluateProSportsPrivatePreflight(proposal, analyticsPayload, commercePayload) {
  const analyticsByExternal = new Map((analyticsPayload.identities || []).map((row) => [
    identityKey(row.league_code, row.source_name, row.external_id), row,
  ]));
  const commerceProducts = new Map((commercePayload.products || []).map((row) => [Number(row.product_id), row]));
  const commerceIdentities = new Map((commercePayload.identities || []).map((row) => [
    identityKey(row.league_code, '', row.athlete_id || ''), row,
  ]));
  const commerceLeagues = new Map((commercePayload.leagues || []).map((row) => [String(row.league_code), row]));
  const results = [];
  for (const product of proposal.highConfidenceProducts || []) {
    const remote = commerceProducts.get(Number(product.productId));
    const expectedCategory = LEAGUE_CATEGORIES[product.leagueCode] || '';
    const productCurrent = Boolean(remote?.remote_product_id)
      && String(remote.category || '') === expectedCategory
      && String(remote.league || '').toUpperCase() === product.leagueCode
      && String(remote.player_athlete || '') === String(product.currentValues?.playerAthlete || '')
      && String(remote.team || '') === String(product.currentValues?.team || '')
      && Number(remote.year ?? 0) === Number(product.currentValues?.year ?? 0);
    const productEligible = productCurrent && remote.is_deleted !== true
      && !['hidden', 'archived', 'sold'].includes(String(remote.sale_status || '').toLowerCase());
    const subjectChecks = (product.proposedSubjects || []).map((subject) => {
      const analytics = analyticsByExternal.get(identityKey(
        product.leagueCode, product.sourceName, subject.providerExternalId,
      ));
      const commerce = commerceIdentities.get(identityKey(product.leagueCode, '', analytics?.athlete_id || ''));
      const canonicalNameMatches = normalizeProviderIdentityName(analytics?.canonical_name)
        === normalizeProviderIdentityName(subject.providerCanonicalName);
      const providerNormalizedName = normalizeProviderIdentityName(subject.providerCanonicalName);
      const analyticsNormalizedNameMatches = String(analytics?.normalized_name || '') === providerNormalizedName;
      const analyticsCurrentNormalizedNameMatches = String(analytics?.normalized_name || '')
        === normalizeProviderIdentityName(analytics?.canonical_name);
      const markerOnlyNameDrift = !canonicalNameMatches
        && normalizeProviderIdentityName(stripProviderDisplayMarkers(analytics?.canonical_name))
          === normalizeProviderIdentityName(subject.providerCanonicalName);
      const analyticsReady = Boolean(analytics?.athlete_id)
        && analytics.identity_status === 'active'
        && analytics.membership_status === 'verified'
        && Number(analytics.provider_verified_alias_count || 0) > 0
        && analyticsNormalizedNameMatches
        && canonicalNameMatches;
      const markerAliasReady = Number(analytics.canonical_verified_alias_count || 0) > 0
        && analyticsCurrentNormalizedNameMatches;
      return {
        subjectOrder: Number(subject.subjectOrder),
        sourcePlayerText: subject.sourcePlayerText,
        providerExternalId: subject.providerExternalId,
        providerCanonicalName: subject.providerCanonicalName,
        analyticsAthleteId: analytics?.athlete_id || null,
        analyticsReady,
        analyticsCanonicalName: analytics?.canonical_name || '',
        analyticsNormalizedName: analytics?.normalized_name || '',
        providerNormalizedName,
        markerOnlyNameDrift,
        providerVerifiedAliasCount: Number(analytics?.provider_verified_alias_count || 0),
        canonicalVerifiedAliasCount: Number(analytics?.canonical_verified_alias_count || 0),
        markerAliasReady,
        commerceAthletePresent: commerce?.identity_status === 'active',
        commerceMembershipVerified: commerce?.membership_status === 'verified',
        commerceProviderVerifiedAliasCount: Number(commerce?.provider_verified_alias_count || 0),
        commerceAliasConflictCount: Number(commerce?.conflicting_alias_count || 0),
      };
    });
    const analyticsReady = subjectChecks.every((subject) => subject.analyticsReady);
    const analyticsMarkerRepairReady = subjectChecks.every((subject) => (
      subject.analyticsReady || (subject.markerOnlyNameDrift && subject.markerAliasReady)
    )) && subjectChecks.some((subject) => subject.markerOnlyNameDrift);
    const commerceIdentityReady = subjectChecks.every((subject) => subject.commerceAthletePresent
      && subject.commerceProviderVerifiedAliasCount > 0
      && subject.commerceAliasConflictCount === 0);
    const leagueReady = Boolean(commerceLeagues.get(product.leagueCode)?.is_active);
    const noExistingMapping = Number(remote?.active_mapping_count || 0) === 0;
    let disposition = 'blocked';
    if (productEligible && analyticsReady && noExistingMapping) {
      disposition = leagueReady && commerceIdentityReady
        ? 'ready_for_mapping_review' : 'ready_for_identity_copy_review';
    } else if (productEligible && analyticsMarkerRepairReady && noExistingMapping) {
      disposition = 'ready_for_analytics_identity_repair_review';
    }
    results.push({
      productId: Number(product.productId), leagueCode: product.leagueCode, sourceName: product.sourceName,
      disposition,
      checks: {
        productCurrent, productEligible, analyticsReady, analyticsMarkerRepairReady,
        leagueReady, commerceIdentityReady, noExistingMapping,
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

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = optionsFromArgs(argv);
  const proposalPath = workspacePath(options.proposalPath, 'Proposal path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const proposalText = await fs.readFile(proposalPath, 'utf8');
  const proposal = JSON.parse(proposalText);
  if (proposal?.mode !== 'proposal_only') throw new Error('Input is not a mapping review proposal.');
  const identities = requestedIdentities(proposal);
  const executeAnalyticsRead = dependencies.executePrivateAnalyticsRead || executePrivateAnalyticsRead;
  const analyticsPayloads = await Promise.all(planPrivateAnalyticsReads(identities).map((plan) => (
    executeAnalyticsRead(
      buildAnalyticsPreflightSql(plan.identities),
      plan.target,
      `analytics-${plan.target.sport}-identities`,
      dependencies,
    )
  )));
  const analyticsPayload = {
    identities: analyticsPayloads.flatMap((payload) => payload?.identities || []),
  };
  const commercePayload = await (dependencies.executeLinkedRead || executeLinkedRead)(
    buildCommercePreflightSql(proposal, analyticsPayload.identities || []), COMMERCE_WORKDIR,
    'commerce-products-identities', dependencies,
  );
  const evaluation = evaluateProSportsPrivatePreflight(proposal, analyticsPayload, commercePayload);
  const report = {
    generatedAt: new Date().toISOString(), mode: 'private_read_only_preflight',
    proposalPath: path.relative(ROOT, proposalPath).replace(/\\/g, '/'),
    proposalSha256: crypto.createHash('sha256').update(proposalText).digest('hex'),
    requestedIdentityCount: identities.length,
    analyticsResolvedIdentityCount: (analyticsPayload.identities || []).filter((row) => row.athlete_id).length,
    ...evaluation,
    publicationBoundary: { databaseWritesPerformed: false, sqlStatementsReadOnly: true },
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    requestedIdentityCount: report.requestedIdentityCount,
    analyticsResolvedIdentityCount: report.analyticsResolvedIdentityCount,
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
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
