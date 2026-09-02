import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNbaProductMappingCoverage } from '../lib/nba-product-mapping-coverage.mjs';

const product = (overrides = {}) => ({
  id: 1,
  name: '2024-25 Test Card',
  category: 'Basketball',
  league: 'NBA',
  playerAthlete: 'Player One',
  team: 'Test Team',
  ...overrides,
});

const mapping = (overrides = {}) => ({
  product_id: 1,
  athlete_id: 'athlete-one',
  league_code: 'NBA',
  review_state: 'auto_verified',
  subject_order: 1,
  ...overrides,
});

test('coverage proposes only exact names already consistent across verified mappings', () => {
  const result = buildNbaProductMappingCoverage({
    products: [
      product(),
      product({ id: 2 }),
      product({ id: 3, playerAthlete: 'Unknown Player' }),
      product({ id: 4, playerAthlete: '' }),
    ],
    mappingRows: [mapping()],
  });

  assert.deepEqual(result.summary, {
    catalogProductCount: 4,
    eligibleNbaProductCount: 4,
    mappedCurrentProductCount: 1,
    unmappedCurrentProductCount: 3,
    exactExpansionCandidateCount: 1,
    mappedEvidenceIssueCount: 0,
    staleSnapshotProductCount: 0,
    dispositionCounts: {
      source_consistent_exact_candidate: 1,
      unseen_verified_name: 1,
      missing_player_text: 1,
    },
  });
  assert.equal(result.queue[0].productId, 2);
  assert.equal(result.queue[0].proposed[0].athleteId, 'athlete-one');
  assert.equal(result.queue[1].proposed, null);
});

test('coverage fails closed on conflicting names, partial evidence, and stale snapshot rows', () => {
  const result = buildNbaProductMappingCoverage({
    products: [
      product(),
      product({ id: 2, playerAthlete: 'Player One' }),
      product({ id: 3, playerAthlete: 'Player One|Player Two' }),
    ],
    mappingRows: [
      mapping(),
      mapping({ product_id: 2, athlete_id: 'athlete-other' }),
      mapping({ product_id: 99 }),
    ],
  });

  assert.equal(result.queue[0].productId, 3);
  assert.equal(result.queue[0].disposition, 'conflicting_verified_name_evidence');
  assert.deepEqual(result.staleSnapshotProductIds, [99]);
});
