import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRoleCoverage,
  buildEraBaseline,
  calculateEraRelativeView,
  classifyPlayerSeasonRolePool,
  derivePlayerRateViews,
  explainOptimizationSelection,
  percentileRanks,
  summarizeReplacementAlternatives,
} from "../fan-analytics.js";

/** Create the canonical per-game player shape used by the optimizer. */
function player(id, overrides = {}) {
  return {
    id,
    name: `Player ${id}`,
    team: "TST",
    positions: ["G"],
    games: 70,
    starts: 50,
    minutes: 30,
    fgPct: 0.48,
    threePct: 0.35,
    efgPct: 0.54,
    ftPct: 0.8,
    points: 15,
    rebounds: 4,
    assists: 4,
    steals: 1,
    blocks: 0.5,
    turnovers: 2,
    ...overrides,
  };
}

test("derives exact per-game and per-36 rates while withholding per-100 without a denominator", () => {
  const rates = derivePlayerRateViews(player("rate", {
    minutes: 30,
    points: 18,
    rebounds: 6,
    assists: 5,
  }));

  assert.equal(rates.perGame.values.points, 18);
  assert.equal(rates.per36.values.points, 21.6);
  assert.equal(rates.per36.values.rebounds, 7.2);
  assert.equal(rates.per36.values.efgPct, 0.54);
  assert.equal(rates.per100.available, false);
  assert.match(rates.caveats.join(" "), /Per-100 rates are hidden/i);
  assert.equal(rates.sample.totalMinutes, 2100);
});

test("uses reported player possessions for per-100 rates and preserves shooting percentages", () => {
  const rates = derivePlayerRateViews(player("possessions", { points: 18, assists: 6 }), {
    possessionContext: { playerPossessionsPerGame: 60 },
  });

  assert.equal(rates.per100.available, true);
  assert.equal(rates.per100.estimated, false);
  assert.equal(rates.per100.basis, "reported-player-possessions-per-game");
  assert.equal(rates.per100.values.points, 30);
  assert.equal(rates.per100.values.assists, 10);
  assert.equal(rates.per100.values.threePct, 0.35);
});

test("reads the planned analytics envelope and labels minute-share possession estimates honestly", () => {
  const analyticsPlayer = player("envelope", {
    games: 50,
    minutes: 24,
    points: 12,
    analytics: {
      totals: {
        minutes: 1200,
        threePointFieldGoalsAttempted: 250,
      },
      advanced: {
        usage_percentage: 0.24,
        assist_percentage: 0.3,
      },
      teamTotalMinutes: 12000,
      estimatedTeamPossessions: 5000,
      leaguePer36: {
        points: 14,
        rebounds: 5,
        assists: 3,
        steals: 1,
        blocks: 0.5,
        turnovers: 2,
        efgPct: 0.52,
        threePct: 0.35,
      },
      postseasonAvailable: true,
      source: { season: "2024-25", team: "TST", phase: "regular" },
    },
  });
  const rates = derivePlayerRateViews(analyticsPlayer);

  // Team minutes contain five player slots. 5,000 possessions * 1,200 player
  // minutes / (12,000 aggregate minutes / 5) = 2,500 estimated on-court
  // possessions, or 50 per game. 12 PPG becomes 24 per 100.
  assert.equal(rates.per100.values.points, 24);
  assert.equal(rates.per100.estimated, true);
  assert.equal(rates.per100.basis, "estimated-minute-share-of-team-season-possessions");
  assert.equal(rates.eraRelative.available, true);
  assert.equal(rates.eraRelative.view, "per36");
  assert.equal(rates.eraRelative.values.points.value, 18);
  assert.equal(rates.eraRelative.values.points.baseline, 14);
  assert.equal(rates.dataContext.postseasonAvailable, true);
  assert.equal(rates.dataContext.source.season, "2024-25");
});

