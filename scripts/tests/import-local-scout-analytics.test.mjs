import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  buildScoutArchiveQueryPlan,
  optionsFromArgs,
  runScoutArchiveImport,
} from '../import-local-scout-analytics.mjs';

const TEAM_ID = '583ecb3a-fb46-11e1-82cb-f4ce4684ea4c';
const PLAYER_A_ID = '6bc71e02-9a03-40db-aed4-332ab5193336';
const PLAYER_B_ID = '6bc71e03-9a03-40db-aed4-332ab5193336';
const IMPORT_ID = '8bc71e02-9a03-40db-aed4-332ab5193336';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function metric() {
  return {
    games: 1,
    totalPossessions: 100,
    offensiveRating: 112.5,
    defensiveRating: 109.5,
    netRating: 3,
    reliability: { possessions: 100, grade: 'medium', publishable: true, reliabilityScore: 0.6 },
    fourFactors: { offense: { effectiveFieldGoalPercentage: 0.52 }, defense: { effectiveFieldGoalPercentage: 0.5 } },
  };
}

function sourceShard() {
  return {
    schemaVersion: 4,
    metricsVersion: 'nba-scout-metrics-v4',
    seasonStartYear: 2025,
    seasonEndYear: 2026,
    team: { teamId: TEAM_ID, team: 'Fixture Team', contexts: { all: metric(), 'phase:regular': metric() } },
    lineupsAndCombinations: [{
      teamId: TEAM_ID,
      team: 'Fixture Team',
      size: 2,
      semantics: 'shared_floor_co_presence_combination',
      playerIds: [PLAYER_B_ID, PLAYER_A_ID],
      players: ['Player B', 'Player A'],
      minutes: 20,
      exposure: { games: 1, possessions: 100 },
      continuity: { gamesUsed: 1 },
      // This mirrors the current derived Scout package. The importer must
      // retain the projection fields Lineup Lab needs while discarding the
      // raw-shaped field below before any private RPC call.
      projection: {
        status: 'available',
        model: 'fixture-possession-lineup-v1',
        playerCount: 2,
        rapmSumPer100: 1.25,
        averageOpponentLineupRapmPer100: -0.2,
        homeCourtExposureAdjustmentPer100: 0.1,
        expectedObservedNetRatingPer100: 1.55,
        contextAdjustmentStatus: 'applied',
        observedNetRating: 1.5,
        observedPossessions: 100,
        rawObservedSynergyPer100: 0.5,
        synergyPriorPossessions: 400,
        synergyWeight: 0.2,
        shrunkSynergyPer100: 0.1,
        projectedNetRatingPer100: 1.35,
        projectedObservedContextNetRatingPer100: 1.45,
        caveat: 'fixture only',
        reliability: {
          possessions: 100,
          grade: 'medium',
          publishable: true,
          reliabilityScore: 0.6,
          method: 'fixture',
        },
        rawPbp: { forbidden: true },
      },
      contexts: { all: metric() },
    }],
    playerOnOff: [{
      teamId: TEAM_ID,
      team: 'Fixture Team',
      playerId: PLAYER_A_ID,
      player: 'Player A',
      scope: 'same-game player appearance',
      onMinutes: 20,
      offMinutes: 28,
      onOffNetRating: 3,
      exposure: { on: { possessions: 50 }, off: { possessions: 50 } },
      on: { all: metric() },
      off: { all: metric() },
      differences: { netRatingDifference: 3 },
    }],
    playerProfiles: [{
      teamId: TEAM_ID,
      team: 'Fixture Team',
      playerId: PLAYER_A_ID,
      player: 'Player A',
      scope: 'same-game player appearance',
      gamesAppeared: 1,
      minutes: 20,
      boxScore: { points: 10, defensiveRebounds: 3 },
      shooting: { trueShootingPercentage: 0.6 },
    }],
    wowy: [{
      teamId: TEAM_ID,
      team: 'Fixture Team',
      playerAId: PLAYER_B_ID,
      playerA: 'Player B',
      playerBId: PLAYER_A_ID,
      playerB: 'Player A',
      semantics: 'descriptive_same_game_shared_floor_wowy',
      cells: { a_on_b_on: { all: metric() }, a_off_b_on: { all: metric() } },
    }],
  };
}

