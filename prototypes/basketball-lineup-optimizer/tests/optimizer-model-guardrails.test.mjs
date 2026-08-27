import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessHistoricalPositionMinuteEvidence,
  deriveHistoricalPositionMinuteRequirements,
} from "../optimizer-config.js";
import { loadOptimizerCore } from "./load-optimizer-core.mjs";

const {
  allocateRotationMinutes,
  optimizeLineups,
  ROTATION_HISTORICAL_READINESS_SHARE,
  ROTATION_STRATEGY_SHARE,
} = await loadOptimizerCore();

function player(id, overrides = {}) {
  return {
    id,
    name: `Player ${id}`,
    team: "TST",
    positions: ["G", "F", "C"],
    games: 70,
    starts: 40,
    minutes: 24,
    fgPct: 0.5,
    threePct: 0.36,
    efgPct: 0.55,
    ftPct: 0.8,
    rebounds: 5,
    assists: 4,
    steals: 1,
    blocks: 0.5,
    turnovers: 2,
    points: 15,
    ...overrides,
  };
}

const STANDARD_ROLE_MINUTES = Object.freeze({ G: 96, F: 96, C: 48 });

test("automatic position-minute balance derives one stable 240-minute team profile", () => {
  const players = [
    player("guard", { positions: ["G"] }),
    player("forward", { positions: ["F"] }),
    player("center", { positions: ["C"] }),
    player("flex", { positions: ["F", "C"] }),
    player("unknown", { positions: ["X"] }),
  ];
  const anchors = {
    guard: 100,
    forward: 80,
    center: 20,
    flex: 40,
    unknown: 200,
  };

  const profile = deriveHistoricalPositionMinuteRequirements(players, anchors);
  assert.deepEqual(profile, { G: 100, F: 100, C: 40 });
  assert.equal(Object.values(profile).reduce((total, minutes) => total + minutes, 0), 240);
  assert.deepEqual(
    deriveHistoricalPositionMinuteRequirements([...players].reverse(), anchors),
    profile,
  );
  const evidence = assessHistoricalPositionMinuteEvidence(players, anchors);
  assert.equal(evidence.sourceRows, 5);
  assert.equal(evidence.workloadRows, 5);
  assert.equal(evidence.sourceListedPositionRows, 4);
  assert.equal(evidence.usableRows, 4);
  assert.equal(evidence.fallbackApplied, false);
  assert.deepEqual(evidence.requirements, profile);

  const fallback = assessHistoricalPositionMinuteEvidence([
    player("no-evidence", { positions: ["X"] }),
  ]);
  assert.equal(fallback.fallbackApplied, true);
  assert.deepEqual(fallback.requirements, STANDARD_ROLE_MINUTES);
});

test("verified career flexibility does not rewrite the historical position-minute estimate", () => {
  const players = [
    player("career-hybrid", {
      // The solver can use every verified role below, but this stint was
      // season-listed as a forward. Dividing the 120 historical minutes among
      // G/F/C would manufacture a guard and center minute history.
      positions: ["G", "F", "C"],
      positionEvidence: { seasonListed: ["F"] },
    }),
    player("season-guard", {
      positions: ["G"],
      positionEvidence: { seasonListed: ["G"] },
    }),
  ];
  const anchors = { "career-hybrid": 120, "season-guard": 120 };

  const evidence = assessHistoricalPositionMinuteEvidence(players, anchors);
  assert.equal(evidence.fallbackApplied, false);
  assert.equal(evidence.sourceListedPositionRows, 2);
  assert.deepEqual(evidence.requirements, { G: 120, F: 120, C: 0 });
});

test("historical-aware allocation honors exact workload anchors while open what-if ignores them", () => {
  const players = Array.from({ length: 8 }, (_, index) => player(`p${index + 1}`));
  const historicalMinuteAnchors = {
    p1: 40,
    p2: 40,
    p3: 40,
    p4: 40,
    p5: 30,
    p6: 20,
    p7: 20,
    p8: 10,
  };
  const scores = { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5, p6: 6, p7: 7, p8: 8 };
  const common = {
    minMinutes: 0,
    maxMinutes: 48,
    scores,
    strategy: "objective",
    historicalAllocationStyle: "preserveWorkload",
    minuteFlexibility: 0,
    historicalMinuteAnchors,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  };

  const historical = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "historicalAware",
  });
  const open = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "openWhatIf",
  });

  assert.equal(historical.ok, true);
  assert.deepEqual(historical.byId, historicalMinuteAnchors);
  assert.equal(historical.historicalGuidance.status, "applied");
  assert.equal(historical.historicalGuidance.flexibilityUsed, 0);
  assert.deepEqual(historical.positionMinutes.actual, STANDARD_ROLE_MINUTES);

  assert.equal(open.ok, true);
  assert.equal(open.historicalGuidance.status, "open-what-if");
  assert.notDeepEqual(open.byId, historicalMinuteAnchors);
  assert.deepEqual(open.positionMinutes.actual, STANDARD_ROLE_MINUTES);
});

