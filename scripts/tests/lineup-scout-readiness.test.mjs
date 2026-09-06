import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessLineupScoutReadiness } from '../lib/lineup-scout-readiness.mjs';
import { parseReadinessArgs, readReadinessMetadata, runReadinessAudit } from '../audit-lineup-scout-readiness.mjs';

// Synthetic contract fixtures, deliberately not claimed to be fitted NBA
// results. Predictive accuracy must still come from the real package's tests.
const digest = value => createHash('sha256').update(value).digest('hex');
const metrics = (mse, possessions = 80, observations = 8) => ({
  weightedMse: mse, weightedRmsePer100: 100 * Math.sqrt(mse),
  weightedMaePer100: 50, weightedBiasPredictedMinusObservedPer100: 0,
  heldOutPossessions: possessions, directionalObservationCount: observations,
});
const interval = (count, first, last) => ({ gameCount: count, firstScheduledAt: first, lastScheduledAt: last });

function chronological(model) {
  return {
    version: 'chronological_latest_season_tune_test_v1', model, latestSeasonStartYear: 2025,
    method: 'prior_seasons_plus_chronological_latest_season_train_tune_test_v1',
    selectedPriorSeasonWeight: 0.5, selectedLambda: 10,
    tuningGameFraction: 0.2, testGameFraction: 0.2,
    tuningSelection: { fitStatus: 'scored', priorSeasonWeight: 0.5, lambda: 10 },
    candidates: [{ fitStatus: 'scored', priorSeasonWeight: 0.5, lambda: 10 }],
    split: {
      priorSeasonsTraining: interval(20, '2022-10-18T23:00:00Z', '2025-06-22T23:00:00Z'),
      latestSeasonTraining: interval(6, '2025-10-21T23:00:00Z', '2026-01-20T23:00:00Z'),
      latestSeasonTuning: interval(2, '2026-02-02T23:00:00Z', '2026-03-03T23:00:00Z'),
      latestSeasonTest: interval(2, '2026-03-20T23:00:00Z', '2026-06-11T23:00:00Z'),
    },
    test: {
      status: 'validated', fullModel: metrics(0.8), fixedEffectsBaseline: metrics(1),
      fullModelMseImprovementVsFixedEffectsBaseline: 0.2, fullModelImprovesBaseline: true,
    },
  };
}

function fixture() {
  const model = name => ({
    seasonEndYear: 2026, solver: { converged: true }, lambda: 10, priorSeasonWeight: 0.5,
    gameCount: 30, directionalObservationCount: 8, totalOffensivePossessions: 100,
    totalEffectiveOffensivePossessions: 80, chronologicalCalibration: chronological(name),
  });
  const od = model('offenseDefense');
  od.calibration = {
    version: 'game_fold_directional_ablation_v1', status: 'validated',
    method: 'deterministic_sorted_game_round_robin_fixed_lambda_weighted_out_of_fold_v1',
    fixedLambda: 10, requestedFoldCount: 5, foldCount: 5, gameCount: 30,
    directionalObservationCount: 8, heldOutPossessions: 80,
    fullModel: metrics(0.8), venueBaseline: metrics(1),
    withoutOffensePlayerEffects: metrics(0.9), withoutDefensePlayerEffects: metrics(0.95),
    fullModelMseImprovementVsVenueBaseline: 0.2,
    offenseComponentMseImprovementVsWithoutOffense: (0.9 - 0.8) / 0.9,
    defenseComponentMseImprovementVsWithoutDefense: (0.95 - 0.8) / 0.95,
    fullModelImprovesBaseline: true, offenseComponentDoesNotDegrade: true,
    defenseComponentDoesNotDegrade: true, allComponentsImproved: true,
    unseenPlayerDirectionPossessions: 0, unseenPlayerDirectionCount: 0, unseenPlayerPossessionShare: 0,
  };
  const sourceValidation = {
    passed: true, validatorVersion: 'sportradar-nba-local-archive-validator-v4',
    archiveScope: { seasons: [2022, 2023, 2024, 2025] }, errors: [], warnings: [],
  };
  const sourceValidationSha256 = digest(JSON.stringify(sourceValidation));
  const net = model('net');
  delete net.solver; // Actual schema-v4 net exports omit this optional field.
  const manifest = {
    schemaVersion: 4, metricsVersion: 'nba-scout-metrics-v4',
    scope: { seasonStartYear: 2022, seasonStartYears: [2022, 2023, 2024, 2025], latestSeasonStartYear: 2025, seasonEndYear: 2026 },
    storage: { writeMode: 'bounded_memory_atomic_team_stream_v1' },
    provenance: {
      sourceArchiveValidationPassed: true, sourceValidatorVersion: sourceValidation.validatorVersion,
      sourceValidationReportSha256: sourceValidationSha256,
    },
    rapm: { net, offenseDefense: od },
  };
  const manifestSha256 = digest(JSON.stringify(manifest));
  return {
    manifest, manifestSha256, sourceValidation, sourceValidationSha256,
    packageValidation: {
      schemaVersion: 3, passed: true, inputSha256: manifestSha256, errors: [], warnings: [],
      checks: { teams: 30, playerProfiles: 5 },
    },
    expectedSeasonStartYears: [2022, 2023, 2024, 2025],
  };
}

