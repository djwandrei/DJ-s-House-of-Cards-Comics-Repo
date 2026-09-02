import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractPublicMappingStatus,
  optionsFromArgs,
  selectCoverageProducts,
} from '../audit-public-nba-product-mapping-status.mjs';

test('public mapping audit defaults to exact expansion candidates', () => {
  assert.deepEqual(optionsFromArgs([]), {
    coveragePath: 'outputs/nba-product-mapping-coverage.json',
    reportPath: 'outputs/nba-product-mapping-live-status.json',
    all: false,
    concurrency: 6,
  });
});

test('coverage selection is deterministic and can include the full queue', () => {
  const coverage = {
    queue: [
      { productId: 8, disposition: 'unseen_verified_name', current: { productName: 'B', playerAthlete: 'B' } },
      { productId: 3, disposition: 'source_consistent_exact_candidate', current: { productName: 'A', playerAthlete: 'A' } },
    ],
  };
  assert.deepEqual(selectCoverageProducts(coverage), [{
    productId: 3,
    productName: 'A',
    sourcePlayerText: 'A',
    team: '',
    priorDisposition: 'source_consistent_exact_candidate',
  }]);
  assert.deepEqual(selectCoverageProducts(coverage, true).map((item) => item.productId), [3, 8]);
});

test('public status extracts mapping identity and omits season payloads', () => {
  const result = extractPublicMappingStatus(
    { productId: 10, productName: 'Card', sourcePlayerText: 'Player', priorDisposition: 'candidate' },
    {
      productId: 10,
      players: [{
        mapping: { subjectOrder: 1, reviewState: 'auto_verified' },
        player: { athleteId: 'athlete-1', nbaPlayerId: 'nba-1', name: 'Player' },
        seasons: [{ points: 999 }],
      }],
    }
  );
  assert.equal(result.status, 'mapped');
  assert.deepEqual(result.mappings, [{
    subjectOrder: 1,
    athleteId: 'athlete-1',
    nbaPlayerId: 'nba-1',
    name: 'Player',
    reviewState: 'auto_verified',
  }]);
  assert.equal('seasons' in result, false);
});

test('public status fails closed on wrong-product or non-contiguous payloads', () => {
  const product = { productId: 10, productName: 'Card', sourcePlayerText: 'Player', priorDisposition: 'candidate' };
  const wrongProduct = extractPublicMappingStatus(product, {
    productId: 11,
    players: [{ mapping: { subjectOrder: 1, reviewState: 'auto_verified' }, player: { athleteId: 'a', name: 'Player' } }],
  });
  assert.equal(wrongProduct.status, 'invalid_payload');
  const nonContiguous = extractPublicMappingStatus(product, {
    productId: 10,
    players: [
      { mapping: { subjectOrder: 1, reviewState: 'auto_verified' }, player: { athleteId: 'a', name: 'Player A' } },
      { mapping: { subjectOrder: 3, reviewState: 'auto_verified' }, player: { athleteId: 'b', name: 'Player B' } },
    ],
  });
  assert.equal(nonContiguous.status, 'invalid_payload');
});
