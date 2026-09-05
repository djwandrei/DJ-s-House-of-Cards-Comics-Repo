import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeRoleCoverage,
  explainOptimizationSelection,
} from '../../lineup-lab/fan-analytics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roster = JSON.parse(fs.readFileSync(
  path.join(root, 'lineup-lab', 'fixtures', 'timberwolves-2021-22.json'),
  'utf8',
)).players;
const selected = roster.filter((player) => [
  'anthony-edwards',
  'dangelo-russell',
  'jaden-mcdaniels',
  'jarred-vanderbilt',
  'karl-anthony-towns',
].includes(player.id));

test('Lineup DNA orders confirmed strengths by evidence signal instead of definition order', () => {
  const coverage = analyzeRoleCoverage(selected, { referencePlayers: roster });
  assert.equal(coverage.strengths[0].roleId, 'rebounder');
  assert.ok(coverage.strengths.every((entry, index, entries) => (
    index === 0 || entries[index - 1].coverageScore >= entry.coverageScore
  )));
  const rebounder = coverage.coverage.find((entry) => entry.roleId === 'rebounder');
  assert.equal(rebounder.coverageScore, rebounder.players[0].score);
});

test('Lineup DNA explanation keeps the evidence-ordered role coverage intact', () => {
  const explanation = explainOptimizationSelection({
    best: { players: selected },
  }, {
    candidatePool: roster,
    referencePlayers: roster,
  });
  assert.equal(explanation.available, true);
  assert.equal(explanation.roleCoverage.strengths[0].roleId, 'rebounder');
  assert.ok(explanation.roleCoverage.deficiencies.every((entry) => (
    entry.status === 'gap' || entry.status === 'thin'
  )));
});
