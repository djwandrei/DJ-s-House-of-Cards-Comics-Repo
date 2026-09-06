import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVANCED_METRIC_DEFINITIONS,
  evaluateIndividualPlayers,
} from "../individual-player-evaluation.js";

function player(id, level, overrides = {}) {
  const advanced = {
    player_efficiency_rating: 10 + level,
    true_shooting_percentage: 0.5 + level * 0.01,
    three_point_attempt_rate: 0.2 + level * 0.03,
    free_throw_attempt_rate: 0.15 + level * 0.02,
    offensive_rebound_percentage: 0.02 + level * 0.005,
    defensive_rebound_percentage: 0.08 + level * 0.015,
    total_rebound_percentage: 0.05 + level * 0.01,
    assist_percentage: 0.1 + level * 0.04,
    steal_percentage: 0.008 + level * 0.002,
    block_percentage: 0.01 + level * 0.005,
    turnover_percentage: 0.2 - level * 0.015,
    usage_percentage: 0.15 + level * 0.025,
    offensive_win_shares: level,
    defensive_win_shares: level * 0.5,
    win_shares: level * 1.5,
    win_shares_per_48: 0.05 + level * 0.02,
    offensive_box_plus_minus: -3 + level,
    defensive_box_plus_minus: -2 + level * 0.5,
    box_plus_minus: -5 + level * 1.5,
    value_over_replacement_player: -1 + level * 0.8,
  };
  return {
    id,
    name: `Player ${id}`,
    positions: ["G"],
    games: 70,
    minutes: 30,
    points: 10 + level * 2,
    rebounds: 3 + level,
    assists: 2 + level,
    steals: 0.5 + level * 0.1,
    blocks: 0.2 + level * 0.1,
    turnovers: 3 - level * 0.2,
    fgPct: 0.42 + level * 0.01,
    threePct: 0.3 + level * 0.015,
    efgPct: 0.47 + level * 0.015,
    ftPct: 0.72 + level * 0.01,
    analytics: {
      seasonTotals: { games: 70, minutes: 2100 },
      seasonAdvanced: advanced,
    },
    ...overrides,
  };
}

test("retains the complete supported advanced box profile and distinguishes descriptive rates", () => {
  const cohort = Array.from({ length: 6 }, (_, index) => player(String(index + 1), index + 1));
  const result = evaluateIndividualPlayers([cohort[5]], {
    referencePlayers: cohort,
    comparisonLabel: "Test NBA cohort",
  });
  const record = result.records[0];

  assert.equal(Object.keys(ADVANCED_METRIC_DEFINITIONS).length, 23);
  assert.equal(record.coverage.advancedBoxMetricCount, 20);
  assert.equal(record.coverage.boxModelMetricCount, 9);
  assert.equal(record.coverage.availableMetricCount, 20);
  assert.equal(record.metrics.trueShootingPercentage.available, true);
  assert.equal(record.metrics.trueShootingPercentage.percentile, 100);
  assert.equal(record.metrics.usagePercentage.direction, "descriptive");
  assert.equal(record.metrics.usagePercentage.qualityScore, null);
  assert.equal(record.metrics.threePointAttemptRate.qualityEligible, false);
  assert.equal(record.metrics.winShares.cumulative, true);
  assert.equal(record.customComposite.available, false);
  assert.match(record.customComposite.reason, /No default all-in-one player grade/i);
});

test("ranks a lower turnover percentage higher and keeps source metrics intact", () => {
  const cohort = Array.from({ length: 6 }, (_, index) => player(String(index + 1), index + 1));
  const result = evaluateIndividualPlayers([cohort[0], cohort[5]], { referencePlayers: cohort });

  assert.equal(result.byId.get("6").metrics.turnoverPercentage.percentile, 100);
  assert.equal(result.byId.get("1").metrics.turnoverPercentage.percentile, 0);
  assert.equal(result.byId.get("6").metrics.turnoverPercentage.direction, "lower");
  assert.equal(result.byId.get("6").metrics.turnoverPercentage.value, 0.11);
});

test("uses season-wide advanced evidence before a selected-team stint", () => {
  const target = player("target", 3);
  target.analytics.advanced = { true_shooting_percentage: 0.51 };
  target.analytics.seasonAdvanced.true_shooting_percentage = 0.64;
  const result = evaluateIndividualPlayers([target]);

  assert.equal(result.records[0].metrics.trueShootingPercentage.value, 0.64);
});

