import assert from "node:assert/strict";
import test from "node:test";
import { loadOptimizerCore } from "./load-optimizer-core.mjs";

const { allocateRotationMinutes, optimizeLineups } = await loadOptimizerCore();

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
    minuteFlexibility: 0,
    positionMinuteRequirements: STANDARD_ROLE_MINUTES,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.byId, expected);
  assert.deepEqual(result.historicalGuidance.anchorsById, expected);
  assert.deepEqual(result.historicalGuidance.targetsById, expected);
});

test("historical workload protection keeps a tiny rate spike from inheriting starter minutes by default", () => {
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
  const protectedPlan = allocateRotationMinutes(players, {
    ...common,
    minutePlan: "historicalAware",
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

test("historical-aware allocation fails open with a visible reason when source evidence is incomplete", () => {
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

  assert.equal(result.ok, true);
  assert.equal(result.totalMinutes, 240);
  assert.equal(result.historicalGuidance.applied, false);
  assert.equal(result.historicalGuidance.status, "unavailable");
  assert.deepEqual(result.historicalGuidance.unavailablePlayerIds, ["p8"]);
  assert.match(result.historicalGuidance.reason, /unavailable/i);
});
