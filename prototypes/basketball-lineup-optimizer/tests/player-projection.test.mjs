import test from "node:test";
import assert from "node:assert/strict";

import {
  projectMetricForResponsibility,
  projectPlayerResponsibility,
  readPlayerUsage,
} from "../player-projection.js";
import { projectionParametersFor } from "../projection-parameters.js";

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
  assert.ok(specialistProjection.targetUsage > 0.1);
  assert.ok(specialistProjection.rateRetention < 1);
});

test("responsibility expansion reduces only an unsupported advantage", () => {
  const parameters = projectionParametersFor("balanced");
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

test("selected-team games and totals do not alter the responsibility projection", () => {
  const parameters = projectionParametersFor("balanced");
  const shortStint = player({ games: 3, analytics: { totals: { minutes: 36 }, advanced: { usage_percentage: 0.12 } } });
  const longStint = player({ games: 80, analytics: { totals: { minutes: 960 }, advanced: { usage_percentage: 0.12 } } });
  assert.deepEqual(
    projectPlayerResponsibility(shortStint, "points", 30, parameters),
    projectPlayerResponsibility(longStint, "points", 30, parameters),
  );
});

