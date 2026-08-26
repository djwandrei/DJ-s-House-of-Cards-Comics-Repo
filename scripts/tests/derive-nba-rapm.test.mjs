import assert from 'node:assert/strict';
import test from 'node:test';
import { main, modelPayload, optionsFromArgs } from '../derive-nba-rapm.mjs';

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

test('RAPM persistence sends the model through the named JSONB RPC parameter', async () => {
  const prior = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    NBA_ANALYTICS_SUPABASE_URL: process.env.NBA_ANALYTICS_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NBA_RAPM_DERIVE_ALLOW_WRITE: process.env.NBA_RAPM_DERIVE_ALLOW_WRITE,
  };
  process.env.SUPABASE_URL = 'https://analytics-project.supabase.co';
  process.env.NBA_ANALYTICS_SUPABASE_URL = 'https://analytics-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.NBA_RAPM_DERIVE_ALLOW_WRITE = 'confirmed';
  const requests = [];
  const priorLog = console.log;
  console.log = () => {};
  try {
    await main(['--season-end', '2025', '--apply'], {
      requestJson: async (url, _serviceRoleKey, options) => {
        requests.push({ url, options });
        if (url.endsWith('/get_nba_rapm_stints')) {
          return [{
            gameId: 'fixture-game',
            stintOrdinal: 1,
            homePlayerIds: ['home-1', 'home-2', 'home-3', 'home-4', 'home-5'],
            awayPlayerIds: ['away-1', 'away-2', 'away-3', 'away-4', 'away-5'],
            homePoints: 4,
            awayPoints: 2,
            homeOffensivePossessions: 3,
            awayOffensivePossessions: 3,
          }];
        }
        return { modelRunId: 'fixture-model-run', playerCount: 0 };
      },
    });
  } finally {
    console.log = priorLog;
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const persistence = requests.find((request) => request.url.endsWith('/ingest_nba_rapm_model'));
  const body = JSON.parse(persistence.options.body);
  assert.deepEqual(Object.keys(body), ['p_payload']);
  assert.equal(body.p_payload.model.seasonEndYear, 2025);
  assert.equal(body.p_payload.model.seasonPhase, 'regular');
  assert.equal(body.p_payload.players.length, 10);
});
