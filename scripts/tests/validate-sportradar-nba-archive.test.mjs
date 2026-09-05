import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARCHIVE_VALIDATOR_PATH = path.join(
  REPOSITORY_ROOT,
  'outputs',
  '01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e',
  'nba-last-five-seasons',
  'work',
  'validate-sportradar-nba-archive.mjs',
);
const archiveValidatorAvailable = await fs.access(ARCHIVE_VALIDATOR_PATH)
  .then(() => true)
  .catch(() => false);
const { checkRecordSourceAccessLevel, checkSummaryTeamIntegrity } = archiveValidatorAvailable
  ? await import(pathToFileURL(ARCHIVE_VALIDATOR_PATH).href)
  : {};
const privateValidatorTest = archiveValidatorAvailable
  ? {}
  : { skip: 'The local private archive validator is not available in this checkout.' };

function validSummaryFixture() {
  return {
    game: {
      homeProviderTeamId: 'home-team',
      awayProviderTeamId: 'away-team',
      homePoints: 108,
      awayPoints: 97,
    },
    teams: [
      {
        id: 'home-team',
        points: 108,
        pointsAgainst: 97,
        possessions: 99.4,
        opponentPossessions: 97.68,
        offensiveRating: (100 * 108) / 99.4,
        defensiveRating: (100 * 97) / 97.68,
      },
      {
        id: 'away-team',
        points: 97,
        pointsAgainst: 108,
        possessions: 97.68,
        opponentPossessions: 99.4,
        offensiveRating: (100 * 97) / 97.68,
        defensiveRating: (100 * 108) / 99.4,
      },
    ],
  };
}

test('summary-team integrity reconciles final scores and rating algebra', privateValidatorTest, () => {
  const result = checkSummaryTeamIntegrity(validSummaryFixture());

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.dataQuality.gamesWithSummaryTeamScoreNonReconciliation, 0);
  assert.equal(result.dataQuality.summaryTeamOffensiveRatingAlgebraDiagnostics, 0);
  assert.equal(result.dataQuality.summaryTeamDefensiveRatingAlgebraDiagnostics, 0);
  assert.equal(result.dataQuality.summaryTeamPossessionSymmetryDiagnostics, 0);
});

test('summary-team integrity treats final-score disagreement as a hard error', privateValidatorTest, () => {
  const fixture = validSummaryFixture();
  fixture.teams[0].points = 107;
  fixture.teams[0].offensiveRating = (100 * 107) / fixture.teams[0].possessions;

  const result = checkSummaryTeamIntegrity({
    ...fixture,
    context: { seasonStartYear: 2025, gameId: 'game-1' },
  });

  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0], {
    code: 'record_summary_team_score_mismatch',
    seasonStartYear: 2025,
    gameId: 'game-1',
    side: 'home',
    providerTeamId: 'home-team',
    expectedPoints: 108,
    actualPoints: 107,
    expectedPointsAgainst: 97,
    actualPointsAgainst: 97,
  });
  assert.equal(result.dataQuality.gamesWithSummaryTeamScoreNonReconciliation, 1);
});

test('summary-team diagnostics are null-safe and remain warnings', privateValidatorTest, () => {
  const fixture = validSummaryFixture();
  fixture.teams[0].offensiveRating = null;
  fixture.teams[0].possessions = null;
  fixture.teams[0].defensiveRating = 0;
  fixture.teams[1].opponentPossessions = null;

  const result = checkSummaryTeamIntegrity(fixture);
  const warningCodes = new Set(result.warnings.map((warning) => warning.code));

  assert.deepEqual(result.errors, []);
  assert.ok(warningCodes.has('record_summary_team_offensive_rating_algebra_unverified'));
  assert.ok(warningCodes.has('record_summary_team_defensive_rating_algebra_mismatch'));
  assert.ok(warningCodes.has('record_summary_team_possession_symmetry_unverified'));
  assert.equal(result.dataQuality.gamesWithSummaryTeamOffensiveRatingAlgebraDiagnostics, 1);
  assert.equal(result.dataQuality.gamesWithSummaryTeamDefensiveRatingAlgebraDiagnostics, 1);
  assert.equal(result.dataQuality.gamesWithSummaryTeamPossessionSymmetryDiagnostics, 1);
});

test('record access level must match the manifest access level', privateValidatorTest, () => {
  assert.deepEqual(checkRecordSourceAccessLevel({
    source: { accessLevel: 'trial' },
    manifestAccessLevel: 'trial',
    context: { seasonStartYear: 2025, gameId: 'game-1' },
  }), []);
  assert.deepEqual(checkRecordSourceAccessLevel({
    source: { accessLevel: 'production' },
    manifestAccessLevel: 'trial',
    context: { seasonStartYear: 2025, gameId: 'game-1' },
  }), [{
    code: 'record_source_access_level_mismatch',
    seasonStartYear: 2025,
    gameId: 'game-1',
    expectedAccessLevel: 'trial',
    actualAccessLevel: 'production',
  }]);
});
