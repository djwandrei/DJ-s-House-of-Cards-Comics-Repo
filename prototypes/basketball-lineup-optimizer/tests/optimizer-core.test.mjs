import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The repository is intentionally package-free and serves browser ES modules
// directly. Loading through a data URL lets `node --test` verify that module
// without adding a package.json solely for Node's .js module classification.
const moduleSource = await readFile(new URL("../optimizer-core.js", import.meta.url), "utf8");
const optimizer = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource, "utf8").toString("base64")}`
);

const { allocateRotationMinutes, MAX_EXACT_ALTERNATIVES, optimizeLineups } = optimizer;

function player(id, overrides = {}) {
  return {
    id,
    name: `Player ${id}`,
    team: "TST",
    positions: ["G"],
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

test("returns exact-size lineups and evaluates every combination", () => {
  const players = Array.from({ length: 6 }, (_, index) =>
    player(`p${index + 1}`, { points: 10 + index }),
  );
  const result = optimizeLineups(players, {
    size: 5,
    weights: { points: 1 },
    alternatives: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.combinationsEvaluated, 6);
  assert.equal(result.diagnostics.feasibleCombinations, 6);
  assert.equal(result.alternatives.length, 3);
  assert.ok(result.alternatives.every((lineup) => lineup.players.length === 5));
  assert.ok(result.alternatives.every((lineup) => lineup.constraintAudit.exactSize.passed));
});

test("honors locked and excluded players", () => {
  const players = Array.from({ length: 7 }, (_, index) =>
    player(`p${index + 1}`, { points: 10 + index }),
  );
  const result = optimizeLineups(players, {
    size: 5,
    weights: { points: 1 },
    lockedIds: ["p1"],
    excludedIds: ["p7"],
    alternatives: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.combinationsEvaluated, 5);
  for (const lineup of result.alternatives) {
    assert.ok(lineup.playerIds.includes("p1"));
    assert.ok(!lineup.playerIds.includes("p7"));
    assert.equal(lineup.constraintAudit.lockedPlayers.passed, true);
    assert.equal(lineup.constraintAudit.excludedPlayers.passed, true);
  }
});

test("treats lower turnovers as better ball security", () => {
  const result = optimizeLineups(
    [
      player("careful", { turnovers: 0.8 }),
      player("average", { turnovers: 2 }),
      player("risky", { turnovers: 4.2 }),
    ],
    { size: 1, weights: { ballSecurity: 1 }, alternatives: 3 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.alternatives.map((lineup) => lineup.playerIds[0]),
    ["careful", "average", "risky"],
  );
  assert.ok(result.alternatives[0].score > result.alternatives[2].score);
});

test("does not let one flex player fill two positional slots", () => {
  const result = optimizeLineups(
    [
      player("flex", { positions: ["G", "F"] }),
      player("center", { positions: ["C"] }),
    ],
    {
      size: 2,
      weights: { points: 1 },
      positionMinimums: { G: 1, F: 1, C: 0 },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "infeasible");
  assert.ok(result.reasons.some((reason) => reason.includes("distinct players")));
  assert.equal(result.alternatives.length, 0);
});

test("returns a structured infeasible result for locked/excluded conflicts", () => {
  const result = optimizeLineups(
    Array.from({ length: 5 }, (_, index) => player(`p${index + 1}`)),
    {
      size: 5,
      weights: { points: 1 },
      lockedIds: ["p1"],
      excludedIds: ["p1"],
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "infeasible");
  assert.ok(result.reasons.some((reason) => reason.includes("both locked and excluded")));
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.diagnostics.combinationsEvaluated, 0);
});

test("sorts alternatives by score and then by sorted player ids", () => {
  const result = optimizeLineups(
    [
      player("b", { points: 20 }),
      player("d", { points: 10 }),
      player("a", { points: 20 }),
      player("c", { points: 30 }),
    ],
    { size: 1, weights: { points: 1 }, alternatives: 4 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.alternatives.map((lineup) => lineup.playerIds[0]),
    ["c", "a", "b", "d"],
  );
  for (let index = 1; index < result.alternatives.length; index += 1) {
    assert.ok(result.alternatives[index - 1].score >= result.alternatives[index].score);
  }
});

test("rejects an unbounded alternatives request", () => {
  const result = optimizeLineups(
    Array.from({ length: 5 }, (_, index) => player(`p${index + 1}`)),
    {
      size: 5,
      weights: { points: 1 },
      alternatives: MAX_EXACT_ALTERNATIVES + 1,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.category, "validation");
  assert.match(result.reasons[0], /alternatives cannot exceed/);
});

test("allocates exactly 240 integer minutes within player bounds", () => {
  const players = Array.from({ length: 10 }, (_, index) =>
    player(`p${index + 1}`, { minutes: 15 + index }),
  );
  const scores = Object.fromEntries(players.map((item, index) => [item.id, index + 1]));
  const result = allocateRotationMinutes(players, {
    minMinutes: 18,
    maxMinutes: 30,
    scores,
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalMinutes, 240);
  assert.equal(
    result.allocations.reduce((total, allocation) => total + allocation.minutes, 0),
    240,
  );
  assert.ok(
    result.allocations.every(
      (allocation) =>
        Number.isInteger(allocation.minutes) &&
        allocation.minutes >= 18 &&
        allocation.minutes <= 30,
    ),
  );
});

test("rotation allocation satisfies deterministic bounded feasibility cases", () => {
  let seed = 65537;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };

  for (let scenario = 0; scenario < 250; scenario += 1) {
    const count = 8 + Math.floor(random() * 5);
    const players = [];
    const playerBounds = {};
    const scores = {};
    let minimumTotal = 0;
    let maximumTotal = 0;

    for (let index = 0; index < count; index += 1) {
      const id = `case-${scenario}-p${index}`;
      const minimum = Math.floor(random() * 31);
      const maximum = minimum + Math.floor(random() * (49 - minimum));
      players.push(player(id, { minutes: 10 + random() * 30 }));
      playerBounds[id] = { min: minimum, max: maximum };
      scores[id] = random() * 10;
      minimumTotal += minimum;
      maximumTotal += maximum;
    }

    const result = allocateRotationMinutes(players, { playerBounds, scores });
    const expectedFeasible = minimumTotal <= 240 && maximumTotal >= 240;
    assert.equal(result.ok, expectedFeasible, `scenario ${scenario} feasibility`);
    if (!result.ok) continue;

    assert.equal(result.totalMinutes, 240, `scenario ${scenario} total`);
    assert.ok(
      result.allocations.every(
        (allocation) =>
          Number.isInteger(allocation.minutes) &&
          allocation.minutes >= allocation.minimum &&
          allocation.minutes <= allocation.maximum,
      ),
      `scenario ${scenario} bounds`,
    );
  }
});

test("rotation optimization includes a feasible 240-minute allocation", () => {
  const players = Array.from({ length: 10 }, (_, index) =>
    player(`p${index + 1}`, {
      positions: index < 4 ? ["G"] : index < 8 ? ["F"] : ["C"],
      points: 10 + index,
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    weights: { points: 1 },
    alternatives: 2,
    positionMinimums: { G: 2, F: 2, C: 1 },
    rotationOptions: { minMinutes: 20, maxMinutes: 36 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.best.rotation.totalMinutes, 240);
  assert.equal(result.best.constraintAudit.rotationMinutes.passed, true);
});

test("defers uniform-bound minute allocation until exact-search finalists are known", () => {
  const players = Array.from({ length: 12 }, (_, index) =>
    player(`p${index + 1}`, {
      positions: index % 3 === 0 ? ["G"] : index % 3 === 1 ? ["F"] : ["C"],
      points: 10 + index,
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 3,
    weights: { points: 1 },
    rotationOptions: { minMinutes: 8, maxMinutes: 40 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.combinationsEvaluated, 495);
  assert.equal(result.diagnostics.rotationAllocationStrategy, "deferred-uniform-bounds");
  assert.equal(result.diagnostics.rotationAllocationsComputed, 4);
  assert.equal(result.alternatives.length, 3);
  assert.ok(result.alternatives.every((alternative) => alternative.rotation.totalMinutes === 240));
});

test("defers score-only and empty-bound rotation options until finalists are known", () => {
  const players = Array.from({ length: 12 }, (_, index) =>
    player(`p${index + 1}`, {
      positions: index % 3 === 0 ? ["G"] : index % 3 === 1 ? ["F"] : ["C"],
      points: 10 + index,
    }),
  );
  const baseConfig = {
    mode: "rotation",
    size: 8,
    alternatives: 3,
    weights: { points: 1 },
    rotationOptions: { minMinutes: 8, maxMinutes: 40 },
  };
  const baseline = optimizeLineups(players, baseConfig);
  const scoreOnly = optimizeLineups(players, {
    ...baseConfig,
    rotationOptions: { ...baseConfig.rotationOptions, scores: { p1: 9 } },
  });
  const emptyBounds = optimizeLineups(players, {
    ...baseConfig,
    rotationOptions: { ...baseConfig.rotationOptions, playerBounds: {} },
  });

  for (const result of [scoreOnly, emptyBounds]) {
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.rotationAllocationStrategy, "deferred-uniform-bounds");
    assert.equal(result.diagnostics.rotationAllocationsComputed, 4);
    assert.deepEqual(
      result.alternatives.map((alternative) => alternative.playerIds),
      baseline.alternatives.map((alternative) => alternative.playerIds),
    );
  }
});

test("keeps per-player rotation bounds candidate-specific", () => {
  const players = Array.from({ length: 9 }, (_, index) =>
    player(`p${index + 1}`, {
      points: 10 + index,
      positions: index % 3 === 0 ? ["G"] : index % 3 === 1 ? ["F"] : ["C"],
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 2,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 8,
      maxMinutes: 40,
      playerBounds: { p9: { min: 241, max: 241 } },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.combinationsEvaluated, 9);
  assert.equal(result.diagnostics.rotationAllocationStrategy, "per-candidate");
  assert.equal(result.diagnostics.rotationAllocationsComputed, 9);
  assert.equal(result.diagnostics.rejectedByConstraint.rotationMinutes, 8);
  assert.deepEqual(result.best.playerIds, players.slice(0, 8).map((item) => item.id));
  assert.equal(result.best.rotation.totalMinutes, 240);
});

test("reports every uniform-bound candidate as infeasible without repeated allocation work", () => {
  const result = optimizeLineups(
    Array.from({ length: 9 }, (_, index) => player(`p${index + 1}`)),
    {
      mode: "rotation",
      size: 8,
      alternatives: 2,
      weights: { points: 1 },
      rotationOptions: { minMinutes: 8, maxMinutes: 20 },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.combinationsEvaluated, 9);
  assert.equal(result.diagnostics.rotationAllocationStrategy, "deferred-uniform-bounds");
  assert.equal(result.diagnostics.rotationAllocationsComputed, 1);
  assert.equal(result.diagnostics.rejectedByConstraint.rotationMinutes, 9);
  assert.match(result.reasons.at(-1), /could not be allocated exactly 240 minutes/);
});

test("stops an unsafe exact search before enumerating combinations", () => {
  const result = optimizeLineups(
    Array.from({ length: 25 }, (_, index) => player(`p${index + 1}`, {
      positions: index % 3 === 0 ? ["G"] : index % 3 === 1 ? ["F"] : ["C"],
    })),
    {
      mode: "rotation",
      size: 12,
      weights: { points: 1 },
      positionMinimums: { G: 2, F: 2, C: 1 },
      maxCombinations: 1000,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.category, "performance");
  assert.equal(result.combinationsEvaluated, 0);
  assert.ok(result.diagnostics.estimatedCombinations > result.diagnostics.maxCombinations);
  assert.match(result.reasons[0], /safe limit/);
});
