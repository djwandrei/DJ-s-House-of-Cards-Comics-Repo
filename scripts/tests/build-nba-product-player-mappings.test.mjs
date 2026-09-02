import assert from 'node:assert/strict';
import test from 'node:test';
import {
  optionsFromArgs,
  reconcilePlannedMappingsWithExisting,
  supabaseApiHeaders,
} from '../build-nba-product-player-mappings.mjs';

test('mapping CLI defaults to audit-only behavior', () => {
  assert.deepEqual(optionsFromArgs([]), {
    apply: false,
    catalogPath: 'products.json',
    reportPath: '',
    confirmation: '',
  });
});

test('mapping CLI parses explicit paths and the two-part apply gate', () => {
  assert.deepEqual(optionsFromArgs([
    '--catalog=fixtures/products.json',
    '--report=outputs/mapping.json',
    '--apply',
    '--confirm=insert-only-reviewed-nba-mappings',
  ]), {
    apply: true,
    catalogPath: 'fixtures/products.json',
    reportPath: 'outputs/mapping.json',
    confirmation: 'insert-only-reviewed-nba-mappings',
  });
});

test('mapping CLI rejects unknown or misspelled arguments', () => {
  assert.throws(() => optionsFromArgs(['--delete']), /Unknown argument/);
});

test('mapping API headers support legacy JWT and new opaque Supabase keys', () => {
  assert.deepEqual(supabaseApiHeaders('legacy-jwt-key'), {
    apikey: 'legacy-jwt-key',
    Authorization: 'Bearer legacy-jwt-key',
  });
  assert.deepEqual(supabaseApiHeaders('sb_secret_example'), {
    apikey: 'sb_secret_example',
  });
});

test('mapping reconciliation distinguishes exact, insertable, and partial existing products', () => {
  const proposed = [
    { product_id: 10, athlete_id: 'a', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
    { product_id: 20, athlete_id: 'b', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
    { product_id: 20, athlete_id: 'c', league_code: 'NBA', subject_order: 2, review_state: 'auto_verified' },
    { product_id: 30, athlete_id: 'd', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
  ];
  const existing = [
    { product_id: 10, athlete_id: 'a', league_code: 'NBA', subject_order: 1, review_state: 'human_verified' },
    { product_id: 20, athlete_id: 'b', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
  ];

  const result = reconcilePlannedMappingsWithExisting(proposed, existing);
  assert.deepEqual(result.exactExistingProductIds, [10]);
  assert.deepEqual(result.insertableMappings, [proposed[3]]);
  assert.equal(result.conflictingExisting.length, 1);
  assert.equal(result.conflictingExisting[0].productId, 20);
  assert.equal(result.conflictingExisting[0].classification, 'partial_existing_mapping');
  assert.deepEqual(result.existingWithoutPlan, []);
});

test('mapping reconciliation treats subject-order drift as a conflict', () => {
  const proposed = [
    { product_id: 40, athlete_id: 'a', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
    { product_id: 40, athlete_id: 'b', league_code: 'NBA', subject_order: 2, review_state: 'auto_verified' },
  ];
  const existing = [
    { product_id: 40, athlete_id: 'a', league_code: 'NBA', subject_order: 2, review_state: 'auto_verified' },
    { product_id: 40, athlete_id: 'b', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
  ];

  const result = reconcilePlannedMappingsWithExisting(proposed, existing);
  assert.deepEqual(result.exactExistingProductIds, []);
  assert.deepEqual(result.insertableMappings, []);
  assert.equal(result.conflictingExisting[0].classification, 'conflicting_existing_mapping');
});

test('mapping reconciliation reports duplicate existing rows and mappings without a current plan', () => {
  const proposed = [
    { product_id: 50, athlete_id: 'a', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
  ];
  const duplicate = {
    product_id: 50,
    athlete_id: 'a',
    league_code: 'NBA',
    subject_order: 1,
    review_state: 'auto_verified',
  };
  const existing = [
    duplicate,
    { ...duplicate },
    { product_id: 60, athlete_id: 'b', league_code: 'NBA', subject_order: 1, review_state: 'human_verified' },
  ];

  const result = reconcilePlannedMappingsWithExisting(proposed, existing);
  assert.deepEqual(result.exactExistingProductIds, []);
  assert.equal(result.conflictingExisting[0].classification, 'duplicate_existing_mapping');
  assert.equal(result.conflictingExisting[0].duplicateExistingRowCount, 1);
  assert.deepEqual(result.existingWithoutPlan.map((entry) => entry.productId), [60]);
});

test('mapping reconciliation does not label a shorter but conflicting mapping as partial', () => {
  const proposed = [
    { product_id: 70, athlete_id: 'a', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
    { product_id: 70, athlete_id: 'b', league_code: 'NBA', subject_order: 2, review_state: 'auto_verified' },
  ];
  const existing = [
    { product_id: 70, athlete_id: 'c', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
  ];

  const result = reconcilePlannedMappingsWithExisting(proposed, existing);
  assert.equal(result.conflictingExisting[0].classification, 'conflicting_existing_mapping');
  assert.equal(result.conflictingExisting[0].missingPlannedRowCount, 2);
  assert.equal(result.conflictingExisting[0].unexpectedExistingRowCount, 1);
});

test('mapping reconciliation ignores rejected history but blocks rejected-only and needs-review mappings', () => {
  const proposed = [
    { product_id: 80, athlete_id: 'a', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
    { product_id: 90, athlete_id: 'b', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
    { product_id: 100, athlete_id: 'c', league_code: 'NBA', subject_order: 1, review_state: 'auto_verified' },
  ];
  const result = reconcilePlannedMappingsWithExisting(proposed, [
    { product_id: 80, athlete_id: 'a', league_code: 'NBA', subject_order: 1, review_state: 'human_verified' },
    { product_id: 80, athlete_id: 'old', league_code: 'NBA', subject_order: 2, review_state: 'rejected' },
    { product_id: 90, athlete_id: 'b', league_code: 'NBA', subject_order: 1, review_state: 'rejected' },
    { product_id: 100, athlete_id: 'c', league_code: 'NBA', subject_order: 1, review_state: 'needs_review' },
  ]);

  assert.deepEqual(result.exactExistingProductIds, [80]);
  assert.deepEqual(result.conflictingExisting.map((entry) => [entry.productId, entry.classification]), [
    [90, 'rejected_existing_mapping'],
    [100, 'needs_review_existing_mapping'],
  ]);
});
