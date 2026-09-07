import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionHistory } from '../../tools/game-decision-history.js';

const source = { family: 'team-season', label: 'Test sample', description: 'Synthetic contract fixture', model: { label: 'Synthetic' }, seasonLabels: ['2024–25'] };
const player = id => ({ id, name: `Test ${id}`, positions: ['G'], source: { teamName: 'Test team', seasonLabel: '2024–25' } });
const challenge = index => ({ id: `c${index}`, title: 'Test challenge', brief: 'Test brief', source,
  lineup: ['x1', 'x2', 'x3', 'x4', 'x5'].map(player), removeId: 'x1', candidates: ['a', 'b', 'c'].map(id => player(`${index}-${id}`)) });
const fix = { contractVersion: 1, gameKind: 'fix-the-five', dailySeed: '2026-09-07', challenges: Array.from({ length: 5 }, (_, index) => challenge(index)) };
const draft = { contractVersion: 1, gameKind: 'draft-night', dailySeed: '2026-09-07', deck: { id: 'd0', title: 'Test draft', source, publishedPathCount: 243,
  rounds: fix.challenges.map((row, index) => ({ id: `r${index}`, title: 'Test slot', prompt: 'Pick', candidates: row.candidates })) } };

test('decision history preserves first, best and current choices without changing the score', () => {
  const history = createDecisionHistory(fix);
  history.record('c0', ['0-a'], { candidateId: '0-a', rank: 3, roundScore: 0 });
  history.record('c0', ['0-b'], { candidateId: '0-b', rank: 1, roundScore: 100 });
  const report = history.record('c0', ['0-c'], { candidateId: '0-c', rank: 2, roundScore: 50 });
  assert.equal(report.first.rank, 3); assert.equal(report.best.rank, 1); assert.equal(report.current.rank, 2); assert.equal(report.rankChange, 1);
  assert.equal(report.count, 3); assert.match(report.note, /tab session/);
  assert.equal(history.summary('c1').count, 0, 'Other rounds are not pooled');
});

test('retries are idempotent and returned reports cannot mutate internal history', () => {
  const history = createDecisionHistory(fix), outcome = { candidateId: '0-a', rank: 1, roundScore: 100 };
  history.record('c0', ['0-a'], outcome); const report = history.record('c0', ['0-a'], outcome);
  assert.equal(report.count, 1); report.first.rank = 99; report.current.selection.push('foreign');
  assert.equal(history.summary('c0').first.rank, 1); assert.equal(history.summary('c0').current.selection.length, 1);
  assert.throws(() => history.record('c0', ['0-a'], { ...outcome, rank: 2 }), /changed/);
});

test('illegal choices, mismatched results and coerced numbers cannot be recorded', () => {
  const history = createDecisionHistory(fix);
  for (const outcome of [{ candidateId: '0-b', rank: 1, roundScore: 100 }, { candidateId: '0-a', rank: 4, roundScore: 100 },
    { candidateId: '0-a', rank: '1', roundScore: 100 }, { candidateId: '0-a', rank: 1, roundScore: null }]) assert.throws(() => history.record('c0', ['0-a'], outcome));
  assert.throws(() => history.record('c0', ['1-a'], { candidateId: '1-a', rank: 1, roundScore: 100 }));
  assert.throws(() => history.summary('foreign'));
});

test('draft history is fixed-slot, bounded to eight displayed decisions, and excludes private fields', () => {
  const history = createDecisionHistory(draft);
  for (let index = 0; index < 12; index++) {
    const picks = draft.deck.rounds.map((round, slot) => round.candidates[Math.floor(index / 3 ** slot) % 3].id);
    history.record('d0', picks, { selectionIds: picks, rank: index + 1, roundScore: 100 - index, rapm: 'DO-NOT-EXPOSE' });
  }
  const report = history.summary('d0'); assert.equal(report.count, 12); assert.equal(report.recent.length, 8); assert.equal(report.first.number, 1);
  assert.doesNotMatch(JSON.stringify(report), /rapm|DO-NOT-EXPOSE|coefficient|archivePath/);
  const picks = draft.deck.rounds.map(round => round.candidates[0].id).reverse();
  assert.throws(() => history.record('d0', picks, { selectionIds: picks, rank: 1, roundScore: 100 }));
});

test('history binds an immutable board definition and does not persist answers', () => {
  const copy = structuredClone(fix), history = createDecisionHistory(copy);
  copy.gameKind = 'draft-night'; copy.challenges[0].candidates[0].name = 'Changed name';
  const report = history.record('c0', ['0-a'], { candidateId: '0-a', rank: 1, roundScore: 100 });
  assert.equal(report.current.names[0], 'Test 0-a'); assert.equal(createDecisionHistory(fix).summary('c0').count, 0);
});
