import assert from 'node:assert/strict';
import test from 'node:test';
import { modelPayload, optionsFromArgs } from '../derive-nba-rapm.mjs';

test('RAPM derivation parser requires an explicit season and safe scope', () => {
  assert.throws(() => optionsFromArgs([]), /season-end is required/);
  assert.deepEqual(optionsFromArgs(['--season-end', '2025', '--phase', 'playoffs', '--lambda', '25', '--minimum-exposure', '50']), {
    help: false,
    apply: false,
    seasonEndYear: 2025,
    phase: 'playoffs',
    lambda: 25,
    minimumExposure: 50,
    reportPath: '',
  });
  assert.throws(() => optionsFromArgs(['--season-end', '2025', '--phase', 'all']), /regular or playoffs/);
});

test('RAPM model payload preserves reproducibility fields and display threshold', () => {
  const payload = modelPayload({
    modelVersion: 'fixture-v1', seasonEndYear: 2025, seasonPhase: 'regular', lambda: 10,
    observationCount: 3, gameCount: 2, excludedStintCount: 1,
    inputSha256: 'a'.repeat(64), excluded: [{}],
    players: [{ providerPlayerId: '00000000-0000-4000-8000-000000000001', rapmPer100: 1.2, pairedPossessions: 99, observationCount: 2, teammateRapmContextPer100: 0.2, opponentRapmContextPer100: -0.1 }],
  }, { minimumExposure: 100, codeVersion: 'test-code' });
  assert.equal(payload.model.codeVersion, 'test-code');
  assert.match(payload.model.errorSummary, /1 invalid/);
  assert.equal(payload.players[0].displayEligible, false);
});
