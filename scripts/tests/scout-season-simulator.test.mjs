import test from 'node:test';
import assert from 'node:assert/strict';
import { roundRobinSchedule, rankLeagueTable, playoffSeedOrder, simulateLeague } from '../../tools/scout-studio/season-simulator.js';
import { createScenarioRandom } from '../../tools/scout-studio/possession-simulator.js';
import { fixtureSource, snapshot } from './fixtures/scout-studio-fixture.mjs';

const source = fixtureSource();
const first = await source.teamContexts('t0', snapshot), second = await source.teamContexts('t1', snapshot);
const teams = [first, second, { ...structuredClone(first), team: 't2' }, { ...structuredClone(second), team: 't3' }];
const input = { teams, season: 2024, seed: 'league-test', trials: 50, playoffTeams: 4, cycles: 2, seriesLength: 3 };

test('round-robin schedules conserve pairings, byes, rounds and two-cycle home/away balance', () => {
  for (const size of [2, 3, 4, 5, 8, 15, 30]) {
    const ids = Array.from({ length: size }, (_, index) => `t${index}`), schedule = roundRobinSchedule(ids);
    assert.equal(schedule.length, size * (size - 1));
    assert.deepEqual(schedule, roundRobinSchedule([...ids].reverse()));
    for (const id of ids) {
      assert.equal(schedule.filter(game => game.home === id).length, size - 1);
      assert.equal(schedule.filter(game => game.away === id).length, size - 1);
      for (const other of ids.filter(team => team !== id)) assert.equal(schedule.filter(game => game.home === id && game.away === other).length, 1);
    }
    for (const round of new Set(schedule.map(game => game.round))) {
      const playing = schedule.filter(game => game.round === round).flatMap(game => [game.home, game.away]);
      assert.equal(new Set(playing).size, playing.length);
    }
  }
});

test('unsupported teams, duplicates, cycles and bracket sizes are rejected', () => {
  for (const ids of [[], ['t0'], ['t0', 't0'], ['t0', 'private-id'], ['t0', 't30']]) assert.throws(() => roundRobinSchedule(ids));
  for (const cycles of [0, 5, 2.2, NaN]) assert.throws(() => roundRobinSchedule(['t0', 't1'], cycles));
  assert.throws(() => playoffSeedOrder(3));
  assert.deepEqual(playoffSeedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('standings use table points then differential and explicitly mark exact-tie lotteries', () => {
  const row = { wins: 2, losses: 2, ties: 0, pointsFor: 400, pointsAgainst: 400 };
  const table = [{ ...row, team: 't0' }, { ...row, team: 't1' }, { ...row, team: 't2', wins: 3 }, { ...row, team: 't3', pointsFor: 401 }];
  const ranked = rankLeagueTable(table, createScenarioRandom('ties'));
  assert.equal(ranked[0].team, 't2'); assert.equal(ranked[1].team, 't3');
  assert.ok(ranked.slice(2).every(row => row.seedLottery));
  assert.deepEqual(ranked, rankLeagueTable([...table].reverse(), createScenarioRandom('ties')));
  const winners = new Set(Array.from({ length: 20 }, (_, seed) => rankLeagueTable(table.slice(0, 2), createScenarioRandom(`tie-${seed}`))[0].team));
  assert.equal(winners.size, 2, 'Opaque handle order must not always win a tied seed');
});

test('league results are reproducible, input-order independent and conserve wins, games and seed counts', async () => {
  const before = structuredClone(input), report = await simulateLeague(input);
  assert.deepEqual(report, await simulateLeague({ ...input, teams: [...teams].reverse() }));
  assert.deepEqual(input, before);
  assert.equal(report.regularGamesPerExperiment, 12);
  assert.equal(report.example.schedule.length, 12);
  assert.equal(report.example.table.reduce((sum, row) => sum + row.pointsFor - row.pointsAgainst, 0), 0);
  assert.equal(report.example.table.reduce((sum, row) => sum + row.wins - row.losses, 0), 0);
  assert.equal(report.example.table.reduce((sum, row) => sum + row.played, 0), 24);
  assert.equal(report.teams.reduce((sum, row) => sum + row.titles, 0) + report.unresolvedTitles, 50);
  assert.equal(report.teams.reduce((sum, row) => sum + row.playoffAppearances, 0), 200);
  for (let seed = 0; seed < 4; seed++) assert.equal(report.teams.reduce((sum, row) => sum + row.seeds[seed], 0), 50);
  assert.ok(report.teams.every(row => row.winQuantiles[10] <= row.winQuantiles[50] && row.winQuantiles[50] <= row.winQuantiles[90]));
});

test('a regular-season-only setup produces no invented championship', async () => {
  const report = await simulateLeague({ ...input, playoffTeams: 0, cycles: 1 });
  assert.equal(report.unresolvedTitles, null); assert.equal(report.example.champion, null);
  assert.deepEqual(report.example.bracket, []);
  assert.equal(report.gamesPlayed, 300);
  assert.ok(report.teams.every(team => team.titles === null && team.playoffAppearances === 0));
});

test('unresolved games do not silently grant playoff byes or championships', async () => {
  const zeros = teams.map(team => {
    const copy = structuredClone(team);
    for (const context of copy.contexts) {
      Object.assign(context, { offensiveRating: 0, defensiveRating: 0, netRating: 0 });
      for (const side of ['offense', 'defense']) Object.assign(context.outcomes[side], {
        points: 0, counts: { empty: 1000, one: 0, two: 0, three: 0, fourPlus: 0 },
      });
    }
    return copy;
  });
  const report = await simulateLeague({ ...input, teams: zeros });
  assert.equal(report.unresolvedTitles, 50);
  assert.equal(report.example.champion, null);
  assert.ok(report.example.table.every(row => row.ties === 6 && row.seedLottery));
  assert.ok(report.teams.every(row => row.titles === 0));
  assert.equal(report.example.bracket.at(-1).games.length, 0);
});

test('invalid scope, assumptions, missing samples and excessive workloads fail before simulation', async () => {
  for (const change of [{ trials: 501 }, { season: 2022 }, { possessions: 59 }, { playoffTeams: 8 },
    { attackWeight: NaN }, { seed: '' }, { teams: [teams[0], { ...teams[1], snapshot: `s${'b'.repeat(24)}` }] },
    { teams: teams.map(team => ({ ...team, contexts: [] })) },
    { teams: Array.from({ length: 30 }, (_, index) => ({ ...teams[index % 4], team: `t${index}` })), trials: 500 }]) {
    await assert.rejects(simulateLeague({ ...input, ...change }));
  }
});

test('league runs yield and cancel without returning a partial champion', async () => {
  const controller = new AbortController(); let batches = 0;
  await assert.rejects(simulateLeague(input, { signal: controller.signal, yieldEveryBatch: async () => { batches++; controller.abort(); } }), { name: 'AbortError' });
  assert.equal(batches, 1);
});
