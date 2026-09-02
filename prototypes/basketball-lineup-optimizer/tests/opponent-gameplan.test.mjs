import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpponentGamePlan,
  normalizeOpponentGamePlanFamilies,
  OPPONENT_GAME_PLAN_MODEL_VERSION,
  summarizeHistoricalTeamProfile,
} from "../opponent-gameplan.js";

/** A complete Basketball Reference-style player total row for game-plan tests. */
function historicalPlayer(id, name, totals, overrides = {}) {
  return {
    id,
    name,
    positions: ["G"],
    // These values deliberately vary in one test. The game-plan model must
    // never use them as a desired rotation amount or a player-selection rule.
    games: 82,
    minutes: 32,
    analytics: { totals },
    ...overrides,
  };
}

function teamDataset(team, players, teamAverages = {}, overrides = {}) {
  return {
    source: {
      team,
      teamName: `${team} Test Team`,
      season: "2024-25",
      seasonPhase: "regular",
      teamGames: 82,
      teamAverages,
      ...overrides,
    },
    players,
  };
}

const OWN_TOTALS = {
  points: 8000,
  totalRebounds: 3600,
  assists: 1800,
  steals: 600,
  blocks: 400,
  turnovers: 1100,
  fieldGoalsMade: 3000,
  fieldGoalsAttempted: 7000,
  threePointFieldGoalsMade: 800,
  threePointFieldGoalsAttempted: 2300,
  freeThrowsAttempted: 1600,
  offensiveRebounds: 800,
};

const OPPONENT_TOTALS = {
  points: 8800,
  totalRebounds: 4100,
  assists: 2500,
  steals: 800,
  blocks: 700,
  turnovers: 1200,
  fieldGoalsMade: 3350,
  fieldGoalsAttempted: 7200,
  threePointFieldGoalsMade: 1200,
  threePointFieldGoalsAttempted: 3300,
  freeThrowsAttempted: 1700,
  offensiveRebounds: 900,
};

function splitTotals(totals, share) {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value * share]));
}

function paceAdjustedMatchup() {
  const own = teamDataset("OWN", [
    historicalPlayer("own-star", "Own Star", splitTotals(OWN_TOTALS, 0.62)),
    historicalPlayer("own-role", "Own Role", splitTotals(OWN_TOTALS, 0.38)),
  ]);
  const opponent = teamDataset("OPP", [
    historicalPlayer("opp-star", "Opponent Star", splitTotals(OPPONENT_TOTALS, 0.52)),
    historicalPlayer("opp-creator", "Opponent Creator", splitTotals(OPPONENT_TOTALS, 0.3)),
    historicalPlayer("opp-role", "Opponent Role", splitTotals(OPPONENT_TOTALS, 0.18)),
  ]);
  return { own, opponent };
}

test("summarizes roster totals into an explicitly estimated possession profile", () => {
  const { own } = paceAdjustedMatchup();
  const profile = summarizeHistoricalTeamProfile(own);

  // 7,000 FGA + (0.44 × 1,600 FTA) − 800 OREB + 1,100 TOV.
  assert.equal(profile.estimatedPossessions, 8004);
  assert.equal(profile.rateMethod, "estimated-offensive-possessions");
  assert.equal(profile.possessionRateAvailable, true);
  assert.ok(Math.abs(profile.per100.points - 99.95) < 0.001);
  assert.equal(profile.per100.threePointAttemptRate, 2300 / 7000);
  assert.equal(profile.per100.efgPct, (3000 + (0.5 * 800)) / 7000);
});

test("builds a readable offense-and-defense response without changing hard solver settings", () => {
  const { own, opponent } = paceAdjustedMatchup();
  const plan = buildOpponentGamePlan({ ownDataset: own, opponentDataset: opponent });
  const defensiveIds = plan.defendTheirStrengths.map((item) => item.id);
  const offensiveIds = plan.protectYourOffense.map((item) => item.id);

  assert.equal(plan.modelVersion, OPPONENT_GAME_PLAN_MODEL_VERSION);
  assert.equal(plan.comparison.rateBasis, "per100");
  assert.ok(defensiveIds.includes("three-point-volume"));
  assert.ok(defensiveIds.includes("ball-movement"));
  assert.ok(defensiveIds.includes("shot-efficiency"));
  assert.ok(defensiveIds.includes("rebounding"));
  assert.ok(offensiveIds.includes("protect-possessions"));
  assert.equal(plan.familyWeights.perimeterDefense > 18, true);
  assert.equal(plan.familyWeights.rebounding > 15, true);
  assert.equal(Object.values(plan.familyWeights).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(plan.constraints.changesOnlyVisibleWeights, true);
  assert.equal(plan.constraints.changesMinutePlan, false);
  assert.equal(plan.constraints.changesPositionRules, false);
  assert.equal(plan.constraints.changesPlayerPool, false);
  assert.equal(plan.constraints.makesMatchupAssignments, false);
  assert.equal(plan.threats.find((threat) => threat.id === "scoring")?.playerName, "Opponent Star");
  assert.match(plan.caveats.join(" "), /not a live injury report/i);
});

test("falls back to clearly labeled per-game evidence instead of inventing possessions", () => {
  const own = teamDataset("OWN", [], {
    points: 100,
    rebounds: 42,
    assists: 23,
    steals: 7,
    blocks: 4,
    turnovers: 13,
    efgPct: 0.52,
    threePct: 0.35,
  });
  const opponent = teamDataset("OPP", [], {
    points: 104,
    rebounds: 47,
    assists: 25,
    steals: 8,
    blocks: 5,
    turnovers: 12,
    efgPct: 0.54,
    threePct: 0.37,
  });
  const plan = buildOpponentGamePlan({ ownDataset: own, opponentDataset: opponent });

  assert.equal(plan.comparison.rateBasis, "perGame");
  assert.equal(plan.comparison.own.possessionRateAvailable, false);
  assert.equal(plan.comparison.opponent.possessionRateAvailable, false);
  assert.match(plan.caveats.join(" "), /per-game totals instead of pace-adjusted/i);
  assert.equal(Object.values(plan.familyWeights).reduce((sum, value) => sum + value, 0), 100);
});

test("does not use a player's past games or minutes to change the game-plan weights", () => {
  const { own, opponent } = paceAdjustedMatchup();
  const alteredHistory = structuredClone(opponent);
  alteredHistory.players[0].games = 7;
  alteredHistory.players[0].minutes = 6;
  alteredHistory.players[1].games = 82;
  alteredHistory.players[1].minutes = 39;

  const originalPlan = buildOpponentGamePlan({ ownDataset: own, opponentDataset: opponent });
  const alteredPlan = buildOpponentGamePlan({ ownDataset: own, opponentDataset: alteredHistory });

  assert.deepEqual(alteredPlan.familyWeights, originalPlan.familyWeights);
  assert.deepEqual(alteredPlan.weights, originalPlan.weights);
  assert.equal(JSON.stringify(alteredPlan).includes("minutePlan"), false);
});

test("normalizes custom family inputs to a truthful 100-point display", () => {
  const normalized = normalizeOpponentGamePlanFamilies({
    scoring: 1,
    spacing: 1,
    creation: 1,
    rebounding: 1,
    perimeterDefense: 1,
    interiorDefense: 1,
  });

  assert.equal(Object.values(normalized).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(normalized.scoring, 17);
  assert.equal(normalized.interiorDefense, 16);
});
