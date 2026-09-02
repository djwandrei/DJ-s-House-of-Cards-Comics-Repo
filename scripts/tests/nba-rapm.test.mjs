import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRapmObservations,
  fitWeightedRidgeOffenseDefenseRapm,
  fitWeightedRidgeRapm,
  RAPM_MODEL_VERSION,
  RAPM_OFFENSE_DEFENSE_MODEL_VERSION,
  selectWeightedRidgeOffenseDefenseLambda,
  selectWeightedRidgeRapmLambda,
} from '../lib/nba-rapm.mjs';

const home = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005'];
const away = ['00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000010'];

function sampleStints() {
  return [
    { gameId: 'game-a', stintOrdinal: 2, homePlayerIds: home, awayPlayerIds: away, homePoints: 12, awayPoints: 4, homeOffensivePossessions: 8, awayOffensivePossessions: 8 },
    { gameId: 'game-a', stintOrdinal: 1, homePlayerIds: home, awayPlayerIds: away, homePoints: 8, awayPoints: 4, homeOffensivePossessions: 8, awayOffensivePossessions: 8 },
    { gameId: 'game-b', stintOrdinal: 1, homePlayerIds: away, awayPlayerIds: home, homePoints: 3, awayPoints: 9, homeOffensivePossessions: 6, awayOffensivePossessions: 6 },
  ];
}

function crossValidationStints() {
  return [
    { gameId: 'game-a', stintOrdinal: 1, homePlayerIds: home, awayPlayerIds: away, homePoints: 20, awayPoints: 5, homeOffensivePossessions: 10, awayOffensivePossessions: 10 },
    { gameId: 'game-b', stintOrdinal: 1, homePlayerIds: away, awayPlayerIds: home, homePoints: 6, awayPoints: 18, homeOffensivePossessions: 10, awayOffensivePossessions: 10 },
    { gameId: 'game-c', stintOrdinal: 1, homePlayerIds: home, awayPlayerIds: away, homePoints: 17, awayPoints: 8, homeOffensivePossessions: 10, awayOffensivePossessions: 10 },
    { gameId: 'game-d', stintOrdinal: 1, homePlayerIds: away, awayPlayerIds: home, homePoints: 7, awayPoints: 19, homeOffensivePossessions: 10, awayOffensivePossessions: 10 },
  ];
}

test('RAPM observation build excludes invalid rows rather than inventing a lineup', () => {
  const built = buildRapmObservations([
    ...sampleStints(),
    { gameId: 'bad', homePlayerIds: home.slice(0, 4), awayPlayerIds: away, homePoints: 1, awayPoints: 1, homeOffensivePossessions: 1, awayOffensivePossessions: 1 },
  ]);
  assert.equal(built.observations.length, 3);
  assert.equal(built.excluded.length, 1);
  assert.match(built.excluded[0].reason, /exactly five/);
  assert.equal(built.observations[0].stintOrdinal, 1);
});

test('RAPM observation build rejects blank game IDs and invalid count values', () => {
  const base = sampleStints()[0];
  const built = buildRapmObservations([
    base,
    { ...base, gameId: '   ' },
    { ...base, gameId: 'negative-points', homePoints: -1 },
    { ...base, gameId: 'fractional-points', awayPoints: 1.5 },
    { ...base, gameId: 'negative-possessions', homeOffensivePossessions: -1 },
    { ...base, gameId: 'fractional-possessions', awayOffensivePossessions: 1.5 },
    { ...base, gameId: 'missing-points', homePoints: null },
    { ...base, gameId: 'blank-possessions', awayOffensivePossessions: ' ' },
  ]);
  assert.equal(built.observations.length, 1);
  assert.equal(built.excluded.length, 7);
  assert.match(built.excluded[0].reason, /gameId cannot be blank/);
  for (const excluded of built.excluded.slice(1)) {
    assert.match(excluded.reason, /non-negative integer/);
  }
});

test('offense/defense RAPM separates nominal-offense scoring from total scoreboard points', () => {
  const directional = {
    gameId: 'directional-points',
    stintOrdinal: 1,
    homePlayerIds: home,
    awayPlayerIds: away,
    homePoints: 11,
    awayPoints: 9,
    homeOffensePoints: 10,
    awayOffensePoints: 8,
    homeOffensivePossessions: 10,
    awayOffensivePossessions: 10,
  };
  const built = buildRapmObservations([directional]);
  assert.equal(built.observations[0].homeOffensePoints, 10);
  assert.equal(built.observations[0].awayOffensePoints, 8);
  assert.equal(built.observations[0].response, 0.2);

  const net = fitWeightedRidgeRapm([directional], { lambda: 10 });
  const offenseDefense = fitWeightedRidgeOffenseDefenseRapm([directional], { lambda: 10 });
  assert.ok(Math.abs(net.interceptPer100 - 20) < 1e-8);
  assert.ok(Math.abs(offenseDefense.baselineOffensiveRatingPer100 - 90) < 1e-8);

  const invalid = buildRapmObservations([{ ...directional, homeOffensePoints: 12 }]);
  assert.equal(invalid.observations.length, 0);
  assert.match(invalid.excluded[0].reason, /cannot exceed total scoreboard points/);

  const alternate = { ...directional, stintOrdinal: 2, homeOffensePoints: 9, awayOffensePoints: 9 };
  const firstOrder = fitWeightedRidgeOffenseDefenseRapm([directional, alternate], { lambda: 10 });
  const reverseOrder = fitWeightedRidgeOffenseDefenseRapm([alternate, directional], { lambda: 10 });
  assert.equal(firstOrder.inputSha256, reverseOrder.inputSha256);
});

