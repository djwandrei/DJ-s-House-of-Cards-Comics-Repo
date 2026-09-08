import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureSource, rawSample } from './fixtures/scout-studio-fixture.mjs';
import { describeScoutSample } from '../lib/scout-studio.mjs';
import { REVIEW_POLICY, FORGE_BLOCKS, buildBlueprint, metricEvidence, comparePlayerEvidence, sampleEvidence,
  analyzeChemistry, createForgeRecipe, buildComposite, explainForgeChange } from '../../tools/scout-studio/studio-analysis.js';
import { saveForgeDraft, loadForgeDraft, clearForgeDraft } from '../../tools/scout-studio/forge-state.js';

const roster = await fixtureSource().roster('t0');
const clone = value => structuredClone(value);
const metric = (player, key) => player.metrics.find(metric => metric.key === key);
const allDonors = id => Object.fromEntries(FORGE_BLOCKS.map(block => [block.key, id]));
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('Blueprint independently recomputes component rates and leave-one-out medians', () => {
  const report = buildBlueprint(roster, 'p0');
  assert.equal(report.components.length, 10);
  const threes = report.components.find(row => row.key === 'threePointAccuracy');
  assert.equal(threes.value, 60 / 150);
  assert.equal(threes.cohort.eligible, 5);
  assert.equal(threes.cohort.median, 57 / 150);
  assert.equal(threes.cohort.difference, 0.02);
  assert.equal(report.components.find(row => row.key === 'assists').value, 8.3333);
  assert.match(report.note, /not validated talent cutoffs/);
});
test('Blueprint does not invent peers or impute missing metrics', () => {
  const one = { ...roster, players: [roster.players[0]] };
  assert.equal(buildBlueprint(one, 'p0').components[0].cohort.median, null);
  const sparse = clone(roster); sparse.players[0].metrics = [];
  const components = buildBlueprint(sparse, 'p0').components;
  assert.equal(components.filter(row => row.value === null).length, 10);
  assert.equal(components[0].cohort.difference, null);
});
test('review thresholds are explicit, inclusive, and do not change observed values', () => {
  const a = clone(roster.players[0]);
  Object.assign(metric(a, 'threePointAccuracy'), { numerator: 12, denominator: 24, value: 0.5 });
  assert.equal(metricEvidence(a, 'threePointAccuracy').status, 'limited_sample');
  assert.equal(metricEvidence(a, 'threePointAccuracy').value, 0.5);
  Object.assign(metric(a, 'threePointAccuracy'), { numerator: 12, denominator: 25, value: 0.48 });
  assert.equal(metricEvidence(a, 'threePointAccuracy').status, 'reviewable');
  a.estimatedTeamPossessions = REVIEW_POLICY.minPossessions;
  Object.assign(metric(a, 'assists'), { numerator: 20, denominator: a.estimatedTeamPossessions, value: 10 });
  assert.equal(metricEvidence(a, 'assists').status, 'reviewable');
});
for (const invalid of [null, undefined, '', false, NaN, Infinity, -1]) test(`invalid counts stay unavailable: ${String(invalid)}`, () => {
  const a = clone(roster.players[0]); metric(a, 'assists').numerator = invalid;
  assert.equal(metricEvidence(a, 'assists').value, null);
});
test('duplicate keys, wrong units, impossible fractions and inconsistent values are withheld', () => {
  for (const mutate of [
    a => a.metrics.push(clone(metric(a, 'threePointAccuracy'))),
    a => { metric(a, 'threePointAccuracy').unit = 'per100'; },
    a => { Object.assign(metric(a, 'threePointAccuracy'), { numerator: 151, value: 151 / 150 }); },
    a => { metric(a, 'threePointAccuracy').value = 0.7; }
  ]) { const a = clone(roster.players[0]); mutate(a); assert.equal(metricEvidence(a, 'threePointAccuracy').value, null); }
  const a = clone(roster.players[0]); a.estimatedTeamPossessions = 10;
  assert.equal(metricEvidence(a, 'assists').status, 'unavailable');
});
test('zero is valid and comparison does not turn low samples into a large advantage', () => {
  const r = clone(roster); Object.assign(metric(r.players[0], 'steals'), { numerator: 0, value: 0 });
  assert.equal(metricEvidence(r.players[0], 'steals').value, 0);
  Object.assign(metric(r.players[0], 'threePointAccuracy'), { numerator: 1, denominator: 1, value: 1 });
  assert.equal(comparePlayerEvidence(r, 'p0', 'p1')[0].difference, null);
  assert.deepEqual(comparePlayerEvidence(r, 'p0', 'p0'), []);
  assert.throws(() => comparePlayerEvidence(r, 'p0', 'p999'), /Choose a player/);
});
test('roster scopes and duplicate identities cannot enter analysis', () => {
  for (const r of [{ ...roster, snapshot: 'old' }, { ...roster, team: 'private-team' },
    { ...roster, players: [roster.players[0], roster.players[0]] }, { ...roster, players: [] }]) {
    assert.throws(() => buildBlueprint(r, 'p0'), /valid, single-team/);
  }
});
test('chemistry contrasts recompute together minus each apart cell with correct defense direction', async () => {
  const result = await fixtureSource().chemistry('t0', roster.snapshot, ['p0', 'p1']);
  const report = analyzeChemistry(roster, result, ['p0', 'p1']);
  assert.equal(report.contrasts[0].netDifference, 1);
  assert.equal(report.contrasts[0].defensiveDifference, -1);
  assert.equal(report.contrasts[0].offensiveDifference, 0);
  assert.equal(report.cells.length, 4);
  assert.match(report.note, /No confidence interval for a difference/);
});
test('missing and low-sample WOWY cells remain unknown even with numeric values', async () => {
  const result = await fixtureSource().chemistry('t0', roster.snapshot, ['p0', 'p1']);
  result.wowy[1].status = 'insufficient_sample'; result.wowy.pop();
  const report = analyzeChemistry(roster, result, ['p0', 'p1']);
  assert.equal(report.contrasts[0].netDifference, null);
  assert.equal(report.cells[3].netRating, null);
});
test('stale, cross-team, duplicated and mismatched group requests fail closed', async () => {
  const result = await fixtureSource().chemistry('t0', roster.snapshot, ['p0', 'p1']);
  for (const bad of [{ ...result, team: 't1' }, { ...result, snapshot: 'old' }, { ...result, selection: ['p1', 'p0'] },
    { ...result, combination: { ...result.combination, kind: 'exact_five' } }]) {
    assert.throws(() => analyzeChemistry(roster, bad, ['p0', 'p1']));
  }
  assert.throws(() => analyzeChemistry(roster, result, ['p0', 'p0']));
});
test('unseen five stays unknown despite ten observed internal pair samples', async () => {
  const ids = ['p0', 'p1', 'p2', 'p3', 'p4'];
  const result = await fixtureSource().chemistry('t0', roster.snapshot, ids);
  const report = analyzeChemistry(roster, result, ids);
  assert.equal(report.observedGroup, false); assert.equal(report.sample.netRating, null);
  assert.equal(report.pairs.length, 10); assert.ok(report.pairs.every(pair => pair.netRating === 6));
  assert.equal(report.kind, 'exact_five');
  result.pairs[1] = result.pairs[0];
  assert.equal(analyzeChemistry(roster, result, ids).pairs[0].netRating, null);
  result.pairs.push(result.pairs[0]); assert.throws(() => analyzeChemistry(roster, result, ids), /bounded/);
});
test('inconsistent ratings, missing exposure and invalid intervals cannot look valid', () => {
  const sample = describeScoutSample(rawSample());
  assert.equal(sampleEvidence(sample).netRating, 6);
  assert.equal(sampleEvidence({ ...sample, defensiveRating: 10 }).netRating, null);
  assert.equal(sampleEvidence({ ...sample, offensePossessions: 0 }).netRating, null);
  assert.equal(sampleEvidence({ ...sample, interval: { lower: 8, upper: 9 } }).interval, null);
});
test('Forge requires all blocks and preserves exact coherent donor components', () => {
  const empty = buildComposite(roster, createForgeRecipe(roster)); assert.equal(empty.status, 'incomplete');
  assert.equal(empty.assigned, 0);
  const recipe = createForgeRecipe(roster, { ...allDonors('p0'), shooting: 'p1', creation: 'p2' });
  const report = buildComposite(roster, recipe, 'p0');
  assert.equal(report.status, 'complete'); assert.equal(report.assigned, 5);
  assert.equal(report.blocks[0].components[0].numerator, 59);
  assert.equal(report.blocks[2].components[0].numerator, 150);
  assert.deepEqual(report.blocks[2].components.map(metric => metric.key), ['assists', 'turnovers']);
  assert.equal(report.blocks[1].components[0].difference, 0, 'shooting donor must not change scoring');
  assert.equal(report.blocks.flatMap(block => block.components).length, 10);
  assert.match(report.note, /not an observed player or forecast/);
});
test('Forge forbids stale scope and unknown donors or blocks', () => {
  const recipe = createForgeRecipe(roster, allDonors('p0'));
  for (const bad of [{ ...recipe, team: 't1' }, { ...recipe, snapshot: 'old' }, { ...recipe, version: 2 }]) assert.throws(() => buildComposite(roster, bad));
  assert.throws(() => createForgeRecipe(roster, { shooting: 'p999' }));
  assert.throws(() => createForgeRecipe(roster, { rapm: 'p0' }));
});
test('single-donor changes have isolated, reversible, deterministic consequences', () => {
  const before = createForgeRecipe(roster, allDonors('p0'));
  for (const block of FORGE_BLOCKS) {
    const after = createForgeRecipe(roster, { ...before.donors, [block.key]: 'p1' });
    const report = explainForgeChange(roster, before, after), reverse = explainForgeChange(roster, after, before);
    assert.equal(report.changedBlocks, 1);
    assert.deepEqual(report.changes[0].metrics.map(metric => metric.key), [...block.metrics]);
    assert.deepEqual(report, explainForgeChange(roster, clone(before), clone(after)));
    for (let i = 0; i < report.changes[0].metrics.length; i++) {
      assert.equal(Math.abs(report.changes[0].metrics[i].difference + reverse.changes[0].metrics[i].difference), 0);
    }
    const oldValues = buildComposite(roster, before), nextValues = buildComposite(roster, after);
    oldValues.blocks.forEach((item, i) => { if (item.key !== block.key) assert.deepEqual(item, nextValues.blocks[i]); });
  }
  assert.equal(explainForgeChange(roster, before, before).changedBlocks, 0);
});
test('Forge preserves null, low sample and reconciliation caveats without renormalizing', () => {
  const r = clone(roster); r.players[0].coverage.independentBoxScore = 'not_fully_reconciled';
  metric(r.players[0], 'rebounds').status = 'unavailable';
  const report = buildComposite(r, createForgeRecipe(r, allDonors('p0')), 'p1');
  assert.equal(report.status, 'complete_with_caveats');
  assert.equal(report.blocks[3].components[0].value, null);
  assert.equal(report.blocks[3].components[0].difference, null);
});
test('saved recipes contain only scoped handles, round-trip and clear exactly one draft', () => {
  const store = storage(); store.setItem('unrelated', 'keep');
  const recipe = createForgeRecipe(roster, allDonors('p2'));
  saveForgeDraft(store, roster, recipe);
  assert.deepEqual(loadForgeDraft(store, roster).recipe, recipe);
  const serialized = [...store.values.values()].join('');
  assert.doesNotMatch(serialized, /Test Player|numerator|metrics|DO-NOT-EXPOSE|rapm|archivePath/);
  assert.equal(loadForgeDraft(store, { ...roster, team: 't1' }).recipe, null);
  assert.equal(loadForgeDraft(store, { ...roster, snapshot: `s${'b'.repeat(24)}` }).recipe, null);
  clearForgeDraft(store, roster); assert.equal(store.getItem('unrelated'), 'keep');
  assert.equal(loadForgeDraft(store, roster).status, 'empty');
});
test('corrupt, oversized and blocked storage never silently substitute a donor', () => {
  const store = storage(); saveForgeDraft(store, roster, createForgeRecipe(roster, allDonors('p0')));
  const key = [...store.values.keys()][0], saved = store.getItem(key);
  for (const value of ['{', 'x'.repeat(4097), saved.replace('"p0"', '"p999"'), saved.replace('"schemaVersion":1', '"schemaVersion":99')]) {
    store.setItem(key, value); assert.equal(loadForgeDraft(store, roster).recipe, null);
  }
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.equal(loadForgeDraft(blocked, roster).status, 'unavailable');
  assert.throws(() => saveForgeDraft(blocked, roster, createForgeRecipe(roster)), /quota/);
});
