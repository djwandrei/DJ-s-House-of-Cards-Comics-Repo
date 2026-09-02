import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main as runPrivatePreflight } from './audit-pro-sports-product-mapping-private-preflight.mjs';
import { splitProductSubjects } from './lib/pro-sports-product-mapping-coverage.mjs';

const ROOT = process.cwd();
const CLI_VERSION = '2.115.0';
const ANALYTICS_WORKDIR = path.join(ROOT, 'supabase-sports-analytics');
const COMMERCE_WORKDIR = ROOT;
const ANALYTICS_REPAIR_CONFIRMATION = 'repair-reviewed-pro-sports-identities';
const COMMERCE_COPY_CONFIRMATION = 'copy-reviewed-pro-sports-mappings';
const REVIEWED_PREFLIGHT_DISPOSITIONS = new Set([
  'ready_for_identity_copy_review',
  'ready_for_mapping_review',
  'ready_for_analytics_identity_repair_review',
]);
const COMMERCE_PREFLIGHT_DISPOSITIONS = new Set([
  'ready_for_identity_copy_review',
  'ready_for_mapping_review',
]);

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

export function optionsFromArgs(argv = []) {
  const options = {
    phase: 'audit',
    confirmation: '',
    proposalPath: 'outputs/pro-sports-product-mapping-review-proposal.json',
    preflightPath: 'outputs/pro-sports-product-mapping-private-preflight.json',
    repairPath: 'outputs/pro-sports-analytics-identity-repair-proposal.json',
    reportPath: 'outputs/pro-sports-product-mapping-sync-report.json',
  };
  for (const argument of argv) {
    if (argument === '--apply-analytics-repairs') options.phase = 'analytics-repairs';
    else if (argument === '--apply-commerce') options.phase = 'commerce-copy';
    else if (argument === '--apply') {
      throw new Error('Use --apply-analytics-repairs or --apply-commerce; the combined apply mode is disabled.');
    }
    else if (argument.startsWith('--confirm=')) options.confirmation = argument.slice('--confirm='.length);
    else if (argument.startsWith('--proposal=')) options.proposalPath = argument.slice('--proposal='.length);
    else if (argument.startsWith('--preflight=')) options.preflightPath = argument.slice('--preflight='.length);
    else if (argument.startsWith('--repairs=')) options.repairPath = argument.slice('--repairs='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonbLiteral(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function identityKey(leagueCode, sourceName, externalId) {
  return `${leagueCode}\u0000${sourceName}\u0000${externalId}`;
}

function repairKey(repair) {
  return [repair.leagueCode, repair.sourceName, repair.athleteId, repair.providerExternalId].join('\u0000');
}

function assertProposalProductSubjectIntegrity(product) {
  if (product?.requiresCatalogCorrectionBeforeMapping === true) {
    throw new Error(`Product ${product.productId} requires a catalog correction before mapping.`);
  }
  const expectedSubjects = splitProductSubjects(product?.currentValues?.playerAthlete);
  const proposedSubjects = [...(product?.proposedSubjects || [])]
    .sort((left, right) => Number(left.subjectOrder) - Number(right.subjectOrder));
  if (!expectedSubjects.length || proposedSubjects.length !== expectedSubjects.length) {
    throw new Error(`Product ${product?.productId} does not resolve every current catalog subject.`);
  }
  const providerIds = new Set();
  for (const [index, subject] of proposedSubjects.entries()) {
    if (Number(subject.subjectOrder) !== index + 1
      || String(subject.sourcePlayerText || '') !== expectedSubjects[index]) {
      throw new Error(`Product ${product?.productId} has a non-contiguous or mismatched subject order.`);
    }
    const providerExternalId = String(subject.providerExternalId || '');
    if (!providerExternalId || providerIds.has(providerExternalId)) {
      throw new Error(`Product ${product?.productId} has duplicate or missing provider identities.`);
    }
    providerIds.add(providerExternalId);
  }
  return proposedSubjects;
}

export function expectedRepairsFromPreflight(preflight = {}) {
  const repairsByKey = new Map();
  for (const product of preflight.results || []) {
    for (const subject of product.subjects || []) {
      if (!subject.markerOnlyNameDrift) continue;
      const repair = {
        leagueCode: String(product.leagueCode || ''),
        sourceName: String(product.sourceName || ''),
        athleteId: String(subject.analyticsAthleteId || ''),
        providerExternalId: String(subject.providerExternalId || ''),
        currentCanonicalName: String(subject.analyticsCanonicalName || ''),
        currentNormalizedName: String(subject.analyticsNormalizedName || ''),
        proposedCanonicalName: String(subject.providerCanonicalName || ''),
        normalizedName: String(subject.providerNormalizedName || ''),
        affectedProductIds: [Number(product.productId)],
      };
      if (!repair.leagueCode || !repair.sourceName || !repair.athleteId
        || !repair.providerExternalId || !repair.currentCanonicalName || !repair.currentNormalizedName || !repair.proposedCanonicalName
        || !repair.normalizedName) {
        throw new Error(`Marker repair for product ${product.productId} is incomplete.`);
      }
      const key = repairKey(repair);
      const prior = repairsByKey.get(key);
      if (prior && (prior.currentCanonicalName !== repair.currentCanonicalName
        || prior.proposedCanonicalName !== repair.proposedCanonicalName)) {
        throw new Error(`Conflicting marker repair evidence for athlete ${repair.athleteId}.`);
      }
      if (prior) prior.affectedProductIds.push(Number(product.productId));
      else repairsByKey.set(key, repair);
    }
  }
  return [...repairsByKey.values()].map((repair) => ({
    ...repair,
    affectedProductIds: [...new Set(repair.affectedProductIds)].sort((left, right) => left - right),
  })).sort((left, right) => left.leagueCode.localeCompare(right.leagueCode)
    || left.proposedCanonicalName.localeCompare(right.proposedCanonicalName)
    || left.athleteId.localeCompare(right.athleteId));
}

function assertExactRepairSet(preflight, repairProposal) {
  const expected = expectedRepairsFromPreflight(preflight);
  const proposed = [...(repairProposal.repairs || [])].map((repair) => ({
    leagueCode: String(repair.leagueCode || ''),
    sourceName: String(repair.sourceName || ''),
    athleteId: String(repair.athleteId || ''),
    providerExternalId: String(repair.providerExternalId || ''),
    currentCanonicalName: String(repair.currentCanonicalName || ''),
    currentNormalizedName: String(repair.currentNormalizedName || ''),
    proposedCanonicalName: String(repair.proposedCanonicalName || ''),
    normalizedName: String(repair.normalizedName || ''),
    affectedProductIds: [...new Set((repair.affectedProductIds || []).map(Number))]
      .sort((left, right) => left - right),
  }));
  if (Number(repairProposal.repairIdentityCount) !== expected.length || proposed.length !== expected.length) {
    throw new Error('The identity repair proposal count does not match the private preflight.');
  }
  const expectedProducts = new Set(expected.flatMap((repair) => repair.affectedProductIds));
  if (Number(repairProposal.affectedProductCount) !== expectedProducts.size) {
    throw new Error('The identity repair product count does not match the private preflight.');
  }
  const byKey = new Map(proposed.map((repair) => [repairKey(repair), repair]));
  if (byKey.size !== expected.length) {
    throw new Error('The identity repair proposal contains duplicate or unexpected repairs.');
  }
  for (const repair of expected) {
    const proposedRepair = byKey.get(repairKey(repair));
    if (!proposedRepair
      || proposedRepair.currentCanonicalName !== repair.currentCanonicalName
      || proposedRepair.currentNormalizedName !== repair.currentNormalizedName
      || proposedRepair.proposedCanonicalName !== repair.proposedCanonicalName
      || proposedRepair.normalizedName !== repair.normalizedName
      || proposedRepair.affectedProductIds.join(',') !== repair.affectedProductIds.join(',')) {
      throw new Error(`The identity repair proposal is not an exact match for athlete ${repair.athleteId}.`);
    }
  }
  return expected;
}

export function buildSyncPlan({ proposal, proposalSha256, preflight, repairProposal, preflightSha256 }) {
  if (proposal?.mode !== 'proposal_only') throw new Error('Input is not a mapping proposal.');
  if (preflight?.mode !== 'private_read_only_preflight') throw new Error('Input is not a private preflight.');
  if (repairProposal?.mode !== 'proposal_only') throw new Error('Input is not an identity repair proposal.');
  if (!proposalSha256 || preflight.proposalSha256 !== proposalSha256) {
    throw new Error('The private preflight does not match the mapping proposal artifact.');
  }
  if (repairProposal.sourcePreflightSha256 !== preflightSha256) {
    throw new Error('The identity repair proposal does not match the private preflight artifact.');
  }
  if (repairProposal.sourceProposalSha256 !== proposalSha256) {
    throw new Error('The identity repair proposal does not match the mapping proposal artifact.');
  }
  const repairs = assertExactRepairSet(preflight, repairProposal);
  const products = proposal.highConfidenceProducts || [];
  const preflightByProduct = new Map((preflight.results || []).map((row) => [Number(row.productId), row]));
  const mappingRows = [];
  const identityRequests = new Map();
  const productChecks = [];
  for (const product of products) {
    const productId = Number(product.productId);
    const proposedSubjects = assertProposalProductSubjectIntegrity(product);
    const checked = preflightByProduct.get(productId);
    if (!checked || !REVIEWED_PREFLIGHT_DISPOSITIONS.has(checked.disposition)) {
      throw new Error(`Product ${productId} is not eligible in the private preflight.`);
    }
    const checkedSubjects = new Map((checked.subjects || []).map((subject) => [
      Number(subject.subjectOrder), subject,
    ]));
    productChecks.push({
      product_id: productId,
      category: product.leagueCode === 'MLB' ? 'Baseball' : 'Football',
      league_code: product.leagueCode,
      player_athlete: String(product.currentValues?.playerAthlete || ''),
      team: String(product.currentValues?.team || ''),
      product_year: product.currentValues?.year ?? null,
    });
    const subjectCount = proposedSubjects.length;
    if (checkedSubjects.size !== subjectCount) {
      throw new Error(`Product ${productId} private preflight subject count does not match the proposal.`);
    }
    for (const subject of proposedSubjects) {
      const checkedSubject = checkedSubjects.get(Number(subject.subjectOrder));
      if (!checkedSubject?.analyticsAthleteId
        || checkedSubject.providerExternalId !== subject.providerExternalId) {
        throw new Error(`Product ${productId} subject ${subject.subjectOrder} lacks a stable athlete identity.`);
      }
      const request = {
        league_code: product.leagueCode,
        source_name: product.sourceName,
        external_id: subject.providerExternalId,
        athlete_id: checkedSubject.analyticsAthleteId,
        canonical_name: subject.providerCanonicalName,
      };
      const key = identityKey(request.league_code, request.source_name, request.external_id);
      const existing = identityRequests.get(key);
      if (existing && (existing.athlete_id !== request.athlete_id
        || existing.canonical_name !== request.canonical_name)) {
        throw new Error(`Conflicting identity evidence for ${request.league_code}/${request.external_id}.`);
      }
      identityRequests.set(key, request);
      mappingRows.push({
        product_id: productId,
        athlete_id: request.athlete_id,
        league_code: product.leagueCode,
        subject_order: Number(subject.subjectOrder),
        subject_role: subjectCount === 1 ? 'primary' : 'co_subject',
        match_method: 'external_id',
        match_confidence: 1,
        review_state: 'auto_verified',
        source_player_text: subject.sourcePlayerText,
        evidence: {
          mappingVersion: 2,
          providerSource: product.sourceName,
          providerExternalId: subject.providerExternalId,
          providerCanonicalName: subject.providerCanonicalName,
          proposalDisposition: product.disposition,
          catalogPlayerAthlete: product.currentValues?.playerAthlete || '',
          catalogTeam: product.currentValues?.team || '',
          catalogYear: product.currentValues?.year ?? null,
          nameMatchMethod: subject.matchMethod,
          teamEvidence: product.evidence?.team || null,
          yearEvidence: product.evidence?.year || null,
        },
      });
    }
  }
  if (mappingRows.length !== Number(proposal.highConfidenceMappingRowCount)) {
    throw new Error('Mapping row count does not reconcile to the proposal summary.');
  }
  if (products.length !== Number(proposal.highConfidenceProductCount)
    || preflightByProduct.size !== products.length) {
    throw new Error('Product counts do not reconcile across proposal and private preflight.');
  }
  const uniqueAthleteIds = [...new Set([...identityRequests.values()].map((request) => request.athlete_id))]
    .sort();
  return {
    products: productChecks.sort((left, right) => left.product_id - right.product_id),
    identityRequests: [...identityRequests.values()].sort((left, right) => (
      left.league_code.localeCompare(right.league_code)
      || left.source_name.localeCompare(right.source_name)
      || left.external_id.localeCompare(right.external_id)
    )),
    mappingRows: mappingRows.sort((left, right) => left.product_id - right.product_id
      || left.subject_order - right.subject_order),
    athleteIds: uniqueAthleteIds,
    repairs,
    commerceReady: repairs.length === 0 && [...preflightByProduct.values()]
      .every((row) => COMMERCE_PREFLIGHT_DISPOSITIONS.has(row.disposition)),
  };
}

export function buildAnalyticsSnapshotSql(identityRequests, repairs = []) {
  if (!identityRequests.length) throw new Error('No athlete identities were requested.');
  const requestedValues = identityRequests.map((row) => `(${[
    sqlLiteral(row.league_code), sqlLiteral(row.source_name), sqlLiteral(row.external_id),
    `${sqlLiteral(row.athlete_id)}::uuid`, sqlLiteral(row.canonical_name),
  ].join(', ')})`).join(',\n');
  const repairIds = repairs.length
    ? repairs.map((repair) => `${sqlLiteral(repair.athleteId)}::uuid`).join(', ')
    : 'null::uuid';
  return `
with requested(league_code, source_name, external_id, expected_athlete_id, expected_name) as (
  values ${requestedValues}
), resolved as (
  select requested.*, external_ids.athlete_id
  from requested
  left join public.athlete_external_ids external_ids
    on external_ids.league_code = requested.league_code
   and external_ids.source_name = requested.source_name
   and external_ids.external_id = requested.external_id
), requested_athletes as (
  select distinct athlete_id from resolved where athlete_id is not null
), requested_memberships as (
  select distinct athlete_id, league_code
  from resolved
  where athlete_id is not null
), requested_sports as (
  select distinct case league_code
    when 'MLB' then 'baseball'
    when 'NFL' then 'football'
  end as sport_code
  from requested
), requested_aliases as (
  select distinct athlete_id, league_code, expected_name
  from resolved
  where athlete_id is not null
)
select json_build_object(
  'requested', (select coalesce(json_agg(row_to_json(resolved) order by league_code, source_name, external_id), '[]'::json) from resolved),
  'sports', (select coalesce(json_agg(to_jsonb(sports) - 'created_at' - 'updated_at' order by sport_code), '[]'::json)
    from public.sports where sport_code in (select sport_code from requested_sports where sport_code is not null)),
  'leagues', (select coalesce(json_agg(to_jsonb(leagues) - 'created_at' - 'updated_at' order by league_code), '[]'::json)
    from public.sports_leagues leagues where league_code in (select distinct league_code from requested)),
  'athletes', (select coalesce(json_agg(to_jsonb(athletes) - 'created_at' - 'updated_at' order by id), '[]'::json)
    from public.athletes athletes where id in (select athlete_id from requested_athletes)),
  'memberships', (select coalesce(json_agg(to_jsonb(memberships) - 'created_at' - 'updated_at' order by memberships.athlete_id, memberships.league_code), '[]'::json)
    from public.athlete_league_memberships memberships
    join requested_memberships requested_memberships
      on requested_memberships.athlete_id = memberships.athlete_id
     and requested_memberships.league_code = memberships.league_code),
  'aliases', (select coalesce(json_agg(to_jsonb(aliases) - 'created_at' - 'updated_at' order by aliases.athlete_id, aliases.league_code, aliases.normalized_alias), '[]'::json)
    from public.athlete_aliases aliases
    join requested_aliases requested_aliases
      on requested_aliases.athlete_id = aliases.athlete_id
     and requested_aliases.league_code = aliases.league_code
     and requested_aliases.expected_name = aliases.alias),
  'externalIds', (select coalesce(json_agg(to_jsonb(ids) - 'created_at' - 'updated_at' order by ids.athlete_id, ids.league_code, ids.source_name, ids.external_id), '[]'::json)
    from public.athlete_external_ids ids
    join requested requested
      on requested.league_code = ids.league_code
     and requested.source_name = ids.source_name
     and requested.external_id = ids.external_id
     and requested.expected_athlete_id = ids.athlete_id),
  'repairProfiles', json_build_object(
    'mlb', (select coalesce(json_agg(json_build_object('athlete_id', athlete_id, 'full_name', full_name, 'normalized_name', normalized_name) order by athlete_id), '[]'::json)
      from public.mlb_players where athlete_id in (${repairIds})),
    'nfl', (select coalesce(json_agg(json_build_object('athlete_id', athlete_id, 'full_name', full_name, 'normalized_name', normalized_name) order by athlete_id), '[]'::json)
      from public.nfl_players where athlete_id in (${repairIds}))
  )
) as payload;
`;
}

export function buildAnalyticsRepairSql(repairs) {
  if (!repairs.length) return '';
  const rows = repairs.map((repair) => ({
    athlete_id: repair.athleteId,
    league_code: repair.leagueCode,
    source_name: repair.sourceName,
    external_id: repair.providerExternalId,
    old_name: repair.currentCanonicalName,
    old_normalized_name: repair.currentNormalizedName,
    new_name: repair.proposedCanonicalName,
    normalized_name: repair.normalizedName,
  }));
  return `
begin;
create temporary table _reviewed_identity_repairs on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(rows)}) as repairs(
  athlete_id uuid, league_code text, source_name text, external_id text, old_name text, old_normalized_name text, new_name text, normalized_name text
);

do $$
begin
  if (select count(*) from _reviewed_identity_repairs) <> ${rows.length} then
    raise exception 'Reviewed repair input count does not reconcile';
  end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athletes athletes on athletes.id = repairs.athlete_id
    where athletes.id is null or athletes.identity_status <> 'active'
      or not (
        (athletes.canonical_name = repairs.old_name and athletes.normalized_name = repairs.old_normalized_name)
        or (athletes.canonical_name = repairs.new_name and athletes.normalized_name = repairs.normalized_name)
      )
  ) then raise exception 'Athlete identity drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    where not exists (
      select 1 from public.athlete_aliases aliases
      where aliases.athlete_id = repairs.athlete_id and aliases.league_code = repairs.league_code
        and ((aliases.alias = repairs.old_name and aliases.normalized_alias = repairs.old_normalized_name)
          or (aliases.alias = repairs.new_name and aliases.normalized_alias = repairs.normalized_name))
        and aliases.review_state = 'verified'
    )
  ) then raise exception 'Verified alias drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athlete_league_memberships memberships
      on memberships.athlete_id = repairs.athlete_id
     and memberships.league_code = repairs.league_code
    where memberships.membership_status is distinct from 'verified'
  ) then raise exception 'Verified membership drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athlete_external_ids external_ids
      on external_ids.athlete_id = repairs.athlete_id
     and external_ids.league_code = repairs.league_code
     and external_ids.source_name = repairs.source_name
     and external_ids.external_id = repairs.external_id
    where external_ids.athlete_id is null
  ) then raise exception 'Provider external ID drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.mlb_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'MLB' and (players.athlete_id is null or not (
      (players.full_name = repairs.old_name and players.normalized_name = repairs.old_normalized_name)
      or (players.full_name = repairs.new_name and players.normalized_name = repairs.normalized_name)
    ))
  ) then raise exception 'MLB profile drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.nfl_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'NFL' and (players.athlete_id is null or not (
      (players.full_name = repairs.old_name and players.normalized_name = repairs.old_normalized_name)
      or (players.full_name = repairs.new_name and players.normalized_name = repairs.normalized_name)
    ))
  ) then raise exception 'NFL profile drift blocks the reviewed repair'; end if;
end $$;

update public.athlete_aliases aliases
set alias = repairs.new_name,
    normalized_alias = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where aliases.athlete_id = repairs.athlete_id
  and aliases.league_code = repairs.league_code
  and aliases.alias = repairs.old_name
  and aliases.review_state = 'verified';

update public.athletes athletes
set canonical_name = repairs.new_name,
    normalized_name = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where athletes.id = repairs.athlete_id and athletes.canonical_name = repairs.old_name;

update public.mlb_players players
set full_name = repairs.new_name,
    normalized_name = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where repairs.league_code = 'MLB' and players.athlete_id = repairs.athlete_id
  and players.full_name = repairs.old_name;

update public.nfl_players players
set full_name = repairs.new_name,
    normalized_name = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where repairs.league_code = 'NFL' and players.athlete_id = repairs.athlete_id
  and players.full_name = repairs.old_name;

do $$
begin
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athletes athletes on athletes.id = repairs.athlete_id
    where athletes.canonical_name <> repairs.new_name
      or athletes.normalized_name <> repairs.normalized_name
  ) then raise exception 'Athlete repair readback failed'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    where not exists (
      select 1 from public.athlete_aliases aliases
      where aliases.athlete_id = repairs.athlete_id and aliases.league_code = repairs.league_code
        and aliases.alias = repairs.new_name
        and aliases.normalized_alias = repairs.normalized_name
        and aliases.review_state = 'verified'
    )
  ) then raise exception 'Alias repair readback failed'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.mlb_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'MLB'
      and (players.full_name <> repairs.new_name
        or players.normalized_name <> repairs.normalized_name)
  ) then raise exception 'MLB profile repair readback failed'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.nfl_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'NFL'
      and (players.full_name <> repairs.new_name
        or players.normalized_name <> repairs.normalized_name)
  ) then raise exception 'NFL profile repair readback failed'; end if;
end $$;

commit;
select json_build_object('repairedIdentityCount', ${rows.length}) as payload;
`;
}

function sourceRowsForCommerce(sourceInput, plan) {
  if (!plan.commerceReady) {
    throw new Error('Commerce copy requires a refreshed private preflight with no pending analytics repairs.');
  }
  const expectedRequests = new Map(plan.identityRequests.map((request) => [
    identityKey(request.league_code, request.source_name, request.external_id), request,
  ]));
  const requested = new Map();
  for (const row of sourceInput.requested || []) {
    const key = identityKey(row.league_code, row.source_name, row.external_id);
    if (requested.has(key)) throw new Error(`Duplicate analytics identity snapshot row for ${key}.`);
    requested.set(key, row);
  }
  if (requested.size !== expectedRequests.size) {
    throw new Error('Analytics identity snapshot count does not match the reviewed plan.');
  }
  const expectedNamesByAthlete = new Map();
  const expectedMembershipKeys = new Set();
  const expectedExternalKeys = new Set();
  for (const [key, request] of expectedRequests) {
    const row = requested.get(key);
    if (!row || !row.athlete_id || String(row.athlete_id) !== String(request.athlete_id)
      || String(row.expected_athlete_id) !== String(request.athlete_id)
      || String(row.expected_name) !== String(request.canonical_name)) {
      throw new Error(`Analytics identity drift for ${request.league_code}/${request.external_id}.`);
    }
    const priorName = expectedNamesByAthlete.get(String(request.athlete_id));
    if (priorName && priorName !== request.canonical_name) {
      throw new Error(`Multiple canonical names were proposed for athlete ${request.athlete_id}.`);
    }
    expectedNamesByAthlete.set(String(request.athlete_id), request.canonical_name);
    expectedMembershipKeys.add(`${request.athlete_id}\u0000${request.league_code}`);
    expectedExternalKeys.add(key);
  }
  const athletesById = new Map((sourceInput.athletes || []).map((row) => [String(row.id), row]));
  if (athletesById.size !== expectedNamesByAthlete.size) {
    throw new Error('Analytics athlete snapshot count does not match the reviewed plan.');
  }
  const athletes = [];
  for (const [athleteId, expectedName] of expectedNamesByAthlete) {
    const athlete = athletesById.get(athleteId);
    if (!athlete || String(athlete.canonical_name) !== expectedName || athlete.identity_status !== 'active') {
      throw new Error(`Analytics canonical identity is not ready for athlete ${athleteId}.`);
    }
    athletes.push(athlete);
  }
  const membershipsByKey = new Map((sourceInput.memberships || []).map((row) => [
    `${row.athlete_id}\u0000${row.league_code}`, row,
  ]));
  const memberships = [...expectedMembershipKeys].map((key) => membershipsByKey.get(key));
  if (memberships.some((row) => !row || row.membership_status !== 'verified')) {
    throw new Error('Analytics league membership is not verified for the reviewed plan.');
  }
  const aliases = [];
  for (const request of expectedRequests.values()) {
    const alias = (sourceInput.aliases || []).find((row) => String(row.athlete_id) === String(request.athlete_id)
      && String(row.league_code) === request.league_code
      && String(row.alias) === request.canonical_name
      && row.review_state === 'verified');
    if (!alias) {
      throw new Error(`Analytics verified alias is missing for ${request.league_code}/${request.external_id}.`);
    }
    aliases.push(alias);
  }
  const externalIdsByKey = new Map((sourceInput.externalIds || []).map((row) => [
    identityKey(row.league_code, row.source_name, row.external_id), row,
  ]));
  const externalIds = [...expectedExternalKeys].map((key) => {
    const row = externalIdsByKey.get(key);
    const request = expectedRequests.get(key);
    if (!row || !request || String(row.athlete_id) !== String(request.athlete_id)) {
      throw new Error(`Analytics external ID snapshot drifted for ${request?.league_code || 'unknown'}/${request?.external_id || 'unknown'}.`);
    }
    return row;
  });
  if (externalIds.some((row) => !expectedNamesByAthlete.has(String(row.athlete_id)))) {
    throw new Error('Analytics external ID snapshot contains an unexpected athlete.');
  }
  const leagueCodes = [...new Set(plan.identityRequests.map((request) => request.league_code))].sort();
  const sportCodes = [...new Set(leagueCodes.map((leagueCode) => (
    leagueCode === 'MLB' ? 'baseball' : leagueCode === 'NFL' ? 'football' : ''
  )))].filter(Boolean).sort();
  const sportsByCode = new Map((sourceInput.sports || []).map((row) => [String(row.sport_code), row]));
  const leaguesByCode = new Map((sourceInput.leagues || []).map((row) => [String(row.league_code), row]));
  const sports = sportCodes.map((sportCode) => sportsByCode.get(sportCode));
  const leagues = leagueCodes.map((leagueCode) => leaguesByCode.get(leagueCode));
  if (sports.some((row) => !row || row.is_active !== true)
    || leagues.some((row) => !row || row.is_active !== true)) {
    throw new Error('Analytics sport or league snapshot is not active for the reviewed plan.');
  }
  return { sports, leagues, athletes, memberships, aliases, externalIds };
}

export function buildCommerceSnapshotSql(plan) {
  const productIds = plan.products.map((row) => Number(row.product_id)).join(', ');
  const athleteIds = plan.athleteIds.map((athleteId) => `${sqlLiteral(athleteId)}::uuid`).join(', ');
  return `
select json_build_object(
  'products', (select coalesce(json_agg(to_jsonb(products) order by id), '[]'::json)
    from public.products where id in (${productIds})),
  'mappings', (select coalesce(json_agg(to_jsonb(mappings) order by product_id, subject_order), '[]'::json)
    from public.product_athlete_mappings mappings where product_id in (${productIds})),
  'sports', (select coalesce(json_agg(to_jsonb(sports) order by sport_code), '[]'::json)
    from public.sports where sport_code in ('baseball', 'football')),
  'leagues', (select coalesce(json_agg(to_jsonb(leagues) order by league_code), '[]'::json)
    from public.sports_leagues leagues where league_code in ('MLB', 'NFL')),
  'athletes', (select coalesce(json_agg(to_jsonb(athletes) order by id), '[]'::json)
    from public.athletes athletes where id in (${athleteIds})),
  'memberships', (select coalesce(json_agg(to_jsonb(memberships) order by athlete_id, league_code), '[]'::json)
    from public.athlete_league_memberships memberships where athlete_id in (${athleteIds})),
  'aliases', (select coalesce(json_agg(to_jsonb(aliases) order by athlete_id, league_code, normalized_alias), '[]'::json)
    from public.athlete_aliases aliases where athlete_id in (${athleteIds})),
  'externalIds', (select coalesce(json_agg(to_jsonb(ids) order by athlete_id, league_code, source_name, external_id), '[]'::json)
    from public.athlete_external_ids ids where athlete_id in (${athleteIds}))
) as payload;
`;
}

export function buildCommerceApplySql(sourceInput, plan) {
  const source = sourceRowsForCommerce(sourceInput, plan);
  return `
begin;
create temporary table _reviewed_products on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(plan.products)}) as rows(
  product_id bigint, category text, league_code text, player_athlete text, team text, product_year integer
);
create temporary table _reviewed_mappings on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(plan.mappingRows)}) as rows(
  product_id bigint, athlete_id uuid, league_code text, subject_order smallint,
  subject_role text, match_method text, match_confidence numeric, review_state text,
  source_player_text text, evidence jsonb
);
create temporary table _source_sports on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(source.sports || [])}) as rows(
  sport_code text, display_name text, is_active boolean
);
create temporary table _source_leagues on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(source.leagues || [])}) as rows(
  league_code text, sport_code text, display_name text, is_active boolean
);
create temporary table _source_athletes on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(source.athletes || [])}) as rows(
  id uuid, canonical_name text, normalized_name text, birth_date date,
  identity_status text, merged_into_athlete_id uuid, metadata jsonb
);
create temporary table _source_memberships on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(source.memberships || [])}) as rows(
  athlete_id uuid, league_code text, membership_status text, source_name text, evidence jsonb
);
create temporary table _source_aliases on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(source.aliases || [])}) as rows(
  athlete_id uuid, league_code text, alias text, normalized_alias text,
  alias_type text, review_state text, source_name text, evidence jsonb
);
create temporary table _source_external_ids on commit drop as
select * from jsonb_to_recordset(${jsonbLiteral(source.externalIds || [])}) as rows(
  athlete_id uuid, league_code text, source_name text, external_id text,
  is_primary_for_source boolean
);

do $$
begin
  if (select count(*) from _reviewed_products) <> ${plan.products.length}
    or (select count(*) from _reviewed_mappings) <> ${plan.mappingRows.length}
    or (select count(*) from _source_sports) <> ${source.sports.length}
    or (select count(*) from _source_leagues) <> ${source.leagues.length}
    or (select count(*) from _source_athletes) <> ${source.athletes.length}
    or (select count(*) from _source_memberships) <> ${source.memberships.length}
    or (select count(*) from _source_aliases) <> ${source.aliases.length}
    or (select count(*) from _source_external_ids) <> ${source.externalIds.length}
  then raise exception 'Reviewed sync input counts do not reconcile'; end if;
  if exists (
    select 1 from _reviewed_products reviewed
    left join public.products products on products.id = reviewed.product_id
    where products.id is null or products.category <> reviewed.category
      or upper(products.league) <> reviewed.league_code
      or products.player_athlete <> reviewed.player_athlete
      or products.team <> reviewed.team
      or coalesce(products.year, 0) <> coalesce(reviewed.product_year, 0)
      or products.is_deleted is true
      or lower(coalesce(products.sale_status, '')) in ('hidden', 'archived', 'sold')
  ) then raise exception 'Commerce product drift blocks mapping sync'; end if;
  if exists (
    select 1 from public.product_athlete_mappings mappings
    where mappings.product_id in (select product_id from _reviewed_products)
  ) then raise exception 'Existing product mapping rows block insert-only sync'; end if;
  if exists (
    select 1 from _source_sports source
    join public.sports target using (sport_code)
    where target.display_name is distinct from source.display_name
      or target.is_active is distinct from source.is_active
  ) then raise exception 'Commerce sport conflict blocks sync'; end if;
  if exists (
    select 1 from _source_leagues source
    join public.sports_leagues target using (league_code)
    where target.sport_code is distinct from source.sport_code
      or target.display_name is distinct from source.display_name
      or target.is_active is distinct from source.is_active
  ) then raise exception 'Commerce league conflict blocks sync'; end if;
  if exists (
    select 1 from _source_athletes source
    join public.athletes target on target.id = source.id
    where target.canonical_name is distinct from source.canonical_name
      or target.normalized_name is distinct from source.normalized_name
      or target.birth_date is distinct from source.birth_date
      or target.identity_status is distinct from source.identity_status
      or target.merged_into_athlete_id is distinct from source.merged_into_athlete_id
      or target.metadata is distinct from source.metadata
  ) then raise exception 'Commerce athlete identity conflict blocks sync'; end if;
  if exists (
    select 1 from _source_memberships source
    join public.athlete_league_memberships target
      on target.athlete_id = source.athlete_id and target.league_code = source.league_code
    where target.membership_status is distinct from source.membership_status
      or target.source_name is distinct from source.source_name
      or target.evidence is distinct from source.evidence
  ) then raise exception 'Commerce membership conflict blocks sync'; end if;
  if exists (
    select 1 from _source_aliases source
    join public.athlete_aliases target
      on target.athlete_id = source.athlete_id
     and target.league_code = source.league_code
     and target.normalized_alias = source.normalized_alias
    where target.alias is distinct from source.alias
      or target.alias_type is distinct from source.alias_type
      or target.review_state is distinct from source.review_state
      or target.source_name is distinct from source.source_name
      or target.evidence is distinct from source.evidence
  ) then raise exception 'Commerce alias conflict blocks sync'; end if;
  if exists (
    select 1 from _source_aliases source
    join public.athlete_aliases target
      on target.league_code = source.league_code and target.normalized_alias = source.normalized_alias
    where target.athlete_id <> source.athlete_id
  ) then raise exception 'Commerce alias ownership conflict blocks sync'; end if;
  if exists (
    select 1 from _source_external_ids source_ids
    join public.athlete_external_ids existing_ids
      on existing_ids.league_code = source_ids.league_code
     and existing_ids.source_name = source_ids.source_name
     and existing_ids.external_id = source_ids.external_id
    where existing_ids.athlete_id <> source_ids.athlete_id
  ) then raise exception 'Commerce external identity conflict blocks sync'; end if;
  if exists (
    select 1 from _source_external_ids source
    join public.athlete_external_ids target
      on target.league_code = source.league_code
     and target.source_name = source.source_name
     and target.external_id = source.external_id
    where target.athlete_id is distinct from source.athlete_id
      or target.is_primary_for_source is distinct from source.is_primary_for_source
  ) then raise exception 'Commerce external ID detail conflict blocks sync'; end if;
end $$;

insert into public.sports (sport_code, display_name, is_active)
select sport_code, display_name, is_active from _source_sports
on conflict (sport_code) do nothing;
insert into public.sports_leagues (league_code, sport_code, display_name, is_active)
select league_code, sport_code, display_name, is_active from _source_leagues
on conflict (league_code) do nothing;
insert into public.athletes (
  id, canonical_name, normalized_name, birth_date, identity_status, merged_into_athlete_id, metadata
)
select id, canonical_name, normalized_name, birth_date, identity_status, merged_into_athlete_id, metadata
from _source_athletes on conflict (id) do nothing;
insert into public.athlete_league_memberships (
  athlete_id, league_code, membership_status, source_name, evidence
)
select athlete_id, league_code, membership_status, source_name, evidence
from _source_memberships on conflict (athlete_id, league_code) do nothing;
insert into public.athlete_aliases (
  athlete_id, league_code, alias, normalized_alias, alias_type, review_state, source_name, evidence
)
select athlete_id, league_code, alias, normalized_alias, alias_type, review_state, source_name, evidence
from _source_aliases on conflict (athlete_id, league_code, normalized_alias) do nothing;
insert into public.athlete_external_ids (
  athlete_id, league_code, source_name, external_id, is_primary_for_source
)
select athlete_id, league_code, source_name, external_id, is_primary_for_source
from _source_external_ids on conflict (league_code, source_name, external_id) do nothing;
insert into public.product_athlete_mappings (
  product_id, athlete_id, league_code, subject_order, subject_role,
  match_method, match_confidence, review_state, source_player_text, evidence
)
select product_id, athlete_id, league_code, subject_order, subject_role,
  match_method, match_confidence, review_state, source_player_text, evidence
from _reviewed_mappings;

do $$
begin
  if exists (
    select 1 from _source_sports source
    left join public.sports target using (sport_code)
    where target.sport_code is null
      or target.display_name is distinct from source.display_name
      or target.is_active is distinct from source.is_active
  ) then raise exception 'Commerce sport readback failed'; end if;
  if exists (
    select 1 from _source_leagues source
    left join public.sports_leagues target using (league_code)
    where target.league_code is null
      or target.sport_code is distinct from source.sport_code
      or target.display_name is distinct from source.display_name
      or target.is_active is distinct from source.is_active
  ) then raise exception 'Commerce league readback failed'; end if;
  if exists (
    select 1 from _source_athletes source
    left join public.athletes target on target.id = source.id
    where target.id is null
      or target.canonical_name is distinct from source.canonical_name
      or target.normalized_name is distinct from source.normalized_name
      or target.birth_date is distinct from source.birth_date
      or target.identity_status is distinct from source.identity_status
      or target.merged_into_athlete_id is distinct from source.merged_into_athlete_id
      or target.metadata is distinct from source.metadata
  ) then raise exception 'Commerce athlete identity readback failed'; end if;
  if exists (
    select 1 from _source_memberships source
    left join public.athlete_league_memberships target
      on target.athlete_id = source.athlete_id and target.league_code = source.league_code
    where target.athlete_id is null
      or target.membership_status is distinct from source.membership_status
      or target.source_name is distinct from source.source_name
      or target.evidence is distinct from source.evidence
  ) then raise exception 'Commerce membership readback failed'; end if;
  if exists (
    select 1 from _source_aliases source
    left join public.athlete_aliases target
      on target.athlete_id = source.athlete_id
     and target.league_code = source.league_code
     and target.normalized_alias = source.normalized_alias
    where target.athlete_id is null
      or target.alias is distinct from source.alias
      or target.alias_type is distinct from source.alias_type
      or target.review_state is distinct from source.review_state
      or target.source_name is distinct from source.source_name
      or target.evidence is distinct from source.evidence
  ) then raise exception 'Commerce alias readback failed'; end if;
  if exists (
    select 1 from _source_external_ids source
    left join public.athlete_external_ids target
      on target.league_code = source.league_code
     and target.source_name = source.source_name
     and target.external_id = source.external_id
    where target.athlete_id is null
      or target.athlete_id is distinct from source.athlete_id
      or target.is_primary_for_source is distinct from source.is_primary_for_source
  ) then raise exception 'Commerce external ID readback failed'; end if;
  if exists (
    select 1 from _reviewed_mappings source
    left join public.product_athlete_mappings target
      on target.product_id = source.product_id
     and target.athlete_id = source.athlete_id
     and target.league_code = source.league_code
     and target.subject_order = source.subject_order
    where target.product_id is null
      or target.subject_role is distinct from source.subject_role
      or target.match_method is distinct from source.match_method
      or target.match_confidence is distinct from source.match_confidence
      or target.review_state is distinct from source.review_state
      or target.source_player_text is distinct from source.source_player_text
      or target.evidence is distinct from source.evidence
  ) then raise exception 'Commerce mapping readback failed'; end if;
end $$;

commit;
select json_build_object(
  'athleteIdentityCount', ${plan.athleteIds.length},
  'productCount', ${plan.products.length},
  'mappingRowCount', ${plan.mappingRows.length}
) as payload;
`;
}

export function parseSupabaseCliJson(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Supabase CLI did not return JSON.');
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* keep searching */ }
  }
  throw new Error('Supabase CLI returned malformed JSON.');
}

async function executeLinkedQuery(sql, workdir, label, dependencies = {}) {
  const outputDirectory = path.join(ROOT, 'outputs', 'pro-sports-mapping-sync-work');
  await fs.mkdir(outputDirectory, { recursive: true });
  const sqlFile = path.join(outputDirectory, `${label}.sql`);
  await fs.writeFile(sqlFile, sql, 'utf8');
  const installedNpx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const npxArgs = ['--yes', `supabase@${CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', workdir,
    '--file', sqlFile, '--output-format', 'json', '--agent', 'yes'];
  const command = await fs.access(installedNpx).then(() => process.execPath).catch(() => (
    process.platform === 'win32' ? 'npx.cmd' : 'npx'
  ));
  const args = command === process.execPath ? [installedNpx, ...npxArgs] : npxArgs;
  const spawnImpl = dependencies.spawnImpl || spawn;
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: ROOT,
      windowsHide: true,
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
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${label} failed: ${details.slice(0, 1600)}`);
  }
  return parseSupabaseCliJson(result.stdout)?.rows?.[0]?.payload || {};
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = optionsFromArgs(argv);
  const proposalPath = workspacePath(options.proposalPath, 'Proposal path');
  const preflightPath = workspacePath(options.preflightPath, 'Preflight path');
  const repairPath = workspacePath(options.repairPath, 'Repair path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const [proposalText, preflightText, repairText] = await Promise.all([
    fs.readFile(proposalPath, 'utf8'), fs.readFile(preflightPath, 'utf8'), fs.readFile(repairPath, 'utf8'),
  ]);
  const plan = buildSyncPlan({
    proposal: JSON.parse(proposalText),
    proposalSha256: sha256(proposalText),
    preflight: JSON.parse(preflightText),
    repairProposal: JSON.parse(repairText),
    preflightSha256: sha256(preflightText),
  });
  const execute = dependencies.executeLinkedQuery || executeLinkedQuery;
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.phase,
    proposalSha256: sha256(proposalText),
    preflightSha256: sha256(preflightText),
    repairProposalSha256: sha256(repairText),
    plannedIdentityRepairs: plan.repairs.length,
    plannedAthleteIdentities: plan.athleteIds.length,
    plannedProviderExternalIds: plan.identityRequests.length,
    plannedProducts: plan.products.length,
    plannedMappingRows: plan.mappingRows.length,
    commerceReady: plan.commerceReady,
    sourceSnapshotCounts: null,
    targetSnapshotCounts: null,
    appliedIdentityRepairs: 0,
    appliedAthleteIdentities: 0,
    appliedProducts: 0,
    appliedMappingRows: 0,
    publicationBoundary: { databaseWritesPerformed: false },
  };
  if (options.phase === 'analytics-repairs') {
    if (!plan.repairs.length) {
      throw new Error('No exact marker-only analytics repairs are pending in this private preflight.');
    }
    if (options.confirmation !== ANALYTICS_REPAIR_CONFIRMATION
      || process.env.PRO_SPORTS_MAPPING_ALLOW_ANALYTICS_REPAIR !== 'confirmed') {
      throw new Error(
        `Analytics repair requires --confirm=${ANALYTICS_REPAIR_CONFIRMATION} and PRO_SPORTS_MAPPING_ALLOW_ANALYTICS_REPAIR=confirmed.`,
      );
    }
    const analyticsBefore = await execute(
      buildAnalyticsSnapshotSql(plan.identityRequests, plan.repairs), ANALYTICS_WORKDIR,
      'analytics-before-repairs', dependencies,
    );
    report.sourceSnapshotCounts = {
      requested: (analyticsBefore.requested || []).length,
      athletes: (analyticsBefore.athletes || []).length,
      memberships: (analyticsBefore.memberships || []).length,
      aliases: (analyticsBefore.aliases || []).length,
      externalIds: (analyticsBefore.externalIds || []).length,
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDirectory = path.join(ROOT, 'outputs', 'backups', `pro-sports-mapping-${timestamp}`);
    await writeJson(path.join(backupDirectory, 'analytics-before.json'), analyticsBefore);
    await execute(buildAnalyticsRepairSql(plan.repairs), ANALYTICS_WORKDIR,
      'analytics-apply-repairs', dependencies);
    report.appliedIdentityRepairs = plan.repairs.length;
    const analyticsAfter = await execute(
      buildAnalyticsSnapshotSql(plan.identityRequests, plan.repairs), ANALYTICS_WORKDIR,
      'analytics-after-repairs', dependencies,
    );
    await writeJson(path.join(backupDirectory, 'analytics-after.json'), analyticsAfter);
    const postRepairPreflightPath = path.join(
      ROOT, 'outputs', `pro-sports-product-mapping-private-preflight-post-repair-${timestamp}.json`,
    );
    const invokePreflight = dependencies.runPrivatePreflight || runPrivatePreflight;
    const postRepairPreflight = await invokePreflight([
      `--proposal=${path.relative(ROOT, proposalPath).replace(/\\/g, '/')}`,
      `--report=${path.relative(ROOT, postRepairPreflightPath).replace(/\\/g, '/')}`,
    ], dependencies.privatePreflightDependencies || {});
    if (postRepairPreflight.proposalSha256 !== report.proposalSha256
      || (postRepairPreflight.dispositionCounts.ready_for_analytics_identity_repair_review || 0) !== 0) {
      throw new Error('Post-repair private preflight did not clear every reviewed analytics repair.');
    }
    report.backupDirectory = path.relative(ROOT, backupDirectory).replace(/\\/g, '/');
    report.postRepairPreflightPath = path.relative(ROOT, postRepairPreflightPath).replace(/\\/g, '/');
    report.nextRequiredStep = 'Regenerate the empty repair proposal from the post-repair preflight, then run a separate --apply-commerce command after review.';
    report.publicationBoundary.databaseWritesPerformed = true;
  } else if (options.phase === 'commerce-copy') {
    if (!plan.commerceReady) {
      throw new Error('Commerce copy is blocked until a refreshed private preflight has no pending analytics repairs.');
    }
    if (options.confirmation !== COMMERCE_COPY_CONFIRMATION
      || process.env.PRO_SPORTS_MAPPING_ALLOW_COMMERCE_WRITE !== 'confirmed') {
      throw new Error(
        `Commerce copy requires --confirm=${COMMERCE_COPY_CONFIRMATION} and PRO_SPORTS_MAPPING_ALLOW_COMMERCE_WRITE=confirmed.`,
      );
    }
    const analyticsBefore = await execute(
      buildAnalyticsSnapshotSql(plan.identityRequests), ANALYTICS_WORKDIR,
      'analytics-before-commerce-copy', dependencies,
    );
    const commerceBefore = await execute(
      buildCommerceSnapshotSql(plan), COMMERCE_WORKDIR, 'commerce-before-copy', dependencies,
    );
    report.sourceSnapshotCounts = {
      requested: (analyticsBefore.requested || []).length,
      athletes: (analyticsBefore.athletes || []).length,
      memberships: (analyticsBefore.memberships || []).length,
      aliases: (analyticsBefore.aliases || []).length,
      externalIds: (analyticsBefore.externalIds || []).length,
    };
    report.targetSnapshotCounts = {
      products: (commerceBefore.products || []).length,
      mappings: (commerceBefore.mappings || []).length,
      athletes: (commerceBefore.athletes || []).length,
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDirectory = path.join(ROOT, 'outputs', 'backups', `pro-sports-mapping-${timestamp}`);
    await Promise.all([
      writeJson(path.join(backupDirectory, 'analytics-before.json'), analyticsBefore),
      writeJson(path.join(backupDirectory, 'commerce-before.json'), commerceBefore),
    ]);
    const commerceResult = await execute(
      buildCommerceApplySql(analyticsBefore, plan), COMMERCE_WORKDIR,
      'commerce-apply-identities-mappings', dependencies,
    );
    const commerceAfter = await execute(
      buildCommerceSnapshotSql(plan), COMMERCE_WORKDIR, 'commerce-after-copy', dependencies,
    );
    await writeJson(path.join(backupDirectory, 'commerce-after.json'), commerceAfter);
    if ((commerceAfter.mappings || []).length !== plan.mappingRows.length
      || (commerceAfter.athletes || []).length !== plan.athleteIds.length) {
      throw new Error('Final commerce snapshot does not reconcile to the reviewed plan.');
    }
    report.appliedAthleteIdentities = Number(commerceResult.athleteIdentityCount || 0);
    report.appliedProducts = Number(commerceResult.productCount || 0);
    report.appliedMappingRows = Number(commerceResult.mappingRowCount || 0);
    report.backupDirectory = path.relative(ROOT, backupDirectory).replace(/\\/g, '/');
    report.publicationBoundary.databaseWritesPerformed = true;
  } else {
    const analyticsBefore = await execute(
      buildAnalyticsSnapshotSql(plan.identityRequests, plan.repairs), ANALYTICS_WORKDIR,
      'analytics-audit', dependencies,
    );
    const commerceBefore = await execute(
      buildCommerceSnapshotSql(plan), COMMERCE_WORKDIR, 'commerce-audit', dependencies,
    );
    report.sourceSnapshotCounts = {
      requested: (analyticsBefore.requested || []).length,
      athletes: (analyticsBefore.athletes || []).length,
      memberships: (analyticsBefore.memberships || []).length,
      aliases: (analyticsBefore.aliases || []).length,
      externalIds: (analyticsBefore.externalIds || []).length,
    };
    report.targetSnapshotCounts = {
      products: (commerceBefore.products || []).length,
      mappings: (commerceBefore.mappings || []).length,
      athletes: (commerceBefore.athletes || []).length,
    };
  }
  await writeJson(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
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
