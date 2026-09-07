import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { loadOptimizerCore } from "./load-optimizer-core.mjs";
import { withSyntheticCounts } from "./synthetic-evidence.mjs";

const optimizer = await loadOptimizerCore();

const {
  allocateRotationMinutes,
  DEFAULT_MAX_CONSTRAINED_SOLVE_STATES,
  MAX_EXACT_ALTERNATIVES,
  optimizeLineups,
} = optimizer;

function player(id, overrides = {}) {
  return withSyntheticCounts({
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
  });
}

/**
 * The fan-facing explanation reads `playerContributions`, so keep this check
 * close to the exact optimizer tests rather than treating the explanation as
 * a presentation-only concern. Contributions are rounded independently for
 * transport/display, hence the small tolerance around the rounded fit score.
 */
function assertPlayerContributionReconciliation(lineup) {
  assert.ok(lineup.playerContributions, "expected player-level objective contributions");
  assert.deepEqual(
    Object.keys(lineup.playerContributions).sort(),
    [...lineup.playerIds].sort(),
    "each selected player should have exactly one contribution record",
  );

  const playerScoreTotal = Object.values(lineup.playerContributions).reduce(
    (total, contribution) => total + contribution.scoreContribution,
    0,
  );
  assert.ok(
    Math.abs(playerScoreTotal - lineup.score) <= 0.00001,
    `player contributions (${playerScoreTotal}) should reconcile to fit score (${lineup.score})`,
  );

  for (const [metric, metricBreakdown] of Object.entries(lineup.contributionBreakdown)) {
    const metricScoreTotal = Object.values(lineup.playerContributions).reduce(
      (total, contribution) => {
        assert.ok(
          contribution.metrics[metric],
          `expected ${metric} evidence for every selected player`,
        );
        return total + contribution.metrics[metric].scoreContribution;
      },
      0,
    );
    assert.ok(
      Math.abs(metricScoreTotal - metricBreakdown.scoreContribution) <= 0.00001,
      `${metric} player evidence (${metricScoreTotal}) should reconcile to its objective component (${metricBreakdown.scoreContribution})`,
    );
  }
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

test("visible role balance respects a points-only objective without adding hidden defense", () => {
  const fixed = [
    player("creator", { assists: 12, turnovers: 2.5, analytics: { advanced: { usage_percentage: 0.3 } } }),
    player("shooter", { threePct: 0.46, efgPct: 0.67 }),
    player("connector", { assists: 8, turnovers: 0.6 }),
    player("stopper", { steals: 3, blocks: 0.8 }),
  ];
  const redundant = player("a-redundant", {
    assists: 11,
    analytics: { advanced: { usage_percentage: 0.29 } },
  });
  const rimHelp = player("z-rim-help", {
    rebounds: 15,
    blocks: 4,
    analytics: { advanced: { defensive_box_plus_minus: 3 } },
  });
  const config = {
    size: 5,
    alternatives: 2,
    lockedIds: fixed.map(({ id }) => id),
    weights: { points: 1 },
  };
  const explanationOnly = optimizeLineups([...fixed, redundant, rimHelp], {
    ...config,
    roleBalance: "off",
  });
  const recommended = optimizeLineups([...fixed, redundant, rimHelp], {
    ...config,
    roleBalance: "recommended",
  });

  assert.equal(explanationOnly.ok, true);
  assert.equal(recommended.ok, true);
  assert.equal(explanationOnly.best.playerIds.includes("a-redundant"), true);
  assert.equal(recommended.best.playerIds.includes("a-redundant"), true);
  assert.equal(recommended.best.modelAdjustments.roleFit.applied, true);
  assert.notEqual(recommended.best.modelAdjustments.totalAdjustmentPoints, 0);
});

test("NBA-baseline index and evidence-adjusted starting-five scores stay anchored to the source", () => {
  const withLeagueEvidence = (id, points) => player(id, {
    minutes: 30,
    points,
    analytics: {
      totals: { minutes: 1800 },
      leaguePer36: { points: 15 },
    },
  });
  const basePlayers = Array.from({ length: 6 }, (_, index) => (
    withLeagueEvidence(`p${index + 1}`, 12 + index)
  ));
  const config = {
    size: 5,
    alternatives: 2,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
  };
  const base = optimizeLineups(basePlayers, config);
  const expandedPool = optimizeLineups([
    withLeagueEvidence("irrelevant", 1),
    ...basePlayers,
  ], config);

  assert.equal(base.ok, true);
  assert.equal(expandedPool.ok, true);
  assert.deepEqual(expandedPool.best.playerIds, base.best.playerIds);
  assert.equal(expandedPool.best.planFitIndex, base.best.planFitIndex);
  assert.equal(expandedPool.best.offenseIndex, base.best.offenseIndex);
  assert.equal(expandedPool.best.score, base.best.score);
  assert.equal(base.best.benchmarkMetricCount, 1);
  assert.equal(base.best.benchmarkMetricIndexes.points > 100, true);
});

test("complete Basketball Reference impact evidence can refine offense and defense priorities", () => {
  const offense = optimizeLineups([
    player("positive-offense", {
      analytics: { totals: { minutes: 1680 }, advanced: { offensive_box_plus_minus: 4 } },
    }),
    player("negative-offense", {
      analytics: { totals: { minutes: 1680 }, advanced: { offensive_box_plus_minus: -4 } },
    }),
  ], {
    size: 1,
    alternatives: 2,
    weights: { offensiveImpact: 1 },
  });
  const defense = optimizeLineups([
    player("positive-defense", {
      analytics: { totals: { minutes: 1680 }, advanced: { defensive_box_plus_minus: 3 } },
    }),
    player("negative-defense", {
      analytics: { totals: { minutes: 1680 }, advanced: { defensive_box_plus_minus: -3 } },
    }),
  ], {
    size: 1,
    alternatives: 2,
    weights: { defensiveImpact: 1 },
  });

  assert.equal(offense.ok, true);
  assert.equal(defense.ok, true);
  assert.equal(offense.best.playerIds[0], "positive-offense");
  assert.equal(defense.best.playerIds[0], "positive-defense");
  assert.equal(offense.best.planFitIndex > 100, true);
  assert.equal(defense.best.planFitIndex > 100, true);
});

test("incomplete impact evidence is disabled for the entire eligible pool", () => {
  const result = optimizeLineups([
    player("high-points", {
      points: 20,
      analytics: { advanced: { offensive_box_plus_minus: -8 } },
    }),
    player("high-obpm", {
      points: 15,
      analytics: { advanced: { offensive_box_plus_minus: 8 } },
    }),
    player("missing-obpm", { points: 5 }),
  ], {
    size: 1,
    alternatives: 3,
    weights: { points: 1, offensiveImpact: 9 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.best.playerIds[0], "high-points");
  assert.equal(result.weights.offensiveImpact, 9);
  assert.equal(result.effectiveWeights.offensiveImpact, 0);
  assert.deepEqual(
    result.diagnostics.objectiveMetricEvidence.disabledRequestedMetrics,
    ["offensiveImpact"],
  );
  assert.equal(result.diagnostics.objectiveMetricEvidence.renormalized, true);
});

test("team-stint games and totals do not change an otherwise identical rotation projection", () => {
  const rotationPlayer = (id, index, games) => player(id, {
    positions: ["G", "F", "C"],
    games,
    starts: 0,
    minutes: 12 + (index * 4),
    points: 8 + (index * 3),
    analytics: {
      totals: { minutes: (12 + (index * 4)) * games },
      leaguePer36: { points: 18 },
    },
  });
  const pool = (changedGames) => Array.from({ length: 9 }, (_, index) => rotationPlayer(
    `rotation-${index + 1}`,
    index,
    index === 0 ? changedGames : 70,
  ));
  const config = {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    minGames: 0,
    minMinutes: 0,
    weights: { points: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      scoringBasis: "per36",
      rateStability: "sampleAdjusted",
      minutePlan: "openWhatIf",
      positionMinuteRequirements: { G: 80, F: 80, C: 80 },
    },
  };
  const fiveGameStint = optimizeLineups(pool(5), config);
  const seventyGameStint = optimizeLineups(pool(70), config);

  assert.equal(fiveGameStint.ok, true);
  assert.equal(seventyGameStint.ok, true);
  assert.deepEqual(fiveGameStint.best.playerIds, seventyGameStint.best.playerIds);
  assert.deepEqual(fiveGameStint.best.rotation.byId, seventyGameStint.best.rotation.byId);
  assert.equal(fiveGameStint.best.score, seventyGameStint.best.score);
  assert.equal(
    fiveGameStint.diagnostics.objectiveMetricEvidence.teamStintLengthAffectsProjection,
    false,
  );
  assert.equal(
    fiveGameStint.diagnostics.rotationRateStabilityEvidence.teamStintLengthAffectsProjection,
    false,
  );
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

test("preserves equal-player lineup scoring and per-game totals regardless of source minutes", () => {
  const result = optimizeLineups(
    [
      player("low-minutes", { minutes: 5, points: 10 }),
      player("high-minutes", { minutes: 40, points: 20 }),
    ],
    { mode: "lineup", size: 2, weights: { points: 1 }, alternatives: 1 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.best.totals.points, 30);
  assert.equal(result.best.score, 50);
  assert.equal(result.best.rotation, undefined);
  assert.equal(result.best.contributionBreakdown.points.minuteWeightedPercentile, undefined);
});

test("emits additive player evidence that reconciles to every exact lineup objective component", () => {
  const result = optimizeLineups(
    [
      player("scorer", { points: 28, rebounds: 4, turnovers: 4 }),
      player("rebounder", { points: 18, rebounds: 13, turnovers: 1 }),
      player("connector", { points: 20, rebounds: 8, turnovers: 2 }),
      player("reserve", { points: 12, rebounds: 6, turnovers: 3 }),
    ],
    {
      mode: "lineup",
      size: 3,
      weights: { points: 5, rebounds: 3, ballSecurity: 2 },
      alternatives: 1,
    },
  );

  assert.equal(result.ok, true);
  assertPlayerContributionReconciliation(result.best);
  assert.ok(
    result.best.playerContributions.scorer.metrics.points.scoreContribution > 0,
    "the top scoring profile should retain positive point-fit evidence",
  );
  assert.ok(
    result.best.playerContributions.rebounder.metrics.rebounds.scoreContribution > 0,
    "the top rebounding profile should retain positive rebound-fit evidence",
  );
});

test("uses per-36 rotation scoring so a superior rate earns more proposed minutes than a larger raw per-game total", () => {
  // `rate-star` has the smaller historical per-game scoring average (10 vs.
  // 20), but produced it in one quarter of the court time. The old raw
  // per-game comparison would reward `volume-veteran` merely for having been
  // on the floor 40 minutes. Six middling players make the minute tradeoff
  // visible: a five-player 48-minute core can leave one profile at zero.
  const players = [
    player("rate-star", {
      positions: ["G", "F", "C"],
      minutes: 10,
      points: 10,
    }),
    player("volume-veteran", {
      positions: ["G", "F", "C"],
      minutes: 40,
      points: 20,
    }),
    ...Array.from({ length: 6 }, (_, index) =>
      player(`support-${index + 1}`, {
        positions: ["G", "F", "C"],
        minutes: 21,
        points: 14,
      }),
    ),
  ];
  const baseConfig = {
    mode: "rotation",
    size: 8,
    weights: { points: 1 },
    alternatives: 1,
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  };

  const rateBased = optimizeLineups(players, baseConfig);
  const legacyPerGame = optimizeLineups(players, {
    ...baseConfig,
    rotationOptions: {
      ...baseConfig.rotationOptions,
      scoringBasis: "perGame",
    },
  });

  assert.equal(rateBased.ok, true);
  assert.equal(rateBased.diagnostics.rotationScoringBasis, "per36");
  assert.equal(rateBased.best.rotation.byId["rate-star"], 48);
  assert.equal(rateBased.best.rotation.byId["volume-veteran"], 0);
  assert.equal(rateBased.best.unitPlan.ok, true, rateBased.best.unitPlan.reason);
  assert.equal(rateBased.best.unitPlan.frames.length, 48);
  assert.ok(rateBased.best.unitPlan.frames.every((frame) => (
    frame.playerIds.length === 5 && new Set(frame.playerIds).size === 5
  )));
  // The displayed projection remains a real 240-minute box-score estimate:
  // 48 + four * (14 / 21 * 48) = 176 points. Per-36 drives the ranking only.
  assert.equal(rateBased.best.totals.points, 176);
  assertPlayerContributionReconciliation(rateBased.best);
  assert.ok(
    rateBased.best.playerContributions["rate-star"].scoreContribution > 0,
    "the superior per-36 scorer should receive fit credit for its allocated minutes",
  );
  assert.equal(
    rateBased.best.playerContributions["volume-veteran"].scoreContribution,
    0,
    "a selected roster member with zero proposed minutes should add no rotation fit credit",
  );

  assert.equal(legacyPerGame.ok, true);
  assert.equal(legacyPerGame.diagnostics.rotationScoringBasis, "perGame");
  assert.equal(legacyPerGame.best.rotation.byId["volume-veteran"], 48);
  assert.equal(legacyPerGame.best.rotation.byId["rate-star"], 0);
  assert.equal(legacyPerGame.best.unitPlan.ok, true, legacyPerGame.best.unitPlan.reason);
  assertPlayerContributionReconciliation(legacyPerGame.best);
  assert.ok(
    legacyPerGame.best.playerContributions["volume-veteran"].scoreContribution > 0,
    "the explicit legacy basis should still attribute fit only to its allocated scorer",
  );
  assert.equal(legacyPerGame.best.playerContributions["rate-star"].scoreContribution, 0);
});

test("rejects an unsupported rotation scoring basis instead of silently changing the model", () => {
  const result = optimizeLineups(
    Array.from({ length: 8 }, (_, index) =>
      player(`p${index + 1}`, { positions: ["G", "F", "C"] }),
    ),
    {
      mode: "rotation",
      size: 8,
      weights: { points: 1 },
      rotationOptions: { scoringBasis: "per100" },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.category, "validation");
  assert.match(result.reasons[0], /rotationOptions\.scoringBasis/);
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

test("rotation exact search ignores legacy candidate-count ceilings", () => {
  const players = Array.from({ length: 9 }, (_, index) =>
    player(`p${index + 1}`, { positions: ["G", "F", "C"] }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    weights: { points: 1 },
    positionMinimums: { G: 2, F: 2, C: 1 },
    // This retired compatibility option is deliberately ignored in rotation
    // mode. The nine candidate groups must all be evaluated exactly.
    maxCombinations: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.estimatedCombinations, 9);
  assert.equal(result.diagnostics.maxCombinations, null);
  assert.equal(result.diagnostics.candidateCombinationLimitApplied, false);
  assert.equal(result.combinationsEvaluated, 9);
  assert.ok(result.alternatives.every((alternative) => alternative.unitPlan?.ok === true));
});

test("rotation progress is observational and preserves the exact result", () => {
  const players = Array.from({ length: 12 }, (_, index) =>
    player(`p${index + 1}`, {
      positions: ["G", "F", "C"],
      points: 10 + index,
    }),
  );
  const config = {
    mode: "rotation",
    size: 8,
    alternatives: 2,
    weights: { points: 1 },
    rotationOptions: { minMinutes: 8, maxMinutes: 40 },
  };
  const baseline = optimizeLineups(players, config);
  const progress = [];
  const observed = optimizeLineups(players, config, {
    onProgress(update) {
      progress.push(update);
    },
  });

  assert.deepEqual(observed, baseline);
  assert.ok(progress.length >= 2, "the rotation search should report its start and completion");
  assert.equal(progress[0].phase, "enumerating");
  assert.equal(progress[0].estimatedCombinations, 495);
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(progress.at(-1).combinationsEvaluated, observed.combinationsEvaluated);
  assert.equal(progress.at(-1).feasibleCombinations, observed.diagnostics.feasibleCombinations);

  const callbackFailureStillExact = optimizeLineups(players, config, {
    onProgress() {
      throw new Error("display-only callback failure");
    },
  });
  assert.deepEqual(callbackFailureStillExact, baseline);
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
  assert.equal(result.best.rotation.strategy, "objective-role-conditioned");
  assert.equal(result.best.rotation.diagnostics.roleConditionedScoring.applied, true);
  assert.deepEqual(result.best.rotation.positionMinutes.actual, { G: 96, F: 96, C: 48 });
  assert.equal(result.best.rotation.positionMinutes.passed, true);
  assert.equal(result.best.constraintAudit.rotationPositionMinutes.passed, true);
  for (const allocation of result.best.rotation.allocations) {
    assert.equal(
      Object.values(allocation.roleMinutes).reduce((total, minutes) => total + minutes, 0),
      allocation.minutes,
    );
  }
  assert.equal(result.best.constraintAudit.rotationMinutes.passed, true);
});

test("uses an F-C flex player to cover center minutes even when the roster center minimum is zero", () => {
  const players = [
    ...Array.from({ length: 3 }, (_, index) => player(`g${index + 1}`, { positions: ["G"] })),
    ...Array.from({ length: 4 }, (_, index) => player(`f${index + 1}`, { positions: ["F"] })),
    player("frontcourt-flex", { positions: ["F", "C"], points: 18 }),
  ];
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    weights: { points: 1 },
    alternatives: 1,
    positionMinimums: { G: 2, F: 2, C: 0 },
    rotationOptions: { minMinutes: 8, maxMinutes: 48 },
  });

  assert.equal(result.ok, true);
  const split = result.best.rotation.positionMinutes.byPlayer;
  assert.equal(split["frontcourt-flex"].C, 48);
  assert.equal(split["frontcourt-flex"].F, 0);
  assert.equal(split["frontcourt-flex"].G, 0);
  assert.deepEqual(result.best.rotation.positionMinutes.actual, { G: 96, F: 96, C: 48 });
});

test("rejects a rotation when one capped center cannot cover all 48 center minutes", () => {
  const players = [
    ...Array.from({ length: 3 }, (_, index) => player(`g${index + 1}`, { positions: ["G"] })),
    ...Array.from({ length: 4 }, (_, index) => player(`f${index + 1}`, { positions: ["F"] })),
    player("only-center", { positions: ["C"] }),
  ];
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    weights: { points: 1 },
    alternatives: 1,
    positionMinimums: { G: 2, F: 2, C: 1 },
    rotationOptions: { minMinutes: 8, maxMinutes: 40 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.rejectedByConstraint.rotationPositionMinutes, 1);
  assert.match(result.reasons.at(-1), /48 center minutes/);
});

test("projects rotation totals from assigned minutes and applies thresholds to that projection", () => {
  const minutePlan = [40, 32, 32, 32, 28, 28, 24, 24];
  const pointProfiles = [20, 16, 12, 10, 8, 6, 4, 2];
  const players = minutePlan.map((minutes, index) =>
    player(`p${index + 1}`, {
      positions: ["G", "F", "C"],
      minutes: 20,
      points: pointProfiles[index],
    }),
  );
  const playerBounds = Object.fromEntries(
    players.map((item, index) => [item.id, { min: minutePlan[index], max: minutePlan[index] }]),
  );
  const baseConfig = {
    mode: "rotation",
    size: 8,
    weights: { points: 1 },
    alternatives: 1,
    rotationOptions: { playerBounds },
  };
  const feasible = optimizeLineups(players, {
    ...baseConfig,
    statMinimums: { points: 127.5 },
  });
  const infeasible = optimizeLineups(players, {
    ...baseConfig,
    statMinimums: { points: 127.7 },
  });

  assert.equal(feasible.ok, true);
  assert.ok(Math.abs(feasible.best.totals.points - 127.6) < 1e-12);
  assert.ok(Math.abs(feasible.best.rotation.projectedTotals.points - 127.6) < 1e-12);
  assert.ok(Math.abs(feasible.best.constraintAudit.statMinimums.checks.points.actual - 127.6) < 1e-12);
  assert.equal(infeasible.ok, false);
  assert.equal(infeasible.diagnostics.rejectedByConstraint.statMinimums.points, 1);
  assert.equal(infeasible.diagnostics.rejectedByConstraint.rotationMinutes, 0);
  assert.ok(!infeasible.reasons.some((reason) => reason.includes("allocated exactly 240")));
});

test("shifts exactly one minute to satisfy the reviewer rebound threshold repro", () => {
  const scorers = [30, 29, 28, 27, 26].map((points, index) =>
    player(String.fromCharCode(97 + index), {
      positions: ["G", "F", "C"],
      minutes: 48,
      points,
      rebounds: 0,
    }),
  );
  const rebounders = ["f", "g", "h"].map((id) =>
    player(id, {
      positions: ["G", "F", "C"],
      minutes: 48,
      points: 0,
      rebounds: 48,
    }),
  );
  const result = optimizeLineups([...scorers, ...rebounders], {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    statMinimums: { rebounds: 1 },
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.best.rotation.strategy, "objective-constrained");
  assert.equal(result.best.totals.rebounds, 1);
  assert.equal(
    ["f", "g", "h"].reduce(
      (total, id) => total + result.best.rotation.byId[id],
      0,
    ),
    1,
  );
  assert.equal(
    ["a", "b", "c", "d", "e"].reduce(
      (total, id) => total + result.best.rotation.byId[id],
      0,
    ),
    239,
  );
  assert.deepEqual(result.best.rotation.positionMinutes.actual, { G: 96, F: 96, C: 48 });
  assert.equal(result.best.constraintAudit.statMinimums.checks.rebounds.passed, true);
  assert.equal(result.best.rotation.diagnostics.projectedConstraints.adjustedAllocation, true);
});

test("equal-fit raw players satisfy a rebound threshold without an imposed equal-minute target", () => {
  const players = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, index) =>
    player(id, {
      positions: ["G", "F", "C"],
      minutes: 48,
      points: 10,
      rebounds: index < 5 ? 0 : 48,
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    statMinimums: { rebounds: 1 },
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });

  assert.equal(result.ok, true);
  // Every rate is equal, so any feasible minute plan attains the same score.
  // The hard floor must hold, but equal minutes are not a model requirement.
  assert.ok(result.best.totals.rebounds >= 1);
  assert.equal(result.best.score, 50);
  assert.equal(
    ["f", "g", "h"].reduce(
      (total, id) => total + result.best.rotation.byId[id],
      0,
    ),
    result.best.totals.rebounds,
  );
  assert.equal(Object.values(result.best.rotation.byId).reduce((a, b) => a + b, 0), 240);
  assert.equal(result.best.constraintAudit.statMinimums.checks.rebounds.passed, true);
});

test("shifts one minute to satisfy a projected turnover ceiling before ranking", () => {
  const highTurnoverScorers = [30, 29, 28, 27, 26].map((points, index) =>
    player(String.fromCharCode(97 + index), {
      positions: ["G", "F", "C"],
      minutes: 48,
      points,
      turnovers: 48,
    }),
  );
  const carefulBench = ["f", "g", "h"].map((id) =>
    player(id, {
      positions: ["G", "F", "C"],
      minutes: 48,
      points: 0,
      turnovers: 0,
    }),
  );
  const result = optimizeLineups([...highTurnoverScorers, ...carefulBench], {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    maxTurnovers: 239,
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.best.totals.turnovers, 239);
  assert.equal(
    ["f", "g", "h"].reduce(
      (total, id) => total + result.best.rotation.byId[id],
      0,
    ),
    1,
  );
  assert.equal(result.best.constraintAudit.maxTurnovers.passed, true);
  assert.deepEqual(result.best.rotation.positionMinutes.actual, { G: 96, F: 96, C: 48 });
});

test("ranks rotations by minute-weighted pool-relative fit instead of equal roster averages", () => {
  const common = Array.from({ length: 7 }, (_, index) =>
    player(`common-${index + 1}`, { positions: ["G", "F", "C"], points: 0 }),
  );
  const highProfileLowMinutes = player("high-eight", {
    positions: ["G", "F", "C"],
    points: 100,
  });
  const strongProfileMajorMinutes = player("strong-forty", {
    positions: ["G", "F", "C"],
    points: 60,
  });
  const result = optimizeLineups(
    [...common, highProfileLowMinutes, strongProfileMajorMinutes],
    {
      mode: "rotation",
      size: 8,
      lockedIds: common.map((item) => item.id),
      weights: { points: 1 },
      alternatives: 2,
      rotationOptions: {
        minMinutes: 0,
        maxMinutes: 40,
        playerBounds: {
          "high-eight": { min: 8, max: 8 },
          "strong-forty": { min: 40, max: 40 },
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.ok(result.best.playerIds.includes("strong-forty"));
  assert.ok(!result.best.playerIds.includes("high-eight"));
  assert.ok(result.alternatives[0].score > result.alternatives[1].score);
  assert.equal(
    result.best.contributionBreakdown.points.minuteWeightedPercentile,
    result.best.contributionBreakdown.points.averagePercentile,
  );
});

test("labels the standalone proportional allocator as balanced rather than optimal", () => {
  const players = Array.from({ length: 8 }, (_, index) => player(`p${index + 1}`));
  const result = allocateRotationMinutes(players, {
    minMinutes: 20,
    maxMinutes: 40,
    scores: Object.fromEntries(players.map((item, index) => [item.id, index + 1])),
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, "balanced-proportional");
  assert.equal(result.diagnostics.allocationStrategy, "balanced");
});

test("rejects physical per-player minute bounds above 48 with structured validation", () => {
  const players = Array.from({ length: 8 }, (_, index) =>
    player(`p${index + 1}`, { positions: ["G", "F", "C"] }),
  );
  const excessiveMaximum = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 49,
  });
  const excessiveMinimum = allocateRotationMinutes(players, {
    minMinutes: 49,
    maxMinutes: 49,
  });

  for (const result of [excessiveMaximum, excessiveMinimum]) {
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.category, "validation");
    assert.ok(result.reasons.some((reason) => reason.includes("cannot exceed 48")));
    assert.deepEqual(result.allocations, []);
  }
});

test("rejects standalone projected constraints without a court-role model", () => {
  const players = Array.from({ length: 8 }, (_, index) =>
    player(`p${index + 1}`, { positions: ["G", "F", "C"] }),
  );
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    projectedStatMinimums: { rebounds: 1 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.category, "validation");
  assert.match(result.reason, /require positionMinuteRequirements/);
  assert.deepEqual(result.allocations, []);
});

test("validates every standalone source rate referenced by projected constraints", () => {
  const incompletePlayers = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index + 1}`,
    positions: ["G", "F", "C"],
    minutes: 30,
  }));
  const missingRebounds = allocateRotationMinutes(incompletePlayers, {
    minMinutes: 30,
    maxMinutes: 30,
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
    projectedStatMinimums: { rebounds: 999 },
  });
  const missingTurnovers = allocateRotationMinutes(incompletePlayers, {
    minMinutes: 30,
    maxMinutes: 30,
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
    projectedMaxTurnovers: 1,
  });
  const zeroSourceMinutes = allocateRotationMinutes(
    incompletePlayers.map((item) => ({ ...item, minutes: 0, rebounds: 1 })),
    {
      minMinutes: 30,
      maxMinutes: 30,
      positionMinuteRequirements: { G: 96, F: 96, C: 48 },
      projectedStatMinimums: { rebounds: 1 },
    },
  );

  for (const result of [missingRebounds, missingTurnovers, zeroSourceMinutes]) {
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.category, "validation");
    assert.deepEqual(result.allocations, []);
  }
  assert.ok(missingRebounds.reasons.some((reason) => reason.includes("rebounds")));
  assert.ok(missingTurnovers.reasons.some((reason) => reason.includes("turnovers")));
  assert.ok(zeroSourceMinutes.reasons.some((reason) => reason.includes("greater than zero")));
});

test("canonicalizes numeric standalone player ids through bounds and role flow", () => {
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    positions: ["G", "F", "C"],
    minutes: 30,
  }));
  const result = allocateRotationMinutes(players, {
    minMinutes: 30,
    maxMinutes: 30,
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalMinutes, 240);
  assert.deepEqual(Object.keys(result.byId), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.deepEqual(result.positionMinutes.actual, { G: 96, F: 96, C: 48 });
});

test("resolves numeric Map keys for standalone objective scores", () => {
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    positions: ["G", "F", "C"],
    minutes: 30,
  }));
  const scores = new Map(players.map(({ id }) => [id, id === 8 ? 100 : 0]));
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    scores,
    strategy: "objective",
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.byId["8"], 48);
  assert.equal(result.allocations.find(({ id }) => id === "8").minutes, 48);
});

test("resolves numeric Map keys for standalone minimum and maximum bounds", () => {
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    positions: ["G", "F", "C"],
    minutes: 30,
  }));
  const minMinutes = new Map(players.map(({ id }) => [id, id === 1 ? 48 : 0]));
  const maxMinutes = new Map(players.map(({ id }) => [id, id === 8 ? 0 : 48]));
  const result = allocateRotationMinutes(players, {
    minMinutes,
    maxMinutes,
    strategy: "objective",
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.byId["1"], 48);
  assert.equal(result.byId["8"], 0);
  assert.deepEqual(
    result.allocations
      .filter(({ id }) => id === "1" || id === "8")
      .map(({ id, minimum, maximum }) => ({ id, minimum, maximum })),
    [
      { id: "1", minimum: 48, maximum: 48 },
      { id: "8", minimum: 0, maximum: 0 },
    ],
  );
});

test("rejects ambiguous canonical Map keys instead of choosing one silently", () => {
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    positions: ["G", "F", "C"],
    minutes: 30,
  }));
  const result = allocateRotationMinutes(players, {
    minMinutes: 0,
    maxMinutes: 48,
    scores: new Map([
      [1, 100],
      ["1", 0],
    ]),
    strategy: "objective",
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.category, "validation");
  assert.ok(result.reasons.some((reason) => reason.includes('player id "1"')));
  assert.deepEqual(result.allocations, []);
});

test("preserves custom numeric Map allocation scores while bounding constrained rankings", () => {
  const players = Array.from({ length: 8 }, (_, index) =>
    player(index + 1, {
      positions: ["G", "F", "C"],
      minutes: 48,
      points: 100 - index * 10,
      rebounds: 48,
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    statMinimums: { rebounds: 1 },
    rotationOptions: {
      minMinutes: 0,
      maxMinutes: 48,
      scores: new Map(players.map(({ id }) => [id, id === 8 ? 100 : 0])),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.best.rotation.byId["8"], 48);
  assert.equal(result.diagnostics.rotationBaselineAllocationsComputed, 1);
  assert.equal(result.diagnostics.rotationRankingBoundAllocationsComputed, 1);
  assert.equal(result.diagnostics.rotationConstrainedAllocationsComputed, 0);
  assert.equal(result.diagnostics.exactTopKProven, true);
});

test("reports impossible projected turnover ceilings as turnover failures, not minute failures", () => {
  const players = Array.from({ length: 8 }, (_, index) =>
    player(`p${index + 1}`, {
      positions: ["G", "F", "C"],
      minutes: 48,
      turnovers: 48,
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    maxTurnovers: 239,
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.rejectedByConstraint.maxTurnovers, 1);
  assert.equal(result.diagnostics.rejectedByConstraint.rotationMinutes, 0);
  assert.match(result.reasons.at(-1), /turnover maximum/);
  assert.ok(!result.reasons.some((reason) => reason.includes("allocated exactly 240")));
});

test("returns structured infeasibility when standalone role positions are missing", () => {
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    minutes: 24,
  }));
  const result = allocateRotationMinutes(players, {
    minMinutes: 8,
    maxMinutes: 40,
    positionMinuteRequirements: { G: 96, F: 96, C: 48 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.category, "position-minutes");
  assert.match(result.reason, /cannot cover 96 guard/);
});

test("allocates every rotation candidate before minute-weighted ranking", () => {
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
  assert.equal(result.diagnostics.rotationAllocationStrategy, "per-candidate-minute-weighted");
  assert.equal(result.diagnostics.rotationAllocationsComputed, 495);
  assert.equal(result.alternatives.length, 3);
  assert.ok(result.alternatives.every((alternative) => alternative.rotation.totalMinutes === 240));
});

test("accepts score-only and empty-bound rotation options on the per-candidate path", () => {
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
    assert.equal(result.diagnostics.rotationAllocationStrategy, "per-candidate-minute-weighted");
    assert.equal(result.diagnostics.rotationAllocationsComputed, 495);
    assert.equal(result.alternatives.length, baseline.alternatives.length);
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
  assert.equal(result.diagnostics.rotationAllocationStrategy, "per-candidate-minute-weighted");
  assert.equal(result.diagnostics.rotationAllocationsComputed, 9);
  assert.equal(result.diagnostics.rejectedByConstraint.rotationMinutes, 8);
  assert.deepEqual(result.best.playerIds, players.slice(0, 8).map((item) => item.id));
  assert.equal(result.best.rotation.totalMinutes, 240);
});

test("reports every candidate as infeasible when its minute capacity is below 240", () => {
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
  assert.equal(result.diagnostics.rotationAllocationStrategy, "per-candidate-minute-weighted");
  assert.equal(result.diagnostics.rotationAllocationsComputed, 9);
  assert.equal(result.diagnostics.rejectedByConstraint.rotationMinutes, 9);
  assert.match(result.reasons.at(-1), /could not be allocated exactly 240 minutes/);
});

test("checks more than the former rotation ceiling without downgrading the minute model", {
  timeout: 30000,
}, () => {
  const players = Array.from({ length: 16 }, (_, index) =>
    player(`p${String(index + 1).padStart(2, "0")}`, {
      positions: ["G", "F", "C"],
      minutes: 48,
      points: 10,
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    statMinimums: { points: 0 },
    // The legacy limit is intentionally ignored for rotation mode. This also
    // exceeds the retired 6,500-group rich-model cutoff, proving that candidate
    // count cannot switch the solver back to the boundary-heavy linear model.
    maxCombinations: 1,
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.combinationsEvaluated, 12870);
  assert.equal(result.diagnostics.maxCombinations, null);
  assert.equal(result.diagnostics.candidateCombinationLimitApplied, false);
  assert.equal(
    result.diagnostics.rotationRateStabilityEvidence.assignedRoleProjection.enabledForExactSearch,
    true,
  );
  assert.equal(result.best.rotation.diagnostics.roleConditionedScoring.applied, true);
  assert.equal(result.diagnostics.constraintSearchStatesUsed, 0);
  assert.equal(result.diagnostics.rejectedByConstraint.constraintSearchLimit, 0);
});

test("caps a high-upper-bound reviewer repro without returning an unproven result", {
  timeout: 20000,
}, () => {
  const players = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id, index) =>
    player(id, {
      positions: ["G", "F", "C"],
      minutes: 48,
      points: 10,
      rebounds: index <= 5 ? 48 : 0,
      assists: index >= 3 ? 48 : 0,
    }),
  );
  const started = performance.now();
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    statMinimums: { rebounds: 200, assists: 200 },
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });
  const elapsedMs = performance.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.best, null);
  assert.equal(result.diagnostics.category, "performance");
  assert.equal(result.diagnostics.subcategory, "constraint-search-limit");
  assert.equal(result.diagnostics.exactSearchCompleted, false);
  assert.ok(
    result.diagnostics.constraintSearchStatesUsed <= DEFAULT_MAX_CONSTRAINED_SOLVE_STATES,
  );
  assert.equal(
    result.diagnostics.constraintSearchStateLimit,
    5000,
  );
  assert.equal(result.combinationsEvaluated, 9);
  assert.equal(result.diagnostics.rotationBaselineAllocationsComputed, 9);
  assert.equal(result.diagnostics.rotationConstrainedAllocationsComputed, 1);
  assert.equal(result.diagnostics.constraintBoundPruned, 0);
  assert.equal(result.diagnostics.exactTopKProven, false);
  assert.ok(elapsedMs < 25000, `expected safe abort below 25s, received ${elapsedMs}ms`);
});

test("prunes a low-upper-bound hard roster after proving an exact top result", () => {
  const players = [
    ...["a", "b", "c", "d"].map((id) =>
      player(id, { positions: ["G", "F", "C"], minutes: 48, points: 90, rebounds: 0 }),
    ),
    ...["e", "f", "g"].map((id) =>
      player(id, { positions: ["G", "F", "C"], minutes: 48, points: 0, rebounds: 48 }),
    ),
    player("h", { positions: ["G", "F", "C"], minutes: 48, points: 100, rebounds: 48 }),
    player("i", { positions: ["G", "F", "C"], minutes: 48, points: 100, rebounds: 0 }),
  ];
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    statMinimums: { rebounds: 3 },
    maxConstraintSearchStates: 2,
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.best.playerIds, ["a", "b", "c", "d", "e", "f", "h", "i"]);
  assert.equal(result.diagnostics.constrainedRotationSearchStrategy, "two-pass-exact-upper-bound");
  assert.equal(result.diagnostics.baselineConstraintFeasible, 8);
  assert.equal(result.diagnostics.unresolvedConstraintCandidates, 1);
  assert.equal(result.diagnostics.constrainedCandidatesSearched, 0);
  assert.equal(result.diagnostics.constraintBoundPruned, 1);
  assert.equal(result.diagnostics.constraintUnclassified, 1);
  assert.equal(result.diagnostics.constraintSearchStatesUsed, 0);
  assert.equal(result.diagnostics.constraintSearchStateLimit, 2);
  assert.equal(result.diagnostics.feasibleCombinationCountComplete, false);
  assert.equal(result.diagnostics.exactTopKProven, true);
});

test("certifies a high-upper-bound constrained roster without spending its state budget", () => {
  const players = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id, index) =>
    player(id, {
      positions: ["G", "F", "C"],
      minutes: 48,
      // Five high-fit scorers can consume all 240 minutes. Candidate groups
      // missing one scorer are baseline-feasible because the bench must play.
      // The group containing all five needs a three-minute constraint repair,
      // which exceeds the two-state enumeration budget but has a closed
      // Lagrangian upper bound and should therefore still be proven exactly.
      points: index < 5 ? 10 : 0,
      rebounds: index >= 5 ? 48 : 0,
    }),
  );
  const result = optimizeLineups(players, {
    mode: "rotation",
    size: 8,
    alternatives: 1,
    weights: { points: 1 },
    statMinimums: { rebounds: 3 },
    maxConstraintSearchStates: 2,
    rotationOptions: { minMinutes: 0, maxMinutes: 48 },
  });

  assert.equal(result.ok, true);
  assert.ok(result.best);
  assert.equal(result.best.totals.rebounds, 3);
  assert.equal(
    result.best.rotation.diagnostics.projectedConstraints.lagrangianCertificateApplied,
    true,
  );
  assert.equal(
    result.best.rotation.diagnostics.projectedConstraints.lagrangianCertificateRule,
    "minimum-rebounds",
  );
  assert.ok(result.diagnostics.constrainedCandidatesSearched > 0);
  assert.equal(result.diagnostics.constraintBoundPruned, 0);
  assert.equal(result.diagnostics.constraintSearchStatesUsed, 0);
  assert.equal(result.diagnostics.constraintSearchStateLimit, 2);
  assert.equal(result.diagnostics.exactTopKProven, true);
  assert.equal(result.diagnostics.exactAlternativeRankingCompleted, true);
});

test("keeps the separate candidate-count safeguard for five-player lineup mode", () => {
  const result = optimizeLineups(
    Array.from({ length: 12 }, (_, index) => player(`p${index + 1}`, {
      positions: index % 3 === 0 ? ["G"] : index % 3 === 1 ? ["F"] : ["C"],
    })),
    {
      mode: "lineup",
      size: 5,
      weights: { points: 1 },
      positionMinimums: { G: 2, F: 2, C: 1 },
      maxCombinations: 100,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.category, "performance");
  assert.equal(result.combinationsEvaluated, 0);
  assert.equal(result.diagnostics.candidateCombinationLimitApplied, true);
  assert.ok(result.diagnostics.estimatedCombinations > result.diagnostics.maxCombinations);
  assert.match(result.reasons[0], /safe limit/);
});
