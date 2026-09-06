import assert from "node:assert/strict";
import test from "node:test";

import { simulateGame, simulateSeries } from "../basketball-simulation.js";

function gameInput(overrides = {}) {
  return {
    home: { id: "A", label: "Team A", expectedPointsPer100: 118 },
    away: { id: "B", label: "Team B", expectedPointsPer100: 108 },
    possessions: { mean: 98, standardDeviation: 4 },
    scoreStandardDeviation: 10,
    scoreCorrelation: 0.15,
    homeCourtPointsPer100: 2,
    modelContext: {
      mode: "exploratory",
      modelVersion: "test-matchup-v1",
      caveats: ["Synthetic unit-test inputs."],
    },
    ...overrides,
  };
}

test("produces deterministic game distributions and sampling uncertainty", () => {
  const first = simulateGame(gameInput(), { iterations: 3000, seed: "repeatable" });
  const second = simulateGame(gameInput(), { iterations: 3000, seed: "repeatable" });

  assert.deepEqual(first, second);
  assert.equal(first.iterations, 3000);
  assert.ok(first.results.home.probability > 0.65);
  assert.equal(Number((first.results.home.probability + first.results.away.probability).toFixed(4)), 1);
  assert.ok(first.results.home.confidenceInterval95.low < first.results.home.probability);
  assert.ok(first.results.home.confidenceInterval95.high > first.results.home.probability);
  assert.match(first.interpretation, /Exploratory what-if/i);
  assert.match(first.caveats.join(" "), /not full model uncertainty/i);
});

test("returns every assumption used instead of hiding generic model defaults", () => {
  const result = simulateGame(gameInput({ neutralSite: true }), { iterations: 500, seed: 42 });

  assert.equal(result.assumptions.neutralSite, true);
  assert.equal(result.assumptions.homeCourtPointsPer100, 0);
  assert.equal(result.assumptions.possessions.minimum, 40);
  assert.equal(result.assumptions.possessions.maximum, 130);
  assert.equal(result.assumptions.scoreStandardDeviation, 10);
  assert.equal(result.assumptions.modelContext.modelVersion, "test-matchup-v1");
});

test("supports zero pace variance and neutral equal-team inputs without a hidden edge", () => {
  const result = simulateGame(gameInput({
    home: { id: 0, expectedPointsPer100: 110 },
    away: { id: 1, expectedPointsPer100: 110 },
    possessions: { mean: 98, standardDeviation: 0, minimum: 90, maximum: 105 },
    neutralSite: true,
  }), { iterations: 10000, seed: "neutral-equality" });

  assert.equal(result.results.home.id, "0");
  assert.equal(result.results.possessions.standardDeviation, 0);
  assert.ok(Math.abs(result.results.home.probability - 0.5) < 0.025);
  assert.equal(Number((result.results.home.probability + result.results.away.probability).toFixed(4)), 1);
});

test("simulates a best-of-seven schedule and stops after either team reaches four wins", () => {
  const result = simulateSeries({
    teamA: { id: "A", expectedPointsPer100: 116 },
    teamB: { id: "B", expectedPointsPer100: 108 },
    schedule: ["A", "A", "B", "B", "A", "B", "A"],
    winsRequired: 4,
    possessions: { mean: 96, standardDeviation: 3 },
    scoreStandardDeviation: 10,
    scoreCorrelation: 0.1,
    homeCourtPointsPer100: 2,
    modelContext: { mode: "validated", modelVersion: "series-test-v1" },
  }, { iterations: 4000, seed: "series" });
  const lengthTotal = Object.values(result.results.lengthProbabilities).reduce((sum, value) => sum + value, 0);
  const outcomeTotal = Object.values(result.results.outcomeProbabilities).reduce((sum, value) => sum + value, 0);

  assert.ok(result.results.teamA.probability > 0.7);
  assert.ok(Math.abs(lengthTotal - 1) <= 0.0002);
  assert.ok(Math.abs(outcomeTotal - 1) <= 0.0002);
  assert.deepEqual(Object.keys(result.results.lengthProbabilities), ["4", "5", "6", "7"]);
  assert.ok(Object.keys(result.results.outcomeProbabilities).every((score) => score.startsWith("4-") || score.endsWith("-4")));
  assert.match(result.interpretation, /validated matchup expectations/i);
});

test("fails closed when simulation provenance or variance assumptions are omitted", () => {
  assert.throws(
    () => simulateGame({ ...gameInput(), modelContext: null }),
    /modelContext.mode must be validated or exploratory/i,
  );
  assert.throws(
    () => simulateGame({ ...gameInput(), scoreStandardDeviation: null }),
    /scoreStandardDeviation is required/i,
  );
  assert.throws(
    () => simulateSeries({
      teamA: { id: "A", expectedPointsPer100: 110 },
      teamB: { id: "B", expectedPointsPer100: 109 },
      schedule: ["A", "B"],
      winsRequired: 2,
      possessions: { mean: 98, standardDeviation: 3 },
      scoreStandardDeviation: 10,
      modelContext: { mode: "exploratory", modelVersion: "invalid-schedule-test" },
    }),
    /schedule must contain exactly 3/i,
  );
  assert.throws(
    () => simulateGame(gameInput({
      possessions: { mean: 140, standardDeviation: 3, minimum: 80, maximum: 120 },
    })),
    /possessions.mean must be within/i,
  );
  assert.throws(
    () => simulateGame(gameInput({ scoreCorrelation: 1 })),
    /scoreCorrelation must be from -0.95 through 0.95/i,
  );
});
