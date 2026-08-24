import assert from 'node:assert/strict';
import test from 'node:test';
import { optionsFromArgs } from '../build-nba-product-player-mappings.mjs';

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