test('offense/defense RAPM isolates a fixed home-court scoring effect from neutral players', () => {
  const fixedHomeStints = ['game-a', 'game-b', 'game-c', 'game-d'].map((gameId) => ({
    gameId,
    stintOrdinal: 1,
    homePlayerIds: home,
    awayPlayerIds: away,
    homePoints: 11,
    awayPoints: 10,
    homeOffensivePossessions: 10,
    awayOffensivePossessions: 10,
  }));
  const model = fitWeightedRidgeOffenseDefenseRapm(fixedHomeStints, { lambda: 100 });
  const reversed = fitWeightedRidgeOffenseDefenseRapm([...fixedHomeStints].reverse(), { lambda: 100 });
  const epsilon = 1e-8;

  assert.equal(model.inputSha256, reversed.inputSha256);
  assert.deepEqual(model.players, reversed.players);
  assert.ok(Math.abs(model.baselineOffensiveRatingPer100 - 105) < epsilon);
  assert.ok(Math.abs(model.homeCourtEffectPer100 - 5) < epsilon);
  assert.equal(model.homeCourtSignConvention, 'positive_increases_home_offensive_rate_and_decreases_away_offensive_rate');
  assert.ok(Math.abs(model.homeCourtNetRatingEffectPer100 - 10) < epsilon);
  assert.ok(Math.abs(
    model.baselineOffensiveRatingPer100 + model.homeCourtEffectPer100 - 110
  ) < epsilon);
  assert.ok(Math.abs(
    model.baselineOffensiveRatingPer100 - model.homeCourtEffectPer100 - 100
  ) < epsilon);
  for (const player of model.players) {
    assert.ok(Math.abs(player.offensiveRapmPer100) < epsilon);
    assert.ok(Math.abs(player.defensiveRapmPer100) < epsilon);
    assert.ok(Math.abs(player.combinedRapmPer100) < epsilon);
  }
  assert.equal(model.venueExposureDiagnostics.oneSidedPlayerCount, 10);
  assert.equal(model.venueExposureDiagnostics.maximumAbsoluteBalance, 1);
  assert.equal(model.players.find((row) => row.providerPlayerId === home[0]).venueExposure.signedVenueExposureBalance, 1);
  assert.equal(model.players.find((row) => row.providerPlayerId === away[0]).venueExposure.signedVenueExposureBalance, -1);
  assert.match(model.identification, /confounding risk/);
});

test('offense/defense RAPM fails closed when signed home-court terms are not identified', () => {
  const homeOnly = {
    gameId: 'home-only',
    stintOrdinal: 1,
    homePlayerIds: home,
    awayPlayerIds: away,
    homePoints: 10,
    awayPoints: 0,
    homeOffensivePossessions: 10,
    awayOffensivePossessions: 0,
  };
  assert.throws(
    () => fitWeightedRidgeOffenseDefenseRapm([homeOnly], { lambda: 100 }),
    /requires at least one positive-possession home direction and one positive-possession away direction/
  );

  const awayOnly = {
    ...homeOnly,
    gameId: 'away-only',
    homePoints: 0,
    awayPoints: 10,
    homeOffensivePossessions: 0,
    awayOffensivePossessions: 10,
  };
  assert.throws(
    () => selectWeightedRidgeOffenseDefenseLambda([homeOnly, awayOnly], {
      candidateLambdas: [1],
      foldCount: 2,
    }),
    /Lambda selection training fold 0 requires at least one positive-possession home direction and one positive-possession away direction/
  );
});

test('weighted ridge RAPM is deterministic and uses a non-regularized intercept', () => {
  const first = fitWeightedRidgeRapm(sampleStints(), { lambda: 5, seasonEndYear: 2025 });
  const second = fitWeightedRidgeRapm([...sampleStints()].reverse(), { lambda: 5, seasonEndYear: 2025 });
  assert.equal(first.modelVersion, RAPM_MODEL_VERSION);
  assert.equal(first.inputSha256, second.inputSha256);
  assert.deepEqual(first.players, second.players);
  assert.equal(first.observationCount, 3);
  assert.equal(first.gameCount, 2);
  assert.ok(first.players.find((row) => row.providerPlayerId === home[0]).rapmPer100 > 0);
  assert.ok(first.players.find((row) => row.providerPlayerId === away[0]).rapmPer100 < 0);
  assert.equal(first.players.find((row) => row.providerPlayerId === home[0]).observationCount, 3);
  assert.ok(Number.isFinite(first.players.find((row) => row.providerPlayerId === home[0]).teammateRapmContextPer100));
  assert.ok(Number.isFinite(first.players.find((row) => row.providerPlayerId === home[0]).opponentRapmContextPer100));
  const player = first.players.find((row) => row.providerPlayerId === home[0]);
  assert.equal(player.teammateRapmContextPer100, player.averageTeammateNetRapmPer100);
  assert.equal(player.opponentRapmContextPer100, player.averageOpponentNetRapmPer100);
  assert.equal(player.displayEligible, false);
  assert.equal(player.sampleSizeTier, 'insufficient');
  assert.ok(player.ridgeReliabilityProxy > 0 && player.ridgeReliabilityProxy < 1);
  assert.equal(first.lambdaSelection, null);
  assert.equal(first.homeCourtSignConvention, 'positive_increases_home_net_rating_relative_to_away');
  assert.equal(first.homeCourtNetRatingEffectPer100, first.interceptPer100);
  assert.match(first.formulation, /home_court_net_effect/);
});