test("historical workload anchors are derived from the live adapter's team-stint totals", () => {
  const expected = { p1: 40, p2: 40, p3: 40, p4: 40, p5: 30, p6: 20, p7: 20, p8: 10 };
  const players = Object.entries(expected).map(([id, anchor]) => player(id, {
    analytics: {
      totals: { minutes: anchor * 50 },
      teamTotalMinutes: 12000,
    },
  }));
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    minutePlan: "historicalAware",
    historicalAllocationStyle: "preserveWorkload",
    minuteFlexibility: 0,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.byId, expected);
  assert.deepEqual(result.historicalGuidance.anchorsById, expected);
  assert.deepEqual(result.historicalGuidance.targetsById, expected);
});

test("observed-workload continuity is opt-in; the default remains game-plan allocation", () => {
  const historicalMinuteAnchors = Object.fromEntries([
    ["micro", 2],
    ...Array.from({ length: 7 }, (_, index) => [`rotation-${index + 1}`, 34]),
  ]);
  const players = Object.keys(historicalMinuteAnchors).map((id) => player(id));
  const common = {
    minMinutes: 0,
    maxMinutes: 48,
    scores: Object.fromEntries(players.map((item) => [item.id, item.id === "micro" ? 100 : 1])),
    strategy: "objective",
    historicalMinuteAnchors,
    minuteFlexibility: 8,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  };
  const defaultPlan = allocateRotationMinutes(players, common);
  const protectedPlan = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "historicalAware",
    historicalAllocationStyle: "preserveWorkload",
  });
  const strategyFirst = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "historicalAware",
    historicalAllocationStyle: "strategyFirst",
  });
  const openWhatIf = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "openWhatIf",
  });

  assert.equal(defaultPlan.ok, true);
  assert.equal(defaultPlan.minutePlan, "openWhatIf");
  assert.equal(defaultPlan.byId.micro, 48);
  assert.equal(defaultPlan.historicalGuidance.allocationStyleApplied, "hard-limits-only");
  assert.equal(protectedPlan.ok, true);
  assert.equal(protectedPlan.byId.micro, 2);
  assert.equal(protectedPlan.historicalGuidance.allocationStyleApplied, "preserveWorkload");
  assert.equal(protectedPlan.strategy, "historical-workload-continuity");
  assert.equal(strategyFirst.ok, true);
  assert.equal(strategyFirst.byId.micro, 10);
  assert.equal(strategyFirst.historicalGuidance.allocationStyleApplied, "strategyFirst");
  assert.equal(openWhatIf.ok, true);
  assert.equal(openWhatIf.byId.micro, 48);
});

test("realistic mode rejects a selected roster that lacks observed workload capacity", () => {
  const players = Array.from({ length: 8 }, (_, index) => player(`reserve-${index + 1}`));
  const historicalMinuteAnchors = Object.fromEntries(
    players.map((item) => [item.id, 20]),
  );
  const common = {
    minMinutes: 0,
    maxMinutes: 48,
    historicalMinuteAnchors,
    minuteFlexibility: 8,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  };
  const realistic = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "historicalAware",
  });
  const openWhatIf = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "openWhatIf",
  });

  // Eight 20-minute reserves can provide at most 224 minutes inside a
  // +/-8 workload window. Rescaling their targets to 240 would manufacture
  // starter minutes, so realistic mode must fail explicitly instead.
  assert.equal(realistic.ok, false);
  assert.equal(realistic.diagnostics.category, "historical-workload");
  assert.equal(realistic.diagnostics.historicalGuidance.status, "workload-capacity-infeasible");
  assert.match(realistic.reasons.join(" "), /at most 224 of 240 minutes/i);

  assert.equal(openWhatIf.ok, true);
});

test("historical continuity minimizes workload departure when exact role coverage changes a target", () => {
  const players = [
    ...Array.from({ length: 3 }, (_, index) => player(`g${index + 1}`, { positions: ["G"] })),
    ...Array.from({ length: 4 }, (_, index) => player(`f${index + 1}`, { positions: ["F"] })),
    player("center", { positions: ["C"] }),
  ];
  const historicalMinuteAnchors = {
    g1: 36,
    g2: 36,
    g3: 36,
    f1: 22,
    f2: 22,
    f3: 22,
    f4: 22,
    center: 44,
  };
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    minutePlan: "historicalAware",
    historicalAllocationStyle: "preserveWorkload",
    minuteFlexibility: 8,
    historicalMinuteAnchors,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });

  assert.equal(result.ok, true);
  assert.equal(result.byId.center, 48);
  assert.equal(result.positionMinutes.actual.C, 48);
  assert.equal(result.diagnostics.historicalGuidance.allocationStyleApplied, "preserveWorkload");
  assert.equal(result.positionMinutes.byPlayer.center.C, 48);
  assert.equal(
    result.allocations.reduce(
      (total, allocation) => total + Math.abs(allocation.minutes - allocation.historicalTarget),
      0,
    ),
    // The source targets call for 108 G / 88 F / 44 C minutes. Reaching the
    // required 96 / 96 / 48 shape therefore needs at least 12 + 8 + 4 = 24
    // absolute player-minute changes; the continuity network attains that
    // lower bound rather than drifting by ID order.
    24,
  );
});

