import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLeague } from '../../tools/scout-studio/season-simulator.js';
import { captureLeagueSummary, compareLeagueScenarios } from '../../tools/scout-studio/league-comparisons.js';
import { fixtureSource, snapshot } from './fixtures/scout-studio-fixture.mjs';

const source = fixtureSource(), first = await source.teamContexts('t0', snapshot), second = await source.teamContexts('t1', snapshot);
const teams = [first, second, { ...structuredClone(first), team: 't2' }, { ...structuredClone(second), team: 't3' }];
const input = { teams, season: 2024, seed: 'comparison', trials: 50, cycles: 2, playoffTeams: 2, seriesLength: 3 };
const baseline = await simulateLeague(input);

test('league references are compact defensive allowlists and can be safely recaptured', () => {
  const dirty = { ...structuredClone(baseline), privateCoefficients: [999] };
  dirty.settings.secret = 'private'; dirty.teams[0].providerId = 'private';
  const reference = captureLeagueSummary(dirty);
  assert.deepEqual(captureLeagueSummary(reference), reference);
  assert.doesNotMatch(JSON.stringify(reference), /private|example|schedule|bracket|gamesPlayed/);
  dirty.teams[0].seeds[0] = 999; dirty.settings.cycles = 99;
  assert.deepEqual(reference, captureLeagueSummary(baseline));
});

test('identical settings yield zero deltas without implying independent experiments', () => {
  const comparison = compareLeagueScenarios(baseline, { ...baseline, teams: [...baseline.teams].reverse() });
  assert.equal(comparison.identical, true); assert.deepEqual(comparison.changes, []);
  assert.ok(comparison.teams.every(team => [team.averageWins, team.winShare, team.qualified, team.title].every(metric => metric.difference === 0)));
  assert.match(comparison.note, /not a paired statistical test/);
});

test('a changed pace is isolated and outcome differences recompute from the exact denominators', async () => {
  const current = await simulateLeague({ ...input, possessions: 110 });
  const comparison = compareLeagueScenarios(baseline, current);
  assert.deepEqual(comparison.changes, [{ key: 'possessions', label: 'Possessions per team', reference: 100, current: 110 }]);
  assert.equal(comparison.structureChanged, false); assert.equal(comparison.repetitionChanged, false);
  for (const team of comparison.teams) {
    const a = baseline.teams.find(row => row.team === team.team), b = current.teams.find(row => row.team === team.team);
    assert.equal(team.title.difference, Math.round((b.titles - a.titles) / 50 * 100 * 10000) / 10000);
    assert.ok(Math.abs(team.winShare.difference - (b.averageWins - a.averageWins) / 6 * 100) <= 0.00005);
  }
});

test('changed schedules withhold raw-win deltas and changed repetition settings are disclosed', async () => {
  const current = await simulateLeague({ ...input, cycles: 1, trials: 60, seed: 'different' });
  const comparison = compareLeagueScenarios(baseline, current);
  assert.equal(comparison.structureChanged, true); assert.equal(comparison.repetitionChanged, true);
  assert.deepEqual(comparison.gamesPerTeam, { reference: 6, current: 3 });
  assert.deepEqual(comparison.changes.map(row => row.key), ['cycles', 'trials', 'seed']);
  assert.ok(comparison.teams.every(row => row.averageWins.difference === null && Number.isFinite(row.winShare.difference)));
});

test('removing playoffs is not displayed as zero title ability', async () => {
  const current = await simulateLeague({ ...input, playoffTeams: 0 });
  const comparison = compareLeagueScenarios(baseline, current);
  assert.equal(comparison.structureChanged, true);
  assert.ok(comparison.teams.every(row => row.title.current === null && row.qualified.current === null && row.title.difference === null));
});

test('different season, team, snapshot and implementation cannot be compared', async () => {
  for (const change of [{ season: 2025 }, { snapshot: `s${'b'.repeat(24)}` }, { modelVersion: 'new-model' },
    { teams: baseline.teams.map(row => ({ ...row, team: row.team === 't3' ? 't4' : row.team })) }]) {
    assert.throws(() => compareLeagueScenarios(baseline, { ...baseline, ...change }));
  }
});

test('the same fixed setup cannot quietly return changed outcomes', () => {
  const changed = structuredClone(baseline); changed.teams[0].averageWins -= 0.02;
  assert.throws(() => compareLeagueScenarios(baseline, changed), /Identical league settings returned different results/);
});

test('malformed, coerced or inconsistent aggregate results cannot be pinned', () => {
  const changes = [r => { r.status = 'cancelled'; }, r => { r.settings.trials = '50'; }, r => { r.teams[0].averageWins = NaN; },
    r => { r.teams[0].seeds[0]++; }, r => { r.teams[0].titles = 51; }, r => { r.unresolvedTitles = 50; },
    r => { r.teams[0].playoffAppearances = 0; }, r => { r.regularGamesPerExperiment++; }, r => { r.settings.possessions = 59; },
    r => { r.teams[0].team = 'private-team'; }, r => { r.teams[0].averageWins = 7; }, r => { r.settings.attackWeight = '0.5'; }];
  for (const mutate of changes) { const broken = structuredClone(baseline); mutate(broken); assert.throws(() => captureLeagueSummary(broken)); }
});