test('game-fold lambda selection is deterministic, order-independent, and never splits games', () => {
  const first = selectWeightedRidgeRapmLambda(crossValidationStints(), {
    candidateLambdas: [50, 1, 5],
    foldCount: 3,
  });
  const second = selectWeightedRidgeRapmLambda([...crossValidationStints()].reverse(), {
    candidateLambdas: [5, 50, 1],
    foldCount: 3,
  });
  assert.equal(first.inputSha256, second.inputSha256);
  assert.deepEqual(first, second);
  assert.ok([1, 5, 50].includes(first.selectedLambda));
  assert.equal(first.foldCount, 3);
  assert.equal(first.folds.flatMap((fold) => fold.gameIds).length, 4);
  assert.equal(new Set(first.folds.flatMap((fold) => fold.gameIds)).size, 4);
  for (const candidate of first.candidates) {
    assert.ok(Number.isFinite(candidate.weightedMse));
    assert.ok(Number.isFinite(candidate.weightedRmsePer100));
    assert.equal(candidate.foldScores.length, 3);
  }

  const fitted = fitWeightedRidgeRapm(crossValidationStints(), {
    lambda: 'auto',
    lambdaCandidates: [1, 5, 50],
    lambdaFoldCount: 3,
  });
  assert.equal(fitted.lambda, fitted.lambdaSelection.selectedLambda);
});

test('separate offense/defense RAPM is deterministic and uses the documented defensive sign', () => {
  const options = {
    lambda: 1,
    seasonEndYear: 2025,
    displayPossessionThresholds: [1, 20, 50],
  };
  const first = fitWeightedRidgeOffenseDefenseRapm(crossValidationStints(), options);
  const second = fitWeightedRidgeOffenseDefenseRapm([...crossValidationStints()].reverse(), options);
  assert.equal(first.modelVersion, RAPM_OFFENSE_DEFENSE_MODEL_VERSION);
  assert.equal(first.inputSha256, second.inputSha256);
  assert.deepEqual(first.players, second.players);
  assert.equal(first.directionalObservationCount, 8);
  assert.equal(first.solver.converged, true);
  assert.match(first.defensiveSignConvention, /positive_is_better/);
  const strong = first.players.find((row) => row.providerPlayerId === home[0]);
  const weak = first.players.find((row) => row.providerPlayerId === away[0]);
  assert.ok(strong.offensiveRapmPer100 > weak.offensiveRapmPer100);
  assert.ok(strong.defensiveRapmPer100 > weak.defensiveRapmPer100);
  assert.equal(strong.combinedRapmPer100, strong.offensiveRapmPer100 + strong.defensiveRapmPer100);
  assert.equal(strong.displayEligible, true);
  assert.ok(strong.offensiveRidgeReliabilityProxy > 0 && strong.offensiveRidgeReliabilityProxy < 1);
  assert.ok(strong.defensiveRidgeReliabilityProxy > 0 && strong.defensiveRidgeReliabilityProxy < 1);
  assert.equal(strong.venueExposure.signedVenueExposureBalance, 0);
  assert.equal(first.venueExposureDiagnostics.oneSidedPlayerCount, 0);

  const selected = selectWeightedRidgeOffenseDefenseLambda(crossValidationStints(), {
    candidateLambdas: [10, 1],
    foldCount: 2,
  });
  const selectedReversed = selectWeightedRidgeOffenseDefenseLambda([...crossValidationStints()].reverse(), {
    candidateLambdas: [1, 10],
    foldCount: 2,
  });
  assert.ok([1, 10].includes(selected.selectedLambda));
  assert.equal(selected.foldCount, 2);
  assert.deepEqual(selected, selectedReversed);
});

test('RAPM rejects a zero or negative ridge lambda', () => {
  assert.throws(() => fitWeightedRidgeRapm(sampleStints(), { lambda: 0 }), /greater than zero/);
  assert.throws(() => fitWeightedRidgeRapm([], { lambda: 1 }), /No valid paired/);
  assert.throws(() => selectWeightedRidgeRapmLambda(sampleStints(), { candidateLambdas: [0, 1] }), /greater than zero/);
  assert.throws(() => selectWeightedRidgeRapmLambda(sampleStints().slice(0, 2)), /at least two distinct games/);
});
