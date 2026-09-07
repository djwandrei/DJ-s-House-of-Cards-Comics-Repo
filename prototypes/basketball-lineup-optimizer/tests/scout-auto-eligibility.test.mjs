import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptimizerCore } from './load-optimizer-core.mjs';

const { optimizeLineups } = await loadOptimizerCore();
const players = Array.from({ length: 9 }, (_, i) => ({
  id: `p${i}`, name: `Player ${i}`, team: 'TST', positions: ['G', 'F', 'C'],
  games: 60, starts: 30, minutes: 25, points: 14, rebounds: 5, assists: 3, steals: 1,
  blocks: .5, turnovers: 2, fgPct: .5, threePct: .35, efgPct: .55, ftPct: .8,
}));
function config() {
  return { mode: 'rotation', size: 8, alternatives: 2, modelMode: 'scout',
    scoutEvidence: { model: { calibration: { status: 'validated', allComponentsImproved: true } },
      players: Object.fromEntries(players.map((p, i) => [p.id, {
        offense: i, defense: 1, reliability: .5, alreadyRegularized: true, displayEligible: true,
      }])) }, rotationOptions: { minMinutes: 30, maxMinutes: 30, minutePlan: 'openWhatIf' } };
}

test('automatically exclude an unsupported optional player, then solve the exact reduced pool', () => {
  const input = config(); delete input.scoutEvidence.players.p8;
  const before = structuredClone(input), poolBefore = structuredClone(players);
  const result = optimizeLineups(players, input);
  const manual = optimizeLineups(players.slice(0, 8), input);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.deepEqual(result.best.playerIds, manual.best.playerIds);
  assert.equal(result.best.score, manual.best.score);
  assert.deepEqual(result.best.rotation.byId, manual.best.rotation.byId);
  assert.equal(result.best.rotation.totalMinutes, 240);
  assert.equal(result.diagnostics.estimatedCombinations, 1);
  assert.deepEqual(result.diagnostics.dataEligibility.excludedPlayers.map(p => p.id), ['p8']);
  assert.equal(result.diagnostics.dataEligibility.candidateCount, 9);
  assert.equal(result.diagnostics.dataEligibility.eligibleCount, 8);
  assert.deepEqual(input, before, 'Per-run exclusions must not rewrite shared URL/lock state.');
  assert.deepEqual(players, poolBefore, 'No mutation of caller evidence or players.');
  assert.equal(result.diagnostics.scoutImpactModel.available, true);
});

test('data coverage failure never silently changes a lock, roster size, or model', () => {
  const locked = config(); delete locked.scoutEvidence.players.p8; locked.lockedIds = ['p8'];
  const conflict = optimizeLineups(players, locked);
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /Locked player "Player 8" lacks required data/);
  assert.deepEqual(conflict.diagnostics.dataEligibility.lockedPlayerIds, ['p8']);
  const short = config(); delete short.scoutEvidence.players.p8; delete short.scoutEvidence.players.p7;
  const insufficient = optimizeLineups(players, short);
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.size, 8);
  assert.match(insufficient.reason, /Only 7 eligible players/);
  assert.equal(insufficient.diagnostics.dataEligibility.excludedPlayers.length, 2);
  const empty = config(); empty.scoutEvidence.players = {};
  const none = optimizeLineups(players, empty);
  assert.equal(none.ok, false);
  assert.equal(none.diagnostics.dataEligibility.eligibleCount, 0);
});

test('broken package validation is not a removable-player coverage issue', () => {
  for (const mutation of [
    c => { delete c.scoutEvidence.model; },
    c => { c.scoutEvidence.model.calibration.allComponentsImproved = false; },
    c => { c.sourceScope = { seasonEndYear: 2026, team: 'TST' }; },
  ]) {
    const input = config(); mutation(input);
    const result = optimizeLineups(players, input);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.subcategory, 'scout-evidence');
    assert.equal(result.diagnostics.dataEligibility, undefined);
  }
});

test('invalid components are excluded, measured zero and poor impact remain eligible', () => {
  for (const patch of [{ offense: null }, { defense: '' }, { reliability: 2 }, { displayEligible: false }]) {
    const input = config(); Object.assign(input.scoutEvidence.players.p8, patch);
    const result = optimizeLineups(players, input);
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    assert.deepEqual(result.diagnostics.dataEligibility.excludedPlayers.map(p => p.id), ['p8']);
  }
  const input = config(); Object.assign(input.scoutEvidence.players.p8, { offense: 0, defense: -8, reliability: 0 });
  input.lockedIds = ['p8'];
  const result = optimizeLineups(players, input);
  assert.equal(result.ok, true);
  assert.ok(result.best.playerIds.includes('p8'));
  assert.equal(result.diagnostics.dataEligibility.excludedPlayers.length, 0);
});

test('sample/user exclusions are not misreported as automatic data exclusions; restored rows are retried', () => {
  const input = config(); delete input.scoutEvidence.players.p8; input.excludedIds = ['p8'];
  assert.equal(optimizeLineups(players, input).diagnostics.dataEligibility.excludedPlayers.length, 0);
  delete input.excludedIds;
  assert.equal(optimizeLineups(players, input).diagnostics.dataEligibility.excludedPlayers.length, 1);
  input.scoutEvidence.players.p8 = { offense: 20, defense: 10, reliability: 1 };
  const restored = optimizeLineups(players, input);
  assert.equal(restored.diagnostics.dataEligibility.excludedPlayers.length, 0);
  assert.ok(restored.best.playerIds.includes('p8'));
  const historical = optimizeLineups(players, { ...input, modelMode: 'historical', weights: { points: 1 } });
  assert.equal(historical.ok, true);
  assert.equal(historical.diagnostics.dataEligibility.excludedPlayers.length, 0);
});

test('five-player mode and positional infeasibility use the same data eligibility filter', () => {
  const input = { ...config(), mode: 'lineup', size: 5 };
  delete input.scoutEvidence.players.p8;
  const five = optimizeLineups(players, input);
  assert.equal(five.ok, true);
  assert.ok(!five.best.playerIds.includes('p8'));
  const positionPool = players.map((p, i) => ({ ...p, positions: i === 8 ? ['C'] : ['G', 'F'] }));
  const failed = optimizeLineups(positionPool, { ...input, positionMinimums: { G: 2, F: 2, C: 1 } });
  assert.equal(failed.ok, false);
  assert.ok(failed.reasons.some(r => /positional minimums/.test(r)));
  assert.equal(failed.diagnostics.dataEligibility.excludedPlayers.length, 1);
});