test("builds a labeled cohort baseline and returns direction-adjusted turnover context", () => {
  const cohort = [
    player("a", { points: 10, turnovers: 3 }),
    player("b", { points: 20, turnovers: 2 }),
    player("c", { points: 30, turnovers: 1 }),
  ];
  const baseline = buildEraBaseline(cohort, {
    view: "perGame",
    metrics: ["points", "turnovers"],
    label: "Test cohort",
    minObservations: 3,
    scope: "unit-test cohort",
  });
  const rates = derivePlayerRateViews(cohort[2]);
  const relative = calculateEraRelativeView(rates, baseline, { view: "perGame" });

  assert.equal(baseline.metrics.points.mean, 20);
  assert.equal(relative.available, true);
  assert.equal(relative.values.points.difference, 10);
  assert.ok(relative.values.turnovers.zScore < 0);
  assert.ok(relative.values.turnovers.directionAdjustedZScore > 0);
  assert.equal(relative.isLeagueWide, false);
  assert.match(relative.caveats.join(" "), /not automatically a league-wide/i);
});

test("uses optimizer-compatible tied percentile ranks and reverses ball-security direction", () => {
  const players = [
    player("a", { points: 10, turnovers: 3 }),
    player("b", { points: 10, turnovers: 2 }),
    player("c", { points: 20, turnovers: 1 }),
  ];
  const pointRanks = percentileRanks(players, "points");
  const turnoverRanks = percentileRanks(players, "turnovers", { lowerIsBetter: true });

  assert.equal(pointRanks.get("a"), 0.25);
  assert.equal(pointRanks.get("b"), 0.25);
  assert.equal(pointRanks.get("c"), 1);
  assert.equal(turnoverRanks.get("c"), 1);
  assert.equal(turnoverRanks.get("a"), 0);
});

test("classifies understandable roles only from supported signals and surfaces missing shooting-volume evidence", () => {
  const roster = [
    player("creator", {
      positions: ["G"], points: 23, assists: 9, turnovers: 2, minutes: 34,
      analytics: { advanced: { assist_percentage: 0.42 }, totals: { threePointFieldGoalsAttempted: 350 } },
    }),
    player("shooter", {
      positions: ["G", "F"], points: 18, threePct: 0.43, efgPct: 0.61, minutes: 30,
      analytics: { totals: { threePointFieldGoalsAttempted: 500 } },
    }),
    player("big", {
      positions: ["F", "C"], points: 17, rebounds: 12, blocks: 2.7, steals: 1.2, minutes: 32,
      analytics: { advanced: { total_rebound_percentage: 0.23, block_percentage: 0.06 } },
    }),
    player("connector", {
      positions: ["G", "F"], points: 12, assists: 5, turnovers: 1.1, minutes: 28,
    }),
    player("low1", { points: 6, assists: 1, rebounds: 2, blocks: 0.1, minutes: 18 }),
    player("low2", { points: 7, assists: 1.2, rebounds: 2.5, blocks: 0.2, minutes: 19 }),
  ];
  const classified = classifyPlayerSeasonRolePool(roster, { referencePlayers: roster });
  const rolesFor = (id) => classified.byId.get(id).roles.map((role) => role.id);

  assert.ok(rolesFor("creator").includes("primaryCreator"));
  assert.ok(rolesFor("shooter").includes("movementShooter"));
  assert.ok(rolesFor("shooter").includes("perimeterShooter"));
  assert.ok(rolesFor("big").includes("rimProtector"));
  assert.ok(rolesFor("big").includes("rebounder"));
  assert.ok(rolesFor("big").includes("switchDefender"));
  assert.match(rolesFor("connector").join(" "), /connector|secondaryCreator/);
  assert.match(classified.byId.get("connector").caveats.join(" "), /movement-shooting proxy is withheld/i);
  assert.equal(
    classified.byId.get("shooter").roles.find((role) => role.id === "movementShooter").label,
    "Movement-shooting proxy",
  );
  assert.equal(
    classified.byId.get("big").roles.find((role) => role.id === "switchDefender").label,
    "Switch-defense proxy",
  );
});