async function fixtureArchive() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-query-import-'));
  const archive = path.join(root, 'outputs', 'fixture-scout-query-package');
  await fs.mkdir(path.join(archive, 'teams'), { recursive: true });
  const source = Buffer.from(JSON.stringify(sourceShard()));
  const gzip = gzipSync(source);
  const gzipPath = 'teams/fixture-team.json.gz';
  await fs.writeFile(path.join(archive, gzipPath), gzip);
  const manifest = {
    schemaVersion: 4,
    metricsVersion: 'nba-scout-metrics-v4',
    provider: 'Sportradar NBA v8 licensed local archive',
    scope: { seasonStartYear: 2025, seasonEndYear: 2026 },
    provenance: { sourceArchiveValidationPassed: true },
    tables: { teams: 1, lineupsAndCombinations: 1, playerOnOff: 1, playerProfiles: 1, wowy: 1 },
    rapm: {
      sourceMode: 'validated fixture',
      sourceExactLineupPossessions: 100,
      net: {
        modelVersion: 'fixture-net-v1', players: [{
          providerPlayerId: PLAYER_A_ID, playerName: 'Player A', rapmPer100: 1.25,
          offensiveRapmPer100: 1, defensiveRapmPer100: 0.25, pairedPossessions: 100, displayEligible: true,
        }],
      },
      offenseDefense: {
        modelVersion: 'fixture-od-v1',
        calibration: {
          version: 'game_fold_directional_ablation_v1',
          status: 'validated',
          method: 'fixture-held-out-game-folds',
          fixedLambda: 25,
          requestedFoldCount: 5,
          foldCount: 5,
          gameCount: 82,
          directionalObservationCount: 164,
          heldOutPossessions: 8_200,
          fullModelMseImprovementVsVenueBaseline: 0.12,
          offenseComponentMseImprovementVsWithoutOffense: 0.04,
          defenseComponentMseImprovementVsWithoutDefense: 0.05,
          fullModelImprovesBaseline: true,
          offenseComponentDoesNotDegrade: true,
          defenseComponentDoesNotDegrade: true,
          allComponentsImproved: true,
          unseenPlayerDirectionPossessions: 0,
          unseenPlayerDirectionCount: 0,
          unseenPlayerPossessionShare: 0,
          inputSha256: 'b'.repeat(64),
          caveat: 'fixture calibration only',
          fullModel: {
            weightedMse: 0.8,
            weightedRmsePer100: 89.44,
            weightedMaePer100: 70,
            weightedBiasPredictedMinusObservedPer100: 0.1,
            heldOutPossessions: 8_200,
            directionalObservationCount: 164,
            perGamePredictions: [{ forbidden: true }],
          },
        },
        players: [{
          providerPlayerId: PLAYER_A_ID, playerName: 'Player A', combinedRapmPer100: 1.25,
          offensiveRapmPer100: 1, defensiveRapmPer100: 0.25, pairedPossessions: 100, displayEligible: true,
        }],
      },
    },
    dataShards: [{
      teamId: TEAM_ID,
      team: 'Fixture Team',
      jsonPath: 'teams/fixture-team.json',
      gzipPath,
      jsonBytes: source.length,
      jsonSha256: sha256(source),
      gzipBytes: gzip.length,
      gzipSha256: sha256(gzip),
      rows: { team: 1, lineupsAndCombinations: 1, playerOnOff: 1, playerProfiles: 1, wowy: 1 },
    }],
  };
  const manifestPath = path.join(archive, 'nba-scout-analytics-2025-26.json');
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(manifestPath, manifestBytes);
  await fs.writeFile(`${manifestPath}.gz`, gzipSync(manifestBytes));
  const validation = {
    schemaVersion: 3,
    inputSha256: sha256(manifestBytes),
    passed: true,
    errors: [],
    warnings: [],
    checks: { teams: 1, combinations: 1, onOff: 1, playerProfiles: 1, wowy: 1, netRapmPlayers: 1, offenseDefenseRapmPlayers: 1 },
  };
  await fs.writeFile(path.join(archive, 'nba-scout-analytics-2025-26.validation-v2.json'), JSON.stringify(validation));
  await fs.writeFile(path.join(archive, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(archive, 'boundary-role-repair-report.json'), '{}');
  return { root, archive };
}

function response(value, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) };
}

