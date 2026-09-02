import test from "node:test";
import assert from "node:assert/strict";

import { buildScoutImpactModel, scoreScoutCandidate } from "../scout-impact.js";

const players = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

test("missing Scout evidence fails closed instead of becoming zero", () => {
  const model = buildScoutImpactModel(players, {
    players: { a: { offense: 1, defense: 1, reliability: 1 } },
  }, { mode: "hybrid" });
  assert.equal(model.available, false);
  assert.equal(model.applied, false);
  assert.equal(scoreScoutCandidate(players, model).adjustmentPoints, 0);
});

test("reliability shrinkage and exact-five residuals remain explicit", () => {
  const evidence = {
    players: Object.fromEntries(players.map(({ id }) => [id, {
      offense: 1,
      defense: 1,
      reliability: 0.5,
    }])),
    exactLineups: [{
      playerIds: ["e", "d", "c", "b", "a"],
      residual: 2,
      reliability: 0.5,
    }],
  };
  const model = buildScoutImpactModel(players, evidence, { mode: "hybrid" });
  const score = scoreScoutCandidate(players, model);
  assert.equal(model.available, true);
  assert.equal(score.exactLineupResidual, 1);
  assert.equal(score.impact, 2);
  assert.equal(score.adjustmentPoints, 2.5);
});