test("builds role coverage matrix with explicit gaps instead of treating them as hard constraints", () => {
  const roster = [
    player("creator", { points: 25, assists: 10, minutes: 35 }),
    player("big", { positions: ["F", "C"], rebounds: 13, blocks: 3, minutes: 33 }),
    player("low1", { points: 5, assists: 1, rebounds: 2, minutes: 16 }),
    player("low2", { points: 6, assists: 1, rebounds: 2, minutes: 16 }),
    player("low3", { points: 7, assists: 1, rebounds: 2, minutes: 16 }),
  ];
  const coverage = analyzeRoleCoverage(roster, {
    referencePlayers: roster,
    roleTargets: { primaryCreator: 1, rimProtector: 1, movementShooter: 1 },
  });
  const primary = coverage.coverage.find((item) => item.roleId === "primaryCreator");
  const rim = coverage.coverage.find((item) => item.roleId === "rimProtector");
  const movement = coverage.coverage.find((item) => item.roleId === "movementShooter");

  assert.equal(primary.status, "covered");
  assert.equal(rim.status, "covered");
  assert.equal(movement.status, "unassessed");
  assert.ok(coverage.matrix.some((row) => row.playerId === "creator"));
  assert.equal(coverage.deficiencies.some((item) => item.roleId === "movementShooter"), false);
});

test("shows small-sample roles as provisional without letting them satisfy coverage by default", () => {
  const roster = [
    player("small-creator", { games: 5, minutes: 30, points: 30, assists: 12, turnovers: 1.5 }),
    player("low1", { points: 5, assists: 1, rebounds: 2, minutes: 16 }),
    player("low2", { points: 6, assists: 1, rebounds: 2, minutes: 16 }),
    player("low3", { points: 7, assists: 1, rebounds: 2, minutes: 16 }),
    player("low4", { points: 8, assists: 1, rebounds: 2, minutes: 16 }),
  ];
  const defaultCoverage = analyzeRoleCoverage(roster, {
    referencePlayers: roster,
    roleTargets: { primaryCreator: 1 },
  });
  const primaryDefault = defaultCoverage.coverage.find((item) => item.roleId === "primaryCreator");
  assert.equal(primaryDefault.status, "gap");
  assert.equal(primaryDefault.players.length, 0);
  assert.equal(primaryDefault.provisionalPlayers.length, 1);
  assert.match(primaryDefault.message, /not counted toward coverage/i);
  assert.ok(defaultCoverage.provisionalSignalCount > 0);

  const optedInCoverage = analyzeRoleCoverage(roster, {
    referencePlayers: roster,
    roleTargets: { primaryCreator: 1 },
    includeProvisionalRoleCoverage: true,
  });
  const primaryOptedIn = optedInCoverage.coverage.find((item) => item.roleId === "primaryCreator");
  assert.equal(primaryOptedIn.status, "covered");
  assert.equal(primaryOptedIn.coverageUsesProvisional, true);
});