test("historical continuity uses player value only to break equal-realism minute ties", () => {
  const players = [
    ...Array.from({ length: 3 }, (_, index) => player(`g${index + 1}`, { positions: ["G"] })),
    ...Array.from({ length: 4 }, (_, index) => player(`f${index + 1}`, { positions: ["F"] })),
    player("center", { positions: ["C"] }),
  ];
  const historicalMinuteAnchors = {
    g1: 36,
    g2: 36,
    g3: 36,
    f1: 22,
    f2: 22,
    f3: 22,
    f4: 22,
    center: 44,
  };
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    minutePlan: "historicalAware",
    minuteFlexibility: 8,
    historicalMinuteAnchors,
    historicalAllocationStyle: "preserveWorkload",
    scores: {
      g1: 100,
      g2: 50,
      g3: 0,
      f1: 100,
      f2: 50,
      f3: 10,
      f4: 0,
      center: 50,
    },
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });

  assert.equal(result.ok, true);
  assert.equal(result.byId.g1, 36);
  assert.equal(result.byId.g2, 32);
  assert.equal(result.byId.g3, 28);
  assert.equal(result.byId.f1, 30);
  assert.equal(result.byId.f2, 22);
  assert.equal(result.byId.f3, 22);
  assert.equal(result.byId.f4, 22);
  assert.equal(result.byId.center, 48);
  assert.equal(
    result.allocations.reduce(
      (total, allocation) => total + Math.abs(
        allocation.minutes - allocation.historicalTarget,
      ),
      0,
    ),
    24,
  );
});

test("a partial-season player is anchored to the team's game share, never raw MPG", () => {
  const partialAnchor = (12 * 30) / 82;
  const remainingAnchor = (240 - partialAnchor) / 7;
  const players = [
    player("short-stint", { games: 12, minutes: 30 }),
    ...Array.from({ length: 7 }, (_, index) => player(`full-${index + 1}`, {
      games: 82,
      minutes: remainingAnchor,
    })),
  ];
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    minutePlan: "historicalAware",
    historicalAllocationStyle: "preserveWorkload",
    minuteFlexibility: 0,
    historicalTeamGames: 82,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.historicalGuidance.anchorsById["short-stint"] - partialAnchor) < 1e-9);
  assert.ok(result.historicalGuidance.targetsById["short-stint"] <= 5);
  assert.ok(result.byId["short-stint"] <= 5);
  assert.notEqual(result.byId["short-stint"], 30);
});

test("sample adjustment keeps a tiny-sample rate spike from outranking proven production", () => {
  const steadyPlayers = Array.from({ length: 7 }, (_, index) => player(`steady-${index + 1}`, {
    points: 15 + index * 0.01,
    analytics: {
      totals: { minutes: 2000 },
      leaguePer36: { points: 15 },
    },
  }));
  const players = [
    ...steadyPlayers,
    player("tiny-sample", {
      minutes: 1,
      points: 2,
      analytics: {
        totals: { minutes: 10 },
        leaguePer36: { points: 15 },
      },
    }),
    player("proven", {
      minutes: 36,
      points: 20,
      analytics: {
        totals: { minutes: 2500 },
        leaguePer36: { points: 15 },
      },
    }),
  ];
  const baseConfig = {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      minutePlan: "openWhatIf",
      positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    },
  };

  const raw = optimizeLineups(players, {
    ...baseConfig,
    rotationOptions: { ...baseConfig.rotationOptions, rateStability: "raw" },
  });
  const adjusted = optimizeLineups(players, {
    ...baseConfig,
    rotationOptions: { ...baseConfig.rotationOptions, rateStability: "sampleAdjusted" },
  });

  assert.equal(raw.ok, true);
  assert.equal(adjusted.ok, true);
  assert.ok(raw.best.playerIds.includes("tiny-sample"));
  assert.ok(!adjusted.best.playerIds.includes("tiny-sample"));
  assert.ok(adjusted.best.playerIds.includes("proven"));
  assert.equal(raw.diagnostics.rotationRateStabilityEvidence.requested, "raw");
  assert.equal(raw.diagnostics.rotationRateStabilityEvidence.applied, false);
  assert.match(raw.diagnostics.rotationRateStabilityEvidence.reason, /disabled.*raw per-36/i);
  assert.equal(adjusted.diagnostics.rotationRateStabilityEvidence.applied, true);
  assert.equal(adjusted.diagnostics.rotationRateStabilityEvidence.adjustedPlayers, 9);
});