test('completed, bound, calibrated metadata permits review but never authorizes promotion', () => {
  const result = assessLineupScoutReadiness(fixture());
  assert.equal(result.status, 'ready_for_integration_review', JSON.stringify(result.errors));
  assert.equal(result.readyForIntegrationReview, true);
  assert.equal(result.livePromotionApproved, false);
  assert.match(result.limitations.join(' '), /box-score completeness/);
});

for (const field of ['manifest', 'packageValidation', 'sourceValidation']) {
  test(`missing ${field} is pending, not success or a reason to use an older package`, () => {
    const input = fixture(); input[field] = null;
    const result = assessLineupScoutReadiness(input);
    assert.equal(result.status, 'pending');
    assert.equal(result.readyForIntegrationReview, false);
    assert.ok(result.pending.some(message => message.includes(field)));
  });
}

const blockedCases = [
  ['failed package validation', input => { input.packageValidation.passed = false; }],
  ['PASS with unresolved errors', input => { input.packageValidation.errors = ['unreconciled totals']; }],
  ['unrecognized report version', input => { input.packageValidation.schemaVersion = 4; }],
  ['wrong manifest hash', input => { input.packageValidation.inputSha256 = 'a'.repeat(64); }],
  ['wrong source report hash', input => { input.sourceValidationSha256 = 'a'.repeat(64); }],
  ['older two-season scope', input => { input.manifest.scope.seasonStartYears = [2024, 2025]; }],
  ['duplicate season', input => { input.manifest.scope.seasonStartYears = [2022, 2023, 2025, 2025]; }],
  ['source validation incomplete', input => { input.sourceValidation.passed = false; }],
  ['source scope incomplete', input => { input.sourceValidation.archiveScope.seasons.pop(); }],
  ['missing team coverage', input => { input.packageValidation.checks.teams = 29; }],
  ['no player profiles', input => { input.packageValidation.checks.playerProfiles = 0; }],
  ['unconverged solver', input => { input.manifest.rapm.offenseDefense.solver.converged = false; }],
  ['missing required O/D solver', input => { delete input.manifest.rapm.offenseDefense.solver; }],
  ['explicit net solver failure', input => { input.manifest.rapm.net.solver = { converged: false }; }],
  ['missing model', input => { delete input.manifest.rapm.offenseDefense; }],
  ['missing component calibration', input => { delete input.manifest.rapm.offenseDefense.calibration; }],
  ['component status contradicts metrics', input => { input.manifest.rapm.offenseDefense.calibration.allComponentsImproved = false; }],
  ['defense ablation is better', input => { input.manifest.rapm.offenseDefense.calibration.withoutDefensePlayerEffects = metrics(0.7); }],
  ['unweighted instead of effective possessions', input => { input.manifest.rapm.offenseDefense.totalEffectiveOffensivePossessions = 100; }],
  ['missing chronology', input => { delete input.manifest.rapm.offenseDefense.chronologicalCalibration; }],
  ['wrong fitted lambda', input => { input.manifest.rapm.offenseDefense.lambda = 100; }],
  ['held-out test does not improve baseline', input => { input.manifest.rapm.offenseDefense.chronologicalCalibration.test.fullModel = metrics(1.1); }],
  ['different comparison denominators', input => { input.manifest.rapm.offenseDefense.chronologicalCalibration.test.fixedEffectsBaseline.heldOutPossessions++; }],
  ['empty held-out sample', input => { const t = input.manifest.rapm.offenseDefense.chronologicalCalibration.test; t.fullModel.heldOutPossessions = t.fixedEffectsBaseline.heldOutPossessions = 0; }],
  ['missing game dates', input => { input.manifest.rapm.offenseDefense.chronologicalCalibration.split.latestSeasonTest.firstScheduledAt = null; }],
  ['test precedes tuning', input => { input.manifest.rapm.offenseDefense.chronologicalCalibration.split.latestSeasonTest.firstScheduledAt = '2025-12-01T00:00:00Z'; }],
  ['empty tuning sample', input => { input.manifest.rapm.offenseDefense.chronologicalCalibration.split.latestSeasonTuning.gameCount = 0; }],
  ['null MSE is not zero error', input => { input.manifest.rapm.offenseDefense.chronologicalCalibration.test.fullModel.weightedMse = null; }],
  ['nonfinite MSE', input => { input.manifest.rapm.offenseDefense.chronologicalCalibration.test.fullModel.weightedMse = Infinity; }],
];
for (const [name, mutate] of blockedCases) {
  test(`fails closed: ${name}`, () => {
    const input = fixture(); mutate(input);
    const result = assessLineupScoutReadiness(input);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.ok(result.errors.length > 0);
    assert.equal(result.livePromotionApproved, false);
  });
}

