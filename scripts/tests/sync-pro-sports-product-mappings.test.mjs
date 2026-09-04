import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  analyticsTargetForLeagueCode,
  buildLinkedQueryArgs,
  buildAnalyticsRepairSql,
  buildAnalyticsSnapshotSql,
  buildCommerceApplySql,
  buildCommerceSnapshotSql,
  buildSyncPlan,
  mergeAnalyticsSnapshots,
  optionsFromArgs,
  partitionAnalyticsInputs,
  parseSupabaseCliJson,
} from '../sync-pro-sports-product-mappings.mjs';

const athleteId = '00000000-0000-0000-0000-000000000001';
const proposal = {
  mode: 'proposal_only',
  highConfidenceProductCount: 1,
  highConfidenceMappingRowCount: 1,
  highConfidenceProducts: [{
    productId: 10,
    productName: '2020 Player One',
    leagueCode: 'MLB',
    sourceName: 'baseball_reference',
    currentValues: { playerAthlete: 'Player One', team: 'Team One', year: 2020 },
    evidence: {
      team: { status: 'consistent', matchedTeams: ['Team One'] },
      year: { status: 'career_window_consistent' },
    },
    disposition: 'source_exact_unique_candidate',
    proposedSubjects: [{
      subjectOrder: 1,
      sourcePlayerText: 'Player One',
      matchMethod: 'provider_name_exact',
      providerExternalId: 'onepl01',
      providerCanonicalName: 'Player One',
    }],
  }],
};
const preflight = {
  mode: 'private_read_only_preflight',
  results: [{
    productId: 10,
    disposition: 'ready_for_identity_copy_review',
    subjects: [{
      subjectOrder: 1,
      providerExternalId: 'onepl01',
      analyticsAthleteId: athleteId,
    }],
  }],
};
const proposalHash = crypto.createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
preflight.proposalSha256 = proposalHash;
const preflightText = `${JSON.stringify(preflight, null, 2)}\n`;
const preflightHash = crypto.createHash('sha256').update(preflightText).digest('hex');
const repairProposal = {
  mode: 'proposal_only',
  sourcePreflightSha256: preflightHash,
  sourceProposalSha256: proposalHash,
  repairIdentityCount: 0,
  affectedProductCount: 0,
  repairs: [],
};

test('sync plan preserves reviewed identity, subject order, and source evidence', () => {
  const plan = buildSyncPlan({ proposal, proposalSha256: proposalHash, preflight, repairProposal, preflightSha256: preflightHash });
  assert.equal(plan.products.length, 1);
  assert.equal(plan.identityRequests.length, 1);
  assert.equal(plan.mappingRows.length, 1);
  assert.equal(plan.mappingRows[0].athlete_id, athleteId);
  assert.equal(plan.mappingRows[0].review_state, 'auto_verified');
  assert.equal(plan.mappingRows[0].match_method, 'external_id');
  assert.equal(plan.mappingRows[0].evidence.providerExternalId, 'onepl01');
  assert.equal(plan.mappingRows[0].evidence.teamEvidence.status, 'consistent');
});

test('sync plan fails closed when the repair artifact is stale', () => {
  assert.throws(() => buildSyncPlan({
    proposal,
    proposalSha256: proposalHash,
    preflight,
    repairProposal: { ...repairProposal, sourcePreflightSha256: 'stale' },
    preflightSha256: preflightHash,
  }), /does not match/);
});

test('sync plan rejects a high-confidence product marked pending catalog correction', () => {
  const heldProposal = {
    ...proposal,
    highConfidenceProducts: [{
      ...proposal.highConfidenceProducts[0],
      requiresCatalogCorrectionBeforeMapping: true,
    }],
  };
  const heldHash = crypto.createHash('sha256').update(JSON.stringify(heldProposal)).digest('hex');
  const heldPreflight = { ...preflight, proposalSha256: heldHash };
  const heldPreflightText = `${JSON.stringify(heldPreflight, null, 2)}\n`;
  const heldPreflightHash = crypto.createHash('sha256').update(heldPreflightText).digest('hex');
  const heldRepairProposal = {
    ...repairProposal,
    sourcePreflightSha256: heldPreflightHash,
    sourceProposalSha256: heldHash,
  };
  assert.throws(() => buildSyncPlan({
    proposal: heldProposal,
    proposalSha256: heldHash,
    preflight: heldPreflight,
    repairProposal: heldRepairProposal,
    preflightSha256: heldPreflightHash,
  }), /requires a catalog correction before mapping/);
});