test("role-expansion projection prevents a low-usage scoring spike from winning a star-sized role", () => {
  // Every standard player has a credible 30-minute source role. The low-role
  // scorer's raw 54 points per 36 looks extraordinary, but it came in only
  // eight MPG. The model should compare him at the 30-minute responsibility
  // implied by an eight-player rotation—not prefer or cap him because of his
  // past minutes.
  const standardPlayers = Array.from({ length: 8 }, (_, index) => player(`standard-${index + 1}`, {
    minutes: 30,
    points: 19 + (index * 0.01),
    analytics: {
      totals: { minutes: 2100 },
      leaguePer36: { points: 15 },
    },
  }));
  const lowRoleScorer = player("low-role-scorer", {
    minutes: 8,
    points: 12,
    analytics: {
      totals: { minutes: 560 },
      leaguePer36: { points: 15 },
    },
  });
  const baseConfig = {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 8,
      maxMinutes: 48,
      minutePlan: "openWhatIf",
      scoringBasis: "per36",
      positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    },
  };

  const raw = optimizeLineups(
    [lowRoleScorer, ...standardPlayers],
    { ...baseConfig, rotationOptions: { ...baseConfig.rotationOptions, rateStability: "raw" } },
  );
  const adjusted = optimizeLineups(
    [lowRoleScorer, ...standardPlayers],
    { ...baseConfig, rotationOptions: { ...baseConfig.rotationOptions, rateStability: "sampleAdjusted" } },
  );

  assert.equal(raw.ok, true);
  assert.equal(adjusted.ok, true);
  assert.ok(raw.best.playerIds.includes("low-role-scorer"));
  assert.ok(!adjusted.best.playerIds.includes("low-role-scorer"));
  assert.equal(adjusted.diagnostics.rotationRateStabilityEvidence.roleMinutesTarget, 30);
  assert.ok(adjusted.diagnostics.rotationRateStabilityEvidence.roleAdjustedPlayerMetricCount > 0);
  assert.equal(adjusted.diagnostics.rotationHistoricalReadiness.applied, false);
});

test("assigned-role scoring smoothly reduces extra-minute value without capping a low-role player", () => {
  const lowRoleStar = player("low-role-star", { minutes: 8 });
  const standardPlayers = Array.from({ length: 7 }, (_, index) => player(`standard-${index + 1}`, {
    minutes: 30,
  }));
  const players = [lowRoleStar, ...standardPlayers];
  const scores = Object.fromEntries(players.map((item) => [
    item.id,
    item.id === "low-role-star" ? 0.98 : 0.7,
  ]));
  const roleConditionedScorePlan = {
    referenceMinutes: 30,
    evidenceMinutesById: Object.fromEntries(players.map((item) => [item.id, 30])),
    establishedScoresById: scores,
    // After the established role, marginal value decays toward the neutral
    // same-season baseline. The player can still earn a larger role, but no
    // longer receives his spike unchanged for all 48 minutes.
    expandedScoresById: Object.fromEntries(players.map((item) => [item.id, 0.5])),
    activeMetrics: ["points"],
  };

  const linear = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    scores,
    strategy: "objective",
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });
  const roleConditioned = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    scores,
    strategy: "objective",
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    roleConditionedScorePlan,
  });

  assert.equal(linear.ok, true);
  assert.equal(roleConditioned.ok, true);
  assert.equal(linear.byId["low-role-star"], 48);
  assert.ok(roleConditioned.byId["low-role-star"] > 30);
  assert.ok(roleConditioned.byId["low-role-star"] < linear.byId["low-role-star"]);
  assert.ok(roleConditioned.byId["low-role-star"] > lowRoleStar.minutes);
  assert.equal(roleConditioned.strategy, "objective-role-conditioned");
  assert.equal(roleConditioned.diagnostics.roleConditionedScoring.applied, true);
  assert.equal(roleConditioned.totalMinutes, 240);
  assert.deepEqual(roleConditioned.positionMinutes.actual, STANDARD_ROLE_MINUTES);
});

test("career-only position minute caps remain exact rotation constraints", () => {
  const players = [
    ...Array.from({ length: 2 }, (_, index) => player(`guard-${index + 1}`, { positions: ["G"] })),
    ...Array.from({ length: 5 }, (_, index) => player(`forward-${index + 1}`, { positions: ["F"] })),
    player("career-center", {
      positions: ["F", "C"],
      // This models the UI's recommended policy: F was listed this season; C
      // is verified on the career profile but conservatively limited to half a
      // regulation game's center role.
      positionMinuteCaps: { C: 24 },
    }),
  ];
  const common = {
    minMinutes: 0,
    maxMinutes: 48,
    scores: Object.fromEntries(players.map((item) => [item.id, 1])),
    strategy: "objective",
  };

  const recommendedTraditional = allocateRotationMinutes(players, {
    ...common,
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
  });
  const recommendedSmall = allocateRotationMinutes(players, {
    ...common,
    positionMinuteRequirements: { G: 96, F: 120, C: 24 },
  });
  const openTraditional = allocateRotationMinutes(
    players.map((item) => ({ ...item, positionMinuteCaps: {} })),
    { ...common, positionMinuteRequirements: { G: 96, F: 96, C: 48 } },
  );

  assert.equal(recommendedTraditional.ok, false);
  assert.equal(recommendedSmall.ok, true);
  assert.equal(recommendedSmall.positionMinutes.byPlayer["career-center"].C, 24);
  assert.equal(openTraditional.ok, true);
  assert.equal(openTraditional.positionMinutes.byPlayer["career-center"].C, 48);
});

