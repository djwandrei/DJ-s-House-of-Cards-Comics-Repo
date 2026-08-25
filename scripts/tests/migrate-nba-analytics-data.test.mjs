import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyticsTableSpecs,
  orderAthletesByMergeDependency,
  parseContentRange,
  stableStringify,
} from '../migrate-nba-analytics-data.mjs';

test('analytics transition excludes commerce and product mapping tables', () => {
  const copied = analyticsTableSpecs.map((entry) => entry.table);
  assert.equal(copied.includes('products'), false);
  assert.equal(copied.includes('product_athlete_mappings'), false);
  assert.equal(copied.includes('orders'), false);
  assert.deepEqual(copied.slice(0, 6), [
    'sports',
    'sports_leagues',
    'athletes',
    'athlete_league_memberships',
    'athlete_aliases',
    'athlete_external_ids',
  ]);
  assert.equal(copied.at(-1), 'nba_stat_source_records');
});

test('stable stringify makes row fingerprints independent of object key order', () => {
  const left = { b: 2, nested: { z: 1, a: [3, { c: true, b: null }] }, a: 'value' };
  const right = { a: 'value', nested: { a: [3, { b: null, c: true }], z: 1 }, b: 2 };
  assert.equal(stableStringify(left), stableStringify(right));
});

test('content range parser requires an exact total', () => {
  assert.equal(parseContentRange('0-499/3270'), 3270);
  assert.throws(() => parseContentRange('0-499/*'), /exact content range/);
  assert.throws(() => parseContentRange(null), /exact content range/);
});

test('athlete merge rows are inserted only after their merge target', () => {
  const ordered = orderAthletesByMergeDependency([
    { id: 'merged', merged_into_athlete_id: 'canonical' },
    { id: 'canonical', merged_into_athlete_id: null },
    { id: 'independent', merged_into_athlete_id: null },
  ]);
  assert.deepEqual(ordered.map((row) => row.id), ['canonical', 'independent', 'merged']);
  assert.throws(
    () => orderAthletesByMergeDependency([
      { id: 'one', merged_into_athlete_id: 'two' },
      { id: 'two', merged_into_athlete_id: 'one' },
    ]),
    /cycle or reference/,
  );
});