test('sync plan rejects a proposal whose subject rows do not match the current catalog player list', () => {
  const malformedProposal = {
    ...proposal,
    highConfidenceProductCount: 1,
    highConfidenceMappingRowCount: 2,
    highConfidenceProducts: [{
      ...proposal.highConfidenceProducts[0],
      proposedSubjects: [
        ...proposal.highConfidenceProducts[0].proposedSubjects,
        {
          subjectOrder: 2,
          sourcePlayerText: 'Player Two',
          providerExternalId: 'twopl02',
          providerCanonicalName: 'Player Two',
        },
      ],
    }],
  };
  const malformedHash = crypto.createHash('sha256').update(JSON.stringify(malformedProposal)).digest('hex');
  const malformedPreflight = {
    mode: 'private_read_only_preflight', proposalSha256: malformedHash,
    results: [{
      productId: 10, disposition: 'ready_for_identity_copy_review',
      subjects: [
        ...preflight.results[0].subjects,
        { subjectOrder: 2, providerExternalId: 'twopl02', analyticsAthleteId: athleteId },
      ],
    }],
  };
  const malformedPreflightText = `${JSON.stringify(malformedPreflight, null, 2)}\n`;
  const malformedPreflightHash = crypto.createHash('sha256').update(malformedPreflightText).digest('hex');
  const malformedRepairProposal = {
    mode: 'proposal_only', sourcePreflightSha256: malformedPreflightHash,
    sourceProposalSha256: malformedHash, repairIdentityCount: 0, affectedProductCount: 0, repairs: [],
  };
  assert.throws(() => buildSyncPlan({
    proposal: malformedProposal, proposalSha256: malformedHash, preflight: malformedPreflight,
    repairProposal: malformedRepairProposal, preflightSha256: malformedPreflightHash,
  }), /does not resolve every current catalog subject/);
});

test('sync plan rejects a repair artifact that differs from marker-only preflight evidence', () => {
  const markerPreflight = {
    ...preflight,
    results: [{
      productId: 10, leagueCode: 'MLB', sourceName: 'baseball_reference',
      disposition: 'ready_for_analytics_identity_repair_review',
      subjects: [{
        subjectOrder: 1, providerExternalId: 'onepl01', analyticsAthleteId: athleteId,
        markerOnlyNameDrift: true, analyticsCanonicalName: 'Player One #', analyticsNormalizedName: 'player one #',
        providerCanonicalName: 'Player One', providerNormalizedName: 'player one',
      }],
    }],
  };
  const markerPreflightText = `${JSON.stringify(markerPreflight, null, 2)}\n`;
  const markerPreflightHash = crypto.createHash('sha256').update(markerPreflightText).digest('hex');
  const markerRepairProposal = {
    mode: 'proposal_only',
    sourcePreflightSha256: markerPreflightHash,
    sourceProposalSha256: proposalHash,
    repairIdentityCount: 1,
    affectedProductCount: 1,
    repairs: [{
      leagueCode: 'MLB', sourceName: 'baseball_reference', athleteId, providerExternalId: 'onepl01',
      currentCanonicalName: 'Player One #', currentNormalizedName: 'player one #',
      proposedCanonicalName: 'Player One', normalizedName: 'player one', affectedProductIds: [99],
    }],
  };
  assert.throws(() => buildSyncPlan({
    proposal, proposalSha256: proposalHash, preflight: markerPreflight,
    repairProposal: markerRepairProposal, preflightSha256: markerPreflightHash,
  }), /not an exact match/);
});

test('one athlete with two reviewed provider IDs remains one commerce identity', () => {
  const multiProposal = {
    ...proposal,
    highConfidenceProductCount: 2,
    highConfidenceMappingRowCount: 2,
    highConfidenceProducts: [
      ...proposal.highConfidenceProducts,
      {
        ...proposal.highConfidenceProducts[0], productId: 11, productName: '2021 Player One',
        currentValues: { playerAthlete: 'Player One', team: 'Team One', year: 2021 },
        proposedSubjects: [{
          ...proposal.highConfidenceProducts[0].proposedSubjects[0], providerExternalId: 'onepl02',
        }],
      },
    ],
  };
  const multiHash = crypto.createHash('sha256').update(JSON.stringify(multiProposal)).digest('hex');
  const multiPreflight = {
    mode: 'private_read_only_preflight', proposalSha256: multiHash,
    results: [
      ...preflight.results,
      {
        productId: 11, disposition: 'ready_for_identity_copy_review',
        subjects: [{ subjectOrder: 1, providerExternalId: 'onepl02', analyticsAthleteId: athleteId }],
      },
    ],
  };
  const multiPreflightText = `${JSON.stringify(multiPreflight, null, 2)}\n`;
  const multiPreflightHash = crypto.createHash('sha256').update(multiPreflightText).digest('hex');
  const multiRepairs = {
    mode: 'proposal_only', sourcePreflightSha256: multiPreflightHash,
    sourceProposalSha256: multiHash, repairIdentityCount: 0, affectedProductCount: 0, repairs: [],
  };
  const plan = buildSyncPlan({
    proposal: multiProposal, proposalSha256: multiHash, preflight: multiPreflight,
    repairProposal: multiRepairs, preflightSha256: multiPreflightHash,
  });
  assert.equal(plan.identityRequests.length, 2);
  assert.deepEqual(plan.athleteIds, [athleteId]);
  assert.match(buildCommerceSnapshotSql(plan), new RegExp(`where id in \\('${athleteId}'::uuid\\)`));
});