test("explains exact solver selections and only reports solver-supplied replacements", () => {
  const p1 = player("p1", { name: "Creator", points: 23, assists: 9 });
  const p2 = player("p2", { name: "Shooter", points: 19, threePct: 0.42 });
  const p3 = player("p3", { name: "Big", positions: ["F", "C"], rebounds: 12, blocks: 2.5 });
  const p4 = player("p4", { name: "Wing", positions: ["G", "F"], points: 16, steals: 1.6 });
  const p5 = player("p5", { name: "Forward", positions: ["F"], points: 15, rebounds: 7 });
  const bench = player("bench", { name: "Bench Shooter", points: 18, threePct: 0.4 });
  const best = {
    rank: 1,
    score: 82,
    players: [p1, p2, p3, p4, p5],
    totals: { points: 88, rebounds: 31, assists: 20, steals: 6, blocks: 4, turnovers: 10 },
    constraintAudit: { exactSize: { passed: true } },
  };
  const alternative = {
    rank: 2,
    score: 79,
    players: [p1, bench, p3, p4, p5],
    totals: { points: 87, rebounds: 30, assists: 19, steals: 6, blocks: 4, turnovers: 9 },
  };
  const replacements = summarizeReplacementAlternatives(best, [best, alternative]);
  const explanation = explainOptimizationSelection({ best, alternatives: [best, alternative] }, {
    candidatePool: [...best.players, bench],
    weights: { points: 2, assists: 1.5, threePct: 1, ballSecurity: 1 },
  });

  assert.equal(replacements.available, true);
  assert.deepEqual(replacements.byRemovedPlayerId.p2.added, [{ id: "bench", name: "Bench Shooter" }]);
  assert.equal(replacements.byRemovedPlayerId.p2.scoreGap, 3);
  assert.equal(replacements.byRemovedPlayerId.p2.productionDeltas.find((delta) => delta.metric === "turnovers").delta, -1);
  assert.equal(explanation.available, true);
  assert.equal(explanation.selectedPlayers.length, 5);
  assert.ok(explanation.selectedPlayers.find((item) => item.playerId === "p1").whySelected.length > 0);
  assert.match(explanation.replacements.caveats.join(" "), /solver-ranked alternatives/i);
});

test("rotation explanations preserve the optimizer's per-36 percentile evidence", () => {
  const rateStar = player("rate-star", { minutes: 10, points: 10 });
  const volumeVeteran = player("volume-veteran", { minutes: 40, points: 20 });
  const best = {
    players: [rateStar, volumeVeteran],
    rotation: { byId: { "rate-star": 48, "volume-veteran": 0 } },
    playerContributions: {
      "rate-star": { metrics: { points: { percentile: 1, scoreContribution: 100 } } },
      "volume-veteran": { metrics: { points: { percentile: 0, scoreContribution: 0 } } },
    },
  };
  const explanation = explainOptimizationSelection({
    best,
    alternatives: [best],
    diagnostics: { rotationScoringBasis: "per36" },
  }, {
    candidatePool: best.players,
    referencePlayers: best.players,
    weights: { points: 1 },
  });
  const profileById = Object.fromEntries(
    explanation.selectedPlayers.map((selected) => [selected.playerId, selected.profile]),
  );
  const ratePoints = profileById["rate-star"].contributions.find((item) => item.metric === "points");
  const volumePoints = profileById["volume-veteran"].contributions.find((item) => item.metric === "points");

  assert.equal(explanation.objectiveScoringBasis, "per36");
  assert.equal(ratePoints.value, 36);
  assert.equal(ratePoints.valueBasis, "per36");
  assert.equal(ratePoints.percentile, 1);
  assert.equal(ratePoints.percentileSource, "optimizer");
  assert.equal(volumePoints.value, 18);
  assert.equal(volumePoints.percentile, 0);
  assert.match(explanation.selectedPlayers[0].whySelected.join(" "), /36 per 36/);
});

test("rotation explanations mirror the optimizer's conservative zero for zero-minute rates", () => {
  const noMinutePlayer = player("no-minutes", { minutes: 0, points: 0 });
  const best = {
    players: [noMinutePlayer],
    rotation: { byId: { "no-minutes": 0 } },
    playerContributions: {
      "no-minutes": { metrics: { points: { percentile: 0, scoreContribution: 0 } } },
    },
  };
  const explanation = explainOptimizationSelection({
    best,
    alternatives: [best],
    diagnostics: { rotationScoringBasis: "per36" },
  }, {
    candidatePool: [noMinutePlayer],
    referencePlayers: [noMinutePlayer],
    weights: { points: 1 },
  });
  const points = explanation.selectedPlayers[0].profile.contributions
    .find((item) => item.metric === "points");

  assert.equal(points.value, 0);
  assert.equal(points.valueBasis, "per36");
  assert.equal(points.percentile, 0);
  assert.equal(points.percentileSource, "optimizer");
  assert.match(explanation.selectedPlayers[0].whySelected.join(" "), /0 per 36/);
});
