import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildGameRoleModel,
  buildChallengeRun,
  evaluateFixTheFiveChallenge,
  formatSignedPoints,
  hasLegalPositionAssignment,
  validateFixTheFiveFixtures,
} from '../../tools/fix-the-five/game-engine.js';
import { FIX_THE_FIVE_FIXTURES } from '../../tools/fix-the-five/fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roster = JSON.parse(fs.readFileSync(
  path.join(root, 'lineup-lab', 'fixtures', 'timberwolves-2021-22.json'),
  'utf8',
)).players;

test('Fix the Five ships fifteen curated, test-validated legal historical fixtures', () => {
  const results = validateFixTheFiveFixtures(FIX_THE_FIVE_FIXTURES, roster);
  assert.equal(results.length, 15);

  results.forEach((result) => {
    assert.equal(result.best.candidateId, result.challenge.answerId);
    assert.equal(result.best.roundScore, 100);
    assert.equal(result.candidates.length, result.challenge.candidateIds.length);
    result.candidates.forEach((candidate) => {
      assert.equal(candidate.legal, true);
      assert.ok(candidate.roundScore >= 0 && candidate.roundScore <= 100);
      assert.equal(candidate.selected.length, 5);
      assert.equal(new Set(candidate.selected.map((player) => player.id)).size, 5);
      assert.equal(
        hasLegalPositionAssignment(candidate.selected, result.challenge.positionMinimums),
        true,
      );
    });
  });
});

test('Fix the Five daily runs are deterministic, bounded, and non-repeating', () => {
  const first = buildChallengeRun(FIX_THE_FIVE_FIXTURES, '2026-09-05');
  const repeat = buildChallengeRun(FIX_THE_FIVE_FIXTURES, '2026-09-05');
  const next = buildChallengeRun(FIX_THE_FIVE_FIXTURES, '2026-09-06');

  assert.equal(first.length, 5);
  assert.deepEqual(first.map((fixture) => fixture.id), repeat.map((fixture) => fixture.id));
  assert.equal(new Set(first.map((fixture) => fixture.id)).size, 5);
  assert.notDeepEqual(first.map((fixture) => fixture.id), next.map((fixture) => fixture.id));
});

test('Fix the Five exposes a source-bounded DNA delta for every candidate', () => {
  const result = evaluateFixTheFiveChallenge(FIX_THE_FIVE_FIXTURES[0], roster);
  result.candidates.forEach((candidate) => {
    assert.equal(candidate.coverageDelta.length, 7);
    assert.equal(candidate.dna.strengths.length, 3);
    assert.equal(candidate.dna.needs.length, 3);
    assert.equal(
      Number((candidate.scoreBreakdown.directContribution + candidate.scoreBreakdown.dnaContribution).toFixed(8)),
      Number(candidate.composite.toFixed(8)),
    );
    assert.match(candidate.dna.evidence, /proxy/i);
    assert.match(candidate.dna.evidence, /minute-weighted center/i);
  });
});

test('Fix the Five exposes lower source-minute reliability without hiding a player row', () => {
  const model = buildGameRoleModel(roster);
  assert.ok(model.sampleReliabilityById.get('nathan-knight') < model.sampleReliabilityById.get('karl-anthony-towns'));
  assert.equal(model.ratePriorMinutes, 360);
});

test('Fix the Five rejects a published candidate that cannot satisfy the court shape', () => {
  const fixture = FIX_THE_FIVE_FIXTURES[0];
  const invalid = {
    ...fixture,
    id: 'min-2022-invalid-court-shape',
    candidateIds: ['malik-beasley', 'taurean-prince', 'jordan-mclaughlin'],
    answerId: 'taurean-prince',
  };
  assert.throws(
    () => evaluateFixTheFiveChallenge(invalid, roster),
    /breaks its required court shape/i,
  );
});

test('Fix the Five normalizes rounded signed zero for result copy', () => {
  assert.equal(formatSignedPoints(-0.01), '±0');
  assert.equal(formatSignedPoints(1.24), '+1.2');
  assert.equal(formatSignedPoints(-1.24), '−1.2');
});
