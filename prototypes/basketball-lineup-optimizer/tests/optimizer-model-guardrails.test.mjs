import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// This project serves browser modules directly and intentionally has no
// package.json. A data URL lets Node exercise the exact shipped module.
const moduleSource = await readFile(new URL("../optimizer-core.js", import.meta.url), "utf8");
const { allocateRotationMinutes, optimizeLineups } = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource, "utf8").toString("base64")}`
);

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