test('query importer defaults to a local validation plan and retains only compact query rows', async () => {
  const fixture = await fixtureArchive();
  try {
    const queryPlan = await buildScoutArchiveQueryPlan({ archiveDir: fixture.archive });
    assert.deepEqual(queryPlan.expectedRows, {
      teams: 1,
      lineups: 1,
      playerOnOff: 1,
      playerProfiles: 1,
      wowy: 1,
      rapmModels: 2,
      rapmPlayers: 2,
      teamContexts: 2,
      playerOnOffContexts: 2,
    });
    assert.equal(queryPlan.plan.bucket, 'nba-scout-analytics-archive');
    assert.equal(queryPlan.rapm.players.length, 2);
    assert.equal(queryPlan.validation.report.passed, true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('apply requires remote verification and write confirmation before any request', () => {
  assert.throws(() => optionsFromArgs(['--archive', 'outputs/example', '--apply']), /requires --verify-remote/);
  assert.throws(() => optionsFromArgs(['--archive', '..']), /workspace/);
});

test('guarded apply uses only private Storage and RPC endpoints and strips raw-shaped data', async () => {
  const fixture = await fixtureArchive();
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    NBA_ANALYTICS_SUPABASE_URL: process.env.NBA_ANALYTICS_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NBA_SCOUT_QUERY_IMPORT_ALLOW_WRITE: process.env.NBA_SCOUT_QUERY_IMPORT_ALLOW_WRITE,
  };
  try {
    const queryPlan = await buildScoutArchiveQueryPlan({ archiveDir: fixture.archive });
    process.env.SUPABASE_URL = 'https://analytics-fixture.supabase.co';
    process.env.NBA_ANALYTICS_SUPABASE_URL = 'https://analytics-fixture.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
    process.env.NBA_SCOUT_QUERY_IMPORT_ALLOW_WRITE = 'confirmed';
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/storage/v1/bucket/')) return response({ id: 'nba-scout-analytics-archive', public: false });
      if (url.includes('/storage/v1/object/list/')) {
        const request = JSON.parse(options.body);
        const folder = request.prefix;
        const rows = queryPlan.plan.artifacts
          .filter((artifact) => {
            const parent = artifact.kind === 'team-gzip-shard'
              ? `${queryPlan.plan.prefix}/teams`
              : queryPlan.plan.prefix;
            return parent === folder;
          })
          .map((artifact) => ({ name: path.posix.basename(artifact.remotePath), metadata: { size: artifact.bytes } }));
        return response(rows);
      }
      if (url.includes('/rpc/begin_nba_scout_archive_import')) return response({ archiveImportId: IMPORT_ID, mode: 'created-staging' });
      if (url.includes('/rpc/ingest_nba_scout_archive_shard')) return response({ mode: 'ingested' });
      if (url.includes('/rpc/ingest_nba_scout_rapm')) return response({ mode: 'ingested' });
      if (url.includes('/rpc/finalize_nba_scout_archive_import')) return response({ status: 'ready', mode: 'ready', counts: { teams: 1 } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const result = await runScoutArchiveImport({ archiveDir: fixture.archive, reportPath: null, verifyRemote: true, apply: true }, { fetchImpl });
    assert.equal(result.import.ingestedTeams, 1);
    assert.equal(calls.some((call) => /\/storage\/v1\/object\/(?!list\/)/.test(call.url)), false);
    assert.equal(calls.filter((call) => call.url.includes('/rest/v1/rpc/')).length, 4);
    const requestBodies = calls.map((call) => String(call.options.body ?? '')).join('\n');
    assert.equal(requestBodies.includes('playByPlay'), false);
    assert.equal(requestBodies.includes('providerPayload'), false);
    assert.equal(requestBodies.includes('rawPbp'), false);
    assert.equal(requestBodies.includes('aOnBOn'), true);
    const shardCall = calls.find((call) => call.url.includes('/rpc/ingest_nba_scout_archive_shard'));
    const shardPayload = JSON.parse(shardCall.options.body).p_payload;
    assert.deepEqual(shardPayload.lineups[0].projection, {
      status: 'available',
      model: 'fixture-possession-lineup-v1',
      playerCount: 2,
      rapmSumPer100: 1.25,
      averageOpponentLineupRapmPer100: -0.2,
      homeCourtExposureAdjustmentPer100: 0.1,
      expectedObservedNetRatingPer100: 1.55,
      contextAdjustmentStatus: 'applied',
      observedNetRating: 1.5,
      observedPossessions: 100,
      rawObservedSynergyPer100: 0.5,
      synergyPriorPossessions: 400,
      synergyWeight: 0.2,
      shrunkSynergyPer100: 0.1,
      projectedNetRatingPer100: 1.35,
      projectedObservedContextNetRatingPer100: 1.45,
      caveat: 'fixture only',
      reliability: {
        possessions: 100,
        grade: 'medium',
        publishable: true,
        reliabilityScore: 0.6,
        method: 'fixture',
      },
    });
    const rapmCall = calls.find((call) => call.url.includes('/rpc/ingest_nba_scout_rapm'));
    const rapmPayload = JSON.parse(rapmCall.options.body).p_payload;
    const offenseDefenseModel = rapmPayload.models.find((model) => model.model_kind === 'offense_defense');
    assert.deepEqual(offenseDefenseModel.model_metadata.calibration, {
      version: 'game_fold_directional_ablation_v1',
      status: 'validated',
      method: 'fixture-held-out-game-folds',
      fixedLambda: 25,
      requestedFoldCount: 5,
      foldCount: 5,
      gameCount: 82,
      directionalObservationCount: 164,
      heldOutPossessions: 8_200,
      fullModelMseImprovementVsVenueBaseline: 0.12,
      offenseComponentMseImprovementVsWithoutOffense: 0.04,
      defenseComponentMseImprovementVsWithoutDefense: 0.05,
      fullModelImprovesBaseline: true,
      offenseComponentDoesNotDegrade: true,
      defenseComponentDoesNotDegrade: true,
      allComponentsImproved: true,
      unseenPlayerDirectionPossessions: 0,
      unseenPlayerDirectionCount: 0,
      unseenPlayerPossessionShare: 0,
      inputSha256: 'b'.repeat(64),
      caveat: 'fixture calibration only',
      fullModel: {
        weightedMse: 0.8,
        weightedRmsePer100: 89.44,
        weightedMaePer100: 70,
        weightedBiasPredictedMinusObservedPer100: 0.1,
        heldOutPossessions: 8_200,
        directionalObservationCount: 164,
      },
    });
    assert.equal(JSON.stringify(rapmPayload).includes('perGamePredictions'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