test("assigned-role projection lowers extra-role totals without changing a required minute assignment", () => {
  const lowRoleScorer = player("low-role-scorer", {
    minutes: 8,
    points: 14,
    analytics: {
      totals: { minutes: 560 },
      leaguePer36: { points: 15 },
    },
  });
  const standardPlayers = Array.from({ length: 7 }, (_, index) => player(`standard-${index + 1}`, {
    minutes: 30,
    points: 18 + (index * 0.01),
    analytics: {
      totals: { minutes: 2100 },
      leaguePer36: { points: 15 },
    },
  }));
  const players = [lowRoleScorer, ...standardPlayers];
  // Fix the minute plan so the comparison isolates the projection itself. The
  // low-role scorer must still play 40 minutes in both runs; only his estimated
  // production beyond the established 30-minute role is tempered.
  const playerBounds = Object.fromEntries(players.map((item, index) => [
    item.id,
    index === 0
      ? { min: 40, max: 40 }
      : index <= 4
        ? { min: 29, max: 29 }
        : { min: 28, max: 28 },
  ]));
  const baseConfig = {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      playerBounds,
      minutePlan: "openWhatIf",
      scoringBasis: "per36",
      rateStability: "sampleAdjusted",
      positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    },
  };
  const roleConditioned = optimizeLineups(players, baseConfig);
  const staticAdjusted = optimizeLineups(players, {
    ...baseConfig,
    rotationOptions: {
      ...baseConfig.rotationOptions,
      // A caller-owned score map intentionally retains the static projection.
      // With every minute fixed, it makes a clean like-for-like control case.
      scores: Object.fromEntries(players.map((item) => [item.id, 1])),
    },
  });

  assert.equal(roleConditioned.ok, true);
  assert.equal(staticAdjusted.ok, true);
  assert.equal(roleConditioned.best.rotation.byId["low-role-scorer"], 40);
  assert.equal(staticAdjusted.best.rotation.byId["low-role-scorer"], 40);
  assert.equal(roleConditioned.best.rotation.diagnostics.roleConditionedScoring.applied, true);
  assert.equal(roleConditioned.best.rotation.diagnostics.roleConditionedScoring.expandedMinutes, 10);
  assert.ok(roleConditioned.best.totals.points < staticAdjusted.best.totals.points);
  assert.equal(
    roleConditioned.best.playerContributions["low-role-scorer"].metrics.points.assignedRoleAdjusted,
    true,
  );
  const contributionTotal = Object.values(roleConditioned.best.playerContributions)
    .reduce((total, entry) => total + Number(entry.scoreContribution), 0);
  assert.ok(Math.abs(contributionTotal - roleConditioned.best.score) < 0.01);
});

test("role expansion never improves a below-baseline scorer", () => {
  const belowBaseline = player("below-baseline", {
    minutes: 8,
    points: 2,
    analytics: {
      totals: { minutes: 560 },
      leaguePer36: { points: 15 },
    },
  });
  const established = Array.from({ length: 7 }, (_, index) => player(`established-${index + 1}`, {
    minutes: 30,
    points: 18,
    analytics: {
      totals: { minutes: 2100 },
      leaguePer36: { points: 15 },
    },
  }));
  const players = [belowBaseline, ...established];
  const playerBounds = Object.fromEntries(players.map((item, index) => [
    item.id,
    index === 0
      ? { min: 40, max: 40 }
      : index <= 4
        ? { min: 29, max: 29 }
        : { min: 28, max: 28 },
  ]));
  const baseConfig = {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      playerBounds,
      minutePlan: "openWhatIf",
      scoringBasis: "per36",
      rateStability: "sampleAdjusted",
      positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    },
  };
  const roleConditioned = optimizeLineups(players, baseConfig);
  const commonRoleOnly = optimizeLineups(players, {
    ...baseConfig,
    rotationOptions: {
      ...baseConfig.rotationOptions,
      scores: Object.fromEntries(players.map((item) => [item.id, 1])),
    },
  });

  assert.equal(roleConditioned.ok, true);
  assert.equal(commonRoleOnly.ok, true);
  assert.equal(roleConditioned.best.rotation.byId["below-baseline"], 40);
  // Expansion cannot replace a weak established projection with the better
  // league baseline. It therefore matches—not exceeds—the common-role control.
  assert.equal(roleConditioned.best.totals.points, commonRoleOnly.best.totals.points);
});

