import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessCrossProjectIdentityParity,
  buildAnalyticsIdentityCandidateQueue,
  foldIdentityName,
} from '../audit-nba-analytics-identity-candidates.mjs';

function mappedStatus(productId, playerName, playerId) {
  return {
    productId,
    status: 'mapped',
    mappings: [{ name: playerName, nbaPlayerId: playerId, athleteId: playerId }],
  };
}

test('cross-project identity parity requires ten matching public mappings', () => {
  const statuses = Array.from({ length: 10 }, (_, index) => (
    mappedStatus(index + 1, `Player ${index}`, `id-${index}`)
  ));
  const rows = Array.from({ length: 10 }, (_, index) => ({
    player_id: `id-${index}`,
    player_name: `Player ${index}`,
  }));
  assert.deepEqual(assessCrossProjectIdentityParity(statuses, rows), {
    minimumRequiredSample: 10,
    checkedMappingCount: 10,
    mismatchCount: 0,
    safeForCandidateIds: true,
    mismatches: [],
  });
});

test('identity folding removes only accents and punctuation differences', () => {
  assert.equal(foldIdentityName('Manu Ginóbili'), 'manu ginobili');
  assert.equal(foldIdentityName("De'Andre-Hunter"), 'deandre hunter');
  assert.notEqual(foldIdentityName('Corey Joseph'), foldIdentityName('Cory Joseph'));
});

test('analytics candidates require exact unique names and complete multi-subject identity', () => {
  const knownStatuses = Array.from({ length: 10 }, (_, index) => (
    mappedStatus(index + 1, `Known ${index}`, `known-${index}`)
  ));
  const analyticsRows = Array.from({ length: 10 }, (_, index) => ({
    player_id: `known-${index}`,
    player_name: `Known ${index}`,
  }));
  analyticsRows.push(
    { player_id: 'a', player_name: 'Exact A' },
    { player_id: 'b', player_name: 'Exact B' },
    { player_id: 'c', player_name: 'Ambiguous' },
    { player_id: 'd', player_name: 'Ambiguous' }
  );
  const result = buildAnalyticsIdentityCandidateQueue([
    ...knownStatuses,
    { productId: 20, productName: 'Complete', sourcePlayerText: 'Exact A | Exact B', status: 'empty' },
    { productId: 21, productName: 'Partial', sourcePlayerText: 'Exact A | Missing', status: 'empty' },
    { productId: 22, productName: 'Ambiguous', sourcePlayerText: 'Ambiguous', status: 'empty' },
  ], analyticsRows);
  assert.deepEqual(result.queue.map((item) => item.disposition), [
    'analytics_exact_identity_candidate',
    'unseen_analytics_name',
    'ambiguous_analytics_name',
  ]);
  assert.deepEqual(result.queue[0].proposed.map((item) => item.athleteId), ['a', 'b']);
  assert.equal(result.queue[0].nextAction, 'verify_commerce_alias_then_create_mapping');
  assert.equal(result.queue[1].proposed, null);
});

test('accent-only public identity differences remain reviewable candidates', () => {
  const knownStatuses = Array.from({ length: 10 }, (_, index) => (
    mappedStatus(index + 1, `Known ${index}`, `known-${index}`)
  ));
  const analyticsRows = Array.from({ length: 10 }, (_, index) => ({
    player_id: `known-${index}`,
    player_name: `Known ${index}`,
  }));
  analyticsRows.push({ player_id: 'manu-id', player_name: 'Manu Ginóbili' });
  const result = buildAnalyticsIdentityCandidateQueue([
    ...knownStatuses,
    { productId: 60, productName: 'Card', sourcePlayerText: 'Manu Ginobili', status: 'empty' },
  ], analyticsRows);
  assert.equal(result.queue[0].disposition, 'analytics_normalized_identity_candidate');
  assert.equal(result.queue[0].proposed[0].athleteId, 'manu-id');
  assert.equal(result.queue[0].evidence[0].matchMethod, 'diacritic_punctuation_fold');
});

test('suffix and single-character first-name differences are review-only suggestions', () => {
  const knownStatuses = Array.from({ length: 10 }, (_, index) => (
    mappedStatus(index + 1, `Known ${index}`, `known-${index}`)
  ));
  const analyticsRows = Array.from({ length: 10 }, (_, index) => ({
    player_id: `known-${index}`,
    player_name: `Known ${index}`,
  }));
  analyticsRows.push(
    { player_id: 'law-id', player_name: 'Acie Law' },
    { player_id: 'cory-id', player_name: 'Cory Joseph' }
  );
  const result = buildAnalyticsIdentityCandidateQueue([
    ...knownStatuses,
    { productId: 70, productName: 'Law', sourcePlayerText: 'Acie Law IV', status: 'empty' },
    { productId: 71, productName: 'Joseph', sourcePlayerText: 'Corey Joseph', status: 'empty' },
  ], analyticsRows);
  assert.deepEqual(result.queue.map((item) => item.disposition), [
    'likely_identity_review_candidate',
    'likely_identity_review_candidate',
  ]);
  assert.deepEqual(result.queue.map((item) => item.proposed), [null, null]);
  assert.deepEqual(result.queue.map((item) => item.suggested[0].reviewMethod), [
    'generational_suffix_removed',
    'single_character_first_name',
  ]);
});

test('identity namespace mismatch withholds otherwise exact proposals', () => {
  const statuses = Array.from({ length: 10 }, (_, index) => (
    mappedStatus(index + 1, `Player ${index}`, `id-${index}`)
  ));
  const rows = Array.from({ length: 10 }, (_, index) => ({
    player_id: index === 0 ? 'different-id' : `id-${index}`,
    player_name: `Player ${index}`,
  }));
  rows.push({ player_id: 'candidate-id', player_name: 'Candidate' });
  const result = buildAnalyticsIdentityCandidateQueue([
    ...statuses,
    { productId: 50, productName: 'Card', sourcePlayerText: 'Candidate', status: 'empty' },
  ], rows);
  assert.equal(result.parity.safeForCandidateIds, false);
  assert.equal(result.queue[0].disposition, 'identity_namespace_unverified');
  assert.equal(result.queue[0].proposed, null);
});

test('named team lots retain intentional blank player attributes', () => {
  const result = buildAnalyticsIdentityCandidateQueue([{
    productId: 80,
    productName: '2020-2025 Panini Chicago Bulls Base + SP + Insert Lot (x184)',
    sourcePlayerText: '',
    team: 'Chicago Bulls',
    status: 'empty',
  }], []);
  assert.equal(result.queue[0].disposition, 'intentionally_blank_team_lot');
  assert.equal(result.queue[0].nextAction, 'no_player_mapping_required');
  assert.equal(result.queue[0].confidence, 'high');
});
