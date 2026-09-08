import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSource } from './fixtures/scout-studio-fixture.mjs';
import { captureChemistry, compareChemistry, compareForgeRecipes, inspectForgeDependencies, BLUEPRINT_QUESTIONS } from '../../tools/scout-studio/workbench-comparisons.js';
import { createForgeRecipe, FORGE_BLOCKS, METRIC_SPECS } from '../../tools/scout-studio/studio-analysis.js';

const source = fixtureSource(), roster = await source.roster('t0');
const view = async ids => captureChemistry(roster, await source.chemistry('t0', roster.snapshot, ids), ids);
const reference = await view(['p0', 'p1']), current = await view(['p0', 'p2']);
const recipe = id => createForgeRecipe(roster, Object.fromEntries(FORGE_BLOCKS.map(block => [block.key, id])));

test('group comparisons identify retained/removed/added players and match context keys', () => {
  const report = compareChemistry(roster, reference, current);
  assert.equal(report.kept.length, 1); assert.equal(report.removed.length, 1); assert.equal(report.added.length, 1);
  assert.equal(report.difference.netRating, 0);
  assert.ok(report.contexts.length > 1); assert.ok(report.contexts.every(row => row.difference.netRating === 0));
  assert.match(report.note, /not a controlled substitution/);
});

test('missing context sides, below-gate groups and inconsistent samples cannot imply improvement', () => {
  const missing = { ...structuredClone(current), contexts: current.contexts.filter(row => row.key !== 'season:2024') };
  const row = compareChemistry(roster, reference, missing).contexts.find(row => row.key === 'season:2024');
  assert.equal(row.difference.netRating, null); assert.equal(row.current.status, 'unavailable');
  const poor = structuredClone(current); poor.sample.offensePossessions = 0;
  assert.equal(compareChemistry(roster, reference, poor).difference.netRating, null);
  poor.sample.offensePossessions = current.sample.offensePossessions; poor.sample.netRating = 200;
  assert.equal(compareChemistry(roster, reference, poor).difference.netRating, null);
});

test('different snapshots, teams, duplicate players and different group sizes stay separate', async () => {
  for (const bad of [{ ...reference, snapshot: 'stale' }, { ...reference, team: 't1' }, { ...reference, selection: ['p0', 'p0'] }]) {
    assert.throws(() => compareChemistry(roster, bad, current));
  }
  assert.throws(() => compareChemistry(roster, reference, { ...current, selection: ['p0', 'p1', 'p2'] }), /same size/);
  const unseen = await view(['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.equal(compareChemistry(roster, unseen, unseen).difference.netRating, null);
});

test('reference snapshots expose only selected presentation fields', async () => {
  const raw = await source.chemistry('t0', roster.snapshot, ['p0', 'p1']);
  raw.rapm = 'DO-NOT-EXPOSE'; raw.combination.contexts[0].coefficient = 20;
  assert.doesNotMatch(JSON.stringify(captureChemistry(roster, raw, ['p0', 'p1'])), /rapm|coefficient|DO-NOT-EXPOSE/);
});

test('Forge reference comparisons preserve all ten components and report only changed donor blocks', () => {
  const a = recipe('p0'), b = createForgeRecipe(roster, { ...a.donors, shooting: 'p1' }), before = structuredClone(a);
  const report = compareForgeRecipes(roster, a, b);
  assert.equal(report.changedBlocks, 1); assert.equal(report.rows.length, 10);
  assert.ok(report.rows.filter(row => row.block !== 'Shooting').every(row => row.difference === 0));
  assert.deepEqual(a, before); assert.match(report.note, /no summed score/);
  const empty = compareForgeRecipes(roster, a, createForgeRecipe(roster));
  assert.ok(empty.rows.every(row => row.current === null && row.difference === null));
});

test('Forge dependency review identifies untested links without creating penalties', () => {
  const a = recipe('p0'); assert.deepEqual(inspectForgeDependencies(roster, a), []);
  const b = createForgeRecipe(roster, { ...a.donors, shooting: 'p1' });
  assert.equal(inspectForgeDependencies(roster, b).length, 1);
  assert.match(inspectForgeDependencies(roster, b)[0].reason, /does not recalculate/);
  assert.throws(() => inspectForgeDependencies(roster, { ...b, snapshot: 'stale' }));
});

test('Blueprint question lenses use only supported observable components', () => {
  for (const question of Object.values(BLUEPRINT_QUESTIONS)) {
    assert.ok(question.note.length > 40);
    assert.ok(question.keys === null || question.keys.every(key => METRIC_SPECS.some(metric => metric.key === key)));
  }
});