test("role-adjusted production is used for projected 240-minute totals, not just roster ranking", () => {
  const lowRoleScorer = player("low-role-scorer", {
    minutes: 8,
    points: 12,
    analytics: {
      totals: { minutes: 560 },
      leaguePer36: { points: 15 },
    },
  });
  const standardPlayers = Array.from({ length: 7 }, (_, index) => player(`standard-${index + 1}`, {
    minutes: 30,
    points: 19 + (index * 0.01),
    analytics: {
      totals: { minutes: 2100 },
      leaguePer36: { points: 15 },
    },
  }));
  const playerBounds = Object.fromEntries(
    [lowRoleScorer, ...standardPlayers].map((item) => [item.id, { min: 30, max: 30 }]),
  );
  const baseConfig = {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      playerBounds,
      minutePlan: "openWhatIf",
      scoringBasis: "per36",
      positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    },
  };
  const raw = optimizeLineups(
    [lowRoleScorer, ...standardPlayers],
    { ...baseConfig, rotationOptions: { ...baseConfig.rotationOptions, rateStability: "raw" } },
  );
  const adjusted = optimizeLineups(
    [lowRoleScorer, ...standardPlayers],
    { ...baseConfig, rotationOptions: { ...baseConfig.rotationOptions, rateStability: "sampleAdjusted" } },
  );

  assert.equal(raw.ok, true);
  assert.equal(adjusted.ok, true);
  // The player receives the same user-required 30 minutes in each run. The
  // lower adjusted projection comes from his rate estimate, not fewer minutes.
  assert.equal(raw.best.rotation.byId["low-role-scorer"], 30);
  assert.equal(adjusted.best.rotation.byId["low-role-scorer"], 30);
  assert.ok(raw.best.totals.points > adjusted.best.totals.points);
  assert.equal(
    adjusted.best.rotation.diagnostics.projectedConstraints.projectedRatesApplied,
    true,
  );
});

test("role-expansion projection also tempers tiny-sample shooting efficiency", () => {
  const standardPlayers = Array.from({ length: 8 }, (_, index) => player(`standard-${index + 1}`, {
    minutes: 30,
    efgPct: 0.62 + (index * 0.0001),
    analytics: {
      totals: { minutes: 2100, fieldGoalsAttempted: 600 },
      leaguePer36: { efgPct: 0.55 },
    },
  }));
  const lowUsageShooter = player("low-usage-shooter", {
    minutes: 8,
    efgPct: 0.9,
    analytics: {
      totals: { minutes: 560, fieldGoalsAttempted: 10 },
      leaguePer36: { efgPct: 0.55 },
    },
  });
  const baseConfig = {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { efgPct: 1 },
    rotationOptions: {
      minMinutes: 8,
      maxMinutes: 48,
      minutePlan: "openWhatIf",
      scoringBasis: "per36",
      positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    },
  };
  const raw = optimizeLineups(
    [lowUsageShooter, ...standardPlayers],
    { ...baseConfig, rotationOptions: { ...baseConfig.rotationOptions, rateStability: "raw" } },
  );
  const adjusted = optimizeLineups(
    [lowUsageShooter, ...standardPlayers],
    { ...baseConfig, rotationOptions: { ...baseConfig.rotationOptions, rateStability: "sampleAdjusted" } },
  );

  assert.equal(raw.ok, true);
  assert.equal(adjusted.ok, true);
  assert.ok(raw.best.playerIds.includes("low-usage-shooter"));
  assert.ok(!adjusted.best.playerIds.includes("low-usage-shooter"));
  assert.ok(adjusted.diagnostics.rotationRateStabilityEvidence.roleAdjustedPlayerMetricCount > 0);
});

test("missing rate metadata cannot create a ranking advantage over an identical short sample", () => {
  const steadyPlayers = Array.from({ length: 7 }, (_, index) => player(`steady-${index + 1}`, {
    points: 15 + index * 0.01,
    analytics: {
      totals: { minutes: 1800 },
      leaguePer36: { points: 15 },
    },
  }));
  const players = [
    player("a-backed", {
      minutes: 1,
      points: 2,
      analytics: {
        totals: { minutes: 10 },
        leaguePer36: { points: 15 },
      },
    }),
    player("z-missing", { minutes: 1, points: 2 }),
    ...steadyPlayers,
  ];
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      minutePlan: "openWhatIf",
      rateStability: "sampleAdjusted",
      positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.best.playerIds.includes("a-backed"));
  assert.ok(result.best.playerIds.includes("z-missing"));
  assert.equal(result.diagnostics.rotationRateStabilityEvidence.applied, false);
  assert.ok(result.diagnostics.rotationRateStabilityEvidence.rawMetricsDueToIncompleteEvidence.includes("points"));
});

