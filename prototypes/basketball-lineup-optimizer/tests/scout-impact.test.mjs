import test from "node:test";
import assert from "node:assert/strict";

import {
  buildScoutImpactModel,
  buildScoutMinuteObjective,
  scoreScoutCandidate,
} from "../scout-impact.js";

const players = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

function nearlyEqual(actual, expected, tolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function completeEvidence(overridesById = {}) {
  return {
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
