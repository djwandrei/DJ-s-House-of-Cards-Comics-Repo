import assert from 'node:assert/strict';
import test from 'node:test';
import { publicStat, publicStatLine, comparePublicPlayers, boardRules, draftNeeds, validOnePickAlternatives } from '../../tools/game-decision-model.js';
const player = (id, stats = {}) => ({ id, name: id, stats });
const deck = { publishedPathCount: 243, rounds: Array.from({ length: 5 }, (_, i) => ({
  id: `r${i}`, title: `Slot ${i}`, slot: ['G', 'G', 'F', 'F', 'C'][i], candidates: [player(`a${i}`), player(`b${i}`), player(`c${i}`)],
})) };
const picks = deck.rounds.map(round => round.candidates[0].id);
test('public comparisons preserve missing values and zero without coercion', () => {
  for (const value of [null, undefined, '', '10', false, NaN, Infinity, -1]) assert.equal(publicStat(player('a', { points: value }), 'points'), null);
  assert.equal(publicStat(player('a', { points: 0 }), 'points'), 0);
  assert.equal(publicStat(player('a', { rawScore: 20 }), 'rawScore'), null);
  assert.equal(publicStatLine(player('a')), 'Public source stats unavailable');
  const rows = comparePublicPlayers([player('b', { points: 4 })], player('a', { points: 0 }));
  assert.deepEqual(rows[0], { key: 'points', label: 'Points', baseline: 0, values: [4] });
  assert.equal(rows[1].baseline, null);
});
test('decision rules use disclosed role minimums, not invented skills', () => {
  assert.match(boardRules({ positionMinimums: { G: 2, F: 2, C: 1 } }), /2 guards/);
  assert.match(boardRules({ positionMinimums: { G: -1 } }), /only the legal candidates/);
});
test('draft checklist follows fixed rounds without double-counting flexible positions', () => {
  const original = structuredClone(deck);
  for (let i = 0; i <= 5; i++) {
    const report = draftNeeds(deck, picks.slice(0, i));
    assert.equal(report.picked, i); assert.equal(report.remaining.length, 5 - i);
    assert.equal(report.filled.length, i);
  }
  assert.equal(draftNeeds(deck, ['wrong']), null);
  assert.equal(draftNeeds(deck, ['a0', 'a0']), null);
  assert.equal(draftNeeds(deck, [...picks, 'a5']), null);
  assert.deepEqual(deck, original);
});
test('one-pick suggestions require matching round, player, and sealed score difference', () => {
  const alternative = { roundId: 'r2', fromPlayerId: 'a2', toPlayerId: 'b2', rank: 10, roundScore: 70, scoreChange: 20 };
  const outcome = { selectionIds: picks, roundScore: 50, onePickAlternatives: [alternative] };
  const result = validOnePickAlternatives(deck, picks, outcome);
  assert.equal(result.length, 1); assert.equal(result[0].index, 2); assert.equal(result[0].to.id, 'b2');
  for (const invalid of [{ fromPlayerId: 'a0' }, { toPlayerId: 'b3' }, { toPlayerId: 'a2' }, { scoreChange: 99 }, { rank: 244 }, { rank: null }, { roundScore: null }]) {
    assert.deepEqual(validOnePickAlternatives(deck, picks, { ...outcome, onePickAlternatives: [{ ...alternative, ...invalid }] }), []);
  }
  assert.deepEqual(validOnePickAlternatives(deck, picks.slice(0, 4), outcome), []);
  assert.deepEqual(validOnePickAlternatives(deck, picks, { roundScore: 50 }), []);
  assert.deepEqual(validOnePickAlternatives(deck, picks, { ...outcome, selectionIds: [...picks].reverse() }), []);
  assert.deepEqual(picks, ['a0', 'a1', 'a2', 'a3', 'a4']);
});