test("rotation ranking uses game-plan fit only while explicit historical capacity bounds minutes", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../fixtures/timberwolves-2021-22.json", import.meta.url),
    "utf8",
  ));
  const teamGames = Math.max(...fixture.players.map((item) => Number(item.games) || 0));
  const historicalMinuteAnchors = Object.fromEntries(fixture.players.map((item) => [
    item.id,
    (Number(item.games) * Number(item.minutes)) / teamGames,
  ]));
  const requiredPositionMinutes = { G: 115, F: 92, C: 33 };
  const result = optimizeLineups(fixture.players, {
    mode: "rotation",
    size: 9,
    alternatives: 2,
    preset: "balanced",
    minGames: 20,
    minMinutes: 6,
    positionMinimums: { G: 3, F: 3, C: 2 },
    rotationOptions: {
      minMinutes: 8,
      maxMinutes: 40,
      minutePlan: "historicalAware",
      historicalAllocationStyle: "preserveWorkload",
      minuteFlexibility: 8,
      scoringBasis: "per36",
      rateStability: "sampleAdjusted",
      positionMinuteRequirements: requiredPositionMinutes,
      historicalMinuteAnchors,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(ROTATION_STRATEGY_SHARE, 1);
  assert.equal(ROTATION_HISTORICAL_READINESS_SHARE, 0);
  assert.equal(result.diagnostics.rotationHistoricalReadiness.applied, false);
  assert.equal(result.diagnostics.rotationHistoricalReadiness.strategyShare, 1);
  assert.equal(result.diagnostics.rotationHistoricalReadiness.historicalReadinessShare, 0);
  assert.ok(result.best.playerIds.includes("jaden-mcdaniels"));
  assert.ok(result.best.playerIds.includes("nathan-knight"));
  assert.ok(result.best.rotation.byId["nathan-knight"] <= 10);
  assert.equal(result.best.rotation.historicalGuidance.allocationStyleApplied, "preserveWorkload");
  assert.equal(result.best.rotation.totalMinutes, 240);
  assert.deepEqual(result.best.rotation.positionMinutes.actual, requiredPositionMinutes);
  assert.ok(Math.abs(
    result.best.score -
      (result.best.strategyScore + result.best.historicalReadinessScore)
  ) <= 0.000001);
  assert.equal(result.best.historicalReadinessIndex, null);
  const componentTotal = Object.values(result.best.contributionBreakdown).reduce(
    (total, component) => total + component.scoreContribution,
    0,
  );
  assert.ok(Math.abs(componentTotal - result.best.score) <= 0.00001);
});

test("open what-if rotation uses game-plan fit only for both roster ranking and minutes", () => {
  const ids = [
    "a-best-strategy",
    ...Array.from({ length: 11 }, (_, index) => `p${index + 2}`),
  ];
  const players = ids.map((id, index) => player(id, {
    positions: ["G", "F", "C"],
    // The best game-plan fit has very little recorded workload. The remaining
    // players intentionally create a realistic-looking workload gradient.
    points: index === 0 ? 30 : index <= 5 ? 20 : 10,
  }));
  const historicalMinuteAnchors = Object.fromEntries(
    ids.map((id, index) => [id, index === 0 ? 1 : 13 - index]),
  );
  const rotationOptions = {
    minMinutes: 0,
    maxMinutes: 48,
    minutePlan: "openWhatIf",
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
    historicalMinuteAnchors,
    scoringBasis: "perGame",
    rateStability: "raw",
  };
  const baseConfig = {
    mode: "rotation",
    size: 12,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    positionMinimums: { G: 0, F: 0, C: 0 },
    weights: { points: 1 },
    rotationOptions,
  };

  for (const [label, config] of [
    ["ordinary", baseConfig],
    ["projected-constraint", { ...baseConfig, statMinimums: { points: 1 } }],
  ]) {
    const result = optimizeLineups(players, config);
    assert.equal(result.ok, true, label);
    // Open what-if intentionally ignores the workload gradient. Neither the
    // roster score nor the minute plan may let it steal proposed minutes from
    // the higher-fitting player.
    assert.equal(result.best.rotation.byId["a-best-strategy"], 48, label);
    assert.equal(
      ["p2", "p3", "p4", "p5", "p6"]
        .filter((id) => result.best.rotation.byId[id] === 48)
        .length,
      4,
      label,
    );
    assert.ok(Math.abs(result.best.strategyFitScore - 78.181818) < 0.00001, label);
    assert.equal(result.best.historicalReadinessIndex, null, label);
    assert.ok(Math.abs(result.best.score - 78.181818) < 0.00001, label);
    assert.equal(result.diagnostics.rotationHistoricalReadiness.applied, false, label);
    assert.match(
      result.diagnostics.rotationHistoricalReadiness.reason,
      /game-plan fit and rate projection determine the result/i,
      label,
    );
    if (label === "projected-constraint") {
      assert.equal(result.best.rotation.strategy, "objective-constrained");
    }
  }
});

test("custom position profiles reconcile every player and role minute", () => {
  const players = [
    ...Array.from({ length: 3 }, (_, index) => player(`g${index + 1}`, { positions: ["G"] })),
    ...Array.from({ length: 3 }, (_, index) => player(`f${index + 1}`, { positions: ["F"] })),
    ...Array.from({ length: 2 }, (_, index) => player(`c${index + 1}`, { positions: ["C"] })),
  ];
  const required = { G: 80, F: 80, C: 80 };
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    strategy: "balanced",
    minutePlan: "openWhatIf",
    positionMinuteRequirements: required,
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalMinutes, 240);
  assert.deepEqual(result.positionMinutes.required, required);
  assert.deepEqual(result.positionMinutes.actual, required);
  assert.equal(
    Object.values(result.positionMinutes.byPlayer)
      .flatMap((roleMinutes) => Object.values(roleMinutes))
      .reduce((total, minutes) => total + minutes, 0),
    240,
  );
  for (const allocation of result.allocations) {
    const assignedRoleMinutes = Object.values(allocation.roleMinutes)
      .reduce((total, minutes) => total + minutes, 0);
    assert.equal(assignedRoleMinutes, allocation.minutes);
  }
});

