import test from "node:test";
import assert from "node:assert/strict";

import {
  buildScoutImpactModel,
  buildScoutMinuteObjective,
  scoreScoutCandidate,
} from "../scout-impact.js";

const players = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
const validatedModel = { calibration: { status: "validated", allComponentsImproved: true } };

function nearlyEqual(actual, expected, tolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function completeEvidence(overridesById = {}) {
  return {
    model: validatedModel,
    players: Object.fromEntries(players.map(({ id }) => [id, {
      offense: 1,
      defense: 1,
      reliability: 1,
      ...overridesById[id],
    }])),
  };
}

test("missing Scout evidence fails closed instead of becoming zero", () => {
  const model = buildScoutImpactModel(players, {
    model: validatedModel,
    players: { a: { offense: 1, defense: 1, reliability: 1 } },
  }, { mode: "hybrid" });
  assert.equal(model.available, false);
  assert.equal(model.applied, false);
  assert.deepEqual(model.missingPlayerIds, ["b", "c", "d", "e"]);
  assert.equal(scoreScoutCandidate(players, model).adjustmentPoints, 0);
});

test("nullish Scout components fail closed while explicit zero remains valid", () => {
  const explicitZero = buildScoutImpactModel(
    players,
    completeEvidence({ a: { offense: 0, defense: 0, reliability: 1 } }),
    { mode: "hybrid" },
  );
  assert.equal(explicitZero.available, true);
  assert.equal(explicitZero.impactsById.get("a").offense, 0);

  for (const [id, invalidRow] of [
    ["a", { offense: null }],
    ["b", { defense: "   " }],
    ["c", { reliability: false }],
    ["d", { displayEligible: false }],
  ]) {
    const model = buildScoutImpactModel(
      players,
      completeEvidence({ [id]: invalidRow }),
      { mode: "hybrid" },
    );
    assert.equal(model.available, false, `${id} should not be coerced to neutral Scout evidence`);
    assert.ok(model.missingPlayerIds.includes(id));
  }
});

test("RAPM aliases and user offense-defense priorities produce a bounded minute objective", () => {
  const evidence = {
    model: validatedModel,
    players: Object.fromEntries(players.map(({ id }, index) => [id, {
      // The production private RAPM response uses these names and a ridge
      // reliability proxy rather than the compact test-only aliases above.
      offensiveRapmPer100: index - 2,
      defensiveRapmPer100: 2 - index,
      // The private service row keeps its compact stability proxy under
      // `metrics`, rather than flattening it alongside the two RAPM columns.
      metrics: { ridgeReliabilityProxy: 0.5 },
      displayEligible: true,
    }])),
  };
  const model = buildScoutImpactModel(players, evidence, { mode: "hybrid" });
  const baseScores = new Map(players.map((player) => [player.id, 0.5]));
  const offenseFirst = buildScoutMinuteObjective(players, model, baseScores, {
    offenseWeight: 1,
    defenseWeight: 0,
  });
  const defenseFirst = buildScoutMinuteObjective(players, model, baseScores, {
    offenseWeight: 0,
    defenseWeight: 1,
  });

  assert.equal(model.available, true);
  assert.equal(model.impactsById.get("e").offense, 1);
  assert.equal(offenseFirst.applied, true);
  assert.ok(offenseFirst.scoresById.get("e") > offenseFirst.scoresById.get("a"));
  assert.ok(defenseFirst.scoresById.get("a") > defenseFirst.scoresById.get("e"));
  nearlyEqual(offenseFirst.scoresById.get("e"), 0.53);
  nearlyEqual(offenseFirst.scoresById.get("a"), 0.47);
});

test("contract-backed Scout RAPM requires a passed held-out offense/defense calibration", () => {
  const rows = Object.fromEntries(players.map(({ id }) => [id, {
    offensiveRapmPer100: 1,
    defensiveRapmPer100: 1,
    metrics: { ridgeReliabilityProxy: 0.5 },
    displayEligible: true,
  }]));
  const blocked = buildScoutImpactModel(players, {
    model: { calibration: { status: "not_validated", allComponentsImproved: false } },
    players: rows,
  }, { mode: "scout" });
  const passed = buildScoutImpactModel(players, {
    model: { calibration: { status: "validated", allComponentsImproved: true } },
    players: rows,
  }, { mode: "scout" });

  assert.equal(blocked.available, false);
  assert.equal(blocked.calibrationRequired, true);
  assert.match(blocked.reason, /held-out offense\/defense calibration/);
  assert.equal(passed.available, true);
  assert.equal(passed.calibrationRequired, true);
  assert.equal(passed.calibrationAvailable, true);
});

function multiseasonEvidence() {
  const evidence = completeEvidence(Object.fromEntries(players.map(({ id }) => [id, {
    offense: 2, defense: -1, reliability: 0.2, displayEligible: true,
  }])));
  evidence.model = {
    ...validatedModel, modelVersion: "weighted_ridge_offense_defense_rapm_v2",
    seasonEndYear: 2026, includedSeasonStartYears: [2022, 2023, 2024, 2025],
    lambda: 2500, priorSeasonWeight: 0.5, solver: { converged: true },
    chronologicalCalibration: {
      version: "chronological_latest_season_tune_test_v1", model: "offenseDefense",
      method: "prior_seasons_plus_chronological_latest_season_train_tune_test_v1",
      latestSeasonStartYear: 2025, selectedLambda: 2500, selectedPriorSeasonWeight: 0.5,
      test: {
        status: "validated", fullModelImprovesBaseline: true,
        fullModelMseImprovementVsFixedEffectsBaseline: 0.2,
        fullModel: { weightedMse: 0.8, heldOutPossessions: 100, directionalObservationCount: 20 },
        fixedEffectsBaseline: { weightedMse: 1, heldOutPossessions: 100, directionalObservationCount: 20 },
      },
    },
  };
  return evidence;
}

test("native multiseason ridge rows retain their fitted O/D values without a transport flag", () => {
  const model = buildScoutImpactModel(players, multiseasonEvidence(), { mode: "scout" });
  assert.equal(model.available, true, model.reason);
  assert.equal(model.impactsById.get("a").offense, 2);
  assert.equal(model.impactsById.get("a").defense, -1);
  assert.equal(model.impactsById.get("a").reliability, 0.2);
});

for (const [name, mutate] of [
  ["missing chronology", model => { delete model.chronologicalCalibration; }],
  ["duplicate years", model => { model.includedSeasonStartYears = [2025, 2025]; }],
  ["future season", model => { model.includedSeasonStartYears.push(2026); }],
  ["wrong test season", model => { model.chronologicalCalibration.latestSeasonStartYear = 2024; }],
  ["wrong lambda", model => { model.chronologicalCalibration.selectedLambda = 100; }],
  ["wrong recency weight", model => { model.chronologicalCalibration.selectedPriorSeasonWeight = 1; }],
  ["unconverged fit", model => { model.solver.converged = false; }],
  ["no baseline improvement", model => { model.chronologicalCalibration.test.fullModel.weightedMse = 1.1; }],
  ["missing MSE", model => { model.chronologicalCalibration.test.fullModel.weightedMse = null; }],
  ["different test samples", model => { model.chronologicalCalibration.test.fixedEffectsBaseline.heldOutPossessions = 200; }],
  ["empty test sample", model => { model.chronologicalCalibration.test.fullModel.heldOutPossessions = 0; }],
]) {
  test(`multiseason evidence stays disabled: ${name}`, () => {
    const evidence = multiseasonEvidence(); mutate(evidence.model);
    const model = buildScoutImpactModel(players, evidence, { mode: "scout" });
    assert.equal(model.available, false);
    assert.match(model.reason, /chronological prediction test/);
  });
}

test("invalid reliability and missing native display eligibility cannot qualify a player", () => {
  for (const reliability of [-0.1, 1.1, Infinity, null]) {
    const evidence = multiseasonEvidence(); evidence.players.a.reliability = reliability;
    const model = buildScoutImpactModel(players, evidence, { mode: "scout" });
    assert.equal(model.available, false);
    assert.deepEqual(model.missingPlayerIds, ["a"]);
  }
  const evidence = multiseasonEvidence(); delete evidence.players.a.displayEligible;
  assert.equal(buildScoutImpactModel(players, evidence, { mode: "scout" }).available, false);
});

test("minute deltas reconcile separately from exact-five residuals", () => {
  const evidence = {
    ...completeEvidence(),
    exactLineups: [{
      playerIds: ["e", "d", "c", "b", "a"],
      // Direct legacy residuals are reliability-shrunk once before their
      // deliberately capped group-only contribution is applied.
      residual: 2,
      reliability: 0.5,
    }],
  };
  const model = buildScoutImpactModel(players, evidence, { mode: "hybrid" });
  const score = scoreScoutCandidate(players, model, {
    minutesById: Object.fromEntries(players.map(({ id }) => [id, 48])),
    minuteScoreUnitsById: { a: 12, b: 0, c: 0, d: 0, e: 0 },
  });

  assert.equal(model.available, true);
  assert.equal(score.exactLineupResidual, 1);
  nearlyEqual(score.minuteAdjustmentPoints, 5);
  nearlyEqual(score.playerMinuteAdjustmentPointsById.a, 5);
  nearlyEqual(score.exactLineupAdjustmentPoints, 0.625);
  nearlyEqual(score.adjustmentPoints, 5.625);
  nearlyEqual(score.impact, 5);
});

test("package exact-five residuals require publishable, already-shrunk evidence", () => {
  const published = buildScoutImpactModel(players, {
    ...completeEvidence(),
    exactLineups: [{
      playerIds: players.map(({ id }) => id),
      projection: {
        status: "available",
        shrunkSynergyPer100: 2,
        reliability: { publishable: true },
      },
    }],
  }, { mode: "hybrid" });
  const hidden = buildScoutImpactModel(players, {
    ...completeEvidence(),
    exactLineups: [{
      playerIds: players.map(({ id }) => id),
      projection: {
        status: "available",
        shrunkSynergyPer100: 2,
        reliability: { publishable: false },
      },
    }],
  }, { mode: "hybrid" });

  const minutePlan = {
    minutesById: Object.fromEntries(players.map(({ id }) => [id, 48])),
    minuteScoreUnitsById: Object.fromEntries(players.map(({ id }) => [id, 0])),
  };
  const publishedScore = scoreScoutCandidate(players, published, minutePlan);
  const hiddenScore = scoreScoutCandidate(players, hidden, minutePlan);

  nearlyEqual(publishedScore.exactLineupResidual, 2);
  nearlyEqual(publishedScore.exactLineupAdjustmentPoints, 1.25);
  assert.equal(publishedScore.exactLineupSource, "package-already-shrunk");
  assert.equal(hiddenScore.exactLineupResidual, null);
  assert.equal(hiddenScore.exactLineupAdjustmentPoints, 0);
});
