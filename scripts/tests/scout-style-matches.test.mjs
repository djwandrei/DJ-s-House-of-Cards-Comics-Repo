import assert from 'node:assert/strict';
import test from 'node:test';
import { styleRoster } from './fixtures/scout-style-fixture.mjs';
import { FORGE_BLOCKS, createForgeRecipe } from '../../tools/scout-studio/studio-analysis.js';
import { findPlayerStyleMatches, findCompositeStyleMatches } from '../../tools/scout-studio/style-matches.js';
const roster = await styleRoster();
const clone = value => structuredClone(value);
const recipe = (r, id) => createForgeRecipe(r, Object.fromEntries(FORGE_BLOCKS.map(block => [block.key, id])));
const setMetric = (player, key, numerator, denominator) => {
  const metric = player.metrics.find(metric => metric.key === key);
  Object.assign(metric, { numerator, denominator,
    value: Math.round(numerator / denominator * (metric.unit === 'per100' ? 100 : 1) * 10000) / 10000 });
};

test('style matches are deterministic, bounded, self-excluding and roster-order independent', () => {
  const before = clone(roster), result = findPlayerStyleMatches(roster, 'p0');
  assert.equal(result.status, 'ready'); assert.equal(result.eligible, 5);
  assert.equal(result.matches.length, 3); assert.equal(result.matches[0].id, 'p1');
  assert.equal(result.components.length, 10);
  assert.deepEqual(result, findPlayerStyleMatches({ ...roster, players: [...roster.players].reverse() }, 'p0'));
  assert.deepEqual(roster, before);
  assert.match(result.note, /not a learned archetype/);
});
test('distances recompute as equal block means, not raw mixed-unit totals', () => {
  const result = findPlayerStyleMatches(roster, 'p0');
  for (const match of result.matches) {
    const means = FORGE_BLOCKS.map(block => {
      const gaps = match.gaps.filter(gap => gap.block === block.key);
      for (const gap of gaps) {
        const scale = result.components.find(component => component.key === gap.key).range;
        assert.equal(gap.normalizedGap, Math.abs(gap.target - gap.candidate) / scale);
      }
      return gaps.reduce((sum, gap) => sum + gap.normalizedGap, 0) / gaps.length;
    });
    assert.ok(Math.abs(match.distance - means.reduce((sum, value) => sum + value, 0) / means.length) < 1e-7);
  }
});
test('one fixed component basis excludes incomplete candidates instead of rewarding missingness', () => {
  const r = clone(roster); r.players[1].metrics = r.players[1].metrics.filter(metric => metric.key !== 'blocks');
  const result = findPlayerStyleMatches(r, 'p0');
  assert.equal(result.status, 'ready'); assert.equal(result.eligible, 4);
  assert.ok(result.matches.every(match => match.id !== 'p1' && match.gaps.length === 10));
});
test('low target samples are omitted explicitly and insufficient target evidence blocks ordering', () => {
  const r = clone(roster); setMetric(r.players[0], 'threePointAccuracy', 1, 1);
  const result = findPlayerStyleMatches(r, 'p0');
  assert.equal(result.status, 'ready'); assert.equal(result.components.length, 9);
  assert.ok(result.omitted.some(item => item.key === 'threePointAccuracy' && item.reason === 'limited_sample'));
  r.players[0].metrics = r.players[0].metrics.slice(0, 5);
  assert.equal(findPlayerStyleMatches(r, 'p0').status, 'insufficient_components');
});
test('too few peers, constant cohorts and wrong scopes fail closed', () => {
  assert.equal(findPlayerStyleMatches({ ...roster, players: roster.players.slice(0, 3) }, 'p0').status, 'insufficient_cohort');
  const r = clone(roster); r.players.forEach(player => { player.metrics = clone(r.players[0].metrics); });
  assert.equal(findPlayerStyleMatches(r, 'p0').status, 'insufficient_variation');
  assert.throws(() => findPlayerStyleMatches({ ...roster, snapshot: 'wrong' }, 'p0'));
  assert.throws(() => findPlayerStyleMatches(roster, 'p999'));
  assert.throws(() => findCompositeStyleMatches(roster, { ...recipe(roster, 'p0'), team: 't1' }));
});
test('ties are marked equally and handle ordering never implies stronger evidence', () => {
  const r = clone(roster); r.players[2].metrics = clone(r.players[1].metrics);
  const result = findPlayerStyleMatches(r, 'p0');
  assert.equal(result.matches[0].rank, result.matches[1].rank);
  assert.equal(result.matches[0].id, 'p1'); assert.equal(result.matches[1].id, 'p2');
});
test('composites retain donor labels, exact-scope recipes and hypothetical semantics', () => {
  const draft = recipe(roster, 'p2'), before = clone(draft);
  const result = findCompositeStyleMatches(roster, draft);
  assert.equal(result.status, 'ready'); assert.equal(result.kind, 'hypothetical_recipe');
  assert.equal(result.matches[0].id, 'p2'); assert.equal(result.matches[0].distance, 0);
  assert.equal(result.matches[0].donorBlocks.length, 5); assert.deepEqual(draft, before);
  assert.equal(findCompositeStyleMatches(roster, createForgeRecipe(roster)).status, 'incomplete_recipe');
});
test('independent reconciliation caveats remain visible and private fields never propagate', () => {
  const r = clone(roster);
  r.players[0].coverage.independentBoxScore = 'not_fully_reconciled';
  r.players[0].rapm = 'DO-NOT-EXPOSE'; r.players[1].archivePath = 'DO-NOT-EXPOSE';
  const result = findPlayerStyleMatches(r, 'p0');
  assert.equal(result.matches[0].unreconciledComponents, 10);
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-EXPOSE|archivePath|"rapm"/);
  assert.ok(result.matches.every(match => match.gaps.every(gap => gap.targetDenominator > 0 && gap.candidateDenominator > 0)));
});
test('duplicate, inconsistent and non-finite source values cannot become a nearest match', () => {
  for (const change of [metric => { metric.value = Infinity; }, metric => { metric.unit = 'wrong'; }, metric => { metric.numerator = null; }]) {
    const r = clone(roster); change(r.players[1].metrics[0]);
    assert.ok(findPlayerStyleMatches(r, 'p0').matches.every(match => match.id !== 'p1'));
  }
  const r = clone(roster); r.players[1].metrics.push(clone(r.players[1].metrics[0]));
  assert.ok(findPlayerStyleMatches(r, 'p0').matches.every(match => match.id !== 'p1'));
});

test('legitimate zeros and reordered component arrays preserve matching', () => {
  const r = clone(roster); setMetric(r.players[0], 'steals', 0, 1800);
  const result = findPlayerStyleMatches(r, 'p0');
  assert.equal(result.status, 'ready');
  assert.equal(result.matches[0].gaps.find(gap => gap.key === 'steals').target, 0);
  r.players.forEach(player => player.metrics.reverse());
  assert.deepEqual(result, findPlayerStyleMatches(r, 'p0'));
});

test('extra unselected and private fields cannot alter the ordering', () => {
  const r = clone(roster);
  r.players.forEach((player, index) => { player.rapm = index * 999; player.skillGrade = 100; player.metrics.push({ key: 'unmeasuredSpeed', value: 99 }); });
  assert.deepEqual(findPlayerStyleMatches(r, 'p0'), findPlayerStyleMatches(roster, 'p0'));
});