test("custom position infeasibility reports the requested role-minute profile", () => {
  const players = Array.from({ length: 8 }, (_, index) => player(`wing-${index + 1}`, {
    positions: ["G", "F"],
  }));
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    positionMinimums: { G: 0, F: 0, C: 0 },
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      minutePlan: "openWhatIf",
      positionMinuteRequirements: { G: 120, F: 96, C: 24 },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.rejectedByConstraint.rotationPositionMinutes, 1);
  assert.deepEqual(
    result.diagnostics.requiredPositionMinutes,
    { G: 120, F: 96, C: 24 },
  );
  const reasons = result.reasons.join(" ");
  assert.match(reasons, /120 guard, 96 forward, and 24 center minutes/);
  assert.doesNotMatch(reasons, /96 guard, 96 forward, and 48 center minutes/);
});

test("projected-constraint proofs use the custom role profile instead of traditional minutes", () => {
  const rolePlayer = (id, positions, overrides = {}) => player(id, {
    positions,
    minutes: 48,
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
    ...overrides,
  });
  const players = [
    ...Array.from({ length: 3 }, (_, index) => rolePlayer(
      `scorer-${index + 1}`,
      ["G"],
      { points: 48 },
    )),
    ...Array.from({ length: 3 }, (_, index) => rolePlayer(
      `passer-${index + 1}`,
      ["G"],
      { assists: 48 },
    )),
    ...Array.from({ length: 4 }, (_, index) => rolePlayer(`forward-${index + 1}`, ["F"])),
    ...Array.from({ length: 2 }, (_, index) => rolePlayer(`center-${index + 1}`, ["C"])),
  ];
  const playerBounds = {
    "scorer-1": { min: 32, max: 48 },
    "scorer-2": { min: 32, max: 48 },
    "scorer-3": { min: 32, max: 48 },
    "passer-1": { min: 0, max: 4 },
    "passer-2": { min: 0, max: 4 },
    "passer-3": { min: 0, max: 3 },
    "forward-1": { min: 48, max: 48 },
    "forward-2": { min: 48, max: 48 },
    "forward-3": { min: 0, max: 0 },
    "forward-4": { min: 0, max: 0 },
    "center-1": { min: 0, max: 48 },
    "center-2": { min: 0, max: 0 },
  };
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 12,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    positionMinimums: { G: 0, F: 0, C: 0 },
    weights: { assists: 1 },
    statMinimums: { points: 110 },
    maxConstraintSearchStates: 1000,
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      playerBounds,
      minutePlan: "openWhatIf",
      positionMinuteRequirements: { G: 120, F: 96, C: 24 },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.best.constraintAudit.statMinimums.checks.points.passed, true);
  assert.ok(result.best.totals.points >= 110);
  assert.deepEqual(result.best.rotation.positionMinutes.actual, { G: 120, F: 96, C: 24 });
  assert.ok(result.diagnostics.constrainedCandidatesSearched > 0);
  assert.equal(result.diagnostics.rejectedByConstraint.statMinimums.points, 0);
});

test("historical-aware allocation fails closed when only part of the selected roster has workload evidence", () => {
  const players = Array.from({ length: 8 }, (_, index) => player(`p${index + 1}`, {
    analytics: index === 7
      ? undefined
      : {
          historicalMinutesPerTeamGame: 30,
          totals: { minutes: 1200 },
          teamTotalMinutes: 9600,
        },
  }));
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    minutePlan: "historicalAware",
    minuteFlexibility: 4,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });

  assert.equal(result.ok, false);
  assert.equal(result.totalMinutes, 0);
  assert.equal(result.diagnostics.category, "historical-workload");
  assert.equal(result.diagnostics.subcategory, "missing-workload-evidence");
  const guidance = result.diagnostics.historicalGuidance;
  assert.equal(guidance.applied, false);
  assert.equal(guidance.status, "missing-workload-evidence");
  assert.deepEqual(guidance.unavailablePlayerIds, ["p8"]);
  assert.match(guidance.reason, /guardrail will not apply unevenly/i);

  const openWhatIf = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    minutePlan: "openWhatIf",
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });
  assert.equal(openWhatIf.ok, true);
  assert.equal(openWhatIf.totalMinutes, 240);
});
