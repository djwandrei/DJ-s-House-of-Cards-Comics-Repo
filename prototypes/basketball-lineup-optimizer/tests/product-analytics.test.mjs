import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeLineupChemistry,
  assessBasketballProductReadiness,
  buildPlayerSkillProfiles,
  buildPlayerValueProfiles,
  detectPlayerArchetypes,
} from "../product-analytics.js";

function player(id, overrides = {}) {
  return {
    id,
    name: `Player ${id}`,
    team: "TST",
    positions: ["G"],
    games: 70,
    minutes: 30,
    fgPct: 0.48,
    threePct: 0.35,
    efgPct: 0.54,
    ftPct: 0.8,
    points: 15,
    rebounds: 5,
    assists: 4,
    steals: 1,
    blocks: 0.5,
    turnovers: 2,
    analytics: {
      seasonTotals: {
        games: 70,
        minutes: 2100,
        fieldGoalsAttempted: 900,
        threePointFieldGoalsAttempted: 300,
        freeThrowsAttempted: 200,
      },
      seasonAdvanced: {
        true_shooting_percentage: 0.57,
        usage_percentage: 0.2,
        assist_percentage: 0.2,
        total_rebound_percentage: 0.1,
        block_percentage: 0.02,
        offensive_box_plus_minus: 0,
        defensive_box_plus_minus: 0,
      },
    },
    ...overrides,
  };
}

function cohort() {
  return [
    player("creator-a", {
      points: 27, assists: 10, turnovers: 2.5, minutes: 35,
      analytics: { seasonTotals: { games: 72, minutes: 2520, fieldGoalsAttempted: 1400, threePointFieldGoalsAttempted: 500, freeThrowsAttempted: 500 }, seasonAdvanced: { true_shooting_percentage: 0.62, usage_percentage: 0.32, assist_percentage: 0.42, total_rebound_percentage: 0.08, block_percentage: 0.01, offensive_box_plus_minus: 6, defensive_box_plus_minus: 0 } },
    }),
    player("creator-b", {
      points: 25, assists: 9, turnovers: 2.7, minutes: 34,
      analytics: { seasonTotals: { games: 70, minutes: 2380, fieldGoalsAttempted: 1300, threePointFieldGoalsAttempted: 450, freeThrowsAttempted: 430 }, seasonAdvanced: { true_shooting_percentage: 0.6, usage_percentage: 0.3, assist_percentage: 0.38, total_rebound_percentage: 0.09, block_percentage: 0.01, offensive_box_plus_minus: 5, defensive_box_plus_minus: -0.5 } },
    }),
    player("shooter", {
      positions: ["G", "F"], points: 19, threePct: 0.44, efgPct: 0.64, turnovers: 1.2,
      analytics: { seasonTotals: { games: 75, minutes: 2250, fieldGoalsAttempted: 900, threePointFieldGoalsAttempted: 650, freeThrowsAttempted: 100 }, seasonAdvanced: { true_shooting_percentage: 0.66, usage_percentage: 0.18, assist_percentage: 0.11, total_rebound_percentage: 0.07, block_percentage: 0.01, offensive_box_plus_minus: 3, defensive_box_plus_minus: 0 } },
    }),
    player("big", {
      positions: ["F", "C"], points: 18, rebounds: 13, blocks: 3, steals: 1.2, threePct: 0.18,
      analytics: { seasonTotals: { games: 74, minutes: 2294, fieldGoalsAttempted: 800, threePointFieldGoalsAttempted: 30, freeThrowsAttempted: 400 }, seasonAdvanced: { true_shooting_percentage: 0.64, usage_percentage: 0.19, assist_percentage: 0.09, total_rebound_percentage: 0.24, block_percentage: 0.07, offensive_box_plus_minus: 2, defensive_box_plus_minus: 5 } },
    }),
    player("wing", {
      positions: ["G", "F"], points: 14, rebounds: 6, steals: 2, blocks: 1, threePct: 0.39,
      analytics: { seasonTotals: { games: 73, minutes: 2190, fieldGoalsAttempted: 850, threePointFieldGoalsAttempted: 450, freeThrowsAttempted: 160 }, seasonAdvanced: { true_shooting_percentage: 0.59, usage_percentage: 0.17, assist_percentage: 0.14, total_rebound_percentage: 0.12, block_percentage: 0.03, offensive_box_plus_minus: 1, defensive_box_plus_minus: 3 } },
    }),
    player("bench", {
      points: 7, rebounds: 2, assists: 1, steals: 0.3, blocks: 0.1, turnovers: 1.5, threePct: 0.29, minutes: 16,
      analytics: { seasonTotals: { games: 50, minutes: 800, fieldGoalsAttempted: 400, threePointFieldGoalsAttempted: 100, freeThrowsAttempted: 80 }, seasonAdvanced: { true_shooting_percentage: 0.49, usage_percentage: 0.15, assist_percentage: 0.08, total_rebound_percentage: 0.06, block_percentage: 0.005, offensive_box_plus_minus: -4, defensive_box_plus_minus: -3 } },
    }),
  ];
}

