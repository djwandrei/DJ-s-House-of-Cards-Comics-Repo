import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCombinationContinuity } from '../validate-local-scout-analytics.mjs';

function exactLineup({ games = 3, starters = 1, closers = 2 } = {}) {
  return {
    size: 5,
    contexts: { all: { games } },
    continuity: {
      exactLineupStartingGames: starters,
      exactLineupClosingGames: closers,
      exactLineupStartRate: games > 0 ? Math.round((starters / games) * 10_000) / 10_000 : null,
      exactLineupCloseRate: games > 0 ? Math.round((closers / games) * 10_000) / 10_000 : null,
    },
  };
}

test('exact-lineup continuity validates role counts and rates against games used', () => {
  const validErrors = [];
  checkCombinationContinuity(exactLineup(), '0.0', validErrors);
  assert.deepEqual(validErrors, []);

  const invalid = exactLineup({ games: 2, starters: 3, closers: 1 });
  invalid.continuity.exactLineupCloseRate = 0.9;
  const errors = [];
  checkCombinationContinuity(invalid, '0.1', errors);
  assert.match(errors.join('\n'), /StartingGames exceeds games used/);
  assert.match(errors.join('\n'), /CloseRate does not reconcile/);
});

test('co-presence continuity rejects exact-lineup role fields', () => {
  const row = {
    size: 4,
    contexts: { all: { games: 2 } },
    continuity: {
      exactLineupStartingGames: 1,
      exactLineupClosingGames: null,
      exactLineupStartRate: 0.5,
      exactLineupCloseRate: null,
    },
  };
  const errors = [];
  checkCombinationContinuity(row, '0.2', errors);
  assert.match(errors.join('\n'), /must be null/);
});