test("keeps the selected player snapshot when the reference cohort has the same ID", () => {
  const stale = player("target", 1);
  const selected = player("target", 6, { name: "Current target" });
  const referencePlayers = [stale, ...Array.from({ length: 5 }, (_, index) => player(`peer-${index}`, index + 1))];
  const result = evaluateIndividualPlayers([selected, selected], { referencePlayers });

  assert.equal(result.referencePlayerCount, 6);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].playerName, "Current target");
  assert.equal(result.records[0].metrics.trueShootingPercentage.value, 0.56);
  assert.equal(result.records[0].metrics.trueShootingPercentage.percentile, 100);
});

test("normalizes valid percentage points and withholds impossible percentages", () => {
  const normalized = player("normalized", 1);
  normalized.analytics.seasonAdvanced.true_shooting_percentage = 55;
  normalized.analytics.seasonAdvanced.usage_percentage = 101;
  const record = evaluateIndividualPlayers([normalized]).records[0];

  assert.equal(record.metrics.trueShootingPercentage.value, 0.55);
  assert.equal(record.metrics.usagePercentage.available, false);
  assert.equal(record.metrics.trueShootingPercentage.percentile, null);
  assert.equal(record.metrics.trueShootingPercentage.qualityScore, null);
});

test("adds RAPM only after provenance and independent box-score reconciliation gates pass", () => {
  const cohort = Array.from({ length: 6 }, (_, index) => player(String(index + 1), index + 1));
  const impactEvidenceById = {
    "6": {
      offensiveRapm: 3.2,
      defensiveRapm: 1.1,
      reliability: 0.8,
      modelVersion: "test-rapm-v1",
      alreadyRegularized: true,
      displayEligible: true,
      validation: { sourceProvenancePassed: true, boxScoreReconciled: true },
    },
    "5": {
      offensiveRapm: 2,
      defensiveRapm: 1,
      reliability: 0.8,
      modelVersion: "test-rapm-v1",
      validation: { sourceProvenancePassed: true, boxScoreReconciled: false },
    },
  };
  const result = evaluateIndividualPlayers([cohort[4], cohort[5]], {
    referencePlayers: cohort,
    impactEvidenceById,
  });
  const valid = result.byId.get("6");
  const invalid = result.byId.get("5");

  assert.equal(valid.coverage.possessionImpactAvailable, true);
  assert.equal(valid.metrics.offensiveRapm.value, 3.2);
  assert.equal(valid.metrics.totalRapm.value, 4.3);
  assert.equal(valid.metrics.totalRapm.comparisonObservations, 1);
  assert.equal(valid.metrics.totalRapm.percentile, null);
  assert.equal(valid.metrics.totalRapm.qualityScore, null);
  assert.equal(valid.possessionImpactEvidence.alreadyRegularized, true);
  assert.equal(invalid.metrics.offensiveRapm.available, false);
  assert.match(invalid.possessionImpactEvidence.reason, /independent box-score reconciliation/i);
});

test("builds an overall index only from explicit caller category weights", () => {
  const cohort = Array.from({ length: 6 }, (_, index) => player(String(index + 1), index + 1));
  const result = evaluateIndividualPlayers([cohort[5]], {
    referencePlayers: cohort,
    categoryWeights: {
      scoringEfficiency: 2,
      creation: 1,
      roleContext: 50,
    },
  });
  const composite = result.records[0].customComposite;

  assert.equal(composite.available, true);
  assert.equal(composite.index, 100);
  assert.equal(composite.effectiveWeights.scoringEfficiency, 0.6667);
  assert.equal(composite.effectiveWeights.creation, 0.3333);
  assert.equal(composite.effectiveWeights.roleContext, undefined);
});

test("flags limited samples without erasing their available measurements", () => {
  const limited = player("limited", 4, {
    games: 5,
    analytics: {
      seasonTotals: { games: 5, minutes: 90 },
      seasonAdvanced: player("copy", 4).analytics.seasonAdvanced,
    },
  });
  const record = evaluateIndividualPlayers([limited]).records[0];

  assert.equal(record.sample.reliable, false);
  assert.equal(record.metrics.boxPlusMinus.available, true);
  assert.equal(record.metrics.boxPlusMinus.confidence, "small-sample");
  assert.match(record.caveats.join(" "), /Limited evidence/i);
});
