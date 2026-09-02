import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateNbaMappingPrivatePreflight } from '../audit-nba-product-mapping-private-preflight.mjs';

const proposal = {
  mode: 'proposal_only',
  highConfidenceProducts: [{
    productId: 10,
    productName: 'Card',
    currentValues: { playerAthlete: 'Player', team: 'Team', publicMappingStatus: 'empty' },
    proposedSubjects: [{ subjectOrder: 1, sourcePlayerText: 'Player', proposedAthleteId: 'athlete-1' }],
  }],
};

function remote(overrides = {}) {
  return {
    products: [{ id: 10, category: 'Basketball', league: 'NBA', is_deleted: false, sale_status: 'available', player_athlete: 'Player', team: 'Team' }],
    athletes: [{ id: 'athlete-1', identity_status: 'active' }],
    memberships: [{ athlete_id: 'athlete-1', league_code: 'NBA', membership_status: 'verified' }],
    aliases: [],
    mappings: [],
    ...overrides,
  };
}

test('private preflight routes a valid missing alias to alias review', () => {
  const result = evaluateNbaMappingPrivatePreflight(proposal, remote());
  assert.deepEqual(result.dispositionCounts, { ready_for_alias_review: 1 });
  assert.equal(result.results[0].checks.identityChecksPass, true);
});

test('private preflight routes a verified unique alias to mapping review', () => {
  const result = evaluateNbaMappingPrivatePreflight(proposal, remote({
    aliases: [{ athlete_id: 'athlete-1', normalized_alias: 'player', review_state: 'verified' }],
  }));
  assert.deepEqual(result.dispositionCounts, { ready_for_mapping_review: 1 });
});

test('private preflight blocks catalog drift, alias conflicts, and existing mappings', () => {
  const result = evaluateNbaMappingPrivatePreflight(proposal, remote({
    products: [{ id: 10, category: 'Basketball', league: 'NBA', is_deleted: false, sale_status: 'available', player_athlete: 'Changed', team: 'Team' }],
    aliases: [{ athlete_id: 'other', normalized_alias: 'player', review_state: 'verified' }],
    mappings: [{ product_id: 10, athlete_id: 'other', review_state: 'needs_review', subject_order: 1 }],
  }));
  assert.deepEqual(result.dispositionCounts, { blocked: 1 });
  assert.equal(result.results[0].checks.catalogValuesMatch, false);
  assert.equal(result.results[0].checks.existingMappingRowCount, 1);
  assert.deepEqual(result.results[0].subjects[0].conflictingAliasAthleteIds, ['other']);
});
