import test from "node:test";
import assert from "node:assert/strict";

import {
  projectMetricForResponsibility,
  projectPlayerResponsibility,
  projectRotationUsageDemand,
  readPlayerUsage,
} from "../player-projection.js";
import { projectionParametersFor } from "../projection-parameters.js";
import { decisionRateAtWorkload } from "../projection-evidence.js";

function player(overrides = {}) {
  return {
    id: "p",
    minutes: 12,
    games: 8,
    analytics: {
      totals: { minutes: 96 },
      advanced: { usage_percentage: 0.1 },
    },
    ...overrides,
  };
}

test("normalizes common usage aliases without converting missing data to zero", () => {
  assert.equal(readPlayerUsage(player()), 0.1);
  assert.equal(readPlayerUsage(player({ analytics: { advanced: { usgPct: 24.5 } } })), 0.245);
  assert.equal(readPlayerUsage(player({ analytics: {} })), null);
});

test("minutes and offensive responsibility remain separate", () => {
  const parameters = projectionParametersFor("balanced");
  const establishedStar = player({
    minutes: 18,
    analytics: { advanced: { usage_percentage: 0.31 } },
  });
  const specialist = player();
  const starProjection = projectPlayerResponsibility(
    establishedStar,
    "points",
    32,
    parameters,
  );
  const specialistProjection = projectPlayerResponsibility(
    specialist,
    "points",
    32,
    parameters,
  );
  assert.equal(starProjection.targetUsage, 0.31);
  assert.equal(starProjection.rateRetention, 1);
  assert.equal(specialistProjection.targetUsage, 0.1);
  assert.equal(specialistProjection.rateRetention, 1);
  const requested = projectPlayerResponsibility(specialist, "points", 32,
    { ...parameters, offensiveResponsibilities: { p: .3 } });
  assert.equal(requested.targetUsage, .3);
  assert.equal(requested.rateRetention, 1, "an unvalidated usage effect must not change the mean");
});

test("fitted conditional workload response reduces only an unsupported advantage", () => {
  const parameters = { ...projectionParametersFor("balanced"), expansionStrengthByMetric: { efgPct: .5 } };
  const above = projectMetricForResponsibility({
    player: player(),
    metric: "efgPct",
    observedValue: 0.66,
    baselineValue: 0.54,
    targetMinutes: 32,
    parameters,
  });
  const below = projectMetricForResponsibility({
    player: player(),
    metric: "efgPct",
    observedValue: 0.5,
    baselineValue: 0.54,
    targetMinutes: 32,
    parameters,
  });
  assert.ok(above.value < 0.66 && above.value > 0.54);
  assert.equal(below.value, 0.5);
});

test("projection risk changes caution monotonically without changing hard inputs", () => {
  const projections = ["reliable", "balanced", "upside"].map((risk) => (
    projectPlayerResponsibility(
      player(),
      "points",
      34,
      projectionParametersFor(risk),
    )
  ));
  const decisions = ["reliable", "balanced", "upside"].map(risk => decisionRateAtWorkload({
    mean: 20, standardError: 2, sourceMinutes: 12, targetMinutes: 34,
    risk: projectionParametersFor(risk).decisionUncertaintyWeight,
  }).decision);
  assert.ok(decisions[0] < decisions[1] && decisions[1] < decisions[2]);
  assert.ok(projections.every(projection => projection.rateRetention === 1), "risk changes the reserve, not the mean");
  assert.deepEqual(projections.map((projection) => projection.targetMinutes), [34, 34, 34]);
  assert.deepEqual(projections.map((projection) => projection.sourceMinutes), [12, 12, 12]);
});

test("selected-team games and totals do not alter the responsibility projection", () => {
  const parameters = projectionParametersFor("balanced");
  const shortStint = player({ games: 3, analytics: { totals: { minutes: 36 }, advanced: { usage_percentage: 0.12 } } });
  const longStint = player({ games: 80, analytics: { totals: { minutes: 960 }, advanced: { usage_percentage: 0.12 } } });
  assert.deepEqual(
    projectPlayerResponsibility(shortStint, "points", 30, parameters),
    projectPlayerResponsibility(longStint, "points", 30, parameters),
  );
});

test("responsibility audit preserves requested usage and never fills a gap behind the user's back", () => {
  const rows = Array.from({ length: 5 }, (_, i) => player({ id: `p${i}` }));
  const minutes = Object.fromEntries(rows.map(row => [row.id, 48]));
  const original = projectRotationUsageDemand(rows, minutes, {});
  assert.ok(Math.abs(original.observedUsageShare - .5) < 1e-12);
  assert.ok(Math.abs(original.projectedUsageShare - .5) < 1e-12);
  assert.ok(Math.abs(original.deficitShare - .5) < 1e-12);
  assert.equal(original.adjustmentPoints, 0);
  assert.equal(original.applied, false);
  assert.ok(original.players.every(row => row.targetUsage === .1));
  const scenario = projectRotationUsageDemand(rows, minutes, { offensiveResponsibilities: { p0: .3 } });
  assert.ok(Math.abs(scenario.projectedUsageShare - .7) < 1e-12);
  assert.equal(scenario.observedUsageShare, original.observedUsageShare, "measured and requested usage stay separate");
  assert.deepEqual(scenario.scenarioPlayerIds, ["p0"]);
  assert.equal(scenario.players[0].targetUsage, .3);
  assert.equal(scenario.players[1].targetUsage, .1);
});

test("missing usage remains missing unless explicitly supplied as a labelled scenario", () => {
  const rows = [player({ id: "known" }), player({ id: "unknown", analytics: {} })];
  const minutes = { known: 24, unknown: 24 };
  assert.equal(projectRotationUsageDemand(rows, minutes, {}).available, false);
  const scenario = projectRotationUsageDemand(rows, minutes, { offensiveResponsibilities: { unknown: .3 } });
  assert.equal(scenario.available, true);
  assert.equal(scenario.observedUsageShare, null);
  assert.deepEqual(scenario.scenarioPlayerIds, ["unknown"]);
  assert.equal(scenario.players[1].usageExpansion, null);
  assert.equal(projectRotationUsageDemand(rows, { known: 24, unknown: 0 }, {}).available, true,
    "a zero-minute unselected row is not missing evidence for a playing unit");
});
