import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBoundaryRoleCountsToShard } from '../repair-scout-boundary-role-counts.mjs';

function counts(entries = {}) {
  return {
    playerStarterCounts: new Map(entries.playerStarterCounts ?? []),
    playerCloserCounts: new Map(entries.playerCloserCounts ?? []),
    lineupStarterCounts: new Map(entries.lineupStarterCounts ?? []),
    lineupCloserCounts: new Map(entries.lineupCloserCounts ?? []),
  };
}

test('role-only repair updates only boundary-role fields and rates', () => {
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const lineupKey = `team-a~5~${ids.join('|')}`;
  const shard = {
    team: { teamId: 'team-a' },
    lineupsAndCombinations: [{
      size: 5,
      playerIds: ids,
      contexts: { all: { games: 5, netRating: 12 } },
      continuity: {
        exactLineupStartingGames: 2,
        exactLineupClosingGames: 3,
        exactLineupStartRate: 0.4,
        exactLineupCloseRate: 0.6,
        caveat: 'old',
      },
    }],
    playerProfiles: [{
      playerId: 'a5',
      gamesAppeared: 5,
      starterGames: 2,
      closerGames: 6,
      starterGameRate: 0.4,
      closerGameRate: 1.2,
      shooting: { fieldGoalPercentage: 0.5 },
    }],
  };
  const result = applyBoundaryRoleCountsToShard(shard, counts({
    playerStarterCounts: [['team-a~a5', 1]],
    playerCloserCounts: [['team-a~a5', 5]],
    lineupStarterCounts: [[lineupKey, 1]],
    lineupCloserCounts: [[lineupKey, 5]],
  }));

  assert.equal(result.changed, true);
  assert.equal(shard.lineupsAndCombinations[0].contexts.all.netRating, 12);
  assert.equal(shard.lineupsAndCombinations[0].continuity.exactLineupClosingGames, 5);
  assert.equal(shard.lineupsAndCombinations[0].continuity.exactLineupCloseRate, 1);
  assert.match(shard.lineupsAndCombinations[0].continuity.caveat, /zero-possession/);
  assert.equal(shard.playerProfiles[0].starterGames, 1);
  assert.equal(shard.playerProfiles[0].closerGames, 5);
  assert.equal(shard.playerProfiles[0].starterGameRate, 0.2);
  assert.equal(shard.playerProfiles[0].closerGameRate, 1);
  assert.equal(shard.playerProfiles[0].shooting.fieldGoalPercentage, 0.5);
});

test('role-only repair rejects counts greater than possession-defined games appeared', () => {
  const shard = {
    team: { teamId: 'team-a' },
    lineupsAndCombinations: [],
    playerProfiles: [{ playerId: 'a1', gamesAppeared: 1 }],
  };
  assert.throws(
    () => applyBoundaryRoleCountsToShard(shard, counts({ playerCloserCounts: [['team-a~a1', 2]] })),
    /exceeds games appeared/,
  );
});