test('expected scope must be explicit, numeric, and unique', () => {
  for (const expectedSeasonStartYears of [[], [2025], [2022, 2022], ['2022', '2025']]) {
    assert.throws(() => assessLineupScoutReadiness({ ...fixture(), expectedSeasonStartYears }), /distinct NBA/);
  }
});

test('warnings remain visible without being mislabeled as missing evidence', () => {
  const input = fixture(); input.sourceValidation.warnings.push('Some fields are unavailable.');
  input.manifest.rapm.offenseDefense.chronologicalCalibration.split.latestSeasonTest.firstScheduledAt = '2026-03-03T23:00:00Z';
  const result = assessLineupScoutReadiness(input);
  assert.equal(result.status, 'ready_for_integration_review');
  assert.match(result.warnings.join(' '), /not universal stat completeness/);
  assert.match(result.warnings.join(' '), /disjoint game IDs/);
});

test('read-only CLI binds actual file bytes, rejects truncated JSON, and reports missing outputs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lineup-scout-readiness-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); // Only this test's unique temp directory.
  const input = fixture();
  for (const field of ['manifest', 'packageValidation', 'sourceValidation']) {
    await fs.writeFile(path.join(directory, `${field}.json`), JSON.stringify(input[field]));
  }
  const args = [
    '--manifest', path.join(directory, 'manifest.json'),
    '--package-validation', path.join(directory, 'packageValidation.json'),
    '--source-validation', path.join(directory, 'sourceValidation.json'),
    '--seasons', '2022,2023,2024,2025',
  ];
  assert.equal((await runReadinessAudit(args)).status, 'ready_for_integration_review');
  const metadata = await readReadinessMetadata(args[1]);
  assert.equal(metadata.sha256, input.manifestSha256);
  // Even harmless whitespace changes the bytes attested by an old report.
  await fs.appendFile(args[1], '\n');
  assert.equal((await runReadinessAudit(args)).status, 'blocked');
  await fs.writeFile(args[1], '{"incomplete":');
  await assert.rejects(() => runReadinessAudit(args), SyntaxError);
  args[1] = path.join(directory, 'not-built-yet.json');
  assert.equal((await runReadinessAudit(args)).status, 'pending');
  const cli = spawnSync(process.execPath, [path.resolve('scripts/audit-lineup-scout-readiness.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'pending');
  assert.throws(() => parseReadinessArgs([...args, '--apply', 'true']), /exactly once/);
});