test('snapshot queries are read-only and apply queries are transaction guarded', () => {
  const plan = buildSyncPlan({ proposal, proposalSha256: proposalHash, preflight, repairProposal, preflightSha256: preflightHash });
  const analyticsSnapshot = buildAnalyticsSnapshotSql(plan.identityRequests);
  const commerceSnapshot = buildCommerceSnapshotSql(plan);
  assert.doesNotMatch(analyticsSnapshot, /\b(?:insert|update|delete|alter|drop|truncate)\b/i);
  assert.doesNotMatch(commerceSnapshot, /\b(?:insert|update|delete|alter|drop|truncate)\b/i);
  assert.match(analyticsSnapshot, /requested_memberships/);
  assert.match(analyticsSnapshot, /requested_aliases/);
  assert.match(analyticsSnapshot, /order by memberships\.athlete_id, memberships\.league_code/);
  assert.match(analyticsSnapshot, /order by aliases\.athlete_id, aliases\.league_code, aliases\.normalized_alias/);
  assert.match(analyticsSnapshot, /order by ids\.athlete_id, ids\.league_code, ids\.source_name, ids\.external_id/);
  assert.doesNotMatch(analyticsSnapshot, /league_code in \('MLB', 'NFL'\)/);

  const source = {
    requested: [{
      league_code: 'MLB', source_name: 'baseball_reference', external_id: 'onepl01',
      expected_athlete_id: athleteId, expected_name: 'Player One', athlete_id: athleteId,
    }],
    sports: [{ sport_code: 'baseball', display_name: 'Baseball', is_active: true }],
    leagues: [{ league_code: 'MLB', sport_code: 'baseball', display_name: 'Major League Baseball', is_active: true }],
    athletes: [{
      id: athleteId, canonical_name: 'Player One', normalized_name: 'player one', birth_date: null,
      identity_status: 'active', merged_into_athlete_id: null, metadata: {},
    }],
    memberships: [{
      athlete_id: athleteId, league_code: 'MLB', membership_status: 'verified',
      source_name: 'baseball_reference', evidence: {},
    }],
    aliases: [{
      athlete_id: athleteId, league_code: 'MLB', alias: 'Player One', normalized_alias: 'player one',
      alias_type: 'canonical', review_state: 'verified', source_name: 'baseball_reference', evidence: {},
    }],
    externalIds: [{
      athlete_id: athleteId, league_code: 'MLB', source_name: 'baseball_reference',
      external_id: 'onepl01', is_primary_for_source: true,
    }],
  };
  const applySql = buildCommerceApplySql(source, plan);
  assert.match(applySql, /^\s*begin;/i);
  assert.match(applySql, /Commerce product drift blocks mapping sync/);
  assert.match(applySql, /Existing product mapping rows block insert-only sync/);
  assert.match(applySql, /Commerce membership conflict blocks sync/);
  assert.match(applySql, /Commerce alias ownership conflict blocks sync/);
  assert.match(applySql, /Commerce external ID readback failed/);
  assert.match(applySql, /commit;/i);
  assert.doesNotMatch(applySql, /\bdelete\b/i);
});

test('analytics sync splits MLB and NFL work by explicit project target', () => {
  const nflRequest = {
    league_code: 'NFL', source_name: 'pro_football_reference', external_id: 'nflone01',
    athlete_id: athleteId, canonical_name: 'Player Two',
  };
  const partitions = partitionAnalyticsInputs([
    { league_code: 'MLB', source_name: 'baseball_reference', external_id: 'onepl01', athlete_id: athleteId, canonical_name: 'Player One' },
    nflRequest,
  ]);
  assert.deepEqual(partitions.map((partition) => ({
    leagueCode: partition.leagueCode,
    sport: partition.sport,
    projectRef: partition.target.projectRef,
  })), [
    { leagueCode: 'MLB', sport: 'mlb', projectRef: 'sptahazcjnorayjkltdx' },
    { leagueCode: 'NFL', sport: 'nfl', projectRef: 'iuhjjwqfkohrrjqgpahh' },
  ]);
  assert.equal(analyticsTargetForLeagueCode('nfl').playerTable, 'nfl_players');
  assert.throws(() => buildAnalyticsSnapshotSql([
    { league_code: 'MLB', source_name: 'baseball_reference', external_id: 'onepl01', athlete_id: athleteId, canonical_name: 'Player One' },
    nflRequest,
  ]), /exactly one league target/);
  const args = buildLinkedQueryArgs('supabase-sports-analytics', 'targeted.sql', partitions[0].target.projectRef);
  assert.equal(args[args.indexOf('--project-ref') + 1], 'sptahazcjnorayjkltdx');
  assert.throws(() => partitionAnalyticsInputs([
    { league_code: 'NBA', source_name: 'basketball_reference', external_id: 'nbaone01', athlete_id: athleteId, canonical_name: 'Player Three' },
  ]), /Unsupported pro-sports analytics league/);
});