test("builds a reusable skill graph while withholding tracking-only detail", () => {
  const players = cohort();
  const skillSet = buildPlayerSkillProfiles([players[0], players[2]], {
    referencePlayers: players,
    comparisonLabel: "Six-player test cohort",
  });
  const creator = skillSet.byId.get("creator-a");
  const shooter = skillSet.byId.get("shooter");

  assert.equal(skillSet.referencePlayerCount, 6);
  assert.equal(creator.dimensions.playmaking.available, true);
  assert.equal(creator.dimensions.usageLoad.percentile, 100);
  assert.equal(shooter.dimensions.spacingProxy.available, true);
  assert.equal(shooter.dimensions.spacingProxy.evidenceMode, "box-score-proxy");
  assert.ok(shooter.categories.offBall.score > 0.7);
  assert.ok(creator.unavailableSkillGroups.some((group) => group.skills.includes("screen navigation")));
  assert.match(creator.caveats.join(" "), /not calibrated scouting grades/i);
});

test("withholds spacing when attempt volume is missing instead of treating it as zero", () => {
  const players = cohort();
  const noVolume = player("no-volume", {
    threePct: 0.45,
    analytics: { seasonAdvanced: { true_shooting_percentage: 0.62, usage_percentage: 0.2 } },
  });
  const profile = buildPlayerSkillProfiles([noVolume], { referencePlayers: [...players, noVolume] }).records[0];

  assert.equal(profile.dimensions.perimeterAccuracy.available, true);
  assert.equal(profile.dimensions.spacingProxy.available, false);
  assert.match(profile.dimensions.spacingProxy.reason, /Both three-point accuracy and attempt volume/i);
});

test("does not manufacture a best-in-cohort skill score from one observation", () => {
  const profile = buildPlayerSkillProfiles([player("solo")]).records[0];

  assert.equal(profile.dimensions.perimeterAccuracy.rawAvailable, true);
  assert.equal(profile.dimensions.perimeterAccuracy.rawValue, 0.35);
  assert.equal(profile.dimensions.perimeterAccuracy.available, false);
  assert.equal(profile.dimensions.perimeterAccuracy.percentile, null);
  assert.equal(profile.dimensions.perimeterAccuracy.comparisonObservations, 1);
  assert.match(profile.dimensions.perimeterAccuracy.reason, /fewer than two comparable observations/i);
});

test("keeps the selected snapshot when a stale reference row has the same ID", () => {
  const stale = player("target", { name: "Stale target", threePct: 0.1 });
  const selected = player("target", { name: "Current target", threePct: 0.5 });
  const referencePlayers = [stale, ...cohort().slice(0, 5)];
  const result = buildPlayerSkillProfiles([selected, selected], { referencePlayers });

  assert.equal(result.referencePlayerCount, 6);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].playerName, "Current target");
  assert.equal(result.records[0].dimensions.perimeterAccuracy.rawValue, 0.5);
  assert.equal(result.records[0].dimensions.perimeterAccuracy.percentile, 100);
});

test("returns multi-label archetype memberships without mislabeling scores as probabilities", () => {
  const players = cohort();
  const skillSet = buildPlayerSkillProfiles(players, { referencePlayers: players });
  const result = detectPlayerArchetypes(players, { skillProfileSet: skillSet });
  const shooter = result.byId.get("shooter");
  const big = result.byId.get("big");

  assert.ok(shooter.labels.some((label) => label.id === "highVolumeShooter"));
  assert.ok(big.labels.some((label) => label.id === "defensiveAnchorProxy"));
  assert.ok(shooter.assessed.every((item) => item.probability === null));
  assert.ok(shooter.withheld.some((item) => item.ids.includes("movementShooter")));
  assert.match(shooter.caveats.join(" "), /not probabilities/i);
});

