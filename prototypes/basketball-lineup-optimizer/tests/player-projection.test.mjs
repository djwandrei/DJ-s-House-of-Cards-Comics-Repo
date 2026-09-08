import test from "node:test";
import assert from "node:assert/strict";

import {
  RESPONSIBILITY_EVIDENCE_VERSION,
  projectMetricForResponsibility,
  projectPlayerResponsibility,
  projectRotationUsageDemand,
  readResponsibilityEvidence,
  readPlayerUsage,
  readSeasonRoleMinutes,
  responsibilityExpansionFor,
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

function responsibilityEvidence({ games = 40, minutes = 314, fga = 100, fta = 20, turnovers = 15, ...overrides } = {}) {
  const offensiveInvolvement = fga + (0.44 * fta) + turnovers;
  const per36 = value => (value * 36) / minutes;
  return {
    version: RESPONSIBILITY_EVIDENCE_VERSION,
    scope: "season-wide",
    games,
    minutes,
    offensiveInvolvement,
    offensiveInvolvementPer36: per36(offensiveInvolvement),
    fieldGoalAttemptsPer36: per36(fga),
    freeThrowAttemptsPer36: per36(fta),
    turnoversPer36: per36(turnovers),
    ...overrides,
  };
}

function playerWithResponsibilityEvidence(options = {}) {
  const evidence = responsibilityEvidence(options);
  return player({
    minutes: options.minutes ?? evidence.minutes / evidence.games,
    games: options.games ?? evidence.games,
    analytics: {
      totals: { minutes: evidence.minutes },
      advanced: { usage_percentage: 0.1 },
      responsibilityEvidence: evidence,
    },
  });
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

test("valid responsibility evidence is normalized while malformed contracts fail closed", () => {
  const source = responsibilityEvidence({ sourceRevision: "scout-2026-09", completeness: "scout-player-games-complete" });
  const parsed = readResponsibilityEvidence(player({ analytics: { responsibilityEvidence: source } }));
  assert.equal(parsed.version, RESPONSIBILITY_EVIDENCE_VERSION);
  assert.equal(parsed.scope, "season-wide");
  assert.equal(parsed.games, 40);
  assert.equal(parsed.minutes, 314);
  assert.equal(parsed.minutesPerGame, 314 / 40);
  assert.ok(Math.abs(parsed.offensiveInvolvementPer36 - ((123.8 * 36) / 314)) < 1e-12);
  assert.equal(parsed.sourceRevision, "scout-2026-09");
  assert.equal(parsed.completeness, "scout-player-games-complete");

  for (const malformed of [
    { ...source, version: "old-contract" },
    { ...source, scope: "selected-team-stint" },
    { ...source, offensiveInvolvement: source.offensiveInvolvement + 1 },
    { ...source, turnoversPer36: source.turnoversPer36 + 1 },
  ]) {
    assert.equal(
      readResponsibilityEvidence(player({ analytics: { responsibilityEvidence: malformed } })),
      null,
      "invalid responsibility evidence must remain unavailable",
    );
  }
});

test("responsibility prior is sensitive to verified exposure and never applies to defensive metrics", () => {
  const parameters = projectionParametersFor("balanced");
  const thin = responsibilityExpansionFor(playerWithResponsibilityEvidence(), "points", parameters);
  const sustained = responsibilityExpansionFor(
    playerWithResponsibilityEvidence({ games: 82, minutes: 2460 }),
    "points",
    parameters,
  );
  assert.equal(thin.source, "responsibility-evidence-prior");
  assert.equal(sustained.source, "responsibility-evidence-prior");
  assert.ok(thin.strength > sustained.strength);
  assert.ok(thin.reliability < sustained.reliability);
  const defensive = responsibilityExpansionFor(playerWithResponsibilityEvidence(), "rebounds", parameters);
  assert.equal(defensive.source, "responsibility-prior-not-applicable");
  assert.equal(defensive.strength, 0);
});

test("a calibrated zero overrides the responsibility prior and preserves the conditional mean", () => {
  const playerWithEvidence = playerWithResponsibilityEvidence();
  const parameters = projectionParametersFor("balanced", { seasonEndYear: 2026, seasonPhase: "regular" });
  assert.equal(parameters.expansionStrengthByMetric.points, 0);
  const profile = responsibilityExpansionFor(playerWithEvidence, "points", parameters);
  assert.equal(profile.source, "chronological-workload-fit");
  assert.equal(profile.strength, 0);
  assert.equal(profile.priorMinutes, null);
  const projection = projectPlayerResponsibility(playerWithEvidence, "points", 32, parameters);
  assert.equal(projection.source, "chronological-workload-fit");
  assert.equal(projection.rateRetention, 1);
  assert.equal(projection.evidenceGrade, "conditional-prediction");
  assert.equal(projection.expansionStrength, 0);
});

test("an explicitly malformed calibrated strength fails closed instead of activating the prior", () => {
  const parameters = {
    ...projectionParametersFor("balanced"),
    expansionStrengthByMetric: { points: -0.25 },
  };
  const profile = responsibilityExpansionFor(playerWithResponsibilityEvidence(), "points", parameters);
  assert.equal(profile.source, "chronological-workload-fit-invalid");
  assert.equal(profile.strength, 0);
});

test("a season-wide responsibility contract can supply the role anchor when season totals are omitted", () => {
  const evidence = responsibilityEvidence({ games: 40, minutes: 1440 });
  const contractOnly = player({
    minutes: 5,
    games: 1,
    analytics: { responsibilityEvidence: evidence, advanced: { usage_percentage: 0.1 } },
  });
  assert.equal(readSeasonRoleMinutes(contractOnly), 36);
});
