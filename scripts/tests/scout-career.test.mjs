import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCareerTimeline, summarizeCareer, replayObservedCareer } from '../../tools/scout-studio/career-simulator.js';

function profile(year, { phase = 'regular', team = 'Minnesota Timberwolves', scope = 'team', games = 10, points = 10, assists = 2, rebounds = 4, missing = [] } = {}) {
  const value = key => missing.includes(key) ? null : key === 'points' ? points : key === 'assists' ? assists : key === 'rebounds' ? rebounds : key === 'turnovers' ? 1 : key === 'steals' ? 1 : 1;
  return { key: `${year}|${phase}|${team}|${scope}`, seasonStartYear: year, phase, team, scope, games, minutes: games * 20,
    positions: ['G'], perGame: { points: value('points'), assists: value('assists'), rebounds: value('rebounds'), turnovers: value('turnovers'), steals: value('steals'), blocks: value('blocks') },
    shooting: { fieldGoalPercentage: .5, threePointPercentage: .35, freeThrowPercentage: .8 }, involvement: 15 };
}

test('career timeline preserves gaps and prefers all-team aggregates', () => {
  const timeline = buildCareerTimeline([
    profile(2020, { scope: 'team', team: 'Team A', games: 10, points: 9 }),
    profile(2020, { scope: 'team', team: 'Team B', games: 5, points: 11 }),
    profile(2020, { scope: 'all-teams', team: 'All teams', games: 15, points: 9.6667 }),
    profile(2022, { scope: 'all-teams', team: 'All teams', games: 20, points: 12 }),
  ], { seasonStartYears: [2020, 2021, 2022] });
  assert.deepEqual(timeline.rows.map(row => row.status), ['observed', 'gap', 'observed']);
  assert.equal(timeline.rows[0].games, 15);
  assert.deepEqual(timeline.rows[0].teams, ['Team A', 'Team B']);
  assert.equal(timeline.rows[1].games, null);
  assert.match(timeline.note, /does not estimate age/);
});

test('career summary reports observed totals and team/role changes', () => {
  const timeline = buildCareerTimeline([profile(2020, { team: 'All teams', scope: 'all-teams', points: 10 }),
    profile(2021, { team: 'All teams', scope: 'all-teams', games: 20, points: 14, assists: 3 })], { seasonStartYears: [2020, 2021] });
  const summary = summarizeCareer(timeline);
  assert.equal(summary.observedSeasons, 2);
  assert.equal(summary.totals.points, 380);
  assert.equal(summary.peakScoringSeason.seasonStartYear, 2021);
  assert.equal(summary.teams.length, 1);
  assert.match(summary.note, /observed per-game/);
});

test('observed replay is bounded, deterministic and marks incomplete metrics', () => {
  const timeline = buildCareerTimeline([profile(2020, { games: 10 }), profile(2021, { games: 20, missing: ['rebounds'] })]);
  const first = replayObservedCareer(timeline, { trials: 50, seed: 'same', seasons: 2 });
  const second = replayObservedCareer(timeline, { trials: 50, seed: 'same', seasons: 2 });
  const different = replayObservedCareer(timeline, { trials: 50, seed: 'different', seasons: 2 });
  assert.deepEqual(first, second);
  assert.notEqual(first.seed, different.seed);
  assert.equal(first.metrics.games.completeTrials, 50);
  assert.ok(first.metrics.rebounds.completeTrials < 50);
  assert.match(first.note, /does not project a future season/);
});

test('career validation rejects duplicate rows and invalid replay settings', () => {
  assert.throws(() => buildCareerTimeline([profile(2020), profile(2020)]), /duplicate/);
  const timeline = buildCareerTimeline([profile(2020)]);
  assert.throws(() => replayObservedCareer(timeline, { trials: 49 }), /50–500/);
  assert.throws(() => replayObservedCareer(timeline, { trials: 50, seed: 'bad seed' }), /seed/);
});