test('analytics snapshots merge split-target reads and reject conflicts', () => {
  const mlbSnapshot = {
    requested: [{ league_code: 'MLB', source_name: 'baseball_reference', external_id: 'onepl01', athlete_id: athleteId }],
    sports: [{ sport_code: 'baseball' }],
    leagues: [{ league_code: 'MLB' }],
    athletes: [{ id: athleteId, canonical_name: 'Player One' }],
    memberships: [{ athlete_id: athleteId, league_code: 'MLB' }],
    aliases: [{ athlete_id: athleteId, league_code: 'MLB', normalized_alias: 'player one' }],
    externalIds: [{ athlete_id: athleteId, league_code: 'MLB', source_name: 'baseball_reference', external_id: 'onepl01' }],
    repairProfiles: { mlb: [{ athlete_id: athleteId, full_name: 'Player One' }], nfl: [] },
  };
  const nflSnapshot = {
    requested: [{ league_code: 'NFL', source_name: 'pro_football_reference', external_id: 'nflone01', athlete_id: athleteId }],
    sports: [{ sport_code: 'football' }],
    leagues: [{ league_code: 'NFL' }],
    athletes: [{ id: athleteId, canonical_name: 'Player One' }],
    memberships: [{ athlete_id: athleteId, league_code: 'NFL' }],
    aliases: [{ athlete_id: athleteId, league_code: 'NFL', normalized_alias: 'player one' }],
    externalIds: [{ athlete_id: athleteId, league_code: 'NFL', source_name: 'pro_football_reference', external_id: 'nflone01' }],
    repairProfiles: { mlb: [], nfl: [{ athlete_id: athleteId, full_name: 'Player One' }] },
  };
  const merged = mergeAnalyticsSnapshots([nflSnapshot, mlbSnapshot]);
  assert.deepEqual(merged.requested.map((row) => row.league_code), ['MLB', 'NFL']);
  assert.deepEqual(merged.sports.map((row) => row.sport_code), ['baseball', 'football']);
  assert.deepEqual(merged.repairProfiles.mlb.map((row) => row.athlete_id), [athleteId]);
  assert.deepEqual(merged.repairProfiles.nfl.map((row) => row.athlete_id), [athleteId]);
  assert.throws(() => mergeAnalyticsSnapshots([
    mlbSnapshot,
    { ...mlbSnapshot, athletes: [{ id: athleteId, canonical_name: 'Different Player' }] },
  ]), /Conflicting athletes rows/);
});

test('marker repair is limited to reviewed identities and verifies readback', () => {
  const sql = buildAnalyticsRepairSql([{
    athleteId,
    leagueCode: 'MLB',
    sourceName: 'baseball_reference',
    providerExternalId: 'onepl01',
    currentCanonicalName: 'Player One #',
    currentNormalizedName: 'player one #',
    proposedCanonicalName: 'Player One',
    normalizedName: 'player one',
  }]);
  assert.match(sql, /_reviewed_identity_repairs/);
  assert.match(sql, /Athlete identity drift blocks the reviewed repair/);
  assert.match(sql, /Alias repair readback failed/);
  assert.doesNotMatch(sql, /\bdelete\b/i);
});

test('CLI JSON parser ignores surrounding status output', () => {
  const parsed = parseSupabaseCliJson('Connecting...\n{"rows":[{"payload":{"ok":true}}]}\nDone');
  assert.equal(parsed.rows[0].payload.ok, true);
});

test('combined mapping apply is disabled in favor of separate reviewed phases', () => {
  assert.throws(() => optionsFromArgs(['--apply']), /combined apply mode is disabled/);
  assert.equal(optionsFromArgs(['--apply-analytics-repairs']).phase, 'analytics-repairs');
  assert.equal(optionsFromArgs(['--apply-commerce']).phase, 'commerce-copy');
});