test("keeps explainable fit separate from independently validated observed synergy", () => {
  const players = cohort();
  const selected = players.slice(0, 5);
  const withheld = analyzeLineupChemistry(selected, {
    referencePlayers: players,
    observedLineupEvidence: {
      playerIds: selected.map((item) => item.id),
      rawSynergyPer100: 5,
      possessions: 1000,
      modelVersion: "lineup-test-v1",
      validation: { sourceProvenancePassed: true, boxScoreReconciled: false },
    },
  });
  const available = analyzeLineupChemistry(selected, {
    referencePlayers: players,
    observedLineupEvidence: {
      playerIds: selected.map((item) => item.id),
      rawSynergyPer100: 5,
      possessions: 1000,
      priorPossessions: 1000,
      modelVersion: "lineup-test-v1",
      validation: { sourceProvenancePassed: true, boxScoreReconciled: true },
    },
  });

  assert.ok(Number.isFinite(available.fitIndex));
  assert.equal(withheld.observedSynergy.available, false);
  assert.match(withheld.observedSynergy.reason, /independent box-score reconciliation/i);
  assert.equal(available.observedSynergy.adjustedPointsPer100, 2.5);
  assert.equal(available.observedSynergy.includedInFitIndex, false);
  assert.ok(available.redundancy.penaltyPoints > 0);
  assert.equal(available.components.length, 6);
});

test("requires certified reliability before publishing already-shrunk synergy", () => {
  const players = cohort().slice(0, 2);
  const evidence = {
    playerIds: players.map((item) => item.id),
    shrunkSynergyPer100: 2.2,
    alreadyShrunk: true,
    publishable: true,
    modelVersion: "lineup-test-v2",
    validation: { sourceProvenancePassed: true, boxScoreReconciled: true },
  };
  const withheld = analyzeLineupChemistry(players, { referencePlayers: cohort(), observedLineupEvidence: evidence });
  const available = analyzeLineupChemistry(players, {
    referencePlayers: cohort(),
    observedLineupEvidence: { ...evidence, reliability: 0.8 },
  });

  assert.equal(withheld.observedSynergy.available, false);
  assert.match(withheld.observedSynergy.reason, /requires reliability/i);
  assert.equal(available.observedSynergy.available, true);
  assert.equal(available.observedSynergy.adjustedPointsPer100, 2.2);
});

test("builds a player value envelope with production, advanced evaluation, impact, and fit kept separate", () => {
  const players = cohort();
  const selected = players.slice(0, 5);
  const fitAnalysis = analyzeLineupChemistry(selected, { referencePlayers: players });
  const result = buildPlayerValueProfiles([players[0]], {
    referencePlayers: players,
    fitAnalysis,
  }).records[0];

  assert.equal(result.production.available, true);
  assert.equal(result.production.compositeValue, null);
  assert.equal(result.impact.boxScoreModel.available, true);
  assert.equal(result.individualAdvancedEvaluation.metrics.offensiveBoxPlusMinus.value, 6);
  assert.equal(result.fit.available, true);
  assert.equal(result.fit.individualAttribution, null);
  assert.match(result.caveats.join(" "), /not collapsed into one number/i);
});

test("reports product readiness without promoting missing evidence", () => {
  const players = cohort();
  const readiness = assessBasketballProductReadiness({
    players,
    longitudinalSeasons: [2024, 2025, 2026],
    simulationModelContext: { mode: "exploratory", modelVersion: "what-if-v1" },
  });

  assert.equal(readiness.byId.optimalLineup.status, "supported");
  assert.equal(readiness.byId.simulation.status, "input-ready");
  assert.equal(readiness.byId.careerArc.status, "observed-trend-only");
  assert.equal(readiness.byId.careerArc.available, false);
  assert.equal(readiness.byId.matchups.status, "evidence-gated");
  assert.equal(readiness.byId.tendencies.available, false);
});

test("does not promote an invalid possession evidence container to partial readiness", () => {
  const players = cohort();
  const readiness = assessBasketballProductReadiness({
    players,
    impactEvidenceById: { [players[0].id]: { offensiveRapm: 2, defensiveRapm: 1 } },
    fitAnalysis: {},
  });

  assert.equal(readiness.byId.playerImpact.status, "box-model-only");
  assert.equal(readiness.generatedFrom.hasValidatedPossessionImpact, false);
  assert.equal(readiness.byId.chemistry.available, false);
  assert.equal(readiness.byId.chemistry.status, "needs-input");
});

test("requires a model version for otherwise validated possession impact", () => {
  const players = cohort();
  const evidence = {
    offensiveRapm: 2,
    defensiveRapm: 1,
    reliability: 0.8,
    displayEligible: true,
    validation: { sourceProvenancePassed: true, boxScoreReconciled: true },
  };
  const record = buildPlayerValueProfiles([players[0]], {
    referencePlayers: players,
    impactEvidenceById: { [players[0].id]: evidence },
  }).records[0];

  assert.equal(record.impact.possessionAdjusted.available, false);
  assert.match(record.impact.possessionAdjusted.reason, /model version/i);
});
